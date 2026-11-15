import chalk from 'chalk';
import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { interactiveBranchSelection } from './log';

export async function checkoutBranch(
  {
    branchName,
    showUntracked,
    stack,
    all,
  }: {
    branchName: string | undefined;
    showUntracked?: boolean;
    stack?: boolean;
    all?: boolean;
  },
  context: TContext
): Promise<void> {
  if (!branchName) {
    branchName = await interactiveBranchSelection(
      {
        message: 'Checkout a branch (autocomplete or arrow keys)',
        showUntracked,
        all,
        branchName: stack
          ? context.engine.currentBranchPrecondition
          : undefined,
      },
      context
    );
  }
  if (branchName === context.engine.currentBranch) {
    context.splog.info(`Already on ${chalk.cyan(branchName)}.`);
    return;
  }
  context.engine.checkoutBranch(branchName);
  context.splog.info(`Checked out ${chalk.cyan(branchName)}.`);
  printBranchInfo(branchName, context);
}

function printBranchInfo(branchName: string, context: TContext) {
  if (
    !context.engine.isTrunk(branchName) &&
    !context.engine.isBranchTracked(branchName)
  ) {
    context.splog.info(`This branch is not tracked by Graphite.`);
  } else if (context.engine.getPrInfo(branchName)?.state === 'MERGED') {
    context.splog.info('This branch has been merged.');
    context.splog.info(`Run ${chalk.cyan('gt sync')} to clean it up.`);
  } else if (!context.engine.isBranchFixed(branchName)) {
    context.splog.info(
      `This branch has fallen behind ${chalk.blueBright(
        context.engine.getParentPrecondition(branchName)
      )}.\nRun ${chalk.cyan('gt restack')} to resolve.`
    );
  } else {
    const nearestAncestorNeedingRestack = context.engine
      .getRelativeStack(branchName, SCOPE.DOWNSTACK)
      .reverse()
      .find((ancestor) => !context.engine.isBranchFixed(ancestor));

    if (nearestAncestorNeedingRestack) {
      context.splog.info(
        `The downstack branch ${chalk.cyan(
          nearestAncestorNeedingRestack
        )} has fallen behind ${chalk.blueBright(
          context.engine.getParentPrecondition(nearestAncestorNeedingRestack)
        )}.\nRun ${chalk.cyan('gt restack')} to resolve.`
      );
    } else if (!context.engine.isTrunk(branchName)) {
      const published = context.engine.getPublishedRevision(branchName);
      if (published !== context.engine.getRevision(branchName)) {
        context.splog.info(
          published
            ? 'This branch has local changes that need to be submitted.'
            : 'This branch has not yet been submitted.'
        );
        context.splog.info(
          `Run ${chalk.cyan('gt submit')} to push your changes.`
        );
      }
    }
  }
}
