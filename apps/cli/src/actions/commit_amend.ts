import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import {
  PreconditionsFailedError,
  BlockedDuringRebaseError,
} from '../lib/errors';
import { restackBranches } from './restack';
import { stageChanges } from './stage_changes';

export async function commitAmendAction(
  opts: {
    addAll: boolean;
    message?: string;
    noEdit: boolean;
    patch: boolean;
    update?: boolean;
    resetAuthor?: boolean;
    verbose?: number;
  },
  context: TContext
): Promise<void> {
  if (
    context.engine.getAllCommits(
      context.engine.currentBranchPrecondition,
      'SHA'
    ).length === 0
  ) {
    throw new PreconditionsFailedError('No commits in this branch to amend');
  }
  if (context.engine.rebaseInProgress()) {
    throw new BlockedDuringRebaseError();
  }

  context.engine.assertBranchMutable(context.engine.currentBranchPrecondition);
  await stageChanges(
    { all: opts.addAll, update: opts.update, patch: opts.patch, offer: 'ALL' },
    context
  );

  context.engine.commit({
    amend: true,
    noEdit: opts.noEdit,
    message: opts.message,
    resetAuthor: opts.resetAuthor,
    verbose: opts.verbose,
  });

  if (!opts.noEdit) {
    context.splog.tip(
      'In the future, you can skip editing the commit message with the `--no-edit` flag.'
    );
  }

  restackBranches(
    context.engine.getRelativeStack(
      context.engine.currentBranchPrecondition,
      SCOPE.UPSTACK_EXCLUSIVE
    ),
    context
  );
}
