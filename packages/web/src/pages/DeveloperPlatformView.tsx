import { useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, SessionRole, Schedule, Task } from "@loom/shared";
import { api } from "../lib/api";
import Board from "./Board";
import { TerminalPane } from "../components/Terminal";
import { Composer } from "../components/Composer";
import { PresetPromptsButton } from "../components/PresetPrompts";
import { TranscriptPane } from "../components/TranscriptPane";
import { Panel, Button, Input, SectionLabel, StatusPill, Badge, Chip } from "../components/ui";
import { color, font } from "../theme";

// Platform Manager P6 — the DEV-edition Platform surface (the "Loom Platform" home), rendered by the
// consolidated Platform page when the reserved "Loom Platform" project exists (LOOM_DEV). SEPARATE from
// the project picker: the reserved "Loom Platform" project is hidden from the ordinary project list (GET
// /api/projects excludes reserved); this view is its only surface. It shows + controls:
//   1. the Platform Lead + Auditor agents, with human spawn/stop controls + live status,
//   2. the live platform sessions (Lead/Auditor terminals),
//   3. the Platform board — the Auditor findings + manager escalations backlog (reused Board),
//   4. the Auditor's schedule (kind:"auditor") cadence controls.
// Everything here reuses EXISTING REST: discovery is read-only (api.platformHome); spawn = startSession
// (role platform/auditor), stop = stopSession, cadence = createSchedule. No new write/elevated surface.
export function DeveloperPlatformView() {
  const home = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome });
  // Profiles resolve each agent's role (platform=Lead, auditor=Auditor) — the human spawn role + chip.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });

  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Platform home…</p>;
  if (home.isError || !home.data) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>No reserved “Loom Platform” project found — the platform layer may not be seeded yet.</p>;
  }
  const { project, agents } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // Classify by the bound profile's role, falling back to the seeded names if a profile is missing.
  const lead = agents.find((a) => roleOf(a) === "platform") ?? agents.find((a) => a.name === "Platform Lead");
  const auditor = agents.find((a) => roleOf(a) === "auditor") ?? agents.find((a) => a.name === "Platform Auditor");

  // Live sessions belonging to the reserved project (the platform sessions), newest first.
  const platformSessions = (sessions.data ?? [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveFor = (agentId?: string) =>
    agentId ? platformSessions.find((s) => s.agentId === agentId && s.processState === "live") : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Platform
          <Badge tone="cyan">{project.name}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            the management layer above all projects · hidden from the project picker
          </span>
        </SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "4px 0 0", fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
          The Platform Lead is the always-available, human-driven operator above all projects; the Auditor is the
          scheduled, read-and-file-only transcript reviewer. Spawning either is a human go-live action — there is
          exactly one Lead. Findings + manager escalations land on the board below for you to triage.
        </p>
      </div>

      {/* --- 1. Agent go-live controls (Lead + Auditor) --- */}
      <section>
        <SectionLabel>Agents</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          <AgentControl agent={lead} role="platform" session={liveFor(lead?.id)} missingLabel="Platform Lead agent not seeded" />
          <AgentControl agent={auditor} role="auditor" session={liveFor(auditor?.id)} missingLabel="Platform Auditor agent not seeded" />
        </div>
      </section>

      {/* --- 2. Live platform sessions (the Lead/Auditor terminals) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Sessions
          <span style={{ color: color.textMuted, fontWeight: 400 }}>({platformSessions.filter((s) => s.processState === "live").length} live)</span>
        </SectionLabel>
        <PlatformSessions sessions={platformSessions} />
      </section>

      {/* --- 4. Auditor cadence (kind:"auditor" schedules) --- */}
      <section>
        <SectionLabel>Auditor schedule</SectionLabel>
        <AuditorSchedules auditorId={auditor?.id} />
      </section>

      {/* --- 5a. Lead history — every Lead RUN (role:"platform" session), newest-first, live+exited+archived --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Lead history
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            every Lead run — when it ran, context cost, duration; expand to read the transcript
          </span>
        </SectionLabel>
        <RunHistory reservedProjectId={project.id} sessions={platformSessions} role="platform"
          emptyLabel="No Lead runs yet — the Platform Lead hasn’t run." />
      </section>

      {/* --- 5b. Auditor history — every audit RUN (auditor session), newest-first, live+exited+archived --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Auditor history
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            every audit run — trigger, context cost, findings filed; expand to read the transcript
          </span>
        </SectionLabel>
        <RunHistory reservedProjectId={project.id} sessions={platformSessions} role="auditor"
          emptyLabel="No audit runs yet — the Auditor hasn’t run." showFindings />
      </section>

      {/* --- 3. The Platform board — findings + escalations backlog (reused Board component) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Board
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            Auditor findings + manager escalations — triage by dragging cards
          </span>
        </SectionLabel>
        <Board projectId={project.id} />
      </section>
    </div>
  );
}

// One agent's go-live card: live status + a spawn button (disabled while a session is live) and a stop
// button (graceful, when live). Spawn role is the agent's platform role — "platform" (Lead) spawns the
// human-equivalent operator; "auditor" spawns the read-and-file-only Auditor. Both are HUMAN-only REST.
function AgentControl({ agent, role, session, missingLabel }:
  { agent?: Agent; role: "platform" | "auditor"; session?: SessionListItem; missingLabel: string }) {
  const qc = useQueryClient();
  const spawn = useMutation({
    mutationFn: () => api.startSession(agent!.id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const roleLabel = role === "platform" ? "Lead" : "Auditor";

  if (!agent) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>{missingLabel}</span></Panel>;
  }
  const live = session?.processState === "live";
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={role === "platform" ? "phosphor" : "cyan"}>{roleLabel}</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={live || spawn.isPending}
          title={live ? `${roleLabel} is already live` : `Spawn the ${roleLabel} (human go-live)`}
          onClick={() => spawn.mutate()}>
          {spawn.isPending ? "Spawning…" : live ? "Live" : `Spawn ${roleLabel}`}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
    </Panel>
  );
}

// The live platform-session terminals (Lead/Auditor), tiled with a graceful-stop control. Dead/exited
// rows are dropped (the live set only) — mirrors the Terminals grid, scoped to the reserved project.
function PlatformSessions({ sessions }: { sessions: SessionListItem[] }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const live = sessions.filter((s) => s.processState === "live");
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>No platform sessions running. Spawn the Lead or Auditor above.</p>;
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 };
  return (
    <div style={grid}>
      {live.map((s) => (
        <Panel key={s.id} style={{ height: 440, padding: 6, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
              <StatusPill tone={s.busy ? "amber" : "phosphor"} glow={s.busy} label={s.busy ? "busy" : "idle"} />
              <span>{s.agentName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</span>
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <PresetPromptsButton sessionId={s.id} />
              {/* No Fork on platform sessions — forking would mint a second Lead/Auditor and break
                  the singleton invariant (the reason this tile is hand-rolled, not TerminalTile). */}
              <Button style={{ padding: "0 8px" }} disabled={stop.isPending}
                title="Stop this session — graceful Ctrl-C, clean and resumable"
                onClick={() => stop.mutate(s.id)}>Stop</Button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
          <Composer sessionId={s.id} />
        </Panel>
      ))}
    </div>
  );
}

// Cheap client-side cron gate (the daemon does the real parse + 400s anything it can't compute).
function looksLikeCron(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.split(/\s+/).length === 5;
}
function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

// The Auditor's cadence: list its kind:"auditor" schedules (enable/disable + delete) and add a new one.
// A fired auditor schedule boots the Platform Auditor (startAuditor, role locked server-side). Reuses
// the existing schedule REST — createSchedule passes kind:"auditor" so the Scheduler routes it right.
function AuditorSchedules({ auditorId }: { auditorId?: string }) {
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const [cron, setCron] = useState("0 9 * * *");

  const create = useMutation({
    mutationFn: () => api.createSchedule({ agentId: auditorId!, cron: cron.trim(), enabled: true, kind: "auditor" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateSchedule(v.id, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });

  if (!auditorId) return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>No Auditor agent — cannot schedule.</span></Panel>;
  // Surface schedules targeting the Auditor agent (any kind), so an existing cadence is always visible.
  const mine = (schedules.data ?? []).filter((s) => s.agentId === auditorId);
  const cronValid = looksLikeCron(cron);

  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Put the Auditor on a cadence — each fire boots the read-and-file-only Auditor to scan recent transcripts
        and file findings to the board. Reading many transcripts costs tokens, so favour a sparse cadence.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {mine.map((s) => <AuditorScheduleRow key={s.id} s={s} onToggle={(enabled) => toggle.mutate({ id: s.id, enabled })}
          onRemove={() => remove.mutate(s.id)} busy={toggle.isPending || remove.isPending} />)}
        {mine.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No auditor schedule yet.</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 160 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Adding…" : "Add cadence"}
        </Button>
        {create.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(create.error as Error).message.includes("400") ? "Daemon rejected the cron expression." : (create.error as Error).message}</span>}
      </div>
    </Panel>
  );
}

function AuditorScheduleRow({ s, onToggle, onRemove, busy }:
  { s: Schedule; onToggle: (enabled: boolean) => void; onRemove: () => void; busy: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim,
      border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 8px" }}>
      <span style={{ color: color.cyan }}>{s.cron}</span>
      <span style={{ fontSize: 10, color: s.kind === "auditor" ? color.phosphor : color.amber }}>kind:{s.kind}</span>
      <span style={{ flex: 1 }}>next · {fmt(s.nextFireAt)}</span>
      <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted }}>{s.enabled ? "ON" : "OFF"}</span>
      <Button style={{ padding: "0 8px" }} disabled={busy} onClick={() => onToggle(!s.enabled)}>{s.enabled ? "Disable" : "Enable"}</Button>
      <Button variant="danger" style={{ padding: "0 8px" }} disabled={busy} onClick={onRemove}>Delete</Button>
    </div>
  );
}

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

// A platform agent's run history — every RUN of a given `role` is a session of that role in the reserved
// project. Used for BOTH the Auditor (role:"auditor", showFindings) and the Lead (role:"platform", no
// findings — the Lead files no audit_finding events). Runs = api.allSessions() (live+exited) ∪
// api.allArchivedSessions() (god-eye archive, already enriched with projectId), filtered to the reserved
// project's sessions of this role, newest-first by createdAt. The trigger (a schedule's cron, or
// "manual") comes from a run's orchestrationEvents (schedule_fired); the findings-filed list (Auditor
// only) comes from audit_finding events resolved against the reserved board() — fetched only when
// showFindings. Everything reuses EXISTING api methods — no new daemon/REST. The live+exited reserved
// sessions are passed in (already filtered by the page); we add the archive locally.
function RunHistory({ reservedProjectId, sessions, role, emptyLabel, showFindings = false }:
  { reservedProjectId: string; sessions: SessionListItem[]; role: SessionRole; emptyLabel: string; showFindings?: boolean }) {
  const archived = useQuery({ queryKey: ["allArchivedSessions"], queryFn: api.allArchivedSessions, refetchInterval: 8000 });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const board = useQuery({ queryKey: ["board", reservedProjectId], queryFn: () => api.board(reservedProjectId), refetchInterval: 8000, enabled: showFindings });

  // SINGLE-OPEN / LAZY-MOUNT: at most one expanded run's TranscriptPane is mounted (it refetches ~5s, so
  // mounting N would hammer the daemon). Mirrors the Overview Fleet accordion's openId pattern.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  const runs = useMemo(() => {
    const live = sessions.filter((s) => s.role === role); // already reserved-project + non-archived
    const arch = (archived.data ?? []).filter((s) => s.projectId === reservedProjectId && s.role === role);
    return [...live, ...arch].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [sessions, archived.data, reservedProjectId, role]);

  if (runs.length === 0) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.textMuted, fontSize: 12 }}>{emptyLabel}</span></Panel>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} schedules={schedules.data ?? []} tasks={board.data?.tasks ?? []}
          showFindings={showFindings} open={openId === run.id} onToggle={() => toggle(run.id)} />
      ))}
    </div>
  );
}

// One run: timing + a live/exited/archived status pill + trigger (schedule cadence or "manual") +
// model/ctx counters + lastError + (Auditor only, when showFindings) the findings it filed (resolved to
// their board cards), with the transcript expanding inline when open. The trigger + findings come from
// this run's orchestrationEvents (the session id IS the managerSessionId those events are keyed by).
// Refetch only while live. The Lead (role:"platform") files no findings, so showFindings is false there.
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
