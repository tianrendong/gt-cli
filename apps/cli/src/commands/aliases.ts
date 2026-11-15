import fs from 'fs-extra';
import tmp from 'tmp';
import yargs from 'yargs';
import { graphiteWithoutRepo } from '../lib/runner';
import { ExitFailedError } from '../lib/errors';
import { TContextLite } from '../lib/context';

export const command = 'aliases';
export const canonical = 'aliases';
export const description =
  'Edit your command aliases. Aliases expand as the first word of a gt invocation.';
export const builder = {
  reset: {
    type: 'boolean',
    default: false,
    describe: 'Reset your alias configuration.',
  },
  legacy: {
    type: 'boolean',
    default: false,
    describe:
      'Append the legacy two-letter noun-verb aliases (bc, bco, ss, ...) to your configuration.',
  },
} as const;

const LEGACY_ALIASES: [string, string][] = [
  ['bc', 'branch create'],
  ['bco', 'branch checkout'],
  ['bdl', 'branch delete'],
  ['btr', 'branch track'],
  ['but', 'branch untrack'],
  ['brn', 'branch rename'],
  ['bs', 'branch submit'],
  ['cc', 'commit create'],
  ['ca', 'commit amend'],
  ['ss', 'stack submit'],
  ['ds', 'downstack'],
  ['us', 'upstack'],
];

export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphiteWithoutRepo(argv, canonical, async (context) => {
    if (argv.reset) {
      context.userConfig.update((data) => (data.aliases = []));
      context.splog.info('Alias configuration reset.');
      return;
    }
    if (argv.legacy) {
      context.userConfig.update((data) => {
        const existing = new Set((data.aliases ?? []).map((a) => a.alias));
        data.aliases = [
          ...(data.aliases ?? []),
          ...LEGACY_ALIASES.filter(([alias]) => !existing.has(alias)).map(
            ([alias, command]) => ({ alias, command })
          ),
        ];
      });
      context.splog.info('Appended legacy aliases to your configuration.');
      return;
    }
    if (!context.interactive) {
      context.splog.info(
        JSON.stringify(context.userConfig.data.aliases ?? [], null, 2)
      );
      return;
    }
    editAliases(context);
  });

function editAliases(context: TContextLite): void {
  const file = tmp.fileSync({ name: 'gt_aliases.json' });
  try {
    fs.writeFileSync(
      file.name,
      [
        '// One entry per alias. The command may be any gt command line.',
        '// Example: { "alias": "sync-all", "command": "sync --all" }',
        JSON.stringify(context.userConfig.data.aliases ?? [], null, 2),
      ].join('\n')
    );
    context.userConfig.execEditor(file.name);
    const contents = fs
      .readFileSync(file.name, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const parsed: unknown = JSON.parse(contents);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          typeof entry?.alias !== 'string' ||
          typeof entry?.command !== 'string' ||
          !/^\S+$/.test(entry.alias) ||
          !entry.command.trim()
      )
    ) {
      throw new ExitFailedError(
        'Aliases must be an array of { "alias": "<word>", "command": "<gt command>" }. No changes saved.'
      );
    }
    context.userConfig.update(
      (data) =>
        (data.aliases = (parsed as { alias: string; command: string }[]).map(
          ({ alias, command: aliasCommand }) => ({
            alias,
            command: aliasCommand,
          })
        ))
    );
    context.splog.info('Saved alias configuration.');
  } finally {
    file.removeCallback();
  }
}
