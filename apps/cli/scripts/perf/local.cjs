#!/usr/bin/env node
/* Isolated, paired end-to-end benchmarks. No user repositories or network writes.
 * Both entries must be built from their own source tree, with the same Node.
 * Example: node scripts/perf/local.cjs --baseline /tmp/control/dist/src/gt_cli.js
 *          --candidate ./dist/src/gt_cli.js --branches 100 --runs 9 --output /tmp/perf.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { performance } = require('perf_hooks');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const baseline = option('--baseline');
const candidate = option('--candidate');
if (!baseline || !candidate)
  throw new Error('Required: --baseline ENTRY --candidate ENTRY');
const count = Number(option('--branches', '50'));
const runs = Number(option('--runs', '9'));
const nativeChecks = process.argv.includes('--native-db');
const mutations = process.argv.includes('--mutations');
if (![count, runs].every((n) => Number.isSafeInteger(n) && n > 0))
  throw new Error('Invalid benchmark size');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-local-perf-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
fs.mkdirSync(home);
fs.mkdirSync(bin);
for (const name of ['gh', 'curl', 'wget']) {
  fs.writeFileSync(
    path.join(bin, name),
    '#!/bin/sh\necho "Network tool forbidden in local benchmark" >&2\nexit 97\n',
    { mode: 0o755 }
  );
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /^(GIT_|GT_|GH_|GITHUB_|GRAPHITE_|NODE_OPTIONS$|NODE_COMPILE_CACHE$|XDG_)/.test(
      key
    )
  )
    delete env[key];
}
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_STATE_HOME: path.join(home, 'state'),
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${bin}${
    path.delimiter
  }${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'Benchmark',
  GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
  GIT_COMMITTER_NAME: 'Benchmark',
  GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
  GRAPHITE_USER_CONFIG_PATH: path.join(home, 'user.json'),
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '',
  PAGER: 'cat',
  GH_PAGER: 'cat',
});
fs.writeFileSync(
  env.GRAPHITE_USER_CONFIG_PATH,
  JSON.stringify({ tips: false, pager: '' })
);
fs.writeFileSync(
  env.GIT_CONFIG_GLOBAL,
  '[user]\n\tname = Benchmark\n\temail = benchmark@example.invalid\n[core]\n\tpager = cat\n'
);
const git = (repo, args, input, extraEnv = {}) =>
  cp
    .execFileSync('git', args, {
      cwd: repo,
      env: { ...env, ...extraEnv },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    })
    .trim();
const fixture = path.join(root, 'fixture');
fs.mkdirSync(fixture);
const date = (n) => `${1700000000 + n} +0000`;
const commit = (repo, tree, parent, n) =>
  git(
    repo,
    [
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      `Commit ${n}`,
    ],
    undefined,
    {
      GIT_AUTHOR_DATE: date(n),
      GIT_COMMITTER_DATE: date(n),
    }
  );
const metadata = (repo, branch, value) => {
  const sha = git(
    repo,
    ['hash-object', '-w', '--stdin'],
    JSON.stringify(value)
  );
  git(repo, ['update-ref', `refs/branch-metadata/${branch}`, sha]);
};
const name = (n) => `branch-${String(n).padStart(4, '0')}`;
const fingerprint = (entry) => {
  const root = path.dirname(path.dirname(path.resolve(entry)));
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const item of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (
        item.isDirectory() &&
        item.name !== 'test' &&
        file !== path.join(root, 'scripts/perf')
      )
        walk(file);
      if (item.isFile() && /\.(?:js|cjs|json)$/.test(item.name)) {
        hash.update(path.relative(root, file) + '\0');
        hash.update(fs.readFileSync(file));
      }
    }
  };
  walk(root);
  return hash.digest('hex');
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(
      2
    )
  );
};
const run = (variant, args = ['log', 'short'], trace, extraEnv = {}) => {
  const start = performance.now();
  const result = cp.spawnSync(
    process.execPath,
    [variant.entry, '--no-interactive', ...args],
    {
      cwd: variant.repo,
      env: {
        ...env,
        ...extraEnv,
        ...(trace ? { GIT_TRACE2_EVENT: trace } : {}),
      },
      encoding: 'utf8',
      maxBuffer: 32 << 20,
      timeout: 60000,
    }
  );
  const ms = performance.now() - start;
  assert.equal(
    result.status,
    0,
    `${variant.entry}: ${result.error || result.stderr || result.stdout}`
  );
  assert(!/ERROR:|UNCAUGHT EXCEPTION:/.test(result.stdout), result.stdout);
  return { ms, stdout: result.stdout, stderr: result.stderr };
};
// Exercise both native ownership checks without using real native metadata,
// credentials, or launcher registrations. SQLite setup is outside timed runs.
const addNativeChecks = (variant) => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(variant.repo, '.git/.graphite_metadata.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE branch_metadata (branch_name TEXT PRIMARY KEY, parent_branch_name TEXT, parent_branch_revision TEXT, last_submitted_version TEXT, state TEXT, children TEXT, branch_revision TEXT, validation_result TEXT, parent_head_revision TEXT)'
  );
  db.close();
  variant.nativeBefore = fs.readFileSync(dbPath);
  const { nativeDigest } = require(path.join(
    path.dirname(variant.entry),
    'lib/switch/repository.js'
  ));
  const directory = path.join(variant.repo, '.git/gt-gh-switch');
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'gt-gh',
      session: '1-000000000000',
      candidate: {
        node: process.execPath,
        script: path.join(path.dirname(variant.entry), 'index.js'),
      },
      native: {
        path: path.join(bin, 'not-native'),
        version: '1.8.6',
        digest: '0'.repeat(64),
      },
      nativeDigest: nativeDigest(dbPath),
      prCache: null,
      repoConfig: fs
        .readFileSync(path.join(variant.repo, '.git/.graphite_repo_config'))
        .toString('base64'),
    })
  );
};
const refs = (repo) =>
  git(repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/',
    'refs/branch-metadata/',
  ]);
try {
  git(fixture, ['init', '-b', 'main']);
  git(fixture, ['config', 'gc.auto', '0']);
  git(fixture, ['config', 'maintenance.auto', 'false']);
  git(fixture, [
    'remote',
    'add',
    'origin',
    'https://github.com/benchmark/fixture.git',
  ]);
  const tree = git(fixture, ['mktree'], '');
  const trunk = commit(fixture, tree, undefined, 0);
  git(fixture, ['update-ref', 'refs/heads/main', trunk]);
  fs.writeFileSync(
    path.join(fixture, '.git/.graphite_repo_config'),
    JSON.stringify({ trunk: 'main', trunks: [{ name: 'main' }] })
  );
  const seeds = new Map();
  let parent = 'main',
    parentSha = trunk;
  for (let i = 1; i <= count; i++) {
    if ((i - 1) % 5 === 0) {
      parent = 'main';
      parentSha = trunk;
    }
    const branch = name(i);
    const tip = commit(fixture, tree, parentSha, i);
    git(fixture, ['update-ref', `refs/heads/${branch}`, tip]);
    const meta = { parentBranchName: parent, parentBranchRevision: parentSha };
    metadata(fixture, branch, meta);
    seeds.set(branch, meta);
    parent = branch;
    parentSha = tip;
  }
  const variants = [baseline, candidate].map((entry, index) => ({
    entry: path.resolve(entry),
    repo: path.join(root, `repo-${index}`),
  }));
  const availableCases = [
    'cold',
    'warm',
    'metadata-change',
    'branch-change',
    ...(mutations ? ['create-warm', 'create-cold', 'create-after-change'] : []),
  ];
  const cases = option('--scenarios')?.split(',') ?? availableCases;
  if (
    new Set(cases).size !== cases.length ||
    cases.some((name) => !availableCases.includes(name))
  )
    throw new Error(
      'Invalid benchmark scenarios (creation cases require --mutations)'
    );
  const results = [];
  for (const scenario of cases) {
    for (const variant of variants) {
      fs.rmSync(variant.repo, { recursive: true, force: true });
      fs.cpSync(fixture, variant.repo, { recursive: true });
      if (nativeChecks) addNativeChecks(variant);
    }
    // Every scenario starts with the same fixture, not the previous scenario's
    // mutations. Creation samples then grow identical stacks in both variants.
    assert.equal(refs(variants[0].repo), refs(variants[1].repo));
    const samples = [[], []];
    const traces = [];
    // Prime code/filesystem and each implementation's own persisted cache.
    for (const variant of variants) for (let i = 0; i < 2; i++) run(variant);
    for (let iteration = 0; iteration <= runs; iteration++) {
      for (const variant of variants) {
        if (scenario === 'cold' || scenario === 'create-cold')
          fs.rmSync(path.join(variant.repo, '.git/.graphite_cache_persist'), {
            force: true,
          });
        if (
          scenario === 'metadata-change' ||
          scenario === 'create-after-change'
        )
          metadata(variant.repo, name(count), {
            ...seeds.get(name(count)),
            prInfo: { title: `title-${iteration}` },
          });
        if (scenario === 'branch-change') {
          const tip = commit(
            variant.repo,
            tree,
            seeds.get(name(count)).parentBranchRevision,
            count + iteration + 1
          );
          git(variant.repo, ['update-ref', `refs/heads/${name(count)}`, tip]);
        }
        if (scenario.startsWith('create-')) {
          fs.writeFileSync(
            path.join(variant.repo, 'bench.txt'),
            `${scenario} ${iteration}\n`
          );
          git(variant.repo, ['add', 'bench.txt']);
        }
      }
      const args = scenario.startsWith('create-')
        ? [
            'create',
            `bench-${scenario}-${iteration}`,
            '-m',
            `Benchmark ${scenario} ${iteration}`,
          ]
        : ['log', 'short'];
      const commandDate = date(
        count + (scenario === 'create-cold' ? 200 : 100) + iteration
      );
      const pair = [];
      for (const index of iteration % 2 ? [1, 0] : [0, 1]) {
        const trace =
          iteration === runs
            ? path.join(root, `${scenario}-${index}.trace`)
            : undefined;
        pair[index] = run(variants[index], args, trace, {
          GIT_AUTHOR_DATE: commandDate,
          GIT_COMMITTER_DATE: commandDate,
        });
        if (iteration < runs) samples[index].push(pair[index].ms);
        else {
          const commands = fs
            .readFileSync(trace, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) => event.event === 'start')
            .map((event) => event.argv.slice(1));
          traces[index] = { gitProcesses: commands.length, commands };
        }
      }
      assert.equal(
        pair[0].stdout,
        pair[1].stdout,
        `${scenario}: output differs`
      );
      assert.equal(
        pair[0].stderr,
        pair[1].stderr,
        `${scenario}: stderr differs`
      );
    }
    // Metadata repairs, branch refs, HEAD, index/worktree, and local topology must agree.
    for (const variant of variants)
      if (nativeChecks)
        assert.deepEqual(
          fs.readFileSync(
            path.join(variant.repo, '.git/.graphite_metadata.db')
          ),
          variant.nativeBefore,
          `${scenario}: native database changed`
        );
    assert.equal(
      refs(variants[0].repo),
      refs(variants[1].repo),
      `${scenario}: refs differ`
    );
    for (const args of [
      ['symbolic-ref', 'HEAD'],
      ['status', '--porcelain=v1'],
    ])
      assert.equal(git(variants[0].repo, args), git(variants[1].repo, args));
    for (const file of ['gh-stack', 'gt-github-sync']) {
      const contents = variants.map((v) => {
        const p = path.join(v.repo, '.git', file);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      });
      assert.equal(contents[0], contents[1], `${scenario}: ${file} differs`);
    }
    const summary = samples.map((s, i) => ({
      medianMs: percentile(s, 0.5),
      p90Ms: percentile(s, 0.9),
      samplesMs: s.map((n) => Number(n.toFixed(2))),
      ...traces[i],
    }));
    const speedup = Number(
      (summary[0].medianMs / summary[1].medianMs).toFixed(2)
    );
    console.log(
      `${scenario}: ${summary[0].medianMs} → ${summary[1].medianMs} ms (${speedup}x); Git processes ${traces[0].gitProcesses} → ${traces[1].gitProcesses}; parity OK`
    );
    results.push({
      scenario,
      baseline: summary[0],
      candidate: summary[1],
      speedup,
    });
  }
  const report = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    gitVersion: git(fixture, ['--version']),
    cpu: os.cpus()[0]?.model,
    branches: count,
    runs,
    nativeSafetyChecks: nativeChecks,
    mutations,
    command: 'gt --no-interactive log short (or create with --mutations)',
    baseline: path.resolve(baseline),
    candidate: path.resolve(candidate),
    fingerprintScope:
      'dist JS/CJS/JSON excluding tests, source maps and scripts/perf',
    baselineBuildSha256: fingerprint(baseline),
    candidateBuildSha256: fingerprint(candidate),
    results,
  };
  const output = option('--output');
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
