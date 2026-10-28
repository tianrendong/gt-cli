const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const GH = {
  'darwin-arm64': [
    'macOS_arm64.zip',
    '3677f9c27965825f9c7d50395473c134edaea4b484373ef6b25de653570a0489',
  ],
  'darwin-x64': [
    'macOS_amd64.zip',
    '985707e9ac60c95ed51cddd808c338b481abe69fffa77e9d6547c3750045f77e',
  ],
  'linux-arm64': [
    'linux_arm64.tar.gz',
    'd41e0b3b6218e5741c8bb4db39b16e53a59e0e06299a8489bd38f623ef7ebaae',
  ],
  'linux-x64': [
    'linux_amd64.tar.gz',
    '25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c',
  ],
};
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function command(name, searchPath = process.env.PATH) {
  for (const directory of (searchPath || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch (e) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(e.code)) throw e;
    }
  }
}
function run(file, args, options = {}) {
  return cp
    .execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      maxBuffer: 16 << 20,
      ...options,
    })
    .trim();
}
function assertOwned(directory) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid()
  )
    throw Error(`Not an owned installation directory: ${directory}`);
}
function atomicFile(file, text, mode = 0o600) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function readLink(file) {
  try {
    if (!fs.lstatSync(file).isSymbolicLink())
      throw Error(`Expected an owned symlink, found another file: ${file}`);
    return fs.readlinkSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function linkNew(target, file) {
  fs.symlinkSync(target, file);
}
function replaceLink(target, file, expected) {
  if (readLink(file) !== expected)
    throw Error(`Concurrent replacement: ${file}`);
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.symlinkSync(target, tmp);
    if (readLink(file) !== expected)
      throw Error(`Concurrent replacement: ${file}`);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function fetch(url, destination) {
  const curl = command('curl'),
    wget = command('wget');
  if (curl)
    return run(
      curl,
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--tlsv1.2',
        '--connect-timeout',
        '20',
        '--max-time',
        '300',
        '--retry',
        '3',
        url,
        '-o',
        destination,
      ],
      { timeout: 360000 }
    );
  if (wget)
    return run(
      wget,
      [
        '--https-only',
        '--secure-protocol=TLSv1_2',
        '--timeout=60',
        '--tries=3',
        '-q',
        '-O',
        destination,
        url,
      ],
      { timeout: 360000 }
    );
  throw Error('Install requires curl or wget.');
}
function githubCli(release, userPath) {
  const existing = command('gh', userPath);
  const tools = path.join(release, 'tools/bin');
  fs.mkdirSync(tools, { recursive: true });
  // Keep the user's existing gh (including authenticated wrappers). Authentication
  // is checked by the installer unless explicitly skipped for local-only use.
  if (existing) {
    const resolved = fs.realpathSync(existing);
    // A bundled gh from a previous installation is not on the user's enduring
    // PATH. Carry it forward rather than binding a fresh install to old tools.
    if (
      resolved.startsWith(fs.realpathSync(path.dirname(release)) + path.sep)
    ) {
      const executable = path.join(tools, 'gh');
      fs.copyFileSync(resolved, executable);
      fs.chmodSync(executable, 0o755);
      const license = path.resolve(resolved, '../../gh-LICENSE');
      if (fs.existsSync(license))
        fs.copyFileSync(license, path.join(release, 'tools/gh-LICENSE'));
      return { executable, tools };
    }
    return { executable: existing, tools };
  }
  const [suffix, expected] = GH[`${process.platform}-${process.arch}`] || [];
  if (!suffix) throw Error('Unsupported GitHub CLI platform.');
  const filename = `gh_2.95.0_${suffix}`,
    archive = path.join(release, filename),
    unpack = path.join(release, 'gh-unpack');
  fs.mkdirSync(unpack);
  fetch(
    `https://github.com/cli/cli/releases/download/v2.95.0/${filename}`,
    archive
  );
  if (hash(archive) !== expected)
    throw Error('GitHub CLI checksum mismatch. Nothing was activated.');
  if (suffix.endsWith('.zip')) run('unzip', ['-q', archive, '-d', unpack]);
  else run('tar', ['-xzf', archive, '-C', unpack]);
  const folder = fs
    .readdirSync(unpack)
    .find((name) => fs.existsSync(path.join(unpack, name, 'bin/gh')));
  if (!folder) throw Error('GitHub CLI archive has no expected executable.');
  const executable = path.join(tools, 'gh');
  fs.copyFileSync(path.join(unpack, folder, 'bin/gh'), executable);
  fs.chmodSync(executable, 0o755);
  if (!run(executable, ['--version']).startsWith('gh version 2.95.0'))
    throw Error('GitHub CLI version validation failed.');
  // Retain upstream license, not just the executable.
  const license = path.join(unpack, folder, 'LICENSE');
  if (fs.existsSync(license))
    fs.copyFileSync(license, path.join(release, 'tools/gh-LICENSE'));
  fs.rmSync(archive);
  fs.rmSync(unpack, { recursive: true });
  return { executable, tools };
}
function nativeSlot(userPath, explicit) {
  const existing = command('gt', userPath);
  if (existing)
    return {
      slot: path.join(
        fs.realpathSync(path.dirname(existing)),
        path.basename(existing)
      ),
      create: false,
    };
  const candidates = explicit
    ? [explicit]
    : [
        path.join(process.env.HOME, '.local/bin/gt'),
        '/opt/homebrew/bin/gt',
        '/usr/local/bin/gt',
      ];
  const directories = (userPath || '')
    .split(path.delimiter)
    .filter(path.isAbsolute)
    .map((p) => path.resolve(p));
  for (const candidate of candidates) {
    const directory = path.dirname(candidate);
    if (path.basename(candidate) !== 'gt' || !directories.includes(directory))
      continue;
    try {
      if (fs.statSync(directory).uid !== process.getuid()) continue;
      fs.accessSync(directory, fs.constants.W_OK);
      if (
        fs.existsSync(candidate) ||
        fs.lstatSync(candidate, { throwIfNoEntry: false })
      )
        continue;
      return {
        slot: path.join(fs.realpathSync(directory), 'gt'),
        create: true,
      };
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw Error(
    'No owned writable gt location on existing PATH. Install Graphite 1.8.6 in a user-owned PATH directory first; no sudo, PATH edit, or executable overwrite was attempted.'
  );
}
function cleanPath(cliRoot) {
  const own = path.join(cliRoot, 'bin/gt-cli');
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((directory) => {
      if (!path.isAbsolute(directory)) return false;
      try {
        return (
          fs.realpathSync(path.join(directory, 'gt-cli')) !==
          fs.realpathSync(own)
        );
      } catch (e) {
        if (['ENOENT', 'ENOTDIR'].includes(e.code)) return true;
        throw e;
      }
    })
    .join(path.delimiter);
}
module.exports = {
  hash,
  quote,
  command,
  run,
  assertOwned,
  atomicFile,
  readLink,
  linkNew,
  replaceLink,
  githubCli,
  nativeSlot,
  cleanPath,
};
