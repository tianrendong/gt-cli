import { runGitCommand } from './runner';

export function addUpdates(): void {
  runGitCommand({
    args: ['add', '--update'],
    onError: 'throw',
    resource: 'addUpdates',
  });
}

export function addAll(): void {
  runGitCommand({
    args: ['add', '--all'],
    onError: 'throw',
    resource: 'addAll',
  });
}
