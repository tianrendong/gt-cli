import yargs from 'yargs';
import { untrackBranch } from '../actions/untrack_branch';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe: 'Branch to stop tracking. Defaults to current branch.',
    demandOption: false,
    type: 'string',
    positional: true,
    hidden: true,
  },
  force: {
    describe:
      'Will not prompt for confirmation before untracking a branch with children.',
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'f',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'untrack [branch]';
export const canonical = 'untrack';
export const description = 'Stop tracking a branch with Graphite.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    untrackBranch(
      {
        branchName: argv.branch ?? context.engine.currentBranchPrecondition,
        force: argv.force,
      },
      context
    )
  );
