import { expect } from 'chai';
import {
  GitHubClient,
  GitHubError,
  GitHubPR,
} from '../../src/lib/github/client';

const repository = { host: 'github.example.com', owner: 'test', name: 'repo' };
const pull = (number: number): GitHubPR => ({
  number,
  id: `PR_${number}`,
  url: `https://github.example.com/test/repo/pull/${number}`,
  headRefName: `branch-${number}`,
  baseRefName: 'main',
  state: 'OPEN',
  title: `Title ${number}`,
  body: `Body ${number}`,
  isDraft: false,
  isCrossRepository: false,
});
const aliases = (args: string[]) => [
  ...(args.find((arg) => arg.startsWith('query=')) ?? '').matchAll(
    /(p\d+):pullRequest\(number:(\d+)\)/g
  ),
];
const response = (args: string[]) =>
  JSON.stringify({
    data: {
      repository: Object.fromEntries(
        aliases(args).map((match) => [match[1], pull(Number(match[2]))])
      ),
    },
  });

describe('batched known-PR lookups', () => {
  it('queries explicit numbers once, without shell interpolation or changing gh host/auth', () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repository, (args) => {
      calls.push(args);
      return response(args);
    });
    const result = client.viewPRs([3, 1, 3, 2]);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.include.members([
      'api',
      '--hostname',
      repository.host,
      'graphql',
      `owner=${repository.owner}`,
      `name=${repository.name}`,
    ]);
    expect(calls[0].find((arg) => arg.startsWith('query='))).to.match(
      /^query=query\(/
    );
    expect([...result.keys()]).to.deep.equal([3, 1, 2]);
    expect(result.get(3)).to.deep.equal({ ...pull(3), reviewDecision: '' });
  });
  it('bounds each query to 50 PRs and does not invoke gh for an empty list', () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repository, (args) => {
      calls.push(args);
      return response(args);
    });
    expect(client.viewPRs([]).size).to.equal(0);
    expect(calls).to.have.length(0);
    expect(
      client.viewPRs(Array.from({ length: 123 }, (_, i) => i + 1)).size
    ).to.equal(123);
    expect(calls.map((args) => aliases(args).length)).to.deep.equal([
      50, 50, 23,
    ]);
  });
  it('preserves merged/closed/fork PRs for the caller to validate', () => {
    const client = new GitHubClient(repository, (args) => {
      const value = JSON.parse(response(args));
      value.data.repository.p0.state = 'MERGED';
      value.data.repository.p1.state = 'CLOSED';
      value.data.repository.p1.isCrossRepository = true;
      value.data.repository.p1.isDraft = true;
      value.data.repository.p1.reviewDecision = 'CHANGES_REQUESTED';
      return JSON.stringify(value);
    });
    const result = client.viewPRs([1, 2]);
    expect(result.get(1)?.state).to.equal('MERGED');
    expect(result.get(2)).to.include({
      state: 'CLOSED',
      isCrossRepository: true,
      isDraft: true,
      reviewDecision: 'CHANGES_REQUESTED',
    });
  });
  it('distinguishes explicit missing PRs from missing query results', () => {
    const client = new GitHubClient(repository, () =>
      JSON.stringify({
        data: {
          repository: { p0: null, p1: pull(2) },
        },
      })
    );
    const result = client.viewPRs([1, 2]);
    expect(result.has(1)).to.equal(true);
    expect(result.get(1)).to.equal(undefined);
    expect(result.get(2)?.number).to.equal(2);
  });
  it('falls back to gh view for partial not-found errors rather than dropping other PRs', () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repository, (args) => {
      calls.push(args);
      if (args[0] === 'api' || args[2] === '1')
        throw new GitHubError(
          'Could not resolve to a PullRequest with the number of 1.'
        );
      return JSON.stringify(pull(Number(args[2])));
    });
    const result = client.viewPRs([1, 2]);
    expect(calls.map((args) => args.slice(0, 3))).to.deep.equal([
      ['api', '--hostname', repository.host],
      ['pr', 'view', '1'],
      ['pr', 'view', '2'],
    ]);
    expect(result.get(1)).to.equal(undefined);
    expect(result.get(2)).to.deep.equal(pull(2));
  });
  it('never treats authentication, network, or partial authorization errors as an empty repository', () => {
    for (const message of [
      'Bad credentials (HTTP 401)',
      'connection timed out',
      'Resource not accessible by integration',
    ]) {
      let calls = 0;
      const client = new GitHubClient(repository, () => {
        calls++;
        throw new GitHubError(message);
      });
      expect(() => client.viewPRs([1, 2])).to.throw(message);
      expect(calls).to.equal(1);
    }
    const client = new GitHubClient(repository, (args) => {
      if (args[0] === 'api')
        throw new GitHubError('Could not resolve to a PullRequest');
      throw new GitHubError('Bad credentials (HTTP 401)');
    });
    expect(() => client.viewPRs([1, 2])).to.throw('Bad credentials');
  });
  it('rejects malformed, incomplete, or mismatched responses', () => {
    for (const output of [
      '{broken',
      'null',
      '{}',
      JSON.stringify({ data: { repository: null } }),
      JSON.stringify({ data: { repository: {} } }),
      JSON.stringify({ data: { repository: { p0: pull(2) } } }),
      JSON.stringify({
        data: { repository: { p0: { ...pull(1), headRefName: '' } } },
      }),
      JSON.stringify({
        data: { repository: { p0: pull(1) } },
        errors: [{ message: 'Forbidden' }],
      }),
    ]) {
      expect(
        () => new GitHubClient(repository, () => output).viewPRs([1]),
        output
      ).to.throw(GitHubError);
    }
  });
  it('rejects invalid numbers before issuing a query', () => {
    const client = new GitHubClient(repository, () => {
      throw Error('must not invoke gh');
    });
    for (const number of [
      0,
      -1,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => client.viewPRs([number])).to.throw(
        'Invalid pull request number.'
      );
  });
});

describe('batched open-PR lookups by branch name', () => {
  const node = (number: number, branch: string, state = 'OPEN'): GitHubPR => ({
    ...pull(number),
    headRefName: branch,
    state: state as GitHubPR['state'],
  });
  const respond = (
    args: string[],
    table: Record<string, GitHubPR[]>
  ): string => {
    const heads = args
      .filter((arg) => /^head\d+=/.test(arg))
      .map((arg) => arg.split('=').slice(1).join('='));
    const repository = Object.fromEntries(
      heads.map((branch, index) => [
        `b${index}`,
        { nodes: table[branch] ?? [] },
      ])
    );
    return JSON.stringify({ data: { repository } });
  };
  it('resolves branches with exactly one open PR in a single query, ignoring closed PRs', () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repository, (args) => {
      calls.push(args);
      return respond(args, {
        one: [node(1, 'one')],
        closed: [node(2, 'closed', 'CLOSED')],
      });
    });
    const result = client.viewOpenPRsByBranch(['one', 'closed', 'none', 'one']);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.include.members([
      'graphql',
      'head0=one',
      'head1=closed',
      'head2=none',
    ]);
    const query = calls[0].find((arg) => arg.startsWith('query=')) ?? '';
    expect(query).to.match(/^query=query\(/);
    expect(query).to.contain('states:OPEN');
    expect(query).not.to.contain('mutation');
    expect(result.get('one')).to.deep.equal({
      ...node(1, 'one'),
      reviewDecision: '',
    });
    expect(result.get('closed')).to.equal(undefined);
    expect(result.has('none')).to.equal(true);
    expect(result.get('none')).to.equal(undefined);
  });
  it('defers to gh pr view when a branch has several open PRs', () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repository, (args) => {
      calls.push(args);
      if (args[0] === 'pr') return JSON.stringify(node(9, 'shared'));
      return respond(args, { shared: [node(8, 'shared'), node(9, 'shared')] });
    });
    expect(
      client.viewOpenPRsByBranch(['shared']).get('shared')?.number
    ).to.equal(9);
    expect(calls.map((args) => args.slice(0, 2))).to.deep.equal([
      ['api', '--hostname'],
      ['pr', 'view'],
    ]);
  });
  it('passes branch names as typed variables, never inside the query text', () => {
    const hostile = 'feature/"){ } mutation';
    const client = new GitHubClient(repository, (args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      expect(query).not.to.contain(hostile);
      expect(args).to.include(`head0=${hostile}`);
      return respond(args, {});
    });
    expect(client.viewOpenPRsByBranch([hostile]).get(hostile)).to.equal(
      undefined
    );
    expect(() => client.viewOpenPRsByBranch(['bad\nname'])).to.throw(
      'Invalid branch name.'
    );
    expect(() => client.viewOpenPRsByBranch([''])).to.throw(
      'Invalid branch name.'
    );
  });
  it('propagates failures and rejects malformed responses instead of treating them as no PR', () => {
    let calls = 0;
    const failing = new GitHubClient(repository, () => {
      calls++;
      throw new GitHubError('Bad credentials (HTTP 401)');
    });
    expect(() => failing.viewOpenPRsByBranch(['one'])).to.throw(
      'Bad credentials'
    );
    expect(calls).to.equal(1);
    for (const output of [
      '{broken',
      '{}',
      JSON.stringify({ data: { repository: { b0: null } } }),
      JSON.stringify({
        data: {
          repository: { b0: { nodes: [{ ...node(1, ''), headRefName: '' }] } },
        },
      }),
      JSON.stringify({
        data: { repository: { b0: { nodes: [] } } },
        errors: [{ message: 'denied' }],
      }),
    ]) {
      expect(
        () =>
          new GitHubClient(repository, () => output).viewOpenPRsByBranch([
            'one',
          ]),
        output
      ).to.throw(GitHubError);
    }
    expect(
      new GitHubClient(repository, () => 'null').viewOpenPRsByBranch([]).size
    ).to.equal(0);
  });
});
