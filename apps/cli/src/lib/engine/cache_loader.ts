import { createHash } from 'crypto';
import { version } from '../../../package.json';
import { getRebaseHead } from '../git/merge_conflict_help';
import { getBranchesAndMetadata } from '../git/sorted_branch_names';
import { cachePersistenceFactory } from '../spiffy/cache_spf';
import { TSplog } from '../utils/splog';
import { TCachedMeta } from './cached_meta';
import { NO_METADATA } from './metadata_ref';
import {
  MetadataRepairs,
  parseBranchesAndMeta,
  TCacheSeed,
} from './parse_branches_and_meta';
import {
  BranchValidationCache,
  historyFingerprint,
  reusableAcross,
  VALIDATION_CACHE_VERSION,
} from './validation_cache';

type TCacheLoader = {
  loadCachedBranches(
    trunkName: string | undefined,
    additionalTrunks?: string[]
  ): Record<string, Readonly<TCachedMeta>>;
  lastLoadUsedPersistedCache(): boolean;
  persistCache(
    trunkName: string | undefined,
    cachedBranches: Record<string, TCachedMeta>,
    additionalTrunks?: string[]
  ): void;
  clearPersistedCache(): void;
};
/** readOnly: the caller holds no repository lock and changes no refs. Parsing
 * then defers metadata repairs, and the cache is stamped for the refs that
 * were actually parsed rather than re-read at persist time, so a concurrent
 * writer's newer refs can never match this process's older branch data.
 */
export function composeCacheLoader(
  splog: TSplog,
  options: { readOnly?: boolean } = {}
): TCacheLoader {
  const persistedCache = cachePersistenceFactory.load();
  let usedPersistedCache = false;
  // historyFingerprint() at load; undefined disables every form of reuse.
  let historyAtLoad: string | undefined;
  let loadedSeedHash: string | undefined;
  let repairs = new MetadataRepairs(!options.readOnly);
  let validationCache = new BranchValidationCache();
  return {
    loadCachedBranches: (
      trunkName: string | undefined,
      additionalTrunks?: string[]
    ) => {
      splog.debug('Reading cache seed data...');
      const cacheSeed = getCacheSeed(trunkName, additionalTrunks);
      splog.debug('Loading cache...');
      historyAtLoad = historyFingerprint(!!cacheSeed.hasReplacementRefs);
      loadedSeedHash = historyAtLoad && hashSeed(cacheSeed, historyAtLoad);
      repairs = new MetadataRepairs(!options.readOnly);
      validationCache = new BranchValidationCache(
        reusableProofs(persistedCache.data.validation, historyAtLoad, splog)
      );
      // The full cache (every branch's parsed result) needs the exact history
      // it was built under; a moved boundary re-parses using the proofs above.
      usedPersistedCache =
        !!loadedSeedHash && persistedCache.data.sha === loadedSeedHash;
      const branches =
        (usedPersistedCache &&
          Object.fromEntries(persistedCache.data.branches)) ||
        parseBranchesAndMeta(
          {
            ...cacheSeed,
            trunkName,
          },
          splog,
          {
            validationCache: historyAtLoad ? validationCache : undefined,
            repairs,
          }
        );
      return branches;
    },
    lastLoadUsedPersistedCache: () => usedPersistedCache,
    persistCache: (
      trunkName: string | undefined,
      cachedBranches: Record<string, TCachedMeta>,
      additionalTrunks?: string[]
    ) => {
      if (options.readOnly && repairs.pending) {
        // The refs still need repairs only a locked command may write; a cache
        // must describe the refs as they are.
        splog.debug('Not persisting cache: metadata repairs are pending.');
        return;
      }
      splog.debug(`Persisting cache...`);
      // The full-cache stamp requires the exact history seen at load: never
      // bless results made under grafts/replacements, or under a shallow
      // boundary that moved mid-command, as an exact snapshot.
      let sha = '0'.repeat(40);
      let historyNow: string | undefined;
      if (options.readOnly) {
        // Refs were not changed by this process: stamp the parsed snapshot.
        // Replacement refs present at load already disabled reuse.
        historyNow = historyFingerprint(false);
        if (historyAtLoad && loadedSeedHash && historyNow === historyAtLoad)
          sha = loadedSeedHash;
      } else {
        const seed = getCacheSeed(trunkName, additionalTrunks);
        historyNow = historyFingerprint(!!seed.hasReplacementRefs);
        // Commands in other worktrees run concurrently and may have moved
        // refs this command never saw. Stamp the cache only when it
        // provably describes every ref as it is right now.
        const refsDescribed = describesRefs(seed, cachedBranches);
        if (historyAtLoad && historyNow === historyAtLoad) {
          if (refsDescribed) sha = hashSeed(seed, historyAtLoad);
          else
            splog.debug(
              'Not marking cache reusable: refs changed during this command.'
            );
        }
      }
      // Per-branch proofs survive a shallow-boundary move (see
      // reusableAcross), so keep them unless the history became one we never
      // reuse. Refs moved by another worktree mid-command do not matter: each
      // proof is keyed on the exact commit IDs and parent name it validated,
      // so a moved or re-parented branch simply misses its proof and is
      // re-validated. Dropping all proofs here made the next command in every
      // worktree re-walk every tracked branch.
      const keepProofs =
        !!historyAtLoad &&
        !!historyNow &&
        reusableAcross(historyAtLoad, historyNow);
      persistedCache.update((data) => {
        data.sha = sha;
        data.branches = Object.entries(cachedBranches);
        data.validation = {
          version: VALIDATION_CACHE_VERSION,
          history: keepProofs ? historyNow : '',
          proofs: keepProofs
            ? validationCache.snapshot(new Set(Object.keys(cachedBranches)))
            : [],
        };
      });
    },
    clearPersistedCache: () => {
      splog.debug(`Clearing persisted cache...`);
      persistedCache.delete();
    },
  };
}

/** Proofs from the persisted file that may answer under `history`. */
function reusableProofs(
  validation: TPersistedValidation | undefined,
  history: string | undefined,
  splog: TSplog
): TPersistedValidation['proofs'] | undefined {
  if (!history || !validation) return undefined;
  // Files written before fingerprints existed only held proofs made under
  // ordinary (non-shallow) history.
  const from = validation.history ?? 'full';
  if (from !== history)
    splog.debug(
      `History changed (${from} -> ${history}); reusing ancestry proofs ` +
        'only across shallow-boundary moves.'
    );
  return reusableAcross(from, history) ? validation.proofs : undefined;
}

type TPersistedValidation = NonNullable<
  ReturnType<typeof cachePersistenceFactory.load>['data']['validation']
>;

/** Every branch head and metadata blob in the seed matches the entry that
 * claims to describe it, and nothing is missing or extra. */
function describesRefs(
  seed: TCacheSeed,
  branches: Record<string, TCachedMeta>
): boolean {
  const names = Object.keys(seed.gitBranchNamesAndRevisions);
  if (names.length !== Object.keys(branches).length) return false;
  for (const name of names) {
    const entry = branches[name];
    if (
      !entry ||
      entry.branchRevision !== seed.gitBranchNamesAndRevisions[name] ||
      entry.metadataOid !== (seed.metadataRefList[name] ?? NO_METADATA)
    )
      return false;
  }
  // Metadata without a branch is deleted by a parse; a cache must not hide it.
  return Object.keys(seed.metadataRefList).every((name) => name in branches);
}

function getCacheSeed(
  trunkName: string | undefined,
  additionalTrunks?: string[]
): TCacheSeed {
  return {
    version,
    trunkName,
    additionalTrunks,
    rebaseHead: getRebaseHead(),
    ...getBranchesAndMetadata({ includeReplacementRefs: true }),
  };
}

function hashSeed(data: TCacheSeed, history: string): string {
  const hash = createHash('sha1').update(
    `gt-branch-validation-v${VALIDATION_CACHE_VERSION}\0`
  );
  // Full-history stamps are unchanged from before fingerprints existed, so
  // upgrading keeps existing caches warm.
  if (history !== 'full') hash.update(`${history}\0`);
  return hash.update(JSON.stringify(data)).digest('hex').toString();
}
