import { PreconditionsFailedError } from '../errors';
import { getMergeBase } from '../git/merge_base';
import { TSplog } from '../utils/splog';
import { TCachedMeta } from './cached_meta';
import { BranchValidationCache, resolveCommitRefs } from './validation_cache';
import {
  deleteMetadataRef,
  NO_METADATA,
  readMetadataRefs,
  TMeta,
  writeMetadataRef,
} from './metadata_ref';

type TBranchToParse = {
  branchName: string;
  branchRevision: string;
  /** Blob the metadata fields were read from; repairs swap exactly it. */
  metadataOid?: string;
} & TMeta;

/** Metadata fixes discovered while parsing: orphaned refs and parent revisions
 * that can be advanced. Commands holding the repository lock apply them at
 * once. Lock-free read-only commands only note that fixes are pending: their
 * in-memory result already reflects the fix, and the next locked command
 * writes it without racing another writer's metadata updates.
 */
export class MetadataRepairs {
  pending = false;
  /** Blob oids written by applied repairs, so parsed entries stay exact. */
  readonly written = new Map<string, string>();
  constructor(readonly apply: boolean = true) {}

  delete(branchName: string, expectedOid?: string): void {
    if (this.apply) deleteMetadataRef(branchName, expectedOid);
    else this.pending = true;
  }

  /** Repairs are compare-and-swap: a concurrent command's newer metadata wins
   * and this parse simply reflects the pre-repair value it read. */
  write(branchName: string, meta: TMeta, expectedOid?: string): void {
    if (!this.apply) {
      this.pending = true;
      return;
    }
    const oid = writeMetadataRef(branchName, meta, undefined, expectedOid);
    if (oid) this.written.set(branchName, oid);
    else this.pending = true;
  }
}

function getAllBranchesAndMeta(
  args: Omit<TCacheSeed, 'version' | 'trunkName'>,
  splog: TSplog,
  repairs: MetadataRepairs
): TBranchToParse[] {
  splog.debug(`Building cache from disk...`);
  const branchesWithMeta = new Set(
    Object.keys(args.metadataRefList).filter((branchName) => {
      if (args.gitBranchNamesAndRevisions[branchName]) {
        return true;
      }
      // Clean up refs whose branch is missing
      splog.debug(`Deleting metadata for missing branch: ${branchName}`);
      repairs.delete(branchName, args.metadataRefList[branchName]);
      return false;
    })
  );

  const branchNames = Object.keys(args.gitBranchNamesAndRevisions);
  const metadata = readMetadataRefs(
    branchNames.filter((name) => branchesWithMeta.has(name)),
    args.metadataRefList
  );
  return branchNames.map((branchName) => ({
    branchName,
    branchRevision: args.gitBranchNamesAndRevisions[branchName],
    metadataOid: args.metadataRefList[branchName] ?? NO_METADATA,
    ...metadata.get(branchName),
  }));
}

export type TCacheSeed = {
  version: string;
  trunkName: string | undefined;
  additionalTrunks?: string[];
  rebaseHead: string | undefined;
  gitBranchNamesAndRevisions: Record<string, string>;
  metadataRefList: Record<string, string>;
  hasReplacementRefs?: boolean;
};

function resolveValidationRefs(
  branches: TBranchToParse[],
  cache?: BranchValidationCache
): Map<string, string> {
  return cache
    ? resolveCommitRefs(
        branches
          .filter((b) => b.parentBranchName && b.parentBranchRevision)
          .map((b) => b.branchName)
      )
    : new Map<string, string>();
}

type TParseOptions = {
  validationCache?: BranchValidationCache;
  repairs?: MetadataRepairs;
};

// eslint-disable-next-line max-lines-per-function
export function parseBranchesAndMeta(
  args: TCacheSeed,
  splog: TSplog,
  { validationCache, repairs = new MetadataRepairs() }: TParseOptions = {}
): Record<string, TCachedMeta> {
  const branchesToParse = getAllBranchesAndMeta(args, splog, repairs);
  const resolved = resolveValidationRefs(branchesToParse, validationCache);
  const allBranchNames = new Set(
    branchesToParse.map((meta) => meta.branchName)
  );
  const parsedBranches: Record<string, TCachedMeta> = {};
  splog.debug('Validating branches...');
  // If we have n branches, it takes at most n(n+1)/2 iterations
  // to parse all of them (worst case is reverse sorted order)
  let cycleDetector =
    (branchesToParse.length * (branchesToParse.length + 1)) / 2;
  while (branchesToParse.length > 0) {
    if (cycleDetector-- <= 0) {
      throw new PreconditionsFailedError('Cycle detected in Graphite metadata');
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const current = branchesToParse.shift()!;
    const {
      branchName,
      branchRevision,
      metadataOid,
      parentBranchName,
      parentBranchRevision,
      prInfo,
      lastSubmittedVersion,
    } = current;

    if (
      branchName === args.trunkName ||
      args.additionalTrunks?.includes(branchName)
    ) {
      splog.debug(`trunk: ${branchName}`);
      parsedBranches[branchName] = {
        validationResult: 'TRUNK',
        branchRevision: branchRevision,
        metadataOid,
        children: [],
      };
      continue;
    }

    // Check parentBranchName
    if (
      !parentBranchName ||
      parentBranchName === branchName ||
      !allBranchNames.has(parentBranchName)
    ) {
      splog.debug(
        `bad parent name: ${branchName}\n\t${parentBranchName ?? 'missing'}`
      );
      parsedBranches[branchName] = {
        validationResult: 'BAD_PARENT_NAME',
        branchRevision,
        metadataOid,
        ...(prInfo ? { prInfo } : {}),
        ...(lastSubmittedVersion ? { lastSubmittedVersion } : {}),
        children: [],
      };
      continue;
    }

    // If parent hasn't been checked yet, we'll come back to this branch
    if (typeof parsedBranches[parentBranchName] === 'undefined') {
      branchesToParse.push(current);
      continue;
    }

    parsedBranches[parentBranchName].children.push(branchName);

    // Check if the parent is valid (or trunk)
    if (
      !['VALID', 'TRUNK'].includes(
        parsedBranches[parentBranchName].validationResult
      )
    ) {
      splog.debug(`invalid parent: ${branchName}`);
      parsedBranches[branchName] = {
        validationResult: 'INVALID_PARENT',
        parentBranchName,
        parentBranchRevision,
        branchRevision,
        metadataOid,
        ...(prInfo ? { prInfo } : {}),
        ...(lastSubmittedVersion ? { lastSubmittedVersion } : {}),
        children: [],
      };
      continue;
    }

    // If we make it here, we just need to validate the parent branch revision!
    const result = validateWithCache(
      {
        ...current,
        parentBranchCurrentRevision:
          parsedBranches[parentBranchName].branchRevision,
      } as TBranchToParseWithValidatedParent,
      splog,
      { cache: validationCache, revision: resolved.get(branchName), repairs }
    );

    parsedBranches[branchName] = {
      ...{
        parentBranchName,
        branchRevision,
        metadataOid: repairs.written.get(branchName) ?? metadataOid,
        ...(prInfo ? { prInfo } : {}),
        ...(lastSubmittedVersion ? { lastSubmittedVersion } : {}),
        children: [],
      },
      ...result,
    };
  }

  return parsedBranches;
}

type TBranchToParseWithValidatedParent = TBranchToParse & {
  parentBranchName: string;
  parentBranchCurrentRevision: string;
  validationRevision?: string;
};

function validateWithCache(
  current: TBranchToParseWithValidatedParent,
  splog: TSplog,
  options: {
    cache?: BranchValidationCache;
    revision?: string;
    repairs: MetadataRepairs;
  }
): ReturnType<typeof validateOrFixParentBranchRevision> {
  // If a short name resolves to a tag/different ref, keep legacy resolution.
  // Proofs must describe the actual commit IDs validated, not names that can
  // move between our snapshot and a later merge-base process.
  const cache =
    options.revision === current.branchRevision ? options.cache : undefined;
  if (current.parentBranchRevision && cache?.has(current)) {
    splog.debug(`validated: ${current.branchName}`);
    return {
      validationResult: 'VALID',
      parentBranchRevision: current.parentBranchRevision,
    };
  }
  const result = validateOrFixParentBranchRevision(
    {
      ...current,
      validationRevision: cache ? current.branchRevision : undefined,
    },
    splog,
    options.repairs
  );
  // Auto-repair writes metadata. Never replay a cached result in place of that
  // write, and never reuse negative/invalid-parent results.
  if (
    result.validationResult === 'VALID' &&
    result.parentBranchRevision === current.parentBranchRevision
  )
    cache?.remember(current);
  return result;
}

export function validateOrFixParentBranchRevision(
  {
    branchName,
    parentBranchName,
    parentBranchRevision,
    prInfo,
    lastSubmittedVersion,
    metadataOid,
    parentBranchCurrentRevision,
    validationRevision,
  }: TBranchToParseWithValidatedParent,
  splog: TSplog,
  repairs: MetadataRepairs = new MetadataRepairs()
):
  | { validationResult: 'VALID'; parentBranchRevision: string }
  | { validationResult: 'BAD_PARENT_REVISION' } {
  // This branch is valid because its PBR is in its history
  if (
    parentBranchRevision &&
    getMergeBase(validationRevision ?? branchName, parentBranchRevision) ===
      parentBranchRevision
  ) {
    if (
      parentBranchRevision !== parentBranchCurrentRevision &&
      getMergeBase(
        validationRevision ?? branchName,
        parentBranchCurrentRevision
      ) === parentBranchCurrentRevision &&
      getMergeBase(parentBranchRevision, parentBranchCurrentRevision) ===
        parentBranchRevision
    ) {
      // If the parent is ahead of where the metadata has it, we update
      // it to the current value, as long as it is still in our history
      repairs.write(
        branchName,
        {
          parentBranchName,
          parentBranchRevision: parentBranchCurrentRevision,
          prInfo,
          lastSubmittedVersion,
        },
        metadataOid
      );
      splog.debug(
        `validated and updated parent rev: ${branchName}\n\t${parentBranchCurrentRevision}`
      );
      return {
        validationResult: 'VALID',
        parentBranchRevision: parentBranchCurrentRevision,
      };
    }
    splog.debug(`validated: ${branchName}`);
    return { validationResult: 'VALID', parentBranchRevision };
  }

  // PBR cannot be fixed because its parent is not in its history
  if (
    getMergeBase(
      validationRevision ?? branchName,
      parentBranchCurrentRevision
    ) !== parentBranchCurrentRevision
  ) {
    splog.debug(
      `bad parent rev: ${branchName}\n\t${parentBranchRevision ?? 'missing'}`
    );
    return { validationResult: 'BAD_PARENT_REVISION' };
  }

  // PBR can be fixed because we see the parent in the branch's history
  repairs.write(
    branchName,
    {
      parentBranchName,
      parentBranchRevision: parentBranchCurrentRevision,
      prInfo,
      lastSubmittedVersion,
    },
    metadataOid
  );
  splog.debug(
    `validated and fixed parent rev: ${branchName}\n\t${parentBranchCurrentRevision}`
  );
  return {
    validationResult: 'VALID',
    parentBranchRevision: parentBranchCurrentRevision,
  };
}
