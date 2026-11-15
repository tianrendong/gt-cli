import yargs from 'yargs';
import { restackBranches } from '../actions/restack';
import { SCOPE } from '../lib/engine/scope_spec';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe:
      'Which branch to run this command from. Defaults to current branch.',
    type: 'string',
  },
  downstack: {
    describe: 'Only restack this branch and its ancestors.',
    type: 'boolean',
    default: false,
    alias: 'd',
  },
  only: {
    describe: 'Only restack this branch.',
    type: 'boolean',
    default: false,
    alias: 'o',
  },
  upstack: {
    describe: 'Only restack this branch and its descendants.',
    type: 'boolean',
    default: false,
    alias: 'u',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'restack';
export const canonical = 'restack';
export const description =
  'Ensure each branch in the current stack has its parent in its Git commit history.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const branchName = argv.branch ?? context.engine.currentBranchPrecondition;
    const scope = argv.only
      ? SCOPE.BRANCH
      : argv.downstack
      ? SCOPE.DOWNSTACK
      : argv.upstack
      ? SCOPE.UPSTACK
      : SCOPE.STACK;

    restackBranches(
      context.engine.getRelativeStack(branchName, scope),
      context
    );
  });
