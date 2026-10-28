import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  digest,
  nativeDigest,
  nativeRows,
  NATIVE_COLUMNS,
  sqlite,
} from '../../src/lib/switch/repository';
import { sqliteReadBatch } from '../../src/lib/switch/sqlite';

const schemaQuery =
  "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name;";

describe('batched native metadata digest', function () {
  this.timeout(15_000);
  let root: string, db: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-digest-'));
    db = path.join(root, 'metadata.db');
    sqlite(
      db,
      `CREATE TABLE branch_metadata (${NATIVE_COLUMNS.map(
        (c) => `${c} TEXT`
      ).join(',')});`,
      false
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyDigest = () => {
    const rows = nativeRows(db);
    return digest(
      JSON.stringify({ schema: JSON.parse(sqlite(db, schemaQuery)), rows })
    );
  };

  it('matches the persisted digest byte for byte, including empty rows, nulls and Unicode', () => {
    expect(nativeDigest(db)).to.equal(legacyDigest());
    sqlite(
      db,
      "INSERT INTO branch_metadata (branch_name,children) VALUES ('z', '[]'), ('é/branch', '[\"child\"]');",
      false
    );
    expect(nativeDigest(db)).to.equal(legacyDigest());
    expect(nativeDigest(db, [])).to.equal(
      digest(
        JSON.stringify({
          schema: JSON.parse(sqlite(db, schemaQuery)),
          rows: [],
        })
      )
    );
    expect(nativeDigest(db, nativeRows(db))).to.equal(legacyDigest());
  });

  it('does not cache rows or schema across checks', () => {
    const before = nativeDigest(db);
    sqlite(
      db,
      "INSERT INTO branch_metadata (branch_name) VALUES ('new');",
      false
    );
    const after = nativeDigest(db);
    expect(after).not.to.equal(before);
    expect(after).to.equal(legacyDigest());
    sqlite(db, 'CREATE TABLE extra (value TEXT);', false);
    expect(nativeDigest(db)).not.to.equal(after);
    expect(nativeDigest(db)).to.equal(legacyDigest());
  });

  it('includes committed WAL data without checkpointing it', () => {
    // Keep a connection alive so the last-writer close cannot checkpoint WAL.
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      db.exec("INSERT INTO branch_metadata (branch_name) VALUES ('wal');");
      process.exit(0);
    `;
    execFileSync(process.execPath, ['-e', script, db], { stdio: 'pipe' });
    expect(fs.existsSync(db + '-wal')).to.equal(true);
    expect(nativeRows(db).map((row) => row.branch_name)).to.deep.equal(['wal']);
    expect(nativeDigest(db)).to.equal(legacyDigest());
  });

  it('preserves result ordering and fails closed on missing or invalid databases', () => {
    expect(
      sqliteReadBatch(db, ['SELECT 1 AS first;', 'SELECT 2 AS second;'])
    ).to.deep.equal([[{ first: 1 }], [{ second: 2 }]]);
    expect(() =>
      sqliteReadBatch(db, ['SELECT 1;', 'SELECT * FROM absent;'])
    ).to.throw();
    expect(() => nativeDigest(path.join(root, 'missing.db'))).to.throw();
    fs.writeFileSync(path.join(root, 'corrupt.db'), 'not sqlite');
    expect(() => nativeDigest(path.join(root, 'corrupt.db'))).to.throw();
    expect(fs.existsSync(path.join(root, 'missing.db'))).to.equal(false);
  });
});
