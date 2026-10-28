import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { Repository } from '../../src/lib/switch/repository';
import {
  withLauncher,
  setGlobalMode,
  planLauncher,
  registerRepository,
  readLauncher,
} from '../../src/lib/switch/launcher';
import {
  canForget,
  automaticForgetBlocker,
  canonicalRegistrationPath,
  registrationSnapshot,
  forgetRegistration,
  mountPoint,
  validRegistrations,
} from '../../src/lib/switch/registration';
import type { LauncherRecord } from '../../src/lib/switch/launcher';
import { ABSENT_NATIVE_DIGEST, writeState } from '../../src/lib/switch/state';
import { upgradeBindings } from '../../src/lib/switch/upgrade';
import { switchGlobal } from '../../src/lib/switch/batch';

const dispatcher = path.resolve(__dirname, '../../src/gt_cli.js');
const toggle = path.resolve(__dirname, '../../src/toggle_cli.js');

describe('missing repository registration cleanup', function () {
  this.timeout(30_000);
  let root: string, cwd: string, common: string, slot: string;
  let saved: NodeJS.ProcessEnv;
  const plan = () => planLauncher(slot);
  const record = () => plan().record!;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const register = async (source: 'adopted' | 'explicit' = 'adopted') =>
    withLauncher(slot, async (p) =>
      registerRepository(
        p,
        p.record!,
        common,
        registrationSnapshot(new Repository(cwd), source)
      )
    );
  const forget = (args: string[]) =>
    spawnSync(process.execPath, [toggle, 'forget', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
  const upgrade = () =>
    upgradeBindings({
      slot,
      candidate: {
        node: process.execPath,
        script: path.resolve(__dirname, '../../src/index.js'),
      },
      dispatcher,
      beforeChange: () => {},
      finish: () => {},
    });

  const globalToggle = (kind: 'enable' | 'disable', dryRun = false) =>
    switchGlobal(kind, {
      initial: plan(),
      candidate: {
        node: process.execPath,
        script: path.resolve(__dirname, '../../src/index.js'),
      },
      dispatcher,
      dryRun,
    });

  beforeEach(async () => {
    saved = { ...process.env };
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-registration-cleanup-'))
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
    cwd = path.join(root, 'repo with spaces');
    git('init', '-b', 'main');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    );
    common = fs.realpathSync(path.join(cwd, '.git'));
    await withLauncher(slot, async (p) => {
      setGlobalMode(p, dispatcher, true);
    });
    await register();
  });
  afterEach(() => {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('forgets missing checkouts without backups, clears pending intent, preserves global mode', async () => {
    fs.rmSync(cwd, { recursive: true });
    const result = await upgrade();
    expect(result.deferred).to.deep.equal([]);
    expect(result.forgotten).to.deep.equal([{ repository: common }]);
    expect(fs.existsSync(path.join(plan().directory, 'forgotten'))).to.equal(
      false
    );
    expect(record().repositories).not.to.include(common);
    expect(record().pendingBindings).to.equal(undefined);
    expect(record().defaultMode).to.equal('gt-gh');
    expect(fs.readlinkSync(slot)).to.equal(record().router);
    expect((await upgrade()).forgotten).to.deep.equal([]);
  });

  it('reports completed cleanup even when activation subsequently fails', async () => {
    fs.rmSync(cwd, { recursive: true });
    let message = '';
    try {
      await upgradeBindings({
        slot,
        candidate: {
          node: process.execPath,
          script: path.resolve(__dirname, '../../src/index.js'),
        },
        dispatcher,
        beforeChange: () => {},
        finish: () => {
          throw new Error('fixture activation failure');
        },
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).to.contain('fixture activation failure');
    expect(message).to.contain('Forgot missing checkout:');
    expect(message).not.to.contain('Registration backup:');
    expect(record().repositories).not.to.include(common);
  });

  for (const source of ['adopted', 'explicit', 'legacy'] as const) {
    it(`auto-forgets missing ${source} registrations without temporary provenance`, async () => {
      if (source === 'explicit') await register(source);
      const p = plan();
      if (source === 'legacy') delete p.record!.registrations;
      else delete p.record!.registrations![common].temporaryRoot;
      p.record!.implementations = {
        [common]: { mode: 'gt-gh', worktrees: [cwd] },
      };
      fs.writeFileSync(
        path.join(p.directory, 'launcher.json'),
        JSON.stringify(p.record)
      );
      fs.rmSync(cwd, { recursive: true });
      const result = await upgrade();
      expect(result.deferred).to.deep.equal([]);
      expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal([
        common,
      ]);
      expect(record().repositories).not.to.include(common);
      expect(record().registrations?.[common]).to.equal(undefined);
      expect(record().implementations?.[common]).to.equal(undefined);
      expect(record().pendingBindings).to.equal(undefined);
      expect(record().defaultMode).to.equal('gt-gh');
      expect((await upgrade()).forgotten).to.deep.equal([]);
    });
  }

  it('cleans old adopted HOME registrations without recorded devices or a temp root', async () => {
    // Match pre-upgrade registrations such as ~/tools/deleted-checkout.
    process.env.HOME = root;
    const p = plan();
    delete p.record!.registrations![common].temporaryRoot;
    delete p.record!.registrations![common].pathDevices;
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    expect((await upgrade()).forgotten).to.have.length(1);
  });

  for (const kind of ['enable', 'disable'] as const) {
    it(`global ${kind} previews and automatically forgets deleted registrations`, async () => {
      await register('explicit');
      const p = plan();
      const file = path.join(p.directory, 'launcher.json');
      const before = fs.readFileSync(file);
      fs.rmSync(cwd, { recursive: true });
      const preview = await globalToggle(kind, true);
      expect(preview.forgotten).to.deep.equal([{ repository: common }]);
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
      expect(fs.existsSync(path.join(p.directory, 'forgotten'))).to.equal(
        false
      );
      const result = await globalToggle(kind);
      expect(result.forgotten).to.have.length(1);
      expect(result.forgotten[0].repository).to.equal(common);
      expect(fs.existsSync(path.join(p.directory, 'forgotten'))).to.equal(
        false
      );
      const after = readLauncher(file);
      expect(after.repositories).to.deep.equal([]);
      expect(after.defaultMode).to.equal(
        kind === 'enable' ? 'gt-gh' : 'graphite'
      );
      expect(after.phase).to.equal(kind === 'enable' ? 'active' : 'restored');
      expect(result.restored).to.equal(kind === 'disable');
    });
  }

  it('global handoff does not clean registrations before the remaining repositories pass preflight', async () => {
    const p = plan();
    const absent = path.join(root, 'deleted', '.git');
    p.record!.repositories.push(absent);
    const file = path.join(p.directory, 'launcher.json');
    fs.writeFileSync(file, JSON.stringify(p.record));
    const before = fs.readFileSync(file);
    fs.unlinkSync(path.join(common, 'HEAD'));
    const error = await globalToggle('disable').catch((error) => error);
    expect(error.message).to.contain(
      'Git cannot read this registered repository'
    );
    expect(fs.readFileSync(file).equals(before)).to.equal(true);
    expect(fs.existsSync(path.join(p.directory, 'forgotten'))).to.equal(false);
  });

  it('global handoff reports all retained missing registrations and their filesystem guards', async () => {
    const p = plan();
    const absent = path.join(root, 'other-volume', 'deleted', '.git');
    const device = fs.statSync(common).dev;
    // One checkout recorded on a mount that is gone; one legacy record whose
    // device differs with nothing proving a renumbering.
    p.record!.registrations![common].pathMounts![common] = path.join(
      root,
      'volume'
    );
    p.record!.repositories.push(absent);
    p.record!.registrations![absent] = {
      source: 'explicit',
      worktrees: [path.dirname(absent)],
      pathDevices: { [absent]: device + 1 },
    };
    const file = path.join(p.directory, 'launcher.json');
    fs.writeFileSync(file, JSON.stringify(p.record));
    const before = fs.readFileSync(file);
    fs.rmSync(cwd, { recursive: true });
    const error = await globalToggle('disable').catch((error) => error);
    expect(error.message).to.contain(`  - ${common}`);
    expect(error.message).to.contain(`  - ${absent}`);
    expect(error.message).to.contain('volume may be unmounted');
    expect(error.message).to.contain('gt-cli forget --missing --dry-run');
    expect(error.message).to.contain(
      'No registration was removed automatically'
    );
    expect(fs.readFileSync(file).equals(before)).to.equal(true);
  });

  it('reports any completed auto-cleanup if a later global cleanup fails', async () => {
    const p = plan();
    const absent = path.join(root, 'zzz-deleted', '.git');
    p.record!.repositories.push(absent);
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    const launcher = path.join(p.directory, 'launcher.json');
    const rename = fs.renameSync;
    // Fail the write that would drop the second missing registration.
    fs.renameSync = ((from, to) => {
      if (
        String(to) === launcher &&
        !fs.readFileSync(from, 'utf8').includes(absent)
      )
        throw new Error('fixture cleanup failure');
      return rename(from, to);
    }) as typeof fs.renameSync;
    try {
      const error = await globalToggle('disable').catch((error) => error);
      expect(error.message).to.contain('fixture cleanup failure');
      expect(error.message).to.contain(`Forgot missing checkout: ${common}`);
      expect(record().repositories).to.deep.equal([absent]);
      expect(record().defaultMode).to.equal('gt-gh');
    } finally {
      fs.renameSync = rename;
    }
  });

  it('forgets every definitely missing registration at once, previewing first and keeping live ones', async () => {
    await register('explicit');
    const live = path.join(root, 'live');
    execFileSync('git', ['init', '-b', 'main', live], { stdio: 'pipe' });
    const liveCommon = fs.realpathSync(path.join(live, '.git'));
    await withLauncher(slot, async (p) =>
      registerRepository(
        p,
        p.record!,
        liveCommon,
        registrationSnapshot(new Repository(live), 'explicit')
      )
    );
    const legacy = path.join(root, 'legacy', '.git');
    const p = plan();
    p.record!.repositories.push(legacy); // unknown provenance, no registration
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    const before = record();
    const dry = forget(['--missing', '--dry-run', '--json']);
    expect(dry.status, dry.stderr).to.equal(0);
    expect(JSON.parse(dry.stdout)).to.deep.equal({
      forgotten: [{ repository: legacy }, { repository: common }],
      dryRun: true,
    });
    expect(record()).to.deep.equal(before);
    const text = forget(['--missing', '--dry-run']);
    expect(text.stdout).to.contain('Would forget 2 missing registrations:');
    expect(text.stdout).to.contain(`  - ${common}`);
    expect(text.stdout).to.contain('Preview only.');
    const done = forget(['--missing']);
    expect(done.status, done.stderr).to.equal(0);
    expect(done.stdout).to.contain('Forgot 2 missing registrations:');
    expect(done.stdout).to.contain(`  - ${legacy}`);
    expect(done.stdout).to.contain(`  - ${common}`);
    expect(done.stdout).not.to.contain('Registration backup:');
    expect(fs.existsSync(path.join(p.directory, 'forgotten'))).to.equal(false);
    expect(record().repositories).to.deep.equal([liveCommon]);
    expect(record().registrations![liveCommon]).to.exist;
    expect(record().registrations![common]).to.equal(undefined);
    expect(record().pendingBindings).to.equal(undefined);
    expect(fs.existsSync(live)).to.equal(true);
    const again = forget(['--missing']);
    expect(again.status, again.stderr).to.equal(0);
    expect(again.stdout).to.contain(
      'No missing registrations eligible for cleanup.'
    );
    expect(JSON.parse(forget(['--missing', '--json']).stdout)).to.deep.equal({
      forgotten: [],
    });
    // The live fixture was registered without a backend selection; only that
    // repair-class entry remains, no stale registration.
    expect(
      (await upgrade()).deferred.map(({ repository, kind }) => ({
        repository,
        kind,
      }))
    ).to.deep.equal([{ repository: liveCommon, kind: 'blocked' }]);
  });

  it('rejects --missing combined with --repo or global flags', () => {
    for (const args of [
      ['--missing', '--repo', common],
      ['--missing', '--global'],
      ['--missing', '--cwd', root],
    ]) {
      const result = forget(args);
      expect(result.status, args.join(' ')).to.equal(1);
      expect(result.stderr).to.contain('gt-cli forget --missing');
    }
  });

  it('does not turn unknown or explicit provenance into adopted provenance', async () => {
    await register('explicit');
    await register('adopted');
    expect(record().registrations![common].source).to.equal('explicit');
    const p = plan();
    delete p.record!.registrations;
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    await register('adopted');
    expect(record().registrations?.[common]).to.equal(undefined);
  });

  it('keeps live repositories and names an existing Git directory as the blocker', () => {
    expect(canForget(record(), common, true)).to.equal(false);
    expect(automaticForgetBlocker(record(), common)).to.equal(
      `Registered Git directory still exists or is not safely accessible: ${common}`
    );
    expect(forget(['--repo', common]).status).to.equal(1);
    expect(forget(['--repo', common]).stderr).to.contain(
      'Registered Git directory still exists'
    );
  });

  it('treats a gone Git directory as a gone repository, leaving working files untouched', async () => {
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '--detach', linked);
    await register();
    fs.writeFileSync(path.join(cwd, 'leftover.txt'), 'plain files remain\n');
    fs.rmSync(common, { recursive: true });
    const result = await upgrade();
    expect(result.deferred).to.deep.equal([]);
    expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal([
      common,
    ]);
    expect(record().repositories).not.to.include(common);
    // Nothing on disk is deleted: leftover files and the linked worktree stay.
    expect(fs.readFileSync(path.join(cwd, 'leftover.txt'), 'utf8')).to.equal(
      'plain files remain\n'
    );
    expect(fs.existsSync(path.join(linked, '.git'))).to.equal(true);
    expect(fs.readdirSync(cwd)).to.include('leftover.txt');
  });

  it('explicitly forgets a checkout whose Git directory is gone despite leftover files', async () => {
    await register('explicit');
    fs.rmSync(common, { recursive: true });
    expect(fs.existsSync(cwd)).to.equal(true);
    const dry = forget(['--missing', '--dry-run', '--json']);
    expect(dry.status, dry.stderr).to.equal(0);
    expect(JSON.parse(dry.stdout)).to.deep.equal({
      forgotten: [{ repository: common }],
      dryRun: true,
    });
    const done = forget(['--repo', cwd, '--json']);
    expect(done.status, done.stderr).to.equal(0);
    expect(JSON.parse(done.stdout)).to.deep.equal({ repository: common });
    expect(record().repositories).to.deep.equal([]);
    expect(fs.existsSync(cwd)).to.equal(true);
  });

  it('protects a relocated Git directory left as a .git file', async () => {
    const separate = path.join(root, 'separate.git');
    git('init', '--separate-git-dir', separate);
    expect(fs.lstatSync(common).isFile()).to.equal(true);
    expect(canForget(record(), common, true)).to.equal(false);
    expect(canForget(record(), common, false)).to.equal(false);
    const { forgotten, deferred } = await upgrade();
    expect(forgotten).to.deep.equal([]);
    expect(deferred).to.have.length(1);
    expect(deferred[0].kind).to.equal('blocked');
    expect(record().repositories).to.include(common);
    expect(forget(['--repo', common]).status).to.equal(1);
  });

  it('records filesystem devices and retains observations for removed linked worktrees', async () => {
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '--detach', linked);
    await register();
    const devices = record().registrations![common].pathDevices!;
    expect(devices[common]).to.equal(fs.statSync(common).dev);
    expect(devices[cwd]).to.equal(fs.statSync(cwd).dev);
    expect(devices[linked]).to.equal(fs.statSync(linked).dev);
    git('worktree', 'remove', linked);
    await register();
    expect(record().registrations![common].worktrees).to.include(linked);
    expect(record().registrations![common].pathDevices).to.deep.equal(devices);
    fs.rmSync(cwd, { recursive: true });
    expect((await upgrade()).forgotten).to.have.length(1);
  });

  it('retains a missing Git directory when its recorded volume may be unmounted', async () => {
    const p = plan();
    // No mount privileges needed: record the checkout as if its volume had been
    // mounted at a directory that is now gone, the way an unmounted volume under
    // /Volumes looks. This must not fall back to HOME's filesystem and forget it.
    const volume = path.join(root, 'volume');
    p.record!.registrations![common].pathMounts![common] = volume;
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    expect(canForget(record(), common, true)).to.equal(false);
    expect(automaticForgetBlocker(record(), common)).to.contain(
      `recorded on the mount ${volume}`
    );
    const { deferred, forgotten } = await upgrade();
    expect(forgotten).to.deep.equal([]);
    expect(deferred).to.have.length(1);
    expect(deferred[0].kind).to.equal('missing');
    expect(deferred[0].retained).to.contain('volume may be unmounted');
    expect(deferred[0].retained).to.contain(common);
    expect(record().pendingBindings!.repositories).to.include(common);
    // An explicit decision to forget is still supported.
    expect(forget(['--repo', common]).status).to.equal(0);
  });

  it('records mount points and forgets a deleted checkout after a reboot renumbered its device', async () => {
    const registration = record().registrations![common];
    const mount = mountPoint(cwd);
    expect(path.relative(mount, cwd).startsWith('..')).to.equal(false);
    expect(mountPoint(mount)).to.equal(mount);
    expect(registration.pathMounts).to.deep.equal({
      [common]: mount,
      [cwd]: mount,
    });
    // macOS assigns APFS device numbers at mount time, so every recorded device
    // is stale after a reboot while the data volume is still mounted.
    const p = plan();
    for (const file of Object.keys(registration.pathDevices!))
      p.record!.registrations![common].pathDevices![file]++;
    p.record!.registrations![common].temporaryRoot = {
      path: root,
      device: fs.statSync(root).dev + 1,
      inode: fs.statSync(root).ino,
    };
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    expect(automaticForgetBlocker(record(), common)).to.equal(undefined);
    const result = await upgrade();
    expect(result.deferred).to.deep.equal([]);
    expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal([
      common,
    ]);
    expect(record().repositories).not.to.include(common);
  });

  it('keeps a mount-identified checkout when a new mount now covers its location', async () => {
    // The record says the checkout lived on the filesystem mounted at `mount`;
    // the nearest existing ancestor now reports a mount point below it.
    const p = plan();
    p.record!.registrations![common].pathMounts![common] = path.parse(
      mountPoint(cwd)
    ).root;
    fs.writeFileSync(
      path.join(p.directory, 'launcher.json'),
      JSON.stringify(p.record)
    );
    fs.rmSync(cwd, { recursive: true });
    if (mountPoint(root) === path.parse(root).root) {
      // Same mount either way on a single-filesystem machine: still deleted.
      expect(canForget(record(), common, true)).to.equal(true);
      return;
    }
    expect(automaticForgetBlocker(record(), common)).to.contain(
      `now under ${mountPoint(root)}`
    );
    expect(canForget(record(), common, true)).to.equal(false);
  });

  describe('records before 0.6.34 (device numbers only)', () => {
    const legacy = (
      device: number,
      mutate: (record: LauncherRecord) => void = () => {}
    ) => {
      const p = plan();
      const registration = p.record!.registrations![common];
      delete registration.pathMounts;
      delete registration.temporaryRoot;
      registration.pathDevices![common] = device;
      mutate(p.record!);
      fs.writeFileSync(
        path.join(p.directory, 'launcher.json'),
        JSON.stringify(p.record)
      );
      fs.rmSync(cwd, { recursive: true });
    };
    const device = () => fs.statSync(root).dev;

    it('keeps a missing checkout whose device differs when nothing proves a renumbering', async () => {
      legacy(device() + 1);
      expect(automaticForgetBlocker(record(), common)).to.contain(
        'Filesystem device changed'
      );
      const { deferred, forgotten } = await upgrade();
      expect(forgotten).to.deep.equal([]);
      expect(deferred).to.have.length(1);
      expect(deferred[0].retained).to.contain('volume may be unmounted');
    });

    it('forgets it when a surviving registered path recorded the same stale device', async () => {
      const survivor = path.join(root, 'survivor', '.git');
      legacy(device() + 1, (r) => {
        r.registrations![survivor] = {
          source: 'explicit',
          worktrees: [path.dirname(survivor)],
          pathDevices: { [path.dirname(survivor)]: device() + 1 },
        };
      });
      // A missing, symlinked, or non-directory path proves nothing.
      expect(canForget(record(), common, true)).to.equal(false);
      fs.symlinkSync(root, path.join(root, 'survivor'));
      expect(canForget(record(), common, true)).to.equal(false);
      fs.unlinkSync(path.join(root, 'survivor'));
      fs.writeFileSync(path.join(root, 'survivor'), 'file');
      expect(canForget(record(), common, true)).to.equal(false);
      fs.unlinkSync(path.join(root, 'survivor'));
      fs.mkdirSync(path.join(root, 'survivor'));
      expect(automaticForgetBlocker(record(), common)).to.equal(undefined);
      const result = await upgrade();
      expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal([
        common,
      ]);
    });

    it('accepts a recorded temporary root as evidence, but not a different stale device', async () => {
      legacy(device() + 1, (r) => {
        r.registrations![common].temporaryRoot = {
          path: root,
          device: device() + 2,
          inode: fs.statSync(root).ino,
        };
      });
      expect(canForget(record(), common, true)).to.equal(false);
      const p = plan();
      p.record!.registrations![common].temporaryRoot!.device = device() + 1;
      fs.writeFileSync(
        path.join(p.directory, 'launcher.json'),
        JSON.stringify(p.record)
      );
      expect(canForget(record(), common, true)).to.equal(true);
      expect((await upgrade()).forgotten).to.have.length(1);
    });

    it('cleans up before refreshing survivors that hold the renumbering evidence', async () => {
      // The survivor sorts before the deleted checkout. Refreshing it first
      // would replace the stale device that proves the renumbering.
      const survivorCwd = path.join(root, 'aaa-survivor');
      fs.mkdirSync(survivorCwd);
      execFileSync('git', ['-C', survivorCwd, 'init', '-b', 'main'], {
        stdio: 'pipe',
      });
      const survivor = fs.realpathSync(path.join(survivorCwd, '.git'));
      await withLauncher(slot, async (p) => {
        // A saved native selection: the binding needs no refresh, but the
        // registration's filesystem observations still get renewed.
        writeState(new Repository(survivorCwd), {
          schemaVersion: 1,
          mode: 'graphite',
          session: '1-0123456789ab',
          candidate: { node: process.execPath, script: dispatcher },
          native: p.native,
          nativeAbsent: true,
          nativeDigest: ABSENT_NATIVE_DIGEST,
          prCache: null,
          repoConfig: null,
        });
        registerRepository(
          p,
          p.record!,
          survivor,
          registrationSnapshot(new Repository(survivorCwd), 'explicit')
        );
      });
      legacy(device() + 1, (r) => {
        for (const file of Object.keys(r.registrations![survivor].pathDevices!))
          r.registrations![survivor].pathDevices![file] = device() + 1;
      });
      expect([common, survivor].sort()).to.deep.equal([survivor, common]);
      const result = await upgrade();
      expect(result.deferred).to.deep.equal([]);
      expect(result.forgotten.map((entry) => entry.repository)).to.deep.equal([
        common,
      ]);
      const refreshed = record().registrations![survivor];
      expect(refreshed.pathDevices![survivor]).to.equal(device());
      expect(refreshed.pathMounts![survivor]).to.equal(mountPoint(survivor));
    });
  });

  it('protects unknown legacy paths outside HOME/temp rather than guessing their device', () => {
    const r = record();
    const unknown = '/gt-cli-unknown-volume/deleted/.git';
    r.repositories = [unknown];
    delete r.registrations;
    expect(canForget(r, unknown, true)).to.equal(false);
    expect(automaticForgetBlocker(r, unknown)).to.contain(
      'Filesystem identity is unknown'
    );
    // A path-prefix lookalike does not qualify as the recorded temporary root.
    const lookalike = record();
    lookalike.repositories = [unknown];
    lookalike.registrations = {
      [unknown]: {
        source: 'adopted',
        worktrees: [path.dirname(unknown)],
        temporaryRoot: {
          path: '/gt-cli-unknown-volume-not-temp',
          device: fs.statSync(root).dev,
          inode: 1,
        },
      },
    };
    expect(canForget(lookalike, unknown, true)).to.equal(false);
    expect(automaticForgetBlocker(lookalike, unknown)).to.contain(
      'Filesystem identity is unknown'
    );
  });

  it('protects dangling symlinks, symlinked ancestors, and ENOTDIR', () => {
    fs.rmSync(cwd, { recursive: true });
    fs.symlinkSync(path.join(root, 'absent'), cwd);
    expect(canForget(record(), common, true)).to.equal(false);
    expect(() => canonicalRegistrationPath(common)).to.throw();
    fs.unlinkSync(cwd);
    fs.writeFileSync(cwd, 'not a directory');
    expect(canForget(record(), common, true)).to.equal(false);
    expect(() => canonicalRegistrationPath(common)).to.throw();
  });

  it('keeps registration if a checkout reappears during cleanup', () => {
    fs.rmSync(cwd, { recursive: true });
    const p = plan();
    const before = fs.readFileSync(
      path.join(p.directory, 'launcher.json'),
      'utf8'
    );
    // The record is read after the first safety check; recreate only the Git
    // directory there, since a recreated working directory alone no longer
    // keeps the registration.
    const pending = p.record!.pendingBindings;
    Object.defineProperty(p.record!, 'pendingBindings', {
      configurable: true,
      enumerable: true,
      get() {
        fs.mkdirSync(common, { recursive: true });
        return pending;
      },
    });
    expect(() => forgetRegistration(p, p.record!, common, true)).to.throw(
      'Git directory reappeared'
    );
    expect(
      fs.readFileSync(path.join(p.directory, 'launcher.json'), 'utf8')
    ).to.equal(before);
  });

  it('does not interpret permission errors as deletion', async function () {
    if (process.getuid?.() === 0) this.skip();
    fs.chmodSync(cwd, 0);
    try {
      const result = await upgrade();
      expect(result.forgotten).to.deep.equal([]);
      expect(result.deferred).to.have.length(1);
      expect(result.deferred[0].reason).to.contain('EACCES');
      expect(record().repositories).to.include(common);
    } finally {
      fs.chmodSync(cwd, 0o700);
    }
  });

  it('supports explicit forget and dry-run for legacy/deleted paths with spaces', async () => {
    await register('explicit');
    fs.rmSync(cwd, { recursive: true });
    const before = record();
    const dry = forget(['--repo', cwd, '--dry-run', '--json']);
    expect(dry.status, dry.stderr).to.equal(0);
    expect(JSON.parse(dry.stdout).dryRun).to.equal(true);
    expect(record()).to.deep.equal(before);
    const done = forget(['--repo', common, '--json']);
    expect(done.status, done.stderr).to.equal(0);
    expect(JSON.parse(done.stdout)).to.deep.equal({ repository: common });
    expect(record().repositories).to.deep.equal([]);
    expect(forget(['--repo', common]).status).to.equal(1);
    expect(forget(['--global']).status).to.equal(1);
  });

  it('validates metadata and leaves other registrations untouched', async () => {
    expect(
      validRegistrations({ [common]: { source: 'guessed', worktrees: [] } })
    ).to.equal(false);
    expect(
      validRegistrations({
        [common]: { source: 'adopted', worktrees: ['relative'] },
      })
    ).to.equal(false);
    for (const pathDevices of [
      { relative: 1 },
      { [common]: -1 },
      { [common]: 1.5 },
      { [common]: 'not a device' },
      [],
    ])
      expect(
        validRegistrations({
          [common]: { source: 'explicit', worktrees: [cwd], pathDevices },
        })
      ).to.equal(false);
    for (const pathMounts of [
      { relative: '/' },
      { [common]: 'relative' },
      { [common]: 1 },
      { [common]: null },
      [],
    ])
      expect(
        validRegistrations({
          [common]: { source: 'explicit', worktrees: [cwd], pathMounts },
        })
      ).to.equal(false);
    expect(
      validRegistrations({
        [common]: {
          source: 'explicit',
          worktrees: [cwd],
          pathDevices: { [common]: 1 },
          pathMounts: { [common]: '/' },
        },
      })
    ).to.equal(true);
    const p = plan();
    p.record!.repositories.push('/non-temp/keep/.git');
    fs.rmSync(cwd, { recursive: true });
    forgetRegistration(p, p.record!, common, true);
    expect(
      readLauncher(path.join(p.directory, 'launcher.json')).repositories
    ).to.deep.equal(['/non-temp/keep/.git']);
  });
});
