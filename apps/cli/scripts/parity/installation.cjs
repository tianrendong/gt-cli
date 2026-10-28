#!/usr/bin/env node
// Real installer, private runtime, native Graphite, disposable PATH/HOME only.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  cp = require('child_process'),
  assert = require('assert/strict');
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const cli = path.resolve(__dirname, '../..');
const native = arg('--graphite'),
  reportPath = arg('--report');
if (!native || !reportPath)
  throw Error(
    'Required: --graphite PATH --report PATH. Optional: --package TGZ --node-archive TGZ --ambient-node PATH --legacy-cli PATH --package-out DIRECTORY --repeat --update-tests'
  );
const { stopIsolatedNativeHelpers, ...nativeApi } = require(path.join(
  cli,
  'dist/src/lib/switch/native.js'
));
const { nativeRows } = require(path.join(
  cli,
  'dist/src/lib/switch/repository.js'
));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switch-test-install-'));
const home = path.join(root, 'home'),
  bin = path.join(root, 'bin'),
  repo = path.join(root, 'repo');
for (const p of [home, bin, repo]) fs.mkdirSync(p);
const which = (name) =>
  cp.execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
for (const [name, target] of [
  ['git', which('git')],
  ['gh', which('gh')],
  ['gt', native],
])
  fs.symlinkSync(target, path.join(bin, name));
fs.writeFileSync(
  path.join(bin, 'node'),
  '#!/bin/sh\necho "ambient Node must not run" >&2\nexit 99\n',
  { mode: 0o755 }
);
const sqliteSentinel = path.join(root, 'sqlite-invoked');
fs.writeFileSync(
  path.join(bin, 'sqlite3'),
  '#!/bin/sh\necho invoked > "' + sqliteSentinel + '"\nexit 99\n',
  { mode: 0o755 }
);
const env = {
  ...process.env,
  HOME: home,
  PATH: bin + ':/usr/bin:/bin',
  GT_CLI_HOME: path.join(home, "install with quote's"),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GRAPHITE_DISABLE_TELEMETRY: '1',
  GRAPHITE_DISABLE_UPGRADE_PROMPT: '1',
  GRAPHITE_DISABLE_SURVEY: '1',
};
for (const key of [
  'GT_NODE_BIN',
  'GT_GH_LAUNCHER_RECORD',
  'GRAPHITE_INTERACTIVE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
])
  delete env[key];
const cached = arg('--node-archive');
if (cached) {
  fs.mkdirSync(path.join(env.GT_CLI_HOME, 'cache'), { recursive: true });
  fs.copyFileSync(
    cached,
    path.join(env.GT_CLI_HOME, 'cache', path.basename(cached))
  );
}
const exec = (file, args, cwd = repo, extra = {}) =>
  cp
    .execFileSync(file, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 360000,
      maxBuffer: 64 << 20,
      ...extra,
    })
    .trim();
const git = (args) => exec('git', args);
const report = {
  fixture: root,
  originalRepositoryUsed: false,
  realGithubWrites: false,
  steps: [],
  passed: false,
  cleanupComplete: false,
};
const sourceDist = path.join(cli, 'dist/src/gt_cli.js'),
  distBefore = fs.readFileSync(sourceDist);
function install(packageFile = arg('--package')) {
  const args = ['--non-interactive', '--skip-auth'];
  if (packageFile) args.push('--package', path.resolve(packageFile));
  const log = exec(path.join(cli, 'install.sh'), args, root);
  report.steps.push('install');
  fs.appendFileSync(reportPath + '.install.log', log + '\n');
  assert(
    fs.readFileSync(sourceDist).equals(distBefore),
    'Installer rebuilt the source installation in place'
  );
  return fs.realpathSync(
    path.join(env.GT_CLI_HOME, 'current/app/node_modules/@tianrendong/gt-cli')
  );
}
function pack(installed, directory) {
  const node = fs.realpathSync(path.join(installed, '.runtime-node'));
  const npm = path.resolve(
    path.dirname(node),
    '../lib/node_modules/npm/bin/npm-cli.js'
  );
  fs.mkdirSync(directory, { recursive: true });
  const result = JSON.parse(
    exec(
      node,
      [
        npm,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
        installed,
      ],
      root
    )
  );
  return path.join(directory, result[0].filename);
}
try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(repo, 'feature'), 'work\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature']);
  const published = git(['rev-parse', 'HEAD']);
  const origin = path.join(root, 'origin.git');
  git(['init', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'main', 'feature']);
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_pr_info'),
    JSON.stringify({ prInfos: [], mergeabilityStatuses: [] })
  );
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_repo_config'),
    JSON.stringify({
      trunk: 'main',
      trunks: [{ name: 'main' }],
      host: 'github.com',
      owner: 'test',
      name: 'repo',
    })
  );
  const blob = exec('git', ['hash-object', '-w', '--stdin'], repo, {
    input: JSON.stringify({
      parentBranchName: 'main',
      parentBranchRevision: base,
      lastSubmittedVersion: {
        headSha: published,
        baseSha: base,
        baseName: 'main',
        versionNumber: 5,
      },
    }),
  });
  git(['update-ref', 'refs/branch-metadata/feature', blob]);
  exec(native, ['log', 'short', '--all', '--no-interactive']);
  stopIsolatedNativeHelpers(root, native);
  const seeded = nativeRows(path.join(repo, '.git/.graphite_metadata.db')).find(
    (row) => row.branch_name === 'feature'
  );
  assert.equal(
    seeded?.parent_branch_name,
    'main',
    'Native fixture did not import its parent'
  );
  assert.equal(JSON.parse(seeded.last_submitted_version).headSha, published);
  git(['update-ref', '-d', 'refs/branch-metadata/feature']);
  const legacy = arg('--legacy-cli');
  if (legacy) {
    const legacyEnv = { ...env, GT_NODE_BIN: process.execPath };
    exec(path.join(legacy, 'enable.sh'), ['--repo', repo], root, {
      env: legacyEnv,
    });
    exec(path.join(legacy, 'enable.sh'), ['--global'], root, {
      env: legacyEnv,
    });
    const selection = path.join(repo, '.git/gt-gh-switch/state.json'),
      state = JSON.parse(fs.readFileSync(selection));
    state.candidate.node = '/missing/old-node';
    fs.writeFileSync(selection, JSON.stringify(state));
    report.steps.push('legacy installation fixture');
  }
  let installed = install();
  const initialInstall = installed;
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  let version = pkg.version;
  const configEnv = {
    ...env,
    GIT_CONFIG_GLOBAL: path.join(root, 'git-config'),
  };
  const config = (args) =>
    JSON.parse(
      exec('gt-cli', ['config', 'submit.graphite', ...args, '--json'], root, {
        env: configEnv,
      })
    );
  const nativeBeforeConfig = fs.readFileSync(
    path.join(repo, '.git/.graphite_metadata.db')
  );
  assert.equal(config(['true', '--global']).enabled, true);
  assert.equal(config(['false', '--repo', repo]).enabled, false);
  assert.equal(config(['--unset', '--repo', repo]).enabled, true);
  assert.equal(config(['--unset', '--global']).enabled, false);
  const graphite = (args) =>
    JSON.parse(
      exec('gt-cli', ['graphite', ...args, '--json'], root, { env: configEnv })
    );
  assert.equal(graphite(['enable', '--global']).enabled, true);
  assert.equal(graphite(['disable', '--repo', repo]).enabled, false);
  assert.equal(config(['--repo', repo]).enabled, false);
  assert.equal(graphite(['status', '--repo', repo]).source, 'repository');
  assert.equal(graphite(['reset', '--repo', repo]).enabled, true);
  assert.equal(graphite(['disable', '--global']).enabled, false);
  assert.equal(graphite(['enable', '--repo', repo]).enabled, true);
  assert.equal(config(['--unset', '--repo', repo]).enabled, false);
  assert.equal(graphite(['reset', '--global']).value, null);
  assert(
    exec('gt-cli', ['--help'], root).includes(
      'gt-cli graphite <enable|disable|status|reset>'
    )
  );
  assert.equal(exec('gt', ['--version'], repo), '1.8.6');
  report.graphiteControlsVerified = true;
  assert(
    fs
      .readFileSync(path.join(repo, '.git/.graphite_metadata.db'))
      .equals(nativeBeforeConfig)
  );
  report.steps.push(
    'installed global/repository Graphite settings work without backend or auth changes'
  );
  if (arg('--package-out'))
    report.package = pack(installed, path.resolve(arg('--package-out')));
  exec('gt-cli', ['enable', '--global'], root);
  report.steps.push('enable --global');
  assert.equal(exec('gt', ['--version'], root), version);
  assert.match(exec('gt', ['info', 'feature']), /Parent: main/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(repo, '.git/gt-gh-switch/state.json')))
      .candidate.script,
    path.join(installed, 'dist/src/index.js')
  );
  report.steps.push('native migration or legacy binding refresh');
  const oldNode = arg('--ambient-node');
  if (oldNode) {
    fs.unlinkSync(path.join(bin, 'node'));
    fs.symlinkSync(path.resolve(oldNode), path.join(bin, 'node'));
    const hook = path.join(repo, '.git/hooks/pre-commit');
    fs.writeFileSync(
      hook,
      '#!/bin/sh\nnode --version > "' + path.join(root, 'hook-node') + '"\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(repo, 'child'), 'child\n');
    exec('gt', [
      'create',
      'child',
      '--all',
      '--message',
      'child',
      '--no-interactive',
    ]);
    assert.equal(
      fs.readFileSync(path.join(root, 'hook-node'), 'utf8').trim(),
      exec(path.resolve(oldNode), ['--version'])
    );
    report.steps.push('project Git hook retains ambient Node');
  }
  const refs = git(['show-ref', '--heads']);
  fs.appendFileSync(path.join(repo, 'feature'), 'staged\n');
  git(['add', 'feature']);
  fs.appendFileSync(path.join(repo, 'feature'), 'unstaged\n');
  fs.writeFileSync(path.join(repo, 'untracked'), 'keep\n');
  const index = fs.readFileSync(path.join(repo, '.git/index')),
    status = git(['status', '--porcelain=v1']);
  const fresh = path.join(root, 'fresh');
  fs.mkdirSync(fresh);
  exec('git', ['init', '-b', 'main'], fresh);
  exec(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ],
    fresh
  );
  const inspectFresh = cp.spawnSync(
    path.join(bin, 'gt'),
    ['info', 'main', '--no-interactive'],
    { cwd: fresh, env, encoding: 'utf8' }
  );
  assert.equal(inspectFresh.status, 1);
  assert.match(inspectFresh.stdout + inspectFresh.stderr, /Run gt init/);
  exec('gt-cli', ['enable', '--repo', fresh], root);
  assert.equal(
    fs.existsSync(path.join(fresh, '.git/.graphite_repo_config')),
    false
  );
  assert.equal(fs.existsSync(path.join(fresh, '.git/gt-gh-switch')), false);
  const selectionOnly = JSON.parse(
    exec('gt-cli', ['enable', '--repo', fresh, '--status'], root)
  );
  assert.equal(selectionOnly.initialized, false);
  assert.equal(
    selectionOnly.repositories.includes(
      fs.realpathSync(path.join(fresh, '.git'))
    ),
    false
  );
  exec('gt', ['init', '--trunk', 'main', '--no-interactive'], fresh);
  exec('gt', ['info', 'main'], fresh);
  report.steps.push(
    'fresh inspection does not enroll; implementation selection leaves setup absent; explicit gt init enrolls'
  );
  if (process.argv.includes('--repeat')) {
    const artifact = pack(installed, path.join(root, 'artifact'));
    installed = install(artifact);
    assert(
      fs.existsSync(path.join(initialInstall, 'dist/src/index.js')),
      'Installer deleted an active version'
    );
    exec('gt-cli', ['enable', '--global'], root);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(repo, '.git/gt-gh-switch/state.json'))
      ).candidate.script,
      path.join(installed, 'dist/src/index.js')
    );
    report.steps.push('immutable upgrade and global rebind');
  }
  if (process.argv.includes('--update-tests')) {
    ({ installed, version } = require('./update_scenarios.cjs')({
      root,
      bin,
      env,
      exec,
      repo,
      fresh,
      installed,
      pack,
      report,
    }));
  }
  exec('gt-cli', ['disable', '--global'], root);
  report.steps.push('disable --global');
  assert.equal(fs.readlinkSync(path.join(bin, 'gt')), native);
  if (process.argv.includes('--update-tests')) {
    exec('gt-cli', ['update'], root);
    assert.equal(fs.readlinkSync(path.join(bin, 'gt')), native);
    report.steps.push('update preserves disabled global/native mode');
  }
  assert.equal(exec('gt', ['--version'], fresh), '1.8.6');
  assert.equal(git(['show-ref', '--heads']), refs);
  assert(fs.readFileSync(path.join(repo, '.git/index')).equals(index));
  assert.equal(git(['status', '--porcelain=v1']), status);
  const row = nativeRows(path.join(repo, '.git/.graphite_metadata.db')).find(
    (row) => row.branch_name === 'feature'
  );
  assert.equal(JSON.parse(row.last_submitted_version).headSha, published);
  exec('gt-cli', ['enable', '--repo', repo], root);
  assert.equal(exec('gt', ['--version']), version);
  exec('gt-cli', ['disable', '--repo', repo], root);
  report.steps.push('repo enable/disable');
  assert.equal(fs.existsSync(sqliteSentinel), false);
  report.privateNode = exec(
    fs.realpathSync(path.join(installed, '.runtime-node')),
    ['--version']
  );
  report.noAmbientNodeRequired = true;
  report.noSystemSqliteUsed = true;
  report.nativeWorksAfterDisable = true;
  report.sourceBuildUnchanged = fs.readFileSync(sourceDist).equals(distBefore);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  report.stderr = error.stderr?.toString();
  report.stdout = error.stdout?.toString();
  process.exitCode = 1;
} finally {
  stopIsolatedNativeHelpers(root, native);
  if (report.passed || !process.argv.includes('--keep-on-failure'))
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  report.cleanupComplete = !fs.existsSync(root);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(reportPath);
  if (!report.passed)
    console.error(report.error, report.stdout || '', report.stderr || '');
}
