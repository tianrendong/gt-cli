/* eslint-disable no-console */
import chalk from 'chalk';
import { execSync } from 'child_process';
import { version } from '../../../package.json';
import { CommandFailedError } from '../git/runner';
import { tracer } from './tracer';

export type TSplog = {
  newline: () => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
  message: (msg: string) => void;
  tip: (msg: string) => void;
  page: (msg: string) => void;
};

export function composeSplog(
  opts: {
    quiet?: boolean;
    outputDebugLogs?: boolean;
    tips?: boolean;
    pager?: string;
  } = {}
): TSplog {
  const warn = (s: string) => console.error(chalk.yellow(`WARNING: ${s}`));
  return {
    newline: opts.quiet ? () => void 0 : () => console.log(),
    info: opts.quiet ? () => void 0 : (s: string) => console.log(s),
    debug: opts.outputDebugLogs
      ? (s: string) =>
          console.log(
            JSON.stringify({
              cliVersion: version,
              level: 'debug',
              message: s,
              timestamp: new Date().toISOString(),
              traceId: tracer.traceId,
            })
          )
      : () => void 0,
    error: (s: string) => console.error(chalk.redBright(`ERROR: ${s} `)),
    warn,
    message: (s: string) => console.log(chalk.yellow(`${chalk.yellow(s)}\n\n`)),
    tip: (s: string) =>
      opts.tips && !opts.quiet
        ? console.error(
            chalk.dim(['', `${chalk.yellow('tip')}: ${s}`, ''].join('\n'))
          )
        : undefined,
    page: (s: string) => {
      if (opts.quiet) return;
      // Native gt pages whenever interactive features are enabled, even when
      // stdout is redirected. Callers decide interactivity; do not re-check TTY.
      if (!opts.pager) {
        console.log(s);
        return;
      }
      try {
        execSync(`${opts.pager}`, {
          input: s,
          stdio: ['pipe', 'inherit', 'inherit'],
          encoding: 'utf-8',
          // match what git does for pager env vars
          // https://github.com/git/git/blob/master/Documentation/config/core.txt#L550
          env: { LESS: 'FRX', LV: '-c', ...process.env },
        });
      } catch (e) {
        if (e.status !== 0 || e.code !== 'EPIPE') {
          console.log(s);
          warn(
            `Tried to send output to your pager (${chalk.cyan(
              opts.pager
            )}) but encountered an error.\nYou can change your configured pager or disable paging in ${chalk.cyan(
              `gt config`
            )}`
          );
          throw new CommandFailedError({
            command: opts.pager,
            ...e,
          });
        }
      }
    },
  };
}
