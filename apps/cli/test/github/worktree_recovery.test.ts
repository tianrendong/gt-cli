import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { FileLockBusyError } from '../../src/lib/github/file_lock';
import { StackStore } from '../../src/lib/github/stack_file';
import { moveCheckedOutBranches } from '../../src/lib/git/worktrees';
import { Operation } from '../../src/lib/operations/journal';

const cli = path.resolve(__dirname, '../../src/index.js');

describe('cross-worktree operation recovery (offline)', function () {
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
      [cli, ...args, '--no-interactive'],
      { cwd, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    return result.stdout + result.stderr;
  };
  const create = (branch: string, file = `${branch}.txt`) => {
    fs.writeFileSync(path.join(repo, file), branch + '\n');
    run(['create', branch, '-am', branch]);
  };
  const occupy = (branch: string) => {
    const directory = path.join(root, branch + ' worktree');
    git(['worktree', 'add', directory, branch]);
    return directory;
  };
  const refs = () =>
    git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/',
      'refs/branch-metadata/',
    ]);
  const gitPath = (name: string, cwd = repo) =>
    path.resolve(cwd, git(['rev-parse', '--git-path', name], cwd));
  const operationFile = (cwd = repo) => {
    const directory = gitPath('gt-operations', cwd);
    const id = JSON.parse(
      fs.readFileSync(path.join(directory, 'latest'), 'utf8')
    );
    return path.join(directory, `${id}.json`);
  };
  const operation = (cwd = repo): Operation =>
    JSON.parse(fs.readFileSync(operationFile(cwd), 'utf8'));
  const inspectRecovery = () => {
    const files = [
      operationFile(),
      ...['gh-stack', 'gt-github-sync', '.gtcontinue'].map((name) =>
        gitPath(name)
      ),
    ];
    const contents = () =>
      files.map((file) =>
        fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      );
    const before = { refs: refs(), files: contents() };
    run(['info', 'main']);
    // Partial rollback can leave a's ref and stored boundary out of sync.
    // Even a failed inspection must not repair or republish that checkpoint.
    expect(run(['info', 'a'], 1)).to.contain('untracked branch a');
    expect(refs()).to.equal(before.refs);
    expect(contents()).to.deep.equal(before.files);
  };
  const clean = (branch: string, cwd = repo) => {
    expect(git(['branch', '--show-current'], cwd)).to.equal(branch);
    expect(git(['status', '--porcelain'], cwd)).to.equal('');
    for (const name of ['rebase-merge', 'rebase-apply', '.gtcontinue'])
      expect(fs.existsSync(gitPath(name, cwd)), name).to.equal(false);
  };
  const advance = (removeOldFile = false) => {
    fs.writeFileSync(path.join(peer, 'upstream.txt'), 'upstream\n');
    if (removeOldFile) fs.unlinkSync(path.join(peer, 'old.txt'));
    git(['add', '--all'], peer);
    git(['commit', '-m', 'advance main'], peer);
    git(['push', 'origin', 'main'], peer);
  };
  const synced = (twoWorktrees = false, removeOldFile = false) => {
    create('a');
    if (twoWorktrees) create('b');
    run(['checkout', 'main']);
    const a = occupy('a');
    const b = twoWorktrees ? occupy('b') : undefined;
    const before = refs();
    advance(removeOldFile);
    run(['sync']);
    const after = refs();
    expect(after).not.to.equal(before);
    return { a, b, before, after, journal: operationFile() };
  };
  const paused = (withChild = false) => {
    create('a');
    create('conflict', 'README');
    if (withChild) create('child');
    run(['checkout', 'main']);
    const a = occupy('a');
    const child = withChild ? occupy('child') : undefined;
    fs.writeFileSync(path.join(repo, 'README'), 'new base\n');
    fs.writeFileSync(path.join(repo, 'upstream.txt'), 'main\n');
    git(['add', '--all']);
    git(['commit', '-m', 'advance main']);
    const before = refs();
    expect(run(['restack'], 1)).to.contain('Hit conflict restacking conflict');
    expect(operation()).to.include({ command: 'restack', pending: true });
    expect(fs.existsSync(path.join(a, 'upstream.txt'))).to.equal(true);
    return { a, child, before, journal: operationFile() };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-worktree-recovery-'));
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
    fs.writeFileSync(path.join(repo, 'old.txt'), 'old\n');
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

  it('undoes sync in both worktrees without leaving phantom changes', () => {
    const { a, before, journal } = synced();
    fs.writeFileSync(path.join(a, 'private'), 'untracked work\n');
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    clean('main');
    expect(git(['branch', '--show-current'], a)).to.equal('a');
    expect(git(['status', '--porcelain'], a)).to.equal('?? private');
    expect(fs.readFileSync(path.join(a, 'private'), 'utf8')).to.equal(
      'untracked work\n'
    );
    expect(fs.existsSync(path.join(a, 'upstream.txt'))).to.equal(false);
    expect(fs.existsSync(journal)).to.equal(false);
    run(['sync']);
  });

  it('undoes sync from a linked worktree, including trunk in the main checkout', () => {
    create('a');
    run(['checkout', 'main']);
    const linked = occupy('a');
    const before = refs();
    const mainJournal = operationFile();
    advance();
    run(['sync'], 0, linked);
    const linkedJournal = operationFile(linked);
    expect(fs.existsSync(path.join(repo, 'upstream.txt'))).to.equal(true);
    run(['undo', '--force'], 0, linked);
    expect(refs()).to.equal(before);
    expect(fs.existsSync(linkedJournal)).to.equal(false);
    expect(operationFile()).to.equal(mainJournal);
    clean('main');
    clean('a', linked);
  });

  it('recovers an interrupted command with no after/partial snapshot', () => {
    const { a, before, journal } = synced();
    const data = operation();
    data.pending = true;
    delete data.after;
    delete data.partial;
    fs.writeFileSync(journal, JSON.stringify(data));
    run(['abort', '--force']);
    expect(refs()).to.equal(before);
    expect(fs.existsSync(journal)).to.equal(false);
    clean('main');
    clean('a', a);
  });

  it('undoes a successful fast-forward even when a later foreign restack fails', () => {
    create('a');
    create('b');
    git(['push', 'origin', 'a', 'b']);
    // Sync only pulls published branches. Keep GitHub offline, but give the
    // branches PR identities so the ordinary remote-update path selects them.
    for (const [index, branch] of ['a', 'b'].entries()) {
      const ref = `refs/branch-metadata/${branch}`;
      const metadata = JSON.parse(git(['show', ref]));
      metadata.prInfo = { number: index + 1, state: 'OPEN' };
      const file = path.join(root, 'metadata.json');
      fs.writeFileSync(file, JSON.stringify(metadata));
      git(['update-ref', ref, git(['hash-object', '-w', file])]);
    }
    run(['checkout', 'main']);
    const b = occupy('b');
    const before = refs();
    fs.writeFileSync(path.join(b, 'parent-new.txt'), 'untracked work\n');
    git(['fetch', 'origin'], peer);
    git(['checkout', 'a'], peer);
    fs.writeFileSync(path.join(peer, 'parent-new.txt'), 'new parent file\n');
    git(['add', '.'], peer);
    git(['commit', '-m', 'advance a'], peer);
    git(['push', 'origin', 'a'], peer);
    git(['checkout', 'b'], peer);
    fs.writeFileSync(path.join(peer, 'child-new.txt'), 'new child file\n');
    git(['add', '.'], peer);
    git(['commit', '-m', 'advance b'], peer);
    git(['push', 'origin', 'b'], peer);
    const output = run(['sync']);
    expect(output, output).to.contain('Did not restack branch b');
    expect(output, output).to.contain('parent-new.txt');
    expect(git(['rev-parse', 'b'])).to.equal(git(['rev-parse', 'b'], peer));
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    expect(fs.readFileSync(path.join(b, 'parent-new.txt'), 'utf8')).to.equal(
      'untracked work\n'
    );
    expect(git(['status', '--porcelain'], b)).to.equal('?? parent-new.txt');
    clean('main');
  });

  for (const legacy of [false, true]) {
    it(`aborts a conflicted restack after a cross-worktree move (${
      legacy ? 'legacy' : 'current'
    } journal)`, () => {
      const { a, before, journal } = paused();
      if (legacy) {
        const data = operation();
        // Old journals only have whole-repository before/partial snapshots.
        delete data.worktreeMoves;
        fs.writeFileSync(journal, JSON.stringify(data));
      }
      expect(run(['sync'], 1)).to.contain('An operation is still in progress');
      run(['abort', '--force']);
      expect(refs()).to.equal(before);
      clean('main');
      clean('a', a);
      expect(fs.existsSync(path.join(a, 'upstream.txt'))).to.equal(false);
      expect(fs.existsSync(journal)).to.equal(false);
      run(['sync', '--no-restack']);
    });
  }

  it('retains cross-worktree recovery records through continue', () => {
    const { a, child, before } = paused(true);
    fs.writeFileSync(path.join(repo, 'README'), 'resolved\n');
    git(['add', 'README']);
    run(['continue']);
    expect(fs.readFileSync(path.join(child!, 'README'), 'utf8')).to.equal(
      'resolved\n'
    );
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    clean('main');
    clean('a', a);
    clean('child', child!);
  });

  it('refuses newer commits in another worktree without changing either checkout', () => {
    const { a, journal } = synced();
    fs.appendFileSync(path.join(a, 'a.txt'), 'new work\n');
    git(['commit', '-am', 'new work'], a);
    const before = refs();
    expect(run(['undo', '--force'], 1)).to.contain(
      'Branches changed outside this operation'
    );
    expect(refs()).to.equal(before);
    clean('main');
    clean('a', a);
    expect(fs.existsSync(journal)).to.equal(true);
  });

  it('does not mistake an external reset to the old tip for its own recovery', () => {
    const { a, journal } = synced();
    const old = operation().before.refs['refs/heads/a'];
    git(['reset', '--keep', old], a);
    const before = refs();
    expect(run(['undo', '--force'], 1)).to.contain(
      'Branches changed outside this operation'
    );
    expect(refs()).to.equal(before);
    expect(fs.existsSync(journal)).to.equal(true);
  });

  it('preflights all worktrees before changing any and preserves staged/unstaged work', () => {
    const { a, b, before, after } = synced(true);
    fs.writeFileSync(path.join(b!, 'README'), 'staged\n');
    git(['add', 'README'], b);
    fs.appendFileSync(path.join(b!, 'README'), 'unstaged\n');
    const index = fs.readFileSync(gitPath('index', b));
    expect(run(['undo', '--force'], 1)).to.contain('uncommitted changes');
    expect(refs()).to.equal(after);
    expect(fs.readFileSync(gitPath('index', b)).equals(index)).to.equal(true);
    expect(fs.readFileSync(path.join(b!, 'README'), 'utf8')).to.equal(
      'staged\nunstaged\n'
    );
    clean('main');
    clean('a', a);
    git(['restore', '--source=HEAD', '--staged', '--worktree', 'README'], b);
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    clean('b', b);
  });

  it('refuses a busy owning worktree, releases earlier locks, and succeeds on retry', () => {
    const { a, b, before, after } = synced(true);
    const holder = new StackStore(gitPath('.', b), gitPath('.'));
    try {
      expect(run(['undo', '--force'], 1)).to.contain(
        'another gt command is running'
      );
      expect(refs()).to.equal(after);
      const available = new StackStore(gitPath('.', a), gitPath('.'));
      available.close();
    } finally {
      holder.close();
    }
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    clean('main');
    clean('a', a);
    clean('b', b);
  });

  for (const legacy of [false, true]) {
    it(`does not touch a paused foreign Git rebase (${
      legacy ? 'legacy' : 'current'
    } journal)`, () => {
      const { a, before, after, journal } = synced();
      if (legacy) {
        const data = operation();
        delete data.worktreeMoves;
        fs.writeFileSync(journal, JSON.stringify(data));
      }
      const stopped = spawnSync(
        'git',
        ['rebase', '-i', '--exec', 'exit 1', 'HEAD^'],
        {
          cwd: a,
          env: { ...env, GIT_SEQUENCE_EDITOR: 'true' },
          encoding: 'utf8',
        }
      );
      expect(stopped.status).to.equal(1);
      expect(git(['branch', '--show-current'], a)).to.equal('');
      expect(run(['undo', '--force'], 1)).to.contain(
        'operation is in progress'
      );
      expect(refs()).to.equal(after);
      expect(fs.existsSync(gitPath('rebase-merge', a))).to.equal(true);
      git(['rebase', '--abort'], a);
      run(['undo', '--force']);
      expect(refs()).to.equal(before);
    });
  }

  for (const state of ['pending', 'rollback', 'malformed']) {
    it(`leaves a foreign ${state} journal untouched without a Git rebase marker`, () => {
      const { a, before, after } = synced();
      const directory = gitPath('gt-operations', a);
      fs.mkdirSync(directory, { recursive: true });
      const id = '123-abcdef';
      const content =
        state === 'malformed'
          ? '{'
          : JSON.stringify({
              version: 1,
              pending: state === 'pending',
              ...(state === 'rollback'
                ? { restoringRefs: { 'refs/heads/a': 'old' } }
                : {}),
            });
      fs.writeFileSync(path.join(directory, 'latest'), JSON.stringify(id));
      fs.writeFileSync(path.join(directory, `${id}.json`), content);
      run(['undo', '--force'], 1);
      expect(refs()).to.equal(after);
      expect(
        fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')
      ).to.equal(content);
      fs.unlinkSync(path.join(directory, 'latest'));
      run(['undo', '--force']);
      expect(refs()).to.equal(before);
    });
  }

  it('holds owning locks through metadata restoration and releases them on callback failure', () => {
    const { a, b } = synced(true);
    const before = operation().before.refs;
    const moves = [a, b!].map((directory, index) => ({
      directory,
      branch: index === 0 ? 'a' : 'b',
      expectedSha: git(['rev-parse', 'HEAD'], directory),
      sha: before[`refs/heads/${index === 0 ? 'a' : 'b'}`],
      mode: 'rewrite' as const,
    }));
    expect(() =>
      moveCheckedOutBranches(moves, {
        afterMoves: () => {
          for (const directory of [a, b!])
            expect(
              () => new StackStore(gitPath('.', directory), gitPath('.'))
            ).to.throw(FileLockBusyError);
          throw new Error('injected metadata failure');
        },
      })
    ).to.throw('injected metadata failure');
    for (const directory of [a, b!]) {
      const released = new StackStore(gitPath('.', directory), gitPath('.'));
      released.close();
    }
  });

  it('refuses a missing owning worktree without moving other branches', () => {
    const { b, after, journal } = synced(true);
    fs.rmSync(b!, { recursive: true });
    run(['undo', '--force'], 1);
    expect(refs()).to.equal(after);
    expect(fs.existsSync(journal)).to.equal(true);
  });

  it('retries a partially completed rollback without losing untracked files', () => {
    const { a, b, before, journal } = synced(true, true);
    fs.writeFileSync(path.join(b!, 'old.txt'), 'private untracked work\n');
    run(['undo', '--force'], 1);
    // The first worktree was restored, but Git refused the second checkout.
    expect(git(['rev-parse', 'HEAD'], a)).to.equal(
      operation().before.refs['refs/heads/a']
    );
    expect(fs.readFileSync(path.join(b!, 'old.txt'), 'utf8')).to.equal(
      'private untracked work\n'
    );
    expect(fs.existsSync(journal)).to.equal(true);
    inspectRecovery();
    expect(run(['create', 'blocked', '-m', 'blocked'], 1)).to.contain(
      'Retry gt undo'
    );
    expect(run(['continue'], 1)).to.contain('Retry gt undo');
    expect(operationFile()).to.equal(journal);
    expect(git(['branch', '--list', 'blocked'])).to.equal('');
    fs.unlinkSync(path.join(b!, 'old.txt'));
    run(['undo', '--force']);
    expect(refs()).to.equal(before);
    clean('main');
    clean('a', a);
    clean('b', b);
  });

  it('retries abort after foreign moves succeeded but the local ref transaction failed', () => {
    const { a, before, journal } = paused();
    const lock = gitPath('refs/branch-metadata/a.lock');
    fs.writeFileSync(lock, '');
    expect(run(['abort', '--force'], 1)).to.contain('cannot lock ref');
    expect(git(['rev-parse', 'HEAD'], a)).to.equal(
      operation().before.refs['refs/heads/a']
    );
    inspectRecovery();
    expect(run(['continue'], 1)).to.contain('Retry gt abort');
    expect(run(['create', 'blocked', '-m', 'blocked'], 1)).to.contain(
      'Retry gt abort'
    );
    fs.unlinkSync(lock);
    run(['abort', '--force']);
    expect(refs()).to.equal(before);
    expect(fs.existsSync(journal)).to.equal(false);
    clean('main');
    clean('a', a);
  });

  it('still refuses new work after a partially completed rollback', () => {
    const { a, b, journal } = synced(true, true);
    fs.writeFileSync(path.join(b!, 'old.txt'), 'private\n');
    run(['undo', '--force'], 1);
    fs.appendFileSync(path.join(a, 'a.txt'), 'new work\n');
    git(['commit', '-am', 'new work'], a);
    fs.unlinkSync(path.join(b!, 'old.txt'));
    const before = refs();
    expect(run(['undo', '--force'], 1)).to.contain(
      'Branches changed outside this operation'
    );
    expect(refs()).to.equal(before);
    expect(fs.existsSync(journal)).to.equal(true);
  });
});
