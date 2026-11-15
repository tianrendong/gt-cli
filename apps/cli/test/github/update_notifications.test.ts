import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import {
  CHECK_INTERVAL_MS,
  UpdateCache,
  withUpdateCache,
} from '../../src/lib/updates/state';
import { notificationInstallation } from '../../src/lib/updates/check';
import { Repository, digest } from '../../src/lib/switch/repository';
import { ABSENT_NATIVE_DIGEST, writeState } from '../../src/lib/switch/state';

const cli = path.resolve(__dirname, '../../..');
const dist = path.resolve(__dirname, '../../src');
const notice =
  'gt-cli update available: 0.6.30 → 0.6.31\nRun `gt-cli update` to install.\n';

describe('managed update notifications', function () {
  this.timeout(20_000);
  let root: string, home: string, repo: string, env: NodeJS.ProcessEnv;
  let installed: ReturnType<typeof install>;
  const cachePath = () => path.join(home, 'update-notifier.json');
  const cache = (): UpdateCache =>
    JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  const seed = (overrides: Partial<UpdateCache> = {}) =>
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({
        schemaVersion: 1,
        latestVersion: '0.6.31',
        lastCheckedAt: Date.now(),
        ...overrides,
      })
    );
  const requests = (): {
    args: string[];
    cwd: string;
    pid: number;
    home: string;
    userconfig: string;
    notifier: string;
  }[] => {
    const file = path.join(root, 'npm-requests');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  async function waitFor(
    predicate: () => boolean,
    timeout = 10_000
  ): Promise<void> {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= end)
        throw Error('Timed out waiting for notification fixture');
      await sleep(20);
    }
  }
  function select(release: ReturnType<typeof install>): void {
    const temporary = path.join(home, 'next');
    fs.symlinkSync(path.relative(home, release.release), temporary);
    fs.renameSync(temporary, path.join(home, 'current'));
  }
  function install(label: string, version: string) {
    const release = path.join(home, 'versions/.install-' + label);
    const packageRoot = path.join(release, 'app/node_modules/@tianrendong/gt-cli');
    const entry = path.join(packageRoot, 'dist/src/gt_cli.js');
    const node = path.join(release, 'runtime/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.symlinkSync(process.execPath, node);
    fs.mkdirSync(path.join(packageRoot, 'dist/src/background_tasks'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(dist, 'lib'),
      path.join(packageRoot, 'dist/src/lib')
    );
    fs.symlinkSync(
      path.resolve(dist, '../scripts'),
      path.join(packageRoot, 'dist/scripts')
    );
    fs.copyFileSync(path.join(dist, 'gt_cli.js'), entry);
    fs.copyFileSync(
      path.join(dist, 'background_tasks/check_for_updates.js'),
      path.join(packageRoot, 'dist/src/background_tasks/check_for_updates.js')
    );
    fs.mkdirSync(path.join(packageRoot, 'scripts'));
    // Real packaging includes scripts/installation/update.cjs, not its dist copy.
    fs.symlinkSync(
      path.join(cli, 'scripts/installation'),
      path.join(packageRoot, 'scripts/installation')
    );
    fs.symlinkSync(node, path.join(packageRoot, '.runtime-node'));
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@tianrendong/gt-cli', version })
    );
    fs.writeFileSync(
      path.join(release, '.installed'),
      JSON.stringify({
        schemaVersion: 1,
        version,
        cli: packageRoot,
        node,
        gt: path.join(root, 'gt'),
        artifactSha256: 'a'.repeat(64),
      })
    );
    fs.writeFileSync(
      path.join(packageRoot, 'dist/src/index.js'),
      `
      const fs = require('fs');
      const args = process.argv.slice(2);
      exports.completion = (async () => {
        console.log('candidate ${version}');
        if (args.includes('fail')) process.exitCode = 7;
        if (args.includes('throw')) throw Error('command failed');
        if (args.includes('exit')) process.exit(0);
        if (args.includes('hold')) {
          fs.writeFileSync(process.env.GT_TEST_READY, 'ready');
          const deadline = Date.now() + 15000;
          while (!fs.existsSync(process.env.GT_TEST_RELEASE) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();
    `
    );
    const npm = path.join(
      release,
      'runtime/lib/node_modules/npm/bin/npm-cli.js'
    );
    fs.mkdirSync(path.dirname(npm), { recursive: true });
    fs.writeFileSync(
      npm,
      `
      const fs = require('fs');
      fs.appendFileSync(process.env.GT_TEST_NPM_LOG, JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
        home: process.env.HOME, userconfig: process.env.npm_config_userconfig,
        notifier: process.env.npm_config_update_notifier
      }) + '\\n');
      function respond() {
        if (process.env.GT_TEST_NPM_MODE === 'fail') {
          console.error('npm error E401: fixture auth failure');
          process.exitCode = 1;
        } else console.log(process.env.GT_TEST_NPM_OUTPUT || '"0.6.31"');
      }
      if (process.env.GT_TEST_NPM_MODE === 'hang') setInterval(() => {}, 1000);
      else if (process.env.GT_TEST_NPM_MODE === 'hold') {
        const timer = setInterval(() => {
          if (fs.existsSync(process.env.GT_TEST_NPM_RELEASE)) {
            clearInterval(timer); respond();
          }
        }, 20);
      } else respond();
    `
    );
    return { release, root: packageRoot, entry, node };
  }
  type Invocation = {
    tty?: boolean;
    env?: NodeJS.ProcessEnv;
    release?: ReturnType<typeof install>;
  };
  function command(args: string[], options: Invocation = {}) {
    const release = options.release ?? installed;
    return {
      argv: [
        ...(options.tty === false
          ? []
          : ['--require', path.join(root, 'terminal.cjs')]),
        release.entry,
        ...args,
      ],
      options: {
        cwd: repo,
        env: { ...env, ...options.env },
        encoding: 'utf8' as const,
      },
    };
  }
  function invoke(args = ['log'], options: Invocation = {}) {
    const cmd = command(args, options);
    return spawnSync(process.execPath, cmd.argv, {
      ...cmd.options,
      timeout: 10_000,
    });
  }
  function invokeAsync(args = ['log'], options: Invocation = {}) {
    const cmd = command(args, options);
    const child = spawn(process.execPath, cmd.argv, {
      ...cmd.options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    return new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  }
  function bind(mode: 'gt-gh' | 'graphite', candidate = installed): void {
    const native = path.join(root, 'native');
    fs.writeFileSync(native, '#!/bin/sh\nprintf "native output\\n"\n', {
      mode: 0o755,
    });
    writeState(new Repository(repo), {
      schemaVersion: 1,
      mode,
      session: '1-0123456789ab',
      candidate: {
        node: candidate.node,
        script: path.join(candidate.root, 'dist/src/index.js'),
      },
      native: {
        path: native,
        version: '1.8.6',
        digest: digest(fs.readFileSync(native)),
      },
      nativeDigest: ABSENT_NATIVE_DIGEST,
      nativeAbsent: true,
      prCache: null,
      repoConfig: null,
    });
  }

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-update-notification-'))
    );
    home = path.join(root, 'install');
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'user'));
    const userconfig = path.join(root, 'user/.npmrc');
    fs.writeFileSync(
      userconfig,
      '//registry.npmjs.org/:_authToken=fixture-only\n'
    );
    fs.writeFileSync(
      path.join(root, 'terminal.cjs'),
      `
      for (const stream of [process.stdin, process.stdout, process.stderr])
        Object.defineProperty(stream, 'isTTY', { value: true });
    `
    );
    env = {
      ...process.env,
      HOME: path.join(root, 'user'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      GRAPHITE_USER_CONFIG_PATH: path.join(root, 'user/graphite.json'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GT_TEST_NPM_LOG: path.join(root, 'npm-requests'),
      GT_TEST_READY: path.join(root, 'ready'),
      GT_TEST_RELEASE: path.join(root, 'release'),
      GT_TEST_NPM_RELEASE: path.join(root, 'npm-release'),
      npm_config_userconfig: userconfig,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
      FORCE_COLOR: undefined,
      NODE_OPTIONS: undefined,
    };
    for (const key of [
      'GT_GH_LAUNCHER_RECORD',
      'GT_GH_PROBING_NATIVE',
      'GT_CLI_HOME',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'CI',
      'CONTINUOUS_INTEGRATION',
      'BUILD_NUMBER',
      'GITHUB_ACTIONS',
      'BUILDKITE',
      'TEAMCITY_VERSION',
      'GT_CLI_NO_UPDATE_CHECK',
      'NO_UPDATE_NOTIFIER',
    ])
      delete env[key];
    execFileSync('git', ['init', '-b', 'main', repo], { env, stdio: 'ignore' });
    installed = install('old', '0.6.30');
    select(installed);
  });
  afterEach(async () => {
    // Kill only fixture npm children if an assertion interrupted their timeout.
    for (const { pid } of requests()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await sleep(50);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('prints after successful output, only on stderr, and throttles receipts across commands', () => {
    seed();
    const first = invoke();
    expect(first.status, first.stderr).to.equal(0);
    expect(first.stdout).to.equal('candidate 0.6.30\n');
    expect(first.stderr).to.equal(notice);
    expect(cache().lastNotifiedVersion).to.equal('0.6.31');
    const second = invoke();
    expect(second.status).to.equal(0);
    expect(second.stdout).to.equal(first.stdout);
    expect(second.stderr).to.equal('');
    expect(requests()).to.have.length(0);
  });

  it('keeps failures unchanged without consuming a future success notice', () => {
    seed();
    const failed = invoke(['fail']);
    expect(failed.status).to.equal(7);
    expect(failed.stdout).to.equal('candidate 0.6.30\n');
    expect(failed.stderr).to.equal('');
    const thrown = invoke(['throw']);
    expect(thrown.status).to.equal(1);
    expect(thrown.stderr).to.equal('ERROR: command failed\n');
    expect(cache().lastNotifiedAt).to.equal(undefined);
    expect(invoke().stderr).to.equal(notice);
  });

  it('also notifies successful explicit exits such as Git passthrough, once', () => {
    seed();
    const result = invoke(['exit']);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.equal(notice);
  });

  it('does no cache or network work in pipes, quiet/machine modes or CI', () => {
    seed();
    const before = fs.readFileSync(cachePath(), 'utf8');
    for (const [args, options] of [
      [['log'], { tty: false }],
      [['log', '--quiet'], {}],
      [['log', '--no-interactive'], {}],
      [['log', '--json'], {}],
      [['--version'], {}],
      [['--help'], {}],
      [['completion'], {}],
      [['--get-yargs-completions', 'log'], {}],
      [['internal-only', 'status'], {}],
      [['log'], { env: { CI: '1' } }],
      [['log'], { env: { GT_CLI_NO_UPDATE_CHECK: '1' } }],
    ] as [string[], Invocation][]) {
      const result = invoke(args, options);
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stderr).to.equal('');
    }
    const handshake = invoke(['--capabilities']);
    expect(JSON.parse(handshake.stdout).implementation).to.equal('gt-gh');
    expect(handshake.stderr).to.equal('');
    expect(fs.readFileSync(cachePath(), 'utf8')).to.equal(before);
    expect(fs.existsSync(path.join(home, 'update-notifier.lock'))).to.equal(
      false
    );
    expect(requests()).to.have.length(0);
  });

  it('never checks or notifies when routing to native Graphite', () => {
    seed();
    bind('graphite');
    const result = invoke();
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('native output\n');
    expect(result.stderr).to.equal('');
    expect(fs.existsSync(path.join(home, 'update-notifier.lock'))).to.equal(
      false
    );
    expect(cache().lastNotifiedAt).to.equal(undefined);
    expect(requests()).to.have.length(0);
  });

  it('compares current management version, not a deferred repository candidate', () => {
    const newer = install('new', '0.6.31');
    select(newer);
    bind('gt-gh', installed);
    seed();
    const result = invoke(['log'], { release: newer });
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('candidate 0.6.30\n');
    expect(result.stderr).to.equal('');
    expect(cache().lastNotifiedAt).to.equal(undefined);
  });

  it('re-reads current at completion when an update finishes during a command', async () => {
    seed();
    const result = invokeAsync(['hold']);
    await waitFor(() => fs.existsSync(env.GT_TEST_READY!));
    select(install('new', '0.6.31'));
    fs.writeFileSync(env.GT_TEST_RELEASE!, 'finish');
    const completed = await result;
    expect(completed.status, completed.stderr).to.equal(0);
    expect(completed.stderr).to.equal('');
    expect(cache().lastNotifiedAt).to.equal(undefined);
  });

  it('runs one detached lookup using private npm, fixed registry and inherited auth config', async () => {
    const result = invoke();
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('candidate 0.6.30\n');
    expect(result.stderr).to.equal('');
    await waitFor(() =>
      Boolean(fs.existsSync(cachePath()) && cache().lastCheckedAt)
    );
    const calls = requests();
    expect(calls).to.have.length(1);
    expect(calls[0].args.slice(0, 4)).to.deep.equal([
      'view',
      '@tianrendong/gt-cli@latest',
      'version',
      '--json',
    ]);
    expect(calls[0].args).to.include.members([
      '--registry=https://registry.npmjs.org/',
      '--@tianrendong:registry=https://registry.npmjs.org/',
      '--prefer-online',
      '--fetch-retries=0',
      '--fetch-timeout=5000',
      '--logs-max=0',
    ]);
    expect(calls[0].cwd).to.equal(home);
    expect(calls[0].home).to.equal(env.HOME);
    expect(calls[0].userconfig).to.equal(env.npm_config_userconfig);
    expect(calls[0].notifier).to.equal('false');
    expect(invoke().stderr).to.equal(notice);
    expect(requests()).to.have.length(1);
  });

  it('deduplicates background lookups and notices across concurrent terminals', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => invokeAsync())
    );
    for (const result of results)
      expect(result.status, result.stderr).to.equal(0);
    await waitFor(() => Boolean(cache().lastCheckedAt));
    expect(requests()).to.have.length(1);
    // Reset only the receipt to test concurrent cached notices independently.
    withUpdateCache(home, (state, save) =>
      save({
        ...state,
        lastNotifiedAt: undefined,
        lastNotifiedVersion: undefined,
      })
    );
    const notices = await Promise.all(
      Array.from({ length: 8 }, () => invokeAsync())
    );
    expect(notices.filter((result) => result.stderr === notice)).to.have.length(
      1
    );
    for (const result of notices)
      expect(result.status, result.stderr).to.equal(0);
    expect(requests()).to.have.length(1);
  });

  it('merges notification receipts written while a lookup is running', async () => {
    seed({ lastCheckedAt: Date.now() - CHECK_INTERVAL_MS - 1 });
    const result = invoke(['log'], {
      env: { GT_TEST_NPM_MODE: 'hold', GT_TEST_NPM_OUTPUT: '"0.6.32"' },
    });
    expect(result.stderr).to.equal(notice);
    await waitFor(() => requests().length === 1);
    fs.writeFileSync(env.GT_TEST_NPM_RELEASE!, 'finish');
    await waitFor(() => cache().latestVersion === '0.6.32');
    expect(cache().lastNotifiedVersion).to.equal('0.6.31');
    expect(cache().lastNotifiedAt).to.be.a('number');
    expect(invoke().stderr).to.contain('0.6.30 → 0.6.32');
  });

  it('backs off silent auth failures and malformed/prerelease npm responses', async () => {
    for (const override of [
      { GT_TEST_NPM_MODE: 'fail' },
      { GT_TEST_NPM_OUTPUT: 'not JSON' },
      { GT_TEST_NPM_OUTPUT: '["0.6.31"]' },
      { GT_TEST_NPM_OUTPUT: '"0.7.0-beta.1"' },
    ]) {
      fs.rmSync(cachePath(), { force: true });
      const count = requests().length;
      const result = invoke(['log'], { env: override });
      expect(result.status).to.equal(0);
      expect(result.stderr).to.equal('');
      await waitFor(() => requests().length > count);
      await sleep(100);
      expect(cache().lastAttemptAt).to.be.a('number');
      expect(cache().lastCheckedAt).to.equal(undefined);
      expect(invoke().stderr).to.equal('');
      expect(requests()).to.have.length(count + 1);
    }
  });

  it('does not query npm for an unclaimed worker attempt', () => {
    seed({ attemptId: 'a'.repeat(32), lastAttemptAt: Date.now() });
    const result = spawnSync(
      installed.node,
      [
        path.join(
          installed.root,
          'dist/src/background_tasks/check_for_updates.js'
        ),
        'b'.repeat(32),
      ],
      { env, encoding: 'utf8', timeout: 10_000 }
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout + result.stderr).to.equal('');
    expect(requests()).to.have.length(0);
  });

  it('cannot overwrite a newer attempt with a late worker result', async () => {
    const attemptId = 'a'.repeat(32);
    seed({ attemptId, lastAttemptAt: Date.now() });
    const child = spawn(
      installed.node,
      [
        path.join(
          installed.root,
          'dist/src/background_tasks/check_for_updates.js'
        ),
        attemptId,
      ],
      { env: { ...env, GT_TEST_NPM_MODE: 'hold' }, stdio: 'pipe' }
    );
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await waitFor(() => requests().length === 1);
    withUpdateCache(home, (state, save) =>
      save({
        ...state,
        attemptId: 'b'.repeat(32),
        latestVersion: '0.6.35',
        lastCheckedAt: Date.now(),
      })
    );
    fs.writeFileSync(env.GT_TEST_NPM_RELEASE!, 'finish');
    expect(await done).to.equal(0);
    expect(cache().latestVersion).to.equal('0.6.35');
    expect(cache().attemptId).to.equal('b'.repeat(32));
  });

  it('drops an obsolete notice when npm latest is rolled back', async () => {
    seed({
      lastCheckedAt: Date.now() - CHECK_INTERVAL_MS - 1,
      lastNotifiedAt: Date.now(),
      lastNotifiedVersion: '0.6.31',
    });
    const result = invoke(['log'], { env: { GT_TEST_NPM_OUTPUT: '"0.6.29"' } });
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.equal('');
    await waitFor(() => cache().latestVersion === '0.6.29');
    expect(invoke().stderr).to.equal('');
    expect(requests()).to.have.length(1);
  });

  it('does not wait for npm and kills a stalled lookup after five seconds', async () => {
    const result = await invokeAsync(['log'], {
      env: { GT_TEST_NPM_MODE: 'hang' },
    });
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal('candidate 0.6.30\n');
    expect(result.stderr).to.equal('');
    await waitFor(() => requests().length === 1);
    const pid = requests()[0].pid;
    // Parent has returned while npm is still running, with no inherited pipes.
    expect(() => process.kill(pid, 0)).not.to.throw();
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000);
    expect(cache().lastCheckedAt).to.equal(undefined);
    expect(invoke().stderr).to.equal('');
    expect(requests()).to.have.length(1);
  });

  it('ignores spawn failures without changing command status or retrying immediately', () => {
    fs.unlinkSync(installed.node);
    const result = invoke();
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.equal('');
    expect(cache().lastAttemptAt).to.be.a('number');
    const attempt = cache().attemptId;
    expect(invoke().status).to.equal(0);
    expect(cache().attemptId).to.equal(attempt);
  });

  it('silently skips invalid installations and never trusts GT_CLI_HOME as a substitute', () => {
    seed();
    fs.unlinkSync(path.join(installed.release, '.installed'));
    const result = invoke(['log'], { env: { GT_CLI_HOME: home } });
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.equal('');
    expect(cache().lastNotifiedAt).to.equal(undefined);
    expect(requests()).to.have.length(0);
    expect(() => notificationInstallation(cli)).to.throw();
  });

  it('does not use an installed cache for source-development commands', () => {
    seed();
    const before = fs.readFileSync(cachePath(), 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        path.join(root, 'terminal.cjs'),
        '-e',
        `const { startUpdateNotification } = require(${JSON.stringify(
          path.join(dist, 'lib/updates/notifier.js')
        )});
       const finish = startUpdateNotification(${JSON.stringify(cli)}, ['log']);
       if (finish) finish(0);
       console.log('source command');`,
      ],
      {
        cwd: repo,
        env: { ...env, GT_CLI_HOME: home },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('source command\n');
    expect(result.stderr).to.equal('');
    expect(fs.readFileSync(cachePath(), 'utf8')).to.equal(before);
    expect(requests()).to.have.length(0);
  });

  it('leaves commands successful when notification state is not writable', function () {
    if (process.getuid?.() === 0) this.skip();
    seed();
    fs.chmodSync(home, 0o500);
    try {
      const result = invoke();
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal('candidate 0.6.30\n');
      expect(result.stderr).to.equal('');
      expect(cache().lastNotifiedAt).to.equal(undefined);
      expect(requests()).to.have.length(0);
    } finally {
      fs.chmodSync(home, 0o700);
    }
  });

  it('rejects traversal and cross-home current pointers without executing them', () => {
    for (const target of ['../outside', 'versions/../outside', '/tmp/other']) {
      fs.unlinkSync(path.join(home, 'current'));
      fs.symlinkSync(target, path.join(home, 'current'));
      const result = invoke();
      expect(result.status).to.equal(0);
      expect(result.stderr).to.equal('');
    }
    const originalHome = home;
    home = path.join(root, 'other-installation');
    const outside = install('other', '0.6.31');
    home = originalHome;
    fs.symlinkSync(
      outside.release,
      path.join(home, 'versions/.install-outside')
    );
    fs.unlinkSync(path.join(home, 'current'));
    fs.symlinkSync('versions/.install-outside', path.join(home, 'current'));
    expect(() => notificationInstallation(installed.root)).to.throw(
      'outside this installation home'
    );
    const result = invoke();
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.equal('');
    expect(requests()).to.have.length(0);
    expect(fs.existsSync(cachePath())).to.equal(false);
  });
});
