import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import semver from 'semver';
import { fileLock } from '../github/file_lock';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Do not keep recommending a possibly withdrawn release while offline.
export const MAX_RESULT_AGE_MS = 24 * 60 * 60 * 1000;

export type UpdateCache = {
  schemaVersion: 1;
  lastAttemptAt?: number;
  attemptId?: string;
  lastCheckedAt?: number;
  latestVersion?: string;
  lastNotifiedAt?: number;
  lastNotifiedVersion?: string;
};

export function stableVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = semver.valid(value);
  return version && !semver.prerelease(version) ? version : undefined;
}

function timestamp(value: unknown, now: number): number | undefined {
  // Reset timestamps after a clock rollback instead of suppressing checks forever.
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= now
    ? value
    : undefined;
}

function assertFile(fd: number): void {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
    throw Error('Unsafe update notification file.');
}

function readCache(file: string): UpdateCache {
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1 };
    throw error;
  }
  try {
    assertFile(fd);
    if (fs.fstatSync(fd).size > 16 * 1024) return { schemaVersion: 1 };
    let value;
    try {
      value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      return { schemaVersion: 1 };
    }
    if (value?.schemaVersion !== 1) return { schemaVersion: 1 };
    const now = Date.now();
    const latestVersion = stableVersion(value.latestVersion);
    return {
      schemaVersion: 1,
      lastAttemptAt: timestamp(value.lastAttemptAt, now),
      attemptId:
        typeof value.attemptId === 'string' &&
        /^[a-f0-9]{32}$/.test(value.attemptId)
          ? value.attemptId
          : undefined,
      lastCheckedAt: latestVersion
        ? timestamp(value.lastCheckedAt, now)
        : undefined,
      latestVersion,
      lastNotifiedAt: timestamp(value.lastNotifiedAt, now),
      lastNotifiedVersion: stableVersion(value.lastNotifiedVersion),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function saveCache(file: string, cache: UpdateCache): void {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(cache), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A separate, permanent lock inode, never an installer or repository lock.
 * All read/modify/write operations merge under this nonblocking lock, including
 * notification receipts written while a background request is in flight.
 * Cache/permission/lock failures must never affect the user's command.
 */
export function withUpdateCache<T>(
  home: string,
  operation: (cache: UpdateCache, save: (cache: UpdateCache) => void) => T
): T | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(home);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      return undefined;
    fd = fs.openSync(
      path.join(home, 'update-notifier.lock'),
      fs.constants.O_CREAT |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600
    );
    assertFile(fd);
    fileLock(fd);
    const file = path.join(home, 'update-notifier.json');
    return operation(readCache(file), (cache) => saveCache(file, cache));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function checkDue(cache: UpdateCache, now: number): boolean {
  return (
    (cache.lastCheckedAt === undefined ||
      now - cache.lastCheckedAt >= CHECK_INTERVAL_MS) &&
    (cache.lastAttemptAt === undefined ||
      now - cache.lastAttemptAt >= RETRY_INTERVAL_MS)
  );
}

export function updateNotice(
  cache: UpdateCache,
  installedVersion: string,
  now: number
): string | undefined {
  const latest = stableVersion(cache.latestVersion);
  const installed = semver.valid(installedVersion);
  if (
    !latest ||
    !installed ||
    !semver.gt(latest, installed) ||
    cache.lastCheckedAt === undefined ||
    now < cache.lastCheckedAt ||
    now - cache.lastCheckedAt >= MAX_RESULT_AGE_MS ||
    (cache.lastNotifiedVersion === latest &&
      cache.lastNotifiedAt !== undefined &&
      now >= cache.lastNotifiedAt &&
      now - cache.lastNotifiedAt < REMINDER_INTERVAL_MS)
  )
    return undefined;
  return `gt-cli update available: ${installed} → ${latest}\nRun \`gt-cli update\` to install.\n`;
}
