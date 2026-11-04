// Derivations for the project node's Overview — card 269f46ef, the owner's "C · Roster" pick.
//
// Same rule as lib/atlasHome.ts, which these sit beside: every figure is COMPOSED CLIENT-SIDE from
// calls lib/api.ts already exposes. This card added no `api.ts` member and no request — the two facts
// that are new TO THIS PAGE (which card a session is holding, and when it last said anything) both
// come off rows ProjectHome already has in hand (`Session.taskId` + the board roll-up's own task list;
// `api.orchestrationEvents` per manager, which the Pulse feed already assembles).
//
// Pure functions only, so the table's rows and the counts stated above them are derived once and
// cannot disagree — and so they can be asserted without a DOM (packages/web/test/atlas-project-
// overview.mjs). Nothing here is shared with the WORKSPACE node: it keeps its five-panel band.
import type { OrchestrationEvent, SessionListItem } from "@loom/shared";

/** One row of the work-in-flight table: a session, plus whether it is nested under its manager. */
export interface RosterRow {
  session: SessionListItem;
  /** True for a worker drawn under the manager that owns it — the table's one level of indent. */
  child: boolean;
}

/**
 * The managers→workers hierarchy, flattened to table rows in the SAME order `FleetList` drew it in
 * the band panel this table replaces: each manager, then its own workers, then every worker whose
 * parent is not in this set.
 *
 * The INPUT set is deliberately identical to that panel's too — every non-archived manager and
 * worker, not only the live ones. "Work in flight" is the card's name for the surface, but dropping
 * an exited-and-unarchived session would lose a row the Overview shows today, and its state pill
 * says `exited` in plain words. The card's own footer names that so the label cannot mislead.
 */
export function rosterRows(
  managers: readonly SessionListItem[],
  workers: readonly SessionListItem[],
): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const m of managers) {
    rows.push({ session: m, child: false });
    for (const w of workers) {
      if (w.parentSessionId === m.id) rows.push({ session: w, child: true });
    }
  }
  for (const w of workers) {
    if (!managers.some((m) => m.id === w.parentSessionId)) rows.push({ session: w, child: false });
  }
  return rows;
}

/**
 * The most recent orchestration event ATTRIBUTABLE to each session, keyed by session id.
 *
 * The two roles resolve differently and that is the point: a WORKER's row wants the last event about
 * that worker (`workerSessionId`), while a MANAGER's wants the last event it filed at all — which
 * includes the ones it filed about its workers, since dispatching one is the manager saying
 * something. A single map keyed only on `workerSessionId` would leave every manager row blank.
 *
 * `events` is expected NEWEST-FIRST (the order ProjectHome's Pulse feed already sorts into), so the
 * first hit for a key wins; a caller handing them in another order gets that order's first hit, not
 * a silently wrong "latest".
 */
export function lastEventBySession(
  events: readonly OrchestrationEvent[],
): Map<string, OrchestrationEvent> {
  const out = new Map<string, OrchestrationEvent>();
  for (const e of events) {
    if (e.workerSessionId && !out.has(e.workerSessionId)) out.set(e.workerSessionId, e);
    if (!out.has(e.managerSessionId)) out.set(e.managerSessionId, e);
  }
  return out;
}

/** Card titles by id, off the board roll-up's own task list — so the Card column costs no request. */
export function taskTitlesById(
  tasks: readonly { id: string; title: string }[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tasks ?? []) out.set(t.id, t.title);
  return out;
}

/**
 * What the Card cell shows for one session: the title of the card it holds, else its own generation
 * readout, else nothing.
 *
 * A worker ALWAYS carries a `taskId`; a manager generally does not, so the fallback is the same
 * `gen N · M turns` pair the session node's head pill states (components/SessionNode.tsx) rather
 * than an em dash that would read as "this session is doing nothing". A `taskId` whose title has not
 * arrived (the board query still in flight, or a card archived out of the board) falls back to the
 * short id, never to a blank cell — the session genuinely IS holding a card.
 */
export function rosterCardLabel(
  s: Pick<SessionListItem, "taskId" | "gen" | "ctxTurns">,
  titles: Map<string, string>,
): { text: string; muted: boolean } | null {
  if (s.taskId) {
    const title = titles.get(s.taskId);
    return { text: title ?? s.taskId.slice(0, 8), muted: !title };
  }
  const parts: string[] = [];
  if (s.gen) parts.push(`gen ${s.gen}`);
  if (s.ctxTurns) parts.push(`${s.ctxTurns} turn${s.ctxTurns === 1 ? "" : "s"}`);
  return parts.length > 0 ? { text: parts.join(" · "), muted: true } : null;
}
