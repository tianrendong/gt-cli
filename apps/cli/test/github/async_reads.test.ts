import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import {
  GitHubClient,
  GitHubError,
  runGhAsync,
} from '../../src/lib/github/client';
import { RemoteStack, StackAPI } from '../../src/lib/github/stack_api';

const repo = { host: 'github.example.com', owner: 'owner', name: 'repo' };
const stack = (number: number, prs: number[] = []): RemoteStack => ({
  id: number,
  node_id: `S_${number}`,
  number,
  url: 'https://github.example.com/stack',
  base: { ref: 'main', sha: '0'.repeat(40) },
  open: true,
  pull_requests: prs.map((pr) => ({
    number: pr,
    state: 'open' as const,
    head: { ref: `branch-${pr}`, sha: '1'.repeat(40) },
  })),
});
const page = (args: string[]) =>
  Number(args[args.length - 1].match(/[?&]page=(\d+)/)?.[1]);
/** Simulate gh api -i: a status line and headers, then the JSON body. */
const withHeaders = (body: unknown, last: number, current: number) =>
  'HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n' +
  (last > 1
    ? `Link: <https://api.github.com/repositories/1/stacks?per_page=100&page=${Math.min(
        current + 1,
        last
      )}>; rel="next", <https://api.github.com/repositories/1/stacks?per_page=100&page=${last}>; rel="last"\r\n`
    : '') +
  '\r\n' +
  JSON.stringify(body);

describe('asynchronous GitHub REST reads', function () {
  this.timeout(15_000);
  let root: string, environment: NodeJS.ProcessEnv;
  beforeEach(() => {
    environment = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-async-gh-'));
    fs.writeFileSync(
      path.join(root, 'gh'),
      `#!/usr/bin/env node
      const args = process.argv.slice(2);
      if (args[0] === 'fail') {
        process.stderr.write('gh: forbidden (HTTP 403)');
        process.exit(1);
      }
      if (args[0] === 'oversize') {
        process.stdout.write('x'.repeat(33 * 1024 * 1024));
      } else {
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => process.stdout.write(JSON.stringify({
          args, input, prompt: process.env.GH_PROMPT_DISABLED, pager: process.env.GH_PAGER,
        })+'\\n'));
      }
    `,
      { mode: 0o755 }
    );
    process.env.PATH = root + path.delimiter + process.env.PATH;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('uses the same argv and JSON decoding as synchronous GETs, including custom runners', async () => {
    const calls: string[][] = [];
    const client = new GitHubClient(repo, (args) => {
      calls.push(args);
      return '{"value":"read"}';
    });
    expect(await client.apiGet('repos/owner/repo/pulls/1')).to.deep.equal(
      client.api('GET', 'repos/owner/repo/pulls/1')
    );
    expect(calls[0]).to.deep.equal(calls[1]);
    expect(calls[0]).to.include.members([
      '--hostname',
      repo.host,
      '--method',
      'GET',
    ]);
  });
  it('preserves literal arguments, EOF/input handling, and non-interactive gh settings', async () => {
    const args = [
      'read',
      '$(touch do-not-create)',
      'with whitespace',
      '--literal',
    ];
    const result = JSON.parse(await runGhAsync(args, 'body\n'));
    expect(result).to.deep.equal({
      args,
      input: 'body\n',
      prompt: '1',
      pager: 'cat',
    });
    expect(JSON.parse(await runGhAsync(['read'])).input).to.equal('');
  });
  it('propagates gh failures with their status instead of returning empty data', async () => {
    try {
      await runGhAsync(['fail']);
      expect.fail('must reject');
    } catch (error) {
      expect(error).to.be.instanceOf(GitHubError);
      expect(error.status).to.equal(403);
      expect(error.message).to.equal('gh: forbidden (HTTP 403)');
    }
  });
  it('bounds subprocess output and rejects malformed JSON', async () => {
    try {
      await runGhAsync(['oversize']);
      expect.fail('must reject');
    } catch (error) {
      expect(error).to.be.instanceOf(GitHubError);
      expect(error.message).to.contain('maxBuffer');
    }
    const client = new GitHubClient(repo, () => 'not json');
    try {
      await client.apiGet('repos/owner/repo/pulls/1');
      expect.fail('must reject');
    } catch (error) {
      expect(error.message).to.equal(
        'GitHub returned invalid JSON for GET repos/owner/repo/pulls/1.'
      );
    }
  });

  describe('stack listing pagination', () => {
    const pages = (count: number, perPage = 100) =>
      Array.from({ length: count }, (_, index) =>
        Array.from({ length: index === count - 1 ? perPage : 100 }, (_, i) =>
          stack(index * 100 + i + 1)
        )
      );
    it('fetches advertised pages up to eight at a time and preserves listing order', async () => {
      const data = pages(11, 40);
      const calls: string[][] = [];
      let active = 0,
        peak = 0;
      const client = new GitHubClient(
        repo,
        () => {
          throw Error('synchronous runner must not be used');
        },
        async (args) => {
          calls.push(args);
          active++;
          peak = Math.max(peak, active);
          try {
            await sleep(5);
            const current = page(args);
            return args.includes('-i')
              ? withHeaders(data[current - 1], data.length, current)
              : JSON.stringify(data[current - 1]);
          } finally {
            active--;
          }
        }
      );
      const listed = await new StackAPI(client).list();
      expect(listed.map((s) => s.number)).to.deep.equal(
        data.flat().map((s) => s.number)
      );
      expect(calls.map(page)).to.deep.equal([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(calls[0]).to.include('-i');
      expect(calls.slice(1).some((args) => args.includes('-i'))).to.equal(
        false
      );
      expect(peak).to.equal(8);
    });
    it('continues sequentially when the listing grows past the advertised last page', async () => {
      const data = pages(3, 100).concat([[stack(301)]]);
      const calls: number[] = [];
      const client = new GitHubClient(repo, undefined, async (args) => {
        const current = page(args);
        calls.push(current);
        return args.includes('-i')
          ? withHeaders(data[0], 3, 1)
          : JSON.stringify(data[current - 1] ?? []);
      });
      const listed = await new StackAPI(client).list();
      expect(listed).to.have.length(301);
      expect(calls).to.deep.equal([1, 2, 3, 4]);
    });
    it('falls back to page-by-page reads when no Link header is available', async () => {
      const data = pages(3, 7);
      const calls: number[] = [];
      const client = new GitHubClient(repo, undefined, async (args) => {
        calls.push(page(args));
        return JSON.stringify(data[page(args) - 1]);
      });
      expect(await new StackAPI(client).list()).to.have.length(207);
      expect(calls).to.deep.equal([1, 2, 3]);
      const single = new GitHubClient(repo, undefined, async () =>
        withHeaders([stack(1)], 1, 1)
      );
      expect(await new StackAPI(single).list()).to.have.length(1);
    });
    it('drains concurrent page reads, then reports the first failing page', async () => {
      let active = 0,
        finished = 0;
      const client = new GitHubClient(repo, undefined, async (args) => {
        const current = page(args);
        if (args.includes('-i')) return withHeaders(pages(1)[0], 5, 1);
        active++;
        try {
          await sleep(current === 3 ? 1 : 20);
          if (current === 3) throw new GitHubError('boom (HTTP 502)');
          finished++;
          return JSON.stringify([]);
        } finally {
          active--;
        }
      });
      try {
        await new StackAPI(client).list();
        expect.fail('must reject');
      } catch (error) {
        expect(error.message).to.equal('boom (HTTP 502)');
      }
      expect(active).to.equal(0);
      expect(finished).to.equal(3);
    });
    it('rejects malformed pages, headers, and stack objects', async () => {
      for (const output of [
        'HTTP/2.0 200 OK\r\nno-body',
        withHeaders({}, 1, 1),
        withHeaders([{}], 1, 1),
        '{}',
      ]) {
        const client = new GitHubClient(repo, undefined, async () => output);
        try {
          await new StackAPI(client).list();
          expect.fail('must reject: ' + output);
        } catch (error) {
          expect(error, output).to.be.instanceOf(GitHubError);
        }
      }
    });
  });

  describe('stack membership queries', () => {
    const stacks = [stack(10, [1, 2, 3]), stack(20, [7])];
    const answer = (args: string[]) => {
      const query = args.find((a) => a.startsWith('query=')) ?? '';
      const repository: Record<string, unknown> = {};
      for (const match of query.matchAll(
        /p(\d+):pullRequest\(number:(\d+)\)/g
      )) {
        const number = Number(match[2]);
        const found = stacks.find((s) =>
          s.pull_requests.some((pr) => pr.number === number)
        );
        repository[`p${match[1]}`] = {
          number,
          stack: found
            ? {
                number: found.number,
                baseRefName: found.base.ref,
                size: found.pull_requests.length,
                entries: {
                  nodes: [...found.pull_requests].reverse().map((pr, i) => ({
                    position: found.pull_requests.length - i,
                    pullRequest: {
                      number: pr.number,
                      headRefName: pr.head.ref,
                    },
                  })),
                },
              }
            : null,
        };
      }
      return JSON.stringify({ data: { repository } });
    };
    it('returns exact membership in position order, from one read-only query per 50 PRs', async () => {
      const calls: string[][] = [];
      const client = new GitHubClient(repo, undefined, async (args) => {
        calls.push(args);
        return answer(args);
      });
      const result = await client.stackMembership([2, 7, 99, 2]);
      expect(calls).to.have.length(1);
      expect(calls[0].slice(0, 4)).to.deep.equal([
        'api',
        '--hostname',
        repo.host,
        'graphql',
      ]);
      expect(calls[0].find((a) => a.startsWith('query='))).to.match(
        /^query=query\(/
      );
      expect(result.get(2)).to.deep.equal({
        number: 10,
        base: 'main',
        prs: [1, 2, 3].map((n) => ({ number: n, branch: `branch-${n}` })),
      });
      expect(result.get(7)?.number).to.equal(20);
      expect(result.has(99)).to.equal(true);
      expect(result.get(99)).to.equal(undefined);
      await client.stackMembership(
        Array.from({ length: 120 }, (_, i) => i + 1)
      );
      expect(calls).to.have.length(4);
    });
    it('rejects incomplete, oversized, or mismatched membership data', async () => {
      const outputs = [
        '{broken',
        JSON.stringify({ data: { repository: null } }),
        JSON.stringify({ data: { repository: {} } }),
        JSON.stringify({ data: { repository: { p0: { number: 2 } } } }),
        JSON.stringify({
          data: {
            repository: {
              p0: {
                number: 1,
                stack: {
                  number: 5,
                  baseRefName: 'main',
                  size: 2,
                  entries: { nodes: [] },
                },
              },
            },
          },
        }),
        JSON.stringify({
          data: { repository: { p0: { number: 1, stack: null } } },
          errors: [{ message: 'partial' }],
        }),
      ];
      for (const output of outputs) {
        const client = new GitHubClient(repo, undefined, async () => output);
        try {
          await client.stackMembership([1]);
          expect.fail('must reject: ' + output);
        } catch (error) {
          expect(error, output).to.be.instanceOf(GitHubError);
        }
      }
      const client = new GitHubClient(repo, undefined, async () => '{}');
      try {
        await client.stackMembership([0]);
        expect.fail('must reject');
      } catch (error) {
        expect(error.message).to.equal('Invalid pull request number.');
      }
    });
  });
});
