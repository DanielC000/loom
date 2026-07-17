import { useState, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { Agent, SessionListItem, OrchestrationEvent, Schedule, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, attentionOpenTarget, dismissAttention, type AttentionItem } from "../lib/attention";
import { useOpenRequest } from "../components/requests";
import { bySessionActivity, byCreatedStable, byManagerThenCreated, dedupeSessionsById } from "../lib/sessions";
import { ARCHIVE_INVALIDATE_KEYS } from "../lib/archiveInvalidate";
import { useStopSession, useForkSession, useEndSession } from "../lib/useSessionActions";
import Board from "./Board";
import { TerminalTile } from "../components/TerminalTile";
import { TerminalCard, type TerminalTabs } from "../components/TerminalCard";
import { useSessionQueuesBulk, useSessionWakesBulk, useInvalidateSessionQueueWakesBulk } from "../lib/useSessionQueueWakesBulk";
import { SessionActions } from "../components/SessionActions";
import { SpawnControls } from "../components/SpawnControls";
import { DiffView } from "../components/Diff";
import { Panel, Button, SectionLabel, StatusPill, Badge, Chip, Meter } from "../components/ui";
import {
  Stat, FleetCard, FleetRow, AttentionRow, EventRow, fleetRollup, worstContext,
} from "../components/fleet";
import { ReviewQueue } from "../components/reviewQueue";
import { color, font, tone } from "../theme";
import { RoleBadge } from "../lib/roleDisplay";

// PROJECT OVERVIEW — the project-scoped analog of the Platform page: one scrolling cockpit for the
// active project (header-selected via useActiveProject). It composes the SAME fleet widgets Mission
// Control uses (extracted to components/fleet) against a project-FILTERED session set, plus the
// project's manager go-live controls (mirroring Platform's AgentControl), its live terminals, its
// board, schedules, attention, activity, and archive count. Pure web composition off existing
// endpoints — no new daemon/REST surface. Switching the active project rescopes every section.
export default function Overview() {
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  // The project's agents (for go-live + schedule attribution) and the platform-level profiles (which
  // resolve each agent's role → which agents are managers). Both already cached elsewhere.
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  // Polled (not just invalidation-driven): the accordion below now folds archived rows in as the
  // durable Resume path (finding #15), so a session that just auto-archived should surface here
  // promptly, not only after some other mutation happens to invalidate this query.
  const archived = useQuery({ queryKey: ["archive", projectId], queryFn: () => api.archivedSessions(projectId), enabled: !!projectId, refetchInterval: 5000 });
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
  // Pending merges get pulled out of the flat AttentionRow list and rendered as the SAME rich review
  // cards Mission Control's Review queue uses (the shared ReviewQueue component — diff stats, risk
  // badge, top-risk files, Review → / Approve & merge), so the Overview's merge cards match Mission.
  // Everything else keeps the compact AttentionRow treatment.
  const reviewWorkerIds = projAttention.filter((i) => i.kind === "MERGE REQUEST" && i.workerSessionId).map((i) => i.workerSessionId!);
  const otherAttention = projAttention.filter((i) => i.kind !== "MERGE REQUEST");

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

  // The EXPANDED accordion folds the project's ARCHIVED managers/workers in alongside the live ones —
  // without this, SessionActions' Resume never gets an archived row to act on (canResumeSession alone
  // isn't enough if the caller never feeds it one — finding #15). Kept SEPARATE from managers/workers/
  // all above, which stay live-only for the roll-up severity + worst-context math (fleetRollup/
  // worstContext are deliberately fed the running set only, per lib/fleet.ts).
  const archivedManagers = archived.data?.filter((s) => s.role === "manager") ?? [];
  const archivedWorkers = archived.data?.filter((s) => s.role === "worker") ?? [];
  // Dedupe the live+archived merge by id (live-first ⇒ keep the LIVE row): a session mid-transition
  // live→archived can appear in BOTH source lists, and rendering both yields a duplicate React key
  // (card efd191ea). Presentational only — drops the duplicate, never changes which sessions show.
  const accordionManagers = dedupeSessionsById([...managers, ...archivedManagers]).sort(byCreatedStable);
  const accordionWorkers = dedupeSessionsById([...workers, ...archivedWorkers]);
  const accordionLooseWorkers = accordionWorkers
    .filter((w) => !accordionManagers.some((m) => m.id === w.parentSessionId))
    .sort(bySessionActivity);
  const hasAnySessions = all.length > 0 || (archived.data?.length ?? 0) > 0;

  if (!projectId) return <p style={{ color: color.textMuted, fontFamily: font.mono }}>No project selected — pick a project in the header.</p>;

  const roleOf = (a: Agent) => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // Worker-role agents are EXCLUDED from the spawn grid: workers are Loom-DRIVEN — a manager dispatches
  // them via worker_spawn onto isolated worktree branches — and a human never manually spawns one, so a
  // worker spawn card is clutter + a footgun. Every other agent (managers, plus null/unknown-role agents)
  // still gets a card; each resolves its agent's profile role for the badge + the spawn default.
  const projectAgents = (agents.data ?? []).filter((a) => roleOf(a) !== "worker");
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
            <Stat label="active managers" value={managers.length} />
            <Stat label="active workers" value={workers.length} />
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

      {/* --- Agents spawn (every non-worker project agent — spawn from profile or override the role) --- */}
      <section>
        <SectionLabel>Agents</SectionLabel>
        {projectAgents.length === 0 ? (
          <Panel style={{ padding: 12 }}>
            <span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>
              No manually-spawnable agents — workers are dispatched by a manager, not spawned here. Create one on the Projects page.
            </span>
          </Panel>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
            {projectAgents.map((a) => <AgentControl key={a.id} agent={a} role={roleOf(a)} session={liveSessionFor(a.id)} />)}
          </div>
        )}
      </section>

      {/* --- Attention (promoted into the slot Fleet vacated) — pending merges render as the SAME rich
             review cards Mission Control uses (ReviewQueue, label suppressed so they nest under this
             heading); every other alert keeps the compact AttentionRow. --- */}
      <section>
        <SectionLabel>Attention ({projAttention.length})</SectionLabel>
        {projAttention.length === 0 && <Panel><span style={{ color: color.textMuted }}>Nothing in this project needs you right now.</span></Panel>}
        {reviewWorkerIds.length > 0 && (
          <div style={{ marginBottom: otherAttention.length > 0 ? 12 : 0 }}>
            <ReviewQueue workerIds={reviewWorkerIds} showLabel={false} />
          </div>
        )}
        <OtherAttentionList items={otherAttention} />
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

      {/* --- Fleet (moved BELOW Board) — compact card ⇄ full managers→workers hierarchy --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Fleet
          <Button variant="ghost" style={{ padding: "0 6px" }} title={fleetOpen ? "Collapse to summary" : "Expand to the full hierarchy"}
            onClick={() => setFleet(!fleetOpen)}>{fleetOpen ? "⤡" : "⤢"}</Button>
        </SectionLabel>
        {!hasAnySessions && <Panel><span style={{ color: color.textMuted }}>No sessions in this project.</span></Panel>}
        {hasAnySessions && !fleetOpen && (
          <div style={{ maxWidth: 280 }}>
            <FleetCard name={project?.name ?? projectId} managers={managers} workers={workers}
              archived={archived.data ?? []}
              attention={projAttention.length} onExpand={() => setFleet(true)} />
          </div>
        )}
        {hasAnySessions && fleetOpen && (
          <FleetAccordion managers={accordionManagers} workers={accordionWorkers} looseWorkers={accordionLooseWorkers} />
        )}
      </section>

      {/* --- Schedules (the project's cron schedules, by agent→project) --- */}
      <section>
        <SectionLabel>Schedules</SectionLabel>
        <ProjectSchedules agentIds={new Set((agents.data ?? []).map((a) => a.id))}
          agentName={(id) => agents.data?.find((a) => a.id === id)?.name ?? id.slice(0, 8)} />
      </section>

      {/* --- Activity (the project's manager event feed) --- */}
      <section>
        <SectionLabel>Activity</SectionLabel>
        <Panel grid style={{ maxHeight: "60vh", overflow: "auto" }}>
          {allEvents.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
          {allEvents.slice(0, 100).map((e) => <EventRow key={e.id} e={e} />)}
        </Panel>
      </section>
    </div>
  );
}

// The compact attention rows (everything except the rich merge-review cards) are CAPPED to the first N
// so a project with many open alerts can't grow the Attention list unbounded and push Fleet/Activity/
// Schedules below the fold. Past the cap a local "Show M more"/"Collapse" toggle reveals the full list
// on demand. This is PURELY render-side: the useAttention hook still returns every item, and the header
// count + the "attention" Stat tile above stay wired to the true total (projAttention.length), never
// this capped-visible slice — so the count is honest in both the collapsed and expanded states.
const ATTENTION_COLLAPSED_COUNT = 5;

function OtherAttentionList({ items }: { items: AttentionItem[] }) {
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  const [expanded, setExpanded] = useState(false);
  const overflow = items.length - ATTENTION_COLLAPSED_COUNT;
  // ≤N items ⇒ overflow ≤ 0 ⇒ render every row and NO toggle (byte-identical to the pre-cap output).
  const visible = overflow > 0 && !expanded ? items.slice(0, ATTENTION_COLLAPSED_COUNT) : items;
  // A pending REQUEST item (it carries a questionId) opens the shared in-place modal (URL unchanged);
  // every other openable alert (session/merge) still navigates to its route via attentionOpenTarget.
  const openFor = (item: AttentionItem): (() => void) | undefined => {
    if (item.questionId) return () => openRequest(item.questionId!);
    const t = attentionOpenTarget(item);
    return t ? () => navigate(t) : undefined;
  };
  return (
    <>
      {visible.map((item) => (
        <AttentionRow key={item.key} item={item}
          onOpen={openFor(item)}
          onDismiss={item.dismissKey ? () => dismissAttention(item.dismissKey!) : undefined} />
      ))}
      {overflow > 0 && (
        <div style={{ marginTop: 2 }}>
          <Button variant="ghost" onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse to the first few alerts" : "Show every alert in this project"}
            style={{ padding: "2px 8px", fontFamily: font.mono, fontSize: 11 }}>
            {expanded ? "Collapse" : `Show ${overflow} more`}
          </Button>
        </div>
      )}
    </>
  );
}

// One agent's spawn card — the Overview analog of the old Workspace Sessions-header spawn, brought to
// every non-worker project agent (workers are manager-dispatched, so they're filtered out upstream — see
// projectAgents). It shows the agent's profile-role badge, its name, a live pill if
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
        <RoleBadge role={role} />
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
// (conditional render off `openId`), so we never run N live xterms at once. This lazy-mount is the
// accordion's OWN perf discipline; it lives alongside — and does NOT replace — the standalone
// ProjectTerminals "Terminals" grid below (a deliberately-kept feature that tiles the project's live
// terminals), which the /terminals page also mirrors.
//
// All mutations already exist (mirrors Workspace's wiring) and invalidate the shared ["allSessions"]
// query the page reads — ZERO new daemon/REST. The manager-archive worker-count confirm is built per
// row here, matching Workspace exactly.
// The outer row-list is CAPPED at this height and scrolls internally past it, so a project with many
// sessions can't grow the card into an unbounded wall (card 3fd4d245). Live/recent rows stay reachable
// because the caller feeds the list live-first (the shared byCreatedStable/bySessionActivity order); you
// scroll to reach the older tail. Each row's OWN cockpit stays independently bounded (maxHeight 440) — a
// clamp on the collapsed list, not a re-cap of the inner cockpit. Kept viewport-relative (min(vh, px)) so
// the card never eats the whole screen on a short viewport.
const FLEET_LIST_MAX_HEIGHT = "min(60vh, 620px)";

function FleetAccordion({ managers, workers, looseWorkers }: {
  managers: SessionListItem[]; workers: SessionListItem[]; looseWorkers: SessionListItem[];
}) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  // Rows here can now be ARCHIVED (folded in by the caller so Resume has something to act on — finding
  // #15), so invalidation uses the shared ARCHIVE_INVALIDATE_KEYS (not just ["allSessions"]) — a
  // resumed archived row must drop out of the archive query too, or it'd show live AND archived at once.
  const invalidate = () => ARCHIVE_INVALIDATE_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));

  const resume = useMutation({ mutationFn: (id: string) => api.resumeSession(id), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: (id: string) => api.stopSession(id, "graceful"), onSuccess: invalidate });
  const fork = useMutation({ mutationFn: (id: string) => api.forkSession(id), onSuccess: invalidate });
  // End Session (card f55bd338): the shared hook (invalidates allSessions). It only enqueues the
  // wrap-up turn — the session self-stops later via end_me — so the archive-key invalidate isn't needed.
  const end = useEndSession();
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
    onEnd: () => end.mutate(s.id), ending: end.isPending,
    onClearRateLimit: () => clearRl.mutate(s.id), clearingRateLimit: clearRl.isPending,
  });

  // Rows shown = every manager + every worker (nested + loose partition workers exactly). A subtle
  // count sits pinned above the scroll region as the "showing N" affordance.
  const rowCount = managers.length + workers.length;
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rowCount > 0 && (
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {rowCount} session{rowCount === 1 ? "" : "s"}
        </span>
      )}
      <div style={{ maxHeight: FLEET_LIST_MAX_HEIGHT, overflowY: "auto", display: "flex", flexDirection: "column" }}>
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
      </div>
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
          <SessionCockpit session={s} />
        </div>
      )}
    </div>
  );
}

// A single session's inline cockpit — now a thin binding over the shared <TerminalCard> base (terminal-
// unification epic, stage 3). It renders the SAME Terminal⇄Transcript tabs over a bounded pane plus the
// session's wakes / queued turns / composer, and — via the base — GAINS the standard card chrome the
// hand-rolled version lacked: PresetPrompts + Maximize in the header and the slim bound-task bar. The
// role-scoped Timeline/Diff drill-downs (relocated from the retired Orchestration page) are passed to
// the base's `tabs` prop as ready-rendered panel nodes: a MANAGER contributes a "Timeline" tab (its own
// orchestration_events), a WORKER a "Diff" tab (its branch diff) — both bounded + internally scrollable.
// Lifecycle (Fork/Stop/Resume) stays on the parent FleetCockpitRow's SessionActions cluster, so the card
// itself takes `lifecycle="none"`. Mounted only by an OPEN FleetCockpitRow, so its TerminalPane is the
// one live terminal on the page (single-open); the base mounts the pane only on the Terminal tab.
function SessionCockpit({ session }: { session: SessionListItem }) {
  const tabs: TerminalTabs = {
    ...(session.role === "manager" ? { timeline: <ManagerTimeline managerId={session.id} /> } : null),
    ...(session.role === "worker" ? { diff: <WorkerDiffPanel workerId={session.id} /> } : null),
  };
  return (
    <TerminalCard
      session={session}
      height={500}
      lifecycle="none"
      maximizable
      subPanels={{ queue: true, wakes: true, taskCard: true }}
      tabs={tabs}
    />
  );
}

// Relocated from the retired Orchestration page: the manager's own orchestration_events timeline. Polls
// so it stays live while the manager drills its workers. Mounted only when the Timeline tab is active
// (single-open cockpit), so it never fans out a query per manager. Reuses the shared EventRow.
function ManagerTimeline({ managerId }: { managerId: string }) {
  const events = useQuery({ queryKey: ["orchEvents", managerId], queryFn: () => api.orchestrationEvents(managerId), refetchInterval: 2000, placeholderData: keepPreviousData });
  const list = events.data ?? [];
  return (
    <Panel grid style={{ maxHeight: 440, overflow: "auto" }}>
      {list.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
      {list.map((e) => <EventRow key={e.id} e={e} />)}
    </Panel>
  );
}

// Relocated from the retired Orchestration page: the worker's branch diff (live, incl. uncommitted; or
// the landed diff once merged). The manager→worker→live-diff drill-down that the Orchestration page owned
// now lives here, reached by expanding a worker row under its manager. Mounted only when the Diff tab is
// active. On error (no branch / merged-away) it says so rather than showing an empty pane.
function WorkerDiffPanel({ workerId }: { workerId: string }) {
  const diff = useQuery({ queryKey: ["workerDiff", workerId], queryFn: () => api.workerDiff(workerId), placeholderData: keepPreviousData });
  return (
    <Panel style={{ maxHeight: 440, overflow: "auto" }}>
      {diff.isLoading && <span style={{ color: color.textMuted, fontSize: 12 }}>Loading diff…</span>}
      {diff.isError && <span style={{ color: color.red, fontSize: 12 }}>No diff (worker has no branch, or it was merged/removed).</span>}
      {diff.data && (
        <>
          <div style={{ fontFamily: font.mono, fontSize: 12, color: color.cyan, marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>{diff.data.filesChanged} file(s) · +{diff.data.insertions} −{diff.data.deletions}</span>
            {diff.data.uncommitted && <Badge tone="amber">live · incl. uncommitted</Badge>}
            {diff.data.merged && <Badge tone="phosphor">merged → landed diff</Badge>}
          </div>
          <DiffView patch={diff.data.patch || "(no changes vs HEAD)"} />
        </>
      )}
    </Panel>
  );
}

// The project's live-session terminals, tiled with Fork (idle-only) + ⤢ maximize + graceful Stop —
// at parity with the dedicated Terminals page via the shared TerminalTile component (so the two can't
// drift). Only the live set renders (dead/exited rows drop out). Maximize is self-contained in the
// tile (a full-viewport overlay), so this grid carries no maximize state. Project-scoped, so the tile
// title omits the project name (showProject left off).
function ProjectTerminals({ sessions }: { sessions: SessionListItem[] }) {
  const stop = useStopSession();
  const fork = useForkSession();
  // Manager-first STABLE order (managers first/left, then createdAt DESC within each bucket) shared with
  // the Terminals page — the orchestrator pins to the front and its workers follow to the right, and a
  // session keeps its slot whether busy or idle so the grid never reshuffles on the 3s poll.
  const live = sessions.filter((s) => s.processState === "live").slice().sort(byManagerThenCreated);
  // ONE bulk queue/wakes poll for the whole grid instead of 2×N per-card round-trips (perf profile
  // 2026-07-16 finding #4) — every tile below reads its own slice via queueData/wakesData props instead
  // of running its own useQuery. Called unconditionally (before the early return) per Rules of Hooks; an
  // empty id list short-circuits client-side to a resolved `{}`, no round-trip.
  const liveIds = useMemo(() => live.map((s) => s.id), [live]);
  const queues = useSessionQueuesBulk(liveIds);
  const wakes = useSessionWakesBulk(liveIds);
  const { invalidateQueues, invalidateWakes } = useInvalidateSessionQueueWakesBulk();
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>No live sessions in this project. Spawn the manager above.</p>;

  // alignItems:"start" so each tile sizes to ITS OWN content — a bare card stays short instead of being
  // stretched to the tallest card in its row (which left dead space below its composer). Cards in a row may
  // now differ in height; that's the intended, owner-requested content-dynamic behavior.
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12, alignItems: "start" };
  return (
    <div style={grid}>
      {live.map((s) => (
        <TerminalTile key={s.id} s={s} height={520}
          onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
          onStop={() => stop.mutate(s.id)} stopPending={stop.isPending}
          queueData={queues.data?.[s.id] ?? []} wakesData={wakes.data?.[s.id] ?? []}
          onQueueMutated={invalidateQueues} onWakeCancelled={invalidateWakes} />
      ))}
    </div>
  );
}

// The project's cron schedules — every Schedule whose agent belongs to this project (agent→project),
// read-only here (create/enable/delete live on the Automation page, Time tab). Reuses GET /api/schedules.
function ProjectSchedules({ agentIds, agentName }: { agentIds: Set<string>; agentName: (id: string) => string }) {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const mine = (schedules.data ?? []).filter((s) => agentIds.has(s.agentId));
  if (mine.length === 0) return <Panel><span style={{ color: color.textMuted, fontSize: 12 }}>No schedules for this project. Add one on the Automation page.</span></Panel>;
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
