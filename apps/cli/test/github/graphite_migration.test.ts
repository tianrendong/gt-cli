import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { promisify } from 'util';
import { setTimeout as sleep } from 'timers/promises';
import { StackStore } from '../../src/lib/github/stack_file';
import { TMeta } from '../../src/lib/engine/metadata_ref';

const script = path.resolve(
  __dirname,
  '../../../scripts/migrate-from-graphite.cjs'
);
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

describe('Graphite SQLite migration', function () {
  this.timeout(30_000);
  let root: string, repo: string, db: string, published: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const sql = (query: string): void => {
    execFileSync('sqlite3', [db, query], { env, stdio: 'pipe' });
  };
  const version = (raw: string | null, branch = 'one'): void => {
    sql(
      `UPDATE branch_metadata SET last_submitted_version=${
        raw === null ? 'NULL' : sqlString(raw)
      } WHERE branch_name=${sqlString(branch)};`
    );
  };
  const migrate = (args: string[] = [], expected = 0, cwd = repo): string => {
    const result = spawnSync(
      process.execPath,
      [script, '--repo', cwd, ...args],
      { env, encoding: 'utf8', timeout: 15_000 }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(
      expected
    );
    return result.stdout + result.stderr;
  };
  const refs = (): string => git(['show-ref']);
  const meta = (branch = 'one'): TMeta =>
    JSON.parse(git(['cat-file', '-p', `refs/branch-metadata/${branch}`]));
  const metadataRefs = (): string =>
    git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/branch-metadata/',
    ]);

  it('migrates without invoking sqlite3 from PATH', () => {
    const bin = path.join(root, 'blocked-bin');
    fs.mkdirSync(bin);
    const marker = path.join(root, 'sqlite3-invoked');
    fs.writeFileSync(
      path.join(bin, 'sqlite3'),
      `#!/bin/sh\nprintf invoked > '${marker}'\nexit 127\n`,
      { mode: 0o755 }
    );
    env.PATH = bin + path.delimiter + env.PATH;
    migrate(['--dry-run']);
    migrate();
    expect(meta().parentBranchName).to.equal('main');
    expect(fs.existsSync(marker)).to.equal(false);
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-graphite-migration-'));
    repo = path.join(root, 'repo');
    db = path.join(repo, '.git/.graphite_metadata.db');
    fs.mkdirSync(repo);
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['commit', '--allow-empty', '-m', 'initial']);
    git(['checkout', '-b', 'one']);
    git(['commit', '--allow-empty', '-m', 'one']);
    published = git(['rev-parse', 'one']);
    git(['checkout', '-b', 'two']);
    git(['commit', '--allow-empty', '-m', 'two']);
    sql(`
      CREATE TABLE branch_metadata (
        branch_name TEXT PRIMARY KEY,
        parent_branch_name TEXT,
        parent_branch_revision TEXT,
        last_submitted_version TEXT,
        validation_result TEXT
      );
      INSERT INTO branch_metadata VALUES ('main', NULL, NULL, NULL, 'TRUNK');
      INSERT INTO branch_metadata VALUES ('one', 'main', '${git([
        'rev-parse',
        'main',
      ])}', NULL, 'VALID');
      INSERT INTO branch_metadata VALUES ('two', 'one', '${published}', NULL, 'VALID');
    `);
    version(
      JSON.stringify({
        headSha: published,
        baseSha: git(['rev-parse', 'main']),
        baseName: 'main',
        versionNumber: 3,
      })
    );
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_pr_info'),
      JSON.stringify({
        prInfos: [
          {
            headRefName: 'one',
            prNumber: 42,
            baseRefName: 'main',
            state: 'OPEN',
            isDraft: true,
            reviewDecision: 'CHANGES_REQUESTED',
            title: 'One',
            body: 'Description',
            url: 'https://github.com/test/repo/pull/42',
          },
        ],
      })
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('preserves published-tip leases, PR review state, parents, and Graphite files', () => {
    const database = fs.readFileSync(db);
    const prFile = path.join(repo, '.git/.graphite_pr_info');
    const prCache = fs.readFileSync(prFile);
    const heads = git(['show-ref', '--heads']);
    expect(migrate()).to.contain('Preserved 1 published-tip lease(s).');
    expect(meta()).to.deep.equal({
      parentBranchName: 'main',
      parentBranchRevision: git(['rev-parse', 'main']),
      lastSubmittedVersion: {
        headSha: published,
        baseSha: git(['rev-parse', 'main']),
        baseName: 'main',
        versionNumber: 3,
      },
      prInfo: {
        number: 42,
        base: 'main',
        state: 'OPEN',
        isDraft: true,
        reviewDecision: 'CHANGES_REQUESTED',
        title: 'One',
        body: 'Description',
        url: 'https://github.com/test/repo/pull/42',
        remoteRevision: published,
      },
    });
    expect(meta('two')).to.deep.equal({
      parentBranchName: 'one',
      parentBranchRevision: published,
    });
    expect(git(['show-ref', '--heads'])).to.equal(heads);
    expect(fs.readFileSync(db).equals(database)).to.equal(true);
    expect(fs.readFileSync(prFile).equals(prCache)).to.equal(true);
  });

  for (const cache of ['absent', 'malformed']) {
    it(`preserves the lease when the optional PR cache is ${cache}`, () => {
      const file = path.join(repo, '.git/.graphite_pr_info');
      if (cache === 'absent') fs.unlinkSync(file);
      else fs.writeFileSync(file, '{');
      const output = migrate();
      expect(output).not.to.contain('PR #undefined');
      expect(meta().prInfo).to.deep.equal({ remoteRevision: published });
    });
  }

  it('previews leases without changing refs or writing metadata blobs', () => {
    const before = refs();
    const objects = git(['count-objects', '-v']);
    expect(migrate(['--dry-run'])).to.contain(
      'Would preserve 1 published-tip lease(s).'
    );
    expect(refs()).to.equal(before);
    expect(git(['count-objects', '-v'])).to.equal(objects);
    expect(metadataRefs()).to.equal('');
  });

  for (const raw of [
    '{',
    'null',
    '{}',
    '{"headSha":42}',
    '{"headSha":"invalid"}',
    `{"headSha":"${'a'.repeat(40)}","baseName":42}`,
    `{"headSha":"${'a'.repeat(40)}","versionNumber":"invalid"}`,
  ]) {
    it(`refuses unknown published-version format ${raw} before writing any refs`, () => {
      // The valid first row must not be partially applied before the bad second row.
      version(raw, 'two');
      const before = refs();
      for (const args of [[], ['--dry-run']]) {
        expect(migrate(args, 1)).to.contain(
          'Refusing to discard its published-tip lease'
        );
        expect(refs()).to.equal(before);
        expect(metadataRefs()).to.equal('');
      }
    });
  }

  it('does not invent a lease for an unpublished branch', () => {
    version(null);
    migrate();
    expect(meta().prInfo?.remoteRevision).to.equal(undefined);
    expect(meta('two').prInfo).to.equal(undefined);
  });

  it('skips existing metadata unless force was explicitly supplied', () => {
    migrate();
    const before = metadataRefs();
    const anotherTip = git(['rev-parse', 'two']);
    version(JSON.stringify({ headSha: anotherTip }));
    expect(migrate()).to.contain('Migrated 0 branch(es); skipped 2.');
    expect(metadataRefs()).to.equal(before);
    migrate(['--force']);
    expect(meta().prInfo?.remoteRevision).to.equal(anotherTip);
  });

  it('applies no metadata refs if a ref transaction cannot prepare', () => {
    const lock = path.join(repo, '.git/refs/branch-metadata/two.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'external owner');
    const before = refs();
    migrate([], 1);
    expect(refs()).to.equal(before);
    expect(metadataRefs()).to.equal('');
    expect(fs.readFileSync(lock, 'utf8')).to.equal('external owner');
  });

  for (const change of [
    "DELETE FROM branch_metadata WHERE branch_name='one'",
    "UPDATE branch_metadata SET parent_branch_name=NULL WHERE branch_name='one'",
  ]) {
    it(`preserves children of a surviving untracked parent (${
      change.startsWith('DELETE') ? 'absent row' : 'untracked row'
    })`, () => {
      sql(change);
      const before = refs();
      const heads = git(['show-ref', '--heads']);
      const objects = git(['count-objects', '-v']);
      const database = fs.readFileSync(db);
      migrate(['--dry-run']);
      expect(refs()).to.equal(before);
      expect(git(['count-objects', '-v'])).to.equal(objects);
      migrate();
      expect(meta('two').parentBranchName).to.equal('one');
      expect(metadataRefs()).not.to.contain('refs/branch-metadata/one');
      expect(git(['show-ref', '--heads'])).to.equal(heads);
      expect(fs.readFileSync(db).equals(database)).to.equal(true);
    });
  }

  const removeRecordedParent = (): void => {
    sql('ALTER TABLE branch_metadata ADD COLUMN branch_revision TEXT;');
    sql(
      `UPDATE branch_metadata SET branch_revision='${published}' WHERE branch_name='one';`
    );
    git(['branch', '-D', 'one']);
  };

  it('refuses partial migration of an orphaned chain unless recovery was requested', () => {
    removeRecordedParent();
    const before = refs();
    for (const args of [[], ['--dry-run']]) {
      expect(migrate(args, 1)).to.contain('Incomplete ancestry');
      expect(refs()).to.equal(before);
    }
  });

  it('previews missing-parent recovery without creating refs or objects', () => {
    removeRecordedParent();
    const before = refs(),
      objects = git(['count-objects', '-v']);
    expect(migrate(['--restore-missing-parents', '--dry-run'])).to.contain(
      `would restore missing parent one at ${published}`
    );
    expect(refs()).to.equal(before);
    expect(git(['count-objects', '-v'])).to.equal(objects);
  });

  it('restores only necessary recorded ancestors, preserving live tips and dirty files', () => {
    removeRecordedParent();
    sql(
      `INSERT INTO branch_metadata (branch_name,parent_branch_name,branch_revision) VALUES ('unused-deleted','main','${published}');`
    );
    const child = git(['rev-parse', 'two']);
    const database = fs.readFileSync(db);
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep me');
    const status = git(['status', '--porcelain']);
    migrate(['--restore-missing-parents']);
    expect(git(['rev-parse', 'one'])).to.equal(published);
    expect(git(['rev-parse', 'two'])).to.equal(child);
    expect(git(['branch', '--show-current'])).to.equal('two');
    expect(git(['branch', '--list', 'unused-deleted'])).to.equal('');
    expect(meta('two').parentBranchName).to.equal('one');
    expect(meta('one').prInfo?.remoteRevision).to.equal(published);
    expect(git(['status', '--porcelain'])).to.equal(status);
    expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).to.equal(
      'keep me'
    );
    expect(fs.readFileSync(db).equals(database)).to.equal(true);
  });

  it('recovers a chain of missing recorded parents without guessing topology', () => {
    removeRecordedParent();
    sql(
      `INSERT INTO branch_metadata (branch_name,parent_branch_name,branch_revision) VALUES ('middle','main','${git(
        ['rev-parse', 'main']
      )}');`
    );
    sql(
      "UPDATE branch_metadata SET parent_branch_name='middle' WHERE branch_name='one';"
    );
    migrate(['--restore-missing-parents']);
    expect(meta('one').parentBranchName).to.equal('middle');
    expect(meta('middle').parentBranchName).to.equal('main');
    expect(git(['rev-parse', 'middle'])).to.equal(git(['rev-parse', 'main']));
  });

  it('refuses missing recorded commits rather than using a tracking ref or trunk tip', () => {
    removeRecordedParent();
    sql(
      `UPDATE branch_metadata SET branch_revision='${'f'.repeat(
        40
      )}' WHERE branch_name='one';`
    );
    const before = refs();
    expect(migrate(['--restore-missing-parents'], 1)).to.contain(
      'recorded commit for missing parent one is unavailable'
    );
    expect(refs()).to.equal(before);
  });

  it('rejects cycles before creating any metadata', () => {
    sql(
      "UPDATE branch_metadata SET parent_branch_name='two' WHERE branch_name='one';"
    );
    const before = refs();
    expect(migrate([], 1)).to.contain('Cycle in ancestry');
    expect(refs()).to.equal(before);
  });

  it('rejects unsafe recorded ref names before writing any refs', () => {
    removeRecordedParent();
    sql(
      "UPDATE branch_metadata SET parent_branch_name='bad name' WHERE branch_name='two';"
    );
    sql(
      `INSERT INTO branch_metadata (branch_name,parent_branch_name,branch_revision) VALUES ('bad name','main','${published}');`
    );
    const before = refs();
    expect(migrate(['--restore-missing-parents'], 1)).to.contain(
      'invalid recorded parent branch name'
    );
    expect(refs()).to.equal(before);
  });

  it('does not restore a missing ref checked out in another worktree', () => {
    sql('ALTER TABLE branch_metadata ADD COLUMN branch_revision TEXT;');
    sql(
      `UPDATE branch_metadata SET branch_revision='${published}' WHERE branch_name='one';`
    );
    git([
      'worktree',
      'add',
      '--no-checkout',
      path.join(root, 'occupied'),
      'one',
    ]);
    git(['update-ref', '-d', 'refs/heads/one']);
    const before = refs();
    expect(migrate(['--restore-missing-parents'], 1)).to.contain(
      'checked out in another worktree'
    );
    expect(refs()).to.equal(before);
  });

  it('restores no branch when the combined metadata/ref transaction fails', () => {
    removeRecordedParent();
    const lock = path.join(repo, '.git/refs/branch-metadata/two.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'external owner');
    const before = refs();
    migrate(['--restore-missing-parents'], 1);
    expect(refs()).to.equal(before);
    expect(git(['branch', '--list', 'one'])).to.equal('');
  });

  it('does not resurrect stale Graphite topology for already-migrated branches', () => {
    migrate();
    sql(
      "UPDATE branch_metadata SET parent_branch_name='obsolete' WHERE branch_name='one';"
    );
    const before = refs();
    migrate(['--restore-missing-parents']);
    expect(refs()).to.equal(before);
  });

  it('coordinates with running gt commands before migrating', async () => {
    const directory = path.join(repo, '.git');
    const holder = new StackStore(directory, directory);
    const pending = promisify(execFile)(
      process.execPath,
      [script, '--repo', repo],
      { env, encoding: 'utf8', timeout: 15_000 }
    ).then(
      () => undefined,
      (error: Error) => error
    );
    try {
      await sleep(300);
      expect(metadataRefs()).to.equal('');
    } finally {
      holder.close();
    }
    expect(await pending).to.equal(undefined);
    expect(meta().prInfo?.remoteRevision).to.equal(published);
  });

  it('uses the shared SQLite database and refs from a linked worktree', () => {
    const worktree = path.join(root, 'worktree');
    git(['worktree', 'add', '--detach', worktree, 'main']);
    migrate([], 0, worktree);
    expect(meta().prInfo?.remoteRevision).to.equal(published);
    expect(meta('two').parentBranchName).to.equal('one');
  });
});
