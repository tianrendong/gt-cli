import { TContext } from '../lib/context';
import { ExitFailedError } from '../lib/errors';
import { runGitCommand } from '../lib/git/runner';

export type StageOptions = {
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  // When set, interactively offer to stage pending changes, matching
  // `gt create`/`gt modify`: "you will be asked whether you'd like to stage".
  offer?: 'ALL' | 'TRACKED';
};

export function validateStaging(opts: StageOptions, context: TContext): void {
  if (opts.patch && !opts.all && !opts.update && !context.interactive) {
    throw new ExitFailedError(
      '--patch requires interactive mode. Stage selected hunks first when using --no-interactive.'
    );
  }
}

function stageGit(args: string[]): string {
  return runGitCommand({
    args,
    onError: 'throw',
    resource: 'stageChanges',
  });
}

export async function stageChanges(
  opts: StageOptions,
  context: TContext
): Promise<void> {
  validateStaging(opts, context);
  if (opts.all) return context.engine.addAll();
  if (opts.update) return context.engine.addUpdates();
  if (opts.patch) {
    runGitCommand({
      args: ['add', '--patch'],
      options: { stdio: 'inherit' },
      onError: 'throw',
      resource: 'stagePatch',
    });
    return;
  }
  if (!opts.offer || !context.interactive) return;
  const unstagedTracked = stageGit(['diff', '--name-only']).length > 0;
  const untracked =
    opts.offer === 'ALL' &&
    stageGit(['ls-files', '--others', '--exclude-standard']).length > 0;
  if (!unstagedTracked && !untracked) return;
  const answer = await context.prompts({
    type: 'confirm',
    name: 'value',
    message: untracked
      ? 'You have unstaged changes. Stage all changes (including untracked files) before continuing?'
      : 'You have unstaged changes. Stage them before continuing?',
    initial: true,
  });
  if (!answer.value) return;
  if (opts.offer === 'ALL') context.engine.addAll();
  else context.engine.addUpdates();
}
