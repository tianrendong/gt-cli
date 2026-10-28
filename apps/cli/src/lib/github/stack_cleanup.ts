import { TContext } from '../context';
import { ExitFailedError } from '../errors';
import { GitHubClient, GitHubError, GitHubPR } from './client';
import {
  exportLocalStacks,
  projectStacks,
  removedPullRequests,
} from './local_stacks';
import { RemoteStack, StackAPI } from './stack_api';
import { MirrorState, StackStore } from './stack_file';

type Cleanup = NonNullable<MirrorState['pendingStackCleanups']>[string];
type CleanupOptions = {
  remote?: RemoteStack[];
  branches?: ReadonlySet<string>;
  deletedOnly?: boolean;
  protectedBranches?: ReadonlySet<string>;
  dryRun?: boolean;
};

function planCleanup(
  context: TContext,
  remote: RemoteStack[],
  opts: CleanupOptions
): Map<number, Cleanup> {
  const store = context.githubStacks as StackStore;
  const removed = new Set(removedPullRequests(context.engine, store));
  const allLocal = [
    ...store.file.stacks,
    ...projectStacks(context.engine, store.file.stacks),
  ];
  const local = allLocal.filter(
    (s) =>
      !opts.branches || s.branches.some((b) => opts.branches?.has(b.branch))
  );
  const knownPRs = new Set(
    local.flatMap((s) =>
      s.branches.flatMap((b) => (b.pullRequest ? [b.pullRequest.number] : []))
    )
  );
  const knownStacks = new Set(local.map((s) => s.number));
  const plans = new Map(
    Object.entries(store.state.pendingStackCleanups ?? {}).map(([n, p]) => [
      Number(n),
      p,
    ])
  );
  for (const stack of remote) {
    const deleted = stack.pull_requests.some((pr) => removed.has(pr.number));
    const known =
      deleted ||
      (!opts.deletedOnly &&
        (knownStacks.has(stack.number) ||
          (!opts.branches && !!store.state.remote[String(stack.number)]) ||
          stack.pull_requests.some((pr) => knownPRs.has(pr.number))));
    if (
      !known ||
      plans.has(stack.number) ||
      !stack.pull_requests.some(
        (pr) =>
          !pr.merged_at && (pr.state === 'closed' || removed.has(pr.number))
      )
    )
      continue;
    plans.set(stack.number, {
      base: stack.base.ref,
      prs: stack.pull_requests.map((pr) => pr.number),
      keep: stack.pull_requests
        .filter(
          (pr) =>
            !pr.merged_at && pr.state === 'open' && !removed.has(pr.number)
        )
        .map((pr) => pr.number),
    });
  }
  for (const stack of remote) {
    if (
      stack.pull_requests.some((pr) => opts.protectedBranches?.has(pr.head.ref))
    )
      plans.delete(stack.number);
  }
  // A pending rebuild may have already dissolved its old object.
  for (const [number, plan] of plans) {
    if (
      allLocal.some((s) =>
        s.branches.some(
          (b) =>
            opts.protectedBranches?.has(b.branch) &&
            b.pullRequest &&
            plan.prs.includes(b.pullRequest.number)
        )
      )
    )
      plans.delete(number);
  }
  return plans;
}

/** Remove obsolete membership, not PRs, refs, or PR bases. Never infer deletion
 * from a remote-only branch being absent locally. GitHub has no per-PR remove
 * endpoint, so journal the survivors before dissolving/rebuilding their chains.
 */
export async function cleanupGitHubStacks(
  context: TContext,
  opts: CleanupOptions = {}
): Promise<RemoteStack[]> {
  const store = context.githubStacks;
  if (!store || !context.repoConfig.getIsGithubIntegrationEnabled())
    return opts.remote ?? [];
  const removed = removedPullRequests(context.engine, store);
  const pending = Object.keys(store.state.pendingStackCleanups ?? {}).length;
  const known =
    Object.keys(store.state.remote).length > 0 ||
    store.file.stacks.some(
      (s) => s.number || s.branches.some((b) => b.pullRequest)
    );
  if (!removed.length && !pending && (opts.deletedOnly || !known))
    return opts.remote ?? [];
  const api = new StackAPI(GitHubClient.fromConfig(context.repoConfig));
  let remote = opts.remote ?? (await api.list());
  const plans = planCleanup(context, remote, opts);
  for (const [number, plan] of plans) {
    context.splog.info(
      `GitHub stack #${number}: prune obsolete PRs; preserve [${plan.keep.join(
        ', '
      )}].`
    );
  }
  if (opts.dryRun) return remote;
  // Submit may only have refreshed a downstack subset. Keep cached states in
  // affected local branches current so removed closed PRs cannot be re-added.
  for (const stack of remote.filter((s) => plans.has(s.number))) {
    for (const pr of stack.pull_requests) {
      if (
        context.engine.branchExists(pr.head.ref) &&
        context.engine.getPrInfo(pr.head.ref)?.number === pr.number
      ) {
        context.engine.upsertPrInfo(pr.head.ref, {
          state: pr.merged_at
            ? 'MERGED'
            : pr.state === 'open'
            ? 'OPEN'
            : 'CLOSED',
        });
      }
    }
  }
  exportLocalStacks(context, store);
  const releases = claimCleanups(plans, store, context);
  try {
    if (plans.size) {
      store.state.pendingStackCleanups = {
        ...store.state.pendingStackCleanups,
        ...Object.fromEntries(plans),
      };
      store.save();
    }
    for (const [number, plan] of plans) {
      remote = applyCleanup({ number, plan, remote, removed }, api, store);
      context.splog.info(`GitHub stack #${number}: obsolete PRs removed.`);
    }
  } finally {
    releases.forEach((release) => release());
  }
  // A deletion is complete even if another writer already removed membership.
  store.state.removedPullRequests = removed.filter((number) =>
    remote.some((s) =>
      s.pull_requests.some((pr) => pr.number === number && !pr.merged_at)
    )
  );
  store.save();
  return remote;
}

/** Cleanup journals are repository-wide, so another worktree may be replaying
 * the same one right now, or may have finished it since this process loaded
 * it. Claim each stack without waiting; skip any held elsewhere. After the
 * claim, the journal on disk is authoritative: it is write-ahead and may list
 * survivors that are no longer in the GitHub stack. */
function claimCleanups(
  plans: Map<number, Cleanup>,
  store: StackStore,
  context: TContext
): (() => void)[] {
  const releases: (() => void)[] = [];
  for (const number of [...plans.keys()]) {
    const release = store.claimStackCleanup(number);
    if (!release) {
      plans.delete(number);
      context.splog.info(
        `GitHub stack #${number}: cleanup is already running in another gt process (possibly another worktree). Skipping it here; it will be checked again on the next gt submit or gt sync.`
      );
      continue;
    }
    releases.push(release);
    const key = String(number);
    const onDisk = store.pendingCleanupOnDisk(number);
    if (onDisk) {
      plans.set(number, onDisk);
      store.state.pendingStackCleanups = {
        ...store.state.pendingStackCleanups,
        [key]: onDisk,
      };
    } else if (store.state.pendingStackCleanups?.[key]) {
      // Finished elsewhere after this process loaded it: never replay.
      delete store.state.pendingStackCleanups[key];
      plans.delete(number);
    }
  }
  return releases;
}

/** Post-mutation cleanup for local commands (delete/fold). The local change is
 * already committed and deletion intent is journaled, so a GitHub failure must
 * not fail the command: `gt submit` and `gt sync` retry the cleanup.
 */
export async function cleanupDeletedGitHubStacks(
  context: TContext
): Promise<void> {
  try {
    await cleanupGitHubStacks(context, { deletedOnly: true });
  } catch (error) {
    if (!(error instanceof ExitFailedError)) throw error;
    context.splog.warn(
      `Local changes are complete, but GitHub stack cleanup failed: ${error.message}\n` +
        'It will be retried on the next gt submit or gt sync.'
    );
  }
}

function readStack(api: StackAPI, number: number): RemoteStack | undefined {
  try {
    return api.get(number);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}

function assertCleanupLease(
  current: RemoteStack,
  plan: Cleanup,
  removed: number[]
): void {
  // A failed unstack can leave a subset locked. Retry that subset, but never
  // dissolve an independently extended/reordered stack or a reopened member.
  const numbers = current.pull_requests.map((pr) => pr.number);
  if (
    current.base.ref !== plan.base ||
    JSON.stringify(numbers) !==
      JSON.stringify(plan.prs.filter((n) => numbers.includes(n))) ||
    current.pull_requests.some(
      (pr) =>
        pr.state === 'open' &&
        !pr.merged_at &&
        !plan.keep.includes(pr.number) &&
        !removed.includes(pr.number)
    )
  ) {
    throw new ExitFailedError(
      `GitHub stack #${current.number} changed during cleanup. Refusing to overwrite remote topology.`
    );
  }
}

function survivorChains(plan: Cleanup, api: StackAPI): GitHubPR[][] {
  const chains: GitHubPR[][] = [];
  for (const number of plan.keep) {
    const pr = api.client.viewPR(number);
    if (!pr)
      throw new ExitFailedError(
        `PR #${number} disappeared during stack cleanup.`
      );
    if (pr.state !== 'OPEN') continue;
    if (pr.isCrossRepository)
      throw new ExitFailedError(
        `Refusing to rebuild a stack containing fork PR #${number}.`
      );
    const previous = chains[chains.length - 1];
    if (
      previous &&
      previous[previous.length - 1].headRefName === pr.baseRefName
    )
      previous.push(pr);
    else chains.push([pr]);
  }
  return chains;
}

function restoreChain(
  chain: GitHubPR[],
  remote: RemoteStack[],
  api: StackAPI
): RemoteStack | undefined {
  if (chain.length < 2) return undefined;
  const numbers = chain.map((pr) => pr.number);
  const matches = remote.filter((s) =>
    s.pull_requests.some((pr) => numbers.includes(pr.number) && !pr.merged_at)
  );
  if (!matches.length) return api.create(numbers);
  const existing = matches[0];
  if (
    matches.length !== 1 ||
    existing.base.ref !== chain[0].baseRefName ||
    JSON.stringify(
      existing.pull_requests
        .filter((pr) => !pr.merged_at)
        .map((pr) => pr.number)
    ) !== JSON.stringify(numbers)
  ) {
    throw new ExitFailedError(
      `Surviving PRs changed stacks during cleanup. Refusing to overwrite GitHub stack #${existing.number}.`
    );
  }
  return existing;
}

function applyCleanup(
  args: {
    number: number;
    plan: Cleanup;
    remote: RemoteStack[];
    removed: number[];
  },
  api: StackAPI,
  store: StackStore
): RemoteStack[] {
  const { number, plan, removed } = args;
  const current = readStack(api, number);
  if (current) assertCleanupLease(current, plan, removed);
  // Read all survivor bases before the destructive API call. Removing a middle
  // PR may split the chain; keep those segments without retargeting any PR.
  const chains = survivorChains(plan, api);
  let remaining = current;
  if (current?.pull_requests.some((pr) => !pr.merged_at)) {
    // Check once more after fetching PRs to catch concurrent membership edits.
    const latest = readStack(api, number);
    if (latest) {
      assertCleanupLease(latest, plan, removed);
      remaining = api.unstack(number);
    } else remaining = undefined;
  }
  let remote = args.remote.filter((s) => s.number !== number);
  if (remaining) remote.push(remaining);
  delete store.state.remote[String(number)];
  for (const local of store.file.stacks) {
    if (local.number === number) {
      delete local.id;
      delete local.number;
    }
  }
  store.save();
  for (const chain of chains) {
    const restored = restoreChain(chain, remote, api);
    if (!restored) continue;
    remote = remote.filter((s) => s.number !== restored.number);
    remote.push(restored);
    store.state.remote[String(restored.number)] = {
      base: restored.base.ref,
      prs: restored.pull_requests.map((pr) => pr.number),
    };
    for (const local of store.file.stacks) {
      if (
        local.branches.some(
          (b) =>
            b.pullRequest &&
            chain.some((pr) => pr.number === b.pullRequest?.number)
        )
      ) {
        local.id = restored.node_id;
        local.number = restored.number;
      }
    }
    store.save();
  }
  delete store.state.pendingStackCleanups?.[String(number)];
  store.save();
  return remote;
}
