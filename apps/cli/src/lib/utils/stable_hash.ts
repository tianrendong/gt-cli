import { createHash } from 'crypto';

/**
 * Stable content hash with JSON semantics: object keys are sorted, properties
 * whose value is undefined are skipped, and undefined array elements become
 * null. Unlike fast-json-stable-hash, this never throws on undefined, which
 * engine cache entries can legitimately contain (e.g. a missing prInfo).
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${members.join(',')}}`;
}
