import yargs from 'yargs';
import { graphite } from '../../lib/runner';

const args = {
  ref: {
    demandOption: true,
    type: 'string',
    positional: true,
    describe: 'The ref to load the file from.',
  },
  file: {
    demandOption: true,
    type: 'string',
    positional: true,
    describe: 'The config to load.',
  },
} as const;

export const command = 'cat [ref] [file]';
export const canonical = 'internal-only cat';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    context.splog.info(context.engine.getFileContents(argv.ref, argv.file));
  });
};
