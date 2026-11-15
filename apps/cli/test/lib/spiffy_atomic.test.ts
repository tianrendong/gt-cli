import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { userConfigFactory } from '../../src/lib/spiffy/user_config_spf';

describe('spiffy atomic writes', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-spiffy-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('replaces the file in one rename and leaves no temporary behind', () => {
    const file = path.join(root, 'config');
    fs.writeFileSync(file, JSON.stringify({ tips: true }));
    const inode = fs.statSync(file).ino;
    userConfigFactory.load(file).update((data) => {
      data.tips = false;
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tips).to.equal(false);
    expect(fs.statSync(file).ino).not.to.equal(inode);
    expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
    expect(fs.readdirSync(root)).to.deep.equal(['config']);
  });

  it('writes through a symlink instead of replacing it', () => {
    const target = path.join(root, 'dotfiles', 'config');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ tips: true }));
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);
    userConfigFactory.load(link).update((data) => {
      data.tips = false;
    });
    expect(fs.lstatSync(link).isSymbolicLink()).to.equal(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).tips).to.equal(false);
    expect(fs.readdirSync(path.dirname(target))).to.deep.equal(['config']);
  });
});
