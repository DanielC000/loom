import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { EventTrigger, OrchestrationEvent, Project, QuestionInboxItem, Schedule, SessionListItem, UsageLimitsStatus } from "@loom/shared";
import { api } from "../lib/api";
import { WORKSPACE_NODE_TABS, workspaceNodeTabOf } from "../nav";
import { NodeTabHostProvider } from "../lib/nodeTabHost";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, attentionOpenTarget, dismissAttention } from "../lib/attention";
import { useOpenRequest } from "../components/requests";
import { AttentionRow, EventRow } from "../components/fleet";
import { Badge, Button, Dot, Panel, StatusPill } from "../components/ui";
import {
  AtlasNodeHead, BandEmpty, BandFoot, BandPanel, DataRow, DayBars, KpiDeck, KpiStrip, LaneBar,
  MeterRow, NodeTabs, nodeTabShowsKpiStrip, PlanUsageDetail, relativeResets, type KpiItem,
} from "../components/atlasHome";
import { FleetControlsBar } from "../components/fleetControls";
import { CompactMergeAction } from "../components/reviewQueue";
import { RoleBadge } from "../lib/roleDisplay";
import { sessionVitals, standingOperators } from "../lib/atlasAgents";
import {
  boardRollup, gateLanes, isLiveSession, lastMergeByProject, liveCountsByProject, mergeThroughput,
  plural, relativeTime, useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import { GLOBAL_ACTIVITY_CAP, PULSE_EXITED_REFETCH_MS, pulseExitedManagers } from "../lib/fleet";
import { WorkspaceReplay } from "../components/workspaceReplay";
import { isCompanionSession } from "../lib/sessions";
import { color, font, type Tone } from "../theme";
import { useNavigate } from "react-router-dom";

// THE WORKSPACE ROOT NODE — cards fd99b2d7 (Atlas P2-1) and 41eab0eb (the cross-project surfaces as
// this node's tabs), both on the owner-approved round-4 V2 design: Mockups/2026-10-19 UI Overhaul
// Round 4. NINE tabs, in the mockup's own `ROOT_TABS` order: Overview is the default landing
// (full-size KPI tiles over a dashboard band over the project grid); Deck is the same node read
// board-first, with the readouts shrunk onto the tab row and a standing rail beside the grid; and the
// seven cross-project surfaces that used to be tree rows follow them as tab bodies.
//
// "Scope is depth": this node is the shallowest thing containing every project, so every figure here
// is cross-project. Nothing on this page reads the active project.
//
// ⛔ Composed from EXISTING `api.*` calls only (docs/plans/atlas-ui/02-architecture.md's hard rule),
// through the cache keys the classic pages already fill — so this node adds no poll Mission Control
// or the Gates page was not already making.

// The node's OWN LEADING tabs. The seven re-homed cross-project surfaces follow them, in the mockup's
// `ROOT_TABS` order, from the one declaration in src/nav.tsx (card 41eab0eb) — so this file never
// names which surfaces they are, only how their counts are derived.
const HOME_TABS = [{ key: "overview", label: "Overview" }, { key: "deck", label: "Deck" }];

// The node's own TRAILING tab — the retrospective reading of the same node (card ff6123de): the wave
// scrubber/diff plus the finished-wave tier, both of them Mission Control surfaces with nowhere else to
// live under Atlas. See components/workspaceReplay.tsx.
//
// It trails the re-homed seven rather than sitting with Overview/Deck for two reasons. A forensic tool is
// the rarest thing on this node, and the More ⋯ overflow folds from the END of the row — so last is
// exactly the slot that should yield first when the row runs out of width (card d4350286). And it is
// declared separately rather than appended to HOME_TABS because HOME_TABS' own position is load-bearing:
// the mockup's `homeTabs().concat(ROOT_TABS)` split puts the node's two readings FIRST, and inserting a
// third there would push Inbox and Gates right for a surface nobody reaches daily.
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
      ...managers.map((m) => ({ queryKey: ["orchEvents", m.id], queryFn: () => api.orchestrationEvents(m.id), refetchInterval: 3000 })),
      ...exitedManagers.map((m) => ({
        queryKey: ["orchEvents", m.id], queryFn: () => api.orchestrationEvents(m.id),
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

  // ── The re-homed tabs' counts (card 41eab0eb) ────────────────────────────────────────────────────
  // The mockup gives a count to three of the seven: `Inbox 4`, `Gates 1·2`, `Automation 9`. The other
  // four carry none there and carry none here.
  //
  // `["openQuestions"]` is already polled app-wide by `useAttention()` (App.tsx mounts it for BOTH
  // shells), so the Inbox count is a free read off a cache entry that is always warm. The two
  // Automation reads are the only new fetches this card adds — one-shot, no interval, 30s stale — and
  // they are the same keys pages/Schedules.tsx and pages/EventTriggers.tsx fill, so landing on that tab
  // finds its own tables already warm rather than paying twice.
  const questionsQ = useQuery<QuestionInboxItem[]>({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions() });
  const schedulesQ = useQuery<Schedule[]>({ queryKey: ["schedules"], queryFn: api.schedules, staleTime: 30_000 });
  const triggersQ = useQuery<EventTrigger[]>({ queryKey: ["eventTriggers"], queryFn: api.eventTriggers, staleTime: 30_000 });
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
  // `gateLanes` has no pending state of its own and the `gate run·queued` KPI already reads 0·0 at rest.
  const tabCounts: Record<string, ReactNode> = {
    inbox: inboxCount,
    gates: `${lanes.running}·${lanes.queued}`,
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
  const pulsePanel = (
    <BandPanel label="Pulse" testId="atlas-band-pulse">
      {events.length === 0 && <BandEmpty>No orchestration events yet.</BandEmpty>}
      {events.slice(0, GLOBAL_ACTIVITY_CAP).map((e) => <EventRow key={e.id} e={e} projectName={projectByManager.get(e.managerSessionId)} />)}
    </BandPanel>
  );

  const grid = (
    <ProjectGrid projects={projects} boards={boards} liveByProject={liveByProject} lastMerge={lastMerge}
      sessions={fleet} onOpen={(id) => { setProjectId(id); navigate("/project"); }} />
  );

  return (
    <div className="loom-atlas-home">
      {/* The node's own pill, portalled into the frame's node head (card 5968d7e0).
          ONE pill, not the mockup's `7 live` + `5 projects` pair: this node's `kpis` array already
          declares `live sessions` and `projects` as TILES, and the strip carries all six on every tab
          but Overview — so both of the mockup's pills would be a figure restated within ~50px of
          itself. `N working` is the busy count instead, which no tile on this node carries.
          No action cluster either: the workspace tier's spawnables are the standing OPERATORS, and
          card c6160c7d's decision record keeps this node a readout of those rather than a second
          place to start or stop one — their lifecycle lives on the Platform and Companion nodes
          that own it. A `Spawn +` here would also have no project to spawn INTO. */}
      <AtlasNodeHead pills={[{
        key: "working",
        text: `${workingCount} working`,
        tone: workingCount > 0 ? "phosphor" : "muted",
        title: `${plural(workingCount, "session")} across every project taking a turn right now`,
      }]} />
      {/* Overview is canonical, so its address is the bare node path — the shape every Atlas node
          gives its first tab. A tab link is built FRESH rather than merged over the live query: `sub`
          belongs to whichever re-homed page is showing, and carrying it onto a sibling tab would hand
          one guest's sub-tab value to another. */}
      <NodeTabs tabs={tabs} active={tab} hrefFor={(k) => (k === "overview" ? "/home" : `/home?tab=${k}`)}>
        {nodeTabShowsKpiStrip(tab) && <KpiStrip items={kpis} />}
      </NodeTabs>

      <RehomedTabPanels active={tab} />
      <ReplayTabPanel active={tab} />

      {/* The node's own two tabs stay CONDITIONAL, unlike the re-homed bodies above: neither holds
          unfinished user input (a KPI pop-over is ephemeral, and the fleet controls confirm in place),
          and the Deck's whole trade is vertical room — so mounting the other one hidden would cost
          every one of these panels' polls on a tab that is not showing them. */}
      {tab === "overview" && (
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
          </section>
        </>
      )}
      {tab === "deck" && (
        <div className="loom-atlas-deck">
          <section className="loom-atlas-deckmain">
            <div className="loom-atlas-primaryhead">
              <span className="loom-atlas-primarylbl">Projects</span>
              <span className="loom-bandcount">{projects.length}</span>
              <span style={{ flex: 1 }} />
              {/* Same control, same target, same reasoning as the Overview tab's above. */}
              <Link to="/platform" className="loom-btn loom-btn-default loom-bandlink"
                title="Create a project with guided setup on the Platform node">New project <span aria-hidden>↗</span></Link>
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
        {/* Names the node that actually holds project creation now that the Projects page is retired
            (card 5afd71bd) — and the "New project ↗" control directly above this panel is the link,
            so the copy points at it by name rather than repeating it as a second anchor. */}
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12.5 }}>
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
