import { useMemo, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { contextWindowForModel, resolveConfig, type OrchestrationEvent, type SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention } from "../lib/attention";
import { attentionItemInProject } from "../lib/fleet";
import { bySessionActivity, byCreatedStable } from "../lib/sessions";
import { EventRow, FleetRow, worstContext } from "../components/fleet";
import { HarnessMixProvider } from "../components/HarnessPicker";
import Board from "./Board";
import Terminals from "./Terminals";
import AgentsNode from "./AgentsNode";
import Repository from "./Repository";
import Memory from "./Memory";
import Runs from "./Runs";
import Archive from "./Archive";
import Settings from "./Settings";
import { Panel } from "../components/ui";
import {
  AtlasNodeHead, BandDisclosure, BandEmpty, BandFoot, BandPanel, DataRow, DayBars, KpiDeck, KpiPill,
  LaneBar, MeterRow, NodeTabs, useDashboardOpen,
  type KpiItem, type NodeHeadPill,
} from "../components/atlasHome";
import { AgentRosterRow, AgentsQuickSpawn, RosterEmpty, WorkersDispatchedNote } from "../components/atlasAgents";
import { AttentionList, GateLaneList } from "./WorkspaceHome";
import { splitRoster } from "../lib/atlasAgents";
import {
  boardRollup, gateLanes, isLiveSession, mergeThroughput, plural, relativeTime,
  useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import { PROJECT_NODE_TABS, isRehomedProjectTab, projectNodeTabAt } from "../nav";
import { color, font } from "../theme";

// THE PROJECT NODE — card fd99b2d7 (Atlas P2-1), the project-scoped twin of WorkspaceHome, widened
// to the approved design's ten tabs by card 25c08fba and narrowed to NINE by card 44f725fe. Every
// figure is scoped to the ActiveProjectProvider's project, which the tree's own project row writes.
//
// ⭐ ONE HOME TAB, NOT TWO (card 44f725fe — the owner's D1 pick on request fb8de852, from his own
// reading of this file: "What is the need to have an overview tab, and a deck tab? Feels redundant
// to me. Unify the pages to one."). He was right at the level of the code: Overview and Deck were
// never two pages, just two `return` branches over ONE `kpis` array and ONE set of five band-panel
// variables, differing only in how they spent the viewport — Overview bought the board 1316px of
// width and spent 670px of height on the band; Deck bought the height and spent 330px of width on a
// rail. Folding the band behind a disclosure gives the board BOTH (1316px starting at y 386), which
// is strictly more board than either tab ever offered, and it costs no content: the Gates panel
// survives here, where the Deck tab dropped it outright.
//
// The tab SET and each tab's address are declared once, in src/nav.tsx's PROJECT_NODE_TABS — read
// there for why a re-homed tab keeps the path it already had rather than becoming a `?tab=`. This
// file owns only what the declaration cannot: each tab's COUNT, and its BODY.
//
// ⭐ OWNER-RULED (card c6bdf358, restated on fd99b2d7 and again on 25c08fba): the board embedded in
// the Overview tab is the owner's PRIMARY board surface. It is the real <Board/>, whole — all its
// lanes, filters, drag and the centred card dialog — never a summary, a trimmed view or a link to
// one. The Board TAB is a second, full-bleed mount of the same component, not a replacement for it.
//
// 🔴 A TAB BODY IS MOUNTED ON FIRST VISIT AND NEVER UNMOUNTED AFTER (card 25c08fba). An inactive
// body stays in the tree with `hidden`, exactly as the Platform node's five panels do (card
// c07ff42a) and for the same owner directive: a tab click is not consent to discard unfinished
// input, and unmounting the body you are leaving destroys a half-typed memory note, a Settings field
// mid-edit or a composer draft. `hidden` — never an inline `display` — also keeps a parked body out
// of the accessibility tree and the tab order.
//
// It is FIRST-VISIT rather than always-mounted because the cost here is not the Platform node's. Eight
// bodies polling on every project page is not what the classic shell already paid (these were eight
// separate pages), and the Sessions body in particular opens a live pty WebSocket per live session —
// so mounting it before anyone has asked for it would make every project address pay for terminals
// nobody opened. First-visit-then-sticky is exactly enough for the directive: input can only exist in
// a body that has rendered, and once it has rendered it is never torn down.
//
// @decision 25c08fba — never unmount an inactive tab body, and never park one with an inline
// `display` (it out-specifies the UA `[hidden]` rule). Unfinished input must survive a tab switch.

export default function ProjectHome() {
  const { pathname, search } = useLocation();
  const tab = projectNodeTabAt(pathname, search)?.key ?? "overview";
  // Which bodies have ever been shown. A ref, not state: the set only ever GROWS, and it grows in the
  // same render that changed `tab` — so there is nothing to re-render for, and going through state
  // would cost every first visit a frame of blank content.
  //
  // 🔴 DECLARED ABOVE THE `!projectId` EARLY RETURN, with every other hook. Below it, the no-project
  // render path calls one FEWER hook than the resolved one, and the first resolve of the active
  // project then throws React error #310 ("rendered more hooks than during the previous render"),
  // blanking the whole app. Measured: it crashed every project-node address — only on a first load
  // that had no project pinned yet, which is why half the suite stayed green through it.
  const visited = useRef<Set<string>>(new Set());
  visited.current.add(tab);
  // The dashboard disclosure's persisted state (card 44f725fe). 🔴 DECLARED HERE, above the
  // `!projectId` early return, with every other hook — for the same measured reason the ref above
  // is: a hook below it makes the no-project render path call one FEWER hook than the resolved one,
  // and the first resolve of the active project then throws React error #310 and blanks the app.
  const [dashOpen, setDashOpen] = useDashboardOpen();
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const boardQ = useQuery({ queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId, staleTime: 30_000 });
  const archivedQ = useQuery({ queryKey: ["archive", projectId, 100], queryFn: () => api.archivedSessions(projectId), enabled: !!projectId });
  // The two tab counts no existing read on this page already answers (card 25c08fba). Both reuse the
  // EXACT query key + fetcher their own tab body uses — ["projectMemory", id] in pages/Memory.tsx,
  // ["runs", id] in pages/Runs.tsx — so the count on a tab and the rows inside it share one cache
  // entry and cannot disagree, and opening the tab issues no second request. Neither adds an api.ts
  // member. Deliberately NO refetchInterval: the Runs body sets its own 4s poll while it is mounted,
  // and the node has no reason to poll faster than the figure is read.
  const memoryQ = useQuery({ queryKey: ["projectMemory", projectId], queryFn: () => api.projectMemory(projectId), enabled: !!projectId });
  const runsQ = useQuery({ queryKey: ["runs", projectId], queryFn: () => api.runs(projectId), enabled: !!projectId });
  // The node head's `<branch> <sha>` pill. The two EXISTING keys pages/Git.tsx reads — same keys,
  // same fetchers — so opening the Repository tab's Git pane issues no second request and the pill
  // and that pane can never disagree about where the repo's head is.
  //
  // These are the only reads on this page that are NOT already made for something else, and they are
  // the deliberate cost of the pill: a long `staleTime` (the head moves on a merge, not on a tab
  // click) and `retry: false`, because the expected failure here — a project with no repo bound, or
  // a repo with no commits yet — is a permanent one and the pill's answer to it is to not render.
  const branchesQ = useQuery({ queryKey: ["git-branches", projectId], queryFn: () => api.gitBranches(projectId), enabled: !!projectId, retry: false, staleTime: 30_000 });
  const gitLogQ = useQuery({ queryKey: ["git-log", projectId], queryFn: () => api.gitLog(projectId), enabled: !!projectId, retry: false, staleTime: 30_000 });
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
  // The threshold the context meters are actually read against, resolved the same way the classic
  // Overview resolves `gateCommand` — this project's override over the platform defaults, off the
  // project row this page already holds. No platform layer here, matching that page exactly.
  const recycleAt = resolveConfig(project?.config).orchestration.recycleAtContextRatio;
  const worstSession = live.find((s) => (s.ctxInputTokens ?? 0) > 0 && s.ctxInputTokens === wc.ctx) ?? null;

  // The roster behind the Agents panel below AND the "spawnable" figure on the fleet tile — ONE
  // derivation (lib/atlasAgents.ts), off the three reads this page already makes, so the count in
  // the KPI sub-line and the rows in the panel can never disagree about who is spawnable.
  const roster = splitRoster(agentsQ.data, profilesQ.data, sessionsQ.data);

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
      sub: `${live.length} live · ${roster.spawnable.length} spawnable`,
      popover: <FleetList managers={managers} workers={workers} />,
    },
    {
      key: "context", label: "worst context", value: wc.ctx > 0 ? `${ctxPct}%` : "—",
      // Highest band FIRST. Tested amber-before-red, `>= 95` was unreachable — anything at 95 is also
      // at 80 — so neither the figure nor the meter fill under it could ever go red, which is the one
      // state the tile exists to surface. The workspace node's `plan` tile already orders it this way;
      // these two are the only meter tiles in the deck and they now read the same.
      tone: ctxPct >= 95 ? "red" : ctxPct >= 80 ? "amber" : "phosphor",
      sub: worstSession ? `${worstSession.agentName} · ${plural(worstSession.ctxTurns ?? 0, "turn")}` : "no session reports context",
      fill: wc.ctx > 0 ? wc.ratio : undefined,
      popover: <ContextList sessions={live} recycleAt={recycleAt} />,
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
  // THE ANSWER TO "how are the spawnable agents spawned for projects?" (card 939922ee, round 4) —
  // the spawn controls are ON the page you land on, second in the band, not behind a navigation.
  // Same rows, same guard, same split button as the Agents node and the tree's quick-spawn: one
  // roster component (components/atlasAgents.tsx) renders all three.
  const agentsPanel = (
    <BandPanel label="Agents" count={roster.spawnable.length}
      action={{ to: "/agents", label: "All" }} testId="atlas-band-agents">
      {roster.spawnable.length === 0
        ? <RosterEmpty workers={roster.workers} />
        : roster.spawnable.map((entry) => <AgentRosterRow key={entry.agent.id} entry={entry} />)}
      <WorkersDispatchedNote workers={roster.workers} />
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

  // What the disclosure bar keeps saying while the five panels above are folded away (card
  // 44f725fe). One figure per panel the fold hides, so folding costs the DETAIL and never the
  // SIGNAL — that is the whole argument for the fold, and this row is where it is honoured or not.
  //
  // ⛔ These are NOT the `kpis` array: that would restate the full-size deck's own six figures ~40px
  // under it, which is the shape card 939922ee's owner rejection names. `needs you` is the one
  // overlap and it is deliberate — it is the panel whose whole point is that it is waiting on you.
  // `spawnable` and `last event` appear nowhere else on the page once the band is folded.
  const lastEvent = events[0];
  const dashSummary = (
    <>
      <KpiPill value={projAttention.length} label="needs you" testId="atlas-banddisc-pill-needs"
        tone={projAttention.length > 0 ? "amber" : "muted"} title="Attention items waiting on you in this project" />
      <KpiPill value={roster.spawnable.length} label="spawnable" testId="atlas-banddisc-pill-spawnable"
        tone={roster.spawnable.length > 0 ? "cyan" : "muted"} title="Agents in this project with no live session, ready to spawn" />
      <KpiPill value={`${lanes.running}·${lanes.queued}`} label="gates" testId="atlas-banddisc-pill-gates"
        tone={lanes.queued > 0 ? "amber" : lanes.running > 0 ? "phosphor" : "muted"}
        title={`${lanes.running} running · ${lanes.queued} queued, daemon-wide (cap ${lanes.cap})`} />
      {/* The event KIND, not its time: "what just happened" is the signal a folded Pulse feed
          stops showing, and the time is one hover away rather than the figure itself. */}
      <KpiPill value={lastEvent?.kind ?? "—"} label="last event" testId="atlas-banddisc-pill-event"
        tone={lastEvent ? "cyan" : "muted"}
        title={lastEvent ? `${lastEvent.kind} · ${relativeTime(lastEvent.ts)}` : "No orchestration events yet"} />
    </>
  );

  // One count per tab, keyed by the declaration's own `key`. A tab with no entry here renders no
  // count — Repository and Settings have no natural figure, and the approved design gives them none.
  // `undefined` is deliberately distinct from `0`: a count that has not loaded yet shows nothing
  // rather than claiming an empty surface.
  const tabCounts: Record<string, number | undefined> = {
    board: board.open,
    // The project's own live sessions — the same set the Sessions body shows once its pre-selected
    // project filter is applied, so the tab's figure describes what is actually inside it.
    sessions: live.length,
    agents: agentsQ.data?.length,
    memory: memoryQ.data?.length,
    runs: runsQ.data?.length,
    // `total`, not `items.length`: archivedSessions is PAGINATED, so the row count is a page size.
    archive: archivedQ.data?.total,
  };
  const tabs = PROJECT_NODE_TABS.map((t) => ({
    key: t.key, label: t.label,
    count: tabCounts[t.key] !== undefined && tabCounts[t.key]! > 0 ? tabCounts[t.key] : undefined,
  }));
  const hrefFor = (key: string) => PROJECT_NODE_TABS.find((t) => t.key === key)?.to ?? "/project";

  // ── The node head (card 5968d7e0) ────────────────────────────────────────────────────────────
  // Two readings, neither of them a figure from `kpis` above. That is the rule, not a coincidence:
  // the deck carries all six on the home tab, so a pill restating one would be the same number twice
  // on one screen.
  //
  //  · `N working` is a BUSY count — how many of this project's agents are mid-turn. The `mgr ·
  //    workers` tile beside it is a LIVE count split by role (`1/4`); a live agent waiting on its
  //    manager counts there and not here, so the two move independently and answer different
  //    questions. It is also the one fleet reading the tree's per-session rows never roll up.
  //  · `<branch> <sha>` is the repo's head, which appears nowhere else on this node at all.
  const working = live.filter((s) => s.busy).length;
  const headBranch = branchesQ.data?.current;
  const headSha = gitLogQ.data?.[0]?.hash;
  const headPills: NodeHeadPill[] = [
    {
      key: "working", text: `${working} working`,
      tone: working > 0 ? "phosphor" : "muted",
      title: `${plural(working, "session")} in ${project?.name ?? "this project"} taking a turn right now`,
    },
    // The branch is NOT assumed to be `main` — the mockup's own `main 57143a90` is that repo's
    // name for it, and a project bound to a repo on `master` or a release branch reads its own.
    // Omitted entirely rather than guessed when either read fails: no repo bound, or no commit yet.
    ...(headBranch && headSha
      ? [{ key: "head", text: `${headBranch} ${headSha.slice(0, 8)}`, title: `${headBranch} at ${headSha}` } as NodeHeadPill]
      : []),
  ];

  // The eight re-homed tab bodies. Each is the EXISTING page component, mounted verbatim — this card
  // re-homes surfaces, it does not rebuild them. Sessions is the one that takes a prop: its page is
  // god-eye by design and already supports being "reached per-project by pre-selecting the filter",
  // so the project node hands it this project's name and the body matches the tab's own count.
  const tabBodies: Record<string, ReactNode> = {
    board: <Board projectId={projectId} />,
    sessions: <Terminals projectName={project?.name} />,
    agents: <AgentsNode />,
    repository: <Repository />,
    memory: <Memory />,
    runs: <Runs />,
    archive: <Archive />,
    settings: <Settings />,
  };
  return (
    // Every fleet row below renders a session from THIS project-filtered live set, so it is also what
    // decides whether the view is mixed-harness — the same contract the classic Overview honours.
    <HarnessMixProvider sessions={live}>
      <div className="loom-atlas-home">
        {/* The node's own pills + its primary action, portalled into the frame's node head. ONE
            mount for the whole node, outside the tab bodies, so it is identical on every tab and
            survives a tab switch without remounting the dialog's own open state. */}
        <AtlasNodeHead pills={headPills} actions={
          // The SAME dialog the tree's `＋` opens and the SAME roster rows the Agents panel below
          // renders — so the go-live guard (a live manager draws its held control plus Stop, never
          // a second spawn) is inherited from `AgentActions`, not re-expressed here. Its own testid
          // stem, because the tree mounts one too and a shared id resolves both.
          <AgentsQuickSpawn projectId={projectId} projectName={project?.name}
            testId="atlas-nodehead-spawn" trigger="button" />
        } />
        {/* No readout rides this row — card 4a0ad464 removed the tab-row KPI strip on the owner's
            own instruction. The node's figures are the full-size deck on the home tab below. */}
        <NodeTabs tabs={tabs} active={tab} hrefFor={hrefFor} />

        {/* Every re-homed body that has been visited, the inactive ones parked with `hidden`. Rendered
            BEFORE the home tabs' own content so a body's position in the DOM is stable across tab
            switches — a parked body that moved would remount and take its draft with it. */}
        {PROJECT_NODE_TABS.filter(isRehomedProjectTab).map((t) => (
          visited.current.has(t.key) ? (
            <div key={t.key} hidden={t.key !== tab} data-testid={`atlas-tabpanel-${t.key}`}>
              {tabBodies[t.key]}
            </div>
          ) : null
        ))}

        {/* THE node's one home tab. Rendered only while it is the selected tab — unlike the
            re-homed bodies above, it is not parked with `hidden`, because it holds no input of its
            own to protect (the disclosure's own folded/unfolded choice is persisted, so it survives
            the remount that a parked body would exist to avoid) and it carries a full <Board/>,
            which is not worth keeping mounted behind eight other tabs. */}
        {tab === "overview" ? (
          <>
            <KpiDeck items={kpis} />
            <BandDisclosure open={dashOpen} onToggle={() => setDashOpen(!dashOpen)} summary={dashSummary}>
              {needsPanel}
              {agentsPanel}
              {fleetPanel}
              {gatePanel}
              {pulsePanel}
            </BandDisclosure>
            <section className="loom-atlas-primary" data-testid="atlas-board-embed">
              <div className="loom-atlas-primaryhead">
                <span className="loom-atlas-primarylbl">Board</span>
                <span className="loom-bandcount">{board.open}</span>
                <span style={{ flex: 1 }} />
                {/* The LaneBar is the board head's trim at every width now. It was Deck-only, which
                    was the one thing genuinely unique to that tab and worth keeping: a cards-per-lane
                    reading is a real figure, where the sentence it replaces ("the same board, whole")
                    only restated what the whole board sitting underneath it already shows. */}
                <LaneBar lanes={board.lanes} />
              </div>
              <Board projectId={projectId} />
            </section>
          </>
        ) : null}
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

/**
 * Context occupancy, worst first — the figure that says who needs recycling before the next gate.
 * Ratio against each session's OWN model window (`contextWindowForModel`), never one page-level
 * constant: two sessions in one project can legitimately run different windows.
 *
 * Card c2968651 (gap c) asked whether the round-4 mockup's pop-over actions belong here. Both of
 * the two aimed at this tile were REJECTED as writes and resolved as EXITS instead, because neither
 * has a one-click write path to wire: "Recycle Dev after card" is a manager's `worker_recycle` with
 * no human REST equivalent at all (`lib/api.ts` has resume/stop and no recycle), and a button named
 * for a recycle that actually stopped and respawned a session would lie about what the click does;
 * "Adjust threshold" edits `orchestration.recycleAtContextRatio`, a numeric config field, which is
 * a form and not a button. So each row carries a link to the session that owns the real controls,
 * and the footer names the live threshold these meters are read against plus where it is changed.
 *
 * @decision c2968651 — do not put a recycle button here. There is no human recycle write path, and
 * a stop+resume pair wearing that label would misname what it does.
 */
function ContextList({ sessions, recycleAt }: { sessions: SessionListItem[]; recycleAt: number }) {
  const rows = sessions
    .filter((s) => (s.ctxInputTokens ?? 0) > 0)
    .map((s) => ({ s, ratio: (s.ctxInputTokens ?? 0) / contextWindowForModel(s.model) }))
    .sort((a, b) => b.ratio - a.ratio);
  if (rows.length === 0) return <BandEmpty>No live session is reporting context yet.</BandEmpty>;
  return (
    <>
      {rows.map(({ s, ratio }) => (
        <MeterRow key={s.id} label={
          <Link to={`/session/${s.id}`} className="loom-inlinelink" title={`Open ${s.agentName}'s session`}>{s.agentName}</Link>
        } ratio={ratio}
          value={`${Math.round(ratio * 100)}% · ${s.ctxTurns ?? 0}t`}
          tone={ratio >= 0.95 ? "red" : ratio >= 0.8 ? "amber" : "phosphor"} />
      ))}
      <BandFoot>
        Occupancy against each session's own model window.{" "}
        {recycleAt > 0
          ? <>A manager is nudged to hand off at {Math.round(recycleAt * 100)}%</>
          : <>The recycle nudge is switched off</>}
        {" — "}
        <Link to="/settings" className="loom-inlinelink">change it in Settings</Link>.
      </BandFoot>
    </>
  );
}
