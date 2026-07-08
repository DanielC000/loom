import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { api } from "./api";
import { hasSupervisedWorkers, isActiveWaitingSnooze, isRateLimited, isStuckBusy } from "./fleet";
import { decisionAttentionText } from "./questions";
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

export interface AttentionItem {
  key: string;
  tone: Tone;
  kind: string;
  text: string;
  // Set ONLY on the user-dismissable STUCK-BUSY kind — `${sessionId}:${lastActivity}`. Its presence is
  // what makes a row dismissable (AttentionRow renders × off it); the actionable kinds leave it unset.
  dismissKey?: string | null;
  // STRICTLY a merge-review worker — set ONLY on MERGE REQUEST, whose branch diff opens in the review
  // panel (/review/:workerSessionId). Do NOT overload it as a generic session pointer (it once routed
  // every non-merge alert to a "No diff" merge page — card a16dfafb); use `sessionId` for those.
  workerSessionId?: string | null;
  // The session this NON-merge alert is ABOUT — STUCK-BUSY / CRASH-LOOPED (the session itself) or
  // MANAGER ASLEEP / NEEDS A HUMAN / QUEUE DRAINED / CONTEXT OVERFLOW (the manager session). Its "Open"
  // affordance deep-links to that session's view (/session/:sessionId), NOT the merge panel.
  sessionId?: string | null;
  rateLimitSessionId?: string | null; // when set, the row offers a "clear / retry now" action (POST .../rate-limit/clear)
  // Set ONLY on the DECISION NEEDED kind (a pending manager→human question). Its "Answer →" affordance
  // opens the answer page (/question/:id); the row also renders a PENDING state chip off this presence.
  questionId?: string | null;
}

// The deep-link an attention item's "Open" affordance targets, or null if it has none. A MERGE REQUEST
// opens the merge-review panel (its worker branch diff); every other openable kind opens the SESSION the
// alert is about (its live terminal, or an exited-session panel). Single-sourced so the Mission Control /
// Overview rows, the toast, and the command palette can't drift on where "Open" goes (card a16dfafb).
export function attentionOpenTarget(item: AttentionItem): string | null {
  if (item.kind === "MERGE REQUEST") return item.workerSessionId ? `/review/${item.workerSessionId}` : null;
  if (item.kind === "DECISION NEEDED") return item.questionId ? `/question/${item.questionId}` : null;
  return item.sessionId ? `/session/${item.sessionId}` : null;
}

export function useAttention(): { items: AttentionItem[]; count: number } {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
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

  const eventQueries = useQueries({
    queries: managers.map((m) => ({
      queryKey: ["orchEvents", m.id],
      queryFn: () => api.orchestrationEvents(m.id),
      refetchInterval: 4000,
    })),
  });
  const allEvents = eventQueries.flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? []);

  const sortedEvents = [...allEvents].sort((a, b) => +new Date(a.ts) - +new Date(b.ts));

  // A merge_request is "pending" until a later merge_done/merge_rejected for the same task/worker.
  // Key task-first so a worker recycled between review and confirm still pairs its terminal event.
  const latestMerge = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "merge_request" || e.kind === "merge_done" || e.kind === "merge_rejected") {
      latestMerge.set(e.taskId || e.workerSessionId || e.id, e);
    }
  }

  // Asleep-at-the-Wheel watchdog (Task 4): surface the manager's LATEST idle disposition. An
  // `idle_escalated` (slept through every nudge) or an `idle_report` with state blocked_human/done is
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

  const items: AttentionItem[] = [];
  // A blocked human is the wave's tightest bottleneck, so a pending DECISION reads first. Only PENDING
  // questions surface here (an answered one is waiting on the MANAGER's pickup, not the human).
  for (const q of (questions.data ?? []).filter((x) => x.state === "pending")) {
    items.push({
      key: `q-${q.id}`, tone: "cyan", kind: "DECISION NEEDED", questionId: q.id, sessionId: q.sessionId,
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
        key: `m-${e.id}`, tone: "phosphor", kind: "MERGE REQUEST", workerSessionId: e.workerSessionId,
        text: `${e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)} ` : ""}${e.taskId ? `task ${e.taskId.slice(0, 8)} ` : ""}— awaiting review`,
      });
    }
  }
  for (const e of latestIdle.values()) {
    const detail = (e.detail ?? {}) as { state?: string; detail?: string; unanswered?: number };
    if (e.kind === "idle_escalated") {
      items.push({
        key: `ie-${e.id}`, tone: "red", kind: "MANAGER ASLEEP", sessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — ${detail.unanswered ?? "?"} unanswered idle nudges, escalated`,
      });
    } else if (detail.state === "blocked_human") {
      items.push({
        key: `ib-${e.id}`, tone: "red", kind: "NEEDS A HUMAN", sessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — needs a human decision${detail.detail ? `: ${detail.detail}` : ""}`,
      });
    } else if (detail.state === "done") {
      items.push({
        key: `id-${e.id}`, tone: "amber", kind: "QUEUE DRAINED", sessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — queue drained; reclaim/close the session${detail.detail ? ` (${detail.detail})` : ""}`,
      });
    }
    // a latest idle_report of working/waiting falls through → no item (the alert is cleared).
  }
  for (const e of latestContext.values()) {
    const detail = (e.detail ?? {}) as { unanswered?: number; pct?: number };
    items.push({
      key: `ce-${e.id}`, tone: "red", kind: "CONTEXT OVERFLOW", sessionId: e.managerSessionId,
      text: `manager ${e.managerSessionId.slice(0, 8)} — ignored ${detail.unanswered ?? "?"} recycle nudges at ~${detail.pct ?? "?"}% context; will overflow without a handoff`,
    });
  }
  // Defense-in-depth: only a LIVE session is actionably rate-limited. The durable fix clears
  // rate_limited_until on session EXIT, but an exited row that pre-dates that fix (or races a tick)
  // could still carry a future timestamp — it can never resume, so it must not linger here.
  for (const s of all.filter((s) => isRateLimited(s) && s.processState === "live")) {
    items.push({
      key: `r-${s.id}`, tone: "red", kind: "RATE-LIMITED", rateLimitSessionId: s.id,
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
      key: `s-${s.id}`, tone: "amber", kind: "STUCK-BUSY", sessionId: s.id,
      dismissKey: `${s.id}:${s.lastActivity}`,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — busy, no activity since ${new Date(s.lastActivity).toLocaleTimeString()} (heuristic)`,
    });
  }
  for (const s of all.filter(isCrashLooped)) {
    items.push({
      key: `cl-${s.id}`, tone: "red", kind: "CRASH-LOOPED", sessionId: s.id,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — died repeatedly after auto-resume; auto-resume STOPPED. Inspect the log + resume manually.`,
    });
  }

  // Single-source the dismiss filter HERE so every surface (the queue rows, the bell/MC count, and the
  // new-item/toast signal that runs off useNewAttention → this same hook) agrees on what's hidden.
  const dismissed = useDismissedSet();
  const visible = items.filter((it) => !(it.dismissKey && dismissed.has(it.dismissKey)));

  // Prune stored dismiss keys that no longer match a live STUCK-BUSY item. Gated on real session data
  // (`sessions.data`) — a still-loading/empty poll yields no derivable keys, which must NOT wipe a valid
  // dismiss. Keyed on the sorted derivable signature so the effect only fires when that set changes.
  const loaded = sessions.data !== undefined;
  const derivableSig = items.filter((it) => it.dismissKey).map((it) => it.dismissKey!).sort().join("\n");
  useEffect(() => {
    if (!loaded) return;
    pruneDismissed(new Set(derivableSig ? derivableSig.split("\n") : []));
  }, [loaded, derivableSig]);

  return { items: visible, count: visible.length };
}

// Shared "newly-appeared attention item" detector. Seeds the seen-set silently on first load (so a
// reload doesn't replay the backlog), then invokes `onNew` exactly once per item whose key wasn't
// seen before; departed keys drop out so a re-occurrence re-fires. Defined ONCE here so the shell
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
  const { items } = useAttention();
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef(onNew);
  cb.current = onNew;
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.key));
      return;
    }
    for (const it of items) {
      if (!seen.current.has(it.key)) cb.current(it);
    }
    seen.current = new Set(items.map((i) => i.key));
  }, [items]);
}
