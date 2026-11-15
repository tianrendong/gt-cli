import yargs from 'yargs';
import { editDownstack } from '../actions/edit/edit_downstack';
import { ExitFailedError } from '../lib/errors';
import { graphite } from '../lib/runner';
import { SCOPE } from '../lib/engine/scope_spec';
import { performInTmpDir } from '../lib/utils/perform_in_tmp_dir';
import fs from 'fs';
import path from 'path';

const args = {
  order: {
    type: 'string',
    describe: 'Comma-separated branch order, bottom to top. Avoids the editor.',
  },
  file: {
    type: 'string',
    describe: 'Read an edit file (top branch first, one branch per line).',
  },
  stack: {
    describe: 'Include every branch through the tip of a linear stack.',
    type: 'boolean',
    default: false,
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = 'reorder';
export const canonical = 'reorder';
export const description =
  'Reorder branches between trunk and the current branch, restacking descendants.';
export const builder = args;

export const handler = async (argv: argsT): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (argv.stack) {
      // Include every upstack branch through the tip that gt top would
      // select, prompting when the stack forks.
      let branch = context.engine.currentBranchPrecondition;
      while (context.engine.getChildren(branch).length) {
        const children = context.engine.getChildren(branch);
        if (children.length === 1) {
          branch = children[0];
          continue;
        }
        if (!context.interactive)
          throw new ExitFailedError(
            `Multiple upstack branches found; choose a path interactively or check out the tip first:\n${children.join(
              '\n'
            )}`
          );
        branch = (
          await context.prompts({
            type: 'select',
            name: 'value',
            message: `Multiple children of ${branch}; select the path to reorder through`,
            choices: children.map((child) => ({ title: child, value: child })),
          })
        ).value;
      }
      context.engine.checkoutBranch(branch);
    }
    if (argv.order) {
      const names = argv.order.split(',').map((name) => name.trim());
      const expected = context.engine.getRelativeStack(
        context.engine.currentBranchPrecondition,
        SCOPE.DOWNSTACK
      );
      if (
        names.length !== expected.length ||
        new Set(names).size !== names.length ||
        names.some((name) => !expected.includes(name))
      ) {
        throw new ExitFailedError(
          '--order must contain every branch in the downstack exactly once, excluding trunk.'
        );
      }
      await performInTmpDir(async (directory) => {
        const file = path.join(directory, 'order');
        fs.writeFileSync(file, [...names].reverse().join('\n') + '\n');
        await editDownstack(file, context);
      });
    } else {
      if (!argv.file && !context.interactive)
        throw new ExitFailedError(
          'Use --order or --file in non-interactive mode.'
        );
      await editDownstack(argv.file, context);
    }
  });
