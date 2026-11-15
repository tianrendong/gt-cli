import fs from 'fs';
import os from 'os';
import path from 'path';
import { Repository, fail } from './repository';
import type { LauncherPlan, LauncherRecord } from './launcher';
import { atomicJSON } from '../github/stack_file';

export type Registration = {
  source: 'adopted' | 'explicit';
  worktrees: string[];
  /** Devices observed while these paths existed, including historical worktrees.
   * Device numbers are assigned at mount time (on every boot for macOS APFS
   * volumes), so they identify a filesystem only until its next mount. */
  pathDevices?: Record<string, number>;
  /** Mount point of each path's filesystem while it existed (0.6.34+). Mount
   * points survive reboots, so a missing path whose nearest existing ancestor
   * is on the same mount was deleted rather than unmounted. */
  pathMounts?: Record<string, string>;
  temporaryRoot?: { path: string; device: number; inode: number };
};
export type ForgottenRepository = { repository: string };

/** Include completed cleanup in errors from a later update/handoff step. */
export function forgottenSummary(entries: ForgottenRepository[]): string {
  return entries
    .map(({ repository }) => `Forgot missing checkout: ${repository}`)
    .join('\n');
}

function below(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

/** Resolve existing ancestors, but never mistake EACCES or ENOTDIR for deletion. */
export function canonicalRegistrationPath(file: string): string {
  const absolute = path.resolve(file);
  try {
    fs.lstatSync(absolute);
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling symlink is not an absent path.
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })) throw error;
    return path.join(
      canonicalRegistrationPath(path.dirname(absolute)),
      path.basename(absolute)
    );
  }
}

/** Highest ancestor on the same device as an existing path: its filesystem's
 * mount point, or the root of a volume group that reports one device (macOS
 * reports `/` for the system and data volumes). Consistent between boots. */
export function mountPoint(file: string): string {
  let current = file;
  const device = fs.statSync(current).dev;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current || fs.statSync(parent).dev !== device)
      return current;
    current = parent;
  }
}

function temporaryRoots(): string[] {
  return [
    ...new Set(
      ['/tmp', os.tmpdir()].flatMap((root) => {
        try {
          const canonical = fs.realpathSync(root);
          if (
            canonical === path.parse(canonical).root ||
            canonical ===
              canonicalRegistrationPath(process.env.HOME || os.homedir())
          )
            return [];
          return [canonical];
        } catch {
          return [];
        }
      })
    ),
  ];
}

export function registrationSnapshot(
  repo: Repository,
  source: Registration['source']
): Registration {
  const worktrees = repo
    .git(['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalRegistrationPath(line.slice(9)));
  const common = fs.realpathSync(repo.common);
  const root = temporaryRoots().find(
    (candidate) =>
      below(candidate, common) &&
      worktrees.every((worktree) => below(candidate, worktree))
  );
  const stat = root ? fs.statSync(root) : undefined;
  const paths = [
    common,
    ...(path.basename(common) === '.git' ? [path.dirname(common)] : []),
    ...worktrees,
  ];
  const identities = paths.flatMap((file) => {
    try {
      return [{ file, device: fs.statSync(file).dev, mount: mountPoint(file) }];
    } catch (error) {
      // Missing linked checkouts may still have live Git administrative data.
      // Do not guess their filesystem from an ancestor; retain prior observations.
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  });
  return {
    source,
    worktrees,
    pathDevices: Object.fromEntries(
      identities.map(({ file, device }) => [file, device])
    ),
    pathMounts: Object.fromEntries(
      identities.map(({ file, mount }) => [file, mount])
    ),
    ...(root && stat
      ? { temporaryRoot: { path: root, device: stat.dev, inode: stat.ino } }
      : {}),
  };
}

export function validRegistrations(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([common, registration]) => {
    const r = registration as Registration;
    return (
      path.isAbsolute(common) &&
      r &&
      ['adopted', 'explicit'].includes(r.source) &&
      Array.isArray(r.worktrees) &&
      r.worktrees.every(
        (root) => typeof root === 'string' && path.isAbsolute(root)
      ) &&
      (r.pathDevices === undefined ||
        (r.pathDevices &&
          typeof r.pathDevices === 'object' &&
          !Array.isArray(r.pathDevices) &&
          Object.entries(r.pathDevices).every(
            ([file, device]) =>
              path.isAbsolute(file) &&
              Number.isSafeInteger(device) &&
              device >= 0
          ))) &&
      (r.pathMounts === undefined ||
        (r.pathMounts &&
          typeof r.pathMounts === 'object' &&
          !Array.isArray(r.pathMounts) &&
          Object.entries(r.pathMounts).every(
            ([file, mount]) =>
              path.isAbsolute(file) &&
              typeof mount === 'string' &&
              path.isAbsolute(mount)
          ))) &&
      (r.temporaryRoot === undefined ||
        (typeof r.temporaryRoot?.path === 'string' &&
          path.isAbsolute(r.temporaryRoot.path) &&
          Number.isSafeInteger(r.temporaryRoot.device) &&
          Number.isSafeInteger(r.temporaryRoot.inode)))
    );
  });
}

/** Filesystem holding a missing path's nearest existing ancestor. */
type MissingIdentity = { device: number; mount: string };

/** Return the nearest existing ancestor's device and mount point only for a
 * plain ENOENT. Symlinks, ENOTDIR, and unreadable ancestors are not evidence
 * of deletion. */
function missingPathIdentity(file: string): MissingIdentity | undefined {
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let parent = fs.lstatSync(current);
  let mount = current;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      if (stat.dev !== parent.dev) mount = current;
      parent = stat;
    } catch (error) {
      if (error.code === 'ENOENT') return { device: parent.dev, mount };
      throw error;
    }
  }
  return undefined;
}

export function definitelyMissing(file: string): boolean {
  return missingPathIdentity(file) !== undefined;
}

/** Registrations whose Git directory is definitely gone. Leftover working files
 * or linked worktree directories have no repository without it and are never
 * deleted. Unverifiable paths (EACCES, symlinks, ENOTDIR) stay protected. */
export function missingRegistrations(record: LauncherRecord): string[] {
  return [
    ...new Set([
      ...record.repositories,
      ...Object.keys(record.implementations ?? {}),
    ]),
  ]
    .sort()
    .filter((common) => {
      try {
        return canForget(record, common, false);
      } catch {
        return false;
      }
    });
}

/** Records before 0.6.34 identify filesystems only by device number. Legacy
 * records without per-path devices fall back to HOME/temp, not arbitrary paths
 * on the root device (e.g. an absent /Volumes mount). This remains a heuristic:
 * old records cannot identify former nested mounts. `recorded` distinguishes a
 * device observed in the past from the current device of a containing root. */
function expectedDevice(
  registration: Registration | undefined,
  file: string
): { device: number; recorded: boolean } | undefined {
  const device = registration?.pathDevices?.[file];
  if (device !== undefined) return { device, recorded: true };
  const temporary = registration?.temporaryRoot;
  if (temporary && below(temporary.path, file))
    return { device: temporary.device, recorded: true };
  for (const root of [process.env.HOME || os.homedir(), ...temporaryRoots()]) {
    try {
      const canonical = fs.realpathSync(root);
      if (canonical !== path.parse(canonical).root && below(canonical, file))
        return { device: fs.statSync(canonical).dev, recorded: false };
    } catch {
      // An unavailable root cannot establish a mounted filesystem.
    }
  }
  return undefined;
}

/** A device number recorded for a path that still exists, as a plain directory
 * on the filesystem now numbered `current`, was reassigned by a later mount
 * (every boot on macOS): the same filesystem is still mounted, so a missing
 * path recorded with that number was deleted, not unmounted. Evidence comes
 * from every registration, since a deleted checkout has no surviving paths of
 * its own; a record can only prove this until refreshes replace the old
 * observations, which is why callers clean up before refreshing. */
function renumbered(
  record: LauncherRecord,
  recorded: number,
  current: number
): boolean {
  return Object.values(record.registrations ?? {}).some((registration) => {
    const observations: [string, number][] = Object.entries(
      registration.pathDevices ?? {}
    );
    if (registration.temporaryRoot)
      observations.push([
        registration.temporaryRoot.path,
        registration.temporaryRoot.device,
      ]);
    return observations.some(([file, device]) => {
      if (device !== recorded) return false;
      try {
        const stat = fs.lstatSync(file);
        return (
          stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === current
        );
      } catch {
        return false;
      }
    });
  });
}

/** Undefined means automatic cleanup is safe: the registered Git directory is
 * gone and the filesystem it lived on is still mounted there. Provenance,
 * leftover working files, and surviving linked worktree directories do not
 * matter; a returned Git directory re-registers itself on first use. A
 * relocated (`.git` file), symlinked, or unreadable path is not deletion. */
export function automaticForgetBlocker(
  record: LauncherRecord,
  common: string
): string | undefined {
  const missing = missingPathIdentity(common);
  if (!missing)
    return `Registered Git directory still exists or is not safely accessible: ${common}`;
  const registration = record.registrations?.[common];
  const mount = registration?.pathMounts?.[common];
  if (mount !== undefined) {
    if (mount === missing.mount) return undefined;
    return `Filesystem changed for ${common}: recorded on the mount ${mount}, now under ${missing.mount}; its volume may be unmounted. Registration kept.`;
  }
  const expected = expectedDevice(registration, common);
  if (expected === undefined)
    return `Filesystem identity is unknown for ${common}. Registration kept.`;
  if (
    expected.device === missing.device ||
    (expected.recorded && renumbered(record, expected.device, missing.device))
  )
    return undefined;
  return `Filesystem device changed for ${common}; its volume may be unmounted. Registration kept.`;
}

export function canForget(
  record: LauncherRecord,
  common: string,
  automatic: boolean
): boolean {
  if (
    !record.repositories.includes(common) &&
    !record.implementations?.[common]
  )
    return false;
  // Explicit forgetting bypasses only the filesystem-identity guard.
  return automatic
    ? automaticForgetBlocker(record, common) === undefined
    : definitelyMissing(common);
}

/** Caller holds launcher lock; never touch repository files or restore gt here. */
// eslint-disable-next-line max-params
export function forgetRegistration(
  plan: LauncherPlan,
  record: LauncherRecord,
  common: string,
  automatic: boolean
): ForgottenRepository {
  if (!canForget(record, common, automatic))
    fail(
      'Registered Git directory still exists or is not safely accessible, or automatic cleanup is unsafe. Use gt-cli disable for an existing repository.'
    );
  const updated = {
    ...record,
    repositories: record.repositories.filter((repo) => repo !== common),
    registrations: { ...record.registrations },
    implementations: { ...record.implementations },
  };
  delete updated.registrations[common];
  delete updated.implementations[common];
  if (record.pendingBindings) {
    const repositories = record.pendingBindings.repositories.filter(
      (repo) => repo !== common
    );
    if (repositories.length)
      updated.pendingBindings = { ...record.pendingBindings, repositories };
    else delete updated.pendingBindings;
  }
  if (!canForget(record, common, automatic))
    fail(
      'Git directory reappeared or its filesystem changed during registration cleanup. Registration was kept.'
    );
  atomicJSON(path.join(plan.directory, 'launcher.json'), updated);
  delete record.pendingBindings;
  Object.assign(record, updated);
  return { repository: common };
}
