import yargs from 'yargs';
import { deleteBranchAction, isSafeToDelete } from '../actions/delete_branch';
import { GitHubClient } from '../lib/github/client';
import { cleanupDeletedGitHubStacks } from '../lib/github/stack_cleanup';
import { syncPrInfo } from '../actions/sync_pr_info';
import { ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';

const args = {
  name: {
    type: 'string',
    positional: true,
    demandOption: false,
    optional: true,
    describe: 'The name of the branch to delete.',
    hidden: true,
  },
  close: {
    describe:
      'Close associated pull requests on GitHub before deleting local branches.',
    type: 'boolean',
    default: false,
    alias: 'c',
  },
  'stack-sync': {
    describe:
      'Immediately remove deleted branches from native GitHub stacks. Defaults to on with --close, otherwise off; gt submit and gt sync apply the cleanup.',
    type: 'boolean',
  },
  downstack: {
    describe: 'Also delete ancestors, excluding trunks.',
    type: 'boolean',
    default: false,
  },
  force: {
    describe: 'Delete the branch even if it is not merged or closed.',
    type: 'boolean',
    alias: 'f',
    default: false,
  },
  upstack: {
    describe: 'Also delete descendants.',
    type: 'boolean',
    default: false,
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'delete [name]';
export const canonical = 'delete';
export const description =
  'Delete a branch and its corresponding Graphite metadata.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const branchName = argv.name ?? context.engine.currentBranchPrecondition;
    const branches = context.engine
      .getRelativeStack(branchName, {
        currentBranch: true,
        recursiveParents: argv.downstack,
        recursiveChildren: argv.upstack,
      })
      .filter((b) => !context.engine.isTrunk(b))
      .reverse();
    if (!branches.length) throw new ExitFailedError('Cannot delete trunk!');
    if (argv.close) await syncPrInfo(branches, context);
    for (const branch of branches) {
      context.engine.assertBranchMutable(branch);
      if (
        !argv.force &&
        !isSafeToDelete(branch, context).result &&
        !(argv.close && context.engine.getPrInfo(branch)?.number)
      ) {
        throw new ExitFailedError(
          `${branch} is neither merged nor closed. Use --force to delete it. No branches were deleted.`
        );
      }
    }
    const client = argv.close
      ? GitHubClient.fromConfig(context.repoConfig)
      : undefined;
    const deleted: string[] = [];
    for (const branch of branches) {
      const pr = context.engine.getPrInfo(branch);
      if (client && pr?.number && pr.state === 'OPEN') {
        try {
          client.pr(['close', String(pr.number)]);
        } catch (error) {
          if (!(error instanceof ExitFailedError)) throw error;
          throw new ExitFailedError(
            `Failed to close PR #${pr.number} for ${branch}; ${branch} was not deleted.` +
              (deleted.length
                ? ` Already deleted locally: ${deleted.join(', ')}.`
                : '') +
              `\n${error.message}`
          );
        }
        context.engine.upsertPrInfo(branch, { state: 'CLOSED' });
      }
      deleteBranchAction({ branchName: branch, force: argv.force }, context);
      deleted.push(branch);
    }
    if (argv['stack-sync'] ?? argv.close)
      await cleanupDeletedGitHubStacks(context);
  });
