import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { ExitFailedError } from '../lib/errors';
import { deleteMetadataRef } from '../lib/engine/metadata_ref';

export const command = 'trunk';
export const description =
  'Show the current stack trunk, list configured trunks, or add another trunk.';
export const builder = {
  add: {
    describe: 'Register an existing local branch as an additional trunk.',
    type: 'string',
  },
  all: {
    describe: 'Show every configured trunk.',
    type: 'boolean',
    default: false,
    alias: 'a',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, argv.add ? 'trunk add' : 'trunk', async (context) => {
    if (argv.add) {
      if (!context.engine.branchExists(argv.add))
        throw new ExitFailedError(
          `No local branch ${argv.add}. Fetch it first.`
        );
      context.engine.assertBranchMutable(argv.add);
      context.repoConfig.update((data) => {
        data.additionalTrunks = [
          ...new Set([...(data.additionalTrunks ?? []), argv.add as string]),
        ].filter((b) => b !== data.trunk);
      });
      deleteMetadataRef(argv.add);
      context.engine.rebuild(
        undefined,
        context.repoConfig.data.additionalTrunks
      );
    }
    context.splog.info(
      argv.all ? context.engine.trunks.join('\n') : context.engine.trunk
    );
  });
