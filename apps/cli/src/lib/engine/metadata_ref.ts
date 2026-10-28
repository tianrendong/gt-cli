import { createHash } from 'crypto';
import * as t from '../retype';
import { cuteString } from '../utils/cute_string';
import {
  runGitCommand,
  runGitCommandAndSplitLines,
  runGitReadBatch,
} from '../git/runner';

export const prInfoSchema = t.shape({
  id: t.optional(t.string),
  remoteRevision: t.optional(t.string),
  number: t.optional(t.number),
  base: t.optional(t.string),
  url: t.optional(t.string),
  title: t.optional(t.string),
  body: t.optional(t.string),
  state: t.optional(
    t.unionMany([
      t.literal('OPEN' as const),
      t.literal('CLOSED' as const),
      t.literal('MERGED' as const),
    ])
  ),
  reviewDecision: t.optional(
    t.unionMany([
      t.literal('APPROVED' as const),
      t.literal('REVIEW_REQUIRED' as const),
      t.literal('CHANGES_REQUESTED' as const),
    ])
  ),
  isDraft: t.optional(t.boolean),
});
export type TBranchPRInfo = t.TypeOf<typeof prInfoSchema>;

// Native Graphite's legacy importer reads this field, not prInfo.remoteRevision.
// versionNumber belongs to Graphite's server and is optional even in 1.8.6.
// Preserve it when known; never invent a version for GitHub-only publication.
export const submittedVersionSchema = t.shape({
  headSha: t.string,
  baseSha: t.optional(t.string),
  baseName: t.optional(t.string),
  versionNumber: t.optional(t.number),
});
export type TSubmittedVersion = t.TypeOf<typeof submittedVersionSchema>;
export function makeSubmittedVersion(
  previous: TSubmittedVersion | undefined,
  current: Omit<Required<TSubmittedVersion>, 'versionNumber'>
): TSubmittedVersion {
  return {
    ...current,
    ...(previous?.versionNumber !== undefined
      ? { versionNumber: previous.versionNumber }
      : {}),
  };
}

const metaSchema = t.shape({
  lastSubmittedVersion: t.optional(submittedVersionSchema),
  parentBranchName: t.optional(t.string),
  parentBranchRevision: t.optional(t.string),
  prInfo: t.optional(prInfoSchema),
});
export type TMeta = t.TypeOf<typeof metaSchema>;

/** Expected value of a metadata ref that must not exist yet. */
export const NO_METADATA = '0'.repeat(40);

/** Current blob of a branch's metadata ref, or NO_METADATA. */
export function getMetadataOid(branchName: string, cwd?: string): string {
  const oid = runGitCommand({
    args: ['rev-parse', '--verify', '-q', `refs/branch-metadata/${branchName}`],
    options: { cwd },
    onError: 'ignore',
    resource: 'getMetadataOid',
  });
  return oid || NO_METADATA;
}

/** Object id Git would assign to this blob in a SHA-1 repository. */
function blobOid(content: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
}

/** Writes the metadata blob and points the ref at it; returns the blob oid.
 * With expectedOid, the update is compare-and-swap: when another process
 * moved the ref meanwhile nothing is written and undefined is returned, so a
 * command in one worktree can retry against the other command's metadata.
 */
// eslint-disable-next-line max-params
export function writeMetadataRef(
  branchName: string,
  meta: TMeta,
  cwd?: string,
  expectedOid?: string
): string | undefined {
  const content = cuteString(meta);
  // Refreshing PR info usually changes nothing. When the ref already points
  // at this exact blob, the update would be a no-op: skip both Git processes.
  // (SHA-256 repositories never match here and take the normal path.)
  if (
    expectedOid !== undefined &&
    expectedOid !== NO_METADATA &&
    blobOid(content) === expectedOid
  )
    return expectedOid;
  const metaSha = runGitCommand({
    args: [`hash-object`, `-w`, `--stdin`],
    options: {
      input: content,
      cwd,
    },
    onError: 'throw',
    resource: 'hashMetadataRef',
  });
  const ref = `refs/branch-metadata/${branchName}`;
  try {
    runGitCommand({
      args: [
        `update-ref`,
        ref,
        metaSha,
        ...(expectedOid !== undefined ? [expectedOid] : []),
      ],
      options: {
        stdio: 'pipe',
        cwd,
      },
      onError: 'throw',
      resource: 'writeMetadataRef',
    });
  } catch (error) {
    if (expectedOid !== undefined) {
      const current = getMetadataOid(branchName, cwd);
      if (current !== expectedOid && current !== metaSha) return undefined;
      if (current === metaSha) return metaSha; // Identical concurrent write.
    }
    throw error;
  }
  return metaSha;
}

export function readMetadataRef(
  branchName: string,
  cwd?: string,
  oid?: string
): TMeta {
  try {
    const meta = JSON.parse(
      runGitCommand({
        args: [`cat-file`, `-p`, oid ?? `refs/branch-metadata/${branchName}`],
        options: {
          cwd,
        },
        onError: 'ignore',
        resource: 'readMetadataRef',
      })
    );

    return metaSchema(meta) ? meta : {};
  } catch {
    return {};
  }
}

/** Read metadata in bounded batches, retaining cat-file -p's tolerant handling
 * of missing/malformed metadata. No shell, filesystem ref parsing, or object
 * cache: Git resolves loose/packed refs, replacements and object stores itself.
 */
export function readMetadataRefs(
  branchNames: string[],
  oids?: Readonly<Record<string, string>>
): Map<string, TMeta> {
  const result = new Map<string, TMeta>();
  for (let start = 0; start < branchNames.length; start += 128) {
    const chunk = branchNames.slice(start, start + 128);
    try {
      const refs = chunk.map(
        (name) => oids?.[name] ?? `refs/branch-metadata/${name}`
      );
      if (refs.some((ref) => /[\0\r\n]/.test(ref))) throw Error('Invalid ref');
      const batch = runGitReadBatch({
        args: ['cat-file', '--batch'],
        input: refs.join('\n') + '\n',
        maxBuffer: 64 * 1024 * 1024,
        resource: 'readMetadataRefs',
      });
      if (!batch) throw Error('Batch read failed');
      let offset = 0;
      for (const [index, ref] of refs.entries()) {
        const end = batch.indexOf('\n', offset);
        if (end < 0) throw Error('Incomplete batch header');
        const header = batch.subarray(offset, end).toString('utf8');
        offset = end + 1;
        let meta: TMeta = {};
        if (header !== `${ref} missing`) {
          const match =
            /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|tree|commit|tag) (\d+)$/.exec(
              header
            );
          if (!match) throw Error('Invalid batch header');
          const size = Number(match[3]);
          if (!Number.isSafeInteger(size) || batch[offset + size] !== 10)
            throw Error('Incomplete batch object');
          if (match[2] === 'blob') {
            try {
              // Match the legacy runner's trim, including BOM/NBSP characters.
              const value: unknown = JSON.parse(
                batch
                  .subarray(offset, offset + size)
                  .toString('utf8')
                  .trim()
              );
              if (metaSchema(value)) meta = value;
            } catch {
              // The singleton reader also treats malformed metadata as absent.
            }
          } else {
            // cat-file -p pretty-prints non-blobs differently from --batch.
            // Unusual/corrupt metadata refs retain that exact legacy behavior.
            meta = readMetadataRef(
              chunk[index],
              undefined,
              oids?.[chunk[index]]
            );
          }
          offset += size + 1;
        }
        result.set(chunk[index], meta);
      }
      if (offset !== batch.length) throw Error('Trailing batch data');
    } catch {
      // Older/unusual Git implementations and oversized batches retain the
      // singleton reader's behavior, including its error handling.
      for (const name of chunk)
        result.set(name, readMetadataRef(name, undefined, oids?.[name]));
    }
  }
  return result;
}

/** With expectedOid, only deletes that exact blob; a ref another process
 * rewrote meanwhile is kept and false is returned. */
export function deleteMetadataRef(
  branchName: string,
  expectedOid?: string
): boolean {
  const ref = `refs/branch-metadata/${branchName}`;
  try {
    runGitCommand({
      args: [
        `update-ref`,
        `-d`,
        ref,
        ...(expectedOid !== undefined ? [expectedOid] : []),
      ],
      onError: 'throw',
      resource: 'deleteMetadataRef',
    });
  } catch (error) {
    if (expectedOid !== undefined) {
      const current = getMetadataOid(branchName);
      if (current === NO_METADATA) return true;
      if (current !== expectedOid) return false;
    }
    throw error;
  }
  return true;
}

export function getMetadataRefList(): Record<string, string> {
  const meta: Record<string, string> = {};
  runGitCommandAndSplitLines({
    args: [
      `for-each-ref`,
      `--format=%(refname:lstrip=2):%(objectname)`,
      `refs/branch-metadata/`,
    ],
    onError: 'throw',
    resource: 'getMetadataRefList',
  })
    .map((line) => line.split(':'))
    .filter(
      (lineSplit): lineSplit is [string, string] =>
        lineSplit.length === 2 && lineSplit.every((s) => s.length > 0)
    )
    .forEach(([branchName, metaSha]) => (meta[branchName] = metaSha));

  return meta;
}
