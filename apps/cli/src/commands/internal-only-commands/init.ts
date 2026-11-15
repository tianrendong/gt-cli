import yargs from 'yargs';
import { graphite } from '../../lib/runner';

const args = {} as const;

export const command = 'init';
export const canonical = 'internal-only init';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    // @TODO
    void context;
  });
};
