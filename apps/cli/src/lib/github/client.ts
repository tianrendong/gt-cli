import { execFile, spawnSync } from 'child_process';
import { ExitFailedError } from '../errors';
import { TRepoConfig } from '../spiffy/repo_config_spf';

export type GitHubRepository = { host: string; owner: string; name: string };
export type GhRunner = (args: string[], input?: string) => string;
export type GhAsyncRunner = (args: string[], input?: string) => Promise<string>;

export class GitHubError extends ExitFailedError {
  readonly status: number | undefined;

  constructor(message: string) {
    super(message);
    this.status = Number(message.match(/HTTP (\d{3})/)?.[1]) || undefined;
  }
}

/** Never invoke a shell or put credentials in argv, logs, or repository metadata. */
export const runGh: GhRunner = (args, input) => {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new GitHubError(
      result.error?.message ||
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `GitHub CLI failed (exit ${result.status}, signal ${result.signal}).`
    );
  }
  return result.stdout.trim();
};

/** The asynchronous counterpart keeps gh's credential, proxy, and host handling.
 * Use it for independent reads, never to parallelize publication mutations.
 */
export const runGhAsync: GhAsyncRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitHubError(
              (typeof error.code === 'string' ? error.message : undefined) ||
                stderr.trim() ||
                stdout.trim() ||
                `GitHub CLI failed (exit ${error.code}, signal ${error.signal}).`
            )
          );
        } else resolve(stdout.trim());
      }
    );
    // A child can exit before consuming stdin; its callback owns the error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });

export function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

export type ApiPage<T> = { body: T; lastPage: number | undefined };
/** gh -i prints the status line and headers before the body. Runners without
 * header support return the body alone: a single page of unknown extent.
 */
function parsePage<T>(output: string, path: string): ApiPage<T> {
  if (!/^HTTP\/\d/.test(output))
    return { body: apiOutput<T>(output, 'GET', path), lastPage: undefined };
  const separator = output.search(/\r?\n\r?\n/);
  if (separator < 0)
    throw new GitHubError(
      `GitHub returned an invalid response for GET ${path}.`
    );
  const headers = output.slice(0, separator).split(/\r?\n/);
  const body = output.slice(separator).replace(/^\r?\n\r?\n/, '');
  const link = headers.find((header) => /^link:/i.test(header));
  const last = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1];
  return {
    body: apiOutput<T>(body, 'GET', path),
    lastPage: last ? Number(last) : undefined,
  };
}

export type StackMembership = {
  number: number;
  base: string;
  prs: { number: number; branch: string }[];
};

function apiOutput<T>(output: string, method: string, path: string): T {
  try {
    return (output ? JSON.parse(output) : undefined) as T;
  } catch {
    throw new GitHubError(
      `GitHub returned invalid JSON for ${method} ${path}.`
    );
  }
}

export class GitHubClient {
  readonly repository: GitHubRepository;
  readonly qualifiedRepo: string;
  readonly repoPath: string;
  private readonly runAsync: GhAsyncRunner;

  constructor(
    repository: GitHubRepository,
    private readonly run: GhRunner = runGh,
    runAsync?: GhAsyncRunner
  ) {
    this.runAsync =
      runAsync ??
      (run === runGh ? runGhAsync : async (args, input) => run(args, input));
    this.repository = repository;
    this.qualifiedRepo = `${repository.host}/${repository.owner}/${repository.name}`;
    this.repoPath = `repos/${encodeURIComponent(
      repository.owner
    )}/${encodeURIComponent(repository.name)}`;
  }

  static fromConfig(config: TRepoConfig): GitHubClient {
    return new GitHubClient(config.getRepoIdentity());
  }

  api<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): T {
    const output = this.run(
      [
        'api',
        '--hostname',
        this.repository.host,
        '--method',
        method,
        '-H',
        'Accept: application/vnd.github+json',
        path,
        ...(body === undefined ? [] : ['--input', '-']),
      ],
      body === undefined ? undefined : JSON.stringify(body)
    );
    return apiOutput<T>(output, method, path);
  }

  /** Read-only GraphQL with gh's existing authentication and host handling. */
  async query<T>(query: string): Promise<T> {
    if (!/^query\b/.test(query))
      throw new GitHubError('Expected a GraphQL query.');
    const output = await this.runAsync([
      'api',
      '--hostname',
      this.repository.host,
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${this.repository.owner}`,
      '-f',
      `name=${this.repository.name}`,
    ]);
    const response = apiOutput<{ data?: T; errors?: unknown }>(
      output,
      'query',
      'graphql'
    );
    if (
      !response?.data ||
      (response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length > 0))
    )
      throw new GitHubError('GitHub returned an incomplete GraphQL query.');
    return response.data;
  }

  /** A fresh, read-only REST request with the same wire format as api('GET'). */
  async apiGet<T>(path: string): Promise<T> {
    const output = await this.runAsync([
      'api',
      '--hostname',
      this.repository.host,
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      path,
    ]);
    return apiOutput<T>(output, 'GET', path);
  }

  /** Same GET, including response headers (RFC 8288 Link rel="last" pagination). */
  async apiGetPage<T>(path: string): Promise<ApiPage<T>> {
    const output = await this.runAsync([
      'api',
      '-i',
      '--hostname',
      this.repository.host,
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      path,
    ]);
    return parsePage<T>(output, path);
  }

  /** Native Stack membership for explicit PR numbers, in one read-only GraphQL
   * query per 50 PRs. Equivalent to listing every repository stack and keeping
   * the ones containing these PRs: GitHub keeps a PR in at most one stack.
   */
  async stackMembership(
    numbers: readonly number[]
  ): Promise<Map<number, StackMembership | undefined>> {
    const unique = [...new Set(numbers)];
    if (unique.some((number) => !Number.isSafeInteger(number) || number < 1))
      throw new GitHubError('Invalid pull request number.');
    type Entry = {
      position: number;
      pullRequest: { number: number; headRefName: string } | null;
    };
    type Node = {
      number: number;
      stack: {
        number: number;
        baseRefName: string;
        size: number;
        entries: { nodes: (Entry | null)[] };
      } | null;
    } | null;
    const result = new Map<number, StackMembership | undefined>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const chunk = unique.slice(offset, offset + 50);
      const pulls = chunk
        .map(
          (number, index) =>
            `p${index}:pullRequest(number:${number}){number stack{number baseRefName size ` +
            'entries(first:100){nodes{position pullRequest{number headRefName}}}}}'
        )
        .join(' ');
      const output = await this.runAsync([
        'api',
        '--hostname',
        this.repository.host,
        'graphql',
        '-f',
        `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${pulls}}}`,
        '-f',
        `owner=${this.repository.owner}`,
        '-f',
        `name=${this.repository.name}`,
      ]);
      let response: {
        data?: { repository?: Record<string, Node> | null };
        errors?: unknown;
      };
      try {
        response = JSON.parse(output);
      } catch {
        throw new GitHubError(
          'GitHub returned invalid JSON for stack membership.'
        );
      }
      const repository = response?.data?.repository;
      if (
        !repository ||
        (response.errors !== undefined &&
          (!Array.isArray(response.errors) || response.errors.length > 0))
      )
        throw new GitHubError(
          'GitHub returned an incomplete stack membership query.'
        );
      for (const [index, number] of chunk.entries()) {
        const node = repository[`p${index}`];
        if (!node || node.number !== number)
          throw new GitHubError(
            `GitHub returned an invalid pull request for #${number}.`
          );
        if (node.stack === null) {
          result.set(number, undefined);
          continue;
        }
        const stack = node.stack;
        const entries = stack?.entries?.nodes;
        if (
          !stack ||
          !Number.isInteger(stack.number) ||
          !stack.baseRefName ||
          !Array.isArray(entries) ||
          entries.length !== stack.size ||
          entries.some(
            (entry) =>
              !entry?.pullRequest ||
              !Number.isInteger(entry.position) ||
              !Number.isInteger(entry.pullRequest.number) ||
              !entry.pullRequest.headRefName
          )
        )
          throw new GitHubError(
            `GitHub returned an invalid or oversized stack for PR #${number}.`
          );
        result.set(number, {
          number: stack.number,
          base: stack.baseRefName,
          prs: [...(entries as Entry[])]
            .sort((a, b) => a.position - b.position)
            .map((entry) => ({
              number: (entry.pullRequest as { number: number }).number,
              branch: (entry.pullRequest as { headRefName: string })
                .headRefName,
            })),
        });
      }
    }
    return result;
  }

  openPRsBasedOn(branch: string): number[] {
    const numbers: number[] = [];
    for (let page = 1; ; page++) {
      const batch = this.api<{ number: number }[]>(
        'GET',
        `${this.repoPath}/pulls?state=open&base=${encodeURIComponent(
          branch
        )}&per_page=100&page=${page}`
      );
      if (
        !Array.isArray(batch) ||
        batch.some((pr) => !Number.isInteger(pr.number))
      )
        throw new GitHubError('Invalid pull request list from GitHub.');
      numbers.push(...batch.map((pr) => pr.number));
      if (batch.length < 100) return numbers;
    }
  }

  pr(args: string[], input?: string): string {
    return this.run(['pr', ...args, '--repo', this.qualifiedRepo], input);
  }

  /** Batch only explicit PR numbers. Branch-name resolution stays with gh so
   * reopened PRs, forks, and ambiguous heads retain gh's selection semantics.
   * These are read-only GraphQL queries using the same fields as `gh pr view`.
   */
  viewPRs(numbers: readonly number[]): Map<number, GitHubPR | undefined> {
    const result = new Map<number, GitHubPR | undefined>();
    for (const chunk of prNumberChunks(numbers)) {
      let output: string;
      try {
        output = this.run(this.prNumbersQuery(chunk));
      } catch (error) {
        this.recoverMissingPRs(error, chunk, result);
        continue;
      }
      parsePRNumbersResponse(output, chunk, result);
    }
    return result;
  }

  /** viewPRs with every chunk in flight at once. Independent reads only. */
  async viewPRsAsync(
    numbers: readonly number[]
  ): Promise<Map<number, GitHubPR | undefined>> {
    const chunks = prNumberChunks(numbers);
    const outputs = await Promise.allSettled(
      chunks.map((chunk) => this.runAsync(this.prNumbersQuery(chunk)))
    );
    const result = new Map<number, GitHubPR | undefined>();
    for (const [index, settled] of outputs.entries()) {
      if (settled.status === 'rejected') {
        this.recoverMissingPRs(settled.reason, chunks[index], result);
        continue;
      }
      parsePRNumbersResponse(settled.value, chunks[index], result);
    }
    return result;
  }

  private prNumbersQuery(chunk: number[]): string[] {
    const fields =
      'id number url state title body headRefName headRefOid baseRefName isDraft reviewDecision isCrossRepository';
    const pulls = chunk
      .map(
        (number, index) => `p${index}:pullRequest(number:${number}){${fields}}`
      )
      .join(' ');
    return [
      'api',
      '--hostname',
      this.repository.host,
      'graphql',
      '-f',
      `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${pulls}}}`,
      '-f',
      `owner=${this.repository.owner}`,
      '-f',
      `name=${this.repository.name}`,
    ];
  }

  /** gh exits nonzero for a missing alias even when other PRs resolved.
   * Reuse its single-PR missing/auth/error behavior; never interpret a
   * partial query failure as an empty repository or drop known PRs. */
  private recoverMissingPRs(
    error: unknown,
    chunk: number[],
    result: Map<number, GitHubPR | undefined>
  ): void {
    if (
      !(error instanceof Error) ||
      !/Could not resolve to a PullRequest/.test(error.message)
    )
      throw error;
    for (const number of chunk) result.set(number, this.viewPR(number));
  }

  /** Open PRs for explicit head branch names, batched read-only. A branch with
   * exactly one open PR resolves like `gh pr view <branch>`; with several open
   * PRs gh's own tie-breaking is kept by falling back to it per branch. Closed
   * or merged PRs are never returned here: name lookups only accept open PRs.
   */
  viewOpenPRsByBranch(
    branches: readonly string[]
  ): Map<string, GitHubPR | undefined> {
    const result = new Map<string, GitHubPR | undefined>();
    for (const chunk of branchChunks(branches)) {
      const output = this.run(this.branchHeadsQuery(chunk));
      this.parseBranchHeadsResponse(output, chunk, result);
    }
    return result;
  }

  /** viewOpenPRsByBranch with every chunk in flight at once. */
  async viewOpenPRsByBranchAsync(
    branches: readonly string[]
  ): Promise<Map<string, GitHubPR | undefined>> {
    const chunks = branchChunks(branches);
    const outputs = await Promise.all(
      chunks.map((chunk) => this.runAsync(this.branchHeadsQuery(chunk)))
    );
    const result = new Map<string, GitHubPR | undefined>();
    for (const [index, output] of outputs.entries())
      this.parseBranchHeadsResponse(output, chunks[index], result);
    return result;
  }

  private branchHeadsQuery(chunk: string[]): string[] {
    const fields =
      'id number url state title body headRefName headRefOid baseRefName isDraft reviewDecision isCrossRepository';
    const variables = chunk.map((_, index) => `$head${index}:String!`);
    const selections = chunk
      .map(
        (_, index) =>
          `b${index}:pullRequests(headRefName:$head${index},states:OPEN,first:2){nodes{${fields}}}`
      )
      .join(' ');
    return [
      'api',
      '--hostname',
      this.repository.host,
      'graphql',
      '-f',
      `query=query($owner:String!,$name:String!,${variables.join(
        ','
      )}){repository(owner:$owner,name:$name){${selections}}}`,
      '-f',
      `owner=${this.repository.owner}`,
      '-f',
      `name=${this.repository.name}`,
      ...chunk.flatMap((branch, index) => ['-f', `head${index}=${branch}`]),
    ];
  }

  private parseBranchHeadsResponse(
    output: string,
    chunk: string[],
    result: Map<string, GitHubPR | undefined>
  ): void {
    let response: {
      data?: {
        repository?: Record<string, { nodes?: (GitHubPR | null)[] } | null>;
      } | null;
      errors?: unknown;
    };
    try {
      response = JSON.parse(output);
    } catch {
      throw new GitHubError('GitHub returned invalid JSON for pull requests.');
    }
    const repository = response?.data?.repository;
    if (
      !repository ||
      (response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length > 0))
    )
      throw new GitHubError(
        'GitHub returned an incomplete pull request query.'
      );
    for (const [index, branch] of chunk.entries()) {
      const nodes = repository[`b${index}`]?.nodes;
      if (!Array.isArray(nodes))
        throw new GitHubError('GitHub returned an invalid pull request list.');
      const open = nodes.filter((pr) => pr?.state === 'OPEN');
      if (open.length > 1) {
        result.set(branch, this.viewPR(branch));
        continue;
      }
      const pr = open[0];
      if (!pr) {
        result.set(branch, undefined);
      } else if (
        !Number.isInteger(pr.number) ||
        !pr.headRefName ||
        !pr.baseRefName
      ) {
        throw new GitHubError('GitHub returned an invalid pull request.');
      } else {
        result.set(branch, {
          ...pr,
          reviewDecision: pr.reviewDecision ?? '',
        });
      }
    }
  }

  viewPR(identifier: string | number): GitHubPR | undefined {
    try {
      const pr: GitHubPR = JSON.parse(
        this.pr([
          'view',
          String(identifier),
          '--json',
          'id,number,url,state,title,body,headRefName,headRefOid,baseRefName,isDraft,reviewDecision,headRepository,headRepositoryOwner,isCrossRepository',
        ])
      );
      if (!Number.isInteger(pr.number) || !pr.headRefName || !pr.baseRefName) {
        throw new GitHubError('GitHub returned an invalid pull request.');
      }
      return pr;
    } catch (error) {
      if (
        error instanceof Error &&
        /no pull requests found|Could not resolve to a PullRequest/.test(
          error.message
        )
      ) {
        return undefined;
      }
      throw error;
    }
  }
}

export type GitHubPR = {
  id: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  body: string;
  headRefName: string;
  /** Commit at the head branch tip as GitHub last saw it. */
  headRefOid?: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision?: 'APPROVED' | 'REVIEW_REQUIRED' | 'CHANGES_REQUESTED' | '';
  isCrossRepository?: boolean;
};

function prNumberChunks(numbers: readonly number[]): number[][] {
  const unique = [...new Set(numbers)];
  if (unique.some((number) => !Number.isSafeInteger(number) || number < 1))
    throw new GitHubError('Invalid pull request number.');
  const chunks: number[][] = [];
  for (let offset = 0; offset < unique.length; offset += 50)
    chunks.push(unique.slice(offset, offset + 50));
  return chunks;
}

function branchChunks(branches: readonly string[]): string[][] {
  const unique = [...new Set(branches)];
  if (unique.some((branch) => !branch || /[\0\n\r]/.test(branch)))
    throw new GitHubError('Invalid branch name.');
  const chunks: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 50)
    chunks.push(unique.slice(offset, offset + 50));
  return chunks;
}

function parsePRNumbersResponse(
  output: string,
  chunk: number[],
  result: Map<number, GitHubPR | undefined>
): void {
  let response: {
    data?: { repository?: Record<string, GitHubPR | null> | null };
    errors?: unknown[];
  };
  try {
    response = JSON.parse(output);
  } catch {
    throw new GitHubError('GitHub returned invalid JSON for pull requests.');
  }
  const repository = response?.data?.repository;
  if (
    !repository ||
    (response.errors !== undefined &&
      (!Array.isArray(response.errors) || response.errors.length > 0))
  )
    throw new GitHubError('GitHub returned an incomplete pull request query.');
  for (const [index, number] of chunk.entries()) {
    const pr = repository[`p${index}`];
    if (pr === null) {
      result.set(number, undefined);
    } else if (
      !pr ||
      pr.number !== number ||
      !pr.headRefName ||
      !pr.baseRefName
    ) {
      throw new GitHubError('GitHub returned an invalid pull request.');
    } else {
      result.set(number, {
        ...pr,
        reviewDecision: pr.reviewDecision ?? '',
      });
    }
  }
}
