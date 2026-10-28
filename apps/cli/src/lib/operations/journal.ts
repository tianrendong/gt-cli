import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import stableHash from 'fast-json-stable-hash';
import { TContext, initContext } from '../context';
import { composeGit } from '../git/git';
import { ExitFailedError } from '../errors';
import { runGitCommand } from '../git/runner';
import { getGitIndexPath, getGitTopLevel } from '../git/git_dir';
import {
  assertBranchesAvailable,
  branchesCheckedOutElsewhere,
  MoveArgs,
  moveCheckedOutBranches,
  setWorktreeMoveRecorder,
} from '../git/worktrees';
import {
  atomicJSON,
  gitDirectory,
  worktreeGitDirectory,
  readJSON,
} from '../github/stack_file';

const METADATA_FILES = [
  '.graphite_repo_config',
  'gh-stack',
  'gt-github-sync',
  'gt-frozen',
  '.gtcontinue',
];
export type Snapshot = {
  refs: Record<string, string>;
  branch?: string;
  head: string;
  index: string;
  worktree: string;
  files: Record<string, string | null>;
};
export type Operation = {
  version: 1;
  id: string;
  command: string;
  /** The command line as invoked, which native gt echoes when undoing. */
  invocation?: string;
  worktree: string;
  before: Snapshot;
  after?: Snapshot;
  partial?: Pick<Snapshot, 'refs' | 'files'>;
  pending: boolean;
  /** Write-ahead receipts for foreign checkouts moved by this command. Absent
   * in legacy v1 journals; an empty map means no foreign moves were ours. */
  worktreeMoves?: Record<
    string,
    { directory: string; before: string; from: string; after: string }
  >;
  /** Write-ahead rollback targets, not permission to accept arbitrary ref drift.
   * A retry accepts the old tip only for a move recovery already attempted. */
  restoringRefs?: Record<string, string>;
  /** Git abort can succeed before ref restoration fails. A later command's
   * normal stale-continuation cleanup is then an expected recovery effect. */
  abortingRebase?: boolean;
};

export const MUTATIONS: ReadonlySet<string> = new Set([
  'create',
  'branch create',
  'modify',
  'commit create',
  'commit amend',
  'move',
  'upstack onto',
  'restack',
  'branch restack',
  'stack restack',
  'upstack restack',
  'downstack restack',
  'fold',
  'branch fold',
  'pop',
  'branch unbranch',
  'squash',
  'branch squash',
  'split',
  'branch split',
  'rename',
  'branch rename',
  'delete',
  'branch delete',
  'track',
  'branch track',
  'downstack track',
  'untrack',
  'branch untrack',
  'reorder',
  'downstack edit',
  'branch edit',
  'get',
  'downstack get',
  'sync',
  'repo sync',
  'revert',
  'absorb',
  'freeze',
  'unfreeze',
  'github import',
  'trunk add',
  'submit',
  'stack submit',
  'branch submit',
  'downstack submit',
  'upstack submit',
]);

export function journalGit(
  args: string[],
  opts: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    noTrim?: boolean;
  } = {}
): string {
  return runGitCommand({
    args,
    options: opts,
    onError: 'throw',
    resource: 'operationJournal',
  });
}
function journalDirectory(): string {
  // Undo belongs to the worktree in which the operation was started.
  return path.join(worktreeGitDirectory(), 'gt-operations');
}
function metadataPaths(): Record<string, string> {
  const shared = gitDirectory();
  const worktree = worktreeGitDirectory();
  return Object.fromEntries(
    METADATA_FILES.map((name) => [
      name,
      path.join(
        ['.graphite_repo_config', 'gt-frozen'].includes(name)
          ? shared
          : worktree,
        name
      ),
    ])
  );
}
function metadataFiles(): Snapshot['files'] {
  const paths = metadataPaths();
  return Object.fromEntries(
    METADATA_FILES.map((name) => {
      const file = paths[name];
      return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
    })
  );
}
export function refsSnapshot(): Record<string, string> {
  const lines = journalGit([
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/',
    'refs/branch-metadata/',
  ]);
  return Object.fromEntries(
    lines
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
  );
}

/** Status uses the real index's fsmonitor/untracked cache. `normal` is essential:
 * `all` bypasses Git's untracked cache and walks the entire repository. Git add
 * can expand the untracked directories that normal status reports instead.
 * Disable renames so each NUL record has exactly one path. Preserve arbitrary
 * byte filenames by falling back to Git's full-tree walk if UTF-8 decoding
 * cannot represent them losslessly.
 */
function workspacePaths(): string[] | undefined {
  const status = journalGit(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--no-renames',
      '--ignore-submodules=none',
    ],
    // Porcelain v1 paths are root-relative even from a subdirectory. Keep
    // the caller's cwd so relative GIT_INDEX_FILE overrides still resolve.
    { noTrim: true }
  );
  if (status.includes('\uFFFD')) return undefined;
  return (
    status
      .split('\0')
      // Staged-only changes are already in the copied index. In particular, a
      // staged deletion no longer exists and is not a valid add pathspec.
      .filter((entry) => entry && entry[1] !== ' ')
      .map((entry) => entry.slice(3))
  );
}

export function workspaceSnapshot(): Pick<Snapshot, 'index' | 'worktree'> {
  const cwd = getGitTopLevel();
  let paths = workspacePaths();
  const indexTree = journalGit(['write-tree']);
  if (paths?.length === 0) return { index: indexTree, worktree: indexTree };
  // Explicit out-of-cone pathspecs fail where `add --all -- .` quietly skips
  // them. Preserve the full-tree behavior for dirty sparse checkouts.
  if (
    paths &&
    runGitCommand({
      args: ['config', '--bool', '--get', 'core.sparseCheckout'],
      onError: 'ignore',
      resource: 'operationJournal',
    }) === 'true'
  )
    paths = undefined;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-index-'));
  try {
    const index = getGitIndexPath();
    const temporary = path.join(directory, 'index');
    const env = {
      ...process.env,
      GIT_INDEX_FILE: temporary,
      // Pathspecs came from Git, not the user's shell; never interpret magic.
      GIT_LITERAL_PATHSPECS: '1',
      GIT_GLOB_PATHSPECS: '0',
      GIT_NOGLOB_PATHSPECS: '0',
      GIT_ICASE_PATHSPECS: '0',
    };
    if (fs.existsSync(index)) fs.copyFileSync(index, temporary);
    else journalGit(['read-tree', '--empty'], { env });
    journalGit(
      paths
        ? ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul']
        : ['add', '--all', '--', '.'],
      {
        env,
        cwd,
        ...(paths ? { input: paths.join('\0') + '\0' } : {}),
      }
    );
    return { index: indexTree, worktree: journalGit(['write-tree'], { env }) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function snapshot(): Snapshot {
  return {
    refs: refsSnapshot(),
    branch: journalGit(['branch', '--show-current']) || undefined,
    head: journalGit(['rev-parse', 'HEAD']),
    ...workspaceSnapshot(),
    files: metadataFiles(),
  };
}

export function assertNoRollbackInProgress(
  operation: Operation | undefined
): void {
  if (operation?.restoringRefs || operation?.abortingRebase)
    throw new ExitFailedError(
      `An operation rollback is still in progress. Retry gt ${
        operation.pending ? 'abort' : 'undo'
      } first.`
    );
}

export function beginOperation(
  command: string,
  dryRun: boolean
): Operation | undefined {
  if (!MUTATIONS.has(command) || dryRun) return undefined;
  const directory = journalDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const previous = latestOperation();
  assertNoRollbackInProgress(previous);
  if (previous?.pending) {
    throw new ExitFailedError(
      'An operation is still in progress. Use gt continue or gt abort first.'
    );
  }
  const before = snapshot();
  const operation: Operation = {
    version: 1,
    id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
    command,
    invocation: process.argv.slice(2).join(' '),
    worktree: getGitTopLevel(),
    before,
    pending: true,
    worktreeMoves: {},
  };
  // Anchor all old objects so garbage collection cannot invalidate undo.
  const anchors = {
    ...before.refs,
    index: before.index,
    worktree: before.worktree,
    head: before.head,
  };
  journalGit(['update-ref', '--stdin'], {
    input:
      Object.entries(anchors)
        .map(
          ([ref, sha]) => `create refs/gt-undo/${operation.id}/${ref} ${sha}`
        )
        .join('\n') + '\n',
  });
  atomicJSON(path.join(directory, `${operation.id}.json`), operation);
  atomicJSON(path.join(directory, 'latest'), operation.id);
  recordOperationWorktreeMoves(operation);
  return operation;
}

function saveOperation(operation: Operation): void {
  atomicJSON(path.join(journalDirectory(), `${operation.id}.json`), operation);
}

/** Also installed when gt continue resumes an existing operation. The receipt
 * is durable before Git moves the foreign checkout, including if gt is killed
 * before finishOperation can write its after/partial snapshot. */
export function recordOperationWorktreeMoves(operation: Operation): void {
  setWorktreeMoveRecorder((args) => {
    // Keep legacy journals recognizable even when continued by a newer CLI.
    if (!operation.worktreeMoves) return;
    const ref = `refs/heads/${args.branch}`;
    const previous = operation.worktreeMoves[ref];
    if (
      operation.before.refs[ref] !== (previous?.before ?? args.expectedSha) ||
      (previous &&
        (previous.directory !== args.directory ||
          ![previous.before, previous.from, previous.after].includes(
            args.expectedSha
          )))
    ) {
      throw new ExitFailedError(
        `${args.branch} changed outside this operation. Refusing to rewrite it from an outdated snapshot.`
      );
    }
    operation.worktreeMoves[ref] = {
      directory: args.directory,
      before: previous?.before ?? args.expectedSha,
      // A failed Git move can leave this intermediate tip in place. It is
      // still ours, even if an earlier move in this command already succeeded.
      from: args.expectedSha,
      after: args.sha,
    };
    saveOperation(operation);
  });
}

export function finishOperation(
  operation: Operation | undefined,
  pending: boolean
): void {
  if (!operation) return;
  setWorktreeMoveRecorder(undefined);
  operation.pending = pending;
  if (pending)
    operation.partial = { refs: refsSnapshot(), files: metadataFiles() };
  if (!pending) {
    operation.after = snapshot();
    if (JSON.stringify(operation.before) === JSON.stringify(operation.after)) {
      removeOperation(operation);
      return;
    }
  }
  atomicJSON(path.join(journalDirectory(), `${operation.id}.json`), operation);
}

export function latestOperation({
  readOnly = false,
}: { readOnly?: boolean } = {}): Operation | undefined {
  const directory = journalDirectory();
  const id = readJSON<string | undefined>(
    path.join(directory, 'latest'),
    undefined
  );
  if (!id) return undefined;
  if (!/^\d+-[a-f0-9]+$/.test(id))
    throw new ExitFailedError('Invalid operation journal.');
  const file = path.join(directory, `${id}.json`);
  const operation = readJSON<Operation | undefined>(file, undefined);
  if (!operation) return undefined;
  if (operation.version !== 1) {
    throw new ExitFailedError(
      `Operation journal ${file} was written by an incompatible gt version. Remove it to continue.`
    );
  }
  // The journal lives inside this worktree's own Git directory, so a recorded
  // path that no longer matches means the worktree itself was relocated (git
  // worktree move, a copied repository, or a worktree pool that renames
  // checkouts between tasks), not that the operation belongs to someone else.
  // Refusing here used to block every mutation, including the undo and abort
  // needed to recover. Adopt the new path instead; the refs and metadata the
  // operation recorded are unchanged by a move.
  const topLevel = getGitTopLevel();
  if (!readOnly && operation.worktree !== topLevel) {
    operation.worktree = topLevel;
    atomicJSON(file, operation);
  }
  return operation;
}

export function restoreOperation(
  operation: Operation,
  context: TContext,
  abort = false
): void {
  if (!abort && operation.pending)
    throw new ExitFailedError(
      'Operation is paused. Use gt abort to restore the whole operation.'
    );
  if (!abort && operation.after) {
    const workspace = workspaceSnapshot();
    if (
      workspace.index !== operation.after.index ||
      workspace.worktree !== operation.after.worktree
    ) {
      throw new ExitFailedError(
        'Working tree or index changed since this operation. Commit or stash those changes before undo.'
      );
    }
  }
  const current = refsSnapshot();
  const before = operation.before;
  const checkpoint = operation.after ?? operation.partial;
  const after = checkpoint?.refs ?? current;
  const affected = [
    ...new Set([...Object.keys(before.refs), ...Object.keys(after)]),
  ].filter((ref) => before.refs[ref] !== after[ref]);
  if (
    checkpoint &&
    affected.some(
      (ref) =>
        current[ref] !== after[ref] &&
        !(
          operation.restoringRefs?.[ref] &&
          operation.restoringRefs[ref] === before.refs[ref] &&
          current[ref] === before.refs[ref]
        )
    )
  ) {
    throw new ExitFailedError(
      'Branches changed outside this operation. Refusing to overwrite newer work.'
    );
  }
  const { currentFiles, changedFiles } = metadataToRestore(
    operation,
    context.engine.rebaseInProgress()
  );
  // Never reattach this worktree to a branch someone else now has checked out.
  if (before.branch) assertBranchesAvailable([before.branch]);
  const moves = planWorktreeRestores(operation, { current, after, affected });
  if (!checkpoint) {
    // Interrupted commands may lack a finish snapshot. Freeze the recovery
    // baseline now, rather than treating fresh ref drift as ours on each retry.
    operation.partial = { refs: current, files: currentFiles };
    saveOperation(operation);
  }
  const movedRefs = new Set(moves.map(({ branch }) => `refs/heads/${branch}`));
  const result = moveCheckedOutBranches(moves, {
    beforeMove: ({ branch, sha }) => {
      operation.restoringRefs ??= {};
      operation.restoringRefs[`refs/heads/${branch}`] = sha;
      saveOperation(operation);
    },
    afterMoves: () => {
      if (context.engine.rebaseInProgress()) {
        operation.abortingRebase = true;
        saveOperation(operation);
        context.engine.abortRebase();
      }
      // Foreign checkouts moved with their files/index under their own locks.
      // Verify those heads in the ref transaction; never rewrite them again
      // using update-ref, which would leave phantom changes in their checkout.
      const updates = affected.map((ref) =>
        movedRefs.has(ref)
          ? `verify ${ref} ${before.refs[ref]}`
          : before.refs[ref]
          ? current[ref]
            ? `update ${ref} ${before.refs[ref]} ${current[ref]}`
            : `create ${ref} ${before.refs[ref]}`
          : `delete ${ref} ${current[ref]}`
      );
      restoreSnapshot(before, updates, changedFiles);
      reloadRestoredContext(context);
      removeOperation(operation);
    },
  });
  if (!result.moved)
    throw new ExitFailedError(
      `${
        result.reason
      }\nRollback is not complete. Resolve the blocker, then retry gt ${
        abort ? 'abort' : 'undo'
      } in this worktree.`
    );
  const invoked = chalk.yellow(
    `gt ${operation.invocation || operation.command}`
  );
  context.splog.info(
    abort
      ? `Successfully aborted ${invoked}.`
      : `Successfully rolled back to before ${invoked}.`
  );
}

function metadataToRestore(
  operation: Operation,
  rebasing: boolean
): { currentFiles: Snapshot['files']; changedFiles: string[] } {
  const currentFiles = metadataFiles();
  const checkpoint = operation.after ?? operation.partial;
  const equalFile = (
    a: string | null | undefined,
    b: string | null | undefined
  ) =>
    stableHash.hash(a ? JSON.parse(a) : null, 'sha256') ===
    stableHash.hash(b ? JSON.parse(b) : null, 'sha256');
  const changedFiles = METADATA_FILES.filter(
    (name) =>
      !checkpoint ||
      !equalFile(operation.before.files[name], checkpoint.files[name])
  );
  const clearedContinuation =
    operation.abortingRebase &&
    !rebasing &&
    currentFiles['.gtcontinue'] === null;
  if (
    checkpoint &&
    changedFiles.some(
      (name) =>
        !(name === '.gtcontinue' && clearedContinuation) &&
        !equalFile(currentFiles[name], checkpoint.files[name])
    )
  ) {
    throw new ExitFailedError(
      'Stack metadata changed outside this operation. Refusing to overwrite newer metadata.'
    );
  }
  return { currentFiles, changedFiles };
}

function planWorktreeRestores(
  operation: Operation,
  refs: {
    current: Snapshot['refs'];
    after: Snapshot['refs'];
    affected: string[];
  }
): MoveArgs[] {
  const elsewhere = branchesCheckedOutElsewhere();
  const moves: MoveArgs[] = [];
  for (const ref of refs.affected) {
    if (!ref.startsWith('refs/heads/')) continue;
    const branch = ref.slice('refs/heads/'.length);
    const recorded = operation.worktreeMoves?.[ref];
    // Use the recorded owner even when a rebase left it detached: porcelain
    // no longer lists its branch, but we must not bypass that worktree's lock.
    const directory = recorded?.directory ?? elsewhere.get(branch);
    if (!directory) continue;
    if (
      !operation.before.refs[ref] ||
      !refs.after[ref] ||
      (operation.worktreeMoves && !recorded)
    ) {
      // Deleting a newly created, now-occupied branch is still unsafe. New
      // journals also refuse foreign moves this operation never performed.
      assertBranchesAvailable([branch]);
      throw new ExitFailedError(
        `Cannot restore ${branch} in another worktree.`
      );
    }
    if (
      recorded &&
      (recorded.before !== operation.before.refs[ref] ||
        ![recorded.from, recorded.after].includes(refs.after[ref]) ||
        (elsewhere.has(branch) && elsewhere.get(branch) !== directory))
    ) {
      throw new ExitFailedError(
        'Branches changed outside this operation. Refusing to overwrite newer work.'
      );
    }
    // Legacy v1 journals lack receipts. Their before/after delta still supports
    // recovery, with the same stale-tip, lock, dirty-tree and Git-state guards.
    moves.push({
      branch,
      directory,
      sha: operation.before.refs[ref],
      expectedSha: refs.current[ref],
      mode: 'rewrite',
    });
  }
  return moves;
}

function restoreSnapshot(
  before: Snapshot,
  updates: string[],
  changedFiles: string[]
): void {
  if (updates.length)
    journalGit(['update-ref', '--stdin'], {
      input: `start\n${updates.join('\n')}\nprepare\ncommit\n`,
    });
  if (before.branch)
    journalGit(['symbolic-ref', 'HEAD', `refs/heads/${before.branch}`]);
  else journalGit(['update-ref', '--no-deref', 'HEAD', before.head]);
  // Never reset --hard: restore the saved worktree and index separately,
  // including staged and originally-untracked files.
  journalGit(['read-tree', '--reset', '-u', before.worktree]);
  journalGit(['read-tree', before.index]);
  const paths = metadataPaths();
  for (const name of changedFiles) {
    const content = before.files[name];
    const file = paths[name];
    if (content === null || content === undefined)
      fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content, { mode: 0o600 });
  }
}

function reloadRestoredContext(context: TContext): void {
  // Do not engine.clear() here: that deletes the shared persisted cache,
  // including per-branch ancestry proofs, forcing a merge-base for every
  // tracked branch (in every worktree). Neither part can go stale from a
  // restore: the full-cache stamp is a hash of every ref, metadata blob and
  // trunk setting, so the restored refs miss it, and proofs are keyed on
  // immutable commit IDs, so only the branches this restore moved re-validate.
  const restored = initContext(context, composeGit(), {
    verify: !context.engine.noVerify,
  });
  context.engine = restored.engine;
  context.repoConfig = restored.repoConfig;
  context.continueConfig = restored.continueConfig;
  // Re-load the optimistic checksum rather than writing stale cached state.
  context.githubStacks?.reload();
}

function removeOperation(operation: Operation): void {
  const directory = journalDirectory();
  fs.rmSync(path.join(directory, `${operation.id}.json`), { force: true });
  const refs = journalGit([
    'for-each-ref',
    '--format=%(refname)',
    `refs/gt-undo/${operation.id}/`,
  ]);
  if (refs)
    journalGit(['update-ref', '--stdin'], {
      input:
        refs
          .split('\n')
          .map((ref) => `delete ${ref}`)
          .join('\n') + '\n',
    });
  const remaining = fs
    .readdirSync(directory)
    .filter((name) => /^\d+-[a-f0-9]+\.json$/.test(name))
    .sort();
  if (remaining.length)
    atomicJSON(
      path.join(directory, 'latest'),
      remaining[remaining.length - 1].replace(/\.json$/, '')
    );
  else fs.rmSync(path.join(directory, 'latest'), { force: true });
}
