import { TContext } from '../context';
import { TEngine } from '../engine/engine';
import {
  deleteMetadataRef,
  readMetadataRef,
  TBranchPRInfo,
  writeMetadataRef,
} from '../engine/metadata_ref';
import { ExitFailedError } from '../errors';
import { runGitCommand } from '../git/runner';
import { BranchRef, LocalStack, StackStore } from './stack_file';

export function removedPullRequests(
  engine: TEngine,
  store: StackStore,
  current = projectStacks(engine, store.file.stacks)
): number[] {
  const retained = new Set(
    current.flatMap((s) =>
      s.branches.flatMap((b) => (b.pullRequest ? [b.pullRequest.number] : []))
    )
  );
  return [
    ...new Set([
      ...(store.state.removedPullRequests ?? []),
      ...[...store.file.stacks, ...store.state.stacks].flatMap((s) =>
        s.branches.flatMap((b) =>
          b.pullRequest &&
          !b.pullRequest.merged &&
          !engine.branchExists(b.branch)
            ? [b.pullRequest.number]
            : []
        )
      ),
    ]),
  ].filter((number) => !retained.has(number));
}

export function parentMap(stacks: LocalStack[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const stack of stacks) {
    let parent = stack.trunk.branch;
    for (const branch of stack.branches) {
      if (parents.has(branch.branch) && parents.get(branch.branch) !== parent) {
        throw new ExitFailedError(
          `Conflicting parents for ${branch.branch} in gh-stack metadata.`
        );
      }
      parents.set(branch.branch, parent);
      parent = branch.branch;
    }
  }
  return parents;
}

/** Partition a DAG into non-overlapping linear chains; a PR can belong to only one GitHub Stack. */
export function projectStacks(
  engine: TEngine,
  previous: LocalStack[] = []
): LocalStack[] {
  const refs = new Map(
    previous.flatMap((s) => s.branches.map((b) => [b.branch, b] as const))
  );
  const tracked = engine.allBranchNames.filter((b) =>
    engine.isBranchTracked(b)
  );
  const starts = tracked
    .filter((b) => {
      const parent = engine.getParentPrecondition(b);
      return engine.isTrunk(parent) || engine.getChildren(parent).length !== 1;
    })
    .sort();
  const used = new Set<LocalStack>();
  return starts.map((start) => {
    const trunk = engine.getParentPrecondition(start);
    const branches: BranchRef[] = [];
    let branch: string | undefined = start;
    while (branch) {
      const pr = engine.getPrInfo(branch);
      const previousPR = refs.get(branch)?.pullRequest;
      const samePR = previousPR?.number === pr?.number ? previousPR : undefined;
      branches.push({
        ...refs.get(branch),
        branch,
        head: engine.getRevision(branch),
        base: engine.getBaseRevision(branch),
        pullRequest: pr?.number
          ? {
              number: pr.number,
              id: pr.id ?? samePR?.id,
              url: pr.url ?? samePR?.url,
              merged: pr.state === 'MERGED',
            }
          : undefined,
      });
      const children = engine.getChildren(branch);
      branch = children.length === 1 ? children[0] : undefined;
    }
    const names = new Set(branches.map((b) => b.branch));
    const candidates = previous.filter(
      (s) => !used.has(s) && s.branches.some((b) => names.has(b.branch))
    );
    candidates.sort(
      (a, b) =>
        b.branches.filter((r) => names.has(r.branch)).length -
        a.branches.filter((r) => names.has(r.branch)).length
    );
    const prior = candidates[0];
    if (prior) used.add(prior);
    return {
      ...prior,
      trunk: { branch: trunk, head: engine.getRevision(trunk) },
      branches,
    };
  });
}

function assertRepository(context: TContext, store: StackStore): void {
  let expected: string | undefined;
  try {
    const { host, owner, name } = context.repoConfig.getRepoIdentity();
    expected = `${host}:${owner}/${name}`;
  } catch {
    /* Local-only remote. */
  }
  if (
    expected &&
    store.file.repository &&
    ![expected, expected.slice(expected.lastIndexOf(':') + 1)].includes(
      store.file.repository
    )
  ) {
    throw new ExitFailedError(
      `gh-stack metadata belongs to ${store.file.repository}, but the configured repository is ${expected}. Correct the repository configuration before reusing PR associations.`
    );
  }
}

/** Import only externally changed PR fields; a new PR must not inherit the old PR's cached state. */
function importPullRequest(args: {
  branch: string;
  parent: string;
  previous: BranchRef['pullRequest'];
  incoming: BranchRef['pullRequest'];
  current: TBranchPRInfo | undefined;
}): TBranchPRInfo | undefined {
  const { branch, parent, previous, incoming, current } = args;
  const associationChanged = previous?.number !== incoming?.number;
  if (
    associationChanged &&
    current?.number !== previous?.number &&
    current?.number !== incoming?.number
  ) {
    throw new ExitFailedError(
      `gt and gh stack both changed the pull request for ${branch}. ` +
        'Resolve with gt github import --source local|gh-stack; neither association was overwritten.'
    );
  }
  if (!associationChanged && current?.number !== incoming?.number)
    return current;
  const changed =
    associationChanged ||
    previous?.id !== incoming?.id ||
    previous?.url !== incoming?.url ||
    !!previous?.merged !== !!incoming?.merged;
  if (!changed) return current;
  // This lease describes the branch, not its PR. Keep it even if the PR is removed.
  const lease: TBranchPRInfo | undefined = current?.remoteRevision
    ? { remoteRevision: current.remoteRevision }
    : undefined;
  if (!incoming) return lease;
  const samePR = current?.number === incoming.number;
  const retained = samePR ? current : lease;
  const mergedChanged =
    !samePR ||
    (associationChanged
      ? !!incoming.merged
      : !!previous?.merged !== !!incoming.merged);
  return {
    ...retained,
    number: incoming.number,
    id:
      (!samePR || previous?.id !== incoming.id ? incoming.id : undefined) ??
      retained?.id,
    url:
      (!samePR || previous?.url !== incoming.url ? incoming.url : undefined) ??
      retained?.url,
    base: retained?.base ?? parent,
    state: mergedChanged
      ? incoming.merged
        ? 'MERGED'
        : retained?.state === 'MERGED'
        ? undefined
        : retained?.state
      : retained?.state,
  };
}

/** Three-way merge: gh-stack edits import only when they do not conflict with local gt edits. */
export function importLocalStacks(context: TContext, store: StackStore): void {
  assertRepository(context, store);
  // Fast path: the gh-stack file matches the topology gt last exported, so
  // there are no external edits to reconcile and no metadata to touch.
  if (
    JSON.stringify(store.file.stacks) === JSON.stringify(store.state.stacks)
  ) {
    return;
  }
  const engine = context.engine;
  const before = parentMap(store.state.stacks);
  const external = parentMap(store.file.stacks);
  const local = parentMap(projectStacks(engine));
  // gh-stack may already have rewritten commits. Such branches can temporarily
  // fail gt's old base-revision validation, but their stored parent still tells
  // us whether gt independently changed topology since the last mirror export.
  for (const branch of before.keys()) {
    if (engine.branchExists(branch) && !local.has(branch)) {
      const parent = readMetadataRef(branch).parentBranchName;
      if (parent) local.set(branch, parent);
    }
  }
  const refs = new Map(
    store.file.stacks.flatMap((s) =>
      s.branches.map((b) => [b.branch, b] as const)
    )
  );
  const oldRefs = new Map(
    store.state.stacks.flatMap((s) =>
      s.branches.map((b) => [b.branch, b] as const)
    )
  );
  const changes = new Map<string, string | undefined>();
  for (const branch of new Set([...before.keys(), ...external.keys()])) {
    const old = before.get(branch);
    const next = external.get(branch);
    if (old === next) continue;
    if (local.get(branch) !== old && local.get(branch) !== next) {
      throw new ExitFailedError(
        `gt and gh stack both changed the parent of ${branch}. ` +
          'Resolve with gt github import --source local|gh-stack; neither topology was overwritten.'
      );
    }
    changes.set(branch, next);
  }
  const merged = new Map(local);
  changes.forEach((parent, branch) =>
    parent ? merged.set(branch, parent) : merged.delete(branch)
  );
  validateParents(merged, engine);

  // Validate every incoming base before touching any ref.
  const bases = new Map<string, string>();
  for (const [branch, ref] of refs) {
    if (!merged.has(branch)) continue;
    if (!engine.branchExists(branch)) {
      throw new ExitFailedError(
        `gh stack references missing local branch ${branch}. Run gt get first.`
      );
    }
    if (changes.has(branch) || ref.base !== oldRefs.get(branch)?.base) {
      const parent = merged.get(branch) as string;
      const base =
        ref.base ||
        runGitCommand({
          args: ['merge-base', `refs/heads/${branch}`, `refs/heads/${parent}`],
          onError: 'throw',
          resource: 'importGhStackBase',
        });
      const ancestor = runGitCommand({
        args: ['merge-base', `refs/heads/${branch}`, base],
        onError: 'throw',
        resource: 'validateGhStackBase',
      });
      if (ancestor !== base) {
        throw new ExitFailedError(
          `gh-stack base for ${branch} is not in its history. Finish the gh stack rebase first.`
        );
      }
      bases.set(branch, base);
    }
  }
  // Preflight all PR associations too, before any topology or metadata ref is written.
  const prs = new Map<string, TBranchPRInfo | undefined>();
  for (const [branch, ref] of refs) {
    const parent = merged.get(branch);
    if (!parent) continue;
    const current = readMetadataRef(branch).prInfo;
    const next = importPullRequest({
      branch,
      parent,
      current,
      incoming: ref.pullRequest,
      previous: oldRefs.get(branch)?.pullRequest,
    });
    if (JSON.stringify(next) !== JSON.stringify(current)) prs.set(branch, next);
  }
  let changed = false;
  for (const [branch, parent] of changes) {
    if (!parent) {
      deleteMetadataRef(branch);
      changed = true;
    }
  }
  for (const branch of refs.keys()) {
    const parent = merged.get(branch);
    if (!parent) continue;
    const meta = readMetadataRef(branch);
    if (!changes.has(branch) && !bases.has(branch) && !prs.has(branch))
      continue;
    writeMetadataRef(branch, {
      ...meta,
      parentBranchName: parent,
      parentBranchRevision: bases.get(branch) ?? meta.parentBranchRevision,
      prInfo: prs.has(branch) ? prs.get(branch) : meta.prInfo,
    });
    changed = true;
  }
  if (changed) engine.rebuild();
}

function validateParents(parents: Map<string, string>, engine: TEngine): void {
  for (const branch of parents.keys()) {
    const seen = new Set<string>();
    let node = branch;
    while (!engine.isTrunk(node)) {
      if (seen.has(node))
        throw new ExitFailedError(`Cycle in gh-stack topology at ${node}.`);
      seen.add(node);
      const parent = parents.get(node);
      if (
        !parent ||
        !engine.branchExists(node) ||
        !engine.branchExists(parent)
      ) {
        throw new ExitFailedError(
          `Cannot import gh-stack topology at ${node}: missing or untracked parent. Run gt get or gt track first.`
        );
      }
      node = parent;
    }
  }
}

export function exportLocalStacks(context: TContext, store: StackStore): void {
  const stacks = projectStacks(context.engine, store.file.stacks);
  const removed = removedPullRequests(context.engine, store, stacks);
  if (removed.length || store.state.removedPullRequests)
    store.state.removedPullRequests = removed;
  store.file.stacks = stacks;
  store.state.stacks = stacks;
  try {
    const { host, owner, name } = context.repoConfig.getRepoIdentity();
    store.file.repository = `${host}:${owner}/${name}`;
  } catch {
    // Offline/local-only repositories still get a usable gh-stack mirror.
  }
  store.save();
}
