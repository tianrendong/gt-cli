import * as t from '../retype';
import { ExitFailedError } from '../errors';
import { runGitCommand } from '../git/runner';
import { spiffy } from './spiffy';

const schema = t.shape({
  host: t.optional(t.string),
  owner: t.optional(t.string),
  name: t.optional(t.string),
  trunk: t.optional(t.string),
  additionalTrunks: t.optional(t.array(t.string)),
  remote: t.optional(t.string),
  lastFetchedPRInfoMs: t.optional(t.number),
  isGithubIntegrationEnabled: t.optional(t.boolean),
});

export const repoConfigFactory = spiffy({
  schema,
  defaultLocations: [
    {
      relativePath: '.graphite_repo_config',
      relativeTo: 'REPO',
    },
  ],
  initialize: () => {
    return {};
  },
  helperFunctions: (data, update) => {
    return {
      setRemote: (remote: string) => {
        update((data) => (data.remote = remote));
      },

      getRemote: () => data.remote ?? 'origin',

      // Resolve the three fields together, without caching across commands,
      // hooks, config edits, or repository changes in the same process.
      getRepoIdentity(): { host: string; owner: string; name: string } {
        const inferred =
          data.host && data.owner && data.name
            ? undefined
            : inferRepoGitHubInfo(data.remote ?? 'origin');
        const identity = {
          host: data.host || inferred!.repoHost,
          owner: data.owner || inferred!.repoOwner,
          name: data.name || inferred!.repoName,
        };
        // Malformed remotes can parse to an empty host/name. Preserve the
        // existing getters' validation and error ordering on that rare path.
        if (!identity.host || !identity.owner || !identity.name) {
          return {
            host: this.getRepoHost(),
            owner: this.getRepoOwner(),
            name: this.getRepoName(),
          };
        }
        return identity;
      },

      setTrunk: (trunk: string) => {
        update((data) => (data.trunk = trunk));
      },

      setIsGithubIntegrationEnabled: (isEnabled: boolean) => {
        update((data) => (data.isGithubIntegrationEnabled = isEnabled));
      },

      getIsGithubIntegrationEnabled: (): boolean =>
        data.isGithubIntegrationEnabled ?? true,

      graphiteInitialized: (): boolean => !!data.trunk,

      getRepoHost: (): string => {
        const configHost = data.host;
        if (configHost) {
          return configHost;
        }

        const inferredInfo = inferRepoGitHubInfo(data.remote ?? 'origin');
        if (inferredInfo?.repoHost) {
          return inferredInfo.repoHost;
        }

        throw new ExitFailedError(
          "Could not determine the host of this repo (e.g. 'github.com' in the repo 'https://github.com/tianrendong/gt-gh'). Please run `gt repo owner --set <owner>` to manually set the repo owner."
        );
      },

      getRepoOwner: (): string => {
        const configOwner = data.owner;
        if (configOwner) {
          return configOwner;
        }

        const inferredInfo = inferRepoGitHubInfo(data.remote ?? 'origin');
        if (inferredInfo?.repoOwner) {
          return inferredInfo.repoOwner;
        }

        throw new ExitFailedError(
          "Could not determine the owner of this repo (e.g. 'tianrendong' in the repo 'tianrendong/gt-gh'). Please run `gt repo owner --set <owner>` to manually set the repo owner."
        );
      },

      getRepoName: (): string => {
        if (data.name) {
          return data.name;
        }

        const inferredInfo = inferRepoGitHubInfo(data.remote ?? 'origin');
        if (inferredInfo?.repoName) {
          return inferredInfo.repoName;
        }

        throw new ExitFailedError(
          "Could not determine the name of this repo (e.g. 'gt-gh' in the repo 'tianrendong/gt-gh'). Please run `gt repo name --set <owner>` to manually set the repo name."
        );
      },
    } as const;
  },
});

function inferRepoGitHubInfo(remote: string): {
  repoOwner: string;
  repoName: string;
  repoHost: string;
} {
  // This assumes the remote to fetch from is the same as the remote to push to.
  // If a user runs into this is not true, they can manually edit the repo config
  // file to overrule what our CLI tries to intelligently infer.
  const url = runGitCommand({
    args: [`config`, `--get`, `remote.${remote}.url`],
    onError: 'ignore',
    resource: 'inferRepoGitHubInfo',
  });

  const inferError = new ExitFailedError(
    `Failed to infer the owner and name of this repo from remote ${remote}. Please run \`gt repo owner --set <owner>\` and \`gt repo name --set <name>\` to manually set the repo owner/name. (e.g. in the repo 'tianrendong/gt-gh', 'tianrendong' is the repo owner and 'gt-gh' is the repo name)`
  );
  if (!url) {
    throw inferError;
  }

  const match = getOwnerAndNameFromURL(url);
  if (match === null) {
    throw inferError;
  }

  return {
    repoOwner: match.owner,
    repoName: match.name,
    repoHost: match.hostname,
  };
}

/**
 * FROM ISL: https://github.com/facebook/sapling/blob/main/addons/isl-server/src/Repository.ts#L887-L914
 *
 * extract repo info from a remote url, typically for GitHub or GitHub Enterprise,
 * in various formats:
 * https://github.com/owner/repo
 * https://github.com/owner/repo.git
 * github.com:owner/repo.git
 * git@github.com:owner/repo.git
 * ssh:git@github.com:owner/repo.git
 * ssh://git@github.com/owner/repo.git
 * git+ssh:git@github.com:owner/repo.git
 *
 * or similar urls with GitHub Enterprise hostnames:
 * https://ghe.myCompany.com/owner/repo
 */
export function getOwnerAndNameFromURL(
  url: string
): { name: string; owner: string; hostname: string } | null {
  if (/^(?:https?|(?:git\+)?ssh):\/\//.test(url)) {
    try {
      const parsed = new URL(url.replace(/^git\+ssh:/, 'ssh:'));
      const parts = parsed.pathname
        .replace(/^\//, '')
        .replace(/\/$/, '')
        .split('/');
      if (parts.length !== 2 || parts.some((part) => !part)) return null;
      // URL.host excludes credentials; never copy a token-bearing authority
      // into a gh --repo argument or the gh-stack metadata file.
      return {
        hostname: parsed.host,
        owner: parts[0],
        name: parts[1].replace(/\.git$/, ''),
      };
    } catch {
      return null;
    }
  }
  const match =
    /^(?:(?:git\+)?ssh:)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
      url
    );
  return match ? { hostname: match[1], owner: match[2], name: match[3] } : null;
}

export type TRepoConfig = ReturnType<typeof repoConfigFactory.load>;
