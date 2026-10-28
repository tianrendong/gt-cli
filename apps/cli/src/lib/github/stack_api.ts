import { GitHubClient, GitHubError, settledValue } from './client';

/** Public REST Stack API used by github/gh-stack (not Graphite's API). */
export type RemoteStackPR = {
  number: number;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
};
export type RemoteStack = {
  id: number;
  node_id: string;
  number: number;
  url: string;
  base: { ref: string; sha: string };
  open: boolean;
  pull_requests: RemoteStackPR[];
};

export function validateRemoteStack(value: RemoteStack): RemoteStack {
  if (
    !value ||
    !Number.isInteger(value.number) ||
    !value.base?.ref ||
    !Array.isArray(value.pull_requests) ||
    value.pull_requests.some(
      (pr) => !Number.isInteger(pr.number) || !pr.head?.ref
    )
  ) {
    throw new GitHubError(
      'Invalid response from GitHub Stacks API. No stack metadata was overwritten.'
    );
  }
  return value;
}

export class StackAPI {
  constructor(readonly client: GitHubClient) {}

  /** Every stack, in listing order. Large repositories have many pages, so
   * fetch the pages GitHub advertises up to eight at a time; without an
   * advertised count, or if the listing grew meanwhile, continue page by page.
   */
  async list(): Promise<RemoteStack[]> {
    const path = (page: number) =>
      `${this.client.repoPath}/stacks?per_page=100&page=${page}`;
    const validatePage = (batch: RemoteStack[]): RemoteStack[] => {
      if (!Array.isArray(batch))
        throw new GitHubError('Invalid response from GitHub Stacks API.');
      return batch.map(validateRemoteStack);
    };
    const first = await this.client.apiGetPage<RemoteStack[]>(path(1));
    const pages = [validatePage(first.body)];
    let next = 2;
    if (first.lastPage !== undefined && first.lastPage > 1) {
      const advertised = Array.from(
        { length: first.lastPage - 1 },
        (_, index) => index + 2
      );
      for (let offset = 0; offset < advertised.length; offset += 8) {
        const chunk = advertised.slice(offset, offset + 8);
        const results = await Promise.allSettled(
          chunk.map((page) => this.client.apiGet<RemoteStack[]>(path(page)))
        );
        for (const result of results)
          pages.push(validatePage(settledValue(result)));
      }
      next = first.lastPage + 1;
    }
    while (pages[pages.length - 1].length === 100) {
      pages.push(
        validatePage(await this.client.apiGet<RemoteStack[]>(path(next++)))
      );
    }
    return pages.flat();
  }

  get(number: number): RemoteStack {
    return validateRemoteStack(
      this.client.api('GET', `${this.client.repoPath}/stacks/${number}`)
    );
  }

  create(prNumbers: number[]): RemoteStack {
    return validateRemoteStack(
      this.client.api('POST', `${this.client.repoPath}/stacks`, {
        pull_requests: prNumbers,
      })
    );
  }

  append(number: number, prNumbers: number[]): RemoteStack {
    return validateRemoteStack(
      this.client.api('POST', `${this.client.repoPath}/stacks/${number}/add`, {
        pull_requests: prNumbers,
      })
    );
  }

  unstack(number: number): RemoteStack | undefined {
    const response = this.client.api<RemoteStack | undefined>(
      'POST',
      `${this.client.repoPath}/stacks/${number}/unstack`
    );
    const remaining = response ? validateRemoteStack(response) : undefined;
    // GitHub keeps merged history. Only unmerged survivors indicate locks.
    if (remaining?.pull_requests.some((pr) => !pr.merged_at)) {
      throw new GitHubError(
        `GitHub stack #${number} still contains locked PRs (merge queue or auto-merge). ` +
          'No replacement stack was created. Resolve the locks and retry gt submit or gt github sync.'
      );
    }
    return remaining;
  }
}
