import { spawnSync } from 'child_process';
import { ExitFailedError } from '../errors';

export const GRAPHITE_SUBMIT_KEY = 'gt.submitGraphite';
export type SettingScope = 'global' | 'local';
export type GraphiteSubmitSetting = {
  enabled: boolean;
  source: 'repository' | 'global' | 'default';
};

function config(args: string[], cwd = process.cwd()) {
  return spawnSync('git', ['--no-optional-locks', 'config', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Git owns config locking; --local is shared by all linked worktrees. */
export function readGraphiteSubmit(
  scope: SettingScope,
  cwd?: string
): boolean | undefined {
  const result = config(
    [`--${scope}`, '--includes', '--bool', '--get', GRAPHITE_SUBMIT_KEY],
    cwd
  );
  if (result.status === 1 && !result.error) return undefined;
  const value = result.stdout?.trim();
  if (result.error || result.status !== 0 || !['true', 'false'].includes(value))
    throw new ExitFailedError(
      `Cannot read ${scope} submit.graphite setting. Use a Git repository for local settings and a valid Git boolean.`
    );
  return value === 'true';
}

export function graphiteSubmitSetting(cwd?: string): GraphiteSubmitSetting {
  const local = readGraphiteSubmit('local', cwd);
  if (local !== undefined) return { enabled: local, source: 'repository' };
  const global = readGraphiteSubmit('global', cwd);
  return global === undefined
    ? { enabled: false, source: 'default' }
    : { enabled: global, source: 'global' };
}

export function writeGraphiteSubmit(
  value: boolean | undefined,
  scope: SettingScope,
  cwd?: string
): void {
  const result = config(
    [
      `--${scope}`,
      ...(value === undefined
        ? ['--unset-all', GRAPHITE_SUBMIT_KEY]
        : ['--type=bool', '--replace-all', GRAPHITE_SUBMIT_KEY, String(value)]),
    ],
    cwd
  );
  if (
    result.error ||
    (result.status !== 0 && !(value === undefined && result.status === 5))
  )
    throw new ExitFailedError(
      `Cannot write ${scope} submit.graphite setting. Check repository/config permissions and concurrent Git config writers.`
    );
}
