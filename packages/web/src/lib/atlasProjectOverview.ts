// Derivations for the project node's Overview — card 269f46ef, the owner's "C · Roster" pick.
//
// Same rule as lib/atlasHome.ts, which these sit beside: every figure is COMPOSED CLIENT-SIDE from
// calls lib/api.ts already exposes. This card added no `api.ts` member and no request — the two facts
// that are new TO THIS PAGE (which card a session is holding, and when it last said anything) both
// come off rows ProjectHome already has in hand (`Session.taskId` + the board roll-up's own task list;
// `api.orchestrationEvents` per manager, which the Pulse feed already assembles).
//
// Pure functions, so the table's rows and the counts stated above them are derived once and cannot
// disagree — and so they can be asserted without a DOM (packages/web/test/atlas-project-
// overview.mjs). The two storage helpers at the very bottom are the only impure part, and they
// exist so the preference's key shape has exactly one home — the same split, for the same reason,
// as lib/terminalLayout.ts. Nothing here is shared with the WORKSPACE node: it keeps its
// five-panel band.
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
 * parent is not in this set — and then, as a tail of unindented rows, every OTHER session the
 * caller hands in.
 *
 * The manager/worker INPUT set is deliberately identical to that panel's — every non-archived
 * manager and worker, not only the live ones. "Work in flight" is the card's name for the surface,
 * but dropping an exited-and-unarchived session would lose a row the Overview shows today, and its
 * state pill says `exited` in plain words. The card's own footer names that so the label cannot
 * mislead.
 *
 * ⭐ `others` IS THE REST OF THE FLEET, AND IT IS NOT OPTIONAL (card 6a9cb96a, an owner bug report:
 * a live Thought Partner session was listed nowhere on this card). A project's sessions are not
 * only managers and workers — an ideation/thought-partner rig and the Companion both run as
 * `role:"assistant"`, an Agent Run as `role:"run"`, and
 * a plain terminal carries no role at all. Every one of them is a session this project is running,
 * counted by the card's own head (`N live`), and before this card every one of them was dropped
 * here — so the head stated a population the table below it could not list, which is exactly the
 * disagreement card 9b6be377 was filed against.
 *
 * They are appended LAST and never indented: `child` is "a worker drawn under the manager that owns
 * it", so nothing outside that relationship may claim it, and keeping the manager/worker hierarchy
 * contiguous leaves the card's spine where every existing reader already found it.
 *
 * @decision 6a9cb96a — never give `others` an `= []` default or an internal `?? []`. A caller that
 * then forgets the population compiles clean and states a short fleet, which reads exactly like a
 * project with nothing else running.
 */
export function rosterRows(
  managers: readonly SessionListItem[],
  workers: readonly SessionListItem[],
  others: readonly SessionListItem[],
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
  for (const s of others) rows.push({ session: s, child: false });
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

// ── Which agents' sessions the roster lists (card effd47d5) ───────────────────────────────────
//
// The owner's own words, under Projects › Overview: "Optionaly show either only tarminals of
// spawnable agents or teminals of all running agents. Adjustable by user preference."
//
// 🔴 "SPAWNABLE" HAS EXACTLY ONE DEFINITION IN THIS APP AND THIS IS NOT A SECOND ONE. It is
// `splitRoster`'s (lib/atlasAgents.ts): an agent whose bound rig's role is not `worker` — the ones a
// human may start by hand, as against the worker rigs a manager dispatches. That file's own header
// states why there is one derivation ("so the three can never disagree about which agent is
// spawnable"), and the Agents tab already states the split in words ("3 you spawn, 2 your manager
// dispatches"), so this filter takes that set as an ARGUMENT rather than re-deriving the predicate
// from a session's own `role`. The two agree on every ordinary fleet and diverge exactly where the
// app itself has changed its mind — an agent re-bound to another rig after its session started — and
// there the one authoritative answer is the one the rest of the UI is already showing.
//
// @decision effd47d5 — never re-derive "spawnable" here from `session.role !== "worker"`; take
// `splitRoster`'s agent set as an argument, or this surface becomes a second definition that drifts
// from the Agents tab silently.

/**
 * Which population this tab lists. `"all"` is the pre-card behaviour and the default.
 *
 * ⭐ ONE PREFERENCE, TWO SURFACES (card 0bcfa530). It governs the work-in-flight roster table AND
 * the Sessions card's terminal list below it. The owner's own sentence asked for one adjustable
 * reading ("Optionaly show either only tarminals of spawnable agents or teminals of all running
 * agents. Adjustable by user preference."), so the two surfaces answer to one control in one place —
 * never a second toggle, and never a second idea of what the chosen reading means.
 */
export type RosterScope = "all" | "spawnable";

/**
 * What a reader with no stored preference sees — and it is `"all"`, the behaviour this page already
 * had, NOT `"spawnable"`.
 *
 * Worth stating because card effd47d5 guessed the other way ("'spawnable agents only' (today's
 * behaviour, confirm first)"). Confirmed against the code it was written about: the table's rows are
 * `rosterRows`' own output over every non-archived manager AND worker — plus, since card 6a9cb96a,
 * every OTHER running session — so the page lists the dispatched workers too. Defaulting to
 * `"spawnable"` would silently hide rows from every existing reader on upgrade, which is a change
 * nobody asked for; the filter is opt-in.
 */
export const DEFAULT_ROSTER_SCOPE: RosterScope = "all";

/**
 * Narrow the roster to one scope.
 *
 * `spawnableAgentIds` is the agent-id set behind `splitRoster(...).spawnable` — or `null` for "not
 * known yet", which is NOT the same as "empty". A caller whose agent/rig reads have not landed must
 * pass `null`: `splitRoster` answers an unloaded agent list with an EMPTY roster, so treating that
 * as the real set would state "no agent you spawn has a session" over a fleet that is merely still
 * loading. `null` lists everything instead, which is the same thing the page shows one tick earlier.
 *
 * ORDER IS PRESERVED and nothing is re-grouped: a kept row sits where `rosterRows` put it. The one
 * thing that can change is a row's own INDENT — `child` is the table's single level of nesting, "a
 * worker drawn under the manager that owns it", so a kept row whose manager was filtered out loses
 * it rather than hanging an indent off whatever row happens to precede it now. Reachable, not
 * theoretical: a worker session whose agent is later re-bound to a non-worker rig is spawnable by
 * the definition above while the manager that dispatched it is not.
 *
 * Never mutates `rows` — the caller's array is render state.
 *
 * @decision effd47d5 — never pass an empty set to mean "the agent reads have not landed". `null` is
 * that state; an empty set is the real answer that no agent here is spawnable, and conflating them
 * states an empty fleet over a loading one.
 */
export function filterRosterRows(
  rows: readonly RosterRow[],
  scope: RosterScope,
  spawnableAgentIds: ReadonlySet<string> | null,
): RosterRow[] {
  if (scope === "all" || spawnableAgentIds === null) return rows.slice();
  const kept = rows.filter((r) => scopeAdmitsAgent(r.session.agentId, scope, spawnableAgentIds));
  const keptIds = new Set(kept.map((r) => r.session.id));
  return kept.map((r) => ({
    session: r.session,
    child: r.child && r.session.parentSessionId != null && keptIds.has(r.session.parentSessionId),
  }));
}

/**
 * Does one scope admit one agent — THE predicate, and the only place it is written.
 *
 * Both of this tab's scoped surfaces call it: the roster table through `filterRosterRows` above and
 * the Sessions card's terminal list through `filterScopedSessions` below. Written out once because
 * the two readings of a two-value scope are trivial to re-spell slightly differently (a `=== "all"`
 * forgotten, a `null` conflated with an empty set) and the resulting disagreement is invisible — two
 * surfaces under one control, showing populations that no longer match.
 *
 * `null` means "the agent/rig reads have not landed", which ADMITS everything; see
 * `filterRosterRows` for why that is not the same as an empty set.
 */
export function scopeAdmitsAgent(
  agentId: string,
  scope: RosterScope,
  spawnableAgentIds: ReadonlySet<string> | null,
): boolean {
  if (scope === "all" || spawnableAgentIds === null) return true;
  return spawnableAgentIds.has(agentId);
}

/**
 * The SAME scope filter over a flat session list — the Sessions card's terminal list (card
 * 0bcfa530), which has no manager/worker nesting to repair.
 *
 * That is the whole difference from `filterRosterRows`: a roster row carries an `child` indent that
 * must be demoted when the manager it hangs under is filtered out, and a terminal row carries no
 * such relationship. Order is preserved and the caller's array is never mutated, same as there.
 */
export function filterScopedSessions(
  sessions: readonly SessionListItem[],
  scope: RosterScope,
  spawnableAgentIds: ReadonlySet<string> | null,
): SessionListItem[] {
  return sessions.filter((s) => scopeAdmitsAgent(s.agentId, scope, spawnableAgentIds));
}

/**
 * The storage key. Per PROJECT, like the Sessions tab's own tile layout
 * (lib/terminalLayout.ts `loom.sessionsLayout.<id>`) and in the same `<area>.<field>.<projectId>`
 * shape: which agents are worth watching is a fact about one project's fleet — a project whose work
 * is all dispatched to workers wants the opposite answer from one run by hand.
 */
export function rosterScopeStorageKey(projectId: string): string {
  return `loom.overviewRoster.${projectId}`;
}

/**
 * Read a stored scope back, defensively. Absent, empty, an unknown word, a stale value from an older
 * build, something hand-edited in devtools — every one of them is the default rather than a throw.
 * This is a browser-storage read on a page the reader is trying to use.
 */
export function parseRosterScope(raw: string | null | undefined): RosterScope {
  return raw === "all" || raw === "spawnable" ? raw : DEFAULT_ROSTER_SCOPE;
}

/** Read one project's stored scope. Storage can be unavailable or throw; the default is the answer then. */
export function readRosterScope(projectId: string): RosterScope {
  try { return parseRosterScope(localStorage.getItem(rosterScopeStorageKey(projectId))); }
  catch { return DEFAULT_ROSTER_SCOPE; }
}

/** Persist one project's scope, best-effort. A write that cannot land leaves the in-memory choice. */
export function writeRosterScope(projectId: string, scope: RosterScope): void {
  try { localStorage.setItem(rosterScopeStorageKey(projectId), scope); }
  catch { /* storage unavailable (private mode, blocked site data) — the in-memory state still applies */ }
}
