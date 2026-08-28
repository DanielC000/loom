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
 * Card e4e180ad follow-up (manager review, measured live against this project's real corpus): EVERY note
 * this function annotates is a digest-rendered note — it's SIZED against the shared kickoff budget
 * whether or not it survives the pack — so backlinks here always use the MUCH tighter {@link
 * MAX_BACKLINKS_DIGEST}, never the general `MAX_BACKLINKS`. An earlier version of this only tightened
 * `never-drop` floor-tier notes; that predicate was an unexamined default, not a reasoned boundary — the
 * real line is DIGEST vs ON-DEMAND, and every note reaching this function sits on the digest side of it
 * regardless of tier (see `MAX_BACKLINKS_DIGEST`'s own doc comment for the measured byte cost across BOTH
 * floor and ordinary pinned notes that motivated dropping the tier-specific predicate).
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
