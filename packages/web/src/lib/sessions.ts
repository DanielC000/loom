import type { Session, SessionListItem, ProcessState, SessionRole } from "@loom/shared";

// The ONE shared session ordering, applied at every session-list tier (Workspace, Terminals,
// Mission Control, the Overview fleet accordion) so a session's place in a list is consistent everywhere.
//
// Order: (1) liveness first — live/starting rank above exited/none; (2) lastActivity DESC — the
// most-recently-active float up; (3) createdAt as a stable tiebreak (spawn order). Applied WITHIN
// each group only — callers preserve the manager→worker hierarchy and never flatten it.
//
// Server-side listChildren stays createdAt-ordered (spawn order is correct for resume/boot); this
// is purely the viewport's presentation order.

/** The minimal session shape this comparator needs — Session and SessionListItem both satisfy it. */
export type SessionOrder = Pick<Session, "processState" | "lastActivity" | "createdAt">;

// Liveness bucket — lower sorts higher. live/starting are "present"; exited/none tie at the bottom.
function livenessRank(state: ProcessState): number {
  return state === "live" || state === "starting" ? 0 : 1;
}

export function bySessionActivity(a: SessionOrder, b: SessionOrder): number {
  const byLiveness = livenessRank(a.processState) - livenessRank(b.processState);
  if (byLiveness !== 0) return byLiveness;
  // ISO-8601 strings compare lexicographically in chronological order; reverse for DESC.
  const byActivity = b.lastActivity.localeCompare(a.lastActivity);
  if (byActivity !== 0) return byActivity;
  return a.createdAt.localeCompare(b.createdAt); // stable spawn-order tiebreak
}

/** The minimal shape the stable comparator needs — Session and SessionListItem both satisfy it. */
export type SessionStableOrder = Pick<Session, "createdAt" | "id">;

/**
 * STABLE newest-first comparator — createdAt DESC, tiebreak id. Unlike bySessionActivity, this key
 * never depends on liveness or lastActivity, so a row keeps its slot whether it's busy or idle and
 * a polling list (Overview, Terminals) never reshuffles between polls. Because createdAt is immutable,
 * DESC is still a STABLE order — newest sessions simply sit at the TOP instead of the bottom, and no
 * row reshuffles between polls. Use this for any tier that must hold position through busy↔idle flips.
 */
export function byCreatedStable(a: SessionStableOrder, b: SessionStableOrder): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** The minimal shape the manager-first comparator needs — role on top of the stable-order fields. */
export type SessionRoleOrder = SessionStableOrder & Pick<Session, "role">;

// Manager bucket — managers rank 0 (first/left), everyone else 1. null/undefined role (plain or
// orphaned sessions) is NOT a manager, so it sinks below the manager(s) in the same group.
function managerRank(role: SessionRole | null | undefined): number {
  return role === "manager" ? 0 : 1;
}

/**
 * Manager-first STABLE comparator for any FLAT grid that mixes a manager with its workers — the
 * Overview `ProjectTerminals` grid and the Terminals-page live grid. Managers sort BEFORE workers
 * (so the orchestrator sits first/left and its workers follow to the right), then byCreatedStable
 * WITHIN each bucket (createdAt DESC, id tiebreak → newest-first, immutable key, no reshuffle on the
 * 3s poll). Use this ONLY where a flat grid must read manager→workers left-to-right; grouped tiers
 * (the fleet accordion, the Terminals manager rows) keep their own nesting and don't need it.
 */
export function byManagerThenCreated(a: SessionRoleOrder, b: SessionRoleOrder): number {
  const byManager = managerRank(a.role) - managerRank(b.role);
  if (byManager !== 0) return byManager;
  return byCreatedStable(a, b);
}

/** The minimal shape the resume gate needs — Session and SessionListItem both satisfy it. */
export type SessionResumeGate = Pick<Session, "processState" | "resumability"> & { archivedAt?: string | null };

/**
 * Whether a session's Resume affordance should show. Auto-archive-on-exit (card b37750a4) stamps
 * archivedAt in the SAME onExit handler that flips processState to "exited", and the rail/god-eye
 * lists (listAllSessions) exclude archived rows outright — so by the time any poll observes a row,
 * gating Resume on `processState === "exited"` alone is already too late: the row either hasn't
 * archived yet (a window of effectively zero) or has archived and vanished from the rail entirely
 * (findings #14/#15). Gate on EITHER signal — still-exited-but-not-yet-archived, OR already
 * archived — so Resume has a durable path through the archive, not just the ephemeral rail window.
 * resume()/resumeSession un-archives + respawns in one call regardless of which state it finds the
 * row in, so both branches call the exact same mutation. Shared by SessionActions and RunHistory so
 * the two surfaces don't drift onto separate resume mechanisms.
 */
export function canResumeSession(s: SessionResumeGate): boolean {
  return (s.processState === "exited" || !!s.archivedAt) && s.resumability !== "dead";
}

// ── The manager go-live guard ──────────────────────────────────────────────────────────────────

/** The minimal shape the go-live guard needs — Session and SessionListItem both satisfy it. */
export type SessionGoLiveSlot = Pick<Session, "processState">;

/**
 * THE GO-LIVE SLOT — whether a session already occupies its agent's one running slot.
 *
 * `live` OR **`starting`**, and the `starting` half is the whole reason this function exists.
 * Every surface that offers a manager go-live control used to ask `processState === "live"` on its
 * own, which is a guard with a hole exactly the width of a spawn's own startup: between the POST
 * and the pty reaching `live` the row sits at `starting`, so the guard read "nothing is live", kept
 * the spawn button enabled, and a second click minted a SECOND manager session. The daemon has no
 * guard of its own here (`SessionService.startNew` inserts a fresh `starting` row for any agent,
 * however many are already running), so this client-side predicate IS the only thing standing
 * between a double-click and two orchestrators on one project.
 *
 * @decision 318b5a21 — never re-spell this test inline. Overview's `AgentControl` and the Atlas
 * roster both call it; a surface that goes back to a bare `=== "live"` reopens the double-spawn.
 */
export function holdsGoLiveSlot(s: SessionGoLiveSlot | null | undefined): boolean {
  return s?.processState === "live" || s?.processState === "starting";
}

/**
 * What the HELD control says once `holdsGoLiveSlot` is holding it. Shared for the same reason the
 * predicate is: a button reading "Live" over a session that is still `starting` states something
 * the guard itself no longer believes, and two surfaces inventing that string separately is how one
 * of them keeps saying it after the other stops.
 */
export function goLiveHeldControl(s: SessionGoLiveSlot): { label: string; title: string } {
  return s.processState === "starting"
    ? { label: "Starting…", title: "Manager is already starting — it holds the go-live slot" }
    : { label: "Live", title: "Manager is already live" };
}

/**
 * The status pill for a session holding the slot. `pending` drives the "work" tone + glow every
 * caller already uses for a busy session: a session mid-startup is transitional in exactly the way a
 * working one is, and it must not borrow the settled green "live" treatment.
 */
export function goLiveSessionPill(s: Pick<Session, "processState" | "busy">): { label: string; pending: boolean } {
  if (s.processState === "starting") return { label: "starting", pending: true };
  return { label: s.busy ? "working" : "live", pending: s.busy };
}

/**
 * Most-recent activity timestamp (epoch ms) across a group's members — for ranking GROUPS (a
 * project lane, a manager's subtree) by their freshest member, so the group you're driving floats
 * up. Empty groups sink (−Infinity). This is the project-tier logic Mission Control had inline.
 */
export function mostRecentActivity(members: readonly SessionOrder[]): number {
  let max = -Infinity;
  for (const m of members) max = Math.max(max, +new Date(m.lastActivity));
  return max;
}

/** The minimal session shape the Terminals-page grouping needs — role + parent + the stable-order keys. */
export type SessionRowMember = SessionRoleOrder & Pick<Session, "parentSessionId">;

/** One rendered row of the Terminals live-sessions grid (see groupSessionRows). */
export type SessionRowGroup<T> = { key: string; kind: "manager" | "orphans" | "standalone"; list: T[] };

/**
 * The Terminals-page manager-centric grouping, extracted here as a PURE function so it can't drift
 * and is hermetically testable (test/sessions.mjs). One ROW per live manager — the manager first, its
 * workers (attached via parentSessionId) to the right in stable order — then two catch-all rows:
 * orphan workers (parent absent from the input — a recycled/stopped manager) and standalone sessions
 * (no role / no parent — plain human sessions, platform leads).
 *
 * COMPANION EXCLUSION (keep it — but it is NOT the security boundary): assistant-role (companion)
 * sessions are dropped HERE, at the grouping source, so a companion never surfaces as a pty tile +
 * STDIN Composer in ANY sub-list (manager row, orphan, standalone) — driven ONLY through /companion.
 * pages/Terminals ALSO excludes them upstream at `live` (keeping them out of the dropdown + counts);
 * this is the belt to that suspenders. What it buys is a UI that doesn't offer a surface the server
 * would refuse: the daemon's own role check on both stdin paths holds that line (anchor below).
 */
export function groupSessionRows<T extends SessionRowMember>(sessions: readonly T[]): SessionRowGroup<T>[] {
  const shown = sessions.filter((s) => !isCompanionSession(s)).slice().sort(byManagerThenCreated);
  const managers = shown.filter((s) => s.role === "manager");
  const managerIds = new Set(managers.map((m) => m.id));
  const workersByParent = new Map<string, T[]>();
  const orphans: T[] = [];
  const standalone: T[] = [];
  for (const s of shown) {
    if (s.role === "manager") continue;
    const pid = s.parentSessionId ?? null;
    if (s.role === "worker" || pid) {
      if (pid && managerIds.has(pid)) (workersByParent.get(pid) ?? workersByParent.set(pid, []).get(pid)!).push(s);
      else orphans.push(s); // parent stopped/recycled or not a live manager — don't drop it
    } else standalone.push(s); // no role / platform lead — its own trailing row
  }
  // `managers` is already in stable createdAt/id order (from `shown`), so the rows are too — no
  // re-sort, and a row holds its slot regardless of activity. Nested workers + the catch-all rows
  // use the same shared stable key (byCreatedStable) so nothing reshuffles on a poll.
  const managerRows: SessionRowGroup<T>[] = managers
    .map((m) => ({ key: m.id, kind: "manager" as const, list: [m, ...(workersByParent.get(m.id) ?? []).slice().sort(byCreatedStable)] }));
  const trailing: SessionRowGroup<T>[] = [];
  if (orphans.length) trailing.push({ key: "__orphans", kind: "orphans", list: orphans.slice().sort(byCreatedStable) });
  if (standalone.length) trailing.push({ key: "__standalone", kind: "standalone", list: standalone.slice().sort(byCreatedStable) });
  return [...managerRows, ...trailing];
}

/** The minimal shape the project-filter option list reads — SessionListItem satisfies it. */
export type SessionProjectNamed = Pick<SessionListItem, "projectName">;

/**
 * The PROJECT options of the live-sessions grid's filter, in the order they are drawn beneath that
 * control's standing "All (N)" entry: deduped and sorted, exactly as the live set alone produced them.
 *
 * `held` is every project name that must stay OFFERED whether or not a live session names it — the
 * scoped project a host pre-selected, and the filter's own current value. Empty and absent entries are
 * dropped rather than drawn as a blank option (`""` is the "All" entry's own value, never a project),
 * so a god-eye mount at rest holds nothing and its list is byte-identical to the old derivation's.
 *
 * @decision d72994d7 — never derive these options from the live sessions alone: a `<select value="X">`
 * with no `X` among its options renders its FIRST one instead, so a quiet scoped project silently
 * reads as "All". Both `held` sources are load-bearing; neither substitutes for the other.
 */
export function projectFilterOptions(
  live: readonly SessionProjectNamed[],
  held: readonly (string | null | undefined)[] = [],
): string[] {
  const names = new Set(live.map((s) => s.projectName));
  for (const name of held) if (name) names.add(name);
  return [...names].sort();
}

/**
 * The COMPANION role. A companion (assistant-role) session is driven ONLY through its chat surface
 * (/companion) — never a raw pty tile + STDIN Composer. See groupSessionRows above, which drops them at
 * the Terminals grouping source, and the two client layers that MIRROR that rule on a rendered terminal
 * (TerminalPane's `disableStdin`/stdin-frame suppression, TerminalCard withholding the Composer).
 *
 * MIRROR, not boundary: these client layers are a UX truth, not the enforcement. The daemon refuses an
 * assistant-role stdin write itself, on BOTH inbound surfaces, and that server check is what actually
 * closes the hole — see isCompanionSession's note below.
 */
export const COMPANION_ROLE = "assistant";

/**
 * THE single companion test — every surface that must treat a companion differently reads it from here
 * rather than hand-rolling `role === "assistant"`, so the four historical spellings of this check can't
 * drift apart (card 5c87f4b6). EIGHT call sites today: seven outside this file (components/Sidebar,
 * components/TerminalCard, lib/atlasHome, lib/companionGuard, lib/workspaceSessions, pages/Terminals,
 * pages/WorkspaceHome) plus `groupSessionRows` ABOVE in this same file — a grep run outside lib/sessions
 * misses that eighth one, so don't take a seven-site count from such a sweep as complete (card f899381b).
 *
 * THE ASSISTANT ROLE *IS* THE COMPANION IDENTITY — server-enforced, not a client-side proxy for some
 * narrower "is it chat-bound" fact: the daemon composes the companion base brief into every assistant
 * spawn AND resume, refuses stdin on BOTH inbound surfaces, and gates the companion MCP levers on that
 * same role. There is no supported "assistant-role but not a companion" session for this to tell apart,
 * and a chat BINDING is a narrower question (is it reachable yet), never a different identity.
 * @decision 018ce1db — never treat this client-side exclusion as the security boundary: the server-side
 * role refusal on `POST /api/sessions/:id/input` and `/ws/term`'s stdin is what closes the escalation
 * path, so widening this predicate cannot make such a session writable — only a UI that lies about it.
 *
 * FAIL-SAFE SHAPE — read this before "fixing" it: the argument is deliberately wide (an optional session,
 * an optional role) and an UNKNOWN role answers **false** (not a companion). That is correct, not an
 * oversight: a raw SHELL terminal is not a DB Session at all and legitimately has no role (Terminals.tsx
 * `ShellTile` passes a bare `{ id }`), and a shell MUST keep taking keystrokes. Answering `true` for an
 * absent role would make every shell — and any caller that simply hasn't got the field — read-only, which
 * is the over-broad failure this card's DoD explicitly guards against. Callers that need fail-CLOSED
 * behaviour for a real session get it by resolving the role from the session store instead of trusting a
 * caller-supplied prop (see lib/companionGuard.ts), which is a lookup no caller can omit.
 */
export function isCompanionSession(s: { role?: SessionRole | null } | null | undefined): boolean {
  return s?.role === COMPANION_ROLE;
}

/** A card title as a narrow row wants it: the Conventional Commits `type(scope): ` lead dropped. */
export function shortCardTitle(title: string): string {
  return title.replace(/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s+/, "").trim() || title;
}

/**
 * What tells two same-named session rows apart (card eb516fba, audit B-22): two workers of one agent
 * both read "Dev" in the tree, with only their context % to choose between them.
 *
 * Only a session whose agent name REPEATS among `sessions` gets a suffix, so a branch of distinct
 * agents keeps its rows exactly as they were. The suffix is the most human answer available: the
 * card the session is working (its title, without the commit-type lead), else its own branch's tail,
 * else its short id — the same 8 characters the session node's head and every terminal tile show.
 */
export function sessionRowSuffixes(
  sessions: readonly Pick<SessionListItem, "id" | "agentName" | "taskId" | "branch">[],
  cardTitles: ReadonlyMap<string, string>,
): Map<string, string> {
  const byName = new Map<string, number>();
  for (const s of sessions) byName.set(s.agentName, (byName.get(s.agentName) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const s of sessions) {
    if ((byName.get(s.agentName) ?? 0) < 2) continue;
    const title = s.taskId ? cardTitles.get(s.taskId) : undefined;
    const branchTail = s.branch ? s.branch.replace(/^.*\//, "").slice(0, 8) : "";
    out.set(s.id, title ? shortCardTitle(title) : branchTail || s.id.slice(0, 8));
  }
  return out;
}

/**
 * A model id as a reader wants it: `"claude-opus-4-8[1m]"` → `"opus-4-8[1m]"`. Drops the vendor
 * prefix only — the tail is the part that distinguishes one model from another, and a window
 * suffix is part of it.
 *
 * It lives HERE, in the shared session lib, rather than beside either of its two readers, because
 * both answer the same question in two places — pages/Usage.tsx's per-session table, and the Atlas
 * Agents card's `ENGINE` fact (card 699fe92a). Two copies of one `replace` is exactly how a display
 * rule drifts silently; this one is three lines, so there is no reason for a second.
 */
export function shortModel(model?: string | null): string {
  if (!model) return "—";
  return model.replace(/^claude-/i, "");
}
