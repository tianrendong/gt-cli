import { runGitCommand } from './runner';

export function showCommits(
  base: string | undefined,
  head: string,
  opts: { patch?: boolean; stat?: boolean } = {}
): string {
  return runGitCommand({
    args: [
      `-c`,
      `color.ui=always`,
      `--no-pager`,
      `log`,
      ...(base ? [] : ['-1']),
      ...(opts.patch ? [opts.stat ? '--stat' : '-p'] : []),
      base ? `${base}..${head}` : head,
      `--`,
    ],
    onError: 'throw',
    resource: 'showCommits',
  });
}
