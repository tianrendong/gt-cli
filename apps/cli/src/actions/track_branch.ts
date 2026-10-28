import chalk from 'chalk';
import { TContext } from '../lib/context';
import { ExitFailedError, KilledError } from '../lib/errors';
import { suggest } from '../lib/utils/prompts_helpers';
import { checkoutBranch } from './checkout_branch';

export async function trackBranchInteractive(
  context: TContext
): Promise<boolean> {
  const parentBranchName = context.engine.currentBranchPrecondition;
  const descendants = context.engine.isTrunk(parentBranchName)
    ? undefined
    : context.engine.getDescendantBranchNames(parentBranchName);
  const choices = context.engine.allBranchNames
    .filter(
      (branchName) =>
        !context.engine.isTrunk(branchName) &&
        !context.engine.isBranchTracked(branchName) &&
        (!descendants || descendants.has(branchName))
    )
    .map((branchName) => ({ title: branchName, value: branchName }));

  if (!choices.length) {
    context.splog.info(
      `No branches available to track as children of ${chalk.blueBright(
        parentBranchName
      )}!`
    );
    return false;
  }

  const branchName = (
    await context.prompts({
      type: 'autocomplete',
      name: 'value',
      message: `Enter a branch to track as a child of ${parentBranchName} (autocomplete or arrow keys)`,
      choices,
      suggest,
    })
  ).value;

  if (!branchName) {
    throw new KilledError();
  }

  trackHelper({ branchName, parentBranchName }, context);
  await checkoutBranch(branchName, context);
  return true;
}

function getPotentialParents(
  args: {
    branchName: string;
    onlyTrackedParents: boolean;
  },
  context: TContext
): { title: string; value: string }[] {
  // One ref scan per branch instead of one merge-base per (branch, candidate)
  // pair; in large repos each merge-base costs tens of milliseconds.
  const ancestorCache = new Map<string, Set<string>>();
  const ancestorsOf = (branchName: string): Set<string> => {
    let ancestors = ancestorCache.get(branchName);
    if (!ancestors) {
      ancestors = context.engine.getAncestorBranchNames(branchName);
      ancestorCache.set(branchName, ancestors);
    }
    return ancestors;
  };
  return context.engine.allBranchNames
    .filter(
      (potentialParentBranchName) =>
        context.engine.isTrunk(potentialParentBranchName) ||
        ((!args.onlyTrackedParents ||
          context.engine.isBranchTracked(potentialParentBranchName)) &&
          ancestorsOf(args.branchName).has(potentialParentBranchName))
    )
    .sort((left, right) => {
      return left === right
        ? 0
        : context.engine.isTrunk(right) || ancestorsOf(left).has(right)
        ? -1 // left is a descendant of right
        : 1; // left is not a descendant of right
    })
    .map((b) => {
      return { title: b, value: b };
    });
}

export async function trackStack(
  args: {
    branchName?: string;
    force: boolean;
  },
  context: TContext
): Promise<void> {
  const force = args.force || !context.interactive;
  const branchName = args.branchName ?? context.engine.currentBranch;

  if (!branchName) {
    throw new ExitFailedError(`No branch checked out.`);
  }

  if (
    context.engine.isTrunk(branchName) ||
    context.engine.isBranchTracked(branchName)
  ) {
    context.splog.info(`${chalk.cyan(branchName)} is already tracked!`);
    return;
  }
  context.splog.debug(`Tracking ${branchName}`);

  const choices = getPotentialParents(
    { branchName, onlyTrackedParents: false },
    context
  );

  if (choices.length === 0) {
    throw new ExitFailedError(
      `No possible parents for this branch. Try running \`git rebase ${context.engine.trunk} ${branchName}\``
    );
  }

  const parentBranchName =
    choices.length === 1 || force
      ? choices[0].value
      : (
          await context.prompts({
            type: 'autocomplete',
            name: 'branch',
            message: `Select a parent for ${branchName} (autocomplete or arrow keys)`,
            choices,
            suggest,
          })
        ).branch;

  await trackStack({ branchName: parentBranchName, force }, context);
  trackHelper({ branchName, parentBranchName }, context);
}

export async function trackBranch(
  args: {
    branchName: string | undefined;
    parentBranchName: string | undefined;
    force: boolean;
  },
  context: TContext
): Promise<void> {
  const branchName = args.branchName ?? context.engine.currentBranch;
  if (!branchName) {
    throw new ExitFailedError(`No branch checked out.`);
  }

  if (args.force || !args.parentBranchName) {
    const choices = getPotentialParents(
      { branchName, onlyTrackedParents: true },
      context
    );

    if (choices.length === 0) {
      throw new ExitFailedError(
        `No possible parents for this branch. Try running \`git rebase ${context.engine.trunk} ${branchName}\``
      );
    }

    if (args.force || choices.length === 1) {
      trackHelper({ branchName, parentBranchName: choices[0].value }, context);
      return;
    }

    if (!context.interactive) {
      throw new ExitFailedError(
        `Multiple possible parents; cannot prompt in non-interactive mode.`
      );
    }

    trackHelper(
      {
        branchName,
        parentBranchName: (
          await context.prompts({
            type: 'autocomplete',
            name: 'branch',
            message: `Select a parent for ${branchName} (autocomplete or arrow keys)`,
            choices,
            suggest,
          })
        ).branch,
      },
      context
    );
    return;
  }

  if (
    !context.engine.isTrunk(args.parentBranchName) &&
    !context.engine.isDescendantOf(branchName, args.parentBranchName)
  ) {
    context.splog.tip(
      `Are you sure that ${chalk.cyan(
        args.parentBranchName
      )} is the right parent for ${chalk.cyan(
        branchName
      )}?  If so, you can fix its history with ${chalk.cyan(
        `git rebase ${args.parentBranchName} ${branchName}`
      )} and then try again.`
    );

    throw new ExitFailedError(
      `${chalk.yellow(
        args.parentBranchName
      )} is not in the history of ${chalk.yellow(branchName)}.`
    );
  }

  trackHelper({ branchName, parentBranchName: args.parentBranchName }, context);
}

function trackHelper(
  {
    branchName,
    parentBranchName,
  }: {
    branchName: string;
    parentBranchName: string;
  },
  context: TContext
) {
  context.engine.trackBranch(branchName, parentBranchName);
  const commitCount = context.engine.getAllCommits(branchName, 'SHA').length;
  context.splog.info(
    `Tracked branch ${chalk.green(branchName)} with parent ${chalk.blueBright(
      parentBranchName
    )} ${chalk.dim(
      `(includes ${commitCount} commit${commitCount === 1 ? '' : 's'})`
    )}.`
  );
}
