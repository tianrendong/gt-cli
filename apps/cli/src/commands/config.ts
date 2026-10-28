import yargs from 'yargs';
import { graphite } from '../lib/runner';
import { TContext } from '../lib/context';
import {
  graphiteSubmitSetting,
  readGraphiteSubmit,
  writeGraphiteSubmit,
} from '../lib/graphite_cloud/settings';

export const command = 'config';
export const canonical = 'config';
export const description = 'Configure the Graphite CLI.';
export const builder = {} as const;

type TSetting = {
  title: (context: TContext) => string;
  run: (context: TContext) => Promise<void>;
};

const text = (
  name: string,
  get: (context: TContext) => string,
  set: (context: TContext, value: string) => void
): TSetting => ({
  title: (context) => `${name} (${get(context) || 'unset'})`,
  run: async (context) => {
    const response = await context.prompts({
      type: 'text',
      name: 'value',
      message: name,
      initial: get(context),
    });
    set(context, response.value);
  },
});

const toggle = (
  name: string,
  get: (context: TContext) => boolean,
  set: (context: TContext, value: boolean) => void
): TSetting => ({
  title: (context) => `${name} (${get(context) ? 'on' : 'off'})`,
  run: async (context) => {
    const response = await context.prompts({
      type: 'confirm',
      name: 'value',
      message: `Enable ${name}?`,
      initial: get(context),
    });
    set(context, response.value);
  },
});

const SETTINGS: TSetting[] = [
  toggle(
    'Mirror submitted PRs to Graphite (global default)',
    () => readGraphiteSubmit('global') ?? false,
    (_c, v) => writeGraphiteSubmit(v, 'global')
  ),
  {
    title: () =>
      `Graphite submission for this repository (${
        readGraphiteSubmit('local') ?? 'inherit global'
      })`,
    run: async (context) => {
      const response = await context.prompts({
        type: 'select',
        name: 'value',
        message: 'Graphite submission for this repository',
        choices: [
          { title: 'Inherit global default', value: 'inherit' },
          { title: 'Enabled', value: 'true' },
          { title: 'Disabled', value: 'false' },
        ],
      });
      if (response.value !== undefined)
        writeGraphiteSubmit(
          response.value === 'inherit' ? undefined : response.value === 'true',
          'local'
        );
    },
  },
  text(
    'Branch prefix',
    (c) => c.userConfig.data.branchPrefix ?? '',
    (c, v) => c.userConfig.update((d) => (d.branchPrefix = v))
  ),
  toggle(
    'Include date in generated branch names',
    (c) => c.userConfig.data.branchDate ?? true,
    (c, v) => c.userConfig.update((d) => (d.branchDate = v))
  ),
  text(
    'Branch name replacement character (_ - or empty)',
    (c) => c.userConfig.data.branchReplacement ?? '_',
    (c, v) =>
      c.userConfig.update((d) => (d.branchReplacement = v as '' | '_' | '-'))
  ),
  text(
    'Editor',
    (c) => c.userConfig.data.editor ?? '',
    (c, v) => c.userConfig.update((d) => (d.editor = v || undefined))
  ),
  text(
    'Pager',
    (c) => c.userConfig.data.pager ?? '',
    (c, v) => c.userConfig.update((d) => (d.pager = v || undefined))
  ),
  toggle(
    'Show tips',
    (c) => c.userConfig.data.tips ?? true,
    (c, v) => c.userConfig.update((d) => (d.tips = v))
  ),
  toggle(
    'Include commit messages in PR descriptions (submit setting)',
    (c) => c.userConfig.data.submitIncludeCommitMessages ?? false,
    (c, v) => c.userConfig.update((d) => (d.submitIncludeCommitMessages = v))
  ),
  toggle(
    'Delete merged/closed branches without prompting (sync/get cleanup)',
    (c) => c.userConfig.data.cleanupDeleteMerged ?? false,
    (c, v) => c.userConfig.update((d) => (d.cleanupDeleteMerged = v))
  ),
  toggle(
    'Use committer date as author date when restacking',
    (c) => c.userConfig.data.restackCommitterDateIsAuthorDate ?? false,
    (c, v) =>
      c.userConfig.update((d) => (d.restackCommitterDateIsAuthorDate = v))
  ),
  toggle(
    'GitHub integration for this repository',
    (c) => c.repoConfig.getIsGithubIntegrationEnabled(),
    (c, v) => c.repoConfig.update((d) => (d.isGithubIntegrationEnabled = v))
  ),
];

export const handler = async (
  argv: yargs.Arguments<yargs.InferredOptionTypes<typeof builder>>
): Promise<void> =>
  graphite(argv, canonical, async (context) => {
    if (!context.interactive) {
      context.splog.info(
        JSON.stringify(
          {
            user: context.userConfig.data,
            submit: { graphite: graphiteSubmitSetting() },
            repo: {
              remote: context.repoConfig.getRemote(),
              trunk: context.engine.trunk,
              trunks: context.engine.trunks,
              isGithubIntegrationEnabled:
                context.repoConfig.getIsGithubIntegrationEnabled(),
            },
          },
          null,
          2
        )
      );
      return;
    }
    for (;;) {
      const choice = await context.prompts({
        type: 'select',
        name: 'value',
        message: 'Configure the Graphite CLI',
        choices: [
          ...SETTINGS.map((setting, index) => ({
            title: setting.title(context),
            value: index,
          })),
          { title: 'Done', value: -1 },
        ],
      });
      if (choice.value === -1 || choice.value === undefined) return;
      await SETTINGS[choice.value].run(context);
    }
  });
