import path from 'path';
import { runGitCommand } from './runner';

export type GitPaths = {
  gitDir: string;
  commonDir: string;
  index: string;
};

// Repository locations are stable during a command; refs, HEAD, configuration,
// and index contents are not. Never cache those mutable values here. Include
// Git's environment overrides so callers using alternate indexes/worktrees in
// the same process cannot accidentally reuse a different repository's paths.
const directories = new Map<string, GitPaths>();
const roots = new Map<string, string>();
function key(cwd: string): string {
  return JSON.stringify([
    path.resolve(cwd),
    ...Object.entries(process.env)
      .filter(([name]) =>
        /^(GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*))$/.test(
          name
        )
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
function resolve(cwd: string, flags: string[]): string {
  const result = runGitCommand({
    args: ['--no-optional-locks', '-C', cwd, 'rev-parse', ...flags],
    options: { noTrim: true },
    onError: 'ignore',
    resource: 'resolveGitPath',
  });
  return result.replace(/\n$/, '');
}

/** Values retain Git's relative/absolute spelling for existing callers. */
export function getGitPaths(cwd = process.cwd()): GitPaths | undefined {
  const cacheKey = key(cwd);
  const cached = directories.get(cacheKey);
  if (cached) return cached;
  const flags = ['--git-dir', '--git-common-dir', '--git-path', 'index'];
  const output = resolve(cwd, flags);
  if (!output) return undefined; // Failed discovery must not poison later init.
  let values = output.split('\n');
  if (values.length !== 3) {
    // Newlines are legal in directory names. The uncommon case keeps separate
    // queries rather than guessing where one path ends and the next begins.
    values = [
      resolve(cwd, ['--git-dir']),
      resolve(cwd, ['--git-common-dir']),
      resolve(cwd, ['--git-path', 'index']),
    ];
  }
  const [gitDir, commonDir, index] = values;
  if (!gitDir || !commonDir || !index) return undefined;
  const result = { gitDir, commonDir, index };
  directories.set(cacheKey, result);
  return result;
}

/** Worktree-local git directory, or '' when not inside a repository. */
export function getGitDir(): string {
  return getGitPaths()?.gitDir ?? '';
}

/** Shared git directory, or '' when not inside a repository. */
export function getGitCommonDir(): string {
  return getGitPaths()?.commonDir ?? '';
}

/** Root of this worktree. Bare repositories deliberately have no root. */
export function getGitTopLevel(): string {
  const cacheKey = key(process.cwd());
  const cached = roots.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = resolve(process.cwd(), ['--show-toplevel']);
  if (result) roots.set(cacheKey, result);
  return result;
}

/** Absolute index path, respecting GIT_INDEX_FILE and linked worktrees. */
export function getGitIndexPath(): string {
  const index = getGitPaths()?.index;
  return index ? path.resolve(index) : '';
}
