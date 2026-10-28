import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { GitHubClient } from '../lib/github/client';
import {
  githubStackAPI,
  listRemoteStacks,
  activePRs,
} from '../lib/github/stack_sync';
import { ExitFailedError } from '../lib/errors';

export const command = 'pr [branch]';
export const description =
  'Open a GitHub PR, or its bottom PR with the native Stack view. Prints the URL in non-interactive mode.';
export const builder = {
  branch: { type: 'string', positional: true },
  stack: {
    type: 'boolean',
    default: false,
    describe: 'Open the bottom PR of the native GitHub stack.',
  },
  web: {
    type: 'boolean',
    default: true,
    describe:
      'Open a browser in interactive mode; --no-web only prints the URL.',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'pr', async (context) => {
    const client = GitHubClient.fromConfig(context.repoConfig);
    let pr = client.viewPR(
      argv.branch ?? context.engine.currentBranchPrecondition
    );
    if (!pr)
      throw new ExitFailedError('No pull request found. Run gt submit first.');
    if (argv.stack) {
      const stack = (await listRemoteStacks(githubStackAPI(context))).find(
        (s) => s.pull_requests.some((p) => p.number === pr?.number)
      );
      const bottom = stack && activePRs(stack)[0];
      if (bottom) pr = client.viewPR(bottom.number) ?? pr;
    }
    if (argv.web && context.interactive)
      client.pr(['view', String(pr.number), '--web']);
    else context.splog.info(pr.url);
  });
