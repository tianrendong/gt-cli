import { runGitCommand } from './runner';

export type TCommitOpts = {
  amend?: boolean;
  message?: string;
  noEdit?: boolean;
  edit?: boolean;
  patch?: boolean;
  resetAuthor?: boolean;
  verbose?: number;
};
export function commit(opts: TCommitOpts & { noVerify: boolean }): string {
  return runGitCommand({
    args: [
      'commit',
      ...(opts.amend ? [`--amend`] : []),
      ...(opts.message ? [`-m`, opts.message] : []),
      ...(opts.noEdit ? [`--no-edit`] : []),
      ...(opts.edit ? [`-e`] : []),
      ...(opts.patch ? [`-p`] : []),
      ...(opts.noVerify ? ['-n'] : []),
      ...(opts.resetAuthor ? ['--reset-author'] : []),
      ...Array.from({ length: opts.verbose || 0 }, () => '--verbose'),
    ],
    options: {
      // Keep hooks and editors attached to the terminal, but let the command
      // logger format/suppress Git's successful commit summary. Patch prompts
      // need stdout too; those are never buffered.
      stdio: opts.patch ? 'inherit' : ['inherit', 'pipe', 'inherit'],
    },
    onError: 'throw',
    resource: 'commit',
  });
}
