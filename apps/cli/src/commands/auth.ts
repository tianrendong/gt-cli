import yargs from 'yargs';
import { spawnSync } from 'child_process';
import { graphiteWithoutRepo } from '../lib/runner';
import { ExitFailedError } from '../lib/errors';
import { runGh } from '../lib/github/client';

export const command = 'auth';
export const canonical = 'auth';
export const description =
  'Authenticate using GitHub CLI credentials; no Graphite account or token is used.';
export const builder = {
  token: {
    type: 'string',
    alias: 't',
    describe:
      'GitHub token (prefer GH_TOKEN in automation). Passed to gh on stdin, never persisted by gt.',
  },
  hostname: { type: 'string', default: process.env.GH_HOST || 'github.com' },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphiteWithoutRepo(argv, canonical, async (context) => {
    if (argv.token) {
      runGh(
        ['auth', 'login', '--hostname', argv.hostname, '--with-token'],
        argv.token + '\n'
      );
    } else if (!getGithubAuthorizationStatus(argv.hostname)) {
      if (!context.interactive)
        throw new ExitFailedError(
          `Authenticate with gh auth login --hostname ${argv.hostname}, or set GH_TOKEN/GH_ENTERPRISE_TOKEN.`
        );
      const result = spawnSync(
        'gh',
        ['auth', 'login', '--hostname', argv.hostname],
        { stdio: 'inherit' }
      );
      if (result.status !== 0)
        throw new ExitFailedError('GitHub authentication failed.');
    }
    context.splog.info(`Authenticated with GitHub (${argv.hostname}).`);
  });

export function getGithubAuthorizationStatus(hostname?: string): boolean {
  const result = spawnSync(
    'gh',
    ['auth', 'status', ...(hostname ? ['--hostname', hostname] : [])],
    { stdio: 'ignore', timeout: 30_000 }
  );
  return !result.error && result.status === 0;
}
