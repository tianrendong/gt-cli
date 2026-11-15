import fs from 'fs';
import os from 'os';
import path from 'path';
import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { ExitFailedError } from '../lib/errors';
import { journalGit as git } from '../lib/operations/journal';
import { restackBranches } from './restack';
import { assertBranchesAvailable } from '../lib/git/worktrees';

export type BranchPatch = {
  branch: string;
  patch: string;
  message?: string;
  append?: boolean;
  resetAuthor?: boolean;
};

/** Prepare commits in detached temporary worktrees so an inapplicable patch
 * cannot partially modify an ancestor, the real index, or the working tree.
 * All branch tips move together, then the existing continuation engine restacks.
 */
export function applyBranchPatches(
  patches: BranchPatch[],
  context: TContext
): void {
  const original = context.engine.currentBranchPrecondition;
  const downstack = context.engine.getRelativeStack(original, SCOPE.DOWNSTACK);
  if (git(['diff', '--name-only']).length) {
    throw new ExitFailedError(
      'Stage or stash unstaged tracked changes before modifying a downstack branch.'
    );
  }
  if (!context.engine.detectStagedChanges())
    throw new ExitFailedError('No staged changes to apply.');
  if (
    patches.some(
      (p) => !downstack.includes(p.branch) || context.engine.isTrunk(p.branch)
    )
  ) {
    throw new ExitFailedError(
      '--into must name the current branch or a tracked ancestor, never trunk.'
    );
  }
  assertBranchesAvailable(patches.map((patch) => patch.branch));
  const ordered = [...patches].sort(
    (a, b) => downstack.indexOf(a.branch) - downstack.indexOf(b.branch)
  );
  const updates = ordered.map((patch) => {
    context.engine.assertBranchMutable(patch.branch);
    const before = context.engine.getRevision(patch.branch);
    return {
      branch: patch.branch,
      before,
      after: prepareCommit(patch, context),
    };
  });
  // Every staged hunk is represented by one of the prepared commits. There are
  // no unstaged tracked changes; the operation journal retains the original
  // index and working files for abort/undo, including newly added files.
  git(['read-tree', '--reset', '-u', 'HEAD']);
  git(['update-ref', '--stdin'], {
    input:
      'start\n' +
      updates
        .map((u) => `update refs/heads/${u.branch} ${u.after} ${u.before}`)
        .join('\n') +
      '\nprepare\ncommit\n',
  });
  git(['read-tree', '--reset', '-u', `refs/heads/${original}`]);
  context.engine.rebuild();
  restackBranches(
    context.engine.getRelativeStack(ordered[0].branch, SCOPE.UPSTACK_EXCLUSIVE),
    context
  );
  context.engine.checkoutBranch(original);
}

function prepareCommit(patch: BranchPatch, context: TContext): string {
  return inDetachedWorktree(
    context.engine.getRevision(patch.branch),
    (worktree) => {
      const options = { cwd: worktree, input: patch.patch };
      try {
        git(['apply', '--index', '--binary'], options);
      } catch {
        // Plain apply is atomic; on failure, try Git's blob-aware three-way apply.
        git(['apply', '--index', '--3way', '--binary'], options);
      }
      git(
        [
          'commit',
          ...(patch.append ? [] : ['--amend']),
          ...(patch.message
            ? ['-m', patch.message]
            : patch.append
            ? ['-m', `Update ${patch.branch}`]
            : ['--no-edit']),
          ...(patch.resetAuthor ? ['--reset-author'] : []),
          ...(context.engine.noVerify ? ['--no-verify'] : []),
        ],
        { cwd: worktree }
      );
      return git(['rev-parse', 'HEAD'], { cwd: worktree });
    },
    `Could not apply staged changes to ${patch.branch}. Original branches and index are unchanged.`
  );
}

/** Rebuild a branch's commit chain, applying a patch to each selected commit.
 * Preparation happens in a detached temporary worktree; nothing is published
 * until the caller updates the branch ref.
 */
export function prepareRewrittenCommits(
  args: {
    commits: string[]; // oldest to newest
    patches: Map<string, string>;
    noVerify: boolean;
    /** Absorb builds zero-context hunks, which Git refuses without this. */
    unidiffZero?: boolean;
  },
  _context: TContext
): string {
  const firstIndex = args.commits.findIndex((sha) => args.patches.has(sha));
  const base =
    firstIndex === 0
      ? git(['rev-parse', `${args.commits[0]}^`])
      : args.commits[firstIndex - 1];
  return inDetachedWorktree(
    base,
    (worktree) => {
      for (const sha of args.commits.slice(firstIndex)) {
        git(['cherry-pick', '--allow-empty', sha], { cwd: worktree });
        const patch = args.patches.get(sha);
        if (!patch) continue;
        const options = { cwd: worktree, input: patch };
        if (args.unidiffZero) {
          // Zero-context hunks use HEAD's line numbers. Applying them directly
          // to an older commit can silently edit a different repeated line.
          // First apply to the recorded preimage, then merge into this commit.
          git(
            ['apply', '--index', '--3way', '--binary', '--unidiff-zero'],
            options
          );
        } else {
          try {
            git(['apply', '--index', '--binary'], options);
          } catch {
            git(['apply', '--index', '--3way', '--binary'], options);
          }
        }
        git(
          [
            'commit',
            '--amend',
            '--no-edit',
            ...(args.noVerify ? ['--no-verify'] : []),
          ],
          { cwd: worktree }
        );
      }
      return git(['rev-parse', 'HEAD'], { cwd: worktree });
    },
    'Could not absorb a hunk into its commit. Original branches and index are unchanged.'
  );
}

function inDetachedWorktree(
  revision: string,
  work: (worktree: string) => string,
  failure: string
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-into-'));
  const worktree = path.join(directory, 'worktree');
  try {
    git(['worktree', 'add', '--detach', worktree, revision]);
    return work(worktree);
  } catch (error) {
    throw new ExitFailedError(`${failure}\n${(error as Error).message}`);
  } finally {
    if (fs.existsSync(path.join(worktree, '.git')))
      git(['worktree', 'remove', '--force', worktree]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
