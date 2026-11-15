import * as t from '../retype';
import { GitHubClient } from '../github/client';
import { ExitFailedError } from '../errors';
import { repoConfigFactory, TRepoConfig } from '../spiffy/repo_config_spf';

const reviewDecisionSchema = t.optional(
  t.unionMany([
    t.literal('APPROVED' as const),
    t.literal('REVIEW_REQUIRED' as const),
    t.literal('CHANGES_REQUESTED' as const),
  ])
);
export const prInfoToUpsertSchema = t.array(
  t.shape({
    id: t.optional(t.string),
    state: t.unionMany([
      t.literal('OPEN' as const),
      t.literal('MERGED' as const),
      t.literal('CLOSED' as const),
    ]),
    url: t.string,
    title: t.string,
    body: t.string,
    prNumber: t.number,
    headRefName: t.string,
    /** Remote head revision GitHub reports; sync compares it with the local branch. */
    headRefOid: t.optional(t.string),
    baseRefName: t.string,
    reviewDecision: reviewDecisionSchema,
    isDraft: t.boolean,
  })
);
export type TPRInfoToUpsert = t.TypeOf<typeof prInfoToUpsertSchema>;

export async function getPrInfoForBranches(
  branches: { branchName: string; prNumber: number | undefined }[],
  config: TRepoConfig = repoConfigFactory.load()
): Promise<TPRInfoToUpsert> {
  if (!branches.length) return [];
  const client = GitHubClient.fromConfig(config);
  // Independent read-only queries: run them concurrently.
  const [known, unlinked] = await Promise.all([
    client.viewPRsAsync(
      branches.flatMap((branch) =>
        branch.prNumber === undefined ? [] : [branch.prNumber]
      )
    ),
    client.viewOpenPRsByBranchAsync(
      branches.flatMap((branch) =>
        branch.prNumber === undefined ? [branch.branchName] : []
      )
    ),
  ]);
  const result: TPRInfoToUpsert = [];
  for (const branch of branches) {
    const pr =
      branch.prNumber === undefined
        ? unlinked.get(branch.branchName)
        : known.get(branch.prNumber);
    if (
      !pr ||
      pr.headRefName !== branch.branchName ||
      (!branch.prNumber && pr.state !== 'OPEN')
    )
      continue;
    if (pr.isCrossRepository)
      throw new ExitFailedError(
        `PR #${pr.number} belongs to a fork. Configure an explicit head remote before syncing or submitting it.`
      );
    result.push({
      id: pr.id,
      prNumber: pr.number,
      url: pr.url,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      headRefName: pr.headRefName,
      headRefOid: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pr.headRefOid ?? '')
        ? pr.headRefOid
        : undefined,
      baseRefName: pr.baseRefName,
      reviewDecision: pr.reviewDecision || undefined,
      isDraft: pr.isDraft,
    });
  }
  // Authentication/network errors are not an empty repository. Let the caller
  // fail before creating duplicate PRs or pruning based on stale metadata.
  return result;
}
