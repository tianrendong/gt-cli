import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { atomicJSON } from '../github/stack_file';
import { fileLock, FileLockBusyError } from '../github/file_lock';
import { digest, equal, fail } from './repository';
import { findNative } from './native';
import { CandidateBinary, NativeBinary, verifyNativeBinary } from './state';
import { Registration, validRegistrations } from './registration';
import { ImplementationSelection, validSelections } from './selection';
import {
  nativeReceipt,
  routerContent as escapeRouterContent,
} from '../../../scripts/installation/native_escape.cjs';

type OriginalEntry =
  | { kind: 'symlink'; target: string }
  | { kind: 'file'; digest: string; mode: number };
export type LauncherRecord = {
  schemaVersion: 1 | 2;
  defaultMode?: 'gt-gh' | 'graphite';
  phase: 'prepared' | 'active' | 'restored';
  slot: string;
  original: OriginalEntry;
  native: NativeBinary;
  dispatcher: string;
  router: string;
  routerDigest: string;
  node?: string;
  toolsBin?: string;
  runtimeUpgrade?: { node?: string; routerDigest: string };
  repositories: string[];
  /** Absent for legacy registrations, which lack per-path filesystem identity. */
  registrations?: Record<string, Registration>;
  /** Implementation overrides, including repositories not initialized with gt. */
  implementations?: Record<string, ImplementationSelection>;
  /** Durable intent for bindings that could not refresh during an update. */
  pendingBindings?: { candidate: CandidateBinary; repositories: string[] };
};
export type LauncherPlan = {
  slot: string;
  directory: string;
  record?: LauncherRecord;
  native: NativeBinary;
  original: OriginalEntry;
};
export const LAUNCHER_ENV = 'GT_GH_LAUNCHER_RECORD';

function noSymlink(file: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink())
      fail(`Refusing symlinked launcher state: ${file}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function entry(slot: string): OriginalEntry | undefined {
  try {
    const stat = fs.lstatSync(slot);
    if (stat.isSymbolicLink())
      return { kind: 'symlink', target: fs.readlinkSync(slot) };
    if (stat.isFile())
      return {
        kind: 'file',
        digest: digest(fs.readFileSync(slot)),
        mode: stat.mode & 0o777,
      };
    fail(`The gt entry is not a regular file or symlink: ${slot}.`);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function gtOnPath(): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', 'gt');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        if (!path.isAbsolute(directory))
          fail(
            'Use an absolute PATH entry for gt before switching implementations.'
          );
        return path.join(fs.realpathSync(path.dirname(candidate)), 'gt');
      }
    } catch (error) {
      if (
        error.code !== 'ENOENT' &&
        error.code !== 'EACCES' &&
        error.code !== 'ENOTDIR'
      )
        throw error;
    }
  }
  return fail(
    'No gt executable found on PATH. Keep native Graphite installed before enabling the clone.'
  );
}
function canonical(file: string): string {
  const absolute = path.resolve(file);
  return fs.existsSync(absolute)
    ? fs.realpathSync(absolute)
    : path.join(canonical(path.dirname(absolute)), path.basename(absolute));
}
function directoryFor(slot: string): string {
  const root = path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'gt-gh/launchers'
  );
  noSymlink(path.dirname(root));
  noSymlink(root);
  const directory = path.join(root, digest(slot).slice(0, 24));
  noSymlink(directory);
  return canonical(directory);
}
function routerPath(directory: string, slot: string): string {
  return path.join(
    path.dirname(slot),
    `.gt-gh-router-${digest(directory).slice(0, 24)}`
  );
}
export function readLauncher(file: string): LauncherRecord {
  noSymlink(path.dirname(file));
  noSymlink(file);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as LauncherRecord;
  if (
    ![1, 2].includes(record.schemaVersion) ||
    (record.schemaVersion === 2 &&
      !['gt-gh', 'graphite'].includes(record.defaultMode ?? '')) ||
    (record.schemaVersion === 1 && record.defaultMode !== undefined) ||
    !['prepared', 'active', 'restored'].includes(record.phase) ||
    !path.isAbsolute(record.slot ?? '') ||
    path.basename(record.slot) !== 'gt' ||
    record.router !== routerPath(path.dirname(file), record.slot) ||
    !/^[a-f0-9]{64}$/.test(record.routerDigest ?? '') ||
    !path.isAbsolute(record.native?.path ?? '') ||
    !path.isAbsolute(record.dispatcher ?? '') ||
    (record.node !== undefined && !path.isAbsolute(record.node)) ||
    (record.toolsBin !== undefined && !path.isAbsolute(record.toolsBin)) ||
    (record.runtimeUpgrade !== undefined &&
      (!record.node ||
        !/^[a-f0-9]{64}$/.test(record.runtimeUpgrade.routerDigest ?? '') ||
        (record.runtimeUpgrade.node !== undefined &&
          !path.isAbsolute(record.runtimeUpgrade.node)))) ||
    (record.pendingBindings !== undefined &&
      (!path.isAbsolute(record.pendingBindings?.candidate?.node ?? '') ||
        !path.isAbsolute(record.pendingBindings?.candidate?.script ?? '') ||
        !Array.isArray(record.pendingBindings?.repositories) ||
        record.pendingBindings.repositories.some(
          (repo) => typeof repo !== 'string' || !path.isAbsolute(repo)
        ))) ||
    (record.implementations !== undefined &&
      !validSelections(record.implementations)) ||
    (record.registrations !== undefined &&
      !validRegistrations(record.registrations)) ||
    !Array.isArray(record.repositories) ||
    record.repositories.some(
      (repo) => typeof repo !== 'string' || !path.isAbsolute(repo)
    ) ||
    !['file', 'symlink'].includes(record.original?.kind) ||
    (record.original.kind === 'symlink' &&
      typeof record.original.target !== 'string') ||
    (record.original.kind === 'file' &&
      (!/^[a-f0-9]{64}$/.test(record.original.digest) ||
        !Number.isInteger(record.original.mode) ||
        record.original.mode < 0 ||
        record.original.mode > 0o777))
  )
    fail('Invalid gt launcher record. No implementation was run.');
  return record;
}
/** Configuration remains readable after restoring native gt. Historical native
 * executable details must not be used instead of the live plan for handoff. */
export function savedLauncherRecord(
  plan: LauncherPlan
): LauncherRecord | undefined {
  if (plan.record) return plan.record;
  const file = path.join(plan.directory, 'launcher.json');
  return fs.lstatSync(file, { throwIfNoEntry: false })
    ? readLauncher(file)
    : undefined;
}

export function launcherFromEnvironment(): LauncherRecord | undefined {
  const file = process.env[LAUNCHER_ENV];
  if (!file) return undefined;
  if (!path.isAbsolute(file)) fail('Invalid gt launcher record path.');
  return readLauncher(file);
}
export function planLauncher(explicitSlot?: string): LauncherPlan {
  const slot = gtOnPath();
  if (process.getuid && fs.lstatSync(slot).uid !== process.getuid())
    fail(
      'The gt PATH entry belongs to another OS user. Use your own native Graphite installation; no executable was changed.'
    );
  if (
    explicitSlot &&
    path.join(
      fs.realpathSync(path.dirname(explicitSlot)),
      path.basename(explicitSlot)
    ) !== slot
  )
    fail(
      '--gt-path must name the gt entry currently selected by PATH. No other executable will be replaced.'
    );
  const directory = directoryFor(slot),
    file = path.join(directory, 'launcher.json');
  const current = entry(slot);
  if (fs.existsSync(file)) {
    const record = readLauncher(file);
    if (record.slot !== slot)
      fail('Launcher record does not match this gt entry.');
    const owned =
      current?.kind === 'symlink' && current.target === record.router;
    if (owned) {
      const routerDigest = digest(fs.readFileSync(record.router));
      if (
        routerDigest !== record.routerDigest &&
        routerDigest !== record.runtimeUpgrade?.routerDigest
      )
        fail(
          'The managed gt launcher changed outside the switch. Nothing was overwritten.'
        );
      if (record.node) {
        const selected = runtimeTarget(directory);
        if (
          selected !== record.node &&
          !(record.runtimeUpgrade && selected === record.runtimeUpgrade.node)
        )
          fail(
            'The managed gt runtime changed outside the installer. No replacement was guessed.'
          );
      }
      verifyNativeBinary(record.native);
      return {
        slot,
        directory,
        record,
        original: record.original,
        native: record.native,
      };
    }
    if (record.phase !== 'restored' && !equal(current, record.original))
      fail(
        'The gt entry changed outside the switch. Restore or reconcile it before retrying; no newer installation was overwritten.'
      );
    if (record.repositories.length && !equal(current, record.original))
      fail(
        'The gt entry changed while repositories still use the clone. No fallback was guessed.'
      );
    if (record.phase !== 'restored') {
      verifyNativeBinary(record.native);
      return {
        slot,
        directory,
        record,
        original: record.original,
        native: record.native,
      };
    }
  }
  if (!current) fail('The gt entry disappeared while preparing the switch.');
  // Only this actual PATH entry may be replaced, and only after native verification.
  const native = findNative(slot);
  if (current.kind === 'file') {
    const magic = fs.readFileSync(slot).subarray(0, 4).toString('hex');
    if (
      ![
        '7f454c46',
        'cffaedfe',
        'cefaedfe',
        'feedfacf',
        'feedface',
        'cafebabe',
        'bebafeca',
      ].includes(magic)
    )
      fail(
        'The gt entry is a wrapper script. Put the native Graphite executable or its symlink on PATH before enabling; the wrapper was not replaced.'
      );
  }
  fs.accessSync(path.dirname(slot), fs.constants.W_OK);
  return { slot, directory, original: current, native };
}
function replaceEntry(
  slot: string,
  expected: OriginalEntry,
  install: (temporary: string) => void
): void {
  if (!equal(entry(slot), expected))
    fail(
      'The gt entry changed during the switch. No newer installation was overwritten.'
    );
  const temporary = path.join(
    path.dirname(slot),
    `.gt-switch-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    install(temporary);
    if (!equal(entry(slot), expected))
      fail(
        'The gt entry changed during the switch. No newer installation was overwritten.'
      );
    fs.renameSync(temporary, slot);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Serializes only our installer. Package managers/native Graphite must be paused. */
export async function withLauncher<T>(
  slot: string,
  action: (plan: LauncherPlan) => Promise<T>,
  timeoutMs = 30_000
): Promise<T> {
  const directory = directoryFor(slot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'install.lock');
  noSymlink(lock);
  const fd = fs.openSync(lock, 'a', 0o600),
    deadline = performance.now() + timeoutMs;
  let acquired = false;
  try {
    for (;;) {
      try {
        fileLock(fd);
        acquired = true;
        break;
      } catch (error) {
        if (!(error instanceof FileLockBusyError) || timeoutMs === 0)
          throw error;
        if (performance.now() >= deadline)
          fail('Timed out waiting for another gt enable/disable script.');
        await sleep(25);
      }
    }
    return await action(planLauncher(slot));
  } finally {
    try {
      if (acquired) fileLock(fd, true);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function runtimeTarget(directory: string): string | undefined {
  const file = path.join(directory, 'node');
  try {
    if (!fs.lstatSync(file).isSymbolicLink())
      fail('Managed gt runtime link was replaced. Nothing was overwritten.');
    return fs.readlinkSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function replaceRuntime(
  directory: string,
  node: string,
  expected?: string
): void {
  const actual = runtimeTarget(directory);
  if (actual === node) return;
  if (actual !== expected)
    fail(
      'Managed gt runtime changed during installation. Nothing was overwritten.'
    );
  const temporary = path.join(
    directory,
    `node.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    fs.symlinkSync(node, temporary);
    if (runtimeTarget(directory) !== actual)
      fail(
        'Managed gt runtime changed during installation. Nothing was overwritten.'
      );
    fs.renameSync(temporary, path.join(directory, 'node'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function routerContent(plan: LauncherPlan, native: string): string {
  const router = routerPath(plan.directory, plan.slot);
  nativeReceipt(router, native);
  return escapeRouterContent(plan.directory, native, router);
}

function preserveNative(plan: LauncherPlan): NativeBinary {
  if (plan.original.kind !== 'file') return plan.native;
  // Adjacent hard link preserves inode/ACLs/signature, even across state volumes.
  const backup = path.join(
    path.dirname(plan.slot),
    `.gt-gh-native-${Date.now()}-${randomBytes(4).toString('hex')}`,
    'gt'
  );
  fs.mkdirSync(path.dirname(backup), { mode: 0o711 });
  fs.chmodSync(path.dirname(backup), 0o711);
  fs.linkSync(plan.slot, backup);
  const native = { ...plan.native, path: backup };
  verifyNativeBinary(native);
  return native;
}

/** Install at the SAME PATH entry so existing shells and agents see the switch.
 * The native executable is never edited. A regular binary gets a private backup.
 */
export function installLauncher(
  plan: LauncherPlan,
  dispatcher: string
): LauncherRecord {
  const file = path.join(plan.directory, 'launcher.json');
  // Upgrade the stable bootstrap before writing a v2 (global-mode) record.
  const bootstrap = path.join(plan.directory, 'bootstrap.cjs');
  noSymlink(bootstrap);
  const bootstrapContent = `const fs = require('fs'), path = require('path');\nconst file = path.join(__dirname, 'launcher.json');\nconst record = JSON.parse(fs.readFileSync(file, 'utf8'));\nif (![1, 2].includes(record.schemaVersion) || !path.isAbsolute(record.dispatcher || '')) throw new Error('Invalid gt launcher record');\nif (record.node && fs.realpathSync(record.node) !== fs.realpathSync(process.execPath)) {\n  const child = require('child_process').spawnSync(record.node, [__filename, ...process.argv.slice(2)], {stdio:'inherit'});\n  if (child.error) throw child.error;\n  process.exit(child.status ?? 1);\n}\nprocess.env.${LAUNCHER_ENV} = file;\nif (record.toolsBin) process.env.PATH = (process.env.PATH || '') + path.delimiter + record.toolsBin;\nprocess.argv[1] = record.dispatcher;\nrequire(record.dispatcher);\n`;
  if (
    !fs.existsSync(bootstrap) ||
    fs.readFileSync(bootstrap, 'utf8') !== bootstrapContent
  ) {
    const temporary = `${bootstrap}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, bootstrapContent, {
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporary, bootstrap);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const node = fs.realpathSync(process.execPath);
  const tools = path.resolve(path.dirname(dispatcher), '../../.tools-bin');
  const toolsBin = fs.existsSync(tools) ? fs.realpathSync(tools) : undefined;
  let record = plan.record;
  if (!record || record.phase === 'restored') {
    const native = preserveNative(plan);
    const router = routerPath(plan.directory, plan.slot);
    noSymlink(router);
    const content = routerContent(plan, native.path);
    const historical = fs.existsSync(file) ? readLauncher(file) : undefined;
    replaceRuntime(
      plan.directory,
      node,
      historical?.phase === 'restored' ? historical.node : undefined
    );
    fs.writeFileSync(router, content, { mode: 0o755 });
    fs.chmodSync(router, 0o755);
    record = {
      schemaVersion: 1,
      phase: 'prepared',
      slot: plan.slot,
      original: plan.original,
      native,
      dispatcher,
      router,
      routerDigest: digest(content),
      node,
      ...(toolsBin ? { toolsBin } : {}),
      repositories: [],
      ...(historical?.implementations
        ? { implementations: historical.implementations }
        : {}),
    };
    atomicJSON(file, record);
  } else {
    const content = routerContent(plan, record.native.path);
    const nextDigest = digest(content);
    if (
      record.runtimeUpgrade ||
      record.node !== node ||
      record.routerDigest !== nextDigest
    ) {
      // Checkpoint both allowed generations before changing either executable.
      // A crash at any point can be resumed; an unrelated replacement still fails.
      record = {
        ...record,
        node,
        routerDigest: nextDigest,
        runtimeUpgrade: record.runtimeUpgrade ?? {
          node: record.node,
          routerDigest: record.routerDigest,
        },
      };
      atomicJSON(file, record);
      replaceRuntime(plan.directory, node, record.runtimeUpgrade?.node);
      const actual = digest(fs.readFileSync(record.router));
      if (actual !== nextDigest) {
        if (actual !== record.runtimeUpgrade?.routerDigest)
          fail(
            'The managed gt launcher changed during its runtime upgrade. Nothing was overwritten.'
          );
        const temporary = `${record.router}.${randomBytes(6).toString(
          'hex'
        )}.tmp`;
        try {
          fs.writeFileSync(temporary, content, { mode: 0o755, flag: 'wx' });
          if (digest(fs.readFileSync(record.router)) !== actual)
            fail(
              'The managed gt launcher changed during its runtime upgrade. Nothing was overwritten.'
            );
          fs.renameSync(temporary, record.router);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
      delete record.runtimeUpgrade;
      atomicJSON(file, record);
    }
  }
  const current = entry(plan.slot);
  if (!(current?.kind === 'symlink' && current.target === record.router)) {
    replaceEntry(plan.slot, record.original, (temporary) =>
      fs.symlinkSync(record!.router, temporary)
    );
  }
  const active = {
    ...record,
    dispatcher,
    node,
    toolsBin,
    phase: 'active' as const,
  };
  atomicJSON(file, active);
  return active;
}
// eslint-disable-next-line max-params
export function registerRepository(
  plan: LauncherPlan,
  record: LauncherRecord,
  common: string,
  registration: Registration = { source: 'explicit', worktrees: [] },
  pendingCandidate?: CandidateBinary
): LauncherRecord {
  common = fs.realpathSync(common);
  const previous = record.registrations?.[common];
  // Adoption cannot downgrade explicit or unknown existing provenance.
  const keepPrevious =
    registration.source === 'adopted' && record.repositories.includes(common);
  const updated = {
    ...record,
    repositories: [
      ...new Set([...record.repositories, fs.realpathSync(common)]),
    ],
  };
  if (!keepPrevious || previous) {
    updated.registrations = {
      ...record.registrations,
      [common]: {
        ...registration,
        source: keepPrevious ? previous!.source : registration.source,
        pathDevices: { ...previous?.pathDevices, ...registration.pathDevices },
        pathMounts: { ...previous?.pathMounts, ...registration.pathMounts },
        worktrees: [
          ...new Set([
            ...(previous?.worktrees ?? []),
            ...registration.worktrees,
          ]),
        ],
      },
    };
  }
  if (pendingCandidate) {
    // Re-enrolling a returned checkout must persist both registration and catch-up
    // intent in one write, including when it is busy or the process crashes next.
    updated.pendingBindings = {
      candidate: pendingCandidate,
      repositories: [
        ...new Set([...(record.pendingBindings?.repositories ?? []), common]),
      ],
    };
  } else {
    // Explicit enable/adoption is a new selection, not a deferred update.
    removePendingBinding(updated, common);
  }
  atomicJSON(path.join(plan.directory, 'launcher.json'), updated);
  return updated;
}

/** Mutates only a caller-owned record, before its atomic write under the lock. */
export function removePendingBinding(
  record: LauncherRecord,
  common: string
): void {
  if (!record.pendingBindings) return;
  const repositories = record.pendingBindings.repositories.filter(
    (repo) => repo !== common
  );
  if (repositories.length)
    record.pendingBindings = { ...record.pendingBindings, repositories };
  else delete record.pendingBindings;
}

export function releaseRepository(
  plan: LauncherPlan,
  record: LauncherRecord,
  common?: string
): { remaining: string[]; restored: boolean } {
  const repositories = common
    ? record.repositories.filter((repo) => repo !== fs.realpathSync(common))
    : record.repositories;
  const needed =
    repositories.length > 0 ||
    record.defaultMode === 'gt-gh' ||
    Object.values(record.implementations ?? {}).some(
      (selection) => selection.mode === 'gt-gh'
    );
  const file = path.join(plan.directory, 'launcher.json');
  const current = entry(plan.slot);
  const owned: OriginalEntry = { kind: 'symlink', target: record.router };
  if (
    !equal(current, record.original) &&
    (!equal(current, owned) ||
      digest(fs.readFileSync(record.router)) !== record.routerDigest)
  )
    fail(
      'The gt launcher changed outside the switch. No newer executable or launcher record was overwritten.'
    );
  if (needed && !equal(current, owned))
    fail(
      'Other repositories still need the gt dispatcher. Rerun the switch script to restore it first.'
    );
  const updated = { ...record, repositories };
  if (common) {
    removePendingBinding(updated, fs.realpathSync(common));
    if (updated.registrations) {
      updated.registrations = { ...updated.registrations };
      delete updated.registrations[fs.realpathSync(common)];
    }
  }
  atomicJSON(file, updated);
  if (needed) return { remaining: repositories, restored: false };
  if (!equal(current, record.original)) {
    verifyNativeBinary(record.native);
    replaceEntry(plan.slot, owned, (temporary) => {
      if (record.original.kind === 'symlink')
        fs.symlinkSync(record.original.target, temporary);
      else fs.linkSync(record.native.path, temporary);
    });
  }
  atomicJSON(file, { ...updated, phase: 'restored' });
  return { remaining: [], restored: true };
}

/** Change only the default; explicitly selected repositories keep their backend. */
export function setGlobalMode(
  plan: LauncherPlan,
  dispatcher: string,
  enabled: boolean
): { remaining: string[]; restored: boolean } {
  if (!enabled && (!plan.record || plan.record.phase === 'restored'))
    return { remaining: [], restored: false };
  const installed = installLauncher(plan, dispatcher);
  const record: LauncherRecord = {
    ...installed,
    schemaVersion: 2,
    defaultMode: enabled ? 'gt-gh' : 'graphite',
  };
  atomicJSON(path.join(plan.directory, 'launcher.json'), record);
  return releaseRepository(plan, record);
}
