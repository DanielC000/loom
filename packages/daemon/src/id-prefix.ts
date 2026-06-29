/**
 * Shared id / id-PREFIX resolution — the SINGLE affordance behind worker_spawn's `agentId` and the
 * platform `*_get` reads, kept HERE so spawn + reads can't drift. Loom displays the 8-char id-PREFIX
 * everywhere as the paste-able id; this resolves that prefix back to the full record, mirroring how
 * `transcript_read` already accepts an 8-char prefix (mcp/transcript-read.ts › MIN_ID_PREFIX_LEN).
 */

/**
 * Shortest id-PREFIX that will resolve — the canonical 8-char short id Loom shows on board cards and
 * in the rail (kept in lockstep with transcript-read.ts's own MIN_ID_PREFIX_LEN). A shorter, non-exact
 * ref is treated as too-short rather than risk a surprise multi-match; an EXACT full-id match always
 * wins regardless of length.
 */
export const MIN_ID_PREFIX_LEN = 8;

/** Resolution outcome: a unique hit, an ambiguous prefix (the matching ids), or no match. */
export type IdPrefixResult<T> =
  | { kind: "found"; record: T }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

/**
 * Resolve `ref` against `candidates` as EITHER a full id OR an unambiguous id-PREFIX:
 *   - an EXACT id (`candidate.id === ref`) ALWAYS wins, any length;
 *   - else, when `ref.length >= MIN_ID_PREFIX_LEN`, the candidates whose id STARTS WITH `ref`:
 *       exactly one ⇒ `found`; more than one ⇒ `ambiguous` (the matching ids); none ⇒ `none`;
 *   - a shorter, non-exact `ref` ⇒ `none` (too short to prefix-match safely).
 * Pure + deterministic — candidates are scanned in their given order.
 */
export function resolveIdPrefix<T extends { id: string }>(candidates: T[], ref: string): IdPrefixResult<T> {
  for (const c of candidates) if (c.id === ref) return { kind: "found", record: c };
  if (ref.length < MIN_ID_PREFIX_LEN) return { kind: "none" };
  const matches = candidates.filter((c) => c.id.startsWith(ref));
  const first = matches[0];
  if (matches.length === 1 && first) return { kind: "found", record: first };
  if (matches.length > 1) return { kind: "ambiguous", ids: matches.map((c) => c.id) };
  return { kind: "none" };
}

/**
 * True when `ref` LOOKS like an id (a full UUID or the displayed 8-char short id): ONLY hex digits +
 * hyphens, and at least MIN_ID_PREFIX_LEN long. Routes the "did you mean" hint AWAY from name-based
 * edit-distance for an id miss — a hex prefix near-matches an arbitrary NAME, so the old name-only hint
 * confidently named an UNRELATED agent for an id typo.
 */
export function looksLikeId(ref: string): boolean {
  return ref.length >= MIN_ID_PREFIX_LEN && /^[0-9a-fA-F-]+$/.test(ref);
}

/**
 * card f9412b5e: shared resolver for the single-record `*_get` reads (platform.ts + the mirrored
 * loom-setup surface) — accept EITHER a full id OR an unambiguous id-PREFIX (the 8-char short id Loom
 * DISPLAYS, mirroring worker_spawn + transcript_read). The exact-id fast path (`getExact`) avoids
 * materializing the whole candidate list on the common hit; only a miss falls back to `listAll()` +
 * resolveIdPrefix. An ambiguous prefix NAMES the candidate ids rather than silently picking one; a true
 * miss returns the entity-specific "<label> not found". Kept HERE so every `*_get` site stays in lockstep.
 */
export function getByIdPrefix<T extends { id: string }>(
  ref: string,
  getExact: (id: string) => T | undefined,
  listAll: () => T[],
  label: string,
): T | { error: string } {
  const exact = getExact(ref);
  if (exact) return exact;
  const r = resolveIdPrefix(listAll(), ref);
  if (r.kind === "found") return r.record;
  if (r.kind === "ambiguous") return { error: `ambiguous ${label} id-prefix '${ref}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` };
  return { error: `${label} not found` };
}
