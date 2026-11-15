import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

describe('npm corresponding-source archive', function () {
  this.timeout(15_000);
  let root: string;
  const cli = path.resolve(__dirname, '../../..');
  const script = path.join(cli, 'scripts/package-source.cjs');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, 'apps/cli/scripts/package-source.cjs')],
      { cwd: root, encoding: 'utf8' }
    );
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-package-source-'));
    for (const file of [
      'apps/cli/scripts/package-source.cjs',
      'libs/types/index.ts',
      '.yarn/releases/yarn.cjs',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        file === 'apps/cli/scripts/package-source.cjs'
          ? fs.readFileSync(script)
          : '// fixture\n'
      );
    }
    fs.writeFileSync(
      path.join(root, '.gitignore'),
      fs.readFileSync(path.join(cli, '../../.gitignore'), 'utf8') +
        '\n/ignored-secret\n'
    );
    fs.writeFileSync(
      path.join(root, 'README.md'),
      '# Repository README\n\nShared GitHub and npm documentation.\n'
    );
    fs.writeFileSync(
      path.join(root, 'apps/cli/USAGE.md'),
      '# Detailed CLI guide\n'
    );
    const { files } = JSON.parse(
      fs.readFileSync(path.join(cli, 'package.json'), 'utf8')
    );
    fs.writeFileSync(
      path.join(root, 'apps/cli/package.json'),
      JSON.stringify({
        name: 'readme-fixture',
        version: '1.0.0',
        files,
        scripts: { prepack: 'node scripts/package-source.cjs' },
      })
    );
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'yarn.lock'), '# fixture\n');
    git('init', '-b', 'main');
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'source'
    );
    fs.writeFileSync(path.join(root, 'ignored-secret'), 'never package me');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('includes committed workspace files and excludes local metadata/secrets', () => {
    const result = run();
    expect(result.status, result.stderr).to.equal(0);
    const files = execFileSync(
      'tar',
      ['-tzf', path.join(root, 'apps/cli/source.tar.gz')],
      { encoding: 'utf8' }
    );
    expect(files).to.contain('gt-cli-source/libs/types/index.ts');
    expect(files).to.contain('gt-cli-source/.yarn/releases/yarn.cjs');
    expect(files).to.contain('gt-cli-source/yarn.lock');
    expect(files).to.contain('gt-cli-source/README.md');
    expect(files).to.contain('gt-cli-source/apps/cli/USAGE.md');
    expect(files).not.to.contain('gt-cli-source/apps/cli/README.md');
    expect(files).not.to.contain('ignored-secret');
    expect(files).not.to.contain('gt-cli-source/.git/');
    expect(files).not.to.contain('source.tar.gz');
  });
  it('copies the root README without changing tracked files or the detailed guide', () => {
    const result = run();
    expect(result.status, result.stderr).to.equal(0);
    expect(
      fs.readFileSync(path.join(root, 'apps/cli/README.md'))
    ).to.deep.equal(fs.readFileSync(path.join(root, 'README.md')));
    expect(
      fs.readFileSync(path.join(root, 'apps/cli/USAGE.md'), 'utf8')
    ).to.equal('# Detailed CLI guide\n');
    expect(git('status', '--porcelain', '--untracked-files=all')).to.equal('');
  });
  it('overwrites a stale generated README and supports repeated packing', () => {
    fs.writeFileSync(path.join(root, 'apps/cli/README.md'), '# Stale README\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run();
      expect(result.status, result.stderr).to.equal(0);
      expect(
        fs.readFileSync(path.join(root, 'apps/cli/README.md'))
      ).to.deep.equal(fs.readFileSync(path.join(root, 'README.md')));
      expect(git('status', '--porcelain', '--untracked-files=all')).to.equal(
        ''
      );
    }
  });
  it('includes the canonical README and detailed guide in the npm tarball', () => {
    const destination = path.join(root, 'pkg');
    fs.mkdirSync(destination);
    const [packed] = JSON.parse(
      execFileSync(
        'npm',
        ['pack', '--offline', '--json', '--pack-destination', destination],
        { cwd: path.join(root, 'apps/cli'), encoding: 'utf8', stdio: 'pipe' }
      )
    );
    const archive = path.join(destination, packed.filename);
    for (const file of ['README.md', 'USAGE.md']) {
      expect(
        execFileSync('tar', ['-xOf', archive, `package/${file}`])
      ).to.deep.equal(
        fs.readFileSync(
          path.join(root, file === 'README.md' ? file : `apps/cli/${file}`)
        )
      );
    }
    expect(git('status', '--porcelain', '--untracked-files=all')).to.equal('');
  });
  it('refuses changed tracked source before creating an archive', () => {
    fs.appendFileSync(path.join(root, 'package.json'), ' ');
    const result = run();
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.contain('Refusing to package uncommitted source');
    expect(fs.existsSync(path.join(root, 'apps/cli/source.tar.gz'))).to.equal(
      false
    );
    expect(fs.existsSync(path.join(root, 'apps/cli/README.md'))).to.equal(
      false
    );
  });
  it('refuses untracked source before creating an archive', () => {
    fs.writeFileSync(path.join(root, 'new.ts'), '// new source');
    const result = run();
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.contain('Refusing to package uncommitted source');
  });
});
