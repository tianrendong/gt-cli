import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  installLauncher,
  planLauncher,
  readLauncher,
  registerRepository,
  releaseRepository,
  setGlobalMode,
  withLauncher,
} from '../../src/lib/switch/launcher';

describe('gt executable switching safety (no proprietary CLI required)', function () {
  this.timeout(20_000);
  let root: string, slot: string, dispatcher: string, common: string;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-launcher-test-'));
    const bin = path.join(root, "bin path's");
    fs.mkdirSync(bin);
    common = path.join(root, 'repo.git');
    fs.mkdirSync(common);
    fs.writeFileSync(
      path.join(root, 'native'),
      '#!/bin/sh\nif [ "$1" = --version ]; then printf "1.8.6\\n"; else printf "native\\n"; fi\n',
      { mode: 0o755 }
    );
    slot = path.join(bin, 'gt');
    fs.symlinkSync('../native', slot);
    dispatcher = path.join(root, 'dispatcher.js');
    fs.writeFileSync(
      dispatcher,
      'console.log(JSON.stringify(process.argv.slice(2)));\n'
    );
    previous = Object.fromEntries(
      ['PATH', 'HOME', 'XDG_STATE_HOME'].map((key) => [key, process.env[key]])
    );
    process.env.PATH = bin + path.delimiter + process.env.PATH;
    process.env.HOME = path.join(root, 'home');
    process.env.XDG_STATE_HOME = path.join(root, "state path's");
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  it('plans without changing the selected entry or creating state directories', () => {
    const plan = planLauncher();
    expect(plan.native.version).to.equal('1.8.6');
    expect(fs.readlinkSync(slot)).to.equal('../native');
    expect(fs.existsSync(process.env.XDG_STATE_HOME!)).to.equal(false);
  });
  it('preserves arguments and relative native links through paths with spaces and quotes', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      let record = installLauncher(plan, dispatcher);
      record = registerRepository(plan, record, common);
      expect(
        JSON.parse(
          execFileSync('gt', ['info', "branch's name"], { encoding: 'utf8' })
        )
      ).to.deep.equal(['info', "branch's name"]);
      releaseRepository(plan, record, common);
      expect(fs.readlinkSync(slot)).to.equal('../native');
    });
  });
  it('keeps native Graphite available to other OS users without exposing private state', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const getuid = process.getuid!;
      let record;
      try {
        process.getuid = () => getuid() + 1;
        record = installLauncher(plan, dispatcher);
      } finally {
        process.getuid = getuid;
      }
      fs.unlinkSync(dispatcher);
      expect(
        execFileSync('gt', ['--version'], { encoding: 'utf8' }).trim()
      ).to.equal('1.8.6');
      expect(fs.statSync(record!.router).mode & 0o777).to.equal(0o755);
      releaseRepository(plan, record!, common);
    });
  });
  it('updates the installation path without pinning the router to a removed installation', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const original = installLauncher(plan, dispatcher);
      const replacement = path.join(root, 'new-dispatcher.js');
      fs.writeFileSync(replacement, 'console.log("updated");\n');
      const current = installLauncher(planLauncher(), replacement);
      expect(current.routerDigest).to.equal(original.routerDigest);
      fs.unlinkSync(dispatcher);
      expect(
        execFileSync('gt', ['info'], { encoding: 'utf8' }).trim()
      ).to.equal('updated');
      releaseRepository(plan, current, common);
    });
  });
  it('global mode pins the dispatcher after the last per-repository disable', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      setGlobalMode(plan, dispatcher, true);
      let current = planLauncher();
      expect(current.record?.schemaVersion).to.equal(2);
      expect(current.record?.defaultMode).to.equal('gt-gh');
      const record = registerRepository(current, current.record!, common);
      expect(releaseRepository(current, record, common).restored).to.equal(
        false
      );
      current = planLauncher();
      expect(
        JSON.parse(execFileSync('gt', ['--version'], { encoding: 'utf8' }))
      ).to.deep.equal(['--version']);
      expect(setGlobalMode(current, dispatcher, false).restored).to.equal(true);
      expect(fs.readlinkSync(slot)).to.equal('../native');
    });
  });
  it('does not restore the executable on global disable while repositories remain registered', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      let record = installLauncher(plan, dispatcher);
      record = registerRepository(plan, record, common);
      setGlobalMode(planLauncher(), dispatcher, true);
      expect(
        setGlobalMode(planLauncher(), dispatcher, false).restored
      ).to.equal(false);
      const current = planLauncher();
      expect(current.record?.defaultMode).to.equal('graphite');
      expect(
        releaseRepository(current, current.record!, common).restored
      ).to.equal(true);
    });
  });
  it('rejects malformed global-mode records rather than guessing a backend', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const record = installLauncher(plan, dispatcher);
      const file = path.join(plan.directory, 'launcher.json');
      for (const invalid of [
        { schemaVersion: 2 },
        { schemaVersion: 2, defaultMode: 'other' },
        { schemaVersion: 1, defaultMode: 'gt-gh' },
      ]) {
        fs.writeFileSync(file, JSON.stringify({ ...record, ...invalid }));
        expect(() => readLauncher(file)).to.throw('Invalid gt launcher');
      }
    });
  });
  it('pins Node independently of PATH and ignores stale GT_NODE_BIN exports', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const record = installLauncher(plan, dispatcher);
      fs.writeFileSync(
        path.join(path.dirname(slot), 'node'),
        '#!/bin/sh\nprintf "ambient Node used" >&2\nexit 99\n',
        { mode: 0o755 }
      );
      const env = {
        ...process.env,
        PATH: path.dirname(slot) + ':/usr/bin:/bin',
        GT_NODE_BIN: '/missing/old-node',
      };
      expect(
        JSON.parse(execFileSync('gt', ['hello'], { env, encoding: 'utf8' }))
      ).to.deep.equal(['hello']);
      expect(record.node).to.equal(fs.realpathSync(process.execPath));
      releaseRepository(plan, record, common);
    });
  });
  it('resumes a legacy launcher runtime upgrade interrupted after its checkpoint', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const record = installLauncher(plan, dispatcher);
      const legacy =
        '#!/bin/sh\nexec node ' +
        JSON.stringify(path.join(plan.directory, 'bootstrap.cjs')) +
        ' "$@"\n';
      fs.writeFileSync(record.router, legacy);
      delete record.node;
      record.routerDigest = createHash('sha256').update(legacy).digest('hex');
      fs.unlinkSync(path.join(plan.directory, 'node'));
      fs.writeFileSync(
        path.join(plan.directory, 'launcher.json'),
        JSON.stringify(record)
      );
      const rename = fs.renameSync;
      try {
        fs.renameSync = (from, to) => {
          if (to === path.join(plan.directory, 'node'))
            throw Error('injected runtime interruption');
          return rename(from, to);
        };
        expect(() => installLauncher(planLauncher(), dispatcher)).to.throw(
          'injected runtime interruption'
        );
      } finally {
        fs.renameSync = rename;
      }
      expect(planLauncher().record?.runtimeUpgrade).not.to.equal(undefined);
      const recovered = installLauncher(planLauncher(), dispatcher);
      expect(recovered.runtimeUpgrade).to.equal(undefined);
      expect(
        JSON.parse(
          execFileSync('gt', ['recovered'], {
            env: {
              ...process.env,
              PATH: path.dirname(slot) + ':/usr/bin:/bin',
            },
            encoding: 'utf8',
          })
        )
      ).to.deep.equal(['recovered']);
      releaseRepository(plan, recovered, common);
    });
  });
  it('refuses an externally replaced runtime link without altering its record', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      installLauncher(plan, dispatcher);
      const record = path.join(plan.directory, 'launcher.json'),
        before = fs.readFileSync(record);
      fs.unlinkSync(path.join(plan.directory, 'node'));
      fs.symlinkSync('/bin/sh', path.join(plan.directory, 'node'));
      expect(() => planLauncher()).to.throw('runtime changed outside');
      expect(fs.readFileSync(record).equals(before)).to.equal(true);
    });
  });
  it('refuses a different PATH slot instead of modifying an unrelated executable', () => {
    expect(() => planLauncher(path.join(root, 'gt'))).to.throw(
      'currently selected by PATH'
    );
    expect(fs.readlinkSync(slot)).to.equal('../native');
  });
  it('does not replace arbitrary executable wrapper scripts', () => {
    fs.unlinkSync(slot);
    fs.copyFileSync(path.join(root, 'native'), slot);
    fs.chmodSync(slot, 0o755);
    expect(() => planLauncher()).to.throw('wrapper script');
    expect(fs.lstatSync(slot).isFile()).to.equal(true);
  });
  it('refuses external changes to its launcher without rewriting the record or executable', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      let record = installLauncher(plan, dispatcher);
      record = registerRepository(plan, record, common);
      const file = path.join(plan.directory, 'launcher.json'),
        before = fs.readFileSync(file);
      fs.appendFileSync(record.router, '# changed externally\n');
      expect(() => planLauncher()).to.throw('changed outside');
      expect(() => releaseRepository(plan, record, common)).to.throw(
        'changed outside'
      );
      expect(fs.readFileSync(file).equals(before)).to.equal(true);
    });
  });
  it('rejects malformed original-entry metadata before restoring anything', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      const record = installLauncher(plan, dispatcher),
        file = path.join(plan.directory, 'launcher.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...record,
          original: { kind: 'file', digest: 'invalid', mode: 'bad' },
        })
      );
      expect(() => readLauncher(file)).to.throw('Invalid gt launcher');
      expect(fs.readlinkSync(slot)).to.equal(record.router);
    });
  });
  it('never follows a symlinked installer record', async () => {
    await withLauncher(planLauncher().slot, async (plan) => {
      installLauncher(plan, dispatcher);
      const file = path.join(plan.directory, 'launcher.json'),
        outside = path.join(root, 'outside');
      fs.renameSync(file, outside);
      fs.symlinkSync(outside, file);
      expect(() => planLauncher()).to.throw('symlinked launcher state');
      expect(fs.existsSync(outside)).to.equal(true);
    });
  });
});
