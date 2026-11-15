import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { installation } from '../../../scripts/installation/update.cjs';
import { stableVersion, withUpdateCache } from './state';

type Installation = ReturnType<typeof installation>;
export const LOOKUP_TIMEOUT_MS = 5000;

/** Reuse the updater's managed-install validation, not GT_CLI_HOME or a
 * repository's pinned candidate. Source checkouts have no .runtime-node link.
 * Load the shipped script from the package root: dist/scripts/update.cjs is not
 * part of the npm package, and this type-only import must stay type-only.
 */
export function notificationInstallation(cliRoot: string): {
  running: Installation;
  current: Installation;
} {
  cliRoot = fs.realpathSync(cliRoot);
  if (!fs.lstatSync(path.join(cliRoot, '.runtime-node')).isSymbolicLink())
    throw Error('Update notifications require a managed installation.');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const updater = require(path.join(
    cliRoot,
    'scripts/installation/update.cjs'
  )) as {
    installation: typeof installation;
  };
  const running = updater.installation(cliRoot);
  const selected = fs.readlinkSync(path.join(running.home, 'current'));
  if (!/^versions\/\.install-[a-zA-Z0-9]+$/.test(selected))
    throw Error('Invalid current installation pointer.');
  const current = updater.installation(
    path.join(running.home, selected, 'app/node_modules/@tianrendong/gt-cli')
  );
  if (current.home !== running.home)
    throw Error('Current installation is outside this installation home.');
  return { running, current };
}

/** Only the detached worker calls this. npm supplies private-registry auth,
 * proxies and user config just as it does for `gt-cli update`. No package code,
 * tarball or install script is downloaded/executed by a notification check.
 */
function latestVersion(info: Installation): string {
  const npm = path.join(
    path.dirname(info.record.node),
    '../lib/node_modules/npm/bin/npm-cli.js'
  );
  const output = execFileSync(
    info.record.node,
    [
      npm,
      'view',
      '@tianrendong/gt-cli@latest',
      'version',
      '--json',
      '--registry=https://registry.npmjs.org/',
      '--@tianrendong:registry=https://registry.npmjs.org/',
      '--prefer-online',
      '--offline=false',
      '--fetch-retries=0',
      `--fetch-timeout=${LOOKUP_TIMEOUT_MS}`,
      '--update-notifier=false',
      '--logs-max=0',
    ],
    {
      cwd: info.home,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LOOKUP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
    }
  );
  const version = stableVersion(JSON.parse(output));
  if (!version) throw Error('Invalid npm latest version.');
  return version;
}

export function checkForUpdates(cliRoot: string, attemptId: string): void {
  try {
    if (!/^[a-f0-9]{32}$/.test(attemptId)) return;
    const { current } = notificationInstallation(cliRoot);
    const claimed = withUpdateCache(
      current.home,
      (cache) => cache.attemptId === attemptId
    );
    if (!claimed) return;
    const version = latestVersion(current);
    withUpdateCache(current.home, (cache, save) => {
      // A late worker cannot overwrite a newer attempt after a clock rollback.
      if (cache.attemptId !== attemptId) return;
      save({ ...cache, latestVersion: version, lastCheckedAt: Date.now() });
    });
  } catch {
    // Offline, expired auth, invalid responses and killed subprocesses are all
    // advisory failures. The saved attempt timestamp backs off further checks.
  }
}
