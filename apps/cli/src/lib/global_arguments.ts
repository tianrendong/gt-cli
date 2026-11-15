import yargs from 'yargs';

export const globalArgumentsOptions = {
  interactive: {
    default: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    type: 'boolean',
    demandOption: false,
    description: 'Prompt the user. Disable with --no-interactive.',
  },
  quiet: {
    alias: 'q',
    default: false,
    type: 'boolean',
    demandOption: false,
    description: 'Minimize output to the terminal.',
  },
  verify: {
    default: true,
    type: 'boolean',
    demandOption: false,
    description: 'Run git hooks. Disable with --no-verify.',
  },
  debug: {
    default: false,
    type: 'boolean',
    demandOption: false,
    description: 'Display debug output.',
  },
  cwd: {
    type: 'string',
    demandOption: false,
    description: 'Working directory in which to perform operations.',
  },
  allCommands: {
    type: 'boolean',
    demandOption: false,
    hidden: true,
    description: 'Print the full list of command help.',
  },
} as const;

export type TGlobalArguments = Partial<
  yargs.InferredOptionTypes<typeof globalArgumentsOptions>
>;
