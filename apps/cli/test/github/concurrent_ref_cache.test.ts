import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../src/index.js');

/**
 * Agents run gt in several worktrees at once. When another worktree moves a
 * ref while a locked command runs, the persisted full cache must not be
 * stamped, but per-branch ancestry proofs stay valid (they are keyed on
 * immutable commit IDs). Dropping them made the next command in every worktree
 * re-run git merge-base for every tracked branch: ~850 calls (~25s) in a large
 * repository, which then widened the race window for the next command.
 */
// eslint-disable-next-line max-lines-per-function
describe('a concurrent ref move keeps ancestry proofs (offline)', function () {
  this.timeout(120_000);
  const SIDE_BRANCHES = 40;
  let root: string, repo: string, other: string, trace: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  /** Runs gt and returns the merge-base processes it spawned. */
  const run = (args: string[], cwd = repo): number => {
    fs.rmSync(trace, { force: true });
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--no-interactive'],
      {
        cwd,
        env: { ...env, GIT_TRACE2_EVENT: trace },
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(0);
    if (!fs.existsSync(trace)) return 0;
    return fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.event === 'start' &&
          !String(event.sid).includes('/') &&
          event.argv?.[1] === 'merge-base'
      ).length;
  };
  const cacheFile = () => path.join(repo, '.git/.graphite_cache_persist');

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-concurrent-proofs-'))
    );
    repo = path.join(root, 'repo');
    other = path.join(root, 'other');
    trace = path.join(root, 'trace.jsonl');
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
      'GIT_TRACE2_EVENT',
    ])
      delete env[name];
    fs.writeFileSync(
      env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'gc.auto', '0']);
    fs.writeFileSync(path.join(repo, 'f'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({ trunk: 'main', isGithubIntegrationEnabled: false })
    );
    const main = git(['rev-parse', 'main']);
    const tree = git(['rev-parse', 'main^{tree}']);
    for (let i = 0; i < SIDE_BRANCHES; i++) {
      git([
        'update-ref',
        `refs/heads/side-${i}`,
        git(['commit-tree', tree, '-p', main, '-m', `side ${i}`]),
      ]);
      run(['track', `side-${i}`, '--parent', 'main']);
    }
    git(['worktree', 'add', '-q', other, `side-${SIDE_BRANCHES - 1}`]);
    run(['info']);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('the next command in any worktree re-validates only the moved branch', () => {
    // While gt create runs in repo, "another worktree" commits on side-0:
    // the pre-commit hook moves that ref between gt's load and persist.
    const main = git(['rev-parse', 'main']);
    const moved = git([
      'commit-tree',
      git(['rev-parse', 'main^{tree}']),
      '-p',
      main,
      '-m',
      'committed in another worktree',
    ]);
    const hook = path.join(repo, '.git/hooks/pre-commit');
    fs.writeFileSync(
      hook,
      `#!/bin/sh\ngit update-ref refs/heads/side-0 ${moved}\n`,
      { mode: 0o755 }
    );
    const proofNames = () =>
      (
        JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).validation
          .proofs as string[][]
      ).map((p) => p[0]);
    const before = proofNames();
    expect(before.length).to.be.at.least(SIDE_BRANCHES - 1);
    fs.writeFileSync(path.join(repo, 'f'), 'a\n');
    run(['create', 'a', '-am', 'a']);
    fs.rmSync(hook);
    expect(git(['rev-parse', 'side-0'])).to.equal(moved);

    const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    // Still never claims to describe refs it did not see...
    expect(persisted.sha).to.equal('0'.repeat(40));
    // ...but keeps every per-branch proof it had.
    expect(proofNames()).to.include.members(before);

    // Only side-0 (moved) and a (new) need a walk, not every branch.
    expect(run(['info'], other)).to.be.lessThan(SIDE_BRANCHES / 4);
    expect(run(['log', 'short'], repo)).to.equal(0);
  });
});
