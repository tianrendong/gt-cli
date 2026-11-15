import {
  CommandFailedError,
  runAsyncGitCommand,
  runGitCommand,
} from './runner';

/** Update refs/remotes/<remote>/<branch> for each branch in one round trip,
 * without touching any checkout. Every branch must exist on the remote. */
export async function fetchRemoteBranches(
  remote: string,
  branchNames: string[]
): Promise<void> {
  if (!branchNames.length) return;
  await runAsyncGitCommand({
    args: [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      ...branchNames.map(
        (branchName) =>
          `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`
      ),
    ],
    onError: 'throw',
    resource: 'fetchRemoteBranches',
  });
}

/** Remote-tracking revisions after fetchRemoteBranches, in one process. */
export function remoteTrackingRevisions(
  remote: string,
  branchNames: string[]
): Map<string, string> {
  if (!branchNames.length) return new Map();
  const lines = runGitCommand({
    args: [
      'rev-parse',
      ...branchNames.map(
        (branchName) => `refs/remotes/${remote}/${branchName}^{commit}`
      ),
    ],
    onError: 'throw',
    resource: 'remoteTrackingRevisions',
  }).split('\n');
  if (lines.length !== branchNames.length)
    throw new Error('Unexpected rev-parse output for remote-tracking refs.');
  return new Map(branchNames.map((branchName, i) => [branchName, lines[i]]));
}

/** Local branches whose tips are reachable from `revision` (ancestors of it,
 * including branches pointing at it), in one ref scan. */
export function branchesMergedInto(revision: string): string[] {
  return localBranchesFilteredBy(`--merged=${revision}`, 'branchesMergedInto');
}

/** Local branches whose tips can reach `revision` (descendants of it,
 * including branches pointing at it), in one ref scan. */
export function branchesContaining(revision: string): string[] {
  return localBranchesFilteredBy(
    `--contains=${revision}`,
    'branchesContaining'
  );
}

function localBranchesFilteredBy(filter: string, resource: string): string[] {
  // Same naming as getBranchesAndMetadata (refname:short, e.g. `heads/b` when
  // a tag `b` exists) so results line up with the engine's branch cache keys.
  return runGitCommand({
    args: ['for-each-ref', filter, '--format=%(refname:short)', 'refs/heads/'],
    onError: 'throw',
    resource,
  })
    .split('\n')
    .filter((name) => name.length > 0);
}

export function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    runGitCommand({
      args: ['merge-base', '--is-ancestor', ancestor, descendant],
      options: { stdio: 'pipe' },
      onError: 'throw',
      resource: 'isAncestor',
    });
    return true;
  } catch (error) {
    if (error instanceof CommandFailedError) return false;
    throw error;
  }
}

/** Compare-and-swap ref update; false when the ref moved meanwhile. */
export function updateRef(ref: string, sha: string, expected: string): boolean {
  try {
    runGitCommand({
      args: ['update-ref', ref, sha, expected],
      options: { stdio: 'pipe' },
      onError: 'throw',
      resource: 'updateRef',
    });
    return true;
  } catch (error) {
    if (error instanceof CommandFailedError) return false;
    throw error;
  }
}

/** Fast-forward the current branch of THIS worktree, files included. */
export function mergeFastForward(sha: string): void {
  runGitCommand({
    args: ['merge', '--ff-only', '--no-edit', sha],
    options: { stdio: 'pipe' },
    onError: 'throw',
    resource: 'mergeFastForward',
  });
}

/** Remote heads for explicit branch names: branch -> revision, omitting
 * branches the remote no longer has. One round trip, no ref changes. */
export async function listRemoteHeads(
  remote: string,
  branchNames: string[]
): Promise<Map<string, string>> {
  if (!branchNames.length) return new Map();
  const listing = await runAsyncGitCommand({
    args: ['ls-remote', '--heads', remote, ...branchNames],
    onError: 'throw',
    resource: 'listRemoteHeads',
  });
  return new Map(
    listing
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter((fields) => fields.length === 2)
      .map(([sha, ref]) => [ref.replace('refs/heads/', ''), sha])
  );
}
