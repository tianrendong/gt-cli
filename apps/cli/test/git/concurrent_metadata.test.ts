import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { composeEngine, TEngine } from '../../src/lib/engine/engine';
import { composeGit } from '../../src/lib/git/git';
import {
  getMetadataOid,
  readMetadataRef,
  readMetadataRefs,
  writeMetadataRef,
} from '../../src/lib/engine/metadata_ref';
import { TSplog } from '../../src/lib/utils/splog';

const splog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
} as unknown as TSplog;

/** Two gt processes (e.g. sync in one worktree, submit in another) operate on
 * the same metadata refs at once. Neither holds a repository-wide lock any
 * more, so metadata writes must not clobber what the other just recorded and
 * the persisted cache must never claim to describe refs it did not see. */
describe('concurrent metadata writers without a repository lock', function () {
  this.timeout(30_000);
  let root: string, cwd: string, savedEnv: NodeJS.ProcessEnv, serial: number;
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      input,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const commit = (parent?: string) => {
    const tree = git(['mktree'], '');
    return git([
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      `commit ${serial++}`,
    ]);
  };
  const branch = (name: string, parent: string) => {
    const pbr = git(['rev-parse', parent]);
    const sha = commit(pbr);
    git(['update-ref', `refs/heads/${name}`, sha]);
    writeMetadataRef(name, {
      parentBranchName: parent,
      parentBranchRevision: pbr,
    });
    return sha;
  };
  const engine = (): TEngine =>
    composeEngine({
      git: composeGit(),
      trunkName: 'main',
      splog,
      noVerify: true,
      remote: 'origin',
    });
  const cacheFile = () => path.join(root, '.git/.graphite_cache_persist');

  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    serial = 0;
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-concurrent-meta-'))
    );
    process.chdir(root);
    for (const key of Object.keys(process.env))
      if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    });
    git(['init', '-b', 'main']);
    git(['config', 'gc.auto', '0']);
    git(['update-ref', 'refs/heads/main', commit()]);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(['reset', '--hard', '-q']);
    branch('a', 'main');
    branch('b', 'a');
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('merges PR info recorded by another command instead of overwriting it', () => {
    const mine = engine();
    // Another worktree's submit records the PR after this command loaded.
    const theirs = engine();
    theirs.upsertPrInfo('b', { number: 7, url: 'https://x/7', state: 'OPEN' });
    // This command only re-parents b (e.g. sync deleted a merged ancestor).
    mine.setParent('b', 'main');
    const stored = readMetadataRef('b');
    expect(stored.parentBranchName).to.equal('main');
    expect(stored.prInfo).to.include({ number: 7, state: 'OPEN' });
    // The in-memory view adopted the merged fields too.
    expect(mine.getPrInfo('b')?.number).to.equal(7);
    expect(mine.getParentPrecondition('b')).to.equal('main');
  });

  it('skips the write when the metadata blob would be identical, without disturbing a newer blob', () => {
    const mine = engine();
    mine.upsertPrInfo('b', { number: 7, url: 'https://x/7', state: 'OPEN' });
    const oid = getMetadataOid('b');
    // Same content: the local blob hash matches the ref, so nothing runs.
    expect(
      writeMetadataRef('b', readMetadataRef('b'), undefined, oid)
    ).to.equal(oid);
    expect(getMetadataOid('b')).to.equal(oid);
    // Re-upserting unchanged PR info is such a no-op.
    mine.upsertPrInfo('b', { number: 7, url: 'https://x/7', state: 'OPEN' });
    expect(getMetadataOid('b')).to.equal(oid);
    // The local hash agrees with git's own object id for this blob.
    expect(
      git(
        ['hash-object', '--stdin'],
        JSON.stringify(readMetadataRef('b'), null, 2)
      )
    ).to.equal(oid);
    // A changed field still writes; a stale expectation still compare-and-swaps.
    mine.upsertPrInfo('b', { state: 'MERGED' });
    const next = getMetadataOid('b');
    expect(next).not.to.equal(oid);
    expect(
      writeMetadataRef('b', { parentBranchName: 'a' }, undefined, oid)
    ).to.equal(undefined);
    expect(getMetadataOid('b')).to.equal(next);
  });

  it('keeps a concurrent re-parent while applying its own PR-info field change', () => {
    const mine = engine();
    const theirs = engine();
    theirs.setParent('b', 'main');
    mine.upsertPrInfo('b', { state: 'MERGED' });
    const stored = readMetadataRef('b');
    expect(stored.parentBranchName).to.equal('main');
    expect(stored.prInfo?.state).to.equal('MERGED');
    expect(mine.getParentPrecondition('b')).to.equal('main');
  });

  it('does not mark its persisted cache reusable when another command moved refs it never saw', () => {
    const mine = engine();
    mine.upsertPrInfo('a', { state: 'OPEN' }); // a write of our own
    const theirs = engine();
    theirs.upsertPrInfo('b', { number: 9 });
    mine.persist();
    const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(persisted.sha).to.equal('0'.repeat(40));
    // The next command parses cold and sees both writes.
    const next = engine();
    expect(next.getPrInfo('a')?.state).to.equal('OPEN');
    expect(next.getPrInfo('b')?.number).to.equal(9);
    next.persist();
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).sha).not.to.equal(
      '0'.repeat(40)
    );
  });

  it('reads the captured metadata blob even if its ref changes before the read', () => {
    const oid = getMetadataOid('b');
    const before = readMetadataRef('b');
    engine().upsertPrInfo('b', { number: 11 });
    expect(readMetadataRef('b').prInfo?.number).to.equal(11);
    expect(readMetadataRef('b', undefined, oid)).to.deep.equal(before);
    expect(readMetadataRefs(['b'], { b: oid }).get('b')).to.deep.equal(before);
  });

  it('stops instead of caching a false parent when another command creates a new parent', () => {
    const mine = engine();
    branch('new-parent', 'a');
    engine().setParent('b', 'new-parent');
    expect(() => mine.upsertPrInfo('b', { state: 'MERGED' })).to.throw(
      "not in this command's snapshot"
    );
    const stored = readMetadataRef('b');
    expect(stored.parentBranchName).to.equal('new-parent');
    expect(stored.prInfo?.state).to.equal('MERGED');
    expect(engine().getParentPrecondition('b')).to.equal('new-parent');
  });

  it('stamps the cache when it alone changed the refs', () => {
    const mine = engine();
    mine.upsertPrInfo('a', { state: 'OPEN' });
    mine.persist();
    const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(persisted.sha).not.to.equal('0'.repeat(40));
    expect(Object.fromEntries(persisted.branches).a.metadataOid).to.equal(
      getMetadataOid('a')
    );
  });
});
