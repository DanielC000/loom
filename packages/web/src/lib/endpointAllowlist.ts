// Reconciles a key's STAGED endpoint-agent allowlist against the agents currently ELIGIBLE to be on it.
// JSX-free so test/endpoint-allowlist.mjs imports the real planner; KeyAdmin.tsx imports the SAME function
// (mirrors lib/columnDesired.ts + test/column-desired.mjs).
//
// @decision 654869e2 — "not loaded" (null) and "loaded, and empty" (an empty Set) are DIFFERENT states and
// must never collapse; treating an unloaded list as empty silently strips every grant the human holds.
//
// WHY THIS IS A MODULE AND NOT TWO INLINE EXPRESSIONS. Three distinct bugs here all come from deriving the
// SENT set and the DISCLOSED set at different moments, or from the wrong set:
//
//  1. The checkbox list renders one row per CURRENTLY-eligible agent, so a stored grant whose agent was
//     un-flagged as an endpoint (or deleted) has no control to clear it. Re-sending it makes
//     db.validateEndpointAllowlist 400 EVERY save of that key from then on — name, caps and status all
//     become unreachable because of a grant the form will not show.
//  2. Filtering the stored ids in a useState INITIALIZER reads the eligible set exactly once, at mount. If
//     the agents query has not resolved yet (first load, or an outright failure) that set is empty, so the
//     seed drops EVERY grant and the next save — even one that only renames the key — silently strips them
//     all. "Narrow rather than widen" is the right instinct for a privilege, but this is a narrowing the
//     human never chose, from data the UI merely had not fetched. Hence `ready:false`: the caller must
//     refuse to submit, not submit a smaller allowlist.
//  3. Deriving what-we-send at mount but what-we-disclose every render lets the two disagree — e.g. an
//     agent un-flagged WHILE the form is open (the Endpoint toggle sits on the same page) grows the
//     disclosure but leaves the stale id in the staged set, so the save 400s again with the UI claiming
//     the id was dropped. One function called once per render, returning both halves, cannot drift.

/** The outcome of reconciling a staged allowlist. `ready:false` means DO NOT SUBMIT — the eligible set is
 *  unknown, so any filtering would be guesswork, and sending the staged set verbatim would 400. */
export type EndpointAllowlistPlan =
  | { ready: false; reason: string }
  | { ready: true; send: string[]; dropped: string[] };

/** Human-readable copy for the not-ready state, so the component and its test agree on one string. */
export const ALLOWLIST_NOT_READY =
  "Endpoint agents could not be loaded — saving is disabled so the key's existing grants are not lost.";

/**
 * Split a staged allowlist into what is sendable and what will be dropped.
 *
 * @param staged      the ids currently ticked (seed the staging state from the STORED ids VERBATIM — never
 *                    pre-filtered, so nothing is lost before this runs).
 * @param eligible    the ids currently allowlist-eligible, or `null` when that list has not loaded
 *                    SUCCESSFULLY. An empty Set is a real answer ("this project has no endpoint agents"),
 *                    for which dropping every grant is correct and intended; `null` is not an answer.
 */
export function planEndpointAllowlist(
  staged: Iterable<string>,
  eligible: ReadonlySet<string> | null,
): EndpointAllowlistPlan {
  if (eligible === null) return { ready: false, reason: ALLOWLIST_NOT_READY };
  const send: string[] = [];
  const dropped: string[] = [];
  for (const id of staged) (eligible.has(id) ? send : dropped).push(id);
  return { ready: true, send, dropped };
}
