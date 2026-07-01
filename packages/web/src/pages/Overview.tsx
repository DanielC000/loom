import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, OrchestrationEvent, Schedule, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, attentionOpenTarget, dismissAttention } from "../lib/attention";
import { bySessionActivity, byCreatedStable, byManagerThenCreated } from "../lib/sessions";
import Board from "./Board";
import { TerminalPane } from "../components/Terminal";
import { TerminalTile } from "../components/TerminalTile";
import { TranscriptPane } from "../components/TranscriptPane";
import { Composer } from "../components/Composer";
import { SessionWakes } from "../components/SessionWakes";
import { SessionQueue } from "../components/SessionQueue";
import { SessionActions } from "../components/SessionActions";
import { SpawnControls } from "../components/SpawnControls";
import { Panel, Button, SectionLabel, StatusPill, Badge, Chip, Meter } from "../components/ui";
import {
  Stat, FleetCard, FleetRow, AttentionRow, EventRow, fleetRollup, worstContext,
} from "../components/fleet";
import { color, font, tone, sessionRoleTone as roleTone } from "../theme";

// PROJECT OVERVIEW — the project-scoped analog of the Platform page: one scrolling cockpit for the
// active project (header-selected via useActiveProject). It composes the SAME fleet widgets Mission
// Control uses (extracted to components/fleet) against a project-FILTERED session set, plus the
// project's manager go-live controls (mirroring Platform's AgentControl), its live terminals, its
// board, schedules, attention, activity, and archive count. Pure web composition off existing
// endpoints — no new daemon/REST surface. Switching the active project rescopes every section.
export default function Overview() {
  const navigate = useNavigate();
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  // The project's agents (for go-live + schedule attribution) and the platform-level profiles (which
  // resolve each agent's role → which agents are managers). Both already cached elsewhere.
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const archived = useQuery({ queryKey: ["archive", projectId], queryFn: () => api.archivedSessions(projectId), enabled: !!projectId });
  const { items: attention } = useAttention();

  // Project-filtered session set — every section below scopes off this.
  const all = (sessions.data ?? []).filter((s) => s.projectId === projectId);
  // Managers hold a STABLE slot (createdAt DESC, tiebreak id — newest first) so the cockpit never
  // reshuffles on the 3s poll when a manager flips busy↔idle — matching the Terminal view (see lib/sessions.ts).
  const managers = all.filter((s) => s.role === "manager").sort(byCreatedStable);
  const workers = all.filter((s) => s.role === "worker");
  const roll = fleetRollup(all);
  const wc = worstContext(all);
  const ctxPct = wc.ctx > 0 ? Math.round(wc.ratio * 100) : 0;

  // Each project-manager's event timeline → the project activity feed (same per-manager events MC uses).
  const eventQueries = useQueries({
    queries: managers.map((m) => ({
      queryKey: ["orchEvents", m.id],
      queryFn: () => api.orchestrationEvents(m.id),
      refetchInterval: 3000,
    })),
  });
  const allEvents = eventQueries
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));

  // Attention items that resolve (via their session id) to THIS project — same item→session resolution
  // Mission Control's per-project count uses (sessionId for non-merge alerts, workerSessionId for a merge
  // request; rate-limit items carry neither and so surface globally, not here; their sessions still show
  // red in the fleet rows below).
  const projAttention = attention.filter((item) => {
    const sid = item.sessionId ?? item.workerSessionId;
    const s = sid ? all.find((x) => x.id === sid) : undefined;
    return !!s;
  });

  // Fleet: collapsed → the compact per-project FleetCard summary; expanded (default) → the full
  // managers→workers FleetRow hierarchy. Persisted per project, mirroring Mission Control's expand set.
  const [fleetOpen, setFleetOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(`overview.fleetCollapsed.${projectId}`) !== "1"; }
    catch { return true; }
  });
  const setFleet = (open: boolean) => {
    setFleetOpen(open);
    try { localStorage.setItem(`overview.fleetCollapsed.${projectId}`, open ? "0" : "1"); } catch { /* ignore */ }
  };

  const looseWorkers = workers
    .filter((w) => !managers.some((m) => m.id === w.parentSessionId))
    .sort(bySessionActivity);

  if (!projectId) return <p style={{ color: color.textMuted, fontFamily: font.mono }}>No project selected — pick a project in the header.</p>;

  const roleOf = (a: Agent) => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // ALL the project's agents get a spawn card (mirroring Workspace, which offers spawn for any agent —
  // not just managers). Each card resolves its agent's profile role for the badge + the spawn default.
  const projectAgents = agents.data ?? [];
  // Any live session for this agent — drives the live-status pill and the manager go-live guard below.
  const liveSessionFor = (agentId: string) =>
    all.find((s) => s.agentId === agentId && s.processState === "live");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* --- Header: identity + roll-up status + counts + worst-of context --- */}
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Overview
          <Badge tone="cyan">{project?.name ?? "…"}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            the active project at a glance · switch the project in the header to rescope
          </span>
        </SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <StatusPill tone={roll.tone} label={roll.label} glow={roll.glow} />
          <div style={{ display: "flex", gap: 10 }}>
            <Stat label="managers" value={managers.length} />
            <Stat label="workers" value={workers.length} />
            <Stat label="attention" value={projAttention.length} tone={projAttention.length ? "amber" : "muted"} />
            <Stat label="archived" value={archived.data?.length ?? 0} tone="muted" />
          </div>
          <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 12px", minWidth: 132 }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>worst context</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: font.mono, fontSize: 14, color: tone[ctxPct >= 80 ? "amber" : "phosphor"] }}>{wc.ctx > 0 ? `${ctxPct}%` : "—"}</span>
            </span>
            <Meter value={wc.ctx} max={wc.window || 1} tone={ctxPct >= 80 ? "amber" : "phosphor"} width={110} />
          </div>
        </div>
      </div>

      {/* --- Agents spawn (every project agent — spawn from profile or override the role) --- */}
      <section>
        <SectionLabel>Agents</SectionLabel>
        {projectAgents.length === 0 ? (
          <Panel style={{ padding: 12 }}>
            <span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>
              No agents in this project — create one in Workspace.
            </span>
          </Panel>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
            {projectAgents.map((a) => <AgentControl key={a.id} agent={a} role={roleOf(a)} session={liveSessionFor(a.id)} />)}
          </div>
        )}
      </section>

      {/* --- Fleet (compact card ⇄ full managers→workers hierarchy) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Fleet
          <Button variant="ghost" style={{ padding: "0 6px" }} title={fleetOpen ? "Collapse to summary" : "Expand to the full hierarchy"}
            onClick={() => setFleet(!fleetOpen)}>{fleetOpen ? "⤡" : "⤢"}</Button>
        </SectionLabel>
        {all.length === 0 && <Panel><span style={{ color: color.textMuted }}>No active sessions in this project.</span></Panel>}
        {all.length > 0 && !fleetOpen && (
          <div style={{ maxWidth: 280 }}>
            <FleetCard name={project?.name ?? projectId} managers={managers} workers={workers}
              attention={projAttention.length} onExpand={() => setFleet(true)} />
          </div>
        )}
        {all.length > 0 && fleetOpen && (
          <FleetAccordion managers={managers} workers={workers} looseWorkers={looseWorkers} />
        )}
      </section>

      {/* --- Live terminals (the project's live sessions) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Terminals
          <span style={{ color: color.textMuted, fontWeight: 400 }}>({all.filter((s) => s.processState === "live").length} live)</span>
        </SectionLabel>
        <ProjectTerminals sessions={all} />
      </section>

      {/* --- Board (the project's kanban — same component, project-scoped) --- */}
      <section>
        <SectionLabel>Board</SectionLabel>
        <Board projectId={projectId} />
      </section>

      {/* --- Schedules (the project's cron schedules, by agent→project) --- */}
      <section>
        <SectionLabel>Schedules</SectionLabel>
        <ProjectSchedules agentIds={new Set((agents.data ?? []).map((a) => a.id))}
          agentName={(id) => agents.data?.find((a) => a.id === id)?.name ?? id.slice(0, 8)} />
      </section>

      {/* --- Attention + Activity --- */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
        <section>
          <SectionLabel>Attention ({projAttention.length})</SectionLabel>
          {projAttention.length === 0 && <Panel><span style={{ color: color.textMuted }}>Nothing in this project needs you right now.</span></Panel>}
          {projAttention.map((item) => (
            <AttentionRow key={item.key} item={item}
              onOpen={(() => { const t = attentionOpenTarget(item); return t ? () => navigate(t) : undefined; })()}
              onDismiss={item.dismissKey ? () => dismissAttention(item.dismissKey!) : undefined} />
          ))}
        </section>
        <section>
          <SectionLabel>Activity</SectionLabel>
          <Panel grid style={{ maxHeight: "60vh", overflow: "auto" }}>
            {allEvents.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
            {allEvents.slice(0, 100).map((e) => <EventRow key={e.id} e={e} />)}
          </Panel>
        </section>
      </div>
    </div>
  );
}

// One agent's spawn card — the Overview analog of Workspace's Sessions-header spawn, brought to EVERY
// project agent (not just managers). It shows the agent's profile-role badge, its name, a live pill if
// the agent has a live session, and the SHARED SpawnControls split-button (spawn from profile, or
// override the role → manager/plain) wired to api.startSession(agent.id, role).
//
// MANAGER GO-LIVE GUARD (preserved from the old ManagerControl): a manager-role agent that's ALREADY
// live must not be re-spawned — a human double-spawning the orchestrator is a footgun — so it keeps the
// disabled "Live" button + a graceful Stop instead of the spawn split-button. Every other agent (incl.
// a non-manager that happens to be live) keeps spawn always-enabled, matching Workspace (which never
// disables spawn). Live-session management (Fork/Resume/Stop) lives in the Fleet accordion below, so
// this card stays spawn-focused; only the manager Stop is retained here as part of the guard.
function AgentControl({ agent, role, session }: { agent: Agent; role: SessionRole | null; session?: SessionListItem }) {
  const qc = useQueryClient();
  const spawn = useMutation({
    mutationFn: (r?: "manager" | "plain") => api.startSession(agent.id, r),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const live = session?.processState === "live";
  const managerLive = role === "manager" && live;
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={role ? roleTone[role] : "muted"}>{role ?? "plain"}</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {live && <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "live"} />}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {managerLive ? (
          <Button variant="primary" disabled title="Manager is already live">Live</Button>
        ) : (
          <SpawnControls profileRole={role} onSpawn={(r) => spawn.mutate(r)} pending={spawn.isPending} />
        )}
        {managerLive && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
    </Panel>
  );
}

// The expanded Fleet as an inline-accordion session cockpit: the managers→workers hierarchy, where
// each row carries its state-appropriate quick-actions (the SHARED SessionActions cluster, identical
// to Workspace) + an expand caret. Clicking a row expands IN PLACE to that session's cockpit
// (Terminal⇄Transcript + wakes/queue/composer), nested under the row.
//
// SINGLE-OPEN / LAZY-MOUNT (the load-bearing perf constraint): one `openId` — at most one row is
// expanded, so at most ONE SessionCockpit (hence ONE TerminalPane + its websocket) is mounted across
// the whole fleet. The cockpit mounts on expand and unmounts on collapse or when another row opens
// (conditional render off `openId`), so we never run N live xterms at once. This replaced the old
// standalone ProjectTerminals "Terminals" section (which tiled ALL live terminals simultaneously —
// directly contradicting this constraint); the all-terminals view still lives on the /terminals page.
//
// All mutations already exist (mirrors Workspace's wiring) and invalidate the shared ["allSessions"]
// query the page reads — ZERO new daemon/REST. The manager-archive worker-count confirm is built per
// row here, matching Workspace exactly.
function FleetAccordion({ managers, workers, looseWorkers }: {
  managers: SessionListItem[]; workers: SessionListItem[]; looseWorkers: SessionListItem[];
}) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  const invalidate = () => qc.invalidateQueries({ queryKey: ["allSessions"] });

  const resume = useMutation({ mutationFn: (id: string) => api.resumeSession(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id, "graceful"), onSuccess: invalidate });
  const fork = useMutation({ mutationFn: (id: string) => api.forkSession(id), onSuccess: invalidate });
  const clearRl = useMutation({
    mutationFn: (id: string) => api.clearSessionRateLimit(id),
    onSuccess: invalidate, onError: (e) => window.alert((e as Error).message),
  });

  // Build the SessionActions props for a row. Manual archive was removed (archiving is automatic on
  // session exit — Card A); stopped sessions live on the Archive page.
  const actionsFor = (s: SessionListItem) => ({
    onResume: () => resume.mutate(s.id), resuming: resume.isPending,
    onStop: () => stop.mutate(s.id), stopping: stop.isPending,
    onFork: () => fork.mutate(s.id), forking: fork.isPending,
    onClearRateLimit: () => clearRl.mutate(s.id), clearingRateLimit: clearRl.isPending,
  });

  return (
    <Panel>
      {managers.map((m) => (
        <div key={m.id} style={{ marginBottom: 8 }}>
          <FleetCockpitRow s={m} star open={openId === m.id} onToggle={() => toggle(m.id)} actions={actionsFor(m)} />
          {workers.filter((w) => w.parentSessionId === m.id).sort(byCreatedStable).map((w) => (
            <div key={w.id} style={{ paddingLeft: 16 }}>
              <FleetCockpitRow s={w} open={openId === w.id} onToggle={() => toggle(w.id)} actions={actionsFor(w)} />
            </div>
          ))}
        </div>
      ))}
      {looseWorkers.map((w) => (
        <FleetCockpitRow key={w.id} s={w} open={openId === w.id} onToggle={() => toggle(w.id)} actions={actionsFor(w)} />
      ))}
      {managers.length === 0 && looseWorkers.length === 0 && (
        <span style={{ color: color.textMuted, fontSize: 12 }}>idle — no live manager</span>
      )}
    </Panel>
  );
}

// One fleet row: the read-only FleetRow summary + a caret + the shared per-state action cluster, with
// the session's cockpit expanding nested below when `open`. The cockpit (and its lone TerminalPane) is
// rendered ONLY when open — the single-open lazy-mount that bounds the page to one live xterm.
function FleetCockpitRow({ s, star, open, onToggle, actions }: {
  s: SessionListItem; star?: boolean; open: boolean; onToggle: () => void;
  actions: Omit<Parameters<typeof SessionActions>[0], "s">;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={onToggle} title={open ? "Collapse this session" : "Expand to this session's cockpit"}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 2px",
            color: open ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 12 }}>
          {open ? "▾" : "▸"}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}><FleetRow s={s} star={star} /></div>
        <SessionActions s={s} {...actions} />
      </div>
      {open && (
        <div style={{ marginLeft: 10, marginTop: 6, paddingLeft: 10, borderLeft: `1px solid ${color.phosphor}` }}>
          <SessionCockpit sessionId={s.id} />
        </div>
      )}
    </div>
  );
}

// A single session's inline cockpit — Terminal⇄Transcript tabs over a bounded pane, plus the session's
// wakes / queued turns / composer. Reuses the standalone components AS-IS; mirrors Workspace's
// right-hand cockpit. Mounted only by an OPEN FleetCockpitRow, so its TerminalPane is the one live
// terminal on the page (single-open). The pane height is fixed (the page itself scrolls).
function SessionCockpit({ sessionId }: { sessionId: string }) {
  const [tab, setTab] = useState<"terminal" | "transcript">("terminal");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ marginBottom: 6, display: "flex", gap: 6 }}>
        {(["terminal", "transcript"] as const).map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "default"} onClick={() => setTab(t)}>
            {t === "terminal" ? "Terminal" : "Transcript"}
          </Button>
        ))}
      </div>
      <div style={{ height: 440, minHeight: 0 }}>
        {tab === "terminal" ? <TerminalPane sessionId={sessionId} /> : <TranscriptPane sessionId={sessionId} />}
      </div>
      <SessionWakes sessionId={sessionId} />
      <SessionQueue sessionId={sessionId} />
      <Composer sessionId={sessionId} />
    </div>
  );
}

// The project's live-session terminals, tiled with Fork (idle-only) + ⤢ maximize + graceful Stop —
// at parity with the dedicated Terminals page via the shared TerminalTile component (so the two can't
// drift). Only the live set renders (dead/exited rows drop out). Maximize is self-contained in the
// tile (a full-viewport overlay), so this grid carries no maximize state. Project-scoped, so the tile
// title omits the project name (showProject left off).
function ProjectTerminals({ sessions }: { sessions: SessionListItem[] }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  // Fork an idle session: branch its conversation into a fresh divergent session (appears as a new
  // tile). Idle-only — the button is disabled while the source is busy.
  const fork = useMutation({
    mutationFn: (id: string) => api.forkSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  // Manager-first STABLE order (managers first/left, then createdAt DESC within each bucket) shared with
  // the Terminals page — the orchestrator pins to the front and its workers follow to the right, and a
  // session keeps its slot whether busy or idle so the grid never reshuffles on the 3s poll.
  const live = sessions.filter((s) => s.processState === "live").slice().sort(byManagerThenCreated);
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>No live sessions in this project. Spawn the manager above.</p>;

  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 };
  return (
    <div style={grid}>
      {live.map((s) => (
        <TerminalTile key={s.id} s={s} height={520}
          onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
          onStop={() => stop.mutate(s.id)} stopPending={stop.isPending} />
      ))}
    </div>
  );
}

// The project's cron schedules — every Schedule whose agent belongs to this project (agent→project),
// read-only here (create/enable/delete live on the dedicated Schedules page). Reuses GET /api/schedules.
function ProjectSchedules({ agentIds, agentName }: { agentIds: Set<string>; agentName: (id: string) => string }) {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const mine = (schedules.data ?? []).filter((s) => agentIds.has(s.agentId));
  if (mine.length === 0) return <Panel><span style={{ color: color.textMuted, fontSize: 12 }}>No schedules for this project. Add one on the Schedules page.</span></Panel>;
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {mine.map((s) => <ScheduleRow key={s.id} s={s} agentName={agentName(s.agentId)} />)}
    </Panel>
  );
}

function ScheduleRow({ s, agentName }: { s: Schedule; agentName: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim,
      border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 8px" }}>
      <span style={{ color: color.cyan }}>{s.cron}</span>
      <Chip label="agent" value={agentName} />
      <span style={{ fontSize: 10, color: s.kind === "auditor" ? color.phosphor : color.amber }}>kind:{s.kind}</span>
      <span style={{ flex: 1 }}>next · {s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : "—"}</span>
      <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted }}>{s.enabled ? "ON" : "OFF"}</span>
    </div>
  );
}
