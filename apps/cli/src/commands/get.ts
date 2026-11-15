import yargs from 'yargs';
import { getAction } from '../actions/sync/get';
import { graphite } from '../lib/runner';

const args = {
  'stack-sync': {
    describe:
      'Discover native GitHub stacks. --no-stack-sync follows PR base branches instead.',
    type: 'boolean',
    default: true,
  },
  branch: {
    describe: 'Branch or PR number to get from remote.',
    demandOption: false,
    type: 'string',
    positional: true,
    hidden: true,
  },
  checkout: {
    describe: 'Check out the target branch after fetching.',
    type: 'boolean',
    default: true,
  },
  'delete-all': {
    describe: 'Delete merged or closed local branches after fetching.',
    type: 'boolean',
    default: false,
  },
  downstack: {
    describe: `Fetch only ancestors through the target branch.`,
    type: 'boolean',
    default: false,
    alias: 'd',
  },
  force: {
    describe: 'Overwrite all fetched branches with remote source of truth.',
    type: 'boolean',
    default: false,
    alias: 'f',
  },
  restack: {
    describe: 'Restack fetched branches and their local descendants.',
    type: 'boolean',
    default: true,
  },
  unfrozen: {
    describe:
      'Unfreeze fetched branches. Existing freeze settings are otherwise preserved.',
    type: 'boolean',
    default: false,
    alias: 'U',
  },
  'remote-upstack': {
    describe:
      'Fetch upstack PRs too, including forks across native GitHub stacks.',
    type: 'boolean',
    default: false,
    alias: 'u',
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'get [branch]';
export const canonical = 'get';
export const description =
  'Sync branches from trunk to the given branch from remote.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) =>
    getAction(
      {
        branchName: argv.branch,
        force: argv.force,
        checkout: argv.checkout,
        restack: argv.restack,
        downstack: argv.downstack,
        remoteUpstack: argv['remote-upstack'],
        stackSync: argv['stack-sync'],
        unfrozen: argv.unfrozen,
        deleteAll:
          argv['delete-all'] ||
          context.userConfig.data.cleanupDeleteMerged === true,
      },
      context
    )
  );
