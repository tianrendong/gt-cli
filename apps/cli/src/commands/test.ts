import yargs from 'yargs';
import { testStack } from '../actions/test';
import { SCOPE } from '../lib/engine/scope_spec';
import { graphite } from '../lib/runner';

export const command = 'test <command>';
export const description =
  'Run a shell command on each branch, aggregate failures, and return to the original branch.';
export const builder = {
  command: { type: 'string', positional: true, demandOption: true },
  downstack: { type: 'boolean', default: false, alias: 'd' },
  upstack: { type: 'boolean', default: false, alias: 'u' },
  trunk: { type: 'boolean', default: false, alias: 't' },
} as const;
export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, 'test', async (context) =>
    testStack(
      {
        command: argv.command,
        scope: argv.downstack
          ? SCOPE.DOWNSTACK
          : argv.upstack
          ? SCOPE.UPSTACK
          : SCOPE.STACK,
        includeTrunk: argv.trunk,
      },
      context
    )
  );
