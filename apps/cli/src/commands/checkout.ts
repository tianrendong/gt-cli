import yargs from 'yargs';
import { checkoutBranch } from '../actions/checkout_branch';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe: 'The branch to checkout.',
    demandOption: false,
    type: 'string',
    positional: true,
    hidden: true,
  },
  all: {
    describe: 'Show branches across every configured trunk.',
    type: 'boolean',
    default: false,
    alias: 'a',
  },
  'show-untracked': {
    describe: 'Include untracked branches in interactive selection.',
    type: 'boolean',
    alias: 'u',
  },
  stack: {
    describe: 'Only show the current stack in interactive selection.',
    type: 'boolean',
    default: false,
    alias: 's',
  },
  trunk: {
    describe: 'Checkout the current trunk.',
    type: 'boolean',
    default: false,
    alias: 't',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'checkout [branch]';
export const canonical = 'checkout';
export const description =
  'Switch to a branch. If no branch is provided, opens an interactive selector.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    checkoutBranch(
      {
        branchName: argv.trunk ? context.engine.trunk : argv.branch,
        showUntracked: argv['show-untracked'],
        stack: argv.stack,
        all: argv.all,
      },
      context
    )
  );
