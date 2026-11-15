import yargs from 'yargs';
import { graphite } from '../lib/runner';

export const command = 'state';
export const description = 'Print local branch metadata as JSON (offline).';
export const handler = async (argv: yargs.Arguments): Promise<void> =>
  graphite(argv, 'state', async (context) => {
    process.stdout.write(context.engine.debug + '\n');
  });
