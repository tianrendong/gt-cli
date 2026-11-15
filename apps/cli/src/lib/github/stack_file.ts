import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { setTimeout as sleep } from 'timers/promises';
import { fileLock, FileLockBusyError } from './file_lock';
import { ExitFailedError } from '../errors';
import { getGitCommonDir, getGitDir } from '../git/git_dir';

// Keep this wire format compatible with github/gh-stack/internal/stack/stack.go.
export type BranchRef = {
  branch: string;
  head?: string;
  base?: string;
  pullRequest?: { number: number; id?: string; url?: string; merged?: boolean };
};
export type LocalStack = {
  id?: string;
  number?: number;
  trunk: BranchRef;
  branches: BranchRef[];
};
export type StackFile = {
  schemaVersion: 1;
  repository: string;
  stacks: LocalStack[];
};
export type RemoteComposition = { base: string; prs: number[] };
export type RemoteRecord = RemoteComposition & {
  /** Migration found different records for this stack in different worktrees.
   * GitHub matching any of them proves it is unchanged since a gt sync; the
   * next write keeps only what gt observed. */
  alternatives?: RemoteComposition[];
  /** Diagnostics only: the worktree that last wrote the record, and when. */
  writtenBy?: string;
  at?: string;
};
export type PendingCleanup = RemoteComposition & {
  keep: number[];
  writtenBy?: string;
  at?: string;
};
export type MirrorState = {
  version: 1;
  // Last topology exported by gt in this worktree. Used for three-way
  // reconciliation with this worktree's gh-stack file.
  stacks: LocalStack[];
  // Last successfully synchronized remote composition, keyed by stack number.
  // Repository-wide: loaded from and saved to SHARED_STATE_DIRECTORY.
  remote: Record<string, RemoteRecord>;
  // Deletion intent survives local-only commands and failed remote cleanup.
  removedPullRequests?: number[];
  // Write ahead of unstack: retries must restore even remote-only survivors.
  // Repository-wide, like remote.
  pendingStackCleanups?: Record<string, PendingCleanup>;
};

/** Every variant of a record that proves GitHub is unchanged since gt synced it. */
export function recordVariants(
  record: RemoteRecord | undefined
): RemoteComposition[] {
  return record
    ? [{ base: record.base, prs: record.prs }, ...(record.alternatives ?? [])]
    : [];
}

/** GitHub's composition equals one gt recorded. */
export function recordMatches(
  record: RemoteRecord | undefined,
  base: string | undefined,
  prs: number[]
): boolean {
  return recordVariants(record).some(
    (variant) =>
      (base === undefined || variant.base === base) &&
      JSON.stringify(variant.prs) === JSON.stringify(prs)
  );
}

/** What gt last synchronized with GitHub is a fact about the repository, not a
 * worktree: branch metadata is shared, and so is GitHub. One file per stack, in
 * the common Git directory, written by atomic rename without a lock: agents on
 * different stacks write different files and never wait for each other. Two
 * writers of the same stack race; the last rename wins. A record left behind
 * GitHub only makes the next submit refuse, which is safe.
 *
 * (Not `gt-github-sync/`: in the main worktree the common directory is the
 * worktree's own Git directory, which already holds a `gt-github-sync` file.)
 */
export const SHARED_STATE_DIRECTORY = 'gt-github-stacks';
const MIGRATED_MARKER = 'migrated';
const RECORD_FILE = /^(\d+)\.json$/;

type SharedState = Pick<MirrorState, 'remote' | 'pendingStackCleanups'>;

const DIAGNOSTICS = ['writtenBy', 'at'];

function omit(value: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key))
  );
}

function canonical(value: unknown): string {
  return value ? JSON.stringify(omit(value as object, DIAGNOSTICS)) : '';
}

function readRecordDirectory<T>(
  directory: string,
  valid: (value: T) => boolean
): Record<string, T> {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const records: Record<string, T> = {};
  for (const name of names.sort()) {
    const number = RECORD_FILE.exec(name)?.[1];
    if (!number) continue; // temporary files and claims
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(directory, name), 'utf8')
      ) as T;
      // Rename makes every write whole. Anything else is treated as no
      // record, so that one stack refuses instead of every command failing.
      if (valid(value)) records[String(Number(number))] = value;
    } catch {
      continue;
    }
  }
  return records;
}

const isComposition = (value: RemoteComposition): boolean =>
  !!value &&
  typeof value.base === 'string' &&
  Array.isArray(value.prs) &&
  value.prs.every(Number.isInteger);
const isRecord = (value: RemoteRecord): boolean =>
  isComposition(value) &&
  (value.alternatives === undefined ||
    (Array.isArray(value.alternatives) &&
      value.alternatives.every(isComposition)));
const isCleanup = (value: PendingCleanup): boolean =>
  isComposition(value) &&
  Array.isArray(value.keep) &&
  value.keep.every(Number.isInteger);

/** Worktree Git directories that may hold a pre-0.6.41 per-worktree record. */
function legacyStateFiles(commonDirectory: string, own: string): string[] {
  const linked = path.join(commonDirectory, 'worktrees');
  let names: string[] = [];
  try {
    names = fs.readdirSync(linked).sort();
  } catch {
    names = [];
  }
  return [
    ...new Set(
      [
        path.join(commonDirectory, 'gt-github-sync'),
        ...names.map((name) => path.join(linked, name, 'gt-github-sync')),
        own,
      ].map((file) => path.resolve(file))
    ),
  ];
}

/** Merge per-worktree records into one repository view. Where worktrees agree,
 * keep the record. Where they disagree, keep every variant: whichever GitHub
 * still matches was the last composition gt synchronized, and the next write
 * keeps only that one. A worktree without a record adds nothing. */
export function mergeLegacyStates(states: Partial<MirrorState>[]): SharedState {
  const remote: Record<string, RemoteRecord> = {};
  const cleanups: Record<string, PendingCleanup> = {};
  for (const state of states) {
    for (const [number, record] of Object.entries(state.remote ?? {})) {
      if (!/^\d+$/.test(number) || !isRecord(record)) continue;
      const existing = remote[number];
      const variants = existing ? recordVariants(existing) : [];
      for (const variant of recordVariants(record)) {
        if (!variants.some((v) => canonical(v) === canonical(variant)))
          variants.push({ base: variant.base, prs: [...variant.prs] });
      }
      const [primary, ...alternatives] = variants;
      remote[number] = {
        ...primary,
        ...(alternatives.length ? { alternatives } : {}),
      };
    }
    for (const [number, cleanup] of Object.entries(
      state.pendingStackCleanups ?? {}
    )) {
      if (!/^\d+$/.test(number) || !isCleanup(cleanup)) continue;
      const existing = cleanups[number];
      // Journals are write-ahead: survivors listed in either may already be
      // unstacked. Keep the one that restores more of them.
      if (
        !existing ||
        (cleanup.keep.length > existing.keep.length &&
          existing.keep.every((pr) => cleanup.keep.includes(pr)))
      )
        cleanups[number] = {
          base: cleanup.base,
          prs: [...cleanup.prs],
          keep: [...cleanup.keep],
        };
      else if (
        !existing.keep.every((pr) => cleanup.keep.includes(pr)) &&
        !cleanup.keep.every((pr) => existing.keep.includes(pr))
      )
        // Neither contains the other: restore the union, in first-seen order.
        existing.keep = [...new Set([...existing.keep, ...cleanup.keep])];
    }
  }
  return { remote, pendingStackCleanups: cleanups };
}

/** Write a file only if it does not exist yet (atomic, no clobber). */
function createJSON(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** A human-readable worktree path for diagnostics, without running Git. */
function worktreeLabel(directory: string, commonDirectory: string): string {
  const resolved = path.resolve(directory);
  if (resolved === path.resolve(commonDirectory))
    return path.basename(resolved) === '.git'
      ? path.dirname(resolved)
      : resolved;
  try {
    const gitFile = fs.readFileSync(path.join(resolved, 'gitdir'), 'utf8');
    return path.dirname(gitFile.trim());
  } catch {
    return resolved;
  }
}

export function gitDirectory(): string {
  const directory = getGitCommonDir();
  if (!directory) {
    throw new ExitFailedError('No .git repository found.');
  }
  return path.resolve(directory);
}

export function worktreeGitDirectory(): string {
  const directory = getGitDir();
  if (!directory) {
    throw new ExitFailedError('No .git repository found.');
  }
  return path.resolve(directory);
}

export function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new ExitFailedError(
      `Malformed or unreadable metadata at ${file}. File left untouched.`
    );
  }
}

export function atomicJSON(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function validateStackFile(file: StackFile): StackFile {
  if (
    file.schemaVersion !== 1 ||
    typeof file.repository !== 'string' ||
    !Array.isArray(file.stacks)
  ) {
    throw new ExitFailedError(
      'Unsupported .git/gh-stack schema. Upgrade gt; existing metadata was not changed.'
    );
  }
  for (const stack of file.stacks) {
    if (
      !stack.trunk?.branch ||
      !Array.isArray(stack.branches) ||
      stack.branches.some((b) => !b.branch || typeof b.branch !== 'string') ||
      new Set(stack.branches.map((b) => b.branch)).size !==
        stack.branches.length ||
      stack.branches.some((b) => b.branch === stack.trunk.branch)
    ) {
      throw new ExitFailedError(
        'Invalid branch chain in .git/gh-stack. File left untouched.'
      );
    }
  }
  return file;
}

export type StackStoreOptions = {
  /** false: lock-free snapshot, never writable. Default true. */
  lock?: boolean;
  /** Also take the repository-wide gt.lock shared by every worktree. Only
   * backend switches, updates, and native dispatch need it; stack commands
   * must never wait on another worktree. */
  repositoryLock?: boolean;
};

/** Uses the same flock and permanent lock inode as gh-stack, not a competing mkdir lock. */
export class StackStore {
  private readonly locks: number[] = [];
  readonly filePath: string;
  /** Per-worktree: last export, plus a copy of the shared records that older
   * gt versions (which read only this file) can still use after a downgrade. */
  readonly statePath: string;
  /** Repository-wide records: SHARED_STATE_DIRECTORY in the common Git dir. */
  readonly sharedPath: string;
  private readonly writer: string;
  private loadedShared: {
    remote: Record<string, string>;
    cleanups: Record<string, string>;
  } = {
    remote: {},
    cleanups: {},
  };
  private readonly claims = new Set<number>();
  /** Lock-free snapshot: readable, never writable. */
  readonly readOnly: boolean;
  file: StackFile;
  state: MirrorState;
  private original: string | undefined;
  private closed = false;

  /** Non-blocking: undefined while another gt or gh-stack command holds a lock.
   * Read-only commands use this so they never queue behind a fetch, restack,
   * or prompt in any worktree.
   */
  static tryOpen(
    directory = worktreeGitDirectory(),
    commonDirectory = gitDirectory(),
    options: StackStoreOptions = {}
  ): StackStore | undefined {
    try {
      return new StackStore(directory, commonDirectory, options);
    } catch (error) {
      if (error instanceof FileLockBusyError) return undefined;
      throw error;
    }
  }

  /** Current metadata without any lock, for inspection while another command
   * runs. Files are written atomically, so each read is a consistent version;
   * save() is refused.
   */
  static snapshot(
    directory = worktreeGitDirectory(),
    commonDirectory = gitDirectory()
  ): StackStore {
    return new StackStore(directory, commonDirectory, { lock: false });
  }

  /** Queue concurrent CLI commands before loading any refs, cache, or mirror.
   * Fetches, restacks, and interactive prompts can hold the shared lock for
   * minutes, including in another worktree. Wait for release by default; only
   * callers that explicitly request a deadline should time out.
   */
  // eslint-disable-next-line max-params
  static async open(
    directory = worktreeGitDirectory(),
    commonDirectory = gitDirectory(),
    timeoutMs = Infinity,
    options: StackStoreOptions = {}
  ): Promise<StackStore> {
    const started = performance.now();
    let reportedWait = false;
    for (;;) {
      try {
        return new StackStore(directory, commonDirectory, options);
      } catch (error) {
        if (!(error instanceof FileLockBusyError)) throw error;
        const elapsed = performance.now() - started;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) {
          throw new ExitFailedError(
            `Timed out after ${timeoutMs} ms waiting for the repository stack lock. Another gt or gh-stack process may be running; retry when it finishes.`
          );
        }
        if (!reportedWait && elapsed >= 1_000) {
          // Keep stdout clean for commands such as `gt github status --json`.
          process.stderr.write(
            options.repositoryLock
              ? 'Waiting for the repository stack lock held by another gt or gh-stack command (possibly in another worktree). Will continue automatically; press Ctrl-C to cancel.\n'
              : 'Waiting for the stack lock held by another gt or gh-stack command in this worktree. Will continue automatically; press Ctrl-C to cancel.\n'
          );
          reportedWait = true;
        }
        // Async sleep keeps SIGINT responsive; never unlink another holder's lock.
        await sleep(Math.min(25, remaining));
      }
    }
  }

  constructor(
    readonly directory = worktreeGitDirectory(),
    commonDirectory = gitDirectory(),
    options: StackStoreOptions = {}
  ) {
    this.filePath = path.join(directory, 'gh-stack');
    this.statePath = path.join(directory, 'gt-github-sync');
    this.sharedPath = path.join(commonDirectory, SHARED_STATE_DIRECTORY);
    this.writer = worktreeLabel(directory, commonDirectory);
    this.readOnly = options.lock === false;
    try {
      if (options.lock !== false) {
        // Like native Graphite, stack commands in different worktrees run
        // concurrently: only this worktree's gh-stack mirror is locked (the
        // same flock gh-stack takes). Shared refs use compare-and-swap
        // updates and the cache proves itself against the refs it describes.
        // The repository-wide lock remains for backend switches and updates.
        for (const file of [
          ...(options.repositoryLock
            ? [path.join(commonDirectory, 'gt.lock')]
            : []),
          path.join(directory, 'gh-stack.lock'),
        ]) {
          const fd = fs.openSync(file, 'a+');
          this.locks.push(fd);
          fileLock(fd);
        }
        const modifying = readJSON<{ phase?: string } | undefined>(
          path.join(directory, 'gh-stack-modify-state'),
          undefined
        );
        if (
          fs.existsSync(path.join(directory, 'gh-stack-rebase-state')) ||
          (modifying && modifying.phase !== 'pending_submit')
        ) {
          throw new ExitFailedError(
            'A gh stack operation is in progress. Finish it with gh stack rebase/modify --continue or --abort before running gt.'
          );
        }
      }
      this.original = fs.existsSync(this.filePath)
        ? fs.readFileSync(this.filePath, 'utf8')
        : undefined;
      this.file = validateStackFile(
        readJSON(this.filePath, {
          schemaVersion: 1,
          repository: '',
          stacks: [],
        })
      );
      this.state = readJSON(this.statePath, {
        version: 1,
        stacks: [],
        remote: {},
      });
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.stacks) ||
        !this.state.remote
      ) {
        throw new ExitFailedError(
          `Unsupported mirror metadata at ${this.statePath}.`
        );
      }
      this.loadShared(commonDirectory);
    } catch (error) {
      this.locks.forEach((fd) => fs.closeSync(fd));
      throw error;
    }
  }

  private get remoteDirectory(): string {
    return path.join(this.sharedPath, 'remote');
  }
  private get cleanupDirectory(): string {
    return path.join(this.sharedPath, 'cleanup');
  }

  /** Replace this worktree's copies with the repository's records. The first
   * load after upgrading merges every worktree's legacy records; the marker is
   * written last, so an interrupted migration simply runs again. */
  private loadShared(commonDirectory: string): void {
    let shared: SharedState;
    if (fs.existsSync(path.join(this.sharedPath, MIGRATED_MARKER))) {
      shared = {
        remote: readRecordDirectory(this.remoteDirectory, isRecord),
        pendingStackCleanups: readRecordDirectory(
          this.cleanupDirectory,
          isCleanup
        ),
      };
    } else {
      shared = mergeLegacyStates(
        legacyStateFiles(commonDirectory, this.statePath).flatMap((file) => {
          try {
            return [readJSON<Partial<MirrorState>>(file, {})];
          } catch {
            return []; // An unreadable legacy file must not block migration.
          }
        })
      );
      if (!this.readOnly) this.migrate(shared);
    }
    this.state.remote = shared.remote;
    this.state.pendingStackCleanups = shared.pendingStackCleanups;
    this.markShared();
  }

  private migrate(shared: SharedState): void {
    // Nothing to carry over (a fresh clone, or GitHub stacks never used): write
    // nothing. The first saved record writes the marker.
    if (
      !Object.keys(shared.remote).length &&
      !Object.keys(shared.pendingStackCleanups ?? {}).length
    )
      return;
    fs.mkdirSync(this.remoteDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.cleanupDirectory, { recursive: true, mode: 0o700 });
    const at = new Date().toISOString();
    // Never clobber: a concurrent, already-migrated process may have written a
    // newer record meanwhile.
    for (const [number, record] of Object.entries(shared.remote))
      createJSON(path.join(this.remoteDirectory, `${number}.json`), {
        ...record,
        writtenBy: `migration from ${this.writer}`,
        at,
      });
    for (const [number, cleanup] of Object.entries(
      shared.pendingStackCleanups ?? {}
    ))
      createJSON(path.join(this.cleanupDirectory, `${number}.json`), {
        ...cleanup,
        writtenBy: `migration from ${this.writer}`,
        at,
      });
    this.writeMarker(at);
    // Re-read: the files are now the source of truth, including any written
    // by another process while this one migrated.
    shared.remote = readRecordDirectory(this.remoteDirectory, isRecord);
    shared.pendingStackCleanups = readRecordDirectory(
      this.cleanupDirectory,
      isCleanup
    );
  }

  private writeMarker(at = new Date().toISOString()): void {
    const marker = path.join(this.sharedPath, MIGRATED_MARKER);
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(this.sharedPath, { recursive: true, mode: 0o700 });
    createJSON(marker, { version: 1, at });
  }

  private markShared(): void {
    const snapshot = (records: Record<string, unknown> = {}) =>
      Object.fromEntries(
        Object.entries(records).map(([key, value]) => [key, canonical(value)])
      );
    this.loadedShared = {
      remote: snapshot(this.state.remote),
      cleanups: snapshot(this.state.pendingStackCleanups),
    };
  }

  /** Write only the stacks this process changed, so concurrent writers of
   * other stacks are never overwritten. */
  private saveShared(): void {
    const at = new Date().toISOString();
    const sync = (
      directory: string,
      loaded: Record<string, string>,
      current: Record<string, RemoteRecord | PendingCleanup>
    ) => {
      for (const key of new Set([
        ...Object.keys(loaded),
        ...Object.keys(current),
      ])) {
        if (!/^\d+$/.test(key))
          throw new ExitFailedError(`Invalid GitHub stack number ${key}.`);
        const file = path.join(directory, `${Number(key)}.json`);
        const value = current[key];
        if (!value) {
          if (loaded[key] !== undefined) unlinkIfPresent(file);
          continue;
        }
        if (loaded[key] === canonical(value)) continue;
        // Before any record: otherwise the next load would ignore the
        // directory and migrate legacy records again.
        this.writeMarker(at);
        value.writtenBy = this.writer;
        value.at = at;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicJSON(file, value);
      }
    };
    sync(this.remoteDirectory, this.loadedShared.remote, this.state.remote);
    sync(
      this.cleanupDirectory,
      this.loadedShared.cleanups,
      this.state.pendingStackCleanups ?? {}
    );
    this.markShared();
  }

  /** The cleanup journal for one stack as it is on disk now, bypassing this
   * process's snapshot: another worktree may have finished or started it. */
  pendingCleanupOnDisk(number: number): PendingCleanup | undefined {
    return readRecordDirectory(this.cleanupDirectory, isCleanup)[
      String(number)
    ];
  }

  /** Non-blocking, per-stack claim for replaying a cleanup journal (unstack,
   * then rebuild survivors). Two worktrees replaying the same journal would
   * both unstack and race to rebuild. Undefined while another process holds
   * it; nothing waits. Released by the returned function or close(). */
  claimStackCleanup(number: number): (() => void) | undefined {
    if (this.readOnly || this.closed)
      throw new ExitFailedError(
        'The repository stack lock is not held. Refusing to replay stack cleanup.'
      );
    if (this.claims.has(number)) return () => undefined;
    fs.mkdirSync(this.cleanupDirectory, { recursive: true, mode: 0o700 });
    // Permanent lock inode, like gh-stack.lock: never unlink a lock file.
    const fd = fs.openSync(
      path.join(this.cleanupDirectory, `${number}.lock`),
      'a+'
    );
    try {
      fileLock(fd);
    } catch (error) {
      fs.closeSync(fd);
      if (error instanceof FileLockBusyError) return undefined;
      throw error;
    }
    this.claims.add(number);
    this.locks.push(fd);
    return () => {
      if (!this.claims.delete(number)) return;
      const index = this.locks.indexOf(fd);
      if (index >= 0) this.locks.splice(index, 1);
      fileLock(fd, true);
      fs.closeSync(fd);
    };
  }

  save(): void {
    if (this.readOnly || this.closed) {
      throw new ExitFailedError(
        'The repository stack lock is not held. Refusing to write .git/gh-stack.'
      );
    }
    const current = fs.existsSync(this.filePath)
      ? fs.readFileSync(this.filePath, 'utf8')
      : undefined;
    if (current !== this.original) {
      throw new ExitFailedError(
        '.git/gh-stack changed concurrently. Refusing to overwrite it; retry the command.'
      );
    }
    const output = JSON.stringify(this.file, null, 2) + '\n';
    if (output !== current) atomicJSON(this.filePath, this.file);
    this.original = output;
    this.saveShared();
    // Dual-write for downgrades: gt before 0.6.41-beta.2 reads only this file,
    // in exactly its old format.
    const strip = (records: Record<string, object> = {}) =>
      Object.fromEntries(
        Object.entries(records).map(([key, value]) => [
          key,
          omit(value, ['alternatives', ...DIAGNOSTICS]),
        ])
      );
    atomicJSON(this.statePath, {
      ...this.state,
      remote: strip(this.state.remote),
      ...(this.state.pendingStackCleanups
        ? { pendingStackCleanups: strip(this.state.pendingStackCleanups) }
        : {}),
    });
  }

  reload(): void {
    this.original = fs.existsSync(this.filePath)
      ? fs.readFileSync(this.filePath, 'utf8')
      : undefined;
    this.file = validateStackFile(
      readJSON(this.filePath, { schemaVersion: 1, repository: '', stacks: [] })
    );
    this.state = readJSON(this.statePath, {
      version: 1,
      stacks: [],
      remote: {},
    });
    this.loadShared(path.dirname(this.sharedPath));
  }

  close(): void {
    if (!this.closed) {
      this.claims.clear();
      this.locks.reverse().forEach((fd) => {
        fileLock(fd, true);
        fs.closeSync(fd);
      });
      this.closed = true;
    }
  }
}
