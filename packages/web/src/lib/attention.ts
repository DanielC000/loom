import { useEffect, useRef } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { api } from "./api";
import type { Tone } from "../theme";

// Centralized "things needing a human" derivation, shared by Mission Control's attention queue and
// the shell bell. Built from the already-polled sessions + per-manager events (react-query dedups
// the network calls by key), so it needs no extra backend.

const STUCK_BUSY_MS = 3 * 60_000; // busy with no activity this long → likely stuck (heuristic)

export function isRateLimited(s: SessionListItem): boolean {
  return !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
}
export function isStuckBusy(s: SessionListItem): boolean {
  return s.processState === "live" && s.busy && Date.now() - new Date(s.lastActivity).getTime() > STUCK_BUSY_MS;
}
// Crash-recovery give-up: the CrashRecoveryWatcher hit its auto-resume cap (crashRecoveryMaxAttempts) for a
// session that kept re-dying, so it STOPPED resuming and stamped this crash-loop banner on lastError. A
// role-agnostic, session-row signal (NOT an event) so it surfaces even for a dead MANAGER, which has no
// live parent whose event stream the attention queue reads (parity with how RATE-LIMITED surfaces).
const CRASH_LOOP_PREFIX = "[loom:crash-loop]";
export function isCrashLooped(s: SessionListItem): boolean {
  return s.processState === "exited" && !!s.lastError && s.lastError.startsWith(CRASH_LOOP_PREFIX);
}

export interface AttentionItem {
  key: string;
  tone: Tone;
  kind: string;
  text: string;
  // STRICTLY a merge-review worker — set ONLY on MERGE REQUEST, whose branch diff opens in the review
  // panel (/review/:workerSessionId). Do NOT overload it as a generic session pointer (it once routed
  // every non-merge alert to a "No diff" merge page — card a16dfafb); use `sessionId` for those.
  workerSessionId?: string | null;
  // The session this NON-merge alert is ABOUT — STUCK-BUSY / CRASH-LOOPED (the session itself) or
  // MANAGER ASLEEP / NEEDS A HUMAN / QUEUE DRAINED / CONTEXT OVERFLOW (the manager session). Its "Open"
  // affordance deep-links to that session's view (/session/:sessionId), NOT the merge panel.
  sessionId?: string | null;
  rateLimitSessionId?: string | null; // when set, the row offers a "clear / retry now" action (POST .../rate-limit/clear)
}

// The deep-link an attention item's "Open" affordance targets, or null if it has none. A MERGE REQUEST
// opens the merge-review panel (its worker branch diff); every other openable kind opens the SESSION the
// alert is about (its live terminal, or an exited-session panel). Single-sourced so the Mission Control /
// Overview rows, the toast, and the command palette can't drift on where "Open" goes (card a16dfafb).
export function attentionOpenTarget(item: AttentionItem): string | null {
  if (item.kind === "MERGE REQUEST") return item.workerSessionId ? `/review/${item.workerSessionId}` : null;
  return item.sessionId ? `/session/${item.sessionId}` : null;
}

export function useAttention(): { items: AttentionItem[]; count: number } {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const all = sessions.data ?? [];
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
  for (const s of all.filter(isStuckBusy)) {
    items.push({
      key: `s-${s.id}`, tone: "amber", kind: "STUCK-BUSY", sessionId: s.id,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — busy, no activity since ${new Date(s.lastActivity).toLocaleTimeString()} (heuristic)`,
    });
  }
  for (const s of all.filter(isCrashLooped)) {
    items.push({
      key: `cl-${s.id}`, tone: "red", kind: "CRASH-LOOPED", sessionId: s.id,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — died repeatedly after auto-resume; auto-resume STOPPED. Inspect the log + resume manually.`,
    });
  }
  return { items, count: items.length };
}

// Shared "newly-appeared attention item" detector. Seeds the seen-set silently on first load (so a
// reload doesn't replay the backlog), then invokes `onNew` exactly once per item whose key wasn't
// seen before; departed keys drop out so a re-occurrence re-fires. Defined ONCE here so the shell
// bell (browser Notification) and the in-app toast stack run off the same new-item signal instead of
// each re-deriving it — no surface fires for an item it already announced.
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
