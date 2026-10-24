/**
 * The merge rule behind a query-preserving redirect — card 260fb29a.
 *
 * Extracted from `nav.tsx`'s `QueryPreservingRedirect` purely so the rule is testable without
 * rendering a router (test/deep-link-query.mjs imports this directly). The component is the only
 * caller; this module holds no state and reads nothing.
 *
 * @decision 260fb29a — on a key collision the TARGET's value wins, and wins WHOLE: never let an
 * incoming query re-point a redirect at a sub-tab the old address never named, and never leave an
 * incoming value for a colliding key beside the target's own.
 */
export function mergeRedirectQuery(to: string, incomingSearch: string): string {
  const [path = to, ownQuery = ""] = to.split("?");
  const own = new URLSearchParams(ownQuery);
  const merged = new URLSearchParams(incomingSearch);
  // Delete-then-append rather than `set`: `set` collapses a repeated key to one value, which would
  // silently drop a second value on EITHER side. This drops every incoming value for a colliding key
  // and keeps every value the target declares for it.
  for (const key of new Set(own.keys())) merged.delete(key);
  for (const [key, value] of own) merged.append(key, value);
  const query = merged.toString();
  return query ? `${path}?${query}` : path;
}
