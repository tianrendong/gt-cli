import path from 'path';
import yargs from 'yargs';
import {
  currentGitRepoPrecondition,
  getRepoRootPathPrecondition,
} from '../../lib/preconditions';
import { graphite } from '../../lib/runner';

const args = {
  dotdir: {
    type: 'boolean',
    default: false,
    describe: 'Point to the dotdir instead.',
  },
} as const;

export const command = 'root';
export const canonical = 'internal-only root';
export const description = false;
export const builder = args;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;
export const handler = async (argv: argsT): Promise<void> => {
  return graphite(argv, canonical, async (context) => {
    const root = argv.dotdir
      ? getRepoRootPathPrecondition()
      : currentGitRepoPrecondition();

    context.splog.info(path.resolve(root));
  });
};
