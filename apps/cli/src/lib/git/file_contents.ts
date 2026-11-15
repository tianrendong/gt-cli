import { runGitCommand } from './runner';

export function getFileContents(ref: string, file: string): string {
  return runGitCommand({
    args: [`show`, `${ref}:${file}`],
    onError: 'throw',
    resource: 'fileContents',
  });
}
