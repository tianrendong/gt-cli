import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import { FileLockBusyError } from '../../src/lib/github/file_lock';
import { StackStore } from '../../src/lib/github/stack_file';
import { moveCheckedOutBranch } from '../../src/lib/git/worktrees';

const cli = path.resolve(__dirname, '../../src/index.js');
const fixture = path.resolve(__dirname, '../../../test/fixtures/fake-gh.cjs');

describe('sync worktree planning and remote ancestry (offline)', function () {
  this.timeout(90_000);
  let root: string, repo: string, origin: string, serverFile: string;
  let env: NodeJS.ProcessEnv;
  // Captured from native Graphite 1.8.6 with a local bare remote and no PRs.
  const fetchOutput =
    '🌲 Fetching branches from remote...\nmain is up to date.\n\n';
  const git = (args: string[], cwd = repo, input?: string): string =>
    execFileSync('git', args, {
      cwd,
      input,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const run = (args: string[], status = 0, cwd = repo): string => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--no-interactive'],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    return result.stdout + result.stderr;
  };
  const startQueuedSync = () => {
    const pending = promisify(execFile)(
      process.execPath,
      [cli, 'sync', '--no-interactive'],
      { cwd: repo, env, encoding: 'utf8', timeout: 15_000 }
    );
    const result = pending.then(
      (output) => ({ ...output, error: undefined }),
      (error: Error) => ({ stdout: '', stderr: '', error })
    );
    const waiting = Promise.race([
      once(pending.child.stderr!, 'data').then(([chunk]) => chunk.toString()),
      result.then(({ error }) => {
        throw error ?? new Error('Sync exited before waiting for the lock.');
      }),
    ]);
    return { child: pending.child, waiting, result };
  };
  const create = (name: string): void => {
    fs.writeFileSync(path.join(repo, name + '.txt'), name + '\n');
    run(['create', name, '-am', name]);
  };
  const meta = (branch: string) =>
    JSON.parse(git(['show', 'refs/branch-metadata/' + branch]));
  const heads = (branches: string[]) =>
    branches.map((branch) => git(['rev-parse', branch]));
  const collaborator = (): string => {
    const directory = path.join(root, 'collaborator');
    git(['clone', origin, directory]);
    git(['config', 'user.name', 'Test'], directory);
    git(['config', 'user.email', 'test@example.invalid'], directory);
    return directory;
  };
  const advance = (
    directory: string,
    branch: string,
    file = 'upstream.txt'
  ): string => {
    git(['checkout', branch], directory);
    fs.writeFileSync(path.join(directory, file), 'remote change\n');
    git(['add', file], directory);
    git(['commit', '-m', 'remote change'], directory);
    git(['push', 'origin', branch], directory);
    return git(['rev-parse', branch], directory);
  };
  const occupy = (branch: string, name = 'occupied'): string => {
    const directory = path.join(root, name);
    git(['worktree', 'add', directory, branch]);
    return directory;
  };
  const dirty = (directory: string): (() => void) => {
    fs.writeFileSync(path.join(directory, 'README'), 'staged\n');
    git(['add', 'README'], directory);
    fs.appendFileSync(path.join(directory, 'README'), 'unstaged\n');
    fs.writeFileSync(path.join(directory, 'untracked'), 'private local work\n');
    const index = fs.readFileSync(
      git(['rev-parse', '--git-path', 'index'], directory)
    );
    const before = git(['status', '--porcelain=v1'], directory);
    const head = git(['rev-parse', 'HEAD'], directory);
    return () => {
      expect(git(['rev-parse', 'HEAD'], directory)).to.equal(head);
      expect(
        fs
          .readFileSync(git(['rev-parse', '--git-path', 'index'], directory))
          .equals(index)
      ).to.equal(true);
      expect(git(['status', '--porcelain=v1'], directory)).to.equal(before);
      expect(fs.readFileSync(path.join(directory, 'README'), 'utf8')).to.equal(
        'staged\nunstaged\n'
      );
      expect(
        fs.readFileSync(path.join(directory, 'untracked'), 'utf8')
      ).to.equal('private local work\n');
    };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sync-test-'));
    repo = path.join(root, 'repo');
    origin = path.join(root, 'origin.git');
    serverFile = path.join(root, 'github.json');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(repo);
    fs.copyFileSync(fixture, path.join(bin, 'gh'));
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      GT_FAKE_GITHUB: serverFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      FORCE_COLOR: '0',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
    };
    delete env.GRAPHITE_INTERACTIVE;
    fs.writeFileSync(
      path.join(root, 'user.json'),
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
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
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches native fetch output without empty cleanup or restack sections', () => {
    expect(run(['sync'])).to.equal(fetchOutput);
    run(['create', 'empty', '-m', 'empty']);
    // Empty branches without PRs are not cleanup candidates.
    expect(run(['sync', '--no-restack'])).to.equal(fetchOutput);
  });

  it('keeps native restack results under a conditional restack heading', () => {
    create('a');
    create('b');
    run(['checkout', 'main']);
    expect(run(['sync'])).to.equal(
      fetchOutput +
        '🥞 Restacking branches...\n' +
        'a does not need to be restacked on main.\n' +
        'b does not need to be restacked on a.\n'
    );
    expect(run(['sync', '--no-restack'])).to.equal(fetchOutput);
    run(['freeze', 'b']);
    const frozen = run(['sync']);
    expect(frozen).to.contain('🥞 Restacking branches...');
    expect(frozen).to.contain('Did not restack branch b because it is frozen.');
    expect(frozen).not.to.contain('🧹');
  });

  it('prints one cleanup section for actual candidates, including skipped deletions', () => {
    create('a');
    create('b');
    run(['submit', '--stack', '--no-stack-sync']);
    run(['checkout', 'main']);
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    for (const pr of server.prs) pr.state = 'CLOSED';
    fs.writeFileSync(serverFile, JSON.stringify(server));
    const heading = '🧹 Cleaning up branches with merged/closed PRs...';
    expect(run(['sync', '--no-restack'])).to.equal(
      fetchOutput + heading + '\n\n'
    );
    expect(heads(['a', 'b'])).to.have.length(2);
    const deleted = run(['sync', '--delete-all', '--no-restack']);
    expect(deleted.split(heading)).to.have.length(2);
    expect(deleted).to.contain('Deleted branch a');
    expect(deleted).to.contain('Deleted branch b');
    expect(deleted).not.to.contain('🥞');
    expect(git(['branch', '--list', 'a', 'b'])).to.equal('');
    expect(run(['sync'])).to.equal(fetchOutput);
  });

  it('runs sync while another worktree holds its own stack lock, like native gt', async () => {
    create('occupied');
    run(['checkout', 'main']);
    const linked = occupy('occupied');
    const remoteMain = advance(collaborator(), 'main');
    const common = path.join(repo, '.git');
    const linkedGitDir = git(['rev-parse', '--absolute-git-dir'], linked);
    const holder = new StackStore(linkedGitDir, common);
    try {
      const result = spawnSync(
        process.execPath,
        [cli, 'sync', '--no-interactive'],
        { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
      );
      expect(result.status, result.stdout + result.stderr).to.equal(0);
      expect(result.stderr).not.to.contain('Waiting for');
      expect(result.stderr).to.contain('another gt command is running');
      expect(result.stdout).not.to.contain('🧹');
      expect(result.stdout).not.to.contain('🥞');
      expect(git(['rev-parse', 'main'])).to.equal(remoteMain);
      // The linked worktree's own stack lock stayed with its holder, and no
      // repository-wide lock was taken by the stack command.
      expect(() => new StackStore(linkedGitDir, common)).to.throw(
        FileLockBusyError
      );
      expect(fs.existsSync(path.join(common, 'gt.lock'))).to.equal(false);
    } finally {
      holder.close();
    }
  });

  it("cancels a queued sync with Ctrl-C without releasing another command's lock", async () => {
    const directory = path.join(repo, '.git');
    const holder = new StackStore(directory, directory);
    const before = git(['show-ref']);
    const running = startQueuedSync();
    try {
      expect(await running.waiting).to.contain('Ctrl-C');
      running.child.kill('SIGINT');
      expect((await running.result).error).to.be.instanceOf(Error);
      expect(running.child.exitCode).to.equal(1);
      expect(running.child.signalCode).to.equal(null);
      expect(git(['show-ref'])).to.equal(before);
      expect(
        JSON.parse(fs.readFileSync(serverFile, 'utf8')).calls
      ).to.deep.equal([]);
      expect(() => new StackStore(directory, directory)).to.throw(
        FileLockBusyError
      );
    } finally {
      running.child.kill('SIGINT');
      await running.result;
      holder.close();
    }
    const retry = await StackStore.open(directory, directory, 0);
    retry.close();
  });

  it('sync restacks a stack whose tip is checked out in a clean worktree, moving that checkout along', () => {
    create('a');
    create('b');
    create('c');
    run(['checkout', 'a']);
    create('sibling');
    run(['checkout', 'main']);
    const occupied = occupy('c', 'worktree with "quotes"\nand newline');
    fs.writeFileSync(path.join(occupied, 'untracked'), 'private\n');
    const remoteMain = advance(collaborator(), 'main');
    const output = run(['sync']);
    expect(output).not.to.contain('another worktree');
    expect(output).to.contain('Restacked c');
    expect(meta('a').parentBranchRevision).to.equal(remoteMain);
    expect(meta('c').parentBranchRevision).to.equal(git(['rev-parse', 'b']));
    expect(meta('sibling').parentBranchRevision).to.equal(
      git(['rev-parse', 'a'])
    );
    // The other worktree follows its branch: HEAD, index, and files together.
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(
      git(['rev-parse', 'c'])
    );
    expect(git(['branch', '--show-current'], occupied)).to.equal('c');
    expect(git(['status', '--porcelain'], occupied)).to.equal('?? untracked');
    expect(fs.existsSync(path.join(occupied, 'upstream.txt'))).to.equal(true);
    expect(git(['branch', '--show-current'])).to.equal('main');
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.equal(false);
  });

  it('sync restacks up to a dirty worktree, reports that branch, and never touches its changes', () => {
    create('a');
    create('b');
    create('c');
    run(['checkout', 'main']);
    create('independent');
    run(['checkout', 'main']);
    const occupied = occupy('b');
    const assertDirtyKept = dirty(occupied);
    const before = heads(['b', 'c']);
    const remoteMain = advance(collaborator(), 'main');
    const output = run(['sync']);
    expect(output).to.contain('Restacked a');
    expect(output).to.contain(
      `Did not restack branch b because it is checked out in worktree ${fs.realpathSync(
        occupied
      )}, which has uncommitted changes.`
    );
    expect(output).not.to.contain('WARNING');
    expect(meta('a').parentBranchRevision).to.equal(remoteMain);
    expect(meta('independent').parentBranchRevision).to.equal(remoteMain);
    // b stays on the old a; c still validates against the unmoved b.
    expect(heads(['b', 'c'])).to.deep.equal(before);
    expect(meta('c').parentBranchRevision).to.equal(git(['rev-parse', 'b']));
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.equal(false);
    expect(fs.existsSync(path.join(repo, '.git/.gtcontinue'))).to.equal(false);
    assertDirtyKept();
    // Once that worktree is clean, the next sync finishes the job.
    git(['checkout', '--', 'README'], occupied);
    git(['reset', '--hard'], occupied);
    run(['sync']);
    expect(meta('b').parentBranchRevision).to.equal(git(['rev-parse', 'a']));
    expect(meta('c').parentBranchRevision).to.equal(git(['rev-parse', 'b']));
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(
      git(['rev-parse', 'b'])
    );
  });

  it('explicit restack rewrites a descendant checked out in a clean worktree', () => {
    create('a');
    create('b');
    create('c');
    run(['checkout', 'main']);
    const occupied = occupy('c');
    fs.writeFileSync(path.join(repo, 'main-only'), 'main\n');
    git(['add', '.']);
    git(['commit', '-m', 'advance main']);
    const output = run(['restack']);
    expect(output).to.contain('Restacked a');
    expect(output).to.contain('Restacked c');
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(
      git(['rev-parse', 'c'])
    );
    expect(fs.existsSync(path.join(occupied, 'main-only'))).to.equal(true);
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.equal(false);
  });

  it('sync --no-restack fast-forwards a branch checked out elsewhere when its files allow it', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    const occupied = occupy('b');
    dirty(occupied);
    const collab = collaborator();
    const remoteA = advance(collab, 'a');
    const remoteB = advance(collab, 'b', 'extra.txt');
    const output = run(['sync', '--no-restack']);
    expect(output).not.to.contain('Skipped');
    expect(heads(['a', 'b'])).to.deep.equal([remoteA, remoteB]);
    // Fast-forwarding only added extra.txt; README's staged and unstaged
    // edits and the untracked file are exactly as they were.
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(remoteB);
    expect(fs.existsSync(path.join(occupied, 'extra.txt'))).to.equal(true);
    expect(git(['status', '--porcelain=v1'], occupied)).to.equal(
      'MM README\n?? untracked'
    );
    expect(fs.readFileSync(path.join(occupied, 'README'), 'utf8')).to.equal(
      'staged\nunstaged\n'
    );
  });

  it('sync deletes a merged ancestor and reparents the occupied child onto trunk', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    create('merged');
    run(['submit']);
    run(['checkout', 'main']);
    const occupied = occupy('b');
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    for (const pr of server.prs)
      if (['a', 'merged'].includes(pr.headRefName)) pr.state = 'MERGED';
    fs.writeFileSync(serverFile, JSON.stringify(server));
    run(['sync', '--delete-all']);
    expect(git(['branch', '--list', 'a'])).to.equal('');
    expect(git(['branch', '--list', 'merged'])).to.equal('');
    expect(meta('b').parentBranchName).to.equal('main');
    expect(meta('b').parentBranchRevision).to.equal(git(['rev-parse', 'main']));
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(
      git(['rev-parse', 'b'])
    );
  });

  it('refuses a cross-worktree rewrite computed from a stale tip and releases its lock', () => {
    create('a');
    const [oldTip] = heads(['a']);
    run(['checkout', 'main']);
    const occupied = occupy('a');
    fs.appendFileSync(path.join(occupied, 'a.txt'), 'new commit\n');
    git(['commit', '-am', 'new commit'], occupied);
    const [newTip] = heads(['a']);
    const result = moveCheckedOutBranch({
      branch: 'a',
      directory: occupied,
      sha: git(['rev-parse', 'main']),
      expectedSha: oldTip,
      mode: 'rewrite',
    });
    expect(result.moved).to.equal(false);
    if (!result.moved) expect(result.reason).to.contain('commit changed');
    expect(heads(['a'])).to.deep.equal([newTip]);
    expect(git(['status', '--porcelain'], occupied)).to.equal('');
    const lock = new StackStore(
      git(['rev-parse', '--absolute-git-dir'], occupied),
      path.join(repo, '.git')
    );
    lock.close();
  });

  it('leaves an already-stale descendant untouched when its occupied ancestor is blocked', () => {
    create('a');
    create('b');
    run(['checkout', 'a']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'amend\n');
    git(['commit', '-am', 'changed a']);
    run(['checkout', 'main']);
    const occupied = occupy('a');
    const unchanged = dirty(occupied);
    const before = heads(['a', 'b']);
    advance(collaborator(), 'main');
    const output = run(['sync']);
    expect(output).to.contain('uncommitted changes');
    expect(heads(['a', 'b'])).to.deep.equal(before);
    unchanged();
  });

  it('leaves a stack alone while another gt command runs in its worktree, and reports it', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    create('independent');
    run(['checkout', 'main']);
    const occupied = occupy('b');
    const before = heads(['a', 'b']);
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    for (const pr of server.prs)
      if (pr.headRefName === 'a') pr.state = 'MERGED';
    fs.writeFileSync(serverFile, JSON.stringify(server));
    const remoteMain = advance(collaborator(), 'main');
    // A running command holds that worktree's stack lock for its duration.
    const running = new StackStore(
      git(['rev-parse', '--absolute-git-dir'], occupied),
      path.join(repo, '.git')
    );
    try {
      const output = run(['sync', '--delete-all']);
      expect(output).to.contain('another gt command is running');
      expect(output).to.contain('Restacked independent');
      // Merged a is kept (b's worktree is busy), b is neither re-parented
      // nor rewritten, and nothing waited for that command to finish.
      expect(git(['branch', '--list', 'a'])).to.equal('a'); // trimmed
      expect(meta('b').parentBranchName).to.equal('a');
      expect(heads(['a', 'b'])).to.deep.equal(before);
      expect(meta('independent').parentBranchRevision).to.equal(remoteMain);
    } finally {
      running.close();
    }
    // Once that command finishes, the next sync completes the cleanup.
    run(['sync', '--delete-all']);
    expect(git(['branch', '--list', 'a'])).to.equal('');
    expect(meta('b').parentBranchName).to.equal('main');
    expect(git(['rev-parse', 'HEAD'], occupied)).to.equal(
      git(['rev-parse', 'b'])
    );
  });

  it('sync explains a merged branch it cannot delete because another worktree has it', () => {
    create('a');
    run(['submit']);
    run(['checkout', 'main']);
    occupy('a');
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    for (const pr of server.prs) pr.state = 'MERGED';
    fs.writeFileSync(serverFile, JSON.stringify(server));
    const output = run(['sync', '--delete-all']);
    expect(output).to.contain(
      '🧹 Cleaning up branches with merged/closed PRs...'
    );
    // Native wording; the restack section names the worktree.
    expect(output).to.contain(
      'WARNING: PR #1 for a is merged but cannot be cleaned up while it is checked out in another worktree.'
    );
    expect(output).not.to.contain('Syncing branches'); // merged PRs are not synced
    expect(git(['branch', '--list', 'a'])).to.equal('+ a'); // still exists, checked out elsewhere
  });

  it('pulls trunk from a linked worktree by fast-forwarding the worktree that has it checked out', () => {
    create('a');
    run(['checkout', 'main']);
    const linked = occupy('a');
    const remoteMain = advance(collaborator(), 'main');
    // The main worktree keeps main checked out with unrelated local edits.
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'wip\n');
    fs.appendFileSync(path.join(repo, 'README'), 'local edit\n');
    const output = run(['sync'], 0, linked);
    expect(output).to.contain('fast-forwarded');
    expect(output).not.to.contain('already used by worktree');
    expect(git(['rev-parse', 'main'])).to.equal(remoteMain);
    expect(git(['rev-parse', 'HEAD'])).to.equal(remoteMain);
    expect(fs.existsSync(path.join(repo, 'upstream.txt'))).to.equal(true);
    expect(git(['status', '--porcelain'])).to.equal('M README\n?? notes.txt'); // trimmed
    expect(meta('a').parentBranchRevision).to.equal(remoteMain);
    expect(git(['branch', '--show-current'], linked)).to.equal('a');
  });

  it('reports a trunk it cannot fast-forward because that worktree edits a file the update changes', () => {
    create('a');
    run(['checkout', 'main']);
    const linked = occupy('a');
    const before = git(['rev-parse', 'main']);
    advance(collaborator(), 'main', 'README');
    fs.appendFileSync(path.join(repo, 'README'), 'conflicting local edit\n');
    const output = run(['sync'], 0, linked);
    expect(output).to.contain('could not update');
    expect(output).to.contain('main is checked out at');
    expect(git(['rev-parse', 'main'])).to.equal(before);
    expect(fs.readFileSync(path.join(repo, 'README'), 'utf8')).to.equal(
      'initial\nconflicting local edit\n'
    );
  });

  it('deleting the current merged branch lands detached when trunk is checked out elsewhere', () => {
    create('a');
    run(['submit']);
    const linked = occupy('main', 'trunk-home');
    run(['checkout', 'a']);
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    for (const pr of server.prs) pr.state = 'MERGED';
    fs.writeFileSync(serverFile, JSON.stringify(server));
    const output = run(['sync', '--delete-all']);
    expect(output).to.contain('detached');
    expect(git(['branch', '--list', 'a'])).to.equal('');
    expect(git(['branch', '--show-current'])).to.equal('');
    expect(git(['rev-parse', 'HEAD'])).to.equal(git(['rev-parse', 'main']));
    expect(git(['branch', '--show-current'], linked)).to.equal('main');
  });

  it('does not import remote Stack growth into an occupied local stack', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    run(['checkout', 'main']);
    occupy('b');
    const before = heads(['a', 'b']);
    const collab = collaborator();
    git(['checkout', '-b', 'c', 'origin/b'], collab);
    advance(collab, 'c');
    const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    const number = server.next++;
    server.prs.push({
      number,
      headRefName: 'c',
      baseRefName: 'b',
      state: 'OPEN',
      title: 'c',
      body: 'c',
      isDraft: true,
    });
    server.stacks[0].prs.push(number);
    fs.writeFileSync(serverFile, JSON.stringify(server));
    run(['sync']);
    expect(heads(['a', 'b'])).to.deep.equal(before);
    expect(git(['branch', '--list', 'c'])).to.equal('');
  });

  it('keeps missing worktree registrations protected instead of pruning them implicitly', () => {
    create('a');
    create('b');
    run(['checkout', 'main']);
    const missing = occupy('b');
    fs.rmSync(missing, { recursive: true });
    const before = heads(['a', 'b']);
    const remoteMain = advance(collaborator(), 'main');
    const output = run(['sync']);
    expect(output).to.contain('b is checked out at');
    expect(output).to.contain('git worktree prune');
    // An inaccessible worktree cannot be proven idle. Protect its stack,
    // while still fetching and updating trunk and independent stacks.
    expect(git(['rev-parse', 'main'])).to.equal(remoteMain);
    expect(heads(['a', 'b'])).to.deep.equal(before);
    expect(git(['worktree', 'list', '--porcelain'])).to.contain(
      'branch refs/heads/b'
    );
  });

  it('sync from the owning linked worktree still restacks its own stack', () => {
    create('a');
    create('b');
    run(['checkout', 'main']);
    const owner = occupy('b');
    git(['checkout', '--detach', 'main']);
    const remoteMain = advance(collaborator(), 'main');
    const output = run(['sync'], 0, owner);
    expect(output).not.to.contain('Skipped branches');
    expect(meta('a').parentBranchRevision).to.equal(remoteMain);
    expect(meta('b').parentBranchRevision).to.equal(git(['rev-parse', 'a']));
    expect(git(['branch', '--show-current'], owner)).to.equal('b');
  });

  it('recognizes the current worktree through a symlinked working directory', () => {
    create('a');
    create('b');
    const alias = path.join(root, 'repo-alias');
    fs.symlinkSync(repo, alias);
    advance(collaborator(), 'main');
    expect(run(['sync'], 0, alias)).not.to.contain('another worktree');
    expect(meta('b').parentBranchRevision).to.equal(git(['rev-parse', 'a']));
  });

  it('keeps ahead-only details in debug output without a divergence warning or force suggestion', () => {
    create('a');
    run(['submit']);
    const published = meta('a').prInfo.remoteRevision;
    fs.appendFileSync(path.join(repo, 'a.txt'), 'local commit\n');
    run(['modify', '--commit', '-am', 'local']);
    const before = git(['rev-parse', 'a']);
    const output = run(['sync', '--no-restack']);
    expect(output).to.equal(fetchOutput);
    const debug = run(['sync', '--no-restack', '--debug']);
    expect(debug).to.contain('a is ahead of origin/a');
    expect(debug).not.to.contain('has diverged');
    expect(output).not.to.contain('--force');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(meta('a').prInfo.remoteRevision).to.equal(published);
  });

  for (const publication of ['prInfo', 'native version']) {
    it(`does not call a local-only amend remote divergence (${publication} lease)`, () => {
      create('a');
      run(['submit']);
      const published = meta('a').prInfo.remoteRevision;
      fs.appendFileSync(path.join(repo, 'a.txt'), 'local amend\n');
      run(['modify', '-am', 'amended']);
      if (publication === 'native version') {
        const data = meta('a');
        delete data.prInfo.remoteRevision;
        git([
          'update-ref',
          'refs/branch-metadata/a',
          git(['hash-object', '-w', '--stdin'], repo, JSON.stringify(data)),
        ]);
      }
      const before = git(['rev-parse', 'a']);
      const output = run(['sync', '--no-restack']);
      expect(output).to.equal(fetchOutput);
      const debug = run(['sync', '--no-restack', '--debug']);
      expect(debug).to.contain('a has unpublished local changes');
      expect(debug).to.contain('origin/a is unchanged since the last submit');
      expect(debug).not.to.contain('has diverged');
      expect(output).not.to.contain('--force');
      expect(git(['rev-parse', 'a'])).to.equal(before);
      expect(meta('a').lastSubmittedVersion.headSha).to.equal(published);
    });
  }

  for (const addLocalCommit of [false, true]) {
    it(`recognizes patch-equivalent remote commits after a local restack (extra local commit: ${addLocalCommit})`, () => {
      create('a');
      run(['submit']);
      const published = git(['rev-parse', 'a']);
      advance(collaborator(), 'main');
      run(['sync']);
      if (addLocalCommit) {
        fs.appendFileSync(path.join(repo, 'a.txt'), 'extra local commit\n');
        run(['modify', '--commit', '-am', 'local commit']);
      }
      // Imported/native branches may have no usable last-submitted lease.
      const data = meta('a');
      delete data.prInfo.remoteRevision;
      delete data.lastSubmittedVersion;
      git([
        'update-ref',
        'refs/branch-metadata/a',
        git(['hash-object', '-w', '--stdin'], repo, JSON.stringify(data)),
      ]);
      const before = git(['rev-parse', 'a']);
      expect(before).not.to.equal(published);
      expect(git(['cherry', 'a', 'origin/a'])).to.equal(`- ${published}`);

      const output = run(['sync', '--no-restack']);

      expect(output).to.contain(
        'a is ahead of origin/a (restacked locally); run gt submit to update.'
      );
      expect(output).not.to.contain('has diverged');
      expect(output).not.to.contain('WARNING:');
      expect(git(['rev-parse', 'a'])).to.equal(before);
      expect(git(['rev-parse', 'origin/a'])).to.equal(published);
      expect(meta('a').prInfo.remoteRevision).to.equal(undefined);
      expect(meta('a').lastSubmittedVersion).to.equal(undefined);
    });
  }

  for (const elsewhere of [false, true]) {
    it(`gives actionable submit guidance for an unrestacked branch (other worktree: ${elsewhere})`, () => {
      create('a');
      create('b');
      create('c');
      run(['checkout', 'a']);
      fs.appendFileSync(path.join(repo, 'a.txt'), 'amended parent\n');
      git(['commit', '--amend', '-am', 'amended parent']);
      run(['checkout', 'c']);
      const linked = elsewhere ? occupy('b', 'branch with spaces') : undefined;
      const unchanged = linked ? dirty(linked) : () => undefined;
      const before = heads(['a', 'b', 'c']);

      const output = run(['submit', '--stack'], 1);

      expect(output).to.contain('has not been restacked on its parent');
      expect(output).to.contain('gt upstack restack');
      if (linked) {
        expect(output).to.contain(JSON.stringify(fs.realpathSync(linked)));
        expect(output).to.contain('Commit or stash');
        expect(output).not.to.contain('check out b');
      } else {
        expect(output).to.contain('check out b and run gt upstack restack');
      }
      expect(heads(['a', 'b', 'c'])).to.deep.equal(before);
      unchanged();
      expect(git(['branch', '--show-current'])).to.equal('c');
      expect(JSON.parse(fs.readFileSync(serverFile, 'utf8')).prs).to.deep.equal(
        []
      );
    });
  }

  it('still warns on independently changed remote history and keeps the published lease', () => {
    create('a');
    run(['submit']);
    const published = meta('a').prInfo.remoteRevision;
    advance(collaborator(), 'a');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'local amend\n');
    run(['modify', '-am', 'amended']);
    const before = git(['rev-parse', 'a']);
    const output = run(['sync', '--no-restack']);
    expect(output).to.contain('a has diverged from origin/a');
    expect(output).not.to.contain('Use gt get a --force');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(meta('a').prInfo.remoteRevision).to.equal(published);
  });

  it('does not mistake remote-only merge resolutions for patch-equivalent history', () => {
    create('a');
    run(['submit']);
    const collab = collaborator();
    git(['checkout', '-b', 'side', 'origin/main'], collab);
    advance(collab, 'side');
    git(['checkout', 'a'], collab);
    git(['merge', '--no-ff', '--no-commit', 'side'], collab);
    fs.writeFileSync(path.join(collab, 'README'), 'remote merge resolution\n');
    git(['add', '--', 'README'], collab);
    git(['commit', '-m', 'merge with resolution'], collab);
    git(['push', 'origin', 'a'], collab);
    git(['fetch', 'origin', 'side']);
    git(['cherry-pick', 'FETCH_HEAD']);
    git(['fetch', 'origin', 'a']);
    const before = git(['rev-parse', 'a']);
    // git cherry ignores the merge itself, including its unique resolution.
    expect(git(['cherry', 'a', 'origin/a'])).to.match(/^- [a-f0-9]+$/);

    const output = run(['sync', '--no-restack']);

    expect(output).to.contain('a has diverged from origin/a');
    expect(output).not.to.contain('restacked locally');
    expect(git(['rev-parse', 'a'])).to.equal(before);
    expect(fs.readFileSync(path.join(repo, 'README'), 'utf8')).to.equal(
      'initial\n'
    );
  });

  it('keeps divergence warnings on stderr even with --quiet', () => {
    create('a');
    run(['submit']);
    advance(collaborator(), 'a');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'local amend\n');
    run(['modify', '-am', 'amended']);
    const before = git(['rev-parse', 'a']);
    const result = spawnSync(
      process.execPath,
      [cli, 'sync', '--no-restack', '--quiet', '--no-interactive'],
      { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('');
    expect(result.stderr).to.contain('WARNING: a has diverged from origin/a');
    expect(git(['rev-parse', 'a'])).to.equal(before);
  });

  it('retains unchanged-branch explanations for explicit get', () => {
    create('a');
    create('b');
    run(['submit', '--stack']);
    fs.appendFileSync(path.join(repo, 'b.txt'), 'local commit\n');
    run(['modify', '--commit', '-am', 'local']);
    const before = heads(['a', 'b']);
    const output = run(['get', 'a', '--no-restack']);
    expect(output).to.contain('b is ahead of origin/b; keeping local commits.');
    expect(heads(['a', 'b'])).to.deep.equal(before);
  });

  it('fast-forwards a remote-ahead branch and records the new lease', () => {
    create('a');
    run(['submit']);
    const remote = advance(collaborator(), 'a');
    const output = run(['sync', '--no-restack']);
    expect(output).to.equal(
      fetchOutput +
        '🔄 Syncing branches...\n' +
        'Branch a fast-forwarded to remote (PR #1).\n\n'
    );
    expect(git(['rev-parse', 'a'])).to.equal(remote);
    expect(meta('a').prInfo.remoteRevision).to.equal(remote);
  });
});
