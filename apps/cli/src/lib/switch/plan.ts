import {
  planMissingParents,
  publishedTip,
  readPrInfo,
} from '../../../scripts/migrate-from-graphite.cjs';
import { TMeta, TSubmittedVersion } from '../engine/metadata_ref';
import {
  Repository,
  RepoSnapshot,
  NativeRow,
  RefMap,
  decodedJSON,
  encodedJSON,
  equal,
  fail,
} from './repository';

export type Config = Record<string, unknown> & {
  trunk: string;
  additionalTrunks?: string[];
  trunks?: Array<{ name: string }>;
};
export type Topology = {
  heads: Record<string, string>;
  metadata: Record<string, TMeta>;
  trunks: string[];
  frozen: string[];
  config: Config;
};
export type ImportPlan = {
  topology: Topology;
  after: RepoSnapshot;
  blobs: Record<string, string>;
  restored: string[];
};
export function metadataRefs(refs: RefMap): RefMap {
  return Object.fromEntries(
    Object.entries(refs).filter(([ref]) =>
      ref.startsWith('refs/branch-metadata/')
    )
  );
}
/** Legacy refs are only writer tripwires when verified SQLite owns the import.
 * Native cleanup can remove them even if a branch is later recreated/retracked
 * or remains a parent. planImport rebuilds all metadata from SQLite, not refs.
 * Reject additions/rewrites; without a native DB, require the exact baseline.
 * Rows must come from the same verified SQLite backup used for the import.
 */
export function assertReenableMetadata(
  repo: Repository,
  refs: RefMap,
  { expected, rows }: { expected: RefMap; rows?: NativeRow[] }
): void {
  const actual = metadataRefs(refs);
  const conflicts: string[] = [];
  for (const ref of [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort()) {
    if (!ref.startsWith('refs/branch-metadata/')) {
      conflicts.push(`invalid saved metadata ref ${ref}`);
      continue;
    }
    if (actual[ref] === expected[ref]) continue;
    if (!actual[ref]) {
      if (rows !== undefined) continue;
      conflicts.push(`removed ${ref} (no native database to rebuild metadata)`);
    } else {
      conflicts.push(`${expected[ref] ? 'changed' : 'added'} ${ref}`);
    }
  }
  if (!conflicts.length) return;
  const shown = conflicts.slice(0, 20);
  if (shown.length < conflicts.length)
    shown.push(`... ${conflicts.length - shown.length} more conflicting refs`);
  fail(
    'gt-gh metadata changed while Graphite owned this repository. Refusing to overwrite conflicting changes.\n' +
      `Repository: ${repo.cwd}\n` +
      shown.map((change) => `  ${change}`).join('\n') +
      `\nBackups: ${repo.control}\n` +
      'Pause gt commands in every worktree and reconcile these refs with native Graphite before retrying. ' +
      'Use gt-cli enable --repo PATH --dry-run to check again. No metadata was overwritten.'
  );
}

export function configFrom(snapshot: RepoSnapshot, native = false): Config {
  const data = decodedJSON<Config>(
    snapshot.files['.graphite_repo_config'],
    {} as Config
  );
  if (!data.trunk || typeof data.trunk !== 'string')
    fail('Graphite must have a configured trunk before enabling gt-gh.');
  if (
    (data.additionalTrunks &&
      (!Array.isArray(data.additionalTrunks) ||
        data.additionalTrunks.some((t) => typeof t !== 'string'))) ||
    (data.trunks &&
      (!Array.isArray(data.trunks) ||
        data.trunks.some((t) => typeof t?.name !== 'string')))
  )
    fail('Unsupported Graphite trunk configuration.');
  const extra =
    native && data.trunks
      ? data.trunks.map((t) => t.name)
      : data.additionalTrunks ?? (data.trunks ?? []).map((t) => t.name);
  const all = [...new Set([data.trunk, ...extra])];
  return { ...data, additionalTrunks: all.filter((t) => t !== data.trunk) };
}
function headsFrom(refs: RefMap): Record<string, string> {
  for (const ref of Object.keys(refs)) {
    if (
      ref.startsWith('refs/heads/') &&
      Object.prototype.hasOwnProperty.call(Object.prototype, ref.slice(11))
    )
      fail(
        `Unsupported reserved branch name ${ref.slice(
          11
        )}. Repository was not migrated.`
      );
  }
  return Object.fromEntries(
    Object.entries(refs)
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => [ref.slice(11), sha])
  );
}
export function assertSubmittedVersion(branch: string, meta: TMeta): void {
  const version = meta.lastSubmittedVersion;
  const lease = meta.prInfo?.remoteRevision;
  if (!version && !lease) return;
  if (
    !version ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(version.headSha) ||
    !version.baseSha ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(version.baseSha) ||
    !version.baseName ||
    (version.versionNumber !== undefined &&
      (!Number.isSafeInteger(version.versionNumber) ||
        version.versionNumber < 0)) ||
    (lease !== undefined && lease !== version.headSha)
  ) {
    fail(
      `Cannot hand ${branch} back to Graphite without a complete matching published version. No lease was discarded. Submit/get with the current gt-gh, or repair the metadata explicitly.`
    );
  }
}

export function planImport(
  repo: Repository,
  before: RepoSnapshot,
  options: { rows: NativeRow[]; restore: boolean; replacing: boolean }
): ImportPlan {
  const { rows, restore, replacing } = options;
  const config = configFrom(before, true);
  const trunks = [config.trunk, ...(config.additionalTrunks ?? [])];
  const heads = headsFrom(before.refs);
  const originalMetadata = metadataRefs(before.refs);
  if (!replacing && Object.keys(originalMetadata).length) {
    fail(
      'Existing gt-gh metadata has no managed handoff record. Refusing to overwrite or guess which store is authoritative. Use a clean trial clone or reconcile it explicitly.'
    );
  }
  const restored = planMissingParents(
    rows,
    new Set(Object.keys(heads)),
    new Map(),
    new Set(trunks),
    {
      git: (args: string[]) => repo.git(args),
      force: true,
      restoreMissingParents: restore,
    }
  ) as Map<string, string>;
  for (const [branch, sha] of restored) heads[branch] = sha;
  for (const trunk of trunks)
    if (!heads[trunk]) fail(`Missing configured trunk ${trunk}.`);
  const prs = readPrInfo(repo.common) as Map<
    string,
    NonNullable<TMeta['prInfo']>
  >;
  const metadata: Record<string, TMeta> = {};
  for (const row of rows) {
    const branch = row.branch_name;
    if (!heads[branch] || !row.parent_branch_name || trunks.includes(branch))
      continue;
    const lease = publishedTip(row) as string | undefined;
    const version = row.last_submitted_version
      ? (JSON.parse(row.last_submitted_version) as TSubmittedVersion)
      : undefined;
    const prInfo = {
      ...prs.get(branch),
      ...(lease ? { remoteRevision: lease } : {}),
    };
    metadata[branch] = {
      parentBranchName: row.parent_branch_name,
      ...(row.parent_branch_revision
        ? { parentBranchRevision: row.parent_branch_revision }
        : {}),
      ...(Object.keys(prInfo).length ? { prInfo } : {}),
      ...(version ? { lastSubmittedVersion: version } : {}),
    };
    assertSubmittedVersion(branch, metadata[branch]);
  }
  const frozen = rows
    .filter((row) => row.state === 'frozen' && metadata[row.branch_name])
    .map((row) => row.branch_name);
  const blobs: Record<string, string> = {};
  const refs: RefMap = Object.fromEntries(
    Object.entries(before.refs).filter(
      ([ref]) => !ref.startsWith('refs/branch-metadata/')
    )
  );
  for (const [branch, sha] of restored) refs[`refs/heads/${branch}`] = sha;
  for (const [branch, meta] of Object.entries(metadata)) {
    const ref = `refs/branch-metadata/${branch}`;
    blobs[ref] = JSON.stringify(meta, null, 2);
    refs[ref] = repo.git(['hash-object', '--stdin'], blobs[ref]); // No -w during preview.
  }
  return {
    topology: { heads, metadata, trunks, frozen, config },
    blobs,
    restored: [...restored.keys()],
    after: {
      ...before,
      refs,
      files: {
        ...before.files,
        '.graphite_repo_config': encodedJSON(config),
        'gt-frozen': encodedJSON({ branches: frozen }),
      },
    },
  };
}

export function currentTopology(
  repo: Repository,
  snapshot: RepoSnapshot
): Topology {
  const config = configFrom(snapshot);
  const heads = headsFrom(snapshot.refs);
  const metadata: Record<string, TMeta> = {};
  for (const [ref, sha] of Object.entries(metadataRefs(snapshot.refs))) {
    const branch = ref.slice('refs/branch-metadata/'.length);
    if (!heads[branch]) continue;
    const meta = JSON.parse(repo.git(['cat-file', '-p', sha])) as TMeta;
    if (
      !meta.parentBranchName ||
      typeof meta.parentBranchName !== 'string' ||
      !meta.parentBranchRevision
    )
      fail(`Invalid metadata for ${branch}; nothing was handed to Graphite.`);
    assertSubmittedVersion(branch, meta);
    metadata[branch] = meta;
  }
  const frozen = decodedJSON<{ branches: string[] }>(
    snapshot.files['gt-frozen'],
    { branches: [] }
  ).branches;
  if (!Array.isArray(frozen) || frozen.some((b) => typeof b !== 'string'))
    fail('Malformed frozen-branch metadata.');
  return {
    heads,
    metadata,
    trunks: [config.trunk, ...(config.additionalTrunks ?? [])],
    frozen,
    config,
  };
}

export function nativeRepoConfig(topology: Topology): Config {
  const known = topology.config.trunks ?? [];
  return {
    ...topology.config,
    trunks: topology.trunks.map(
      (name) => known.find((t) => t.name === name) ?? { name }
    ),
    // We just handed over the current PR cache. Let Graphite refresh it on its
    // normal schedule; do not immediately launch a competing background writer.
    // Published-tip safety lives in the SQLite rows, not in this timestamp.
    lastFetchedPRInfoMs: Date.now(),
  };
}
/** Preserve native-only cache fields and unrelated entries; update identities we know. */
export function nativePrCache(
  topology: Topology,
  encoded: string | null
): string | null {
  type PR = Record<string, unknown> & {
    headRefName?: string;
    prNumber?: number;
  };
  let cache: { prInfos: PR[]; [key: string]: unknown };
  try {
    cache = decodedJSON(encoded, { prInfos: [], mergeabilityStatuses: [] });
  } catch {
    fail('Malformed Graphite PR cache; refusing to replace it during handoff.');
  }
  if (!Array.isArray(cache.prInfos)) fail('Unsupported Graphite PR cache.');
  const migrated = new Set(Object.keys(topology.metadata));
  const knownNumbers = new Set(
    Object.values(topology.metadata).flatMap((meta) =>
      meta.prInfo?.number ? [meta.prInfo.number] : []
    )
  );
  const result = cache.prInfos.filter(
    (pr) =>
      !migrated.has(pr.headRefName ?? '') &&
      !knownNumbers.has(pr.prNumber as number)
  );
  for (const [branch, meta] of Object.entries(topology.metadata)) {
    const pr = meta.prInfo;
    if (!pr?.number) continue;
    const previous = cache.prInfos.find((p) => p.prNumber === pr.number);
    let trunk = branch;
    const seen = new Set<string>();
    while (topology.metadata[trunk]?.parentBranchName && !seen.has(trunk)) {
      seen.add(trunk);
      trunk = topology.metadata[trunk].parentBranchName as string;
    }
    result.push({
      authorGithubHandle: '',
      isBaseRefGraphiteBase: false,
      versions: [],
      ...previous,
      prNumber: pr.number,
      headRefName: branch,
      baseRefName:
        pr.base ?? meta.lastSubmittedVersion?.baseName ?? meta.parentBranchName,
      title: pr.title ?? previous?.title ?? branch,
      body: pr.body ?? previous?.body ?? '',
      url: pr.url ?? previous?.url ?? '',
      state: pr.state ?? previous?.state ?? 'OPEN',
      isDraft: pr.isDraft ?? previous?.isDraft ?? false,
      ...(pr.reviewDecision !== undefined
        ? { reviewDecision: pr.reviewDecision }
        : {}),
      // An untracked ancestor is not a configured trunk. Preserve any native
      // cached trunk identity, but do not invent one for this partial stack.
      ...(topology.trunks.includes(trunk) ? { cliTrunk: trunk } : {}),
    });
  }
  const next = { ...cache, prInfos: result };
  if (equal(next, cache)) return encoded;
  return encodedJSON(next);
}

/** Only an existing untracked ancestor explains an accepted INVALID_PARENT.
 * Missing heads, cycles, bad bases, and other native validation failures do not.
 */
function hasUntrackedAncestor(topology: Topology, branch: string): boolean {
  const seen = new Set<string>();
  let parent = topology.metadata[branch]?.parentBranchName;
  while (parent && !seen.has(parent)) {
    if (topology.trunks.includes(parent) || !topology.heads[parent])
      return false;
    seen.add(parent);
    if (!topology.metadata[parent]) return true;
    parent = topology.metadata[parent].parentBranchName;
  }
  return false;
}

export function assertTopologyRows(
  topology: Topology,
  rows: NativeRow[],
  isAncestor: (ancestor: string, descendant: string) => boolean
): void {
  const byName = new Map(rows.map((row) => [row.branch_name, row]));
  const depth = (branch: string): number => {
    const seen = new Set<string>();
    let parent = topology.metadata[branch]?.parentBranchName;
    while (parent && topology.metadata[parent] && !seen.has(parent)) {
      seen.add(parent);
      parent = topology.metadata[parent].parentBranchName;
    }
    return seen.size;
  };
  const ordered = Object.entries(topology.metadata).sort(
    ([a], [b]) => depth(a) - depth(b)
  );
  for (const [branch, meta] of ordered) {
    const row = byName.get(branch);
    const validation = hasUntrackedAncestor(topology, branch)
      ? ['VALID', 'INVALID_PARENT']
      : ['VALID'];
    if (row && !validation.includes(row.validation_result ?? ''))
      fail(
        `Native Graphite validation disagrees for ${branch} (${
          row.validation_result
        }; expected ${validation.join(' or ')}). Parent: ${
          meta.parentBranchName
        }; recorded base: ${
          meta.parentBranchRevision
        }. Resolve this ancestry with the current backend, then retry. No branch or database was changed.`
      );
    const parentHead =
      meta.parentBranchName && topology.heads[meta.parentBranchName];
    const head = topology.heads[branch];
    if (
      !row ||
      row.parent_branch_name !== meta.parentBranchName ||
      row.branch_revision !== head ||
      (row.parent_branch_revision !== meta.parentBranchRevision &&
        // Native moves a stale base to the parent head (validateOrFixParentBranchRevision).
        !(
          parentHead &&
          head &&
          meta.parentBranchRevision &&
          row.parent_branch_revision === parentHead &&
          row.parent_head_revision === parentHead &&
          isAncestor(meta.parentBranchRevision, parentHead) &&
          isAncestor(parentHead, head)
        )) ||
      !equal(
        row.last_submitted_version
          ? JSON.parse(row.last_submitted_version)
          : undefined,
        meta.lastSubmittedVersion
      ) ||
      row.state !== (topology.frozen.includes(branch) ? 'frozen' : null)
    ) {
      fail(
        `Graphite round-trip verification failed for ${branch}. No real branch or Graphite database was changed. ` +
          JSON.stringify({
            expected: {
              validation,
              parent: meta.parentBranchName,
              base: meta.parentBranchRevision,
              head: topology.heads[branch],
              published: meta.lastSubmittedVersion,
              frozen: topology.frozen.includes(branch),
            },
            actual: row,
          })
      );
    }
  }
  for (const branch of Object.keys(topology.heads)) {
    if (
      !topology.metadata[branch] &&
      !topology.trunks.includes(branch) &&
      byName.get(branch)?.parent_branch_name
    )
      fail(`Graphite unexpectedly tracked ${branch}; handoff cancelled.`);
  }
  for (const trunk of topology.trunks)
    if (byName.get(trunk)?.validation_result !== 'TRUNK')
      fail(`Graphite did not recognize trunk ${trunk}.`);
}
