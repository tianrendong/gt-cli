import { runGitCommand } from './runner';

export function pushBranch(opts: {
  remote: string;
  branchName: string;
  noVerify: boolean;
  forcePush: boolean;
  expectedRemoteRevision?: string;
}): void {
  const ref = `refs/heads/${opts.branchName}`;
  const expected =
    opts.expectedRemoteRevision ??
    runGitCommand({
      args: [
        'rev-parse',
        '--verify',
        `refs/remotes/${opts.remote}/${opts.branchName}`,
      ],
      onError: 'ignore',
      resource: 'pushLease',
    });
  runGitCommand({
    args: [
      'push',
      '-u',
      ...(opts.noVerify ? ['--no-verify'] : []),
      opts.forcePush ? '--force' : `--force-with-lease=${ref}:${expected}`,
      opts.remote,
      `${ref}:${ref}`,
    ],
    options: { stdio: 'pipe' },
    onError: 'throw',
    resource: 'pushBranch',
  });
}
