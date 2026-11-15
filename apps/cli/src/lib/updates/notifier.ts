import path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { expandCommand } from '../pre-yargs/preprocess_command';
import { notificationInstallation } from './check';
import { checkDue, updateNotice, withUpdateCache } from './state';

type Terminal = { stdin: boolean; stdout: boolean; stderr: boolean };

export function updateNotificationsEnabled(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  terminal: Terminal = {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    stderr: Boolean(process.stderr.isTTY),
  }
): boolean {
  if (
    !terminal.stdin ||
    !terminal.stdout ||
    !terminal.stderr ||
    env.TERM === 'dumb' ||
    [
      'GT_CLI_NO_UPDATE_CHECK',
      'NO_UPDATE_NOTIFIER',
      'CI',
      'CONTINUOUS_INTEGRATION',
      'BUILD_NUMBER',
      'GITHUB_ACTIONS',
      'BUILDKITE',
      'TEAMCITY_VERSION',
    ].some(
      (key) => env[key] !== undefined && !['0', 'false'].includes(env[key]!)
    )
  )
    return false;
  const separator = args.indexOf('--');
  const options = (separator < 0 ? args : args.slice(0, separator)).filter(
    (arg, index) =>
      arg !== '--cwd' &&
      !arg.startsWith('--cwd=') &&
      args[index - 1] !== '--cwd'
  );
  const command = options.findIndex((arg) => !arg.startsWith('-'));
  if (command < 0) return false;
  // User aliases can carry --quiet/--no-interactive or target internal commands.
  options.splice(
    command,
    1,
    ...expandCommand(options[command], options[command + 1])
  );
  return !options.some(
    (arg, index) =>
      ['help', 'version', 'completion', 'fish', 'internal-only'].includes(
        arg
      ) ||
      /^--(?:help|version|quiet|json|capabilities|allCommands|get-yargs-completions)(?:=|$)/.test(
        arg
      ) ||
      /^--no-interactive(?:=|$)/.test(arg) ||
      /^--interactive=(?:false|0)$/.test(arg) ||
      (arg === '--interactive' &&
        ['false', '0'].includes(options[index + 1])) ||
      /^-[^-]*[qh]/.test(arg)
  );
}

/** Called only on the candidate path, never for native Graphite. No network
 * work runs in this process. The return value is an idempotent completion hook;
 * the exit listener also covers successful Git passthroughs that call exit().
 */
export function startUpdateNotification(
  cliRoot: string,
  args: readonly string[]
): ((exitCode: number) => void) | undefined {
  try {
    if (!updateNotificationsEnabled(args)) return undefined;
    const { running, current } = notificationInstallation(cliRoot);
    const snapshot = withUpdateCache(current.home, (cache, save) => {
      const now = Date.now();
      // Only an already-cached result is eligible for this command's notice.
      const latest = updateNotice(cache, current.record.version, now)
        ? cache.latestVersion
        : undefined;
      if (checkDue(cache, now)) {
        const attemptId = randomBytes(16).toString('hex');
        // Claim before spawning: multiple terminals share one check/backoff.
        save({ ...cache, lastAttemptAt: now, attemptId });
        const worker = spawn(
          running.record.node,
          [
            path.join(
              running.root,
              'dist/src/background_tasks/check_for_updates.js'
            ),
            attemptId,
          ],
          { cwd: running.home, detached: true, stdio: 'ignore' }
        );
        worker.once('error', () => {
          // Missing runtime/worker or spawn failure stays on the normal backoff.
        });
        worker.unref();
      }
      return latest;
    });
    if (!snapshot) return undefined;
    let finished = false;
    const finish = (exitCode: number): void => {
      process.removeListener('exit', finish);
      if (finished) return;
      finished = true;
      if (exitCode !== 0) return;
      try {
        // An update may have completed while this command was running. Re-read
        // current, not this dispatcher's version or the repository's candidate.
        const installed = notificationInstallation(cliRoot).current;
        withUpdateCache(installed.home, (cache, save) => {
          if (cache.latestVersion !== snapshot) return;
          const now = Date.now();
          const notice = updateNotice(cache, installed.record.version, now);
          if (!notice) return;
          save({
            ...cache,
            lastNotifiedVersion: snapshot,
            lastNotifiedAt: now,
          });
          process.stderr.write(notice);
        });
      } catch {
        // Even a concurrent uninstall or an unwritable cache is non-fatal.
      }
    };
    process.once('exit', finish);
    return finish;
  } catch {
    return undefined;
  }
}
