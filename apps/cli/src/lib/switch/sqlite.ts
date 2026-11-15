import path from 'path';
import { execFileSync } from 'child_process';
import { ExitFailedError } from '../errors';

export function assertBundledSqliteRuntime(
  version = process.versions.node
): void {
  const [major, minor] = version.split('.').map(Number);
  if (!((major === 22 && minor >= 16) || major >= 24)) {
    throw new ExitFailedError(
      `Cutover requires Node.js 22.16+ (22.x) or 24+ for bundled SQLite; found ${version}. Upgrade Node.js and retry. No system sqlite3 installation is needed.`
    );
  }
}

/** Keep SQLite work in a killable subprocess, including native busy/backup waits. */
function run(request: {
  db: string;
  readonly: boolean;
  sql?: string;
  queries?: string[];
  destination?: string;
}): string {
  assertBundledSqliteRuntime();
  return execFileSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      path.resolve(__dirname, '../../../scripts/sqlite.cjs'),
    ],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ).trim();
}

/** Read one result set, or execute a write script on a single connection. */
export function sqlite(db: string, sql: string, readonly = true): string {
  return run({ db, sql, readonly });
}

/** Read related result sets in one snapshot, retaining subprocess time bounds. */
export function sqliteReadBatch(db: string, queries: string[]): unknown[][] {
  return JSON.parse(run({ db, queries, readonly: true }));
}

export function sqliteBackup(db: string, destination: string): void {
  run({ db, destination, readonly: true });
}
