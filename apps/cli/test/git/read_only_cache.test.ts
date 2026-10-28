import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { composeCacheLoader } from '../../src/lib/engine/cache_loader';
import {
  readMetadataRef,
  writeMetadataRef,
} from '../../src/lib/engine/metadata_ref';
import { getGitCommonDir } from '../../src/lib/git/git_dir';
import { TSplog } from '../../src/lib/utils/splog';

const splog = { debug: () => undefined } as unknown as TSplog;

describe('lock-free (read-only) cache loading', function () {
  this.timeout(30_000);
  let root: string, cwd: string, savedEnv: NodeJS.ProcessEnv, serial: number;
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      input,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const cacheFile = () =>
    path.resolve(getGitCommonDir(), '.graphite_cache_persist');
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
  const metadataRefs = () =>
    git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/branch-metadata/',
    ]);
  const load = (readOnly: boolean) => {
    const loader = composeCacheLoader(splog, { readOnly });
    const branches = loader.loadCachedBranches('main');
    return { loader, branches, hit: loader.lastLoadUsedPersistedCache() };
  };

  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    serial = 0;
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-read-only-cache-'))
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

  it('stamps the cache for the refs it parsed, not refs changed by a concurrent writer', () => {
    const reader = load(true);
    expect(reader.hit).to.equal(false);
    // Another process moves a branch between this reader's parse and persist.
    git(['update-ref', 'refs/heads/b', commit(git(['rev-parse', 'b']))]);
    reader.loader.persistCache('main', reader.branches);
    const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(persisted.sha).not.to.equal('0'.repeat(40));
    // The newer refs must miss: the stored branch data describes the old ones.
    const writer = load(false);
    expect(writer.hit).to.equal(false);
    expect(writer.branches.b.branchRevision).to.equal(git(['rev-parse', 'b']));
    expect(reader.branches.b.branchRevision).not.to.equal(
      writer.branches.b.branchRevision
    );
  });

  it('is reused by the next command when the refs did not change', () => {
    const reader = load(true);
    reader.loader.persistCache('main', reader.branches);
    const next = load(false);
    expect(next.hit).to.equal(true);
    expect(next.branches).to.deep.equal(reader.branches);
  });

  it('computes repairs in memory but writes neither metadata nor cache', () => {
    // Advance a; b's recorded parent revision is stale but still in history.
    const a2 = commit(git(['rev-parse', 'a']));
    git(['update-ref', 'refs/heads/a', a2]);
    git(['update-ref', 'refs/heads/b', commit(a2)]);
    // Orphan metadata whose branch is gone is normally deleted during a parse.
    writeMetadataRef('gone', { parentBranchName: 'main' });
    const before = metadataRefs();
    const reader = load(true);
    expect(reader.branches.b).to.include({
      validationResult: 'VALID',
      parentBranchRevision: a2,
    });
    expect(reader.branches).not.to.have.property('gone');
    expect(metadataRefs()).to.equal(before);
    reader.loader.persistCache('main', reader.branches);
    expect(fs.existsSync(cacheFile())).to.equal(false);

    const writer = load(false);
    // The writer applied the repair, so only b's metadata blob differs: the
    // reader deliberately keeps the oid of the blob it actually read.
    const withoutOid = (branches: typeof writer.branches) =>
      Object.fromEntries(
        Object.entries(branches).map(([name, { metadataOid, ...rest }]) => [
          name,
          rest,
        ])
      );
    expect(withoutOid(writer.branches)).to.deep.equal(
      withoutOid(reader.branches)
    );
    expect(writer.branches.b.metadataOid).not.to.equal(
      reader.branches.b.metadataOid
    );
    expect(readMetadataRef('b').parentBranchRevision).to.equal(a2);
    expect(metadataRefs()).not.to.contain('refs/branch-metadata/gone');
    writer.loader.persistCache('main', writer.branches);
    expect(fs.existsSync(cacheFile())).to.equal(true);
  });
});
