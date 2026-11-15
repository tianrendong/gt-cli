import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { isDeepStrictEqual } from 'util';
import { ExitFailedError } from '../errors';
import { getGitPaths, GitPaths } from '../git/git_dir';
import { sqlite, sqliteBackup, sqliteReadBatch } from './sqlite';
export { sqlite } from './sqlite';

export const NATIVE_COLUMNS = [
  'branch_name',
  'parent_branch_name',
  'parent_branch_revision',
  'last_submitted_version',
  'state',
  'children',
  'branch_revision',
  'validation_result',
  'parent_head_revision',
] as const;
export type NativeRow = {
  [K in (typeof NATIVE_COLUMNS)[number]]: string | null;
} & { branch_name: string };
export type RefMap = Record<string, string>;
export const MANAGED_FILES = [
  '.graphite_repo_config',
  '.graphite_pr_info',
  'gt-frozen',
] as const;
export type ManagedFile = (typeof MANAGED_FILES)[number];
export type FileMap = Record<ManagedFile, string | null>;
export type RepoSnapshot = { refs: RefMap; files: FileMap; worktrees: string };

/** Running commands and paused operations can update once they finish. */
export class RepositoryBusyError extends ExitFailedError {}
/** Registered Git directory is absent. Cleanup still checks filesystem identity
 * before dropping its registration. */
export class RepositoryMissingError extends ExitFailedError {}

export function fail(message: string): never {
  throw new ExitFailedError(message);
}
export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function equal(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
export function nativeRows(db: string): NativeRow[] {
  return JSON.parse(
    sqlite(
      db,
      `SELECT ${NATIVE_COLUMNS.join(
        ','
      )} FROM branch_metadata ORDER BY branch_name;`
    ) || '[]'
  );
}
export function backupDatabase(db: string, destination: string): void {
  if (fs.existsSync(destination)) fail(`Backup already exists: ${destination}`);
  // SQLite's online backup includes committed WAL contents, unlike copying .db.
  sqliteBackup(db, destination);
  // A WAL source can leave the backup header in WAL mode without sidecars.
  // Normalize only the private backup so it is self-contained and read-only-openable.
  if (fs.existsSync(destination))
    sqlite(destination, 'PRAGMA journal_mode=DELETE;', false);
  if (
    !fs.existsSync(destination) ||
    sqlite(destination, 'PRAGMA integrity_check;') !==
      '[{"integrity_check":"ok"}]'
  ) {
    fail('SQLite backup verification failed. Repository was not migrated.');
  }
}
export function validateNativeSchema(db: string): void {
  const columns: Array<{ name: string; type: string }> = JSON.parse(
    sqlite(db, 'PRAGMA table_info(branch_metadata);')
  );
  if (
    !equal(
      columns.map((c) => c.name),
      [...NATIVE_COLUMNS]
    ) ||
    columns.some((c) => c.type.toLowerCase() !== 'text')
  ) {
    fail(
      'Unsupported Graphite SQLite schema. No automatic switch is safe for this version.'
    );
  }
  for (const row of nativeRows(db)) {
    if (row.state !== null && row.state !== 'frozen')
      fail(`Unsupported Graphite branch state for ${row.branch_name}.`);
  }
}
export function nativeDigest(db: string, rows?: NativeRow[]): string {
  const schemaQuery =
    "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name;";
  if (rows !== undefined) {
    return digest(
      JSON.stringify({ schema: JSON.parse(sqlite(db, schemaQuery)), rows })
    );
  }
  const [snapshotRows, schema] = sqliteReadBatch(db, [
    `SELECT ${NATIVE_COLUMNS.join(
      ','
    )} FROM branch_metadata ORDER BY branch_name;`,
    schemaQuery,
  ]);
  // Keep the persisted digest representation byte-for-byte compatible.
  return digest(JSON.stringify({ schema, rows: snapshotRows }));
}
export function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file).toString('base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function encodedJSON(value: unknown): string {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64');
}
export function decodedJSON<T>(value: string | null, fallback: T): T {
  return value === null
    ? fallback
    : (JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T);
}

export class Repository {
  readonly cwd: string;
  readonly common: string;
  readonly worktree: string;
  readonly db: string;
  readonly control: string;
  constructor(cwd: string, paths: GitPaths | undefined = getGitPaths(cwd)) {
    this.cwd = path.resolve(cwd);
    this.common = path.resolve(
      this.cwd,
      paths?.commonDir ?? this.git(['rev-parse', '--git-common-dir'])
    );
    this.worktree = path.resolve(
      this.cwd,
      paths?.gitDir ?? this.git(['rev-parse', '--absolute-git-dir'])
    );
    this.db = path.join(this.common, '.graphite_metadata.db');
    this.control = path.join(this.common, 'gt-gh-switch');
    if (
      fs.existsSync(this.control) &&
      fs.lstatSync(this.control).isSymbolicLink()
    )
      fail('Refusing a symlinked gt-gh switch directory.');
  }
  git(args: string[], input?: string): string {
    return execFileSync(
      'git',
      ['--no-optional-locks', '-C', this.cwd, ...args],
      {
        input,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).replace(/\n$/, '');
  }
  refs(): RefMap {
    return Object.fromEntries(
      this.git([
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads/',
        'refs/branch-metadata/',
      ])
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
    );
  }
  files(): FileMap {
    return Object.fromEntries(
      MANAGED_FILES.map((name) => [
        name,
        readFile(path.join(this.common, name)),
      ])
    ) as FileMap;
  }
  snapshot(): RepoSnapshot {
    return {
      refs: this.refs(),
      files: this.files(),
      worktrees: this.git(['worktree', 'list', '--porcelain']),
    };
  }
  worktreeDirectories(): string[] {
    // A checkout may be deleted, moved, or offline while its administrative
    // directory survives. Inspect that metadata directly: never require git -C
    // in the checkout, skip its paused operations, or prune its registration.
    const directories = new Set([this.common, this.worktree]);
    const registered = path.join(this.common, 'worktrees');
    const stat = fs.lstatSync(registered, { throwIfNoEntry: false });
    if (!stat) return [...directories];
    if (stat.isSymbolicLink())
      fail(`Refusing symlinked worktree metadata: ${registered}.`);
    if (!stat.isDirectory())
      fail(`Worktree metadata is not a directory: ${registered}.`);
    // Do not use existsSync or ignore read errors: inaccessible registrations
    // must not make a repository appear idle.
    for (const entry of fs.readdirSync(registered, { withFileTypes: true })) {
      const directory = path.join(registered, entry.name);
      if (entry.isSymbolicLink())
        fail(`Refusing symlinked worktree metadata: ${directory}.`);
      if (entry.isDirectory()) directories.add(directory);
    }
    return [...directories];
  }
  /** Structural safety still applies to routing-only re-enables. */
  assertSwitchContext(): void {
    for (const name of ['.graphite_metadata.db', ...MANAGED_FILES]) {
      const file = path.join(this.common, name);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
        fail(`Refusing symlinked backend metadata: ${name}.`);
    }
    if (this.git(['rev-parse', '--is-bare-repository']) === 'true')
      fail(
        'Backend switching requires a working repository, not a bare repository.'
      );
    for (const variable of [
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]) {
      if (process.env[variable])
        fail(`Unset ${variable} before switching backends.`);
    }
  }
  assertIdle(): void {
    this.assertSwitchContext();
    for (const dir of this.worktreeDirectories()) {
      for (const name of [
        'rebase-merge',
        'rebase-apply',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        '.gtcontinue',
        'gh-stack-rebase-state',
        'gh-stack-modify-state',
      ]) {
        if (fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }))
          throw new RepositoryBusyError(
            `Finish or abort the operation in ${dir} before migrating metadata or updating the runtime (${name}).`
          );
      }
      const latest = decodedJSON<string | null>(
        readFile(path.join(dir, 'gt-operations/latest')),
        null
      );
      if (latest) {
        if (!/^[0-9]+-[a-f0-9]+$/.test(latest))
          fail('Invalid operation journal pointer.');
        const operation = decodedJSON<{
          version?: number;
          pending?: boolean;
          restoringRefs?: unknown;
          abortingRebase?: boolean;
        } | null>(
          readFile(path.join(dir, 'gt-operations', `${latest}.json`)),
          null
        );
        if (
          operation?.pending ||
          operation?.restoringRefs ||
          operation?.abortingRebase
        )
          throw new RepositoryBusyError(
            `Finish or abort the pending gt operation in ${dir} before migrating metadata or updating the runtime.`
          );
        // A missing or unknown journal is not proof that recovery finished.
        // Routing-only re-enable may keep the old runtime, but neither migration
        // nor a deferred updater may replace it based on an unreadable status.
        if (operation?.version !== 1 || typeof operation.pending !== 'boolean')
          fail(
            `Cannot verify the operation journal in ${dir}. It is missing or unsupported. Repair recovery state with its original runtime before migrating metadata or updating the runtime.`
          );
      }
    }
  }
  assertRefs(expected: RefMap): void {
    if (!equal(this.refs(), expected))
      fail(
        'Git refs changed during the switch. No commits will be reset. Stop other writers and retry.'
      );
  }
  applyRefs(before: RefMap, after: RefMap): void {
    this.assertRefs(before);
    const lines = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .map((ref) => {
        if (!/^refs\/(heads|branch-metadata)\//.test(ref))
          return fail('Unsafe ref in switch manifest.');
        this.git(['check-ref-format', ref]);
        for (const sha of [before[ref], after[ref]]) {
          if (
            sha !== undefined &&
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)
          )
            fail('Unsafe object ID in switch manifest.');
        }
        if (
          ref.startsWith('refs/heads/') &&
          before[ref] &&
          after[ref] &&
          before[ref] !== after[ref]
        )
          fail('Backend switches never rewrite existing branch tips.');
        if (before[ref] === after[ref]) return `verify ${ref} ${before[ref]}`;
        if (!before[ref]) return `create ${ref} ${after[ref]}`;
        if (!after[ref]) return `delete ${ref} ${before[ref]}`;
        return `update ${ref} ${after[ref]} ${before[ref]}`;
      });
    this.git(
      ['update-ref', '--stdin'],
      ['start', ...lines, 'prepare', 'commit', ''].join('\n')
    );
  }
  applyFile(
    name: ManagedFile,
    before: string | null,
    after: string | null
  ): void {
    const file = path.join(this.common, name);
    const current = readFile(file);
    if (current === after) return;
    if (current !== before)
      fail(`${name} changed during the switch. File was not overwritten.`);
    if (after === null) {
      fs.unlinkSync(file);
      return;
    }
    const tmp = `${file}.gt-switch-${process.pid}`;
    try {
      fs.writeFileSync(tmp, Buffer.from(after, 'base64'), {
        flag: 'wx',
        mode: 0o600,
      });
      if (readFile(file) !== before)
        fail(`${name} changed during the switch. File was not overwritten.`);
      fs.renameSync(tmp, file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}
