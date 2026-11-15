import yargs from 'yargs';
import { trackBranch } from '../actions/track_branch';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe: 'Branch to begin tracking. Defaults to current branch.',
    demandOption: false,
    positional: true,
    type: 'string',
    hidden: true,
  },
  force: {
    describe: 'Sets the parent to the most recent tracked ancestor.',
    default: false,
    type: 'boolean',
    alias: 'f',
  },
  parent: {
    describe: "The tracked branch's parent. Must be a tracked branch.",
    demandOption: false,
    type: 'string',
    alias: 'p',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'track [branch]';
export const canonical = 'track';
export const description =
  'Start tracking the current or provided branch with Graphite by selecting its parent.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    trackBranch(
      {
        branchName: argv.branch,
        parentBranchName: argv.parent,
        force: argv.force,
      },
      context
    )
  );
