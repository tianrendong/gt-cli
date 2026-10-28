import yargs from 'yargs';
import { foldCurrentBranch } from '../../actions/fold_branch';
import { graphite } from '../../lib/runner';
import { TContext } from '../../lib/context';
import { ExitFailedError } from '../../lib/errors';
import { GitHubClient } from '../../lib/github/client';
import { cleanupDeletedGitHubStacks } from '../../lib/github/stack_cleanup';
import { renameCurrentBranch } from '../../actions/rename_branch';

const args = {
  keep: {
    describe: `Keeps the name of the current branch instead of using the name of its parent.`,
    demandOption: false,
    type: 'boolean',
    alias: 'k',
    default: false,
  },
  stack: {
    describe: `Fold the selected branch's entire stack into a single retained branch.`,
    demandOption: false,
    type: 'boolean',
    default: false,
  },
  'stack-sync': {
    describe:
      'Immediately remove folded branches from native GitHub stacks. Defaults to on with --close, otherwise off; gt submit and gt sync apply the cleanup.',
    type: 'boolean',
  },
  close: {
    describe: `Close associated pull requests on GitHub.`,
    demandOption: false,
    type: 'boolean',
    alias: 'c',
    default: false,
  },
} as const;
type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const aliases = ['f'];
export const command = 'fold';
export const canonical = 'branch fold';
export const description =
  "Fold a branch's changes into its parent, update dependencies of descendants of the new combined branch, and restack.";
export const builder = args;
export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const original = context.engine.currentBranchPrecondition;
    // Capture PR info before folding; folded branches lose their metadata.
    const openPRs = new Map(
      context.engine.allBranchNames.flatMap((branchName) => {
        const prInfo = context.engine.getPrInfo(branchName);
        return prInfo?.number && prInfo.state === 'OPEN'
          ? [[branchName, prInfo.number] as const]
          : [];
      })
    );
    const folded: string[] = [];
    if (argv.stack) {
      const top = await linearStackTop(context);
      context.engine.checkoutBranch(top);
      while (
        !context.engine.isTrunk(
          context.engine.getParentPrecondition(
            context.engine.currentBranchPrecondition
          )
        )
      ) {
        folded.push(context.engine.currentBranchPrecondition);
        foldCurrentBranch(false, context);
      }
      const bottom = context.engine.currentBranchPrecondition;
      if (argv.keep && bottom !== original) {
        folded.push(bottom);
        await renameCurrentBranch(
          { newBranchName: original, force: true },
          context
        );
      }
    } else {
      folded.push(
        argv.keep ? context.engine.getParentPrecondition(original) : original
      );
      foldCurrentBranch(argv.keep, context);
    }
    if (argv.close) closePRs(folded, openPRs, context);
    if (argv['stack-sync'] ?? argv.close)
      await cleanupDeletedGitHubStacks(context);
  });

/** Find the tip that `gt top` would select, prompting on ambiguity. */
async function linearStackTop(context: TContext): Promise<string> {
  let branch = context.engine.currentBranchPrecondition;
  for (;;) {
    const children = context.engine.getChildren(branch);
    if (!children.length) return branch;
    if (children.length === 1) {
      branch = children[0];
      continue;
    }
    if (!context.interactive) {
      throw new ExitFailedError(
        `Multiple upstack branches found; choose a linear path interactively or fold branches individually:\n${children.join(
          '\n'
        )}`
      );
    }
    branch = (
      await context.prompts({
        type: 'select',
        name: 'value',
        message: `Multiple children of ${branch}; select the path to fold`,
        choices: children.map((child) => ({ title: child, value: child })),
      })
    ).value;
  }
}

function closePRs(
  branchNames: string[],
  openPRs: Map<string, number>,
  context: TContext
): void {
  const toClose = branchNames.filter((branchName) => openPRs.has(branchName));
  if (!toClose.length) return;
  const client = GitHubClient.fromConfig(context.repoConfig);
  for (const branchName of toClose) {
    const prNumber = openPRs.get(branchName) as number;
    try {
      client.pr(['close', String(prNumber)]);
    } catch (error) {
      if (!(error instanceof ExitFailedError)) throw error;
      throw new ExitFailedError(
        `Fold completed locally, but closing PR #${prNumber} for ${branchName} failed. Close it manually.\n${error.message}`
      );
    }
    if (context.engine.branchExists(branchName)) {
      context.engine.upsertPrInfo(branchName, { state: 'CLOSED' });
    }
    context.splog.info(`Closed PR #${prNumber} for ${branchName}.`);
  }
}
