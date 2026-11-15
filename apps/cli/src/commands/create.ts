import yargs from 'yargs';
import { createBranchAction } from '../actions/create_branch';
import { ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';

const args = {
  name: {
    type: 'string',
    positional: true,
    demandOption: false,
    optional: true,
    describe: 'The name of the new branch.',
    hidden: true,
  },
  message: {
    describe: `Specify a commit message.`,
    demandOption: false,
    type: 'string',
    alias: 'm',
  },
  all: {
    describe: `Stage all unstaged changes before creating the branch, including untracked files.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'a',
  },
  patch: {
    describe: `Pick hunks to stage before committing.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'p',
  },
  insert: {
    describe: `Insert this branch between the current branch and its child.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'i',
  },
  update: {
    describe: `Stage updates to tracked files only.`,
    demandOption: false,
    default: false,
    type: 'boolean',
    alias: 'u',
  },
  onto: {
    describe: `Create the branch on top of the specified branch instead of the current branch.`,
    demandOption: false,
    type: 'string',
    alias: 'o',
  },
  ai: {
    describe: `Graphite AI branch/message generation is not supported by this GitHub-only CLI.`,
    demandOption: false,
    default: false,
    type: 'boolean',
  },
  'no-ai': {
    describe: `No-op compatibility flag; this GitHub-only CLI never uses Graphite AI.`,
    demandOption: false,
    default: false,
    type: 'boolean',
  },
  verbose: {
    describe: `Show commit diff in the commit-message editor.`,
    demandOption: false,
    count: true,
    alias: 'v',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'create [name]';
export const canonical = 'create';
export const description =
  'Create a new branch stacked on top of the current branch and commit staged changes.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (argv.ai) {
      throw new ExitFailedError(
        'This GitHub-only CLI does not support Graphite AI branch/message generation. Use --message or omit --ai.'
      );
    }
    if (argv.onto) {
      context.engine.checkoutBranch(argv.onto);
    }

    await createBranchAction(
      {
        branchName: argv.name,
        message: argv.message,
        all: argv.all,
        update: argv.update,
        verbose: argv.verbose,
        insert: argv.insert,
        patch: argv.patch,
      },
      context
    );
  });
