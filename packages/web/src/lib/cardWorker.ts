// Card ↔ worker ↔ review links (card fa4234ab, Atlas audit B finding G-01). Pure derivations only, so
// the board card, the card dialog and the Needs-you merge row can all be tested without React or a
// daemon. Everything here reads data the web client already holds: the `["allSessions"]` feed, a
// manager's `["orchEvents", id]` stream and a project's `["board", id]` roll-up.
import type { OrchestrationEvent, SessionListItem } from "@loom/shared";
import { buildLatestMergeMap } from "./fleet";

/** The session route a worker's own node lives at. One spelling, so the card and the dialog agree. */
export function workerSessionPath(workerId: string): string {
  return `/session/${workerId}`;
}

/** The review (branch diff) route for a worker. */
export function workerReviewPath(workerId: string): string {
  return `/review/${workerId}`;
}

/**
 * Whether `worker` has a merge request awaiting review, read off its manager's event stream.
 *
 * The SAME latest-wins pairing the Needs-you queue uses (`buildLatestMergeMap`), keyed task-first, so a
 * `merge_done`/`merge_rejected` after the request retires it here exactly as it retires the attention
 * row. Two deliberate differences from that queue: a dismissed alert does NOT hide this (dismissing is a
 * view action on the alert, and the branch is still waiting), and the request must name THIS worker — a
 * task-keyed request filed by an earlier generation of the card's worker does not make the current one
 * reviewable. A worker that is no longer running has no live review either (its worktree is gone or
 * going), mirroring the queue's own liveness rule.
 */
export function hasPendingMergeRequest(
  events: readonly OrchestrationEvent[] | undefined,
  worker: Pick<SessionListItem, "id" | "taskId" | "processState">,
): boolean {
  if (!events || events.length === 0) return false;
  if (worker.processState !== "live" && worker.processState !== "starting") return false;
  const latest = buildLatestMergeMap(events);
  const e = (worker.taskId ? latest.get(worker.taskId) : undefined) ?? latest.get(worker.id);
  return !!e && e.kind === "merge_request" && e.workerSessionId === worker.id;
}

/**
 * The card title a merge request is about: its worker's `taskId`, looked up in the board roll-ups the
 * caller already loaded. `null` when the worker, its card, or that project's board is not (yet) known —
 * the caller then keeps the row's own text rather than printing a blank.
 */
export function mergeRequestCardTitle(
  workerId: string | null | undefined,
  sessions: readonly Pick<SessionListItem, "id" | "taskId">[] | undefined,
  titleById: ReadonlyMap<string, string>,
): string | null {
  if (!workerId) return null;
  const taskId = sessions?.find((s) => s.id === workerId)?.taskId;
  if (!taskId) return null;
  return titleById.get(taskId) ?? null;
}

/** The merge-request row's text once its card is known: the card first, because that is what the
 *  reader recognises; the worker's short id after it, because that is what the Review action opens. */
export function mergeRequestRowText(cardTitle: string, workerId: string): string {
  return `${cardTitle} · w:${workerId.slice(0, 8)} · awaiting review`;
}
