import { runAsyncGitCommand, runGitCommand } from './runner';

/**
 * The merge base of two commits, or undefined when they share no history.
 *
 * `git merge-base` exits 1 for disjoint histories: an orphan branch, a trunk
 * that was reset to unrelated history, or a recorded parent revision whose
 * commit is no longer reachable. That is a legitimate answer rather than a
 * failure. Metadata validation runs it for every tracked branch on every
 * command, so throwing here used to lock the whole repository out of gt,
 * including read-only commands and the commands needed to repair the branch.
 * Callers decide what a missing base means: "needs restack", "not a
 * descendant", "not merged", or an explicit error naming the branches.
 */
export function getMergeBase(left: string, right: string): string | undefined {
  return (
    runGitCommand({
      args: [`merge-base`, left, right],
      onError: 'ignore',
      resource: 'getMergeBase',
    }) || undefined
  );
}

export async function getMergeBaseAsync(
  left: string,
  right: string
): Promise<string | undefined> {
  return (
    (await runAsyncGitCommand({
      args: [`merge-base`, left, right],
      onError: 'ignore',
      resource: 'getMergeBase',
    })) || undefined
  );
}
