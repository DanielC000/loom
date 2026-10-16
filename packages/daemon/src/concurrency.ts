/**
 * Run `fn` over `items` with at most `limit` concurrently in flight — never an unbounded `Promise.all`
 * over the whole set. The returned array's order matches `items`, regardless of which entry finishes
 * first. An unusable `limit` (`<= 0`, `NaN`, or any other value that isn't `>= 1`) or an empty `items`
 * runs nothing and resolves immediately to an array of that length (every entry `undefined` in the
 * unusable-`limit` case — there is nothing meaningful to run). The `!(limit >= 1)` guard (rather than
 * `limit <= 0`) is deliberately NaN-safe: `NaN <= 0` is `false` (so a NaN limit would otherwise fall
 * through to `Math.min(NaN, items.length)`, itself `NaN`, and `Array.from({length: NaN})` silently
 * produces an EMPTY worker pool — nothing would ever run, with no error and no "unusable limit" signal).
 *
 * REJECTION SEMANTICS: this is a thin wrapper over `Promise.all`, so it inherits `Promise.all`'s own
 * behavior, not a custom one — if any `fn` call rejects, `mapWithConcurrency` rejects with that SAME
 * error as soon as it's thrown (never aggregated, never wrapped). Every OTHER in-flight call keeps running
 * in the background to completion (or to its own later rejection) — JS has no built-in cancellation, and
 * this function does not add one — but its result is silently discarded; the caller only ever sees the
 * first rejection. A caller that cannot tolerate orphaned in-flight work after a rejection must make `fn`
 * itself tolerant (catch-and-wrap each call into a `{ok, value}`/`{ok, error}` result) rather than relying
 * on this function to stop anything.
 *
 * @decision 37fe091c — a fully serial classify loop is what made `/api/worktrees/retained` time out;
 * `Promise.all` over the whole set is not the fix either (unbounded concurrent git subprocesses).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0 || !(limit >= 1)) return results;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i); // i < items.length, by construction
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
