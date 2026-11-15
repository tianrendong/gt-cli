import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { ExitFailedError } from '../lib/errors';
import { newBranchName } from '../lib/utils/branch_name';
import { restackBranches } from './restack';
import { stageChanges, validateStaging } from './stage_changes';

export async function createBranchAction(
  opts: {
    branchName?: string;
    message?: string;
    all?: boolean;
    insert?: boolean;
    patch?: boolean;
    update?: boolean;
    verbose?: number;
  },
  context: TContext
): Promise<void> {
  const branchName = newBranchName(opts.branchName, opts.message, context);
  if (!branchName) {
    throw new ExitFailedError(
      `Must specify either a branch name or commit message.`
    );
  }

  validateStaging(opts, context);
  context.engine.checkoutNewBranch(branchName);
  await stageChanges({ ...opts, offer: 'ALL' }, context);

  if (context.engine.detectStagedChanges()) {
    try {
      if (!context.interactive && !opts.message)
        throw new ExitFailedError(
          'Supply --message when creating a commit non-interactively.'
        );
      context.engine.commit({
        message: opts.message,
        verbose: opts.verbose,
        summaryOnly: true,
      });
    } catch (e) {
      try {
        context.engine.deleteBranch(branchName);
      } catch {
        // pass
      }
      throw e;
    }
  } else {
    context.splog.info(`No staged changes; creating a branch with no commit.`);
  }

  // The reason we get the list of siblings here instead of having all
  // the `--insert` logic in a separate function is so that we only
  // show the tip if the user creates a branch with siblings.

  const siblings = context.engine
    .getChildren(context.engine.getParentPrecondition(branchName))
    .filter((childBranchName) => childBranchName !== branchName);

  if (siblings.length === 0) {
    return;
  }

  if (!opts.insert) {
    context.splog.tip(
      [
        'To insert a created branch into the middle of your stack, use the `--insert` flag.',
        "If you meant to insert this branch, you can rearrange your stack's dependencies with `gt upstack onto`",
      ].join('\n')
    );
    return;
  }

  // Now we actually handle the `insert` case. With multiple siblings,
  // Graphite prompts you to select which children move onto the new branch.
  const movedSiblings =
    siblings.length > 1 && context.interactive
      ? (
          await context.prompts({
            type: 'multiselect',
            name: 'value',
            message: `Select the branches to move onto ${branchName}`,
            choices: siblings.map((sibling) => ({
              title: sibling,
              value: sibling,
              selected: true,
            })),
            instructions: false,
          })
        ).value
      : siblings;

  // Change the parent of each selected sibling to the new branch.
  movedSiblings.forEach((siblingBranchName: string) =>
    context.engine.setParent(siblingBranchName, branchName)
  );

  // If we're restacking siblings onto this branch, we need to restack
  // all of their recursive children as well. Get all the upstacks!
  restackBranches(
    movedSiblings.flatMap((siblingBranchName: string) =>
      context.engine.getRelativeStack(siblingBranchName, SCOPE.UPSTACK)
    ),
    context
  );
}
