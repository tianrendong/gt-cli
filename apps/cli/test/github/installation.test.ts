import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../..');
const install = path.join(cli, 'install.sh');
const tools = require(path.join(cli, 'scripts/installation/install_tools.cjs'));

describe('three-command installation bootstrap', function () {
  this.timeout(30_000);
  let root: string, env: NodeJS.ProcessEnv;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-install-test-'));
    fs.mkdirSync(path.join(root, 'bin'));
    env = {
      ...process.env,
      HOME: root,
      GT_CLI_HOME: path.join(root, 'install'),
      PATH: path.join(root, 'bin') + ':/usr/bin:/bin',
    };
    delete env.GT_NODE_BIN;
    fs.writeFileSync(path.join(root, 'bin/node'), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  );

  it('shows the complete three-command flow without Node, downloads, or mutations', () => {
    const result = spawnSync(install, ['--help'], { env, encoding: 'utf8' });
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain('gt-cli enable');
    expect(result.stdout).to.contain('gt-cli disable');
    expect(fs.existsSync(env.GT_CLI_HOME!)).to.equal(false);
  });
  it('rejects a substituted runtime archive before extraction or activation', () => {
    fs.writeFileSync(
      path.join(root, 'bin/curl'),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = --output ]; then shift; printf invalid > "$1"; exit 0; fi\nshift\ndone\nexit 1\n',
      { mode: 0o755 }
    );
    const result = spawnSync(install, ['--non-interactive', '--skip-auth'], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status).to.equal(1);
    expect(result.stderr).to.contain('checksum mismatch');
    expect(fs.existsSync(path.join(env.GT_CLI_HOME!, 'current'))).to.equal(
      false
    );
    expect(
      fs.readdirSync(path.join(env.GT_CLI_HOME!, 'versions'))
    ).to.deep.equal([]);
  });
  it('refuses symlinked installation roots without changing the target', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'unchanged');
    fs.symlinkSync(outside, env.GT_CLI_HOME!);
    const result = spawnSync(install, [], { env, encoding: 'utf8' });
    expect(result.status).to.equal(1);
    expect(result.stderr).to.contain('symlinked installation directory');
    expect(fs.readdirSync(outside)).to.deep.equal(['keep']);
  });
  it('canonicalizes existing gt slots before comparing them with launcher plans', () => {
    fs.writeFileSync(path.join(root, 'bin/gt'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const slot = tools.nativeSlot(env.PATH);
    expect(slot).to.deep.equal({
      slot: path.join(fs.realpathSync(path.join(root, 'bin')), 'gt'),
      create: false,
    });
  });
  it('never replaces a concurrently published installation pointer', () => {
    const pointer = path.join(root, 'current');
    fs.symlinkSync('newer', pointer);
    expect(() => tools.replaceLink('older', pointer, undefined)).to.throw(
      'Concurrent replacement'
    );
    expect(fs.readlinkSync(pointer)).to.equal('newer');
  });
});
