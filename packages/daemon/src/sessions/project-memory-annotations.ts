import type { ProjectMemoryEntry } from "@loom/shared";
import type { Db } from "../db.js";
import { annotateRequestLinks } from "./project-memory-request-links.js";
import { annotateBacklinks, MAX_BACKLINKS_DIGEST } from "./project-memory-backlinks.js";

/**
 * Every read-time annotation line for a note that a DIGEST/`composeProjectMemoryDigest` `annotate`
 * callback appends after the note's own body: linked-Request state (card e6d270b3) followed by inbound
 * `[[wikilink]]` backlinks (card e4e180ad). Combined into ONE function so every caller that sizes or
 * renders a note's annotations — the kickoff digest (project-memory-recall.ts's
 * `retrieveProjectMemoryForKickoff`) AND the never-drop floor-tier byte estimate (mcp/memory.ts's
 * `computeNeverDropStatus`) — computes the identical set from the identical function, rather than two
 * independently-written closures that could silently diverge on which annotations count toward a note's
 * rendered/estimated size (the exact class of bug `floorSectionTokens`/`computeFloorTierStatus` were
 * already written to avoid for the floor-tier total itself — see project-memory-recall.ts).
 *
 * @decision e4e180ad — every note this function annotates is DIGEST-rendered, sized against the shared
 * kickoff budget whether or not it survives the pack, so backlinks here always use the tighter {@link
 * MAX_BACKLINKS_DIGEST} — never `MAX_BACKLINKS`, and never scoped to just the never-drop floor tier.
 *
 * NOT used by mcp/memory.ts's `withLinks` (the memory_read/memory_list read path) — there, request
 * annotations and backlinks are deliberately kept as two SEPARATE fields (`requestAnnotations`,
 * `backlinks`) on `ProjectMemoryEntryWithLinks`, since that's a structured API response, not prose being
 * appended into one digest block, and that on-demand read keeps the full `MAX_BACKLINKS`.
 */
export function annotateNote(db: Db, projectId: string, entry: ProjectMemoryEntry): string[] {
  return [
    ...annotateRequestLinks(db, projectId, entry.requestIds),
    ...annotateBacklinks(db, projectId, entry.key, MAX_BACKLINKS_DIGEST),
  ];
}
