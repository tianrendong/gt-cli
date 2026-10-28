import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../src/index.js');

// Native sync is best-effort; only an explicit restack enters resolution:
// https://graphite.com/docs/sync-with-a-remote-repo#dealing-with-conflicts
// Native Graphite 1.8.6 `sync --help` describes the same contract.
describe('sync defers restack conflicts (offline)', function () {
  this.timeout(60_000);
  let root: string, repo: string, origin: string, peer: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = (args: string[], status = 0, cwd = repo): string => {
    const result = spawnSync(
      process.execPath,
      [cli, '--cwd', cwd, ...args, '--no-interactive'],
      { cwd, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    return result.stdout + result.stderr;
  };
  const create = (branch: string, file = `${branch}.txt`, content = branch) => {
    fs.writeFileSync(path.join(repo, file), content + '\n');
    run(['create', branch, '-am', branch]);
  };
  const meta = (branch: string) =>
    JSON.parse(git(['show', `refs/branch-metadata/${branch}`]));
  const advance = (branch = 'main', file = 'conflict.txt') => {
    git(['checkout', branch], peer);
    fs.writeFileSync(path.join(peer, file), 'upstream\n');
    git(['add', '--', file], peer);
    git(['commit', '-m', `advance ${branch}`], peer);
    git(['push', 'origin', branch], peer);
    return git(['rev-parse', branch], peer);
  };
  const operation = () => {
    const directory = path.join(repo, '.git/gt-operations');
    const id = JSON.parse(
      fs.readFileSync(path.join(directory, 'latest'), 'utf8')
    );
    return JSON.parse(
      fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')
    );
  };
  const expectClean = (branch: string, cwd = repo) => {
    expect(git(['branch', '--show-current'], cwd)).to.equal(branch);
    expect(git(['status', '--porcelain'], cwd)).to.equal('');
    for (const name of ['rebase-merge', 'rebase-apply', '.gtcontinue']) {
      expect(
        fs.existsSync(
          path.resolve(cwd, git(['rev-parse', '--git-path', name], cwd))
        ),
        name
      ).to.equal(false);
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sync-conflicts-'));
    repo = path.join(root, 'repo');
    origin = path.join(root, 'origin.git');
    peer = path.join(root, 'peer');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    env = {
      ...process.env,
      HOME: path.join(root, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GRAPHITE_DISABLE_TELEMETRY: '1',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
    };
    for (const name of [
      'GRAPHITE_INTERACTIVE',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_CONFIG_COUNT',
    ])
      delete env[name];
    fs.writeFileSync(
      env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    git(['init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-u', 'origin', 'main']);
    git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({ trunk: 'main', isGithubIntegrationEnabled: false })
    );
    git(['clone', origin, peer]);
    git(['config', 'user.name', 'Test'], peer);
    git(['config', 'user.email', 'test@example.invalid'], peer);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps successful restacks before and after conflicts, reports all blockers, and leaves no continuation', () => {
    create('a-clean');
    run(['checkout', 'main']);
    create('b-conflict', 'conflict.txt');
    create('b-child');
    run(['checkout', 'main']);
    create('c-conflict', 'conflict.txt');
    run(['checkout', 'main']);
    create('z-clean');
    run(['checkout', 'main']);
    const blocked = ['b-conflict', 'b-child', 'c-conflict'];
    const before = blocked.map((branch) => ({
      head: git(['rev-parse', branch]),
      metadata: meta(branch),
    }));
    const trunk = advance();
    const headMoves = () => git(['reflog', 'HEAD']).split('\n').length;
    const movesBefore = headMoves();

    const output = run(['sync', '--force']);

    expect(output).to.contain(
      'The following branches could not be restacked cleanly:'
    );
    expect(output).to.contain('▸ b-conflict');
    expect(output).to.contain('▸ c-conflict');
    expect(output).to.contain('gt restack');
    expect(output).not.to.contain('gt continue');
    expect(output).not.to.contain('Unmerged files:');
    // Conflicts are detected from the merge result alone: no rebase ever
    // checked the conflicting branches out, so HEAD only moved for trunk.
    expect(headMoves()).to.equal(movesBefore + 1);
    // Descendants are skipped, not attempted or listed as conflicts of their own.
    expect(output).not.to.contain('b-child');
    expect(git(['rev-parse', 'main'])).to.equal(trunk);
    for (const branch of ['a-clean', 'z-clean']) {
      expect(output).to.contain(`Restacked ${branch} on main.`);
      expect(meta(branch).parentBranchRevision).to.equal(trunk);
      expect(git(['merge-base', branch, 'main'])).to.equal(trunk);
    }
    blocked.forEach((branch, index) => {
      expect(git(['rev-parse', branch])).to.equal(before[index].head);
      expect(meta(branch)).to.deep.equal(before[index].metadata);
    });
    expectClean('main');
    expect(operation()).to.include({ command: 'sync', pending: false });
    run(['continue'], 1);
    expectClean('main');
    // Repeated sync retries conflicts without leaving a pending operation.
    expect(run(['sync'])).to.contain('▸ b-conflict');
    expectClean('main');
  });

  for (const useHook of [false, true]) {
    it(`skips stale descendants of a conflict (${
      useHook ? 'working-tree rebase' : 'in-memory replay'
    })`, () => {
      create('conflict', 'conflict.txt', 'parent');
      create('child', 'conflict.txt', 'child');
      create('grandchild');
      run(['checkout', 'conflict']);
      fs.writeFileSync(path.join(repo, 'conflict.txt'), 'amended parent\n');
      git(['commit', '--amend', '-am', 'amended parent']);
      run(['checkout', 'main']);
      create('healthy');
      run(['checkout', 'main']);
      if (useHook) {
        fs.writeFileSync(
          path.join(repo, '.git/hooks/pre-rebase'),
          '#!/bin/sh\nexit 0\n',
          { mode: 0o755 }
        );
      }
      const blocked = ['conflict', 'child', 'grandchild'];
      const before = blocked.map((branch) => ({
        head: git(['rev-parse', branch]),
        metadata: meta(branch),
      }));
      advance();

      const output = run(['sync']);

      expect(output).to.contain('▸ conflict');
      expect(output).not.to.contain('child');
      expect(output).to.contain('Restacked healthy on main.');
      blocked.forEach((branch, index) => {
        expect(git(['rev-parse', branch])).to.equal(before[index].head);
        expect(meta(branch)).to.deep.equal(before[index].metadata);
      });
      expectClean('main');
      expect(operation()).to.include({ command: 'sync', pending: false });
    });
  }

  for (const current of ['conflict', 'child']) {
    it(`restores the original ${current} checkout when its stack conflicts`, () => {
      create('conflict', 'conflict.txt');
      create('child');
      run(['checkout', current]);
      const before = git(['show-ref', '--heads']);
      const trunk = advance();
      expect(run(['sync'])).to.contain('▸ conflict');
      expectClean(current);
      expect(git(['rev-parse', 'main'])).to.equal(trunk);
      for (const branch of ['conflict', 'child']) {
        const old = before
          .split('\n')
          .find((line) => line.endsWith(` refs/heads/${branch}`))!;
        expect(`${git(['rev-parse', branch])} refs/heads/${branch}`).to.equal(
          old
        );
      }
    });
  }

  it('does not prompt for conflict resolution in interactive sync', () => {
    create('conflict', 'conflict.txt');
    run(['checkout', 'main']);
    advance();
    // Closed stdin and a deadline make any unexpected prompt a test failure.
    const result = spawnSync(
      process.execPath,
      [cli, '--cwd', repo, 'sync', '--interactive'],
      { cwd: repo, env, input: '', encoding: 'utf8', timeout: 10_000 }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    // Warnings go to stderr, like native gt.
    expect(result.stderr).to.contain('▸ conflict');
    expectClean('main');
  });

  it('lists a conflicting branch owned by another worktree with its location', () => {
    create('conflict', 'conflict.txt');
    create('child');
    run(['checkout', 'main']);
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', linked, 'conflict']);
    const before = git(['show-ref', '--heads']);
    advance();
    const output = run(['sync']);
    expect(output).to.contain(
      `▸ conflict (checked out in ${fs.realpathSync(linked)})`
    );
    expect(output).not.to.contain('Did not restack');
    expect(output).not.to.contain('Restacked child');
    expect(git(['show-ref', '--heads']))
      .to.contain(
        before.split('\n').find((l) => l.endsWith('refs/heads/conflict'))
      )
      .and.to.contain(
        before.split('\n').find((l) => l.endsWith('refs/heads/child'))
      );
    expectClean('conflict', linked);
    expectClean('main');
  });

  it('leaves a conflicted linked worktree clean without changing the other checkout', () => {
    create('conflict', 'conflict.txt');
    create('child');
    git(['checkout', '--detach']);
    const original = git(['rev-parse', 'HEAD']);
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', linked, 'child']);
    advance();
    expect(run(['sync'], 0, linked)).to.contain('▸ conflict');
    expectClean('child', linked);
    expectClean('');
    expect(git(['rev-parse', 'HEAD'])).to.equal(original);
  });

  it('preserves trunk updates and merged-branch deletion through conflicts and a later explicit restack abort', () => {
    create('merged');
    create('conflict', 'conflict.txt');
    create('child');
    run(['checkout', 'main']);
    create('healthy');
    run(['checkout', 'merged']);
    git(['fetch', repo, 'merged'], peer);
    git(['merge', '--ff-only', 'FETCH_HEAD'], peer);
    const trunk = advance();

    expect(run(['sync', '--delete-all'])).to.contain('▸ conflict');
    expectClean('main');
    expect(git(['branch', '--list', 'merged'])).to.equal('');
    expect(meta('conflict').parentBranchName).to.equal('main');
    expect(meta('healthy').parentBranchRevision).to.equal(trunk);
    const synced = git(['show-ref', '--heads']);
    run(['checkout', 'child']);

    expect(run(['restack'], 1)).to.contain('Hit conflict restacking conflict');
    expect(operation()).to.include({ command: 'restack', pending: true });
    run(['abort', '--force']);
    expectClean('child');
    expect(git(['show-ref', '--heads'])).to.equal(synced);
    expect(git(['branch', '--list', 'merged'])).to.equal('');

    run(['restack'], 1);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'resolved\n');
    git(['add', '--', 'conflict.txt']);
    run(['continue']);
    expectClean('child');
    expect(meta('conflict').parentBranchRevision).to.equal(trunk);
    expect(meta('child').parentBranchRevision).to.equal(
      git(['rev-parse', 'conflict'])
    );
  });

  it('honors --no-restack even when branches conflict', () => {
    create('conflict', 'conflict.txt');
    run(['checkout', 'main']);
    const before = meta('conflict');
    const trunk = advance();
    const output = run(['sync', '--no-restack']);
    expect(output).not.to.contain('could not be restacked');
    expect(meta('conflict')).to.deep.equal(before);
    expect(git(['rev-parse', 'main'])).to.equal(trunk);
    expectClean('main');
  });

  it('does not hide non-conflict Git failures', () => {
    create('feature');
    run(['checkout', 'main']);
    advance();
    fs.writeFileSync(
      path.join(repo, '.git/hooks/pre-rebase'),
      '#!/bin/sh\necho "refusing rebase in test hook" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    const output = run(['sync'], 1);
    expect(output).to.contain('refusing rebase in test hook');
    expect(output).not.to.contain('could not be restacked cleanly');
    expectClean('main');
  });

  it('continues syncing other trunks with --all and restores the original checkout', () => {
    git(['branch', 'release']);
    git(['push', 'origin', 'release']);
    git(['fetch', 'origin'], peer);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({
        trunk: 'main',
        additionalTrunks: ['release'],
        isGithubIntegrationEnabled: false,
      })
    );
    create('conflict', 'conflict.txt');
    run(['checkout', 'release']);
    create('release-feature');
    run(['checkout', 'conflict']);
    const main = advance();
    const release = advance('release', 'release-change.txt');
    const output = run(['sync', '--all']);
    expect(output).to.contain('▸ conflict');
    expect(output).to.contain('Restacked release-feature on release.');
    expect(meta('release-feature').parentBranchRevision).to.equal(release);
    expect(git(['rev-parse', 'main'])).to.equal(main);
    expectClean('conflict');
    expect(operation()).to.include({ command: 'sync', pending: false });
  });
});
