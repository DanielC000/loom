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

export interface AttentionItem {
  key: string;
  tone: Tone;
  kind: string;
  text: string;
  workerSessionId?: string | null; // when set, the item is openable in the review panel
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

  // A merge_request is "pending" until a later merge_done/merge_rejected for the same worker/task.
  const latestMerge = new Map<string, OrchestrationEvent>();
  for (const e of sortedEvents) {
    if (e.kind === "merge_request" || e.kind === "merge_done" || e.kind === "merge_rejected") {
      latestMerge.set(e.workerSessionId || e.taskId || e.id, e);
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

  const items: AttentionItem[] = [];
  for (const e of latestMerge.values()) {
    if (e.kind === "merge_request") {
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
        key: `ie-${e.id}`, tone: "red", kind: "MANAGER ASLEEP", workerSessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — ${detail.unanswered ?? "?"} unanswered idle nudges, escalated`,
      });
    } else if (detail.state === "blocked_human") {
      items.push({
        key: `ib-${e.id}`, tone: "red", kind: "NEEDS A HUMAN", workerSessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — needs a human decision${detail.detail ? `: ${detail.detail}` : ""}`,
      });
    } else if (detail.state === "done") {
      items.push({
        key: `id-${e.id}`, tone: "amber", kind: "QUEUE DRAINED", workerSessionId: e.managerSessionId,
        text: `manager ${e.managerSessionId.slice(0, 8)} — queue drained; reclaim/close the session${detail.detail ? ` (${detail.detail})` : ""}`,
      });
    }
    // a latest idle_report of working/waiting falls through → no item (the alert is cleared).
  }
  for (const s of all.filter(isRateLimited)) {
    items.push({
      key: `r-${s.id}`, tone: "red", kind: "RATE-LIMITED",
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — resumes ${s.rateLimitedUntil ? new Date(s.rateLimitedUntil).toLocaleTimeString() : "?"}`,
    });
  }
  for (const s of all.filter(isStuckBusy)) {
    items.push({
      key: `s-${s.id}`, tone: "amber", kind: "STUCK-BUSY", workerSessionId: s.id,
      text: `${s.projectName} · ${s.role ?? "session"} ${s.id.slice(0, 8)} — busy, no activity since ${new Date(s.lastActivity).toLocaleTimeString()} (heuristic)`,
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
