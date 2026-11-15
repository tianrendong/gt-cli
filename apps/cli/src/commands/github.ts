import { Argv } from 'yargs';

export const command = 'github <command>';
export const description =
  'Inspect and repair the local gh-stack mirror and native GitHub Stacks.';
export const builder = (argv: Argv): Argv =>
  argv.commandDir('github-commands').strict().demandCommand();
