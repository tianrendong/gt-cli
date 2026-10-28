import * as t from '../retype';
import { cachedMetaSchema } from '../engine/cached_meta';
import {
  validationProofSchema,
  VALIDATION_CACHE_VERSION,
} from '../engine/validation_cache';
import { spiffy } from './spiffy';

export const cachePersistenceFactory = spiffy({
  schema: t.shape({
    sha: (sha: unknown): sha is string => t.string(sha) && sha.length === 40,
    branches: t.array(t.tuple([t.string, cachedMetaSchema])),
    validation: t.optional(
      t.shape({
        version: t.literal(VALIDATION_CACHE_VERSION),
        // historyFingerprint() the proofs were made under; absent in files
        // written before fingerprints (always full history).
        history: t.optional(t.string),
        proofs: t.array(validationProofSchema),
      })
    ),
  }),
  defaultLocations: [
    {
      relativePath: '.graphite_cache_persist',
      relativeTo: 'REPO',
    },
  ],
  initialize: () => {
    return {};
  },
  helperFunctions: () => {
    return {};
  },
  options: { removeIfEmpty: true, removeIfInvalid: true },
});
