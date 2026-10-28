import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import {
  installLauncher,
  planLauncher,
  registerRepository,
  setGlobalMode,
} from '../../src/lib/switch/launcher';
import { ABSENT_NATIVE_DIGEST } from '../../src/lib/switch/state';
import { BindingLock } from '../../src/lib/switch/binding_lock';
import { StackStore } from '../../src/lib/github/stack_file';
import { fileLock } from '../../src/lib/github/file_lock';
import {
  clearSelection,
  globalMarker,
  marker,
  selectionSnapshot,
} from '../../scripts/installation/native_escape.cjs';
import { worker } from '../../scripts/installation/disable.cjs';

const dist = path.resolve(__dirname, '../../src');
const toggle = path.join(dist, 'toggle_cli.js');
const dispatcher = path.join(dist, 'gt_cli.js');
const scripts = path.resolve(__dirname, '../../../scripts/installation');

describe('gt-cli disable native escape (no proprietary CLI required)', function () {
  this.timeout(30_000);
  let root: string, repo: string, common: string, slot: string, native: string;
  let saved: NodeJS.ProcessEnv;
  let plan: ReturnType<typeof planLauncher>;
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [toggle, 'disable', ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).to.equal(expected);
    return result;
  };
  const json = (args: string[] = []) =>
    JSON.parse(run([...args, '--json']).stdout);
  const gt = (cwd = repo, args = ['--version']) => {
    const result = spawnSync(slot, args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    return result.stdout.trim();
  };
  const stateFile = () => path.join(common, 'gt-gh-switch/state.json');
  const makeRepo = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    git(['init', '-b', 'main'], directory);
    git(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      directory
    );
    return directory;
  };
  const state = (directory = repo) => {
    const commonDir = fs.realpathSync(path.join(directory, '.git'));
    const value = {
      schemaVersion: 1,
      mode: 'gt-gh',
      session: '123456789-abcdefabcdef',
      native: plan.native,
      nativeDigest: ABSENT_NATIVE_DIGEST,
      nativeAbsent: true,
      candidate: {
        node: process.execPath,
        script: path.join(dist, 'index.js'),
      },
      prCache: null,
      repoConfig: null,
    };
    fs.mkdirSync(path.join(commonDir, 'gt-gh-switch'), { recursive: true });
    fs.writeFileSync(
      path.join(commonDir, 'gt-gh-switch/state.json'),
      JSON.stringify(value)
    );
    const current = planLauncher();
    registerRepository(current, current.record!, commonDir);
  };
  const snapshot = () => ({
    refs: git(['show-ref']),
    index: fs.readFileSync(path.join(common, 'index')),
    state: fs.readFileSync(stateFile()),
    status: git(['status', '--porcelain']),
  });

  beforeEach(() => {
    saved = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-disable-escape-'))
    );
    fs.mkdirSync(path.join(root, 'bin'));
    process.env.HOME = path.join(root, 'home');
    process.env.XDG_STATE_HOME = path.join(root, 'state');
    process.env.XDG_CONFIG_HOME = path.join(root, 'config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.PATH = path.join(root, 'bin') + path.delimiter + saved.PATH;
    delete process.env.GT_GH_LAUNCHER_RECORD;
    native = path.join(root, "native gt's");
    fs.writeFileSync(
      native,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.8.6; else printf "native:%s\\n" "$*"; fi\n',
      { mode: 0o755 }
    );
    slot = path.join(root, 'bin/gt');
    fs.symlinkSync(native, slot);
    repo = makeRepo('repo');
    common = fs.realpathSync(path.join(repo, '.git'));
    // Ensure an index exists and cover preservation of staged/unstaged data.
    fs.writeFileSync(path.join(repo, 'file'), 'staged\n');
    git(['add', 'file']);
    fs.appendFileSync(path.join(repo, 'file'), 'unstaged\n');
    plan = planLauncher();
    fs.mkdirSync(plan.directory, { recursive: true, mode: 0o700 });
    installLauncher(plan, dispatcher);
    setGlobalMode(planLauncher(), dispatcher, true);
    plan = planLauncher();
    state();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('escapes malformed repository state before parsing it, keeping other repositories on the clone', () => {
    fs.writeFileSync(stateFile(), '{invalid state');
    const before = snapshot();
    const result = json();
    expect(result.mode).to.equal('graphite');
    expect(result.handoff).to.equal('incomplete');
    expect(result.warnings.join('\n')).to.contain('Recovery metadata retained');
    expect(result.warnings.join('\n')).to.contain('gt log');
    expect(snapshot()).to.deep.equal(before);
    expect(gt()).to.equal('1.8.6');
    expect(gt(root)).not.to.equal('1.8.6');
    expect(fs.existsSync(marker(common))).to.equal(true);
  });

  it('warns on stderr without falsely claiming that metadata was verified', () => {
    fs.writeFileSync(stateFile(), 'broken');
    const result = run([]);
    expect(result.stdout).to.contain('gt now uses native Graphite');
    expect(result.stdout).not.to.contain('Verified');
    expect(result.stderr).to.contain('WARNING:');
    expect(result.stderr).to.contain('may be stale or incomplete');
  });

  it('does not mutate routing, recovery state, or metadata in a failed-handoff preview', () => {
    fs.writeFileSync(stateFile(), 'broken');
    const before = snapshot();
    const link = fs.readlinkSync(slot);
    const record = fs.readFileSync(path.join(plan.directory, 'launcher.json'));
    const result = json(['--dry-run']);
    expect(result.dryRun).to.equal(true);
    expect(result.disabled).to.equal(false);
    expect(result.handoff).to.equal('incomplete');
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readlinkSync(slot)).to.equal(link);
    expect(
      fs.readFileSync(path.join(plan.directory, 'launcher.json')).equals(record)
    ).to.equal(true);
    expect(fs.existsSync(marker(common))).to.equal(false);
    expect(
      fs.existsSync(path.join(plan.directory, 'native-recovery'))
    ).to.equal(false);
  });

  it('keeps paused linked-worktree operations and selects native across worktrees, including --cwd', () => {
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'main']);
    const localGit = git(['rev-parse', '--absolute-git-dir'], linked);
    const pending = path.join(localGit, '.gtcontinue');
    fs.writeFileSync(pending, '{pending operation}');
    const before = snapshot();
    const result = json(['--repo', linked]);
    expect(result.warnings.join('\n')).to.contain('Finish or abort');
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(pending, 'utf8')).to.equal('{pending operation}');
    expect(gt()).to.equal('1.8.6');
    expect(gt(linked)).to.equal('1.8.6');
    expect(gt(root, ['--cwd', linked, 'info'])).to.equal(
      `native:--cwd ${linked} info`
    );
    expect(gt(root, [`--cwd=${linked}`, 'info'])).to.equal(
      `native:--cwd=${linked} info`
    );
  });

  for (const kind of ['binding', 'stack', 'launcher']) {
    it(`does not wait for a busy ${kind} lock or unlink its inode`, async () => {
      const lockFile = path.join(plan.directory, 'install.lock');
      const fd = kind === 'launcher' ? fs.openSync(lockFile, 'a') : undefined;
      const lock =
        kind === 'binding'
          ? new BindingLock(common)
          : kind === 'stack'
          ? await StackStore.open(common, common, 0, { repositoryLock: true })
          : undefined;
      if (fd !== undefined) fileLock(fd);
      try {
        const started = Date.now();
        expect(json().handoff).to.equal('incomplete');
        expect(Date.now() - started).to.be.lessThan(8000);
        expect(gt()).to.equal('1.8.6');
        if (fd !== undefined)
          expect(fs.statSync(lockFile).ino).to.equal(fs.fstatSync(fd).ino);
      } finally {
        lock?.close();
        if (fd !== undefined) fs.closeSync(fd);
      }
    });
  }

  it('never replays a failed export on repeated disable after native work', () => {
    fs.writeFileSync(stateFile(), 'broken');
    json();
    state(); // Even a later repair of the old state does not make it authoritative.
    const db = path.join(common, '.graphite_metadata.db');
    fs.writeFileSync(db, 'newer native work');
    const before = snapshot();
    expect(json().handoff).to.equal('incomplete');
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(db, 'utf8')).to.equal('newer native work');
    expect(gt()).to.equal('1.8.6');
  });

  it('allows an explicit, validated re-enable after a busy-operation escape', () => {
    const pending = path.join(common, '.gtcontinue');
    fs.writeFileSync(pending, '{}');
    json();
    fs.unlinkSync(pending);
    const result = spawnSync(process.execPath, [toggle, 'enable'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    expect(fs.existsSync(marker(common))).to.equal(false);
    expect(gt()).not.to.equal('1.8.6');
  });

  it('repairs global escape bookkeeping before scoped enable can expose other old clone bindings', () => {
    const other = makeRepo('other');
    state(other);
    fs.writeFileSync(globalMarker(plan), '{"reason":"shell-only recovery"}');
    fs.unlinkSync(slot);
    fs.symlinkSync(native, slot);
    const attempt = () =>
      spawnSync(process.execPath, [toggle, 'enable'], {
        cwd: repo,
        encoding: 'utf8',
      });
    const refused = attempt();
    expect(refused.status).to.equal(1);
    expect(refused.stderr).to.contain('Rerun gt-cli disable --global');
    expect(gt(other)).to.equal('1.8.6');
    json(['--global']);
    const enabled = attempt();
    expect(enabled.status, enabled.stdout + enabled.stderr).to.equal(0);
    expect(gt()).not.to.equal('1.8.6');
    expect(gt(other)).to.equal('1.8.6');
  });

  it('does not let an earlier enable clear a newer disable selection', () => {
    const before = selectionSnapshot(plan, common);
    fs.writeFileSync(marker(common), 'new disable');
    expect(() => clearSelection(before)).to.throw('concurrent gt-cli disable');
    expect(fs.readFileSync(marker(common), 'utf8')).to.equal('new disable');
  });

  it('global disable hands healthy repositories back despite malformed and unavailable registrations', () => {
    const healthy = makeRepo('healthy');
    state(healthy);
    fs.writeFileSync(stateFile(), 'broken');
    const unavailable = path.join(root, 'offline.git');
    fs.mkdirSync(unavailable);
    const current = planLauncher();
    registerRepository(current, current.record!, unavailable);
    const result = json(['--global']);
    expect(result.handoff).to.equal('incomplete');
    expect(result.completed).to.include(healthy);
    expect(result.warnings.join('\n')).to.contain(unavailable);
    expect(gt()).to.equal('1.8.6');
    expect(gt(healthy)).to.equal('1.8.6');
    expect(gt(root)).to.equal('1.8.6');
    expect(fs.readFileSync(stateFile(), 'utf8')).to.equal('broken');
    expect(
      fs.existsSync(path.join(healthy, '.git/gt-gh-switch/state.json'))
    ).to.equal(false);
    const record = JSON.parse(
      fs.readFileSync(path.join(plan.directory, 'launcher.json'), 'utf8')
    );
    expect(record.repositories).to.deep.equal([]);
    expect(record.defaultMode).to.equal('graphite');
    expect(fs.existsSync(result.backup)).to.equal(true);
  });

  for (const damage of [
    'record',
    'router',
    'missing router',
    'runtime',
    'legacy receipt',
    'selections',
    'registrations',
    'binding',
    'switch symlink',
  ]) {
    it(`returns native with damaged ${damage} without needing clone state`, () => {
      fs.writeFileSync(stateFile(), 'broken');
      if (damage === 'record')
        fs.writeFileSync(path.join(plan.directory, 'launcher.json'), 'broken');
      if (damage === 'router')
        fs.writeFileSync(plan.record!.router, '#!/bin/sh\nexit 99\n');
      if (damage === 'missing router') fs.unlinkSync(plan.record!.router);
      if (['selections', 'registrations', 'binding'].includes(damage)) {
        const file = path.join(plan.directory, 'launcher.json');
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (damage === 'selections')
          record.implementations = { [common]: null };
        if (damage === 'registrations') record.repositories = [null, 3, {}];
        if (damage === 'binding') record.pendingBindings = {};
        fs.writeFileSync(file, JSON.stringify(record));
      }
      if (damage === 'switch symlink') {
        const control = path.join(common, 'gt-gh-switch');
        const outside = path.join(root, 'untouched-recovery');
        fs.renameSync(control, outside);
        fs.symlinkSync(outside, control);
      }
      if (damage === 'runtime') {
        fs.unlinkSync(path.join(plan.directory, 'node'));
        fs.symlinkSync('/missing/runtime', path.join(plan.directory, 'node'));
      }
      if (damage === 'legacy receipt') {
        fs.unlinkSync(plan.record!.router + '.native');
        fs.writeFileSync(path.join(plan.directory, 'launcher.json'), 'broken');
      }
      expect(json().handoff).to.equal('incomplete');
      expect(gt()).to.equal('1.8.6');
      expect(fs.readFileSync(stateFile(), 'utf8')).to.equal('broken');
    });
  }

  it('previews global escape when launcher registrations cannot be read', () => {
    const file = path.join(plan.directory, 'launcher.json');
    fs.writeFileSync(file, 'broken');
    const link = fs.readlinkSync(slot);
    const result = json(['--dry-run']);
    expect(result.scope).to.equal('global');
    expect(result.warnings.join('\n')).to.contain('Would restore');
    expect(fs.readFileSync(file, 'utf8')).to.equal('broken');
    expect(fs.readlinkSync(slot)).to.equal(link);
    expect(fs.existsSync(marker(common))).to.equal(false);
  });

  it('restores native globally when a repository selection cannot be written', function () {
    if (process.getuid?.() === 0) this.skip();
    fs.writeFileSync(stateFile(), 'broken');
    fs.chmodSync(common, 0o500);
    try {
      const result = json();
      expect(result.scope).to.equal('global');
      expect(result.warnings.join('\n')).to.contain(
        'Could not save repository-native selection'
      );
      expect(gt(root)).to.equal('1.8.6');
      expect(fs.readFileSync(stateFile(), 'utf8')).to.equal('broken');
    } finally {
      fs.chmodSync(common, 0o700);
    }
  });

  it('reports native selection even when preserved recovery state is malformed', () => {
    fs.writeFileSync(stateFile(), 'broken');
    json();
    const before = snapshot();
    const status = json(['--status']);
    expect(status.mode).to.equal('graphite');
    expect(status.handoff).to.equal('incomplete');
    expect(snapshot()).to.deep.equal(before);
  });

  for (const nodeAvailable of [true, false]) {
    it(`installation entry escapes with missing private runtime/build (ambient Node ${
      nodeAvailable ? 'available' : 'unavailable'
    })`, () => {
      const install = path.join(root, 'broken-install');
      const directory = path.join(install, 'scripts/installation');
      fs.mkdirSync(directory, { recursive: true });
      for (const file of [
        'run.sh',
        'output.sh',
        'output.cjs',
        'disable.cjs',
        'native_escape.cjs',
        'disable-native.sh',
      ])
        fs.copyFileSync(path.join(scripts, file), path.join(directory, file));
      fs.symlinkSync(
        '/missing/private-node',
        path.join(install, '.runtime-node')
      );
      fs.writeFileSync(path.join(root, 'bin/node'), '#!/bin/sh\nexit 99\n', {
        mode: 0o755,
      });
      const result = spawnSync(
        '/bin/sh',
        [path.join(directory, 'run.sh'), install, 'disable', '--repo', repo],
        {
          cwd: repo,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            GT_NODE_BIN: nodeAvailable ? process.execPath : '/missing/node',
            GT_CLI_HOME: path.join(root, 'missing-install'),
            PATH: path.join(root, 'bin') + ':/usr/bin:/bin',
          },
        }
      );
      expect(result.status, result.stdout + result.stderr).to.equal(0);
      expect(result.stderr).to.contain('WARNING:');
      expect(gt()).to.equal('1.8.6');
      expect(fs.existsSync(stateFile())).to.equal(true);
    });
  }

  it('does not require the saved native binary version or digest for routing', () => {
    fs.writeFileSync(native, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
    expect(json().handoff).to.equal('incomplete');
    expect(gt()).to.equal('9.9.9');
  });

  it('reports missing native Graphite honestly without claiming disable succeeded', () => {
    fs.unlinkSync(native);
    process.env.PATH = path.join(root, 'bin') + ':/usr/bin:/bin';
    const before = fs.readlinkSync(slot);
    const result = run(['--global'], 1);
    expect(result.stderr).to.contain(
      'Native Graphite is missing or cannot run'
    );
    expect(fs.readlinkSync(slot)).to.equal(before);
    expect(fs.existsSync(globalMarker(plan))).to.equal(false);
  });

  it('rejects invalid arguments and handles help without switching', () => {
    const before = fs.readlinkSync(slot);
    for (const args of [['--typo'], ['--repo'], ['--global', '--repo', repo]])
      run(args, 1);
    expect(run(['--help']).stdout).to.contain('best-effort');
    expect(fs.readlinkSync(slot)).to.equal(before);
    expect(fs.existsSync(marker(common))).to.equal(false);
  });

  it('shell rescue works without Node and stays idempotent', () => {
    const script = path.join(scripts, 'disable-native.sh');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('/bin/sh', [script, '--global'], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: path.join(root, 'bin') + ':/usr/bin:/bin',
        },
      });
      expect(result.status, result.stdout + result.stderr).to.equal(0);
      expect(gt()).to.equal('1.8.6');
    }
    expect(fs.existsSync(stateFile())).to.equal(true);
  });

  it('bounds a hung migration and kills its child writers before returning', async () => {
    const script = path.join(root, 'hung.cjs');
    const output = path.join(root, 'late-write');
    fs.writeFileSync(
      script,
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(
          output
        )}, 'unsafe'), 700)`
      )}], {stdio:'inherit'}); setInterval(() => {}, 1000);`
    );
    const result = (await worker(script, [], 100)) as { error: string };
    expect(result.error).to.contain('timed out');
    await sleep(900);
    expect(fs.existsSync(output)).to.equal(false);
  });
});
