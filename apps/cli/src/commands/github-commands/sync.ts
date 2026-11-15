import yargs from 'yargs';
import { graphite } from '../../lib/runner';
import { projectStacks } from '../../lib/github/local_stacks';
import {
  githubStackAPI,
  listRemoteStacks,
  closedPRNumbers,
  planStackSync,
  syncSubmittedStacks,
} from '../../lib/github/stack_sync';
import { syncPrInfo } from '../../actions/sync_pr_info';
import { ExitFailedError } from '../../lib/errors';
import { cleanupGitHubStacks } from '../../lib/github/stack_cleanup';

export const command = 'sync';
export const description =
  'Repair native GitHub Stack membership for already submitted PRs. Never pushes Git branches or creates PRs.';
export const builder = {
  'dry-run': {
    type: 'boolean',
    default: false,
    describe: 'Show API changes without applying them.',
  },
  source: {
    type: 'string',
    choices: ['local'],
    describe:
      'Explicitly replace diverged GitHub stacks with local topology; preserves PRs and Git branches.',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'github sync', async (context) => {
    const store = context.githubStacks;
    if (!store) throw new ExitFailedError('No metadata session.');
    const branches = context.engine.allBranchNames.filter((b) =>
      context.engine.isBranchTracked(b)
    );
    await syncPrInfo(branches, context);
    const remote = await cleanupGitHubStacks(context, {
      remote: await listRemoteStacks(githubStackAPI(context)),
      dryRun: argv['dry-run'],
    });
    for (const branch of branches) {
      const pr = context.engine.getPrInfo(branch);
      if (
        pr?.state === 'OPEN' &&
        (pr.base !== context.engine.getParentPrecondition(branch) ||
          ['CLOSED', 'MERGED'].includes(
            context.engine.getPrInfo(pr.base)?.state ?? ''
          ))
      ) {
        throw new ExitFailedError(
          `${branch}'s PR base is stale. Delete completed parent branches with gt delete, then run gt submit --stack to update PRs before linking stacks.`
        );
      }
    }
    const plans = planStackSync({
      local: projectStacks(context.engine, store.file.stacks),
      remote,
      state: store.state,
      preferLocal: argv.source === 'local',
      closedPRs: closedPRNumbers(context),
    });
    plans.forEach((p) =>
      context.splog.info(
        `${p.action}: ${p.local.branches.map((b) => b.branch).join(' -> ')}`
      )
    );
    if (!argv['dry-run'])
      await syncSubmittedStacks(context, branches, argv.source === 'local');
  });
