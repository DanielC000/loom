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
 * Reads `db.listTasks` (the plain project-scoped read every other board tool already uses) rather than a
 * bespoke query — this only ever runs on a gate FAILURE, never a hot path, and a project's
 * `deferredUntilEvent`-carrying cards are expected to be a small minority of its board.
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
