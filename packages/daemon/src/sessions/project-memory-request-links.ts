import type { Db } from "../db.js";
import { stripEscapeAndControlChars } from "../security/control-chars.js";

/**
 * Resolve a memory note's linked Request ids against the LIVE requests store, at RECALL time.
 *
 * @decision e6d270b3 — half (a) (shipped 2026-07-22) only changed how a note is WRITTEN — asking voice
 * instead of decided voice — but a note still froze that state at write time; once the owner answered,
 * the note kept reading PENDING forever. This module is half (b).
 *
 * This module is the fix: every surface that surfaces a note (kickoff injection, `memory_read`,
 * `memory_list`) re-resolves each linked id fresh, right before the note is shown, so the annotation can
 * never outlive the state it describes.
 *
 * Three deliberate constraints (card e6d270b3):
 *  - FAIL-VISIBLE on an unknown/deleted id: never silently omitted (a silent omission leaves the note's
 *    own stale text standing unchallenged — exactly the failure this card removes).
 *  - PROJECT-SCOPED, server-side: `projectId` is always the CALLER's own project (resolved server-side
 *    from the session, same as every other memory tool) — a cross-project id renders "not found in this
 *    project" and never leaks the other project's actual state (title, state, anything).
 *  - Reports the RAW `Question.state` literally (pending/answered/consumed/cancelled), uppercased, with
 *    zero interpretation — this module reports state, it does not decide anything.
 */

/** One linked id's live annotation line, e.g. `[linked request req-123: PENDING as of 2026-07-24]`.
 *
 * @decision ea5fb00a — never interpolate the raw `requestId` into the rendered line on any branch; strip
 * ESC/C0/C1 first. A control-byte id never resolves to a real Request, so the "not found" branch below is
 * reachable on every such id, not an edge case, and this render must always produce something.
 */
export function annotateRequestLink(db: Db, projectId: string, requestId: string, now: Date): string {
  const safeId = stripEscapeAndControlChars(requestId).text;
  const q = db.getQuestion(requestId);
  if (!q) return `[linked request ${safeId}: request not found — may be deleted]`;
  if (q.projectId !== projectId) return `[linked request ${safeId}: not found in this project]`;
  const asOf = now.toISOString().slice(0, 10);
  return `[linked request ${safeId}: ${q.state.toUpperCase()} as of ${asOf}]`;
}

/**
 * Every linked id's annotation line, in order. `null`/empty `requestIds` (a note that links nothing — the
 * common case) ⇒ `[]`, no DB lookups at all. `now` defaults to the real clock; tests pass a fixed Date for
 * deterministic "as of" assertions.
 */
export function annotateRequestLinks(db: Db, projectId: string, requestIds: string[] | null, now: Date = new Date()): string[] {
  if (!requestIds || requestIds.length === 0) return [];
  return requestIds.map((id) => annotateRequestLink(db, projectId, id, now));
}
