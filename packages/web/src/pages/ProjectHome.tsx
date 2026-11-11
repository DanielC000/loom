import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { contextWindowForModel, resolveConfig, type OrchestrationEvent, type SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention, usePendingDecisionsBySession } from "../lib/attention";
import {
  GLOBAL_ACTIVITY_CAP, PULSE_EXITED_REFETCH_MS, attentionItemInProject, pulseExitedManagers,
} from "../lib/fleet";
import { bySessionActivity, byCreatedStable } from "../lib/sessions";
import { EventRow, FleetRow, sessionStatus, worstContext } from "../components/fleet";
import { HarnessMixProvider } from "../components/HarnessPicker";
import Board, { DONE_LANE_PAGE } from "./Board";
import Terminals from "./Terminals";
import AgentsNode from "./AgentsNode";
import Repository from "./Repository";
import Memory from "./Memory";
import Runs from "./Runs";
import Archive from "./Archive";
import ProjectUsage from "./ProjectUsage";
import Settings from "./Settings";
import { Panel } from "../components/ui";
import {
  AtlasNodeHead, BandEmpty, BandFoot, DataRow, DayBars, GatePair, LaneBar, MeterRow, NodeTabs,
  type NodeHeadPill,
} from "../components/atlasHome";
import {
  BriefLine, BriefTrailing, EmptyNextStep, LaneChips, OverviewCard, RosterScopeToggle, RosterTable,
  type BriefReading, type RosterCell,
} from "../components/atlasProjectOverview";
import { AgentEditDialog, AgentsQuickSpawn } from "../components/atlasAgents";
import { SessionTerminalList, type SessionListTestIds } from "../components/sessionTerminals";
import { AttentionList, GateLaneList } from "./WorkspaceHome";
import { MergeGateAttention, mergeGateAttentionCount, useMergeGateStatus } from "../components/mergeGate";
import { splitRoster } from "../lib/atlasAgents";
import { projectRunningSessions } from "../lib/workspaceSessions";
import {
  boardRollup, gateLanes, gatePairWords, isLiveSession, mergeThroughput, plural, relativeTime,
  useGateHistoryRecent, useGatesActive,
} from "../lib/atlasHome";
import {
  DEFAULT_ROSTER_SCOPE, filterRosterRows, filterScopedSessions, lastEventBySession, readRosterScope,
  rosterCardLabel, rosterRows, taskTitlesById, writeRosterScope, type RosterScope,
} from "../lib/atlasProjectOverview";
import { eventKindLabel } from "../lib/eventLabels";
import { PROJECT_NODE_TABS, isRehomedProjectTab, projectNodeTabAt } from "../nav";
import { color, fs } from "../theme";

/** The Sessions card's `aria-controls` target — one region, because there is only ever one mount. */
const PROJECT_SESSION_TERMINAL_REGION = "atlas-project-session-terminal";

/**
 * This node's Sessions-card testids (card 0bcfa530). Distinct from the Workspace node's own set
 * (`atlas-session*`) so a spec written against one node can never be satisfied by the other's card
 * — the two render the same component over different populations, which is exactly the case where a
 * shared locator would pass while proving nothing.
 */
const PROJECT_SESSION_IDS: SessionListTestIds = {
  list: "atlas-psessions-list",
  terminal: "atlas-psessions-terminal",
  row: "atlas-psession-row",
  expand: "atlas-psession-expand",
  open: "atlas-psession-open",
};

// THE PROJECT NODE — card fd99b2d7 (Atlas P2-1), the project-scoped twin of WorkspaceHome, widened
// to the approved design's ten tabs by card 25c08fba and narrowed to NINE by card 44f725fe. Every
// figure is scoped to the ActiveProjectProvider's project, which the tree's own project row writes.
//
// ⭐ ONE HOME TAB, NOT TWO (card 44f725fe — the owner's D1 pick on request fb8de852, from his own
// reading of this file: "What is the need to have an overview tab, and a deck tab? Feels redundant
// to me. Unify the pages to one."). He was right at the level of the code: Overview and Deck were
// never two pages, just two `return` branches over ONE `kpis` array and ONE set of five band-panel
// variables, differing only in how they spent the viewport.
//
// The tab SET and each tab's address are declared once, in src/nav.tsx's PROJECT_NODE_TABS — read
// there for why a re-homed tab keeps the path it already had rather than becoming a `?tab=`. This
// file owns only what the declaration cannot: each tab's COUNT, and its BODY.
//
// 🔴 THE OVERVIEW NO LONGER EMBEDS THE BOARD, AND NO LONGER MOUNTS THE KPI DECK OR THE FIVE-PANEL
// BAND — card 269f46ef, the owner's own later instruction on this page, verbatim: "Remove Board." /
// "Dashboard cards too cluttered on narrower page width. Remove 'AGENTS' card. Rework and Expand
// the rest of the cards now that the board is gone. Improve them." He then picked direction C ·
// Roster from three rendered mockups, with one amendment, also verbatim: "Overview C: 'Needs you'
// should be on top in its own row so it has enough space."
//
// That OVERRIDES the standing directive this comment used to restate (card c6bdf358, restated on
// fd99b2d7, 25c08fba and 44f725fe) that the embedded board is the owner's primary board surface. It
// is overridden ONLY here, on the Atlas project node: the CLASSIC pages/Overview.tsx board embed is
// a different surface, is still the owner's primary board, and this card does not touch it. The
// project node's Board TAB is now the node's only board, mounted whole and unchanged.
//
// @decision 269f46ef — do not re-embed <Board/> in this tab, and do not re-add the KpiDeck or the
// BandDisclosure here. Both were removed on the owner's own instruction, not as a tidy-up.
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
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;

  // WHICH AGENTS' SESSIONS THE ROSTER LISTS (card effd47d5) — the owner's own item on this tab:
  // "Optionaly show either only tarminals of spawnable agents or teminals of all running agents.
  // Adjustable by user preference." Persisted per project in localStorage, the same store and the
  // same `<area>.<field>.<projectId>` key shape the Sessions tab's tile layout already uses; the
  // key, the parse and the default all live in lib/atlasProjectOverview.ts.
  //
  // Seeded from storage in the INITIALISER (so a stored choice is on screen in the first paint
  // rather than flashing the default for a frame) and re-read by the effect, which is what makes it
  // follow a project switch — the tree can repoint this node's project under a mount that never
  // unmounts, so an initialiser alone would pin whichever project happened to resolve first. Same
  // pairing, for the same reason, as pages/Terminals.tsx's own per-project layout.
  const [rosterScope, setRosterScope] = useState<RosterScope>(
    () => (projectId ? readRosterScope(projectId) : DEFAULT_ROSTER_SCOPE),
  );
  useEffect(() => {
    setRosterScope(projectId ? readRosterScope(projectId) : DEFAULT_ROSTER_SCOPE);
  }, [projectId]);
  // The empty roster's "＋ New agent" (card 006ed11f, audit G-04) opens the Agents node's own editor
  // dialog in place. Declared here, above the `!projectId` early return, with every other hook.
  const [creatingAgent, setCreatingAgent] = useState(false);
  const chooseRosterScope = (next: RosterScope) => {
    setRosterScope(next);
    if (projectId) writeRosterScope(projectId, next);
  };

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: ({ signal }) => api.agents(projectId, signal), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: ({ signal }) => api.profiles(signal) });
  // The SAME windowed read the Board tab makes while unfiltered — same `?doneLimit=`, same key — so the
  // two share one cache entry and the node never fetches the whole done lane just to count it. The
  // window still carries every count this page shows: every non-terminal lane in full, and `doneTotal`,
  // the terminal lane's true length (`boardRollup` reads it). What it does NOT carry is the title of a
  // done card older than the window; a session holding one falls back to its short id (rosterCardLabel).
  //
  // @decision a483cbec — never drop the `doneLimit` here: this node mounts under every Board-tab visit,
  // so an unwindowed read here re-fetches the whole done set the window exists to avoid.
  const boardQ = useQuery({ queryKey: ["board", projectId, DONE_LANE_PAGE], queryFn: ({ signal }) => api.board(projectId, DONE_LANE_PAGE, signal), enabled: !!projectId, staleTime: 30_000 });
  const archivedQ = useQuery({ queryKey: ["archive", projectId, 100], queryFn: ({ signal }) => api.archivedSessions(projectId, undefined, signal), enabled: !!projectId });
  // The two tab counts no existing read on this page already answers (card 25c08fba). Both reuse the
  // EXACT query key + fetcher their own tab body uses — ["projectMemory", id] in pages/Memory.tsx,
  // ["runs", id] in pages/Runs.tsx — so the count on a tab and the rows inside it share one cache
  // entry and cannot disagree, and opening the tab issues no second request. Neither adds an api.ts
  // member. Deliberately NO refetchInterval: the Runs body sets its own 4s poll while it is mounted,
  // and the node has no reason to poll faster than the figure is read.
  const memoryQ = useQuery({ queryKey: ["projectMemory", projectId], queryFn: ({ signal }) => api.projectMemory(projectId, signal), enabled: !!projectId });
  const runsQ = useQuery({ queryKey: ["runs", projectId], queryFn: ({ signal }) => api.runs(projectId, signal), enabled: !!projectId });
  // The merge gate's failed-periodic-gate alert (card acbb6df6, re-homed from the deleted classic
  // Overview). Same hook + key the Settings tab's gate strip reads, so the two never disagree.
  const mergeGate = useMergeGateStatus(projectId || null);
  const gateAttention = mergeGateAttentionCount(mergeGate.data);
  // The node head's `<branch> <sha>` pill. The two EXISTING keys pages/Git.tsx reads — same keys,
  // same fetchers — so opening the Repository tab's Git pane issues no second request and the pill
  // and that pane can never disagree about where the repo's head is.
  //
  // These are the only reads on this page that are NOT already made for something else, and they are
  // the deliberate cost of the pill: a long `staleTime` (the head moves on a merge, not on a tab
  // click) and `retry: false`, because the expected failure here — a project with no repo bound, or
  // a repo with no commits yet — is a permanent one and the pill's answer to it is to not render.
  const branchesQ = useQuery({ queryKey: ["git-branches", projectId], queryFn: ({ signal }) => api.gitBranches(projectId, signal), enabled: !!projectId, retry: false, staleTime: 30_000 });
  const gitLogQ = useQuery({ queryKey: ["git-log", projectId], queryFn: ({ signal }) => api.gitLog(projectId, signal), enabled: !!projectId, retry: false, staleTime: 30_000 });
  const activeGatesQ = useGatesActive();
  const historyQ = useGateHistoryRecent(projectId || undefined);
  const { items: attention } = useAttention();
  // Sessions holding a PENDING owner Request they filed: their roster pill reads "waiting on you".
  const decisions = usePendingDecisionsBySession();

  const all = (sessionsQ.data ?? []).filter((s) => s.projectId === projectId);
  const live = all.filter(isLiveSession);
  const managers = all.filter((s) => s.role === "manager").sort(byCreatedStable);
  const workers = all.filter((s) => s.role === "worker").sort(bySessionActivity);
  const liveManagers = managers.filter(isLiveSession);
  // The roster's THIRD population (card 6a9cb96a, an owner bug report): every other kind of session
  // this project runs. The two filters above are exact role matches, so a thought-partner rig and
  // the Companion (both `assistant`), an `operator`, an Agent `run` and a plain terminal (no role)
  // all fell through them — while the card's own head counts them all (`${live.length} live`).
  //
  // `byCreatedStable`, not `bySessionActivity`: these are peers of a manager, whose own rows use the
  // stable key precisely so no row jumps between the page's 3s polls.
  //
  // @decision 6a9cb96a — keep this LIVE-only, and never narrow it by excluding companions: an
  // ideation/thought-partner rig shares the `assistant` role, so that exclusion drops the very
  // session this card was filed about.
  const others = all
    .filter((s) => isLiveSession(s) && s.role !== "manager" && s.role !== "worker")
    .sort(byCreatedStable);

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

  const board = boardRollup(boardQ.data?.columns, boardQ.data?.tasks, boardQ.data?.doneTotal);
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

  // …and the SAME derivation is what the roster's scope filter asks about, as an id set, so the
  // table and the `spawnable` figure in the briefing line can never disagree about who is spawnable.
  //
  // `null` until BOTH reads behind that answer have landed. `splitRoster` answers a missing agent
  // list with an empty roster and a missing profile list by reading every role as null, so an
  // in-flight page would otherwise claim either that nothing is spawnable (hiding the whole fleet)
  // or that everything is (showing dispatched workers under a filter that says it hides them).
  // `filterRosterRows` lists everything for `null`, which is exactly what the page showed a tick
  // earlier — a loading state, never a stated one.
  const spawnableAgentIds = useMemo(
    () => (agentsQ.data && profilesQ.data ? new Set(roster.spawnable.map((r) => r.agent.id)) : null),
    [agentsQ.data, profilesQ.data, roster.spawnable],
  );

  // The project's pulse, TWO TIERS — card 102bc915 extending card ef86b089 from the workspace node to
  // this one. This fed off `liveManagers` alone, so an exited-but-unarchived manager's stream was
  // reachable NOWHERE on the project tier: the classic Overview reads every non-archived manager, so
  // retiring it would have dropped a whole class of manager rather than merely older events. That is
  // the SAME gap ef86b089 found and closed one tier up, and this is the same fix, not a second one.
  //
  // `all` is already project-filtered, so the helper's own recency cap applies WITHIN this project.
  // The cap and the 60s interval are both load-bearing and are ef86b089's to set — read
  // `pulseExitedManagers` (lib/fleet.ts) for the policy; never fold this tier onto the live tier's 3s
  // interval and never drop its cap. Same `["orchEvents", id]` keys as the live tier, so a manager
  // crossing between them keeps its cache entry and only changes how often it is refetched.
  const exitedManagers = useMemo(() => pulseExitedManagers(all), [all]);
  const eventQs = useQueries({
    queries: [
      ...liveManagers.map((m) => ({ queryKey: ["orchEvents", m.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.orchestrationEvents(m.id, signal) })), // live tier: pushed over /ws/fleet, no poll (card 670b2081)
      ...exitedManagers.map((m) => ({
        queryKey: ["orchEvents", m.id], queryFn: ({ signal }: { signal: AbortSignal }) => api.orchestrationEvents(m.id, signal),
        refetchInterval: PULSE_EXITED_REFETCH_MS,
      })),
    ],
  });
  const events = eventQs
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));

  if (!projectId) {
    return (
      <Panel style={{ maxWidth: 560, padding: "18px 20px" }} data-testid="atlas-project-empty">
        <p style={{ margin: 0, color: color.text2, fontSize: fs.body, lineHeight: 1.7 }}>
          No project is active yet. Pick one in the entity tree — this node is whichever project the tree has open.
        </p>
      </Panel>
    );
  }

  // A `?task=<id>` card deep link arriving on any tab but Board normalizes the ADDRESS onto the
  // Board tab, which is the only surface on this node that can show the dialog it asks for. Until
  // card 269f46ef the Overview embedded a whole <Board/> and consumed the param itself; with the
  // embed gone the link would otherwise land on a page that cannot answer it and leave `task=`
  // sitting in the URL. Same shape, and the same reasoning, as the Platform node's own
  // normalization (pages/PlatformView.tsx) — rewrite the address, never merely derive a tab, since
  // Board CLEARS the param it consumes.
  //
  // `tab` is dropped rather than carried: it is this node's own home-tab key and means nothing at
  // `/board`, which is a re-homed tab with an address of its own. Every other incoming key rides
  // along.
  //
  // @decision 269f46ef — a card deep link on this node must still reach a board. Never remove this
  // normalization without putting a <Board/> back on whichever tab the link lands on.
  const taskParam = new URLSearchParams(search).get("task");
  if (taskParam && tab !== "board") {
    const next = new URLSearchParams(search);
    next.delete("tab");
    return <Navigate to={`/board?${next.toString()}`} replace />;
  }

  // ── The briefing line (card 269f46ef) ────────────────────────────────────────────────────────
  // Five readings where the deck had six tiles, each keeping the breakdown its tile owned.
  //
  // ⛔ `needs you` is NOT among them: it is the full-width card directly below, whose own head
  // carries the count. And neither `working` nor the repo head is here either — both are node-head
  // pills (card 5968d7e0), which render on EVERY tab, so restating one ~40px under itself is the
  // same-number-twice shape card 939922ee was filed against. The mockup this was built from drew
  // `HEAD main <sha>` in both places; that is the one thing in it not reproduced, deliberately.
  const briefReadings: BriefReading[] = [
    {
      key: "cards", label: "board", value: board.open, sub: `open · ${board.inReview} review · ${board.waiting} waiting`,
      tone: "muted",
      title: `${plural(board.total, "card")} on the board, ${board.open} of them open`,
      popover: (
        <>
          {board.lanes.map((l) => <DataRow key={l.key} label={l.label} value={l.count} tone="muted" />)}
          <BandFoot>{plural(board.total, "card")} on the board, {board.open} of them open.</BandFoot>
        </>
      ),
    },
    {
      key: "fleet", label: "fleet", value: live.length, sub: `live · ${roster.spawnable.length} spawnable`,
      tone: liveManagers.length > 0 ? "live" : "muted",
      title: `${liveManagers.length} live manager(s) and ${workers.filter(isLiveSession).length} live worker(s) in this project`,
      popover: <FleetList managers={managers} workers={workers} />,
    },
    {
      key: "context", label: "worst context", value: wc.ctx > 0 ? `${ctxPct}%` : "—",
      // Highest band FIRST. Tested amber-before-red, `>= 95` was unreachable — anything at 95 is also
      // at 80 — so the figure could never go red, which is the one state this reading exists to
      // surface. The workspace node's `plan` tile orders it the same way.
      tone: ctxPct >= 95 ? "danger" : ctxPct >= 80 ? "attn" : "accent",
      sub: worstSession ? worstSession.agentName : "no session reports context",
      title: worstSession ? `${worstSession.agentName} · ${plural(worstSession.ctxTurns ?? 0, "turn")}` : undefined,
      popover: <ContextList sessions={live} recycleAt={recycleAt} />,
    },
    {
      key: "gates", label: "gate lanes", value: <GatePair lanes={lanes} />, sub: `of cap ${lanes.cap}`,
      tone: lanes.queued > 0 || lanes.running > 0 ? "work" : "muted",
      title: `${gatePairWords(lanes)}, daemon-wide (cap ${lanes.cap})`,
      popover: <GateLaneList lanes={lanes} />,
    },
  ];

  // The roster table's rows and the two facts that are NEW to this page — which card a session is
  // holding, and when it last said anything. Both come off reads this page already makes; see
  // lib/atlasProjectOverview.ts for why a manager and a worker resolve "last event" differently.
  const taskTitles = taskTitlesById(boardQ.data?.tasks);
  const lastEvents = lastEventBySession(events);
  const rows = rosterRows(managers, workers, others);
  // The scope filter (card effd47d5). BOTH populations are derived, in both modes, because the
  // toggle states each option's own count — so the reading the reader is not looking at says what
  // picking it would yield, rather than making them click to find out.
  const spawnableRows = filterRosterRows(rows, "spawnable", spawnableAgentIds);
  const visibleRows = filterRosterRows(rows, rosterScope, spawnableAgentIds);
  const hiddenRows = rows.length - visibleRows.length;

  // ── The Sessions card's own population (card 0bcfa530) ──────────────────────────────────────
  //
  // The SAME scope preference, applied to a DIFFERENT population — and the difference is the point,
  // not an oversight. The roster lists every non-archived manager and worker, exited ones included,
  // because its job is "what is this project working on"; a terminal list can only list sessions
  // that are actually RUNNING, because an exited session has no pty to attach to and a companion is
  // driven from its chat surface rather than a raw one (the companion guard, card 5c87f4b6). So the
  // two cards state their own counts in their own heads and each footer names its own omissions —
  // the shape card 9b6be377 warns against is one card's HEAD disagreeing with that card's own LIST,
  // which is why both heads here count exactly what they list.
  const termRows = projectRunningSessions(sessionsQ.data, projectId);
  const visibleTermRows = filterScopedSessions(termRows, rosterScope, spawnableAgentIds);
  const hiddenTermRows = termRows.length - visibleTermRows.length;
  const cellFor: (row: { session: SessionListItem }) => RosterCell = ({ session: s }) => {
    const ctx = s.ctxInputTokens ?? 0;
    const ratio = ctx > 0 ? ctx / contextWindowForModel(s.model) : 0;
    const e = lastEvents.get(s.id);
    return {
      state: sessionStatus(s, decisions.has(s.id)),
      card: rosterCardLabel(s, taskTitles),
      branch: s.branch ?? null,
      context: ctx > 0
        ? { ratio, pct: Math.round(ratio * 100), tone: ratio >= 0.95 ? "danger" : ratio >= 0.8 ? "attn" : "accent" }
        : null,
      lastEvent: e ? { kind: e.kind, label: eventKindLabel(e.kind, e.detail), at: relativeTime(e.ts) } : null,
    };
  };

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
      tone: working > 0 ? "live" : "muted",
      title: `${plural(working, "session")} in ${project?.name ?? "this project"} taking a turn right now`,
    },
    // The branch is NOT assumed to be `main` — the mockup's own `main 57143a90` is that repo's
    // name for it, and a project bound to a repo on `master` or a release branch reads its own.
    // Omitted entirely rather than guessed when either read fails: no repo bound, or no commit yet.
    ...(headBranch && headSha
      ? [{ key: "head", text: `${headBranch} ${headSha.slice(0, 8)}`, title: `${headBranch} at ${headSha}` } as NodeHeadPill]
      // While either read is still in flight, hold the pill's place (card eb516fba, audit B-25) so the
      // head row does not shift when it lands. Its own key, so `atlas-nodehead-pill-head` still means
      // "the head is known". A settled failure renders nothing, exactly as before.
      // `isLoading`, not `isPending`: a disabled query (no project yet) is pending forever.
      : branchesQ.isLoading || gitLogQ.isLoading
        ? [{ key: "head-pending", text: "main 00000000", pending: true } as NodeHeadPill]
        : []),
  ];

  // The eight re-homed tab bodies. Each is the EXISTING page component, mounted verbatim — this card
  // re-homes surfaces, it does not rebuild them. Sessions is the one that takes a prop: its page is
  // god-eye by design and already supports being "reached per-project by pre-selecting the filter",
  // so the project node hands it this project's name and the body matches the tab's own count.
  const tabBodies: Record<string, ReactNode> = {
    // `deepLinks` only while the Board tab is the VISIBLE one. A re-homed body stays mounted after
    // its first visit, parked with `hidden` — and a mounted-but-hidden board that consumed `?task=`
    // would open its dialog where nobody can see it and clear the param on the way out, which is
    // exactly what the normalization above is routing the link here to avoid (card 260fb29a).
    board: <Board projectId={projectId} deepLinks={tab === "board"} />,
    // Both halves of the pre-selection: the NAME drives its project filter, the ID is what its
    // quick-start reads a roster by (card f3b18f27). The god-eye classic mount still passes neither.
    sessions: <Terminals projectId={projectId} projectName={project?.name} />,
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

        {/* THE node's one home tab (card 269f46ef — direction C · Roster). Rendered only while it
            is the selected tab, unlike the re-homed bodies above: it holds no input of its own to
            protect, so there is nothing for a park to save.

            The ORDER is the owner's. C put Needs-you in a two-up footer beside Pulse; his amendment
            — "'Needs you' should be on top in its own row so it has enough space" — hoists it to the
            first card at full width, which leaves Pulse the footer on its own. That is not only a
            move: it is also what finally pays Pulse the width card b4442d27 measured it needing
            (479px for its four columns at natural width, against 135px inside the band it used to
            share with four other panels). */}
        {tab === "overview" ? (
          <>
            <BriefLine readings={briefReadings} trailing={
              <BriefTrailing label="landed" value={merges.branches} testId="atlas-brief-merged"
                tone={merges.branches > 0 ? "live" : "muted"}
                sub={merges.branches > 0 ? `today · last ${relativeTime(merges.lastEndedAt)}` : "today"}>
                {/* The series IS the breakdown, so this reading is a readout and not a fifth button:
                    a pop-over would open the same 14 bars already drawn beside the figure. */}
                <DayBars series={merges.byDay} label="branches landed per day" />
              </BriefTrailing>
            } />

            <OverviewCard label="Needs you" count={projAttention.length + gateAttention}
              action={{ to: "/inbox", label: "Inbox" }} testId="atlas-band-needs">
              {/* A failed periodic merge gate (the default branch is unverified and every merge stays
                  gated). It never enters the shared attention feed, so it is mounted here directly and
                  counted beside it, exactly as the classic Overview did. Renders nothing when healthy.
                  @decision acbb6df6 — the alert lives HERE, never only on the Settings tab. */}
              <MergeGateAttention status={mergeGate.data} />
              {/* The SAME list the `needs you` breakdown renders at both node levels, so the card and
                  the Inbox cannot disagree about what is waiting. `cap` is higher than the band's 6
                  because this card is now a full-width row with the page's whole width to spend. Its
                  "nothing needs you" empty state is skipped while the gate alert above is showing. */}
              {(projAttention.length > 0 || gateAttention === 0) && <AttentionList items={projAttention} cap={10} />}
            </OverviewCard>

            <OverviewCard label="Work in flight" count={`${live.length} live · ${working} working`}
              action={{ to: "/terminals", label: "Sessions" }} testId="atlas-overview-roster"
              controls={
                <RosterScopeToggle testId="atlas-roster-scope" value={rosterScope}
                  onChange={chooseRosterScope}
                  counts={{ all: rows.length, spawnable: spawnableRows.length }} />
              }
              footer={<>
                {/* THE FILTER SENTENCE COMES FIRST, and only while something is actually hidden.
                    This footer's job is to keep the card's own label honest, and "Work in flight"
                    over a filtered list is the one thing on the card that can now be read as more
                    than it is. The head count is deliberately left alone — it is the project's live
                    FLEET, which is what the Sessions exit beside it opens, and restating a filtered
                    figure there would put two populations in one head. */}
                {hiddenRows > 0 ? <>
                  Listing only the agents you start by hand; {plural(hiddenRows, "session")} dispatched
                  by a manager {hiddenRows === 1 ? "is" : "are"} hidden.{" "}
                </> : null}
                Context is measured against each session's own model window
                {recycleAt > 0 ? <>; a manager is nudged to hand off at {Math.round(recycleAt * 100)}%</> : null}.
                An idle worker is live and waiting on its manager, not stopped, and an exited manager
                or worker stays listed here until it is archived. Every other kind of session — a
                thought partner, a companion, an operator, a run, a plain terminal — is listed only
                while it is running.
              </>}>
              {/* THREE states, not two: a project with no sessions at all, and a project whose
                  sessions are all filtered out, are different facts and the second must not be
                  reported as the first — a reader who has just hidden four running workers would
                  otherwise be told the project has nothing in flight. */}
              {rows.length === 0
                ? <EmptyNextStep hasAgents={(agentsQ.data?.length ?? 0) > 0} agentsLoaded={!!agentsQ.data}
                    onNewAgent={() => setCreatingAgent(true)}
                    spawn={<AgentsQuickSpawn projectId={projectId} projectName={project?.name}
                      testId="atlas-overview-empty-spawn" trigger="button" />} />
                : visibleRows.length === 0
                  ? <BandEmpty>
                      No agent you start by hand has a session here — {plural(rows.length, "session")}{" "}
                      dispatched by a manager {rows.length === 1 ? "is" : "are"} hidden by the filter above.
                    </BandEmpty>
                  : <RosterTable rows={visibleRows} cellFor={cellFor} />}
            </OverviewCard>

            {/* ── THE SESSIONS CARD (card 0bcfa530) ────────────────────────────────────────────
                The owner's decision 925ea659, verbatim: "Also add a filtered terminal list to the
                project Overview (new card)" — closing the question card effd47d5's record left open
                ("his word was 'terminals', and this page has none").

                @decision 0bcfa530 — this card stays DIRECTLY under the roster, is never folded into
                it, and never grows a second scope toggle or a second `Sessions ↗` exit of its own. */}
            <OverviewCard label="Sessions" count={visibleTermRows.length}
              testId="atlas-overview-sessions"
              footer={<>
                {/* Same order as the roster's footer, and for the same reason: the sentence that can
                    make the card's own label read as more than it is comes FIRST, and only while
                    something is actually hidden. It names the control rather than repeating it —
                    one preference, one place to change it. */}
                {hiddenTermRows > 0 ? <>
                  Listing only the agents you start by hand; {plural(hiddenTermRows, "running session")}{" "}
                  dispatched by a manager {hiddenTermRows === 1 ? "is" : "are"} hidden by the filter on
                  the card above.{" "}
                </> : null}
                One terminal is mounted at a time, and collapsing it only releases the view — the
                session keeps running. Companions are driven from their own chat surface and are not
                listed, and an exited session has no terminal to show.
              </>}>
              {/* THREE states, not two — the roster's own rule one card up: a project with nothing
                  running and a project whose running sessions are all filtered out are different
                  facts, and reporting the second as the first would tell a reader who has just
                  hidden four live workers that nothing is running. */}
              {termRows.length === 0
                ? <BandEmpty>No session is running in this project.</BandEmpty>
                : visibleTermRows.length === 0
                  ? <BandEmpty>
                      No agent you start by hand has a session running here — {plural(termRows.length, "running session")}{" "}
                      dispatched by a manager {termRows.length === 1 ? "is" : "are"} hidden by the filter above.
                    </BandEmpty>
                  : <SessionTerminalList rows={visibleTermRows} ids={PROJECT_SESSION_IDS}
                      regionId={PROJECT_SESSION_TERMINAL_REGION} />}
            </OverviewCard>

            <OverviewCard label="Board" count={`${board.open} open · ${board.total} total`}
              action={{ to: "/board", label: "Board" }} testId="atlas-overview-board">
              {/* The whole board signal in one strip: the SAME LaneBar the board head wore, now with
                  its lanes named and counted under it rather than only on a hover title. */}
              <LaneBar lanes={board.lanes} />
              <LaneChips lanes={board.lanes} />
            </OverviewCard>

            <OverviewCard label="Pulse" count="last 24h" action={{ to: "/runs", label: "Runs" }}
              testId="atlas-band-pulse" bodyMaxHeight={300}>
              {events.length === 0 && <BandEmpty>No orchestration events yet.</BandEmpty>}
              {/* `GLOBAL_ACTIVITY_CAP` (lib/fleet.ts) — the SAME constant the classic Overview's
                  Activity section, Mission Control's Activity column and the workspace node's own
                  Pulse all read, so the four cannot disagree about how deep "recent activity" goes.
                  The card's own body scrolls, so the cap buys depth and never page length. */}
              {events.slice(0, GLOBAL_ACTIVITY_CAP).map((e) => <EventRow key={e.id} e={e} />)}
            </OverviewCard>
          </>
        ) : null}

        {/* THE USAGE TAB (card 30266229). The node's SECOND non-re-homed tab — see PROJECT_NODE_TABS in
            src/nav.tsx for why it is a `?tab=` rather than an address of its own.

            Rendered only while selected, like the home tab above and unlike the eight re-homed bodies:
            it holds no unfinished INPUT to protect (its window picker, sort and expanded-row set are
            all re-derivable choices, not typed text), and keeping a polling usage query mounted behind
            nine other tabs would make every project address pay for a breakdown nobody opened. */}
        {tab === "usage" ? <ProjectUsage /> : null}
        {creatingAgent && (
          <AgentEditDialog projectId={projectId} agentId={null} onClose={() => setCreatingAgent(false)} />
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
          tone={ratio >= 0.95 ? "danger" : ratio >= 0.8 ? "attn" : "accent"} />
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
