import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { workspaceSnapshot } from '../../src/lib/operations/journal';

describe('operation journal workspace snapshots', function () {
  this.timeout(30_000);
  let root: string, repo: string, cwd: string, savedEnv: NodeJS.ProcessEnv;
  const git = (args: string[], env = process.env): string =>
    execFileSync('git', args, { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const file = (name: string, content = name + '\n'): void => {
    const target = path.join(repo, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  // Keep full-tree git add as an independent semantic oracle. Git (not a JS
  // index implementation) owns filters, ignores, executable bits, symlinks,
  // sparse entries, and intent-to-add semantics.
  function fullTreeSnapshot(): ReturnType<typeof workspaceSnapshot> {
    const directory = fs.mkdtempSync(path.join(root, 'oracle-'));
    const index = path.resolve(git(['rev-parse', '--git-path', 'index']));
    const temporary = path.join(directory, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: temporary };
    try {
      if (fs.existsSync(index)) {
        const stat = fs.statSync(index);
        fs.copyFileSync(index, temporary);
        // The index timestamp participates in Git's racy-clean checks. A
        // fresh timestamp would let this oracle skip files Git must recheck.
        fs.utimesSync(temporary, stat.atimeMs / 1000, stat.mtimeMs / 1000);
      } else git(['read-tree', '--empty'], env);
      execFileSync('git', ['add', '--all', '--', '.'], {
        cwd: git(['rev-parse', '--show-toplevel']),
        env,
        stdio: 'pipe',
      });
      return {
        index: git(['write-tree']),
        worktree: git(['write-tree'], env),
      };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  function matchesOracle(): void {
    const staged = git(['ls-files', '--stage', '-z']);
    const expected = fullTreeSnapshot();
    expect(workspaceSnapshot()).to.deep.equal(expected);
    expect(git(['ls-files', '--stage', '-z'])).to.equal(staged);
    expect(workspaceSnapshot()).to.deep.equal(expected); // cached status/index
  }

  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-snapshot-'))
    );
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    Object.assign(process.env, {
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'file',
    });
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_LITERAL_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_ICASE_PATHSPECS',
    ]) {
      delete process.env[key];
    }
    process.chdir(repo);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Snapshot test']);
    git(['config', 'user.email', 'snapshot@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.filemode', 'true']);
    file('tracked.txt', 'original\n');
    file('kept/file.txt');
    file('other/file.txt');
    file('.gitignore', '*.ignored\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('preserves a clean tree without changing the staged entries', () => {
    matchesOracle();
  });
  it('preserves staged changes separately from later edits and untracked files', () => {
    file('tracked.txt', 'staged\n');
    git(['add', 'tracked.txt']);
    file('tracked.txt', 'unstaged\n');
    file('new/nested.txt');
    file('keep.ignored');
    matchesOracle();
  });
  it('handles staged additions, deletions, renames, and unstaged deletions', () => {
    git(['mv', 'tracked.txt', 'renamed.txt']);
    file('renamed.txt', 'changed after rename\n');
    git(['rm', 'other/file.txt']);
    fs.unlinkSync(path.join(repo, 'kept/file.txt'));
    file('added.txt');
    git(['add', 'added.txt']);
    matchesOracle();
  });
  it('handles replacing a tracked file with a directory and a directory with a file', () => {
    fs.unlinkSync(path.join(repo, 'tracked.txt'));
    file('tracked.txt/child.txt');
    fs.rmSync(path.join(repo, 'kept'), { recursive: true });
    file('kept', 'now a file\n');
    matchesOracle();
  });
  it('treats every pathname literally, including whitespace, newlines, and pathspec magic', () => {
    for (const name of [
      '-dash',
      ' space ',
      'tab\tname',
      'line\nbreak',
      'quote"name',
      ':(glob)*',
      '[abc]',
      '*',
      'emoji-🦕',
    ])
      file(name);
    process.env.GIT_GLOB_PATHSPECS = '1';
    matchesOracle();
  });
  it('preserves non-UTF-8 filenames without replacement-character corruption', function () {
    if (process.platform === 'win32') this.skip();
    const target = Buffer.concat([
      Buffer.from(repo + '/bytes-'),
      Buffer.from([0xff]),
    ]);
    try {
      fs.writeFileSync(target, 'raw filename\n');
    } catch (error) {
      if (error.code === 'EILSEQ') this.skip(); // APFS requires valid UTF-8.
      throw error;
    }
    matchesOracle();
    expect(fs.readFileSync(target, 'utf8')).to.equal('raw filename\n');
  });
  it('uses the full-tree fallback for replacement-character filenames', () => {
    file('replacement-\uFFFD');
    matchesOracle();
  });
  for (const optionalLocks of ['0', '1']) {
    for (const mode of ['normal', 'racy', 'racy fallback']) {
      it(`applies Git clean filters and line-ending conversion (${mode}, optional locks ${optionalLocks})`, () => {
        process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
        if (mode !== 'normal') {
          // Record old file mtimes before enabling filters, so a freshly
          // copied index would consider these entries non-racy and skip them.
          for (const name of ['kept/file.txt', 'other/file.txt'])
            fs.utimesSync(path.join(repo, name), 2, 2);
          git(['add', 'kept/file.txt', 'other/file.txt']);
        }
        file('.gitattributes', '*.txt text eol=lf filter=upper\n');
        git(['config', 'filter.upper.clean', 'tr a-z A-Z']);
        git(['config', 'filter.upper.smudge', 'cat']);
        file('tracked.txt', 'lowercase\r\n');
        file('new.txt', 'new lowercase\r\n');
        if (mode === 'racy fallback') file('replacement-\uFFFD');
        if (mode !== 'normal') {
          // Force racy entries without sleeps or wall-clock boundary luck.
          // Copying this index without its mtime makes them look non-racy.
          fs.utimesSync(git(['rev-parse', '--git-path', 'index']), 1, 1);
        }
        matchesOracle();
        const snapshot = workspaceSnapshot();
        const content = (name: string) =>
          execFileSync('git', ['show', `${snapshot.worktree}:${name}`], {
            encoding: 'utf8',
            stdio: 'pipe',
          });
        expect(content('tracked.txt')).to.equal('LOWERCASE\n');
        expect(content('new.txt')).to.equal('NEW LOWERCASE\n');
        if (mode !== 'normal') {
          expect(content('kept/file.txt')).to.equal('KEPT/FILE.TXT\n');
          expect(content('other/file.txt')).to.equal('OTHER/FILE.TXT\n');
        }
      });
    }
  }
  it('preserves executable and symlink changes', function () {
    if (process.platform === 'win32') this.skip();
    fs.chmodSync(path.join(repo, 'tracked.txt'), 0o755);
    fs.symlinkSync('tracked.txt', path.join(repo, 'link'));
    git(['add', 'link']);
    fs.unlinkSync(path.join(repo, 'link'));
    fs.symlinkSync('kept/file.txt', path.join(repo, 'link'));
    matchesOracle();
  });
  it('handles intent-to-add without changing the real index', () => {
    file('intent.txt');
    git(['add', '-N', 'intent.txt']);
    matchesOracle();
  });
  it('honors assume-unchanged and skip-worktree entries', () => {
    git(['update-index', '--assume-unchanged', 'tracked.txt']);
    git(['update-index', '--skip-worktree', 'kept/file.txt']);
    file('tracked.txt', 'not staged by add --all\n');
    file('kept/file.txt', 'not staged by add --all either\n');
    matchesOracle();
  });
  it('honors sparse checkouts without materializing excluded paths', () => {
    git(['sparse-checkout', 'init', '--cone']);
    git(['sparse-checkout', 'set', 'kept']);
    file('kept/new.txt');
    file('kept/file.txt', 'changed\n');
    matchesOracle();
    expect(fs.existsSync(path.join(repo, 'other/file.txt'))).to.equal(false);
  });
  it('handles sparse indexes and materialized out-of-cone tracked files', () => {
    git(['sparse-checkout', 'init', '--cone', '--sparse-index']);
    git(['sparse-checkout', 'set', 'kept']);
    file('other/file.txt', 'materialized edit\n');
    file('kept/file.txt', 'inside cone\n');
    matchesOracle();
  });
  it('takes a whole-repository snapshot when invoked from a subdirectory', () => {
    file('tracked.txt', 'outside cwd\n');
    file('kept/new.txt');
    process.chdir(path.join(repo, 'kept'));
    matchesOracle();
  });
  it('respects a caller-selected index', () => {
    const index = path.join(root, 'alternate-index');
    fs.copyFileSync(path.join(repo, '.git/index'), index);
    process.env.GIT_INDEX_FILE = index;
    file('tracked.txt', 'alternate staged content\n');
    git(['add', 'tracked.txt']);
    matchesOracle();
    delete process.env.GIT_INDEX_FILE;
    expect(git(['show', ':tracked.txt'])).to.equal('original');
  });
  it('resolves a relative alternate index from the original subdirectory', () => {
    const index = path.join(root, 'alternate-index');
    fs.copyFileSync(path.join(repo, '.git/index'), index);
    process.chdir(path.join(repo, 'kept'));
    process.env.GIT_INDEX_FILE = path.relative(process.cwd(), index);
    // The selected index tracks an ignored file; querying status with the
    // default/wrong index would silently omit its subsequent unstaged edit.
    file('tracked.ignored', 'staged ignored content\n');
    git(['add', '-f', '../tracked.ignored']);
    file('tracked.ignored', 'unstaged ignored content\n');
    matchesOracle();
  });
  it('supports split and version-4 indexes', () => {
    git(['update-index', '--index-version=4', '--split-index']);
    file('tracked.txt', 'changed\n');
    file('new.txt');
    matchesOracle();
  });
  it('does not resolve conflicts or change unmerged index entries', () => {
    git(['checkout', '-b', 'other']);
    file('tracked.txt', 'other branch\n');
    git(['commit', '-am', 'other']);
    git(['checkout', 'main']);
    file('tracked.txt', 'main branch\n');
    git(['commit', '-am', 'main']);
    expect(() => git(['merge', 'other'])).to.throw();
    const staged = git(['ls-files', '--stage', '-z']);
    const contents = fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8');
    expect(() => fullTreeSnapshot()).to.throw();
    expect(() => workspaceSnapshot()).to.throw();
    expect(git(['ls-files', '--stage', '-z'])).to.equal(staged);
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).to.equal(
      contents
    );
  });
  it('handles a missing index', () => {
    fs.unlinkSync(path.join(repo, '.git/index'));
    matchesOracle();
  });
  it('keeps nested repositories as gitlinks rather than adding their files', () => {
    file('nested/content.txt');
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: path.join(repo, 'nested'),
      stdio: 'pipe',
    });
    execFileSync('git', ['add', '.'], {
      cwd: path.join(repo, 'nested'),
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'nested',
      ],
      { cwd: path.join(repo, 'nested'), stdio: 'pipe' }
    );
    matchesOracle();
  });
});
