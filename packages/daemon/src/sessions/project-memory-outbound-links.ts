import type { ProjectMemoryEntry } from "@loom/shared";
import { extractWikilinkKeys } from "./project-memory-backlinks.js";

/**
 * Resolve OUTBOUND `[[wikilink]]` targets for a memory note — the mirror of project-memory-backlinks.ts's
 * INBOUND resolution. A note's text can `[[link]]` to a key that no longer exists (renamed, forgotten) or
 * never existed (a typo, or a deliberate reference into a DIFFERENT store this project's memory has no
 * visibility into — e.g. the owner's personal auto-memory). Nothing surfaced this before card 1c9dcb24:
 * `memory_read`/`memory_list`/the kickoff digest rendered a `[[link]]` verbatim whether or not its target
 * resolved, and `memory_write` never checked at all. Resolved fresh at read/write time, never stored on
 * the note itself — mirrors backlinks' own "never cached" posture, so a target created AFTER this note
 * was written self-corrects the next time anyone reads/lists/writes.
 *
 * Deliberately UNFILTERED by expiry — an expired note still genuinely EXISTS (card 57a91801: expiry
 * gates kickoff delivery, never existence; project-memory-backlinks.ts's own card 527ed4f0 makes the
 * identical call for inbound backlinks) — so a link to an expired note is a RESOLVED link, not a broken
 * one.
 *
 * @decision 1c9dcb24 — flag every unresolved target unconditionally; never auto-strip/delete one, and
 * never heuristically allowlist a cross-store reference (that list would drift the moment the owner's
 * own slugs change).
 */

/** Every `[[key]]` target in `entry.text` that is NOT present in `existingKeys` — in extraction order
 *  (mirrors {@link extractWikilinkKeys}'s own first-seen ordering). `[]` when every target resolves (or
 *  the note has none) — a MEASURED zero, same discipline as the inbound-backlinks resolver's `[]`. A
 *  self-reference (`entry.text` linking to `entry.key`) always resolves, with no special-casing needed:
 *  `existingKeys` is built from the live corpus, which always includes the note's own row. */
export function findUnresolvedOutboundLinks(entry: ProjectMemoryEntry, existingKeys: Set<string>): string[] {
  return extractWikilinkKeys(entry.text).filter((key) => !existingKeys.has(key));
}

/** The set of every key this project's memory store currently holds — built once from an already-
 *  fetched corpus (never a fresh fetch) so a LIST caller (`memory_list`, the kickoff digest) can reuse
 *  the corpus it already has in hand instead of paying for a second `db.listProjectMemory` round-trip. */
export function existingKeysFromCorpus(corpus: ProjectMemoryEntry[]): Set<string> {
  return new Set(corpus.map((e) => e.key));
}

/**
 * Bulk variant of {@link findUnresolvedOutboundLinks} — resolves EVERY note's outbound-unresolved links
 * in one pass over `corpus`, building the existence Set exactly once rather than once per note. Keyed by
 * note `key`, with exactly one entry per note in `corpus` (possibly `[]`, never omitted).
 */
export function findUnresolvedOutboundLinksBulk(corpus: ProjectMemoryEntry[]): Map<string, string[]> {
  const existingKeys = existingKeysFromCorpus(corpus);
  const result = new Map<string, string[]>();
  for (const entry of corpus) result.set(entry.key, findUnresolvedOutboundLinks(entry, existingKeys));
  return result;
}

/** The explanatory wording for `memory_read`/`memory_write` responses (never rendered into the
 *  kickoff digest) — acknowledges that an unresolved target MAY be a deliberate reference into a different memory system
 *  this project's store has no visibility into, per card 1c9dcb24's "flag unconditionally, never strip"
 *  decision. */
export function unresolvedOutboundLinksMessage(unresolved: string[]): string {
  return (
    `this note's [[wikilink]] target(s) do not exist in this project's memory store: ${unresolved.join(", ")} — ` +
    "never auto-stripped; write the target note, fix a typo in the key, or ignore this if it's a deliberate " +
    "reference into a different memory system (e.g. the owner's personal auto-memory) this store has no " +
    "visibility into."
  );
}
