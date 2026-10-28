import { expect } from 'chai';
import { GitHubClient, GitHubError } from '../../src/lib/github/client';
import { StackAPI, RemoteStack } from '../../src/lib/github/stack_api';
import {
  LocalStack,
  MirrorState,
  validateStackFile,
} from '../../src/lib/github/stack_file';
import { planStackSync } from '../../src/lib/github/stack_sync';
import { expandCommand } from '../../src/lib/pre-yargs/preprocess_command';

const number = (name: string) => name.charCodeAt(0) - 96;
const local = (names: string[], base = 'main'): LocalStack => ({
  trunk: { branch: base },
  branches: names.map((branch) => ({
    branch,
    pullRequest: { number: number(branch) },
  })),
});
const remote = (
  names: string[],
  stackNumber = 100,
  base = 'main'
): RemoteStack => ({
  id: stackNumber,
  node_id: `S_${stackNumber}`,
  number: stackNumber,
  url: '',
  open: true,
  base: { ref: base, sha: '0'.repeat(40) },
  pull_requests: names.map((ref) => ({
    number: number(ref),
    state: 'open',
    head: { ref, sha: '1'.repeat(40) },
    merged_at: null,
  })),
});
const state = (stacks: RemoteStack[] = []): MirrorState => ({
  version: 1,
  stacks: [],
  remote: Object.fromEntries(
    stacks.map((s) => [
      String(s.number),
      { base: s.base.ref, prs: s.pull_requests.map((p) => p.number) },
    ])
  ),
});

describe('native stack synchronization planner', () => {
  it('does not create a native stack for a single PR', () => {
    expect(
      planStackSync({ local: [local(['a'])], remote: [], state: state() })[0]
        .action
    ).to.equal('noop');
  });
  it('creates at least two PRs as a native stack', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [],
        state: state(),
      })[0].action
    ).to.equal('create');
  });
  it('does nothing when membership and base are equal', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [remote(['a', 'b'])],
        state: state(),
      })[0].action
    ).to.equal('noop');
  });
  it('appends a clean local extension even without a checkpoint', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b', 'c'])],
        remote: [remote(['a', 'b'])],
        state: state(),
      })[0].action
    ).to.equal('append');
  });
  it('refuses to truncate an unknown remote-ahead stack', () => {
    expect(() =>
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [remote(['a', 'b', 'c'])],
        state: state(),
      })
    ).to.throw('gt has no record of syncing #100');
  });
  it('replaces a deliberate local removal when the server matches the checkpoint', () => {
    const server = remote(['a', 'b', 'c']);
    expect(
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [server],
        state: state([server]),
      })[0].action
    ).to.equal('replace');
  });
  it('does not mistake reordered names for a clean append', () => {
    expect(() =>
      planStackSync({
        local: [local(['b', 'a'])],
        remote: [remote(['a', 'b'])],
        state: state(),
      })
    ).to.throw('gt has no record of syncing #100');
  });
  it('ignores merged history when checking an unchanged active suffix', () => {
    const server = remote(['a', 'b', 'c']);
    server.pull_requests[0].merged_at = '2026-01-01';
    server.pull_requests[0].state = 'closed';
    expect(
      planStackSync({
        local: [local(['b', 'c'])],
        remote: [server],
        state: state([server]),
      })[0].action
    ).to.equal('noop');
  });
  it('starts a new stack after a fully merged stack rather than extending its history', () => {
    const server = remote(['a', 'b']);
    server.pull_requests.forEach((pr) => {
      pr.merged_at = '2026-01-01';
      pr.state = 'closed';
    });
    const desired = { ...local(['c', 'd']), number: server.number };
    expect(
      planStackSync({
        local: [desired],
        remote: [server],
        state: state([server]),
      })[0].action
    ).to.equal('create');
  });
  it('does not include closed PRs still associated with local branches', () => {
    const server = remote(['a', 'b', 'c']);
    server.pull_requests[2].state = 'closed';
    expect(
      planStackSync({
        local: [local(['a', 'b', 'c'])],
        remote: [server],
        state: state([server]),
      })[0].prs
    ).to.deep.equal([1, 2]);
  });
  it('does not recreate a closed PR after remote cleanup removed its record', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b', 'c'])],
        remote: [remote(['a', 'b'])],
        state: state(),
        closedPRs: new Set([3]),
      })[0].action
    ).to.equal('noop');
  });
  it('does not create a stack when every local PR is closed', () => {
    const plan = planStackSync({
      local: [local(['a', 'b'])],
      remote: [],
      state: state(),
      closedPRs: new Set([1, 2]),
    })[0];
    expect(plan.action).to.equal('noop');
    expect(plan.prs).to.deep.equal([]);
  });
  it('rejects a missing PR in the middle of a submitted chain', () => {
    const desired = local(['a', 'b', 'c']);
    delete desired.branches[1].pullRequest;
    expect(() =>
      planStackSync({ local: [desired], remote: [], state: state() })
    ).to.throw('interrupt');
  });
  it('allows an unsubmitted suffix without claiming it is remotely synchronized', () => {
    const desired = local(['a', 'b', 'c']);
    delete desired.branches[2].pullRequest;
    const plan = planStackSync({
      local: [desired],
      remote: [],
      state: state(),
    });
    expect(plan[0].prs).to.deep.equal([1, 2]);
  });
  it('explicit local preference permits replacing an independently changed stack', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [remote(['b', 'a'])],
        state: state(),
        preferLocal: true,
      })[0].action
    ).to.equal('replace');
  });
  it('expands a split to all affected local segments, including those outside submit scope', () => {
    const server = remote(['a', 'b', 'c']);
    const plans = planStackSync({
      local: [local(['a']), local(['b', 'c'], 'a'), local(['d', 'e'], 'a')],
      remote: [server],
      state: state([server]),
      submitting: new Set(['a', 'd', 'e']),
    });
    expect(plans.filter((p) => p.action === 'replace')).to.have.length(2);
    expect(plans.flatMap((p) => p.prs)).to.have.members([1, 2, 3, 4, 5]);
  });
  it('repairs all split segments after an external writer already unstacked the old object', () => {
    const plans = planStackSync({
      local: [local(['a', 'b']), local(['c']), local(['d', 'e'])],
      remote: [],
      state: state([remote(['a', 'b', 'c'])]),
      submitting: new Set(['c']),
    });
    expect(plans.map((plan) => [plan.action, plan.prs])).to.deep.equal([
      ['noop', [3]],
      ['create', [1, 2]],
    ]);
  });
  it('adopts an external rebuild that already matches desired topology without recreating it', () => {
    const plans = planStackSync({
      local: [local(['a', 'b']), local(['c'])],
      remote: [remote(['a', 'b'], 200)],
      state: state([remote(['a', 'b', 'c'])]),
      submitting: new Set(['c']),
    });
    expect(plans.every((plan) => plan.action === 'noop')).to.equal(true);
    expect(plans.flatMap((plan) => plan.prs)).to.have.members([1, 2, 3]);
  });
  it('still rejects an independently changed replacement after an external unstack', () => {
    expect(() =>
      planStackSync({
        local: [local(['a', 'b']), local(['c'])],
        remote: [remote(['a', 'd'], 200)],
        state: state([remote(['a', 'b', 'c'])]),
        submitting: new Set(['c']),
      })
    ).to.throw('gt has no record of syncing #200');
  });
  it('does not revive closed Stack objects containing historical open PR records', () => {
    expect(
      planStackSync({
        local: [local(['a', 'b'])],
        remote: [{ ...remote(['a', 'b']), open: false }],
        state: state(),
      })[0].action
    ).to.equal('create');
  });
  it('plans joining two previously synchronized objects as one replacement', () => {
    const servers = [remote(['a', 'b']), remote(['c', 'd'], 200)];
    const plan = planStackSync({
      local: [local(['a', 'b', 'c', 'd'])],
      remote: servers,
      state: state(servers),
    })[0];
    expect(plan.replace?.map((s) => s.number)).to.deep.equal([100, 200]);
  });
  it('requires confirmation when one side of a cross-stack move changed remotely', () => {
    const old = [remote(['a', 'b']), remote(['c', 'd'], 200)];
    const changed = [old[0], remote(['c', 'd', 'e'], 200)];
    expect(() =>
      planStackSync({
        local: [local(['a', 'b', 'c', 'd'])],
        remote: changed,
        state: state(old),
      })
    ).to.throw('GitHub stack #200 changed on GitHub since gt last synced it');
  });
  it('does not treat a different PR with the same branch name as identical', () => {
    const desired = local(['a', 'b']);
    desired.branches[1].pullRequest = { number: 999 };
    expect(() =>
      planStackSync({
        local: [desired],
        remote: [remote(['a', 'b'])],
        state: state(),
      })
    ).to.throw('gt has no record of syncing #100');
  });
});

describe('stack sync refusals', () => {
  const segment = (names: string[], base: string): LocalStack => ({
    ...local(names, 'main'),
    trunk: { branch: base },
  });
  const refusal = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('names the fork and says GitHub stacks are linear when gt has no record', () => {
    // GitHub: one stack a -> b -> c. Locally, d was forked off a.
    const message = refusal(() =>
      planStackSync({
        local: [
          segment(['a'], 'main'),
          segment(['b', 'c'], 'a'),
          segment(['d'], 'a'),
        ],
        remote: [remote(['a', 'b', 'c'], 411935)],
        state: state(),
        submitting: new Set(['d', 'a', 'b', 'c']),
      })
    );
    expect(message).to.contain('GitHub stack #411935 must be rebuilt');
    expect(message).to.contain('local branch a has 2 children in it (b, d)');
    expect(message).to.contain('GitHub stacks are linear');
    expect(message).to.contain('gt has no record of syncing #411935');
    expect(message).to.contain('[#1 a -> #2 b -> #3 c] on main');
    expect(message).to.contain('gt submit --stack --reconcile local');
    expect(message).not.to.contain('changed on GitHub');
    expect(message).not.to.match(
      /(use|run|with) gt submit[^\n]*--no-stack-sync/
    );
  });

  it('rebuilds the same fork when gt has a record', () => {
    const server = remote(['a', 'b', 'c'], 411935);
    const plans = planStackSync({
      local: [
        segment(['a'], 'main'),
        segment(['b', 'c'], 'a'),
        segment(['d'], 'a'),
      ],
      remote: [server],
      state: state([server]),
      submitting: new Set(['d', 'a', 'b', 'c']),
    });
    expect(plans.some((plan) => plan.action === 'replace')).to.equal(true);
  });

  it('reports a GitHub-side change with what gt last synced, and never suggests overriding it', () => {
    const synced = remote(['a', 'b'], 7);
    const known = state([synced]);
    known.remote['7'].writtenBy = '/work/agent-3';
    known.remote['7'].at = '2026-10-01T00:15:00.000Z';
    const message = refusal(() =>
      planStackSync({
        local: [local(['b', 'a'])],
        remote: [remote(['a', 'b', 'c'], 7)],
        state: known,
      })
    );
    expect(message).to.contain(
      'GitHub stack #7 changed on GitHub since gt last synced it'
    );
    expect(message).to.contain(
      'gt last synced [#1 -> #2] on main (by /work/agent-3 at 2026-10-01T00:15:00.000Z)'
    );
    expect(message).to.contain('GitHub now has [#1 a -> #2 b -> #3 c] on main');
    expect(message).to.contain('gt get 7');
    expect(message).not.to.contain('--reconcile local');
    expect(message).not.to.contain('has no record');
  });

  it('accepts any record a migration kept when GitHub matches it', () => {
    const server = remote(['a', 'b', 'c']);
    const migrated = state();
    migrated.remote['100'] = {
      base: 'main',
      prs: [1, 2],
      alternatives: [{ base: 'main', prs: [1, 2, 3] }],
    };
    expect(
      planStackSync({
        local: [local(['b', 'a', 'c'])],
        remote: [server],
        state: migrated,
      })[0].action
    ).to.equal('replace');
    migrated.remote['100'].alternatives = [{ base: 'main', prs: [2, 1, 3] }];
    expect(() =>
      planStackSync({
        local: [local(['b', 'a', 'c'])],
        remote: [server],
        state: migrated,
      })
    ).to.throw('changed on GitHub');
  });
});

describe('GitHub transport and storage contracts', () => {
  it('sends typed JSON and explicit host/repository, not shell-interpolated arguments', () => {
    const calls: { args: string[]; input?: string }[] = [];
    const client = new GitHubClient(
      { host: 'ghe.example.com', owner: 'owner', name: 'repo' },
      (args, input) => {
        calls.push({ args, input });
        return JSON.stringify(remote(['a', 'b']));
      }
    );
    new StackAPI(client).create([1, 2]);
    expect(calls[0].args).to.include.members([
      '--hostname',
      'ghe.example.com',
      '--method',
      'POST',
      'repos/owner/repo/stacks',
      '--input',
      '-',
    ]);
    expect(JSON.parse(calls[0].input as string)).to.deep.equal({
      pull_requests: [1, 2],
    });
    client.pr(['edit', '42', '--title', '$(touch /tmp/never-executed)']);
    expect(calls[1].args.slice(-2)).to.deep.equal([
      '--repo',
      'ghe.example.com/owner/repo',
    ]);
    expect(calls[1].args).to.include('$(touch /tmp/never-executed)');
  });
  it('paginates through repositories containing more than 100 native stacks', async () => {
    let calls = 0;
    const api = new StackAPI(
      new GitHubClient({ host: 'github.com', owner: 'o', name: 'r' }, () =>
        JSON.stringify(
          ++calls === 1
            ? Array.from({ length: 100 }, (_, i) => remote(['a', 'b'], i + 1))
            : [remote(['c', 'd'], 101)]
        )
      )
    );
    expect(await api.list()).to.have.length(101);
    expect(calls).to.equal(2);
  });
  it('detects partial unstack responses with locked members', () => {
    const api = new StackAPI(
      new GitHubClient({ host: 'github.com', owner: 'o', name: 'r' }, () =>
        JSON.stringify(remote(['a', 'b']))
      )
    );
    expect(() => api.unstack(100)).to.throw('locked PRs');
  });
  it('accepts merged-only history remaining after unstack', () => {
    const history = remote(['a']);
    history.open = false;
    history.pull_requests[0].state = 'closed';
    history.pull_requests[0].merged_at = '2026-01-01';
    const api = new StackAPI(
      new GitHubClient({ host: 'github.com', owner: 'o', name: 'r' }, () =>
        JSON.stringify(history)
      )
    );
    expect(api.unstack(100)).to.deep.equal(history);
  });
  it('accepts an empty 204 unstack response', () => {
    const api = new StackAPI(
      new GitHubClient({ host: 'github.com', owner: 'o', name: 'r' }, () => '')
    );
    expect(() => api.unstack(100)).not.to.throw();
  });
  it('distinguishes a missing PR from authentication failures', () => {
    const client = new GitHubClient(
      { host: 'github.com', owner: 'o', name: 'r' },
      () => {
        throw new GitHubError('gh: Bad credentials (HTTP 401)');
      }
    );
    expect(() => client.viewPR('feature')).to.throw('Bad credentials');
    const missing = new GitHubClient(client.repository, () => {
      throw new GitHubError('no pull requests found for branch feature');
    });
    expect(missing.viewPR('feature')).to.equal(undefined);
  });
  it('rejects malformed remote data rather than overwriting local metadata', () => {
    const api = new StackAPI(
      new GitHubClient(
        { host: 'github.com', owner: 'o', name: 'r' },
        () => '{"pull_requests":[]}'
      )
    );
    expect(() => api.get(100)).to.throw('Invalid response');
  });
  it('rejects duplicate branches and unknown local schema versions', () => {
    expect(() =>
      validateStackFile({
        schemaVersion: 1,
        repository: 'o/r',
        stacks: [local(['a', 'a'])],
      })
    ).to.throw('Invalid branch chain');
    expect(() =>
      validateStackFile({
        schemaVersion: 2 as 1,
        repository: 'o/r',
        stacks: [],
      })
    ).to.throw('Unsupported');
  });
});

describe('command aliases', () => {
  for (const [input, output] of [
    ['c', 'create'],
    ['m', 'modify'],
    ['co', 'checkout'],
    ['b', 'bottom'],
    ['tr', 'track'],
    ['sq', 'squash'],
    ['g', 'guide'],
    ['ab', 'absorb'],
    ['utr', 'untrack'],
  ]) {
    it(`${input} expands to ${output}`, () =>
      expect(expandCommand(input)).to.deep.equal([output]));
  }
  it('retains commit-amend and branch-create legacy shortcuts', () => {
    expect(expandCommand('ca')).to.deep.equal(['commit', 'a']);
    expect(expandCommand('bc')).to.deep.equal(['branch', 'c']);
  });
});
