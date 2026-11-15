import chalk from 'chalk';
import { TContext } from '../../lib/context';
import { ExitFailedError } from '../../lib/errors';
import { GitHubClient } from '../../lib/github/client';

export type TPRSubmissionInfo = Array<
  {
    head: string;
    headSha: string;
    base: string;
    baseSha: string;
    title?: string;
    body?: string;
    reviewers: string[];
    draft?: boolean;
  } & (
    | { action: 'create'; title: string; body: string; draft: boolean }
    | { action: 'update'; prNumber: number }
  )
>;

export async function submitPullRequest(
  submissionInfo: TPRSubmissionInfo,
  context: TContext
): Promise<void> {
  const client = GitHubClient.fromConfig(context.repoConfig);
  for (const request of submissionInfo) {
    const existing = client.viewPR(
      request.action === 'update' ? request.prNumber : request.head
    );
    if (existing?.isCrossRepository)
      throw new ExitFailedError(
        'Fork PR submission requires an explicitly configured head remote; refusing to push to the base repository.'
      );
    if (existing && existing.headRefName !== request.head) {
      throw new ExitFailedError(
        `PR #${existing.number} does not belong to ${request.head}.`
      );
    }
    if (request.action === 'update' && existing?.state !== 'OPEN') {
      throw new ExitFailedError(
        `PR #${request.prNumber} is no longer open. Run gt sync before submitting.`
      );
    }
    const updating = existing?.state === 'OPEN';
    if (updating) {
      const edits = [
        ...(existing.baseRefName !== request.base
          ? ['--base', request.base]
          : []),
        ...(request.title !== undefined && request.title !== existing.title
          ? ['--title', request.title]
          : []),
        ...(request.body !== undefined && request.body !== existing.body
          ? ['--body-file', '-']
          : []),
        ...(request.reviewers.length
          ? ['--add-reviewer', request.reviewers.join(',')]
          : []),
      ];
      if (edits.length)
        client.pr(['edit', String(existing.number), ...edits], request.body);
      if (request.draft !== undefined && request.draft !== existing.isDraft) {
        client.pr([
          'ready',
          String(existing.number),
          ...(request.draft ? ['--undo'] : []),
        ]);
      }
    } else {
      client.pr(
        [
          'create',
          '--head',
          request.head,
          '--base',
          request.base,
          '--title',
          request.title || request.head,
          '--body-file',
          '-',
          ...(request.draft ? ['--draft'] : []),
          ...(request.reviewers.length
            ? ['--reviewer', request.reviewers.join(',')]
            : []),
        ],
        request.body || ''
      );
    }
    const pr = client.viewPR(updating ? existing.number : request.head);
    if (!pr || pr.state !== 'OPEN')
      throw new ExitFailedError(
        `Unable to verify the submitted PR for ${request.head}. Retry gt submit.`
      );
    context.engine.upsertPrInfo(request.head, {
      id: pr.id,
      number: pr.number,
      url: pr.url,
      base: pr.baseRefName,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision || undefined,
    });
    context.engine.recordPublishedVersion(request.head, {
      headSha: request.headSha,
      baseSha: request.baseSha,
      baseName: request.base,
    });
    context.splog.info(
      `${chalk.green(request.head)}: ${pr.url} (${
        updating ? 'updated' : 'created'
      })`
    );
  }
}
