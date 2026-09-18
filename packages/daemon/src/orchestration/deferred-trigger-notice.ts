import type { Db } from "../db.js";

/**
 * Card 74716cfb: builds the `[loom:deferred-trigger]` notice appendix for a settled gate run's
 * `run-summary.failedNames` (see `gate-timing-band.ts`'s `readFailedNamesForOp`, the caller-side reader
 * of this join key), when any task on the project has annotated itself
 * `deferredUntilEvent.kind === "gate-fail-naming"` naming one of those exact files
 * (`Task.deferredUntilEvent`'s own doc has the full contract — this NEVER auto-clears the deferral, it
 * only ANNOTATES, and the notice below is a POINTER, never an excerpt of the card's own `deferredReason`).
 *
 * Returns `""` — never appended — when there's nothing to report (no `failedNames`, or no task names a
 * match), so a card with no `deferredUntilEvent` set sees a BYTE-IDENTICAL nudge, and a card whose
 * `deferredUntilEvent` names a DIFFERENT file is likewise untouched.
 *
 * ⚠️ WIRE THIS AT BOTH gate-outcome nudge composition sites in `sessions/service.ts`
 * (`[loom:merge-rejected]` and `[loom:gate-failed]`) — the card's own binding constraint: a partial
 * rollout to only one of the two sibling nudges is the exact failure this mechanism exists to prevent.
 *
 * @decision 74716cfb — reads `db.listTasks`, the plain read every other board tool already uses,
 * rather than a bespoke query: this only ever runs on a gate failure, never a hot path.
 *
 */
export function deferredTriggerNotice(db: Db, projectId: string, failedNames: string[] | undefined): string {
  if (!failedNames || failedNames.length === 0) return "";
  const matches = db.listTasks(projectId).filter(
    (t) => t.deferredUntilEvent?.kind === "gate-fail-naming" && failedNames.includes(t.deferredUntilEvent.key),
  );
  if (matches.length === 0) return "";
  return matches
    .map((t) =>
      `\n[loom:deferred-trigger] this red names ${t.deferredUntilEvent!.key}; card ${t.id} is deferred ON THIS EXACT EVENT. ` +
      "Read its deferredReason IN FULL before attributing (a red naming a listed file is not itself a specimen), " +
      "and capture the tail NOW — gate-output/ is pruned in ~20 min.",
    )
    .join("");
}

/**
 * Card f75a2202: the `kind:"request-answered"` sibling of {@link deferredTriggerNotice} above, keyed on
 * a Request (Question) id instead of a failed test-file name — see `Task.deferredUntilEvent`'s own doc
 * for the full "never auto-clears, this is a POINTER" contract. Returns `""` when nothing matches a task
 * whose `deferredUntilEvent.kind === "request-answered"` names this exact `questionId`. Wired at every
 * site that pushes a "your question was answered" nudge to the asker (`gateway/server.ts`'s answer
 * route; `companion/capabilities.ts`'s two `decision_resolve` commit paths) — never `question_resolve`
 * (`mcp/questionTool.ts`), which pushes no nudge of its own to append to.
 */
export function requestAnsweredTriggerNotice(db: Db, projectId: string, questionId: string): string {
  const matches = db.listTasks(projectId).filter(
    (t) => t.deferredUntilEvent?.kind === "request-answered" && t.deferredUntilEvent.key === questionId,
  );
  if (matches.length === 0) return "";
  return matches
    .map((t) =>
      `\n[loom:deferred-trigger] request ${questionId} was just answered; card ${t.id} is deferred ON THIS EXACT REQUEST. ` +
      "Read its deferredReason IN FULL before releasing anything — this is a POINTER, never proof the card should be released.",
    )
    .join("");
}
