import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { promisify } from 'util';
import { setTimeout as sleep } from 'timers/promises';
import { fileLock } from '../../src/lib/github/file_lock';
import {
  MirrorState,
  SHARED_STATE_DIRECTORY,
  StackStore,
} from '../../src/lib/github/stack_file';
import { TBranchPRInfo } from '../../src/lib/engine/metadata_ref';

const cli = path.resolve(__dirname, '../../src/index.js');
const fixture = path.resolve(__dirname, '../../../test/fixtures/fake-gh.cjs');

type Server = {
  gitDir: string;
  next: number;
  calls: string[][];
  prs: Array<{
    number: number;
    headRefName: string;
    baseRefName: string;
    title: string;
    body: string;
    state: string;
    isDraft: boolean;
    reviewers?: string;
    comment?: string;
    autoMerge?: boolean;
  }>;
  stacks: { number: number; base: string; prs: number[] }[];
  failure?: { method: string; path: string; count: number; status: number };
  locked?: boolean;
  lockedPRs?: number[];
  stackReadMutation?: { number: number; prs?: number[]; reopen?: number };
};

describe('GitHub-backed gt (isolated git repositories and fake gh)', function () {
  this.timeout(90_000);
  let root: string, repo: string, serverFile: string, env: NodeJS.ProcessEnv;
  const git = (args: string[], input?: string, cwd = repo): string =>
    execFileSync('git', args, {
      cwd,
      input,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const server = (): Server => JSON.parse(fs.readFileSync(serverFile, 'utf8'));
  const syncState = (): MirrorState =>
    JSON.parse(fs.readFileSync(path.join(repo, '.git/gt-github-sync'), 'utf8'));
  const updateServer = (mutate: (state: Server) => void): void => {
    const state = server();
    mutate(state);
    fs.writeFileSync(serverFile, JSON.stringify(state));
  };
  const run = (args: string[], expected = 0, cwd = repo): string => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--no-interactive'],
      { cwd, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(expected);
    return result.stdout + result.stderr;
  };
  const create = (name: string): void => {
    fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
    run(['create', name, '-am', name]);
  };
  const mirror = (): {
    schemaVersion: number;
    repository: string;
    stacks: {
      number?: number;
      trunk: { branch: string };
      branches: {
        branch: string;
        base: string;
        head: string;
        pullRequest?: {
          number: number;
          id?: string;
          url?: string;
          merged?: boolean;
        };
      }[];
    }[];
  } => JSON.parse(fs.readFileSync(path.join(repo, '.git/gh-stack'), 'utf8'));
  const editMirror = (
    mutate: (data: ReturnType<typeof mirror>) => void
  ): void => {
    const data = mirror();
    mutate(data);
    fs.writeFileSync(path.join(repo, '.git/gh-stack'), JSON.stringify(data));
  };
  const prInfo = (branch: string): TBranchPRInfo | undefined =>
    JSON.parse(git(['cat-file', '-p', `refs/branch-metadata/${branch}`]))
      .prInfo;
  const seedPrInfo = (branch: string, value: TBranchPRInfo): void => {
    const meta = JSON.parse(
      git(['cat-file', '-p', `refs/branch-metadata/${branch}`])
    );
    meta.prInfo = value;
    const sha = git(['hash-object', '-w', '--stdin'], JSON.stringify(meta));
    git(['update-ref', `refs/branch-metadata/${branch}`, sha]);
  };
  const configure = (directory: string): void => {
    fs.writeFileSync(
      path.join(directory, '.git/.graphite_repo_config'),
      JSON.stringify({
        trunk: 'main',
        host: 'github.com',
        owner: 'test',
        name: 'repo',
      })
    );
    fs.writeFileSync(
      path.join(directory, '.git/.graphite_user_config'),
      JSON.stringify({ tips: false })
    );
    git(['config', 'user.name', 'Test'], undefined, directory);
    git(['config', 'user.email', 'test@example.com'], undefined, directory);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-github-test-'));
    repo = path.join(root, 'repo');
    serverFile = path.join(root, 'github.json');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(fixture, path.join(bin, 'gh'));
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GT_FAKE_GITHUB: serverFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GRAPHITE_USER_CONFIG_PATH: path.join(repo, '.git/.graphite_user_config'),
      GIT_EDITOR: 'true',
    };
    fs.mkdirSync(repo);
    git(['init', '-b', 'main']);
    configure(repo);
    fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    const origin = path.join(root, 'origin.git');
    git(['init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-u', 'origin', 'main']);
    git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        gitDir: origin,
        next: 1,
        calls: [],
        prs: [],
        stacks: [],
      })
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('supports the parallel log/info reads used by pi-stack status', async () => {
    create('a');
    create('b');
    const heads = git(['show-ref', '--heads']);
    for (let attempt = 0; attempt < 3; attempt++) {
      const results = await Promise.allSettled(
        [['log', '--stack'], ['info']].map((args) =>
          promisify(execFile)(
            process.execPath,
            [
              cli,
              '--cwd',
              repo,
              '--no-interactive',
              ...args,
              '--no-interactive',
            ],
            { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
          )
        )
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        expect(result.value.stdout).to.contain('b');
        expect(result.value.stdout).not.to.contain('ERROR:');
      }
    }
    expect(git(['show-ref', '--heads'])).to.equal(heads);
    expect(
      mirror().stacks[0].branches.map((branch) => branch.branch)
    ).to.deep.equal(['a', 'b']);
    expect(server().calls).to.deep.equal([]);
  });

  it("does not remove another process's legacy cache lock", () => {
    create('a');
    const lock = path.join(repo, '.git/.graphite_cache_lock');
    const marker = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    fs.writeFileSync(lock, marker);
    expect(run(['parent']).trim()).to.equal('main');
    expect(fs.readFileSync(lock, 'utf8')).to.equal(marker);
  });

  it('advertises Stack ownership without opening a repository or contacting GitHub', () => {
    const files = fs.readdirSync(root);
    expect(JSON.parse(run(['--capabilities'], 0, root))).to.deep.equal({
      schemaVersion: 1,
      implementation: 'gt-gh',
      nativeStackSync: true,
    });
    expect(fs.readdirSync(root)).to.deep.equal(files);
    expect(server().calls).to.deep.equal([]);
  });

  it('does not treat a passthrough filename after -- as a capability probe', () => {
    fs.writeFileSync(path.join(repo, '--capabilities'), 'literal filename\n');
    const result = spawnSync(
      process.execPath,
      [cli, 'add', '--', '--capabilities'],
      {
        cwd: repo,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(git(['diff', '--cached', '--name-only'])).to.equal('--capabilities');
  });

  it('preserves Graphite-owned PR cache and SQLite metadata through reads and edits', () => {
    create('a');
    const prCacheFile = path.join(repo, '.git/.graphite_pr_info');
    const prCache = JSON.stringify({
      prInfos: [{ headRefName: 'a', prNumber: 42, state: 'OPEN' }],
      mergeabilityStatuses: [],
      unknownFutureField: 'preserve',
    });
    const db = path.join(repo, '.git/.graphite_metadata.db');
    execFileSync(
      'sqlite3',
      [db, 'CREATE TABLE branch_metadata (branch_name TEXT);'],
      { env, stdio: 'pipe' }
    );
    const database = fs.readFileSync(db);
    fs.writeFileSync(prCacheFile, prCache);
    run(['parent']);
    expect(fs.readFileSync(prCacheFile, 'utf8')).to.equal(prCache);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'amended\n');
    run(['modify', '-am', 'amended']);
    run(['log', '--stack']);
    expect(fs.readFileSync(prCacheFile, 'utf8')).to.equal(prCache);
    expect(fs.readFileSync(db).equals(database)).to.equal(true);
    expect(server().calls).to.deep.equal([]);
  });

  it('mirrors create, amend, move, rename, and delete without contacting GitHub', () => {
    create('a');
    create('b');
    expect(mirror().stacks[0].branches.map((b) => b.branch)).to.deep.equal([
      'a',
      'b',
    ]);
    expect(mirror().repository).to.equal('github.com:test/repo');
    fs.appendFileSync(path.join(repo, 'b.txt'), 'change\n');
    run(['modify', '-am', 'changed']);
    expect(mirror().stacks[0].branches[1].head).to.equal(
      git(['rev-parse', 'b'])
    );
    run(['move', '--onto', 'main']);
    expect(
      mirror().stacks.map((s) => s.branches.map((b) => b.branch))
    ).to.deep.equal([['a'], ['b']]);
    run(['rename', 'renamed']);
    run(['delete', 'renamed', '--force']);
    expect(mirror().stacks[0].branches.map((b) => b.branch)).to.deep.equal([
      'a',
    ]);
    expect(server().calls).to.deep.equal([]);
  });

  it('partitions a fork without assigning any branch to two gh-stack chains', () => {
    create('a');
    create('b');
    run(['checkout', 'a']);
    create('c');
    create('d');
    const stacks = mirror().stacks;
    expect(
      stacks.map((s) => [s.trunk.branch, ...s.branches.map((b) => b.branch)])
    ).to.deep.equal([
      ['main', 'a'],
      ['a', 'b'],
      ['a', 'c', 'd'],
    ]);
  });

  it('imports externally created gh-stack metadata on the next local command', () => {
    create('a');
    git(['branch', 'b']);
    const data = mirror();
    data.stacks[0].branches.push({
      branch: 'b',
      base: git(['rev-parse', 'a']),
      head: git(['rev-parse', 'b']),
    });
    fs.writeFileSync(path.join(repo, '.git/gh-stack'), JSON.stringify(data));
    run(['checkout', 'b']);
    expect(run(['parent']).trim()).to.equal('a');
  });

  it('imports same-number PR merged state, ID, and URL updates without contacting GitHub', () => {
    create('a');
    editMirror((data) => {
      data.stacks[0].branches[0].pullRequest = { number: 1 };
    });
    run(['parent']);
    editMirror((data) => {
      data.stacks[0].branches[0].pullRequest = {
        number: 1,
        id: 'PR_1',
        url: 'https://github.com/test/repo/pull/1',
        merged: true,
      };
    });
    run(['parent']);
    expect(prInfo('a')?.state).to.equal('MERGED');
    expect(prInfo('a')?.id).to.equal('PR_1');
    expect(prInfo('a')?.url).to.equal('https://github.com/test/repo/pull/1');
    expect(mirror().stacks[0].branches[0].pullRequest?.merged).to.equal(true);
    expect(server().calls).to.deep.equal([]);
  });

  it('removes externally cleared PR associations while preserving the branch push lease', () => {
    create('a');
    const remoteRevision = git(['rev-parse', 'a']);
    seedPrInfo('a', {
      number: 1,
      state: 'OPEN',
      body: 'old body',
      remoteRevision,
    });
    run(['parent']);
    editMirror((data) => {
      delete data.stacks[0].branches[0].pullRequest;
    });
    run(['parent']);
    expect(prInfo('a')?.number).to.equal(undefined);
    expect(prInfo('a')?.body).to.equal(undefined);
    expect(prInfo('a')?.remoteRevision).to.equal(remoteRevision);
    expect(mirror().stacks[0].branches[0].pullRequest).to.equal(undefined);
  });

  it('does not carry old PR state, review data, or description into a replacement PR', () => {
    create('a');
    const remoteRevision = git(['rev-parse', 'a']);
    seedPrInfo('a', {
      number: 1,
      id: 'PR_1',
      state: 'MERGED',
      title: 'old title',
      body: 'old body',
      reviewDecision: 'APPROVED',
      isDraft: true,
      remoteRevision,
    });
    run(['parent']);
    editMirror((data) => {
      data.stacks[0].branches[0].pullRequest = {
        number: 2,
        id: 'PR_2',
        merged: false,
      };
    });
    run(['parent']);
    expect(prInfo('a')?.number).to.equal(2);
    expect(prInfo('a')?.id).to.equal('PR_2');
    for (const field of [
      'state',
      'title',
      'body',
      'reviewDecision',
      'isDraft',
    ] as const)
      expect(prInfo('a')?.[field]).to.equal(undefined);
    expect(prInfo('a')?.remoteRevision).to.equal(remoteRevision);
    expect(mirror().stacks[0].branches[0].pullRequest?.merged).to.equal(false);
  });

  it('preserves gt-only PR changes when gh-stack still matches the checkpoint', () => {
    create('a');
    seedPrInfo('a', { number: 1, state: 'OPEN' });
    run(['parent']);
    seedPrInfo('a', {
      number: 1,
      state: 'MERGED',
      id: 'PR_1',
      title: 'latest title',
    });
    run(['parent']);
    expect(prInfo('a')?.state).to.equal('MERGED');
    expect(prInfo('a')?.title).to.equal('latest title');
    expect(mirror().stacks[0].branches[0].pullRequest?.merged).to.equal(true);
  });

  it('never borrows a previous PR node ID or URL for a locally replaced PR number', () => {
    create('a');
    seedPrInfo('a', {
      number: 1,
      id: 'PR_1',
      url: 'https://github.com/test/repo/pull/1',
    });
    run(['parent']);
    seedPrInfo('a', { number: 2 });
    run(['parent']);
    const pr = mirror().stacks[0].branches[0].pullRequest;
    expect(pr?.number).to.equal(2);
    expect(pr?.id).to.equal(undefined);
    expect(pr?.url).to.equal(undefined);
  });

  it('preflights conflicting PR associations before writing any metadata, with explicit resolution', () => {
    create('a');
    create('b');
    seedPrInfo('b', { number: 1 });
    run(['parent']);
    seedPrInfo('b', { number: 3 });
    editMirror((data) => {
      data.stacks[0].branches[0].pullRequest = { number: 10 };
      data.stacks[0].branches[1].pullRequest = { number: 2 };
    });
    const before = git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/branch-metadata/',
    ]);
    const file = fs.readFileSync(path.join(repo, '.git/gh-stack'), 'utf8');
    expect(run(['parent'], 1)).to.contain('both changed the pull request');
    expect(
      git([
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/branch-metadata/',
      ])
    ).to.equal(before);
    expect(fs.readFileSync(path.join(repo, '.git/gh-stack'), 'utf8')).to.equal(
      file
    );
    run(['github', 'import', '--source', 'local']);
    expect(mirror().stacks[0].branches[1].pullRequest?.number).to.equal(3);
    seedPrInfo('b', { number: 4 });
    editMirror((data) => {
      data.stacks[0].branches[1].pullRequest = { number: 5 };
    });
    run(['github', 'import', '--source', 'gh-stack']);
    expect(prInfo('b')?.number).to.equal(5);
  });

  it('refuses malformed/newer gh-stack schemas before changing a branch', () => {
    create('a');
    const before = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(
      path.join(repo, '.git/gh-stack'),
      '{"schemaVersion":99,"repository":"test/repo","stacks":[]}'
    );
    expect(run(['create', 'b', '-m', 'b'], 1)).to.contain('Unsupported');
    expect(git(['rev-parse', 'HEAD'])).to.equal(before);
  });

  it('creates real native stack objects, then appends only the delta, idempotently', () => {
    create('a');
    create('b');
    run(['submit', '--stack', '--no-edit']);
    expect(server().prs).to.have.length(2);
    expect(server().stacks).to.have.length(1);
    const number = server().stacks[0].number;
    expect(mirror().stacks[0].number).to.equal(number);
    const mutations = server().calls.filter((call) =>
      call.includes('POST')
    ).length;
    run(['submit', '--stack', '--no-edit']);
    expect(
      server().calls.filter((call) => call.includes('POST'))
    ).to.have.length(mutations);
    create('c');
    run(['submit', '--stack', '--no-edit']);
    expect(server().stacks[0].number).to.equal(number);
    expect(server().stacks[0].prs).to.have.length(3);
    expect(
      server().calls.some((call) =>
        call.some((a) => a.endsWith(`/stacks/${number}/add`))
      )
    ).to.equal(true);
  });

  it('dry-run never pushes, creates PRs, or changes the gh-stack mirror', () => {
    create('a');
    create('b');
    const before = fs.readFileSync(path.join(repo, '.git/gh-stack'), 'utf8');
    run(['submit', '--stack', '--dry-run']);
    expect(server().prs).to.have.length(0);
    expect(server().stacks).to.have.length(0);
    expect(fs.readFileSync(path.join(repo, '.git/gh-stack'), 'utf8')).to.equal(
      before
    );
    expect(git(['ls-remote', '--heads', 'origin'])).not.to.contain(
      'refs/heads/a'
    );
  });

  it('does not create PRs under --update-only --always', () => {
    create('a');
    run(['submit', '--update-only', '--always']);
    expect(server().prs).to.have.length(0);
    expect(server().stacks).to.have.length(0);
  });

  it('updates draft state and reviewers in non-interactive mode', () => {
    create('a');
    create('b');
    run(['submit', '--stack', '--draft']);
    run(['submit', '--stack', '--publish', '--reviewers', 'alice']);
    expect(
      server().prs.every((pr) => !pr.isDraft && pr.reviewers === 'alice')
    ).to.equal(true);
  });

  it('repairs a partial native-API failure without duplicating PRs', () => {
    create('a');
    create('b');
    updateServer((s) => {
      s.failure = { method: 'POST', path: '/stacks', count: 1, status: 500 };
    });
    run(['submit', '--stack'], 1);
    expect(server().prs).to.have.length(2);
    expect(server().stacks).to.have.length(0);
    run(['submit', '--stack']);
    expect(server().prs).to.have.length(2);
    expect(server().stacks).to.have.length(1);
  });

  it('native API errors do not silently fall back to footer-only stacks', () => {
    create('a');
    create('b');
    updateServer((s) => {
      s.failure = { method: 'GET', path: '/stacks', count: 2, status: 404 };
    });
    expect(run(['submit', '--stack'], 1)).to.contain(
      'Stacks API is unavailable'
    );
    expect(server().prs).to.have.length(0);
    run(['submit', '--stack', '--no-stack-sync']);
    expect(server().prs).to.have.length(2);
  });

  it('replaces dependency trees despite trailing whitespace, and repairs duplicates', () => {
    create('a');
    create('b');
    run(['submit', '--stack', '--no-stack-sync']);
    const trees = (body: string) =>
      body.split('#### PR Dependency Tree').length - 1;
    expect(server().prs.map((pr) => trees(pr.body))).to.deep.equal([1, 1]);
    // An agent's `gh pr edit` left a trailing newline, and an older gt then
    // appended a second tree to one PR.
    updateServer((s) => {
      s.prs[0].body += '\n';
      s.prs[1].body = `${s.prs[1].body}\n${s.prs[1].body.trim()}\n`;
    });
    run(['submit', '--stack', '--no-stack-sync']);
    expect(server().prs.map((pr) => trees(pr.body))).to.deep.equal([1, 1]);
    expect(server().prs.every((pr) => !/\s$/.test(pr.body))).to.equal(true);
    const calls = server().calls.length;
    run(['submit', '--stack', '--no-stack-sync']);
    expect(
      server()
        .calls.slice(calls)
        .some((call) => call[1] === 'edit' && call.includes('--body-file'))
    ).to.equal(false);
    // With stack sync back on, GitHub stacks replace the stale trees.
    run(['submit', '--stack']);
    expect(server().prs.map((pr) => trees(pr.body))).to.deep.equal([0, 0]);
    expect(server().stacks).to.have.length(1);
  });

  it('fetches a GitHub stack into a fresh clone and reconstructs gt parents', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const clone = path.join(root, 'clone');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', String(server().stacks[0].number), '--no-restack'], 0, clone);
    expect(git(['branch', '--show-current'], undefined, clone)).to.equal('b');
    expect(run(['parent'], 0, clone).trim()).to.equal('a');
    const data = JSON.parse(
      fs.readFileSync(path.join(clone, '.git/gh-stack'), 'utf8')
    );
    expect(data.stacks[0].number).to.equal(server().stacks[0].number);
  });

  it('rejects a foreign PR URL without contacting its repository', () => {
    expect(run(['get', 'https://github.com/other/repo/pull/12'], 1)).to.contain(
      'different repository'
    );
    expect(server().calls).to.have.length(0);
  });

  it('keeps a single PR standalone rather than creating an invalid native stack', () => {
    create('a');
    run(['submit']);
    expect(server().prs).to.have.length(1);
    expect(server().stacks).to.have.length(0);
  });

  it('refuses remote divergence before any push or PR update', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    updateServer((s) => {
      s.stacks[0].prs.reverse();
    });
    const before = server().calls.length;
    expect(run(['submit', '--stack'], 1)).to.contain(
      'changed on GitHub since gt last synced it'
    );
    expect(
      server()
        .calls.slice(before)
        .some((call) => call[1] === 'edit' || call.includes('POST'))
    ).to.equal(false);
  });

  it('creates a commit from patch-selected, previously unstaged changes', () => {
    fs.writeFileSync(path.join(repo, 'README'), 'patched\n');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'create',
        'patch-branch',
        '--patch',
        '-m',
        'patch',
        '--interactive',
      ],
      { cwd: repo, env, input: 'y\n', encoding: 'utf8', timeout: 30_000 }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0);
    expect(git(['show', 'patch-branch:README'])).to.equal('patched');
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('modify --commit --patch stages selected hunks before checking for changes', () => {
    create('a');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'patched\n');
    const result = spawnSync(
      process.execPath,
      [cli, 'modify', '--commit', '--patch', '-m', 'patch', '--interactive'],
      { cwd: repo, env, input: 'y\n', encoding: 'utf8', timeout: 30_000 }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0);
    expect(git(['rev-list', '--count', 'main..a'])).to.equal('2');
    expect(git(['show', 'a:a.txt'])).to.equal('patched');
  });

  it('rejects non-interactive patch selection before creating a branch', () => {
    fs.writeFileSync(path.join(repo, 'README'), 'unstaged\n');
    expect(
      run(['create', 'blocked', '--patch', '-m', 'blocked'], 1)
    ).to.contain('requires interactive mode');
    expect(git(['branch', '--list', 'blocked'])).to.equal('');
    expect(git(['diff', '--cached', '--name-only'])).to.equal('');
  });

  it('does not publish branches or PRs when GitHub integration is disabled', () => {
    create('a');
    const config = path.join(repo, '.git/.graphite_repo_config');
    const data = JSON.parse(fs.readFileSync(config, 'utf8'));
    data.isGithubIntegrationEnabled = false;
    fs.writeFileSync(config, JSON.stringify(data));
    expect(run(['submit'], 1)).to.contain('GitHub integration is disabled');
    expect(server().calls).to.have.length(0);
    expect(git(['ls-remote', '--heads', 'origin'])).not.to.contain(
      'refs/heads/a'
    );
  });

  it('ignores submit selection prompts in non-interactive dry runs', () => {
    create('a');
    create('b');
    run(['submit', '--stack', '--select', '--dry-run']);
    expect(server().prs).to.have.length(0);
  });

  it('supports staged-only updates without accidentally adding untracked files', () => {
    create('a');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'tracked\n');
    fs.writeFileSync(path.join(repo, 'untracked'), 'keep me');
    run(['modify', '--update', '--no-edit']);
    expect(git(['status', '--porcelain'])).to.equal('?? untracked');
  });

  it('undo restores branch identity, staged state and originally untracked files', () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked before create\n');
    run(['create', 'a', '-am', 'new']);
    run(['undo', '--force']);
    expect(git(['branch', '--show-current'])).to.equal('main');
    expect(git(['status', '--porcelain'])).to.equal('?? new.txt');
    expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).to.equal(
      'untracked before create\n'
    );
    expect(git(['branch', '--list', 'a'])).to.equal('');
  });

  it('a failed continue cannot bless unrelated commits as part of an older undo checkpoint', () => {
    create('a');
    git(['commit', '--allow-empty', '-m', 'manual commit after gt']);
    const before = git(['rev-parse', 'a']);
    run(['continue'], 1);
    expect(run(['undo', '--force'], 1)).to.contain('outside this operation');
    expect(git(['rev-parse', 'a'])).to.equal(before);
  });

  it('persists the branch cache and stays correct when refs change outside gt', () => {
    create('a');
    create('b');
    const cacheFile = path.join(repo, '.git/.graphite_cache_persist');
    expect(fs.existsSync(cacheFile), 'cache file should be written').to.equal(
      true
    );
    const firstSha = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).sha;
    expect(run(['parent'])).to.contain('a');
    // A read-only command must not rewrite an already-valid cache.
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).sha).to.equal(
      firstSha
    );
    // Change a ref outside gt: the seed no longer matches, so gt must reparse
    // and then persist a fresh cache.
    git(['commit', '--allow-empty', '-m', 'external commit']);
    expect(run(['log', '--stack'])).to.contain('external commit');
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).sha).to.not.equal(
      firstSha
    );
  });

  it('logs every commit of a multi-commit branch, including empty subjects', () => {
    create('a');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'second\n');
    run(['modify', '--commit', '-am', 'second commit on a']);
    git(['commit', '--allow-empty', '--allow-empty-message', '-m', '']);
    const log = run(['log', '--stack']);
    expect(log).to.contain('second commit on a');
    expect(log).to.contain('- a');
    expect(git(['rev-list', '--count', 'main..a'])).to.equal('3');
  });

  it('undo refuses to discard edits made after the operation', () => {
    create('a');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'new work\n');
    expect(run(['undo', '--force'], 1)).to.contain('changed since');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).to.contain(
      'new work'
    );
  });

  it('amends a downstack branch through --into, preserving its descendants', () => {
    create('a');
    create('b');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'fix\n');
    git(['add', 'a.txt']);
    run(['modify', '--into', 'a', '-m', 'fixed a']);
    expect(git(['show', 'a:a.txt'])).to.equal('a\nfix');
    expect(git(['show', 'b:b.txt'])).to.equal('b');
    expect(git(['merge-base', 'a', 'b'])).to.equal(git(['rev-parse', 'a']));
    expect(git(['branch', '--show-current'])).to.equal('b');
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('absorb previews hunk ownership, then applies changes to the correct ancestor', () => {
    create('a');
    create('b');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
    git(['add', 'a.txt']);
    const before = git(['rev-parse', 'a']);
    const preview = run(['absorb', '--dry-run']);
    expect(preview).to.contain('Staged changes in a.txt');
    expect(preview).to.contain('Absorbing into: a');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(run(['absorb'], 1)).to.contain('--force');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    run(['absorb', '--force']);
    expect(git(['show', 'a:a.txt'])).to.equal('fixed a');
    expect(git(['show', 'b:b.txt'])).to.equal('b');
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('absorbs into the owning commit and keeps unowned hunks staged', () => {
    create('a');
    fs.writeFileSync(path.join(repo, 'a2.txt'), 'second\n');
    run(['modify', '--commit', '-am', 'second commit']);
    const tip = git(['rev-parse', 'a']);
    // One hunk owned by the first commit of a, one owned by trunk.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
    fs.writeFileSync(path.join(repo, 'README'), 'trunk change\n');
    git(['add', '.']);
    run(['absorb', '--force']);
    expect(git(['show', 'a:a.txt'])).to.equal('fixed a');
    expect(git(['show', 'a:a2.txt'])).to.equal('second');
    // The fix went into the first commit, not the tip commit.
    expect(git(['show', `a~1:a.txt`])).to.equal('fixed a');
    expect(git(['rev-parse', 'a'])).not.to.equal(tip);
    expect(git(['diff', '--cached', '--name-only'])).to.equal('README');
    expect(git(['rev-list', '--count', 'main..a'])).to.equal('2');
  });

  it('absorb uses the recorded preimage when repeated lines have shifted', () => {
    const file = path.join(repo, 'shared.txt');
    fs.writeFileSync(file, 'A\nsame\nB\nsame\nC\n');
    run(['create', 'a', '-am', 'repeated lines']);
    fs.writeFileSync(file, 'p\nq\nA\nsame\nB\nsame\nC\n');
    run(['create', 'b', '-am', 'insert prefix']);
    const expected = 'p\nq\nA\nfixed\nB\nsame\nC\n';
    fs.writeFileSync(file, expected);
    git(['add', 'shared.txt']);
    run(['absorb', '--force']);
    expect(git(['show', 'a:shared.txt'])).to.equal('A\nfixed\nB\nsame\nC');
    expect(git(['show', 'b:shared.txt'])).to.equal(expected.trim());
    expect(git(['merge-base', 'a', 'b'])).to.equal(git(['rev-parse', 'a']));
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('absorb separates nearby hunks owned by different branches in one file', () => {
    const file = path.join(repo, 'shared.txt');
    fs.writeFileSync(file, 'first in a\nseparator\nlast in a\n');
    run(['create', 'a', '-am', 'original lines']);
    fs.writeFileSync(file, 'first in a\nseparator\nlast in b\n');
    run(['create', 'b', '-am', 'change last line']);
    const expected = 'fixed first\nseparator\nfixed last\n';
    fs.writeFileSync(file, expected);
    git(['add', 'shared.txt']);
    const expectedTree = git(['write-tree']);
    run(['absorb', '--force']);
    expect(git(['show', 'a:shared.txt'])).to.equal(
      'fixed first\nseparator\nlast in a'
    );
    expect(git(['show', 'b:shared.txt'])).to.equal(expected.trim());
    expect(git(['rev-parse', 'HEAD^{tree}'])).to.equal(expectedTree);
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('absorb re-stages unowned repeated lines after an absorbed deletion shifts them', () => {
    const file = path.join(repo, 'shared.txt');
    const original = 'T\nsame\nmiddle\nsame\nend\n';
    fs.writeFileSync(file, original);
    git(['add', '.']);
    git(['commit', '-m', 'trunk repeated lines']);
    fs.writeFileSync(file, 'owned\n' + original);
    create('a');
    create('b');
    const expected = 'T\nfixed\nmiddle\nsame\nend\n';
    fs.writeFileSync(file, expected);
    git(['add', 'shared.txt']);
    const expectedTree = git(['write-tree']);
    run(['absorb', '--force']);
    expect(git(['show', 'a:shared.txt'])).to.equal(original.trim());
    expect(git(['show', 'b:shared.txt'])).to.equal(original.trim());
    expect(git(['write-tree'])).to.equal(expectedTree);
    expect(fs.readFileSync(file, 'utf8')).to.equal(expected);
    expect(git(['diff', '--cached', '--name-only'])).to.equal('shared.txt');
    expect(git(['diff', '--name-only'])).to.equal('');
  });

  it('absorb assigns zero-context insertions to the preceding line owner', () => {
    const file = path.join(repo, 'shared.txt');
    fs.writeFileSync(file, 'first\nsecond\nanchor\n');
    run(['create', 'a', '-am', 'original lines']);
    fs.writeFileSync(file, 'first\nchanged in b\nanchor\n');
    run(['create', 'b', '-am', 'change preceding line']);
    fs.appendFileSync(file, 'inserted after anchor\n');
    git(['add', 'shared.txt']);
    const before = git(['rev-parse', 'a']);
    const preview = run(['absorb', '--dry-run']);
    expect(preview).to.contain('Absorbing into: a');
    expect(preview).not.to.contain('Absorbing into: b');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(git(['diff', '--cached'])).to.contain('+inserted after anchor');
  });

  it('absorb preserves unowned text, new files and binary data in the index', () => {
    const binary = Buffer.from([0, 1, 2, 0, 255]);
    fs.writeFileSync(path.join(repo, 'binary.dat'), binary);
    git(['add', '.']);
    git(['commit', '-m', 'trunk binary']);
    create('a');
    create('b');
    const changedBinary = Buffer.from([0, 3, 4, 0, 254]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
    fs.writeFileSync(path.join(repo, 'README'), 'trunk change\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'keep staged\n');
    fs.writeFileSync(path.join(repo, 'binary.dat'), changedBinary);
    git(['add', '.']);
    const expectedTree = git(['write-tree']);
    run(['absorb', '--force']);
    expect(git(['show', 'a:a.txt'])).to.equal('fixed a');
    expect(git(['show', 'b:b.txt'])).to.equal('b');
    expect(git(['write-tree'])).to.equal(expectedTree);
    expect(git(['diff', '--name-only'])).to.equal('');
    expect(git(['diff', '--cached', '--name-only']).split('\n')).to.deep.equal([
      'README',
      'binary.dat',
      'new.txt',
    ]);
    expect(fs.readFileSync(path.join(repo, 'binary.dat'))).to.deep.equal(
      changedBinary
    );
  });

  it('absorb keeps conflict guidance visible and abort restores the original staged tree', () => {
    create('a');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'sibling change\n');
    run(['create', 'sibling', '-am', 'conflicting sibling']);
    run(['checkout', 'a']);
    create('b');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'absorbed change\n');
    git(['add', 'a.txt']);
    const branches = ['a', 'b', 'sibling'];
    const before = branches.map((branch) => git(['rev-parse', branch]));
    const expectedTree = git(['write-tree']);
    const output = run(['absorb', '--force'], 1);
    expect(output).to.contain('Unmerged files:');
    expect(output).to.contain('gt continue');
    expect(output).to.contain('gt abort');
    run(['abort', '--force']);
    expect(branches.map((branch) => git(['rev-parse', branch]))).to.deep.equal(
      before
    );
    expect(git(['branch', '--show-current'])).to.equal('b');
    expect(git(['write-tree'])).to.equal(expectedTree);
    expect(git(['diff', '--name-only'])).to.equal('');
  });

  it('absorb does not report a frozen descendant as restacked', () => {
    create('a');
    create('b');
    run(['freeze', 'b', '--only']);
    run(['checkout', 'a']);
    const before = git(['rev-parse', 'b']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixed a\n');
    git(['add', 'a.txt']);
    const output = run(['absorb', '--force']);
    expect(output).to.contain('because it is frozen');
    expect(output).not.to.contain('b restacked');
    expect(git(['rev-parse', 'b'])).to.equal(before);
    expect(git(['show', 'a:a.txt'])).to.equal('fixed a');
    expect(git(['status', '--porcelain'])).to.equal('');
  });

  it('modify on a branch without commits creates a commit like gt', () => {
    run(['create', 'empty-branch']);
    fs.writeFileSync(path.join(repo, 'empty.txt'), 'content\n');
    run(['modify', '-am', 'first commit']);
    expect(git(['rev-list', '--count', 'main..empty-branch'])).to.equal('1');
    expect(git(['show', 'empty-branch:empty.txt'])).to.equal('content');
  });

  it('submit --target-trunk retargets PRs without rebasing local branches', () => {
    git(['branch', 'release', 'main']);
    git(['push', 'origin', 'release']);
    create('a');
    const sha = git(['rev-parse', 'a']);
    run(['submit', '--target-trunk', 'release']);
    expect(server().prs[0].baseRefName).to.equal('release');
    expect(git(['rev-parse', 'a'])).to.equal(sha);
    expect(run(['parent']).trim()).to.equal('main');
  });

  it('warns but submits safely when trunk advances between sync and submit, like Graphite', () => {
    create('a');
    const localTrunk = git(['rev-parse', 'main']);
    const mover = path.join(root, 'trunk-mover');
    git(['clone', server().gitDir, mover]);
    git(['config', 'user.name', 'Test'], undefined, mover);
    git(['config', 'user.email', 'test@example.com'], undefined, mover);
    fs.writeFileSync(path.join(mover, 'moved.txt'), 'moved\n');
    git(['add', '.'], undefined, mover);
    git(['commit', '-m', 'move trunk'], undefined, mover);
    git(['push', 'origin', 'main'], undefined, mover);
    const remoteTrunk = git(['ls-remote', '--heads', 'origin', 'main']);
    expect(run(['submit', '--dry-run'])).to.contain('out of sync');
    expect(server().prs).to.have.length(0);
    expect(run(['submit'])).to.contain('out of sync');
    expect(server().prs).to.have.length(1);
    expect(server().prs[0].baseRefName).to.equal('main');
    expect(git(['rev-parse', 'main'])).to.equal(localTrunk);
    expect(git(['ls-remote', '--heads', 'origin', 'main'])).to.equal(
      remoteTrunk
    );
    expect(run(['submit', '--ignore-out-of-sync-trunk'])).not.to.contain(
      'out of sync'
    );
    expect(server().prs).to.have.length(1);
  });

  it('sync fast-forwards branches that moved on the remote', () => {
    create('a');
    run(['submit']);
    const collab = path.join(root, 'ff-collab');
    git(['clone', server().gitDir, collab]);
    git(['config', 'user.name', 'Test'], undefined, collab);
    git(['config', 'user.email', 'test@example.com'], undefined, collab);
    git(['checkout', 'a'], undefined, collab);
    fs.writeFileSync(path.join(collab, 'extra.txt'), 'collab\n');
    git(['add', '.'], undefined, collab);
    git(['commit', '-m', 'collab work'], undefined, collab);
    git(['push', 'origin', 'a'], undefined, collab);
    const remoteSha = git(['rev-parse', 'HEAD'], undefined, collab);
    run(['sync', '--no-restack']);
    expect(git(['rev-parse', 'a'])).to.equal(remoteSha);
    expect(git(['show', 'a:extra.txt'])).to.equal('collab');
  });

  it('get freezes newly fetched branches until unfreeze or --unfrozen', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const clone = path.join(root, 'freeze-clone');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', 'b', '--no-restack'], 0, clone);
    fs.appendFileSync(path.join(clone, 'b.txt'), 'edit\n');
    expect(run(['modify', '-am', 'edit'], 1, clone)).to.contain('frozen');
    run(['unfreeze'], 0, clone);
    run(['modify', '-am', 'edit'], 0, clone);
  });

  it('fold --close merges a branch into its parent and closes its PR', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['fold', '--close']);
    expect(git(['branch', '--list', 'b'])).to.equal('');
    expect(git(['show', 'a:b.txt'])).to.equal('b');
    expect(server().prs.find((pr) => pr.number === 2)?.state).to.equal(
      'CLOSED'
    );
  });

  it('fold --stack folds the whole stack into the bottom branch', () => {
    create('a');
    create('b');
    create('c');
    run(['fold', '--stack']);
    expect(git(['branch', '--list', 'b'])).to.equal('');
    expect(git(['branch', '--list', 'c'])).to.equal('');
    expect(git(['show', 'a:c.txt'])).to.equal('c');
    expect(git(['branch', '--show-current'])).to.equal('a');
  });

  it('split --by-file extracts matching files into a new parent branch', () => {
    fs.writeFileSync(path.join(repo, 'code.ts'), 'code\n');
    fs.writeFileSync(path.join(repo, 'spec.json'), 'spec\n');
    run(['create', 'a', '-am', 'both files']);
    run(['split', '--by-file', 'spec.json', '--names', 'spec-base']);
    expect(git(['show', 'spec-base:spec.json'])).to.equal('spec');
    expect(git(['show', 'a:code.ts'])).to.equal('code');
    expect(run(['parent']).trim()).to.equal('spec-base');
    expect(git(['branch', '--show-current'])).to.equal('a');
    expect(mirror().stacks[0].branches.map((b) => b.branch)).to.deep.equal([
      'spec-base',
      'a',
    ]);
  });

  it('expands user-configured aliases from the user config', () => {
    create('a');
    const config = path.join(repo, '.git/.graphite_user_config');
    const data = JSON.parse(fs.readFileSync(config, 'utf8'));
    data.aliases = [{ alias: 'yolo', command: 'log short' }];
    fs.writeFileSync(config, JSON.stringify(data));
    expect(run(['yolo'])).to.contain('a');
  });

  it('interactive submit offers to include upstack branches with open PRs', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'a']);
    const result = spawnSync(
      process.execPath,
      [cli, 'submit', '--interactive'],
      { cwd: repo, env, input: 'y\n', encoding: 'utf8', timeout: 30_000 }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0);
    expect(result.stdout).to.contain('Include 1 upstack branch(es)');
  });

  it('frozen branches reject modifications until explicitly unfrozen', () => {
    create('a');
    run(['freeze']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'fix\n');
    expect(run(['modify', '-am', 'change'], 1)).to.contain('frozen');
    run(['unfreeze']);
    run(['modify', '-am', 'change']);
    expect(git(['show', 'a:a.txt'])).to.equal('a\nfix');
  });

  it('supports modern aliases, legacy shortcuts, global cwd, and Git passthrough', () => {
    run(['c', 'a', '-m', 'a']);
    run(['bc', 'b', '-m', 'b']);
    run(['--cwd', repo, 'co', 'a'], 0, root);
    expect(git(['branch', '--show-current'])).to.equal('a');
    expect(run([`--cwd=${repo}`, 'ls'], 0, root)).to.contain('a');
    run(['status', '--short']);
    run(['co', 'b']);
    run(['b']);
    expect(git(['branch', '--show-current'])).to.equal('a');
  });

  it('supports multiple trunks without duplicating branches in the mirror', () => {
    create('a');
    git(['branch', 'release', 'main']);
    run(['trunk', '--add', 'release']);
    run(['checkout', 'release']);
    create('hotfix');
    expect(run(['trunk']).trim()).to.equal('release');
    expect(run(['trunk', '--all']).trim().split('\n')).to.deep.equal([
      'main',
      'release',
    ]);
    expect(mirror().stacks.map((s) => s.trunk.branch)).to.deep.equal([
      'main',
      'release',
    ]);
    // Like gt: log shows the current trunk by default; --all shows every trunk.
    expect(run(['log', 'short'])).not.to.contain('main');
    expect(run(['log', 'short', '--all'])).to.contain('main');
  });

  it('reorders a submitted stack by unstacking BEFORE PR retargeting and recreates its identity', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const oldNumber = server().stacks[0].number;
    run(['reorder', '--order', 'b,a']);
    expect(run(['parent']).trim()).to.equal('b');
    run(['submit', '--stack']);
    const state = server();
    expect(state.prs).to.have.length(2);
    expect(state.stacks).to.have.length(1);
    expect(state.stacks[0].number).not.to.equal(oldNumber);
    expect(state.stacks[0].prs).to.deep.equal([2, 1]);
    const unstack = state.calls.findIndex((call) =>
      call.some((a) => a.endsWith(`/stacks/${oldNumber}/unstack`))
    );
    const retarget = state.calls.findIndex(
      (call) => call[1] === 'edit' && call.includes('--base')
    );
    expect(unstack).to.be.greaterThan(-1);
    expect(unstack).to.be.lessThan(retarget);
  });

  it('reconciles a fork into disjoint native stacks, including untouched former stack members', () => {
    create('a');
    create('b');
    create('d');
    run(['submit', '--stack']);
    run(['checkout', 'a']);
    create('c');
    create('e');
    run(['submit', '--stack']);
    const state = server();
    expect(state.prs).to.have.length(5);
    expect(state.stacks).to.have.length(2);
    expect(state.stacks.map((s) => s.base)).to.deep.equal(['a', 'a']);
    const members = state.stacks.flatMap((s) => s.prs);
    expect(new Set(members).size).to.equal(4);
    expect(mirror().stacks.filter((s) => s.number)).to.have.length(2);
  });

  it('syncs a native stack that spans a local fork from a worktree without checkpoints', () => {
    create('a');
    create('b');
    create('c');
    run(['submit', '--stack']);
    const number = server().stacks[0].number;
    // Forking below a splits the local chain; GitHub still holds a, b, c as
    // one stack. A linked worktree has no record of synchronizing it.
    run(['checkout', 'a']);
    create('d');
    run(['checkout', 'main']);
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'main']);
    const output = run(['sync', '--no-restack'], 0, linked);
    expect(output).not.to.contain('diverged');
    expect(output).not.to.contain('Imported');
    expect(server().stacks.map((s) => s.prs)).to.deep.equal([[1, 2, 3]]);
    // The spanning stack counts as synchronized there, so submitting the fork
    // can later split it into linear stacks instead of refusing.
    const linkedState: MirrorState = JSON.parse(
      fs.readFileSync(
        path.join(
          git(['rev-parse', '--absolute-git-dir'], undefined, linked),
          'gt-github-sync'
        ),
        'utf8'
      )
    );
    expect(linkedState.remote[String(number)]?.prs).to.deep.equal([1, 2, 3]);
    run(['checkout', 'd'], 0, linked);
    run(['submit', '--stack'], 0, linked);
    const stacks = server().stacks;
    expect(stacks.some((s) => s.number === number)).to.equal(false);
    expect(stacks.map((s) => s.prs.sort())).to.deep.equal([[2, 3]]);
    expect(stacks[0].base).to.equal('a');
  });

  it('joins two previously submitted stacks without duplicate PRs', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    create('c');
    create('d');
    run(['submit', '--stack']);
    run(['move', '--source', 'c', '--onto', 'b']);
    run(['submit', '--stack']);
    expect(server().prs).to.have.length(4);
    expect(server().stacks).to.have.length(1);
    expect(server().stacks[0].prs).to.have.length(4);
  });

  it('refuses locked native stack replacements without pushing rebased branches', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const remoteBefore = git(['ls-remote', '--heads', 'origin']);
    run(['reorder', '--order', 'b,a']);
    updateServer((s) => {
      s.locked = true;
    });
    expect(run(['submit', '--stack'], 1)).to.contain('locked PRs');
    expect(git(['ls-remote', '--heads', 'origin'])).to.equal(remoteBefore);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
  });

  it('retries safely after unstack succeeds but native recreation fails', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['reorder', '--order', 'b,a']);
    updateServer((s) => {
      s.failure = { method: 'POST', path: '/stacks', count: 1, status: 500 };
    });
    run(['submit', '--stack'], 1);
    expect(server().stacks).to.have.length(0);
    run(['submit', '--stack']);
    expect(server().prs).to.have.length(2);
    expect(server().stacks[0].prs).to.deep.equal([2, 1]);
  });

  it('pulls a remote-ahead native stack during sync without opening PRs or pushing', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const clone = path.join(root, 'collaborator');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', String(server().stacks[0].number), '--no-restack'], 0, clone);
    fs.writeFileSync(path.join(clone, 'c.txt'), 'collaborator\n');
    run(['create', 'c', '-am', 'c'], 0, clone);
    run(['submit', '--stack'], 0, clone);
    const count = server().calls.length;
    run(['sync', '--no-restack']);
    expect(mirror().stacks[0].branches.map((b) => b.branch)).to.deep.equal([
      'a',
      'b',
      'c',
    ]);
    expect(
      server()
        .calls.slice(count)
        .some(
          (call) =>
            call.includes('POST') || call[1] === 'create' || call[1] === 'edit'
        )
    ).to.equal(false);
    expect(git(['branch', '--show-current'])).to.equal('b');
  });

  it('adopts rebuilt stacks instead of matching their merged-only historical number', () => {
    create('merged');
    create('a');
    create('b');
    run(['submit', '--stack']);
    const oldNumber = server().stacks[0].number;
    const replacement = server().next;
    updateServer((s) => {
      s.prs[0].state = 'MERGED';
      s.prs[1].baseRefName = 'main';
      s.stacks[0].prs = [s.prs[0].number];
      s.stacks.push({
        number: s.next++,
        base: 'main',
        prs: s.prs.slice(1).map((pr) => pr.number),
      });
    });
    expect(syncState().remote[String(replacement)]).to.equal(undefined);
    const calls = server().calls.length;

    const output = run(['sync', '--delete-all']);

    expect(output).not.to.contain('multiple GitHub stacks');
    expect(git(['branch', '--list', 'merged'])).to.equal('');
    const local = mirror().stacks.find((s) => s.branches[0].branch === 'a')!;
    expect(local.number).to.equal(replacement);
    expect(local.number).not.to.equal(oldNumber);
    expect(local.branches.map((b) => b.branch)).to.deep.equal(['a', 'b']);
    expect(syncState().remote[String(replacement)]).to.deep.equal({
      base: 'main',
      prs: [2, 3],
    });
    expect(
      server()
        .calls.slice(calls)
        .some((call) => call.includes('POST'))
    ).to.equal(false);
  });

  it('warns for ambiguous stacks without checkpointing them or stopping other sync work', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const original = server().stacks[0].number;
    const previous = syncState().remote[String(original)];
    const replacement = server().next;
    updateServer((s) => {
      s.stacks[0].prs = [1];
      s.stacks.push({ number: s.next++, base: 'a', prs: [2] });
    });
    run(['checkout', 'main']);
    create('healthy');
    create('healthy-child');
    run(['submit', '--stack']);
    const clone = path.join(root, 'collaborator');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', 'healthy-child', '--no-restack'], 0, clone);
    fs.writeFileSync(path.join(clone, 'new.txt'), 'remote extension\n');
    run(['create', 'new', '-am', 'new'], 0, clone);
    run(['submit', '--stack'], 0, clone);
    run(['checkout', 'main'], 0, clone);
    fs.writeFileSync(path.join(clone, 'trunk.txt'), 'new trunk\n');
    git(['add', '--', 'trunk.txt'], undefined, clone);
    git(['commit', '-m', 'advance trunk'], undefined, clone);
    git(['push', 'origin', 'main'], undefined, clone);
    const trunk = git(['rev-parse', 'main'], undefined, clone);
    run(['checkout', 'main']);
    const calls = server().calls.length;

    const output = run(['sync']);

    expect(output).to.contain(
      'Local stack [a -> b] matches multiple GitHub stacks'
    );
    expect(output).to.contain(`#${original}`);
    expect(output).to.contain(`#${replacement}`);
    expect(output).to.contain('gt get <stack-number>');
    expect(output).to.contain('Imported new branches from GitHub stack');
    expect(output).to.contain('Restacked healthy on main.');
    expect(git(['rev-parse', 'main'])).to.equal(trunk);
    expect(git(['branch', '--list', 'new'])).not.to.equal('');
    expect(syncState().remote[String(original)]).to.deep.equal(previous);
    expect(syncState().remote[String(replacement)]).to.equal(undefined);
    expect(
      mirror().stacks.find((s) => s.branches[0].branch === 'a')?.number
    ).to.equal(original);
    expect(
      server()
        .calls.slice(calls)
        .some((call) => call.includes('POST'))
    ).to.equal(false);
  });

  it('warns on divergent topology during sync without blessing it for later submit', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    const number = server().stacks[0].number;
    const previous = syncState().remote[String(number)];
    updateServer((s) => {
      s.stacks[0].prs.reverse();
      s.prs[1].baseRefName = 'main';
      s.prs[0].baseRefName = 'b';
    });
    const before = git(['show-ref', '--heads']);
    const output = run(['sync', '--no-restack']);
    expect(output).to.contain(
      `GitHub stack #${number} and local stack [a -> b] diverged`
    );
    expect(output).to.contain(`gt get ${number}`);
    expect(output).to.contain('main is up to date.');
    expect(git(['show-ref', '--heads'])).to.equal(before);
    expect(syncState().remote[String(number)]).to.deep.equal(previous);
    expect(run(['submit', '--stack'], 1)).to.contain(
      'changed on GitHub since gt last synced it'
    );
  });

  it('preserves local commits during get unless --force is explicit', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'local only\n');
    run(['modify', '-am', 'local only']);
    const before = git(['rev-parse', 'b']);
    expect(run(['get', String(server().stacks[0].number)], 1)).to.contain(
      'local commits'
    );
    expect(git(['rev-parse', 'b'])).to.equal(before);
    run(['get', String(server().stacks[0].number), '--force']);
    expect(git(['show', 'b:b.txt'])).to.equal('b');
  });

  for (const withPrCache of [true, false]) {
    it(`protects the first post-migration push after a background fetch (PR cache: ${withPrCache})`, () => {
      create('a');
      const published = git(['rev-parse', 'a']);
      git(['push', 'origin', 'a']);
      updateServer((state) => {
        state.next = 2;
        state.prs.push({
          number: 1,
          headRefName: 'a',
          baseRefName: 'main',
          title: 'a',
          body: 'Previously submitted with Graphite',
          state: 'OPEN',
          isDraft: true,
        });
      });
      // Simulate a Graphite-published branch with no gt-gh metadata yet.
      git(['update-ref', '-d', 'refs/branch-metadata/a']);
      execFileSync(
        'sqlite3',
        [
          path.join(repo, '.git/.graphite_metadata.db'),
          `CREATE TABLE branch_metadata (branch_name TEXT, parent_branch_name TEXT, parent_branch_revision TEXT, last_submitted_version TEXT);
         INSERT INTO branch_metadata VALUES ('a', 'main', '${git([
           'rev-parse',
           'main',
         ])}', '{"headSha":"${published}"}');`,
        ],
        { env, stdio: 'pipe' }
      );
      if (withPrCache) {
        fs.writeFileSync(
          path.join(repo, '.git/.graphite_pr_info'),
          JSON.stringify({
            prInfos: [{ headRefName: 'a', prNumber: 1, state: 'OPEN' }],
          })
        );
      }
      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, '../../../scripts/migrate-from-graphite.cjs'),
          '--repo',
          repo,
        ],
        { cwd: repo, env, stdio: 'pipe', timeout: 15_000 }
      );
      expect(prInfo('a')?.remoteRevision).to.equal(published);

      const collaborator = path.join(root, 'collaborator');
      git(['clone', server().gitDir, collaborator]);
      configure(collaborator);
      git(['checkout', 'a'], undefined, collaborator);
      fs.writeFileSync(path.join(collaborator, 'a.txt'), 'collaborator\n');
      git(['add', '.'], undefined, collaborator);
      git(['commit', '-m', 'collaborator'], undefined, collaborator);
      git(['push', 'origin', 'a'], undefined, collaborator);
      const remote = git(['ls-remote', '--heads', 'origin', 'a']);
      git(['fetch', 'origin']);
      expect(git(['rev-parse', 'origin/a'])).not.to.equal(published);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'local\n');
      run(['modify', '-am', 'local']);
      const local = git(['rev-parse', 'a']);
      expect(run(['submit'], 1)).to.contain('external changes');
      expect(git(['rev-parse', 'a'])).to.equal(local);
      expect(git(['ls-remote', '--heads', 'origin', 'a'])).to.equal(remote);
      expect(prInfo('a')?.remoteRevision).to.equal(published);
      expect(server().prs).to.have.length(1);
    });
  }

  it('uses an explicit published-tip lease even after a background fetch updates tracking refs', () => {
    create('a');
    run(['submit']);
    const clone = path.join(root, 'collaborator');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    git(['checkout', 'a'], undefined, clone);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'collaborator\n');
    git(['add', '.'], undefined, clone);
    git(['commit', '-m', 'collaborator'], undefined, clone);
    git(['push', 'origin', 'a'], undefined, clone);
    const remote = git(['ls-remote', '--heads', 'origin', 'a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'local\n');
    run(['modify', '-am', 'local']);
    git(['fetch', 'origin']);
    expect(run(['submit'], 1)).to.contain('external changes');
    expect(git(['ls-remote', '--heads', 'origin', 'a'])).to.equal(remote);
  });

  it('moves only the selected branch, leaving descendants on its former parent', () => {
    create('a');
    create('b');
    create('c');
    run(['move', '--source', 'b', '--onto', 'main', '--only']);
    expect(git(['branch', '--show-current'])).to.equal('c');
    expect(run(['parent']).trim()).to.equal('a');
    run(['checkout', 'b']);
    expect(run(['parent']).trim()).to.equal('main');
  });

  it('splits commits non-interactively and mirrors the resulting chain', () => {
    create('a');
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n');
    run(['modify', '--commit', '-am', 'second']);
    run(['split', '--by-commit', '--names', 'first,a']);
    expect(mirror().stacks[0].branches.map((b) => b.branch)).to.deep.equal([
      'first',
      'a',
    ]);
    expect(git(['rev-list', '--count', 'main..first'])).to.equal('1');
    expect(git(['rev-list', '--count', 'first..a'])).to.equal('1');
  });

  it('closes and deletes a downstack in child-first order, dissolving remote membership', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['delete', '--downstack', '--close']);
    expect(server().prs.every((p) => p.state === 'CLOSED')).to.equal(true);
    expect(server().stacks).to.have.length(0);
    expect(git(['branch', '--show-current'])).to.equal('main');
    expect(mirror().stacks).to.have.length(0);
    expect(syncState().removedPullRequests).to.deep.equal([]);
  });

  for (const command of [
    ['sync', '--no-restack'],
    ['github', 'sync'],
  ]) {
    it(`${command.join(
      ' '
    )} removes externally closed suffixes without re-adding their cached PRs`, () => {
      ['a', 'b', 'c', 'd'].forEach(create);
      run(['submit', '--stack']);
      const old = server().stacks[0].number;
      const refs = git(['ls-remote', '--heads', 'origin']);
      updateServer((s) => {
        s.prs
          .filter((pr) => ['c', 'd'].includes(pr.headRefName))
          .forEach((pr) => {
            pr.state = 'CLOSED';
          });
      });
      const prs = server().prs;
      run(command);
      expect(server().stacks).to.have.length(1);
      expect(server().stacks[0].number).not.to.equal(old);
      expect(server().stacks[0].prs).to.deep.equal([1, 2]);
      expect(server().prs).to.deep.equal(prs);
      expect(git(['ls-remote', '--heads', 'origin'])).to.equal(refs);
      expect(mirror().stacks[0].number).to.equal(server().stacks[0].number);
      expect(prInfo('c')?.state).to.equal('CLOSED');
      const writes = server().calls.filter((call) =>
        call.includes('POST')
      ).length;
      run(command);
      expect(
        server().calls.filter((call) => call.includes('POST'))
      ).to.have.length(writes);
    });
  }

  it('plans closed PR cleanup without remote writes or mirror changes during dry-run', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs[2].state = 'CLOSED';
    });
    const before = mirror();
    const metadata = syncState();
    const stacks = server().stacks;
    const count = server().calls.length;
    expect(run(['github', 'sync', '--dry-run'])).to.contain(
      'prune obsolete PRs'
    );
    expect(server().stacks).to.deep.equal(stacks);
    expect(mirror()).to.deep.equal(before);
    expect(syncState()).to.deep.equal(metadata);
    expect(
      server()
        .calls.slice(count)
        .some((call) => call.includes('POST'))
    ).to.equal(false);
  });

  it('deleting an open PR branch removes membership without closing PRs or deleting remote refs', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    const prs = server().prs;
    const refs = git(['ls-remote', '--heads', 'origin']);
    run(['delete', 'c', '--force', '--stack-sync']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(server().prs).to.deep.equal(prs);
    expect(git(['ls-remote', '--heads', 'origin'])).to.equal(refs);
    expect(git(['branch', '--list', 'c'])).to.equal('');
  });

  for (const stackSync of [true, false]) {
    it(`never re-adds a closed descendant that was outside the submitted scope (${
      stackSync ? 'immediate' : 'deferred'
    } cleanup)`, () => {
      ['a', 'b', 'c', 'd'].forEach(create);
      run(['submit', '--stack']);
      updateServer((s) => {
        s.prs[2].state = 'CLOSED';
        s.prs[3].state = 'CLOSED';
      });
      run(['delete', 'c', '--force', ...(stackSync ? ['--stack-sync'] : [])]);
      if (stackSync) expect(prInfo('d')?.state).to.equal('CLOSED');
      run(['checkout', 'b']);
      run(['submit']);
      expect(server().stacks[0].prs).to.deep.equal([1, 2]);
      expect(server().prs).to.have.length(4);
    });
  }

  it('fold --close prunes the discarded PR while preserving the retained local changes', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    const remoteB = git(['ls-remote', '--heads', 'origin', 'b']);
    run(['fold', '--close']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(server().prs[2].state).to.equal('CLOSED');
    expect(git(['show', 'b:c.txt'])).to.equal('c');
    expect(git(['ls-remote', '--heads', 'origin', 'b'])).to.equal(remoteB);
  });

  it('remembers raw Git deletions across local commands, including deletion of the whole stack', () => {
    ['a', 'b'].forEach(create);
    run(['submit', '--stack']);
    git(['checkout', 'main']);
    git(['branch', '-D', 'a', 'b']);
    const calls = server().calls.length;
    run(['log']);
    expect(server().calls).to.have.length(calls);
    expect(syncState().removedPullRequests).to.have.members([1, 2]);
    run(['sync', '--no-restack']);
    expect(server().stacks).to.have.length(0);
    expect(server().prs.every((pr) => pr.state === 'OPEN')).to.equal(true);
    expect(syncState().removedPullRequests).to.deep.equal([]);
  });

  it('remembers deletion when gh-stack also removed the local branch record', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    git(['checkout', 'b']);
    git(['branch', '-D', 'c']);
    editMirror((data) => {
      data.stacks[0].branches.pop();
    });
    run(['sync', '--no-restack']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(server().prs[2].state).to.equal('OPEN');
  });

  for (const command of [
    ['sync', '--no-restack'],
    ['submit', '--stack'],
  ]) {
    for (const local of [
      ['delete', 'c', '--force'],
      ['branch', 'delete', 'c', '--force'],
      ['fold'],
    ]) {
      it(`${command.join(' ')} repairs stack membership deferred by ${local.join(
        ' '
      )}`, () => {
        ['a', 'b', 'c'].forEach(create);
        run(['submit', '--stack']);
        const old = server().stacks[0].number;
        const calls = server().calls.length;
        run(local);
        expect(server().calls).to.have.length(calls);
        expect(server().stacks[0].prs).to.deep.equal([1, 2, 3]);
        expect(syncState().removedPullRequests).to.deep.equal([3]);
        run(command);
        expect(server().stacks[0].prs).to.deep.equal([1, 2]);
        expect(server().stacks[0].number).not.to.equal(old);
        expect(syncState().removedPullRequests).to.deep.equal([]);
      });
    }
  }

  it('delete --stack-sync warns instead of failing when GitHub is unreachable', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.failure = { method: 'GET', path: '/stacks', count: 1, status: 500 };
    });
    expect(run(['delete', 'c', '--force', '--stack-sync'])).to.contain(
      'retried on the next gt submit or gt sync'
    );
    expect(git(['branch', '--list', 'c'])).to.equal('');
    expect(server().stacks[0].prs).to.deep.equal([1, 2, 3]);
    run(['sync', '--no-restack']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(syncState().removedPullRequests).to.deep.equal([]);
  });

  it('prunes closed middle PRs into valid surviving segments without retargeting bases', () => {
    ['a', 'b', 'c', 'd'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs[1].state = 'CLOSED';
    });
    const bases = server().prs.map((pr) => pr.baseRefName);
    run(['sync', '--no-restack']);
    expect(server().stacks).to.have.length(1);
    expect(server().stacks[0].prs).to.deep.equal([3, 4]);
    expect(server().stacks[0].base).to.equal('b');
    expect(server().prs.map((pr) => pr.baseRefName)).to.deep.equal(bases);
  });

  it('sync preserves multiple survivor segments after a middle PR closes', () => {
    ['a', 'b', 'c', 'd', 'e'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs[2].state = 'CLOSED';
    });
    run(['sync', '--no-restack']);
    expect(server().stacks.map((s) => s.prs)).to.deep.equal([
      [1, 2],
      [4, 5],
    ]);
    const writes = server().calls.filter((call) =>
      call.includes('POST')
    ).length;
    run(['sync', '--no-restack']);
    expect(
      server().calls.filter((call) => call.includes('POST'))
    ).to.have.length(writes);
  });

  it('leaves merged history on GitHub while rebuilding only open survivors', () => {
    ['a', 'b', 'c', 'd'].forEach(create);
    run(['submit', '--stack']);
    const old = server().stacks[0].number;
    updateServer((s) => {
      s.prs[0].state = 'MERGED';
      s.prs[3].state = 'CLOSED';
    });
    run(['sync', '--no-restack']);
    expect(server().stacks.find((s) => s.number === old)?.prs).to.deep.equal([
      1,
    ]);
    const active = server().stacks.find((s) => s.number !== old);
    expect(active?.prs).to.deep.equal([2, 3]);
    expect(mirror().stacks[0].number).to.equal(active?.number);
  });

  it('dissolves an all-closed stack even while its local branches still exist', () => {
    ['a', 'b'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs.forEach((pr) => {
        pr.state = 'CLOSED';
      });
    });
    run(['github', 'sync']);
    expect(server().stacks).to.have.length(0);
    expect(mirror().stacks[0].number).to.equal(undefined);
    expect(git(['branch', '--list', 'a', 'b'])).to.contain('a');
    expect(syncState().remote).to.deep.equal({});
  });

  it('retries cleanup after unstack succeeds but recreation fails', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs[2].state = 'CLOSED';
      s.failure = { method: 'POST', path: '/stacks', count: 1, status: 500 };
    });
    run(['github', 'sync'], 1);
    expect(server().stacks).to.have.length(0);
    expect(Object.keys(syncState().pendingStackCleanups ?? {})).to.have.length(
      1
    );
    run(['github', 'sync']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(syncState().pendingStackCleanups).to.deep.equal({});
    const writes = server().calls.filter((call) =>
      call.includes('POST')
    ).length;
    run(['github', 'sync']);
    expect(
      server().calls.filter((call) => call.includes('POST'))
    ).to.have.length(writes);
  });

  it('cleanup preserves and recovers remote-only survivors, never mistaking a partial checkout for deletion', () => {
    ['a', 'b', 'c', 'd'].forEach(create);
    run(['submit', '--stack']);
    const clone = path.join(root, 'partial');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', 'b', '--no-restack', '--unfrozen'], 0, clone);
    updateServer((s) => {
      s.failure = { method: 'POST', path: '/stacks', count: 1, status: 500 };
    });
    expect(
      run(['delete', 'b', '--force', '--stack-sync'], 0, clone)
    ).to.contain('GitHub stack cleanup failed');
    expect(server().stacks).to.have.length(0);
    run(['github', 'sync'], 0, clone);
    expect(server().stacks).to.have.length(1);
    expect(server().stacks[0].prs).to.deep.equal([3, 4]);
    expect(server().stacks[0].base).to.equal('b');
    expect(server().prs.every((pr) => pr.state === 'OPEN')).to.equal(true);
    expect(git(['branch', '--list', 'c', 'd'], undefined, clone)).to.equal('');
  });

  it('does not prune closed members of an unrelated stack absent from local tracking', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    const clone = path.join(root, 'unrelated');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    for (const branch of ['x', 'y']) {
      fs.writeFileSync(path.join(clone, `${branch}.txt`), `${branch}\n`);
      run(['create', branch, '-am', branch], 0, clone);
    }
    run(['submit', '--stack'], 0, clone);
    const foreign = server().stacks[1];
    updateServer((s) => {
      s.prs
        .filter((pr) => ['c', 'y'].includes(pr.headRefName))
        .forEach((pr) => {
          pr.state = 'CLOSED';
        });
    });
    run(['sync', '--no-restack']);
    expect(
      server().stacks.find((s) => s.number === foreign.number)
    ).to.deep.equal(foreign);
    expect(
      server().stacks.find((s) => s.number !== foreign.number)?.prs
    ).to.deep.equal([1, 2]);
  });

  it('keeps occupied stacks out of remote cleanup', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    git(['worktree', 'add', path.join(root, 'occupied'), 'b']);
    updateServer((s) => {
      s.prs[2].state = 'CLOSED';
    });
    const stack = server().stacks[0];
    const calls = server().calls.length;
    run(['sync', '--no-restack']);
    expect(server().stacks[0]).to.deep.equal(stack);
    expect(
      server()
        .calls.slice(calls)
        .some((call) => call.includes('POST'))
    ).to.equal(false);
  });

  it('retries locked stack cleanup without losing deletion intent', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.locked = true;
    });
    expect(run(['delete', 'c', '--force', '--stack-sync'])).to.contain(
      'locked PRs'
    );
    expect(server().stacks[0].prs).to.deep.equal([1, 2, 3]);
    expect(syncState().removedPullRequests).to.deep.equal([3]);
    updateServer((s) => {
      s.locked = false;
    });
    run(['github', 'sync']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(syncState().removedPullRequests).to.deep.equal([]);
  });

  it('legacy branch delete --stack-sync removes the deleted PR from native stacks', () => {
    ['a', 'b'].forEach(create);
    run(['submit', '--stack']);
    run(['branch', 'delete', 'b', '--force', '--stack-sync']);
    expect(server().stacks).to.have.length(0);
    expect(server().prs.every((pr) => pr.state === 'OPEN')).to.equal(true);
  });

  it('cleans closed orphan stacks checkpointed before deletion tombstones were supported', () => {
    ['a', 'b'].forEach(create);
    run(['submit', '--stack']);
    git(['checkout', 'main']);
    git(['branch', '-D', 'a', 'b']);
    run(['log']);
    const previous = syncState();
    delete previous.removedPullRequests;
    fs.writeFileSync(
      path.join(repo, '.git/gt-github-sync'),
      JSON.stringify(previous)
    );
    updateServer((s) => {
      s.prs.forEach((pr) => {
        pr.state = 'CLOSED';
      });
    });
    run(['sync', '--no-restack']);
    expect(server().stacks).to.have.length(0);
    expect(syncState().remote).to.deep.equal({});
  });

  for (const change of [{ prs: [2, 1, 3] }, { reopen: 3 }]) {
    it(`refuses a concurrent ${
      'reopen' in change ? 'PR reopen' : 'stack reorder'
    } before unstacking`, () => {
      ['a', 'b', 'c'].forEach(create);
      run(['submit', '--stack']);
      updateServer((s) => {
        s.prs[2].state = 'CLOSED';
        s.stackReadMutation = { number: s.stacks[0].number, ...change };
      });
      const calls = server().calls.length;
      expect(run(['github', 'sync'], 1)).to.contain('changed during cleanup');
      expect(server().stacks).to.have.length(1);
      expect(
        server()
          .calls.slice(calls)
          .some((call) => call.includes('POST'))
      ).to.equal(false);
      expect(
        Object.keys(syncState().pendingStackCleanups ?? {})
      ).to.have.length(1);
    });
  }

  it('recovers all survivors after a partial unstack leaves only locked members', () => {
    ['a', 'b', 'c'].forEach(create);
    run(['submit', '--stack']);
    updateServer((s) => {
      s.prs[2].state = 'CLOSED';
      s.lockedPRs = [1];
    });
    expect(run(['github', 'sync'], 1)).to.contain('locked PRs');
    expect(server().stacks[0].prs).to.deep.equal([1]);
    updateServer((s) => {
      s.lockedPRs = [];
    });
    run(['github', 'sync']);
    expect(server().stacks[0].prs).to.deep.equal([1, 2]);
    expect(syncState().pendingStackCleanups).to.deep.equal({});
  });

  it('propagates stack test failures and restores the original checkout', () => {
    create('a');
    create('b');
    run(['test', '--downstack', 'exit 0']);
    expect(run(['test', '--upstack', 'exit 1'], 1)).to.contain(
      'Stack tests failed'
    );
    expect(git(['branch', '--show-current'])).to.equal('b');
  });

  const conflict = (): string[] => {
    create('a');
    create('b');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'child\n');
    run(['modify', '-am', 'child']);
    create('c');
    const revisions = ['a', 'b', 'c'].map((branch) =>
      git(['rev-parse', branch])
    );
    run(['checkout', 'a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'parent change\n');
    run(['modify', '-am', 'parent change'], 1);
    return revisions;
  };

  it('abort restores every branch and the pre-operation dirty working tree', () => {
    const revisions = conflict();
    run(['abort', '--force']);
    expect(['a', 'b', 'c'].map((b) => git(['rev-parse', b]))).to.deep.equal(
      revisions
    );
    expect(git(['branch', '--show-current'])).to.equal('a');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).to.equal(
      'parent change\n'
    );
    expect(git(['status', '--porcelain'])).to.contain('M a.txt');
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.equal(false);
  });

  it('continue completes descendants and undo restores the entire original operation', () => {
    const revisions = conflict();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'resolved\n');
    git(['add', 'a.txt']);
    run(['continue']);
    expect(git(['merge-base', 'b', 'c'])).to.equal(git(['rev-parse', 'b']));
    run(['undo', '--force']);
    expect(['a', 'b', 'c'].map((b) => git(['rev-parse', b]))).to.deep.equal(
      revisions
    );
  });

  it('undo reloads restored freeze configuration', () => {
    create('a');
    run(['freeze']);
    run(['undo', '--force']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'unfrozen\n');
    run(['modify', '-am', 'unfrozen']);
  });

  it('waits for the advisory lock before staging or creating a branch', async () => {
    const store = new StackStore(
      path.join(repo, '.git'),
      path.join(repo, '.git')
    );
    fs.writeFileSync(path.join(repo, 'waited.txt'), 'waited\n');
    const pending = promisify(execFile)(
      process.execPath,
      [cli, 'create', 'waited', '-am', 'waited', '--no-interactive'],
      { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
    ).then(
      () => undefined,
      (error: Error) => error
    );
    try {
      await sleep(300);
      expect(git(['branch', '--list', 'waited'])).to.equal('');
      expect(git(['diff', '--cached', '--name-only'])).to.equal('');
    } finally {
      store.close();
    }
    expect(await pending).to.equal(undefined);
    expect(git(['branch', '--show-current'])).to.equal('waited');
    expect(git(['show', 'waited:waited.txt'])).to.equal('waited');
  });

  it('undo cannot rewrite a descendant checked out in another worktree', () => {
    create('a');
    create('b');
    run(['checkout', 'a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'amended\n');
    run(['modify', '-am', 'amended']);
    const before = ['a', 'b'].map((branch) => git(['rev-parse', branch]));
    git(['worktree', 'add', path.join(root, 'occupied'), 'b']);
    expect(run(['undo', '--force'], 1)).to.contain('another worktree');
    expect(
      ['a', 'b'].map((branch) => git(['rev-parse', branch]))
    ).to.deep.equal(before);
  });

  it('modify --into refuses an ancestor checked out elsewhere without consuming staged changes', () => {
    create('a');
    create('b');
    const before = git(['rev-parse', 'a']);
    git(['worktree', 'add', path.join(root, 'occupied'), 'a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'staged change\n');
    git(['add', 'a.txt']);
    expect(run(['modify', '--into', 'a', '-m', 'change'], 1)).to.contain(
      'another worktree'
    );
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(git(['diff', '--cached', '--name-only'])).to.equal('a.txt');
  });

  it('stores gh-stack and undo state in the linked worktree git directory', () => {
    const worktree = path.join(root, 'worktree');
    git(['worktree', 'add', '-b', 'worktree-base', worktree, 'main']);
    run(['track', 'worktree-base', '--parent', 'main'], 0, worktree);
    fs.writeFileSync(path.join(worktree, 'probe.txt'), 'probe\n');
    run(['create', 'worktree-child', '-am', 'probe'], 0, worktree);
    const directory = git(['rev-parse', '--git-dir'], undefined, worktree);
    expect(fs.existsSync(path.join(directory, 'gh-stack'))).to.equal(true);
    expect(fs.existsSync(path.join(repo, '.git/gh-stack'))).to.equal(false);
    run(['undo', '--force'], 0, worktree);
    expect(git(['branch', '--show-current'], undefined, worktree)).to.equal(
      'worktree-base'
    );
    expect(git(['branch', '--show-current'])).to.equal('main');
  });

  it('imports a gh-stack reparent after its Git rebase invalidated the old gt boundary', () => {
    create('a');
    create('b');
    run(['checkout', 'main']);
    create('x');
    const data = mirror();
    git(['rebase', '--onto', 'x', 'a', 'b']);
    const old = data.stacks.find((s) =>
      s.branches.some((b) => b.branch === 'a')
    ) as (typeof data.stacks)[number];
    const destination = data.stacks.find((s) =>
      s.branches.some((b) => b.branch === 'x')
    ) as (typeof data.stacks)[number];
    const branch = old.branches.pop() as (typeof old.branches)[number];
    branch.base = git(['rev-parse', 'x']);
    branch.head = git(['rev-parse', 'b']);
    destination.branches.push(branch);
    fs.writeFileSync(path.join(repo, '.git/gh-stack'), JSON.stringify(data));
    expect(run(['parent']).trim()).to.equal('x');
    expect(
      mirror()
        .stacks.find((s) => s.branches.some((b) => b.branch === 'x'))
        ?.branches.map((b) => b.branch)
    ).to.deep.equal(['x', 'b']);
  });

  it('detects conflicting local parent edits and supports explicit local resolution', () => {
    create('a');
    create('b');
    run(['checkout', 'main']);
    create('x');
    const data = mirror();
    const meta = JSON.parse(git(['cat-file', '-p', 'refs/branch-metadata/b']));
    meta.parentBranchName = 'main';
    const hash = git(['hash-object', '-w', '--stdin'], JSON.stringify(meta));
    git(['update-ref', 'refs/branch-metadata/b', hash]);
    const old = data.stacks.find((s) =>
      s.branches.some((b) => b.branch === 'a')
    ) as (typeof data.stacks)[number];
    const destination = data.stacks.find((s) =>
      s.branches.some((b) => b.branch === 'x')
    ) as (typeof data.stacks)[number];
    const branch = old.branches.pop() as (typeof old.branches)[number];
    branch.base = git(['rev-parse', 'x']);
    destination.branches.push(branch);
    fs.writeFileSync(path.join(repo, '.git/gh-stack'), JSON.stringify(data));
    expect(run(['log'], 1)).to.contain('both changed the parent');
    run(['github', 'status', '--json']);
    run(['github', 'import', '--source', 'local']);
    run(['checkout', 'b']);
    expect(run(['parent']).trim()).to.equal('main');
  });

  it('reconstructs forked native stacks by following GitHub PR base edges', () => {
    create('a');
    create('b');
    create('d');
    run(['submit', '--stack']);
    run(['checkout', 'a']);
    create('c');
    create('e');
    run(['submit', '--stack']);
    const clone = path.join(root, 'fork-clone');
    git(['clone', server().gitDir, clone]);
    configure(clone);
    run(['get', 'a', '--remote-upstack', '--no-restack'], 0, clone);
    const data = JSON.parse(
      fs.readFileSync(path.join(clone, '.git/gh-stack'), 'utf8')
    );
    expect(
      data.stacks.flatMap((s: { branches: { branch: string }[] }) =>
        s.branches.map((b) => b.branch)
      )
    ).to.have.members(['a', 'b', 'c', 'd', 'e']);
  });

  describe('repository-wide stack records across worktrees', () => {
    const records = () => path.join(repo, '.git', SHARED_STATE_DIRECTORY);
    const sharedRecord = (number: number) =>
      JSON.parse(
        fs.readFileSync(
          path.join(records(), 'remote', `${number}.json`),
          'utf8'
        )
      );
    const worktree = (name: string): string => {
      const directory = path.join(root, name);
      git(['worktree', 'add', '--detach', directory, 'main']);
      return directory;
    };
    const createIn = (directory: string, name: string): void => {
      fs.writeFileSync(path.join(directory, `${name}.txt`), `${name}\n`);
      if (git(['branch', '--show-current'], undefined, directory)) {
        run(['create', name, '-am', name], 0, directory);
        return;
      }
      // A detached worktree (main is checked out elsewhere): start on trunk.
      git(['switch', '-c', name], undefined, directory);
      git(['add', '.'], undefined, directory);
      git(['commit', '-m', name], undefined, directory);
      run(['track', name, '--parent', 'main'], 0, directory);
    };
    const runAsync = (args: string[], cwd: string) =>
      promisify(execFile)(
        process.execPath,
        [cli, ...args, '--no-interactive'],
        {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 60_000,
        }
      ).then(
        (result) => ({ status: 0, output: result.stdout + result.stderr }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          status: error.code ?? 1,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        })
      );
    const singleMembership = () => {
      const members = server().stacks.flatMap((s) => s.prs);
      expect(new Set(members).size).to.equal(members.length);
    };

    it('reorders a stack created in another worktree', () => {
      create('a');
      create('b');
      run(['submit', '--stack']);
      const old = server().stacks[0].number;
      run(['checkout', 'main']);
      const linked = worktree('linked');
      run(['checkout', 'b'], 0, linked);
      run(['reorder', '--order', 'b,a'], 0, linked);
      run(['submit', '--stack'], 0, linked);
      const stacks = server().stacks;
      expect(stacks.map((s) => s.prs)).to.deep.equal([[2, 1]]);
      expect(stacks[0].number).not.to.equal(old);
      expect(sharedRecord(stacks[0].number).prs).to.deep.equal([2, 1]);
      expect(
        fs.existsSync(path.join(records(), 'remote', `${old}.json`))
      ).to.equal(false);
    });

    it('submits a fork under a stacked branch from another worktree', () => {
      create('a');
      create('b');
      create('d');
      run(['submit', '--stack']);
      run(['checkout', 'main']);
      const linked = worktree('linked');
      run(['checkout', 'a'], 0, linked);
      createIn(linked, 'c');
      createIn(linked, 'e');
      run(['submit', '--stack'], 0, linked);
      // The same result as submitting from the worktree that created it.
      const state = server();
      expect(state.prs).to.have.length(5);
      expect(state.stacks).to.have.length(2);
      expect(state.stacks.map((s) => s.base)).to.deep.equal(['a', 'a']);
      singleMembership();
      for (const stack of state.stacks)
        expect(sharedRecord(stack.number).prs).to.deep.equal(stack.prs);
    });

    it('migrates the record of the worktree that submitted, so another can rebuild', () => {
      create('a');
      create('b');
      run(['submit', '--stack']);
      run(['checkout', 'main']);
      const linked = worktree('linked');
      // Before 0.6.41-beta.2, only the submitting worktree had a record.
      const linkedDirectory = git(
        ['rev-parse', '--absolute-git-dir'],
        undefined,
        linked
      );
      fs.renameSync(
        path.join(repo, '.git/gt-github-sync'),
        path.join(linkedDirectory, 'gt-github-sync')
      );
      fs.rmSync(records(), { recursive: true, force: true });
      run(['checkout', 'b']);
      run(['reorder', '--order', 'b,a']);
      run(['submit', '--stack']);
      expect(server().stacks.map((s) => s.prs)).to.deep.equal([[2, 1]]);
    });

    it('lets worktrees submit different stacks at once, with both records correct', async () => {
      const [left, right] = [worktree('left'), worktree('right')];
      createIn(left, 'l1');
      createIn(left, 'l2');
      createIn(right, 'r1');
      createIn(right, 'r2');
      const results = await Promise.all([
        runAsync(['submit', '--stack'], left),
        runAsync(['submit', '--stack'], right),
      ]);
      for (const result of results)
        expect(result.status, result.output).to.equal(0);
      const stacks = server().stacks;
      expect(stacks).to.have.length(2);
      singleMembership();
      for (const stack of stacks)
        expect(sharedRecord(stack.number)).to.include({ base: stack.base });
      for (const stack of stacks)
        expect(sharedRecord(stack.number).prs).to.deep.equal(stack.prs);
      // Each worktree sees the other's stack as synchronized.
      for (const directory of [left, right])
        expect(run(['submit', '--stack'], 0, directory)).not.to.contain(
          'Refusing'
        );
    });

    it('never corrupts the record when worktrees submit the same stack at once', async () => {
      create('a');
      create('b');
      create('c');
      run(['submit', '--stack']);
      run(['checkout', 'main']);
      run(['checkout', 'c']);
      run(['reorder', '--order', 'b,a,c']);
      run(['checkout', 'main']);
      const [left, right] = [worktree('left'), worktree('right')];
      const results = await Promise.all(
        [left, right].map((directory) =>
          runAsync(['submit', '--stack', '--branch', 'c'], directory)
        )
      );
      expect(results.some((r) => r.status === 0)).to.equal(true);
      for (const result of results)
        expect(result.output).not.to.match(/Malformed|Unsupported mirror/);
      singleMembership();
      for (const name of fs.readdirSync(path.join(records(), 'remote')))
        if (name.endsWith('.json'))
          JSON.parse(
            fs.readFileSync(path.join(records(), 'remote', name), 'utf8')
          );
      // Either the record matches GitHub and this is a no-op, or it was left
      // behind and gt refuses: never a silent overwrite.
      const next = spawnSync(
        process.execPath,
        [cli, 'submit', '--stack', '--branch', 'c', '--no-interactive'],
        { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
      );
      if (next.status !== 0)
        expect(next.stdout + next.stderr).to.contain('GitHub stack #');
      singleMembership();
    });

    it('explains a fork in a stack gt has no record of, and --reconcile local rebuilds it', () => {
      create('a');
      create('b');
      create('c');
      run(['submit', '--stack']);
      const number = server().stacks[0].number;
      // As if the stack had been submitted from another clone or by gh stack.
      fs.rmSync(records(), { recursive: true, force: true });
      fs.rmSync(path.join(repo, '.git/gt-github-sync'));
      run(['checkout', 'a']);
      create('d');
      const output = run(['submit', '--stack'], 1);
      expect(output).to.contain(`GitHub stack #${number} must be rebuilt`);
      expect(output).to.contain('local branch a has 2 children in it (b, d)');
      expect(output).to.contain('GitHub stacks are linear');
      expect(output).to.contain(`gt has no record of syncing #${number}`);
      expect(output).to.contain('gt submit --stack --reconcile local');
      expect(server().prs).to.have.length(3);
      run(['submit', '--stack', '--reconcile', 'local']);
      expect(server().prs).to.have.length(4);
      expect(server().stacks.some((s) => s.number === number)).to.equal(false);
      singleMembership();
    });

    it('refuses when the shared record is behind GitHub', () => {
      create('a');
      create('b');
      create('c');
      run(['submit', '--stack']);
      const number = server().stacks[0].number;
      // A same-stack race left an older composition in the record.
      fs.writeFileSync(
        path.join(records(), 'remote', `${number}.json`),
        JSON.stringify({ base: 'main', prs: [1, 2], writtenBy: '/w/other' })
      );
      run(['reorder', '--order', 'b,a,c']);
      const before = server().calls.length;
      const output = run(['submit', '--stack'], 1);
      expect(output).to.contain(
        `GitHub stack #${number} changed on GitHub since gt last synced it`
      );
      expect(output).to.contain('by /w/other');
      expect(
        server()
          .calls.slice(before)
          .some((call) => call[1] === 'edit' || call.includes('POST'))
      ).to.equal(false);
    });

    it('still refuses a stack changed on GitHub, from any worktree', () => {
      create('a');
      create('b');
      run(['submit', '--stack']);
      run(['checkout', 'main']);
      // For example, gh stack submit or the web UI reordered it.
      updateServer((s) => {
        s.stacks[0].prs.reverse();
      });
      const linked = worktree('linked');
      const number = server().stacks[0].number;
      for (const directory of [repo, linked]) {
        const before = server().calls.length;
        expect(
          run(['submit', '--stack', '--branch', 'b'], 1, directory)
        ).to.contain(`GitHub stack #${number} changed on GitHub`);
        expect(
          server()
            .calls.slice(before)
            .some((call) => call[1] === 'edit' || call.includes('POST'))
        ).to.equal(false);
      }
    });

    it('skips a stack cleanup another process is replaying, without waiting', () => {
      ['a', 'b', 'c'].forEach(create);
      run(['submit', '--stack']);
      const number = server().stacks[0].number;
      updateServer((s) => {
        s.prs[1].state = 'CLOSED';
      });
      fs.mkdirSync(path.join(records(), 'cleanup'), { recursive: true });
      const fd = fs.openSync(
        path.join(records(), 'cleanup', `${number}.lock`),
        'a+'
      );
      try {
        fileLock(fd);
        const output = run(['sync', '--no-restack']);
        expect(output).to.contain(
          `GitHub stack #${number}: cleanup is already running`
        );
        expect(
          server().calls.some((call) =>
            call.some((a) => a.endsWith(`/stacks/${number}/unstack`))
          )
        ).to.equal(false);
      } finally {
        fileLock(fd, true);
        fs.closeSync(fd);
      }
      run(['sync', '--no-restack']);
      expect(server().stacks.some((s) => s.number === number)).to.equal(false);
      expect(server().stacks.map((s) => s.prs)).to.deep.equal([]);
      expect(syncState().pendingStackCleanups).to.deep.equal({});
    });
  });

  it('refuses to take over an interrupted gh-stack rebase', () => {
    fs.writeFileSync(path.join(repo, '.git/gh-stack-rebase-state'), '{}');
    expect(run(['create', 'blocked', '-m', 'blocked'], 1)).to.contain(
      'gh stack operation is in progress'
    );
    expect(git(['branch', '--list', 'blocked'])).to.equal('');
  });
});
