import yargs from 'yargs';
import { syncAction } from '../actions/sync/sync';
import { graphite } from '../lib/runner';

const args = {
  'stack-sync': {
    describe:
      'Reconcile native GitHub Stack topology before syncing Git branches.',
    type: 'boolean',
    default: true,
  },
  all: {
    describe: 'Sync every configured trunk and its stacks.',
    type: 'boolean',
    default: false,
    alias: 'a',
  },
  'delete-all': {
    describe:
      'Delete all merged or closed branches during sync without prompting.',
    type: 'boolean',
    default: false,
    alias: 'd',
  },
  force: {
    describe: `Don't prompt for confirmation before overwriting or deleting a branch.`,
    type: 'boolean',
    default: false,
    alias: 'f',
  },
  restack: {
    describe: 'Restack branches that can be restacked without conflicts.',
    type: 'boolean',
    default: true,
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'sync';
export const canonical = 'sync';
export const description =
  'Sync all branches with remote, delete merged branches, and restack where possible.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const original = context.engine.currentBranch;
    const trunks = argv.all ? context.engine.trunks : [context.engine.trunk];
    for (const trunk of trunks) {
      if (argv.all) context.engine.checkoutBranch(trunk);
      await syncAction(
        {
          pull: true,
          force: argv.force,
          deleteForce:
            argv['delete-all'] ||
            context.userConfig.data.cleanupDeleteMerged === true,
          stackSync: argv['stack-sync'],
          delete: true,
          showDeleteProgress: false,
          restack: argv.restack,
        },
        context
      );
    }
    if (argv.all && original && context.engine.branchExists(original))
      context.engine.checkoutBranch(original);
  });
