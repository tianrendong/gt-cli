import chalk from 'chalk';
import yargs from 'yargs';
import { currentBranchOnto } from '../actions/current_branch_onto';
import { interactiveBranchSelection } from '../actions/log';
import { BadTrunkOperationError, ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';
import { restackBranches } from '../actions/restack';
import { SCOPE } from '../lib/engine/scope_spec';
import { uncommittedTrackedChangesPrecondition } from '../lib/preconditions';

const args = {
  all: {
    describe:
      'Show branches across all configured trunks in interactive selection.',
    type: 'boolean',
    default: false,
    alias: 'a',
  },
  only: {
    describe:
      'Move only this branch, leaving its former descendants on its former parent.',
    type: 'boolean',
    default: false,
  },
  onto: {
    describe: 'Branch to move the current branch onto.',
    type: 'string',
    alias: 'o',
  },
  source: {
    describe: 'Branch to move. Defaults to current branch.',
    type: 'string',
    alias: 's',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'move';
export const canonical = 'move';
export const description =
  'Rebase the current branch onto the target branch and restack all descendants.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const originalBranch = argv.source
      ? context.engine.currentBranch
      : undefined;
    if (argv.source) {
      context.engine.checkoutBranch(argv.source);
    }
    const source = context.engine.currentBranchPrecondition;
    if (context.engine.isTrunk(source))
      throw new BadTrunkOperationError(source);

    const dest =
      argv.onto ??
      (await interactiveBranchSelection(
        {
          message: `Choose a new base for ${chalk.yellow(
            context.engine.currentBranchPrecondition
          )} (autocomplete or arrow keys)`,
          omitCurrentBranch: true,
          all: argv.all,
        },
        context
      ));

    if (argv.only) {
      uncommittedTrackedChangesPrecondition();
      const source = context.engine.currentBranchPrecondition;
      if (dest === source)
        throw new ExitFailedError('Cannot move a branch onto itself.');
      const parent = context.engine.getParentPrecondition(source);
      const children = [...context.engine.getChildren(source)];
      [source, ...children].forEach(context.engine.assertBranchMutable);
      children.forEach((child) => context.engine.setParent(child, parent));
      restackBranches(
        children.flatMap((child) =>
          context.engine.getRelativeStack(child, SCOPE.UPSTACK)
        ),
        context
      );
    }
    currentBranchOnto(dest, context);

    if (originalBranch) {
      context.engine.checkoutBranch(originalBranch);
    }
  });
