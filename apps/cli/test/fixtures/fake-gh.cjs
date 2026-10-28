#!/usr/bin/env node
// Offline GitHub simulator. Any unknown command fails closed; no real gh or HTTP.
const fs = require('fs');
const cp = require('child_process');
const args = process.argv.slice(2);
const file = process.env.GT_FAKE_GITHUB;
if (!file) throw new Error('GT_FAKE_GITHUB is required');
// Real reads can overlap. Serialize this simulator's mutable JSON/call log so
// concurrent children cannot lose calls, truncate JSON, or overwrite state.
const lockPath = file + '.lock';
const deadline = Date.now() + 30000;
let lock;
for (;;) {
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
    break;
  } catch (error) {
    if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.once('exit', () => {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
});
process.once('SIGTERM', () => process.exit(143));
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const output = (value) => {
  save();
  if (value !== undefined)
    process.stdout.write(
      typeof value === 'string' ? value : JSON.stringify(value)
    );
};
const fail = (message, status = 422) => {
  save();
  process.stderr.write(`gh: ${message} (HTTP ${status})\n`);
  process.exit(1);
};
const input = () => fs.readFileSync(0, 'utf8');
const body = () =>
  !flag('--body-file') || flag('--body-file') === '-'
    ? input()
    : fs.readFileSync(flag('--body-file'), 'utf8');
const sha = (branch) =>
  cp
    .execFileSync(
      'git',
      ['--git-dir', state.gitDir, 'rev-parse', `refs/heads/${branch}`],
      { encoding: 'utf8' }
    )
    .trim();
// GitHub keeps reporting a PR's head commit after its branch is deleted.
const shaOrNull = (branch) => {
  try {
    return sha(branch);
  } catch {
    return null;
  }
};
const wire = (s) => ({
  id: s.number,
  number: s.number,
  node_id: `S_${s.number}`,
  url: `https://api.github.com/repos/test/repo/stacks/${s.number}`,
  base: { ref: s.base, sha: sha(s.base) },
  open: s.prs.some(
    (number) => state.prs.find((pr) => pr.number === number).state === 'OPEN'
  ),
  pull_requests: s.prs.map((number) => {
    const pr = state.prs.find((p) => p.number === number);
    return {
      number,
      state: pr.state === 'OPEN' ? 'open' : 'closed',
      merged_at: pr.state === 'MERGED' ? '2026-01-01T00:00:00Z' : null,
      draft: pr.isDraft,
      head: { ref: pr.headRefName, sha: pr.headSha || sha(pr.headRefName) },
    };
  }),
});
const validateChain = (numbers) => {
  if (new Set(numbers).size !== numbers.length) fail('Duplicate pull request');
  numbers.forEach((number, index) => {
    const pr = state.prs.find((p) => p.number === number);
    if (!pr || pr.state !== 'OPEN') fail('Pull request is not open');
    if (
      index &&
      pr.baseRefName !==
        state.prs.find((p) => p.number === numbers[index - 1]).headRefName
    )
      fail('Invalid base chain');
  });
};
if (args[0] === '--version') output('gh version 2.95.0');
else if (args[0] === 'auth' && args[1] === 'status') output('Logged in');
else if (args[0] === 'repo' && args[1] === 'view') {
  output({
    nameWithOwner: 'test/repo',
    defaultBranchRef: { name: 'main' },
    url: 'https://github.com/test/repo',
  });
} else if (args[0] === 'stack') {
  if (args[1] === '--version') output('gh stack version 0.1.0');
  else if (args[1] === 'unstack') {
    if (state.locked) fail('Stack is locked');
    state.stacks = state.stacks.filter(
      (stack) => stack.number !== Number(args[2])
    );
    output('Stack unstacked');
  } else if (args[1] === 'link') {
    if (state.locked) fail('Stack is locked');
    const list = args.slice(2);
    let base = 'main';
    if (list[0] === '--base') {
      base = list[1];
      list.splice(0, 2);
    }
    const numbers = list.map(Number);
    if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1))
      fail('Fixture accepts PR numbers only');
    const existing = state.stacks.find((stack) => stack.number === numbers[0]);
    if (existing) {
      numbers.shift();
      base = existing.base;
      numbers.unshift(...existing.prs);
    }
    if (
      state.stacks.some(
        (stack) =>
          stack !== existing &&
          stack.prs.some((number) => numbers.includes(number))
      )
    )
      fail('PR already in another stack');
    for (let i = 0; i < numbers.length; i++) {
      const pr = state.prs.find((pr) => pr.number === numbers[i]);
      if (!pr || pr.state !== 'OPEN') fail('Unknown/open PR required');
      // Official gh-stack link fixes existing PR bases, but never changes local tracking.
      pr.baseRefName = i
        ? state.prs.find((pr) => pr.number === numbers[i - 1]).headRefName
        : base;
    }
    validateChain(numbers);
    if (existing) existing.prs = numbers;
    else {
      if (numbers.length < 2) fail('At least two PRs required');
      state.stacks.push({ number: state.next++, base, prs: numbers });
    }
    output('Stack linked');
  } else fail('Unexpected stack command', 500);
} else if (args[0] === 'api' && args.includes('graphql')) {
  if (flag('--hostname') !== 'github.com') fail('Wrong GraphQL host');
  const query = args.find((arg) => arg.startsWith('query='))?.slice(6) ?? '';
  if (!query.startsWith('query')) fail('Only read-only GraphQL is supported');
  const membership = (pr) => {
    const stack = state.stacks.find((stack) => stack.prs.includes(pr.number));
    if (!stack) return null;
    // Same shape as GitHub's PullRequestStack: every entry, in position order.
    return {
      number: stack.number,
      baseRefName: stack.base,
      size: stack.prs.length,
      entries: {
        nodes: stack.prs.map((number, index) => {
          const member = state.prs.find((p) => p.number === number);
          return {
            position: index + 1,
            pullRequest: {
              number,
              headRefName: member.headRefName,
              state: member.state,
            },
          };
        }),
      },
    };
  };
  const raw = (pr) => ({
    ...pr,
    id: pr.id ?? `PR_${pr.number}`,
    // Mirror snapshots need fresh remote refs and repository identities.
    // Other reads can include PRs whose fixture branches were already deleted.
    ...(query.includes('headRefOid')
      ? {
          headRefOid: shaOrNull(pr.headRefName) ?? pr.headSha ?? null,
          baseRefOid: shaOrNull(pr.baseRefName),
          headRepository: { nameWithOwner: 'test/repo' },
          baseRepository: { nameWithOwner: 'test/repo' },
        }
      : {}),
    merged: pr.state === 'MERGED',
    stack: membership(pr),
    mergeQueueEntry: state.locked || pr.queued ? { id: 'queued' } : null,
    autoMergeRequest: pr.autoMerge ? { enabledAt: 'now' } : null,
  });
  const repository = {};
  for (const match of query.matchAll(/b(\d+):pullRequests/g)) {
    const branch = args
      .find((arg) => arg.startsWith(`head${match[1]}=`))
      ?.slice(`head${match[1]}=`.length);
    const pr = [...state.prs].reverse().find((pr) => pr.headRefName === branch);
    repository[`b${match[1]}`] = { nodes: pr ? [raw(pr)] : [] };
  }
  for (const match of query.matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)) {
    const pr = state.prs.find((pr) => pr.number === Number(match[2]));
    repository[`p${match[1]}`] = pr ? raw(pr) : null;
  }
  output({ data: { repository } });
} else if (args[0] === 'api') {
  const method = flag('--method') || 'GET';
  const endpoint = args.find((a) => a.startsWith('repos/'));
  if (!endpoint || flag('--hostname') !== 'github.com')
    fail('Wrong API repository or host');
  const path = endpoint.split('?')[0];
  if (
    state.failure &&
    state.failure.method === method &&
    path.endsWith(state.failure.path) &&
    state.failure.count > 0
  ) {
    state.failure.count--;
    fail('Injected failure', state.failure.status || 500);
  }
  const number = Number(path.match(/stacks\/(\d+)/)?.[1]);
  const stack = state.stacks.find((s) => s.number === number);
  if (method === 'GET') {
    if (number) {
      if (!stack) fail('Not Found', 404);
      const change = state.stackReadMutation;
      if (change?.number === number) {
        if (change.prs) stack.prs = change.prs;
        if (change.reopen)
          state.prs.find((pr) => pr.number === change.reopen).state = 'OPEN';
        delete state.stackReadMutation;
      }
      output(wire(stack));
    } else if (path.endsWith('/stacks')) {
      const params = new URLSearchParams(endpoint.split('?')[1]);
      const page = Number(params.get('page') || 1),
        size = Number(params.get('per_page') || 100);
      const last = Math.max(1, Math.ceil(state.stacks.length / size));
      if (args.includes('-i')) {
        // gh api -i: status line and headers precede the body, like GitHub.
        const url = `https://api.github.com/repositories/1/stacks?per_page=${size}&page=`;
        process.stdout.write(
          'HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n' +
            (last > 1
              ? `Link: <${url}${Math.min(
                  page + 1,
                  last
                )}>; rel="next", <${url}${last}>; rel="last"\r\n`
              : '') +
            '\r\n'
        );
      }
      output(state.stacks.slice((page - 1) * size, page * size).map(wire));
    } else if (/\/pulls\/\d+$/.test(path)) {
      const number = Number(path.split('/').pop());
      const pr = state.prs.find((p) => p.number === number);
      if (!pr) fail('Not Found', 404);
      output({
        number,
        node_id: pr.id,
        state: pr.state === 'OPEN' ? 'open' : 'closed',
        title: pr.title,
        body: pr.body,
        draft: pr.isDraft,
        head: {
          ref: pr.headRefName,
          sha: sha(pr.headRefName),
          repo: { full_name: 'test/repo' },
        },
        base: {
          ref: pr.baseRefName,
          sha: sha(pr.baseRefName),
          repo: { full_name: 'test/repo' },
        },
      });
    } else if (path.endsWith('/pulls')) {
      const params = new URLSearchParams(endpoint.split('?')[1]);
      const page = Number(params.get('page') || 1),
        size = Number(params.get('per_page') || 100);
      output(
        state.prs
          .filter(
            (pr) => pr.state === 'OPEN' && pr.baseRefName === params.get('base')
          )
          .slice((page - 1) * size, page * size)
          .map((pr) => ({ number: pr.number }))
      );
    } else fail(`Unexpected GET ${endpoint}`, 500);
  } else if (method === 'POST' && path.endsWith('/unstack')) {
    if (!stack) fail('Not Found', 404);
    if (state.locked) output(wire(stack));
    else {
      stack.prs = stack.prs.filter(
        (number) =>
          state.prs.find((pr) => pr.number === number).state === 'MERGED' ||
          state.lockedPRs?.includes(number)
      );
      if (stack.prs.length) output(wire(stack));
      else {
        state.stacks = state.stacks.filter((s) => s !== stack);
        output();
      }
    }
  } else if (method === 'POST') {
    const numbers = JSON.parse(input()).pull_requests;
    if (path.endsWith('/add')) {
      if (!stack) fail('Not Found', 404);
      if (numbers.some((n) => stack.prs.includes(n)))
        fail('Append must contain only delta');
      validateChain([...stack.prs, ...numbers]);
      stack.prs.push(...numbers);
      output(wire(stack));
    } else if (path.endsWith('/stacks')) {
      if (numbers.length < 2) fail('At least two PRs required');
      if (state.stacks.some((s) => s.prs.some((n) => numbers.includes(n))))
        fail('PR already in another stack');
      validateChain(numbers);
      const created = {
        number: state.next++,
        base: state.prs.find((p) => p.number === numbers[0]).baseRefName,
        prs: numbers,
      };
      state.stacks.push(created);
      output(wire(created));
    } else fail(`Unexpected POST ${endpoint}`, 500);
  } else fail(`Unexpected API method ${method}`, 500);
} else if (args[0] === 'pr') {
  if (flag('--repo') && flag('--repo') !== 'github.com/test/repo')
    fail(`Wrong PR repository: ${flag('--repo')}`, 500);
  if (
    !flag('--repo') &&
    cp
      .execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
      })
      .trim() !== state.gitDir
  )
    fail('Unscoped PR command outside the owned fixture repository', 500);
  const command = args[1];
  let pr = state.prs.find(
    (p) => String(p.number) === args[2] || p.headRefName === args[2]
  );
  if (command === 'view') {
    if (!pr) fail(`no pull requests found for branch ${args[2]}`, 404);
    if (flag('--json') === 'reviews')
      output({ reviews: [{ author: { login: 'reviewer' } }] });
    else output(pr);
  } else if (command === 'create') {
    const number = state.next++;
    pr = {
      id: `PR_${number}`,
      number,
      url: `https://github.com/test/repo/pull/${number}`,
      state: 'OPEN',
      title: flag('--title'),
      body: body(),
      headRefName: flag('--head'),
      baseRefName: flag('--base'),
      isDraft: args.includes('--draft'),
      reviewDecision: 'REVIEW_REQUIRED',
      isCrossRepository: false,
    };
    pr.headSha = sha(pr.headRefName);
    sha(pr.baseRefName);
    state.prs.push(pr);
    output(pr.url);
  } else {
    if (!pr) fail('Unknown PR');
    if (command === 'edit') {
      if (args.includes('--base')) pr.baseRefName = flag('--base');
      if (args.includes('--title')) pr.title = flag('--title');
      if (args.includes('--body-file')) pr.body = body();
      if (args.includes('--add-reviewer'))
        pr.reviewers = flag('--add-reviewer');
    } else if (command === 'ready') pr.isDraft = args.includes('--undo');
    else if (command === 'close') pr.state = 'CLOSED';
    else if (command === 'comment') pr.comment = input();
    else if (command === 'merge') pr.autoMerge = true;
    else fail(`Unexpected pr ${command}`, 500);
    output(pr.url);
  }
} else fail(`Unexpected command: ${args.join(' ')}`, 500);
