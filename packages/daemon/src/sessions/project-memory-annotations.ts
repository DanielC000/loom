import type { ProjectMemoryEntry } from "@loom/shared";
import type { Db } from "../db.js";
import { annotateRequestLinks } from "./project-memory-request-links.js";

/**
 * The read-time annotation lines a DIGEST/`composeProjectMemoryDigest` `annotate` callback appends after a
 * note body: ONLY linked-Request live state (decision e6d270b3). One function so the kickoff digest
 * (project-memory-recall.ts) and the never-drop floor-tier size estimate (mcp/memory.ts
 * `computeNeverDropStatus`) compute the identical set.
 *
 * Inbound `[[wikilink]]` backlinks, unresolved outbound links and auto-detected card/path mentions are
 * deliberately NOT injected into kickoffs (decision 7c74acd8): they were ~16% of the memory section and are
 * navigation aids, and `memory_read`/`memory_list` still return `backlinks` and `unresolvedOutboundLinks`
 * as structured fields, and `memory_read` (single-note only) also returns auto-detected `mentions`.
 */
export function annotateNote(
  db: Db,
  projectId: string,
  entry: ProjectMemoryEntry,
): string[] {
  return annotateRequestLinks(db, projectId, entry.requestIds);
}
