import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  Repository,
  backupDatabase,
  nativeRows,
  sqlite,
  nativeDigest,
} from '../../src/lib/switch/repository';
import {
  commitNativeRows,
  createNativeDatabase,
} from '../../src/lib/switch/native';
import {
  SwitchState,
  ABSENT_NATIVE_DIGEST,
  assertNativeUnchanged,
  readState,
  writeState,
} from '../../src/lib/switch/state';
import { assertReenableMetadata } from '../../src/lib/switch/plan';
import { switchBackend } from '../../src/lib/switch/transition';

describe('backend switch safety primitives (no proprietary CLI required)', function () {
  this.timeout(20_000);
  let root: string, repo: Repository, db: string;
  const selection = (): SwitchState => ({
    schemaVersion: 1,
    mode: 'gt-gh',
    session: '123-abcdef123456',
    native: { path: '/native/gt', version: '1.8.6', digest: 'a'.repeat(64) },
    candidate: { node: '/removed/node', script: '/removed/gt-gh.js' },
    nativeDigest: nativeDigest(db),
    prCache: null,
    repoConfig: null,
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switch-safety-'));
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { stdio: 'pipe' }
    );
    repo = new Repository(root);
    db = repo.db;
    sqlite(
      db,
      `CREATE TABLE branch_metadata (branch_name TEXT PRIMARY KEY, parent_branch_name TEXT, parent_branch_revision TEXT, last_submitted_version TEXT, state TEXT, children TEXT, branch_revision TEXT, validation_result TEXT, parent_head_revision TEXT);
      INSERT INTO branch_metadata(branch_name,validation_result) VALUES('main','TRUNK'),('one','VALID');
      CREATE TABLE unrelated(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO unrelated VALUES('keep','untouched');`,
      false
    );
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  );

  it('only replaces branch metadata, preserving unrelated SQLite data and inode', () => {
    const before = path.join(root, 'before.sqlite'),
      target = path.join(root, 'target.sqlite');
    backupDatabase(db, before);
    backupDatabase(db, target);
    sqlite(
      target,
      "UPDATE branch_metadata SET parent_branch_name='main' WHERE branch_name='one';",
      false
    );
    const ino = fs.statSync(db).ino;
    commitNativeRows(repo, before, target);
    expect(
      nativeRows(db).find((r) => r.branch_name === 'one')!.parent_branch_name
    ).to.equal('main');
    expect(sqlite(db, 'SELECT value FROM unrelated;')).to.contain('untouched');
    expect(fs.statSync(db).ino).to.equal(ino);
  });

  it('rejects a concurrent native write in the SQLite transaction', () => {
    const before = path.join(root, 'before.sqlite'),
      target = path.join(root, 'target.sqlite');
    backupDatabase(db, before);
    backupDatabase(db, target);
    sqlite(
      db,
      "UPDATE branch_metadata SET state='frozen' WHERE branch_name='one';",
      false
    );
    const current = nativeDigest(db);
    expect(() => commitNativeRows(repo, before, target)).to.throw();
    expect(nativeDigest(db)).to.equal(current);
  });

  it('rolls back the DELETE if inserting replacement rows fails', () => {
    sqlite(
      db,
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON branch_metadata BEGIN SELECT RAISE(ABORT,'test write failure'); END;",
      false
    );
    const before = path.join(root, 'before.sqlite'),
      target = path.join(root, 'target.sqlite');
    backupDatabase(db, before);
    backupDatabase(db, target);
    const current = nativeRows(db);
    expect(() => commitNativeRows(repo, before, target)).to.throw();
    expect(nativeRows(db)).to.deep.equal(current);
  });

  it('backs up committed data still resident in SQLite WAL', async () => {
    const writer = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let output = '';
        writer.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('READY')) resolve();
        });
        writer.once('error', reject);
        writer.once('exit', (code) => {
          if (code !== 0) reject(new Error('SQLite writer failed'));
        });
      });
      writer.stdin.write(
        "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nUPDATE branch_metadata SET state='frozen' WHERE branch_name='one';\n.print READY\n"
      );
      await ready;
      expect(fs.existsSync(db + '-wal')).to.equal(true);
      const backup = path.join(root, 'wal-backup.sqlite');
      backupDatabase(db, backup);
      expect(
        nativeRows(backup).find((r) => r.branch_name === 'one')!.state
      ).to.equal('frozen');
    } finally {
      const exited = new Promise((resolve) => writer.once('exit', resolve));
      writer.stdin.end();
      await exited;
    }
  });

  it('never replaces a concurrently created native database during first handoff', () => {
    const target = path.join(root, 'target.sqlite');
    backupDatabase(db, target);
    const expected = fs.readFileSync(db);
    fs.unlinkSync(db);
    const link = fs.linkSync;
    try {
      fs.linkSync = (from, to) => {
        if (to === db) fs.writeFileSync(db, expected, { flag: 'wx' });
        return link(from, to);
      };
      expect(() => createNativeDatabase(repo, target)).to.throw();
      expect(fs.readFileSync(db).equals(expected)).to.equal(true);
    } finally {
      fs.linkSync = link;
    }
  });

  it('cannot rewrite an existing branch even with a bad recovery plan', () => {
    const before = repo.refs();
    const tree = repo.git(['rev-parse', 'HEAD^{tree}']);
    const other = execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit-tree',
        tree,
        '-p',
        'HEAD',
        '-m',
        'other',
      ],
      { encoding: 'utf8' }
    ).trim();
    expect(() =>
      repo.applyRefs(before, { ...before, 'refs/heads/main': other })
    ).to.throw('never rewrite');
    expect(repo.refs()).to.deep.equal(before);
  });

  it('rejects injected ref transaction text', () => {
    const before = repo.refs();
    expect(() =>
      repo.applyRefs(before, {
        ...before,
        'refs/branch-metadata/one': 'bad\ndelete refs/heads/main',
      })
    ).to.throw('Unsafe object ID');
    expect(repo.refs()).to.deep.equal(before);
  });

  it('rejects symlinked metadata rather than breaking the link or overwriting its target', () => {
    const target = path.join(root, 'external-config');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, path.join(repo.common, '.graphite_repo_config'));
    expect(() => repo.assertIdle()).to.throw('symlinked backend metadata');
    expect(fs.readFileSync(target, 'utf8')).to.equal('{}');
  });

  it('archives disabled selection without requiring the candidate installation', () => {
    const state = selection();
    writeState(repo, state);
    expect(fs.existsSync(path.join(repo.control, 'state.json'))).to.equal(true);
    writeState(repo, { ...state, mode: 'graphite' });
    expect(fs.existsSync(path.join(repo.control, 'state.json'))).to.equal(
      false
    );
    expect(readState(repo)?.mode).to.equal('graphite');
  });

  it('does not change an enabled launcher during an idempotent preview', async () => {
    const state = selection();
    writeState(repo, state);
    const active = path.join(repo.control, 'state.json');
    const before = fs.readFileSync(active);
    const snapshot = repo.snapshot();
    const result = await switchBackend('enable', {
      repo: root,
      candidate: {
        node: process.execPath,
        script: path.join(root, 'new-install.js'),
      },
      dryRun: true,
    });
    expect(fs.readFileSync(active).equals(before)).to.equal(true);
    expect(result).to.include({ mode: 'gt-gh', already: true, dryRun: true });
    expect(repo.snapshot()).to.deep.equal(snapshot);
  });

  it('can update an enabled launcher when preview is not requested', async () => {
    writeState(repo, selection());
    const candidate = {
      node: process.execPath,
      script: path.join(root, 'new-install.js'),
    };
    await switchBackend('enable', { repo: root, candidate });
    expect(readState(repo)?.candidate).to.deep.equal(candidate);
  });

  it('reports an already-disabled preview without changing its history', async () => {
    const state = { ...selection(), mode: 'graphite' as const };
    writeState(repo, state);
    const archived = path.join(repo.control, 'last.json');
    const before = fs.readFileSync(archived);
    const result = await switchBackend('disable', {
      repo: root,
      candidate: state.candidate,
      dryRun: true,
    });
    expect(result).to.include({
      mode: 'graphite',
      already: true,
      dryRun: true,
    });
    expect(fs.readFileSync(archived).equals(before)).to.equal(true);
    expect(fs.existsSync(path.join(repo.control, 'state.json'))).to.equal(
      false
    );
  });

  describe('re-enable metadata ownership', () => {
    const ref = 'refs/branch-metadata/one';
    const expected = { [ref]: 'a'.repeat(40) };
    beforeEach(() => {
      sqlite(
        db,
        "UPDATE branch_metadata SET parent_branch_name='main' WHERE branch_name='one';",
        false
      );
    });

    it('allows unchanged dormant refs regardless of branch-tip movement', () => {
      expect(() =>
        assertReenableMetadata(
          repo,
          { ...expected, 'refs/heads/one': 'b'.repeat(40) },
          { expected, rows: nativeRows(db) }
        )
      ).not.to.throw();
    });

    it('allows removed refs when native Graphite deleted the branch', () => {
      sqlite(db, "DELETE FROM branch_metadata WHERE branch_name='one';", false);
      expect(() =>
        assertReenableMetadata(repo, repo.refs(), {
          expected,
          rows: nativeRows(db),
        })
      ).not.to.throw();
    });

    it('allows removed refs when native Graphite untracked a surviving branch', () => {
      sqlite(
        db,
        "UPDATE branch_metadata SET parent_branch_name=NULL WHERE branch_name='one';",
        false
      );
      expect(() =>
        assertReenableMetadata(
          repo,
          { ...repo.refs(), 'refs/heads/one': 'b'.repeat(40) },
          { expected, rows: nativeRows(db) }
        )
      ).not.to.throw();
    });

    it('allows removed refs even when SQLite still tracks the branch and its head is missing', () => {
      expect(() =>
        assertReenableMetadata(repo, repo.refs(), {
          expected,
          rows: nativeRows(db),
        })
      ).not.to.throw();
    });

    it('allows removed refs even when native children retain an untracked parent', () => {
      sqlite(
        db,
        "DELETE FROM branch_metadata WHERE branch_name='one'; INSERT INTO branch_metadata(branch_name,parent_branch_name) VALUES('child','one');",
        false
      );
      expect(() =>
        assertReenableMetadata(repo, repo.refs(), {
          expected,
          rows: nativeRows(db),
        })
      ).not.to.throw();
    });

    it('allows all removed refs when a verified native database has no rows', () => {
      expect(() =>
        assertReenableMetadata(
          repo,
          {},
          {
            expected: {
              ...expected,
              'refs/branch-metadata/two': 'b'.repeat(40),
            },
            rows: [],
          }
        )
      ).not.to.throw();
    });

    for (const operation of ['added', 'changed']) {
      it(`rejects ${operation} refs even when native Graphite no longer tracks them`, () => {
        sqlite(
          db,
          "DELETE FROM branch_metadata WHERE branch_name='one';",
          false
        );
        expect(() =>
          assertReenableMetadata(
            repo,
            { [ref]: 'b'.repeat(40) },
            {
              expected: operation === 'added' ? {} : expected,
              rows: nativeRows(db),
            }
          )
        ).to.throw(`${operation} ${ref}`);
      });
    }

    it('does not let an allowed removal hide another conflicting ref', () => {
      expect(() =>
        assertReenableMetadata(
          repo,
          { 'refs/branch-metadata/foreign': 'b'.repeat(40) },
          { expected, rows: nativeRows(db) }
        )
      ).to.throw('added refs/branch-metadata/foreign');
    });

    it('keeps strict ownership checks when there is no native database', () => {
      expect(() => assertReenableMetadata(repo, {}, { expected })).to.throw(
        `removed ${ref} (no native database to rebuild metadata)`
      );
      expect(() =>
        assertReenableMetadata(repo, expected, { expected })
      ).not.to.throw();
    });

    it('keeps the nativeAbsent re-enable path strict without changing selection', async () => {
      const saved = {
        ...selection(),
        mode: 'graphite' as const,
        nativeAbsent: true as const,
        nativeDigest: ABSENT_NATIVE_DIGEST,
        metadataRefs: {},
      };
      fs.unlinkSync(db);
      writeState(repo, saved);
      const blob = repo.git(['hash-object', '-w', '--stdin'], '{}');
      repo.git(['update-ref', ref, blob]);
      const before = repo.snapshot();
      const archived = path.join(repo.control, 'last.json');
      const history = fs.readFileSync(archived);
      for (const dryRun of [true, false]) {
        let message = '';
        try {
          await switchBackend('enable', {
            repo: root,
            candidate: saved.candidate,
            dryRun,
          });
        } catch (error) {
          message = error.message;
        }
        expect(message).to.contain(`added ${ref}`);
        expect(repo.snapshot()).to.deep.equal(before);
        expect(fs.readFileSync(archived).equals(history)).to.equal(true);
        expect(readState(repo)?.mode).to.equal('graphite');
        expect(fs.existsSync(db)).to.equal(false);
      }
    });

    it('does not treat malformed saved ref names as allowed removals', () => {
      expect(() =>
        assertReenableMetadata(
          repo,
          {},
          { expected: { invalid: 'a'.repeat(40) }, rows: [] }
        )
      ).to.throw('invalid saved metadata ref invalid');
    });

    it('reports repository, conflicting refs, backups, and retry guidance without writes', () => {
      const before = repo.snapshot();
      const database = fs.readFileSync(db);
      let message = '';
      try {
        assertReenableMetadata(
          repo,
          { ...repo.refs(), [ref]: 'b'.repeat(40) },
          {
            expected,
            rows: nativeRows(db),
          }
        );
      } catch (error) {
        message = error.message;
      }
      expect(message).to.contain(`Repository: ${repo.cwd}`);
      expect(message).to.contain(ref);
      expect(message).to.contain(`Backups: ${repo.control}`);
      expect(message).to.contain('gt-cli enable --repo PATH --dry-run');
      expect(message).to.contain('No metadata was overwritten.');
      expect(repo.snapshot()).to.deep.equal(before);
      expect(fs.readFileSync(db).equals(database)).to.equal(true);
    });
  });

  it('identifies every changed native component without exposing or overwriting its contents', () => {
    const saved = selection();
    sqlite(
      db,
      "UPDATE branch_metadata SET state='frozen' WHERE branch_name='one';",
      false
    );
    for (const name of ['.graphite_repo_config', '.graphite_pr_info'])
      fs.writeFileSync(
        path.join(repo.common, name),
        'private-content-sentinel'
      );
    const before = repo.snapshot();
    const database = fs.readFileSync(db);
    let message = '';
    try {
      assertNativeUnchanged(repo, saved);
    } catch (error) {
      message = error.message;
    }
    for (const name of [
      '.graphite_metadata.db',
      '.graphite_repo_config',
      '.graphite_pr_info',
    ])
      expect(message).to.contain(`changed ${name}`);
    expect(message).to.contain(`Repository: ${repo.cwd}`);
    expect(message).to.contain(`Backups: ${repo.control}`);
    expect(message).not.to.contain('private-content-sentinel');
    expect(repo.snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(db).equals(database)).to.equal(true);
  });

  it('still permits candidate-owned config changes when recording the next baseline', () => {
    const saved = selection();
    fs.writeFileSync(path.join(repo.common, '.graphite_repo_config'), '{}');
    expect(() => assertNativeUnchanged(repo, saved, false)).not.to.throw();
    expect(() => assertNativeUnchanged(repo, saved)).to.throw(
      'changed .graphite_repo_config'
    );
  });

  it('does not silently fall back on corrupt active selection', () => {
    fs.mkdirSync(repo.control);
    fs.writeFileSync(path.join(repo.control, 'state.json'), '{broken');
    expect(() => readState(repo)).to.throw();
  });
});
