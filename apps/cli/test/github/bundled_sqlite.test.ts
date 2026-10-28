import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  sqlite,
  sqliteBackup,
  assertBundledSqliteRuntime,
} from '../../src/lib/switch/sqlite';
import { backupDatabase } from '../../src/lib/switch/repository';

describe('SQLite bundled with Node.js', function () {
  this.timeout(15_000);
  let root: string, db: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bundled-sqlite-'));
    db = path.join(root, "database 'quoted'.db");
    sqlite(
      db,
      "CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('kept');",
      false
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads and backs up without any executable available on PATH', () => {
    const old = process.env.PATH;
    try {
      process.env.PATH = path.join(root, 'absent');
      expect(JSON.parse(sqlite(db, 'SELECT value FROM data;'))).to.deep.equal([
        { value: 'kept' },
      ]);
      const dest = path.join(root, "backup 'quoted'.db");
      backupDatabase(db, dest);
      expect(sqlite(dest, 'SELECT value FROM data;')).to.equal(
        sqlite(db, 'SELECT value FROM data;')
      );
    } finally {
      if (old === undefined) delete process.env.PATH;
      else process.env.PATH = old;
    }
  });

  it('read-only opens neither create missing databases nor permit writes', () => {
    const missing = path.join(root, 'missing.db');
    expect(() => sqlite(missing, 'SELECT 1;')).to.throw();
    expect(fs.existsSync(missing)).to.equal(false);
    expect(() => sqlite(db, 'DELETE FROM data RETURNING value;')).to.throw();
    expect(sqlite(db, 'SELECT value FROM data;')).to.contain('kept');
  });

  it('never overwrites an existing backup, including a symlink', () => {
    const dest = path.join(root, 'backup');
    fs.writeFileSync(dest, 'owned elsewhere');
    expect(() => sqliteBackup(db, dest)).to.throw();
    expect(fs.readFileSync(dest, 'utf8')).to.equal('owned elsewhere');
    const link = path.join(root, 'link');
    fs.symlinkSync(dest, link);
    expect(() => sqliteBackup(db, link)).to.throw();
    expect(fs.readFileSync(dest, 'utf8')).to.equal('owned elsewhere');
  });

  it('supports the documented runtimes and rejects old Node before cutover', () => {
    for (const version of ['22.16.0', '22.23.2', '24.0.0', '26.4.0'])
      expect(() => assertBundledSqliteRuntime(version)).not.to.throw();
    for (const version of [
      '18.20.0',
      '20.19.0',
      '22.12.0',
      '22.15.1',
      '23.0.0',
    ])
      expect(() => assertBundledSqliteRuntime(version)).to.throw(
        'Upgrade Node.js'
      );
  });

  it('reads a database created by the independent system SQLite implementation', () => {
    // Cross-implementation compatibility, not a runtime dependency.
    const external = path.join(root, 'external.db');
    execFileSync('sqlite3', [
      external,
      "CREATE TABLE example(value TEXT); INSERT INTO example VALUES('external');",
    ]);
    expect(JSON.parse(sqlite(external, 'SELECT * FROM example'))).to.deep.equal(
      [{ value: 'external' }]
    );
  });
});
