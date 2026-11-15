import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { composeCacheLoader } from '../../src/lib/engine/cache_loader';
import {
  readMetadataRef,
  writeMetadataRef,
} from '../../src/lib/engine/metadata_ref';
import {
  historyFingerprint,
  ordinaryHistory,
  resolveCommitRefs,
  reusableAcross,
} from '../../src/lib/engine/validation_cache';
import { getGitCommonDir } from '../../src/lib/git/git_dir';
import { TSplog } from '../../src/lib/utils/splog';

const splog = { debug: () => undefined } as unknown as TSplog;

describe('incremental branch ancestry validation', function () {
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
  const load = (fresh = false, trunks: string[] = []) => {
    if (fresh) fs.rmSync(cacheFile(), { force: true });
    const loader = composeCacheLoader(splog);
    const branches = loader.loadCachedBranches('main', trunks);
    loader.persistCache('main', branches, trunks);
    return { branches, hit: loader.lastLoadUsedPersistedCache() };
  };
  const matchesRebuild = (trunks: string[] = []) => {
    const incremental = load(false, trunks);
    const cache = fs.readFileSync(cacheFile());
    const refs = git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/branch-metadata/',
    ]);
    expect(incremental.branches).to.deep.equal(load(true, trunks).branches);
    expect(
      git([
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/branch-metadata/',
      ])
    ).to.equal(refs);
    fs.writeFileSync(cacheFile(), cache);
    return incremental;
  };
  const trace = (fn: () => unknown): string[][] => {
    const file = path.join(root, 'trace.jsonl');
    fs.rmSync(file, { force: true });
    process.env.GIT_TRACE2_EVENT = file;
    try {
      fn();
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
    }
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start')
      .map((event) => event.argv.slice(1));
  };
  const merges = (commands: string[][]) =>
    commands.filter((args) => args[0] === 'merge-base');
  const onlyWalks = (commands: string[][], sha: string) =>
    merges(commands).every((args) => args.includes(sha));
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
  const seed = () => {
    git(['update-ref', 'refs/heads/main', commit()]);
    const a = branch('a', 'main'),
      b = branch('b', 'a'),
      c = branch('c', 'b'),
      d = branch('d', 'main');
    return { a, b, c, d };
  };
  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    serial = 0;
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-validation-'))
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
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reuses ancestry but reloads changed PR metadata and rebuilds child lists', () => {
    seed();
    const initial = trace(() => load());
    expect(merges(initial)).to.have.length(4);
    expect(load().hit).to.equal(true);
    writeMetadataRef('b', {
      ...readMetadataRef('b'),
      prInfo: { title: 'new title', body: 'new body', isDraft: true },
    });
    let actual: ReturnType<typeof load> | undefined;
    const commands = trace(() => {
      actual = load();
    });
    expect(actual!.hit).to.equal(false);
    expect(actual!.branches.b.prInfo?.title).to.equal('new title');
    expect(actual!.branches.a.children).to.deep.equal(['b']);
    expect(merges(commands)).to.have.length(0);
    matchesRebuild();
  });

  it('revalidates changed branch/parent IDs without rechecking unrelated branches', () => {
    const original = seed();
    load();
    const next = commit(original.a);
    git(['update-ref', 'refs/heads/a', next]);
    const calls = trace(() => load());
    // a moved; b must check both its recorded base and a's new head. c/d reuse.
    expect(merges(calls)).to.have.length(3);
    const actual = matchesRebuild().branches;
    expect(actual.a.branchRevision).to.equal(next);
    expect(actual.b.validationResult).to.equal('VALID');
    expect(actual.c.validationResult).to.equal('VALID');
  });

  it('propagates invalid parents and restores validity after reparenting back', () => {
    const original = seed();
    load();
    const old = readMetadataRef('b');
    writeMetadataRef('b', {
      parentBranchName: 'd',
      parentBranchRevision: original.d,
    });
    const invalid = matchesRebuild().branches;
    expect(invalid.b.validationResult).to.equal('BAD_PARENT_REVISION');
    expect(invalid.c.validationResult).to.equal('INVALID_PARENT');
    writeMetadataRef('b', old);
    expect(matchesRebuild().branches.c.validationResult).to.equal('VALID');
  });

  it('still detects cycles even when all involved branches have old valid proofs', () => {
    const original = seed();
    load();
    writeMetadataRef('a', {
      parentBranchName: 'c',
      parentBranchRevision: original.c,
    });
    expect(() => load()).to.throw('Cycle detected in Graphite metadata');
    expect(() => load(true)).to.throw('Cycle detected in Graphite metadata');
  });

  it('cleans orphan metadata, invalidates missing parents, and prunes removed proofs', () => {
    seed();
    load();
    git(['update-ref', '-d', 'refs/heads/a']);
    const actual = matchesRebuild().branches;
    expect(actual.b.validationResult).to.equal('BAD_PARENT_NAME');
    expect(actual.c.validationResult).to.equal('INVALID_PARENT');
    expect(readMetadataRef('a')).to.deep.equal({});
    const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(
      persisted.validation.proofs.some((p: string[]) => p[0] === 'a')
    ).to.equal(false);
  });

  it('does not replace parent-revision auto-repair with a cached read-only result', () => {
    const trunk = commit();
    git(['update-ref', 'refs/heads/main', trunk]);
    git(['update-ref', 'refs/heads/a', trunk]);
    writeMetadataRef('a', {
      parentBranchName: 'main',
      parentBranchRevision: trunk,
    });
    const b = branch('b', 'a');
    load();
    git(['update-ref', 'refs/heads/a', b]);
    const calls = trace(() => load());
    expect(
      calls.some(
        (args) =>
          args[0] === 'update-ref' && args[1] === 'refs/branch-metadata/b'
      )
    ).to.equal(true);
    expect(readMetadataRef('b').parentBranchRevision).to.equal(b);
    matchesRebuild();
  });

  it('rebuilds trunk classification instead of caching parent/trunk validity', () => {
    seed();
    load();
    expect(matchesRebuild(['b']).branches.b.validationResult).to.equal('TRUNK');
    expect(matchesRebuild().branches.b.validationResult).to.equal('VALID');
  });

  describe('refs changed by another worktree during a locked command', () => {
    /** A locked command loads, another worktree changes refs, then the
     * command persists. The full cache must not be stamped, but per-branch
     * proofs (keyed on immutable commit IDs) must survive. */
    const concurrently = (change: () => void) => {
      const loader = composeCacheLoader(splog);
      const branches = loader.loadCachedBranches('main', []);
      change();
      loader.persistCache('main', branches, []);
      return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    };

    it('keeps proofs for untouched branches and walks only the moved one', () => {
      const original = seed();
      load();
      const moved = commit(git(['rev-parse', 'main']));
      const persisted = concurrently(() =>
        git(['update-ref', 'refs/heads/d', moved])
      );
      expect(persisted.sha).to.equal('0'.repeat(40));
      expect(persisted.validation.history).to.equal('full');
      expect(
        persisted.validation.proofs.map((p: string[]) => p[0]).sort()
      ).to.deep.equal(['a', 'b', 'c', 'd']);
      const calls = trace(() => load());
      expect(merges(calls)).to.have.length(1);
      expect(onlyWalks(calls, moved)).to.equal(true);
      expect(matchesRebuild().branches.d.branchRevision).to.equal(moved);
      expect(original.a).to.equal(git(['rev-parse', 'a']));
    });

    it('re-validates a concurrently rewritten branch instead of trusting its old proof', () => {
      const original = seed();
      load();
      // b no longer contains a: its recorded parent revision is not in its
      // history, so it must become BAD_PARENT_REVISION, and c INVALID_PARENT.
      concurrently(() =>
        git(['update-ref', 'refs/heads/b', commit(git(['rev-parse', 'main']))])
      );
      const actual = matchesRebuild().branches;
      expect(actual.b.validationResult).to.equal('BAD_PARENT_REVISION');
      expect(actual.c.validationResult).to.equal('INVALID_PARENT');
      expect(actual.a.branchRevision).to.equal(original.a);
    });

    it('re-validates a concurrent re-parent instead of trusting its old proof', () => {
      const original = seed();
      load();
      concurrently(() =>
        writeMetadataRef('b', {
          parentBranchName: 'd',
          parentBranchRevision: original.d,
        })
      );
      const actual = matchesRebuild().branches;
      expect(actual.b.validationResult).to.equal('BAD_PARENT_REVISION');
      expect(actual.c.validationResult).to.equal('INVALID_PARENT');
    });

    it('handles a concurrent delete and same-name recreate exactly like a rebuild', () => {
      seed();
      load();
      concurrently(() => {
        git(['update-ref', '-d', 'refs/heads/a']);
        branch('a', 'd');
      });
      const actual = matchesRebuild().branches;
      expect(actual.a).to.include({ parentBranchName: 'd' });
      expect(actual.a.validationResult).to.equal('VALID');
      // b still contains the old a, so it stays VALID (it needs a restack).
      expect(actual.b.validationResult).to.equal('VALID');
    });

    it('still drops proofs when the history becomes unfingerprintable mid-command', () => {
      const original = seed();
      load();
      const persisted = concurrently(() => {
        git(['update-ref', 'refs/heads/d', commit(original.a)]);
        fs.writeFileSync(
          path.join(root, '.git/info/grafts'),
          `${original.b} ${git(['rev-parse', 'main'])}\n`
        );
      });
      expect(persisted.sha).to.equal('0'.repeat(40));
      expect(persisted.validation.history).to.equal('');
      expect(persisted.validation.proofs).to.deep.equal([]);
    });
  });

  it('accepts old cache files and discards malformed proof records safely', () => {
    seed();
    load();
    const file = cacheFile();
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete old.validation;
    fs.writeFileSync(file, JSON.stringify(old));
    writeMetadataRef('b', {
      ...readMetadataRef('b'),
      prInfo: { title: 'invalidate full cache' },
    });
    expect(merges(trace(() => load()))).to.have.length(4);
    const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
    bad.validation.proofs[0][1] = 'not-a-commit-id';
    fs.writeFileSync(file, JSON.stringify(bad));
    expect(merges(trace(() => load()))).to.have.length(4);
    matchesRebuild();
  });

  it('does not let short-ref ambiguity turn cached branch-head proofs into tag proofs', () => {
    seed();
    load();
    // Git's own refname:short and resolver decide what names mean, including
    // ambiguity modes. No direct loose-ref/packed-ref parser is substituted.
    git(['tag', 'b', 'main']);
    git(['config', 'core.warnAmbiguousRefs', 'false']);
    writeMetadataRef('d', {
      ...readMetadataRef('d'),
      prInfo: { title: 'invalidate full cache' },
    });
    matchesRebuild();
    expect(resolveCommitRefs(['main']).get('main')).to.equal(
      git(['rev-parse', 'main'])
    );
    expect(resolveCommitRefs(['does-not-exist']).size).to.equal(0);
  });

  it('invalidates even a full-cache hit when packed replacement refs change ancestry', () => {
    const original = seed();
    load();
    git(['replace', original.b, commit(git(['rev-parse', 'main']))]);
    git(['pack-refs', '--all']);
    const changed = matchesRebuild();
    expect(changed.hit).to.equal(false);
    expect(changed.branches.b.validationResult).to.equal('BAD_PARENT_REVISION');
    expect(changed.branches.c.validationResult).to.equal('INVALID_PARENT');
    expect(merges(trace(() => load())).length).to.be.greaterThan(0);
    expect(
      JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).validation.proofs
    ).to.deep.equal([]);
    git(['replace', '-d', original.b]);
    expect(matchesRebuild().branches.b.validationResult).to.equal('VALID');
  });

  it('does not bless history overrides removed between load and persist', () => {
    seed();
    const grafts = path.join(root, '.git/info/grafts');
    fs.writeFileSync(grafts, '');
    const loader = composeCacheLoader(splog);
    const branches = loader.loadCachedBranches('main');
    fs.unlinkSync(grafts);
    loader.persistCache('main', branches);
    expect(load().hit).to.equal(false);
  });

  it('reuses proofs within a shallow boundary and, accepting staleness, across boundary moves', () => {
    const original = seed();
    load();
    const shallow = path.join(root, '.git/shallow');
    const onlyB = (commands: string[][]) => onlyWalks(commands, original.b);

    // Accepted trade-off (matches upstream Graphite): a new boundary changes
    // no commit ID, so full-history proofs keep answering. b stays VALID
    // although a from-scratch load behind the boundary says
    // BAD_PARENT_REVISION. Only the full-cache stamp is dropped.
    fs.writeFileSync(shallow, original.b + '\n');
    let stale: ReturnType<typeof load> | undefined;
    expect(merges(trace(() => (stale = load())))).to.be.empty;
    expect(stale?.hit).to.equal(false);
    expect(stale?.branches.b.validationResult).to.equal('VALID');
    expect(load().hit).to.equal(true);
    expect(
      JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).validation.history
    ).to.match(/^shallow:[0-9a-f]{40}$/);

    // A cold load validates under the boundary, and a merge base that does
    // not exist is a validation result, not a fatal git error.
    const cold = load(true);
    expect(cold.branches.b.validationResult).to.equal('BAD_PARENT_REVISION');
    expect(cold.branches.a.validationResult).to.equal('VALID');
    expect(cold.branches.d.validationResult).to.equal('VALID');
    // Same boundary: repeat commands are full-cache hits with no walks.
    expect(merges(trace(() => load()))).to.be.empty;
    expect(matchesRebuild().hit).to.equal(true);

    // A metadata-only change misses the full cache but reuses the proofs;
    // only b, whose negative result is never cached, is walked again.
    writeMetadataRef('d', {
      ...readMetadataRef('d'),
      prInfo: { title: 'invalidate full cache' },
    });
    const partial = trace(() => load());
    expect(merges(partial)).not.to.be.empty;
    expect(onlyB(partial)).to.equal(true);
    expect(matchesRebuild().hit).to.equal(true);

    // Deepening (boundary moves to the root) keeps a and d's proofs; b is
    // re-walked and is VALID again, matching a from-scratch rebuild.
    fs.writeFileSync(shallow, git(['rev-parse', 'main']) + '\n');
    const deepened = trace(() => load());
    expect(onlyB(deepened)).to.equal(true);
    expect(matchesRebuild().branches.b.validationResult).to.equal('VALID');
    expect(merges(trace(() => load()))).to.be.empty;

    // Unshallowing reuses every proof without a single walk.
    fs.unlinkSync(shallow);
    let full: ReturnType<typeof load> | undefined;
    expect(merges(trace(() => (full = load())))).to.be.empty;
    expect(full?.hit).to.equal(false);
    expect(load().hit).to.equal(true);
    expect(
      JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).validation.history
    ).to.equal('full');
  });

  it('does not reuse proofs across graft changes', () => {
    const original = seed();
    load();
    fs.writeFileSync(
      path.join(root, '.git/info/grafts'),
      `${original.b} ${git(['rev-parse', 'main'])}\n`
    );
    expect(matchesRebuild().hit).to.equal(false);
    expect(ordinaryHistory(false)).to.equal(false);
    expect(historyFingerprint(false)).to.equal(undefined);
    expect(
      JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).validation
    ).to.deep.include({ history: '', proofs: [] });
    // Removing the grafts does not resurrect proofs made under them.
    fs.unlinkSync(path.join(root, '.git/info/grafts'));
    expect(merges(trace(() => load())).length).to.be.greaterThan(0);
  });

  it('does not stamp the full cache when the shallow boundary moves mid-command', () => {
    const original = seed();
    const shallow = path.join(root, '.git/shallow');
    for (const readOnly of [false, true]) {
      fs.rmSync(cacheFile(), { force: true });
      fs.writeFileSync(shallow, original.b + '\n');
      const loader = composeCacheLoader(splog, { readOnly });
      const branches = loader.loadCachedBranches('main');
      fs.writeFileSync(shallow, original.a + '\n');
      loader.persistCache('main', branches);
      const persisted = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      expect(persisted.sha, String(readOnly)).to.equal('0'.repeat(40));
      // Per-branch proofs still carry over, stamped with the new boundary.
      expect(persisted.validation.proofs, String(readOnly)).not.to.be.empty;
      expect(persisted.validation.history, String(readOnly)).to.equal(
        historyFingerprint(false)
      );
      fs.writeFileSync(shallow, original.b + '\n');
      const next = trace(() => load());
      expect(onlyWalks(next, original.b), String(readOnly)).to.equal(true);
      expect(load().hit, String(readOnly)).to.equal(true);
    }
  });

  it('fingerprints the shallow boundary by content, not by presence', () => {
    const original = seed();
    expect(historyFingerprint(false)).to.equal('full');
    const shallow = path.join(root, '.git/shallow');
    fs.writeFileSync(shallow, original.b + '\n');
    const first = historyFingerprint(false);
    expect(first).to.match(/^shallow:/);
    expect(ordinaryHistory(false)).to.equal(false);
    fs.writeFileSync(shallow, original.b + '\n');
    expect(historyFingerprint(false)).to.equal(first);
    fs.writeFileSync(shallow, `${original.a}\n${original.b}\n`);
    expect(historyFingerprint(false)).not.to.equal(first);
    expect(historyFingerprint(true)).to.equal(undefined);
    fs.unlinkSync(shallow);
    fs.mkdirSync(shallow);
    expect(historyFingerprint(false)).to.equal(undefined);

    const at = first ?? '';
    const other = at.replace(/.$/, at.endsWith('0') ? '1' : '0');
    expect(reusableAcross('full', 'full')).to.equal(true);
    expect(reusableAcross(at, at)).to.equal(true);
    expect(reusableAcross('full', at)).to.equal(true);
    expect(reusableAcross(at, 'full')).to.equal(true);
    expect(reusableAcross(at, other)).to.equal(true);
    expect(reusableAcross('', '')).to.equal(false);
    expect(reusableAcross('', 'full')).to.equal(false);
    expect(reusableAcross('full', '')).to.equal(false);
  });

  it('takes the conservative path for custom object stores and namespaces', () => {
    seed();
    expect(ordinaryHistory(false)).to.equal(true);
    for (const key of [
      'GIT_REPLACE_REF_BASE',
      'GIT_GRAFT_FILE',
      'GIT_SHALLOW_FILE',
      'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]) {
      process.env[key] = '';
      expect(ordinaryHistory(false), key).to.equal(false);
      delete process.env[key];
    }
    fs.writeFileSync(path.join(root, '.git/objects/info/alternates'), '');
    expect(ordinaryHistory(false)).to.equal(false);
    fs.unlinkSync(path.join(root, '.git/objects/info/alternates'));
    fs.writeFileSync(path.join(root, '.git/objects/pack/test.promisor'), '');
    expect(ordinaryHistory(false)).to.equal(false);
  });

  it('shares immutable proofs across linked worktrees using the common Git directory', () => {
    seed();
    load();
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'main']);
    process.chdir(linked);
    expect(load().hit).to.equal(true);
    writeMetadataRef('b', {
      ...readMetadataRef('b'),
      prInfo: { title: 'linked edit' },
    });
    expect(merges(trace(() => load()))).to.have.length(0);
    matchesRebuild();
  });

  for (const format of ['--object-format=sha256', '--ref-format=reftable']) {
    it(`supports repository format ${format} when supported by Git`, function () {
      fs.rmSync(path.join(root, '.git'), { recursive: true });
      const result = spawnSync('git', ['init', format, '-b', 'main'], {
        encoding: 'utf8',
      });
      if (result.status !== 0) this.skip();
      seed();
      load();
      writeMetadataRef('b', {
        ...readMetadataRef('b'),
        prInfo: { title: format },
      });
      expect(merges(trace(() => load()))).to.have.length(0);
      matchesRebuild();
    });
  }
});
