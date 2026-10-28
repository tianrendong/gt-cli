import chalk from 'chalk';
import { TContext } from '../lib/context';
import { ExitFailedError } from '../lib/errors';

export function unbranch(context: TContext): void {
  const currentBranchName = context.engine.currentBranchPrecondition;
  const parentBranchName =
    context.engine.getParentPrecondition(currentBranchName);
  if (context.engine.getChildren(currentBranchName).length > 0) {
    throw new ExitFailedError(`Can't unbranch a branch with children!`);
  }
  context.engine.unbranch();
  context.splog.info(
    `Popped ${chalk.red(currentBranchName)}. Now on ${chalk.blueBright(
      parentBranchName
    )}.`
  );
}
