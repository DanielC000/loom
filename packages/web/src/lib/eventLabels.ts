// Plain-English labels for orchestration/audit event kinds (card 99b98864, Atlas audit G-05). The
// Timeline, Pulse and Replay rows used to print the raw snake_case kind (`spawn_worker`), which reads as a
// log line rather than a sentence. This is DISPLAY ONLY: every call site keeps the raw kind reachable on
// the row (its `title` and a `data-event-kind` attribute), so a reader debugging from the event table
// loses nothing.
//
// Pure and JSX-free so test/eventLabels.mjs can import it directly under Node's type stripping.

/** The kinds a reader actually meets, worded as what happened. Anything not listed falls back to
 *  {@link humanizeKind}, so a new daemon kind never renders blank. */
const LABELS: Record<string, string> = {
  spawn_worker: "Started worker",
  message_worker: "Messaged worker",
  redirect_worker: "Redirected worker",
  stop_worker: "Stopped worker",
  worker_report: "Worker reported",
  worker_report_rejected: "Report refused",
  worker_report_undelivered: "Report undelivered",
  worker_exited_without_report: "Worker exited, no report",
  worker_retired: "Worker retired",
  worker_revived: "Worker revived",
  worker_stuck: "Worker looks stuck",
  worker_context_high: "Worker context high",
  worker_context_exhausted: "Worker out of context",
  manager_context_exhausted: "Manager out of context",
  context_escalated: "Context warning raised",
  merge_request: "Merge requested",
  merge_done: "Merged",
  merge_rejected: "Merge rejected",
  merge_cancelled: "Merge cancelled",
  merge_landing_started: "Merge landing",
  merge_landing_aborted: "Merge aborted",
  build_gate: "Gate ran",
  build_gate_retry: "Gate retried",
  build_gate_retry_attempt: "Gate retry started",
  worker_gate: "Worker gate ran",
  deploy: "Deployed",
  recycle_begin: "Recycle started",
  recycle_complete: "Recycled",
  recycle_failed: "Recycle failed",
  idle_report: "Idle report",
  idle_escalated: "Idle, escalated",
  session_died: "Session died",
  session_resume_attempt: "Resume attempted",
  session_recovered: "Session recovered",
  session_recovery_abandoned: "Recovery abandoned",
  session_message: "Message sent",
  session_message_queued: "Message queued",
  session_message_delivered: "Message delivered",
  session_message_gave_up: "Message not delivered",
  manager_exited_with_live_workers: "Manager exited, workers live",
  wake_scheduled: "Wake scheduled",
  wake_fired: "Woke up",
  wake_dropped: "Wake dropped",
  schedule_fired: "Schedule ran",
  schedule_fire_failed: "Schedule failed",
  schedule_fire_deferred: "Schedule deferred",
  schedule_fire_missed: "Schedule missed",
  question_asked: "Asked a question",
  request_escalated: "Request escalated",
  platform_escalate: "Escalated to Platform",
  kill_switch: "Kill switch",
  session_rate_limited: "Rate limited",
  rate_limit_resumed: "Resumed after limit",
  codex_auto_commit: "Auto-committed",
  end_me_complete: "Session ended itself",
};

/** `worker_report` reads better with its status folded in ("Worker done" rather than "Worker reported"). */
const REPORT_STATUS: Record<string, string> = {
  done: "Worker done",
  blocked: "Worker blocked",
  progress: "Worker progress",
};

/** `snake_case_kind` → "Snake case kind": the fallback for any kind without a hand-written label. */
export function humanizeKind(kind: string): string {
  const words = kind.replace(/_+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : kind;
}

/** The display label for an event. `detail` is optional and only consulted for kinds whose wording
 *  depends on it (a worker report's status, a deploy's outcome). */
export function eventKindLabel(kind: string, detail?: Record<string, unknown> | null): string {
  if (kind === "worker_report") {
    const status = typeof detail?.status === "string" ? detail.status : "";
    return REPORT_STATUS[status] ?? "Worker reported";
  }
  if (kind === "deploy" && detail && detail.ok === false) return "Deploy failed";
  return LABELS[kind] ?? humanizeKind(kind);
}
