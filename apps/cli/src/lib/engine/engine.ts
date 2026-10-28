import chalk from 'chalk';
import { isDeepStrictEqual } from 'util';
import {
  DetachedError,
  ExitFailedError,
  NoBranchError,
  PreconditionsFailedError,
} from '../errors';
import { TCommitOpts } from '../git/commit';
import { TCommitFormat } from '../git/commit_range';
import { TGit } from '../git/git';
import { cuteString } from '../utils/cute_string';
import { TSplog } from '../utils/splog';
import {
  assertCachedMetaIsNotTrunk,
  assertCachedMetaIsValidAndNotTrunk,
  assertCachedMetaIsValidOrTrunk,
  TCachedMeta,
  TValidCachedMetaExceptTrunk,
} from './cached_meta';
import { composeCacheLoader } from './cache_loader';
import { TChangedFile, TStatusFile } from '../git/changed_files';
import {
  deleteMetadataRef,
  getMetadataOid,
  getMetadataRefList,
  NO_METADATA,
  readMetadataRef,
  TBranchPRInfo,
  TMeta,
  TSubmittedVersion,
  makeSubmittedVersion,
  writeMetadataRef,
} from './metadata_ref';
import { validateOrFixParentBranchRevision } from './parse_branches_and_meta';
import { TScopeSpec } from './scope_spec';
import { stableHash } from '../utils/stable_hash';
import { frozenConfigFactory } from '../spiffy/frozen_spf';

export type TEngine = {
  debug: string;
  persist: () => void;
  clear: () => void;
  noVerify: boolean;
  assertBranchMutable: (branchName: string) => void;
  isBranchFrozen: (branchName: string) => boolean;
  freezeBranch: (branchName: string, frozen: boolean) => void;

  reset: (newTrunkName?: string) => void;
  rebuild: (newTrunkName?: string, newAdditionalTrunks?: string[]) => void;
  trunk: string;
  trunks: string[];
  getTrunk: (branchName: string) => string;
  isTrunk: (branchName: string) => boolean;

  branchExists(branchName: string | undefined): branchName is string;
  allBranchNames: string[];
  isBranchTracked: (branchName: string) => boolean;
  isDescendantOf: (branchName: string, parentBranchName: string) => boolean;
  /** Branches whose tips are in `branchName`'s history, excluding itself:
   * every `p` with isDescendantOf(branchName, p), from one git call. */
  getAncestorBranchNames: (branchName: string) => Set<string>;
  /** Branches with `branchName`'s tip in their history, excluding itself:
   * every `c` with isDescendantOf(c, branchName), from one git call. */
  getDescendantBranchNames: (branchName: string) => Set<string>;
  trackBranch: (branchName: string, parentBranchName: string) => void;
  untrackBranch: (branchName: string) => void;

  currentBranch: string | undefined;
  currentBranchPrecondition: string;

  rebaseInProgress: () => boolean;
  detectStagedChanges: () => boolean;
  findRemoteBranch: () => string | undefined;
  getUnmergedFiles: () => string[];
  getRebaseHead: () => string | undefined;
  getUnstagedChanges: () => string;
  getStatus: () => TStatusFile[];
  logLong: () => void;

  showCommits: (branchName: string, patch: boolean, stat?: boolean) => string;
  showDiff: (branchName: string, stat?: boolean) => string;
  getDiff: (left: string, right: string | undefined) => string;
  getStackDiff: (branchName: string) => string;
  getParentOrPrev: (branchName: string) => string;
  getChangedFiles: (branchName: string) => TChangedFile[];
  getFileContents: (ref: string, file: string) => string;
  restoreFile: (file: string) => void;

  getRevision: (branchName: string) => string;
  getBaseRevision: (branchName: string) => string;
  getAllCommits: (branchName: string, format: TCommitFormat) => string[];

  getCommitDate: (branchName: string) => Promise<Date>;
  getCommitAuthor: (branchName: string) => Promise<string>;

  getPrInfo: (branchName: string) => TBranchPRInfo | undefined;
  getPublishedRevision: (branchName: string) => string | undefined;
  getLastSubmittedVersion: (
    branchName: string
  ) => TSubmittedVersion | undefined;
  upsertPrInfo: (branchName: string, prInfo: Partial<TBranchPRInfo>) => void;
  recordPublishedVersion: (
    branchName: string,
    version: Omit<Required<TSubmittedVersion>, 'versionNumber'>
  ) => void;
  clearPrInfo: (branchName: string) => void;

  getChildren: (branchName: string) => string[];
  getBranchWorktrees: () => Map<string, string>;

  setParent: (branchName: string, parentBranchName: string) => void;
  getParent: (branchName: string) => string | undefined;
  getParentPrecondition: (branchName: string) => string;

  getRelativeStack: (branchName: string, scope: TScopeSpec) => string[];

  checkoutNewBranch: (branchName: string) => void;
  checkoutBranch: (branchName: string) => void;
  renameCurrentBranch: (branchName: string) => void;
  foldCurrentBranch: (keep: boolean) => void;
  deleteBranch: (branchName: string) => void;
  commit: (opts: TCommitOpts & { summaryOnly?: boolean }) => void;
  squashCurrentBranch: (opts: { message?: string; noEdit?: boolean }) => void;

  addAll: () => void;
  addUpdates: () => void;
  detach: () => void;
  unbranch: () => void;
  detachAndResetBranchChanges: () => void;
  applySplitToCommits: (args: {
    branchToSplit: string;
    branchNames: string[];
    branchPoints: number[];
  }) => void;
  forceCheckoutBranch: (branchToSplit: string) => void;

  restackBranch: (
    branchName: string,
    opts?: {
      deferCheckout?: boolean;
      /** Report a conflict detected without touching the working tree
       * instead of starting a git rebase that would stop on it. */
      deferConflicts?: boolean;
    }
  ) =>
    | {
        result: 'REBASE_CONFLICT';
        rebasedBranchBase: string;
      }
    | { result: 'REBASE_DONE' | 'REBASE_UNNEEDED' | 'REBASE_FROZEN' }
    /** Would conflict; nothing was rewritten and no rebase is in progress.
     * directory names the worktree whose checkout must resolve it, if any. */
    | { result: 'REBASE_CONFLICT_DEFERRED'; directory?: string }
    /** Checked out in another worktree that cannot take the rewrite now. */
    | {
        result: 'REBASE_BLOCKED';
        reason: string;
        directory: string;
        /** What about that worktree blocks the rewrite, as a clause. */
        cause: string;
      };
  /** Return to the branch this command started on, if it still exists. */
  checkoutCurrentBranch: () => void;

  rebaseInteractive: (branchName: string) =>
    | {
        result: 'REBASE_CONFLICT';
        rebasedBranchBase: string;
      }
    | { result: 'REBASE_DONE' };
  continueRebase: (parentBranchRevision: string) =>
    | {
        result: 'REBASE_DONE';
        branchName: string;
      }
    | { result: 'REBASE_CONFLICT' };
  abortRebase: () => void;

  isMergedIntoTrunk: (branchName: string) => boolean;
  isBranchFixed: (branchName: string) => boolean;
  isBranchEmpty: (branchName: string) => boolean;
  populateRemoteShas: () => Promise<void>;
  branchMatchesRemote: (branchName: string) => boolean;
  getRemoteSha: (branchName: string) => string | undefined;

  pushBranch: (branchName: string, forcePush: boolean) => void;
  /** Drop remote-tracking refs the remote no longer has. Resolves when done;
   * await it before fetching so the two never contend for ref locks. */
  pruneRemote: () => Promise<void>;
  /** Remote revisions of these branches (absent when deleted remotely). */
  listRemoteHeads: (branchNames: string[]) => Promise<Map<string, string>>;
  /** One fetch for every listed branch into refs/remotes/<remote>/. Returns
   * the fetched revisions, which may be newer than a prior listing. */
  fetchRemoteBranches: (branchNames: string[]) => Promise<Map<string, string>>;
  /** Move trunk to an already-fetched remote revision. */
  pullTrunk: (remoteRevision: string) =>
    | { result: 'PULL_DONE' | 'PULL_UNNEEDED' | 'PULL_CONFLICT' }
    /** Trunk is checked out in another worktree that cannot move right now. */
    | { result: 'PULL_BLOCKED'; reason: string };
  hardReset: (sha?: string) => void;
  resetTrunkToRemote: (
    remoteRevision: string
  ) => { result: 'RESET' } | { result: 'RESET_BLOCKED'; reason: string };
  clean: () => void;

  fetchBranch: (branchName: string, parentBranchName: string) => void;
  branchMatchesFetched: (branchName: string) => boolean;
  checkoutBranchFromFetched: (
    branchName: string,
    parentBranchName: string
  ) => void;
  rebaseBranchOntoFetched: (branchName: string) =>
    | {
        result: 'REBASE_CONFLICT';
        rebasedBranchBase: string;
      }
    | { result: 'REBASE_DONE' };
};

// eslint-disable-next-line max-lines-per-function
export function composeEngine({
  git,
  trunkName,
  additionalTrunks = [],
  currentBranchOverride,
  splog,
  noVerify,
  remote,
  restackCommitterDateIsAuthorDate,
  readOnly = false,
}: {
  git: TGit;
  trunkName?: string;
  additionalTrunks?: string[];
  currentBranchOverride?: string;
  splog: TSplog;
  noVerify: boolean;
  remote: string;
  restackCommitterDateIsAuthorDate?: boolean;
  /** No repository lock is held: defer metadata repairs and stamp the cache
   * for the parsed refs. See composeCacheLoader. */
  readOnly?: boolean;
}): TEngine {
  const frozenConfig = frozenConfigFactory.load();
  const assertBranchMutable = (branchName: string) => {
    if (frozenConfig.data.branches.includes(branchName)) {
      throw new PreconditionsFailedError(
        `${branchName} is frozen. Run gt unfreeze ${branchName} before modifying it.`
      );
    }
  };
  const cacheLoader = composeCacheLoader(splog, { readOnly });
  // Hash of the branch data as loaded. A cold parse leaves this undefined so
  // that persist() always writes, letting subsequent commands skip reparsing.
  let loadedBranchesHash: string | undefined;
  const loadBranches = (): Record<string, TCachedMeta> => {
    const branches = cacheLoader.loadCachedBranches(
      trunkName,
      additionalTrunks
    );
    loadedBranchesHash = cacheLoader.lastLoadUsedPersistedCache()
      ? stableHash(branches)
      : undefined;
    return branches;
  };
  const cache = {
    currentBranch: currentBranchOverride ?? git.getCurrentBranchName(),
    branches: loadBranches(),
  };

  const allTrunks = () => [
    ...new Set(
      [trunkName, ...additionalTrunks].filter((b): b is string => !!b)
    ),
  ];
  const isTrunk = (branchName: string) => allTrunks().includes(branchName);
  const assertTrunk = (branchName = cache.currentBranch) => {
    if (!trunkName) throw new PreconditionsFailedError('No trunk found.');
    const visited = new Set<string>();
    while (branchName && !visited.has(branchName)) {
      if (isTrunk(branchName)) return branchName;
      visited.add(branchName);
      const meta: Readonly<TCachedMeta> | undefined =
        cache.branches[branchName];
      branchName =
        meta && 'parentBranchName' in meta ? meta.parentBranchName : undefined;
    }
    return trunkName;
  };

  const branchExists = (branchName: string): branchName is string =>
    branchName in cache.branches;

  const assertBranch: (branchName: string) => asserts branchName is string = (
    branchName
  ) => {
    if (!branchExists(branchName)) {
      throw new NoBranchError(branchName);
    }
  };

  const getCurrentBranchOrThrow = () => {
    if (!cache.currentBranch) {
      throw new DetachedError();
    }
    assertBranch(cache.currentBranch);
    return cache.currentBranch;
  };

  const assertBranchIsValidOrTrunkAndGetMeta = (branchName: string) => {
    assertBranch(branchName);
    const meta = cache.branches[branchName];
    assertCachedMetaIsValidOrTrunk(branchName, meta);
    return meta;
  };

  const assertBranchIsValidAndNotTrunkAndGetMeta = (branchName: string) => {
    assertBranch(branchName);
    const meta = cache.branches[branchName];
    assertCachedMetaIsValidAndNotTrunk(branchName, meta);
    return meta;
  };

  const isDescendantOf = (branchName: string, parentBranchName: string) => {
    assertBranch(branchName);
    assertBranch(parentBranchName);
    return (
      branchName !== parentBranchName &&
      git.getMergeBase(branchName, parentBranchName) ===
        cache.branches[parentBranchName].branchRevision
    );
  };

  // merge-base(b, p) === p's tip  <=>  p's tip is an ancestor of b, so a
  // single ref scan answers isDescendantOf for every branch at once instead
  // of spawning one merge-base per branch.
  const relatedBranchNames = (
    branchName: string,
    query: (revision: string) => string[]
  ) => {
    assertBranch(branchName);
    return new Set(
      query(cache.branches[branchName].branchRevision).filter(
        (name) => name !== branchName && branchExists(name)
      )
    );
  };
  const getAncestorBranchNames = (branchName: string) =>
    relatedBranchNames(branchName, git.branchesMergedInto);
  const getDescendantBranchNames = (branchName: string) =>
    relatedBranchNames(branchName, git.branchesContaining);

  const isBranchFixed = (branchName: string): boolean => {
    const cachedMeta = cache.branches[branchName];
    if (cachedMeta?.validationResult === 'TRUNK') {
      return true;
    }
    if (cachedMeta?.validationResult !== 'VALID') {
      return false;
    }
    splog.debug(`${branchName} fixed?`);
    splog.debug(`${cachedMeta.parentBranchRevision}`);
    splog.debug(
      `${cache.branches[cachedMeta.parentBranchName].branchRevision}`
    );
    return (
      cachedMeta.parentBranchRevision ===
      cache.branches[cachedMeta.parentBranchName].branchRevision
    );
  };

  const getChildren = (branchName: string) =>
    cache.branches[branchName].children.filter(
      (childBranchName) =>
        cache.branches[childBranchName]?.validationResult === 'VALID'
    );

  const getRecursiveChildren = (branchName: string): string[] =>
    getChildren(branchName).flatMap((child) => [
      child,
      ...getRecursiveChildren(child),
    ]);

  const removeChild = (parentBranchName: string, childBranchName: string) => {
    assertBranch(parentBranchName);
    const parentCachedChildren = cache.branches[parentBranchName].children;
    const index = parentCachedChildren.indexOf(childBranchName);
    if (index > -1) {
      parentCachedChildren.splice(index, 1);
    }
  };

  const validateNewParent = (branchName: string, parentBranchName: string) => {
    if (branchName === parentBranchName) {
      throw new PreconditionsFailedError(
        `Cannot set parent of ${chalk.yellow(branchName)} to itself!`
      );
    }
    if (
      branchName in cache.branches &&
      getRecursiveChildren(branchName).includes(parentBranchName)
    ) {
      throw new PreconditionsFailedError(
        `Cannot set parent of ${chalk.yellow(branchName)} to ${chalk.yellow(
          parentBranchName
        )}!`
      );
    }
  };

  const setParent = (branchName: string, parentBranchName: string) => {
    assertBranchMutable(branchName);
    validateNewParent(branchName, parentBranchName);
    const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

    const oldParentBranchName = cachedMeta.parentBranchName;
    if (oldParentBranchName === parentBranchName) {
      return;
    }

    assertBranchIsValidOrTrunkAndGetMeta(parentBranchName);
    updateMeta(branchName, { ...cachedMeta, parentBranchName });
  };

  const getParent = (branchName: string) => {
    const meta = cache.branches[branchName];
    return meta?.validationResult === 'BAD_PARENT_NAME' ||
      meta?.validationResult === 'TRUNK'
      ? undefined
      : meta?.parentBranchName;
  };

  const getRecursiveParentsExcludingTrunk = (branchName: string): string[] => {
    const parent = getParent(branchName);
    return parent && !isTrunk(parent)
      ? [...getRecursiveParentsExcludingTrunk(parent), parent]
      : [];
  };

  const checkoutBranch = (branchName: string) => {
    if (cache.currentBranch === branchName) {
      return;
    }
    assertBranch(branchName);
    git.switchBranch(branchName);
    cache.currentBranch = branchName;
  };

  /** After deleting the current branch: land on its parent, or detached at the
   * parent's commit when another worktree has that branch checked out. */
  const checkoutBranchOrDetach = (branchName: string) => {
    const elsewhere = git.branchesCheckedOutElsewhere().get(branchName);
    if (!elsewhere) {
      checkoutBranch(branchName);
      return;
    }
    assertBranch(branchName);
    git.switchBranch(cache.branches[branchName].branchRevision, {
      detach: true,
    });
    cache.currentBranch = undefined;
    splog.info(
      `${chalk.cyan(branchName)} is checked out at ${JSON.stringify(
        elsewhere
      )}; left this worktree detached at its commit. Use ${chalk.cyan(
        'gt checkout'
      )} to pick a branch.`
    );
  };

  const metaOf = (meta: {
    parentBranchName?: string;
    parentBranchRevision?: string;
    prInfo?: TBranchPRInfo;
    lastSubmittedVersion?: TSubmittedVersion;
  }): TMeta => ({
    parentBranchName: meta.parentBranchName,
    parentBranchRevision: meta.parentBranchRevision,
    prInfo: meta.prInfo,
    lastSubmittedVersion: meta.lastSubmittedVersion,
  });

  /** Another command (often in another worktree) wrote this branch's metadata
   * since we loaded it. Keep its fields and apply only the fields this command
   * meant to change, per PR-info field, then retry compare-and-swap. */
  const mergeConcurrentMeta = (
    branchName: string,
    intended: TMeta,
    previous: TMeta | undefined
  ): { meta: TMeta; oid: string } => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentOid = getMetadataOid(branchName);
      const current: TMeta =
        currentOid === NO_METADATA
          ? {}
          : readMetadataRef(branchName, undefined, currentOid);
      const merged: TMeta = { ...current };
      for (const key of [
        'parentBranchName',
        'parentBranchRevision',
        'lastSubmittedVersion',
      ] as const) {
        if (!isDeepStrictEqual(intended[key], previous?.[key]))
          (merged as Record<string, unknown>)[key] = intended[key];
      }
      if (!isDeepStrictEqual(intended.prInfo, previous?.prInfo)) {
        const prInfo: Record<string, unknown> = { ...current.prInfo };
        const fields = new Set([
          ...Object.keys(intended.prInfo ?? {}),
          ...Object.keys(previous?.prInfo ?? {}),
        ]);
        for (const field of fields) {
          const wanted = (intended.prInfo as Record<string, unknown>)?.[field];
          const before = (previous?.prInfo as Record<string, unknown>)?.[field];
          if (isDeepStrictEqual(wanted, before)) continue;
          if (intended.prInfo && field in intended.prInfo)
            prInfo[field] = wanted;
          else delete prInfo[field];
        }
        merged.prInfo = Object.keys(prInfo).length
          ? (prInfo as TBranchPRInfo)
          : undefined;
      }
      splog.debug(
        `Merging metadata for ${branchName} written by another command`
      );
      const oid = writeMetadataRef(branchName, merged, undefined, currentOid);
      if (oid) return { meta: merged, oid };
    }
    throw new ExitFailedError(
      `Metadata for ${branchName} keeps changing under other gt commands. Retry.`
    );
  };

  // Any writes should go through this function, which:
  // Validates the new metadata
  // Updates children of the old+new parent
  // Writes to disk
  // Revalidates 'INVALID_PARENT' children
  // eslint-disable-next-line max-lines-per-function
  const updateMeta = (
    branchName: string,
    newCachedMeta: TValidCachedMetaExceptTrunk
  ) => {
    // Get current meta and ensure this branch isn't trunk.
    const oldCachedMeta = cache.branches[branchName] ?? {
      validationResult: 'BAD_PARENT_NAME',
      branchRevision: git.getShaOrThrow(branchName),
      children: [],
    };
    assertCachedMetaIsNotTrunk(oldCachedMeta);

    // Write to disk first: compare-and-swap against the blob this command
    // loaded, merging with concurrent writers instead of overwriting them.
    const intended = metaOf(newCachedMeta);
    const expectedOid =
      branchName in cache.branches
        ? oldCachedMeta.metadataOid
        : oldCachedMeta.metadataOid ?? NO_METADATA;
    let oid = writeMetadataRef(branchName, intended, undefined, expectedOid);
    if (!oid) {
      const merged = mergeConcurrentMeta(
        branchName,
        intended,
        oldCachedMeta.validationResult === 'BAD_PARENT_NAME'
          ? undefined
          : metaOf(oldCachedMeta)
      );
      oid = merged.oid;
      newCachedMeta = {
        ...newCachedMeta,
        parentBranchName:
          merged.meta.parentBranchName ?? newCachedMeta.parentBranchName,
        parentBranchRevision:
          merged.meta.parentBranchRevision ??
          newCachedMeta.parentBranchRevision,
        prInfo: merged.meta.prInfo,
        lastSubmittedVersion: merged.meta.lastSubmittedVersion,
      };
      if (!(newCachedMeta.parentBranchName in cache.branches))
        throw new ExitFailedError(
          `Another command changed ${branchName}'s parent to ${newCachedMeta.parentBranchName}, which is not in this command's snapshot. Metadata was preserved; retry with a fresh snapshot.`
        );
    }
    newCachedMeta = { ...newCachedMeta, metadataOid: oid };

    // Get new cached meta and handle updating children
    cache.branches[branchName] = newCachedMeta;
    const oldParentBranchName =
      oldCachedMeta.validationResult === 'BAD_PARENT_NAME'
        ? undefined
        : oldCachedMeta.parentBranchName;
    const newParentBranchName = newCachedMeta.parentBranchName;
    assertBranch(newParentBranchName);

    if (oldParentBranchName !== newParentBranchName) {
      if (oldParentBranchName && oldParentBranchName in cache.branches) {
        removeChild(oldParentBranchName, branchName);
      }
    }

    if (!cache.branches[newParentBranchName].children.includes(branchName)) {
      cache.branches[newParentBranchName].children.push(branchName);
    }

    splog.debug(
      `Updated cached meta for branch ${branchName}:\n${cuteString(
        newCachedMeta
      )}`
    );

    // Any 'INVALID_PARENT' children can be revalidated
    if (oldCachedMeta.validationResult !== 'VALID') {
      revalidateChildren(newCachedMeta.children);
    }
  };

  const revalidateChildren = (children: string[]) => {
    children.forEach((childBranchName) => {
      assertBranch(childBranchName);
      const childCachedMeta = cache.branches[childBranchName];
      if (childCachedMeta.validationResult !== 'INVALID_PARENT') {
        return;
      }

      const result = validateOrFixParentBranchRevision(
        {
          branchName: childBranchName,
          ...childCachedMeta,
          parentBranchCurrentRevision:
            cache.branches[childCachedMeta.parentBranchName].branchRevision,
        },
        splog
      );
      cache.branches[childBranchName] = { ...childCachedMeta, ...result };
      // fix children recursively
      revalidateChildren(childCachedMeta.children);
    });
  };

  const deleteAllBranchData = (branchName: string) => {
    const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

    removeChild(cachedMeta.parentBranchName, branchName);
    delete cache.branches[branchName];
    git.deleteBranch(branchName);
    deleteMetadataRef(branchName);
  };

  /** Rewrite a branch that another worktree has checked out: compute the
   * rebased commits here, then move that worktree's HEAD, index, and files to
   * them together. Blocked (not failed) when that worktree is busy or dirty. */
  const restackElsewhere = (args: {
    branchName: string;
    directory: string;
    cachedMeta: TValidCachedMetaExceptTrunk;
  }):
    | { result: 'REBASE_DONE' }
    | { result: 'REBASE_CONFLICT_DEFERRED'; directory: string }
    | {
        result: 'REBASE_BLOCKED';
        reason: string;
        directory: string;
        cause: string;
      } => {
    const { branchName, directory, cachedMeta } = args;
    const replayed = git.replayCommits({
      branchName,
      onto: cachedMeta.parentBranchName,
      from: cachedMeta.parentBranchRevision,
      currentBranch: cache.currentBranch,
      restackCommitterDateIsAuthorDate,
    });
    if (replayed === 'CONFLICT')
      return { result: 'REBASE_CONFLICT_DEFERRED', directory };
    if (replayed === 'UNSUPPORTED') {
      const cause = 'needs a working-tree rebase (unusual history)';
      return {
        result: 'REBASE_BLOCKED',
        reason: `${branchName} is checked out at ${JSON.stringify(
          directory
        )} and ${cause}. Run gt restack from that worktree.`,
        directory,
        cause,
      };
    }
    const moved = git.moveCheckedOutBranch({
      branch: branchName,
      directory,
      sha: replayed.newTip,
      expectedSha: replayed.tip,
      mode: 'rewrite',
    });
    return moved.moved
      ? { result: 'REBASE_DONE' }
      : {
          result: 'REBASE_BLOCKED',
          reason: moved.reason,
          directory,
          cause: moved.cause ?? 'refused the update',
        };
  };

  /** Move trunk (or any branch) that this worktree does not have checked out.
   * Nowhere checked out: a plain compare-and-swap ref update. Checked out in
   * another worktree: fast-forward or reset there so its files follow. */
  const moveBranchNotCheckedOutHere = (args: {
    branchName: string;
    from: string;
    to: string;
    mode: 'fast-forward' | 'rewrite';
  }): { moved: true } | { moved: false; reason: string } => {
    const { branchName, from, to, mode } = args;
    const elsewhere = git.branchesCheckedOutElsewhere().get(branchName);
    if (elsewhere)
      return git.moveCheckedOutBranch({
        branch: branchName,
        directory: elsewhere,
        sha: to,
        expectedSha: from,
        mode,
      });
    return git.updateRef(`refs/heads/${branchName}`, to, from)
      ? { moved: true }
      : {
          moved: false,
          reason: `${branchName} moved while this command was running.`,
        };
  };

  // A rebase leaves the rebased branch checked out. Return to the command's
  // original branch; restacking many branches in a large repository defers
  // this to one final checkout instead of one per branch.
  const checkoutCurrentBranch = () => {
    if (
      cache.currentBranch &&
      cache.currentBranch in cache.branches &&
      git.getCurrentBranchName() !== cache.currentBranch
    ) {
      try {
        git.switchBranch(cache.currentBranch);
      } catch (error) {
        // A failing post-checkout hook makes git switch exit nonzero after
        // the switch itself succeeded. The command's work is done; report
        // the hook instead of discarding the summary that follows.
        if (git.getCurrentBranchName() !== cache.currentBranch) throw error;
        splog.warn(
          `Switched back to ${
            cache.currentBranch
          }, but the checkout reported: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  };

  const handleSuccessfulRebase = (
    branchName: string,
    parentBranchRevision: string,
    opts?: { deferCheckout?: boolean }
  ) => {
    const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

    updateMeta(branchName, {
      ...cachedMeta,
      branchRevision: git.getShaOrThrow(branchName),
      parentBranchRevision,
    });

    if (!opts?.deferCheckout) checkoutCurrentBranch();
  };

  return {
    noVerify,
    assertBranchMutable,
    isBranchFrozen: (branchName: string) =>
      frozenConfig.data.branches.includes(branchName),
    freezeBranch: (branchName: string, frozen: boolean) => {
      assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      frozenConfig.update((data) => {
        data.branches = data.branches.filter((b) => b !== branchName);
        if (frozen) data.branches.push(branchName);
      });
    },
    get debug() {
      // Canonical key order: the same repository state must serialize
      // identically whether branch data came from the persisted cache, a
      // cold parse, or in-process mutations.
      return JSON.stringify(
        cache,
        (_key, value: unknown) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>).sort(
                  ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
                )
              )
            : value,
        2
      );
    },
    persist() {
      const currentHash = stableHash(cache.branches);
      if (loadedBranchesHash !== currentHash) {
        cacheLoader.persistCache(trunkName, cache.branches, additionalTrunks);
        loadedBranchesHash = currentHash;
      }
    },
    clear() {
      cacheLoader.clearPersistedCache();
    },
    reset(newTrunkName?: string) {
      trunkName = newTrunkName ?? trunkName;
      Object.keys(getMetadataRefList()).forEach((branchName) =>
        deleteMetadataRef(branchName)
      );
      cache.branches = loadBranches();
    },
    rebuild(newTrunkName?: string, newAdditionalTrunks?: string[]) {
      trunkName = newTrunkName ?? trunkName;
      additionalTrunks = newAdditionalTrunks ?? additionalTrunks;
      cache.branches = loadBranches();
      cache.currentBranch = git.getCurrentBranchName() ?? currentBranchOverride;
    },
    get trunk() {
      return assertTrunk();
    },
    get trunks() {
      return allTrunks();
    },
    getTrunk: assertTrunk,
    isTrunk,
    branchExists,
    get allBranchNames() {
      return Object.keys(cache.branches);
    },
    isBranchTracked: (branchName: string) => {
      assertBranch(branchName);
      return cache.branches[branchName].validationResult === 'VALID';
    },
    isDescendantOf: isDescendantOf,
    getAncestorBranchNames,
    getDescendantBranchNames,
    trackBranch: (branchName: string, parentBranchName: string) => {
      assertBranchMutable(branchName);
      validateNewParent(branchName, parentBranchName);
      assertBranch(branchName);
      assertBranchIsValidOrTrunkAndGetMeta(parentBranchName);

      // This is parentMeta.branchRevision unless parent is trunk
      const parentBranchRevision = git.getMergeBase(
        branchName,
        parentBranchName
      );
      if (!parentBranchRevision) {
        throw new ExitFailedError(
          `${chalk.yellow(branchName)} shares no history with ${chalk.yellow(
            parentBranchName
          )}. Rebase it onto ${chalk.cyan(
            parentBranchName
          )} before tracking it.`
        );
      }
      updateMeta(branchName, {
        ...cache.branches[branchName],
        validationResult: 'VALID',
        parentBranchName,
        parentBranchRevision,
      });
      return 'TRACKED';
    },
    untrackBranch: (branchName: string) => {
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      deleteMetadataRef(branchName);
      cache.branches[branchName] = {
        ...cachedMeta,
        validationResult: 'BAD_PARENT_NAME',
      };

      // We have to fix validation state for any recursive children
      const childrenToUntrack = cachedMeta.children.slice();
      while (childrenToUntrack.length) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const childBranchName = childrenToUntrack.pop()!;
        const childCachedMeta = cache.branches[childBranchName];
        assertCachedMetaIsNotTrunk(childCachedMeta);
        if (childCachedMeta.validationResult !== 'BAD_PARENT_NAME') {
          cache.branches[childBranchName] = {
            ...childCachedMeta,
            validationResult: 'INVALID_PARENT',
          };
        }
        childrenToUntrack.concat(childCachedMeta.children);
      }
    },
    get currentBranch() {
      return cache.currentBranch;
    },
    get currentBranchPrecondition(): string {
      const branchName = getCurrentBranchOrThrow();
      assertBranchIsValidOrTrunkAndGetMeta(branchName);
      return branchName;
    },
    rebaseInProgress: git.rebaseInProgress,
    detectStagedChanges: git.detectStagedChanges,
    findRemoteBranch: () => git.findRemoteBranch(remote),
    getUnmergedFiles: git.getUnmergedFiles,
    getRebaseHead: git.getRebaseHead,
    getUnstagedChanges: git.getUnstagedChanges,
    getStatus: git.getStatus,
    logLong: git.logLong,
    showCommits: (branchName: string, patch: boolean, stat?: boolean) => {
      const meta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      return git.showCommits(
        meta.validationResult === 'TRUNK'
          ? undefined
          : meta.parentBranchRevision,
        branchName,
        { patch, stat }
      );
    },
    getChangedFiles: (branchName: string) => {
      const meta = cache.branches[branchName];
      return git.getFilesChanged(
        !meta || meta.validationResult !== 'VALID'
          ? `${branchName}~`
          : meta.parentBranchRevision,
        branchName
      );
    },
    getFileContents: git.getFileContents,
    restoreFile: git.restoreFile,
    showDiff: (branchName: string, stat?: boolean) => {
      const meta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      return git.showDiff(
        meta.validationResult === 'TRUNK'
          ? `${branchName}~`
          : meta.parentBranchRevision,
        branchName,
        stat
      );
    },
    getDiff: git.getDiff,
    getStackDiff: (branchName: string) => {
      const meta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      return git.getDiff(
        meta.validationResult === 'TRUNK'
          ? `${branchName}~`
          : meta.parentBranchRevision,
        branchName
      );
    },
    getParentOrPrev: (branchName: string) => {
      const meta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      return meta.validationResult === 'TRUNK'
        ? `${branchName}~`
        : meta.parentBranchRevision;
    },
    getRevision: (branchName: string) => {
      assertBranch(branchName);
      const meta = cache.branches[branchName];
      return meta.branchRevision;
    },
    getBaseRevision: (branchName: string) =>
      assertBranchIsValidAndNotTrunkAndGetMeta(branchName).parentBranchRevision,
    getAllCommits: (branchName: string, format: TCommitFormat) => {
      const meta = assertBranchIsValidOrTrunkAndGetMeta(branchName);

      return git.getCommitRange(
        // for trunk, commit range is just one commit
        meta.validationResult === 'TRUNK'
          ? undefined
          : meta.parentBranchRevision,
        meta.branchRevision,
        format
      );
    },
    getCommitDate: git.getCommitDate,
    getCommitAuthor: git.getCommitAuthor,
    getPrInfo: (branchName: string) => {
      const meta = cache.branches[branchName];
      return meta?.validationResult === 'TRUNK' ? undefined : meta?.prInfo;
    },
    getPublishedRevision: (branchName: string) => {
      const meta = cache.branches[branchName];
      return (
        meta?.prInfo?.remoteRevision ?? meta?.lastSubmittedVersion?.headSha
      );
    },
    getLastSubmittedVersion: (branchName: string) =>
      cache.branches[branchName]?.lastSubmittedVersion,
    upsertPrInfo: (branchName: string, prInfo: Partial<TBranchPRInfo>) => {
      const meta = cache.branches[branchName];
      if (meta?.validationResult !== 'VALID') {
        return;
      }
      updateMeta(branchName, {
        ...meta,
        prInfo: { ...meta.prInfo, ...prInfo },
      });
    },
    recordPublishedVersion: (branchName, version) => {
      const meta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      updateMeta(branchName, {
        ...meta,
        lastSubmittedVersion: makeSubmittedVersion(
          meta.lastSubmittedVersion,
          version
        ),
      });
    },
    clearPrInfo: (branchName: string) => {
      const meta = cache.branches[branchName];
      if (meta?.validationResult !== 'VALID') {
        return;
      }
      updateMeta(branchName, {
        ...meta,
        prInfo: {},
        lastSubmittedVersion: undefined,
      });
    },
    getChildren,
    getBranchWorktrees: git.branchesCheckedOutElsewhere,
    setParent,
    getParent,
    getParentPrecondition: (branchName: string) =>
      assertBranchIsValidAndNotTrunkAndGetMeta(branchName).parentBranchName,
    getRelativeStack: (branchName: string, scope: TScopeSpec) => {
      assertBranchIsValidOrTrunkAndGetMeta(branchName);
      // Only includes trunk if branchName is trunk
      return [
        ...(scope.recursiveParents
          ? getRecursiveParentsExcludingTrunk(branchName)
          : []),
        ...(scope.currentBranch ? [branchName] : []),
        ...(scope.recursiveChildren ? getRecursiveChildren(branchName) : []),
      ];
    },
    checkoutNewBranch: (branchName: string) => {
      const parentBranchName = getCurrentBranchOrThrow();
      const parentCachedMeta =
        assertBranchIsValidOrTrunkAndGetMeta(parentBranchName);
      validateNewParent(branchName, parentBranchName);
      git.switchBranch(branchName, { new: true });
      updateMeta(branchName, {
        validationResult: 'VALID',
        parentBranchName,
        parentBranchRevision: parentCachedMeta.branchRevision,
        branchRevision: parentCachedMeta.branchRevision,
        children: [],
      });
      cache.currentBranch = branchName;
    },
    checkoutBranch,
    renameCurrentBranch: (branchName: string) => {
      const currentBranchName = getCurrentBranchOrThrow();
      assertBranchMutable(currentBranchName);
      if (branchName === currentBranchName) {
        return;
      }
      const cachedMeta =
        assertBranchIsValidAndNotTrunkAndGetMeta(currentBranchName);

      git.moveBranch(branchName);
      updateMeta(branchName, {
        ...cachedMeta,
        prInfo: {},
        lastSubmittedVersion: undefined,
      });

      cachedMeta.children.forEach((childBranchName) =>
        setParent(childBranchName, branchName)
      );

      removeChild(cachedMeta.parentBranchName, currentBranchName);
      delete cache.branches[currentBranchName];
      deleteMetadataRef(currentBranchName);
      cache.currentBranch = branchName;
    },
    foldCurrentBranch: (keep: boolean) => {
      const currentBranchName = getCurrentBranchOrThrow();
      assertBranchMutable(currentBranchName);
      assertBranchMutable(getParent(currentBranchName) as string);
      const cachedMeta =
        assertBranchIsValidAndNotTrunkAndGetMeta(currentBranchName);

      const parentBranchName = cachedMeta.parentBranchName;
      const parentCachedMeta =
        assertBranchIsValidAndNotTrunkAndGetMeta(parentBranchName);

      if (keep) {
        updateMeta(currentBranchName, {
          ...cachedMeta,
          parentBranchName: parentCachedMeta.parentBranchName,
          parentBranchRevision: parentCachedMeta.parentBranchRevision,
        });
        parentCachedMeta.children
          .filter((childBranchName) => childBranchName !== currentBranchName)
          .forEach((childBranchName) =>
            setParent(childBranchName, currentBranchName)
          );
        deleteAllBranchData(parentBranchName);
      } else {
        git.forceCheckoutNewBranch(parentBranchName, cachedMeta.branchRevision);
        updateMeta(parentBranchName, {
          ...parentCachedMeta,
          branchRevision: cachedMeta.branchRevision,
        });
        cachedMeta.children.forEach((childBranchName) =>
          setParent(childBranchName, parentBranchName)
        );
        checkoutBranch(cachedMeta.parentBranchName);
        deleteAllBranchData(currentBranchName);
      }
    },
    deleteBranch: (branchName: string) => {
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

      if (branchName === cache.currentBranch) {
        checkoutBranchOrDetach(cachedMeta.parentBranchName);
      }

      cachedMeta.children.forEach((childBranchName) =>
        setParent(childBranchName, cachedMeta.parentBranchName)
      );

      deleteAllBranchData(branchName);
    },
    commit: (opts: TCommitOpts & { summaryOnly?: boolean }) => {
      const branchName = getCurrentBranchOrThrow();
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      const output = git.commit({ ...opts, noVerify });
      // Native create omits the [branch sha] header; modify keeps it.
      const summary = opts.summaryOnly
        ? output.split('\n').slice(1).join('\n').trim()
        : output;
      if (summary) splog.info(summary);
      cache.branches[branchName] = {
        ...cachedMeta,
        branchRevision: git.getShaOrThrow(branchName),
      };
    },
    squashCurrentBranch: (opts: Pick<TCommitOpts, 'message' | 'noEdit'>) => {
      const branchName = getCurrentBranchOrThrow();
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      git.softReset(
        git
          .getCommitRange(
            cachedMeta.parentBranchRevision,
            cachedMeta.branchRevision,
            'SHA'
          )
          .reverse()[0]
      );
      try {
        const output = git.commit({
          ...opts,
          amend: true,
          noVerify,
        });
        if (output) splog.info(output);
      } catch (e) {
        try {
          git.softReset(cachedMeta.branchRevision);
        } catch {
          // pass
        }
        throw e;
      }
      cache.branches[branchName] = {
        ...cachedMeta,
        branchRevision: git.getShaOrThrow(branchName),
      };
    },
    addAll: git.addAll,
    addUpdates: git.addUpdates,
    detach() {
      const branchName = getCurrentBranchOrThrow();
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      git.switchBranch(cachedMeta.branchRevision, { detach: true });
    },
    unbranch() {
      const branchName = getCurrentBranchOrThrow();
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      git.switchBranch(cachedMeta.branchRevision, { detach: true });
      const parentBranchName = cachedMeta.parentBranchName;
      deleteAllBranchData(branchName);
      git.mixedReset(parentBranchName);
      git.switchBranch(parentBranchName);
    },
    detachAndResetBranchChanges() {
      const branchName = getCurrentBranchOrThrow();
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      git.switchBranch(cachedMeta.branchRevision, { detach: true });
      git.trackedReset(cachedMeta.parentBranchRevision);
    },
    applySplitToCommits({
      branchToSplit,
      branchNames,
      branchPoints,
    }: {
      branchToSplit: string;
      branchNames: string[];
      branchPoints: number[];
    }) {
      if (branchNames.length !== branchPoints.length) {
        splog.debug(branchNames.toString());
        splog.debug(branchPoints.toString());
        throw new PreconditionsFailedError(`Invalid number of branch names.`);
      }
      const cachedMeta =
        assertBranchIsValidAndNotTrunkAndGetMeta(branchToSplit);

      const children = cachedMeta.children;

      // we reverse the branch points because they are referencing
      // commits from newest to oldest, but we name branches from
      // oldest to newest (parent to child)
      const reversedBranchPoints = branchPoints.slice().reverse();
      // keep track of the last branch's name + SHA for metadata
      const lastBranch = {
        name: cachedMeta.parentBranchName,
        revision: cachedMeta.parentBranchRevision,
      };
      branchNames.forEach((branchName, idx) => {
        const branchRevision = git.getShaOrThrow(
          `@~${reversedBranchPoints[idx]}`
        );
        git.forceCreateBranch(branchName, branchRevision);
        updateMeta(branchName, {
          validationResult: 'VALID',
          branchRevision,
          parentBranchName: lastBranch.name,
          parentBranchRevision: lastBranch.revision,
          children: [],
          prInfo: branchName === branchToSplit ? cachedMeta.prInfo : undefined,
          lastSubmittedVersion:
            branchName === branchToSplit
              ? cachedMeta.lastSubmittedVersion
              : undefined,
        });
        lastBranch.name = branchName;
        lastBranch.revision = branchRevision;
      });
      if (lastBranch.name !== branchToSplit) {
        children.forEach((childBranchName) =>
          setParent(childBranchName, lastBranch.name)
        );
      }
      if (!branchNames.includes(branchToSplit)) {
        deleteAllBranchData(branchToSplit);
      }
      cache.currentBranch = lastBranch.name;
      git.switchBranch(lastBranch.name);
    },
    forceCheckoutBranch: (branchToSplit: string) => {
      git.switchBranch(branchToSplit, { force: true });
    },
    checkoutCurrentBranch,
    restackBranch: (
      branchName: string,
      opts?: { deferCheckout?: boolean; deferConflicts?: boolean }
    ) => {
      if (frozenConfig.data.branches.includes(branchName))
        return { result: 'REBASE_FROZEN' };
      const cachedMeta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      if (isBranchFixed(branchName)) {
        return { result: 'REBASE_UNNEEDED' };
      }
      assertCachedMetaIsNotTrunk(cachedMeta);
      assertBranch(cachedMeta.parentBranchName);
      const newBase =
        cache.branches[cachedMeta.parentBranchName].branchRevision;

      // Another worktree owns this branch's checkout: rewrite it there.
      const elsewhere = git.branchesCheckedOutElsewhere().get(branchName);
      if (elsewhere) {
        const moved = restackElsewhere({
          branchName,
          directory: elsewhere,
          cachedMeta,
        });
        if (moved.result === 'REBASE_DONE')
          handleSuccessfulRebase(branchName, newBase, opts);
        return moved;
      }

      // Branches that are not checked out can usually be rewritten without a
      // working-tree switch; conflicts and unusual setups use git rebase.
      const replayed = git.replayBranch({
        branchName,
        onto: cachedMeta.parentBranchName,
        from: cachedMeta.parentBranchRevision,
        currentBranch: cache.currentBranch,
        restackCommitterDateIsAuthorDate,
      });
      // The merge already showed the conflict. A best-effort caller gains
      // nothing from a full checkout, a stopped rebase, and its abort.
      if (replayed === 'CONFLICT' && opts?.deferConflicts)
        return { result: 'REBASE_CONFLICT_DEFERRED' };
      if (
        replayed !== 'REBASE_DONE' &&
        git.rebase({
          branchName,
          onto: cachedMeta.parentBranchName,
          from: cachedMeta.parentBranchRevision,
          restackCommitterDateIsAuthorDate,
        }) === 'REBASE_CONFLICT'
      ) {
        return {
          result: 'REBASE_CONFLICT',
          rebasedBranchBase: newBase,
        };
      }
      handleSuccessfulRebase(branchName, newBase, opts);
      return { result: 'REBASE_DONE' };
    },
    rebaseInteractive: (branchName: string) => {
      assertBranchMutable(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

      if (
        git.rebaseInteractive({
          branchName,
          parentBranchRevision: cachedMeta.parentBranchRevision,
        }) === 'REBASE_CONFLICT'
      ) {
        return {
          result: 'REBASE_CONFLICT',
          rebasedBranchBase: cachedMeta.parentBranchRevision,
        };
      }

      handleSuccessfulRebase(branchName, cachedMeta.parentBranchRevision);
      return { result: 'REBASE_DONE' };
    },
    continueRebase: (parentBranchRevision: string) => {
      const result = git.rebaseContinue();
      if (result === 'REBASE_CONFLICT') {
        return { result };
      }
      const branchName = git.getCurrentBranchName();
      if (!branchName) {
        throw new PreconditionsFailedError(
          'Must be on a branch after a rebase.'
        );
      }
      assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      handleSuccessfulRebase(branchName, parentBranchRevision);
      return { result, branchName };
    },
    abortRebase: () => {
      git.rebaseAbort();
    },
    isMergedIntoTrunk: (branchName: string) => {
      assertBranch(branchName);
      const trunkName = assertTrunk(branchName);
      return git.isMerged({ branchName, trunkName });
    },
    isBranchFixed,
    isBranchEmpty: (branchName: string) => {
      assertBranch(branchName);
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      return git.isDiffEmpty(branchName, cachedMeta.parentBranchRevision);
    },
    populateRemoteShas: async () => {
      await git.populateRemoteShas(remote);
    },
    branchMatchesRemote: (branchName: string) => {
      const cachedMeta = assertBranchIsValidOrTrunkAndGetMeta(branchName);
      const remoteParentRevision = git.getRemoteSha(branchName);
      return cachedMeta.branchRevision === remoteParentRevision;
    },
    getRemoteSha: (branchName: string) => git.getRemoteSha(branchName),
    pushBranch: (branchName: string, forcePush: boolean) => {
      const meta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);
      git.pushBranch({
        remote,
        branchName,
        noVerify,
        forcePush,
        expectedRemoteRevision:
          meta.prInfo?.remoteRevision ?? meta.lastSubmittedVersion?.headSha,
      });
      updateMeta(branchName, {
        ...meta,
        prInfo: { ...meta.prInfo, remoteRevision: meta.branchRevision },
        lastSubmittedVersion: makeSubmittedVersion(meta.lastSubmittedVersion, {
          headSha: meta.branchRevision,
          baseSha: meta.parentBranchRevision,
          baseName: meta.parentBranchName,
        }),
      });
    },
    pruneRemote: () => git.pruneRemoteAsync(remote),
    listRemoteHeads: (branchNames: string[]) =>
      git.listRemoteHeads(remote, branchNames),
    fetchRemoteBranches: async (branchNames: string[]) => {
      await git.fetchRemoteBranches(remote, branchNames);
      return git.remoteTrackingRevisions(remote, branchNames);
    },
    // Trunk is moved without switching branches, so this works from any
    // worktree, including when trunk is checked out in another one.
    pullTrunk: (target: string) => {
      const trunkName = assertTrunk();
      const oldTrunkCachedMeta = cache.branches[trunkName];
      // Compare with the live ref, not the loaded cache: a command in another
      // worktree may have moved trunk since this command started.
      const before = git.getShaOrThrow(trunkName);
      if (target === before) {
        cache.branches[trunkName] = {
          ...oldTrunkCachedMeta,
          branchRevision: before,
        };
        return { result: 'PULL_UNNEEDED' };
      }
      if (!git.isAncestor(before, target)) return { result: 'PULL_CONFLICT' };
      if (cache.currentBranch === trunkName) {
        git.mergeFastForward(target);
      } else {
        const moved = moveBranchNotCheckedOutHere({
          branchName: trunkName,
          from: before,
          to: target,
          mode: 'fast-forward',
        });
        if (!moved.moved)
          return { result: 'PULL_BLOCKED', reason: moved.reason };
      }
      cache.branches[trunkName] = {
        ...oldTrunkCachedMeta,
        branchRevision: git.getShaOrThrow(trunkName),
      };
      return { result: 'PULL_DONE' };
    },
    hardReset: git.hardReset,
    resetTrunkToRemote: (remoteTrunkRevision: string) => {
      const trunkName = assertTrunk();
      const oldTrunkCachedMeta = cache.branches[trunkName];
      if (cache.currentBranch === trunkName) {
        git.hardReset(remoteTrunkRevision);
      } else {
        const moved = moveBranchNotCheckedOutHere({
          branchName: trunkName,
          from: git.getShaOrThrow(trunkName),
          to: remoteTrunkRevision,
          mode: 'rewrite',
        });
        if (!moved.moved)
          return { result: 'RESET_BLOCKED', reason: moved.reason };
      }
      cache.branches[trunkName] = {
        ...oldTrunkCachedMeta,
        branchRevision: git.getShaOrThrow(trunkName),
      };
      return { result: 'RESET' };
    },
    clean: git.clean,
    fetchBranch: (branchName: string, parentBranchName: string) => {
      const parentMeta = assertBranchIsValidOrTrunkAndGetMeta(parentBranchName);
      if (parentMeta.validationResult === 'TRUNK') {
        // If this is a trunk-child, its base is its merge base with trunk.
        git.fetchBranch(remote, branchName);
        const fetchBase = git.getMergeBase(
          git.readFetchHead(),
          parentMeta.branchRevision
        );
        if (!fetchBase) {
          throw new ExitFailedError(
            `Fetched ${chalk.yellow(
              branchName
            )} shares no history with ${chalk.yellow(parentBranchName)}.`
          );
        }
        git.writeFetchBase(fetchBase);
      } else {
        // Otherwise, its base is the head of the previous fetch
        git.writeFetchBase(git.readFetchHead());
        git.fetchBranch(remote, branchName);
      }
    },
    branchMatchesFetched: (branchName: string) => {
      assertBranch(branchName);
      return cache.branches[branchName].branchRevision === git.readFetchHead();
    },
    checkoutBranchFromFetched: (
      branchName: string,
      parentBranchName: string
    ) => {
      validateNewParent(branchName, parentBranchName);
      assertBranch(parentBranchName);
      const { head, base } = {
        head: git.readFetchHead(),
        base: git.readFetchBase(),
      };
      git.forceCheckoutNewBranch(branchName, head);
      git.setRemoteTracking({ remote, branchName, sha: head });

      updateMeta(branchName, {
        validationResult: 'VALID',
        parentBranchName,
        parentBranchRevision: base,
        branchRevision: head,
        children: [],
      });
      cache.currentBranch = branchName;
    },
    rebaseBranchOntoFetched: (branchName: string) => {
      const cachedMeta = assertBranchIsValidAndNotTrunkAndGetMeta(branchName);

      const { head, base } = {
        head: git.readFetchHead(),
        base: git.readFetchBase(),
      };
      git.setRemoteTracking({ remote, branchName, sha: head });

      // setting the current branch to this branch is correct in either case
      // failure case, we want it so that currentBranchOverride will be set
      // success case, it ends up as HEAD after the rebase.
      cache.currentBranch = branchName;
      if (
        git.rebase({
          onto: head,
          from: cachedMeta.parentBranchRevision,
          branchName,
          restackCommitterDateIsAuthorDate,
        }) === 'REBASE_CONFLICT'
      ) {
        return {
          result: 'REBASE_CONFLICT',
          rebasedBranchBase: base,
        };
      }
      handleSuccessfulRebase(branchName, base);
      return { result: 'REBASE_DONE' };
    },
  };
}
