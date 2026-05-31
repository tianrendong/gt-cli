import yargs from 'yargs';
import { absorbAction } from '../actions/absorb';
import { graphite } from '../lib/runner';

const args = {
  'dry-run': {
    describe:
      'Print the planned hunk-to-commit routing without mutating anything.',
    type: 'boolean',
    default: false,
    alias: 'n',
  },
  force: {
    describe: 'Apply without interactive confirmation.',
    type: 'boolean',
    default: false,
    alias: 'f',
  },
  all: {
    describe: 'Stage all tracked modifications before absorbing (like `-a`).',
    type: 'boolean',
    default: false,
    alias: 'a',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'absorb';
export const canonical = 'absorb';
export const description =
  'Amend staged changes into the downstack commits that last touched those lines, then restack descendants.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    absorbAction(
      {
        dryRun: argv['dry-run'],
        force: argv.force,
        all: argv.all,
      },
      context
    )
  );
