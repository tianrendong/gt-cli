import { TContext } from '../../lib/context';
import { ExitFailedError } from '../../lib/errors';
import { GitHubClient } from '../../lib/github/client';
import { RemoteStack } from '../../lib/github/stack_api';
import { cleanupGitHubStacks } from '../../lib/github/stack_cleanup';
import { recordMatches, recordVariants } from '../../lib/github/stack_file';
import {
  projectStacks,
  exportLocalStacks,
} from '../../lib/github/local_stacks';
import {
  activePRs,
  chainMatchesLocal,
  githubStackAPI,
  isPrefix,
  listRemoteStacks,
  remoteMatchesCheckpoint,
} from '../../lib/github/stack_sync';
import {
  importRemoteBranches,
  recordRemoteStacks,
  resolveAncestors,
} from './github_get';

/** Sync imports topology and prunes obsolete membership; it never pushes branches or opens PRs. */
export async function pullGitHubStacks(
  context: TContext,
  protectedBranches: ReadonlySet<string> = new Set()
): Promise<void> {
  const store = context.githubStacks;
  if (!store) return;
  const remote = await cleanupGitHubStacks(context, {
    remote: await listRemoteStacks(githubStackAPI(context)),
    protectedBranches,
  });
  const local = projectStacks(context.engine, store.file.stacks);
  const imports = [];
  const skipped = new Set<number>();
  for (const stack of local) {
    if (stack.branches.some((branch) => protectedBranches.has(branch.branch)))
      continue;
    const branches = stack.branches.filter(
      (b) =>
        !['MERGED', 'CLOSED'].includes(
          context.engine.getPrInfo(b.branch)?.state ?? ''
        )
    );
    const names = branches.map((b) => b.branch);
    const prs = new Set(branches.map((b) => b.pullRequest?.number));
    const matches = remote.filter(
      (s) =>
        s.open &&
        activePRs(s).length > 0 &&
        (s.number === stack.number ||
          activePRs(s).some(
            (pr) => names.includes(pr.head.ref) || prs.has(pr.number)
          ))
    );
    if (matches.length > 1) {
      // Pruning a closed middle PR can split one local chain into several
      // remote segments. Keep local topology until delete/restack/submit, but
      // only while every segment still matches our synchronized checkpoint.
      if (matches.every((s) => remoteMatchesCheckpoint(s, store.state)))
        continue;
      matches.forEach((s) => skipped.add(s.number));
      context.splog.warn(
        `Local stack [${names.join(
          ' -> '
        )}] matches multiple GitHub stacks: ${matches
          .map((s) => `#${s.number}`)
          .join(
            ', '
          )}. Skipping topology sync for this stack. Inspect the candidates, then resolve with gt get <stack-number>.`
      );
      continue;
    }
    const source = matches[0];
    if (
      !source ||
      activePRs(source).some((pr) => protectedBranches.has(pr.head.ref))
    )
      continue;
    const remoteNames = activePRs(source).map((pr) => pr.head.ref);
    if (isPrefix(remoteNames, names)) continue; // local-only growth, or already synchronized
    if (isPrefix(names, remoteNames)) {
      // Remote PRs past this segment may already exist locally as further
      // segments of a fork; only genuinely new branches need importing.
      if (chainMatchesLocal(remoteNames, context.engine)) continue;
      imports.push(source);
      continue;
    }
    // A remote stack that starts upstack of this segment (a fork projected
    // this segment on its own) is consistent if it follows local parents.
    if (
      remoteNames.includes(names[0]) &&
      chainMatchesLocal(remoteNames, context.engine)
    )
      continue;
    if (
      recordMatches(
        store.state.remote[String(source.number)],
        undefined,
        source.pull_requests.map((pr) => pr.number)
      )
    ) {
      continue; // deliberate local move/reorder, to be published by submit
    }
    skipped.add(source.number);
    context.splog.warn(
      `GitHub stack #${source.number} and local stack [${names.join(
        ' -> '
      )}] diverged. Keeping local topology. ` +
        `Inspect both, then use gt get ${source.number} --force --remote-upstack to adopt GitHub or gt github sync --source local to publish local topology.`
    );
  }
  const client = GitHubClient.fromConfig(context.repoConfig);
  // A remote stack can span several local segments. Check them all before
  // importing, and never checkpoint an ambiguous/divergent candidate merely
  // because another segment happens to match it.
  for (const stack of imports.filter((s) => !skipped.has(s.number))) {
    const prs = activePRs(stack).map((pr) => {
      const full = client.viewPR(pr.number);
      if (!full)
        throw new ExitFailedError(
          `PR #${pr.number} disappeared while synchronizing.`
        );
      return full;
    });
    importRemoteBranches(
      resolveAncestors(prs, client, context),
      { force: false, keepExisting: true, freezeNew: true },
      context
    );
    context.splog.info(
      `Imported new branches from GitHub stack #${stack.number}.`
    );
  }
  exportLocalStacks(context, store);
  recordSynchronizedStacks(
    remote.filter((s) => !skipped.has(s.number)),
    protectedBranches,
    context
  );
  pruneClosedStackRecords(remote, context);
}

/** Records are repository-wide and one file per stack, so they would otherwise
 * accumulate. A record of a stack that is gone from GitHub is still needed while
 * any of its PRs is open locally: submit uses it to find every segment of a
 * stack that something else dissolved. Without such a PR it is never read. */
function pruneClosedStackRecords(
  remote: RemoteStack[],
  context: TContext
): void {
  const store = context.githubStacks;
  if (!store) return;
  const open = new Set(
    context.engine.allBranchNames.flatMap((branch) => {
      const pr = context.engine.getPrInfo(branch);
      return pr?.number && pr.state !== 'MERGED' && pr.state !== 'CLOSED'
        ? [pr.number]
        : [];
    })
  );
  let pruned = false;
  for (const [number, record] of Object.entries(store.state.remote)) {
    if (
      remote.some(
        (s) => s.number === Number(number) && s.open && activePRs(s).length
      ) ||
      recordVariants(record).some((v) => v.prs.some((pr) => open.has(pr)))
    )
      continue;
    delete store.state.remote[number];
    pruned = true;
  }
  if (pruned) store.save();
}

/** Only record synchronized stacks; don't bless a deliberate local divergence. */
function recordSynchronizedStacks(
  remote: RemoteStack[],
  protectedBranches: ReadonlySet<string>,
  context: TContext
): void {
  const local = context.githubStacks?.file.stacks ?? [];
  recordRemoteStacks(
    remote.filter((stack) => {
      const prs = activePRs(stack);
      const names = prs.map((pr) => pr.head.ref);
      return (
        stack.open &&
        prs.length > 0 &&
        !names.some((name) => protectedBranches.has(name)) &&
        (local.some((s) =>
          isPrefix(
            names,
            s.branches
              .filter((b) => !b.pullRequest?.merged)
              .map((b) => b.branch)
          )
        ) ||
          // Spanning a local fork is synchronized too; the checkpoint lets a
          // later submit split it into linear stacks.
          chainMatchesLocal(names, context.engine))
      );
    }),
    context
  );
}
