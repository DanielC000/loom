import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { EventTrigger, OrchestrationEvent, Project, QuestionInboxItem, Schedule, SessionListItem, UsageLimitsStatus, UsageWindow } from "@loom/shared";
import { api } from "../lib/api";
import { WORKSPACE_NODE_TABS, workspaceNodeTabOf } from "../nav";
import { NodeTabHostProvider } from "../lib/nodeTabHost";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, attentionOpenTarget, dismissAttention } from "../lib/attention";
import { useOpenRequest } from "../components/requests";
import { AttentionRow, EventRow } from "../components/fleet";
import { Badge, Button, Dot, Panel, SectionLabel, StatusPill } from "../components/ui";
import {
  AtlasNodeHead, BandDisclosure, BandEmpty, BandFoot, BandPanel, DataRow, DayBars, GatePair, KpiDeck, KpiPill,
  LaneBar, MeterRow, NodeTabs, PlanUsageDetail, relativeResets, useDashboardOpen, type KpiItem,
} from "../components/atlasHome";
import { FleetControlsBar } from "../components/fleetControls";
import { CompactMergeAction } from "../components/reviewQueue";
import { mergeRequestCardTitle, mergeRequestRowText } from "../lib/cardWorker";
import { RoleBadge } from "../lib/roleDisplay";
import { sessionVitals, standingOperators } from "../lib/atlasAgents";
import {
  boardRollup, gateLanes, gatePairWords, isLiveSession, lastMergeByProject, liveCountsByProject, mergeThroughput,
  plural, relativeTime, useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import { GLOBAL_ACTIVITY_CAP, PULSE_EXITED_REFETCH_MS, pulseExitedManagers } from "../lib/fleet";
import { WorkspaceReplay } from "../components/workspaceReplay";
import { isCompanionSession } from "../lib/sessions";
import { needsYouSplit, needsYouSummary } from "../lib/needsYouSplit";
import { workspaceRunningSessions, workspaceSessionsSummary } from "../lib/workspaceSessions";
import { SessionTerminalList, type SessionListTestIds } from "../components/sessionTerminals";
import { color, type Tone, fs } from "../theme";
import { useNavigate } from "react-router-dom";

// THE WORKSPACE ROOT NODE — cards fd99b2d7 (Atlas P2-1) and 41eab0eb (the cross-project surfaces as
// this node's tabs), both on the owner-approved round-4 V2 design: Mockups/2026-10-19 UI Overhaul
// Round 4. ONE home tab, in the mockup's own `ROOT_TABS` order: Overview is the default landing
// (full-size KPI tiles over a foldable dashboard band over the project grid), and the seven
// cross-project surfaces that used to be tree rows follow it as tab bodies.
// There was a second home tab, `Deck`, until card 4a0ad464 unified the pair behind one
// `BandDisclosure` — see that card's record, and card 44f725fe's, which did the same for the project node.
//
// "Scope is depth": this node is the shallowest thing containing every project, so every figure here
// is cross-project. Nothing on this page reads the active project.
//
// ⛔ Composed from EXISTING `api.*` calls only (docs/plans/archive/atlas-ui/02-architecture.md's hard rule),
// through the cache keys the classic pages already fill — so this node adds no poll Mission Control
// or the Gates page was not already making.

// The node's OWN LEADING tabs. The seven re-homed cross-project surfaces follow them, in the mockup's
// `ROOT_TABS` order, from the one declaration in src/nav.tsx (card 41eab0eb) — so this file never
// names which surfaces they are, only how their counts are derived.
// ⛔ ONE home tab, and `deck` must not come back as a second one (card 4a0ad464 — the owner's words
// on card 93d50f2d item 3: "What is the need to have an overview tab, and a deck tab? Feels redundant
// to me. Unify the pages to one."). A legacy `?tab=deck` needs no row and no LEGACY_REDIRECTS entry
// either: `isTabKey` below simply does not recognise it, and an unrecognised tab falls back to
// Overview. A redirect row would reach the CLASSIC shell too (both shells mount that table from one
// declaration), and `/home` is Atlas-only anyway.
const HOME_TABS = [{ key: "overview", label: "Overview" }];

// The node's own TRAILING tab — the retrospective reading of the same node (card ff6123de): the wave
// scrubber/diff plus the finished-wave tier, both of them Mission Control surfaces with nowhere else to
// live under Atlas. See components/workspaceReplay.tsx.
//
// It trails the re-homed seven rather than sitting with Overview/Deck for two reasons. A forensic tool is
// the rarest thing on this node, and the More ⋯ overflow folds from the END of the row — so last is
// exactly the slot that should yield first when the row runs out of width (card d4350286). And it is
// declared separately rather than appended to HOME_TABS because HOME_TABS' own position is load-bearing:
// the mockup's `homeTabs().concat(ROOT_TABS)` split puts the node's own reading FIRST, and inserting a
// second there would push Inbox and Gates right for a surface nobody reaches daily.
const REPLAY_TAB = { key: "replay", label: "Replay" };

/**
 * The `?tab=` values this node answers to. Anything else falls back to Overview.
 *
 * ⛔ Read at CALL time, never at module scope. src/nav.tsx imports this module (it owns the element
 * for the `/home` route) and this module imports src/nav.tsx back, so during module evaluation
 * `WORKSPACE_NODE_TABS` is still undefined — a `const` built from it here blew the whole app up with a
 * blank page rather than failing in any one component. ESM live bindings make the cycle harmless as
 * soon as the read happens inside a function.
 */
const isTabKey = (key: string) =>
  HOME_TABS.some((t) => t.key === key) || key === REPLAY_TAB.key
  || WORKSPACE_NODE_TABS.some((t) => t.key === key);

/** The query key a hosted page's own sub-tab uses here — see lib/nodeTabHost.tsx for why not `tab`. */
const SUB_KEY = "sub";

export default function WorkspaceHome() {
  const [params] = useSearchParams();
  const raw = params.get("tab") ?? "overview";
  const tab = isTabKey(raw) ? raw : "overview";
  const { projects, setProjectId } = useActiveProject();
  const navigate = useNavigate();
  // The SAME per-browser preference the project node's own band reads (card 44f725fe's
  // `DASHBOARD_OPEN_STORAGE_KEY`), not a second key: the band is the same furniture on both nodes,
  // and two keys would make "fold the dashboard away" mean two different things depending on which
  // node you happened to be standing on when you asked for it.
  const [dashOpen, setDashOpen] = useDashboardOpen();

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const usageQ = useQuery<UsageLimitsStatus>({ queryKey: ["usageLimits"], queryFn: ({ signal }) => api.usageLimits(signal), refetchInterval: 30_000 });
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
  // The node head's one pill (card 5968d7e0) — BUSY, not live. Deliberately a different population
  // from the `live sessions` tile beside it: a live agent parked on its manager counts there, not
  // here, so the two never read as the same number drawn twice.
  const workingCount = live.filter((s) => s.busy).length;
  const liveByProject = useMemo(() => liveCountsByProject(sessions), [sessions]);
  // Off the FULL session list, not `fleet`: these are exactly the rows the fleet filter removes.
  const operators = useMemo(() => standingOperators(sessions), [sessions]);
  const activeProjects = projects.filter((p) => (liveByProject.get(p.id) ?? 0) > 0);

  const lanes = gateLanes(activeGatesQ.data);
  const merges = mergeThroughput(historyQ.data?.items);
  const lastMerge = useMemo(() => lastMergeByProject(historyQ.data?.items), [historyQ.data]);
  const usage = usageQ.data?.available ? usageQ.data : null;
  // The deck has room for ONE plan window, and WHICH one depends on the account's plan. A plan with
  // no 5h limit reports a legitimate `fiveHour: null` alongside real `sevenDay` data (protocol.ts), so
  // a tile hard-wired to 5h read "—"/"loading…" on it forever — the only branch that stated a reason
  // was `!available`, and this plan IS available. 7d is the fallback because the protocol guarantees
  // it on every available snapshot; the pop-over below still lists every window the plan reports.
  const planWindow: { label: string; window: UsageWindow } | null = !usage
    ? null
    : usage.fiveHour
      ? { label: "plan 5h", window: usage.fiveHour }
      : { label: "plan 7d", window: usage.sevenDay };

  // One board read per project, sharing the EXACT ["board", id] entry pages/Board.tsx fills — so a
  // project card's open-card count is the same number that project's board shows, and opening it
  // from here is already warm. No refetchInterval: the grid is a glance, and the board page itself
  // owns the live cadence once you are actually looking at one.
  const boardQs = useQueries({
    queries: projects.map((p) => ({ queryKey: ["board", p.id], queryFn: ({ signal }) => api.board(p.id, undefined, signal), staleTime: 30_000 })),
  });
  const boards = new Map(projects.map((p, i) => [p.id, boardRollup(boardQs[i]?.data?.columns, boardQs[i]?.data?.tasks)]));
  const openCards = [...boards.values()].reduce((n, b) => n + b.open, 0);

  // The cross-project pulse, from the SAME per-manager event queries Mission Control ran (same keys
  // ⇒ one shared cache entry, not a second poll of the same endpoint).
  //
  // TWO TIERS, because this feed is the only place an exited manager's stream is still reachable once
  // card 5afd71bd retired Mission Control (card ef86b089). The LIVE tier keeps the 3s interval that
  // makes the band read as live. The EXITED tier is capped and polled far more slowly — see
  // `pulseExitedManagers` (lib/fleet.ts) for the whole policy and why the cap and the interval are
  // BOTH load-bearing. Same `["orchEvents", id]` keys either way, so a manager crossing between the
  // tiers keeps its cache entry and only changes how often it is refetched.
  const exitedManagers = useMemo(() => pulseExitedManagers(sessions), [sessions]);
  const eventQs = useQueries({
    queries: [
      ...managers.map((m) => ({ queryKey: ["orchEvents", m.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.orchestrationEvents(m.id, signal) })), // live tier: pushed over /ws/fleet, no poll (card 670b2081)
      ...exitedManagers.map((m) => ({
        queryKey: ["orchEvents", m.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.orchestrationEvents(m.id, signal),
        refetchInterval: PULSE_EXITED_REFETCH_MS,
      })),
    ],
  });
  const events = eventQs
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
  // Over BOTH tiers: a row whose manager is missing here renders with no project chip, and an exited
  // manager's rows are exactly the ones this card added.
  const projectByManager = new Map([...managers, ...exitedManagers].map((m) => [m.id, m.projectName]));
  // Card 99b98864: the row's card link makes the event's own project active before opening the board.
  const projectIdByManager = new Map([...managers, ...exitedManagers].map((m) => [m.id, m.projectId]));

  // ── The re-homed tabs' counts (card 41eab0eb) ────────────────────────────────────────────────────
  // The mockup gives a count to three of the seven: `Inbox 4`, `Gates 1·2`, `Automation 9`. The other
  // four carry none there and carry none here.
  //
  // `["openQuestions"]` is already kept fresh app-wide (signal-driven via `/ws/fleet`, no poll) by `useAttention()` (App.tsx mounts it for BOTH
  // shells), so the Inbox count is a free read off a cache entry that is always warm. The two
  // Automation reads are the only new fetches this card adds — one-shot, no interval, 30s stale — and
  // they are the same keys pages/Schedules.tsx and pages/EventTriggers.tsx fill, so landing on that tab
  // finds its own tables already warm rather than paying twice.
  const questionsQ = useQuery<QuestionInboxItem[]>({ queryKey: ["openQuestions"], queryFn: ({ signal }) => api.openQuestions(false, signal) });
  const schedulesQ = useQuery<Schedule[]>({ queryKey: ["schedules"], queryFn: ({ signal }) => api.schedules(signal), staleTime: 30_000 });
  const triggersQ = useQuery<EventTrigger[]>({ queryKey: ["eventTriggers"], queryFn: ({ signal }) => api.eventTriggers(signal), staleTime: 30_000 });
  // The Inbox page's OWN headline figure ("Waiting on me (N)", components/requests.tsx): pending plus
  // answered-awaiting-pickup, with NOTICES excluded — nobody is waiting on anything for a notice, so
  // counting one here would make the tab claim work that does not exist. Deliberately NOT
  // `attention.length`, which is the "needs you" KPI's wider population and would disagree on one screen.
  const inboxCount = questionsQ.data?.filter((q) => q.state !== "notice").length;
  const automationCount = schedulesQ.data && triggersQ.data
    ? schedulesQ.data.length + triggersQ.data.length
    : undefined;

  // A count only once its read has RESOLVED: `undefined` renders no count at all, so a tab never
  // flashes a "0" that is really "not loaded yet". Gates is the exception and is always shown, because
  // `gateLanes` has no pending state of its own and the `gate run · queued` KPI already reads 0 · 0 at rest.
  // The pair is spaced (`GatePair`), and the words ride the hover: a tab count has no label of its own.
  const tabCounts: Record<string, ReactNode> = {
    inbox: inboxCount,
    gates: <span title={gatePairWords(lanes)}><GatePair lanes={lanes} /></span>,
    automation: automationCount,
  };
  const tabs = [
    ...HOME_TABS,
    ...WORKSPACE_NODE_TABS.map((t) => {
      const { key, label } = workspaceNodeTabOf(t);
      return { key, label, count: tabCounts[key] };
    }),
    REPLAY_TAB,
  ];

  const kpis: KpiItem[] = [
    {
      key: "projects", label: "projects", value: projects.length,
      sub: `${activeProjects.length} active · ${projects.length - activeProjects.length} idle`,
      popover: (
        <>
          {projects.length === 0 && <BandEmpty>No projects yet.</BandEmpty>}
          {projects.map((p) => (
            <DataRow key={p.id} label={p.name}
              tone={(liveByProject.get(p.id) ?? 0) > 0 ? "live" : "muted"}
              value={(liveByProject.get(p.id) ?? 0) > 0 ? `${liveByProject.get(p.id)} live` : "idle"} />
          ))}
        </>
      ),
    },
    {
      key: "live", label: "live sessions", value: live.length,
      sub: `${plural(managers.length, "manager")} · ${plural(workers.length, "worker")}`,
      tone: live.length > 0 ? "live" : "muted",
      popover: (
        <>
          {live.length === 0 && <BandEmpty>Nothing is running.</BandEmpty>}
          {live.slice(0, 12).map((s) => (
            <DataRow key={s.id} label={`${s.agentName}${s.role ? ` · ${s.role}` : ""}`}
              tone={s.busy ? "work" : "live"} value={s.busy ? "working" : "idle"} title={s.projectName} />
          ))}
          <BandFoot>Live sessions across every project. Workers are dispatched by a manager, never spawned here.</BandFoot>
        </>
      ),
    },
    {
      key: "needs", label: "needs you", value: attention.length,
      tone: attention.length > 0 ? "attn" : "muted",
      // The split, not the kinds (card 73b41b5d, Atlas audit A-15): the Inbox tab beside this tile counts
      // Requests only, so a sub-line that names the requests and the rest is what reconciles the two.
      sub: needsYouSummary(needsYouSplit(attention)),
      popover: (
        <>
          <AttentionList items={attention} cap={8} />
          <BandFoot>The Inbox tab counts requests only. Merges, notices and fleet alerts are counted here too.</BandFoot>
        </>
      ),
    },
    {
      key: "gates", label: "gate run · queued", value: <GatePair lanes={lanes} />,
      tone: lanes.queued > 0 ? "work" : lanes.running > 0 ? "live" : "muted",
      sub: `cap ${lanes.cap} · daemon-wide`,
      popover: <GateLaneList lanes={lanes} />,
    },
    {
      key: "plan", label: planWindow?.label ?? "plan 5h",
      value: planWindow ? `${Math.round(planWindow.window.utilization)}%` : "—",
      // Highest band FIRST — ordered the other way, `>= 95` is unreachable and red is dead code.
      tone: !planWindow ? "muted" : planWindow.window.utilization >= 95 ? "danger" : planWindow.window.utilization >= 80 ? "attn" : "accent",
      sub: planWindow ? `resets ${relativeResets(planWindow.window.resetsAt)}` : (usageQ.data && !usageQ.data.available ? usageQ.data.reason : "loading…"),
      fill: planWindow ? planWindow.window.utilization / 100 : undefined,
      popover: <PlanUsageDetail usage={usage} />,
    },
    {
      key: "merged", label: "merged today", value: merges.branches,
      tone: merges.branches > 0 ? "live" : "muted",
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
      <AttentionList items={attention} cap={6} fitPanel />
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
  // The cap is `GLOBAL_ACTIVITY_CAP` (lib/fleet.ts), the SAME constant Mission Control's Activity column
  // read — this band was 40 against that page's 100, and card 5afd71bd then retired that page, so the
  // shortfall would have been 60 rows made unreachable rather than merely summarised. The band owns a
  // fixed 320px scroll by design, so a deeper list changes scroll depth, not layout.
  //
  // ⚠️ The project-scoped pulse (pages/ProjectHome.tsx) keeps its OWN, narrower cap: different
  // population, and its `Runs` exit survives. Don't fold the two onto one number.
  //
  // @decision 5afd71bd — this band is the DEEPEST cross-project view of the orchestration stream, so
  // it carries no `action`. Never point one at the Replay tab (wave replay, a different corpus),
  // `/runs` (a project tab, the wrong tier) or a session's Timeline (one slice of it).
  //
  // @decision b4442d27 — this panel's width is a BUDGETED track in `.loom-atlas-band`, not a bare
  // 1fr: its `EventRow` has an additive appetite no other band panel has. Never flatten that track
  // and never drop its 308px floor.
  const pulsePanel = (
    <BandPanel label="Pulse" testId="atlas-band-pulse">
      {events.length === 0 && <BandEmpty>No orchestration events yet.</BandEmpty>}
      {events.slice(0, GLOBAL_ACTIVITY_CAP).map((e) => <EventRow key={e.id} e={e} projectName={projectByManager.get(e.managerSessionId)} projectId={projectIdByManager.get(e.managerSessionId)} />)}
    </BandPanel>
  );

  const grid = (
    <ProjectGrid projects={projects} boards={boards} liveByProject={liveByProject} lastMerge={lastMerge}
      sessions={fleet} onOpen={(id) => { setProjectId(id); navigate("/project"); }} />
  );

  // What the disclosure bar keeps saying while the five panels above are folded away — card
  // 4a0ad464, the same contract card 44f725fe gave the project node's own bar: folding costs the
  // reader the DETAIL and never the SIGNAL.
  //
  // ⛔ NOT one pill per panel, and deliberately NOT the `kpis` array. THREE of the five panels state
  // a figure the full-size deck is already showing 40px above a folded bar — Gate lanes is the
  // `gate run·queued` tile verbatim, Plan usage is the `plan 5h` tile, and the deck does not move
  // when the band folds. A pill for either would be the same number twice on one screen, which is
  // the shape card 939922ee's owner rejection names. So the bar carries exactly what the fold
  // actually TAKES OFF the page: the Operators roster's size and what just happened in the Pulse
  // feed. `needs you` joins them despite overlapping its own tile, for the one reason card 44f725fe
  // gave the same pill on the project node — it is the panel whose whole point is that it is
  // waiting on you.
  const lastEvent = events[0];
  const dashSummary = (
    <>
      <KpiPill value={attention.length} label="needs you" testId="atlas-banddisc-pill-needs"
        tone={attention.length > 0 ? "attn" : "muted"} title="Attention items waiting on you across every project" />
      <KpiPill value={operators.length} label="operators" testId="atlas-banddisc-pill-operators"
        tone="muted" title="Standing cross-project operator sessions" />
      {/* The event KIND, not its time: "what just happened" is the signal a folded Pulse feed stops
          showing, and the time is one hover away rather than the figure itself. */}
      <KpiPill value={lastEvent?.kind ?? "—"} label="last event" testId="atlas-banddisc-pill-event"
        tone="muted"
        title={lastEvent ? `${lastEvent.kind} · ${relativeTime(lastEvent.ts)}` : "No orchestration events yet"} />
    </>
  );

  return (
    <div className="loom-atlas-home">
      {/* The node's own pill, portalled into the frame's node head (card 5968d7e0).
          ONE pill, not the mockup's `7 live` + `5 projects` pair: this node's `kpis` array already
          declares `live sessions` and `projects` as TILES — so both of the mockup's pills would be a
          figure restated within ~50px of itself. `N working` is the busy count instead, which no tile
          on this node carries.
          No action cluster either: the workspace tier's spawnables are the standing OPERATORS, and
          card c6160c7d's decision record keeps this node a readout of those rather than a second
          place to start or stop one — their lifecycle lives on the Platform and Companion nodes
          that own it. A `Spawn +` here would also have no project to spawn INTO. */}
      <AtlasNodeHead pills={[{
        key: "working",
        text: `${workingCount} working`,
        tone: workingCount > 0 ? "live" : "muted",
        title: `${plural(workingCount, "session")} across every project taking a turn right now`,
      }]} />
      {/* Overview is canonical, so its address is the bare node path — the shape every Atlas node
          gives its first tab. A tab link is built FRESH rather than merged over the live query: `sub`
          belongs to whichever re-homed page is showing, and carrying it onto a sibling tab would hand
          one guest's sub-tab value to another. */}
      {/* No readout rides this row: card 4a0ad464 removed the tab-row KPI strip on the owner's own
          instruction. The node's figures are the full-size deck on the home tab below. */}
      <NodeTabs tabs={tabs} active={tab} hrefFor={(k) => (k === "overview" ? "/home" : `/home?tab=${k}`)} />

      <RehomedTabPanels active={tab} />
      <ReplayTabPanel active={tab} />

      {/* THE node's one home tab. Rendered only while it is the selected tab — unlike the re-homed
          bodies above, it holds no unfinished input of its own to protect (a KPI pop-over is
          ephemeral, the fleet controls confirm in place, and the disclosure's own folded/unfolded
          choice is persisted, so it survives the remount a parked body would exist to avoid), and
          mounting it hidden would cost every one of these panels' polls on a tab not showing them. */}
      {tab === "overview" && (
        <>
          <KpiDeck items={kpis} />
          {/* The four daemon-global fleet controls (clear usage hold / pause / resume / kill all) take
              this full-width bar under the deck in the approved design — card 7b893d54. It stays above
              the disclosure rather than inside it: folding the dashboard is a request for the project
              grid, not for fewer ways to stop the fleet, and the crumb-bar chip reaches the same four
              controls from every node including this one. */}
          <FleetControlsBar />
          {/* The band behind ONE bar — card 4a0ad464, the same D1 disclosure card 44f725fe gave the
              project node. Unfolded is the default and the page looks exactly as it did; folded, the
              project grid rises to meet the deck, which is the reading the retired Deck tab existed
              to give. */}
          <BandDisclosure open={dashOpen} onToggle={() => setDashOpen(!dashOpen)} summary={dashSummary}>
            {needsPanel}
            {operatorsPanel}
            {gatePanel}
            <BandPanel label="Plan usage" action={{ to: "/usage", label: "Usage" }} testId="atlas-band-plan">
              <PlanUsageDetail usage={usage} />
            </BandPanel>
            {pulsePanel}
          </BandDisclosure>
          {/* The owner's Sessions card (card 9b6be377). It sits OUTSIDE the disclosure and above the
              grid: the band's panels are a fixed-height five-track line (card b4442d27's budget) and
              a terminal does not fit one, and folding the dashboard away is a request for the project
              grid — not for losing sight of what is running. `live` is the population, the same set
              the `live sessions` tile above it counts, so the two can never disagree on one screen. */}
          <WorkspaceSessions sessions={live} />
          <section className="loom-atlas-primary">
            <div className="loom-atlas-primaryhead">
              <span className="loom-atlas-primarylbl">Projects</span>
              <span className="loom-bandcount">{projects.length}</span>
              <span style={{ flex: 1 }} />
              {/* The Platform node, not the retired Projects page (card 5afd71bd): project creation's
                  Atlas home is that node's guided setup wizard (`GuidedSetupLauncher` →
                  `SetupWizard`, pages/PlatformView.tsx's `home` panel), which collects the same
                  repo/vault binding this grid's own cards are built from and seeds a templated team
                  on top. The LABEL stays "New project" — it names what the control does, which the
                  retirement did not change; only where it lands did. */}
              <Link to="/platform" className="loom-btn loom-btn-default loom-bandlink"
                title="Create a project with guided setup on the Platform node">New project <span aria-hidden>↗</span></Link>
            </div>
            {grid}
            {/* The retired Deck tab's one line of its own, kept rather than dropped (card 4a0ad464's
                D1 rule, inherited from card 44f725fe): `open cards` is the only figure that tab
                stated and no tile on this node carries, and the Platform sentence is the one place
                the grid's own omission is explained. */}
            <p className="loom-bandempty" style={{ marginTop: 10 }} data-testid="atlas-grid-foot">
              {plural(openCards, "open card")} across {plural(projects.length, "project")}. The reserved Platform home is pinned in the tree, not listed here.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

// ── The re-homed cross-project surfaces, as this node's tabs ───────────────────────────────────
// Card 41eab0eb. Each tab's body is the destination's OWN component, mounted verbatim — the frame
// moved, the page did not.
//
// 🔴 A VISITED PANEL IS NEVER UNMOUNTED. Five of the seven hold unfinished user input the moment a
// reader touches them (a half-written cron in Automation, an edited profile or skill in Actors, a
// Settings field, a companion composer draft or persona edit, an in-progress Request answer), and a
// tab click is not consent to discard it — the owner's standing rule. `hidden`, not an inline
// `display`, is also what keeps an inactive panel out of the accessibility tree and the tab order.
//
// 🔴 BUT A PANEL IS NOT MOUNTED UNTIL IT IS FIRST VISITED. Mounting all seven on arrival would make
// `/home` — the default Atlas landing — pay for every poll in Gates, Usage, Automation, Actors,
// Settings and the Companion node's twelve manage sections before the reader has asked for any of
// them. Mount-on-first-visit keeps both halves: nothing a reader has touched is ever destroyed, and
// nothing they have not touched is ever started.
//
// @decision 41eab0eb — never render only the active panel (it destroys unfinished input), and never
// mount all seven up front (it makes the default landing pay for six surfaces nobody opened). Never
// put an inline `display` on a panel wrapper: it out-specifies the UA's `[hidden]` rule.
function RehomedTabPanels({ active }: { active: string }) {
  // Grows, never shrinks, for the life of this node's mount. Set during render (React's own
  // "adjusting state when a prop changes" path) rather than in an effect, so a tab's first frame is
  // already its content and not an empty column.
  const [visited, setVisited] = useState<string[]>([]);
  const isRehomed = WORKSPACE_NODE_TABS.some((t) => t.key === active);
  if (isRehomed && !visited.includes(active)) setVisited([...visited, active]);

  return (
    <>
      {WORKSPACE_NODE_TABS.filter((t) => visited.includes(t.key)).map((t) => {
        const { key, element } = workspaceNodeTabOf(t);
        return (
          <div key={key} hidden={key !== active} data-testid={`atlas-tabpanel-${key}`}>
            {/* The host tells the page inside which query key its OWN sub-tab may use, so a page that
                owns a `?tab=` (Actors, Automation, the Companion node) cannot collide with this
                node's. See lib/nodeTabHost.tsx. */}
            <NodeTabHostProvider subKey={SUB_KEY}>{element}</NodeTabHostProvider>
          </div>
        );
      })}
    </>
  );
}

/**
 * The Replay tab's body, under the SAME mount rule as the re-homed panels above (card 41eab0eb) rather
 * than the node's own two conditional tabs: mounted on first visit, never unmounted after.
 *
 * Both halves of that rule are load-bearing here, for the same reasons they are there. The panel holds
 * real unfinished work the moment a reader touches it — a chosen subject, a scrub position, an open
 * run-diff — and a tab click is not consent to discard it. And it is the ONLY thing on this node that
 * reads the archive, so leaving it unmounted until asked for is what keeps the default `/home` landing
 * free of two 300-row archived pages and the two reserved-home probes.
 *
 * Deliberately NOT folded into `RehomedTabPanels`: that component maps `WORKSPACE_NODE_TABS` and wraps
 * each body in a `NodeTabHostProvider`, which exists for a GUEST page that owns a `?tab=` of its own.
 * This body owns no query parameter and is not a re-homed address, so it needs neither.
 */
function ReplayTabPanel({ active }: { active: string }) {
  // Set during render (React's "adjusting state when a prop changes" path), as the sibling above does,
  // so the tab's first frame is already its content and not an empty column.
  const [visited, setVisited] = useState(false);
  const isActive = active === REPLAY_TAB.key;
  if (isActive && !visited) setVisited(true);
  if (!visited) return null;
  return (
    // `hidden` as the ATTRIBUTE, never an inline `display` — an author `display` out-specifies the UA's
    // `[hidden]` rule, and the attribute is also what keeps the panel out of the accessibility tree and
    // the tab order while it is not showing.
    <div hidden={!isActive} data-testid={`atlas-tabpanel-${REPLAY_TAB.key}`}>
      <WorkspaceReplay />
    </div>
  );
}

// ── Shared pieces ──────────────────────────────────────────────────────────────────────────────

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
export function AttentionList({ items, cap, fitPanel }: {
  items: ReturnType<typeof useAttention>["items"];
  cap: number;
  /** Band panel only (card 104a31a4): show just the rows that fit WHOLE inside the panel's max-height,
   *  then the "+N more" row, instead of letting the last row clip mid-button at the panel edge. */
  fitPanel?: boolean;
}) {
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  // A MERGE REQUEST names its CARD (card fa4234ab, Atlas audit B finding G-01): "w:<id> task <id>" alone
  // made the reader go and look the work up. Resolved worker → taskId → title off reads both node levels
  // already make — the shared session feed and the per-project ["board", id] roll-up, same key and
  // staleTime as both pages' own board reads, so on either page this is a warm cache hit, not a new
  // fetch. Only projects that actually hold a pending merge request are read at all.
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const mergeProjectIds = [...new Set(items.flatMap((item) => {
    if (item.kind !== "MERGE REQUEST" || !item.workerSessionId) return [];
    const pid = sessionsQ.data?.find((s) => s.id === item.workerSessionId)?.projectId;
    return pid ? [pid] : [];
  }))];
  const mergeBoardQs = useQueries({
    queries: mergeProjectIds.map((pid) => ({
      queryKey: ["board", pid], queryFn: ({ signal }: { signal: AbortSignal }) => api.board(pid, undefined, signal), staleTime: 30_000,
    })),
  });
  const titleById = new Map<string, string>();
  for (const q of mergeBoardQs) for (const t of q.data?.tasks ?? []) titleById.set(t.id, t.title);
  const listRef = useRef<HTMLDivElement>(null);
  const capped = items.slice(0, cap).map((item) => {
    if (item.kind !== "MERGE REQUEST" || !item.workerSessionId) return item;
    const title = mergeRequestCardTitle(item.workerSessionId, sessionsQ.data, titleById);
    // Unknown title (board still loading, card gone) keeps the row's own text rather than a blank.
    return title ? { ...item, text: mergeRequestRowText(title, item.workerSessionId) } : item;
  });
  // The resolved title rides in `rowsKey` too: a title arriving after first paint changes a merge row's
  // text (and so possibly its height), so the fit must re-measure rather than keep a stale count.
  const { n: fitted, measuring } = useFitRows(listRef, !!fitPanel && items.length > 0, capped.map((i) => `${i.key}:${i.text}`).join("|"), items.length);
  if (items.length === 0) return <BandEmpty>Nothing needs you right now.</BandEmpty>;
  const shown = fitPanel && !measuring ? capped.slice(0, fitted ?? capped.length) : capped;
  const hidden = items.length - shown.length;
  if (fitPanel) {
    return (
      <div ref={listRef} data-testid="attention-list">
        {shown.map((item) => attentionRow(item))}
        {/* While measuring, the row is always present (with any count) so its own height is part of
            the sum; the layout effect settles the real count before the browser paints. */}
        {(hidden > 0 || measuring) && (
          <Link to="/inbox" className="loom-attn-more" data-testid="attention-more"
            title="Open the Inbox to see everything waiting on you">
            +{Math.max(hidden, 1)} more in Inbox <span aria-hidden>↗</span>
          </Link>
        )}
      </div>
    );
  }
  return (
    <>
      {shown.map((item) => attentionRow(item))}
      {hidden > 0 && (
        <BandFoot>+{hidden} more in the Inbox</BandFoot>
      )}
    </>
  );

  function attentionRow(item: (typeof items)[number]) {
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
  }
}

/**
 * How many of a list's rows fit WHOLE inside its band panel's `max-height`, leaving room for the
 * trailing "+N more" row (card 104a31a4). Measures off the real DOM: a row's height depends on its
 * kind (a merge row carries a footer) and on the column width, so a fixed row count would clip at one
 * width and waste space at another.
 *
 * The room is read from the panel's MAX-height, never its current height or the body's clientHeight:
 * both of those shrink as rows are removed, so measuring against them would cut again on every pass.
 * Re-measures only when the panel's WIDTH or the row set changes — not the body's width, which moves
 * with the scrollbar that the measuring pass itself can cause, and would loop.
 */
function useFitRows(listRef: RefObject<HTMLDivElement | null>, enabled: boolean, rowsKey: string, total: number) {
  const [panelWidth, setPanelWidth] = useState(0);
  const [fontsTick, setFontsTick] = useState(0);
  const [fit, setFit] = useState<{ sig: string; n: number } | null>(null);
  const sig = `${panelWidth}|${fontsTick}|${total}|${rowsKey}`;
  const measuring = enabled && fit?.sig !== sig;

  useLayoutEffect(() => {
    const panel = listRef.current?.parentElement?.parentElement;
    if (!enabled || !panel) return;
    const ro = new ResizeObserver(() => setPanelWidth(Math.round(panel.getBoundingClientRect().width)));
    ro.observe(panel);
    return () => ro.disconnect();
  }, [enabled, listRef]);

  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => { if (live) setFontsTick((t) => t + 1); });
    return () => { live = false; };
  }, []);

  useLayoutEffect(() => {
    if (!measuring) return;
    const list = listRef.current;
    const body = list?.parentElement;
    const panel = body?.parentElement;
    if (!list || !body || !panel) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-testid="attention-row"]'));
    const ps = getComputedStyle(panel);
    const maxH = parseFloat(ps.maxHeight);
    if (!Number.isFinite(maxH)) { setFit({ sig, n: rows.length }); return; }
    const top = list.getBoundingClientRect().top + body.scrollTop;
    // Border-box (global `* { box-sizing: border-box }`): the list's room is the panel's max-height
    // minus everything above the list and the panel's own bottom padding + border.
    const room = maxH - (top - panel.getBoundingClientRect().top)
      - parseFloat(ps.paddingBottom) - parseFloat(ps.borderBottomWidth);
    const more = list.querySelector<HTMLElement>('[data-testid="attention-more"]');
    const moreH = more ? more.offsetHeight + parseFloat(getComputedStyle(more).marginTop) : 0;
    let n = 0;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      const bottom = r.bottom + body.scrollTop - top + parseFloat(getComputedStyle(row).marginBottom);
      const needsMore = i + 1 < total;
      if (bottom + (needsMore ? moreH : 0) <= room + 0.5) n = i + 1;
    });
    // Never zero: one row always shows, and the body's own scroll still reaches it whole.
    setFit({ sig, n: Math.max(1, n) });
  }, [measuring, sig, total, listRef]);

  return { n: fit?.n ?? null, measuring };
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
            <StatusPill tone={session.busy ? "work" : "live"} glow={session.busy}
              label={session.busy ? "working" : "live"} />
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
      {/* Spelled out rather than the tile's bare `0 · 0`: this row has no label of its own to say which
          figure is which. The cap rides the hover, since every mount already states it beside the row. */}
      <MeterRow label={`${lanes.running} running`} value={`${lanes.queued} queued`} stacked
        title={`${gatePairWords(lanes)} · cap ${lanes.cap}, daemon-wide`}
        ratio={lanes.cap > 0 ? lanes.running / lanes.cap : 0}
        tone={lanes.queued > 0 ? "work" : "live"} />
      {lanes.runs.length === 0 && <BandEmpty>No gate is running or queued.</BandEmpty>}
      {lanes.runs.map((g) => (
        <DataRow key={g.id}
          label={<><Dot tone={g.phase === "running" ? "work" : "muted"} style={{ marginRight: 6 }} />{g.gateType} <span style={{ color: color.text3 }}>{g.projectName}</span></>}
          tone={g.phase === "running" ? "work" : "muted"}
          value={g.phase === "running" ? relativeTime(g.since).replace(" ago", "") : `queued${g.queuePosition ? ` ·${g.queuePosition}` : ""}`}
          title={g.workerLabel ?? g.branch ?? undefined} />
      ))}
    </>
  );
}

// ── The Sessions card ──────────────────────────────────────────────────────────────────────────
// Card 9b6be377, the owner's Atlas feedback verbatim: `"Workspace": Add "Sessions" card with all
// running session terminals.` The workspace tier had no cross-project terminal surface at all —
// under Atlas `/terminals` is the PROJECT node's Sessions tab (card 25c08fba).
//
// ⭐ THE LIST ITSELF IS SHARED with the project node's own Sessions card (card 0bcfa530):
// components/sessionTerminals.tsx owns the single-mount rule, the row grammar and the one
// `TerminalCard` variant either node may mount. What stays HERE is this node's own population
// (`workspaceRunningSessions` — every running session across every project) and this node's own
// card chrome. The project node brings a different population and a different card, and that is the
// only axis on which the two surfaces differ.
//
// @decision 9b6be377 — ONE mounted terminal, and NOTHING at rest. Never render a second
// TerminalCard here, never pre-expand a row, and never pass `resizable` for a claude session (pty
// geometry is pinned daemon-side).

/** The `aria-controls` target — one region, because there is only ever one mount. */
const SESSION_TERMINAL_REGION = "atlas-workspace-session-terminal";

/** This node's testids, unchanged from the card that minted them (9b6be377). */
const WORKSPACE_SESSION_IDS: SessionListTestIds = {
  list: "atlas-sessions-list",
  terminal: "atlas-sessions-terminal",
  row: "atlas-session-row",
  expand: "atlas-session-expand",
  open: "atlas-session-open",
};

function WorkspaceSessions({ sessions }: { sessions: SessionListItem[] }) {
  const rows = useMemo(() => workspaceRunningSessions(sessions), [sessions]);

  return (
    <Panel className="loom-wsessions" data-testid="atlas-sessions-card">
      <div className="loom-bandhead">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>Sessions</SectionLabel>
        <span className="loom-bandcount" data-testid="atlas-sessions-count">{rows.length}</span>
        <span style={{ flex: 1 }} />
        {/* States the card's own cost model where a reader meets it, rather than leaving "why is
            nothing showing a terminal" to be discovered. Withheld on an empty card, where it would
            promise an affordance that has no subject. */}
        {rows.length > 0 && <span className="loom-bandcount">one terminal at a time</span>}
      </div>
      {rows.length === 0 ? (
        <div className="loom-bandbody">
          <BandEmpty>Nothing is running.</BandEmpty>
          <BandFoot>
            A manager is started from its project's Agents tab, and it dispatches its own workers.
            Standing operators live on <Link to="/platform" className="loom-inlinelink">Platform</Link> and{" "}
            <Link to="/companion" className="loom-inlinelink">Companion</Link>.
          </BandFoot>
        </div>
      ) : (
        <>
          {/* `showProject`: this node is the app's only CROSS-project terminal list, so a row that
              did not name its project would leave "and where" unanswered — which is the half of a
              session's identity the project node never has to state. */}
          <SessionTerminalList rows={rows} ids={WORKSPACE_SESSION_IDS}
            regionId={SESSION_TERMINAL_REGION} showProject />
          <BandFoot>
            {workspaceSessionsSummary(rows)} Companions are driven from their own chat surface and are not listed.
          </BandFoot>
        </>
      )}
    </Panel>
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
        {/* Names the node that actually holds project creation now that the Projects page is retired
            (card 5afd71bd) — and the "New project ↗" control directly above this panel is the link,
            so the copy points at it by name rather than repeating it as a second anchor. */}
        <span style={{ color: color.text3, fontSize: fs.sm }}>
          No projects yet — create one with guided setup on the Platform node.
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
              <Dot tone={liveCount > 0 ? "live" : "muted"} glow={liveCount > 0} />
              <span className="loom-projcard-name">{p.name}</span>
              {/* Worded (card 73b41b5d, Atlas audit A-35): a bare green digit beside the name said
                  nothing about what it counted. */}
              {liveCount > 0 && <Badge tone="live" style={{ flex: "none", whiteSpace: "nowrap" }}>{liveCount} live</Badge>}
            </span>
            <span className="loom-projcard-meta">
              {liveCount > 0 ? `${plural(mgr, "manager")} · ${plural(wrk, "worker")}` : "idle"}
              {board && ` · ${plural(board.open, "open card")}`}
            </span>
            {board && <LaneBar lanes={board.lanes} title={`Cards by lane: ${board.lanes.filter((l) => l.count > 0).map((l) => `${l.label} ${l.count}`).join(" · ") || "none"}`} />}
            <span className="loom-projcard-foot">
              {landed ? `merged ${relativeTime(landed)}` : p.repoPath ? "no landing recorded yet" : "no repository bound yet"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
