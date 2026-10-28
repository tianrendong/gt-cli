import { TContext } from '../../lib/context';
import {
  TMeta,
  readMetadataRef,
  makeSubmittedVersion,
} from '../../lib/engine/metadata_ref';
import { ExitFailedError } from '../../lib/errors';
import { runGitCommand } from '../../lib/git/runner';
import { GitHubClient, GitHubPR } from '../../lib/github/client';
import {
  activePRs,
  githubStackAPI,
  listRemoteStacks,
} from '../../lib/github/stack_sync';
import { RemoteStack } from '../../lib/github/stack_api';
import { exportLocalStacks } from '../../lib/github/local_stacks';
import { restackBranches } from '../restack';
import { SCOPE } from '../../lib/engine/scope_spec';
import { cleanBranches } from './clean_branches';
import { syncPrInfo } from '../sync_pr_info';
import { updateBranchesFromRemote } from './update_branches';

export type GetOptions = {
  branchName?: string;
  force: boolean;
  checkout?: boolean;
  restack?: boolean;
  remoteUpstack?: boolean;
  downstack?: boolean;
  stackSync?: boolean;
  unfrozen?: boolean;
  deleteAll?: boolean;
};
export type RemoteBranch = { name: string; parent: string; pr: GitHubPR };

function git(args: string[], input?: string): string {
  return runGitCommand({
    args,
    options: { input },
    onError: 'throw',
    resource: 'getGitHubStack',
  });
}

export async function getGitHubStack(
  args: GetOptions,
  context: TContext
): Promise<void> {
  if (args.downstack && args.remoteUpstack)
    throw new ExitFailedError(
      '--downstack and --remote-upstack are mutually exclusive.'
    );
  assertCleanForGet();
  const client = GitHubClient.fromConfig(context.repoConfig);
  const identifier =
    args.branchName ?? context.engine.currentBranchPrecondition;
  const url = identifier.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/
  );
  if (url && `${url[1]}/${url[2]}/${url[3]}` !== client.qualifiedRepo) {
    throw new ExitFailedError(
      `PR URL belongs to a different repository than ${client.qualifiedRepo}.`
    );
  }
  const key = url ? url[4] : identifier;
  const stacks =
    args.stackSync === false
      ? []
      : await listRemoteStacks(githubStackAPI(context));
  const candidates = stacks.filter(
    (s) =>
      String(s.number) === key ||
      activePRs(s).some(
        (pr) => String(pr.number) === key || pr.head.ref === key
      )
  );
  if (candidates.length > 1)
    throw new ExitFailedError(
      'Branch belongs to multiple GitHub stacks. Specify a stack number.'
    );
  const remote = candidates[0];
  let prs: GitHubPR[];
  let target: string;
  if (remote) {
    const active = activePRs(remote);
    const selected = active.findIndex(
      (pr) => String(pr.number) === key || pr.head.ref === key
    );
    const limit =
      String(remote.number) === key || args.remoteUpstack
        ? active.length
        : selected + 1;
    const entries =
      args.downstack && selected >= 0
        ? active.slice(0, selected + 1)
        : active.slice(0, limit || active.length);
    prs = entries.map((pr) => requirePR(client, pr.number));
    target = active[selected]?.head.ref ?? prs[prs.length - 1]?.headRefName;
  } else {
    const pr = requirePR(client, key);
    prs = [pr];
    target = pr.headRefName;
  }
  if (!target || !prs.length)
    throw new ExitFailedError('The GitHub stack has no open pull requests.');
  if (args.remoteUpstack) {
    const seen = new Set(prs.map((pr) => pr.number));
    // Follow PR base edges as well as native stack membership: GitHub permits
    // only one native Stack per PR, so forks are represented by multiple chains.
    for (let i = 0; i < prs.length; i++) {
      for (const number of client.openPRsBasedOn(prs[i].headRefName)) {
        if (!seen.has(number)) {
          seen.add(number);
          prs.push(requirePR(client, number));
        }
      }
    }
  }
  const branches = resolveAncestors(prs, client, context);
  const targetExistedLocally = context.engine.branchExists(target);
  importRemoteBranches(
    branches,
    {
      force: args.force,
      checkout: args.checkout === false ? undefined : target,
      // Like gt: newly fetched branches default to frozen so you can stack on
      // top of someone else's PRs without modifying them.
      freezeNew: args.unfrozen !== true,
    },
    context
  );
  if (context.githubStacks) {
    exportLocalStacks(context, context.githubStacks);
    recordRemoteStacks(stacks, context);
  }
  // Like gt: when the target already exists locally, local branches upstack
  // of it are also synced from remote unless --downstack is passed.
  if (targetExistedLocally && !args.downstack) {
    await updateBranchesFromRemote(
      context.engine.getRelativeStack(target, SCOPE.UPSTACK_EXCLUSIVE),
      { force: args.force },
      context
    );
  }
  if (args.deleteAll) {
    await syncPrInfo(context.engine.allBranchNames, context);
    await cleanBranches(
      { force: true, showDeleteProgress: false, trustOpenPRs: true },
      context
    );
  }
  if (args.restack && context.engine.branchExists(target)) {
    restackBranches(
      context.engine
        .getRelativeStack(target, SCOPE.STACK)
        .filter((branch) => !context.engine.isBranchFrozen(branch)),
      context
    );
  }
  context.splog.info(`Fetched GitHub stack through ${target}.`);
}

function requirePR(
  client: GitHubClient,
  identifier: string | number
): GitHubPR {
  const pr = client.viewPR(identifier);
  if (!pr)
    throw new ExitFailedError(`No pull request found for ${identifier}.`);
  if (pr.isCrossRepository) {
    throw new ExitFailedError(
      'Fork pull requests require an explicitly configured head remote; refusing to fetch from the wrong repository.'
    );
  }
  if (pr.state !== 'OPEN')
    throw new ExitFailedError(
      `PR #${
        pr.number
      } is ${pr.state.toLowerCase()}. Run gt sync to prune completed branches.`
    );
  return pr;
}

export function resolveAncestors(
  prs: GitHubPR[],
  client: GitHubClient,
  context: TContext
): RemoteBranch[] {
  const result: RemoteBranch[] = [];
  const seen = new Set<string>();
  const visit = (pr: GitHubPR): void => {
    if (result.some((b) => b.name === pr.headRefName)) return;
    if (seen.has(pr.headRefName))
      throw new ExitFailedError('Cycle in GitHub PR base branches.');
    seen.add(pr.headRefName);
    if (!context.engine.isTrunk(pr.baseRefName)) {
      const parent =
        prs.find((p) => p.headRefName === pr.baseRefName) ??
        client.viewPR(pr.baseRefName);
      if (!parent || parent.state !== 'OPEN') {
        throw new ExitFailedError(
          `Untracked GitHub base ${pr.baseRefName}. Configure it with gt trunk --add ${pr.baseRefName} or fetch its parent PR first.`
        );
      }
      visit(parent);
    }
    if (pr.isCrossRepository)
      throw new ExitFailedError(
        'Cannot import a fork PR from the configured base remote.'
      );
    result.push({ name: pr.headRefName, parent: pr.baseRefName, pr });
  };
  prs.forEach(visit);
  return result;
}

export function assertCleanForGet(): void {
  if (git(['status', '--porcelain']).length) {
    throw new ExitFailedError(
      'Commit or stash local changes (including untracked files) before fetching a stack.'
    );
  }
}

function assertNotOccupiedElsewhere(name: string, occupied: Set<string>): void {
  if (occupied.has(name))
    throw new ExitFailedError(`${name} is checked out in another worktree.`);
}

/** Fetch first, preflight EVERY ref, then update heads and metadata in one Git transaction. */
// eslint-disable-next-line max-lines-per-function
export function importRemoteBranches(
  branches: RemoteBranch[],
  args: {
    force: boolean;
    checkout?: string;
    keepExisting?: boolean;
    freezeNew?: boolean;
  },
  context: TContext
): void {
  assertCleanForGet();
  const remote = context.repoConfig.getRemote();
  const names = [...new Set(branches.flatMap((b) => [b.parent, b.name]))];
  names.forEach((name) => git(['check-ref-format', `refs/heads/${name}`]));
  git([
    'fetch',
    '--no-tags',
    remote,
    ...names.map(
      (name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`
    ),
  ]);
  const updates: string[] = [];
  const revisions = new Map<string, string>();
  const createdBranches = new Set<string>();
  const original = context.engine.currentBranch;
  const worktrees = git(['worktree', 'list', '--porcelain']).split('\n\n');
  const root = git(['rev-parse', '--show-toplevel']);
  const occupied = new Set(
    worktrees
      .filter((entry) => !entry.startsWith(`worktree ${root}\n`))
      .flatMap((entry) =>
        entry
          .split('\n')
          .filter((line) => line.startsWith('branch refs/heads/'))
          .map((line) => line.slice(18))
      )
  );
  for (const name of names) {
    const fetched = git(['rev-parse', `refs/remotes/${remote}/${name}`]);
    const existing = context.engine.branchExists(name)
      ? context.engine.getRevision(name)
      : undefined;
    const isTrunk = context.engine.isTrunk(name);
    const desired =
      existing && (isTrunk || args.keepExisting) ? existing : fetched;
    if (existing && desired !== existing) {
      assertNotOccupiedElsewhere(name, occupied);
      if (!args.force && git(['merge-base', existing, desired]) !== existing) {
        throw new ExitFailedError(
          `${name} has local commits or was rewritten remotely. No local branches changed; use gt get --force only to replace them.`
        );
      }
    }
    revisions.set(name, desired);
    if (!existing) createdBranches.add(name);
    if (desired !== existing)
      updates.push(
        existing
          ? `update refs/heads/${name} ${desired} ${existing}`
          : `create refs/heads/${name} ${desired}`
      );
  }
  for (const branch of branches) {
    if (
      args.keepExisting &&
      context.engine.branchExists(branch.name) &&
      context.engine.isBranchTracked(branch.name)
    )
      continue;
    const base = git([
      'merge-base',
      revisions.get(branch.name) as string,
      revisions.get(branch.parent) as string,
    ]);
    const previous = readMetadataRef(branch.name);
    const publishedHead = git([
      'rev-parse',
      `refs/remotes/${remote}/${branch.name}`,
    ]);
    const meta: TMeta = {
      ...previous,
      lastSubmittedVersion: makeSubmittedVersion(
        previous.lastSubmittedVersion,
        {
          headSha: publishedHead,
          baseSha: git([
            'merge-base',
            publishedHead,
            revisions.get(branch.parent) as string,
          ]),
          baseName: branch.parent,
        }
      ),
      parentBranchName: branch.parent,
      parentBranchRevision: base,
      prInfo: {
        id: branch.pr.id,
        number: branch.pr.number,
        base: branch.parent,
        remoteRevision: publishedHead,
        title: branch.pr.title,
        body: branch.pr.body,
        url: branch.pr.url,
        state: branch.pr.state,
        isDraft: branch.pr.isDraft,
        reviewDecision: branch.pr.reviewDecision || undefined,
      },
    };
    const sha = git(['hash-object', '-w', '--stdin'], JSON.stringify(meta));
    updates.push(`update refs/branch-metadata/${branch.name} ${sha}`);
  }
  // Detaching avoids leaving a checked-out branch with a stale index/worktree
  // while the ref transaction advances it. A clean worktree was required above.
  if (updates.length) {
    git(['switch', '--detach', 'HEAD']);
    try {
      git(
        ['update-ref', '--stdin'],
        `start\n${updates.join('\n')}\nprepare\ncommit\n`
      );
    } finally {
      if (original) git(['switch', original]);
    }
  }
  for (const branch of branches) {
    git(['config', `branch.${branch.name}.remote`, remote]);
    git(['config', `branch.${branch.name}.merge`, `refs/heads/${branch.name}`]);
  }
  context.engine.rebuild();
  if (args.freezeNew) {
    branches
      .filter((branch) => createdBranches.has(branch.name))
      .forEach((branch) => context.engine.freezeBranch(branch.name, true));
  }
  if (args.checkout) context.engine.checkoutBranch(args.checkout);
}

export function recordRemoteStacks(
  stacks: RemoteStack[],
  context: TContext
): void {
  const store = context.githubStacks;
  if (!store) return;
  for (const local of store.file.stacks) {
    const numbers = local.branches.flatMap((b) =>
      b.pullRequest ? [b.pullRequest.number] : []
    );
    const remote = stacks.find(
      (s) => s.open && activePRs(s).some((pr) => numbers.includes(pr.number))
    );
    if (!remote) continue;
    local.id = remote.node_id;
    local.number = remote.number;
    store.state.remote[String(remote.number)] = {
      base: remote.base.ref,
      prs: remote.pull_requests.map((pr) => pr.number),
    };
  }
  store.state.stacks = store.file.stacks;
  store.save();
}
