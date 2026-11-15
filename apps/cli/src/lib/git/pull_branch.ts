import { CommandFailedError, runGitCommand } from './runner';

/**
 * Returns OK if the branch was fast-forwarded successfully
 * Returns CONFLICT if it could not be fast-forwarded
 */
export function pullBranch(
  remote: string,
  branchName: string
): 'OK' | 'CONFLICT' {
  try {
    runGitCommand({
      args: [`pull`, `--ff-only`, remote, branchName],
      options: { stdio: 'pipe' },
      onError: 'throw',
      resource: 'pullBranch',
    });
    return 'OK';
  } catch (e: unknown) {
    if (
      e instanceof CommandFailedError &&
      e.message.includes('fatal: Not possible to fast-forward, aborting.')
    ) {
      return 'CONFLICT';
    }
    throw e;
  }
}
