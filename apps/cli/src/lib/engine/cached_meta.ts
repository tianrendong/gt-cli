import * as t from '../retype';
import { BadTrunkOperationError, UntrackedBranchError } from '../errors';
import { prInfoSchema, submittedVersionSchema } from './metadata_ref';

export const cachedMetaSchema = t.intersection(
  t.shape({
    children: t.array(t.string),
    branchRevision: t.string,
    /** Metadata blob this entry reflects (NO_METADATA when none). Absent in
     * caches from older releases. Enables compare-and-swap metadata writes
     * and proves a persisted cache still matches the refs. */
    metadataOid: t.optional(t.string),
    prInfo: t.optional(prInfoSchema),
    lastSubmittedVersion: t.optional(submittedVersionSchema),
  }),
  t.taggedUnion('validationResult' as const, {
    VALID: {
      validationResult: t.literal('VALID' as const),
      parentBranchName: t.string,
      parentBranchRevision: t.string,
    },
    INVALID_PARENT: {
      validationResult: t.literal('INVALID_PARENT' as const),
      parentBranchName: t.string,
      parentBranchRevision: t.optional(t.string),
    },
    BAD_PARENT_REVISION: {
      validationResult: t.literal('BAD_PARENT_REVISION' as const),
      parentBranchName: t.string,
    },
    BAD_PARENT_NAME: {
      validationResult: t.literal('BAD_PARENT_NAME' as const),
    },
    TRUNK: {
      validationResult: t.literal('TRUNK' as const),
    },
  })
);
export type TCachedMeta = t.TypeOf<typeof cachedMetaSchema>;

type TValidCachedMeta = Extract<
  TCachedMeta,
  { validationResult: 'TRUNK' | 'VALID' }
>;
export function assertCachedMetaIsValidOrTrunk(
  branchName: string,
  meta: TCachedMeta
): asserts meta is TValidCachedMeta {
  if (meta.validationResult !== 'VALID' && meta.validationResult !== 'TRUNK') {
    throw new UntrackedBranchError(branchName);
  }
}

type TNonTrunkCachedMeta = Exclude<TCachedMeta, { validationResult: 'TRUNK' }>;
export function assertCachedMetaIsNotTrunk(
  meta: TCachedMeta
): asserts meta is TNonTrunkCachedMeta {
  if (meta.validationResult === 'TRUNK') {
    throw new BadTrunkOperationError();
  }
}

export type TValidCachedMetaExceptTrunk = Extract<
  TValidCachedMeta,
  TNonTrunkCachedMeta
>;
export function assertCachedMetaIsValidAndNotTrunk(
  branchName: string,
  meta: TCachedMeta
): asserts meta is TValidCachedMetaExceptTrunk {
  assertCachedMetaIsValidOrTrunk(branchName, meta);
  assertCachedMetaIsNotTrunk(meta);
}
