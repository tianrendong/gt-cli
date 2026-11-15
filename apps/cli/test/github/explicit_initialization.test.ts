import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  withLauncher,
  setGlobalMode,
  planLauncher,
  savedLauncherRecord,
} from '../../src/lib/switch/launcher';
import { initializationRequested } from '../../src/lib/switch/initialization';
import { validSelections } from '../../src/lib/switch/selection';
import { upgradeBindings } from '../../src/lib/switch/upgrade';

const dist = path.resolve(__dirname, '../../src');
const dispatcher = path.join(dist, 'gt_cli.js');
const toggle = path.join(dist, 'toggle_cli.js');

describe('implementation selection versus explicit initialization', function () {
  this.timeout(30_000);
  let root: string, repo: string, common: string, slot: string;
  let saved: NodeJS.ProcessEnv;
  const record = () => savedLauncherRecord(planLauncher(slot))!;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = (args: string[], cwd = repo) =>
    spawnSync(slot, args, { cwd, encoding: 'utf8', timeout: 15_000 });
  const select = (kind: string, args: string[] = []) =>
    spawnSync(process.execPath, [toggle, kind, '--repo', repo, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
    });
  function snapshot(directory = common): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory())
        Object.assign(result, snapshot(file));
      else
        result[path.relative(common, file)] = fs
          .readFileSync(file)
          .toString('base64');
    }
    return result;
  }
  const initialize = (
    args = ['init', '--trunk', 'main', '--no-interactive'],
    cwd = repo
  ) => {
    const result = run(args, cwd);
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(common, '.graphite_repo_config'), 'utf8')
      ).trunk
    ).to.equal('main');
    return result.stdout;
  };

  beforeEach(async () => {
    saved = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-explicit-init-'))
    );
    for (const dir of ['bin', 'home', 'repo with spaces'])
      fs.mkdirSync(path.join(root, dir));
    const native = path.join(root, 'native');
    fs.writeFileSync(native, '#!/bin/sh\nprintf "1.8.6\\n"\n', { mode: 0o755 });
    slot = path.join(root, 'bin/gt');
    fs.symlinkSync(native, slot);
    Object.assign(process.env, {
      HOME: path.join(root, 'home'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user-config'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: path.join(root, 'bin') + path.delimiter + saved.PATH,
    });
    for (const key of [
      'GT_GH_LAUNCHER_RECORD',
      'GIT_DIR',
      'GIT_COMMON_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
    ])
      delete process.env[key];
    repo = path.join(root, 'repo with spaces');
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-m', 'initial');
    common = fs.realpathSync(path.join(repo, '.git'));
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, true);
    });
  });
  afterEach(() => {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('global mode does not initialize or register inspection and mutation commands in fresh repos', () => {
    const before = snapshot(),
      launcher = record();
    for (const args of [
      ['info'],
      ['log'],
      ['create', 'feature', '-m', 'feature'],
      ['info', 'init'],
    ]) {
      const result = run([...args, '--no-interactive']);
      expect(result.status, result.stdout + result.stderr).to.equal(1);
      expect(result.stdout + result.stderr).to.contain(
        'Run gt init --trunk <branch> first'
      );
      expect(snapshot()).to.deep.equal(before);
      expect(record()).to.deep.equal(launcher);
    }
  });

  it('version and command-specific help never enroll or initialize', () => {
    const before = snapshot(),
      launcher = record();
    for (const args of [
      ['--version'],
      ['--help'],
      ['init', '--help'],
      ['repo', 'init', '--help'],
      ['info', '--help'],
    ]) {
      const result = run(args);
      expect(result.status, result.stdout + result.stderr).to.equal(0);
    }
    expect(snapshot()).to.deep.equal(before);
    expect(record()).to.deep.equal(launcher);
  });

  it('per-repo enable/disable selects implementation without touching Git or creating a handoff registration', () => {
    const before = snapshot();
    for (const kind of ['enable', 'disable', 'enable']) {
      const result = select(kind, ['--json']);
      expect(result.status, result.stdout + result.stderr).to.equal(0);
      expect(JSON.parse(result.stdout)).to.include({
        initialized: false,
        selectionOnly: true,
      });
      expect(snapshot()).to.deep.equal(before);
      expect(record().repositories).to.deep.equal([]);
      expect(record().implementations![common].mode).to.equal(
        kind === 'enable' ? 'gt-gh' : 'graphite'
      );
    }
    expect(run(['info']).status).to.equal(1);
  });

  it('colors selection results and previews without adding routine boilerplate', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    delete process.env.NODE_DISABLE_COLORS;
    const before = snapshot(),
      launcher = record();
    const preview = select('enable', ['--dry-run']);
    expect(preview.status, preview.stderr).to.equal(0);
    expect(preview.stdout).to.contain('\u001b[36mWould select gt-gh');
    expect(snapshot()).to.deep.equal(before);
    expect(record()).to.deep.equal(launcher);
    for (const kind of ['enable', 'disable']) {
      const result = select(kind);
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.contain(
        `\u001b[32mSelected ${kind === 'enable' ? 'gt-gh' : 'graphite'}`
      );
      expect(result.stdout).to.contain(
        '\u001b[36mgt init --trunk <branch>\u001b[39m'
      );
      expect(result.stdout.trim().split('\n')).to.have.length(2);
    }
    expect(snapshot()).to.deep.equal(before);
  });

  it('keeps toggle JSON, status, and machine-mode errors uncolored under FORCE_COLOR', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    for (const flag of ['--json', '--status']) {
      const result = select('enable', [flag]);
      expect(result.status, result.stderr).to.equal(0);
      expect(JSON.parse(result.stdout).mode).to.equal('gt-gh');
      expect(result.stdout + result.stderr).not.to.contain('\u001b[');
      const invalid = select('enable', ['--unsupported', flag]);
      expect(invalid.status).to.equal(1);
      expect(invalid.stderr).to.contain('ERROR: Unsupported switch argument');
      expect(invalid.stderr).not.to.contain('\u001b[');
    }
  });

  it('colors forget previews and results', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    delete process.env.NODE_DISABLE_COLORS;
    expect(select('enable').status).to.equal(0);
    fs.rmSync(repo, { recursive: true });
    const launcher = record();
    const preview = select('forget', ['--dry-run']);
    expect(preview.status, preview.stderr).to.equal(0);
    expect(preview.stdout).to.equal(
      `\u001b[36mWould forget registration: ${common}\u001b[39m\n`
    );
    expect(record()).to.deep.equal(launcher);
    const result = select('forget');
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.contain(
      `\u001b[32mForgot registration: ${common}`
    );
    expect(result.stdout).not.to.contain('Registration backup:');
    expect(result.stdout.trim().split('\n')).to.have.length(1);
    expect(record().implementations?.[common]).to.equal(undefined);
  });

  it('explicit init initializes once and registers before managed stack work', () => {
    const output = initialize();
    expect(output.match(/Welcome to Graphite!/g)).to.have.length(1);
    expect(record().repositories).to.deep.equal([common]);
    expect(record().registrations![common].source).to.equal('adopted');
    expect(run(['info', 'main']).status).to.equal(0);
  });

  it('per-repo selection works with global mode off but still needs init', async () => {
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, false);
    });
    expect(select('enable').status).to.equal(0);
    expect(run(['info']).status).to.equal(1);
    expect(record().repositories).to.deep.equal([]);
    initialize();
    expect(record().registrations![common].source).to.equal('explicit');
    expect(record().defaultMode).not.to.equal('gt-gh');
  });

  it('preserves native opt-outs through restoring and reinstalling the global router', async () => {
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, false);
    });
    const before = snapshot();
    expect(select('disable').status).to.equal(0);
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, true);
    });
    expect(run(['--version']).stdout.trim()).to.equal('1.8.6');
    expect(snapshot()).to.deep.equal(before);
    expect(record().repositories).to.deep.equal([]);
  });

  it('supports init through cwd options, legacy commands, and user aliases', () => {
    fs.writeFileSync(
      process.env.GRAPHITE_USER_CONFIG_PATH!,
      JSON.stringify({ aliases: [{ alias: 'setup', command: 'init' }] })
    );
    initialize(
      ['--cwd', repo, '--no-interactive', 'setup', '--trunk', 'main'],
      root
    );
    expect(record().repositories).to.deep.equal([common]);
    initialize(['r', 'i', '--trunk', 'main', '--no-interactive']);
  });

  it('shares selectors and enrollment across linked worktrees', () => {
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '--detach', linked);
    const chosen = spawnSync(
      process.execPath,
      [toggle, 'enable', '--repo', linked],
      { cwd: root, encoding: 'utf8' }
    );
    expect(chosen.status, chosen.stdout + chosen.stderr).to.equal(0);
    expect(record().repositories).to.deep.equal([]);
    expect(run(['info'], linked).status).to.equal(1);
    initialize(['init', '--trunk', 'main', '--no-interactive'], linked);
    expect(record().repositories).to.deep.equal([common]);
    expect(record().implementations![common].worktrees).to.include(linked);
  });

  it('direct candidate execution also requires init rather than inferring a trunk', () => {
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      [path.join(dist, 'index.js'), 'info', '--no-interactive'],
      { cwd: repo, encoding: 'utf8' }
    );
    expect(result.status).to.equal(1);
    expect(result.stdout + result.stderr).to.contain('Run gt init');
    expect(snapshot()).to.deep.equal(before);
  });

  it('allows explicit forgetting of deleted selector-only repos, without enrollment', () => {
    expect(select('enable').status).to.equal(0);
    fs.rmSync(repo, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [toggle, 'forget', '--repo', common, '--json'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(record().implementations?.[common]).to.equal(undefined);
    expect(record().repositories).to.deep.equal([]);
  });

  it('can inspect and forget native-only selectors after the router is restored', async () => {
    await withLauncher(slot, async (plan) => {
      setGlobalMode(plan, dispatcher, false);
    });
    expect(select('disable').status).to.equal(0);
    const status = JSON.parse(select('enable', ['--status']).stdout);
    expect(status.implementationOverride).to.equal('graphite');
    fs.rmSync(repo, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [toggle, 'forget', '--repo', common, '--json'],
      { cwd: root, encoding: 'utf8', timeout: 15_000 }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(record().implementations?.[common]).to.equal(undefined);
    expect(record().phase).to.equal('restored');
  });

  it('selector dry-run leaves both Git and launcher records unchanged', () => {
    const before = snapshot(),
      launcher = record();
    expect(select('enable', ['--dry-run']).status).to.equal(0);
    expect(snapshot()).to.deep.equal(before);
    expect(record()).to.deep.equal(launcher);
  });

  it('updates preserve selector-only configuration without enrolling or initializing', async () => {
    expect(select('enable').status).to.equal(0);
    const before = snapshot();
    const result = await upgradeBindings({
      slot,
      candidate: {
        node: process.execPath,
        script: path.join(dist, 'index.js'),
      },
      dispatcher,
      beforeChange: () => {},
      finish: () => {},
    });
    expect(result.repositories).to.deep.equal([]);
    expect(result.deferred).to.deep.equal([]);
    expect(record().repositories).to.deep.equal([]);
    expect(record().implementations![common].mode).to.equal('gt-gh');
    expect(snapshot()).to.deep.equal(before);
  });

  it('global disable clears clone-only selectors without initializing or writing Git metadata', () => {
    expect(select('enable').status).to.equal(0);
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      [toggle, 'disable', '--global'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(record().implementations?.[common]).to.equal(undefined);
    expect(record().repositories).to.deep.equal([]);
    expect(record().phase).to.equal('restored');
    expect(snapshot()).to.deep.equal(before);
  });

  it('validates selector metadata and recognizes only actual init commands', () => {
    expect(
      validSelections({ [common]: { mode: 'gt-gh', worktrees: [repo] } })
    ).to.equal(true);
    expect(
      validSelections({ [common]: { mode: 'bad', worktrees: [repo] } })
    ).to.equal(false);
    expect(
      validSelections({ relative: { mode: 'gt-gh', worktrees: [] } })
    ).to.equal(false);
    for (const args of [
      ['info', 'init'],
      ['--bad', 'init'],
      ['internal-only', 'init'],
      ['create', '-m', 'init'],
    ])
      expect(initializationRequested(args)).to.equal(false);
    for (const args of [
      ['init'],
      ['repo', 'i'],
      ['--no-interactive', 'init'],
      ['r', 'init'],
    ])
      expect(initializationRequested(args)).to.equal(true);
  });
});
