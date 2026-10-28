import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { ensureSomeStagedChangesPrecondition } from '../lib/preconditions';
import { BlockedDuringRebaseError, ExitFailedError } from '../lib/errors';
import { restackBranches } from './restack';
import { stageChanges } from './stage_changes';

export async function commitCreateAction(
  opts: {
    addAll: boolean;
    patch: boolean;
    message?: string;
    update?: boolean;
    verbose?: number;
  },
  context: TContext
): Promise<void> {
  if (context.engine.rebaseInProgress()) {
    throw new BlockedDuringRebaseError();
  }

  context.engine.assertBranchMutable(context.engine.currentBranchPrecondition);
  await stageChanges(
    { all: opts.addAll, update: opts.update, patch: opts.patch, offer: 'ALL' },
    context
  );

  ensureSomeStagedChangesPrecondition(context);
  if (!context.interactive && !opts.message)
    throw new ExitFailedError(
      'Supply --message when creating a commit non-interactively.'
    );
  context.engine.commit({
    message: opts.message,
    verbose: opts.verbose,
  });

  restackBranches(
    context.engine.getRelativeStack(
      context.engine.currentBranchPrecondition,
      SCOPE.UPSTACK_EXCLUSIVE
    ),
    context
  );
}
