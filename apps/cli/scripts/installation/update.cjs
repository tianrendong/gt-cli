#!/usr/bin/env node
// One-command, registry-backed update. Code directories remain immutable; only
// validated bindings and the management pointer change. Keep failed targets for
// retry: some repositories may already be running them after an interruption.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const semver = require('semver');
const stripAnsi = require('strip-ansi');
const t = require('./install_tools.cjs');
const { color, diagnostic, help } = require('./output.cjs');
const PACKAGE = '@tianrendong/gt-cli';
const REGISTRY = 'https://registry.npmjs.org/';
const RELATIVE = /^versions\/\.install-[a-zA-Z0-9]+$/;
const cli = fs.realpathSync(path.resolve(__dirname, '../..'));
function readJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid())
    throw Error(`Not an owned regular file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function installation(root) {
  root = fs.realpathSync(root);
  const release = path.resolve(root, '../../../..');
  const home = path.resolve(release, '../..');
  for (const dir of [home, path.join(home, 'versions'), release])
    t.assertOwned(dir);
  const relative = path.relative(home, release);
  if (
    !RELATIVE.test(relative) ||
    root !== path.join(release, 'app/node_modules', PACKAGE)
  )
    throw Error(
      'gt-cli update requires a managed installation. Run the npm bootstrap first.'
    );
  const record = readJSON(path.join(release, '.installed'));
  const pkg = readJSON(path.join(root, 'package.json'));
  if (
    record.schemaVersion !== 1 ||
    pkg.name !== PACKAGE ||
    !semver.valid(pkg.version) ||
    record.version !== pkg.version ||
    record.cli !== root ||
    record.node !== path.join(release, 'runtime/bin/node') ||
    !path.isAbsolute(record.gt) ||
    !/^[0-9a-f]{64}$/.test(record.artifactSha256)
  )
    throw Error('Invalid managed installation record. No bindings changed.');
  return { home, release, relative, root, record };
}
function checkpoint(home) {
  const file = path.join(home, 'update.json');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
  const value = readJSON(file);
  if (
    value.schemaVersion !== 1 ||
    !RELATIVE.test(value.from) ||
    !RELATIVE.test(value.target) ||
    !semver.valid(value.version) ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256)
  )
    throw Error(
      'Invalid update checkpoint. Keep installation directories; no rollback attempted.'
    );
  return value;
}
function pending(home) {
  const value = checkpoint(home);
  if (!value) return undefined;
  const target = installation(
    path.join(home, value.target, 'app/node_modules', PACKAGE)
  );
  if (
    target.home !== home ||
    target.relative !== value.target ||
    target.record.version !== value.version ||
    target.record.artifactSha256 !== value.artifactSha256
  )
    throw Error(
      'Update target differs from its checkpoint. No rollback attempted.'
    );
  return value;
}
async function lock(home, name, operation) {
  const { fileLock, FileLockBusyError } = require(path.join(
    cli,
    'dist/src/lib/github/file_lock.js'
  ));
  const file = path.join(home, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.uid !== process.getuid()))
    throw Error(`Unsafe installation lock: ${file}`);
  const fd = fs.openSync(file, 'a', 0o600);
  let acquired = false;
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        fileLock(fd);
        acquired = true;
        break;
      } catch (error) {
        if (!(error instanceof FileLockBusyError) || Date.now() >= deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return await operation();
  } finally {
    if (acquired) fileLock(fd, true);
    fs.closeSync(fd);
  }
}
function manifest(value) {
  if (
    value.name !== PACKAGE ||
    !semver.valid(value.version) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.dist?.integrity)
  )
    throw Error(
      'Registry returned an invalid package/version/integrity. Nothing activated.'
    );
  return value;
}
function verifyArtifact(file, metadata) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid())
    throw Error('Unsafe downloaded artifact.');
  const bytes = fs.readFileSync(file);
  const integrity =
    'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
  if (integrity !== metadata.dist.integrity)
    throw Error('npm artifact integrity mismatch. Nothing activated.');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function npmRun(info, args) {
  const npm = path.join(
    path.dirname(info.record.node),
    '../lib/node_modules/npm/bin/npm-cli.js'
  );
  return t.run(
    info.record.node,
    [npm, ...args, `--registry=${REGISTRY}`, `--@tianrendong:registry=${REGISTRY}`],
    {
      cwd: info.home,
      timeout: 300000,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    }
  );
}
class UpdateAlreadyReportedError extends Error {}

function warning(message) {
  console.log(diagnostic('stdout', 'yellow', message));
}

function formatUpdateError(error) {
  const version = error.updateVersion;
  const target = version ? `gt-cli ${version}` : 'gt-cli';
  const detail = stripAnsi(
    error.stderr?.toString().trim() || error.message || String(error)
  );
  const preflight = error.updatePhase === 'preflight';
  const partial = error.updatePhase === 'activation';
  return [
    preflight
      ? `Update blocked: activation preflight failed for ${target}.`
      : partial
      ? `Update incomplete: activation of ${target} did not finish.`
      : `Update failed${version ? ` for ${target}` : ''}.`,
    detail,
    '',
    ...(error.currentVersion
      ? [`Current gt-cli management version: ${error.currentVersion}.`]
      : []),
    preflight
      ? 'This activation attempt changed no repository bindings. Any earlier partial activation was kept.'
      : partial
      ? 'Some repositories may already use the new version. No work was rolled back.'
      : 'Existing installations and current work were kept.',
    'Fix the issue above, then rerun `gt-cli update` to resume.',
    'Keep the downloaded release and version directories; do not delete them.',
  ].join('\n');
}

function reportUpdateFailure(error) {
  if (!(error instanceof UpdateAlreadyReportedError))
    console.error(diagnostic('stderr', 'red', formatUpdateError(error)));
  process.exitCode = 1;
}

function updateSuccessMessage(version, result, alreadyCurrent) {
  const count = result.repositories.length;
  const deferred = result.deferred || [];
  // Deleted checkouts are stale registrations, not pending repository work.
  const missing = deferred.filter((binding) => binding.kind === 'missing');
  const pending = deferred.length - missing.length;
  const unchanged = alreadyCurrent && count === 0;
  const lines = [
    color(
      'stdout',
      unchanged && pending ? 'yellow' : 'green',
      unchanged
        ? pending
          ? `gt-cli ${version} is installed; repository updates are pending.`
          : `Already up to date: gt-cli ${version}.`
        : `Update complete: gt-cli ${version} is installed.`
    ),
  ];
  if (count)
    lines.push(
      color(
        'stdout',
        'green',
        `Refreshed ${count} enabled repository binding${
          count === 1 ? '' : 's'
        }.`
      )
    );
  for (const { repository } of result.forgotten || [])
    lines.push(
      color('stdout', 'yellow', `Forgot missing checkout: ${repository}`)
    );
  for (const [kind, bindings] of [
    ['busy', deferred.filter((binding) => binding.kind === 'busy')],
    [
      'blocked',
      deferred.filter(
        (binding) => binding.kind !== 'busy' && binding.kind !== 'missing'
      ),
    ],
  ]) {
    if (!bindings.length) continue;
    const count = `${bindings.length} ${
      bindings.length === 1 ? 'repository' : 'repositories'
    }`;
    const warnings = [
      kind === 'busy'
        ? `Deferred ${count}; each will switch automatically on its next idle \`gt\` command:`
        : `Blocked ${count}; fix the errors below before these bindings can update:`,
    ];
    for (const { repository, reason } of bindings) {
      warnings.push(`  - ${repository}`);
      for (const line of stripAnsi(String(reason)).split('\n'))
        if (line.trim()) warnings.push(`      ${line.trim()}`);
    }
    warnings.push(
      kind === 'busy'
        ? 'Running commands and paused operations keep their current version. No second update is needed.'
        : 'Current repository versions were kept. After fixing these errors, the next `gt` command retries the pending update; no second update is needed.'
    );
    lines.push(diagnostic('stdout', 'yellow', warnings.join('\n')));
  }
  if (missing.length) {
    // Absent registrations that failed the cleanup safety checks remain pending.
    // Show the specific guard without repeating the full recovery instructions.
    const plural = missing.length === 1 ? 'checkout' : 'checkouts';
    lines.push(
      diagnostic(
        'stdout',
        'yellow',
        [
          `Missing ${missing.length} registered ${plural}; ${
            missing.length === 1 ? 'its binding stays' : 'their bindings stay'
          } pending until restored or forgotten:`,
          ...missing.flatMap(({ repository, retained }) => [
            `  - ${repository}`,
            ...(retained ? [`      ${retained}`] : []),
          ]),
          'Restore or remount these checkouts to update them. If a Git directory is permanently deleted, `gt-cli forget --repo PATH` or `gt-cli forget --missing` (preview with --dry-run) drops its registration; relocated, symlinked, or unreadable paths must be repaired first.',
          'No repository files are deleted.',
        ].join('\n')
      )
    );
  }
  return lines.join('\n');
}

function activate(target, from) {
  // Run new activation logic under the new private runtime, not an ambient or
  // older Node. The parent holds update.lock; activation takes install.lock,
  // then launcher lock, then every affected common-repository lock.
  const result = cp.spawnSync(
    target.record.node,
    [
      path.join(target.root, 'scripts/installation/update.cjs'),
      '--activate',
      from,
    ],
    {
      cwd: target.home,
      env: process.env,
      stdio: ['ignore', 'inherit', 'pipe'],
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 16 << 20,
    }
  );
  const stderr = stripAnsi(result.stderr || '');
  if (!result.error && result.status === 0) {
    if (stderr) process.stderr.write(diagnostic('stderr', 'yellow', stderr));
    return;
  }
  // The activation helper owns its diagnosis. Relay it once rather than
  // wrapping it in another "Command failed: ... --activate ..." error.
  // Accept the old updater's header too when resuming an older staged release.
  if (
    result.status === 1 &&
    /^Update (?:failed|blocked|incomplete)[.:]/m.test(stderr)
  ) {
    // The child's stderr is piped for deduplication, so color for the parent's
    // actual destination. Strip ANSI before header matching and recoloring.
    process.stderr.write(diagnostic('stderr', 'red', stderr));
    throw new UpdateAlreadyReportedError();
  }
  const error = Error(
    stderr.trim() ||
      result.error?.message ||
      (result.signal
        ? `Activation process stopped with signal ${result.signal}.`
        : `Activation process exited with code ${result.status} before reporting a result.`)
  );
  error.updatePhase = 'activation';
  error.updateVersion = target.record.version;
  throw error;
}
async function activateHere(info, from) {
  if (!RELATIVE.test(from)) throw Error('Invalid prior installation.');
  return lock(info.home, 'install.lock', async () => {
    const current = path.join(info.home, 'current');
    const check = () => {
      const actual = t.readLink(current);
      if (actual !== from && actual !== info.relative)
        throw Error(
          'Another installation replaced current. No newer installation was overwritten. Rerun gt-cli update.'
        );
    };
    check();
    const file = path.join(info.home, 'update.json');
    const record = {
      schemaVersion: 1,
      from,
      target: info.relative,
      version: info.record.version,
      artifactSha256: info.record.artifactSha256,
    };
    const previous = checkpoint(info.home);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record))
      // Immutable version directories keep any repository already bound to the
      // older target working; this activation rebinds it when it is idle.
      warning(
        `Superseding the unfinished update to gt-cli ${previous.version}.`
      );
    if (JSON.stringify(previous) !== JSON.stringify(record))
      t.atomicFile(file, JSON.stringify(record));
    const { upgradeBindings } = require(path.join(
      info.root,
      'dist/src/lib/switch/upgrade.js'
    ));
    console.log(
      color(
        'stdout',
        'cyan',
        `Activating gt-cli ${info.record.version}: checking registered repositories...`
      )
    );
    const result = await upgradeBindings({
      slot: info.record.gt,
      candidate: {
        node: info.record.node,
        script: path.join(info.root, 'dist/src/index.js'),
      },
      dispatcher: path.join(info.root, 'dist/src/gt_cli.js'),
      beforeChange: check,
      finish: () => {
        check();
        const expected = t.readLink(current);
        if (expected !== info.relative)
          t.replaceLink(info.relative, current, expected);
        fs.unlinkSync(file);
      },
    });
    console.log(
      updateSuccessMessage(info.record.version, result, from === info.relative)
    );
  }).catch((error) => {
    const failure = error instanceof Error ? error : Error(String(error));
    failure.updateVersion = info.record.version;
    try {
      const active = t.readLink(path.join(info.home, 'current'));
      if (active && RELATIVE.test(active))
        failure.currentVersion = installation(
          path.join(info.home, active, 'app/node_modules', PACKAGE)
        ).record.version;
    } catch {
      // Diagnostic reads must never hide the original activation failure.
    }
    throw failure;
  });
}
async function update(info) {
  return lock(info.home, 'update.lock', async () => {
    const current = t.readLink(path.join(info.home, 'current'));
    if (current !== info.relative)
      throw Error(
        'This updater is not current. Run gt-cli update through the installed management command.'
      );
    // Check latest BEFORE resuming: a rigid older activation helper must not
    // prevent upgrading to the release that fixes it. Unsafe records still fail.
    const interrupted = checkpoint(info.home);
    console.log(
      color(
        'stdout',
        'cyan',
        `Checking npm for latest @tianrendong/gt-cli (current: ${info.record.version})...`
      )
    );
    const latest = manifest(
      JSON.parse(
        npmRun(info, ['view', `${PACKAGE}@latest`, '--json', '--prefer-online'])
      )
    );
    if (semver.lt(latest.version, info.record.version)) {
      warning(
        `Installed ${info.record.version} is newer than npm latest ${latest.version}; refusing automatic downgrade.`
      );
      return;
    }
    const downloads = path.join(info.home, 'updates');
    fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
    t.assertOwned(downloads);
    const work = fs.mkdtempSync(path.join(downloads, '.download-'));
    try {
      const packed = JSON.parse(
        npmRun(info, [
          'pack',
          `${PACKAGE}@${latest.version}`,
          '--ignore-scripts',
          '--json',
          '--prefer-online',
          '--pack-destination',
          work,
        ])
      );
      if (
        packed.length !== 1 ||
        typeof packed[0].filename !== 'string' ||
        path.basename(packed[0].filename) !== packed[0].filename
      )
        throw Error('Invalid downloaded package path.');
      const artifact = path.join(work, packed[0].filename);
      const hash = verifyArtifact(artifact, latest);
      if (
        latest.version === info.record.version &&
        hash === info.record.artifactSha256
      ) {
        activate(info, current); // Also repairs stale bindings left by a prior install.
        return;
      }
      if (
        interrupted?.version === latest.version &&
        interrupted.artifactSha256 === hash
      ) {
        let staged;
        try {
          pending(info.home); // Validate the retained target before executing it.
          staged = installation(
            path.join(
              info.home,
              interrupted.target,
              'app/node_modules',
              PACKAGE
            )
          );
        } catch {
          warning(
            'Previously staged release is unavailable; preparing a fresh verified copy. Existing version directories are kept.'
          );
        }
        if (staged) {
          console.log(
            color(
              'stdout',
              'cyan',
              `Resuming verified gt-cli ${latest.version}...`
            )
          );
          activate(staged, current);
          return;
        }
      }
      console.log(
        color(
          'stdout',
          'cyan',
          `Preparing verified gt-cli ${latest.version} (not active yet)...`
        )
      );
      const bootstrap = path.join(work, 'bootstrap');
      npmRun(info, [
        'install',
        '--prefix',
        bootstrap,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        artifact,
      ]);
      const packageRoot = path.join(bootstrap, 'node_modules', PACKAGE);
      const pkg = readJSON(path.join(packageRoot, 'package.json'));
      if (pkg.name !== PACKAGE || pkg.version !== latest.version)
        throw Error('Downloaded package identity changed.');
      const result = path.join(work, 'staged.json');
      cp.execFileSync(
        path.join(packageRoot, 'install.sh'),
        [
          '--package',
          artifact,
          '--non-interactive',
          '--skip-auth', // Updating local tools makes no GitHub requests.
          '--stage-only',
          '--result-file',
          result,
        ],
        {
          cwd: info.home,
          stdio: 'inherit',
          timeout: 600000,
          env: { ...process.env, GT_CLI_HOME: info.home },
        }
      );
      const staged = readJSON(result);
      const target = installation(staged.cli);
      if (
        target.home !== info.home ||
        target.record.version !== latest.version ||
        target.record.artifactSha256 !== hash
      )
        throw Error(
          'Staged installation does not match verified registry artifact.'
        );
      activate(target, current);
    } finally {
      // Runtime/candidate paths never point here, even after a partial activation.
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      help(
        'gt-cli update\nInstalls the latest npm release without interrupting running commands.\nBusy repositories switch automatically on their next idle gt command.\nGlobal mode and native opt-outs stay unchanged.'
      )
    );
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--activate'))
    throw Error('Use gt-cli update without flags.');
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
  ])
    if (process.env[key]) throw Error(`Refusing update with ${key} set.`);
  const info = installation(cli);
  if (fs.realpathSync(process.execPath) !== info.record.node)
    throw Error(
      'Update requires the installed private runtime. Use gt-cli update.'
    );
  if (args[0] === '--activate') return activateHere(info, args[1]);
  return update(info);
}
module.exports = {
  manifest,
  verifyArtifact,
  installation,
  pending,
  checkpoint,
  activate,
  formatUpdateError,
  reportUpdateFailure,
  updateSuccessMessage,
  warning,
  activateHere,
  update,
};
if (require.main === module)
  main(process.argv.slice(2)).catch(reportUpdateFailure);
