import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { workingDirectory } from '../../src/lib/switch/batch';
import { RepositoryMissingError } from '../../src/lib/switch/repository';

describe('registered repository diagnostics', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-registered-repo-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('names missing registrations and does not recreate or silently forget them', () => {
    // os.tmpdir() may sit behind a symlink (macOS /var); existing ancestors are
    // canonicalized before deletion is judged certain.
    const common = path.join(root, 'gone', '.git');
    let caught: unknown;
    try {
      workingDirectory(common);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(RepositoryMissingError);
    const message = (caught as Error).message;
    expect(message).to.contain('Registered Git directory is missing');
    expect(message).to.contain(common);
    expect(message).to.contain('explicitly remove its saved gt registration');
    expect(message).to.contain('gt-cli forget --missing');
    expect(message).to.contain('No registration was removed automatically');
    expect(message).not.to.contain('global disable');
    expect(fs.existsSync(common)).to.equal(false);
  });

  it('does not call an unreadable or dangling registration missing', function () {
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'absent'), dangling);
    let caught: unknown;
    try {
      workingDirectory(path.join(dangling, '.git'));
    } catch (error) {
      caught = error;
    }
    expect(caught).not.to.be.instanceOf(RepositoryMissingError);
    expect((caught as Error).message).to.contain('inaccessible');
    expect((caught as Error).message).to.contain('Restore this checkout');
    if (process.getuid?.() === 0) this.skip();
    const sealed = path.join(root, 'sealed');
    fs.mkdirSync(sealed);
    fs.chmodSync(sealed, 0);
    try {
      caught = undefined;
      try {
        workingDirectory(path.join(sealed, 'repo', '.git'));
      } catch (error) {
        caught = error;
      }
      expect(caught).not.to.be.instanceOf(RepositoryMissingError);
      expect((caught as Error).message).to.contain('inaccessible');
    } finally {
      fs.chmodSync(sealed, 0o700);
    }
  });

  it('explains a leftover .git directory that Git no longer recognizes', () => {
    const common = path.join(root, 'partial checkout', '.git');
    const metadata = path.join(common, 'gt-gh-switch');
    fs.mkdirSync(metadata, { recursive: true });
    const marker = path.join(metadata, 'state.json');
    fs.writeFileSync(marker, '{"keep":"for recovery"}\n');
    let message = '';
    try {
      workingDirectory(common);
    } catch (error) {
      message = error.message;
    }
    expect(message).to.contain('Git cannot read this registered repository');
    expect(message).to.contain('not a git repository');
    expect(message).to.contain(common);
    expect(message).to.contain('Restore this checkout');
    expect(message).not.to.contain('Command failed:');
    expect(fs.readFileSync(marker, 'utf8')).to.equal(
      '{"keep":"for recovery"}\n'
    );
    expect(fs.readdirSync(common)).to.deep.equal(['gt-gh-switch']);
  });

  it('still resolves usable registered repositories, including paths with spaces', () => {
    const repo = path.join(root, 'valid checkout');
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    expect(fs.realpathSync(workingDirectory(path.join(repo, '.git')))).to.equal(
      fs.realpathSync(repo)
    );
  });
});
