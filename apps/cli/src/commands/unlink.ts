import yargs from 'yargs';
import { graphite } from '../lib/runner';

const args = {
  branch: {
    describe: 'The branch to unlink.',
    demandOption: false,
    type: 'string',
    positional: true,
    hidden: true,
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'unlink [branch]';
export const canonical = 'unlink';
export const description =
  'Unlink the PR currently associated with the branch.';
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const branchName = argv.branch ?? context.engine.currentBranchPrecondition;
    const prNumber = context.engine.getPrInfo(branchName)?.number;
    // Native confirms before dropping a real PR association, so this refuses
    // in non-interactive mode rather than silently unlinking.
    if (
      prNumber &&
      !(
        await context.prompts({
          type: 'confirm',
          name: 'value',
          message: `Unlink PR #${prNumber} from ${branchName}?`,
          initial: false,
        })
      ).value
    ) {
      return;
    }
    context.engine.clearPrInfo(branchName);
    context.splog.info(
      prNumber
        ? `Unlinked PR #${prNumber} from ${branchName}`
        : `No PR associated with ${branchName}`
    );
  });
