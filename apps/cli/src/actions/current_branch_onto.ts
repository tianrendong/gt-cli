import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { uncommittedTrackedChangesPrecondition } from '../lib/preconditions';
import { restackBranches } from './restack';

export function currentBranchOnto(
  ontoBranchName: string,
  context: TContext
): void {
  uncommittedTrackedChangesPrecondition();

  const currentBranch = context.engine.currentBranchPrecondition;

  context.engine.setParent(currentBranch, ontoBranchName);

  restackBranches(
    context.engine.getRelativeStack(currentBranch, SCOPE.UPSTACK),
    context
  );
}
