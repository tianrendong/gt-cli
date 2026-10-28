import chalk from 'chalk';
import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { AbsorbPlan, applyAbsorb, planAbsorb } from '../actions/absorb';
import { stageChanges } from '../actions/stage_changes';
import { TContext } from '../lib/context';
import { BadTrunkOperationError, ExitFailedError } from '../lib/errors';

export const command = 'absorb';
export const canonical = 'absorb';
export const aliases = ['ab'];
export const description =
  'Amend staged changes to the relevant commits in the current stack.';
export const builder = {
  'dry-run': {
    type: 'boolean',
    default: false,
    alias: 'd',
    describe:
      'Print which commits the hunks would be absorbed into, but do not absorb them.',
  },
  force: {
    type: 'boolean',
    default: false,
    alias: 'f',
    describe:
      'Do not prompt for confirmation; apply the hunks to the commits immediately.',
  },
  all: {
    type: 'boolean',
    default: false,
    alias: 'a',
    describe:
      'Stage all unstaged changes before absorbing. Does not include untracked files, as file creations are never absorbed.',
  },
  patch: {
    type: 'boolean',
    default: false,
    alias: 'p',
    describe: 'Pick hunks to stage before absorbing.',
  },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    const current = context.engine.currentBranchPrecondition;
    if (context.engine.isTrunk(current))
      throw new BadTrunkOperationError(current);
    await stageChanges({ update: argv.all, patch: argv.patch }, context);
    context.splog.info(
      chalk.blueBright('\u{1F50D} Calculating changes to absorb...')
    );
    const plan = planAbsorb(context);
    const shown = plan.files.filter((entry) => entry.hunks.length);
    if (!shown.length) {
      context.splog.info(chalk.yellow('\u2705 No changes to absorb.'));
      return;
    }
    printPlan(shown, context);
    if (argv['dry-run']) {
      context.splog.info(chalk.blueBright('\u2705 Dry run complete.'));
      return;
    }
    if (!plan.branches.length) {
      context.splog.info(chalk.yellow('\u2705 No changes to absorb.'));
      return;
    }
    if (!argv.force) {
      if (!context.interactive) {
        throw new ExitFailedError(
          'Pass --force to absorb without confirmation in non-interactive mode. Nothing was absorbed.'
        );
      }
      const answer = await context.prompts({
        type: 'confirm',
        name: 'value',
        message: 'Amend these commits and restack their descendants?',
        initial: true,
      });
      if (!answer.value) return;
    }
    const restacked = applyAbsorb(plan, context);
    printSummary(plan, restacked, context);
  });

function printPlan(files: AbsorbPlan['files'], context: TContext): void {
  for (const { file, hunks } of files) {
    context.splog.info(`Staged changes in ${chalk.yellowBright(file)}:`);
    for (const hunk of hunks) {
      context.splog.info(chalk.magenta(hunk.header));
      context.splog.info(
        hunk.branch
          ? `Absorbing into: ${chalk.blueBright(
              hunk.branch
            )}\nCommit: ${chalk.bold(hunk.commitLabel)}`
          : 'Not absorbed'
      );
      hunk.body.forEach((line) =>
        context.splog.info(
          line.startsWith('-')
            ? chalk.red(line)
            : line.startsWith('+')
            ? chalk.green(line)
            : line
        )
      );
    }
    context.splog.newline();
  }
}

function printSummary(
  plan: AbsorbPlan,
  restacked: string[],
  context: TContext
): void {
  const plural = (count: number) => (count === 1 ? 'change' : 'changes');
  const skipped = plan.unassigned.filter((entry) => !entry.hidden).length;
  context.splog.newline();
  context.splog.info(
    chalk.green(
      `\u{1F9FD} Absorbed ${plan.hunks.length} ${plural(plan.hunks.length)}.${
        skipped
          ? chalk.yellow(` ${skipped} ${plural(skipped)} were not absorbed.`)
          : ''
      }`
    )
  );
  for (const { branch } of plan.branches) {
    const applied = plan.hunks.filter((hunk) => hunk.branch === branch).length;
    context.splog.info(
      `${chalk.green(branch)} updated (${applied} ${plural(applied)} applied)`
    );
  }
  restacked.forEach((branch) =>
    context.splog.info(`${chalk.cyan(branch)} restacked`)
  );
}
