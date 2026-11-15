import { runGitCommand } from './runner';

export function clean(): void {
  runGitCommand({
    args: ['clean', '--force'],
    options: { stdio: 'ignore' },
    onError: 'throw',
    resource: 'clean',
  });
}
