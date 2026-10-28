import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  installLauncher,
  planLauncher,
  registerRepository,
  releaseRepository,
  setGlobalMode,
} from '../../src/lib/switch/launcher';
import { saveImplementation } from '../../src/lib/switch/selection';
import { ABSENT_NATIVE_DIGEST } from '../../src/lib/switch/state';
import { BindingLock } from '../../src/lib/switch/binding_lock';
import { StackStore } from '../../src/lib/github/stack_file';
import { fileLock } from '../../src/lib/github/file_lock';
import {
  globalMarker,
  marker,
} from '../../scripts/installation/native_escape.cjs';
import { version } from '../../package.json';

const dist = path.resolve(__dirname, '../../src');
const toggle = path.join(dist, 'toggle_cli.js');
const dispatcher = path.join(dist, 'gt_cli.js');
const candidate = {
  node: process.execPath,
  script: path.join(dist, 'index.js'),
};

describe('gt-cli non-blocking re-enable', function () {
  this.timeout(30_000);
  let root: string,
    repo: string,
    common: string,
    slot: string,
    oldScript: string;
  let saved: NodeJS.ProcessEnv;
  let plan: ReturnType<typeof planLauncher>;
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = (args: string[], expected = 0) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [toggle, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status, result.stdout + result.stderr).to.equal(expected);
    expect(Date.now() - started).to.be.lessThan(10_000);
    return result;
  };
  const gt = (args = ['--version'], cwd = repo) => {
    const result = spawnSync(slot, args, {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status, result.stdout + result.stderr).to.equal(0);
    return result.stdout.trim();
  };
  const stateFile = (gitDir = common) =>
    path.join(gitDir, 'gt-gh-switch/state.json');
  const launcherFile = () => path.join(plan.directory, 'launcher.json');
  const record = () => JSON.parse(fs.readFileSync(launcherFile(), 'utf8'));
  const makeRepo = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    git(['init', '-b', 'main'], directory);
    fs.writeFileSync(path.join(directory, 'file'), 'committed\n');
    git(['add', 'file'], directory);
    git(['commit', '-m', 'initial'], directory);
    return directory;
  };
  const state = (directory = repo) => {
    const gitDir = fs.realpathSync(path.join(directory, '.git'));
    const config = JSON.stringify({ trunk: 'main' });
    fs.writeFileSync(path.join(gitDir, '.graphite_repo_config'), config);
    fs.mkdirSync(path.join(gitDir, 'gt-gh-switch'), { recursive: true });
    fs.writeFileSync(
      stateFile(gitDir),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'gt-gh',
        session: '123456789-abcdefabcdef',
        native: plan.native,
        nativeDigest: ABSENT_NATIVE_DIGEST,
        nativeAbsent: true,
        candidate: { node: process.execPath, script: oldScript },
        prCache: null,
        repoConfig: Buffer.from(config).toString('base64'),
      })
    );
    const current = planLauncher();
    registerRepository(current, current.record!, gitDir);
    return gitDir;
  };
  const journal = () => {
    const id = execFileSync(
      process.execPath,
      [
        '-e',
        `const {beginOperation} = require(${JSON.stringify(
          path.join(dist, 'lib/operations/journal.js')
        )}); console.log(beginOperation('sync', false).id);`,
      ],
      { cwd: repo, encoding: 'utf8' }
    ).trim();
    return path.join(common, 'gt-operations', `${id}.json`);
  };
  const snapshot = () => {
    const operations = path.join(common, 'gt-operations');
    return {
      refs: git(['show-ref']),
      index: fs.readFileSync(path.join(common, 'index')),
      state: fs.readFileSync(stateFile()),
      config: fs.readFileSync(path.join(common, '.graphite_repo_config')),
      status: git(['status', '--porcelain']),
      working: fs.readFileSync(path.join(repo, 'file')),
      untracked: fs.readFileSync(path.join(repo, 'untracked')),
      journals: fs.existsSync(operations)
        ? Object.fromEntries(
            fs
              .readdirSync(operations)
              .map((name) => [
                name,
                fs.readFileSync(path.join(operations, name)),
              ])
          )
        : {},
    };
  };
  const escape = () => {
    const result = JSON.parse(run(['disable', '--json']).stdout);
    expect(result.handoff).to.equal('incomplete');
    expect(gt()).to.equal('1.8.6');
    return result;
  };

  beforeEach(() => {
    saved = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-enable-resume-'))
    );
    fs.mkdirSync(path.join(root, 'bin'));
    Object.assign(process.env, {
      HOME: path.join(root, 'home'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      PATH: path.join(root, 'bin') + path.delimiter + saved.PATH,
    });
    delete process.env.GT_GH_LAUNCHER_RECORD;
    const native = path.join(root, 'native-gt');
    fs.writeFileSync(
      native,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.8.6; else printf "native:%s\\n" "$*"; fi\n',
      { mode: 0o755 }
    );
    slot = path.join(root, 'bin/gt');
    fs.symlinkSync(native, slot);
    oldScript = path.join(root, 'saved-runtime.js');
    fs.writeFileSync(
      oldScript,
      `if (process.argv.includes('--version')) console.log('saved-runtime'); else require(${JSON.stringify(
        candidate.script
      )});\n`
    );
    repo = makeRepo('repo');
    common = fs.realpathSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'file'), 'staged\n');
    git(['add', 'file']);
    fs.appendFileSync(path.join(repo, 'file'), 'unstaged\n');
    fs.writeFileSync(path.join(repo, 'untracked'), 'keep me\n');
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

  it('restores routing with a real unfinished sync journal, preserving dirty data and the recovery runtime', () => {
    const file = journal();
    const before = snapshot();
    expect(before.refs).to.contain('refs/gt-undo/');
    escape();
    const result = JSON.parse(run(['enable', '--json']).stdout);
    expect(result).to.include({
      mode: 'gt-gh',
      selectionOnly: true,
      bindingDeferred: true,
    });
    expect(result.candidate.script).to.equal(oldScript);
    expect(result.warnings.join('\n')).to.contain('pending gt operation');
    expect(result.warnings.join('\n')).to.contain('Runtime update deferred');
    expect(snapshot()).to.deep.equal(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).to.equal(true);
    expect(fs.existsSync(marker(common))).to.equal(false);
    expect(record().pendingBindings).to.deep.equal({
      candidate,
      repositories: [common],
    });
    expect(gt()).to.equal('saved-runtime');

    // Recovery is now reachable through the normal PATH command, not a manually
    // discovered installation directory. Only this explicit abort changes it.
    gt(['abort', '--no-interactive']);
    expect(git(['status', '--porcelain'])).to.equal(before.status);
    expect(fs.readFileSync(path.join(repo, 'file'))).to.deep.equal(
      before.working
    );
    expect(fs.readFileSync(path.join(repo, 'untracked'))).to.deep.equal(
      before.untracked
    );
    expect(gt()).to.equal(version);
    expect(record().pendingBindings).to.equal(undefined);
  });

  it('queues a scoped re-enable under its canonical Git directory when invoked through a symlink', () => {
    journal();
    escape();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(repo, alias, 'dir');
    const before = snapshot();
    const result = JSON.parse(
      run(['enable', '--repo', alias, '--json']).stdout
    );
    expect(result.bindingDeferred).to.equal(true);
    expect(record().pendingBindings).to.deep.equal({
      candidate,
      repositories: [common],
    });
    expect(snapshot()).to.deep.equal(before);
    expect(gt()).to.equal('saved-runtime');
  });

  it('warns on stderr for successful routing without claiming operation recovery', () => {
    journal();
    escape();
    const result = run(['enable']);
    expect(result.stdout).to.contain('gt now uses the clone');
    expect(result.stderr).to.contain('WARNING:');
    expect(result.stderr).to.contain(
      'operation journals, and recovery data are retained'
    );
    expect(result.stderr).to.contain('Continue or abort');
  });

  it('previews deferred re-enable without changing selection, state, update intent, or journals', () => {
    journal();
    escape();
    const before = snapshot();
    const launcher = fs.readFileSync(launcherFile());
    const selected = fs.readFileSync(marker(common));
    const result = JSON.parse(run(['enable', '--dry-run', '--json']).stdout);
    expect(result).to.include({
      dryRun: true,
      selectionOnly: true,
      bindingDeferred: true,
    });
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(launcherFile())).to.deep.equal(launcher);
    expect(fs.readFileSync(marker(common))).to.deep.equal(selected);
    expect(gt()).to.equal('1.8.6');
  });

  it('previews an idle runtime update without creating repository lock files', () => {
    const files = ['gt-cli-binding.lock', 'gt.lock', 'gh-stack.lock'].map(
      (name) => path.join(common, name)
    );
    expect(files.some((file) => fs.existsSync(file))).to.equal(false);
    const before = snapshot();
    const launcher = fs.readFileSync(launcherFile());
    const result = JSON.parse(run(['enable', '--dry-run', '--json']).stdout);
    expect(result).to.include({ dryRun: true, selectionOnly: true });
    expect(result.candidate).to.deep.equal(candidate);
    expect(result.bindingDeferred).to.equal(undefined);
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(launcherFile())).to.deep.equal(launcher);
    expect(files.some((file) => fs.existsSync(file))).to.equal(false);
    expect(gt()).to.equal('saved-runtime');
  });

  for (const kind of [
    'shared binding',
    'exclusive binding',
    'stack',
    'repository',
  ]) {
    it(`resumes promptly with a busy ${kind} lock, without replacing its inode or runtime`, () => {
      const file = path.join(
        common,
        kind.includes('binding')
          ? 'gt-cli-binding.lock'
          : kind === 'stack'
          ? 'gh-stack.lock'
          : 'gt.lock'
      );
      const fd = kind === 'repository' ? fs.openSync(file, 'a') : undefined;
      const lock = kind.includes('binding')
        ? new BindingLock(common, kind === 'shared binding')
        : kind === 'stack'
        ? new StackStore(common, common)
        : undefined;
      if (fd !== undefined) fileLock(fd);
      const inode = fs.statSync(file).ino;
      try {
        escape();
        const before = snapshot();
        const launcher = fs.readFileSync(launcherFile());
        const selected = fs.readFileSync(marker(common));
        const preview = JSON.parse(
          run(['enable', '--dry-run', '--json']).stdout
        );
        expect(preview.bindingDeferred).to.equal(true);
        expect(snapshot()).to.deep.equal(before);
        expect(fs.readFileSync(launcherFile())).to.deep.equal(launcher);
        expect(fs.readFileSync(marker(common))).to.deep.equal(selected);
        const result = JSON.parse(run(['enable', '--json']).stdout);
        expect(result.bindingDeferred).to.equal(true);
        expect(result.warnings.join('\n')).to.contain('still running');
        expect(snapshot()).to.deep.equal(before);
        expect(fs.statSync(file).ino).to.equal(inode);
        expect(fs.existsSync(marker(common))).to.equal(false);
        expect(JSON.parse(gt(['--capabilities'])).implementation).to.equal(
          'gt-gh'
        );
        if (kind === 'shared binding') expect(gt()).to.equal('saved-runtime');
      } finally {
        lock?.close();
        if (fd !== undefined) fs.closeSync(fd);
      }
      expect(gt()).to.equal(version);
    });
  }

  it('keeps a paused linked worktree and its runtime while restoring routing across the repository', () => {
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'main']);
    const local = git(['rev-parse', '--absolute-git-dir'], linked);
    const continuation = path.join(local, '.gtcontinue');
    fs.writeFileSync(continuation, '{}');
    escape();
    const before = snapshot();
    const result = JSON.parse(
      run(['enable', '--repo', linked, '--json']).stdout
    );
    expect(result.bindingDeferred).to.equal(true);
    expect(result.warnings.join('\n')).to.contain(local);
    expect(fs.readFileSync(continuation, 'utf8')).to.equal('{}');
    expect(snapshot()).to.deep.equal(before);
    expect(gt()).to.equal('saved-runtime');
    expect(gt(['--version'], linked)).to.equal('saved-runtime');
  });

  for (const kind of [
    'malformed',
    'missing',
    'unknown version',
    'null',
    'restoringRefs',
    'abortingRebase',
  ]) {
    it(`leaves ${kind} recovery data intact and defers runtime updates`, () => {
      const file = journal();
      const operation = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (kind === 'missing') fs.unlinkSync(file);
      else {
        const value =
          kind === 'null'
            ? null
            : {
                ...operation,
                pending: false,
                ...(kind === 'unknown version'
                  ? { version: 2 }
                  : { [kind]: kind === 'abortingRebase' ? true : {} }),
              };
        fs.writeFileSync(
          file,
          kind === 'malformed' ? '{invalid journal' : JSON.stringify(value)
        );
      }
      escape();
      const before = snapshot();
      const result = JSON.parse(run(['enable', '--json']).stdout);
      expect(result.bindingDeferred).to.equal(true);
      expect(result.warnings).not.to.be.empty;
      if (!['restoringRefs', 'abortingRebase'].includes(kind)) {
        expect(result.bindingBlocked).to.equal(true);
        // An older dispatcher might misread a newer journal as idle. Do not
        // leave it update intent that could replace the recovery runtime.
        expect(record().pendingBindings).to.equal(undefined);
      }
      expect(snapshot()).to.deep.equal(before);
      expect(gt()).to.equal('saved-runtime');
    });
  }

  it('does not silently rebind a same-version runtime or discard a pending journal', () => {
    const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    fs.writeFileSync(stateFile(), JSON.stringify({ ...value, candidate }));
    journal();
    escape();
    const before = snapshot();
    const result = JSON.parse(run(['enable', '--json']).stdout);
    expect(result.selectionOnly).to.equal(true);
    expect(result.bindingDeferred).to.equal(undefined);
    expect(result.warnings.join('\n')).to.contain('pending gt operation');
    expect(snapshot()).to.deep.equal(before);
    expect(record().pendingBindings).to.equal(undefined);
    expect(gt()).to.equal(version);
  });

  it('still refuses native metadata drift without clearing native selection or touching recovery', () => {
    journal();
    escape();
    fs.writeFileSync(
      path.join(common, '.graphite_repo_config'),
      '{"trunk":"native-work"}'
    );
    const before = snapshot();
    const selected = fs.readFileSync(marker(common));
    const launcher = fs.readFileSync(launcherFile());
    expect(run(['enable', '--json'], 1).stderr).to.contain(
      'Refusing to overwrite newer work'
    );
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(marker(common))).to.deep.equal(selected);
    expect(fs.readFileSync(launcherFile())).to.deep.equal(launcher);
    expect(gt()).to.equal('1.8.6');
  });

  for (const mode of ['graphite', 'enabling', 'disabling']) {
    it(`does not bypass migration guards for ${mode} ownership`, () => {
      journal();
      escape();
      const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      fs.writeFileSync(stateFile(), JSON.stringify({ ...value, mode }));
      const before = snapshot();
      expect(run(['enable', '--json'], 1).stderr).to.contain(
        'pending gt operation'
      );
      expect(snapshot()).to.deep.equal(before);
      expect(fs.existsSync(marker(common))).to.equal(true);
      expect(gt()).to.equal('1.8.6');
    });
  }

  for (const kind of ['binding', 'stack']) {
    it(`does not wait for a ${kind} lock when an actual metadata migration is required`, () => {
      const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ ...value, mode: 'graphite' })
      );
      fs.writeFileSync(marker(common), 'native selection');
      const lock =
        kind === 'binding'
          ? new BindingLock(common, true)
          : new StackStore(common, common, { repositoryLock: true });
      const before = snapshot();
      try {
        expect(run(['enable', '--json'], 1).stderr).to.contain(
          'retry when it finishes'
        );
        expect(snapshot()).to.deep.equal(before);
        expect(fs.readFileSync(marker(common), 'utf8')).to.equal(
          'native selection'
        );
        expect(gt()).to.equal('1.8.6');
      } finally {
        lock.close();
      }
    });
  }

  it('fails promptly on launcher contention without clearing a newer native selection', () => {
    journal();
    escape();
    const file = path.join(plan.directory, 'install.lock');
    const fd = fs.openSync(file, 'a');
    fileLock(fd);
    const selected = fs.readFileSync(marker(common));
    try {
      expect(run(['enable'], 1).stderr).to.contain('retry when it finishes');
      expect(fs.statSync(file).ino).to.equal(fs.fstatSync(fd).ino);
      expect(fs.readFileSync(marker(common))).to.deep.equal(selected);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('requires an available saved runtime when recovery prevents an update', () => {
    journal();
    escape();
    fs.unlinkSync(oldScript);
    const before = snapshot();
    expect(run(['enable'], 1).stderr).to.contain(
      'saved clone runtime is unavailable'
    );
    expect(snapshot()).to.deep.equal(before);
    expect(fs.existsSync(marker(common))).to.equal(true);
    expect(gt()).to.equal('1.8.6');
  });

  it("does not retarget another repository's queued update during scoped re-enable", () => {
    journal();
    escape();
    const other = makeRepo('other');
    const otherCommon = state(other);
    const otherCandidate = { ...candidate, script: oldScript };
    const current = record();
    const pending = { candidate: otherCandidate, repositories: [otherCommon] };
    fs.writeFileSync(
      launcherFile(),
      JSON.stringify({ ...current, pendingBindings: pending })
    );
    const before = fs.readFileSync(stateFile(otherCommon));
    const result = JSON.parse(run(['enable', '--json']).stdout);
    expect(result.bindingDeferred).to.equal(true);
    expect(record().pendingBindings).to.deep.equal(pending);
    expect(fs.readFileSync(stateFile(otherCommon))).to.deep.equal(before);
    expect(gt()).to.equal('saved-runtime');
  });

  it('global enable defers busy runtimes, updates healthy ones, and preserves native opt-outs', () => {
    journal();
    const second = makeRepo('second');
    const secondCommon = state(second);
    fs.writeFileSync(path.join(secondCommon, '.gtcontinue'), '{}');
    const healthy = makeRepo('healthy');
    const healthyCommon = state(healthy);
    const blocked = makeRepo('blocked');
    const blockedCommon = state(blocked);
    fs.mkdirSync(path.join(blockedCommon, 'gt-operations'));
    fs.writeFileSync(
      path.join(blockedCommon, 'gt-operations/latest'),
      '"1-abc"'
    );
    fs.writeFileSync(
      path.join(blockedCommon, 'gt-operations/1-abc.json'),
      JSON.stringify({ version: 2, pending: false })
    );
    const nativeOnly = makeRepo('native-only');
    const nativeCommon = state(nativeOnly);
    let current = planLauncher();
    const selected = saveImplementation(current, current.record!, {
      common: nativeCommon,
      mode: 'graphite',
      worktrees: [nativeOnly],
    });
    releaseRepository(current, selected, nativeCommon);
    current = planLauncher();
    fs.writeFileSync(
      launcherFile(),
      JSON.stringify({
        ...current.record,
        pendingBindings: {
          candidate: { ...candidate, script: oldScript },
          repositories: [common, secondCommon, healthyCommon, blockedCommon],
        },
      })
    );
    fs.writeFileSync(globalMarker(plan), 'interrupted global escape');
    const before = snapshot();
    const secondBefore = fs.readFileSync(stateFile(secondCommon));
    const nativeBefore = fs.readFileSync(stateFile(nativeCommon));
    const previewRecord = fs.readFileSync(launcherFile());
    const preview = JSON.parse(
      run(['enable', '--global', '--dry-run', '--json']).stdout
    );
    expect(preview.deferred).to.have.members([repo, second, blocked]);
    expect(fs.readFileSync(launcherFile())).to.deep.equal(previewRecord);
    expect(fs.existsSync(globalMarker(plan))).to.equal(true);
    expect(snapshot()).to.deep.equal(before);

    const result = JSON.parse(run(['enable', '--global', '--json']).stdout);
    expect(result.deferred).to.have.members([repo, second, blocked]);
    expect(result.completed).to.have.members([repo, second, healthy, blocked]);
    expect(result.warnings.join('\n')).to.contain('pending gt operation');
    expect(record().pendingBindings).to.deep.equal({
      candidate,
      repositories: [common, secondCommon],
    });
    expect(snapshot()).to.deep.equal(before);
    expect(fs.readFileSync(stateFile(secondCommon))).to.deep.equal(
      secondBefore
    );
    expect(fs.readFileSync(stateFile(nativeCommon))).to.deep.equal(
      nativeBefore
    );
    expect(
      JSON.parse(fs.readFileSync(stateFile(healthyCommon), 'utf8')).candidate
    ).to.deep.equal(candidate);
    expect(fs.existsSync(globalMarker(plan))).to.equal(false);
    expect(gt()).to.equal('saved-runtime');
    expect(gt(['--version'], second)).to.equal('saved-runtime');
    expect(gt(['--version'], healthy)).to.equal(version);
    expect(gt(['--version'], blocked)).to.equal('saved-runtime');
    expect(gt(['--version'], nativeOnly)).to.equal('1.8.6');
  });
});
