/**
 * Card aeec1880 — originally the TRIGGER-PREDICATE mechanism's own path-token heuristic (gates a
 * `pinned:true` note's delivery to kickoffs whose text names a matching path — see
 * project-memory-recall.ts's `triggerMatchesKickoff`). Card a140598a round 2 moved it HERE, out of
 * project-memory-recall.ts, so project-memory-recall.ts can import from project-memory-references.ts
 * (to build its mentions index once per digest composition) without the two modules importing from
 * each other in a cycle — this file sits BELOW both and is imported by both.
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;

/** Extracts path-like tokens (2+ `/`-separated segments of path-safe characters) from free-form prose —
 *  a kickoff/task title+body routinely contains a literal repo path this way. Trailing prose punctuation
 *  that can glue onto a mentioned path (e.g. "...see `packages/daemon/src/db.ts`." or
 *  "(packages/daemon/src/db.ts)") is stripped before matching — never part of a real path. Leading
 *  punctuation never needs stripping: {@link PATH_TOKEN_RE} only ever starts a match on a path-safe
 *  character. Reused as-is by project-memory-references.ts's mentions feature — see that module's own
 *  `isPlausiblePathToken` for the additional filter it applies ONLY at its own call site. */
export function extractPathTokens(text: string): string[] {
  const found = text.match(PATH_TOKEN_RE) ?? [];
  return found.map((t) => t.replace(/[.,:;)\]'"]+$/, ""));
}
