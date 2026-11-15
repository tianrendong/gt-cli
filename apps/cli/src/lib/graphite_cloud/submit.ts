import { createHash } from 'crypto';
import { TContext } from '../context';
import { ExitFailedError } from '../errors';
import { GitHubClient } from '../github/client';
import { gitDirectory } from '../github/stack_file';
import {
  GraphiteCloudClient,
  GraphiteCloudError,
  GraphiteRequest,
  graphiteToken,
} from './client';
import { graphiteSubmitSetting } from './settings';
import { GraphiteSubmissionState } from './state';
import { mirrorSnapshot, Pull } from './snapshot';

type Plan = {
  branch: string;
  snapshot: Pull;
  request: GraphiteRequest;
  fingerprint: string;
};
type Options = {
  dryRun: boolean;
  always: boolean;
  targetTrunk?: string;
  stackSync: boolean;
};
function order(plans: Plan[]): Plan[] {
  const byName = new Map(plans.map((plan) => [plan.branch, plan]));
  const ordered: Plan[] = [],
    active = new Set<string>(),
    done = new Set<string>();
  const visit = (plan: Plan) => {
    if (done.has(plan.branch)) return;
    if (active.has(plan.branch))
      throw new GraphiteCloudError(
        'protocol',
        'GitHub PR bases form a cycle; Graphite mirroring was not started.'
      );
    active.add(plan.branch);
    const parent = byName.get(plan.snapshot.base.ref);
    if (parent) visit(parent);
    active.delete(plan.branch);
    done.add(plan.branch);
    ordered.push(plan);
  };
  plans.forEach(visit);
  return ordered;
}

export class GraphiteSubmission {
  constructor(
    private readonly context: TContext,
    private readonly options: Options,
    private readonly clients: {
      github: GitHubClient;
      cloud: GraphiteCloudClient;
      state: GraphiteSubmissionState;
    }
  ) {}

  private plan(branch: string, pr: Pull): Plan[] {
    if (pr.state !== 'open') return [];
    const prInfo = this.context.engine.getPrInfo(branch)!;
    const parent = this.context.engine.getParentPrecondition(branch);
    const base =
      prInfo.base ??
      (this.context.engine.isTrunk(parent)
        ? this.options.targetTrunk ?? parent
        : parent);
    if (
      pr.head.ref !== branch ||
      pr.head.sha !== this.context.engine.getRevision(branch) ||
      pr.base.ref !== base ||
      (prInfo.id && prInfo.id !== pr.node_id)
    )
      throw new GraphiteCloudError(
        'protocol',
        `PR #${pr.number} changed since GitHub submission. Rerun gt submit before mirroring it.`
      );
    const request: GraphiteRequest = {
      repoOwner: this.clients.github.repository.owner,
      repoName: this.clients.github.repository.name,
      trunkBranchName:
        this.options.targetTrunk ?? this.context.engine.getTrunk(branch),
      prs: [
        {
          action: 'update',
          head: branch,
          headSha: pr.head.sha,
          base: pr.base.ref,
          baseSha: pr.base.sha,
          prNumber: pr.number,
        },
      ],
    };
    // Preserve per-PR fingerprints, including receipts written by 0.6.16.
    return [
      {
        branch,
        snapshot: pr,
        request,
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ request, nodeId: pr.node_id }))
          .digest('hex'),
      },
    ];
  }

  async sync(branches: string[]): Promise<void> {
    const { github, cloud, state } = this.clients;
    let completed = 0,
      total = 0;
    try {
      const candidates = [...new Set(branches)].flatMap((branch) => {
        const prInfo = this.context.engine.getPrInfo(branch);
        return prInfo?.number
          ? [{ branch, prInfo, number: prInfo.number }]
          : [];
      });
      const numbers = candidates.map((c) => c.number);
      const before = await mirrorSnapshot(
        github,
        numbers,
        this.options.stackSync
      );
      const sorted = order(
        candidates.flatMap(({ branch, number }) =>
          this.plan(branch, before.get(number)!.pull)
        )
      );
      total = sorted.length;
      const pending = sorted.filter(
        (plan) =>
          this.options.always ||
          !state.submitted(plan.snapshot.number, plan.fingerprint)
      );
      completed = total - pending.length;
      const successes: Plan[] = [];
      let attempted = false,
        failure: unknown;
      // Match native Graphite: one PR per POST, sequentially in parent order.
      // Stop at the first failure; do not mark unattempted PRs as pending.
      try {
        for (const plan of pending) {
          state.record(plan.snapshot.number, plan.fingerprint, 'pending');
          attempted = true;
          await cloud.update(plan.request);
          successes.push(plan);
        }
      } catch (error) {
        failure = error;
      }
      if (attempted) {
        // Keep just two snapshot phases, not two queries per POST. Even a
        // failed/ambiguous POST may have changed remote state. Verify every
        // selected PR, including receipt-skipped PRs, before checkpointing.
        const after = await mirrorSnapshot(
          github,
          numbers,
          this.options.stackSync
        );
        if (
          numbers.some(
            (number) =>
              JSON.stringify(before.get(number)) !==
              JSON.stringify(after.get(number))
          )
        )
          throw new GraphiteCloudError(
            'protocol',
            'GitHub PR or stack metadata changed during Graphite submission. Inspect both services before retrying; no changes were rolled back.'
          );
        for (const plan of successes) {
          state.record(plan.snapshot.number, plan.fingerprint, 'submitted');
          completed++;
          this.context.splog.info(
            `Graphite: PR #${plan.snapshot.number} mirrored.`
          );
        }
      }
      if (failure) throw failure;
      this.context.splog.info(
        `Graphite: ${completed} open PR${
          completed === 1 ? '' : 's'
        } synchronized.`
      );
    } catch (error) {
      const detail =
        error instanceof GraphiteCloudError
          ? error.message
          : 'Could not verify or checkpoint Graphite synchronization.';
      throw new ExitFailedError(
        `GitHub submission completed, but Graphite mirroring is incomplete (${completed}/${total}). ${detail}\nRerun gt submit --no-edit to retry; successful GitHub work and publication leases were kept.`
      );
    }
  }
}

/** Run before any GitHub writes; disabled mode never reads Graphite credentials. */
export function prepareGraphiteSubmission(
  context: TContext,
  options: Options & { branches: string[] },
  dependencies: {
    github?: GitHubClient;
    cloud?: () => GraphiteCloudClient;
    state?: () => GraphiteSubmissionState;
  } = {}
): GraphiteSubmission | undefined {
  if (!options.branches.length || !graphiteSubmitSetting().enabled)
    return undefined;
  const github =
    dependencies.github ?? GitHubClient.fromConfig(context.repoConfig);
  if (github.repository.host !== 'github.com')
    throw new ExitFailedError(
      'Graphite cloud mirroring supports github.com repositories only. Disable submit.graphite for this repository before submitting.'
    );
  if (options.dryRun) {
    context.splog.info(
      'Graphite mirroring enabled: would synchronize existing PRs after GitHub submission. No Graphite request in dry-run mode.'
    );
    return undefined;
  }
  const cloud =
    dependencies.cloud?.() ?? new GraphiteCloudClient(graphiteToken());
  const state =
    dependencies.state?.() ??
    new GraphiteSubmissionState(gitDirectory(), github.qualifiedRepo);
  return new GraphiteSubmission(context, options, { github, cloud, state });
}
