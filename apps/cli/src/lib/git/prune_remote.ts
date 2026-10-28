import { runAsyncGitCommand, runGitCommand } from './runner';

export function pruneRemote(remote: string): void {
  runGitCommand({
    args: [`remote`, `prune`, remote],
    onError: 'ignore',
    resource: 'pruneRemote',
  });
}

/** Pruning needs the remote's full ref advertisement, which is slow on
 * repositories with many branches. Run it while other work proceeds; await
 * it before any fetch so the two never contend for ref locks. */
export function pruneRemoteAsync(remote: string): Promise<void> {
  return runAsyncGitCommand({
    args: [`remote`, `prune`, remote],
    onError: 'ignore',
    resource: 'pruneRemote',
  }).then(() => undefined);
}
