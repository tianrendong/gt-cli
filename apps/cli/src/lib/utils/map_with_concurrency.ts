/** Map `items` through `fn`, running at most `limit` calls at once, and
 * return the results in input order.
 *
 * After the first failure no new calls start; calls already running are
 * awaited before that failure is rethrown, so no work outlives the returned
 * promise. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failure) failure = { error };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  // Workers never reject, so this waits for every in-flight call.
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.error;
  return results;
}
