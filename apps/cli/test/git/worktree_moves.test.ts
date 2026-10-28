import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileLock } from '../../src/lib/github/file_lock';
import {
  MoveArgs,
  moveCheckedOutBranch,
  moveCheckedOutBranches,
  setWorktreeMoveRecorder,
  worktreeBusy,
} from '../../src/lib/git/worktrees';

describe('checked-out branch no-op updates', function () {
  this.timeout(30_000);
  let root: string, repo: string, linked: string, other: string;
  let tip: string, base: string, savedEnv: NodeJS.ProcessEnv;
  let recorded: MoveArgs[];
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const gitPath = (name: string, cwd = linked) =>
    path.resolve(cwd, git(['rev-parse', '--git-path', name], cwd));
  const state = (directory: string) => ({
    head: git(['rev-parse', 'HEAD'], directory),
    branch: git(['symbolic-ref', 'HEAD'], directory),
    index: fs.readFileSync(gitPath('index', directory)),
    tracked: fs.readFileSync(path.join(directory, 'README'), 'utf8'),
    untracked: fs.readFileSync(path.join(directory, 'untracked'), 'utf8'),
  });
  const noOp = (): MoveArgs => ({
    branch: 'feature',
    directory: linked,
    expectedSha: tip,
    sha: tip,
    mode: 'rewrite',
  });
  const otherMove = (): MoveArgs => ({
    branch: 'other',
    directory: other,
    expectedSha: tip,
    sha: base,
    mode: 'rewrite',
  });
  const journal = (contents: string) => {
    const directory = gitPath('gt-operations');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'latest'), JSON.stringify('1-abc'));
    fs.writeFileSync(path.join(directory, '1-abc.json'), contents);
  };

  beforeEach(() => {
    savedEnv = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-worktree-noop-'))
    );
    repo = path.join(root, 'repo');
    linked = path.join(root, 'linked');
    other = path.join(root, 'other');
    fs.mkdirSync(repo);
    for (const key of Object.keys(process.env))
      if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, {
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    fs.writeFileSync(path.join(repo, 'README'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'README'), 'feature\n');
    git(['commit', '-am', 'feature']);
    tip = git(['rev-parse', 'HEAD']);
    git(['checkout', 'main']);
    git(['branch', 'other', 'feature']);
    git(['worktree', 'add', linked, 'feature']);
    git(['worktree', 'add', other, 'other']);
    fs.writeFileSync(path.join(linked, 'README'), 'staged\n');
    git(['add', 'README'], linked);
    fs.appendFileSync(path.join(linked, 'README'), 'unstaged\n');
    for (const directory of [linked, other])
      fs.writeFileSync(path.join(directory, 'untracked'), 'private work\n');
    recorded = [];
    setWorktreeMoveRecorder((args) => recorded.push(args));
  });
  afterEach(() => {
    setWorktreeMoveRecorder(undefined);
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const batch of [false, true]) {
    describe(batch ? 'batch preflight' : 'single update', () => {
      const execute = (args: MoveArgs) =>
        batch
          ? moveCheckedOutBranches([otherMove(), args])
          : moveCheckedOutBranch(args);
      const expectBlocked = (args: MoveArgs, cause: string) => {
        const before = [state(linked), state(other), git(['show-ref'])];
        const result = execute(args);
        expect(result.moved, JSON.stringify(result)).to.equal(false);
        if (!result.moved) expect(result.cause).to.equal(cause);
        expect([state(linked), state(other), git(['show-ref'])]).to.deep.equal(
          before
        );
        expect(recorded).to.deep.equal([]);
        expect(worktreeBusy(other)).to.equal(false);
      };

      it('preserves staged, unstaged, and untracked changes without recording a no-op move', () => {
        const before = state(linked);
        const beforeMoves: MoveArgs[] = [];
        let afterMoves = false;
        const result = batch
          ? moveCheckedOutBranches([otherMove(), noOp()], {
              beforeMove: (args) => beforeMoves.push(args),
              afterMoves: () => {
                afterMoves = true;
                expect(worktreeBusy(linked)).to.equal(true);
                expect(worktreeBusy(other)).to.equal(true);
              },
            })
          : moveCheckedOutBranch(noOp());
        expect(result).to.deep.equal({ moved: true });
        expect(state(linked)).to.deep.equal(before);
        expect(recorded).to.deep.equal(batch ? [otherMove()] : []);
        expect(beforeMoves).to.deep.equal(batch ? [otherMove()] : []);
        expect(afterMoves).to.equal(batch);
        expect(git(['rev-parse', 'HEAD'], other)).to.equal(batch ? base : tip);
        expect(worktreeBusy(linked)).to.equal(false);
        expect(worktreeBusy(other)).to.equal(false);
      });

      it('still refuses a real rewrite in a dirty worktree', () => {
        expectBlocked({ ...noOp(), sha: base }, 'has uncommitted changes');
        expect(worktreeBusy(linked)).to.equal(false);
      });

      it('still refuses a no-op while the owning lock is held', () => {
        const fd = fs.openSync(gitPath('gh-stack.lock'), 'a+');
        try {
          fileLock(fd);
          expectBlocked(
            noOp(),
            'is running another gt command or cannot be locked'
          );
          expect(worktreeBusy(linked)).to.equal(true);
        } finally {
          fs.closeSync(fd);
        }
        expect(worktreeBusy(linked)).to.equal(false);
      });

      it('still refuses a no-op if the worktree switched branches', () => {
        git(['branch', 'switched', 'feature']);
        git(['symbolic-ref', 'HEAD', 'refs/heads/switched'], linked);
        expectBlocked(noOp(), 'switched branches meanwhile');
      });

      it('still refuses a no-op computed from a stale tip', () => {
        git(['update-ref', 'refs/heads/feature', base, tip]);
        expectBlocked(noOp(), 'moved to a new commit meanwhile');
      });

      for (const marker of [
        'rebase-merge',
        'rebase-apply',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_LOG',
        'gh-stack-rebase-state',
      ]) {
        it(`still refuses a no-op during ${marker}`, () => {
          fs.writeFileSync(gitPath(marker), 'paused\n');
          expectBlocked(noOp(), 'has a git operation in progress');
          expect(fs.readFileSync(gitPath(marker), 'utf8')).to.equal('paused\n');
        });
      }

      for (const [name, operation] of Object.entries({
        pending: { version: 1, pending: true },
        rollback: { version: 1, pending: false, restoringRefs: {} },
        abort: { version: 1, pending: false, abortingRebase: true },
      })) {
        it(`still refuses a no-op with a ${name} journal`, () => {
          const contents = JSON.stringify(operation);
          journal(contents);
          expectBlocked(
            noOp(),
            'has an unfinished gt operation to recover first'
          );
          expect(
            fs.readFileSync(gitPath('gt-operations/1-abc.json'), 'utf8')
          ).to.equal(contents);
        });
      }

      it('still refuses a no-op with an invalid journal', () => {
        journal(JSON.stringify({ version: 2, pending: false }));
        expectBlocked(noOp(), 'has an invalid operation journal');
      });

      it('still refuses a no-op with an unreadable journal', () => {
        journal('{');
        expectBlocked(noOp(), 'has an unreadable operation journal');
      });
    });
  }
});
