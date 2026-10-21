import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { contextWindowForModel, type Agent, type OrchestrationEvent, type SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention } from "../lib/attention";
import { attentionItemInProject } from "../lib/fleet";
import { bySessionActivity, byCreatedStable } from "../lib/sessions";
import { EventRow, FleetRow, worstContext } from "../components/fleet";
import { HarnessMixProvider } from "../components/HarnessPicker";
import Board from "./Board";
import { Panel } from "../components/ui";
import {
  BandEmpty, BandFoot, BandPanel, DataRow, DayBars, KpiDeck, KpiStrip, LaneBar, MeterRow, NodeTabs, SlotPanel,
  type KpiItem,
} from "../components/atlasHome";
import { AttentionList, GateLaneList } from "./WorkspaceHome";
import {
  boardRollup, gateLanes, isLiveSession, mergeThroughput, plural, relativeTime,
  useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import { color, font } from "../theme";

// THE PROJECT NODE — card fd99b2d7 (Atlas P2-1), the project-scoped twin of WorkspaceHome. Same two
// tabs, same grammar, one depth down: every figure is scoped to the ActiveProjectProvider's project,
// which the tree's own project row writes.
//
// ⭐ OWNER-RULED (card c6bdf358, and restated on this card): the board embedded in the Overview tab
// is the owner's PRIMARY board surface. It is the real <Board/>, whole — all its lanes, filters,
// drag and the centred card dialog — never a summary, a trimmed view or a link to one.

const TABS = [{ key: "overview", label: "Overview" }, { key: "deck", label: "Deck" }];

export default function ProjectHome() {
  const [params] = useSearchParams();
  const tab = params.get("tab") === "deck" ? "deck" : "overview";
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const boardQ = useQuery({ queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId, staleTime: 30_000 });
  const archivedQ = useQuery({ queryKey: ["archive", projectId, 100], queryFn: () => api.archivedSessions(projectId), enabled: !!projectId });
  const activeGatesQ = useGatesActive();
  const historyQ = useGateHistoryRecent(projectId || undefined);
  const { items: attention } = useAttention();

  const all = (sessionsQ.data ?? []).filter((s) => s.projectId === projectId);
  const live = all.filter(isLiveSession);
  const managers = all.filter((s) => s.role === "manager").sort(byCreatedStable);
  const workers = all.filter((s) => s.role === "worker").sort(bySessionActivity);
  const liveManagers = managers.filter(isLiveSession);

  // Scoped through the SHARED resolver the classic Overview and Mission Control both use, fed from
  // queries this page already makes — so this list is the same set the old page listed, not a
  // second, Atlas-only idea of "what belongs to this project".
  const sessionProjectIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessionsQ.data ?? []) m.set(s.id, s.projectId);
    for (const s of archivedQ.data?.items ?? []) m.set(s.id, s.projectId);
    return m;
  }, [sessionsQ.data, archivedQ.data]);
  const agentProjectIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agentsQ.data ?? []) m.set(a.id, a.projectId);
    return m;
  }, [agentsQ.data]);
  const projAttention = attention.filter((item) => attentionItemInProject(item, projectId, {
    sessionProjectId: (id) => sessionProjectIndex.get(id),
    agentProjectId: (id) => agentProjectIndex.get(id),
  }));

  const board = boardRollup(boardQ.data?.columns, boardQ.data?.tasks);
  const lanes = gateLanes(activeGatesQ.data, projectId || undefined);
  const merges = mergeThroughput(historyQ.data?.items);
  const wc = worstContext(live);
  const ctxPct = wc.ctx > 0 ? Math.round(wc.ratio * 100) : 0;
  const worstSession = live.find((s) => (s.ctxInputTokens ?? 0) > 0 && s.ctxInputTokens === wc.ctx) ?? null;

  // Spawnable = the agents a human may start by hand. Workers are Loom-DRIVEN (a manager dispatches
  // them onto isolated worktree branches), so they are excluded here for the same reason the classic
  // Overview's spawn grid excludes them — never because they cannot be counted.
  const roleOf = (a: Agent) => profilesQ.data?.find((p) => p.id === a.profileId)?.role ?? null;
  const spawnable = (agentsQ.data ?? []).filter((a) => roleOf(a) !== "worker");

  const eventQs = useQueries({
    queries: liveManagers.map((m) => ({ queryKey: ["orchEvents", m.id], queryFn: () => api.orchestrationEvents(m.id), refetchInterval: 3000 })),
  });
  const events = eventQs
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));

  if (!projectId) {
    return (
      <Panel style={{ maxWidth: 560, padding: "18px 20px" }} data-testid="atlas-project-empty">
        <p style={{ margin: 0, color: color.textDim, fontFamily: font.mono, fontSize: 13, lineHeight: 1.7 }}>
          No project is active yet. Pick one in the entity tree — this node is whichever project the tree has open.
        </p>
      </Panel>
    );
  }

  const kpis: KpiItem[] = [
    {
      key: "needs", label: "needs you", value: projAttention.length,
      tone: projAttention.length > 0 ? "amber" : "muted",
      sub: projAttention.length > 0 ? projAttention.slice(0, 3).map((a) => a.kind.toLowerCase()).join(" · ") : "nothing waiting",
      popover: <AttentionList items={projAttention} cap={8} />,
    },
    {
      key: "fleet", label: "mgr · workers", value: `${liveManagers.length}/${workers.filter(isLiveSession).length}`,
      tone: liveManagers.length > 0 ? "phosphor" : "muted",
      sub: `${live.length} live · ${spawnable.length} spawnable`,
      popover: <FleetList managers={managers} workers={workers} />,
    },
    {
      key: "context", label: "worst context", value: wc.ctx > 0 ? `${ctxPct}%` : "—",
      tone: ctxPct >= 80 ? "amber" : ctxPct >= 95 ? "red" : "phosphor",
      sub: worstSession ? `${worstSession.agentName} · ${plural(worstSession.ctxTurns ?? 0, "turn")}` : "no session reports context",
      fill: wc.ctx > 0 ? wc.ratio : undefined,
      popover: <ContextList sessions={live} />,
    },
    {
      key: "gates", label: "gate run·queued", value: `${lanes.running}·${lanes.queued}`,
      tone: lanes.queued > 0 ? "amber" : lanes.running > 0 ? "phosphor" : "muted",
      sub: `cap ${lanes.cap} · daemon-wide`,
      popover: <GateLaneList lanes={lanes} />,
    },
    {
      key: "cards", label: "open cards", value: board.open,
      tone: board.open > 0 ? "cyan" : "muted",
      sub: `${board.inReview} in review · ${board.waiting} waiting on you`,
      popover: (
        <>
          {board.lanes.map((l) => <DataRow key={l.key} label={l.label} value={l.count} tone={l.count > 0 ? "cyan" : "muted"} />)}
          <BandFoot>{plural(board.total, "card")} on the board, {board.open} of them open.</BandFoot>
        </>
      ),
    },
    {
      key: "merged", label: "merged today", value: merges.branches,
      tone: merges.branches > 0 ? "phosphor" : "muted",
      sub: merges.branches > 0 ? `last ${relativeTime(merges.lastEndedAt)}` : "nothing landed yet",
      popover: (
        <>
          <DayBars series={merges.byDay} label="branches landed per day" />
          <BandFoot>Branches landed per day, last 14. A batched merge counts every branch it landed.</BandFoot>
        </>
      ),
    },
  ];

  const needsPanel = (
    <BandPanel label="Needs you" count={projAttention.length} action={{ to: "/inbox", label: "Inbox" }} testId="atlas-band-needs">
      <AttentionList items={projAttention} cap={6} />
    </BandPanel>
  );
  const fleetPanel = (
    <BandPanel label="Fleet" count={`${live.length} live`}
      action={{ to: "/terminals", label: "Terminals" }} testId="atlas-band-fleet">
      <FleetList managers={managers} workers={workers} />
    </BandPanel>
  );
  const gatePanel = (
    // "Gates", not "Gates & throughput": a band column is ~250px, and the longer label wraps inside
    // its own head. The sparkline below carries its own caption, so nothing is lost by the shorter name.
    <BandPanel label="Gates" count={`cap ${lanes.cap}`} action={{ to: "/gates", label: "All" }} testId="atlas-band-gates">
      <GateLaneList lanes={lanes} />
      <div style={{ marginTop: 10 }}>
        <DayBars series={merges.byDay} label="branches landed per day" />
        <BandFoot>Merges · last 14 days</BandFoot>
      </div>
    </BandPanel>
  );
  const pulsePanel = (
    <BandPanel label="Pulse" count="last 24h" action={{ to: "/runs", label: "Runs" }} testId="atlas-band-pulse">
      {events.length === 0 && <BandEmpty>No orchestration events yet.</BandEmpty>}
      {events.slice(0, 40).map((e) => <EventRow key={e.id} e={e} />)}
    </BandPanel>
  );

  return (
    // Every fleet row below renders a session from THIS project-filtered live set, so it is also what
    // decides whether the view is mixed-harness — the same contract the classic Overview honours.
    <HarnessMixProvider sessions={live}>
      <div className="loom-atlas-home">
        <NodeTabs tabs={TABS} active={tab} hrefFor={(k) => (k === "overview" ? "/project" : `/project?tab=${k}`)}>
          {tab === "deck" && <KpiStrip items={kpis} />}
        </NodeTabs>

        {tab === "overview" ? (
          <>
            <KpiDeck items={kpis} />
            <div className="loom-atlas-band">
              {needsPanel}
              <SlotPanel slot="agents" label="Agents" card="the Agents card (P2-2)"
                what={`The ${spawnable.length || "project"}-agent roster with its spawn controls and the manager go-live guard.`} />
              {fleetPanel}
              {gatePanel}
              {pulsePanel}
            </div>
            <section className="loom-atlas-primary" data-testid="atlas-board-embed">
              <div className="loom-atlas-primaryhead">
                <span className="loom-atlas-primarylbl">Board</span>
                <span className="loom-bandcount">{board.open}</span>
                <span style={{ flex: 1 }} />
                <span className="loom-bandempty" style={{ margin: 0 }}>
                  The same board, whole — every lane, every card, the same filters and the same card dialog.
                </span>
              </div>
              <Board projectId={projectId} />
            </section>
          </>
        ) : (
          <div className="loom-atlas-deck">
            <section className="loom-atlas-deckmain" data-testid="atlas-board-embed">
              <div className="loom-atlas-primaryhead">
                <span className="loom-atlas-primarylbl">Board</span>
                <span className="loom-bandcount">{board.open}</span>
                <span style={{ flex: 1 }} />
                <LaneBar lanes={board.lanes} />
              </div>
              <Board projectId={projectId} />
            </section>
            <aside className="loom-atlas-deckrail">
              {needsPanel}
              {fleetPanel}
              {pulsePanel}
            </aside>
          </div>
        )}
        {project && <span hidden data-testid="atlas-project-name">{project.name}</span>}
      </div>
    </HarnessMixProvider>
  );
}

/** The managers→workers hierarchy as read-only rows. Management (resume/fork/stop) deliberately
 *  stays on the surfaces that own it — the session node and the classic Overview's accordion — so a
 *  band panel is a status read, never a second place to act on a session from. */
function FleetList({ managers, workers }: { managers: SessionListItem[]; workers: SessionListItem[] }) {
  if (managers.length === 0 && workers.length === 0) return <BandEmpty>No sessions in this project.</BandEmpty>;
  const loose = workers.filter((w) => !managers.some((m) => m.id === w.parentSessionId));
  return (
    <>
      {managers.map((m) => (
        <div key={m.id}>
          <FleetRow s={m} star />
          {workers.filter((w) => w.parentSessionId === m.id).map((w) => (
            <div key={w.id} style={{ paddingLeft: 14 }}><FleetRow s={w} /></div>
          ))}
        </div>
      ))}
      {loose.map((w) => <FleetRow key={w.id} s={w} />)}
    </>
  );
}

/** Context occupancy, worst first — the figure that says who needs recycling before the next gate.
 *  Ratio against each session's OWN model window (`contextWindowForModel`), never one page-level
 *  constant: two sessions in one project can legitimately run different windows. */
function ContextList({ sessions }: { sessions: SessionListItem[] }) {
  const rows = sessions
    .filter((s) => (s.ctxInputTokens ?? 0) > 0)
    .map((s) => ({ s, ratio: (s.ctxInputTokens ?? 0) / contextWindowForModel(s.model) }))
    .sort((a, b) => b.ratio - a.ratio);
  if (rows.length === 0) return <BandEmpty>No live session is reporting context yet.</BandEmpty>;
  return (
    <>
      {rows.map(({ s, ratio }) => (
        <MeterRow key={s.id} label={s.agentName} ratio={ratio}
          value={`${Math.round(ratio * 100)}% · ${s.ctxTurns ?? 0}t`}
          tone={ratio >= 0.95 ? "red" : ratio >= 0.8 ? "amber" : "phosphor"} />
      ))}
      <BandFoot>Occupancy against each session's own model window.</BandFoot>
    </>
  );
}
