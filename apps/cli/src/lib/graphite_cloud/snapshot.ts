import { GitHubClient } from '../github/client';
import { GraphiteCloudError } from './client';

export type Pull = {
  number: number;
  node_id: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
};
type Entry = {
  position: number;
  pullRequest: { number: number; headRefName: string };
};
type Stack = {
  number: number;
  baseRefName: string;
  size: number;
  entries: { nodes: Entry[] };
};
type Node = {
  number: number;
  id: string;
  state: string;
  title: string;
  body: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  headRepository: { nameWithOwner: string };
  baseRepository: { nameWithOwner: string };
  stack?: Stack | null;
};
const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
function invalid(): never {
  throw new GraphiteCloudError(
    'protocol',
    'Invalid or incomplete GitHub mirror snapshot (including cross-repository identity).'
  );
}

/** Fresh identities and membership in one query per 50 PRs; never use a cache.
 * Reject truncated membership, missing aliases, and partial GraphQL responses.
 */
export async function mirrorSnapshot(
  client: GitHubClient,
  numbers: number[],
  stackSync: boolean
): Promise<Map<number, { pull: Pull; stack?: string }>> {
  const unique = [...new Set(numbers)];
  if (unique.some((n) => !positive(n))) invalid();
  const result = new Map<number, { pull: Pull; stack?: string }>();
  const repo =
    `${client.repository.owner}/${client.repository.name}`.toLowerCase();
  for (let offset = 0; offset < unique.length; offset += 50) {
    const chunk = unique.slice(offset, offset + 50);
    const fields =
      'number id state title body isDraft headRefName headRefOid baseRefName baseRefOid headRepository{nameWithOwner} baseRepository{nameWithOwner}' +
      (stackSync
        ? ' stack{number baseRefName size entries(first:100){nodes{position pullRequest{number headRefName}}}}'
        : '');
    const selections = chunk
      .map((n, i) => `p${i}:pullRequest(number:${n}){${fields}}`)
      .join(' ');
    const data = await client.query<{ repository: Record<string, Node> }>(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${selections}}}`
    );
    for (const [i, number] of chunk.entries()) {
      const node = data.repository?.[`p${i}`];
      if (
        !node ||
        node.number !== number ||
        typeof node.id !== 'string' ||
        !node.id ||
        !['OPEN', 'CLOSED', 'MERGED'].includes(node.state) ||
        typeof node.title !== 'string' ||
        typeof node.body !== 'string' ||
        typeof node.isDraft !== 'boolean' ||
        !node.headRefName ||
        !node.baseRefName ||
        !sha.test(node.headRefOid) ||
        !sha.test(node.baseRefOid) ||
        node.headRepository?.nameWithOwner?.toLowerCase() !== repo ||
        node.baseRepository?.nameWithOwner?.toLowerCase() !== repo
      )
        invalid();
      let stack: string | undefined;
      if (stackSync) {
        const s = node.stack;
        if (s === null) stack = 'null';
        else {
          const entries = s?.entries?.nodes;
          if (
            !s ||
            !positive(s.number) ||
            !s.baseRefName ||
            !Array.isArray(entries) ||
            !positive(s.size) ||
            entries.length !== s.size ||
            entries.some(
              (e) =>
                !e ||
                !Number.isSafeInteger(e.position) ||
                !positive(e.pullRequest?.number) ||
                !e.pullRequest?.headRefName
            ) ||
            new Set(entries.map((e) => e.position)).size !== entries.length ||
            new Set(entries.map((e) => e.pullRequest.number)).size !==
              entries.length ||
            !entries.some((e) => e.pullRequest.number === number)
          )
            invalid();
          stack = JSON.stringify({
            number: s.number,
            base: s.baseRefName,
            entries: [...entries].sort((a, b) => a.position - b.position),
          });
        }
      }
      result.set(number, {
        pull: {
          number,
          node_id: node.id,
          state: node.state === 'OPEN' ? 'open' : 'closed',
          title: node.title,
          body: node.body,
          draft: node.isDraft,
          head: {
            ref: node.headRefName,
            sha: node.headRefOid,
            repo: { full_name: repo },
          },
          base: {
            ref: node.baseRefName,
            sha: node.baseRefOid,
            repo: { full_name: repo },
          },
        },
        stack,
      });
    }
  }
  return result;
}
