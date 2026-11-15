import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { latestOperation, restoreOperation } from '../lib/operations/journal';
import { ExitFailedError } from '../lib/errors';

export const command = 'undo';
export const description =
  'Undo the last local gt operation in this worktree, including branch tips, metadata, index, and working files. Remote changes are not undone.';
export const builder = {
  force: {
    type: 'boolean',
    default: false,
    alias: 'f',
    describe: 'Skip confirmation, but never overwrite newer local changes.',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'undo', async (context) => {
    const operation = latestOperation();
    if (!operation)
      throw new ExitFailedError(
        'No local gt operation to undo in this worktree.'
      );
    if (!argv.force) {
      if (!context.interactive)
        throw new ExitFailedError(
          'Use gt undo --force to confirm undo in non-interactive mode.'
        );
      const answer = await context.prompts({
        type: 'confirm',
        name: 'value',
        message: `Undo gt ${operation.command}? Remote changes will not be undone.`,
        initial: false,
      });
      if (!answer.value) return;
    }
    restoreOperation(operation, context);
  });
