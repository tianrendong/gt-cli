import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  NativeBinary,
  verifyNativeBinary,
  currentNativeDigest,
  ABSENT_NATIVE_DIGEST,
} from './state';
import { Topology, assertTopologyRows } from './plan';
import {
  Repository,
  RepositoryBusyError,
  NativeRow,
  NATIVE_COLUMNS,
  digest,
  fail,
  nativeRows,
  sqlite,
  sqlString,
  validateNativeSchema,
  backupDatabase,
} from './repository';
import { canonicalRegistrationPath } from './registration';

export const SUPPORTED_GRAPHITE = '1.8.6';
export function findNative(explicit?: string): NativeBinary {
  const paths = explicit
    ? [path.resolve(explicit)]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((p) => path.join(p, 'gt'));
  for (const candidate of [...new Set(paths)]) {
    try {
      const binary = fs.realpathSync(candidate);
      const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, GT_GH_PROBING_NATIVE: '1' },
      });
      if (result.status === 0 && result.stdout.trim() === SUPPORTED_GRAPHITE) {
        return {
          path: binary,
          version: SUPPORTED_GRAPHITE,
          digest: digest(fs.readFileSync(binary)),
        };
      }
    } catch {
      /* Try the next PATH entry, never use an unverified fallback. */
    }
  }
  fail(
    `A verified Graphite ${SUPPORTED_GRAPHITE} binary is required for reversible migration. Keep Graphite installed; pass --graphite /absolute/path/to/gt if it is not on PATH.`
  );
}
/** Best-effort preflight in addition to SQLite/ref CAS. Never kill other users' processes. */
export function assertNoNativeProcess(repo: Repository): void {
  const listing = execFileSync('ps', ['-axo', 'pid=,comm='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const roots = repo
    .git(['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    // Keep missing roots in the process check without requiring them to exist.
    // Resolve surviving ancestors too (e.g. /tmp -> /private/tmp on macOS).
    .map((field) => canonicalRegistrationPath(field.slice(9)));
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (
      !match ||
      Number(match[1]) === process.pid ||
      path.basename(match[2]) !== 'gt'
    )
      continue;
    let cwd: string;
    try {
      cwd =
        process.platform === 'linux'
          ? fs.readlinkSync(`/proc/${match[1]}/cwd`)
          : execFileSync(
              '/usr/sbin/lsof',
              ['-a', '-p', match[1], '-d', 'cwd', '-Fn'],
              {
                encoding: 'utf8',
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            )
              .split('\n')
              .find((l) => l.startsWith('n'))
              ?.slice(1) ?? '';
    } catch {
      continue;
    } // The process may already have exited; SQLite/ref CAS is still mandatory.
    if (roots.some((root) => cwd === root || cwd.startsWith(root + path.sep))) {
      throw new RepositoryBusyError(
        'Native Graphite is still running in this repository. Pause native gt commands in all worktrees before switching. No process was killed.'
      );
    }
  }
}

export function stopIsolatedNativeHelpers(
  directory: string,
  binary: string
): void {
  // Never a general process-killer. Only our private validation/test directories
  // and this exact packaged Graphite executable's detached background jobs.
  if (
    !/^gt-(?:gh-handoff-|switch-test-|handoff-probe-)/.test(
      path.basename(directory)
    )
  )
    fail('Refusing helper cleanup outside an owned validation directory.');
  const root = fs.realpathSync(directory);
  const prefix =
    fs.realpathSync(binary) + ' /snapshot/dist/graphite.js background ';
  const jobs = (): number[] => {
    const listing = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return listing.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !match[2].startsWith(prefix)) return [];
      try {
        const cwd =
          process.platform === 'linux'
            ? fs.readlinkSync(`/proc/${match[1]}/cwd`)
            : execFileSync(
                '/usr/sbin/lsof',
                ['-a', '-p', match[1], '-d', 'cwd', '-Fn'],
                {
                  encoding: 'utf8',
                  timeout: 3000,
                  stdio: ['ignore', 'pipe', 'pipe'],
                }
              )
                .split('\n')
                .find((l) => l.startsWith('n'))
                ?.slice(1) ?? '';
        return cwd === root || cwd.startsWith(root + path.sep)
          ? [Number(match[1])]
          : [];
      } catch {
        return [];
      }
    });
  };
  const owned = jobs();
  for (const pid of owned) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Exited. */
      }
    }
  }
  if (owned.length) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (const pid of jobs().filter((pid) => owned.includes(pid))) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Exited. */
        }
      }
    }
  }
}

export type NativeVerification = { db: string; rows: NativeRow[] };
/** Ask the real, version-gated Graphite CLI to import legacy refs in an isolated
 * Git directory. No checkout, no source refs/index changes, no credentials.
 */
// eslint-disable-next-line max-lines-per-function
export function verifyWithNative(
  repo: Repository,
  options: { native: NativeBinary; topology: Topology; directory: string }
): NativeVerification {
  const { native, topology, directory } = options;
  verifyNativeBinary(native);
  const staging = path.join(directory, 'native-check');
  const home = path.join(directory, 'native-home');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const offlineBin = path.join(directory, 'offline-bin');
  fs.mkdirSync(offlineBin, { mode: 0o700 });
  // Graphite starts a background `brew info` update check, even for log. Never
  // let validation invoke package managers, credential helpers, or HTTP CLIs.
  for (const name of ['brew', 'npm', 'gh', 'curl', 'wget']) {
    fs.writeFileSync(path.join(offlineBin, name), '#!/bin/sh\nexit 1\n', {
      mode: 0o700,
    });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: offlineBin + path.delimiter + process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GT_EDITOR: 'true',
    GT_PAGER: '',
    GH_PROMPT_DISABLED: '1',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    GRAPHITE_DISABLE_TELEMETRY: '1',
    GRAPHITE_DISABLE_UPGRADE_PROMPT: '1',
    GRAPHITE_DISABLE_SURVEY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
  };
  const git = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', staging, ...args], {
      env,
      input,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git([
    'init',
    '--object-format=' + repo.git(['rev-parse', '--show-object-format']),
    '-b',
    topology.config.trunk,
  ]);
  const objects = path.resolve(
    repo.cwd,
    repo.git(['rev-parse', '--git-path', 'objects'])
  );
  if (objects.includes('\n'))
    fail('Unsupported newline in the Git object directory path.');
  fs.writeFileSync(
    path.join(staging, '.git/objects/info/alternates'),
    objects + '\n'
  );
  for (const [name, value] of Object.entries({
    'core.hooksPath': path.join(directory, 'no-hooks'),
    'core.fsmonitor': 'false',
    'gc.auto': '0',
    'user.name': 'gt-gh validation',
    'user.email': 'gt-gh-validation@example.invalid',
    'remote.origin.url': 'https://github.com/gt-gh-offline/validation.git',
    'remote.origin.pushurl': 'disabled://gt-gh-handoff',
  }))
    git(['config', name, value]);
  const commands: string[] = [];
  for (const [branch, sha] of Object.entries(topology.heads)) {
    git(['check-ref-format', `refs/heads/${branch}`]);
    commands.push(`create refs/heads/${branch} ${sha}`);
  }
  for (const [branch, meta] of Object.entries(topology.metadata)) {
    git(['check-ref-format', `refs/branch-metadata/${branch}`]);
    const legacy = {
      ...meta,
      ...(topology.frozen.includes(branch) ? { state: 'frozen' } : {}),
    };
    const sha = git(['hash-object', '-w', '--stdin'], JSON.stringify(legacy));
    commands.push(`create refs/branch-metadata/${branch} ${sha}`);
  }
  git(
    ['update-ref', '--stdin'],
    ['start', ...commands, 'prepare', 'commit', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(staging, '.git/.graphite_repo_config'),
    JSON.stringify({
      trunk: topology.config.trunk,
      trunks: topology.trunks.map((name) => ({ name })),
      lastFetchedPRInfoMs: Date.now(),
      lastFetchedFeatureFlagsInMs: Date.now(),
    })
  );
  fs.writeFileSync(
    path.join(staging, '.git/.graphite_pr_info'),
    JSON.stringify({ prInfos: [], mergeabilityStatuses: [] })
  );
  // Node supports detached spawnSync; the inherited Node 17 declarations omit it.
  const commandOptions = {
    cwd: staging,
    env,
    encoding: 'utf8' as const,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    detached: process.platform !== 'win32',
  };
  const result = spawnSync(
    native.path,
    // Include untracked branches so native also validates descendants below
    // an untracked ancestor instead of leaving their lazy cache rows unset.
    [
      '--cwd',
      staging,
      '--no-interactive',
      'log',
      'short',
      '--all',
      '--show-untracked',
    ],
    commandOptions
  );
  // Terminate helpers that stayed in this validation process group, never the
  // user's sessions. Detached cleanup helpers may finish asynchronously; the
  // caller retries removal of only this isolated directory.
  if (result.pid && process.platform !== 'win32') {
    try {
      process.kill(-result.pid, 'SIGTERM');
    } catch {
      /* Group already exited. */
    }
  }
  stopIsolatedNativeHelpers(directory, native.path);
  fs.writeFileSync(
    path.join(directory, 'native-validation.log'),
    result.stdout + '\n' + result.stderr,
    { mode: 0o600 }
  );
  if (result.status !== 0)
    fail(
      'Graphite could not validate the handoff in an isolated repository. Real branches and metadata were not changed. ' +
        (result.stderr || result.error?.message || '')
    );
  const db = path.join(staging, '.git/.graphite_metadata.db');
  validateNativeSchema(db);
  const rows = nativeRows(db);
  assertTopologyRows(topology, rows, (ancestor, descendant) => {
    try {
      git(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  });
  return { db, rows };
}

/** Publish a validated first native DB without replacing a concurrent writer. */
export function createNativeDatabase(repo: Repository, targetDb: string): void {
  const temporary = path.join(
    repo.common,
    `.gt-native-install-${randomBytes(6).toString('hex')}.sqlite`
  );
  try {
    backupDatabase(targetDb, temporary);
    if (currentNativeDigest(repo) !== ABSENT_NATIVE_DIGEST)
      fail(
        'Native Graphite metadata appeared during handoff. Nothing was overwritten.'
      );
    // Same filesystem, atomic and exclusive. EEXIST is a concurrent-write failure.
    fs.linkSync(temporary, repo.db);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Keep the live database inode/WAL protocol. SQLite owns one transaction; never
 * replace a possibly-open .db file or wipe unrelated tables/lock files.
 */
export function commitNativeRows(
  repo: Repository,
  beforeDb: string,
  targetDb: string
): void {
  const columns = NATIVE_COLUMNS.join(',');
  sqlite(
    repo.db,
    `
    ATTACH DATABASE ${sqlString(beforeDb)} AS expected;
    ATTACH DATABASE ${sqlString(targetDb)} AS desired;
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE switch_guard (ok INTEGER NOT NULL CHECK(ok = 1));
    INSERT INTO switch_guard SELECT CASE WHEN
      EXISTS (SELECT ${columns} FROM main.branch_metadata EXCEPT SELECT ${columns} FROM expected.branch_metadata)
      OR EXISTS (SELECT ${columns} FROM expected.branch_metadata EXCEPT SELECT ${columns} FROM main.branch_metadata)
      OR EXISTS (SELECT name,sql FROM main.sqlite_master WHERE type='table' EXCEPT SELECT name,sql FROM expected.sqlite_master WHERE type='table')
      OR EXISTS (SELECT name,sql FROM expected.sqlite_master WHERE type='table' EXCEPT SELECT name,sql FROM main.sqlite_master WHERE type='table')
      THEN 0 ELSE 1 END;
    DELETE FROM main.branch_metadata;
    INSERT INTO main.branch_metadata (${columns}) SELECT ${columns} FROM desired.branch_metadata;
    COMMIT;
  `,
    false
  );
}
