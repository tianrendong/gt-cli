import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as t from '../retype';
import { getGitCommonDir } from '../git/git_dir';
import { runGitReadBatch } from '../git/runner';

const oid: t.Schema<string> = (value): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

// Bump when validation rules change; package-only version changes need not
// discard proofs about the same immutable commits.
export const VALIDATION_CACHE_VERSION = 1;

// Only successful, non-repairing validations for fully resolved commit IDs.
// PR contents, child lists and validation of the parent are NEVER cached here.
export const validationProofSchema = t.tuple([
  t.string,
  oid,
  t.string,
  oid,
  oid,
]);
type Proof = t.TypeOf<typeof validationProofSchema>;
export type ValidationInput = {
  branchName: string;
  branchRevision: string;
  parentBranchName: string;
  parentBranchRevision?: string;
  parentBranchCurrentRevision: string;
};
function proof(input: ValidationInput): Proof | undefined {
  const value = [
    input.branchName,
    input.branchRevision,
    input.parentBranchName,
    input.parentBranchRevision,
    input.parentBranchCurrentRevision,
  ];
  return validationProofSchema(value) ? value : undefined;
}

export class BranchValidationCache {
  private readonly entries: Map<string, Proof>;
  constructor(previous: Proof[] = []) {
    this.entries = new Map(previous.map((p) => [p[0], p]));
  }
  has(input: ValidationInput): boolean {
    const key = proof(input),
      previous = this.entries.get(input.branchName);
    return !!key && !!previous && key.every((part, i) => part === previous[i]);
  }
  remember(input: ValidationInput): void {
    const key = proof(input);
    if (key) this.entries.set(input.branchName, key);
  }
  snapshot(branches: ReadonlySet<string>): Proof[] {
    return [...this.entries.values()].filter((p) => branches.has(p[0]));
  }
}

/** Everything besides immutable commit objects that decides ancestry, as a
 * string, or undefined when ancestry cannot be pinned down cheaply.
 *
 * A shallow boundary makes the listed commits parentless. Ancestry is then a
 * pure function of the commit objects plus the exact boundary set, so the
 * boundary file's contents are part of the fingerprint: an exact match makes
 * reuse provably correct. Do not rely on mtime/size equality. When the
 * boundary moves, see reusableAcross().
 *
 * Grafts and replacement refs can rewrite arbitrary parents, and custom
 * object/namespace overrides, alternates and promisor packs can change which
 * objects exist; those take the conservative path (full Git validation, no
 * reuse), even on a full-cache hit.
 */
export function historyFingerprint(
  hasReplacementRefs: boolean
): string | undefined {
  if (
    hasReplacementRefs ||
    [
      'GIT_REPLACE_REF_BASE',
      'GIT_GRAFT_FILE',
      'GIT_SHALLOW_FILE',
      'GIT_NAMESPACE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ].some((name) => process.env[name] !== undefined)
  )
    return undefined;
  const common = getGitCommonDir();
  if (!common) return undefined;
  for (const file of ['info/grafts', 'objects/info/alternates']) {
    try {
      fs.lstatSync(path.join(common, file));
      return undefined;
    } catch (error) {
      if (error.code !== 'ENOENT') return undefined;
    }
  }
  try {
    if (
      fs
        .readdirSync(path.join(common, 'objects/pack'))
        .some((name) => name.endsWith('.promisor'))
    )
      return undefined;
  } catch (error) {
    if (error.code !== 'ENOENT') return undefined;
  }
  const shallow = path.join(common, 'shallow');
  try {
    // Git replaces this file atomically (shallow.lock + rename). Anything but
    // a regular file is not something we can fingerprint reliably.
    if (!fs.lstatSync(shallow).isFile()) return undefined;
    const contents = fs.readFileSync(shallow);
    return `shallow:${createHash('sha1').update(contents).digest('hex')}`;
  } catch (error) {
    if (error.code !== 'ENOENT') return undefined;
  }
  return 'full';
}

/** Whether proofs made under history `from` may answer under history `to`.
 *
 * Identical fingerprints: provably correct. Between full history and any
 * shallow boundary (fetch --deepen/--unshallow/--depth, or a fresh boundary):
 * reused anyway, matching upstream Graphite. Moving the boundary changes no
 * commit ID, so a proof can be stale until the branch or its parent moves;
 * that rarely matters in practice, while discarding proofs makes the next
 * command re-run merge-base for every tracked branch without a commit-graph
 * (Git disables it when shallow): minutes with a few hundred branches. The
 * full-cache stamp still requires an exact match, so only per-branch ancestry
 * answers carry over; everything else is re-parsed.
 *
 * Unfingerprintable history (grafts, replacements, object overrides) and
 * proofs stamped under it ('') are never reused.
 */
export function reusableAcross(from: string, to: string): boolean {
  const boundaryOnly = (h: string) => h === 'full' || h.startsWith('shallow:');
  return from === to ? from !== '' : boundaryOnly(from) && boundaryOnly(to);
}

/** Ancestry is fully determined by commit IDs alone (no shallow boundary,
 * grafts, replacements or object-store overrides). */
export function ordinaryHistory(hasReplacementRefs: boolean): boolean {
  return historyFingerprint(hasReplacementRefs) === 'full';
}

/** Resolve the exact short names the legacy validator passes to Git. Using
 * only refs/heads would silently change ambiguous tag/branch-name behavior.
 * Failure disables proof reuse for that chunk; normal Git validation still runs.
 */
export function resolveCommitRefs(names: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let start = 0; start < names.length; start += 128) {
    const chunk = names.slice(start, start + 128);
    if (chunk.some((name) => /[\0\r\n]/.test(name))) continue;
    const batch = runGitReadBatch({
      args: ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      input: chunk.join('\n') + '\n',
      maxBuffer: 1024 * 1024,
      resource: 'resolveValidationRefs',
    });
    if (!batch) continue;
    const lines = batch.toString('utf8').trimEnd().split('\n');
    if (lines.length !== chunk.length) continue;
    for (const [index, line] of lines.entries()) {
      const [sha, type] = line.split(' ');
      if (type === 'commit' && oid(sha)) result.set(chunk[index], sha);
    }
  }
  return result;
}
