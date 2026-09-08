import { resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Card 0ad1ca68 — SPAWN-policy gate (deliberately NOT a nudge-policy change; idle-watcher.ts's own
 * `nonTerminal`/`openCards` predicate at :266-487 is untouched and stays the source of truth for
 * whether a LIVE manager gets idle-nudged). This is the pre-spawn analogue: before the Scheduler boots
 * a FRESH manager seat, ask whether the project's board is already known to be fully gated on an
 * unanswered owner Request — if so, an identical seat would just re-derive the same "0 actionable"
 * conclusion a predecessor seat already reached, burning a full context window for zero commits (the
 * card's own specimen: session `9d141891`, ~290 turns, zero product change).
 *
 * 🔴 CRITICAL GUARDRAIL (carried verbatim from the card, doubled by two prior Leads before this):
 * suppression is gated on an ACTUAL pending owner Request existing for this project, NEVER on
 * "0 actionable cards" alone. A board can read 0-actionable for reasons that have nothing to do with
 * the owner (every card manually deferred pending a sibling task, a lull between cards) — those cases
 * must still get a fresh seat, because nothing else will ever re-check them. Only a genuinely
 * owner-gated board — where the ONLY way forward is the owner answering something already sitting in
 * their inbox — is safe to defer, because the owner's own answer already re-arms things (a stale-request
 * escalation, per `65ecafb3`, or the answer itself waking whoever asks next).
 */
export function isProjectGatedOnPendingOwnerRequest(db: Db, projectId: string): boolean {
  try {
    // The blocking condition itself: at least one still-open (pending) owner-facing Request tied to
    // this project. Project-scoped rather than per-task — an owner "decision" Request is very often
    // filed with taskId:null (mirrors hasPendingQuestionForSession's own rationale in db.ts), so a
    // per-card-only check would miss exactly the shape the card's own specimen (request `54797043`) is.
    const pendingProjectRequests = db.listQuestionsForAudit({ projectId, state: "pending" });
    if (pendingProjectRequests.length === 0) return false;

    const project = db.getProject(projectId);
    if (!project) return false; // unknown project → never claim it's gated (fail toward spawning)
    const cols = resolveConfig(project.config).kanbanColumns;
    const terminalKey = columnKeyForRole(cols, "terminal");
    const reviewKey = columnKeyForRole(cols, "review");
    const excludedColumnKeys = new Set(cols.filter((c) => c.excludeFromIdleWatchdog === true).map((c) => c.key));

    const nonTerminal = db.listTasks(projectId).filter((t) => t.columnKey !== terminalKey);

    // A review-lane card is independently actionable by a fresh manager (go merge it) even though it's
    // blocked from ordinary dispatch — same carve-out idle-watcher's own `hasReviewCards` makes. Its mere
    // presence means there IS something a new seat could usefully do, so never suppress.
    if (nonTerminal.some((t) => t.columnKey === reviewKey)) return false;

    // Batched pending-question lookup (mirrors idle-watcher's own a193398f batching) — one query for the
    // whole project instead of one per card, including the legacy 8-char task_id PREFIX linkage.
    const pendingQuestionTaskIds = db.listPendingQuestionTaskIds(projectId);
    const pendingLegacyPrefixes = [...pendingQuestionTaskIds].filter((id) => id.length === 8);
    const hasPendingQuestion = (taskId: string): boolean =>
      pendingQuestionTaskIds.has(taskId) || pendingLegacyPrefixes.some((p) => taskId.startsWith(`${p}-`));

    // Same "genuinely actionable" definition idle-watcher's `openCards` uses (minus the platform/parked
    // exclusion — this gate only ever runs ahead of a "manager"-kind schedule fire, never a platform Lead
    // spawn, so that carve-out doesn't apply here): not held, not deferred (unless stuck), not in review,
    // not in a dead-end lane, and not itself blocked on its own pending Request.
    const openCards = nonTerminal.filter((t) =>
      t.held !== true
      && (t.deferred !== true || t.deferredStuck === true)
      && t.columnKey !== reviewKey
      && !excludedColumnKeys.has(t.columnKey)
      && !hasPendingQuestion(t.id),
    );
    return openCards.length === 0;
  } catch {
    return false; // defensive: a read fault must never silently suppress a real spawn
  }
}
