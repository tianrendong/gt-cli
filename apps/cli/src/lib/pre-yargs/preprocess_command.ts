import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleDeprecatedCommandNames } from './deprecated_commands';
import { passthrough } from './passthrough';

const FLAT_ALIASES = new Map<string, string[]>([
  ['c', ['create']],
  ['m', ['modify']],
  ['co', ['checkout']],
  ['u', ['up']],
  ['d', ['down']],
  ['t', ['top']],
  ['i', ['info']],
  ['g', ['guide']],
  ['ab', ['absorb']],
  ['tr', ['track']],
  ['ut', ['untrack']],
  ['utr', ['untrack']],
  ['rn', ['rename']],
  ['dl', ['delete']],
  ['sq', ['squash']],
  ['sp', ['split']],
  ['mv', ['move']],
  ['ro', ['reorder']],
  ['rs', ['restack']],
  ['ls', ['log', 'short']],
  ['ll', ['log', 'long']],
  ['ss', ['submit', '--stack']],
]);

/** User-defined aliases from ~/.graphite_user_config (see `gt aliases`).
 * Loaded without a repo context because expansion happens before yargs.
 */
export function loadUserAliases(): Map<string, string[]> {
  try {
    const file =
      process.env.GRAPHITE_USER_CONFIG_PATH ??
      path.join(os.homedir(), '.graphite_user_config');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      aliases?: { alias: string; command: string }[];
    };
    return new Map(
      (data.aliases ?? [])
        .filter(
          (entry) =>
            typeof entry?.alias === 'string' &&
            typeof entry?.command === 'string' &&
            /^\S+$/.test(entry.alias) &&
            entry.command.trim().length > 0
        )
        .map((entry) => [entry.alias, entry.command.trim().split(/\s+/)])
    );
  } catch {
    return new Map();
  }
}
const NOUNS: Record<string, string> = {
  b: 'branch',
  c: 'commit',
  s: 'stack',
  ds: 'downstack',
  us: 'upstack',
};

export function expandCommand(command: string, following?: string): string[] {
  const user = loadUserAliases().get(command);
  if (user) return user;
  // Preserve noun-verb forms while making flat aliases behave like modern gt.
  if (command === 'c' && ['create', 'amend'].includes(following || ''))
    return ['commit'];
  if (command === 'b')
    return following && !following.startsWith('-') ? ['branch'] : ['bottom'];
  if (command === 's')
    return ['submit', 's', 'restack', 'r', 'test', 't'].includes(
      following || ''
    )
      ? ['stack']
      : ['submit'];
  if (command === 'r')
    return following && !following.startsWith('-') ? ['repo'] : ['restack'];
  const flat = FLAT_ALIASES.get(command);
  if (flat) return flat;
  if (['ds', 'us', 'up', 'pr'].includes(command)) return [command];
  if (command.length === 2 && NOUNS[command[0]])
    return [NOUNS[command[0]], command[1]];
  if (
    ['bco', 'bdl', 'btr', 'but', 'brn', 'bsq', 'bsp', 'dpr'].includes(command)
  )
    return [NOUNS[command[0]] ?? command[0], command.slice(1)];
  if (
    (command.length === 3 || command === 'dstr') &&
    ['ds', 'us'].includes(command.slice(0, 2))
  )
    return [NOUNS[command.slice(0, 2)], command.slice(2)];
  return [command];
}

export function getYargsInput(): string[] {
  const input = process.argv.slice(2);
  let index = 0;
  while (index < input.length && input[index].startsWith('-')) {
    index += input[index] === '--cwd' ? 2 : 1;
  }
  if (index >= input.length) return input;
  const expanded = expandCommand(input[index], input[index + 1]);
  const prefix = input.slice(0, index);
  const command = [...expanded, ...input.slice(index + 1)];
  // --cwd is a gt global option, never an argument to a forwarded Git command.
  const gitArgs = [...command];
  const cwd = gitArgs.indexOf('--cwd');
  if (cwd >= 0) gitArgs.splice(cwd, 2);
  const globals = new Set([
    '--no-interactive',
    '--interactive',
    '--debug',
    '--no-debug',
    '--quiet',
    '--no-quiet',
    '--verify',
    '--no-verify',
  ]);
  const separator = gitArgs.indexOf('--');
  passthrough([
    ...process.argv.slice(0, 2),
    ...gitArgs.filter(
      (arg, i) =>
        (separator >= 0 && i >= separator) ||
        (!arg.startsWith('--cwd=') && !globals.has(arg))
    ),
  ]);
  handleDeprecatedCommandNames(command.slice(0, 2));
  return [...prefix, ...command];
}
