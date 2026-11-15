import { runAsyncGitCommand } from './runner';

// Using pretty formats specified here

export function getCommitAuthor(ref: string): Promise<string> {
  return runAsyncGitCommand({
    args: [`log`, '--format=%an', '-n', '1', ref],
    onError: 'ignore',
    resource: 'commitInfoAuthor',
  });
}

export async function getCommitDate(ref: string): Promise<Date> {
  const result = await runAsyncGitCommand({
    args: [`log`, '--format=%cd', '-n', '1', ref],
    onError: 'ignore',
    resource: 'commitInfoBody',
  });

  return new Date(result);
}
