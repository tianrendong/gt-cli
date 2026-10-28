import { default as chalk } from 'chalk';
import { TContext } from '../../lib/context';
import { deleteBranchAction, isSafeToDelete } from '../delete_branch';

/**
 * This method is assumed to be idempotent -- if a merge conflict interrupts
 * execution of this method, we simply restart the method upon running `gt
 * continue`.
 *
 * It returns a list of branches whose parents have changed so that we know
 * which branches to restack.
 */
// eslint-disable-next-line max-lines-per-function
export async function cleanBranches(
  opts: {
    showDeleteProgress: boolean;
    force: boolean;
    /** Branch -> why it cannot be deleted from this worktree, as a clause
     * completing "cannot be cleaned up while <reason>". */
    protectedBranches?: ReadonlyMap<string, string>;
    /** Show a section only when cleanup finds candidates. */
    showSection?: boolean;
    /** PR states are fresh: skip history scans for branches with open PRs. */
    trustOpenPRs?: boolean;
  },
  context: TContext
): Promise<string[]> {
  /**
   * To find and delete all of the merged/closed branches, we traverse all of
   * the stacks off of trunk, greedily deleting the base branches and rebasing
   * the remaining branches.
   *
   * To greedily delete the branches, we keep track of the branches we plan
   * to delete as well as a live snapshot of their children. When a branch
   * we plan to delete has no more children, we know that it is safe to
   * eagerly delete.
   *
   * This eager deletion doesn't matter much in small repos, but matters
   * a lot if a repo has a lot of branches to delete. Whereas previously
   * any error in `repo sync` would throw away all of the work the command did
   * to determine what could and couldn't be deleted, now we take advantage
   * of that work as soon as we can.
   */

  const branchesToProcess = context.engine.getChildren(context.engine.trunk);
  const branchesToDelete: Record<string, Set<string>> = {};
  const branchesWithNewParents: string[] = [];

  /**
   * Since we're doing a DFS, assuming rather even distribution of stacks off
   * of trunk children, we can trace the progress of the DFS through the trunk
   * children to give the user a sense of how far the repo sync has progressed.
   * Note that we only do this if the user has a large number of branches off
   * of trunk (> 50).
   */
  const progressMarkers = opts.showDeleteProgress
    ? getProgressMarkers(branchesToProcess)
    : {};
  let cleanupStarted = false;
  const onDeleteCandidate = () => {
    if (cleanupStarted || !opts.showSection) return;
    cleanupStarted = true;
    context.splog.info('🧹 Cleaning up branches with merged/closed PRs...');
  };

  while (branchesToProcess.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const branchName = branchesToProcess.pop()!;

    if (branchName in branchesToDelete) {
      continue;
    }

    if (branchName in progressMarkers) {
      context.splog.info(
        `${progressMarkers[branchName]} done searching for merged/closed branches to delete...`
      );
    }

    context.splog.debug(`Checking if should delete ${branchName}...`);
    // Some branches cannot be deleted from this worktree (checked out or
    // being worked on elsewhere). Say so instead of prompting; keep them.
    const protectedReason = opts.protectedBranches?.get(branchName);
    if (protectedReason) {
      const safe = isSafeToDelete(branchName, context, {
        trustOpenPRs: opts.trustOpenPRs,
      });
      if (safe.result) {
        onDeleteCandidate();
        context.splog.warn(
          `${protectedSubject(
            branchName,
            safe.reason,
            context
          )} but cannot be cleaned up while ${protectedReason}.`
        );
      }
    }
    const shouldDelete =
      !protectedReason &&
      (await shouldDeleteBranch(
        {
          branchName: branchName,
          force: opts.force,
          trustOpenPRs: opts.trustOpenPRs,
          onDeleteCandidate,
        },
        context
      ));
    if (shouldDelete) {
      const children = context.engine.getChildren(branchName);

      // We concat children here (because we pop above) to make our search a DFS.
      children.forEach((b) => branchesToProcess.push(b));

      // Value in branchesToDelete is a list of children blocking deletion.
      branchesToDelete[branchName] = new Set(children);
      context.splog.debug(
        `Marked ${branchName} for deletion. Blockers: ${children}`
      );
    } else {
      // We know this branch isn't being deleted.
      // If its parent IS being deleted, we have to change its parent.

      // First, find the nearest ancestor that isn't being deleted.
      const parentBranchName = context.engine.getParentPrecondition(branchName);
      let newParentBranchName = parentBranchName;
      while (newParentBranchName in branchesToDelete) {
        newParentBranchName =
          context.engine.getParentPrecondition(newParentBranchName);
      }

      // If the nearest ancestor is not already the parent, we make it so.
      if (newParentBranchName !== parentBranchName) {
        context.engine.setParent(branchName, newParentBranchName);
        context.splog.info(
          `Set parent of ${chalk.cyan(branchName)} to ${chalk.blueBright(
            newParentBranchName
          )}.`
        );
        branchesWithNewParents.push(branchName);

        // This branch is no longer blocking its parent's deletion.
        branchesToDelete[parentBranchName].delete(branchName);
        context.splog.debug(
          `Removed a blocker for ${parentBranchName}. Blockers: ${[
            ...branchesToDelete[parentBranchName].entries(),
          ]}`
        );
      }
    }

    greedilyDeleteUnblockedBranches(branchesToDelete, context);
  }
  if (cleanupStarted) context.splog.newline();
  return branchesWithNewParents;
}

// With either path in the above, we may have unblocked a branch that can
// be deleted immediately. We repeatedly check for branches that can be
// deleted, because the act of deleting one branch may free up another.
function greedilyDeleteUnblockedBranches(
  branchesToDelete: Record<string, Set<string>>,
  context: TContext
) {
  const unblockedBranches = Object.keys(branchesToDelete).filter(
    (branchToDelete) => branchesToDelete[branchToDelete].size === 0
  );
  context.splog.debug(`Unblocked branches: ${unblockedBranches}`);

  while (unblockedBranches.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const branchName = unblockedBranches.pop()!;
    const parentBranchName = context.engine.getParentPrecondition(branchName);

    deleteBranchAction({ branchName: branchName, force: true }, context);

    // This branch is no longer blocking its parent's deletion.
    // Remove it from the parents list of blockers and check if parent is
    // now unblocked for deletion.
    if (
      branchesToDelete[parentBranchName]?.delete(branchName) &&
      branchesToDelete[parentBranchName].size === 0
    ) {
      context.splog.debug(`${parentBranchName} is now unblocked.`);
      unblockedBranches.push(parentBranchName);
    }

    // Remove the branch from the list of branches to delete.
    delete branchesToDelete[branchName];
  }
}

function getProgressMarkers(trunkChildren: string[]): Record<string, string> {
  const progressMarkers: Record<string, string> = {};
  trunkChildren
    // Ignore the first child - don't show 0% progress.
    .slice(1)
    .forEach(
      (child, i) =>
        (progressMarkers[child] = `${+(
          // Add 1 to the overall children length to account for the fact that
          // when we're on the last trunk child, we're not 100% done - we need
          // to go through its stack.
          ((i + 1 / (trunkChildren.length + 1)) * 100).toFixed(2)
        )}%`)
    );
  return progressMarkers;
}

/** Native wording: "PR #N for X is merged" when a PR settled the branch,
 * otherwise what the local history shows. */
function protectedSubject(
  branchName: string,
  reason: string,
  context: TContext
): string {
  const pr = context.engine.getPrInfo(branchName);
  if (pr?.number && pr.state === 'MERGED')
    return `PR #${pr.number} for ${chalk.cyan(branchName)} is merged`;
  if (pr?.number && pr.state === 'CLOSED')
    return `PR #${pr.number} for ${chalk.cyan(branchName)} is closed`;
  return reason;
}

async function shouldDeleteBranch(
  args: {
    branchName: string;
    force: boolean;
    trustOpenPRs?: boolean;
    onDeleteCandidate: () => void;
  },
  context: TContext
): Promise<boolean> {
  const shouldDelete = isSafeToDelete(args.branchName, context, {
    trustOpenPRs: args.trustOpenPRs,
  });
  if (!shouldDelete.result) {
    return false;
  }

  // Don't delete empty branches without an associated PR
  if (
    context.engine.isBranchEmpty(args.branchName) &&
    !context.engine.getPrInfo(args.branchName)?.number
  ) {
    return false;
  }

  args.onDeleteCandidate();

  if (args.force) {
    return true;
  }

  if (!context.interactive) {
    return false;
  }

  return (
    (
      await context.prompts({
        type: 'confirm',
        name: 'value',
        message: `${shouldDelete.reason}. Delete it?`,
        initial: true,
      })
    ).value === true
  );
}
