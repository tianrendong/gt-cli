import * as t from '../retype';
import { execSync } from 'child_process';
import { getGitEditor, getGitPager } from '../git/git_editor';
import { CommandFailedError } from '../git/runner';
import { spiffy } from './spiffy';

const schema = t.shape({
  branchPrefix: t.optional(t.string),
  branchDate: t.optional(t.boolean),
  branchReplacement: t.optional(
    t.unionMany([t.literal('_'), t.literal('-'), t.literal('')])
  ),
  tips: t.optional(t.boolean),
  editor: t.optional(t.string),
  pager: t.optional(t.string),
  restackCommitterDateIsAuthorDate: t.optional(t.boolean),
  submitIncludeCommitMessages: t.optional(t.boolean),
  cleanupDeleteMerged: t.optional(t.boolean),
  aliases: t.optional(
    t.array(
      t.shape({
        alias: t.string,
        command: t.string,
      })
    )
  ),
  connectCliToLocalServer: t.optional(t.boolean),
  gtiConfigs: t.optional(
    t.array(
      t.shape({
        key: t.string,
        value: t.string,
      })
    )
  ),
  alternativeProfiles: t.optional(
    t.array(
      t.shape({
        name: t.string,
        hostPrefix: t.string,
      })
    )
  ),
});

export type TProfile = Required<
  t.TypeOf<typeof schema>
>['alternativeProfiles'][number];

export type TApiServerUrl = string;
export type TAppServerUrl = string;
export const DEFAULT_GITHUB_API_SERVER: TApiServerUrl =
  'https://api.github.com';
export const DEFAULT_GITHUB_APP_SERVER: TAppServerUrl = 'https://github.com';

export const userConfigFactory = spiffy({
  schema,
  defaultLocations: [
    {
      relativePath: '.graphite_user_config',
      relativeTo: 'USER_HOME',
    },
  ],
  initialize: () => {
    return {};
  },
  helperFunctions: (data) => {
    // Accept legacy profile fields when migrating, but never connect to a
    // Graphite service or weaken TLS based on old configuration.
    const getApiServerUrl = (): TApiServerUrl =>
      process.env.GH_HOST && process.env.GH_HOST !== 'github.com'
        ? `https://${process.env.GH_HOST}/api/v3`
        : DEFAULT_GITHUB_API_SERVER;
    const getAppServerUrl = (): TAppServerUrl =>
      process.env.GH_HOST
        ? `https://${process.env.GH_HOST}`
        : DEFAULT_GITHUB_APP_SERVER;

    const getEditor = () => {
      return (
        process.env.GT_EDITOR ?? // single command override
        data.editor ??
        process.env.TEST_GT_EDITOR ?? // for tests
        // If we don't have an editor set, do what git would do
        getGitEditor() ??
        process.env.GIT_EDITOR ??
        process.env.EDITOR ??
        'vi'
      );
    };

    const getPager = () => {
      // If we don't have a pager set, do what git would do
      const pager =
        process.env.GT_PAGER ?? // single command override
        data.pager ??
        process.env.TEST_GT_PAGER ?? // for tests
        // If we don't have a pager set, do what git would do
        getGitPager() ??
        process.env.GIT_PAGER ??
        process.env.PAGER ??
        'less';
      return pager === '' ? undefined : pager;
    };

    return {
      getEditor,
      getApiServerUrl,
      getAppServerUrl,
      getPager,
      execEditor: (editFilePath: string) => {
        const command = `${getEditor()} '${editFilePath.replace(
          /'/g,
          "'\\''"
        )}'`;
        try {
          execSync(command, { stdio: 'inherit', encoding: 'utf-8' });
        } catch (e) {
          throw new CommandFailedError({ command, args: [editFilePath], ...e });
        }
      },
    };
  },
});

export type TUserConfig = ReturnType<typeof userConfigFactory.load>;
