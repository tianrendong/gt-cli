import { runGitCommand } from './runner';

export function restoreFile(file: string): void {
  runGitCommand({
    args: ['restore', '-SW', file],
    options: { stdio: 'ignore' },
    onError: 'throw',
    resource: 'clean',
  });
}
