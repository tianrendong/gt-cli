import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateNotificationsEnabled } from '../../src/lib/updates/notifier';
import {
  CHECK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  REMINDER_INTERVAL_MS,
  MAX_RESULT_AGE_MS,
  UpdateCache,
  checkDue,
  updateNotice,
  withUpdateCache,
} from '../../src/lib/updates/state';

const terminal = { stdin: true, stdout: true, stderr: true };
const now = 1_700_000_000_000;
const fresh: UpdateCache = {
  schemaVersion: 1,
  latestVersion: '0.6.31',
  lastCheckedAt: now,
};

describe('update notification policy', () => {
  let userConfig: string | undefined;
  before(() => {
    userConfig = process.env.GRAPHITE_USER_CONFIG_PATH;
    process.env.GRAPHITE_USER_CONFIG_PATH = '/dev/null';
  });
  after(() => {
    if (userConfig === undefined) delete process.env.GRAPHITE_USER_CONFIG_PATH;
    else process.env.GRAPHITE_USER_CONFIG_PATH = userConfig;
  });

  it('allows normal interactive commands, aliases and global cwd options', () => {
    for (const args of [
      ['log'],
      ['ls', '--stack'],
      ['--cwd', '/repo', 'log'],
      ['--cwd=/repo', 'log'],
      ['create', '--', '--quiet'],
      ['--interactive', 'log'],
    ])
      expect(
        updateNotificationsEnabled(args, {}, terminal),
        args.join(' ')
      ).to.equal(true);
  });

  it('suppresses help, completion, machine output, internal and quiet commands', () => {
    for (const args of [
      [],
      ['--version'],
      ['--help'],
      ['--capabilities'],
      ['log', '--quiet'],
      ['log', '--quiet=true'],
      ['log', '-q'],
      ['log', '-hq'],
      ['log', '--no-interactive'],
      ['log', '--no-interactive=true'],
      ['log', '--interactive=false'],
      ['--interactive', 'false', 'log'],
      ['log', '--interactive=0'],
      ['log', '--json'],
      ['log', '--json=true'],
      ['init', '--help'],
      ['log', '--allCommands'],
      ['completion'],
      ['fish'],
      ['--get-yargs-completions', 'log'],
      ['internal-only', 'status'],
    ])
      expect(
        updateNotificationsEnabled(args, {}, terminal),
        args.join(' ')
      ).to.equal(false);
  });

  it('requires all three terminal streams, regardless of explicit interactive/color flags', () => {
    for (const stream of ['stdin', 'stdout', 'stderr'])
      expect(
        updateNotificationsEnabled(
          ['log', '--interactive'],
          { FORCE_COLOR: '1' },
          {
            ...terminal,
            [stream]: false,
          }
        )
      ).to.equal(false);
  });

  it('respects CI and opt-outs without confusing NO_COLOR with notification opt-out', () => {
    for (const env of [
      { CI: '1' },
      { CI: '' },
      { GITHUB_ACTIONS: 'true' },
      { BUILDKITE: 'true' },
      { CONTINUOUS_INTEGRATION: 'true' },
      { BUILD_NUMBER: '12' },
      { TEAMCITY_VERSION: '2026.1' },
      { GT_CLI_NO_UPDATE_CHECK: '1' },
      { GT_CLI_NO_UPDATE_CHECK: 'true' },
      { NO_UPDATE_NOTIFIER: '1' },
      { TERM: 'dumb' },
    ])
      expect(
        updateNotificationsEnabled(['log'], env, terminal),
        JSON.stringify(env)
      ).to.equal(false);
    for (const env of [{ CI: 'false' }, { CI: '0' }, { NO_COLOR: '' }])
      expect(updateNotificationsEnabled(['log'], env, terminal)).to.equal(true);
  });

  it('checks every six hours, backing off failed/spawned attempts for one hour', () => {
    expect(checkDue({ schemaVersion: 1 }, now)).to.equal(true);
    expect(checkDue(fresh, now + CHECK_INTERVAL_MS - 1)).to.equal(false);
    expect(checkDue(fresh, now + CHECK_INTERVAL_MS)).to.equal(true);
    const failed = { schemaVersion: 1 as const, lastAttemptAt: now };
    expect(checkDue(failed, now + RETRY_INTERVAL_MS - 1)).to.equal(false);
    expect(checkDue(failed, now + RETRY_INTERVAL_MS)).to.equal(true);
    expect(
      checkDue({ ...fresh, lastAttemptAt: now }, now + RETRY_INTERVAL_MS)
    ).to.equal(false);
  });

  it('compares semver, never suggesting equal, older or prerelease releases', () => {
    expect(updateNotice(fresh, '0.6.30', now)).to.equal(
      'gt-cli update available: 0.6.30 → 0.6.31\nRun `gt-cli update` to install.\n'
    );
    for (const installed of ['0.6.31', '0.6.32', '0.7.0-beta.1', 'invalid'])
      expect(updateNotice(fresh, installed, now)).to.equal(undefined);
    expect(updateNotice(fresh, '0.6.31-beta.1', now)).to.contain(
      '0.6.31-beta.1 → 0.6.31'
    );
    expect(
      updateNotice({ ...fresh, latestVersion: '0.6.100' }, '0.6.99', now)
    ).to.contain('0.6.100');
    expect(
      updateNotice(
        { ...fresh, latestVersion: '0.6.31+build.2' },
        '0.6.31+build.1',
        now
      )
    ).to.equal(undefined);
    for (const latestVersion of [
      '0.7.0-beta.1',
      'latest',
      '\u001b[31m0.6.31',
      undefined,
    ])
      expect(updateNotice({ ...fresh, latestVersion }, '0.6.30', now)).to.equal(
        undefined
      );
  });

  it('shows a new release immediately, then reminds daily after fresh checks', () => {
    const notified = {
      ...fresh,
      lastNotifiedAt: now,
      lastNotifiedVersion: fresh.latestVersion,
    };
    expect(updateNotice(notified, '0.6.30', now)).to.equal(undefined);
    expect(
      updateNotice(
        { ...notified, lastCheckedAt: now + REMINDER_INTERVAL_MS },
        '0.6.30',
        now + REMINDER_INTERVAL_MS
      )
    ).to.contain('0.6.31');
    expect(
      updateNotice({ ...notified, latestVersion: '0.6.32' }, '0.6.30', now)
    ).to.contain('0.6.32');
  });

  it('does not advertise stale, future-dated or unchecked results', () => {
    expect(updateNotice(fresh, '0.6.30', now + MAX_RESULT_AGE_MS)).to.equal(
      undefined
    );
    expect(updateNotice(fresh, '0.6.30', now - 1)).to.equal(undefined);
    expect(
      updateNotice({ ...fresh, lastCheckedAt: undefined }, '0.6.30', now)
    ).to.equal(undefined);
  });
});

describe('update notification cache boundaries', () => {
  let home: string;
  const file = () => path.join(home, 'update-notifier.json');
  beforeEach(() => {
    home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gt-notification-cache-'))
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('uses a separate private atomic cache and leaves activation checkpoints alone', () => {
    fs.writeFileSync(path.join(home, 'update.json'), 'activation checkpoint');
    withUpdateCache(home, (_cache, save) => save(fresh));
    expect(withUpdateCache(home, (cache) => cache.latestVersion)).to.equal(
      '0.6.31'
    );
    expect(fs.statSync(file()).mode & 0o777).to.equal(0o600);
    expect(
      fs.statSync(path.join(home, 'update-notifier.lock')).mode & 0o777
    ).to.equal(0o600);
    expect(fs.readFileSync(path.join(home, 'update.json'), 'utf8')).to.equal(
      'activation checkpoint'
    );
    expect(fs.readdirSync(home).sort()).to.deep.equal([
      'update-notifier.json',
      'update-notifier.lock',
      'update.json',
    ]);
  });

  it('recovers from missing, malformed, oversized and unknown-schema cache data', () => {
    expect(withUpdateCache(home, (cache) => cache)).to.deep.equal({
      schemaVersion: 1,
    });
    for (const contents of [
      '{',
      'null',
      '[]',
      '{"schemaVersion":2}',
      'x'.repeat(20 * 1024),
    ]) {
      fs.writeFileSync(file(), contents);
      expect(withUpdateCache(home, (cache) => cache)).to.deep.equal({
        schemaVersion: 1,
      });
    }
  });

  it('resets future/invalid timestamps and validates cached versions and attempt IDs', () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        latestVersion: 'garbage',
        lastCheckedAt: Date.now() + 86_400_000,
        lastAttemptAt: 'yesterday',
        attemptId: '../other',
        lastNotifiedAt: -1,
        lastNotifiedVersion: '1.0.0-beta.1',
      })
    );
    const cached = withUpdateCache(home, (cache) => cache)!;
    expect(cached.latestVersion).to.equal(undefined);
    expect(cached.attemptId).to.equal(undefined);
    expect(cached.lastNotifiedAt).to.equal(undefined);
    expect(checkDue(cached, Date.now())).to.equal(true);
  });

  it('does not treat a recent timestamp without a valid version as a successful check', () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        latestVersion: 'invalid',
        lastCheckedAt: Date.now(),
      })
    );
    const cached = withUpdateCache(home, (cache) => cache)!;
    expect(cached.lastCheckedAt).to.equal(undefined);
    expect(checkDue(cached, Date.now())).to.equal(true);
  });

  it('skips busy locks immediately and releases locks on failure', () => {
    let entered = false;
    withUpdateCache(home, () => {
      expect(
        withUpdateCache(home, () => {
          entered = true;
        })
      ).to.equal(undefined);
      throw Error('simulated write failure');
    });
    expect(entered).to.equal(false);
    expect(withUpdateCache(home, () => 'unlocked')).to.equal('unlocked');
  });

  it('rejects symlinked/hardlinked caches and locks without touching their targets', () => {
    const target = path.join(home, 'target');
    fs.writeFileSync(target, 'keep');
    for (const name of ['update-notifier.json', 'update-notifier.lock']) {
      const location = path.join(home, name);
      fs.rmSync(location, { force: true });
      for (const link of [fs.symlinkSync, fs.linkSync]) {
        link(target, location);
        expect(withUpdateCache(home, (_cache, save) => save(fresh))).to.equal(
          undefined
        );
        expect(fs.readFileSync(target, 'utf8')).to.equal('keep');
        fs.unlinkSync(location);
      }
    }
  });

  it('respects quiet/internal user aliases', () => {
    const prior = process.env.GRAPHITE_USER_CONFIG_PATH;
    const config = path.join(home, 'aliases.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        aliases: [
          { alias: 'silent', command: 'log --quiet' },
          { alias: 'machine', command: 'internal-only status' },
          { alias: 'noninteractive', command: 'log --no-interactive' },
        ],
      })
    );
    process.env.GRAPHITE_USER_CONFIG_PATH = config;
    try {
      for (const alias of ['silent', 'machine', 'noninteractive'])
        expect(updateNotificationsEnabled([alias], {}, terminal)).to.equal(
          false
        );
    } finally {
      if (prior === undefined) delete process.env.GRAPHITE_USER_CONFIG_PATH;
      else process.env.GRAPHITE_USER_CONFIG_PATH = prior;
    }
  });
});
