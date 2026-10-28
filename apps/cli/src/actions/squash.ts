import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { BadTrunkOperationError, ExitFailedError } from '../lib/errors';
import { TCommitOpts } from '../lib/git/commit';
import { restackBranches } from './restack';

export function squashCurrentBranch(
  opts: Pick<TCommitOpts, 'message' | 'noEdit'>,
  context: TContext
): void {
  const branchName = context.engine.currentBranchPrecondition;
  if (context.engine.isTrunk(branchName))
    throw new BadTrunkOperationError(branchName);
  if (context.engine.getAllCommits(branchName, 'SHA').length < 2)
    throw new ExitFailedError('Only one commit in branch, nothing to squash.');
  context.engine.squashCurrentBranch({
    noEdit: opts.noEdit,
    message: opts.message,
  });
  restackBranches(
    context.engine.getRelativeStack(
      context.engine.currentBranchPrecondition,
      SCOPE.UPSTACK_EXCLUSIVE
    ),
    context
  );
}
