import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../src/index.js');

/**
 * `git merge-base` exits 1 when two commits share no history. Metadata
 * validation asks for the merge base of every tracked branch and its parent on
 * every command, so a trunk that was reset to unrelated history (or an orphan
 * branch) used to fail every gt command with a raw git error, including the
 * read-only commands and the restack needed to recover. Native Graphite shows
 * the branch as "needs restack" instead.
 */
describe('branches that share no history with their parent (offline)', function () {
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
  const create = (branch: string) => {
    fs.writeFileSync(path.join(repo, `${branch}.txt`), branch + '\n');
    run(['create', branch, '-am', branch]);
  };
  /** Commit an unrelated root and point `branch` at it. */
  const orphan = (branch: string, file: string) => {
    const previous = git(['branch', '--show-current']);
    git(['checkout', '--orphan', 'orphan-work']);
    git(['rm', '-rq', '--cached', '.']);
    for (const name of fs.readdirSync(repo))
      if (name !== '.git')
        fs.rmSync(path.join(repo, name), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'unrelated\n');
    git(['add', '--all']);
    git(['commit', '-m', `unrelated root for ${branch}`]);
    git(['branch', '-f', branch, 'orphan-work']);
    git(['checkout', previous]);
    git(['branch', '-D', 'orphan-work']);
  };
  const noMergeBase = (left: string, right: string) => {
    const result = spawnSync('git', ['merge-base', left, right], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    expect(result.status, `${left} and ${right} still share history`).to.equal(
      1
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-disjoint-history-'));
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

  it('keeps every command working after trunk is reset to unrelated history', () => {
    create('feat');
    const featBefore = git(['rev-parse', 'feat']);
    orphan('main', 'unrelated.txt');
    noMergeBase('feat', 'main');

    // Read-only commands keep working and report the branch like native gt.
    const log = run(['log', '--stack']);
    expect(log).to.contain('feat');
    expect(log).to.contain('(needs restack)');
    expect(run(['info'])).to.contain('feat');
    expect(run(['log', 'short'])).to.contain('feat');

    // Navigation and the repair path work too.
    run(['checkout', 'main']);
    run(['checkout', 'feat']);
    run(['restack']);
    expect(git(['merge-base', 'feat', 'main'])).to.equal(
      git(['rev-parse', 'main'])
    );
    expect(git(['rev-parse', 'feat'])).not.to.equal(featBefore);
    expect(fs.readFileSync(path.join(repo, 'feat.txt'), 'utf8')).to.equal(
      'feat\n'
    );
    expect(fs.existsSync(path.join(repo, 'unrelated.txt'))).to.equal(true);
    expect(run(['log', '--stack'])).not.to.contain('(needs restack)');
  });

  it('still untracks and re-tracks a branch that shares no history', () => {
    create('feat');
    orphan('main', 'unrelated.txt');
    noMergeBase('feat', 'main');

    run(['untrack', 'feat']);
    expect(run(['log'])).not.to.contain('feat');
    expect(run(['track', 'feat', '--parent', 'main'], 1)).to.contain(
      'shares no history'
    );
    // Rebasing onto trunk first makes it trackable again.
    git(['rebase', '--onto', 'main', '--root', 'feat']);
    run(['track', 'feat', '--parent', 'main']);
    expect(run(['log', '--stack'])).to.contain('feat');
  });

  it('refuses to track an orphan branch onto a non-trunk parent with a clear error', () => {
    create('base');
    git(['branch', 'lonely']);
    orphan('lonely', 'lonely.txt');
    noMergeBase('lonely', 'base');
    const output = run(['track', 'lonely', '--parent', 'base'], 1);
    expect(output).to.contain('is not in the history of');
    expect(output).not.to.contain('merge-base');
    expect(run(['log', '--stack'])).to.contain('base');
  });
});
