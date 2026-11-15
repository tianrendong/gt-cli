import { TContext } from '../context';
import { TEngine } from '../engine/engine';
import { ExitFailedError } from '../errors';
import { GitHubClient, GitHubError } from './client';
import { exportLocalStacks, projectStacks } from './local_stacks';
import {
  LocalStack,
  MirrorState,
  RemoteComposition,
  recordMatches,
  recordVariants,
} from './stack_file';
import { RemoteStack, StackAPI } from './stack_api';
import { cleanupGitHubStacks } from './stack_cleanup';

export function closedPRNumbers(context: TContext): Set<number> {
  return new Set(
    context.engine.allBranchNames.flatMap((branch) => {
      const pr = context.engine.getPrInfo(branch);
      return pr?.state === 'CLOSED' && pr.number ? [pr.number] : [];
    })
  );
}

export type StackPlan = {
  local: LocalStack;
  remote?: RemoteStack;
  action: 'noop' | 'create' | 'append' | 'replace';
  prs: number[];
  replace?: RemoteStack[];
};

export function isPrefix<T>(left: T[], right: T[]): boolean {
  return (
    left.length <= right.length && left.every((value, i) => value === right[i])
  );
}
export function activePRs(stack: RemoteStack): RemoteStack['pull_requests'] {
  return stack.pull_requests.filter(
    (pr) => !pr.merged_at && pr.state === 'open'
  );
}

/** A GitHub Stack is one linear chain. Locally, a fork splits that chain into
 * several segments, so a remote stack can span segments without any topology
 * disagreement: it is consistent when every remote PR sits directly on the
 * previous one locally. */
export function chainMatchesLocal(
  remoteNames: readonly string[],
  engine: TEngine
): boolean {
  return remoteNames.every(
    (branch, index) =>
      engine.branchExists(branch) &&
      engine.isBranchTracked(branch) &&
      (index === 0 || engine.getParent(branch) === remoteNames[index - 1])
  );
}
export function remoteMatchesCheckpoint(
  stack: RemoteStack,
  state: MirrorState
): boolean {
  return recordMatches(
    state.remote[String(stack.number)],
    stack.base.ref,
    stack.pull_requests.map((pr) => pr.number)
  );
}

function missingRemoteCheckpoints(
  remote: RemoteStack[],
  state: MirrorState
): [string, { prs: number[] }][] {
  return Object.entries(state.remote)
    .filter(
      ([number]) =>
        !remote.some(
          (stack) =>
            stack.number === Number(number) &&
            stack.open &&
            activePRs(stack).length
        )
    )
    .map(([number, record]) => [
      number,
      { prs: [...new Set(recordVariants(record).flatMap((v) => v.prs))] },
    ]);
}

type StackSyncOptions = {
  local: LocalStack[];
  remote: RemoteStack[];
  state: MirrorState;
  submitting?: Set<string>;
  allowNew?: boolean;
  preferLocal?: boolean;
  closedPRs?: ReadonlySet<number>;
};

function closedStackPRs(args: StackSyncOptions): Set<number> {
  return new Set([
    ...(args.closedPRs ?? []),
    ...args.remote.flatMap((s) =>
      s.pull_requests
        .filter((pr) => pr.state === 'closed')
        .map((pr) => pr.number)
    ),
  ]);
}

/** Pure planner. Membership is compared before any push, PR edit, or unstack. */
export function planStackSync(args: StackSyncOptions): StackPlan[] {
  const closed = closedStackPRs(args);
  const missingCheckpoints = missingRemoteCheckpoints(args.remote, args.state);
  const proposed = args.local.map((local) => {
    const branches = local.branches.filter(
      (b) =>
        !b.pullRequest?.merged &&
        (!b.pullRequest || !closed.has(b.pullRequest.number))
    );
    const included = branches.filter(
      (b) => b.pullRequest || (args.allowNew && args.submitting?.has(b.branch))
    );
    const names = included.map((b) => b.branch);
    const prs = included.flatMap((b) =>
      b.pullRequest ? [b.pullRequest.number] : []
    );
    const candidates = args.remote.filter(
      (r) =>
        r.open &&
        activePRs(r).length > 0 &&
        (r.number === local.number ||
          activePRs(r).some(
            (pr) => names.includes(pr.head.ref) || prs.includes(pr.number)
          ))
    );
    const previousGroups = new Set(
      missingCheckpoints
        .filter(([, prior]) => prior.prs.some((pr) => prs.includes(pr)))
        .map(([number]) => number)
    );
    return {
      local,
      branches,
      included,
      names,
      prs,
      candidates,
      previousGroups,
    };
  });
  const selected = new Set(
    proposed.filter(
      (p) =>
        !args.submitting ||
        p.local.branches.some((b) => args.submitting?.has(b.branch))
    )
  );
  // A fork or cross-stack move can split/join remote objects. Include every
  // affected linear segment so no PR is assigned to two remote stacks. If an
  // external gh-stack writer already dissolved the old object, its checkpoint
  // still identifies the other segments we must repair. Membership/base checks
  // below remain strict for any independently changed replacement object.
  for (const item of selected) {
    proposed
      .filter(
        (p) =>
          p.candidates.some((r) => item.candidates.includes(r)) ||
          [...p.previousGroups].some((number) =>
            item.previousGroups.has(number)
          )
      )
      .forEach((p) => selected.add(p));
  }
  const plans: StackPlan[] = [];
  for (const p of selected) {
    if (
      !isPrefix(
        p.names,
        p.branches.map((b) => b.branch)
      )
    ) {
      throw new ExitFailedError(
        'Unsubmitted branches interrupt the GitHub stack. Run gt submit --stack first.'
      );
    }
    const remote = p.candidates[0];
    const shared = p.candidates.some(
      (r) =>
        [...selected].filter((other) => other.candidates.includes(r)).length > 1
    );
    const remoteEntries = remote ? activePRs(remote) : [];
    const remoteNames = remoteEntries.map((pr) => pr.head.ref);
    const samePrefix =
      isPrefix(remoteNames, p.names) &&
      remoteEntries.every(
        (pr, i) =>
          !p.included[i]?.pullRequest ||
          p.included[i].pullRequest?.number === pr.number
      );
    const sameBase = !remote || remote.base.ref === p.local.trunk.branch;
    let action: StackPlan['action'];
    if (!remote) action = p.names.length >= 2 ? 'create' : 'noop';
    else if (!shared && p.candidates.length === 1 && sameBase && samePrefix) {
      action = remoteNames.length === p.names.length ? 'noop' : 'append';
    } else if (
      args.preferLocal ||
      p.candidates.every((r) => remoteMatchesCheckpoint(r, args.state))
    ) {
      action = 'replace';
    } else {
      throw new ExitFailedError(
        explainRefusal({
          plan: p,
          all: args.local,
          state: args.state,
          sameBase,
        })
      );
    }
    plans.push({
      local: p.local,
      remote,
      action,
      prs: p.prs,
      ...(action === 'replace' ? { replace: p.candidates } : {}),
    });
  }
  return plans;
}

const describeRemote = (stack: RemoteStack): string =>
  `[${activePRs(stack)
    .map((pr) => `#${pr.number} ${pr.head.ref}`)
    .join(' -> ')}] on ${stack.base.ref}`;
const describeRecord = (record: RemoteComposition): string =>
  `[${record.prs.map((pr) => `#${pr}`).join(' -> ')}] on ${record.base}`;

/** The branch, if any, where the local stacks fork inside a GitHub stack. */
function forkInside(
  stack: RemoteStack,
  all: LocalStack[]
): { branch: string; children: string[] } | undefined {
  const children = new Map<string, string[]>();
  for (const segment of all) {
    let parent = segment.trunk.branch;
    for (const { branch } of segment.branches) {
      children.set(parent, [...(children.get(parent) ?? []), branch]);
      parent = branch;
    }
  }
  for (const branch of [
    stack.base.ref,
    ...activePRs(stack).map((pr) => pr.head.ref),
  ]) {
    const below = [...new Set(children.get(branch) ?? [])];
    if (below.length > 1) return { branch, children: below };
  }
  return undefined;
}

/** Why gt cannot rebuild a stack, telling "gt has no record of it" apart from
 * "it changed on GitHub", and naming a local fork when that is the cause. */
function explainRefusal(args: {
  plan: {
    local: LocalStack;
    names: string[];
    candidates: RemoteStack[];
  };
  all: LocalStack[];
  state: MirrorState;
  sameBase: boolean;
}): string {
  const { plan, state } = args;
  const stack =
    plan.candidates.find((r) => !remoteMatchesCheckpoint(r, state)) ??
    plan.candidates[0];
  const number = stack.number;
  const fork = forkInside(stack, args.all);
  const reason = fork
    ? `local branch ${fork.branch} has ${
        fork.children.length
      } children in it (${fork.children.join(
        ', '
      )}). GitHub stacks are linear, so gt must dissolve #${number} and rebuild it as separate stacks.`
    : plan.candidates.length > 1
    ? `local stack [${plan.names.join(
        ' -> '
      )}] now joins GitHub stacks ${plan.candidates
        .map((r) => `#${r.number}`)
        .join(' and ')}, so gt must rebuild them as one.`
    : !args.sameBase
    ? `its base changed locally from ${stack.base.ref} to ${plan.local.trunk.branch}.`
    : `its PRs changed order or membership locally (local: [${plan.names.join(
        ' -> '
      )}]).`;
  const record = state.remote[String(number)];
  const noRetreat =
    'Do not retry with --no-stack-sync: it stops syncing GitHub stacks and falls back to dependency trees in PR bodies.';
  if (!record) {
    return [
      `GitHub stack #${number} must be rebuilt: ${reason}`,
      `gt has no record of syncing #${number} in this repository, so it cannot tell whether someone changed it on GitHub. ` +
        '(A stack last submitted from another clone, by gh stack, or by gt before 0.6.41-beta.2 has no record.)',
      `GitHub now has ${describeRemote(stack)}.`,
      `If that is what you last submitted, rebuild it from your local branches: gt submit --stack --reconcile local`,
      `Otherwise adopt GitHub's version first with gt get ${number}, then repeat your local change.`,
      noRetreat,
    ].join('\n');
  }
  const written = [
    record.writtenBy && `by ${record.writtenBy}`,
    record.at && `at ${record.at}`,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    `GitHub stack #${number} changed on GitHub since gt last synced it. Refusing to overwrite it.`,
    `gt last synced ${describeRecord(record)}${
      written ? ` (${written})` : ''
    }; GitHub now has ${describeRemote(stack)}.`,
    `Your local change needs #${number} rebuilt: ${reason}`,
    `Run gt get ${number} to adopt GitHub's version (it refuses rather than discard local commits), then repeat your local change and submit again.`,
    noRetreat,
  ].join('\n');
}

export function githubStackAPI(context: TContext): StackAPI {
  return new StackAPI(GitHubClient.fromConfig(context.repoConfig));
}

export async function listRemoteStacks(api: StackAPI): Promise<RemoteStack[]> {
  try {
    return await api.list();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new ExitFailedError(
        'GitHub Stacks API is unavailable for this repository or token. Enable stacked PRs/check gh auth, ' +
          'or explicitly use --no-stack-sync for ordinary chained PRs.'
      );
    }
    throw error;
  }
}

export async function preflightStackSync(
  context: TContext,
  branches: string[],
  preferLocal = false
): Promise<StackPlan[]> {
  const remote = await listRemoteStacks(githubStackAPI(context));
  const plans = planStackSync({
    local: projectStacks(context.engine, context.githubStacks?.file.stacks),
    remote,
    state: context.githubStacks?.state ?? {
      version: 1,
      stacks: [],
      remote: {},
    },
    submitting: new Set(branches),
    allowNew: true,
    preferLocal,
    closedPRs: closedPRNumbers(context),
  });
  await cleanupGitHubStacks(context, {
    remote,
    branches: new Set(
      plans.flatMap((p) => p.local.branches.map((b) => b.branch))
    ),
    dryRun: true,
  });
  for (const plan of plans) {
    for (const branch of plan.local.branches) {
      const pr = context.engine.getPrInfo(branch.branch);
      if (
        pr?.number &&
        plan.prs.includes(pr.number) &&
        !branches.includes(branch.branch) &&
        pr.base !== context.engine.getParentPrecondition(branch.branch)
      ) {
        throw new ExitFailedError(
          `Also submit ${
            branch.branch
          }: its PR base must change to reconcile this stack. Submit --stack from a common ancestor, or use --branch ${context.engine.getTrunk(
            branch.branch
          )} --stack.`
        );
      }
    }
    context.splog.info(
      `GitHub Stack plan: ${plan.action} [${plan.local.branches
        .map((b) => b.branch)
        .join(' -> ')}]`
    );
  }
  return plans;
}

/** Dissolve before PR retargeting: GitHub may forbid breaking an existing chain. */
export function prepareRemoteStacks(
  plans: StackPlan[],
  context: TContext
): void {
  const store = context.githubStacks;
  if (!store)
    throw new ExitFailedError(
      'GitHub stack synchronization requires a metadata session.'
    );
  const api = githubStackAPI(context);
  const replacements = new Map(
    plans.flatMap((p) => (p.replace ?? []).map((r) => [r.number, r] as const))
  );
  for (const remote of replacements.values()) {
    const latest = api.get(remote.number);
    if (
      JSON.stringify([
        latest.base.ref,
        latest.pull_requests.map((pr) => pr.number),
      ]) !==
      JSON.stringify([
        remote.base.ref,
        remote.pull_requests.map((pr) => pr.number),
      ])
    ) {
      throw new ExitFailedError(
        `GitHub stack #${remote.number} changed during submit. Retry; it was not unstacked.`
      );
    }
    api.unstack(remote.number);
    delete store.state.remote[String(remote.number)];
    for (const local of store.file.stacks) {
      if (local.number === remote.number) {
        local.id = undefined;
        local.number = undefined;
      }
    }
    store.save();
  }
}

/** Re-read the server after PR submission; retry repairs partial API failures idempotently. */
export async function syncSubmittedStacks(
  context: TContext,
  branches: string[],
  preferLocal = false
): Promise<void> {
  const store = context.githubStacks;
  if (!store)
    throw new ExitFailedError(
      'GitHub stack synchronization requires a stack metadata session.'
    );
  exportLocalStacks(context, store);
  const api = githubStackAPI(context);
  const observed = await cleanupGitHubStacks(context, {
    remote: await listRemoteStacks(api),
    branches: new Set(branches),
  });
  const plans = planStackSync({
    local: store.file.stacks,
    remote: observed,
    state: store.state,
    submitting: new Set(branches),
    preferLocal,
    closedPRs: closedPRNumbers(context),
  });
  prepareRemoteStacks(plans, context);
  for (const plan of plans) {
    let remote = plan.action === 'replace' ? undefined : plan.remote;
    if (plan.action === 'create' || plan.action === 'replace') {
      remote = plan.prs.length >= 2 ? api.create(plan.prs) : undefined;
    } else if (plan.action === 'append' && remote) {
      const existing = new Set(remote.pull_requests.map((pr) => pr.number));
      const delta = plan.prs.filter((number) => !existing.has(number));
      if (delta.length) remote = api.append(remote.number, delta);
    }
    if (remote) {
      plan.local.id = remote.node_id;
      plan.local.number = remote.number;
      store.state.remote[String(remote.number)] = {
        base: remote.base.ref,
        prs: remote.pull_requests.map((pr) => pr.number),
      };
      context.splog.info(
        `GitHub stack #${remote.number}: ${
          plan.action === 'noop' ? 'up to date' : 'synchronized'
        }.`
      );
    }
    store.state.stacks = store.file.stacks;
    store.save();
  }
  const touched = new Set(plans.flatMap((plan) => plan.prs));
  let pruned = false;
  for (const [number, previous] of Object.entries(store.state.remote)) {
    if (
      !observed.some(
        (remote) =>
          remote.number === Number(number) &&
          remote.open &&
          activePRs(remote).length
      ) &&
      !plans.some((plan) => plan.local.number === Number(number)) &&
      previous.prs.some((pr) => touched.has(pr))
    ) {
      delete store.state.remote[number];
      pruned = true;
    }
  }
  if (pruned) store.save();
}
