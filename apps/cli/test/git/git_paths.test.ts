import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  getGitPaths,
  getGitDir,
  getGitCommonDir,
  getGitIndexPath,
  getGitTopLevel,
} from '../../src/lib/git/git_dir';
import { Repository } from '../../src/lib/switch/repository';

describe('command-local repository path discovery', function () {
  this.timeout(15_000);
  let root: string, repo: string, cwd: string, savedEnv: NodeJS.ProcessEnv;
  const git = (args: string[], directory = repo): string =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: 'pipe',
    }).replace(/\n$/, '');
  beforeEach(() => {
    cwd = process.cwd();
    savedEnv = { ...process.env };
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-paths-')));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    Object.assign(process.env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    for (const name of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_TRACE2_EVENT',
    ]) {
      delete process.env[name];
    }
    git(['init', '-b', 'main']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const name of Object.keys(process.env))
      if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const matchesGit = () => {
    expect(getGitDir()).to.equal(
      git(['rev-parse', '--git-dir'], process.cwd())
    );
    expect(getGitCommonDir()).to.equal(
      git(['rev-parse', '--git-common-dir'], process.cwd())
    );
    expect(getGitIndexPath()).to.equal(
      path.resolve(git(['rev-parse', '--git-path', 'index'], process.cwd()))
    );
    expect(getGitTopLevel()).to.equal(
      git(['rev-parse', '--show-toplevel'], process.cwd())
    );
  };
  it('shares one directory query and one root query across layers', () => {
    const trace = path.join(root, 'trace.jsonl');
    process.env.GIT_TRACE2_EVENT = trace;
    for (let i = 0; i < 3; i++) {
      const repository = new Repository(repo);
      expect(repository.common).to.equal(path.join(repo, '.git'));
      expect(repository.worktree).to.equal(path.join(repo, '.git'));
      getGitPaths();
      getGitDir();
      getGitCommonDir();
      getGitIndexPath();
      getGitTopLevel();
    }
    delete process.env.GIT_TRACE2_EVENT;
    const calls = fs
      .readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start');
    expect(calls).to.have.length(2);
    matchesGit();
  });
  it('keeps directory spellings compatible from subdirectories', () => {
    fs.mkdirSync(path.join(repo, 'nested'));
    matchesGit();
    process.chdir(path.join(repo, 'nested'));
    matchesGit();
  });
  it('distinguishes linked worktree indexes from their shared directory', () => {
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD']);
    matchesGit();
    process.chdir(linked);
    matchesGit();
    expect(new Repository(linked).common).to.equal(path.join(repo, '.git'));
    expect(getGitIndexPath()).not.to.equal(path.join(repo, '.git/index'));
  });
  it('invalidates path discovery when Git environment overrides change', () => {
    matchesGit();
    process.env.GIT_INDEX_FILE = path.join(root, 'other-index');
    matchesGit();
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(['init', '-b', 'main'], other);
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    matchesGit();
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    delete process.env.GIT_INDEX_FILE;
    matchesGit();
  });
  it('does not cache a failure before a repository is initialized', () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    process.chdir(fresh);
    expect(getGitPaths()).to.equal(undefined);
    expect(getGitTopLevel()).to.equal('');
    git(['init', '-b', 'main'], fresh);
    matchesGit();
  });
  it('supports newline-containing directory names without splitting a path', () => {
    const other = path.join(root, 'line\nbreak');
    fs.mkdirSync(other);
    git(['init', '-b', 'main'], other);
    const nested = path.join(other, 'nested');
    fs.mkdirSync(nested);
    process.chdir(nested);
    matchesGit();
    expect(new Repository(nested).common).to.equal(path.join(other, '.git'));
  });
  it('keeps bare repository detection available to switching preconditions', () => {
    const bare = path.join(root, 'bare.git');
    git(['init', '--bare', bare]);
    process.chdir(bare);
    expect(getGitPaths()).not.to.equal(undefined);
    expect(getGitTopLevel()).to.equal('');
    expect(() => new Repository(bare).assertIdle()).to.throw(
      'not a bare repository'
    );
  });
});
