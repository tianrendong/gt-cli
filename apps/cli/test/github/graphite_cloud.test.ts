import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import nock from 'nock';
import { TContext } from '../../src/lib/context';
import { GitHubClient } from '../../src/lib/github/client';
import {
  GraphiteCloudClient,
  GraphiteRequest,
  GraphiteReply,
  graphiteToken,
  sendGraphite,
} from '../../src/lib/graphite_cloud/client';
import { GraphiteSubmissionState } from '../../src/lib/graphite_cloud/state';
import { prepareGraphiteSubmission } from '../../src/lib/graphite_cloud/submit';
import {
  graphiteSubmitSetting,
  readGraphiteSubmit,
  writeGraphiteSubmit,
} from '../../src/lib/graphite_cloud/settings';
chai.use(chaiAsPromised);

const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  trunk = '0'.repeat(40);
const payload: GraphiteRequest = {
  repoOwner: 'owner',
  repoName: 'repo',
  trunkBranchName: 'main',
  prs: [
    {
      action: 'update',
      head: 'one',
      headSha: a,
      base: 'main',
      baseSha: trunk,
      prNumber: 1,
    },
  ],
};
const ack = (request: GraphiteRequest): GraphiteReply => ({
  status: 200,
  body: {
    prs: request.prs.map((pr) => ({
      status: 'updated',
      head: pr.head,
      prNumber: pr.prNumber,
      prURL: 'https://github.com/owner/repo/pull/' + pr.prNumber,
    })),
  },
});

describe('opt-in Graphite cloud submission', function () {
  this.timeout(20_000);
  let root: string,
    repo: string,
    originalCwd: string,
    oldEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cloud-test-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    originalCwd = process.cwd();
    oldEnv = { ...process.env };
    Object.assign(process.env, {
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      GIT_CONFIG_GLOBAL: path.join(root, 'global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    });
    for (const key of [
      'GT_GRAPHITE_TOKEN',
      'GRAPHITE_PROFILE',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
    ])
      delete process.env[key];
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    process.chdir(repo);
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env))
      if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const auth = (value = 'native-token') => {
    const file = path.join(root, 'config/graphite/auth');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ authToken: value }), {
      mode: 0o600,
    });
    return file;
  };

  it('defaults off and supports global default, repository false override, and unset', () => {
    expect(graphiteSubmitSetting()).to.deep.equal({
      enabled: false,
      source: 'default',
    });
    writeGraphiteSubmit(true, 'global');
    expect(graphiteSubmitSetting()).to.deep.equal({
      enabled: true,
      source: 'global',
    });
    writeGraphiteSubmit(false, 'local');
    expect(graphiteSubmitSetting()).to.deep.equal({
      enabled: false,
      source: 'repository',
    });
    writeGraphiteSubmit(undefined, 'local');
    expect(graphiteSubmitSetting().enabled).to.equal(true);
    writeGraphiteSubmit(undefined, 'global');
    writeGraphiteSubmit(undefined, 'global');
    expect(graphiteSubmitSetting().source).to.equal('default');
  });
  it('shares a repository override between linked worktrees', () => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { stdio: 'ignore' }
    );
    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], {
      stdio: 'ignore',
    });
    writeGraphiteSubmit(true, 'local');
    expect(graphiteSubmitSetting(linked).enabled).to.equal(true);
    writeGraphiteSubmit(false, 'local', linked);
    expect(graphiteSubmitSetting().enabled).to.equal(false);
  });
  it('supports standalone management configuration without adopting a repository', () => {
    const entry = path.resolve(__dirname, '../../src/settings_cli.js');
    const result = spawnSync(
      process.execPath,
      [entry, 'submit.graphite', 'true', '--global', '--json'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(result.status).to.equal(0);
    expect(JSON.parse(result.stdout).enabled).to.equal(true);
    expect(readGraphiteSubmit('global')).to.equal(true);
    expect(fs.existsSync(path.join(root, '.git'))).to.equal(false);
    const invalid = spawnSync(
      process.execPath,
      [entry, 'submit.graphite', 'yes', '--global'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(invalid.status).to.equal(1);
  });
  const manage = (args: string[], cwd = repo) =>
    spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../../src/settings_cli.js'),
        'graphite',
        ...args,
      ],
      { cwd, encoding: 'utf8' }
    );
  const setting = (args: string[], cwd = repo) => {
    const result = manage([...args, '--json'], cwd);
    expect(result.status, result.stderr).to.equal(0);
    return JSON.parse(result.stdout);
  };
  it('enables and disables Graphite submission without authentication or repository adoption', () => {
    process.env.GT_GRAPHITE_TOKEN = 'invalid\ncredential';
    expect(setting(['status']).enabled).to.equal(false);
    expect(setting(['enable']).enabled).to.equal(true);
    expect(readGraphiteSubmit('local')).to.equal(true);
    expect(setting(['disable']).enabled).to.equal(false);
    expect(fs.existsSync(path.join(repo, '.git/gt-gh-switch'))).to.equal(false);
    expect(
      fs.existsSync(path.join(repo, '.git/gt-graphite-submit.json'))
    ).to.equal(false);
    expect(fs.existsSync(path.join(root, 'config'))).to.equal(false);
  });
  it('supports global defaults, explicit repository overrides, and reset inheritance', () => {
    expect(setting(['enable', '--global'], root).scope).to.equal('global');
    expect(setting(['status']).source).to.equal('global');
    expect(setting(['disable', '--repo', repo], root).enabled).to.equal(false);
    expect(setting(['status']).source).to.equal('repository');
    expect(setting(['reset', '--repo', repo], root).enabled).to.equal(true);
    expect(readGraphiteSubmit('local')).to.equal(undefined);
    expect(setting(['disable', '--global'], root).enabled).to.equal(false);
    expect(setting(['enable', '--repo', repo], root).enabled).to.equal(true);
    expect(setting(['reset', '--global'], root).value).to.equal(null);
    expect(setting(['status']).enabled).to.equal(true);
    expect(setting(['reset']).enabled).to.equal(false);
  });
  it('shares shorthand configuration with linked worktrees and legacy config commands', () => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { stdio: 'ignore' }
    );
    const linked = path.join(root, 'linked with spaces');
    execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], {
      stdio: 'ignore',
    });
    expect(setting(['enable', '--repo', linked], root).enabled).to.equal(true);
    expect(graphiteSubmitSetting(repo).enabled).to.equal(true);
    const legacy = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../../src/settings_cli.js'),
        'config',
        'submit.graphite',
        'false',
      ],
      { cwd: repo, encoding: 'utf8' }
    );
    expect(legacy.status, legacy.stderr).to.equal(0);
    expect(legacy.stdout).to.contain('submit.graphite=false');
    expect(setting(['status'], linked).enabled).to.equal(false);
  });
  it('rejects invalid shorthand arguments before any configuration write', () => {
    writeGraphiteSubmit(false, 'local');
    writeGraphiteSubmit(false, 'global');
    const local = fs.readFileSync(path.join(repo, '.git/config'));
    const global = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL!);
    for (const args of [
      ['status', 'true'],
      ['status', '--unset'],
      ['enable', 'disable'],
      ['reset', 'false'],
      ['on'],
      ['enable', '--repo'],
      ['enable', '--unknown'],
      ['enable', '--global', '--repo', repo],
      ['enable', '--unset'],
    ])
      expect(manage(args).status, args.join(' ')).to.equal(1);
    expect(
      fs.readFileSync(path.join(repo, '.git/config')).equals(local)
    ).to.equal(true);
    expect(
      fs.readFileSync(process.env.GIT_CONFIG_GLOBAL!).equals(global)
    ).to.equal(true);
  });
  it('shows scope-aware status and non-mutating help', () => {
    expect(manage([]).stdout).to.contain(
      'gt-cli graphite <enable|disable|status|reset>'
    );
    expect(manage(['enable', '--help']).status).to.equal(0);
    expect(readGraphiteSubmit('local')).to.equal(undefined);
    expect(manage(['status']).stdout).to.contain(
      'Graphite submission: disabled (built-in default)'
    );
    expect(manage(['enable', '--global'], root).stdout).to.contain(
      'Repository overrides take precedence'
    );
    expect(manage(['status']).stdout).to.contain('(global default)');
    expect(manage(['disable']).stdout).to.contain('(repository override)');
  });
  it('rejects malformed booleans instead of silently turning mirroring on', () => {
    execFileSync('git', [
      'config',
      '--local',
      'gt.submitGraphite',
      'not-a-boolean',
    ]);
    expect(() => graphiteSubmitSetting()).to.throw('valid Git boolean');
  });
  it('reuses native authentication without modifying it and accepts explicit production override', () => {
    const file = auth(),
      before = fs.readFileSync(file);
    expect(graphiteToken()).to.equal('native-token');
    expect(fs.readFileSync(file).equals(before)).to.equal(true);
    process.env.GT_GRAPHITE_TOKEN = 'explicit-token';
    process.env.GRAPHITE_PROFILE = 'custom';
    expect(graphiteToken()).to.equal('explicit-token');
    delete process.env.GT_GRAPHITE_TOKEN;
    expect(() => graphiteToken()).to.throw('Custom Graphite profiles');
  });
  it('does not use GitHub credentials or accept unsafe native auth files', () => {
    process.env.GH_TOKEN = 'github-only-secret';
    expect(() => graphiteToken()).to.throw('authentication is missing');
    const file = auth();
    fs.chmodSync(file, 0o666);
    expect(() => graphiteToken()).to.throw('authentication is missing');
    fs.unlinkSync(file);
    const outside = path.join(root, 'token');
    fs.writeFileSync(outside, '{"authToken":"elsewhere"}');
    fs.symlinkSync(outside, file);
    expect(() => graphiteToken()).to.throw('authentication is missing');
    process.env.GT_GRAPHITE_TOKEN = 'bad\nheader';
    expect(() => graphiteToken()).to.throw('Invalid Graphite credential');
  });
  it('uses fixed HTTPS endpoint and header auth, with no token in request body', async () => {
    const scope = nock('https://api.graphite.com')
      .post('/v1/graphite/submit/pull-requests', payload as any)
      .matchHeader('authorization', 'token secret-token')
      .reply(200, ack(payload).body as any);
    await new GraphiteCloudClient('secret-token').update(payload);
    expect(scope.isDone()).to.equal(true);
    expect(JSON.stringify(payload)).not.to.contain('secret-token');
  });
  it('rejects create requests or content edits before transport', async () => {
    let called = false;
    const client = new GraphiteCloudClient('token', async () => {
      called = true;
      return ack(payload);
    });
    await expect(
      client.update({
        ...payload,
        prs: [{ ...payload.prs[0], action: 'create' as any }],
      })
    ).to.be.rejectedWith('Only existing-PR updates');
    await expect(
      client.update({
        ...payload,
        prs: [{ ...payload.prs[0], body: 'not allowed' } as any],
      })
    ).to.be.rejectedWith('Only existing-PR updates');
    expect(called).to.equal(false);
  });
  it('rejects empty and multi-PR requests before transport despite the array-shaped API', async () => {
    let calls = 0;
    const client = new GraphiteCloudClient('token', async (request) => {
      calls++;
      return ack(request);
    });
    for (const prs of [
      undefined,
      [],
      [payload.prs[0], { ...payload.prs[0], head: 'two', prNumber: 2 }],
      [payload.prs[0], payload.prs[0]],
    ])
      await expect(
        client.update({ ...payload, prs } as GraphiteRequest)
      ).to.be.rejectedWith('exactly one existing PR per request');
    expect(calls).to.equal(0);
  });
  it('does not follow redirects or forward credentials elsewhere', async () => {
    nock('https://api.graphite.com')
      .post('/v1/graphite/submit/pull-requests')
      .reply(302, '', { location: 'https://other.invalid/' });
    const other = nock('https://other.invalid').post('/').reply(200, {});
    await expect(
      new GraphiteCloudClient('secret-token').update(payload)
    ).to.be.rejectedWith('HTTP 302');
    expect(other.isDone()).to.equal(false);
  });
  it('bounds response size and rejects invalid JSON', async () => {
    nock('https://api.graphite.com')
      .post('/v1/graphite/submit/pull-requests')
      .reply(200, 'x'.repeat(1024 * 1024 + 1));
    await expect(sendGraphite(payload, 'token')).to.be.rejectedWith(
      'size limit'
    );
    nock('https://api.graphite.com')
      .post('/v1/graphite/submit/pull-requests')
      .reply(200, 'not json');
    await expect(sendGraphite(payload, 'token')).to.be.rejectedWith(
      'invalid JSON'
    );
  });
  it('has a total request deadline and redacts transport/server errors', async () => {
    nock('https://api.graphite.com')
      .post('/v1/graphite/submit/pull-requests')
      .delayConnection(100)
      .reply(200, {});
    await expect(sendGraphite(payload, 'secret-token', 5)).to.be.rejectedWith(
      'timed out'
    );
    const client = new GraphiteCloudClient('secret-token', async () => {
      throw Error('secret-token echoed by transport');
    });
    let message = '';
    try {
      await client.update(payload);
    } catch (error) {
      message = error.message;
    }
    expect(message).to.contain('transport failed');
    expect(message).not.to.contain('secret-token');
    const denied = new GraphiteCloudClient('secret-token', async () => ({
      status: 403,
      body: { token: 'secret-token' },
    }));
    await expect(denied.update(payload)).to.be.rejectedWith('HTTP 403');
  });
  it('rejects create acknowledgements, wrong PR identities, and per-PR errors', async () => {
    for (const response of [
      { status: 'created', head: 'one', prNumber: 1, prURL: 'url' },
      { status: 'updated', head: 'one', prNumber: 999, prURL: 'url' },
      { status: 'updated', head: 'other', prNumber: 1, prURL: 'url' },
      { status: 'error', head: 'unknown', error: 'private server detail' },
    ]) {
      const client = new GraphiteCloudClient('token', async () => ({
        status: 200,
        body: { prs: [response] },
      }));
      await expect(client.update(payload)).to.be.rejected;
    }
  });

  function fixture() {
    const pulls: Record<number, any> = {
      1: {
        number: 1,
        node_id: 'PR_one',
        state: 'open',
        title: 'one title',
        body: 'unchanged body',
        draft: true,
        head: { ref: 'one', sha: a, repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', sha: trunk, repo: { full_name: 'owner/repo' } },
      },
      2: {
        number: 2,
        node_id: 'PR_two',
        state: 'open',
        title: 'two title',
        body: 'second body',
        draft: false,
        head: { ref: 'two', sha: b, repo: { full_name: 'owner/repo' } },
        base: { ref: 'one', sha: a, repo: { full_name: 'owner/repo' } },
      },
    };
    const expected = structuredClone(pulls);
    const logs: string[] = [],
      requests: GraphiteRequest[] = [],
      ghCalls: string[][] = [];
    const stacks: any[] = [
      {
        id: 10,
        node_id: 'S_10',
        number: 10,
        url: 'https://github.com/owner/repo/stack/10',
        open: true,
        base: { ref: 'main', sha: trunk },
        pull_requests: [
          { number: 1, state: 'open', head: { ref: 'one', sha: a } },
          { number: 2, state: 'open', head: { ref: 'two', sha: b } },
        ],
      },
    ];
    const github = new GitHubClient(
      { host: 'github.com', owner: 'owner', name: 'repo' },
      (args) => {
        ghCalls.push(args);
        if (args.includes('graphql')) {
          // Read-only membership query, answered from the same stack objects.
          const query = args.find((a) => a.startsWith('query=')) ?? '';
          expect(query).to.match(/^query=query\(/);
          const repository: Record<string, unknown> = {};
          for (const match of query.matchAll(
            /p(\d+):pullRequest\(number:(\d+)\)/g
          )) {
            const number = Number(match[2]);
            const stack = stacks.find((s) =>
              s.pull_requests.some((pr: any) => pr.number === number)
            );
            const pr = pulls[number];
            repository[`p${match[1]}`] = {
              number,
              id: pr.node_id,
              state: pr.state.toUpperCase(),
              title: pr.title,
              body: pr.body ?? '',
              isDraft: pr.draft,
              headRefName: pr.head.ref,
              headRefOid: pr.head.sha,
              baseRefName: pr.base.ref,
              baseRefOid: pr.base.sha,
              headRepository: { nameWithOwner: pr.head.repo.full_name },
              baseRepository: { nameWithOwner: pr.base.repo.full_name },
              stack: stack
                ? {
                    number: stack.number,
                    baseRefName: stack.base.ref,
                    size: stack.pull_requests.length,
                    entries: {
                      nodes: stack.pull_requests.map((pr: any, i: number) => ({
                        position: i + 1,
                        pullRequest: {
                          number: pr.number,
                          headRefName: pr.head.ref,
                        },
                      })),
                    },
                  }
                : null,
            };
          }
          return JSON.stringify({ data: { repository } });
        }
        expect(args[args.indexOf('--method') + 1]).to.equal('GET');
        const endpoint = args[args.length - 1];
        const number = Number(endpoint.split('/').pop());
        if (pulls[number]) return JSON.stringify(pulls[number]);
        throw Error('Unexpected GitHub request');
      }
    );
    // Route PR reads and stack-membership reads through one observable hook.
    const interceptReads = (
      hook: (label: string, next: () => Promise<unknown>) => Promise<unknown>
    ) => {
      const query = github.query.bind(github);
      github.query = <T>(text: string): Promise<T> =>
        hook('snapshot', () => query(text)) as Promise<T>;
    };
    const context = {
      splog: { info: (s: string) => logs.push(s) },
      engine: {
        getPrInfo: (branch: string) => ({
          number: branch === 'one' ? 1 : 2,
          id: branch === 'one' ? 'PR_one' : 'PR_two',
          base: expected[branch === 'one' ? 1 : 2].base.ref,
        }),
        getRevision: (branch: string) => (branch === 'one' ? a : b),
        getParentPrecondition: (branch: string) =>
          branch === 'one' ? 'main' : 'one',
        isTrunk: (branch: string) => branch === 'main',
        getTrunk: () => 'main',
      },
    } as unknown as TContext;
    const common = path.join(repo, '.git');
    const receipt = () =>
      new GraphiteSubmissionState(common, github.qualifiedRepo);
    const prepare = (
      transport = async (request: GraphiteRequest) => ack(request),
      extra = {}
    ) =>
      prepareGraphiteSubmission(
        context,
        {
          branches: ['two', 'one'],
          dryRun: false,
          always: false,
          stackSync: true,
          ...extra,
        },
        {
          github,
          cloud: () =>
            new GraphiteCloudClient('fixture-token', async (request) => {
              expect(request.prs).to.have.length(1);
              requests.push(structuredClone(request));
              return transport(request);
            }),
          state: receipt,
        }
      );
    return {
      pulls,
      expected,
      logs,
      requests,
      ghCalls,
      stacks,
      context,
      github,
      prepare,
      common,
      receipt,
      interceptReads,
    };
  }

  it('never loads credentials, receipts, or contacts Graphite when disabled or dry-running', () => {
    const f = fixture();
    expect(
      prepareGraphiteSubmission(
        f.context,
        { branches: ['one'], dryRun: false, always: false, stackSync: true },
        {
          github: f.github,
          cloud: () => {
            throw Error('must not read credentials');
          },
        }
      )
    ).to.equal(undefined);
    writeGraphiteSubmit(true, 'local');
    expect(
      prepareGraphiteSubmission(
        f.context,
        { branches: ['one'], dryRun: true, always: false, stackSync: true },
        {
          github: f.github,
          cloud: () => {
            throw Error('must not read credentials');
          },
        }
      )
    ).to.equal(undefined);
    expect(f.ghCalls).to.have.length(0);
    expect(
      fs.existsSync(path.join(f.common, 'gt-graphite-submit.json'))
    ).to.equal(false);
  });
  it('fails known auth/host/receipt problems before any Graphite request', () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    expect(() =>
      prepareGraphiteSubmission(
        f.context,
        { branches: ['one'], dryRun: false, always: false, stackSync: true },
        { github: f.github }
      )
    ).to.throw('authentication is missing');
    expect(f.ghCalls).to.have.length(0);
    const enterprise = new GitHubClient({
      host: 'ghe.invalid',
      owner: 'owner',
      name: 'repo',
    });
    expect(() =>
      prepareGraphiteSubmission(
        f.context,
        { branches: ['one'], dryRun: false, always: false, stackSync: true },
        { github: enterprise }
      )
    ).to.throw('github.com repositories only');
    fs.writeFileSync(path.join(f.common, 'gt-graphite-submit.json'), '{}');
    expect(() => f.prepare()).to.throw('Invalid Graphite submission receipts');
  });
  it('mirrors only existing PRs in parent order and checkpoints unchanged requests', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    const nativeFile = path.join(f.common, '.graphite_metadata.db');
    fs.writeFileSync(nativeFile, 'native sentinel');
    await f.prepare()!.sync(['two', 'one']);
    expect(f.requests).to.have.length(2);
    expect(f.ghCalls).to.have.length(2);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 2]);
    for (const request of f.requests) {
      expect(Object.keys(request.prs[0]).sort()).to.deep.equal([
        'action',
        'base',
        'baseSha',
        'head',
        'headSha',
        'prNumber',
      ]);
      expect(request.prs[0].action).to.equal('update');
    }
    await f.prepare()!.sync(['two', 'one']);
    expect(f.requests).to.have.length(2);
    expect(f.ghCalls).to.have.length(3);
    await f.prepare(undefined, { always: true })!.sync(['two', 'one']);
    expect(f.requests).to.have.length(4);
    expect(f.ghCalls).to.have.length(5);
    expect(f.pulls).to.deep.equal(f.expected);
    expect(fs.readFileSync(nativeFile, 'utf8')).to.equal('native sentinel');
    const saved = fs.readFileSync(
      path.join(f.common, 'gt-graphite-submit.json'),
      'utf8'
    );
    expect(saved).not.to.contain('fixture-token');
    expect(saved).not.to.contain('unchanged body');
  });
  it('reuses 0.6.16 fingerprints and retries its pending receipts as singleton requests', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    const state = f.receipt();
    // Fixed fingerprints from the released per-PR receipt format.
    const first =
      '44f198a68f46ec62c58fee7730154e4534410ae925f835fae3e6aa2ccc4f4712';
    const second =
      '760e196b475ce2cfeefa9323d83922d71ebd447bc304ef1d975e378751128470';
    state.record(1, first, 'submitted');
    state.record(2, second, 'pending');
    await f.prepare()!.sync(['two', 'one']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([2]);
    expect(f.receipt().submitted(1, first)).to.equal(true);
    expect(f.receipt().submitted(2, second)).to.equal(true);
    await f.prepare()!.sync(['two', 'one']);
    expect(f.requests).to.have.length(1);
    expect(f.ghCalls).to.have.length(3);
  });
  it('awaits each singleton POST in parent order without intervening snapshot reads', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    const events: string[] = [];
    let active = 0,
      peak = 0;
    f.interceptReads(async (_, next) => {
      expect(active).to.equal(0);
      events.push('snapshot');
      return next();
    });
    await f
      .prepare(async (request) => {
        const number = request.prs[0].prNumber;
        active++;
        peak = Math.max(peak, active);
        events.push(`start:${number}`);
        const saved = JSON.parse(
          fs.readFileSync(
            path.join(f.common, 'gt-graphite-submit.json'),
            'utf8'
          )
        );
        expect(saved.receipts[String(number)].status).to.equal('pending');
        if (number === 1) expect(saved.receipts['2']).to.equal(undefined);
        await sleep(15);
        active--;
        events.push(`end:${number}`);
        return ack(request);
      })!
      .sync(['two', 'one']);
    expect(peak).to.equal(1);
    expect(events).to.deep.equal([
      'snapshot',
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'snapshot',
    ]);
  });
  it('chunks snapshots at 50 PRs while sending ordered singleton POSTs', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    const branches = Array.from(
      { length: 51 },
      (_, index) => `branch-${index + 1}`
    );
    branches.forEach((branch, index) => {
      const number = index + 1;
      f.pulls[number] = {
        ...structuredClone(f.expected[1]),
        number,
        node_id: `PR_${number}`,
        head: {
          ref: branch,
          sha: number.toString(16).padStart(40, '0'),
          repo: { full_name: 'owner/repo' },
        },
      };
    });
    f.context.engine.getPrInfo = (branch) => {
      const number = branches.indexOf(branch) + 1;
      return { number, id: `PR_${number}`, base: 'main' };
    };
    f.context.engine.getRevision = (branch) =>
      f.pulls[branches.indexOf(branch) + 1].head.sha;
    f.context.engine.getParentPrecondition = () => 'main';
    const original = f.github.query.bind(f.github);
    let active = 0,
      peak = 0;
    f.github.query = async <T>(endpoint: string): Promise<T> => {
      active++;
      peak = Math.max(peak, active);
      try {
        await sleep(3);
        return (await original(endpoint)) as T;
      } finally {
        active--;
      }
    };
    await f
      .prepare(
        async (request) => {
          expect(active).to.equal(0);
          return ack(request);
        },
        { stackSync: false }
      )!
      .sync(branches);
    expect(peak).to.equal(1);
    expect(f.ghCalls).to.have.length(4);
    expect(f.requests).to.have.length(51);
    expect(f.requests.map((r) => r.prs[0].head)).to.deep.equal(branches);
    expect(active).to.equal(0);
  });
  it('keeps every receipt pending until full postflight verification', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    const completed: string[] = [];
    let active = 0,
      phase = 0,
      peak = 0;
    f.interceptReads(async (endpoint, next) => {
      const current = phase;
      active++;
      peak = Math.max(peak, active);
      try {
        if (current === 2 && endpoint === 'snapshot') {
          const receipts = JSON.parse(
            fs.readFileSync(
              path.join(f.common, 'gt-graphite-submit.json'),
              'utf8'
            )
          );
          expect(receipts.receipts['1'].status).to.equal('pending');
          expect(receipts.receipts['2'].status).to.equal('pending');
        }
        await sleep(endpoint === 'stacks' ? 15 : 3);
        const value = await next();
        completed.push(`${current}:${endpoint}`);
        return value;
      } finally {
        active--;
      }
    });
    await f
      .prepare(async (request) => {
        expect(active).to.equal(0);
        phase++;
        return ack(request);
      })!
      .sync(['one', 'two']);
    expect(peak).to.equal(1);
    expect(completed).to.deep.equal(['0:snapshot', '2:snapshot']);
    expect(f.requests).to.have.length(2);
  });
  it('fails an unavailable preflight without sending any POST', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    let active = 0;
    f.interceptReads(async (endpoint, next) => {
      active++;
      try {
        if (endpoint === 'snapshot') {
          await sleep(1);
          throw Error('unavailable');
        }
        await sleep(20);
        return await next();
      } finally {
        active--;
      }
    });
    await expect(f.prepare()!.sync(['one', 'two'])).to.be.rejectedWith(
      'incomplete'
    );
    expect(active).to.equal(0);
    expect(f.requests).to.have.length(0);
  });
  it('leaves all receipts pending if postflight query fails', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    let posted = false,
      finished = false;
    f.interceptReads(async (endpoint, next) => {
      if (posted && endpoint === 'snapshot') {
        await sleep(15);
        finished = true;
        throw Error('unavailable');
      }
      return await next();
    });
    await expect(
      f
        .prepare(async (request) => {
          posted = true;
          f.pulls[1].body = 'concurrent edit';
          return ack(request);
        })!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('incomplete');
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
    );
    expect(
      Object.values(saved.receipts).map((r: any) => r.status)
    ).to.deep.equal(['pending', 'pending']);
    expect(finished).to.equal(true);
    expect(f.requests).to.have.length(2);
    expect(f.pulls[1].body).to.equal('concurrent edit');
  });

  it('resumes a partial failure without resending verified successes or rewriting GitHub work', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f
        .prepare(async (request) =>
          request.prs[0].prNumber === 1
            ? ack(request)
            : {
                status: 200,
                body: {
                  prs: [
                    {
                      status: 'error',
                      head: 'two',
                      error: 'private server detail',
                    },
                  ],
                },
              }
        )!
        .sync(['one', 'two'])
    ).to.be.rejectedWith(
      'GitHub submission completed, but Graphite mirroring is incomplete (1/2)'
    );
    expect(f.pulls).to.deep.equal(f.expected);
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
    );
    expect(saved.receipts['1'].status).to.equal('submitted');
    expect(saved.receipts['2'].status).to.equal('pending');
    await f.prepare()!.sync(['one', 'two']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 2, 2]);
    expect(f.ghCalls).to.have.length(4);
  });
  for (const failure of [
    {
      name: 'HTTP failure',
      message: 'HTTP 503',
      send: async (): Promise<GraphiteReply> => ({ status: 503, body: {} }),
    },
    {
      name: 'ambiguous transport failure',
      message: 'Graphite transport failed',
      send: async (): Promise<GraphiteReply> => {
        throw Error('private transport detail');
      },
    },
    {
      name: 'malformed acknowledgement',
      message: 'unexpected result',
      send: async (): Promise<GraphiteReply> => ({
        status: 200,
        body: { prs: [] },
      }),
    },
  ])
    it(`checkpoints verified earlier PRs after a later ${failure.name}`, async () => {
      const f = fixture();
      writeGraphiteSubmit(true, 'local');
      await expect(
        f
          .prepare(async (request) =>
            request.prs[0].prNumber === 1 ? ack(request) : failure.send()
          )!
          .sync(['one', 'two'])
      ).to.be.rejectedWith(failure.message);
      expect(f.ghCalls).to.have.length(2);
      const saved = JSON.parse(
        fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
      );
      expect(saved.receipts['1'].status).to.equal('submitted');
      expect(saved.receipts['2'].status).to.equal('pending');
      await f.prepare()!.sync(['one', 'two']);
      expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 2, 2]);
      expect(f.pulls).to.deep.equal(f.expected);
    });
  it('does not checkpoint earlier acknowledgements when a later failed POST causes drift', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f
        .prepare(async (request) => {
          if (request.prs[0].prNumber === 1) return ack(request);
          f.pulls[1].body = 'concurrent edit during failed POST';
          return { status: 503, body: {} };
        })!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('metadata changed during Graphite submission');
    expect(f.ghCalls).to.have.length(2);
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
    );
    expect(
      Object.values(saved.receipts).map((r: any) => r.status)
    ).to.deep.equal(['pending', 'pending']);
    expect(f.pulls[1].body).to.equal('concurrent edit during failed POST');
    await f.prepare()!.sync(['one', 'two']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([
      1, 2, 1, 2,
    ]);
  });
  it('keeps existing unattempted receipts untouched after a forced retry fails', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await f.prepare()!.sync(['one', 'two']);
    const file = path.join(f.common, 'gt-graphite-submit.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    await expect(
      f
        .prepare(async () => ({ status: 503, body: {} }), { always: true })!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('HTTP 503');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.receipts['1'].status).to.equal('pending');
    expect(after.receipts['2']).to.deep.equal(before.receipts['2']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 2, 1]);
  });
  it('preflights all PR identities and refuses forks or externally changed heads', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    f.pulls[2].head.sha = 'c'.repeat(40);
    await expect(f.prepare()!.sync(['one', 'two'])).to.be.rejectedWith(
      'changed since GitHub submission'
    );
    expect(f.requests).to.have.length(0);
    f.pulls[2].head.sha = b;
    f.pulls[2].head.repo.full_name = 'someone/fork';
    await expect(f.prepare()!.sync(['one', 'two'])).to.be.rejectedWith(
      'cross-repository'
    );
    expect(f.requests).to.have.length(0);
  });
  it('detects changed PR content without restoring an old body over newer work', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f
        .prepare(async (request) => {
          f.pulls[1].body = 'newer content';
          return ack(request);
        })!
        .sync(['one'])
    ).to.be.rejectedWith('metadata changed during Graphite submission');
    expect(f.pulls[1].body).to.equal('newer content');
    expect(f.receipt().submitted(1, '0'.repeat(64))).to.equal(false);
  });
  it('detects native GitHub Stack changes but ignores unrelated repository counters', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await f
      .prepare(async (request) => {
        f.pulls[1].head.repo.forks_count = 12;
        return ack(request);
      })!
      .sync(['one']);
    await expect(
      f
        .prepare(
          async (request) => {
            f.stacks[0].pull_requests.reverse();
            return ack(request);
          },
          { always: true }
        )!
        .sync(['one'])
    ).to.be.rejectedWith('metadata changed during Graphite submission');
  });
  it('supports chained-PR mode without calling GitHub Stacks API', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await f.prepare(undefined, { stackSync: false })!.sync(['one']);
    expect(
      f.ghCalls.some((args) =>
        args.some((a) => a.includes(' stack{') || a.includes('/stacks'))
      )
    ).to.equal(false);
  });
  it('rejects missing, extra, duplicate, and mismatched singleton acknowledgements', async () => {
    const response = (ack(payload).body as any).prs[0];
    for (const body of [
      null,
      {},
      { prs: [] },
      { prs: [null] },
      { prs: [response, response] },
      { prs: [response, { ...response, head: 'two', prNumber: 2 }] },
      { prs: [{ ...response, head: 'unknown' }] },
      { prs: [{ ...response, prNumber: 2 }] },
      { prs: [{ ...response, prURL: undefined }] },
      { prs: [{ status: 'error', head: 'one', prNumber: 2 }] },
    ]) {
      const client = new GraphiteCloudClient('token', async () => ({
        status: 200,
        body,
      }));
      await expect(client.update(payload)).to.be.rejectedWith(
        'unexpected result'
      );
    }
    const rejected = new GraphiteCloudClient('token', async () => ({
      status: 200,
      body: { prs: [{ status: 'error', head: 'one', error: 'secret-token' }] },
    }));
    await expect(rejected.update(payload)).to.be.rejectedWith(
      'Graphite rejected PR #1. Retry to mirror remaining PRs.'
    );
  });
  it('rejects partial GraphQL responses, missing aliases, and truncated membership before POST', async () => {
    writeGraphiteSubmit(true, 'local');
    for (const corrupt of [
      (data: any) => {
        delete data.repository.p1;
      },
      (data: any) => {
        data.repository.p0.stack.size++;
      },
      (data: any) => {
        data.repository.p0.stack = undefined;
      },
      (data: any) => {
        data.repository.p0.headRefOid = 'invalid';
      },
    ]) {
      const f = fixture();
      f.interceptReads(async (_, next) => {
        const data = await next();
        corrupt(data);
        return data;
      });
      await expect(f.prepare()!.sync(['one', 'two'])).to.be.rejectedWith(
        'incomplete'
      );
      expect(f.requests).to.have.length(0);
    }
    const github = new GitHubClient(
      { host: 'github.com', owner: 'owner', name: 'repo' },
      () =>
        JSON.stringify({
          data: { repository: {} },
          errors: [{ message: 'partial' }],
        })
    );
    await expect(github.query('query{repository{name}}')).to.be.rejectedWith(
      'incomplete GraphQL query'
    );
  });
  it('stops at the first failed POST, verifies, and retries only attempted or unsubmitted PRs', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f.prepare(async () => ({ status: 503, body: {} }))!.sync(['one', 'two'])
    ).to.be.rejectedWith('HTTP 503');
    expect(f.ghCalls).to.have.length(2);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
    );
    expect(saved.receipts['1'].status).to.equal('pending');
    expect(saved.receipts['2']).to.equal(undefined);
    await f.prepare()!.sync(['one', 'two']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 1, 2]);
  });
  it('detects drift anywhere in the selected stack before checkpointing any success', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f
        .prepare(async (request) => {
          f.pulls[2].draft = true;
          return ack(request);
        })!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('metadata changed');
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.common, 'gt-graphite-submit.json'), 'utf8')
    );
    expect(
      Object.values(saved.receipts).map((r: any) => r.status)
    ).to.deep.equal(['pending', 'pending']);
  });
  it('still verifies receipt-skipped PRs when another PR is mirrored', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await f.prepare()!.sync(['one']);
    await expect(
      f
        .prepare(async (request) => {
          expect(request.prs.map((pr) => pr.prNumber)).to.deep.equal([2]);
          f.pulls[1].body = 'external edit';
          return ack(request);
        })!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('metadata changed');
  });
  it('does not checkpoint a malformed response or attempt its descendants', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await expect(
      f
        .prepare(async () => ({ status: 200, body: { prs: [] } }))!
        .sync(['one', 'two'])
    ).to.be.rejectedWith('unexpected result');
    expect(f.ghCalls).to.have.length(2);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1]);
    await f.prepare()!.sync(['one', 'two']);
    expect(f.requests.map((r) => r.prs[0].prNumber)).to.deep.equal([1, 1, 2]);
  });
  it('preserves different trunk identities without extra snapshot phases', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    f.context.engine.getTrunk = (branch) =>
      branch === 'two' ? 'develop' : 'main';
    await f.prepare()!.sync(['one', 'two']);
    expect(
      f.requests.map((r) => [r.trunkBranchName, r.prs.map((pr) => pr.prNumber)])
    ).to.deep.equal([
      ['main', [1]],
      ['develop', [2]],
    ]);
    expect(f.ghCalls).to.have.length(2);
  });
  it('does no network work for an empty selection', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    await f.prepare()!.sync([]);
    expect(f.ghCalls).to.have.length(0);
    expect(f.requests).to.have.length(0);
  });
  it('skips closed PRs and refuses stale receipts changed by another writer', async () => {
    const f = fixture();
    writeGraphiteSubmit(true, 'local');
    f.pulls[2].state = 'closed';
    const prepared = f.prepare()!;
    fs.writeFileSync(
      path.join(f.common, 'gt-graphite-submit.json'),
      JSON.stringify({
        schemaVersion: 1,
        repository: f.github.qualifiedRepo,
        receipts: {},
      })
    );
    await expect(prepared.sync(['one', 'two'])).to.be.rejectedWith(
      'incomplete'
    );
    expect(f.requests).to.have.length(0);
    await f.prepare()!.sync(['one', 'two']);
    expect(f.requests).to.have.length(1);
  });
});
