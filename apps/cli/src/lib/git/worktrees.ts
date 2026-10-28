import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { ExitFailedError } from '../errors';
import { fileLock } from '../github/file_lock';
import { readJSON } from '../github/stack_file';
import { runGitCommand } from './runner';
import { getGitTopLevel } from './git_dir';

function canonical(directory: string): string {
  // Missing/prunable worktrees still reserve their branches until explicitly
  // removed by the user. Do not silently drop them from the protection map.
  return fs.existsSync(directory)
    ? fs.realpathSync(directory)
    : path.resolve(directory);
}

/** Branch -> worktree path, excluding this worktree (including symlink aliases). */
export function branchesCheckedOutElsewhere(): Map<string, string> {
  const root = canonical(getGitTopLevel());
  const output = runGitCommand({
    args: ['worktree', 'list', '--porcelain', '-z'],
    onError: 'throw',
    resource: 'otherWorktrees',
  });
  const occupied = new Map<string, string>();
  for (const record of output.split('\0\0')) {
    const fields = record.split('\0');
    const directory = fields
      .find((field) => field.startsWith('worktree '))
      ?.slice(9);
    if (!directory || canonical(directory) === root) continue;
    const branch =
      fields
        .find((field) => field.startsWith('branch refs/heads/'))
        ?.slice(18) ??
      (fields.includes('detached') ? rebasingBranch(directory) : undefined);
    if (branch) occupied.set(branch, canonical(directory));
  }
  return occupied;
}

function rebasingBranch(directory: string): string | undefined {
  const gitDir = worktreeGitDir(directory);
  if (!gitDir) return undefined;
  for (const rebase of ['rebase-merge', 'rebase-apply']) {
    try {
      const head = fs
        .readFileSync(path.join(gitDir, rebase, 'head-name'), 'utf8')
        .trim();
      if (head.startsWith('refs/heads/'))
        return head.slice('refs/heads/'.length);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

/** Git's update-ref plumbing does not protect branches checked out elsewhere. */
export function assertBranchesAvailable(branches: string[]): void {
  if (!branches.length) return;
  const occupied = branchesCheckedOutElsewhere();
  for (const branch of branches) {
    const directory = occupied.get(branch);
    if (directory) {
      throw new ExitFailedError(
        `${branch} is checked out in another worktree at ${JSON.stringify(
          directory
        )}. ` +
          'Refusing to rewrite it; run this operation from its owning worktree.'
      );
    }
  }
}

export type MoveResult =
  | { moved: true }
  | {
      moved: false;
      /** Full explanation naming the branch and its worktree. */
      reason: string;
      /** What about that worktree blocks the move, as a clause for
       * "checked out in worktree P, which <cause>". */
      cause?: string;
    };

/** A linked worktree's `.git` is a gitfile naming its private directory; the
 * main worktree's is that directory itself. Reading it avoids one process per
 * worktree per call, which adds up when restacking dozens of branches. */
function worktreeGitDir(directory: string): string | undefined {
  const dotGit = path.join(directory, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(
      fs.readFileSync(dotGit, 'utf8')
    );
    if (pointer && fs.existsSync(path.resolve(directory, pointer[1])))
      return path.resolve(directory, pointer[1]);
  } catch {
    // Unusual layouts (GIT_DIR, missing worktrees) are resolved by Git below.
  }
  const result = gitIn(directory, ['rev-parse', '--git-dir']);
  return result.status === 0
    ? path.resolve(directory, result.stdout.trim())
    : undefined;
}

/** A gt or gh-stack command holds that worktree's stack lock while it runs.
 * Rewriting a branch under a running command would leave that command with
 * a stale view, so such worktrees are treated as busy, like dirty ones. */
export function worktreeBusy(directory: string): boolean {
  const gitDir = worktreeGitDir(directory);
  if (!gitDir) return true;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(gitDir, 'gh-stack.lock'), 'a+');
    fileLock(fd);
    fileLock(fd, true);
    return false;
  } catch {
    return true; // Fail closed when the owning worktree cannot be inspected.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function gitIn(directory: string, args: string[]) {
  return spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.replace(/^(fatal|error): /, '').trim())
      .find(Boolean) ?? 'git refused the update'
  );
}

/** Move a branch that is checked out in ANOTHER worktree, updating that
 * worktree's HEAD, index, and files together so it never sees a stale
 * checkout. A plain ref update would leave its files behind as phantom
 * changes. Git's own safety rules protect that worktree: `merge --ff-only`
 * refuses to overwrite modified files and `reset --keep` aborts instead of
 * discarding local changes to files the move touches. Paused operations always
 * block an update; uncommitted tracked changes block rewrites that change the
 * commit, like gt's own preconditions would there. Nothing is stashed, and
 * nothing that fails leaves that worktree different from before.
 */
export type MoveArgs = {
  branch: string;
  directory: string;
  sha: string;
  expectedSha: string;
  mode: 'fast-forward' | 'rewrite';
};

// The operation journal installs a write-ahead recorder only while a command
// runs. Keeping the callback here avoids making Git depend on the journal.
let recordMove: ((args: MoveArgs) => void) | undefined;
export function setWorktreeMoveRecorder(recorder: typeof recordMove): void {
  recordMove = recorder;
}

export function moveCheckedOutBranch(args: MoveArgs): MoveResult {
  return moveCheckedOutBranches([args]);
}

/** Recovery may touch several owning worktrees. Lock and preflight all of them
 * before the first move, and keep their locks through the caller's ref/metadata
 * restoration. Locks never wait, so concurrent recoveries cannot deadlock.
 * Git can still reject a move (e.g. an untracked obstruction); beforeMove lets
 * the journal checkpoint that intent so a partial rollback is retryable. */
export function moveCheckedOutBranches(
  moves: MoveArgs[],
  opts: {
    beforeMove?: (args: MoveArgs) => void;
    afterMoves?: () => void;
  } = {}
): MoveResult {
  const locks: number[] = [];
  const directories = new Map(moves.map((args) => [args.directory, args]));
  try {
    for (const args of directories.values()) {
      try {
        const gitDir = worktreeGitDir(args.directory);
        if (!gitDir)
          throw new Error('Cannot locate owning worktree Git directory.');
        const fd = fs.openSync(path.join(gitDir, 'gh-stack.lock'), 'a+');
        locks.push(fd);
        fileLock(fd);
      } catch {
        return {
          moved: false,
          reason: `${args.branch} is checked out at ${JSON.stringify(
            args.directory
          )}, where another gt command is running or its lock cannot be acquired. Retry when it is idle and accessible.`,
          cause: 'is running another gt command or cannot be locked',
        };
      }
    }
    if (moves.length > 1) {
      for (const args of moves) {
        const blocker = worktreeMoveBlocker(args);
        if (blocker) return { moved: false, ...blocker };
      }
    }
    for (const args of moves) {
      const result = moveLockedWorktree(args, opts.beforeMove);
      if (!result.moved) return result;
    }
    opts.afterMoves?.();
    return { moved: true };
  } finally {
    for (const fd of locks) fs.closeSync(fd);
  }
}

type MoveBlocker = { reason: string; cause: string };

function worktreeMoveBlocker(args: MoveArgs): MoveBlocker | undefined {
  const where = `checked out at ${JSON.stringify(args.directory)}`;
  if (!fs.existsSync(args.directory))
    return {
      reason: `${args.branch} is ${where}, which is missing. Run git worktree prune if it was deleted.`,
      cause: 'is missing (run git worktree prune if it was deleted)',
    };
  const gitDir = worktreeGitDir(args.directory);
  if (!gitDir)
    return {
      reason: `Cannot locate owning worktree Git directory: ${where}.`,
      cause: 'cannot be inspected',
    };
  for (const marker of [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'gh-stack-rebase-state',
  ]) {
    if (fs.existsSync(path.join(gitDir, marker)))
      return {
        reason: `${args.branch} is ${where}, where a git operation is in progress.`,
        cause: 'has a git operation in progress',
      };
  }
  // An interrupted gt command can be pending without a Git rebase marker.
  const journalBlocker = worktreeJournalBlocker(gitDir);
  if (journalBlocker)
    return {
      reason: `${args.branch} is ${where}, ${journalBlocker.reason}`,
      cause: journalBlocker.cause,
    };
  const head = gitIn(args.directory, ['symbolic-ref', '-q', 'HEAD']);
  if (head.status !== 0 || head.stdout.trim() !== `refs/heads/${args.branch}`)
    return {
      reason: `${args.branch} is ${where}, but that worktree changed branches meanwhile.`,
      cause: 'switched branches meanwhile',
    };
  const before = gitIn(args.directory, ['rev-parse', '--verify', 'HEAD']);
  if (before.status !== 0 || before.stdout.trim() !== args.expectedSha)
    return {
      reason: `${args.branch} is ${where}, but its commit changed while this command was running. Retry from the new tip.`,
      cause: 'moved to a new commit meanwhile',
    };
  // A metadata-only restack leaves HEAD, index, and files untouched. Skip only
  // its clean-tree requirement, not ownership, tip, lock, or recovery checks.
  // Keep this in the shared blocker so batch preflight accepts no-ops too.
  if (args.mode === 'rewrite' && args.expectedSha !== args.sha) {
    const status = gitIn(args.directory, [
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
    ]);
    if (status.status !== 0)
      return {
        reason: firstLine(status.stderr),
        cause: `cannot report its status: ${firstLine(status.stderr)}`,
      };
    if (status.stdout.trim())
      return {
        reason: `${args.branch} is ${where} with uncommitted changes. Commit or stash them, then retry.`,
        cause: 'has uncommitted changes',
      };
  }
  return undefined;
}

function worktreeJournalBlocker(gitDir: string): MoveBlocker | undefined {
  const journal = path.join(gitDir, 'gt-operations');
  const invalid = {
    reason: 'with an invalid operation journal.',
    cause: 'has an invalid operation journal',
  };
  try {
    const id = readJSON<string | undefined>(
      path.join(journal, 'latest'),
      undefined
    );
    if (!id) return undefined;
    if (!/^\d+-[a-f0-9]+$/.test(id)) return invalid;
    const operation = readJSON<
      | {
          version: number;
          pending: boolean;
          restoringRefs?: unknown;
          abortingRebase?: boolean;
        }
      | undefined
    >(path.join(journal, `${id}.json`), undefined);
    if (
      !operation ||
      operation.version !== 1 ||
      typeof operation.pending !== 'boolean'
    )
      return invalid;
    if (
      operation.pending ||
      operation.restoringRefs ||
      operation.abortingRebase
    )
      return {
        reason:
          'where a gt operation is in progress. Finish its recovery there first.',
        cause: 'has an unfinished gt operation to recover first',
      };
    return undefined;
  } catch {
    return {
      reason:
        'where its operation journal cannot be read. Repair it before retrying.',
      cause: 'has an unreadable operation journal',
    };
  }
}

function moveLockedWorktree(
  args: MoveArgs,
  beforeMove?: (args: MoveArgs) => void
): MoveResult {
  const blocker = worktreeMoveBlocker(args);
  if (blocker) return { moved: false, ...blocker };
  if (args.expectedSha === args.sha) return { moved: true };
  beforeMove?.(args);
  recordMove?.(args);
  const where = `checked out at ${JSON.stringify(args.directory)}`;
  const result = gitIn(
    args.directory,
    args.mode === 'fast-forward'
      ? ['merge', '--ff-only', '--no-edit', args.sha]
      : ['reset', '--keep', args.sha]
  );
  if (result.status !== 0)
    return {
      moved: false,
      reason: `${args.branch} is ${where}: ${firstLine(result.stderr)}`,
      cause: `refused the update: ${firstLine(result.stderr)}`,
    };
  const now = gitIn(args.directory, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (now.stdout.trim() !== args.sha)
    return {
      moved: false,
      reason: `${args.branch} is ${where} and did not move as expected.`,
      cause: 'did not move as expected',
    };
  return { moved: true };
}
