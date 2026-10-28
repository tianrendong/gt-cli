import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../src/index.js');

/**
 * gt abort and gt undo restore refs, then reload the engine. The persisted
 * cache's per-branch ancestry proofs are keyed on immutable commit IDs, so a
 * restore must re-validate only the branches it moved. Discarding them made
 * every abort/undo re-run git merge-base for every tracked branch: ~25s per
 * abort with a few hundred branches in a large repository.
 */
// eslint-disable-next-line max-lines-per-function
describe('abort/undo keep ancestry proofs for untouched branches (offline)', function () {
  this.timeout(120_000);
  const SIDE_BRANCHES = 40;
  let root: string, repo: string, trace: string;
  let env: NodeJS.ProcessEnv;
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  /** Runs gt and returns the merge-base processes it spawned. */
  const run = (args: string[], status = 0): number => {
    fs.rmSync(trace, { force: true });
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--no-interactive'],
      {
        cwd: repo,
        env: { ...env, GIT_TRACE2_EVENT: trace },
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    expect(
      result.status,
      `${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    ).to.equal(status);
    if (!fs.existsSync(trace)) return 0;
    return fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.event === 'start' &&
          // Top-level git processes only, not children git spawns itself.
          !String(event.sid).includes('/') &&
          event.argv?.[1] === 'merge-base'
      ).length;
  };
  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(repo, file), content);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-restore-proofs-'));
    repo = path.join(root, 'repo');
    trace = path.join(root, 'trace.jsonl');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    env = {
      ...process.env,
      HOME: path.join(root, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GRAPHITE_DISABLE_TELEMETRY: '1',
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user.json'),
      FORCE_COLOR: '0',
    };
    for (const name of [
      'GRAPHITE_INTERACTIVE',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_CONFIG_COUNT',
      'GIT_TRACE2_EVENT',
    ])
      delete env[name];
    fs.writeFileSync(
      env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ tips: false })
    );
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'gc.auto', '0']);
    write('f', 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    fs.writeFileSync(
      path.join(repo, '.git/.graphite_repo_config'),
      JSON.stringify({ trunk: 'main', isGithubIntegrationEnabled: false })
    );
    // Many tracked branches the restore never touches.
    const main = git(['rev-parse', 'main']);
    const tree = git(['rev-parse', 'main^{tree}']);
    for (let i = 0; i < SIDE_BRANCHES; i++) {
      git([
        'update-ref',
        `refs/heads/side-${i}`,
        git(['commit-tree', tree, '-p', main, '-m', `side ${i}`]),
      ]);
      run(['track', `side-${i}`, '--parent', 'main']);
    }
    // Warm the cache, then build a stack whose restack conflicts.
    run(['info']);
    write('f', 'a\n');
    run(['create', 'a', '-am', 'a']);
    write('f', 'b\n');
    run(['create', 'b', '-am', 'b']);
    run(['checkout', 'a']);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gt abort re-validates only the restored branches', () => {
    write('f', 'a2\n');
    // modify restacks b onto the amended a, which conflicts.
    run(['modify', '-a'], 1);
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.be.true;

    const mergeBases = run(['abort', '--force']);
    expect(fs.existsSync(path.join(repo, '.git/rebase-merge'))).to.be.false;
    expect(git(['branch', '--show-current'])).to.equal('a');
    expect(mergeBases).to.be.lessThan(SIDE_BRANCHES / 4);

    // The restored state is fully valid, and the next command stays warm.
    expect(run(['info'])).to.equal(0);
    expect(git(['log', '--format=%s', '-1', 'b'])).to.equal('b');
  });

  it('gt undo re-validates only the restored branches', () => {
    run(['checkout', 'b']);
    write('g', 'x\n');
    run(['modify', '-a']);
    const mergeBases = run(['undo', '--force']);
    expect(git(['status', '--porcelain'])).to.equal('?? g');
    expect(mergeBases).to.be.lessThan(SIDE_BRANCHES / 4);
    expect(run(['info'])).to.equal(0);
  });
});
