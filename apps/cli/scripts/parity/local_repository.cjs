#!/usr/bin/env node
/**
 * Destructive CLI tests run ONLY in a newly created, isolated local clone.
 * The source repository is read-only. No GitHub writes or pushes are permitted.
 * Usage: node scripts/parity/local_repository.cjs --source /path/to/repo --trunk master
 *        [--gh-stack /path/to/gh-stack]
 */
const assert = require('assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const source = option('--source') && fs.realpathSync(option('--source'));
if (!source || !fs.statSync(source).isDirectory())
  throw new Error('Pass --source pointing to a local Git repository.');
const trunk = option('--trunk') || 'main';
const ghStack = option('--gh-stack');
const cli = path.resolve(__dirname, '../../dist/src/index.js');
if (!fs.existsSync(cli)) throw new Error('Build the CLI first.');
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'gt-repository-parity-')
);
const repo = path.join(directory, 'repo');
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GH_PROMPT_DISABLED: '1',
  GH_CONFIG_DIR: path.join(directory, 'gh-config'),
  GH_REPO: '',
  GH_HOST: '',
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GH_ENTERPRISE_TOKEN: '',
  GITHUB_ENTERPRISE_TOKEN: '',
  GRAPHITE_PROFILE: '',
  GT_PAGER: '',
};
for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
])
  delete env[name];
const commands = [];
const checks = [];
function exec(executable, argv, cwd = repo, expected = 0) {
  const result = cp.spawnSync(executable, argv, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  commands.push({
    executable,
    argv,
    cwd,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(
    result.status,
    expected,
    `${executable} ${argv.join(' ')}\n${result.stdout}\n${result.stderr}\n${
      result.error || ''
    }`
  );
  return result.stdout;
}
const git = (argv, cwd = repo) => exec('git', argv, cwd).trim();
const gt = (argv, cwd = repo, expected = 0) =>
  exec(
    process.execPath,
    [cli, '--cwd', cwd, '--no-interactive', '--no-verify', ...argv],
    cwd,
    expected
  );
const refs = (cwd) =>
  git(
    [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/',
      'refs/branch-metadata/',
    ],
    cwd
  );
const sourceBefore = {
  refs: refs(source),
  status: git(['status', '--porcelain=v1'], source),
};
const probe = 'gt-gh-parity-probe';
const branches = Object.fromEntries(
  ['a', 'b', 'c', 'inserted', 'gh', 'renamed', 'split', 'undo', 'pop'].map(
    (name) => [name, `gt-gh-parity-${name}`]
  )
);
function file(name, contents, cwd = repo) {
  fs.mkdirSync(path.join(cwd, probe), { recursive: true });
  fs.writeFileSync(path.join(cwd, probe, `${name}.txt`), contents + '\n');
}
function check(name, fn) {
  fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
function create(name) {
  file(name, name);
  gt(['create', branches[name], '-am', `Parity: ${name}`]);
}
function parents(expected, cwd = repo) {
  const state = JSON.parse(gt(['state'], cwd));
  for (const [branch, parent] of Object.entries(expected))
    assert.equal(state.branches[branch].parentBranchName, parent);
  const gitDir = git(['rev-parse', '--git-dir'], cwd);
  const mirror = JSON.parse(
    fs.readFileSync(path.resolve(cwd, gitDir, 'gh-stack'), 'utf8')
  );
  const actual = new Map();
  for (const stack of mirror.stacks) {
    let parent = stack.trunk.branch;
    for (const branch of stack.branches) {
      assert(!actual.has(branch.branch));
      actual.set(branch.branch, parent);
      parent = branch.branch;
    }
  }
  for (const [branch, parent] of Object.entries(expected))
    assert.equal(actual.get(branch), parent);
}
function view(cwd = repo) {
  assert(ghStack, '--gh-stack is required for interoperability tests');
  return JSON.parse(exec(ghStack, ['view', '--json'], cwd));
}
let failure;
try {
  exec(
    'git',
    ['clone', '--shared', '--single-branch', '--branch', trunk, source, repo],
    directory
  );
  git(['config', 'user.name', 'gt-gh parity test']);
  git(['config', 'user.email', 'gt-gh-parity@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'remote.origin.pushurl', 'disabled://parity-test']);
  const hooks = path.join(directory, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(
    path.join(hooks, 'pre-push'),
    '#!/bin/sh\necho "Push disabled in parity tests" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_repo_config'),
    JSON.stringify({ trunk, isGithubIntegrationEnabled: false })
  );
  const userConfig = path.join(directory, 'user-config');
  fs.writeFileSync(
    userConfig,
    JSON.stringify({ tips: false, branchPrefix: '' })
  );
  env.GRAPHITE_USER_CONFIG_PATH = userConfig;
  gt(['init', '--trunk', trunk]);

  check('create three stacked branches and mirror parents', () => {
    create('a');
    create('b');
    create('c');
    parents({
      [branches.a]: trunk,
      [branches.b]: branches.a,
      [branches.c]: branches.b,
    });
  });
  check('navigation and inspection', () => {
    gt(['bottom']);
    assert.equal(git(['branch', '--show-current']), branches.a);
    gt(['up', '2']);
    assert.equal(git(['branch', '--show-current']), branches.c);
    gt(['down']);
    assert.equal(git(['branch', '--show-current']), branches.b);
    gt(['top']);
    assert.equal(git(['branch', '--show-current']), branches.c);
    assert(gt(['log', '--stack']).includes(branches.a));
    assert.equal(gt(['trunk']).trim(), trunk);
    gt(['checkout', '--trunk']);
    gt(['checkout', branches.c]);
  });
  check('amend restacks descendants', () => {
    gt(['checkout', branches.a]);
    file('a', 'amended');
    gt(['modify', '-am', 'Parity: amend']);
    assert.equal(
      git(['merge-base', branches.a, branches.b]),
      git(['rev-parse', branches.a])
    );
    assert.equal(
      git(['merge-base', branches.b, branches.c]),
      git(['rev-parse', branches.b])
    );
  });
  check('modify --into preserves branch-local diffs', () => {
    gt(['checkout', branches.c]);
    file('a', 'into');
    git(['add', '--', `${probe}/a.txt`]);
    gt(['modify', '--into', branches.a, '-m', 'Parity: into']);
    assert.equal(git(['show', `${branches.a}:${probe}/a.txt`]), 'into');
    assert.equal(git(['branch', '--show-current']), branches.c);
  });
  check('absorb routes staged hunks to their owner', () => {
    file('b', 'absorbed');
    git(['add', '--', `${probe}/b.txt`]);
    assert(gt(['absorb', '--dry-run']).includes(branches.b));
    gt(['absorb', '--force']);
    assert.equal(git(['show', `${branches.b}:${probe}/b.txt`]), 'absorbed');
  });
  check('insert reparents and restacks children', () => {
    gt(['checkout', branches.a]);
    file('inserted', 'inserted');
    gt(['create', branches.inserted, '-am', 'Parity: insert', '--insert']);
    parents({
      [branches.inserted]: branches.a,
      [branches.b]: branches.inserted,
      [branches.c]: branches.b,
    });
    gt(['top']);
  });
  if (ghStack) {
    check('installed gh-stack reads the gt-produced stack', () => {
      const output = view();
      assert.equal(output.currentBranch, branches.c);
      assert.deepEqual(
        output.branches.map((b) => b.name),
        [branches.a, branches.inserted, branches.b, branches.c]
      );
    });
    check('installed gh-stack add imports back into gt', () => {
      exec(ghStack, ['add', branches.gh]);
      assert.equal(gt(['parent']).trim(), branches.c);
      file('gh', 'gh');
      gt(['modify', '--commit', '-am', 'Parity: gh-stack branch']);
      assert.equal(view().currentBranch, branches.gh);
    });
  } else create('gh');
  check('rename updates both local representations', () => {
    gt(['rename', branches.renamed]);
    parents({ [branches.renamed]: branches.c });
    if (ghStack)
      assert(view().branches.some((b) => b.name === branches.renamed));
  });
  check('move --only leaves descendants on the original parent', () => {
    gt(['move', '--source', branches.inserted, '--onto', trunk, '--only']);
    parents({ [branches.inserted]: trunk, [branches.b]: branches.a });
  });
  check('move joins a branch onto the stack tip', () => {
    gt(['move', '--source', branches.inserted, '--onto', branches.renamed]);
    parents({ [branches.inserted]: branches.renamed });
    gt(['top']);
  });
  check('non-interactive reorder preserves commits and parent pointers', () => {
    gt([
      'reorder',
      '--order',
      [
        branches.b,
        branches.a,
        branches.c,
        branches.renamed,
        branches.inserted,
      ].join(','),
    ]);
    parents({
      [branches.b]: trunk,
      [branches.a]: branches.b,
      [branches.c]: branches.a,
      [branches.renamed]: branches.c,
      [branches.inserted]: branches.renamed,
    });
  });
  check('fold and squash preserve files', () => {
    gt(['fold']);
    gt(['squash', '-m', 'Parity: folded']);
    assert.equal(
      git(['rev-list', '--count', `${branches.c}..${branches.renamed}`]),
      '1'
    );
    assert.equal(
      git(['show', `${branches.renamed}:${probe}/inserted.txt`]),
      'inserted'
    );
  });
  check('split by commit creates a mirrored chain', () => {
    file('split', 'split');
    gt(['modify', '--commit', '-am', 'Parity: split']);
    gt([
      'split',
      '--by-commit',
      '--names',
      `${branches.renamed},${branches.split}`,
    ]);
    parents({ [branches.split]: branches.renamed });
  });
  check('freeze protects branches until unfreeze', () => {
    gt(['freeze']);
    file('split', 'blocked');
    gt(['modify', '-am', 'Must not commit'], repo, 1);
    file('split', 'split');
    // freeze affects the whole downstack; unfreeze from the bottom branch.
    gt(['unfreeze', branches.b]);
    assert.equal(git(['status', '--porcelain']), '');
  });
  check('undo restores checkout and untracked pre-operation files', () => {
    create('undo');
    gt(['undo', '--force']);
    assert.equal(git(['branch', '--show-current']), branches.split);
    assert(fs.existsSync(path.join(repo, probe, 'undo.txt')));
    fs.unlinkSync(path.join(repo, probe, 'undo.txt'));
  });
  check('pop preserves working files while deleting the branch', () => {
    create('pop');
    gt(['pop']);
    assert.equal(git(['branch', '--show-current']), branches.split);
    assert(fs.existsSync(path.join(repo, probe, 'pop.txt')));
    fs.unlinkSync(path.join(repo, probe, 'pop.txt'));
  });
  check('delete updates metadata and checks out the parent', () => {
    gt(['delete', branches.split, '--force']);
    assert.equal(git(['branch', '--show-current']), branches.renamed);
  });
  check('stack test visits branches without leaving changes', () => {
    gt(['test', '--downstack', 'git diff --quiet']);
    assert.equal(git(['status', '--porcelain']), '');
    if (ghStack) assert.equal(view().currentBranch, branches.renamed);
  });
  check(
    'linked worktrees get gh-stack-compatible metadata and independent undo',
    () => {
      const wt = path.join(directory, 'worktree');
      git(['worktree', 'add', '-b', 'gt-gh-parity-worktree', wt, trunk]);
      gt(['track', 'gt-gh-parity-worktree', '--parent', trunk], wt);
      file('worktree', 'worktree', wt);
      gt(
        ['create', 'gt-gh-parity-worktree-child', '-am', 'Parity: worktree'],
        wt
      );
      parents({ 'gt-gh-parity-worktree-child': 'gt-gh-parity-worktree' }, wt);
      if (ghStack)
        assert.equal(view(wt).currentBranch, 'gt-gh-parity-worktree-child');
      gt(['undo', '--force'], wt);
      assert.equal(
        git(['branch', '--show-current'], wt),
        'gt-gh-parity-worktree'
      );
      assert.equal(git(['branch', '--show-current']), branches.renamed);
    }
  );
} catch (error) {
  failure = error.stack || String(error);
} finally {
  const sourceAfter = {
    refs: refs(source),
    status: git(['status', '--porcelain=v1'], source),
  };
  try {
    assert.deepEqual(sourceAfter, sourceBefore);
    checks.push('source refs, metadata refs, and working tree unchanged');
  } catch (error) {
    failure = `${failure || ''}\nSource verification failed: ${error.stack}`;
  }
  const report = { source, trunk, sandbox: repo, checks, failure, commands };
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2)
  );
  process.stdout.write(
    `\n${checks.length} checks passed. Sandbox: ${repo}\nReport: ${path.join(
      directory,
      'report.json'
    )}\n`
  );
  if (failure) {
    process.stderr.write(failure + '\n');
    process.exitCode = 1;
  }
}
