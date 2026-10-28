import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { SCOPE } from '../lib/engine/scope_spec';

export const command = 'freeze [branch]';
export const description =
  'Freeze a branch and any downstack branches, preventing local modifications including restacks.';
export const builder = {
  branch: { type: 'string', positional: true },
  only: {
    type: 'boolean',
    default: false,
    describe: 'Affect only this branch, not its downstack/upstack branches.',
  },
} as const;
export type FreezeArgs = yargs.Arguments<
  yargs.InferredOptionTypes<typeof builder>
>;
export const handler = async (argv: FreezeArgs): Promise<void> =>
  setFrozen(argv, true);

export async function setFrozen(
  argv: FreezeArgs,
  frozen: boolean
): Promise<void> {
  return graphite(argv, frozen ? 'freeze' : 'unfreeze', async (context) => {
    // Matches gt: freeze affects the branch and everything downstack;
    // unfreeze affects the branch and everything upstack.
    const branches = context.engine.getRelativeStack(
      argv.branch ?? context.engine.currentBranchPrecondition,
      argv.only ? SCOPE.BRANCH : frozen ? SCOPE.DOWNSTACK : SCOPE.UPSTACK
    );
    branches
      .filter((b) => !context.engine.isTrunk(b))
      .forEach((branch) => {
        context.engine.freezeBranch(branch, frozen);
      });
  });
}
