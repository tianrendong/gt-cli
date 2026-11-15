import chalk from 'chalk';
import os from 'os';
import { TContext } from '../../lib/context';
import { runAsyncGitCommand, runGitCommand } from '../../lib/git/runner';
import {
  branchesCheckedOutElsewhere,
  moveCheckedOutBranch,
} from '../../lib/git/worktrees';
import { mapWithConcurrency } from '../../lib/utils/map_with_concurrency';

function git(args: string[], input?: string): string {
  return runGitCommand({
    args,
    options: { input },
    onError: 'throw',
    resource: 'updateBranchesFromRemote',
  });
}

/** Rebased commits have new IDs but the same patches. Count every remote-only
 * commit as well: git cherry omits merges, whose resolutions may differ. */
function remotePatchesAreLocal(
  local: string,
  target: string,
  behind: number
): boolean {
  const commits = git(['cherry', local, target]).split('\n').filter(Boolean);
  return (
    commits.length === behind && commits.every((line) => line.startsWith('- '))
  );
}

/** How many ahead/behind counts run at once. Each is a short, CPU-bound
 * history walk (slow in shallow clones, where git ignores the commit-graph).
 * Use at most half the cores, and no more than 4, which already captures most
 * of the speedup while leaving room for other work. GT_SYNC_CONCURRENCY
 * overrides this; 1 runs the counts one after another. */
export function syncConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.GT_SYNC_CONCURRENCY);
  if (env.GT_SYNC_CONCURRENCY && Number.isInteger(override) && override >= 1)
    return Math.min(override, 64);
  const cores =
    (os as { availableParallelism?: () => number }).availableParallelism?.() ??
    os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/** [ahead, behind] of `local` relative to `target`, for each pair. Counts
 * depend only on commit IDs, so they may run concurrently and ahead of any
 * ref updates. Rejects, after every started count settles, if any fails. */
function countDivergence(
  pairs: { local: string; target: string }[]
): Promise<[number, number][]> {
  return mapWithConcurrency(pairs, syncConcurrency(), async (pair) => {
    const output = await runAsyncGitCommand({
      args: [
        'rev-list',
        '--left-right',
        '--count',
        `${pair.local}...${pair.target}`,
      ],
      onError: 'throw',
      resource: 'updateBranchesFromRemote',
    });
    const [ahead, behind] = output.split(/\s+/).map(Number);
    return [ahead, behind];
  });
}

/** Tracked non-trunk branches with an open PR: the ones sync compares with
 * the remote. Merged and closed PRs are cleanup candidates instead. */
export function publishedBranches(context: TContext): string[] {
  return context.engine.allBranchNames.filter((name) => {
    if (context.engine.isTrunk(name) || !context.engine.isBranchTracked(name))
      return false;
    const pr = context.engine.getPrInfo(name);
    return !!pr?.number && pr.state !== 'MERGED' && pr.state !== 'CLOSED';
  });
}

/** Fast-forward local branches to their remote counterparts, like gt sync.
 * Diverged branches are only overwritten with force; otherwise they are
 * reported and skipped. Frozen branches may still receive remote updates.
 */
// eslint-disable-next-line max-lines-per-function
export async function updateBranchesFromRemote(
  branchNames: string[],
  args: {
    force: boolean;
    /** Explain branches that stay local-only (gt get). */
    printUnchanged?: boolean;
    /** Print the native-style "Syncing branches" section, listing these
     * branches as skipped first. */
    section?: { skipped: string[] };
    /** Remote revisions already listed, with changed branches already
     * fetched into refs/remotes/<remote>/. Omit to list and fetch here. */
    remoteHeads?: Map<string, string>;
  },
  context: TContext
): Promise<string[]> {
  // Sync visits every published branch. Local-only changes are routine, not
  // warnings; retain the per-branch explanation in --debug instead.
  const logUnchanged =
    args.printUnchanged === false ? context.splog.debug : context.splog.info;
  const remote = context.repoConfig.getRemote();
  const names = branchNames.filter(
    (name) =>
      !context.engine.isTrunk(name) && context.engine.isBranchTracked(name)
  );
  let sectionOpen = false;
  const sectionLine = (line: string) => {
    if (!args.section) return;
    if (!sectionOpen) {
      context.splog.info('🔄 Syncing branches...');
      sectionOpen = true;
    }
    context.splog.info(line);
  };
  const finish = (updated: string[]): string[] => {
    if (sectionOpen) context.splog.newline();
    return updated;
  };
  for (const name of args.section?.skipped ?? [])
    sectionLine(
      `Skipped syncing branch ${chalk.cyan(
        name
      )} because it is checked out in another worktree.`
    );
  if (!names.length) return finish([]);
  const prLabel = (name: string) => {
    const number = context.engine.getPrInfo(name)?.number;
    return number ? ` (PR #${number})` : '';
  };
  let remoteShas: Map<string, string>;
  if (args.remoteHeads) {
    remoteShas = args.remoteHeads;
  } else {
    const listing = git(['ls-remote', '--heads', remote, ...names]);
    remoteShas = new Map(
      listing
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
        .map(([sha, ref]) => [ref.replace('refs/heads/', ''), sha])
    );
  }
  const candidates: string[] = [];
  for (const name of names) {
    const sha = remoteShas.get(name);
    if (sha === undefined) continue; // Deleted remotely, e.g. after a merge.
    if (sha === context.engine.getRevision(name)) {
      sectionLine(
        `Branch ${chalk.cyan(name)} is up to date with remote${prLabel(name)}.`
      );
      continue;
    }
    candidates.push(name);
  }
  if (!candidates.length) return finish([]);
  if (!args.remoteHeads) {
    git([
      'fetch',
      '--no-tags',
      remote,
      ...candidates.map(
        (name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`
      ),
    ]);
  }
  const currentBranch = context.engine.currentBranch;
  const elsewhere = branchesCheckedOutElsewhere();
  const pairs = candidates.map((name) => ({
    name,
    local: context.engine.getRevision(name),
    target: remoteShas.get(name) as string,
  }));
  // Count each side independently: a local-only commit is not divergence,
  // and an amend/rebase need not mean the published remote changed at all.
  // All counts finish (or one fails) before any branch below is changed.
  const counts = await countDivergence(pairs);
  const updated: string[] = [];
  for (const [index, { name, local, target }] of pairs.entries()) {
    const [ahead, behind] = counts[index];
    const fastForward = ahead === 0;
    if (!fastForward && !args.force) {
      if (behind === 0) {
        logUnchanged(
          `${name} is ahead of ${remote}/${name}; keeping local commits.`
        );
      } else if (target === context.engine.getPublishedRevision(name)) {
        logUnchanged(
          `${name} has unpublished local changes; ${remote}/${name} is unchanged since the last submit. Keeping local branch.`
        );
      } else if (remotePatchesAreLocal(local, target, behind)) {
        context.splog.info(
          `${name} is ahead of ${remote}/${name} (restacked locally); run gt submit to update.`
        );
      } else {
        context.splog.warn(
          `${chalk.yellow(
            name
          )} has diverged from ${remote}/${name}; leaving your local branch in place. Inspect both histories before reconciling.`
        );
      }
      continue;
    }
    if (name === currentBranch) {
      // The caller has verified there are no uncommitted tracked changes.
      git(['reset', '--hard', target]);
    } else if (elsewhere.has(name)) {
      // Move the other worktree's checkout with the branch so its files
      // follow; git refuses rather than disturb local changes there.
      const moved = moveCheckedOutBranch({
        branch: name,
        directory: elsewhere.get(name) as string,
        sha: target,
        expectedSha: local,
        mode: fastForward ? 'fast-forward' : 'rewrite',
      });
      if (!moved.moved) {
        context.splog.warn(
          `Could not update ${chalk.yellow(name)} from ${remote}/${name}: ${
            moved.reason
          }`
        );
        continue;
      }
    } else {
      git(['update-ref', `refs/heads/${name}`, target, local]);
    }
    updated.push(name);
    const message = args.section
      ? `Branch ${chalk.cyan(name)} ${
          fastForward ? 'fast-forwarded' : 'reset'
        } to remote${prLabel(name)}.`
      : `${chalk.cyan(name)} ${
          fastForward ? 'fast-forwarded' : 'reset'
        } to ${remote}/${name}.`;
    if (args.section) sectionLine(message);
    else context.splog.info(message);
  }
  if (updated.length) {
    context.engine.rebuild();
    updated.forEach((name) => {
      if (context.engine.getPrInfo(name)) {
        const headSha = remoteShas.get(name) as string;
        const baseName = context.engine.getParentPrecondition(name);
        context.engine.upsertPrInfo(name, { remoteRevision: headSha });
        context.engine.recordPublishedVersion(name, {
          headSha,
          baseSha: git(['merge-base', headSha, baseName]),
          baseName,
        });
      }
    });
  }
  return finish(updated);
}
