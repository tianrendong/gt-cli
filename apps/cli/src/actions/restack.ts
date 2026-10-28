import chalk from 'chalk';
import { TContext } from '../lib/context';
import { RebaseConflictError } from '../lib/errors';
import { SCOPE } from '../lib/engine/scope_spec';
import { assertUnreachable } from '../lib/utils/assert_unreachable';
import { persistContinuation } from './persist_continuation';
import { printConflictStatus } from './print_conflict_status';

export function restackBranches(
  branchNames: string[],
  context: TContext,
  opts: { failOnConflict?: boolean; printProgress?: boolean } = {}
): void {
  context.splog.debug(
    branchNames.reduce((acc, curr) => `${acc}\n${curr}`, 'RESTACKING:')
  );
  // Each rebase checks out its branch. Return to the original branch once,
  // after the whole batch, unless a conflict must be left checked out.
  let conflict = false;
  const deferredConflicts = new Map<string, string | undefined>();
  try {
    restackSequentially(branchNames, context, {
      deferConflicts: opts.failOnConflict === false,
      printProgress: opts.printProgress !== false,
      onDeferred: (branchName, directory) =>
        deferredConflicts.set(branchName, directory),
      onConflict: (branchName) => {
        conflict = true;
        if (opts.failOnConflict !== false) return true;
        // Sync is best-effort: undo only this failed rebase, not the
        // successful pulls, deletions, or restacks that preceded it. Do not
        // create a continuation until the user explicitly runs gt restack.
        context.engine.abortRebase();
        conflict = false;
        deferredConflicts.set(branchName, undefined);
        return false;
      },
    });
  } finally {
    if (!conflict) context.engine.checkoutCurrentBranch();
  }
  if (deferredConflicts.size) {
    // Same layout as native gt: a blank line, the list, then the next step.
    context.splog.newline();
    context.splog.warn(
      [
        'The following branches could not be restacked cleanly:',
        ...Array.from(deferredConflicts, ([branch, directory]) =>
          directory
            ? `▸ ${chalk.yellow(branch)} (checked out in ${directory})`
            : `▸ ${chalk.yellow(branch)}`
        ),
      ].join('\n')
    );
    context.splog.newline();
    context.splog.info(
      `Check out each branch and run ${chalk.cyan(
        'gt restack'
      )} to resolve the conflicts.`
    );
  }
}

function restackSequentially(
  branchNames: string[],
  context: TContext,
  handlers: {
    deferConflicts: boolean;
    printProgress: boolean;
    onDeferred: (branchName: string, directory: string | undefined) => void;
    onConflict: (branchName: string) => boolean;
  }
): void {
  while (branchNames.length > 0) {
    const branchName = branchNames.shift() as string;

    if (context.engine.isTrunk(branchName)) {
      continue;
    }

    const result = context.engine.restackBranch(branchName, {
      deferCheckout: true,
      deferConflicts: handlers.deferConflicts,
    });
    context.splog.debug(`${result}: ${branchName}`);
    switch (result.result) {
      case 'REBASE_FROZEN':
        context.splog.info(
          `Did not restack branch ${chalk.yellow(
            branchName
          )} because it is frozen.`
        );
        continue;
      case 'REBASE_BLOCKED':
        // Descendants may already be stale; do not rewrite them when their
        // ancestor could not be moved safely.
        dropDescendants(branchName, branchNames, context);
        context.splog.info(
          `Did not restack branch ${chalk.yellow(
            branchName
          )} because it is checked out in worktree ${result.directory}, which ${
            result.cause
          }.`
        );
        continue;
      case 'REBASE_CONFLICT_DEFERRED':
        // Resolve the parent first. Stale descendants may conflict against its
        // old tip too, but they are blocked work, not independent failures.
        dropDescendants(branchName, branchNames, context);
        handlers.onDeferred(branchName, result.directory);
        continue;
      case 'REBASE_DONE':
        if (handlers.printProgress)
          context.splog.info(
            `Restacked ${chalk.green(branchName)} on ${chalk.cyan(
              context.engine.getParentPrecondition(branchName)
            )}.`
          );
        continue;

      case 'REBASE_CONFLICT':
        if (!handlers.onConflict(branchName)) {
          dropDescendants(branchName, branchNames, context);
          continue;
        }
        persistContinuation(
          {
            branchesToRestack: branchNames,
            rebasedBranchBase: result.rebasedBranchBase,
          },
          context
        );
        printConflictStatus(
          `Hit conflict restacking ${chalk.yellow(branchName)} on ${chalk.cyan(
            context.engine.getParentPrecondition(branchName)
          )}.`,
          context
        );
        throw new RebaseConflictError();

      case 'REBASE_UNNEEDED':
        if (handlers.printProgress)
          context.splog.info(
            `${chalk.cyan(
              branchName
            )} does not need to be restacked${` on ${chalk.cyan(
              context.engine.getParentPrecondition(branchName)
            )}`}.`
          );
        continue;

      default:
        assertUnreachable(result);
    }
  }
}

function dropDescendants(
  branchName: string,
  branchNames: string[],
  context: TContext
): void {
  const descendants = new Set(
    context.engine.getRelativeStack(branchName, SCOPE.UPSTACK)
  );
  for (let i = branchNames.length - 1; i >= 0; i--)
    if (descendants.has(branchNames[i])) branchNames.splice(i, 1);
}
