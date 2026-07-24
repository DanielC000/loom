import type { Db } from "../db.js";

/**
 * Resolve a memory note's linked Request ids against the LIVE requests store, at RECALL time — the half
 * (b) fix for card e6d270b3. Half (a) (shipped 2026-07-22) only changed how a note is WRITTEN — asking
 * voice ("PENDING request `<id>` asks the owner to authorize X") instead of decided voice — but a note
 * still froze that state at write time; once the owner answered, the note kept reading PENDING forever.
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

/** One linked id's live annotation line, e.g. `[linked request req-123: PENDING as of 2026-07-24]`. */
export function annotateRequestLink(db: Db, projectId: string, requestId: string, now: Date): string {
  const q = db.getQuestion(requestId);
  if (!q) return `[linked request ${requestId}: request not found — may be deleted]`;
  if (q.projectId !== projectId) return `[linked request ${requestId}: not found in this project]`;
  const asOf = now.toISOString().slice(0, 10);
  return `[linked request ${requestId}: ${q.state.toUpperCase()} as of ${asOf}]`;
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
