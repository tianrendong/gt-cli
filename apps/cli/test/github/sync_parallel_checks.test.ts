import { expect } from 'chai';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  syncConcurrency,
  updateBranchesFromRemote,
} from '../../src/actions/sync/update_branches';
import { TContext } from '../../src/lib/context';
import { mapWithConcurrency } from '../../src/lib/utils/map_with_concurrency';

const cli = path.resolve(__dirname, '../../src/index.js');
const fixture = path.resolve(__dirname, '../../../test/fixtures/fake-gh.cjs');

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('bounded concurrency helper', () => {
  it('never runs more than the limit at once and keeps input order', async () => {
    for (const limit of [1, 2, 4]) {
      let active = 0;
      let peak = 0;
      const results = await mapWithConcurrency(
        Array.from({ length: 23 }, (_, i) => i),
        limit,
        async (item) => {
          active++;
          peak = Math.max(peak, active);
          await tick((item * 7) % 5);
          active--;
          return item * 2;
        }
      );
      expect(peak).to.equal(limit);
      expect(results).to.deep.equal(
        Array.from({ length: 23 }, (_, i) => i * 2)
      );
    }
  });

  it('stops starting work after a failure and waits for in-flight calls', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    const failure = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (item) => {
        started.push(item);
        active++;
        await tick(item === 2 ? 1 : 20);
        active--;
        if (item === 2) throw new Error('count failed');
        finished.push(item);
        return item;
      }
    ).then(
      () => undefined,
      (error: Error) => error
    );
    expect(failure?.message).to.equal('count failed');
    // Rejection only after the calls running alongside the failure settled.
    expect(active).to.equal(0);
    expect(finished).to.include.members([0, 1]);
    // Nothing new starts once the failure is seen.
    expect(started.length).to.be.lessThan(20);
    await tick(50);
    expect(active).to.equal(0);
  });

  it('bounds the default to half the cores, at most 4, at least 1', () => {
    const cores =
      (
        os as { availableParallelism?: () => number }
      ).availableParallelism?.() ?? os.cpus().length;
    expect(syncConcurrency({})).to.equal(
      Math.max(1, Math.min(4, Math.floor(cores / 2)))
    );
    expect(syncConcurrency({ GT_SYNC_CONCURRENCY: '1' })).to.equal(1);
    expect(syncConcurrency({ GT_SYNC_CONCURRENCY: '6' })).to.equal(6);
    for (const invalid of ['0', '-2', '1.5', 'many', ''])
      expect(syncConcurrency({ GT_SYNC_CONCURRENCY: invalid })).to.equal(
        syncConcurrency({})
      );
  });
});

describe('updateBranchesFromRemote divergence counts', function () {
  this.timeout(60_000);
  let root: string;
  let oldDir: string;
  let oldConcurrency: string | undefined;
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sync-counts-'))
    );
    oldDir = process.cwd();
    oldConcurrency = process.env.GT_SYNC_CONCURRENCY;
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['commit', '-q', '--allow-empty', '-m', 'initial']);
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(oldDir);
    if (oldConcurrency === undefined) delete process.env.GT_SYNC_CONCURRENCY;
    else process.env.GT_SYNC_CONCURRENCY = oldConcurrency;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Eight branches at main, each with a remote head one commit ahead. */
  function scenario(): {
    names: string[];
    remoteHeads: Map<string, string>;
    context: TContext;
    lines: string[];
  } {
    const names = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const remoteHeads = new Map<string, string>();
    for (const name of names) {
      git(['branch', name, 'main']);
      remoteHeads.set(
        name,
        git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', name])
      );
    }
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const context = {
      engine: {
        isTrunk: (name: string) => name === 'main',
        isBranchTracked: () => true,
        getPrInfo: () => undefined,
        getRevision: (name: string) => git(['rev-parse', name]),
        getPublishedRevision: () => undefined,
        currentBranch: 'main',
        rebuild: () => undefined,
      },
      repoConfig: { getRemote: () => 'origin' },
      splog: { info: log, debug: log, warn: log, newline: () => log('') },
    } as unknown as TContext;
    return { names, remoteHeads, context, lines };
  }

  for (const concurrency of ['1', '4']) {
    it(`makes no ref change when any count fails (concurrency ${concurrency})`, async () => {
      process.env.GT_SYNC_CONCURRENCY = concurrency;
      const { names, remoteHeads, context, lines } = scenario();
      remoteHeads.set('b5', 'deadbeef'.repeat(5)); // no such commit
      const before = git(['show-ref']);
      const error = await updateBranchesFromRemote(
        names,
        { force: false, remoteHeads },
        context
      ).then(
        () => undefined,
        (e: Error) => e
      );
      expect(error?.message).to.contain('rev-list');
      expect(git(['show-ref'])).to.equal(before);
      expect(lines).to.deep.equal([]);
    });

    it(`fast-forwards every branch when all counts succeed (concurrency ${concurrency})`, async () => {
      process.env.GT_SYNC_CONCURRENCY = concurrency;
      const { names, remoteHeads, context, lines } = scenario();
      const updated = await updateBranchesFromRemote(
        names,
        { force: false, remoteHeads },
        context
      );
      expect(updated).to.deep.equal(names);
      for (const name of names)
        expect(git(['rev-parse', name])).to.equal(remoteHeads.get(name));
      expect(lines).to.deep.equal(
        names.map((name) => `${name} fast-forwarded to origin/${name}.`)
      );
    });
  }
});

describe('sync divergence checks at different concurrency (offline)', function () {
  this.timeout(300_000);
  const roots: string[] = [];
  after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  type TOutcome = {
    output: string;
    refs: string;
    worktreeHeads: string[];
    counts: { start: number; end: number }[];
  };

  /** Build the same repository (fixed commit dates, so identical commit IDs)
   * with branches in every sync state, then run sync once. */
  // eslint-disable-next-line max-lines-per-function
  function syncMixedStates(concurrency: number): TOutcome {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sync-parallel-'))
    );
    roots.push(root);
    const repo = path.join(root, 'repo');
    const origin = path.join(root, 'origin.git');
    const serverFile = path.join(root, 'github.json');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(repo);
    fs.copyFileSync(fixture, path.join(bin, 'gh'));
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      GT_FAKE_GITHUB: serverFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
      FORCE_COLOR: '0',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
    };
    delete env.GRAPHITE_INTERACTIVE;
    delete env.GT_SYNC_CONCURRENCY;
    delete env.GIT_TRACE2_EVENT;
    const git = (args: string[], cwd = repo): string =>
      execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): string => {
      const result = spawnSync(
        process.execPath,
        [cli, ...args, '--no-interactive'],
        {
          cwd: repo,
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
          timeout: 60_000,
        }
      );
      expect(
        result.status,
        `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
      ).to.equal(0);
      return result.stdout + result.stderr;
    };
    const write = (file: string, text: string, cwd = repo) =>
      fs.appendFileSync(path.join(cwd, file), text);
    fs.writeFileSync(
      path.join(root, 'user.json'),
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    write('README', 'initial\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    git(['init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-u', 'origin', 'main']);
    git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({
        trunk: 'main',
        host: 'github.com',
        owner: 'test',
        name: 'repo',
      })
    );
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        gitDir: origin,
        next: 1,
        prs: [],
        stacks: [],
        calls: [],
      })
    );

    // One stack, interleaving states so neighbours differ.
    const states = [
      'ff',
      'ahead',
      'amend',
      'restacked',
      'diverged',
      'current',
      'worktree',
      'same',
    ];
    const names: string[] = [];
    for (let round = 0; round < 3; round++)
      for (const state of states) {
        if (round > 0 && state === 'current') continue;
        const name = `${state}-${round}`;
        write(name + '.txt', name + '\n');
        run(['create', name, '-am', name]);
        names.push(name);
      }
    run(['submit', '--stack']);
    run(['checkout', 'main']);

    const collab = path.join(root, 'collaborator');
    git(['clone', origin, collab]);
    git(['config', 'user.name', 'Test'], collab);
    git(['config', 'user.email', 'test@example.invalid'], collab);
    const advance = (branch: string) => {
      git(['checkout', branch], collab);
      write('upstream.txt', `remote change on ${branch}\n`, collab);
      git(['add', 'upstream.txt'], collab);
      git(['commit', '-m', 'remote change'], collab);
      git(['push', 'origin', branch], collab);
    };
    const dropLease = (branch: string) => {
      const ref = `refs/branch-metadata/${branch}`;
      const data = JSON.parse(git(['show', ref]));
      delete data.prInfo.remoteRevision;
      delete data.lastSubmittedVersion;
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        env,
        input: JSON.stringify(data),
        encoding: 'utf8',
      }).trim();
      git(['update-ref', ref, blob]);
    };
    const worktrees: string[] = [];
    for (const name of names) {
      const state = name.replace(/-\d+$/, '');
      if (['ff', 'current', 'worktree', 'diverged'].includes(state))
        advance(name);
      if (state === 'same') continue;
      git(['checkout', name]);
      if (state === 'ahead') {
        write(name + '.txt', 'local commit\n');
        git(['commit', '-am', 'local commit']);
      } else if (state === 'amend' || state === 'diverged') {
        write(name + '.txt', 'local amend\n');
        git(['commit', '--amend', '-am', 'local amend']);
      } else if (state === 'restacked') {
        // Same patch, new commit ID, and no lease to compare with.
        git(['commit', '--amend', '-m', 'restacked']);
        dropLease(name);
      }
      git(['checkout', 'main']);
      if (state === 'worktree') {
        const directory = path.join(root, 'wt-' + name);
        git(['worktree', 'add', directory, name]);
        worktrees.push(directory);
      }
    }
    git(['checkout', 'current-0']);

    const trace = path.join(root, 'trace.json');
    const output = run(['sync', '--no-restack', '--debug'], {
      GT_SYNC_CONCURRENCY: String(concurrency),
      GIT_TRACE2_EVENT: trace,
    });
    const events = fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const starts = new Map<string, number>();
    const counts: { start: number; end: number }[] = [];
    for (const event of events) {
      if (
        event.event === 'start' &&
        event.argv.includes('rev-list') &&
        event.argv.includes('--left-right')
      )
        starts.set(event.sid, Date.parse(event.time) + micros(event.time));
      if (event.event === 'exit' && starts.has(event.sid))
        counts.push({
          start: starts.get(event.sid) as number,
          end: Date.parse(event.time) + micros(event.time),
        });
    }
    return {
      output: output
        .split(root)
        .join('<root>')
        .split('\n')
        .map(debugMessage)
        .join('\n'),
      refs: git([
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/remotes',
      ]),
      worktreeHeads: [repo, ...worktrees].map((dir) =>
        git(['rev-parse', 'HEAD'], dir)
      ),
      counts,
    };
  }

  /** --debug lines are JSON with a timestamp and a per-run trace ID; keep
   * only the message. */
  function debugMessage(line: string): string {
    if (!line.startsWith('{')) return line;
    try {
      return `debug: ${JSON.parse(line).message}`;
    } catch {
      return line;
    }
  }

  /** Sub-millisecond part of a trace2 UTC timestamp, in milliseconds. */
  function micros(time: string): number {
    const fraction = /\.(\d+)Z$/.exec(time)?.[1] ?? '';
    return Number(`0.${fraction.slice(3) || '0'}`);
  }

  function peakOverlap(intervals: { start: number; end: number }[]): number {
    const edges = intervals
      .flatMap(({ start, end }) => [
        [start, 1],
        [end, -1],
      ])
      // Ends sort before starts at the same instant.
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0;
    let peak = 0;
    for (const [, delta] of edges) {
      active += delta;
      peak = Math.max(peak, active);
    }
    return peak;
  }

  it('produces identical output, order and refs at concurrency 1 and 4', () => {
    const sequential = syncMixedStates(1);
    const parallel = syncMixedStates(4);

    // Every state is exercised.
    const output = sequential.output;
    expect(output).to.contain('Branch ff-0 fast-forwarded to remote');
    expect(output).to.contain('Branch current-0 fast-forwarded to remote');
    expect(output).to.contain('Branch worktree-2 fast-forwarded to remote');
    expect(output).to.contain('ahead-1 is ahead of origin/ahead-1');
    expect(output).to.contain(
      'amend-2 has unpublished local changes; origin/amend-2 is unchanged'
    );
    expect(output).to.contain(
      'restacked-0 is ahead of origin/restacked-0 (restacked locally)'
    );
    expect(output).to.contain('diverged-1 has diverged from origin/diverged-1');
    expect(output).to.contain('Branch same-0 is up to date with remote');

    expect(parallel.output).to.equal(sequential.output);
    expect(parallel.refs).to.equal(sequential.refs);
    expect(parallel.worktreeHeads).to.deep.equal(sequential.worktreeHeads);

    // 3 of each of 6 states that differ from the remote, 1 current branch.
    expect(sequential.counts).to.have.length(19);
    expect(parallel.counts).to.have.length(19);
    expect(peakOverlap(sequential.counts)).to.equal(1);
    expect(peakOverlap(parallel.counts)).to.be.within(1, 4);
  });
});
