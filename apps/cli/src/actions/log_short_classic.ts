import chalk from 'chalk';
import { TContext } from '../lib/context';

function displayBranchesInternal(
  opts: {
    branchName: string;
    highlightCurrentBranch?: boolean;
    omitCurrentBranch?: boolean;
    indent?: number;
  },
  context: TContext
): { display: string; branchName: string }[] {
  const currentBranchName = context.engine.currentBranch;
  const currentChoice = {
    display: `${'  '.repeat(opts.indent ?? 0)}↱ $ ${opts.branchName}${
      context.engine.isBranchFixed(opts.branchName)
        ? ''
        : chalk.yellowBright(` (needs restack)`)
    }`,
    branchName: opts.branchName,
  };
  return (
    context.engine
      .getChildren(opts.branchName)
      ?.filter((b) => b !== currentBranchName || !opts.omitCurrentBranch)
      .map((b) =>
        displayBranchesInternal(
          {
            ...opts,
            branchName: b,
            indent: (opts.indent ?? 0) + 1,
          },
          context
        )
      )
      .reduceRight((acc, arr) => arr.concat(acc), [currentChoice]) ?? []
  );
}

export function logShortClassic(context: TContext): void {
  context.splog.info(
    displayBranchesInternal(
      { branchName: context.engine.trunk, highlightCurrentBranch: true },
      context
    )
      .map((b) => b.display)
      .join('\n')
  );
}
