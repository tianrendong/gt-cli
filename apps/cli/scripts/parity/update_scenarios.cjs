// Offline registry/fault injection is fixture-local. Production updater receives
// no test flags or alternate registry/TLS settings. Actual npm dependency install,
// private Node bootstrap, locks, management command and gt dispatcher all run.
const fs = require('fs'),
  path = require('path'),
  cp = require('child_process');
const crypto = require('crypto'),
  assert = require('assert/strict');
module.exports = function updateScenarios({
  root,
  bin,
  env,
  exec,
  repo,
  fresh,
  installed,
  pack,
  report,
}) {
  const home = fs.realpathSync(env.GT_CLI_HOME),
    current = path.join(home, 'current');
  const originalPointer = fs.readlinkSync(current);
  const linked = path.join(root, 'update-linked');
  exec('git', ['worktree', 'add', '--detach', linked, 'HEAD'], fresh);
  const linkedHead = exec('git', ['rev-parse', 'HEAD'], linked);
  // Deleted linked checkouts must not require manual pruning before updates.
  const deleted = path.join(root, 'update-deleted-linked');
  exec('git', ['worktree', 'add', '--detach', deleted, 'HEAD'], fresh);
  const deletedGit = exec('git', ['rev-parse', '--absolute-git-dir'], deleted);
  const deletedIndex = fs.readFileSync(path.join(deletedGit, 'index'));
  fs.rmSync(deleted, { recursive: true });
  const staleWorktrees = exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    fresh
  );
  const optOut = path.join(root, 'update-native-opt-out');
  fs.mkdirSync(optOut);
  exec('git', ['init', '-b', 'main'], optOut);
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
    optOut
  );
  exec('gt-cli', ['disable', '--repo', optOut], root);
  const optOutFile = path.join(optOut, '.git/gt-gh-switch/last.json');
  assert.equal(fs.existsSync(optOutFile), false);
  const originalPackage = pack(installed, path.join(root, 'update-original'));
  const registry = path.join(root, 'registry.json'),
    calls = path.join(root, 'registry-calls');
  const source = path.join(root, 'fake-source-checkout');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: '@tianrendong/gt-cli',
      version: '999.0.0',
      bin: 'missing-command',
    })
  );
  function variant(version) {
    const folder = path.join(root, 'registry-' + version);
    fs.mkdirSync(folder);
    exec('tar', ['-xzf', originalPackage, '-C', folder], root);
    for (const file of ['package/package.json', 'package/dist/package.json']) {
      const p = path.join(folder, file),
        data = JSON.parse(fs.readFileSync(p));
      data.version = version;
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    }
    const file = path.join(root, `fixture-${version}.tgz`);
    exec('tar', ['-czf', file, '-C', folder, 'package'], root, {
      env: { ...env, COPYFILE_DISABLE: '1' },
    });
    return {
      file,
      name: '@tianrendong/gt-cli',
      version,
      dist: {
        integrity:
          'sha512-' +
          crypto
            .createHash('sha512')
            .update(fs.readFileSync(file))
            .digest('base64'),
      },
    };
  }
  const currentVersion = JSON.parse(
    fs.readFileSync(path.join(installed, 'package.json'))
  ).version;
  const firstVersion = require('semver').inc(currentVersion, 'patch');
  const first = variant(firstVersion),
    second = variant(require('semver').inc(firstVersion, 'patch'));
  let config = { metadata: first, home, calls };
  const save = () => fs.writeFileSync(registry, JSON.stringify(config));
  save();
  function mockRegistry(packageRoot) {
    const node = fs.realpathSync(path.join(packageRoot, '.runtime-node'));
    const npm = path.resolve(
      path.dirname(node),
      '../lib/node_modules/npm/bin/npm-cli.js'
    );
    const original = path.join(path.dirname(npm), 'npm-cli-real.cjs');
    if (!fs.existsSync(original)) fs.copyFileSync(npm, original);
    fs.writeFileSync(
      npm,
      `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const config=JSON.parse(fs.readFileSync(${JSON.stringify(registry)}));
const args=process.argv.slice(2);
if(args[0]==='view'||(args[0]==='pack'&&args[1].startsWith('@tianrendong/gt-cli@'))){
 if(fs.realpathSync(process.cwd())!==config.home)throw Error('Updater used caller workspace');
 if(!args.includes('--registry=https://registry.npmjs.org/'))throw Error('Unexpected registry');
 fs.appendFileSync(config.calls,JSON.stringify(args)+'\\n');
 if(config.offline){console.error('fixture registry unavailable');process.exit(19)}
 if(args[0]==='view'){console.log(JSON.stringify(config.metadata));process.exit(0)}
 const dest=args[args.indexOf('--pack-destination')+1],name='registry-package.tgz';
 fs.copyFileSync(config.metadata.file,path.join(dest,name));
 if(config.tamper)fs.appendFileSync(path.join(dest,name),'tampered');
 if(config.replaceCurrent){const p=path.join(config.home,'current');fs.unlinkSync(p);fs.symlinkSync(config.replaceCurrent,p)}
 console.log(JSON.stringify([{filename:name}]));process.exit(0);
}
require('./npm-cli-real.cjs');
`
    );
  }
  mockRegistry(installed);
  const selection = (cwd) =>
    JSON.parse(fs.readFileSync(path.join(cwd, '.git/gt-gh-switch/state.json')));
  const snapshot = () =>
    JSON.stringify({
      current: fs.readlinkSync(current),
      first: selection(repo),
      second: selection(fresh),
    });
  function failure(expected) {
    try {
      exec('gt-cli', ['update'], source);
      throw Error('Expected update failure');
    } catch (e) {
      const output = (e.stdout || '') + (e.stderr || '') || e.message;
      assert.match(output, expected);
      return output;
    }
  }
  const before = snapshot();
  config.offline = true;
  save();
  failure(/registry unavailable/);
  assert.equal(snapshot(), before);
  config.offline = false;
  config.tamper = true;
  save();
  failure(/integrity mismatch/);
  assert.equal(snapshot(), before);
  config.tamper = false;
  save();
  report.steps.push(
    'update registry failure and tampered artifact leave bindings unchanged'
  );

  // A paused operation keeps its old code without blocking the installation.
  const oldSelection = selection(repo);
  fs.writeFileSync(path.join(repo, '.git/.gtcontinue'), '{}');
  const deferred = exec('gt-cli', ['update'], source);
  assert(
    deferred.includes(`Update complete: gt-cli ${firstVersion} is installed.`)
  );
  assert(deferred.includes('Deferred 1 repository'));
  assert(deferred.includes('automatically on its next idle `gt` command'));
  assert(!deferred.includes('Update failed'));
  assert.deepEqual(selection(repo), oldSelection);
  assert.equal(exec('gt', ['--version'], repo), currentVersion);
  assert.equal(exec('gt', ['--version'], fresh), firstVersion);
  assert.equal(
    exec('git', ['worktree', 'list', '--porcelain'], fresh),
    staleWorktrees
  );
  assert.deepEqual(
    fs.readFileSync(path.join(deletedGit, 'index')),
    deletedIndex
  );
  assert.equal(fs.existsSync(path.join(home, 'update.json')), false);
  const activePointer = fs.readlinkSync(current);
  const target = fs.realpathSync(
    path.join(home, activePointer, 'app/node_modules/@tianrendong/gt-cli')
  );
  mockRegistry(target);
  report.steps.push(
    'update succeeds without pruning deleted worktrees while paused repository keeps its old version'
  );

  // Existing .git directories can be leftovers, not readable repositories.
  const headFile = path.join(repo, '.git/HEAD');
  const headContents = fs.readFileSync(headFile);
  fs.unlinkSync(headFile);
  try {
    const damaged = exec('gt-cli', ['update'], source);
    assert.match(damaged, /Git cannot read this registered repository/);
    assert(damaged.includes(path.join(repo, '.git')));
    assert(damaged.includes('Blocked 1 repository'));
    assert(damaged.includes('After fixing these errors'));
    assert(!damaged.includes('Update failed'));
    assert(!damaged.includes('Command failed:'));
    assert.deepEqual(selection(repo), oldSelection);
  } finally {
    fs.writeFileSync(headFile, headContents);
  }
  fs.unlinkSync(path.join(repo, '.git/.gtcontinue'));
  // No second update: normal dispatch performs the deferred refresh.
  assert.equal(exec('gt', ['--version'], repo), firstVersion);
  assert.equal(
    selection(repo).candidate.script,
    path.join(target, 'dist/src/index.js')
  );
  assert(
    fs.existsSync(
      path.join(
        home,
        originalPointer,
        'app/node_modules/@tianrendong/gt-cli/dist/src/index.js'
      )
    )
  );
  report.steps.push(
    'damaged repository is reported as blocked; first idle gt command after repair catches up without another update'
  );

  // Make both bindings stale to exercise interruption during an idempotent repair.
  const oldCandidate = oldSelection.candidate;
  for (const cwd of [repo, fresh]) {
    const state = selection(cwd);
    fs.writeFileSync(
      path.join(cwd, '.git/gt-gh-switch/state.json'),
      JSON.stringify({ ...state, candidate: oldCandidate })
    );
  }

  // Kill activation immediately after one binding is durable. No rollback over
  // work subsequently done with the new backend is allowed.
  const armed = path.join(root, 'interrupt-once'),
    hook = path.join(root, 'interrupt.cjs');
  fs.writeFileSync(armed, 'yes');
  fs.writeFileSync(
    hook,
    `const fs=require('fs');const rename=fs.renameSync;fs.renameSync=function(from,to){rename.apply(this,arguments);if(String(to).endsWith('/gt-gh-switch/state.json')&&fs.existsSync(${JSON.stringify(
      armed
    )})){fs.unlinkSync(${JSON.stringify(armed)});process.exit(93)}};`
  );
  const updater = path.join(target, 'scripts/installation/update.cjs');
  const contents = fs.readFileSync(updater, 'utf8');
  fs.writeFileSync(
    updater,
    contents.replace('\n', '\nrequire(' + JSON.stringify(hook) + ');\n')
  );
  const interrupted = failure(/Update incomplete/);
  assert.match(
    interrupted,
    /Some repositories may already use the new version/
  );
  assert(!interrupted.includes('Command failed:'));
  assert.equal(fs.readlinkSync(current), activePointer);
  assert.notEqual(
    selection(repo).candidate.script,
    selection(fresh).candidate.script
  );
  assert(fs.existsSync(path.join(home, 'update.json')));
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
      'work after interrupted update',
    ],
    fresh
  );
  const newHead = exec('git', ['rev-parse', 'HEAD'], fresh);
  exec('gt-cli', ['update'], source);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], fresh), newHead);
  assert.equal(fs.existsSync(path.join(home, 'update.json')), false);
  installed = fs.realpathSync(
    path.join(home, 'current/app/node_modules/@tianrendong/gt-cli')
  );
  assert.equal(installed, target);
  for (const cwd of [root, repo, fresh, linked])
    assert.equal(exec('gt', ['--version'], cwd), firstVersion);
  assert.equal(exec('git', ['rev-parse', 'HEAD'], linked), linkedHead);
  assert.equal(fs.existsSync(optOutFile), false);
  assert.equal(
    JSON.parse(exec('gt-cli', ['enable', '--repo', optOut, '--status'], root))
      .mode,
    'graphite'
  );
  assert.equal(exec('gt', ['--version'], optOut), '1.8.6');
  for (const cwd of [repo, fresh])
    assert.equal(
      selection(cwd).candidate.script,
      path.join(target, 'dist/src/index.js')
    );
  report.steps.push(
    'interrupted update resumes all bindings without rewinding newer work'
  );

  const count = fs.readdirSync(path.join(home, 'versions')).length;
  // Management can already be current while a repository still names an old
  // release; update must repair that without needlessly reinstalling anything.
  const stale = selection(fresh);
  stale.candidate = {
    node: path.join(home, originalPointer, 'runtime/bin/node'),
    script: path.join(
      home,
      originalPointer,
      'app/node_modules/@tianrendong/gt-cli/dist/src/index.js'
    ),
  };
  fs.writeFileSync(
    path.join(fresh, '.git/gt-gh-switch/state.json'),
    JSON.stringify(stale)
  );
  const repaired = exec('gt-cli', ['update'], source);
  assert(
    repaired.includes(`Update complete: gt-cli ${firstVersion} is installed.`)
  );
  assert(repaired.includes('Refreshed 1 enabled repository binding.'));
  assert.equal((repaired.match(/^Update complete:/gm) || []).length, 1);
  assert(!repaired.includes('Already up to date'));
  const unchanged = exec('gt-cli', ['update'], source);
  assert(unchanged.includes(`Already up to date: gt-cli ${firstVersion}.`));
  assert(!unchanged.includes('Update complete:'));
  assert.equal(
    selection(fresh).candidate.script,
    path.join(target, 'dist/src/index.js')
  );
  assert.equal(fs.readdirSync(path.join(home, 'versions')).length, count);
  assert(!exec('gt-cli', [], root).includes('gt-cli install'));
  assert(exec('gt-cli', [], root).includes('gt-cli update'));
  report.steps.push(
    'latest update is idempotent and ignores stale source workspace'
  );

  // A retained, verified latest target is reused, not reinstalled.
  const targetRecord = JSON.parse(
    fs.readFileSync(path.join(home, activePointer, '.installed'))
  );
  const checkpointFile = path.join(home, 'update.json');
  const writeCheckpoint = (value) =>
    fs.writeFileSync(
      checkpointFile,
      JSON.stringify({ schemaVersion: 1, ...value })
    );
  fs.unlinkSync(current);
  fs.symlinkSync(originalPointer, current);
  writeCheckpoint({
    from: originalPointer,
    target: activePointer,
    version: firstVersion,
    artifactSha256: targetRecord.artifactSha256,
  });
  assert.match(exec('gt-cli', ['update'], source), /Resuming verified/);
  assert.equal(fs.readlinkSync(current), activePointer);
  assert.equal(fs.readdirSync(path.join(home, 'versions')).length, count);

  // An older rigid helper must not run before checking npm for its replacement.
  const oldHelperRan = path.join(root, 'old-helper-ran');
  fs.writeFileSync(
    path.join(
      home,
      originalPointer,
      'app/node_modules/@tianrendong/gt-cli/scripts/installation/update.cjs'
    ),
    `require('fs').writeFileSync(${JSON.stringify(
      oldHelperRan
    )},'unexpected');process.exit(93);`
  );
  const originalRecord = JSON.parse(
    fs.readFileSync(path.join(home, originalPointer, '.installed'))
  );
  writeCheckpoint({
    from: originalPointer,
    target: originalPointer,
    version: currentVersion,
    artifactSha256: originalRecord.artifactSha256,
  });
  exec('gt-cli', ['update'], source);
  assert.equal(fs.existsSync(oldHelperRan), false);
  assert.equal(fs.existsSync(checkpointFile), false);
  assert.equal(fs.readlinkSync(current), activePointer);

  // A valid checkpoint with a missing staged directory is superseded safely.
  writeCheckpoint({
    from: originalPointer,
    target: 'versions/.install-missing',
    version: firstVersion,
    artifactSha256: targetRecord.artifactSha256,
  });
  exec('gt-cli', ['update'], source);
  assert.equal(fs.existsSync(checkpointFile), false);
  assert.equal(fs.readlinkSync(current), activePointer);
  report.steps.push(
    'verified staged targets are reused; stale and missing targets do not trap updates'
  );

  // A separate installation winning the current-pointer race must not be reset.
  const pointer = fs.readlinkSync(current);
  config.metadata = second;
  config.replaceCurrent = originalPointer;
  save();
  failure(/Another installation replaced current/);
  assert.equal(fs.readlinkSync(current), originalPointer);
  assert.equal(
    selection(repo).candidate.script,
    path.join(target, 'dist/src/index.js')
  );
  assert.equal(fs.existsSync(path.join(home, 'update.json')), false);
  fs.unlinkSync(current);
  fs.symlinkSync(pointer, current); // fixture-owned competing change
  delete config.replaceCurrent;
  config.metadata = first;
  save();
  report.steps.push('concurrent installation is never overwritten by update');
  config.metadata = { ...first, version: '0.0.0' };
  save();
  assert.match(
    exec('gt-cli', ['update'], source),
    /refusing automatic downgrade/
  );
  assert.equal(fs.readlinkSync(current), pointer);
  config.metadata = first;
  save();
  report.steps.push('update never downgrades to an older registry tag');
  // Deleted checkouts no longer require temporary/adopted provenance for cleanup.
  const scratch = path.join(root, 'adopted scratch');
  const explicit = path.join(root, 'explicit scratch');
  const manual = path.join(root, 'manual scratch');
  for (const checkout of [scratch, explicit, manual]) {
    exec('git', ['clone', '--no-hardlinks', fresh, checkout], root);
    exec('gt', ['init', '--trunk', 'main', '--no-interactive'], checkout);
    exec('gt', ['info'], checkout);
  }
  exec('gt-cli', ['enable', '--repo', explicit], root);
  fs.rmSync(manual, { recursive: true });
  const preview = JSON.parse(
    exec('gt-cli', ['forget', '--repo', manual, '--dry-run', '--json'], root)
  );
  assert.equal(preview.dryRun, true);
  const batchPreview = JSON.parse(
    exec('gt-cli', ['forget', '--missing', '--dry-run', '--json'], root)
  );
  assert.deepEqual(batchPreview, {
    forgotten: [{ repository: preview.repository }],
    dryRun: true,
  });
  const forgotten = JSON.parse(
    exec('gt-cli', ['forget', '--missing', '--json'], root)
  ).forgotten;
  assert.equal(forgotten.length, 1);
  assert.equal(forgotten[0].repository, preview.repository);
  assert.equal(forgotten[0].backup, undefined);
  const deletedRegistrations = [scratch, explicit].map((checkout) => {
    const common = fs.realpathSync(path.join(checkout, '.git'));
    fs.rmSync(checkout, { recursive: true });
    return common;
  });
  const cleaned = exec('gt-cli', ['update'], root);
  for (const common of deletedRegistrations)
    assert(cleaned.includes(`Forgot missing checkout: ${common}`));
  assert.doesNotMatch(cleaned, /Registration backup:/);
  assert.doesNotMatch(cleaned, /Deferred|Blocked|Missing/);
  assert.doesNotMatch(
    exec('gt-cli', ['update'], root),
    /Deferred|Blocked|Missing|Forgot missing/
  );
  report.steps.push(
    'missing adopted and explicit checkouts are auto-forgotten; manual forget --missing supports dry-run and JSON'
  );
  report.fakeRegistry = true;
  report.updateVerified = true;
  report.registryCommands = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  return { installed, version: firstVersion };
};
