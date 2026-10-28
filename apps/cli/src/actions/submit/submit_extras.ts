import { TContext } from '../../lib/context';
import { GitHubClient } from '../../lib/github/client';

export async function submitExtras(
  args: {
    comment?: string;
    mergeWhenReady?: boolean;
    rerequestReview?: boolean;
  },
  branches: string[],
  context: TContext
): Promise<void> {
  if (!args.comment && !args.mergeWhenReady && !args.rerequestReview) return;
  const client = GitHubClient.fromConfig(context.repoConfig);
  for (const branch of branches) {
    const pr = context.engine.getPrInfo(branch);
    if (!pr?.number || pr.state !== 'OPEN') continue;
    const number = String(pr.number);
    if (args.rerequestReview) {
      const data: { reviews: { author?: { login: string } }[] } = JSON.parse(
        client.pr(['view', number, '--json', 'reviews'])
      );
      const reviewers = [
        ...new Set(
          data.reviews.flatMap((review) =>
            review.author?.login ? [review.author.login] : []
          )
        ),
      ];
      if (reviewers.length)
        client.pr(['edit', number, '--add-reviewer', reviewers.join(',')]);
    }
    if (args.comment)
      client.pr(['comment', number, '--body-file', '-'], args.comment);
    if (args.mergeWhenReady) {
      client.pr([
        'merge',
        number,
        '--auto',
        '--squash',
        '--match-head-commit',
        context.engine.getRevision(branch),
      ]);
    }
  }
}
