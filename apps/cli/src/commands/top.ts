import yargs from 'yargs';
import { switchBranchAction } from '../actions/branch_traversal';
import { graphite } from '../lib/runner';

const args = {} as const;
type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'top';
export const canonical = 'top';
export const description = 'Switch to the tip branch of the current stack.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    switchBranchAction({ direction: 'TOP' }, context)
  );
