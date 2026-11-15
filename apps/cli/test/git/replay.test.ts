import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { replayBranch, resetReplayEligibility } from '../../src/lib/git/replay';

/** Oracle: with a pinned committer, a plumbing replay must produce the exact
 * commit objects `git rebase --onto` produces, or decline and leave the
 * repository untouched so `git rebase` runs as before.
 */
describe('restack without checkout', function () {
  this.timeout(30_000);
  let root: string,
    repo: string,
    oracle: string,
    cwd: string,
    saved: NodeJS.ProcessEnv;
  const pinned = {
    GIT_COMMITTER_NAME: 'Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_COMMITTER_DATE: '1700000000 +0000',
  };
  const git = (
    args: string[],
    directory = repo,
    env: NodeJS.ProcessEnv = process.env
  ): string =>
    execFileSync('git', args, {
      cwd: directory,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).replace(/\n$/, '');
  const write = (name: string, content: string, directory = repo) => {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  };
  const commit = (
    message: string,
    files: Record<string, string | null>,
    opts: { author?: string; date?: string } = {}
  ) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) git(['rm', '-q', name]);
      else {
        write(name, content);
        git(['add', name]);
      }
    }
    git(
      [
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
        ...(opts.author ? ['--author', opts.author] : []),
      ],
      repo,
      {
        ...process.env,
        ...(opts.date ? { GIT_AUTHOR_DATE: opts.date } : {}),
      }
    );
    return git(['rev-parse', 'HEAD']);
  };
  /** Run git rebase in a throwaway copy and return the resulting branch tip. */
  const rebaseOracle = (
    branch: string,
    onto: string,
    from: string,
    extra: string[] = []
  ): { tip: string; status: number } => {
    fs.rmSync(oracle, { recursive: true, force: true });
    execFileSync('cp', ['-R', repo, oracle]);
    const result = spawnSync(
      'git',
      ['rebase', ...extra, '--onto', onto, from, branch],
      {
        cwd: oracle,
        env: process.env,
        encoding: 'utf8',
      }
    );
    return {
      tip: git(['rev-parse', `refs/heads/${branch}`], oracle),
      status: result.status ?? 1,
    };
  };
  const state = () => ({
    head: git(['symbolic-ref', '-q', 'HEAD']),
    refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(['write-tree']),
    status: git(['status', '--porcelain=v1', '-z']),
  });

  beforeEach(() => {
    cwd = process.cwd();
    saved = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-replay-'))
    );
    repo = path.join(root, 'repo');
    oracle = path.join(root, 'oracle');
    fs.mkdirSync(repo);
    Object.assign(process.env, {
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_AUTHOR_DATE: '1600000000 +0100',
      ...pinned,
    });
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
      delete process.env[key];
    process.chdir(repo);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    commit('base', { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
    git(['checkout', '-q', '-b', 'feature']);
    commit(
      'feature one',
      { 'a.txt': 'a\nfeature\n' },
      {
        author: 'Someone Else <else@example.invalid>',
        date: '1650000000 -0500',
      }
    );
    commit(
      'feature two\n\nBody with trailer.\n\nSigned-off-by: X <x@example.invalid>\n',
      { 'dir/c.txt': 'c\n', 'dir/b.txt': null }
    );
    git(['checkout', '-q', 'main']);
    commit('trunk moves on', { 'trunk.txt': 'trunk\n' });
    git(['checkout', '-q', '-b', 'other']);
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => resetReplayEligibility());
  const replay = (
    branch = 'feature',
    onto = 'main',
    from = git(['rev-parse', 'main~1']),
    current: string | undefined = 'other',
    extra = {}
  ) =>
    replayBranch({
      branchName: branch,
      onto,
      from,
      currentBranch: current,
      ...extra,
    });

  it('produces byte-identical commits to git rebase --onto and leaves the checkout alone', () => {
    const from = git(['rev-parse', 'main~1']);
    const before = state();
    const oldTip = git(['rev-parse', 'feature']);
    const expected = rebaseOracle('feature', 'main', from);
    expect(expected.status).to.equal(0);
    expect(replay('feature', 'main', from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
    expect(git(['rev-parse', 'ORIG_HEAD'])).to.equal(oldTip);
    const after = state();
    expect(after.head).to.equal(before.head);
    expect(after.index).to.equal(before.index);
    expect(after.status).to.equal(before.status);
    expect(git(['log', '-1', '--format=%an <%ae> %ad', 'feature~1'])).to.equal(
      git(['log', '-1', '--format=%an <%ae> %ad', 'feature~1'], oracle)
    );
    expect(git(['reflog', 'show', '--format=%gs', 'feature'])).to.contain(
      'rebase (finish)'
    );
  });
  it('keeps commits that started empty and drops commits that become empty, like rebase', () => {
    git(['checkout', '-q', 'feature']);
    commit('deliberately empty', {});
    git(['checkout', '-q', 'main']);
    commit('same change lands on trunk', {
      'dir/c.txt': 'c\n',
      'dir/b.txt': null,
    });
    git(['checkout', '-q', 'other']);
    const from = git(['rev-parse', 'main~2']);
    const expected = rebaseOracle('feature', 'main', from);
    expect(expected.status).to.equal(0);
    expect(
      git(['log', '--format=%s', 'main..feature'], oracle).split('\n')
    ).to.deep.equal(['deliberately empty', 'feature one']);
    expect(replay('feature', 'main', from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
  });
  it('supports committer-date-is-author-date exactly like the rebase option', () => {
    const from = git(['rev-parse', 'main~1']);
    const expected = rebaseOracle('feature', 'main', from, [
      '--committer-date-is-author-date',
    ]);
    expect(expected.status).to.equal(0);
    expect(
      replay('feature', 'main', from, 'other', {
        restackCommitterDateIsAuthorDate: true,
      })
    ).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
  });
  for (const ontoRevision of ['main~1', 'feature~1']) {
    for (const withEmptyCommit of [false, true]) {
      for (const authorDate of [false, true]) {
        it(`matches rebase commit reuse onto ${ontoRevision} (empty=${withEmptyCommit}, authorDate=${authorDate})`, () => {
          const from = git(['rev-parse', 'main~1']);
          const onto = git(['rev-parse', ontoRevision]);
          if (withEmptyCommit) {
            git(['checkout', '-q', 'feature']);
            commit('deliberately empty', {});
            commit('after empty', { 'after.txt': 'after\n' });
            git(['checkout', '-q', 'other']);
          }
          const oldTip = git(['rev-parse', 'feature']);
          const before = state();
          // Recreating an unchanged commit with the setup identity/date would
          // produce the same SHA and hide a missing fast-forward optimization.
          Object.assign(process.env, {
            GIT_COMMITTER_NAME: 'Later Committer',
            GIT_COMMITTER_EMAIL: 'later@example.invalid',
            GIT_COMMITTER_DATE: '1800000000 +0000',
          });
          const expected = rebaseOracle(
            'feature',
            onto,
            from,
            authorDate ? ['--committer-date-is-author-date'] : []
          );
          expect(expected.status).to.equal(0);
          if (authorDate) expect(expected.tip).not.to.equal(oldTip);
          else expect(expected.tip).to.equal(oldTip);
          expect(
            replay('feature', onto, from, 'other', {
              restackCommitterDateIsAuthorDate: authorDate,
            })
          ).to.equal('REBASE_DONE');
          expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
          expect(git(['rev-parse', 'ORIG_HEAD'])).to.equal(oldTip);
          const after = state();
          expect(after.head).to.equal(before.head);
          expect(after.index).to.equal(before.index);
          expect(after.status).to.equal(before.status);
        });
      }
    }
  }
  it('rewrites rather than fast-forwards when only the parent tree matches', () => {
    const from = git(['rev-parse', 'main~1']);
    const oldTip = git(['rev-parse', 'feature']);
    const onto = git([
      'commit-tree',
      'feature~1^{tree}',
      '-p',
      from,
      '-m',
      'same tree, different commit',
    ]);
    process.env.GIT_COMMITTER_DATE = '1800000000 +0000';
    const expected = rebaseOracle('feature', onto, from);
    expect(expected.status).to.equal(0);
    expect(expected.tip).not.to.equal(oldTip);
    expect(replay('feature', onto, from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
  });
  it('does not recreate commits when the new base already includes the entire branch', () => {
    const from = git(['rev-parse', 'main~1']);
    const oldTip = git(['rev-parse', 'feature']);
    process.env.GIT_COMMITTER_DATE = '1800000000 +0000';
    const expected = rebaseOracle('feature', oldTip, from);
    expect(expected.status).to.equal(0);
    expect(expected.tip).to.equal(oldTip);
    expect(replay('feature', oldTip, from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
  });
  it('fast-forwards a branch without its own commits onto the new base', () => {
    git(['branch', 'empty-branch', 'main~1']);
    const from = git(['rev-parse', 'main~1']);
    const expected = rebaseOracle('empty-branch', 'main', from);
    expect(replay('empty-branch', 'main', from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'empty-branch'])).to.equal(expected.tip);
    expect(git(['rev-parse', 'empty-branch'])).to.equal(
      git(['rev-parse', 'main'])
    );
  });
  it('handles renames, mode changes, symlinks, and binary files through the merge machinery', function () {
    if (process.platform === 'win32') this.skip();
    git(['checkout', '-q', '-b', 'rename', 'main~1']);
    git(['mv', 'a.txt', 'renamed.txt']);
    fs.chmodSync(path.join(repo, 'renamed.txt'), 0o755);
    fs.symlinkSync('renamed.txt', path.join(repo, 'link'));
    fs.writeFileSync(
      path.join(repo, 'blob.bin'),
      Buffer.from([0, 1, 2, 255, 254])
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'rename, mode, symlink, binary']);
    git(['checkout', '-q', 'main']);
    commit('trunk edits a.txt', { 'a.txt': 'trunk edit\na\n' });
    git(['checkout', '-q', 'other']);
    const from = git(['rev-parse', 'main~2']);
    const expected = rebaseOracle('rename', 'main', from);
    expect(expected.status).to.equal(0);
    expect(replay('rename', 'main', from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'rename'])).to.equal(expected.tip);
    expect(git(['show', 'rename:renamed.txt'])).to.contain('trunk edit');
    expect(git(['ls-tree', 'rename', 'renamed.txt']).split(' ')[0]).to.equal(
      '100755'
    );
    expect(git(['ls-tree', 'rename', 'link']).split(' ')[0]).to.equal('120000');
  });
  it('reports conflicts without touching refs, index, or working tree', () => {
    git(['checkout', '-q', 'main']);
    commit('conflicting trunk change', { 'a.txt': 'conflict\n' });
    git(['checkout', '-q', 'other']);
    const from = git(['rev-parse', 'main~2']);
    const before = state();
    // The same merge git rebase would run: callers may skip that rebase.
    expect(replay('feature', 'main', from)).to.equal('CONFLICT');
    expect(state()).to.deep.equal(before);
    expect(rebaseOracle('feature', 'main', from).status).to.not.equal(0);
  });
  it('declines for the checked-out branch, merges, non-ancestor bases, and missing refs', () => {
    const from = git(['rev-parse', 'main~1']);
    expect(replay('feature', 'main', from, 'feature')).to.equal('UNSUPPORTED');
    expect(replay('feature', 'main', git(['rev-parse', 'main']))).to.equal(
      'UNSUPPORTED'
    );
    expect(replay('missing', 'main', from)).to.equal('UNSUPPORTED');
    git(['checkout', '-q', 'feature']);
    git(['merge', '-q', '--no-ff', '-m', 'merge trunk', 'main']);
    git(['checkout', '-q', 'other']);
    expect(replay('feature', 'main', from)).to.equal('UNSUPPORTED');
  });
  it('declines when signing, hooks, or rebase configuration would change results', () => {
    const from = git(['rev-parse', 'main~1']);
    const before = state();
    for (const [key, value] of [
      ['commit.gpgsign', 'true'],
      ['rebase.backend', 'apply'],
      ['rebase.updateRefs', 'true'],
      ['rebase.rebaseMerges', 'true'],
      ['notes.rewriteRef', 'refs/notes/commits'],
    ]) {
      git(['config', key, value]);
      resetReplayEligibility();
      expect(replay('feature', 'main', from), key).to.equal('UNSUPPORTED');
      git(['config', '--unset', key]);
    }
    for (const hook of ['pre-rebase', 'post-rewrite']) {
      const hooks = path.join(root, 'no-hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, hook), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      resetReplayEligibility();
      expect(replay('feature', 'main', from), hook).to.equal('UNSUPPORTED');
      fs.unlinkSync(path.join(hooks, hook));
    }
    expect(state()).to.deep.equal(before);
    resetReplayEligibility();
    expect(replay('feature', 'main', from)).to.equal('REBASE_DONE');
  });
  it('declines commits with encoding headers or non-UTF-8 identities and preserves messages verbatim', () => {
    const from = git(['rev-parse', 'main~1']);
    git(['checkout', '-q', 'feature']);
    fs.writeFileSync(
      path.join(root, 'message.txt'),
      'Subject with trailing spaces   \n\n\n  indented body\twith tab\n\n\n'
    );
    write('msg.txt', 'message\n');
    git(['add', 'msg.txt']);
    git([
      'commit',
      '-q',
      '--cleanup=verbatim',
      '-F',
      path.join(root, 'message.txt'),
    ]);
    git(['checkout', '-q', 'other']);
    const expected = rebaseOracle('feature', 'main', from);
    expect(expected.status).to.equal(0);
    expect(replay('feature', 'main', from)).to.equal('REBASE_DONE');
    expect(git(['rev-parse', 'feature'])).to.equal(expected.tip);
    // Now a commit with an explicit encoding header, which rebase re-encodes.
    git(['checkout', '-q', 'feature']);
    git([
      '-c',
      'i18n.commitEncoding=ISO-8859-1',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'latin1 encoded',
    ]);
    git(['checkout', '-q', 'other']);
    expect(git(['cat-file', 'commit', 'feature'])).to.contain(
      'encoding ISO-8859-1'
    );
    expect(replay('feature', 'main', from)).to.equal('UNSUPPORTED');
  });
  it('records rebase-style reflog entries for the rewritten branch', () => {
    const from = git(['rev-parse', 'main~1']);
    expect(replay('feature', 'main', from)).to.equal('REBASE_DONE');
    expect(
      git(['reflog', 'show', '--format=%gs', 'feature']).split('\n')[0]
    ).to.contain('rebase (finish)');
  });
});
