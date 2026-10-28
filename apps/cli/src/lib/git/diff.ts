import { runGitCommand } from './runner';

export function detectStagedChanges(): boolean {
  return (
    runGitCommand({
      args: [`--no-pager`, `diff`, `--no-ext-diff`, `--shortstat`, `--cached`],
      onError: 'throw',
      resource: 'detectStagedChanges',
    }).length > 0
  );
}

export function getUnstagedChanges(): string {
  return runGitCommand({
    args: [
      `-c`,
      `color.ui=always`,
      `--no-pager`,
      `diff`,
      `--no-ext-diff`,
      `--stat`,
    ],
    onError: 'throw',
    resource: 'getUnstagedChanges',
  });
}

export function showDiff(left: string, right: string, stat?: boolean): string {
  return runGitCommand({
    args: [
      `-c`,
      `color.ui=always`,
      `--no-pager`,
      `diff`,
      `--no-ext-diff`,
      ...(stat ? ['--stat'] : []),
      left,
      right,
      `--`,
    ],
    onError: 'throw',
    resource: 'showDiff',
  });
}

export function isDiffEmpty(left: string, right: string): boolean {
  return (
    runGitCommand({
      args: [
        `--no-pager`,
        `diff`,
        `--no-ext-diff`,
        `--shortstat`,
        left,
        right,
        `--`,
      ],
      onError: 'throw',
      resource: 'isDiffEmpty',
    }).length === 0
  );
}

export function getDiff(left: string, right: string | undefined): string {
  return runGitCommand({
    args: ['diff', left, ...(right ? [right] : []), '--no-prefix', '--unified'],
    onError: 'throw',
    resource: 'getDiff',
  });
}
