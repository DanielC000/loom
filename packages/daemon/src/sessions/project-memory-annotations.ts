import type { ProjectMemoryEntry } from "@loom/shared";
import type { Db } from "../db.js";
import { annotateRequestLinks } from "./project-memory-request-links.js";
import { annotateBacklinksPrecomputed } from "./project-memory-backlinks.js";
import { annotateMentionsPrecomputed, type NoteMention } from "./project-memory-references.js";

/**
 * Every read-time annotation line for a note that a DIGEST/`composeProjectMemoryDigest` `annotate`
 * callback appends after the note's own body: linked-Request state (card e6d270b3), inbound
 * `[[wikilink]]` backlinks (card e4e180ad), then auto-detected card/decision/path cross-note mentions
 * (card a140598a). Combined into ONE function so every caller that sizes or renders a note's
 * annotations — the kickoff digest (project-memory-recall.ts's `retrieveProjectMemoryForKickoff`) AND
 * the never-drop floor-tier byte estimate (mcp/memory.ts's `computeNeverDropStatus`) — computes the
 * identical set from the identical function, rather than two independently-written closures that could
 * silently diverge on which annotations count toward a note's rendered/estimated size (the exact class
 * of bug `floorSectionTokens`/`computeFloorTierStatus` were already written to avoid for the floor-tier
 * total itself — see project-memory-recall.ts).
 *
 * @decision e4e180ad — every note here is DIGEST-rendered, so its backlinks always use the tighter
 * `MAX_BACKLINKS_DIGEST` (applied when the caller builds `backlinksIndex`), never `MAX_BACKLINKS`.
 *
 * `mentionsIndex` (card a140598a round 2 — performance) and `backlinksIndex` (card 527ed4f0 — same
 * performance fix, applied to the OTHER per-note scan this function used to run) are each built ONCE per
 * digest composition / per write-time status computation by the CALLER (`buildMentionsIndex`/
 * `buildBacklinksIndex`), never fetched or recomputed by this function itself — every note annotated in
 * the SAME composition shares the identical prebuilt maps, an O(1) lookup each, instead of each call
 * re-scanning the whole memory corpus (+ task list, for mentions). Both optional only so a caller with
 * genuinely nothing to look up can omit either.
 *
 * NOT used by mcp/memory.ts's `withLinks` (the memory_read/memory_list read path) — there, request
 * annotations and backlinks are deliberately kept as two SEPARATE fields (`requestAnnotations`,
 * `backlinks`) on `ProjectMemoryEntryWithLinks`, since that's a structured API response, not prose being
 * appended into one digest block, and that on-demand read keeps the full `MAX_BACKLINKS` (via the
 * per-note `annotateBacklinks`, unaffected by this card). Auto-detected mentions (card a140598a) have no
 * on-demand surface of their own yet — see that card's own scope note — so they are digest-only, same as
 * everything else this function renders.
 */
export function annotateNote(
  db: Db,
  projectId: string,
  entry: ProjectMemoryEntry,
  mentionsIndex?: Map<string, { matches: NoteMention[]; totalFound: number }>,
  backlinksIndex?: Map<string, string[]>,
): string[] {
  return [
    ...annotateRequestLinks(db, projectId, entry.requestIds),
    ...annotateBacklinksPrecomputed(backlinksIndex, entry.key),
    ...annotateMentionsPrecomputed(mentionsIndex, entry.key),
  ];
}
