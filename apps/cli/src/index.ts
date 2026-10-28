#!/usr/bin/env node
/* eslint-disable no-console */

import chalk from 'chalk';
import tmp from 'tmp';
import yargs from 'yargs';
import { version } from '../package.json';
import { registerCommands } from './lib/commands';
import { globalArgumentsOptions } from './lib/global_arguments';
import { getYargsInput } from './lib/pre-yargs/preprocess_command';

// this line gets rid of warnings about "experimental fetch API" for our users
// while still showing us warnings when we test with DEBUG=1
if (!process.env.DEBUG) {
  process.removeAllListeners('warning');
}

// https://www.npmjs.com/package/tmp#graceful-cleanup
tmp.setGracefulCleanup();

const cwdIndex = process.argv.indexOf('--cwd');
const cwd =
  process.argv.find((arg) => arg.startsWith('--cwd='))?.slice(6) ??
  (cwdIndex >= 0 ? process.argv[cwdIndex + 1] : undefined);
if (cwd) process.chdir(cwd);

function reportUnhandled(err: Error): void {
  console.error(chalk.redBright(`UNCAUGHT EXCEPTION: ${err.message}`));
  console.error(chalk.redBright(`UNCAUGHT EXCEPTION: ${err.stack}`));
  process.exitCode = 1;
}
process.on('uncaughtException', (err) => {
  reportUnhandled(err);
  // eslint-disable-next-line no-restricted-syntax
  process.exit(1);
});

const cliArgs = process.argv.slice(2);
const separator = cliArgs.indexOf('--');
const optionArgs = separator < 0 ? cliArgs : cliArgs.slice(0, separator);
async function run(): Promise<void> {
  if (optionArgs.includes('--capabilities')) {
    // Repository-free handshake: wrappers must not become a second Stack writer.
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        implementation: 'gt-gh',
        nativeStackSync: true,
      })
    );
    return;
  }
  await registerCommands(
    yargs(getYargsInput()).scriptName('gt').version(version)
  )
    .help()
    .usage(
      'gt — GitHub-backed stacked changes, compatible with Graphite commands.\nLocal stacks mirror gh stack; submit synchronizes native GitHub Stacks.\n\nhttps://github.com/tianrendong/gt-cli'
    )
    .options(globalArgumentsOptions)
    .global(Object.keys(globalArgumentsOptions))
    .strict()
    .demandCommand()
    .parseAsync();
}

// Dispatchers can now await the complete command, including async handlers and
// their finally blocks, without booting another Node process for this release.
// Preserve the direct entry point's unhandled-error output while allowing
// callers to release their leases after failures as well as successful runs.
export const completion: Promise<void> = run().catch(reportUnhandled);
