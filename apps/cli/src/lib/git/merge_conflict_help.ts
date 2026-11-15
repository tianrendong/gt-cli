import fs from 'fs-extra';
import path from 'path';
import { getGitDir } from './git_dir';
import { runGitCommandAndSplitLines } from './runner';

export function getUnmergedFiles(): string[] {
  return runGitCommandAndSplitLines({
    args: [
      `--no-pager`,
      `diff`,
      `--no-ext-diff`,
      `--name-only`,
      `--diff-filter=U`,
    ],
    onError: 'throw',
    resource: 'getUnmergedFiles',
  });
}

export function getRebaseHead(): string | undefined {
  const rebaseHeadPath = path.join(getGitDir(), `rebase-merge`, `head-name`);

  return fs.existsSync(rebaseHeadPath)
    ? fs
        .readFileSync(rebaseHeadPath, {
          encoding: 'utf-8',
        })
        .trim()
        .slice('refs/heads/'.length)
    : undefined;
}
