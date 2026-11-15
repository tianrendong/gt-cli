import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../src/index.js');

/** A fetch can advance trunk into a child's existing history after metadata
 * validation has run. Restacking then needs to update the child's recorded
 * base, not recreate the remaining commits that Git would fast-forward over.
 */
describe('restack preserves existing commit identity (offline)', function () {
  this.timeout(60_000);
  let root: string, repo: string, origin: string;
  let base: string, first: string, feature: string, descendant: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = (args: string[]): string => {
    const result = spawnSync(
      process.execPath,
      [cli, '--cwd', repo, ...args, '--no-interactive'],
      { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(0);
    return result.stdout + result.stderr;
  };
  const write = (file: string) =>
    fs.writeFileSync(path.join(repo, file), file + '\n');
  const meta = (branch: string) =>
    JSON.parse(git(['show', `refs/branch-metadata/${branch}`]));
  const heads = () => git(['show-ref', '--heads']);
  const expectClean = (branch: string, cwd = repo) => {
    expect(git(['branch', '--show-current'], cwd)).to.equal(branch);
    expect(git(['status', '--porcelain'], cwd)).to.equal('');
    for (const name of ['rebase-merge', 'rebase-apply', '.gtcontinue'])
      expect(
        fs.existsSync(
          path.resolve(cwd, git(['rev-parse', '--git-path', name], cwd))
        ),
        name
      ).to.equal(false);
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-replay-identity-'))
    );
    repo = path.join(root, 'repo');
    origin = path.join(root, 'origin.git');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith('GIT_') || key === 'GRAPHITE_INTERACTIVE')
        delete env[key];
    Object.assign(env, {
      HOME: path.join(root, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_AUTHOR_NAME: 'Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_AUTHOR_DATE: '1600000000 +0000',
      GIT_COMMITTER_NAME: 'Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.invalid',
      GIT_COMMITTER_DATE: '1700000000 +0000',
      GRAPHITE_DISABLE_TELEMETRY: '1',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
      FORCE_COLOR: '0',
    });
    fs.writeFileSync(
      env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    write('base.txt');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);
    git(['init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-u', 'origin', 'main']);
    git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({ trunk: 'main', isGithubIntegrationEnabled: false })
    );
    write('one.txt');
    run(['create', 'feature', '-am', 'one']);
    first = git(['rev-parse', 'HEAD']);
    write('two.txt');
    git(['add', '.']);
    git(['commit', '-m', 'two']);
    feature = git(['rev-parse', 'HEAD']);
    write('descendant.txt');
    run(['create', 'descendant', '-am', 'descendant']);
    descendant = git(['rev-parse', 'HEAD']);
    run(['checkout', 'main']);
    // Only the disposable remote moves. Local trunk still points at base when
    // sync loads its metadata; sync's fetch/pull advances it to first.
    git(['push', 'origin', `${first}:refs/heads/main`]);
    env.GIT_COMMITTER_DATE = '1800000000 +0000';
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const checkout of ['main', 'feature', 'linked']) {
    it(`preserves child and descendant SHAs during sync from ${checkout}, including undo`, () => {
      const linked = path.join(root, 'linked');
      if (checkout === 'feature') run(['checkout', 'feature']);
      if (checkout === 'linked') git(['worktree', 'add', linked, 'feature']);
      const before = heads();
      const beforeMeta = [meta('feature'), meta('descendant')];
      const current = checkout === 'feature' ? 'feature' : 'main';
      expect(meta('feature').parentBranchRevision).to.equal(base);
      expect(git(['rev-parse', 'main'])).to.equal(base);

      const output = run(['sync', '--restack']);

      expect(output).to.contain('Restacked feature on main.');
      expect(git(['rev-parse', 'main'])).to.equal(first);
      expect(git(['rev-parse', 'feature'])).to.equal(feature);
      expect(git(['rev-parse', 'descendant'])).to.equal(descendant);
      expect(meta('feature').parentBranchRevision).to.equal(first);
      expect(meta('descendant').parentBranchRevision).to.equal(feature);
      expectClean(current);
      if (checkout === 'linked') expectClean('feature', linked);

      run(['undo', '--force']);
      expect(heads()).to.equal(before);
      expect([meta('feature'), meta('descendant')]).to.deep.equal(beforeMeta);
      expectClean(current);
      if (checkout === 'linked') expectClean('feature', linked);
    });
  }

  for (const entireBranch of [false, true]) {
    it(`allows metadata-only sync and undo in a dirty linked worktree (${
      entireBranch ? 'all commits included' : 'remaining commits reused'
    })`, () => {
      const linked = path.join(root, 'linked');
      git(['worktree', 'add', linked, 'feature']);
      const newBase = entireBranch ? feature : first;
      if (entireBranch) git(['push', 'origin', `${newBase}:refs/heads/main`]);
      env.GIT_OPTIONAL_LOCKS = '0';
      fs.writeFileSync(path.join(linked, 'base.txt'), 'staged\n');
      git(['add', 'base.txt'], linked);
      fs.appendFileSync(path.join(linked, 'base.txt'), 'unstaged\n');
      fs.writeFileSync(path.join(linked, 'untracked'), 'private work\n');
      const state = () => ({
        head: git(['rev-parse', 'HEAD'], linked),
        branch: git(['branch', '--show-current'], linked),
        index: fs.readFileSync(
          git(['rev-parse', '--git-path', 'index'], linked)
        ),
        status: git(['status', '--porcelain'], linked),
        tracked: fs.readFileSync(path.join(linked, 'base.txt'), 'utf8'),
        untracked: fs.readFileSync(path.join(linked, 'untracked'), 'utf8'),
      });
      const before = heads();
      const beforeMeta = [meta('feature'), meta('descendant')];
      const dirty = state();
      expect(dirty.status).to.equal('MM base.txt\n?? untracked');

      const output = run(['sync', '--restack']);

      expect(output).to.contain('Restacked feature on main.');
      expect(output).not.to.contain('uncommitted changes');
      expect(git(['rev-parse', 'main'])).to.equal(newBase);
      expect(git(['rev-parse', 'feature'])).to.equal(feature);
      expect(git(['rev-parse', 'descendant'])).to.equal(descendant);
      expect(meta('feature').parentBranchRevision).to.equal(newBase);
      expect(meta('descendant').parentBranchRevision).to.equal(feature);
      expect(state()).to.deep.equal(dirty);
      const journals = path.join(repo, '.git/gt-operations');
      const id = JSON.parse(
        fs.readFileSync(path.join(journals, 'latest'), 'utf8')
      );
      const journal = JSON.parse(
        fs.readFileSync(path.join(journals, `${id}.json`), 'utf8')
      );
      expect(journal.worktreeMoves).to.deep.equal({});
      expectClean('main');

      run(['undo', '--force']);
      expect(heads()).to.equal(before);
      expect([meta('feature'), meta('descendant')]).to.deep.equal(beforeMeta);
      expect(state()).to.deep.equal(dirty);
      expectClean('main');
    });
  }

  it('repairs an already-advanced parent during validation without rewriting on restack', () => {
    git(['merge', '--ff-only', first]);
    run(['restack']);
    expect(git(['rev-parse', 'feature'])).to.equal(feature);
    expect(git(['rev-parse', 'descendant'])).to.equal(descendant);
    expect(meta('feature').parentBranchRevision).to.equal(first);
    expectClean('main');
  });

  it('still rewrites like Git when committer-date-is-author-date forces replay', () => {
    fs.writeFileSync(
      env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ tips: false, restackCommitterDateIsAuthorDate: true })
    );
    const before = heads();
    const oracle = path.join(root, 'oracle');
    fs.cpSync(repo, oracle, { recursive: true });
    git(
      [
        'rebase',
        '--committer-date-is-author-date',
        '--onto',
        first,
        base,
        'feature',
      ],
      oracle
    );
    const expectedFeature = git(['rev-parse', 'feature'], oracle);
    git(
      [
        'rebase',
        '--committer-date-is-author-date',
        '--onto',
        expectedFeature,
        feature,
        'descendant',
      ],
      oracle
    );
    const expectedDescendant = git(['rev-parse', 'descendant'], oracle);
    expect(expectedFeature).not.to.equal(feature);
    expect(expectedDescendant).not.to.equal(descendant);

    run(['sync', '--restack']);
    expect(git(['rev-parse', 'feature'])).to.equal(expectedFeature);
    expect(git(['rev-parse', 'descendant'])).to.equal(expectedDescendant);
    expectClean('main');
    run(['undo', '--force']);
    expect(heads()).to.equal(before);
    expectClean('main');
  });
});
