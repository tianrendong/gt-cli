import yargs from 'yargs';
import { PreconditionsFailedError } from '../../lib/errors';
import { graphite } from '../../lib/runner';

const args = {
  target: {
    demandOption: true,
    choices: ['uncommitted', 'head', 'stack'],
    positional: true,
    describe: 'What to diff against.',
  },
  file: {
    demandOption: true,
    type: 'string',
    positional: true,
    describe: 'The config to load.',
  },
  ref: {
    type: 'string',
    describe: 'Only respected for stack merge. The branch to show changes of.',
  },
} as const;

export const command = 'relative-cat [target] [file]';
export const canonical = 'internal-only relative-cat';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    if (argv.target === 'uncommitted') {
      context.splog.info(context.engine.getFileContents('HEAD', argv.file));
      return;
    }

    if (argv.target === 'head') {
      context.splog.info(context.engine.getFileContents('HEAD~', argv.file));
      return;
    }

    if (argv.target === 'stack') {
      const current = argv.ref || context.engine.currentBranch;
      if (!current) {
        throw new PreconditionsFailedError(
          'Running stack diff when not on a branch and without passing --ref'
        );
      }

      context.splog.info(
        context.engine.getFileContents(
          context.engine.getParentOrPrev(current),
          argv.file
        )
      );
      return;
    }
  });
};
