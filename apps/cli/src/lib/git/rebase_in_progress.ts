import fs from 'fs-extra';
import path from 'path';
import { getGitDir } from './git_dir';
import { runGitCommand } from './runner';

export function rebaseInProgress(options?: { cwd: string }): boolean {
  let rebaseDir = path.join(
    options?.cwd
      ? runGitCommand({
          args: [`rev-parse`, `--git-dir`],
          options,
          onError: 'throw',
          resource: 'rebaseInProgress',
        })
      : getGitDir(),
    'rebase-merge'
  );
  if (options?.cwd) {
    rebaseDir = path.join(options.cwd, rebaseDir);
  }
  return fs.existsSync(rebaseDir);
}
