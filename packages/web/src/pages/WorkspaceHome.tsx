import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { OrchestrationEvent, Project, SessionListItem, UsageLimitsStatus } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, attentionOpenTarget, dismissAttention } from "../lib/attention";
import { useOpenRequest } from "../components/requests";
import { AttentionRow, EventRow } from "../components/fleet";
import { Badge, Button, Dot, Panel, StatusPill } from "../components/ui";
import {
  BandEmpty, BandFoot, BandPanel, DataRow, DayBars, KpiDeck, KpiStrip, LaneBar, MeterRow, NodeTabs,
  PlanUsageDetail, relativeResets, type KpiItem,
} from "../components/atlasHome";
import { FleetControlsBar } from "../components/fleetControls";
import { CompactMergeAction } from "../components/reviewQueue";
import { RoleBadge } from "../lib/roleDisplay";
import { sessionVitals, standingOperators } from "../lib/atlasAgents";
import {
  boardRollup, gateLanes, isLiveSession, lastMergeByProject, liveCountsByProject, mergeThroughput,
  plural, relativeTime, useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import { isCompanionSession } from "../lib/sessions";
import { color, font, type Tone } from "../theme";
import { useNavigate } from "react-router-dom";

// THE WORKSPACE ROOT NODE — card fd99b2d7 (Atlas P2-1, the owner-approved round-4 V2 design:
// Mockups/2026-10-19 UI Overhaul Round 4). Overview is the default landing (full-size KPI tiles over
// a dashboard band over the project grid); Deck is the same node read board-first, with the readouts
// shrunk onto the tab row and a standing rail beside the grid.
//
// "Scope is depth": this node is the shallowest thing containing every project, so every figure here
// is cross-project. Nothing on this page reads the active project.
//
// ⛔ Composed from EXISTING `api.*` calls only (docs/plans/atlas-ui/02-architecture.md's hard rule),
// through the cache keys the classic pages already fill — so this node adds no poll Mission Control
// or the Gates page was not already making.

const TABS = [{ key: "overview", label: "Overview" }, { key: "deck", label: "Deck" }];

export default function WorkspaceHome() {
  const [params] = useSearchParams();
  const tab = params.get("tab") === "deck" ? "deck" : "overview";
  const { projects, setProjectId } = useActiveProject();
  const navigate = useNavigate();

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const usageQ = useQuery<UsageLimitsStatus>({ queryKey: ["usageLimits"], queryFn: api.usageLimits, refetchInterval: 30_000 });
  const activeGatesQ = useGatesActive();
  const historyQ = useGateHistoryRecent();
  const { items: attention } = useAttention();

  const sessions = sessionsQ.data ?? [];
  // Companions are standing, human-facing sessions rather than fleet members — the tree's own live
  // marker excludes them, so these counts do too or the two would disagree on one screen.
  const fleet = sessions.filter((s) => !isCompanionSession(s));
  const live = fleet.filter(isLiveSession);
  const managers = live.filter((s) => s.role === "manager");
  const workers = live.filter((s) => s.role === "worker");
  const liveByProject = useMemo(() => liveCountsByProject(sessions), [sessions]);
  // Off the FULL session list, not `fleet`: these are exactly the rows the fleet filter removes.
  const operators = useMemo(() => standingOperators(sessions), [sessions]);
  const activeProjects = projects.filter((p) => (liveByProject.get(p.id) ?? 0) > 0);

  const lanes = gateLanes(activeGatesQ.data);
  const merges = mergeThroughput(historyQ.data?.items);
  const lastMerge = useMemo(() => lastMergeByProject(historyQ.data?.items), [historyQ.data]);
  const usage = usageQ.data?.available ? usageQ.data : null;
  const fiveHour = usage?.fiveHour ?? null;

  // One board read per project, sharing the EXACT ["board", id] entry pages/Board.tsx fills — so a
  // project card's open-card count is the same number that project's board shows, and opening it
  // from here is already warm. No refetchInterval: the grid is a glance, and the board page itself
  // owns the live cadence once you are actually looking at one.
  const boardQs = useQueries({
    queries: projects.map((p) => ({ queryKey: ["board", p.id], queryFn: () => api.board(p.id), staleTime: 30_000 })),
  });
  const boards = new Map(projects.map((p, i) => [p.id, boardRollup(boardQs[i]?.data?.columns, boardQs[i]?.data?.tasks)]));
  const openCards = [...boards.values()].reduce((n, b) => n + b.open, 0);

  // The cross-project pulse, from the SAME per-manager event queries Mission Control runs (same keys
  // ⇒ one shared cache entry, not a second poll of the same endpoint).
  const eventQs = useQueries({
    queries: managers.map((m) => ({ queryKey: ["orchEvents", m.id], queryFn: () => api.orchestrationEvents(m.id), refetchInterval: 3000 })),
  });
  const events = eventQs
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
  const projectByManager = new Map(managers.map((m) => [m.id, m.projectName]));

  const kpis: KpiItem[] = [
    {
      key: "projects", label: "projects", value: projects.length,
      sub: `${activeProjects.length} active · ${projects.length - activeProjects.length} idle`,
      popover: (
        <>
          {projects.length === 0 && <BandEmpty>No projects yet.</BandEmpty>}
          {projects.map((p) => (
            <DataRow key={p.id} label={p.name}
              tone={(liveByProject.get(p.id) ?? 0) > 0 ? "phosphor" : "muted"}
              value={(liveByProject.get(p.id) ?? 0) > 0 ? `${liveByProject.get(p.id)} live` : "idle"} />
          ))}
        </>
      ),
    },
    {
      key: "live", label: "live sessions", value: live.length,
      sub: `${plural(managers.length, "manager")} · ${plural(workers.length, "worker")}`,
      tone: live.length > 0 ? "phosphor" : "muted",
      popover: (
        <>
          {live.length === 0 && <BandEmpty>Nothing is running.</BandEmpty>}
          {live.slice(0, 12).map((s) => (
            <DataRow key={s.id} label={`${s.agentName}${s.role ? ` · ${s.role}` : ""}`}
              tone={s.busy ? "amber" : "phosphor"} value={s.busy ? "busy" : "idle"} title={s.projectName} />
          ))}
          <BandFoot>Live sessions across every project. Workers are dispatched by a manager, never spawned here.</BandFoot>
        </>
      ),
    },
    {
      key: "needs", label: "needs you", value: attention.length,
      tone: attention.length > 0 ? "amber" : "muted",
      sub: attentionSummary(attention.map((a) => a.kind)),
      popover: <AttentionList items={attention} cap={8} />,
    },
    {
      key: "gates", label: "gate run·queued", value: `${lanes.running}·${lanes.queued}`,
      tone: lanes.queued > 0 ? "amber" : lanes.running > 0 ? "phosphor" : "muted",
      sub: `cap ${lanes.cap} · daemon-wide`,
      popover: <GateLaneList lanes={lanes} />,
    },
    {
      key: "plan", label: "plan 5h", value: fiveHour ? `${Math.round(fiveHour.utilization)}%` : "—",
      tone: !fiveHour ? "muted" : fiveHour.utilization >= 95 ? "red" : fiveHour.utilization >= 80 ? "amber" : "phosphor",
      sub: fiveHour ? `resets ${relativeResets(fiveHour.resetsAt)}` : (usageQ.data && !usageQ.data.available ? usageQ.data.reason : "loading…"),
      fill: fiveHour ? fiveHour.utilization / 100 : undefined,
      popover: <PlanUsageDetail usage={usage} />,
    },
    {
      key: "merged", label: "merged today", value: merges.branches,
      tone: merges.branches > 0 ? "phosphor" : "muted",
      sub: merges.branches > 0 ? `${relativeTime(merges.lastEndedAt)} · across ${plural(merges.projects, "project")}` : "nothing landed yet",
      popover: (
        <>
          <DayBars series={merges.byDay} label="branches landed per day" />
          <BandFoot>Branches landed per day, last 14. A batched merge counts every branch it landed.</BandFoot>
        </>
      ),
    },
  ];

  const needsPanel = (
    <BandPanel label="Needs you" count={attention.length} action={{ to: "/inbox", label: "Inbox" }}
      testId="atlas-band-needs" style={{ gridColumn: "span 1" }}>
      <AttentionList items={attention} cap={6} />
    </BandPanel>
  );
  // The standing, cross-project operators — the complement of the fleet counts above, which
  // deliberately exclude them (card c6160c7d).
  //
  // @decision c6160c7d — a READOUT. Never put a second go-live control for the Platform Lead or
  // the Companion here: each is a singleton whose spawn is gated by its own surface's rules, and a
  // second copy of that gating is one that drifts.
  const operatorsPanel = (
    <BandPanel label="Operators" count={operators.length} action={{ to: "/platform", label: "Platform" }}
      testId="atlas-band-operators">
      <OperatorList operators={operators} />
    </BandPanel>
  );
  const gatePanel = (
    <BandPanel label="Gate lanes" count={`cap ${lanes.cap}`} action={{ to: "/gates", label: "Gates" }} testId="atlas-band-gates">
      <GateLaneList lanes={lanes} />
    </BandPanel>
  );
  const pulsePanel = (
    <BandPanel label="Pulse" action={{ to: "/", label: "Mission" }} testId="atlas-band-pulse">
      {events.length === 0 && <BandEmpty>No orchestration events yet.</BandEmpty>}
      {events.slice(0, 40).map((e) => <EventRow key={e.id} e={e} projectName={projectByManager.get(e.managerSessionId)} />)}
    </BandPanel>
  );

  const grid = (
    <ProjectGrid projects={projects} boards={boards} liveByProject={liveByProject} lastMerge={lastMerge}
      sessions={fleet} onOpen={(id) => { setProjectId(id); navigate("/project"); }} />
  );

  return (
    <div className="loom-atlas-home">
      <NodeTabs tabs={TABS} active={tab} hrefFor={(k) => (k === "overview" ? "/home" : `/home?tab=${k}`)}>
        {tab === "deck" && <KpiStrip items={kpis} />}
      </NodeTabs>

      {tab === "overview" ? (
        <>
          <KpiDeck items={kpis} />
          {/* The four daemon-global fleet controls (clear usage hold / pause / resume / kill all) take
              this full-width bar under the deck in the approved design — card 7b893d54. The Deck tab
              deliberately does NOT carry it: that tab's whole trade is vertical room for the board, and
              the crumb-bar chip already reaches these controls from every node including this one. */}
          <FleetControlsBar />
          <div className="loom-atlas-band">
            {needsPanel}
            {operatorsPanel}
            {gatePanel}
            <BandPanel label="Plan usage" action={{ to: "/usage", label: "Usage" }} testId="atlas-band-plan">
              <PlanUsageDetail usage={usage} />
            </BandPanel>
            {pulsePanel}
          </div>
          <section className="loom-atlas-primary">
            <div className="loom-atlas-primaryhead">
              <span className="loom-atlas-primarylbl">Projects</span>
              <span className="loom-bandcount">{projects.length}</span>
              <span style={{ flex: 1 }} />
              <Link to="/projects" className="loom-btn loom-btn-default loom-bandlink">New project <span aria-hidden>↗</span></Link>
            </div>
            {grid}
          </section>
        </>
      ) : (
        <div className="loom-atlas-deck">
          <section className="loom-atlas-deckmain">
            <div className="loom-atlas-primaryhead">
              <span className="loom-atlas-primarylbl">Projects</span>
              <span className="loom-bandcount">{projects.length}</span>
              <span style={{ flex: 1 }} />
              <Link to="/projects" className="loom-btn loom-btn-default loom-bandlink">New project <span aria-hidden>↗</span></Link>
            </div>
            {grid}
            <p className="loom-bandempty" style={{ marginTop: 10 }}>
              {plural(openCards, "open card")} across {plural(projects.length, "project")}. The reserved Platform home is pinned in the tree, not listed here.
            </p>
          </section>
          <aside className="loom-atlas-deckrail">
            {needsPanel}
            {operatorsPanel}
            {gatePanel}
            {pulsePanel}
          </aside>
        </div>
      )}
    </div>
  );
}

// ── Shared pieces ──────────────────────────────────────────────────────────────────────────────

/** "2 decisions · 1 merge · 1 push" — the attention queue's own composition, in its own words. */
function attentionSummary(kinds: string[]): string {
  if (kinds.length === 0) return "nothing waiting";
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k.toLowerCase(), (counts.get(k.toLowerCase()) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(" · ");
}

/**
 * The attention queue as compact rows, capped so one noisy project cannot make a panel the page.
 * Each row keeps its real affordances: a pending Request opens the shared modal (never a navigation
 * away from here), everything else deep-links to its own session or diff.
 *
 * A MERGE REQUEST is the one kind whose action is a WRITE rather than a navigation, so it gets the
 * row's second line instead (card c2968651, gap a — the decision record is on `CompactMergeAction`).
 * Its `onOpen` is deliberately dropped: the footer's own `Review →` IS that affordance.
 *
 * FOUR mounts read this — the Needs-you band panel and the `needs you` KPI pop-over, at each of the
 * two levels — so wiring it here puts the action in all four. No classic surface reaches it: Mission
 * Control and the project Overview both filter MERGE REQUEST out and render the rich card instead.
 * `compact` (card d0d430d4) rides on that same fact — this is the only Atlas-side AttentionRow caller.
 */
export function AttentionList({ items, cap }: { items: ReturnType<typeof useAttention>["items"]; cap: number }) {
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  if (items.length === 0) return <BandEmpty>Nothing needs you right now.</BandEmpty>;
  const shown = items.slice(0, cap);
  return (
    <>
      {shown.map((item) => {
        const workerId = item.kind === "MERGE REQUEST" ? item.workerSessionId : null;
        const footer = workerId
          ? <CompactMergeAction workerId={workerId} onReview={() => navigate(`/review/${workerId}`)} />
          : undefined;
        return (
          <AttentionRow key={item.key} item={item} footer={footer} compact
            onOpen={footer
              ? undefined
              : item.questionId
                ? () => openRequest(item.questionId!)
                : (() => { const t = attentionOpenTarget(item); return t ? () => navigate(t) : undefined; })()}
            onDismiss={item.dismissKey ? () => dismissAttention(item.dismissKey!) : undefined} />
        );
      })}
      {items.length > shown.length && (
        <BandFoot>+{items.length - shown.length} more in the Inbox</BandFoot>
      )}
    </>
  );
}

/**
 * The standing operators, as a status read with a way out to the surface that owns each one.
 *
 * Deliberately NOT a second place to start or stop one: a Platform Lead's spawn is gated by the
 * install's edition and a singleton rule that live on the Platform node, and a Companion is
 * provisioned by a wizard, not a split button. The exits carry the reader to the real control
 * rather than this panel carrying a second, thinner copy of the gating around it.
 */
function OperatorList({ operators }: { operators: ReturnType<typeof standingOperators> }) {
  if (operators.length === 0) {
    return (
      <>
        <BandEmpty>No standing operator is running.</BandEmpty>
        <BandFoot>
          Start the Platform Lead from the <Link to="/platform" className="loom-inlinelink">Platform</Link> node,
          or provision a companion from <Link to="/companion" className="loom-inlinelink">Companion</Link>.
        </BandFoot>
      </>
    );
  }
  return (
    <>
      {operators.map(({ session, role, home }) => (
        <div key={session.id} className="loom-operrow" data-testid={`atlas-operator-${session.id}`}>
          <div className="loom-agentrow-head">
            <RoleBadge role={role} />
            <strong className="loom-agentrow-name" title={session.agentName}>{session.agentName}</strong>
            <span style={{ flex: 1 }} />
            <StatusPill tone={session.busy ? "amber" : "phosphor"} glow={session.busy}
              label={session.busy ? "busy" : "live"} />
          </div>
          <div className="loom-operrow-foot">
            <span className="loom-agentrow-meta">{sessionVitals(session) || session.projectName}</span>
            <span style={{ flex: 1 }} />
            <Link to={home.to} className="loom-inlinelink" title={`Manage this operator on ${home.label}`}>
              {home.label} <span aria-hidden>↗</span>
            </Link>
          </div>
        </div>
      ))}
      <BandFoot>Cross-project operators. Their controls live on the surface that owns each one.</BandFoot>
    </>
  );
}

/** The semaphore's live occupancy: the lane fill, then a row per run. `cap` is daemon-global, so the
 *  fill is "how much of the HOST's budget is in use", not this project's own allowance. */
export function GateLaneList({ lanes }: { lanes: ReturnType<typeof gateLanes> }) {
  return (
    <>
      <MeterRow label={`${lanes.running}·${lanes.queued}`} value={`cap ${lanes.cap}`}
        ratio={lanes.cap > 0 ? lanes.running / lanes.cap : 0}
        tone={lanes.queued > 0 ? "amber" : "phosphor"} />
      {lanes.runs.length === 0 && <BandEmpty>No gate is running or queued.</BandEmpty>}
      {lanes.runs.map((g) => (
        <DataRow key={g.id}
          label={<><Dot tone={g.phase === "running" ? "amber" : "muted"} style={{ marginRight: 6 }} />{g.gateType} <span style={{ color: color.textMuted }}>{g.projectName}</span></>}
          tone={g.phase === "running" ? "amber" : "muted"}
          value={g.phase === "running" ? relativeTime(g.since).replace(" ago", "") : `queued${g.queuePosition ? ` ·${g.queuePosition}` : ""}`}
          title={g.workerLabel ?? g.branch ?? undefined} />
      ))}
    </>
  );
}

// ── The project grid ───────────────────────────────────────────────────────────────────────────
// At the Workspace root the project grid stands where the board stands at the project node: the one
// thing on the page that is a list of the real work, at full size and never summarised away.

function ProjectGrid({ projects, boards, liveByProject, lastMerge, sessions, onOpen }: {
  projects: Project[];
  boards: Map<string, ReturnType<typeof boardRollup>>;
  liveByProject: Map<string, number>;
  lastMerge: Map<string, string>;
  sessions: SessionListItem[];
  onOpen: (projectId: string) => void;
}) {
  if (projects.length === 0) {
    return (
      <Panel data-testid="atlas-project-grid" style={{ padding: 16 }}>
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12.5 }}>
          No projects yet — create one from the Projects node.
        </span>
      </Panel>
    );
  }
  return (
    <div className="loom-projgrid" data-testid="atlas-project-grid">
      {projects.map((p) => {
        const board = boards.get(p.id);
        const liveCount = liveByProject.get(p.id) ?? 0;
        const own = sessions.filter((s) => s.projectId === p.id && isLiveSession(s));
        const mgr = own.filter((s) => s.role === "manager").length;
        const wrk = own.filter((s) => s.role === "worker").length;
        const landed = lastMerge.get(p.id);
        return (
          // A button, not a link: opening a project both SELECTS it (one ActiveProjectProvider, the
          // same one the tree writes) and navigates to its node — an anchor would carry only half of
          // that and leave the page scoped to whatever was active before.
          <button key={p.id} type="button" className="loom-projcard" data-testid={`atlas-project-card-${p.id}`}
            title={`Open ${p.name}`} onClick={() => onOpen(p.id)}>
            <span className="loom-projcard-head">
              <Dot tone={liveCount > 0 ? "phosphor" : "muted"} glow={liveCount > 0} />
              <span className="loom-projcard-name">{p.name}</span>
              {liveCount > 0 && <Badge tone="phosphor">{liveCount}</Badge>}
            </span>
            <span className="loom-projcard-meta">
              {liveCount > 0 ? `${plural(mgr, "manager")} · ${plural(wrk, "worker")}` : "idle"}
              {board && ` · ${plural(board.open, "open card")}`}
            </span>
            {board && <LaneBar lanes={board.lanes} />}
            <span className="loom-projcard-foot">
              {landed ? `merged ${relativeTime(landed)}` : p.repoPath ? "no landing recorded yet" : "no repository bound yet"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
