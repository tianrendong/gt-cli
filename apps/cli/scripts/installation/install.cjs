#!/usr/bin/env node
// Installer runs only on the verified private runtime downloaded by install.sh.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const t = require('./install_tools.cjs');
const { color, diagnostic } = require('./output.cjs');
const argv = process.argv.slice(2),
  options = {};
const values = new Set([
  '--release',
  '--cli-root',
  '--source',
  '--package',
  '--gt-path',
  '--result-file',
]);
for (let i = 0; i < argv.length; i++) {
  if (values.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'))
    options[argv[i].slice(2)] = argv[++i];
  else if (
    ['--non-interactive', '--skip-auth', '--stage-only'].includes(argv[i])
  )
    options[argv[i].slice(2)] = true;
  else throw Error(`Unknown or incomplete install argument: ${argv[i]}`);
}
if (Boolean(options['stage-only']) !== Boolean(options['result-file']))
  throw Error('Staging requires both --stage-only and --result-file.');
const release = fs.realpathSync(options.release),
  cliRoot = fs.realpathSync(options['cli-root']);
const home = path.dirname(path.dirname(release)),
  current = path.join(home, 'current');
if (
  !path.basename(release).startsWith('.install-') ||
  path.basename(path.dirname(release)) !== 'versions'
)
  throw Error('Invalid installation staging directory.');
for (const directory of [home, path.dirname(release), release])
  t.assertOwned(directory);
if (
  process.version !== 'v24.13.1' ||
  fs.realpathSync(process.execPath) !== path.join(release, 'runtime/bin/node')
)
  throw Error('Installer must use its verified private Node runtime.');
const previousCurrent = t.readLink(current);
if (
  previousCurrent &&
  (!previousCurrent.startsWith('versions/.install-') ||
    previousCurrent.includes('..'))
)
  throw Error('Invalid current installation pointer.');
const userPath = t.cleanPath(cliRoot),
  userEnv = { ...process.env, PATH: userPath };
const buildEnv = {
  ...userEnv,
  PATH: path.join(release, 'runtime/bin') + path.delimiter + userPath,
  npm_config_update_notifier: 'false',
};
const npm = path.join(release, 'runtime/lib/node_modules/npm/bin/npm-cli.js');
let sourceSnapshot;
function note(message, style = 'cyan') {
  console.log(color('stdout', style, message));
}
function npmRun(args, { cwd = release, capture = false } = {}) {
  const full = [npm, ...args];
  if (capture)
    return t.run(process.execPath, full, {
      cwd,
      env: buildEnv,
      timeout: 300000,
    });
  cp.execFileSync(process.execPath, full, {
    cwd,
    env: buildEnv,
    stdio: 'inherit',
    timeout: 300000,
  });
}
function sourceFiles(root) {
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
  ])
    if (process.env[key])
      throw Error(`Refusing source snapshot with ${key} set.`);
  const gitOutput = (args) =>
    cp.execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      env: userEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 32 << 20,
    });
  const top = gitOutput(['rev-parse', '--show-toplevel']).replace(/\n$/, '');
  if (fs.realpathSync(top) !== fs.realpathSync(root))
    throw Error('Source installation requires the gt-cli repository root.');
  return [
    ...new Set(
      gitOutput([
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ]).split('\0')
    ),
  ]
    .filter(
      (p) =>
        p &&
        p !== 'apps/cli/source.tar.gz' &&
        fs.existsSync(path.join(root, p)) &&
        !fs.statSync(path.join(root, p)).isDirectory()
    )
    .sort();
}
function sourceRecord(root, names) {
  return Object.fromEntries(
    names.map((name) => {
      const file = path.join(root, name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (!fs.realpathSync(file).startsWith(root + path.sep))
          throw Error(`Source link points outside the repository: ${name}`);
        return [name, { link: fs.readlinkSync(file) }];
      }
      return [name, { hash: t.hash(file), mode: stat.mode & 0o777 }];
    })
  );
}
function snapshotSource(root) {
  root = fs.realpathSync(root);
  if (home === root || home.startsWith(root + path.sep))
    throw Error('GT_CLI_HOME must be outside the source checkout.');
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/cli/package.json'))
  );
  if (pkg.name !== '@tianrendong/gt-cli')
    throw Error('Not the gt-cli source repository.');
  const names = sourceFiles(root),
    records = sourceRecord(root, names);
  const snapshot = path.join(release, 'build/gt-cli-source');
  fs.mkdirSync(snapshot, { recursive: true });
  for (const name of names) {
    const from = path.join(root, name),
      to = path.join(snapshot, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (records[name].link !== undefined)
      fs.symlinkSync(records[name].link, to);
    else {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, records[name].mode);
    }
  }
  sourceSnapshot = { root, names, records };
  verifySource();
  return snapshot;
}
function verifySource() {
  if (!sourceSnapshot) return;
  const { root, names, records } = sourceSnapshot;
  if (
    JSON.stringify(sourceFiles(root)) !== JSON.stringify(names) ||
    JSON.stringify(sourceRecord(root, names)) !== JSON.stringify(records)
  )
    throw Error(
      'Source changed during installation. Nothing was activated; rerun install to build the latest source.'
    );
}
function packageSource(source) {
  note('Building a private snapshot; active source/build stays untouched...');
  const snapshot = snapshotSource(source),
    yarn = path.join(snapshot, '.yarn/releases/yarn-3.2.1.cjs');
  for (const args of [['install', '--immutable'], ['build'], ['check']])
    cp.execFileSync(process.execPath, [yarn, ...args], {
      cwd: snapshot,
      env: buildEnv,
      stdio: 'inherit',
      timeout: 300000,
    });
  // Local install is not a publication. Include the exact working source even
  // when it is uncommitted; release prepack still requires a committed tree.
  const list = path.join(release, 'source-files');
  fs.writeFileSync(
    list,
    sourceSnapshot.names.map((name) => `gt-cli-source/${name}\0`).join('')
  );
  t.run('tar', [
    '-czf',
    path.join(snapshot, 'apps/cli/source.tar.gz'),
    '-C',
    path.dirname(snapshot),
    '--null',
    '-T',
    list,
  ]);
  // Match release prepack when packing this snapshot without lifecycle scripts.
  fs.copyFileSync(
    path.join(snapshot, 'README.md'),
    path.join(snapshot, 'apps/cli/README.md')
  );
  const manifest = JSON.parse(
    npmRun(
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        release,
        path.join(snapshot, 'apps/cli'),
      ],
      { capture: true }
    )
  );
  verifySource();
  return path.join(release, manifest[0].filename);
}
function packagePrebuilt(root) {
  if (
    !fs.existsSync(path.join(root, 'dist/src/toggle_cli.js')) ||
    !fs.existsSync(path.join(root, 'source.tar.gz'))
  )
    throw Error(
      'Prebuilt package is incomplete. Source checkouts must use the source installer.'
    );
  return path.join(
    release,
    JSON.parse(
      npmRun(
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          release,
          root,
        ],
        { capture: true }
      )
    )[0].filename
  );
}
function managementPlan(slot) {
  const file = path.join(path.dirname(slot), 'gt-cli');
  const content = `#!/bin/sh\n# Managed gt-cli installer entry (schema 1).\nexec ${t.quote(
    path.join(home, 'current/app/node_modules/@tianrendong/gt-cli/bin/gt-cli')
  )} "$@"\n`;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      fs.readFileSync(file, 'utf8') !== content)
  )
    throw Error(`Refusing to overwrite an unrelated gt-cli command: ${file}`);
  fs.accessSync(path.dirname(file), fs.constants.W_OK);
  if (fs.statSync(path.dirname(file)).uid !== process.getuid())
    throw Error('Management command directory belongs to another OS user.');
  return { file, content, exists: Boolean(stat) };
}
async function authenticate(gh) {
  if (options['skip-auth']) return;
  const status = cp.spawnSync(gh, ['auth', 'status'], {
    env: userEnv,
    stdio: 'pipe',
    timeout: 30000,
  });
  if (status.status === 0) return;
  let tty;
  if (!options['non-interactive'] && !process.stdin.isTTY) {
    try {
      tty = fs.openSync('/dev/tty', 'r+');
    } catch {
      /* no controlling terminal */
    }
  }
  if (options['non-interactive'] || (!process.stdin.isTTY && tty === undefined))
    throw Error(
      'GitHub authentication is required. Supply GH_TOKEN for non-interactive install, or run install interactively to sign in. No backend was enabled.'
    );
  try {
    cp.execFileSync(
      gh,
      ['auth', 'login', '--hostname', 'github.com', '--web'],
      {
        env: userEnv,
        stdio: tty === undefined ? 'inherit' : [tty, tty, tty],
      }
    );
  } finally {
    if (tty !== undefined) fs.closeSync(tty);
  }
}
async function main() {
  const git = t.command('git', userPath);
  if (!git)
    throw Error(
      'Git is required (OS developer tools). Install Git before using gt-cli. Node, npm, SQLite, gh, and CLI dependencies are handled by this installer.'
    );
  t.run(git, ['--version'], { env: userEnv });
  const prospective = t.nativeSlot(userPath, options['gt-path']);
  const command = managementPlan(prospective.slot);
  const source =
    options.source ||
    (fs.existsSync(path.resolve(cliRoot, '../../.yarn/releases/yarn-3.2.1.cjs'))
      ? path.resolve(cliRoot, '../..')
      : undefined);
  const artifact = options.package
    ? fs.realpathSync(options.package)
    : source
    ? packageSource(source)
    : packagePrebuilt(cliRoot);
  note('Installing prebuilt CLI dependencies (no native build scripts)...');
  npmRun([
    'install',
    '--prefix',
    path.join(release, 'app'),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org/',
    artifact,
  ]);
  const installed = path.join(release, 'app/node_modules/@tianrendong/gt-cli');
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  if (
    pkg.name !== '@tianrendong/gt-cli' ||
    pkg.version !==
      JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'))).version
  )
    throw Error('Installer package/version mismatch.');
  for (const file of [
    'dist/src/gt_cli.js',
    'dist/src/toggle_cli.js',
    'dist/src/toggle_commands.js',
    'scripts/installation/disable.cjs',
    'scripts/installation/disable-native.sh',
    'scripts/installation/native_escape.cjs',
    'dist/scripts/installation/disable.cjs',
    'dist/scripts/installation/native_escape.cjs',
    'dist/src/settings_cli.js',
    'source.tar.gz',
    'bin/gt-cli',
    'scripts/installation/run.sh',
    'scripts/installation/output.sh',
    'scripts/installation/output.cjs',
    'dist/scripts/installation/output.cjs',
  ])
    if (!fs.existsSync(path.join(installed, file)))
      throw Error(`Installed package missing ${file}`);
  const gh = t.githubCli(release, userPath);
  await authenticate(gh.executable);
  fs.symlinkSync(
    '../../../../runtime/bin/node',
    path.join(installed, '.runtime-node')
  );
  fs.symlinkSync('../../../../tools/bin', path.join(installed, '.tools-bin'));
  for (const file of [
    'enable.sh',
    'disable.sh',
    'install.sh',
    'bin/gt-cli',
    'scripts/installation/run.sh',
  ])
    fs.chmodSync(path.join(installed, file), 0o755);
  process.env.PATH = userPath + path.delimiter + gh.tools;
  const { planLauncher, withLauncher } = require(path.join(
    installed,
    'dist/src/lib/switch/launcher.js'
  ));
  const { findNative } = require(path.join(
    installed,
    'dist/src/lib/switch/native.js'
  ));
  let native;
  if (prospective.create) {
    const name = `@withgraphite/graphite-cli-${process.platform}-${process.arch}`;
    npmRun([
      'install',
      '--prefix',
      path.join(release, 'native'),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
      `${name}@1.8.6`,
    ]);
    native = findNative(
      path.join(release, 'native/node_modules', name, 'bin/gt')
    );
  } else native = planLauncher(options['gt-path']).native;
  let installedVersion;
  try {
    installedVersion = t.run(process.execPath, [
      path.join(installed, 'dist/src/index.js'),
      '--version',
    ]);
  } catch (error) {
    throw Error(
      `Installed CLI could not start (exit ${error.status}, signal ${
        error.signal
      }): ${
        error.stderr?.toString().trim() ||
        error.stdout?.toString().trim() ||
        error.message
      }`
    );
  }
  if (installedVersion !== pkg.version)
    throw Error('Installed CLI version check failed.');
  const { fileLock, FileLockBusyError } = require(path.join(
    installed,
    'dist/src/lib/github/file_lock.js'
  ));
  const lockPath = path.join(home, 'install.lock');
  if (fs.lstatSync(lockPath, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('Refusing symlinked installation lock.');
  const fd = fs.openSync(lockPath, 'a', 0o600);
  let locked = false;
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        fileLock(fd);
        locked = true;
        break;
      } catch (e) {
        if (!(e instanceof FileLockBusyError) || Date.now() >= deadline)
          throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    verifySource();
    if (t.readLink(current) !== previousCurrent)
      throw Error(
        'Another installation finished first. Rerun install; no newer installation was overwritten.'
      );
    managementPlan(prospective.slot);
    const summary = {
      schemaVersion: 1,
      version: pkg.version,
      nodeVersion: process.version,
      node: process.execPath,
      cli: installed,
      native,
      source: sourceSnapshot?.root,
      sourceHash:
        sourceSnapshot &&
        crypto
          .createHash('sha256')
          .update(JSON.stringify(sourceSnapshot.records))
          .digest('hex'),
      artifactSha256: t.hash(artifact),
      gt: prospective.slot,
      command: command.file,
      createdNativeEntry: prospective.create,
      backendChanged: false,
    };
    t.atomicFile(
      path.join(release, '.installed'),
      JSON.stringify(summary, null, 2) + '\n'
    );
    if (options['stage-only']) {
      if (prospective.create)
        throw Error('Updates require an existing gt installation.');
      const result = path.resolve(options['result-file']);
      t.assertOwned(path.dirname(result));
      fs.writeFileSync(result, JSON.stringify(summary, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      note(`Prepared gt-cli ${pkg.version}; not active yet.`);
      return;
    }
    if (prospective.create) {
      if (t.command('gt', userPath))
        throw Error(
          'A gt executable appeared during install. Nothing was replaced.'
        );
      t.linkNew(native.path, prospective.slot);
    }
    await withLauncher(prospective.slot, async (plan) => {
      if (
        plan.slot !== prospective.slot ||
        plan.native.digest !== native.digest
      )
        throw Error('Native gt changed during install. Nothing was replaced.');
      if (t.readLink(current) !== previousCurrent)
        throw Error('Current installation changed during install.');
      if (!command.exists) {
        const tmp = path.join(
          path.dirname(command.file),
          `.gt-cli-install-${crypto.randomBytes(8).toString('hex')}`
        );
        try {
          fs.writeFileSync(tmp, command.content, { flag: 'wx', mode: 0o755 });
          fs.linkSync(tmp, command.file);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      } else managementPlan(prospective.slot);
      t.replaceLink(path.relative(home, release), current, previousCurrent);
      t.atomicFile(
        path.join(home, 'command.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            path: command.file,
            digest: t.hash(command.file),
          },
          null,
          2
        ) + '\n'
      );
    });
    note(
      `Installed gt-cli ${pkg.version} with private Node ${process.version}. No repository or backend selection changed.`,
      'green'
    );
    note('Enable: gt-cli enable --repo PATH (or --global)');
    console.log('Keep all active installation directories.');
  } finally {
    if (locked) fileLock(fd, true);
    fs.closeSync(fd);
  }
  // Build intermediates cannot be active: all runtime/candidate paths live under app/runtime/tools/native.
  for (const directory of ['build', 'bootstrap'])
    fs.rmSync(path.join(release, directory), { recursive: true, force: true });
  if (artifact.startsWith(release + path.sep))
    fs.rmSync(artifact, { force: true });
}
main().catch((error) => {
  console.error(
    diagnostic('stderr', 'red', `Install failed: ${error.message}`)
  );
  process.exitCode = 1;
});
