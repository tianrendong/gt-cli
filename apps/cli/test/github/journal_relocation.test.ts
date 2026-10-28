import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { Operation } from '../../src/lib/operations/journal';

const cli = path.resolve(__dirname, '../../src/index.js');

/**
 * The operation journal records the worktree path an operation ran in. The
 * journal lives inside that worktree's own Git directory, so after `git
 * worktree move`, a renamed checkout, or a copied repository the recorded path
 * is stale but the journal is still ours. Treating the mismatch as a foreign
 * journal used to reject every mutation in the relocated worktree, including
 * the undo and abort needed to clear it.
 */
describe('operation journal after a worktree is relocated (offline)', function () {
  this.timeout(60_000);
  let root: string, repo: string;
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
      [cli, ...args, '--no-interactive'],
      { cwd, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    return result.stdout + result.stderr;
  };
  const create = (branch: string, cwd = repo) => {
    fs.writeFileSync(path.join(cwd, `${branch}.txt`), branch + '\n');
    run(['create', branch, '-am', branch], 0, cwd);
  };
  const journalDirectory = (cwd: string) =>
    path.resolve(cwd, git(['rev-parse', '--git-path', 'gt-operations'], cwd));
  const latest = (cwd: string): Operation => {
    const directory = journalDirectory(cwd);
    const id = JSON.parse(
      fs.readFileSync(path.join(directory, 'latest'), 'utf8')
    );
    return JSON.parse(
      fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')
    );
  };
  const topLevel = (cwd: string) => git(['rev-parse', '--show-toplevel'], cwd);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-journal-relocation-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    env = {
      ...process.env,
      HOME: path.join(root, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GRAPHITE_DISABLE_TELEMETRY: '1',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
      FORCE_COLOR: '0',
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
    fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({ trunk: 'main', isGithubIntegrationEnabled: false })
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps mutating and undoing after a linked worktree is moved', () => {
    const worktree = path.join(root, 'task-a');
    git(['worktree', 'add', '-b', 'pool', worktree, 'main']);
    run(['track', 'pool', '--parent', 'main'], 0, worktree);
    create('a', worktree);
    const recorded = latest(worktree);
    expect(recorded.command).to.equal('create');
    expect(recorded.worktree).to.equal(topLevel(worktree));

    // Re-purpose the checkout under a new name, as a worktree pool does.
    const moved = path.join(root, 'task-b');
    git(['worktree', 'move', worktree, moved]);
    expect(latest(moved).worktree).not.to.equal(topLevel(moved));

    create('b', moved);
    expect(git(['branch', '--show-current'], moved)).to.equal('b');
    expect(latest(moved)).to.include({
      command: 'create',
      worktree: topLevel(moved),
    });

    run(['undo', '--force'], 0, moved);
    expect(git(['branch', '--show-current'], moved)).to.equal('a');
    expect(git(['branch', '--list', 'b'], moved)).to.equal('');
    // Undo restores the pre-create working tree, so b.txt is untracked again.
    expect(git(['status', '--porcelain'], moved)).to.equal('?? b.txt');
    fs.unlinkSync(path.join(moved, 'b.txt'));

    // The operation recorded before the move is ours too: undo it as well.
    run(['undo', '--force'], 0, moved);
    expect(git(['branch', '--show-current'], moved)).to.equal('pool');
    expect(git(['branch', '--list', 'a'], moved)).to.equal('');
    expect(git(['status', '--porcelain'], moved)).to.equal('?? a.txt');
  });

  it('keeps mutating after the repository directory itself is renamed', () => {
    create('a');
    const renamed = path.join(root, 'renamed');
    fs.renameSync(repo, renamed);
    expect(latest(renamed).worktree).not.to.equal(topLevel(renamed));

    fs.writeFileSync(path.join(renamed, 'a.txt'), 'amended\n');
    run(['modify', '-a'], 0, renamed);
    expect(latest(renamed)).to.include({
      command: 'modify',
      worktree: topLevel(renamed),
    });
    run(['undo', '--force'], 0, renamed);
    // The commit is rolled back; the uncommitted edit that preceded it is kept.
    expect(git(['show', 'HEAD:a.txt'], renamed)).to.equal('a');
    expect(fs.readFileSync(path.join(renamed, 'a.txt'), 'utf8')).to.equal(
      'amended\n'
    );
    expect(git(['status', '--porcelain'], renamed)).to.equal('M a.txt');
    expect(run(['log', '--stack'], 0, renamed)).to.contain('a');
  });

  it('adopts the stale path only for this worktree, leaving others untouched', () => {
    const worktree = path.join(root, 'other');
    git(['worktree', 'add', '-b', 'other', worktree, 'main']);
    run(['track', 'other', '--parent', 'main'], 0, worktree);
    create('o', worktree);
    const otherBefore = latest(worktree);

    create('a');
    const renamed = path.join(root, 'renamed');
    fs.renameSync(repo, renamed);
    git(['worktree', 'repair'], renamed);
    create('b', renamed);
    expect(latest(renamed).worktree).to.equal(topLevel(renamed));
    expect(latest(worktree)).to.deep.equal(otherBefore);
  });
});
