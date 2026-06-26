import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, SessionRole, Schedule, Task } from "@loom/shared";
import { api } from "../lib/api";
import { TranscriptPane } from "./TranscriptPane";
import { Panel, Button, StatusPill, Chip } from "./ui";
import { color, font } from "../theme";

// A platform/home agent's RUN HISTORY — every RUN of a given `role` is a session of that role in a
// reserved home project. SHARED between the dev Platform view (Lead role:"platform" + Auditor
// role:"auditor", showFindings) and the END-USER Platform view (operator role:"setup" + Workspace
// Auditor role:"workspace-auditor"). Runs = api.allSessions() (live+exited) ∪ api.allArchivedSessions()
// (god-eye archive, already enriched with projectId), filtered to the reserved project's sessions of this
// role, newest-first by createdAt. The trigger (a schedule's cron, or "manual") comes from a run's
// orchestrationEvents (schedule_fired); the findings-filed list (when showFindings) comes from
// audit_finding events resolved against the reserved board() — fetched only when showFindings. Everything
// reuses EXISTING api methods — no new daemon/REST. The live+exited reserved sessions are passed in
// (already filtered by the page); we add the archive locally.

function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

// Human duration between two ISO instants (run start → end). Coarse on purpose (s / m / h).
function fmtDur(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// How many runs the history renders by default. Each recycle / audit run mints a NEW session, so the run
// list grows without bound over the life of the daemon; capping the default view keeps the page bounded.
// Capping ALSO bounds the per-row orchestrationEvents query fan-out (each RunRow mounts its own query) —
// only the visible rows fetch until the human expands the list with "Show all".
const DEFAULT_VISIBLE = 12;

export function RunHistory({ reservedProjectId, sessions, role, emptyLabel, showFindings = false }:
  { reservedProjectId: string; sessions: SessionListItem[]; role: SessionRole; emptyLabel: string; showFindings?: boolean }) {
  const archived = useQuery({ queryKey: ["allArchivedSessions"], queryFn: api.allArchivedSessions, refetchInterval: 8000 });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const board = useQuery({ queryKey: ["board", reservedProjectId], queryFn: () => api.board(reservedProjectId), refetchInterval: 8000, enabled: showFindings });

  // SINGLE-OPEN / LAZY-MOUNT: at most one expanded run's TranscriptPane is mounted (it refetches ~5s, so
  // mounting N would hammer the daemon). Mirrors the Overview Fleet accordion's openId pattern.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  // Default-bounded view: render only the most recent DEFAULT_VISIBLE runs unless the human expands.
  const [showAll, setShowAll] = useState(false);

  const runs = useMemo(() => {
    const live = sessions.filter((s) => s.role === role); // already reserved-project + non-archived
    const arch = (archived.data ?? []).filter((s) => s.projectId === reservedProjectId && s.role === role);
    return [...live, ...arch].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [sessions, archived.data, reservedProjectId, role]);

  if (runs.length === 0) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.textMuted, fontSize: 12 }}>{emptyLabel}</span></Panel>;
  }
  // Newest-first is preserved, so a LIVE run (top of the sort) always stays in the default window.
  const visible = showAll ? runs : runs.slice(0, DEFAULT_VISIBLE);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {visible.map((run) => (
        <RunRow key={run.id} run={run} schedules={schedules.data ?? []} tasks={board.data?.tasks ?? []}
          showFindings={showFindings} open={openId === run.id} onToggle={() => toggle(run.id)} />
      ))}
      {runs.length > DEFAULT_VISIBLE && (
        <button onClick={() => setShowAll((v) => !v)}
          style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${color.border}`, borderRadius: 4,
            padding: "4px 10px", cursor: "pointer", fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
          {showAll ? "Show fewer" : `Show all (${runs.length})`}
        </button>
      )}
    </div>
  );
}

// One run: timing + a live/exited/archived status pill + trigger (schedule cadence or "manual") +
// model/ctx counters + lastError + (when showFindings) the findings it filed (resolved to their board
// cards), with the transcript expanding inline when open. The trigger + findings come from this run's
// orchestrationEvents (the session id IS the managerSessionId those events are keyed by). Refetch only
// while live.
function RunRow({ run, schedules, tasks, showFindings, open, onToggle }:
  { run: SessionListItem; schedules: Schedule[]; tasks: Task[]; showFindings: boolean; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const live = !run.archivedAt && run.processState === "live";
  // On-demand human resume of an EXITED run (distinct from a manual Spawn, which always mints a FRESH
  // session, and from boot/restart resume, which is resume-by-id). resumability is only reliably "dead"
  // after a failed resume — most exited rows are "unknown" — so we offer Resume on any exited-non-archived
  // run and surface the server's error inline if it turns out to be unresumable.
  const canResume = !run.archivedAt && run.processState !== "live";
  const resumeM = useMutation({
    mutationFn: () => api.resumeSession(run.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["allSessions"] });
      qc.invalidateQueries({ queryKey: ["allArchivedSessions"] });
    },
  });
  const events = useQuery({
    queryKey: ["orchestrationEvents", run.id],
    queryFn: () => api.orchestrationEvents(run.id),
    refetchInterval: live ? 6000 : false,
  });
  const evs = events.data ?? [];

  // Status: archived (archivedAt set) → live (running) → exited.
  const status: { label: string; tone: "phosphor" | "cyan" | "muted"; glow?: boolean } =
    run.archivedAt ? { label: "archived", tone: "cyan" }
      : live ? { label: "live", tone: "phosphor", glow: true }
        : { label: "exited", tone: "muted" };

  // Trigger: a schedule_fired event → its scheduleId resolved to the schedule's cron (fall back to the
  // cron stamped on the event if the schedule was since deleted); no such event → a manual spawn.
  const fired = evs.find((e) => e.kind === "schedule_fired");
  const firedSchedId = fired?.detail?.scheduleId as string | undefined;
  const firedCron = fired?.detail?.cron as string | undefined;
  const trigger = fired
    ? (schedules.find((s) => s.id === firedSchedId)?.cron ?? firedCron ?? "scheduled")
    : "manual";

  // Findings filed: each audit_finding event → its taskId resolved against the reserved board's tasks.
  const findings = evs.filter((e) => e.kind === "audit_finding");

  const end = live ? new Date().toISOString() : run.lastActivity;
  return (
    <Panel style={{ padding: 0 }}>
      <div onClick={onToggle} title={open ? "Collapse" : "Expand to read this run’s transcript"}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", flexWrap: "wrap" }}>
        <span style={{ color: open ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        <StatusPill tone={status.tone} glow={status.glow} label={status.label} />
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>{fmt(run.createdAt)}</span>
        <Chip label="dur" value={fmtDur(run.createdAt, end)} />
        <Chip label={fired ? "cron" : "trigger"} value={trigger} tone={fired ? "cyan" : "muted"} />
        {run.model && <Chip label="model" value={run.model} />}
        {run.ctxInputTokens != null && <Chip label="ctx" value={run.ctxInputTokens.toLocaleString()} />}
        {run.ctxTurns != null && <Chip label="turns" value={run.ctxTurns} />}
        {showFindings && <Chip label="filed" value={findings.length} tone={findings.length ? "phosphor" : "muted"} />}
        <span style={{ flex: 1 }} />
        {canResume && (
          <Button variant="ghost" disabled={resumeM.isPending}
            onClick={(e) => { e.stopPropagation(); resumeM.mutate(); }}
            title="Resume this exited run (brings it back live)"
            style={{ padding: "2px 8px", fontSize: 11, color: color.cyan, borderColor: color.border }}>
            {resumeM.isPending ? "resuming…" : "Resume"}
          </Button>
        )}
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>last · {fmt(run.lastActivity)} · {run.id.slice(0, 8)}</span>
      </div>

      {resumeM.isError && (
        <div style={{ padding: "0 10px 8px 30px", color: color.red, fontFamily: font.mono, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          resume failed: {resumeM.error instanceof Error ? resumeM.error.message : String(resumeM.error)}
        </div>
      )}

      {run.lastError && (
        <div style={{ padding: "0 10px 8px 30px", color: color.red, fontFamily: font.mono, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {run.lastError}
        </div>
      )}

      {showFindings && findings.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "0 10px 8px 30px" }}>
          <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>findings</span>
          {findings.map((f) => {
            const task = tasks.find((t) => t.id === f.taskId);
            const title = task?.title ?? (f.detail?.title as string | undefined) ?? "finding";
            const severity = f.detail?.severity as string | undefined;
            return (
              <span key={f.id} title={task ? title : `${title} (no longer on the board)`}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: font.mono, fontSize: 11,
                  border: `1px solid ${task ? color.cyan : color.border}`, borderRadius: 4, padding: "1px 6px",
                  color: task ? color.cyan : color.textMuted, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {severity && <span style={{ color: color.amber }}>{severity}</span>}
                {title}{!task && " ·gone"}
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <div style={{ height: 420, margin: "0 10px 10px 30px", border: `1px solid ${color.border}`, borderRadius: 4, overflow: "hidden" }}>
          <TranscriptPane sessionId={run.id} />
        </div>
      )}
    </Panel>
  );
}
