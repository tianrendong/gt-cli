#!/usr/bin/env node
// Offline integration: actual pi-stack tools/hooks, ordinary PATH-based gt calls.
// Every executable replacement and Git mutation is inside the owned fixture.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const piStack = arg('--pi-stack');
// Also exercise pi-graphite, where gt is the only remote Stack writer.
const noReconciler = process.argv.includes('--no-reconciler');
const blockSystemSqlite = process.argv.includes('--block-system-sqlite');
const globalDefault = process.argv.includes('--global-default');
const graphiteCloud = process.argv.includes('--graphite-cloud');
const loaderPath = arg('--pi-loader');
const native = arg('--graphite');
const reportPath = arg('--report');
if (!piStack || !loaderPath || !native || !reportPath)
  throw new Error(
    'Required: --pi-stack PATH --pi-loader PATH --graphite PATH --report PATH'
  );
const sourceCli = path.resolve(__dirname, '../..');
let cliRoot = sourceCli;
const packagePath = arg('--package');
const packageSpec = arg('--package-spec');
const installTarget = packageSpec ?? (packagePath && path.resolve(packagePath));
const packageName = require(path.join(sourceCli, 'package.json')).name;
const { stopIsolatedNativeHelpers } = require(path.join(
  cliRoot,
  'dist/src/lib/switch/native.js'
));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switch-test-'));
const repo = path.join(root, 'repo');
const initialEnv = { ...process.env };
const report = {
  fixture: root,
  repository: repo,
  originalRepositoryUsed: false,
  realGithubWrites: false,
  steps: [],
};
for (const directory of [repo, path.join(root, 'home'), path.join(root, 'bin')])
  fs.mkdirSync(directory);
Object.assign(process.env, {
  HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GRAPHITE_DISABLE_TELEMETRY: '1',
  GRAPHITE_DISABLE_UPGRADE_PROMPT: '1',
  GRAPHITE_DISABLE_SURVEY: '1',
  GRAPHITE_USER_CONFIG_PATH: path.join(root, 'home/user.json'),
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  PI_STACK_DEBUG: '1',
  GT_FAKE_GITHUB: path.join(root, 'github.json'),
});
delete process.env.GRAPHITE_INTERACTIVE;
delete process.env.PI_STACK_DRY_RUN;
fs.symlinkSync(native, path.join(root, 'bin/gt'));
fs.copyFileSync(
  path.join(sourceCli, 'test/fixtures/fake-gh.cjs'),
  path.join(root, 'bin/gh')
);
fs.chmodSync(path.join(root, 'bin/gh'), 0o755);
for (const name of ['brew', 'curl', 'wget'])
  fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
if (blockSystemSqlite) {
  fs.writeFileSync(
    path.join(root, 'bin/sqlite3'),
    '#!/bin/sh\nprintf invoked > "' +
      path.join(root, 'sqlite3-invoked') +
      '"\nexit 127\n',
    { mode: 0o755 }
  );
}
const exec = (file, args, options = {}) =>
  cp
    .execFileSync(file, args, {
      cwd: repo,
      env: process.env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
      maxBuffer: 32 << 20,
      ...options,
    })
    .trim();
const git = (args, input) => exec('git', args, { input });
const toggleBackend = (kind, args = []) =>
  JSON.parse(
    exec(path.join(cliRoot, `${kind}.sh`), [...args, '--json'], {
      cwd: args.includes('--global') ? root : repo,
    })
  );
const server = () => JSON.parse(fs.readFileSync(process.env.GT_FAKE_GITHUB));
const wirePR = (number, head, base) => ({
  id: 'PR_' + number,
  number,
  url: `https://github.com/test/repo/pull/${number}`,
  state: 'OPEN',
  title: head,
  body: 'Fixture description',
  headRefName: head,
  baseRefName: base,
  isDraft: true,
  reviewDecision: 'REVIEW_REQUIRED',
  isCrossRepository: false,
});
(async () => {
  if (installTarget) {
    const prefix = path.join(root, 'install');
    let artifact = packagePath && path.resolve(packagePath);
    if (packageSpec) {
      const packed = JSON.parse(
        cp.execFileSync(
          'npm',
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            root,
            packageSpec,
          ],
          { env: initialEnv, encoding: 'utf8', timeout: 120000 }
        )
      );
      artifact = path.join(root, packed[0].filename);
    }
    process.env.GT_CLI_HOME = prefix;
    const archive = arg('--node-archive');
    if (archive) {
      fs.mkdirSync(path.join(prefix, 'cache'), { recursive: true });
      fs.copyFileSync(
        archive,
        path.join(prefix, 'cache', path.basename(archive))
      );
    }
    const log = cp.execFileSync(
      path.join(sourceCli, 'install.sh'),
      ['--package', artifact, '--non-interactive', '--skip-auth'],
      {
        env: {
          ...process.env,
          HTTP_PROXY: initialEnv.HTTP_PROXY,
          HTTPS_PROXY: initialEnv.HTTPS_PROXY,
          NPM_CONFIG_USERCONFIG:
            initialEnv.NPM_CONFIG_USERCONFIG ??
            path.join(initialEnv.HOME, '.npmrc'),
        },
        encoding: 'utf8',
        timeout: 360000,
      }
    );
    cliRoot = path.join(prefix, 'current/app/node_modules', packageName);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(cliRoot, 'package.json'))
    );
    assert.equal(manifest.name, packageName);
    assert.deepEqual(
      typeof manifest.bin === 'string'
        ? { 'gt-cli': manifest.bin }
        : manifest.bin,
      { 'gt-cli': 'bin/gt-cli' }
    );
    assert(fs.existsSync(path.join(cliRoot, '.runtime-node')));
    assert(fs.existsSync(path.join(cliRoot, 'source.tar.gz')));
    assert(
      fs.existsSync(path.join(cliRoot, 'enable.sh')) &&
        fs.existsSync(path.join(cliRoot, 'disable.sh'))
    );
    report.packageInstall = log.trim();
    report.package = installTarget;
  }
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README'), 'initial\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const main = git(['rev-parse', 'HEAD']);
  for (const branch of ['one', 'two']) {
    git(['checkout', '-b', branch]);
    fs.writeFileSync(path.join(repo, branch + '.txt'), branch + '\n');
    git(['add', '.']);
    git(['commit', '-m', branch]);
  }
  const origin = path.join(root, 'origin.git');
  git(['init', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'main', 'one', 'two']);
  git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_repo_config'),
    JSON.stringify({
      trunk: 'main',
      trunks: [{ name: 'main' }],
      owner: 'test',
      name: 'repo',
      host: 'github.com',
      lastFetchedPRInfoMs: Date.now(),
      lastFetchedFeatureFlagsInMs: Date.now(),
    })
  );
  fs.writeFileSync(
    process.env.GRAPHITE_USER_CONFIG_PATH,
    JSON.stringify({ tips: false })
  );
  for (const [branch, parent] of [
    ['one', 'main'],
    ['two', 'one'],
  ]) {
    const base = git(['rev-parse', parent]);
    const meta = {
      parentBranchName: parent,
      parentBranchRevision: base,
      lastSubmittedVersion: {
        headSha: git(['rev-parse', branch]),
        baseSha: base,
        baseName: parent,
        versionNumber: 3,
      },
    };
    git([
      'update-ref',
      'refs/branch-metadata/' + branch,
      git(['hash-object', '-w', '--stdin'], JSON.stringify(meta)),
    ]);
  }
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_pr_info'),
    JSON.stringify({ prInfos: [], mergeabilityStatuses: [] })
  );
  exec(native, ['--cwd', repo, '--no-interactive', 'log', 'short', '--all']);
  stopIsolatedNativeHelpers(root, native);
  for (const branch of ['one', 'two'])
    git(['update-ref', '-d', 'refs/branch-metadata/' + branch]);
  const prs = [wirePR(101, 'one', 'main'), wirePR(102, 'two', 'one')];
  fs.writeFileSync(
    path.join(repo, '.git/.graphite_pr_info'),
    JSON.stringify({
      prInfos: prs.map((pr) => ({
        ...pr,
        prNumber: pr.number,
        authorGithubHandle: 'test',
        isBaseRefGraphiteBase: false,
        versions: [],
        cliTrunk: 'main',
      })),
      mergeabilityStatuses: [],
    })
  );
  fs.writeFileSync(
    process.env.GT_FAKE_GITHUB,
    JSON.stringify({
      gitDir: origin,
      next: 9001,
      prs,
      stacks: [{ number: 9000, base: 'main', prs: [101, 102] }],
      calls: [],
    })
  );
  const loader = await import(pathToFileURL(loaderPath).href);
  const loaded = await loader.loadExtensions(
    [path.join(piStack, 'src/index.ts')],
    repo
  );
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0],
    hook = extension.handlers.get('tool_result')?.[0];
  if (noReconciler) assert.equal(hook, undefined);
  else assert.equal(typeof hook, 'function');
  report.extension = piStack;
  report.noExtensionReconciler = noReconciler;
  const invoke = async (name, params, label) => {
    const input = { cwd: repo, ...params };
    const tool = extension.tools.get(name).definition;
    const result = await tool.execute(label, input);
    if (noReconciler) {
      report.steps.push({ label, name, outcome: { status: 'tool_succeeded' } });
      return result;
    }
    const patched = await hook(
      {
        toolName: name,
        input,
        content: result.content,
        details: result.details,
        isError: false,
      },
      { cwd: repo }
    );
    const debug = patched?.content?.find((part) =>
      part.text?.startsWith('--- remote stack metadata (debug) ---')
    );
    assert(
      debug,
      `${label}: hook did not report a verified outcome: ${JSON.stringify(
        patched
      )}`
    );
    const outcome = JSON.parse(debug.text.split('\n').slice(1).join('\n'));
    assert(
      ['in_sync', 'applied', 'planned'].includes(outcome.status),
      label + ': ' + JSON.stringify(outcome)
    );
    report.steps.push({ label, name, outcome });
    return result;
  };
  const cloudState = () =>
    JSON.parse(fs.readFileSync(path.join(root, 'cloud.json')));
  const submit = async (label, descriptions = []) => {
    const before = graphiteCloud ? cloudState().requests.length : 0;
    await invoke('graphite_submit', { apply: false }, label + '-preview');
    if (graphiteCloud)
      assert.equal(
        cloudState().requests.length,
        before,
        'Dry-run contacted Graphite'
      );
    await invoke(
      'graphite_submit',
      { apply: true, confirmRemote: true, draft: true, descriptions },
      label
    );
  };
  const move = async (branch, parent, label) => {
    await invoke(
      'graphite_move',
      { branch, parent, apply: false },
      label + '-preview'
    );
    await invoke(
      'graphite_move',
      { branch, parent, apply: true, confirmDestructive: true },
      label
    );
  };
  await invoke('graphite_status', {}, 'native-before-enable');
  if (globalDefault) {
    report.globalEnablePreview = toggleBackend('enable', [
      '--global',
      '--dry-run',
    ]);
    report.globalEnable = toggleBackend('enable', ['--global']);
    assert.equal(
      JSON.parse(exec('gt', ['--capabilities'], { cwd: root })).implementation,
      'gt-gh'
    );
    assert.equal(
      JSON.parse(exec('gt', ['--capabilities'])).migrationRequired,
      true
    );
  }
  report.enable = toggleBackend('enable');
  await invoke('graphite_status', {}, 'clone-same-loaded-extension');
  if (graphiteCloud) {
    if (!installTarget)
      throw Error('--graphite-cloud requires an installed package fixture');
    fs.writeFileSync(
      path.join(root, 'cloud.json'),
      JSON.stringify({ requests: [], failPr: 0, remaining: 0 })
    );
    process.env.GT_FAKE_GRAPHITE = path.join(root, 'cloud.json');
    process.env.GT_GRAPHITE_TOKEN = 'fixture-token';
    process.env.NO_PROXY = 'api.graphite.com';
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(
      path.join(sourceCli, 'test/fixtures/fake-graphite.cjs')
    )}`;
    exec('gt-cli', ['config', 'submit.graphite', 'true', '--repo', repo]);
  }
  await submit('adopt');
  await invoke(
    'graphite_navigate',
    { action: 'checkout', branch: 'one' },
    'parent-checkout'
  );
  fs.appendFileSync(path.join(repo, 'one.txt'), 'amended\n');
  await invoke(
    'graphite_change',
    { action: 'amend', message: 'amended parent' },
    'amend'
  );
  await submit('publish-amend');
  await invoke(
    'graphite_navigate',
    { action: 'checkout', branch: 'two' },
    'child-checkout'
  );
  fs.writeFileSync(path.join(repo, 'three.txt'), 'three\n');
  git(['add', 'three.txt']);
  await invoke(
    'graphite_change',
    { action: 'create', name: 'three', message: 'third change' },
    'create-third'
  );
  await submit('append', [
    { branch: 'three', body: 'Third fixture description' },
  ]);
  const third = server().prs.find((pr) => pr.headRefName === 'three').number;
  const identities = server().prs.map((pr) => [pr.headRefName, pr.number]);
  await move('three', 'main', 'split-third');
  assert.equal(
    server().stacks.length,
    noReconciler ? 1 : 0,
    noReconciler
      ? 'local move should leave remote Stack writes to submit'
      : 'legacy hook should have unstacked the former three-member stack'
  );
  await submit('publish-split');
  assert.deepEqual(
    server().stacks.map((stack) => stack.prs),
    [[101, 102]],
    'gt must repair the remaining segment after an external writer unstacked it'
  );
  await invoke(
    'graphite_navigate',
    { action: 'checkout', branch: 'two' },
    'select-pair'
  );
  await move('two', 'main', 'detach-second');
  await invoke(
    'graphite_navigate',
    { action: 'checkout', branch: 'one' },
    'select-new-top'
  );
  await move('one', 'two', 'reverse-pair');
  await submit('publish-reordered');
  assert.deepEqual(
    server().stacks.map((stack) => stack.prs),
    [[102, 101]]
  );
  const cloudBeforeNoop = graphiteCloud ? cloudState().requests.length : 0;
  await submit('idempotent');
  if (graphiteCloud)
    assert.equal(cloudState().requests.length, cloudBeforeNoop);
  assert.deepEqual(
    server().prs.map((pr) => [pr.headRefName, pr.number]),
    identities
  );
  assert.equal(
    server().prs.find((pr) => pr.number === third).baseRefName,
    'main'
  );
  const heads = git(['show-ref', '--heads']);
  if (graphiteCloud) {
    report.graphiteRequests = cloudState().requests;
    assert(report.graphiteRequests.length > 0);
    assert.deepEqual(
      report.graphiteRequests
        .slice(0, 2)
        .map((request) => request.prs.map((pr) => pr.prNumber)),
      [[101], [102]],
      'Initial Graphite updates must use singleton POSTs in parent order'
    );
    assert(
      report.graphiteRequests.every(
        (request) =>
          request.prs.length === 1 && request.prs[0].action === 'update'
      )
    );
    report.graphiteCloudVerified = true;
    for (const key of [
      'NODE_OPTIONS',
      'NO_PROXY',
      'GT_GRAPHITE_TOKEN',
      'GT_FAKE_GRAPHITE',
    ]) {
      if (initialEnv[key] === undefined) delete process.env[key];
      else process.env[key] = initialEnv[key];
    }
  }
  report.disable = toggleBackend('disable');
  await invoke('graphite_status', {}, 'native-after-disable-same-extension');
  if (globalDefault) {
    const fresh = path.join(root, 'global-fresh');
    fs.mkdirSync(fresh);
    const freshGit = (args) => exec('git', ['-C', fresh, ...args]);
    freshGit(['init', '-b', 'main']);
    freshGit([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    exec('gt', ['--cwd', fresh, '--no-interactive', 'info', 'main']);
    const newState = JSON.parse(
      fs.readFileSync(path.join(fresh, '.git/gt-gh-switch/state.json'))
    );
    assert.equal(newState.nativeAbsent, true);
    report.globalDisable = toggleBackend('disable', ['--global']);
    assert.equal(report.globalDisable.restored, true);
    assert.equal(exec('gt', ['--cwd', fresh, '--version']), '1.8.6');
    assert(
      report.globalDisable.completed
        .map((p) => fs.realpathSync(p))
        .includes(fs.realpathSync(fresh))
    );
    assert.equal(exec('gt', ['--version'], { cwd: root }), '1.8.6');
    report.globalModeVerified = true;
  }
  if (installTarget) {
    fs.rmSync(path.join(root, 'install'), { recursive: true, force: true });
    await invoke(
      'graphite_status',
      {},
      'native-after-uninstall-same-extension'
    );
    report.nativeWorksAfterUninstall = true;
  }
  assert.equal(git(['show-ref', '--heads']), heads);
  assert.equal(fs.readlinkSync(path.join(root, 'bin/gt')), native);
  if (blockSystemSqlite) {
    assert.equal(fs.existsSync(path.join(root, 'sqlite3-invoked')), false);
    report.noSystemSqliteUsed = true;
  }
  report.passed = true;
  report.unchangedLoadedPiStack = true;
  report.existingHeadsKeptOnDisable = true;
})()
  .catch((error) => {
    report.error = error.stack;
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      stopIsolatedNativeHelpers(root, native);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      report.cleanupComplete = true;
    } finally {
      Object.keys(process.env).forEach((key) => {
        if (!(key in initialEnv)) delete process.env[key];
      });
      Object.assign(process.env, initialEnv);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(reportPath);
    }
  });
