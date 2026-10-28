#!/usr/bin/env node
// Private, bounded subprocess used by the cutover manager. Never invokes sqlite3
// from PATH. SQLite is bundled with the supported Node.js runtime.
const fs = require('fs');

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { DatabaseSync, backup } = require('node:sqlite');
  const db = new DatabaseSync(request.db, { readOnly: request.readonly });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    if (request.destination !== undefined) {
      // Reserve exclusively: never overwrite another backup or follow its symlink.
      const fd = fs.openSync(request.destination, 'wx', 0o600);
      fs.closeSync(fd);
      // SQLite's online backup API includes committed WAL data. Do not copy the
      // source file or replace the live database inode.
      await backup(db, request.destination);
    } else if (request.readonly && request.queries !== undefined) {
      // A digest's schema and rows must come from the same committed snapshot.
      // Errors still close the connection (rolling back) and fail the subprocess.
      db.exec('BEGIN;');
      const results = request.queries.map((sql) => db.prepare(sql).all());
      db.exec('COMMIT;');
      process.stdout.write(JSON.stringify(results));
    } else if (request.readonly) {
      process.stdout.write(JSON.stringify(db.prepare(request.sql).all()));
    } else {
      // Keep multi-statement CAS/DELETE/INSERT/COMMIT scripts on one connection.
      // Closing on error rolls back any uncommitted transaction.
      db.exec(request.sql);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Bundled SQLite: ${error.message}`);
  process.exitCode = 1;
});
