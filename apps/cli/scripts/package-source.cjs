#!/usr/bin/env node
// Include complete corresponding source with the AGPL binary distribution.
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const cli = path.resolve(__dirname, '..');
const git = (...args) =>
  cp
    .execFileSync('git', ['-C', cli, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    .trim();
const root = git('rev-parse', '--show-toplevel');
if (
  cp
    .execFileSync(
      'git',
      ['-C', root, 'status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8' }
    )
    .trim()
) {
  throw new Error(
    'Refusing to package uncommitted source. Commit changes first so source.tar.gz exactly matches the published build.'
  );
}
const target = path.join(cli, 'source.tar.gz');
const temporary = `${target}.${process.pid}.tmp`;
try {
  cp.execFileSync(
    'git',
    [
      '-C',
      root,
      'archive',
      '--format=tar.gz',
      '--prefix=gt-cli-source/',
      `--output=${temporary}`,
      'HEAD',
    ],
    { stdio: 'pipe' }
  );
  fs.renameSync(temporary, target);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
// npm renders the package-root README, not the repository-root README.
fs.copyFileSync(path.join(root, 'README.md'), path.join(cli, 'README.md'));
