import yargs from 'yargs';
import { showBranchInfo } from '../actions/show_branch';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe: 'The branch to show info for. Defaults to current branch.',
    demandOption: false,
    type: 'string',
    positional: true,
    hidden: true,
  },
  body: {
    describe: 'Show the PR body, if it exists.',
    default: false,
    type: 'boolean',
    alias: 'b',
  },
  diff: {
    describe: 'Show the diff between this branch and its parent.',
    default: false,
    type: 'boolean',
    alias: 'd',
  },
  patch: {
    describe: 'Show the changes made by each commit.',
    default: false,
    type: 'boolean',
    alias: 'p',
  },
  stat: {
    describe: 'Show a diffstat instead of a full diff.',
    default: false,
    type: 'boolean',
    alias: 's',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'info [branch]';
export const canonical = 'info';
export const description = 'Display information about a branch.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    await showBranchInfo(
      argv.branch ?? context.engine.currentBranchPrecondition,
      { patch: argv.patch, diff: argv.diff, stat: argv.stat, body: argv.body },
      context
    );
  });
