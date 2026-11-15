import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const cli = path.resolve(__dirname, '../../..');
const api = require(path.join(cli, 'scripts/installation/update.cjs'));
const tools = require(path.join(cli, 'scripts/installation/install_tools.cjs'));

describe('registry-backed updater boundaries', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-update-test-'));
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  );

  it('requires canonical package identity and SHA-512 registry integrity', () => {
    const valid = {
      name: '@tianrendong/gt-cli',
      version: '0.5.0',
      dist: { integrity: 'sha512-YWJjZA==' },
    };
    expect(api.manifest(valid)).to.equal(valid);
    for (const bad of [
      { ...valid, name: 'other' },
      { ...valid, version: 'latest' },
      { ...valid, dist: { integrity: 'sha1-abc' } },
    ])
      expect(() => api.manifest(bad)).to.throw(
        'invalid package/version/integrity'
      );
  });
  it('checks actual downloaded bytes, not just the npm pack manifest', () => {
    const bytes = Buffer.from('verified artifact'),
      file = path.join(root, 'artifact.tgz');
    fs.writeFileSync(file, bytes);
    const metadata = {
      dist: {
        integrity:
          'sha512-' +
          crypto.createHash('sha512').update(bytes).digest('base64'),
      },
    };
    expect(api.verifyArtifact(file, metadata)).to.equal(
      crypto.createHash('sha256').update(bytes).digest('hex')
    );
    fs.appendFileSync(file, 'tampered');
    expect(() => api.verifyArtifact(file, metadata)).to.throw(
      'integrity mismatch'
    );
    const link = path.join(root, 'link.tgz');
    fs.symlinkSync(file, link);
    expect(() => api.verifyArtifact(link, metadata)).to.throw(
      'Unsafe downloaded artifact'
    );
  });
  it('rejects malformed or traversal-bearing update checkpoints', () => {
    fs.writeFileSync(
      path.join(root, 'update.json'),
      JSON.stringify({
        schemaVersion: 1,
        from: 'versions/.install-a',
        target: '../outside',
        version: '0.5.0',
        artifactSha256: 'a'.repeat(64),
      })
    );
    expect(() => api.pending(root)).to.throw('Invalid update checkpoint');
  });
  it('shows update rather than reinstall in installed management help', () => {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'scripts/installation'), { recursive: true });
    fs.copyFileSync(
      path.join(cli, 'scripts/installation/output.sh'),
      path.join(root, 'scripts/installation/output.sh')
    );
    fs.copyFileSync(
      path.join(cli, 'bin/gt-cli'),
      path.join(root, 'bin/gt-cli')
    );
    fs.chmodSync(path.join(root, 'bin/gt-cli'), 0o755);
    fs.symlinkSync('/missing/private-node', path.join(root, '.runtime-node'));
    const help = spawnSync(path.join(root, 'bin/gt-cli'), [], {
      encoding: 'utf8',
    });
    expect(help.status).to.equal(0);
    expect(help.stdout).to.contain('gt-cli update');
    expect(help.stdout).not.to.contain('gt-cli install');
    const reinstall = spawnSync(path.join(root, 'bin/gt-cli'), ['install'], {
      encoding: 'utf8',
    });
    expect(reinstall.status).to.equal(1);
    expect(reinstall.stderr).to.contain('Use gt-cli update');
  });
  it('distinguishes a preflight blocker from partially applied activation', () => {
    const message = api.formatUpdateError(
      Object.assign(
        new Error('Registered Git directory is missing: /tmp/removed/.git'),
        {
          updatePhase: 'preflight',
          updateVersion: '0.6.3',
          currentVersion: '0.6.1',
        }
      )
    );
    expect(message).to.contain(
      'Update blocked: activation preflight failed for gt-cli 0.6.3.'
    );
    expect(message).to.contain('/tmp/removed/.git');
    expect(message).to.contain('Current gt-cli management version: 0.6.1.');
    expect(message).to.contain(
      'This activation attempt changed no repository bindings'
    );
    expect(message).to.contain('Any earlier partial activation was kept');
    expect(message).to.contain('rerun `gt-cli update` to resume');
    expect(message).to.contain('do not delete them');
    expect(message).not.to.contain('0.6.3 is active');

    const partial = api.formatUpdateError(
      Object.assign(new Error('pointer write failed'), {
        updatePhase: 'activation',
        updateVersion: '0.6.3',
      })
    );
    expect(partial).to.contain('Update incomplete');
    expect(partial).to.contain(
      'Some repositories may already use the new version'
    );
    expect(partial).not.to.contain('changed no repository bindings');
  });

  it('keeps download errors readable without wrapping internal npm command lines', () => {
    const message = api.formatUpdateError(
      Object.assign(
        new Error('Command failed: /private/runtime/node npm ...'),
        {
          stderr: Buffer.from('npm error E401: authentication required\n'),
        }
      )
    );
    expect(message).to.contain('Update failed.');
    expect(message).to.contain('npm error E401: authentication required');
    expect(message).not.to.contain('Command failed');
    expect(message).to.contain(
      'Existing installations and current work were kept'
    );
  });

  it('success identifies the active version and refreshed repositories without claiming all repos changed', () => {
    const message = api.updateSuccessMessage(
      '0.6.3',
      {
        repositories: ['/one', '/two'],
        global: true,
      },
      false
    );
    expect(message).to.contain('Update complete: gt-cli 0.6.3 is installed.');
    expect(message).to.contain('Refreshed 2 enabled repository bindings.');
    expect(message.split('\n')).to.have.length(2);
    expect(message).not.to.contain('Already up to date');
  });

  it('distinguishes an unchanged latest install from repairing stale bindings', () => {
    const noop = api.updateSuccessMessage(
      '0.6.3',
      { repositories: [], global: false },
      true
    );
    expect(noop).to.equal('Already up to date: gt-cli 0.6.3.');
    const repaired = api.updateSuccessMessage(
      '0.6.3',
      { repositories: ['/one'], global: false },
      true
    );
    expect(repaired).to.contain('Update complete: gt-cli 0.6.3 is installed.');
    expect(repaired).to.contain('Refreshed 1 enabled repository binding.');
    expect(repaired).not.to.contain('Already up to date');
  });

  it('explains automatic catch-up without asking for a second update or claiming all bindings are verified', () => {
    const message = api.updateSuccessMessage(
      '0.6.5',
      {
        repositories: [],
        global: true,
        deferred: [
          {
            repository: '/tmp/busy/.git',
            kind: 'busy',
            reason: 'A command is still running.',
          },
        ],
      },
      true
    );
    expect(message).to.contain(
      'gt-cli 0.6.5 is installed; repository updates are pending.'
    );
    expect(message).not.to.contain('Already up to date');
    expect(message).to.contain('automatically on its next idle `gt` command');
    expect(message).to.contain('/tmp/busy/.git');
    expect(message).to.contain(
      'Running commands and paused operations keep their current version'
    );
    expect(message).to.contain('No second update is needed');
    expect(message).not.to.contain('bindings verified');
    expect(message).not.to.contain('Update failed');
  });

  for (const kind of ['blocked', undefined]) {
    it(`requires repair for blocked or unclassified activation failures (${kind})`, () => {
      const message = api.updateSuccessMessage(
        '0.6.5',
        {
          repositories: [],
          global: true,
          deferred: [
            {
              repository: '/tmp/broken/.git',
              kind,
              reason: 'EACCES: permission denied',
            },
          ],
        },
        true
      );
      expect(message).to.contain('Blocked 1 repository');
      expect(message).to.contain('/tmp/broken/.git');
      expect(message).to.contain('EACCES: permission denied');
      expect(message).to.contain('After fixing these errors');
      expect(message).to.contain('retries the pending update');
      expect(message).not.to.contain('next idle');
      expect(message).not.to.contain('Already up to date');
      expect(message).not.to.contain('bindings verified');
    });
  }

  it('reports automatic cleanup with audit paths, without asking users to forget again', () => {
    const message = api.updateSuccessMessage(
      '0.6.29',
      {
        repositories: ['/live'],
        global: true,
        deferred: [],
        forgotten: [
          { repository: '/home/me/tools/deleted/.git' },
          { repository: '/tmp/deleted/.git' },
        ],
      },
      false
    );
    expect(message).to.contain('Update complete: gt-cli 0.6.29 is installed.');
    expect(message).to.contain('Refreshed 1 enabled repository binding.');
    expect(message).to.contain(
      'Forgot missing checkout: /home/me/tools/deleted/.git'
    );
    expect(message).to.contain('Forgot missing checkout: /tmp/deleted/.git');
    expect(message).not.to.contain('Registration backup:');
    expect(message).not.to.match(/Blocked|Missing|gt-cli forget|pending/);
  });

  it('explains safety guards for retained absent checkouts, apart from repairable blockers', () => {
    const message = api.updateSuccessMessage(
      '0.6.29',
      {
        repositories: [],
        global: true,
        deferred: [
          {
            repository: '/home/me/tools/gone-a/.git',
            kind: 'missing',
            retained: 'Filesystem device changed; its volume may be unmounted.',
            reason:
              'Registered Git directory is missing.\nRegistered Git directory: /home/me/tools/gone-a/.git\nRestore this checkout...',
          },
          {
            repository: '/home/me/tools/gone-b/.git',
            kind: 'missing',
            reason: 'Registered Git directory is missing.',
          },
        ],
      },
      true
    );
    // Stale registrations are not pending repository work.
    expect(message).to.contain('Already up to date: gt-cli 0.6.29.');
    expect(message).not.to.contain('repository updates are pending');
    expect(message).not.to.contain('Blocked');
    expect(message).not.to.contain('fix the errors below');
    expect(message).to.contain('Missing 2 registered checkouts');
    expect(message).to.contain('  - /home/me/tools/gone-a/.git');
    expect(message).to.contain('  - /home/me/tools/gone-b/.git');
    expect(message).to.contain('gt-cli forget --missing');
    expect(message).to.contain('gt-cli forget --repo PATH');
    expect(message).to.contain('No repository files are deleted.');
    expect(message).to.contain(
      'Filesystem device changed; its volume may be unmounted.'
    );
    expect(message).to.contain('Restore or remount these checkouts');
    // Each reason repeats the same instructions; print the list once instead.
    expect(message).not.to.contain('Restore this checkout...');
    expect(message.match(/Registered Git directory/g) ?? []).to.have.length(0);

    const mixed = api.updateSuccessMessage(
      '0.6.29',
      {
        repositories: ['/ready'],
        global: true,
        deferred: [
          { repository: '/gone/.git', kind: 'missing', reason: 'missing' },
          { repository: '/broken/.git', kind: 'blocked', reason: 'EACCES' },
        ],
      },
      false
    );
    expect(mixed).to.contain('Update complete: gt-cli 0.6.29 is installed.');
    expect(mixed).to.contain('Blocked 1 repository');
    expect(mixed).to.contain('/broken/.git');
    expect(mixed).to.contain('Missing 1 registered checkout;');
    expect(mixed).to.contain('its binding stays pending');
    expect(mixed.indexOf('Blocked')).to.be.lessThan(mixed.indexOf('Missing'));
  });

  it('separates busy repositories from blockers in a partially completed update', () => {
    const message = api.updateSuccessMessage(
      '0.6.5',
      {
        repositories: ['/ready'],
        global: true,
        deferred: [
          { repository: '/busy', kind: 'busy', reason: 'Command running.' },
          {
            repository: '/broken',
            kind: 'blocked',
            reason: 'Invalid metadata.',
          },
        ],
      },
      false
    );
    expect(message).to.contain('Refreshed 1 enabled repository binding.');
    expect(message).to.contain('Deferred 1 repository');
    expect(message).to.contain('Blocked 1 repository');
    expect(message).to.contain('Command running.');
    expect(message).to.contain('Invalid metadata.');
    expect(message).to.contain('fix the errors below');
    expect(message).not.to.contain('Deferred 2');
  });

  it('allows superseding a missing staged target but still rejects unsafe checkpoint metadata', () => {
    const file = path.join(root, 'update.json');
    const record = {
      schemaVersion: 1,
      from: 'versions/.install-old',
      target: 'versions/.install-gone',
      version: '0.6.3',
      artifactSha256: 'a'.repeat(64),
    };
    fs.writeFileSync(file, JSON.stringify(record));
    expect(api.checkpoint(root)).to.deep.equal(record);
    expect(() => api.pending(root)).to.throw();
    fs.writeFileSync(file, JSON.stringify({ ...record, target: '../outside' }));
    expect(() => api.checkpoint(root)).to.throw('Invalid update checkpoint');
    fs.unlinkSync(file);
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(record));
    fs.symlinkSync(outside, file);
    expect(() => api.checkpoint(root)).to.throw('Not an owned regular file');
    fs.unlinkSync(outside);
    expect(() => api.checkpoint(root)).to.throw('Not an owned regular file');
  });

  const runActivation = (
    body: string,
    env: NodeJS.ProcessEnv = {},
    tty = false
  ) => {
    const scripts = path.join(root, 'scripts/installation');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'update.cjs'), body);
    const target = {
      home: root,
      root,
      record: { node: process.execPath, version: '0.6.3' },
    };
    return spawnSync(
      process.execPath,
      [
        '-e',
        `${tty ? 'require("tty").isatty = fd => fd === 2;' : ''}
       const api = require(${JSON.stringify(
         path.join(cli, 'scripts/installation/update.cjs')
       )});
       try { api.activate(${JSON.stringify(target)}, 'versions/.install-old'); }
       catch (error) { api.reportUpdateFailure(error); }`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: undefined,
          TERM: 'xterm',
          ...env,
        },
      }
    );
  };

  const render = (body: string, env: NodeJS.ProcessEnv = {}, tty = false) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        `
    ${tty ? 'require("tty").isatty = fd => fd === 1 || fd === 2;' : ''}
    const api = require(${JSON.stringify(
      path.join(cli, 'scripts/installation/update.cjs')
    )});
    ${body}
  `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: undefined,
          NODE_DISABLE_COLORS: undefined,
          TERM: 'xterm',
          ...env,
        },
      }
    );

  it('colors successes green and warning headings yellow, leaving details plain', () => {
    const result = render(
      `console.log(api.updateSuccessMessage('0.6.6', {repositories:['/ready'], global:true, deferred:[{repository:'/busy', kind:'busy', reason:'Command running.'}, {repository:'/broken', kind:'blocked', reason:'Invalid metadata.'}]}, false));`,
      { FORCE_COLOR: undefined },
      true
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.contain(
      '\u001b[32mUpdate complete: gt-cli 0.6.6 is installed.\u001b[39m'
    );
    expect(result.stdout).to.contain(
      '\u001b[32mRefreshed 1 enabled repository binding.\u001b[39m'
    );
    expect(result.stdout).to.contain('\u001b[33mDeferred 1 repository');
    expect(result.stdout).to.contain(
      '\u001b[39m\n  - /busy\n      Command running.'
    );
    expect(result.stdout).to.contain('\u001b[33mBlocked 1 repository');
    expect(result.stdout).to.contain(
      '\u001b[39m\n  - /broken\n      Invalid metadata.'
    );
  });

  it('colors already-current results green and recovery warnings yellow', () => {
    const result = render(
      `console.log(api.updateSuccessMessage('0.6.6', {repositories:[],global:false},true)); api.warning('Superseding an unfinished update.');`,
      { FORCE_COLOR: '1' }
    );
    expect(result.stdout).to.contain(
      '\u001b[32mAlready up to date: gt-cli 0.6.6.\u001b[39m'
    );
    expect(result.stdout).to.contain(
      '\u001b[33mSuperseding an unfinished update.\u001b[39m'
    );
    expect(result.status).to.equal(0);
  });

  it('marks an already-installed release with pending bindings yellow, not green', () => {
    const result = render(
      `console.log(api.updateSuccessMessage('0.6.6', {repositories:[], global:true, deferred:[{repository:'/busy', kind:'busy', reason:'Command running.'}]}, true));`,
      { FORCE_COLOR: '1' }
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.contain(
      '\u001b[33mgt-cli 0.6.6 is installed; repository updates are pending.\u001b[39m'
    );
    expect(result.stdout).not.to.contain('\u001b[32m');
  });

  it('colors failure headings red without changing the failing exit status', () => {
    const result = render(
      `api.reportUpdateFailure(new Error('fixture failure'));`,
      { FORCE_COLOR: '1' }
    );
    expect(result.status).to.equal(1);
    expect(result.stderr).to.contain('\u001b[31mUpdate failed.\u001b[39m');
    expect(result.stderr).to.contain('\u001b[39m\nfixture failure\n');
  });

  it('keeps piped results plain and honors NO_COLOR even when color is forced', () => {
    const body = `console.log(api.updateSuccessMessage('0.6.6', {repositories:[],global:true,deferred:[{repository:'/busy',kind:'busy',reason:'busy'}]},true)); api.warning('fixture warning'); api.reportUpdateFailure(new Error('fixture failure'));`;
    for (const env of [
      { FORCE_COLOR: undefined },
      { FORCE_COLOR: '0' },
      { NO_COLOR: '1', FORCE_COLOR: '1' },
      { NO_COLOR: '', FORCE_COLOR: '1' },
    ]) {
      const result = render(body, env);
      expect(result.status).to.equal(1);
      expect(result.stdout + result.stderr).not.to.contain('\u001b[');
      expect(result.stdout).to.contain('fixture warning');
      expect(result.stderr).to.contain('fixture failure');
    }
  });

  it('colors captured plain child failures for the parent terminal without duplicate errors', () => {
    const result = runActivation(
      'console.error("Update blocked: busy repository"); process.exitCode=1;',
      { FORCE_COLOR: undefined },
      true
    );
    expect(result.status).to.equal(1);
    expect(result.stderr).to.equal(
      '\u001b[31mUpdate blocked: busy repository\u001b[39m\n'
    );
  });

  it('recognizes already-colored child failures and recolors them only once', () => {
    const result = runActivation(
      'console.error("\\u001b[31mUpdate failed: fixture\\u001b[39m"); process.exitCode=1;',
      { FORCE_COLOR: '1' }
    );
    expect(result.status).to.equal(1);
    expect(result.stderr).to.equal(
      '\u001b[31mUpdate failed: fixture\u001b[39m\n'
    );
    expect(result.stderr).not.to.contain('Command failed');
  });

  it('colors successful child warnings yellow on the parent terminal', () => {
    const result = runActivation(
      'console.error("fixture warning");',
      { FORCE_COLOR: undefined },
      true
    );
    expect(result.status).to.equal(0);
    expect(result.stderr).to.equal('\u001b[33mfixture warning\u001b[39m\n');
  });

  for (const header of [
    'Update blocked: activation preflight failed for gt-cli 0.6.3.',
    'Update failed: missing registered repository',
  ]) {
    it(`reports activation errors once, including older helpers (${
      header.split(':')[0]
    })`, () => {
      const result = runActivation(
        `console.error(${JSON.stringify(
          header + '\nRestore /tmp/missing/.git, then rerun gt-cli update.'
        )}); process.exitCode = 1;`
      );
      expect(result.status, result.stderr).to.equal(1);
      expect(
        result.stderr.match(/^Update (blocked|failed|incomplete)[.:]/gm)
      ).to.have.length(1);
      expect(result.stderr).to.contain('Restore /tmp/missing/.git');
      expect(result.stderr).not.to.contain('Command failed:');
      expect(result.stderr).not.to.contain('--activate');
    });
  }

  it('reports unannounced activation crashes without pretending bindings are unchanged', () => {
    const result = runActivation('process.exit(93);');
    expect(result.status, result.stderr).to.equal(1);
    expect(result.stderr).to.contain('Update incomplete');
    expect(result.stderr).to.contain('Activation process exited with code 93');
    expect(result.stderr).to.contain(
      'Some repositories may already use the new version'
    );
    expect(result.stderr).not.to.contain('Command failed:');
  });

  it('relays activation success and warnings without adding a second success message', () => {
    const result = runActivation(
      'console.log("Update complete: gt-cli 0.6.3 is active."); console.error("fixture warning");'
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout.match(/Update complete/g)).to.have.length(1);
    expect(result.stderr).to.equal('fixture warning\n');
  });

  it('carries a privately provisioned gh into the next installation', () => {
    const versions = path.join(root, 'versions');
    const old = path.join(versions, '.install-old/tools/bin');
    const next = path.join(versions, '.install-new');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(old, 'gh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(old, '../gh-LICENSE'), 'license');
    const copied = tools.githubCli(next, old);
    expect(copied.executable).to.equal(path.join(next, 'tools/bin/gh'));
    expect(fs.readFileSync(copied.executable, 'utf8')).to.equal(
      fs.readFileSync(path.join(old, 'gh'), 'utf8')
    );
    expect(
      fs.readFileSync(path.join(next, 'tools/gh-LICENSE'), 'utf8')
    ).to.equal('license');
    fs.rmSync(path.join(versions, '.install-old'), { recursive: true });
    expect(fs.existsSync(copied.executable)).to.equal(true);
  });
});
