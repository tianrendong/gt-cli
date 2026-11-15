import chalk from 'chalk';
import { TContext } from '../../lib/context';
import { SCOPE } from '../../lib/engine/scope_spec';
import { ExitFailedError } from '../../lib/errors';
import { CommandFailedError } from '../../lib/git/runner';
import { TPRInfoToUpsert } from '../../lib/api/pr_info';
import { uncommittedTrackedChangesPrecondition } from '../../lib/preconditions';
import { restackBranches } from '../restack';
import { cleanBranches } from './clean_branches';
import { syncPrInfo } from '../sync_pr_info';
import { pullGitHubStacks } from './github_sync';
import { publishedBranches, updateBranchesFromRemote } from './update_branches';
import {
  branchesCheckedOutElsewhere,
  worktreeBusy,
} from '../../lib/git/worktrees';

export async function syncAction(
  opts: {
    pull: boolean;
    force: boolean;
    delete: boolean;
    showDeleteProgress: boolean;
    restack: boolean;
    deleteForce?: boolean;
    stackSync?: boolean;
  },
  context: TContext
): Promise<void> {
  uncommittedTrackedChangesPrecondition();
  // Pruning only needs the remote's ref list; overlap it with the GitHub PR
  // reads, which touch no remote-tracking refs. Await it before any fetch.
  const pruned = opts.pull ? context.engine.pruneRemote() : undefined;
  // Branches checked out in other worktrees are still synchronized: their
  // rewrites happen inside the owning worktree (or are reported as blocked).
  const { occupied, undeletable, busy } = worktreePlan(context);
  const prs = await syncPrInfo(context.engine.allBranchNames, context);
  await pruned;
  // GitHub just reported every open PR's head, so the one fetch needed can
  // start now and overlap the GitHub Stack reads, which use no Git refs.
  const fetching = opts.pull
    ? fetchRemote(context, busy, remoteHeadsFromPRs(prs))
    : undefined;
  fetching?.catch(() => undefined); // Reported when awaited below.
  if (
    opts.pull &&
    opts.stackSync !== false &&
    context.repoConfig.getIsGithubIntegrationEnabled()
  ) {
    await pullGitHubStacks(context, occupied);
  }

  let branchesToRestack: string[] = [];
  const fetched = fetching ? await fetching : undefined;
  if (fetched) {
    await pullTrunk(context, fetched.trunkRevision);
    context.splog.tip('You can skip pulling trunk with the `--no-pull` flag.');
    context.splog.newline();
  }

  let branchesWithNewParents: string[] = [];
  if (opts.delete) {
    branchesWithNewParents = await cleanBranches(
      {
        showDeleteProgress: opts.showDeleteProgress,
        showSection: true,
        force: opts.force || !!opts.deleteForce,
        protectedBranches: undeletable,
        // PR states were refreshed moments ago; an open PR is not merged.
        trustOpenPRs: context.repoConfig.getIsGithubIntegrationEnabled(),
      },
      context
    );
    context.splog.tip(cleanupTips(opts));
  }

  if (fetched) {
    // Same section order as native gt: fetch, clean up, then sync branches.
    (await syncBranches(fetched, busy, context)).forEach((branchName) =>
      context.engine
        .getRelativeStack(branchName, SCOPE.UPSTACK)
        .forEach((upstackBranchName) =>
          branchesToRestack.push(upstackBranchName)
        )
    );
  }

  if (!opts.restack) {
    if (!opts.delete)
      context.splog.tip(
        'Try the `--restack` flag to automatically restack the current stack.'
      );
    return;
  }

  branchesWithNewParents
    .flatMap((branchName) =>
      context.engine.getRelativeStack(branchName, SCOPE.UPSTACK)
    )
    .forEach((branchName) => branchesToRestack.push(branchName));

  const currentBranch = context.engine.currentBranch;

  // A trunk's stack already includes every branch that needs restacking.
  if (currentBranch && context.engine.isTrunk(currentBranch)) {
    branchesToRestack = context.engine.getRelativeStack(
      currentBranch,
      SCOPE.STACK
    );
  } else if (
    currentBranch &&
    context.engine.isBranchTracked(currentBranch) &&
    !branchesToRestack.includes(currentBranch)
  ) {
    context.engine
      .getRelativeStack(currentBranch, SCOPE.STACK)
      .forEach((branchName) => branchesToRestack.push(branchName));
  }

  const restackPlan = [...new Set(branchesToRestack)].filter(
    (branch) => !busy.has(branch)
  );
  if (restackPlan.some((branch) => !context.engine.isTrunk(branch)))
    context.splog.info('🥞 Restacking branches...');
  restackBranches(restackPlan, context, { failOnConflict: false });
}

function cleanupTips(opts: { force: boolean; restack: boolean }): string {
  return [
    'You can skip deleting branches with the `--no-delete` flag.',
    ...(opts.force
      ? []
      : [
          'Try the `--force` flag to delete merged branches without prompting for each.',
        ]),
    ...(opts.restack
      ? []
      : [
          'Try the `--restack` flag to automatically restack the current stack as well as any stacks with deleted branches.',
        ]),
  ].join('\n');
}

type FetchedRemote = {
  /** Remote revisions of every syncable published branch; changed ones are
   * already fetched into refs/remotes/<remote>/. */
  remoteHeads: Map<string, string>;
  published: string[];
  /** Remote trunk, fetched. */
  trunkRevision: string;
};

function remoteHeadsFromPRs(prs: TPRInfoToUpsert): Map<string, string> {
  return new Map(
    prs.flatMap((pr) =>
      pr.state === 'OPEN' && pr.headRefOid
        ? [[pr.headRefName, pr.headRefOid] as const]
        : []
    )
  );
}

/** One fetch covers trunk and every published branch whose remote head
 * differs from the local branch, so collaborator pushes to the stack arrive
 * with the trunk update. GitHub's PR heads replace a remote listing; only
 * branches it did not report are listed. */
async function fetchRemote(
  context: TContext,
  busy: ReadonlySet<string>,
  knownHeads: ReadonlyMap<string, string>
): Promise<FetchedRemote> {
  context.splog.info('🌲 Fetching branches from remote...');
  const trunk = context.engine.trunk;
  const published = publishedBranches(context);
  const syncable = published.filter((name) => !busy.has(name));
  const remoteHeads = new Map<string, string>();
  const unknown: string[] = [];
  for (const name of syncable) {
    const sha = knownHeads.get(name);
    if (sha) remoteHeads.set(name, sha);
    else unknown.push(name);
  }
  for (const [name, sha] of await context.engine.listRemoteHeads(unknown))
    remoteHeads.set(name, sha);
  const changed = () =>
    syncable.filter(
      (name) =>
        remoteHeads.has(name) &&
        remoteHeads.get(name) !== context.engine.getRevision(name)
    );
  let fetchedRevisions: Map<string, string>;
  try {
    fetchedRevisions = await context.engine.fetchRemoteBranches([
      trunk,
      ...changed(),
    ]);
  } catch (error) {
    if (
      !(error instanceof CommandFailedError) ||
      !/couldn't find remote ref/.test(error.message)
    )
      throw error;
    // A branch disappeared since GitHub reported it (e.g. merged and
    // deleted meanwhile). Fetch only what the remote still has.
    const existing = await context.engine.listRemoteHeads([
      trunk,
      ...changed(),
    ]);
    if (!existing.has(trunk))
      throw new ExitFailedError(
        `${context.repoConfig.getRemote()} has no branch ${trunk}.`
      );
    for (const name of syncable)
      if (!existing.has(name)) remoteHeads.delete(name);
    fetchedRevisions = await context.engine.fetchRemoteBranches([
      trunk,
      ...changed(),
    ]);
  }
  // The remote may have moved again since GitHub reported it; trust what arrived.
  for (const [name, sha] of fetchedRevisions)
    if (name !== trunk) remoteHeads.set(name, sha);
  return {
    remoteHeads,
    published,
    trunkRevision: fetchedRevisions.get(trunk) as string,
  };
}

/** Cleanup may have deleted some listed branches by now. Returns the updated ones. */
function syncBranches(
  fetched: FetchedRemote,
  busy: ReadonlySet<string>,
  context: TContext
): Promise<string[]> {
  const present = fetched.published.filter((name) =>
    context.engine.branchExists(name)
  );
  return updateBranchesFromRemote(
    present.filter((name) => !busy.has(name)),
    {
      force: false,
      printUnchanged: false,
      section: { skipped: present.filter((name) => busy.has(name)) },
      remoteHeads: fetched.remoteHeads,
    },
    context
  );
}

/** Branches checked out in other worktrees, and why each cannot be deleted
 * from here. A stack whose worktree is running another gt command is wholly
 * undeletable: deleting or re-parenting under that command would give it a
 * stale view. Idle worktrees only keep their own checked-out branch.
 * Reasons are clauses completing "... cannot be cleaned up while <reason>". */
function worktreePlan(context: TContext): {
  occupied: Set<string>;
  undeletable: Map<string, string>;
  busy: Set<string>;
} {
  const elsewhere = branchesCheckedOutElsewhere();
  const undeletable = new Map<string, string>();
  for (const [branch, directory] of elsewhere) {
    if (!context.engine.isBranchTracked(branch) || !worktreeBusy(directory))
      continue;
    context.splog.warn(
      `Leaving the stack of ${chalk.cyan(branch)} alone: ${chalk.cyan(
        branch
      )} is checked out at ${JSON.stringify(
        directory
      )}, where another gt command is running or the worktree is inaccessible. Retry when idle and accessible; restore missing worktrees or explicitly run git worktree prune if deleted.`
    );
    const root = context.engine.getRelativeStack(branch, SCOPE.DOWNSTACK)[0];
    for (const member of context.engine.getRelativeStack(root, SCOPE.UPSTACK))
      undeletable.set(
        member,
        `its stack is checked out in worktree ${directory}, which is busy or inaccessible`
      );
  }
  const busy = new Set(undeletable.keys());
  for (const branch of elsewhere.keys())
    if (!undeletable.has(branch))
      undeletable.set(branch, 'it is checked out in another worktree');
  return {
    occupied: new Set([...elsewhere.keys(), ...busy]),
    undeletable,
    busy,
  };
}

export async function pullTrunk(
  context: TContext,
  remoteRevision: string
): Promise<void> {
  const pullResult = context.engine.pullTrunk(remoteRevision);
  if (pullResult.result === 'PULL_BLOCKED') {
    context.splog.warn(
      `Fetched ${context.repoConfig.getRemote()}/${
        context.engine.trunk
      } but could not update ${chalk.blueBright(context.engine.trunk)}: ${
        pullResult.reason
      } Continuing with the current local ${context.engine.trunk}.`
    );
    return;
  }
  if (pullResult.result !== 'PULL_CONFLICT') {
    context.splog.info(
      pullResult.result === 'PULL_UNNEEDED'
        ? `${chalk.green(context.engine.trunk)} is up to date.`
        : `${chalk.green(context.engine.trunk)} fast-forwarded to ${chalk.gray(
            context.engine.getRevision(context.engine.trunk)
          )}.`
    );
    return;
  }

  // Like gt: if trunk cannot be fast-forwarded to match remote, overwrite
  // trunk with the remote version.
  context.splog.warn(
    `${chalk.blueBright(
      context.engine.trunk
    )} could not be fast-forwarded; resetting it to the remote version.`
  );
  const reset = context.engine.resetTrunkToRemote(remoteRevision);
  if (reset.result === 'RESET_BLOCKED') {
    context.splog.warn(
      `Could not reset ${chalk.blueBright(context.engine.trunk)}: ${
        reset.reason
      } Continuing with the current local ${context.engine.trunk}.`
    );
    return;
  }
  context.splog.info(
    `${chalk.green(context.engine.trunk)} set to ${chalk.gray(
      context.engine.getRevision(context.engine.trunk)
    )}.`
  );
}
