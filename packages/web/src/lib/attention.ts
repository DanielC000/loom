import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent, BrowserNotificationKind } from "@loom/shared";
import { api } from "./api";
import { activeBootStuckAlerts, activeCodexIsolationGapAlerts, activeCrashLoopAbandonments, activeRecycleLineageConsolidatedAlerts, activeVaultLockAlerts, buildLatestMergeMap, hasSupervisedWorkers, isActiveWaitingSnooze, isRateLimited, isStuckBusy } from "./fleet";
import { decisionAttentionText, requestAttentionLabel } from "./questions";
import type { Tone } from "../theme";

// isRateLimited / isStuckBusy (+ its exclusion helpers) moved to lib/fleet.ts (a JSX-free, runtime-
// relative-import-free module the hermetic fleet test can load); re-exported here so their existing
// importers keep resolving them from lib/attention.
export { isRateLimited, isStuckBusy };

// Centralized "things needing a human" derivation, shared by Mission Control's attention queue and
// the shell bell. Built from the already-polled sessions + per-manager events (react-query dedups
// the network calls by key), so it needs no extra backend.

// Crash-recovery give-up: the CrashRecoveryWatcher hit its auto-resume cap (crashRecoveryMaxAttempts) for a
// session that kept re-dying, so it STOPPED resuming and stamped this crash-loop banner on lastError. A
// role-agnostic, session-row signal (NOT an event) so it surfaces even for a dead MANAGER, which has no
// live parent whose event stream the attention queue reads (parity with how RATE-LIMITED surfaces).
const CRASH_LOOP_PREFIX = "[loom:crash-loop]";
export function isCrashLooped(s: SessionListItem): boolean {
  return s.processState === "exited" && !!s.lastError && s.lastError.startsWith(CRASH_LOOP_PREFIX);
}

// Orphaned-fleet strand (card 6cd3ce9e): a manager/platform exited while it still owned ≥1 LIVE worker/
// child session — SessionService.archiveOnExit skipped the archive (the row stays exited-but-visible) and
// stamped this banner on lastError instead. Exact parallel of isCrashLooped above, for the exact same
// reason: a dead manager has no live parent whose event stream the attention queue reads (the manager_
// exited_with_live_workers event it ALSO files is real audit trail, but useAttention only fetches
// orchestration events for LIVE managers — see the `managers` filter below), so the role-agnostic,
// session-row lastError signal is what makes this reach the queue/bell at all.
const ORPHANED_FLEET_PREFIX = "[loom:orphaned-fleet]";
export function isOrphanedFleet(s: SessionListItem): boolean {
  return s.processState === "exited" && !!s.lastError && s.lastError.startsWith(ORPHANED_FLEET_PREFIX);
}

// User-dismissable attention items (STUCK-BUSY only) carry a `dismissKey` — see the dismiss store
// below. Keyed on `${sessionId}:${lastActivity}`, NOT the session id alone: lastActivity is frozen
// for the duration of one stuck episode (so a dismiss sticks for THIS episode), but advances the
// moment the session acts again (so a fresh stuck episode re-surfaces instead of being suppressed
// forever). Only an item with a dismissKey is dismissable; the actionable kinds deliberately have none.
const DISMISS_STORAGE_KEY = "loom.attention.dismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DISMISS_STORAGE_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

// Module-level store so every useAttention instance (bell, Mission Control, Overview, command palette,
// the toast/notification signal) reflects a dismiss the instant it happens — a per-hook useState would
// leave the other surfaces stale until their next poll. useSyncExternalStore subscribes them all.
let dismissedSet = loadDismissed();
let dismissedSnapshot: readonly string[] = [...dismissedSet];
const dismissListeners = new Set<() => void>();

function persistDismissed() {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify([...dismissedSet]));
  } catch {
    /* localStorage unavailable (private mode / quota) — dismiss still holds for this session */
  }
  dismissedSnapshot = [...dismissedSet]; // new identity so useSyncExternalStore re-renders subscribers
  for (const l of dismissListeners) l();
}

export function dismissAttention(dismissKey: string): void {
  if (dismissedSet.has(dismissKey)) return;
  dismissedSet = new Set(dismissedSet).add(dismissKey);
  persistDismissed();
}

// Drop stored dismiss keys that are no longer derivable from a live STUCK-BUSY session (it recovered,
// exited, or acted again → a new key), so localStorage can't grow unbounded. Callers pass the set of
// currently-derivable keys; pruning is gated on real session data upstream so a transient empty poll
// can't wipe a still-valid dismiss.
function pruneDismissed(derivable: Set<string>): void {
  const next = new Set<string>();
  for (const k of dismissedSet) if (derivable.has(k)) next.add(k);
  if (next.size === dismissedSet.size) return; // nothing pruned → no churn
  dismissedSet = next;
  persistDismissed();
}

function useDismissedSet(): Set<string> {
  const snap = useSyncExternalStore(
    (cb) => { dismissListeners.add(cb); return () => dismissListeners.delete(cb); },
    () => dismissedSnapshot,
    () => dismissedSnapshot,
  );
  return useMemo(() => new Set(snap), [snap]);
}

// Card 51a80b4d — the display copy for the browser-notification toggles, a TOTAL record over the shared
// `BrowserNotificationKind` domain. Total on purpose: adding an id to `BROWSER_NOTIFICATION_KINDS`
// (packages/shared/src/config.ts) without adding its label here is a COMPILE error, and a builder below
// cannot set a `notify` outside that domain either — so the Settings list can't drift from what actually
// fires in EITHER direction. `kind` (the free-form display string in the toast title) stays separate:
// several kinds share one notification category, and the Request kinds vary their label by type/state.
export const BROWSER_NOTIFICATION_LABELS: Record<BrowserNotificationKind, { label: string; hint: string }> = {
  "request": { label: "Pending requests", hint: "A manager is waiting on you — a decision, an answer, an authorization, or a secret. Covers stale and orphaned requests too." },
  "merge-request": { label: "Merge request", hint: "A worker finished and its branch is waiting for your review." },
  "boot-stuck": { label: "Boot stuck", hint: "A session never reached ready after spawning." },
  "manager-asleep": { label: "Manager asleep", hint: "A manager went idle with work still on its board." },
  "queue-drained": { label: "Queue drained", hint: "A manager ran out of dispatchable work." },
  "context-overflow": { label: "Context overflow", hint: "A manager is close to filling its context window." },
  "vault-lock-stuck": { label: "Vault lock stuck", hint: "A vault commit lock has been held too long." },
  "codex-isolation-gap": { label: "Codex isolation gap", hint: "A codex session's sandbox could not be confirmed." },
  "give-up-recovery": { label: "Give-up recovery", hint: "Loom stopped retrying a message delivery into a session." },
  "quiet-board": { label: "Quiet board", hint: "A manager's board has gone quiet with nothing in flight." },
  "rate-limited": { label: "Rate limited", hint: "A session hit the model provider's rate limit." },
  "stuck-busy": { label: "Stuck busy", hint: "A session has been mid-turn far longer than expected." },
  "crash-looped": { label: "Crash looped", hint: "A session kept dying and auto-resume gave up on it." },
  "orphaned-fleet": { label: "Orphaned fleet", hint: "A worker outlived the manager that dispatched it." },
  "recycle-lineage-consolidated": { label: "Recycle lineage consolidated", hint: "A halted recycle's successor died too; its fleet was consolidated back onto the predecessor with no automatic owner." },
};

/**
 * Card 51a80b4d — the human's muted browser-notification categories, read LIVE off the RESOLVED platform
 * group (never the raw override, and never an ad-hoc default here: `resolveConfig` on the daemon side is
 * the one resolution mechanism, and this reads its output). Shares the `["platformConfig"]` query key
 * with the Settings page, so react-query dedups the fetch and Settings' own save-invalidation refreshes
 * this immediately — no second poll and no restart. While the config is still loading, or if the read
 * fails, the set is EMPTY: the fail-open direction is "still notify", because losing an alert the human
 * asked to keep is worse than one extra ping they asked to mute.
 */
export function useMutedBrowserNotifications(): Set<BrowserNotificationKind> {
  const cfg = useQuery({ queryKey: ["platformConfig"], queryFn: () => api.getPlatformConfig() });
  const muted = cfg.data?.resolved.mutedBrowserNotifications;
  return useMemo(() => new Set(muted ?? []), [muted]);
}

export interface AttentionItem {
  key: string;
  tone: Tone;
  kind: string;
  // Card 51a80b4d — which browser-notification toggle governs this item's desktop `Notification`.
  // REQUIRED, and typed to the shared domain, so a new item builder cannot ship a kind that silently
  // escapes the Settings toggles (the structural half of this feature; see BROWSER_NOTIFICATION_LABELS
  // above). Several display `kind`s map to one `notify` — every Request presentation is `"request"`, and
  // both CRASH-LOOPED builders are `"crash-looped"`. Governs the browser Notification ONLY: the on-screen
  // toast stack and the pending-Request count pill ignore it entirely.
  notify: BrowserNotificationKind;
  text: string;
  // Set on a user-dismissable kind — STUCK-BUSY (`${sessionId}:${lastActivity}`) and CODEX ISOLATION GAP
  // (`${agent}:${itemsKey}`, card ed0858dc). Its presence is what makes a row dismissable (AttentionRow
  // renders × off it); the actionable kinds leave it unset.
  dismissKey?: string | null;
  // The hover title for the × affordance. Optional because the wording is kind-specific ("until the
  // session acts again" is true of STUCK-BUSY only); omitted ⇒ AttentionRow keeps its STUCK-BUSY default.
  dismissHint?: string | null;
  // Card ed0858dc — the full detail behind a row whose one-line `text` can only carry a summary (the
  // isolation-gap `reason` strings are paragraph-length). Rendered as the row's `title`, i.e. on hover;
  // never a substitute for `text`, which must stand alone for a reader who never hovers.
  hoverText?: string | null;
  // STRICTLY a merge-review worker — set ONLY on MERGE REQUEST, whose branch diff opens in the review
  // panel (/review/:workerSessionId). Do NOT overload it as a generic session pointer (it once routed
  // every non-merge alert to a "No diff" merge page — card a16dfafb); use `sessionId` for those.
  workerSessionId?: string | null;
  // The session this NON-merge alert is ABOUT — STUCK-BUSY / CRASH-LOOPED (the session itself) or
  // MANAGER ASLEEP / QUEUE DRAINED / CONTEXT OVERFLOW (the manager session). Its "Open"
  // affordance deep-links to that session's view (/session/:sessionId), NOT the merge panel.
  sessionId?: string | null;
  rateLimitSessionId?: string | null; // when set, the row offers a "clear / retry now" action (POST .../rate-limit/clear)
  // Set ONLY on a pending/orphaned request item (a manager→human Request of ANY type — decision, input,
  // permission, credential). Its "Answer →" affordance opens the answer page (/question/:id); the row
  // also renders a PENDING state chip off this presence. This is the structural "is a request" check —
  // prefer it over comparing `kind` to a literal label, since the label itself is now type-varying.
  questionId?: string | null;
  // Card 889ae619 (iii-a) — set ONLY on the DECISION STALE branch (a pending Request whose `escalatedAt`
  // is set and isn't currently snoozed): the Snooze affordance's presence check. Deliberately a SEPARATE
  // field from `questionId` (which is also set on the cyan/amber branches, where there's nothing stale to
  // suppress) rather than re-deriving "is this the stale row" from `tone`/`kind` at render time.
  staleQuestionId?: string | null;
  // Card 5ced500b — the project this item belongs to, set HERE (at the source) whenever the row the item
  // was built from already carried one: a Request's own `projectId`, a vault-lock event's
  // `detail.projectId`, or the session row a session-derived kind was iterated from. AUTHORITATIVE for the
  // project-scoped readers — `resolveAttentionProjectId` (lib/fleet.ts) returns it without consulting any
  // session lookup, so a project-scoped surface shows the item even when its session has been ARCHIVED and
  // is therefore absent from the live feed. Left unset for a kind whose source genuinely doesn't know
  // (today: CODEX ISOLATION GAP, which falls back to `agentId` below).
  projectId?: string | null;
  // Card 5ced500b — the AGENT this item is about, the fallback project key for a kind whose source row
  // carries no project id. Agents are project-scoped in Loom, so a project-scoped reader holding an
  // agent↦project map can resolve the item from this alone, which is what keeps a CODEX ISOLATION GAP
  // visible after its short-lived run session has archived out of every bounded session page. Purely a
  // resolution hint — nothing renders off it.
  agentId?: string | null;
}

// The deep-link an attention item's "Open" affordance targets, or null if it has none. A MERGE REQUEST
// opens the merge-review panel (its worker branch diff); every other openable kind opens the SESSION the
// alert is about (its live terminal, or an exited-session panel). Single-sourced so the Mission Control /
// Overview rows, the toast, and the command palette can't drift on where "Open" goes (card a16dfafb).
export function attentionOpenTarget(item: AttentionItem): string | null {
  if (item.kind === "MERGE REQUEST") return item.workerSessionId ? `/review/${item.workerSessionId}` : null;
  // A pending/orphaned request item is the only kind that carries a questionId (any type — decision,
  // input, permission, credential — so this is structural, not a hardcoded "DECISION" kind string).
  if (item.questionId) return `/question/${item.questionId}`;
  return item.sessionId ? `/session/${item.sessionId}` : null;
}

export function useAttention(): { items: AttentionItem[]; count: number; resolved: boolean } {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const all = sessions.data ?? [];
  // Manager→human DECISION INBOX (card 8701bdbb): the GLOBAL "waiting on me" queue. A PENDING question is
  // ONE attention item (tone cyan — the signed "actionable question" color); it clears the instant the
  // human answers it (state → 'answered', dropped server-side from the pending set). Same shared query
  // key as the inbox page/bell, so react-query dedups the poll.
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 3000 });
  // LIVE managers only: an EXITED manager has no actionable merge/idle state (it's gone), so its
  // events (e.g. an orphaned merge_request whose merge_done was never recorded) must not surface as
  // permanent attention items. Only a live manager's pending reviews / idle states are actionable.
  const managers = all.filter((s) => s.role === "manager" && s.processState === "live");

  // Card b1da256d (ported from e2a3c613's round 2-3 draft, cut at round 4): a boot-dialog-stuck session
  // with NO live parent to notify files its own `claude_boot_dialog_stuck` event under
  // `s?.parentSessionId ?? sessionId` — WHICHEVER manager was live at the moment it got stuck, a value
  // that is never rewritten later.
  // @decision 43084723 — never re-add a per-manager fan-out for these two kinds; it made a worker's
  // unresolved event unreachable the moment its FILING manager stopped being live (e.g. recycled).
  const bootStuckEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "claude_boot_dialog_stuck", "claude_boot_dialog_resolved"],
    queryFn: () => api.orchestrationEventsByKinds(["claude_boot_dialog_stuck", "claude_boot_dialog_resolved"]),
    refetchInterval: 4000,
  });
  const bootStuckEvents = bootStuckEventsQuery.data ?? [];

  // Card 227d9f0b: a stale vault .git/index.lock alert is filed `managerSessionId:""` (daemon-global — no
  // session owns a vault watcher), so it can never be attributed to any live manager's own event stream
  // (the `eventQueries` fan-out below) — same reason `claude_boot_dialog_stuck` above gets its own
  // dedicated kind-filtered query rather than feeding `allEvents`.
  // Round 2: also fetches the paired `vault_index_lock_cleared` kind so `activeVaultLockAlerts` (lib/fleet.ts,
  // mirroring `activeBootStuckAlerts`) can drop an item once a later clear supersedes it, instead of
  // persisting until a NEWER stale episode for the same repo replaces it (decision 227d9f0b's round-2
  // section — this superseded round 1's "no cleared counterpart" call).
  const vaultLockEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "vault_index_lock_stale", "vault_index_lock_cleared"],
    queryFn: () => api.orchestrationEventsByKinds(["vault_index_lock_stale", "vault_index_lock_cleared"]),
    refetchInterval: 15000,
  });
  const activeVaultLocks = activeVaultLockAlerts(vaultLockEventsQuery.data ?? []);

  // Card ed0858dc — a codex session's DROPPED claude-side isolation/permission protections. The daemon
  // files this row on every codex spawn but nudges a recipient only when the session HAS a parent, so a
  // PARENTLESS one (every agent run) reached nobody at all. Its own kind-filtered query for the same
  // reason as the two above: the row is filed under `parentSessionId ?? sessionId`, so a per-manager
  // fan-out can never reach it (card 43084723's rule). Polled at the vault-lock cadence, not the 4s
  // manager cadence — this is a standing configuration fact, not a live incident.
  const codexGapEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "codex_isolation_gap_disclosed"],
    queryFn: () => api.orchestrationEventsByKinds(["codex_isolation_gap_disclosed"]),
    refetchInterval: 15000,
  });
  const activeCodexGaps = activeCodexIsolationGapAlerts(codexGapEventsQuery.data ?? []);

  // Card 65294dcc — a both-dead halted-recycle lineage's consolidation banner (docs/decisions/a4c5f234).
  // Filed under the predecessor's OWN session id, which by construction is not a live manager — same
  // kind-filtered-query reason as the two queries above (card 43084723's rule).
  const recycleConsolidatedEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "recycle_split_lineage_consolidated"],
    queryFn: () => api.orchestrationEventsByKinds(["recycle_split_lineage_consolidated"]),
    refetchInterval: 15000,
  });
  const activeRecycleConsolidated = activeRecycleLineageConsolidatedAlerts(
    recycleConsolidatedEventsQuery.data ?? [],
    (predecessorId) => {
      const p = all.find((x) => x.id === predecessorId);
      return !!p && isOrphanedFleet(p);
    },
  );
  const recycleConsolidatedPredecessorIds = new Set(activeRecycleConsolidated.map((c) => c.predecessorId));

  // Card 7be85378 — CRASH-LOOPED for a session the `all.filter(isCrashLooped)` loop below can never see:
  // `archiveOnExit` always archives the subject before the watcher's own give-up tick stamps the banner,
  // so a worker (or a manager/platform with zero live workers) never has its item built by that loop at
  // all. `session_recovery_abandoned`/`session_recovered` are TWO SEPARATE queries, never one combined
  // call — see `activeCrashLoopAbandonments`'s own doc for why a shared cap can evict the rarer kind.
  const crashLoopAbandonedEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "session_recovery_abandoned"],
    queryFn: () => api.orchestrationEventsByKinds(["session_recovery_abandoned"]),
    refetchInterval: 15000,
  });
  const crashLoopRecoveredEventsQuery = useQuery({
    queryKey: ["orchEventsByKind", "session_recovered"],
    queryFn: () => api.orchestrationEventsByKinds(["session_recovered"]),
    refetchInterval: 15000,
  });

  const eventQueries = useQueries({
    queries: managers.map((m) => ({
      queryKey: ["orchEvents", m.id],
      queryFn: () => api.orchestrationEvents(m.id),
      refetchInterval: 4000,
    })),
  });
  // Round 2 (Code Review e5290bc2 MAJOR), reaffirmed by card 43084723: do NOT fold bootStuckEvents into
  // allEvents — it is already kind-filtered server-side to the two boot-dialog kinds alone, and merging it
  // in would re-create the original bug this guarded against: a parentless session's idle_report/
  // context_escalated/board_quiet_cause/merge_request events wrongly feeding latestIdle/latestContext/
  // latestQuiet/latestMerge below. `allEvents` stays scoped to `managers` alone; `bootStuckEvents` feeds
  // ONLY `activeBootStuckAlerts` below.
  const allEvents = eventQueries.flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? []);

  const sortedEvents = [...allEvents].sort((a, b) => +new Date(a.ts) - +new Date(b.ts));

  // A merge_request is "pending" until a later merge_done/merge_rejected for the same task/worker.
  // Key task-first so a worker recycled between review and confirm still pairs its terminal event.
  // Extracted to lib/fleet.ts's buildLatestMergeMap (card e5458ccd round 2) — unit-tested there.
  const latestMerge = buildLatestMergeMap(sortedEvents);

  // Card b1da256d round 2 (item 3b): the pairing/sort/liveness-drop logic itself now lives in the pure,
  // unit-tested `activeBootStuckAlerts` (lib/fleet.ts) — see that function's own doc for the
  // parentNudged filter, the workerSessionId keying rationale, and the latest-wins/non-live-drop rules.
  const activeBootStuck = activeBootStuckAlerts(bootStuckEvents, (sessionId) =>
    all.find((s) => s.id === sessionId)?.processState === "live");

  // Asleep-at-the-Wheel watchdog (Task 4): surface the manager's LATEST idle disposition. An
  // `idle_escalated` (slept through every nudge) or an `idle_report` with state done is
  // a human-facing alert; a later `working`/`waiting` report — or any newer idle event — clears it (we
  // only keep the single latest idle event per manager, mirroring latestMerge). detail is typed
  // Record<string,unknown>, so read .state/.detail through a cast as elsewhere in this codebase.
  const latestIdle = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "idle_report" || e.kind === "idle_escalated") {
      latestIdle.set(e.managerSessionId, e);
    }
  }

  // Context-recycle escalation (ContextWatcher twin of idle_escalated): a context-heavy manager that
  // ignored every recycle nudge → a human-facing alert. There's no "context_report" answer to clear it
  // (a context nudge is answered by recycling, which makes the manager not-live → its events stop being
  // fetched here), so the latest context_escalated per LIVE manager simply surfaces. Keyed per manager
  // (at most one per session — escalate-once), mirroring latestIdle/latestMerge.
  const latestContext = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "context_escalated") latestContext.set(e.managerSessionId, e);
  }

  // Give-up-recovery alarm (card c00231e2, PtyHost's own per-session episode counter): a manager/
  // platform-lead's submit GIVE-UP RECOVERY fired repeatedly inside a rolling window. Same shape as
  // context_escalated immediately above — no "cleared" event exists, so the latest one per LIVE manager
  // simply surfaces until that session exits or a later episode's event replaces it.
  const latestGiveUpRecovery = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "give_up_recovery_escalated") latestGiveUpRecovery.set(e.managerSessionId, e);
  }

  // Quiet-board cause (card 275ac184, IdleWatcher's `nothingElseActionable` skip): a manager/Lead
  // suppressed because every non-terminal card is non-actionable (held/deferred/excluded-lane/
  // platform-parked/pending-request) reads identically whether it's genuinely converged or starved on
  // the owner — this surfaces WHY, and whether answering the pending Request(s) involved would actually
  // release anything. No "cleared" event exists (mirrors context_escalated's own shape) — the latest one
  // per LIVE manager simply surfaces until that session exits or a newer episode's event replaces it.
  const latestQuiet = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "board_quiet_cause") latestQuiet.set(e.managerSessionId, e);
  }

  const items: AttentionItem[] = [];
  // A blocked human is the wave's tightest bottleneck, so a pending DECISION reads first. Only PENDING
  // questions surface here (an answered one is waiting on the MANAGER's pickup, not the human).
  // A question whose asker is `sessionOrphaned` (row hard-deleted, or resume already proved it dead) can
  // never be consumed no matter how long it sits 'pending' — answering it would be a silent no-op. Surface
  // it as a DISTINCT kind (amber, not the actionable cyan) rather than either hiding it (the human would
  // never learn the manager needs attention) or leaving it indistinguishable from a live, answerable
  // decision (misleading — see the residual-gap investigation, card 8701bdbb follow-up).
  const now = Date.now();
  for (const q of (questions.data ?? []).filter((x) => x.state === "pending")) {
    const label = requestAttentionLabel(q.type); // type-aware — a credential/permission/input ask is not a "decision"
    // Card 99d41588: `escalatedAt` is stamped ONCE, server-side (IdleWatcher.tickStaleRequests), the
    // instant this still-pending Request first crosses `orchestration.staleRequestMinutes` — read directly
    // off the question row rather than cross-referencing a `request_escalated` orchestration event, since
    // this bell already polls `openQuestions` globally (unlike the idle/context escalation rows below,
    // which can only surface for a currently-LIVE manager's own fetched event stream — a Request's asking
    // session may since have exited without ever answering it, and this must still show the escalation).
    // A row that's ALSO sessionOrphaned takes the orphaned branch instead — "asking session is gone" is
    // the more actionable fact for a human to know than "and it was also stale before that".
    // Card 889ae619 (iii-a): a durable, human-set `acknowledgedUntil` SUPPRESSES the STALE presentation
    // while it's still in the future — a snooze, never a retirement (state/escalatedAt are untouched, so
    // the row RE-REDDENS the instant acknowledgedUntil passes, with no separate "cleared" event to miss).
    const snoozed = q.acknowledgedUntil != null && new Date(q.acknowledgedUntil).getTime() > now;
    const stale = q.escalatedAt != null && !snoozed;
    // Card 5ced500b — `projectId` comes straight off the Request row, so a pending owner Request stays on
    // its project's Overview even once the asking manager has exited and ARCHIVED (previously it resolved
    // only through the live session feed and vanished from the owner's primary board). It is the ONLY
    // project key the ORPHANED branch can ever have: `sessionOrphaned` means that session row is gone for
    // good, so there is nothing left for a session lookup to find.
    items.push(q.sessionOrphaned
      ? {
          key: `q-${q.id}`, tone: "amber", notify: "request", kind: label.replace(" NEEDED", " ORPHANED"), questionId: q.id, sessionId: q.sessionId,
          projectId: q.projectId,
          text: `${decisionAttentionText(q)} — asking session is gone; may never be consumed`,
        }
      : stale
      ? {
          key: `q-${q.id}`, tone: "red", notify: "request", kind: label.replace(" NEEDED", " STALE"), questionId: q.id, sessionId: q.sessionId,
          projectId: q.projectId,
          // Structural marker for the Snooze affordance (AttentionRow) — set ONLY on this exact branch, so
          // "snooze" never shows on a cyan/amber/orphaned row where there's nothing stale to suppress.
          staleQuestionId: q.id,
          text: `${decisionAttentionText(q)} — pending since ${new Date(q.createdAt).toLocaleDateString()}, unanswered`,
        }
      : {
          key: `q-${q.id}`, tone: "cyan", notify: "request", kind: label, questionId: q.id, sessionId: q.sessionId,
          projectId: q.projectId,
          text: decisionAttentionText(q),
        });
  }
  // A genuinely-pending review keeps its WORKER session alive on the worktree (the worker is only
  // hard-stopped at merge-confirm time). So a merge_request whose worker is gone (exited/dead/not in
  // `all`) is NOT a live review — its merge resolved or was abandoned (e.g. a merge_done lost to a
  // daemon restart). Retire it. This is what makes the lost-event case correct even under a live
  // manager; the live-managers-only filter above composes with it (belt and suspenders).
  const liveWorker = (id?: string | null): boolean => {
    if (!id) return false;
    const w = all.find((s) => s.id === id);
    return !!w && (w.processState === "live" || w.processState === "starting");
  };
  for (const e of latestMerge.values()) {
    if (e.kind === "merge_request" && liveWorker(e.workerSessionId)) {
      items.push({
        key: `m-${e.id}`, tone: "phosphor", notify: "merge-request", kind: "MERGE REQUEST", workerSessionId: e.workerSessionId,
        text: `${e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)} ` : ""}${e.taskId ? `task ${e.taskId.slice(0, 8)} ` : ""}— awaiting review`,
      });
    }
  }
  for (const { event: e, sessionId: sid } of activeBootStuck) {
    const detail = (e.detail ?? {}) as { signatureName?: string | null; role?: string | null; timeoutMs?: number };
    items.push({
      key: `bs-${e.id}`, tone: "red", notify: "boot-stuck", kind: "BOOT STUCK", sessionId: sid,
      text: `${detail.role ?? "session"} ${sid.slice(0, 8)} never reached SessionStart — possible blocking CLI dialog (${detail.signatureName ?? "none recognized"})`,
    });
  }
  for (const e of latestIdle.values()) {
    const detail = (e.detail ?? {}) as { state?: string; detail?: string; unanswered?: number };
    if (e.kind === "idle_escalated") {
      items.push({
        key: `ie-${e.id}`, tone: "red", notify: "manager-asleep", kind: "MANAGER ASLEEP", sessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — ${detail.unanswered ?? "?"} unanswered idle nudges, escalated`,
      });
    } else if (detail.state === "done") {
      items.push({
        key: `id-${e.id}`, tone: "amber", notify: "queue-drained", kind: "QUEUE DRAINED", sessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — queue drained; reclaim/close the session${detail.detail ? ` (${detail.detail})` : ""}`,
      });
    }
    // a latest idle_report of working/waiting falls through → no item (the alert is cleared).
  }
  for (const e of latestContext.values()) {
    const detail = (e.detail ?? {}) as { unanswered?: number; pct?: number };
    items.push({
      key: `ce-${e.id}`, tone: "red", notify: "context-overflow", kind: "CONTEXT OVERFLOW", sessionId: e.managerSessionId,
      text: `manager ${e.managerSessionId.slice(0, 8)} — ignored ${detail.unanswered ?? "?"} recycle nudges at ~${detail.pct ?? "?"}% context; will overflow without a handoff`,
    });
  }
  for (const e of activeVaultLocks) {
    const detail = (e.detail ?? {}) as { repoPath?: string; command?: string; ageMs?: number; projectId?: string };
    const ageMin = typeof detail.ageMs === "number" ? Math.round(detail.ageMs / 60000) : null;
    items.push({
      key: `vl-${e.id}`, tone: "red", notify: "vault-lock-stuck", kind: "VAULT LOCK STUCK",
      // Card 5ced500b — this item carries NO session id at all (it keys on `detail.repoPath`; no session
      // owns a vault watcher), so before this it resolved to no project and showed on NO project Overview,
      // ever. The daemon has always filed `detail.projectId` alongside repoPath (vault/versioner.ts), so
      // reading it here is what puts the alert on the one board the owner actually watches. Optional on the
      // wire: the versioner takes its lockAlert projectId as an optional ctor arg, so a row filed without
      // one stays global-only rather than being attributed to a guess.
      projectId: detail.projectId ?? null,
      text: `${detail.repoPath ?? "a vault repo"} — .git/index.lock stuck` +
        `${ageMin !== null ? ` for ~${ageMin}min` : ""}; run: ${detail.command ?? "(see event detail)"}`,
    });
  }
  // Card ed0858dc — a PARENTLESS codex session's dropped claude-side protections, which the daemon
  // discloses durably but nudges nobody about. activeCodexIsolationGapAlerts (lib/fleet.ts) owns the
  // filtering/keying rules and carries the decision anchor for what must not be changed here.
  for (const { event: e, sessionId: sid, dedupKey } of activeCodexGaps) {
    const detail = (e.detail ?? {}) as { items?: { id?: string; reason?: string }[]; agentId?: string | null };
    const gapItems = detail.items ?? [];
    const ids = gapItems.map((i) => i.id).filter((id): id is string => !!id);
    const n = ids.length;
    // Prefer the AGENT's name — it's the thing the human then edits — over an opaque id. A run session is
    // often already archived and gone from `all`, so degrade to the agent id, then to the session itself,
    // rather than rendering a bare uuid with no label.
    const agentLabel = all.find((s) => s.id === sid)?.agentName
      ?? (detail.agentId ? `agent ${detail.agentId.slice(0, 8)}` : `session ${sid.slice(0, 8)}`);
    items.push({
      key: `cig-${e.id}`, tone: "amber", notify: "codex-isolation-gap", kind: "CODEX ISOLATION GAP", sessionId: sid,
      // Card 5ced500b — this kind has NO liveness filter by design (card ed0858dc: it reports a
      // standing CONFIGURATION fact whose remedy outlives the disclosing session), and a codex run is
      // short-lived, so by the time a human looks the session is usually archived and gone from the live
      // feed. The event carries no projectId, so the AGENT is the project key — agents are project-scoped,
      // and the agent's profile harness is the very thing the human must edit anyway. `detail.agentId` can
      // legitimately be null (the daemon reads it off a session row that may already be gone), in which
      // case this item falls back to the session lookup and the bound in `resolveAttentionProjectId`'s doc.
      agentId: detail.agentId ?? null,
      dismissKey: dedupKey,
      dismissHint: "Dismiss — hides this isolation gap until this agent discloses a different set",
      // Deliberately NOT "read-deny protections", and deliberately no "can read those files" clause:
      // `permissionDeny` is the project's AUTHORED permission.deny rule set, which can deny edits and
      // commands too, not only reads (codexPermissionDenyReason, daemon profiles/codex-compat.ts). Only
      // the other three ids are read-denies, so "claude protection(s) not enforced" is the one umbrella
      // honest for the whole set. The per-item `reason` strings carry the specifics, on hover.
      text: `${agentLabel} · codex — ${n} claude protection${n === 1 ? "" : "s"} not enforced (${ids.join(", ")}). `
        + `No manager to warn, so nobody was told. Set this agent's profile harness to "claude" if that isolation matters.`,
      hoverText: gapItems.map((i) => i.reason).filter((r): r is string => !!r).join("\n\n") || null,
    });
  }
  // Card 65294dcc — see docs/decisions/65294dcc: a dedicated kind so this never double-renders alongside
  // the generic ORPHANED FLEET item below (which excludes any predecessor id covered here).
  for (const { event: e, predecessorId } of activeRecycleConsolidated) {
    const p = all.find((x) => x.id === predecessorId);
    items.push({
      key: `rlc-${e.id}`, tone: "red", notify: "recycle-lineage-consolidated", kind: "RECYCLE LINEAGE CONSOLIDATED",
      sessionId: predecessorId,
      projectId: p?.projectId ?? null,
      text: `${p ? `${p.projectName} · ${p.role ?? "session"} ` : "session "}${predecessorId.slice(0, 8)} — a halted recycle's successor died too; its fleet was consolidated back here. No automatic owner exists — resume this session, reassign its workers, or start a new manager.`,
    });
  }
  for (const e of latestGiveUpRecovery.values()) {
    const detail = (e.detail ?? {}) as { count?: number; windowMs?: number };
    const windowMin = detail.windowMs ? Math.round(detail.windowMs / 60_000) : null;
    items.push({
      key: `gr-${e.id}`, tone: "red", notify: "give-up-recovery", kind: "GIVE-UP RECOVERY", sessionId: e.managerSessionId,
      text: `manager ${e.managerSessionId.slice(0, 8)} — submit give-up recovery fired ${detail.count ?? "?"}x${windowMin ? ` in ~${windowMin}m` : ""}; its composer submissions may be unreliable`,
    });
  }
  for (const e of latestQuiet.values()) {
    const detail = (e.detail ?? {}) as {
      reason?: string; totalNonTerminal?: number; causeCounts?: Record<string, number>;
      questionIds?: string[]; releasable?: { questionId: string; taskIds: string[] }[];
    };
    const cc = detail.causeCounts ?? {};
    const releasable = detail.releasable ?? [];
    const releasedCardCount = releasable.reduce((n, r) => n + r.taskIds.length, 0);
    const questionCount = (detail.questionIds ?? []).length;
    // Self-parked (the manager's own sequencing — no owner block present) and owner-blocked (a pending
    // Request and/or a held card) are reported as SEPARATE phrases, mirroring `causeCounts`' own
    // ownerBlocked/selfParked split — never collapsed into one generic count, since the coupling this
    // card exists to surface (does answering the owner side actually release anything) only makes sense
    // read against the owner phrase specifically.
    const selfParts = [
      (cc.managerDeferred ?? 0) > 0 ? `${cc.managerDeferred} deferred` : null,
      (cc.deadEndLane ?? 0) > 0 ? `${cc.deadEndLane} dead-end-lane` : null,
      (cc.leadOwnerFlow ?? 0) > 0 ? `${cc.leadOwnerFlow} parked` : null,
    ].filter((s): s is string => s !== null);
    const selfPhrase = selfParts.length > 0 ? `${selfParts.join(", ")} (manager)` : "";
    const ownerHasAny = (cc.ownerHeld ?? 0) > 0 || (cc.ownerRequest ?? 0) > 0;
    const ownerPhrase = ownerHasAny ? `${cc.ownerHeld ?? 0} held + ${cc.ownerRequest ?? 0} request-blocked (owner)` : "";
    const causePhrase = [selfPhrase, ownerPhrase].filter((s) => s.length > 0).join(", ") || "0 cards";
    const text = detail.reason === "own-pending-request"
      ? `manager ${e.managerSessionId.slice(0, 8)} — quiet: blocked entirely on its own pending Request, nothing else to do`
      : `manager ${e.managerSessionId.slice(0, 8)} — quiet: ${causePhrase}` +
        (questionCount > 0 ? `; answering ${questionCount} pending Request(s) releases ${releasedCardCount} card(s)` : "");
    items.push({
      key: `bq-${e.id}`, tone: "amber", notify: "quiet-board", kind: "QUIET BOARD", sessionId: e.managerSessionId, text,
    });
  }
  // Defense-in-depth: only a LIVE session is actionably rate-limited. The durable fix clears
  // rate_limited_until on session EXIT, but an exited row that pre-dates that fix (or races a tick)
  // could still carry a future timestamp — it can never resume, so it must not linger here.
  for (const s of all.filter((s) => isRateLimited(s) && s.processState === "live")) {
    items.push({
      key: `r-${s.id}`, tone: "red", notify: "rate-limited", kind: "RATE-LIMITED", rateLimitSessionId: s.id,
      // Card 5ced500b — this row carries `rateLimitSessionId` (the clear/retry action's target), never
      // `sessionId`, so the old session-id-only resolver found nothing and the item surfaced GLOBALLY only.
      // A comment on the Overview used to call that deliberate; it wasn't — it described the missing field,
      // not an intent. The project was in hand the whole time, so it is stated here and the row now reaches
      // the project board too.
      projectId: s.projectId,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — resumes ${s.rateLimitedUntil ? new Date(s.rateLimitedUntil).toLocaleTimeString() : "?"}`,
    });
  }
  // STUCK-BUSY exclusions (board card a1f06bcc): a manager parked mid-orchestration between worker turns
  // (supervising ≥1 live/pending worker) or a session that self-reported an active idle_report('waiting')
  // snooze is legitimately parked, not stuck — `latestIdle` (built above) already carries each live
  // manager's most recent idle disposition, so the waiting-snooze check reuses it directly.
  for (const s of all.filter((s) => isStuckBusy(s, {
    hasSupervisedWorkers: hasSupervisedWorkers(s.id, all),
    isWaitingSnoozed: isActiveWaitingSnooze(latestIdle.get(s.id)),
  }))) {
    items.push({
      key: `s-${s.id}`, tone: "amber", notify: "stuck-busy", kind: "STUCK-BUSY", sessionId: s.id,
      // Card 5ced500b — derived by ITERATING the live session feed, so the project is already in hand;
      // stating it keeps every reader on the same `projectId` path instead of a session re-lookup.
      projectId: s.projectId,
      dismissKey: `${s.id}:${s.lastActivity}`,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — busy, no activity since ${new Date(s.lastActivity).toLocaleTimeString()} (heuristic)`,
    });
  }
  for (const s of all.filter(isCrashLooped)) {
    items.push({
      key: `cl-${s.id}`, tone: "red", notify: "crash-looped", kind: "CRASH-LOOPED", sessionId: s.id,
      // Card 5ced500b — derived by ITERATING the live session feed, so the project is already in hand;
      // stating it keeps every reader on the same `projectId` path instead of a session re-lookup.
      projectId: s.projectId,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — died repeatedly after auto-resume; auto-resume STOPPED. Inspect the log + resume manually.`,
    });
  }
  // Card 7be85378 — the archived-surviving counterpart to the loop above: every session id already
  // covered there is excluded inside activeCrashLoopAbandonments itself (the dedupe), so this never
  // double-renders the same episode.
  const archivedCrashLoopItems = activeCrashLoopAbandonments(
    crashLoopAbandonedEventsQuery.data ?? [],
    crashLoopRecoveredEventsQuery.data ?? [],
    new Set(all.map((s) => s.id)),
  );
  for (const { event: e, sessionId: sid } of archivedCrashLoopItems) {
    const detail = (e.detail ?? {}) as { role?: string | null; attempts?: number; projectId?: string | null };
    items.push({
      key: `cl-${e.id}`, tone: "red", notify: "crash-looped", kind: "CRASH-LOOPED", sessionId: sid,
      // Card 5ced500b — stated directly from the event's own detail: session_recovery_abandoned is
      // already a DURABLE_AUDIT_EVENT_KINDS member, so db.ts's appendEvent backstop (9f7f2b50) stamps
      // projectId generically at write time — no daemon change was needed for this card. A row filed
      // before 9f7f2b50 shipped lacks it and falls back to resolveAttentionProjectId's session-id step.
      projectId: detail.projectId ?? null,
      // @decision 7be85378 — a permanently DELETED session's event has no clearing path. Give it the
      // same dismiss escape hatch CODEX ISOLATION GAP uses for its own no-clear-path case, keyed on the
      // abandoned event's own ts so a later, separate crash-loop episode mints a different key.
      dismissKey: `${sid}:${e.ts}`,
      dismissHint: "Dismiss — hides this crash-loop episode until this session crash-loops again",
      text: `${detail.role ?? "session"} ${sid.slice(0, 8)} (archived) — died ${detail.attempts ?? "?"}× after ` +
        `auto-resume; auto-resume STOPPED. Inspect the log + resume manually.`,
    });
  }
  for (const s of all.filter(isOrphanedFleet)) {
    // Card 65294dcc — a predecessor already covered by the more specific RECYCLE LINEAGE CONSOLIDATED item
    // above incidentally also matches isOrphanedFleet (the consolidation branch reuses its lastError
    // prefix); skip it here so the same lineage never renders twice. See docs/decisions/65294dcc.
    if (recycleConsolidatedPredecessorIds.has(s.id)) continue;
    items.push({
      key: `of-${s.id}`, tone: "red", notify: "orphaned-fleet", kind: "ORPHANED FLEET", sessionId: s.id,
      // Card 5ced500b — derived by ITERATING the live session feed, so the project is already in hand;
      // stating it keeps every reader on the same `projectId` path instead of a session re-lookup.
      projectId: s.projectId,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — exited while still owning live worker(s); they are now parentless. Resume this session or reparent/stop them manually.`,
    });
  }

  // Single-source the dismiss filter HERE so every surface (the queue rows, the bell/MC count, and the
  // new-item/toast signal that runs off useNewAttention → this same hook) agrees on what's hidden.
  const dismissed = useDismissedSet();
  const visible = items.filter((it) => !(it.dismissKey && dismissed.has(it.dismissKey)));

  // Prune stored dismiss keys that no longer match a derivable dismissable item. Gated on real data — a
  // still-loading/empty poll yields no derivable keys, which must NOT wipe a valid dismiss. Keyed on the
  // sorted derivable signature so the effect only fires when that set changes.
  //
  // ⚠️ THE GATE MUST NAME EVERY QUERY A DISMISSABLE KIND IS DERIVED FROM, not just the sessions poll.
  // STUCK-BUSY comes from `sessions` alone, but CODEX ISOLATION GAP (card ed0858dc) comes from its own
  // events query — and the two resolve independently. With the gate on `sessions` alone, a page load where
  // sessions landed FIRST ran the prune against an `items` that had no isolation-gap row yet, silently
  // wiping its dismiss key; the row then reappeared the moment the events landed, so a dismiss never
  // survived a reload. Caught by codex-isolation-gap-attention.spec.ts's post-reload assertion. Any future
  // dismissable kind must add its own source here too.
  // Card 7be85378 — the archived-surviving CRASH-LOOPED item is dismissable too; same rule, same two
  // queries it's built from.
  const loaded = sessions.data !== undefined && codexGapEventsQuery.data !== undefined
    && crashLoopAbandonedEventsQuery.data !== undefined && crashLoopRecoveredEventsQuery.data !== undefined;
  const derivableSig = items.filter((it) => it.dismissKey).map((it) => it.dismissKey!).sort().join("\n");
  useEffect(() => {
    if (!loaded) return;
    pruneDismissed(new Set(derivableSig ? derivableSig.split("\n") : []));
  }, [loaded, derivableSig]);

  // Whether `items` is the REAL attention set rather than a not-yet-resolved prefix of it: every query ANY
  // kind is derived from has settled. Read `isPending`, not `data !== undefined`, so an ERRORED query still
  // counts as settled (react-query leaves `data` undefined forever after a failed fetch).
  //
  // @decision 3157a563 — never narrow this to a subset of the queries, and never fold it into `loaded`
  // above (a deliberately narrower gate, naming only the DISMISSABLE kinds' own sources).
  const resolved = !sessions.isPending && !questions.isPending && !bootStuckEventsQuery.isPending
    && !vaultLockEventsQuery.isPending && !codexGapEventsQuery.isPending
    && !recycleConsolidatedEventsQuery.isPending
    && !crashLoopAbandonedEventsQuery.isPending && !crashLoopRecoveredEventsQuery.isPending
    && eventQueries.every((q) => !q.isPending);

  return { items: visible, count: visible.length, resolved };
}

// Shared "newly-appeared attention item" detector. Seeds the seen-set silently from the FIRST RESOLVED
// attention set — not the first render, which on a cold load carries no items at all (card 3157a563) — so
// a reload doesn't replay the backlog; then invokes `onNew` exactly once per item whose key wasn't seen
// before; departed keys drop out so a re-occurrence re-fires. Defined ONCE here so the shell
// bell (browser Notification) and the in-app toast stack run off the same new-item signal instead of
// each re-deriving it — no surface fires for an item it already announced.
// The fleet affordance (surface 5): a per-session map of the PENDING decisions each asking manager holds,
// so a FleetCard/FleetRow can flag "N decision · waiting on you" and deep-link its answer page. Reads the
// SAME shared openQuestions query (react-query dedups), so it adds no extra poll. `questionId` is the
// FIRST (newest) pending question for that session — the "Answer →" jump target.
export interface PendingDecision { questionId: string; count: number }
export function usePendingDecisionsBySession(): Map<string, PendingDecision> {
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 3000 });
  return useMemo(() => {
    const m = new Map<string, PendingDecision>();
    // openQuestions is newest-first, so the first pending row seen per session is the newest → the jump target.
    for (const q of questions.data ?? []) {
      if (q.state !== "pending") continue;
      const cur = m.get(q.sessionId);
      if (cur) cur.count += 1;
      else m.set(q.sessionId, { questionId: q.id, count: 1 });
    }
    return m;
  }, [questions.data]);
}

export function useNewAttention(onNew: (item: AttentionItem) => void): void {
  const { items, resolved } = useAttention();
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef(onNew);
  cb.current = onNew;
  useEffect(() => {
    // @decision 3157a563 — never seed the seen-set from an UNRESOLVED render. A cold load's first effect
    // pass sees `items` EMPTY because the queries behind it haven't resolved, so seeding there seeds
    // nothing and replays the whole pending backlog as "new" on every single page load.
    if (!resolved) return;
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.key));
      return;
    }
    for (const it of items) {
      if (!seen.current.has(it.key)) cb.current(it);
    }
    seen.current = new Set(items.map((i) => i.key));
  }, [items, resolved]);
}
