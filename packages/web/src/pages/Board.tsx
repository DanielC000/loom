import { Fragment, useState, useEffect, useId, useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, useIsMutating, keepPreviousData } from "@tanstack/react-query";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type Announcements } from "@dnd-kit/core";
import { bandSlots, clampSlot, planReorder, slotForPointer } from "../lib/laneReorder";
import { LaneMenu, boardCollision, laneDragId, movedKeys, useCollapsedLanes, type BoardDragData } from "../components/boardLanes";
import type { Task, BoardTask, TaskPriority, KanbanColumn, SessionListItem, QuestionInboxItem, PendingMerge, RepoRegistryEntry } from "@loom/shared";
// The done lane's order lives in shared, not here: the server picks WHICH cards a `?doneLimit=` window
// contains by this same comparator, so a second copy would be a window that disagrees with its lane.
// `columnKeyForRole` is the daemon's OWN terminal-lane resolver, used here only to identify which lane
// a windowed response describes — never to decide a lane's tint or sort (that stays `isDoneColumn`).
import { byRecentlyDone, columnKeyForRole } from "@loom/shared";
import { api, type TaskUpdateConflictError, type TaskUpdatePatch } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useBottomDock } from "../lib/bottomDock";
import { Button, Input, Select, SectionLabel, StatusPill, Chip, Badge, Dot } from "../components/ui";
import { useOpenRequest, RequestTypeTag, RequestProvenance } from "../components/requests";
import { DecisionStateChip } from "../components/decisions";
import { relativeAge, requestHint, REQUEST_TYPE_TONE } from "../lib/questions";
import { usePendingDecisionsBySession } from "../lib/attention";
import { WAITING_ON_YOU } from "../lib/fleet";
import { workerSessionPath } from "../lib/cardWorker";
import { CardWorkerRow } from "../components/cardWorker";
import { color, columnTone, font, fs, radius, shadow, tone, toneFill, toneSoft, toneText, type Tone } from "../theme";
// Board-hierarchy read model + presentation (card 1ae4f88c). The lib reads the daemon's hierarchy fields
// structurally and defaults every one of them, so a response without them renders exactly as before.
import { boardHierarchy, hasBoardHierarchy, hasTaskContextLinks, resolveParentInput, taskLinks, type TaskLinks, type TaskRef } from "../lib/taskHierarchy";
import { BoardCardHierarchy, TaskLinkRow, TaskLinksBlock } from "../components/taskLinks";
import { TaskRelationsEditor, relationGrid, relationRowLabel } from "../components/taskRelationsEditor";
import {
  relationBaseline, relationErrorTarget, relationPatch, relationsDirty,
  type PickerCard, type RelationDraft, type RelationPatch,
} from "../lib/taskRelationsEdit";
import { useSpeechRecognition, type SpeechRecognitionApi } from "../lib/useSpeechRecognition";
import { useVoiceLang } from "../lib/useVoiceLang";
import { isDoneColumn } from "../lib/columnSort";
import { useResolvedTheme, type ResolvedTheme } from "../lib/themePref";
import { taskMatchesSearch } from "../lib/taskFilter";
import { laneOverflow, scrollTargetFor, type LaneOverflow, type LaneSpan } from "../lib/laneOverflow";
import {
  CARD_STATES, OTHER_TYPE, commitType, descendantCounts, hasState, isUnderEpic, pendingRequestTaskIds, sortTypes,
  type CardState, type StateContext,
} from "../lib/boardFilters";
// Priority chip + metadata live in one place so the board and the /terminals task card never drift.
import { PRIORITY_META, PriorityChip, prio, byPriorityThenPosition } from "../components/priority";
import { errorText } from "../lib/loopbackCredential";
import { submitDraft } from "../lib/draftSubmit";
import {
  BoardNavContext, NAV_HEAD, NAV_KEYS, NAV_MORE, NEW_CARD_KEY, SELECT_KEY, laneRange, navElement, navTarget, readNavLanes,
  renderedCards, resolveLaneItem, shortcutBlocked, tabOutWrapTarget, takeNavHint, useBoardNav, type BoardFocus, type BoardNav, type NavKey,
} from "../lib/boardFocus";
import { usePreviewOnly, PREVIEW_REQUEST_HELD_TITLE } from "../lib/previewOnly";
// Ship state is only DISCOVERABLE from git while this project writes the reserved trailer paragraph
// (card bd828fb3) — the drawer says so rather than letting a null read as "did not ship".
import { commitTrailersOff, SHIP_STATE_TRAILERS_OFF } from "../lib/mergeGate";
// Card policies (card 61d32daf): the unmet badge on a card and the drawer's Policy block. This one component is
// also the board embedded in Overview, so both surfaces get them.
import { CardPolicyBadge, CardPolicyBlock, useCardPolicyStatus } from "../components/cardPolicies";
import type { CardPolicyCardStatus } from "../lib/cardPolicies";

const PRIORITIES: TaskPriority[] = ["p0", "p1", "p2", "p3"];
// Everything the detail drawer can write, in ONE place — the drawer's `onSave` prop, the mutation that
// receives it and api.updateTask all read the same shape, so a new editable field can't be added to the
// form and quietly dropped on the way to the request. `parentId` (card 1ae4f88c) is `string | null`:
// null CLEARS the parent, and the key is omitted entirely when the field wasn't touched.
// The four relation kinds (card 03d9db6e) ride the same shape — see RelationPatch for the whole-set
// replace rule and why an untouched kind must be omitted rather than echoed back.
type TaskEditPatch = {
  title?: string; body?: string; priority?: TaskPriority; held?: boolean; deferred?: boolean;
  repoKey?: string | null; parentId?: string | null; baseVersion?: number;
} & RelationPatch;
// A live lane's card order lives beside `prio` in components/priority — see that comment for why it
// is not in this file. The done lane's own order (`byRecentlyDone`) is imported from @loom/shared above.

// ── Done-lane paging ──────────────────────────────────────────────────────────
// @decision 7da27eb5 — page only the TERMINAL lane, and only AFTER filtering (paging first searches
// just the newest page and silently loses an older match). The lane header's count is the full
// filtered length, never the rendered one.
//
// @decision a483cbec — while NO filter is active this page size is also the server's `?doneLimit=`
// window, so the lane's unrendered cards are never fetched at all; the instant a filter IS active the
// client must drop the param and fetch the whole set, or a search can only ever see the newest page.
const DONE_LANE_PAGE = 50;
const NO_POLICY_STATUS: Record<string, CardPolicyCardStatus> = {};

// The outcome of one bulk action (card 19074e42). `verb` is the past-tense phrase ("moved to Review").
type BulkResult = { verb: string; updated: number; skipped: number; failed: { id: string; title: string; error: string }[] };
const cardsWord = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
function bulkSummary(r: BulkResult): string {
  const parts: string[] = [];
  if (r.updated || !r.failed.length) parts.push(`${cardsWord(r.updated)} ${r.verb}`);
  if (r.skipped) parts.push(`${r.skipped} already were`);
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  return parts.join(", ");
}

// Per-project kanban. Reads/writes the SAME task store the MCP tools use — moving a card
// POSTs columnKey, which a spawned agent's tasks_list immediately sees, and vice versa.
// Scoped to the header's active project by default; an explicit `projectId` prop points it at a
// specific project instead — the Platform section reuses it pointed at the reserved "Loom Platform"
// home so its board (the findings + escalations backlog) renders + triages with the same component.
// `deepLinks` says whether THIS mount is the one that consumes `?task=` (default: it is, so every
// existing mount is unchanged). A node that parks its inactive tab bodies with `hidden` rather than
// unmounting them has a LIVE but invisible board, and whichever board consumed the param first used to
// open its dialog inside a panel nobody can see — then cleared the param, so no visible board ever got
// it. A hidden panel passes `false` and stays out of it.
//
// @decision 260fb29a — never consume or clear `?task=` from a mount that cannot show the dialog.
export default function Board({ projectId: propProjectId, deepLinks = true }:
  { projectId?: string; deepLinks?: boolean } = {}) {
  const qc = useQueryClient();
  const active = useActiveProject();
  const projectId = propProjectId ?? active.projectId;
  const [openTaskId, setOpenTaskId] = useState<string | null>(null); // task whose detail drawer is open

  // ── Client-side view filter (no server round-trip) ───────────────────────────
  // Search matches id+title+body (case-insensitive substring — a full card id or any prefix finds the
  // card by its primary handle). The rest filter on CARD DETAILS: priority, commit type and State are
  // multi-select (empty = no constraint, OR within a group); Epic and Repo are single-selects (null =
  // any). Groups AND together; non-matching cards vanish from every lane.
  //
  // @decision cea577af — never persist these filters per viewer, and never re-add a column filter.
  //
  // Declared ABOVE the board query because `filterActive` decides whether that query may ask the server
  // for a done WINDOW at all (card a483cbec) — the filter runs over whatever the response contains, so a
  // windowed response while filtering could only ever search the newest page. Every filter below MUST
  // count toward `filterActive`, or turning it on would filter a windowed response.
  const [search, setSearch] = useState("");
  const [priFilter, setPriFilter] = useState<Set<TaskPriority>>(() => new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() => new Set());
  const [stateFilter, setStateFilter] = useState<Set<CardState>>(() => new Set());
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  // "" is the PRIMARY repo (a card whose repoKey is null); null is "any repo".
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const toggleIn = <T,>(set: (f: (s: Set<T>) => Set<T>) => void) => (v: T) =>
    set((s) => { const n = new Set(s); n.delete(v) || n.add(v); return n; });
  const togglePri = toggleIn(setPriFilter);
  const toggleType = toggleIn(setTypeFilter);
  const toggleState = toggleIn(setStateFilter);
  const clearFilters = () => {
    setSearch(""); setPriFilter(new Set()); setTypeFilter(new Set()); setStateFilter(new Set());
    setEpicFilter(null); setRepoFilter(null);
  };
  // A project switch drops the single-selects: an epic or repo key from project A means nothing on B.
  useEffect(() => { setEpicFilter(null); setRepoFilter(null); }, [propProjectId, active.projectId]);
  const q = search.trim().toLowerCase();
  const filterActive = q !== "" || priFilter.size > 0 || typeFilter.size > 0 || stateFilter.size > 0
    || epicFilter !== null || repoFilter !== null;

  // ── The done-lane window (card a483cbec) ─────────────────────────────────────
  // How many done cards this board currently asks the server for. The "Show N more" reveal bumps it by
  // one page, which changes the query key and so is a real refetch rather than a client-side unhide.
  // Reset on a project switch for the same reason `<Column>`'s key carries the project id: lane B must
  // not open already-expanded because lane A was.
  const [doneWindow, setDoneWindow] = useState(DONE_LANE_PAGE);
  useEffect(() => { setDoneWindow(DONE_LANE_PAGE); }, [projectId]);
  // `null` ⇒ send no `?doneLimit=` at all and fetch the WHOLE board. That is the state while any filter
  // is active, preserving 7da27eb5's load-bearing invariant (filter first, page second) across the new
  // server window: a search for a done card from last year has to be able to reach it.
  const doneLimit = filterActive ? null : doneWindow;
  // Poll so the board reflects task changes made by ANOTHER process (the orchestrator via MCP), not
  // just this client's own mutations — otherwise external card moves only appear on a manual refresh.
  // keepPreviousData (above) makes the 4s refetch flicker-free, and ALSO covers the two key changes this
  // board now makes on purpose — a window bump and the windowed↔full switch — so neither flashes an
  // empty lane. Matches the Platform board's polling.
  //
  // The key EXTENDS `["board", projectId]` rather than replacing it: that exact entry stays the full,
  // unwindowed set its four other consumers read, while `invalidateQueries(["board", projectId])` below
  // still reaches every windowed entry too, because react-query matches a key by prefix.
  // A within-lane card reorder (card 139cfc3d) can be several sequential writes; the poll is paused until
  // they settle, so a refetch landing mid-sequence never paints a half-renumbered band.
  const cardReorderKey = ["board-card-reorder", projectId];
  const cardReordering = useIsMutating({ mutationKey: cardReorderKey }) > 0;
  const board = useQuery({ queryKey: ["board", projectId, doneLimit], queryFn: ({ signal }) => api.board(projectId, doneLimit ?? undefined, signal), enabled: !!projectId, refetchInterval: cardReordering ? false : 4000, placeholderData: keepPreviousData });
  // True while a DIFFERENT window (or the windowed↔full switch) is in flight and the lane is still
  // showing the previous response — the reveal button's loading state.
  const windowPending = board.isPlaceholderData;
  // Link the board to the orchestration spine: a worker carries its task id, so cards can show the
  // live worker's status + branch for the task they represent.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  // The project's WRITABLE repo registry (multi-repo epic 49136451, phase 3). Drives the card repo
  // picker + badge. A project with an EMPTY registry (the overwhelmingly common case) renders no picker
  // and no badge at all — zero UI tax for a single-repo project, which is the point. Reuses the
  // already-cached ["projects"] query every other page shares, so this costs no extra round trip.
  const projects = useQuery({ queryKey: ["projects"], queryFn: ({ signal }) => api.projects(signal) });
  const project = (projects.data ?? []).find((p) => p.id === projectId) ?? null;
  const repos = project?.repos ?? [];
  const multiRepo = repos.length > 0;
  // Per-card unmet counts for the policy badge. No request at all on a project that stores no policy.
  const policyStatus = useCardPolicyStatus(projectId, project);
  const policyByTask = policyStatus.data?.tasks ?? NO_POLICY_STATUS;
  const workerByTask = new Map<string, SessionListItem>();
  for (const s of sessions.data ?? []) if (s.taskId) workerByTask.set(s.taskId, s);

  const move = useMutation({
    mutationFn: ({ id, columnKey }: { id: string; columnKey: string }) => api.updateTask(id, { columnKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  // `repoKey` routes the new card at a registered repo; null = the project's primary. Passed only as
  // whatever the picker resolved — a single-repo project always sends null, i.e. the same request body
  // this mutation sent before multi-repo existed.
  const create = useMutation({
    // Inline-only (see NewTask's error line) — no global blocking alert. Same reason as the drawer's
    // edit mutation below: an unknown repoKey is a message to read next to the control that caused it.
    meta: { inlineError: true },
    mutationFn: ({ title, repoKey }: { title: string; repoKey: string | null }) =>
      api.createTask(projectId, { title, columnKey: "inbox", repoKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
    onError: () => { /* surfaced inline by NewTask via create.error */ },
  });
  // "+ Add child card" from the card dialog (card 92259dac, audit G-03). Lands in the inbox like a
  // quick-added card, with `parentId` set. Refetches the PARENT's detail too, since that read is what
  // carries its Children list.
  const addChild = useMutation({
    meta: { inlineError: true },
    mutationFn: ({ parentId, title }: { parentId: string; title: string }) =>
      api.createTask(projectId, { title, columnKey: "inbox", parentId }),
    onSuccess: (_r, { parentId }) => {
      qc.invalidateQueries({ queryKey: ["board", projectId] });
      qc.invalidateQueries({ queryKey: ["task", parentId] });
    },
    onError: () => { /* surfaced inline by AddChildCard */ },
  });
  // Edit a task's title/description/priority/held/deferred from the detail drawer (same store the MCP tools read/write).
  // `baseVersion` (card 0b36702e) rides along on a content (title/body) save — the drawer sends the
  // version it LOADED, so a stale save (an agent wrote the body while the drawer was open) 409s instead
  // of silently clobbering it. Omitting it (the drawer's "overwrite anyway" retry) writes blind.
  const edit = useMutation({
    // Inline-only (the drawer renders saveError beside Save). The repoKey retarget refusal is a
    // paragraph of reasoning about worktrees — it belongs next to the picker, not in a modal the user
    // must dismiss before they can act on it. A version conflict is ALSO inline for the same reason —
    // it's a decision to make right next to the fields it affects, not a blocking modal.
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: string; patch: TaskEditPatch }) => api.updateTask(id, patch),
    // Invalidate BOTH the board list and this card's own lazy-fetched detail (a done card's body query,
    // below) — a save must never leave the detail cache holding the pre-edit body on next open.
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ["board", projectId] });
      qc.invalidateQueries({ queryKey: ["task", id] });
    },
  });
  // PERMANENTLY delete a task card from the drawer (HUMAN-only REST; no MCP path). On success close the
  // drawer + refetch the board. On the server's live-session guard 400, delErr throws the reason — leave
  // the drawer open and surface `del.error` to the user instead of silently closing.
  const del = useMutation({
    meta: { inlineError: true },
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => { setOpenTaskId(null); qc.invalidateQueries({ queryKey: ["board", projectId] }); },
  });

  // ── Lane order + collapse (card 67c43038) ────────────────────────────────────
  // A reorder writes ONLY the order, through the permutation-only route, so a reorder computed from a stale
  // 4s poll is refused (409) rather than silently dropping a column created since. Optimistic across every
  // cached window of this board (the key prefix), rolled back on failure; the refetch then shows the truth.
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsedLanes, setLaneCollapsed] = useCollapsedLanes(projectId);
  const [announcement, setAnnouncement] = useState("");
  const [laneError, setLaneError] = useState<string | null>(null);
  // After a menu/shortcut move the lane's DOM node is re-inserted, which drops focus; put it back on that
  // lane's ⋯ button so a keyboard user can keep pressing Alt+→.
  const [refocusLane, setRefocusLane] = useState<string | null>(null);
  type BoardData = NonNullable<typeof board.data>;
  const reorder = useMutation({
    meta: { inlineError: true }, // surfaced beside the board, never a blocking alert
    mutationFn: (keys: string[]) => api.reorderProjectColumns(projectId, keys),
    onMutate: async (keys) => {
      await qc.cancelQueries({ queryKey: ["board", projectId] });
      const snapshot = qc.getQueriesData<BoardData>({ queryKey: ["board", projectId] });
      qc.setQueriesData<BoardData>({ queryKey: ["board", projectId] }, (old) => {
        if (!old) return old;
        const byKey = new Map(old.columns.map((c) => [c.key, c]));
        const next = keys.map((k) => byKey.get(k)).filter((c): c is KanbanColumn => !!c);
        return next.length === old.columns.length ? { ...old, columns: next } : old;
      });
      setLaneError(null);
      return { snapshot };
    },
    onError: (err, _keys, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      setLaneError(errorText(err));
      setAnnouncement(`Lane not moved: ${errorText(err)}`);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["board", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const moveLane = (key: string, toIndex: number, refocus: boolean) => {
    const cols = board.data?.columns ?? [];
    const keys = movedKeys(cols, key, toIndex);
    if (!keys) return;
    const label = cols.find((c) => c.key === key)?.label ?? key;
    setAnnouncement(`${label} moved to position ${keys.indexOf(key) + 1} of ${keys.length}`);
    if (refocus) setRefocusLane(key);
    reorder.mutate(keys);
  };
  const setCollapsed = (col: KanbanColumn, on: boolean) => {
    setLaneCollapsed(col.key, on);
    setAnnouncement(`${col.label} lane ${on ? "collapsed" : "expanded"}`);
    // Focus follows the control that replaced the one just used, scoped to THIS board (a hidden tab can
    // mount a second one).
    requestAnimationFrame(() => {
      const sel = on ? `[data-lane-expand="${CSS.escape(col.key)}"]` : `[data-lane-more="${CSS.escape(col.key)}"]`;
      rootRef.current?.querySelector<HTMLElement>(sel)?.focus();
    });
  };
  useEffect(() => {
    if (!refocusLane) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-lane-more="${CSS.escape(refocusLane)}"]`)?.focus();
    setRefocusLane(null);
  }, [refocusLane, board.data?.columns]);

  // Which lane is being dragged, and which lane it is over — drives the drag preview, the insertion edge
  // on the target lane, and the "Release to place…" hint. Card drags leave both null.
  const [dragLane, setDragLane] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);
  // The card being dragged (card 68800f89): drives its DragOverlay preview and the insertion line in the
  // lane it is over. `overLane` is shared with the lane drag — only one drag runs at a time.
  const [dragCard, setDragCard] = useState<string | null>(null);
  const dataOf = (d: { data: { current?: unknown } } | null | undefined) => d?.data.current as BoardDragData | undefined;
  const onDragStart = (e: DragStartEvent) => {
    const d = dataOf(e.active);
    if (d?.type === "lane") { setDragLane(d.key); setOverLane(d.key); }
    else { setDragCard(String(e.active.id)); setOverLane(null); }
  };
  const onDragOver = (e: DragOverEvent) => {
    setOverLane(e.over ? String(e.over.id) : null);
  };
  // Card 139cfc3d — a card dragged over its OWN live lane is a reorder. The slot follows the lifted
  // preview's vertical centre against the other cards' midpoints, then clamps into the card's priority
  // band, so the line shows where it will really land; null while the drop would leave it where it is.
  const [reorderSlot, setReorderSlot] = useState<number | null>(null);
  const onDragMove = (e: DragMoveEvent) => {
    const d = dataOf(e.active);
    const rect = e.active.rect.current.translated;
    const task = d?.type === "card" ? allTasks.find((t) => t.id === String(e.active.id)) : undefined;
    const col = task && board.data?.columns.find((c) => c.key === task.columnKey);
    let slot: number | null = null;
    if (task && col && rect && e.over && String(e.over.id) === col.key && !isDoneColumn(col) && !cardReordering) {
      const lane = laneTasks(col);
      const others = lane.filter((t) => t.id !== task.id);
      const els = new Map([...(gridRef.current?.querySelectorAll<HTMLElement>(`[data-lane-key="${CSS.escape(col.key)}"] [data-card-id]`) ?? [])]
        .map((el) => [el.dataset.cardId!, el]));
      const mids = others.map((t) => { const r = els.get(t.id)?.getBoundingClientRect(); return r ? r.top + r.height / 2 : -Infinity; });
      const to = clampSlot(others, prio(task), slotForPointer(mids, rect.top + rect.height / 2));
      slot = to === lane.findIndex((t) => t.id === task.id) ? null : to;
    }
    setReorderSlot((s) => (s === slot ? s : slot));
  };
  const clearLaneDrag = () => { setDragLane(null); setDragCard(null); setOverLane(null); setReorderSlot(null); };
  // A card drags from anywhere on its face with a mouse or pen, once the pointer has travelled 6px — so a
  // plain click (open) and a Ctrl/Shift-click (select) never turn into a drag. Touch drags from the grip
  // only (Card filters by pointerType), so a swipe on a card still scrolls the lane on a phone.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const d = dataOf(e.active);
    const slot = reorderSlot;
    clearLaneDrag();
    if (d?.type === "lane") {
      const cols = board.data?.columns ?? [];
      const to = e.over ? cols.findIndex((c) => c.key === String(e.over!.id)) : -1;
      if (to >= 0) moveLane(d.key, to, false);
      return;
    }
    if (!e.over) return;
    const task = allTasks.find((t) => t.id === String(e.active.id));
    // Dropped back on its own lane: a reorder when the line showed a new slot, else nothing at all. (A
    // same-lane columnKey write used to go out here, which only stamped updatedAt — and in the done lane,
    // which sorts by it, jumped the card to the top.)
    if (task && task.columnKey === String(e.over.id)) {
      if (slot !== null) reorderCardTo(task, slot);
      return;
    }
    move.mutate({ id: String(e.active.id), columnKey: String(e.over.id) });
  };
  // Screen-reader narration for the drag itself, in lane LABELS and card TITLES rather than dnd-kit's
  // default raw ids ("Picked up draggable item lane:in_progress").
  const dragName = (id: string | number) => {
    const s = String(id);
    const cols = board.data?.columns ?? [];
    if (s.startsWith("lane:")) return `lane ${cols.find((c) => `lane:${c.key}` === s)?.label ?? s.slice(5)}`;
    return `card ${board.data?.tasks.find((t) => t.id === s)?.title ?? s.slice(0, 8)}`;
  };
  const laneName = (id: string | number) => board.data?.columns.find((c) => c.key === String(id))?.label ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${dragName(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${dragName(active.id)} is over the ${laneName(over.id)} lane.` : `${dragName(active.id)} is not over a lane.`),
    onDragEnd: ({ active, over }) => (over ? `${dragName(active.id)} dropped on the ${laneName(over.id)} lane.` : `${dragName(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${dragName(active.id)} was cancelled.`,
  };

  // Deep-link into a specific card's drawer via `?task=<id>` — used by a Request's reverse "linked task"
  // chip (components/requests → RequestDetail). Consumed once the target card is present in the loaded
  // board, then the param is cleared so a later close/reopen doesn't re-open it. A dangling id (deleted
  // card) never resolves and simply leaves the board as-is — the soft link tolerates it.
  const [searchParams, setSearchParams] = useSearchParams();
  const taskParam = searchParams.get("task");
  useEffect(() => {
    if (!deepLinks || !taskParam || !board.data) return;
    if (board.data.tasks.some((t) => t.id === taskParam)) setOpenTaskId(taskParam);
    setSearchParams((p) => { p.delete("task"); return p; }, { replace: true });
  }, [deepLinks, taskParam, board.data, setSearchParams]);

  // `?lane=<key>` (card 006ed11f, audit G-07) — the Overview's lane legend lands here. Scroll that lane
  // into view and mark it briefly so the eye finds it among seven, then clear the param exactly as
  // `?task=` is cleared. Same `deepLinks` gate, for the same reason: a hidden board must not eat it.
  // An unknown key (a lane renamed away) clears the param and leaves the board where it is.
  const laneParam = searchParams.get("lane");
  useEffect(() => {
    if (!deepLinks || !laneParam || !board.data) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-lane-key="${CSS.escape(laneParam)}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest", inline: "start" });
      // No effect cleanup removes this: clearing the param below re-runs the effect at once, and a
      // cleanup would wipe the mark before anyone saw it. A timer on a detached node is harmless.
      el.dataset.laneFlash = "";
      setTimeout(() => { delete el.dataset.laneFlash; }, 1600);
    }
    setSearchParams((p) => { p.delete("lane"); return p; }, { replace: true });
  }, [deepLinks, laneParam, board.data, setSearchParams]);

  const openTask = board.data?.tasks.find((t) => t.id === openTaskId) ?? null;
  // The open card's resolved lane, for the modal header's state/lane chip (dossier header).
  const openColumn = openTask ? board.data?.columns.find((c) => c.key === openTask.columnKey) ?? null : null;
  // The board list omits a DONE card's body (card 4fa2c146) — `openTask.body` is only ever undefined for
  // one of those, since a LIVE card's body rides along on the board response already. That distinction
  // still governs whether the drawer can open INSTANTLY (`drawerTask` below), but the fetch itself is now
  // unconditional: parent/children/relations (card 1ae4f88c) live ONLY on the single-task read — the board
  // list deliberately carries counts, not relation arrays — so a live card needs this round trip too. It
  // costs one request per drawer open and does NOT delay the open; the links block fills in when it lands.
  // Polled at the board's own interval so a relation written by an agent while the drawer sits open shows up.
  const needsBodyFetch = !!openTask && openTask.body === undefined;
  const taskDetail = useQuery({
    queryKey: ["task", openTask?.id],
    queryFn: ({ signal }) => api.getTask(openTask!.id, signal),
    enabled: !!openTask,
    refetchInterval: 4000,
    // retry:false (matches Git.tsx/mergeGate.tsx/platformHome's own expected-error reads): fail FAST into
    // TaskDrawerError / the "links unavailable" line below rather than leaving TaskDrawerLoading spinning
    // through react-query's default 3-attempt backoff first. NOT because every failure here is permanent:
    // 404/403/401 are (a card deleted under us, or a remote bind with no Tier-1 route for this read), but
    // remotely a 429 or a dropped connection is transient. The `refetchInterval` above is what covers
    // those — the poll keeps running in the error state, so a transient failure self-heals on the next
    // tick without burning the open-drawer moment on a silent backoff the user can neither see nor skip.
    retry: false,
    // NO keepPreviousData here, unlike the board query above: this key changes when a links-block click
    // opens a DIFFERENT card, and carrying the previous card's row across that change would render the
    // OLD card's relations (and, for a done card, its whole body) under the NEW card's header for a beat.
    // A same-key refetch already keeps its data while re-fetching, so nothing flickers on the 4s poll.
  });
  // Belt-and-braces on the same hazard: only trust the detail row when it IS this card's. A cache hand-off
  // mid-transition can otherwise surface the wrong row for one render.
  const detail = taskDetail.data && openTask && taskDetail.data.id === openTask.id ? taskDetail.data : null;
  const drawerTask: Task | null = !openTask ? null : needsBodyFetch ? detail : (openTask as Task);
  // A DONE card's body never rode along on the board response (card 4fa2c146), so when its lazy fetch
  // above fails outright (e.g. a remote bind with no Tier-1 route for it — card 3485a489), `detail` stays
  // null forever and the drawer would otherwise spin on TaskDrawerLoading indefinitely with no way out
  // but Escape/click-outside. Only gates on the needsBodyFetch path — a live card already has its row from
  // the board response and renders the real drawer regardless of this fetch's outcome.
  const drawerError = needsBodyFetch && !drawerTask && taskDetail.isError;

  const allTasks = board.data?.tasks ?? [];
  const draggedTask = dragCard ? allTasks.find((t) => t.id === dragCard) ?? null : null;
  // Hierarchy lookups (card 1ae4f88c), both built off the UNFILTERED list on purpose:
  //  · titleById resolves a card's `parentId` to a title for its board-card chip. The board response
  //    carries every task in the project, so the parent is normally right here — no extra request, and
  //    no need for the board row to ship a parent title. Resolving against the FILTERED list instead
  //    would blank the parent chip the moment a search hid the parent card, which is exactly when the
  //    context matters most.
  //  · the same map tells the drawer's links block which targets it can actually OPEN (a relation can
  //    point at an archived card, and a link that silently does nothing is worse than a plain-text one)
  //    and backs the Parent field's id/prefix resolution.
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of allTasks) m.set(t.id, t.title);
    return m;
  }, [allTasks]);
  //  · the drawer's relation picker (card 03d9db6e) needs a lane as well as a title, so it gets its own
  //    projection rather than a second map. Built off the UNFILTERED list for the same reason as
  //    titleById above: a card hidden by the board's search filter is still a legitimate link target,
  //    and "relations are same-project only" is the daemon's rule — not "relations are visible-only".
  const pickerCards = useMemo<PickerCard[]>(
    () => allTasks.map((t) => ({ id: t.id, title: t.title, columnKey: t.columnKey })),
    [allTasks],
  );
  // ── Card-detail filter inputs (card cea577af) ──────────────────────────────────
  // Pending Requests come from the SAME app-wide key the sidebar badge already polls, so this is a cache
  // read, not a new request per board.
  const openQuestions = useQuery({ queryKey: ["openQuestions"], queryFn: ({ signal }) => api.openQuestions(false, signal) });
  const facets = useMemo(() => {
    const ids = allTasks.map((t) => t.id);
    const parentOf = new Map(allTasks.map((t) => [t.id, t.parentId]));
    const typeOf = new Map(allTasks.map((t) => [t.id, commitType(t.title)]));
    const ctx: StateContext = {
      policyBlocking: (id) => policyByTask[id]?.blocking ?? 0,
      pendingRequest: pendingRequestTaskIds(openQuestions.data ?? [], projectId, ids),
    };
    const under = descendantCounts(allTasks);
    const epics = allTasks.filter((t) => (under.get(t.id) ?? 0) > 0)
      .map((t) => ({ id: t.id, title: t.title, count: under.get(t.id) ?? 0 }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return { parentOf, typeOf, ctx, epics };
  }, [allTasks, policyByTask, openQuestions.data, projectId]);
  const matchesDetails = (t: BoardTask) =>
    (typeFilter.size === 0 || typeFilter.has(facets.typeOf.get(t.id) ?? OTHER_TYPE)) &&
    (stateFilter.size === 0 || [...stateFilter].some((s) => hasState(t, s, facets.ctx))) &&
    (epicFilter === null || isUnderEpic(t, epicFilter, facets.parentOf)) &&
    (repoFilter === null || (t.repoKey ?? "") === repoFilter);
  const shownTasks = allTasks.filter((t) =>
    taskMatchesSearch(t, q) &&
    (priFilter.size === 0 || priFilter.has(prio(t))) &&
    matchesDetails(t));
  // A lane's cards as rendered: filtered, then in the lane's own order.
  const laneTasks = (col: KanbanColumn) => shownTasks.filter((t) => t.columnKey === col.key)
    .sort(isDoneColumn(col) ? byRecentlyDone : byPriorityThenPosition);

  // ── Within-lane reorder (card 139cfc3d) ──────────────────────────────────────
  // The writes go out ONE AT A TIME, in band order. The new order is painted optimistically; if any write
  // fails, the board refetches and shows what the server actually holds, with the error beside it — a
  // half-renumbered band is never left on screen looking saved.
  const [cardOrderError, setCardOrderError] = useState<string | null>(null);
  const reorderCards = useMutation({
    mutationKey: cardReorderKey,
    meta: { inlineError: true }, // surfaced beside the board, never a blocking alert
    mutationFn: async ({ writes }: { writes: { id: string; position: number }[]; label: string }) => {
      for (const w of writes) await api.updateTask(w.id, { position: w.position });
    },
    onMutate: async ({ writes }) => {
      await qc.cancelQueries({ queryKey: ["board", projectId] });
      const next = new Map(writes.map((w) => [w.id, w.position]));
      qc.setQueriesData<BoardData>({ queryKey: ["board", projectId] }, (old) => old && {
        ...old, tasks: old.tasks.map((t) => (next.has(t.id) ? { ...t, position: next.get(t.id)! } : t)),
      });
      setCardOrderError(null);
    },
    onError: (err, { label }) => {
      setCardOrderError(errorText(err));
      setAnnouncement(`${label} not reordered: ${errorText(err)}. Showing the saved order.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  /** Move `task` to `slot` (counted with the card itself removed) within its lane, and say so. Returns
   *  false when nothing moved. */
  const reorderCardTo = (task: BoardTask, slot: number): boolean => {
    const col = board.data?.columns.find((c) => c.key === task.columnKey);
    if (!col || isDoneColumn(col) || reorderCards.isPending) return false;
    const lane = laneTasks(col);
    const fullBand = allTasks.filter((t) => t.columnKey === col.key && prio(t) === prio(task));
    const plan = planReorder(lane, task.id, slot, fullBand);
    if (!plan || plan.writes.length === 0) return false;
    const [start, end] = bandSlots(lane.filter((t) => t.id !== task.id), prio(task));
    const label = task.title;
    setAnnouncement(`${label} moved to ${plan.slot - start + 1} of ${end - start + 1} in ${PRIORITY_META[prio(task)].short}, ${col.label}`);
    reorderCards.mutate({ writes: plan.writes, label });
    return true;
  };
  // Where the reorder line sits in `col`'s rendered list (the index of the card it sits above, or the
  // list's length for "last"), or -1 when this lane is not the target of a reorder drag.
  const reorderIndexFor = (col: KanbanColumn) => {
    if (reorderSlot === null || !draggedTask || draggedTask.columnKey !== col.key) return -1;
    const lane = laneTasks(col);
    const next = lane.filter((t) => t.id !== draggedTask.id)[reorderSlot];
    return next ? lane.indexOf(next) : lane.length;
  };
  // Chip counts, over the whole fetched board (not the filtered view), so a chip's number never moves
  // as other chips toggle.
  const counts = useMemo(() => {
    const pri = new Map<string, number>(); const type = new Map<string, number>(); const state = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const t of allTasks) {
      bump(pri, prio(t));
      bump(type, facets.typeOf.get(t.id) ?? OTHER_TYPE);
      for (const s of CARD_STATES) if (hasState(t, s.key, facets.ctx)) bump(state, s.key);
    }
    return { pri, type, state };
  }, [allTasks, facets]);
  // An epic picked before it lost its children (or was deleted) must stay visible in the picker, or the
  // board would be filtered by a value no control shows.
  const epicOptions = epicFilter && !facets.epics.some((e) => e.id === epicFilter)
    ? [...facets.epics, { id: epicFilter, title: titleById.get(epicFilter) ?? epicFilter.slice(0, 8), count: 0 }]
    : facets.epics;

  // ── Reading a windowed response (card a483cbec) ──────────────────────────────
  // WHICH lane the server windowed is resolved by the DAEMON'S OWN resolver, never by this board's
  // `isDoneColumn` (role, else a key-substring guess). On a legacy role-less board the two genuinely
  // disagree — `columnKeyForRole` falls back to the LAST column, `isDoneColumn` to a name guess — and
  // attributing one lane's window and total to a different lane is worse than not windowing at all.
  // Gated on `!filterActive` too, so the brief moment a stale windowed response is still on screen
  // after a filter goes on reads its counts off the rendered set rather than a total it no longer spans.
  const windowedTotal = filterActive ? undefined : board.data?.doneTotal;
  const windowedLaneKey = windowedTotal === undefined ? undefined : columnKeyForRole(board.data?.columns ?? [], "terminal");
  const laneTotalFor = (col: KanbanColumn) => (col.key === windowedLaneKey ? windowedTotal : undefined);
  // The done cards the window left on the server. Added back into the FilterBar's "N of M shown"
  // readout, which is about the FILTER, not about what the lane renders — so it must keep counting the
  // whole board (exactly as it did under 7da27eb5's render-only cap), never just what was fetched.
  const unfetchedDone = windowedTotal === undefined ? 0
    : windowedTotal - allTasks.filter((t) => t.columnKey === windowedLaneKey).length;

  // ── Keyboard focus (card 591fe6ed) ───────────────────────────────────────────
  // The ONE place the board's focus position lives (see lib/boardFocus.ts). Set from whatever the user
  // focuses (keyboard or pointer) via the grid's delegated onFocus, so the Tab stop is always the last
  // item they were on. Resolved against the live board here: a card that moved lane (the dialog's "Move to
  // lane", another process) is followed to its new lane; a lane that no longer exists falls back to the
  // first lane's default.
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusPos, setFocusPos] = useState<BoardFocus | null>(null);
  // True while a nav item holds focus, and still true if that item is then removed from the DOM (React
  // removing a focused node drops focus to <body>). That is the case `repairIfLost` puts right.
  const navHadFocus = useRef(false);
  const [navHint, setNavHint] = useState(false);
  // True from a pointer press in the grid until the next key press anywhere. :focus-visible alone is not
  // enough to tell a keyboard entry: a Ctrl/⌘+click selection holds a key, so Chromium marks it visible.
  const pointerEntry = useRef(false);
  useEffect(() => {
    const onKey = () => { pointerEntry.current = false; };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const columnKeys = board.data?.columns.map((c) => c.key) ?? [];
  let navLane: string | null = null;
  let navItem: string | null = focusPos?.item ?? null;
  const navIndex = focusPos?.index ?? 0;
  if (focusPos) {
    const followed = shownTasks.find((t) => t.id === focusPos.item)?.columnKey;
    navLane = followed && columnKeys.includes(followed) ? followed
      : columnKeys.includes(focusPos.lane) ? focusPos.lane : null;
  }
  if (navLane === null) { navLane = columnKeys[0] ?? null; navItem = null; }
  const focusStop = () => gridRef.current?.querySelector<HTMLElement>("[data-board-nav][tabindex='0']")?.focus();
  const repairIfLost = () => {
    if (!navHadFocus.current) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body) return;
    focusStop();
  };
  // ── Multi-select (card 19074e42) ─────────────────────────────────────────────
  // The selection is a set of card ids; its range ANCHOR is the board's one focus position above, never a
  // second one (591fe6ed's record). A selection press (Ctrl/⌘/Shift + click) suppresses the mousedown's
  // focus move, so `focusPos` is still the previous card when the click is read, then focuses the clicked
  // card itself so it becomes the next anchor.
  //
  // @decision 19074e42 — the anchor is BoardFocus; the selection is only ever a subset of rendered cards.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const clearSelection = () => setSelected((s) => (s.size ? new Set() : s));
  const focusCard = (id: string) => requestAnimationFrame(() => {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-board-nav="${CSS.escape(id)}"]`);
    el?.focus();
  });
  const press: BoardNav["press"] = (id, { ctrlKey, metaKey, shiftKey }) => {
    if (!ctrlKey && !metaKey && !shiftKey) return false;
    const grid = gridRef.current;
    const lane = grid?.querySelector<HTMLElement>(`[data-board-nav="${CSS.escape(id)}"]`)?.closest<HTMLElement>("[data-lane-key]")?.dataset.laneKey;
    if (!grid || !lane) return false;
    if (shiftKey) {
      const range = focusPos ? laneRange(readNavLanes(grid), lane, focusPos.item, id) : [];
      setSelected((s) => new Set([...s, ...(range.length ? range : [id])]));
    } else {
      setSelected((s) => { const n = new Set(s); n.delete(id) || n.add(id); return n; });
    }
    focusCard(id);
    return true;
  };
  // Whatever is no longer RENDERED leaves the selection: a filter hid it, its lane collapsed, the done cap
  // or window dropped it, the poll found it deleted. A card that only changed lane is still rendered, so it
  // stays selected. Runs after every board and lane render (Column calls it too, like repairIfLost).
  const pruneSelection = () => {
    if (!gridRef.current || selected.size === 0) return;
    const shown = renderedCards(readNavLanes(gridRef.current));
    if ([...selected].some((id) => !shown.has(id))) setSelected((s) => new Set([...s].filter((id) => shown.has(id))));
  };
  const nav: BoardNav = { lane: navLane, item: navItem, index: navIndex, repairIfLost, selected, press, pruneSelection };
  useEffect(() => { repairIfLost(); pruneSelection(); });
  // Escape clears the selection from anywhere on the page, except while a field, a dialog or a menu owns
  // the key (the same rule as `n`). The bulk bar's own controls are the exception: they act on the
  // selection, so Escape there clears it too. Every board clears only its own selection. Clearing from the
  // bar unmounts the control that held focus, so focus goes back to the board's Tab stop.
  const clearSelectionFrom = (from: EventTarget | null) => {
    const inBar = from instanceof HTMLElement && !!from.closest("[data-board-bulk-bar]");
    clearSelection();
    if (inBar) requestAnimationFrame(() => focusStop());
  };
  const clearRef = useRef(clearSelectionFrom);
  clearRef.current = clearSelectionFrom;
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const inBar = e.target instanceof HTMLElement && !!e.target.closest("[data-board-bulk-bar]");
      if (inBar || !shortcutBlocked(e)) clearRef.current(e.target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // A bulk action: one PATCH per selected card through api.updateTask, all settled before anything is
  // reported. A card already in the target state is skipped rather than rewritten. The cards that FAILED
  // stay selected (so a retry is one click) and are named with the server's reason; a fully successful
  // action keeps the selection so a second action can follow (move, then set priority).
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const runBulk = async (verb: string, patch: TaskUpdatePatch, unchanged: (t: BoardTask) => boolean) => {
    const targets = allTasks.filter((t) => selected.has(t.id));
    const todo = targets.filter((t) => !unchanged(t));
    setBulkPending(verb);
    setBulkResult(null);
    const settled = await Promise.allSettled(todo.map((t) => api.updateTask(t.id, patch).then((r) => {
      if (r && r.ok === false) throw new Error("the server did not apply the change");
    })));
    const failed = todo.flatMap((t, i) => {
      const r = settled[i]!;
      return r.status === "rejected" ? [{ id: t.id, title: t.title, error: errorText(r.reason) }] : [];
    });
    const result: BulkResult = { verb, updated: todo.length - failed.length, skipped: targets.length - todo.length, failed };
    setBulkPending(null);
    setBulkResult(result);
    if (failed.length) setSelected(new Set(failed.map((f) => f.id)));
    setAnnouncement(bulkSummary(result));
    await qc.invalidateQueries({ queryKey: ["board", projectId] });
    for (const t of todo) qc.invalidateQueries({ queryKey: ["task", t.id] });
  };
  // Closing the card dialog: useDialogFocus hands focus back to the opener, but when that card has left
  // the DOM meanwhile (moved lane from the dialog, deleted) focus would land on <body>. Put it on the
  // Tab stop instead, which `navLane` has already moved to follow the card.
  const prevOpen = useRef<string | null>(null);
  useEffect(() => {
    const was = prevOpen.current;
    prevOpen.current = openTaskId;
    if (!was || openTaskId) return;
    requestAnimationFrame(() => {
      const ae = document.activeElement;
      if (!ae || ae === document.body) focusStop();
    });
  }, [openTaskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onGridFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-board-nav]");
    const lane = el?.closest<HTMLElement>("[data-lane-key]")?.dataset.laneKey;
    if (!el || !lane) return;
    navHadFocus.current = true;
    // The one-time "how do I move in here" hint (card 78eaac95), on keyboard entry only: a pointer user
    // clicked the card they wanted and needs no telling.
    if (!navHint && !pointerEntry.current && el.matches(":focus-visible") && takeNavHint()) setNavHint(true);
    const item = el.dataset.boardNav!;
    const items = [...el.closest("[data-lane-key]")!.querySelectorAll<HTMLElement>("[data-board-nav]")];
    const index = items.indexOf(el);
    setFocusPos((p) => (p && p.lane === lane && p.item === item && p.index === index ? p : { lane, item, index }));
  };
  const onGridBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    requestAnimationFrame(() => {
      if (gridRef.current?.contains(document.activeElement)) return;
      setNavHint(false);
      // Still in the DOM and still focusable ⇒ the user moved focus elsewhere on purpose. Removed, or
      // just disabled (a windowed "Show more" while its page loads) ⇒ keep the flag so the next render
      // can put focus back.
      if (el.isConnected && !el.matches(":disabled")) navHadFocus.current = false;
      else repairIfLost();
    });
  };
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Alt+↑/↓ on a focused card moves it one slot within its priority band (card 139cfc3d) — the keyboard
    // twin of a within-lane drag. Focus stays on the card; the live region says where it went, or that
    // it is already at its band's edge. Not offered in the done lane, which sorts by recency.
    if (!e.defaultPrevented && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const id = (e.target as HTMLElement).dataset?.boardNav;
      const task = id && id !== NAV_HEAD && id !== NAV_MORE ? allTasks.find((t) => t.id === id) : undefined;
      const col = task && board.data?.columns.find((c) => c.key === task.columnKey);
      if (!task || !col || isDoneColumn(col)) return;
      e.preventDefault();
      if (reorderCards.isPending) return;
      const from = laneTasks(col).findIndex((t) => t.id === task.id);
      if (!reorderCardTo(task, from + (e.key === "ArrowUp" ? -1 : 1))) {
        setAnnouncement(`${task.title} is already ${e.key === "ArrowUp" ? "first" : "last"} of the ${PRIORITY_META[prio(task)].short} cards in ${col.label}`);
        return;
      }
      requestAnimationFrame(() => { if (gridRef.current) navElement(gridRef.current, col.key, task.id)?.focus(); });
      return;
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target as HTMLElement;
    const item = el.dataset?.boardNav;
    const lane = el.closest<HTMLElement>("[data-lane-key]")?.dataset.laneKey;
    if (!item || !lane || !gridRef.current) return;
    // Tab out of the grid (card 78eaac95). With nothing tabbable after the grid the browser drops focus on
    // <body>; hand it to the page's first stop instead. Otherwise the browser's own Tab is already right.
    if (e.key === "Tab") {
      const wrap = e.shiftKey ? null : tabOutWrapTarget(gridRef.current);
      if (wrap) { e.preventDefault(); wrap.focus(); }
      return;
    }
    const isCard = item !== NAV_HEAD && item !== NAV_MORE;
    // Selection keys (card 19074e42): `x` toggles the focused card; Shift+↑/↓ extends the selection to the
    // neighbouring card in the same lane and moves there. Both act on cards only, never a header.
    if (!e.shiftKey && e.key.toLowerCase() === SELECT_KEY) {
      if (!isCard) return;
      e.preventDefault();
      setSelected((s) => { const n = new Set(s); n.delete(item) || n.add(item); return n; });
      return;
    }
    if (e.shiftKey) {
      if (!isCard || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const to = navTarget(readNavLanes(gridRef.current), { lane, item }, e.key);
      if (!to || to.lane !== lane || to.item === NAV_HEAD || to.item === NAV_MORE) return;
      setSelected((s) => new Set([...s, item, to.item]));
      navElement(gridRef.current, to.lane, to.item)?.focus();
      return;
    }
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    const to = navTarget(readNavLanes(gridRef.current), { lane, item }, e.key as NavKey);
    if (to) navElement(gridRef.current, to.lane, to.item)?.focus();
  };
  // The new-card shortcut: `n` focuses this board's "new task title" field. Owned by the component (the
  // shortcut record a1c6e339: never re-wired per surface). Only the first VISIBLE board in the document
  // answers, so a second mount parked behind a hidden tab never steals it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== NEW_CARD_KEY || shortcutBlocked(e)) return;
      const mine = rootRef.current?.querySelector<HTMLInputElement>("[data-board-new-task]");
      if (!mine || !mine.getClientRects().length) return;
      const first = [...document.querySelectorAll<HTMLElement>("[data-board-new-task]")].find((el) => el.getClientRects().length);
      if (first !== mine) return;
      e.preventDefault();
      mine.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Re-subscribed whenever the set of lanes or their collapse changes (new lane elements to observe).
  const laneEdges = useLaneOverflow(gridRef,
    board.data ? `${columnKeys.join(",")}|${[...collapsedLanes].sort().join(",")}` : "");
  const laneOverflowing = laneEdges.before.length > 0 || laneEdges.after.length > 0;
  const showLaneRow = laneOverflowing || navHint;

  return (
    <div ref={rootRef}>
      {/* Polite narration of lane moves / collapses (the visible change is the lane itself). */}
      <div aria-live="polite" role="status" data-testid="lane-announcer"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {announcement}
      </div>
      {!projectId && <p style={{ color: color.text3 }}>No project selected.</p>}
      {/* First-load placeholder: lane shells so the layout settles in, not a blank flash. keepPreviousData
          keeps this from re-appearing on the 4s refetch — it shows only before the very first response. */}
      {projectId && !board.data && board.isLoading && <BoardSkeleton />}
      {/* First-load failure (retries under the hood): a calm line rather than a permanently empty page. */}
      {projectId && !board.data && board.isError && (
        <div style={{ marginTop: 10, color: color.danger, fontSize: fs.sm }}>
          couldn’t load the board — retrying…
        </div>
      )}
      {projectId && board.data && (
        <>
          {/* `mutateAsync`, not `mutate`: NewTask has to AWAIT the create to know whether clearing the
              typed title is safe (card a1ec70a6). It still surfaces the failure inline via create.error. */}
          <NewTask repos={repos} onCreate={(title, repoKey) => create.mutateAsync({ title, repoKey })}
            error={create.error ? errorText(create.error) : null} />
          {/* An empty board has nothing to filter (card c315f579): the bar, with every chip at zero, only
              pushed the lanes down. It comes back with the first card. A filter still ON (a search typed
              before the last card went) keeps it, so the active filter is never left without a control. */}
          {(allTasks.length + unfetchedDone > 0 || filterActive) && <FilterBar search={search} onSearch={setSearch} counts={counts}
            priFilter={priFilter} onTogglePri={togglePri}
            types={sortTypes(counts.type.keys())} typeFilter={typeFilter} onToggleType={toggleType}
            stateFilter={stateFilter} onToggleState={toggleState}
            epics={epicOptions} epicFilter={epicFilter} onEpic={setEpicFilter}
            repos={multiRepo ? repos : null} repoFilter={repoFilter} onRepo={setRepoFilter}
            shown={shownTasks.length + unfetchedDone} total={allTasks.length + unfetchedDone}
            active={filterActive} onClear={clearFilters} />}
          {/* A failed policy-status read must not look like "nothing is blocking": say so, quietly (404 stays null = no badges). */}
          {policyStatus.isError && (
            <div data-testid="card-policy-status-unavailable" title="The unmet-requirement badges could not be loaded; open a card to see its policy."
              style={{ marginTop: 10, color: color.text3, fontSize: fs.sm }}>
              card policy status unavailable
            </div>
          )}
          {laneError && (
            <div role="alert" data-testid="lane-reorder-error"
              style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, color: color.attnText, fontSize: fs.sm }}>
              <span style={{ flex: 1 }}>Couldn’t move the lane: {laneError}</span>
              <Button variant="ghost" onClick={() => setLaneError(null)}>Dismiss</Button>
            </div>
          )}
          {cardOrderError && (
            <div role="alert" data-testid="card-reorder-error"
              style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, color: color.attnText, fontSize: fs.sm }}>
              <span style={{ flex: 1 }}>Couldn’t save the new card order: {cardOrderError}. The board shows the saved order.</span>
              <Button variant="ghost" onClick={() => setCardOrderError(null)}>Dismiss</Button>
            </div>
          )}
          {/* Lanes behind an edge (card c315f579): a row of its own, only while some lane is cut off. */}
          {/* The one-time keyboard hint (card 78eaac95) borrows this row's left side: above the grid, so it
              never covers the focused card, and in the row the overflow chips already use, so it never
              covers the filters. With every lane in view the row comes up for the hint alone. */}
          {showLaneRow && (
            <div className="loom-lane-more-row" data-testid={laneOverflowing ? "lane-overflow-row" : undefined}>
              {navHint && <BoardNavHint />}
              <LaneOverflowChip side="before" keys={laneEdges.before} columns={board.data.columns} gridRef={gridRef} />
              <span style={{ flex: 1 }} />
              <LaneOverflowChip side="after" keys={laneEdges.after} columns={board.data.columns} gridRef={gridRef} />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: showLaneRow ? 6 : 10, alignItems: "stretch" }}>
            <DndContext onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={clearLaneDrag}
              sensors={sensors} collisionDetection={boardCollision} accessibility={{ announcements }}>
              {/* Responsive lane grid (.loom-board-grid): equal 1fr lanes when they fit, horizontal
                  scroll with a usable per-lane min width when they don't (narrow viewport / many lanes)
                  — so the board degrades gracefully instead of crushing every lane. A collapsed lane
                  takes a fixed slim track; the inline template is set only then, so an all-expanded
                  board keeps the stylesheet's auto tracks untouched. */}
              <BoardNavContext.Provider value={nav}>
              <div className="loom-board-grid" ref={gridRef} onFocus={onGridFocus} onBlur={onGridBlur} onKeyDown={onGridKey}
                onPointerDownCapture={() => { pointerEntry.current = true; }}
                data-more-left={laneEdges.before.length > 0 ? "true" : undefined}
                data-more-right={laneEdges.after.length > 0 ? "true" : undefined}
                style={board.data.columns.some((c) => collapsedLanes.has(c.key))
                  ? { gridTemplateColumns: board.data.columns.map((c) => (collapsedLanes.has(c.key) ? "44px" : "minmax(var(--loom-lane-min), 1fr)")).join(" ") }
                  : undefined}>
                {board.data.columns.map((col, colIndex) => (
                  // The project id rides in the key ON PURPOSE (card 7da27eb5): it keeps Column's
                  // done-lane reveal state alive across the 4s poll (same key ⇒ re-render, not remount)
                  // while a project switch remounts the lane and collapses it back to one page.
                  <Column key={`${projectId}:${col.key}`} col={col}
                    tasks={laneTasks(col)}
                    reorderIndex={reorderIndexFor(col)}
                    filterActive={filterActive} workers={workerByTask} policyByTask={policyByTask} onOpen={setOpenTaskId}
                    multiRepo={multiRepo} repos={repos} primaryRepoPath={project?.repoPath ?? ""}
                    titleById={titleById}
                    // The server's TRUE lane length on a windowed response, else undefined. It is what
                    // both the header count and the soft-WIP readout must read — `tasks`/`cardCount`
                    // only span what was FETCHED, so on a windowed lane both would read the window.
                    laneTotal={laneTotalFor(col)}
                    onRevealMore={() => setDoneWindow((n) => n + DONE_LANE_PAGE)}
                    revealPending={windowPending}
                    cardCount={allTasks.filter((t) => t.columnKey === col.key).length}
                    index={colIndex} laneCount={board.data!.columns.length}
                    collapsed={collapsedLanes.has(col.key)} onCollapse={(on) => setCollapsed(col, on)}
                    onMoveLane={(to) => moveLane(col.key, to, true)} reordering={reorder.isPending}
                    laneDragging={dragLane === col.key}
                    dropCard={draggedTask && overLane === col.key && draggedTask.columnKey !== col.key ? draggedTask : null}
                    dropEdge={dragLane && overLane === col.key && overLane !== dragLane
                      ? (board.data!.columns.findIndex((c) => c.key === dragLane) > colIndex ? "before" : "after")
                      : null} />
                ))}
              </div>
              </BoardNavContext.Provider>
              {/* The lifted lane's preview: its header only, so it reads as "this lane" without dragging a
                  4,000-card list across the screen. No drop animation: the lane snaps into its new slot.
                  A lifted CARD gets its own preview (card 68800f89): the overlay renders above every lane's
                  scroll container, so the card follows the pointer instead of clipping inside its lane. */}
              <DragOverlay dropAnimation={null}>
                {dragLane ? <LaneDragPreview col={board.data.columns.find((c) => c.key === dragLane)} />
                  : draggedTask ? <CardDragPreview task={draggedTask} /> : null}
              </DragOverlay>
            </DndContext>
          </div>
          {(selected.size > 0 || bulkResult) && (
            <BulkBar count={selected.size} columns={board.data.columns} pending={bulkPending} result={bulkResult}
              onDismissResult={() => setBulkResult(null)} onClear={(e) => clearSelectionFrom(e.currentTarget)}
              onMove={(col) => runBulk(`moved to ${col.label}`, { columnKey: col.key }, (t) => t.columnKey === col.key)}
              onPriority={(p) => runBulk(`set to ${PRIORITY_META[p].short}`, { priority: p }, (t) => prio(t) === p)}
              onHold={(held) => runBulk(held ? "held" : "released", { held }, (t) => !!t.held === held)} />
          )}
          {dragLane && (
            <div data-testid="lane-drag-hint" aria-hidden
              style={{ marginTop: 8, color: color.text2, fontSize: fs.sm }}>
              {(() => {
                const cols = board.data.columns;
                const from = cols.findIndex((c) => c.key === dragLane);
                const to = overLane ? cols.findIndex((c) => c.key === overLane) : -1;
                const name = cols[from]?.label ?? dragLane;
                if (to < 0 || to === from) return <>Drag over another lane to move <b style={{ color: color.text, fontWeight: 500 }}>{name}</b> · Esc cancels</>;
                return <>Release to place <b style={{ color: color.text, fontWeight: 500 }}>{name}</b> {to < from ? "before" : "after"}{" "}
                  <b style={{ color: color.text, fontWeight: 500 }}>{cols[to]?.label}</b> · Esc cancels</>;
              })()}
            </div>
          )}
        </>
      )}
      {/* A live card's full row already rode along on the board response, so its drawer opens instantly;
          a done card's body is still loading (needsBodyFetch) for the brief window before the lazy
          fetch above resolves — a minimal placeholder rather than rendering the editable form against a
          not-yet-loaded body (which would let an edit race the fetch and clobber unsaved keystrokes). */}
      {openTask && !drawerTask && !drawerError && (
        <TaskDrawerLoading onClose={() => setOpenTaskId(null)} />
      )}
      {openTask && drawerError && (
        <TaskDrawerError onClose={() => setOpenTaskId(null)} onRetry={() => taskDetail.refetch()} />
      )}
      {openTask && drawerTask && (
        <TaskDrawer key={drawerTask.id} task={drawerTask} column={openColumn} onClose={() => setOpenTaskId(null)}
          worker={workerByTask.get(drawerTask.id)}
          repos={repos} primaryRepoPath={project?.repoPath ?? ""}
          trailersOff={commitTrailersOff(project?.config?.orchestration)}
          links={taskLinks(detail)} linksUnavailable={taskDetail.isError && !detail}
          columns={board.data?.columns ?? []} titleById={titleById} cards={pickerCards} onOpenTask={setOpenTaskId}
          onSave={(patch) => edit.mutate({ id: openTask.id, patch })} saving={edit.isPending}
          saved={edit.isSuccess && edit.variables?.id === drawerTask.id}
          saveError={edit.error as TaskUpdateConflictError | null}
          onDismissConflict={() => edit.reset()}
          onMoveLane={(columnKey) => move.mutate({ id: openTask.id, columnKey })}
          moving={move.isPending && move.variables?.id === openTask.id}
          onAddChild={(title) => addChild.mutateAsync({ parentId: openTask.id, title })}
          onDelete={() => del.mutate(openTask.id)} deleting={del.isPending}
          deleteError={del.error ? errorText(del.error) : null} />
      )}
    </div>
  );
}

// ── One source of truth for a board lane's color ──────────────────────────────────
// A lane's ROLE tint is resolved by `columnTone` (theme.ts — shared with the drawer's lane badge and the
// task-link lane chips, so every surface that tints a lane agrees).
//
// The resolved accent COLOR for a lane: an explicit per-column accentColor WINS, then the role tone,
// then null. accentColor-first is what makes the Settings accent picker take effect on the board even
// for role-bearing lanes (f033daeb added the picker; before this it silently lost to the role tone on
// the typical all-role board). A preset's accentColor equals its role color, and the DEFAULT board sets
// no accentColor at all, so default/preset boards look unchanged. A role-less lane with no accent → null
// (transparent bar + neutral label/border). The "muted" role tone resolves to textDim, the stronger of
// the two secondary text tokens, so a muted lane label is never the weakest text on the board.
function columnAccent(col: KanbanColumn): string | null {
  if (col.accentColor) return col.accentColor;
  const t = columnTone(col);
  if (t) return t === "muted" ? color.text2 : tone[t];
  return null;
}

// WCAG-AA guard for the 11px-bold lane LABEL, which must clear 4.5:1 on the panel. The accent bar and
// each card's left border are decorative (no contrast floor) and always use the resolved accent; the
// LABEL uses it ONLY when it clears AA, else falls back to textDim. Only a raw accentColor hex can fail
// — the role tones are var() refs vetted AA-safe by design — so the guard runs the contrast math on hex
// accents alone. The panel differs per theme, and a swatch that clears AA on the dark panel can fail on
// the light one (phosphor #2ee66e is 1.66:1 on white), so the guard compares against the panel of the
// theme IN FORCE. Each hex is --loom-surface (global.css) converted to sRGB; persisted accentColor values
// are owner data and are never rewritten.
const PANEL_HEX: Record<ResolvedTheme, string> = { dark: "#141921", light: "#ffffff" };
function relLuminance(hex: string): number {
  const lin = (i: number): number => {
    const v = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}
function labelColorFor(accent: string | null, theme: ResolvedTheme): string {
  if (!accent) return color.text2;
  if (accent.startsWith("#")) {
    const a = relLuminance(accent) + 0.05;
    const b = relLuminance(PANEL_HEX[theme]) + 0.05;
    const ratio = a > b ? a / b : b / a;
    if (ratio < 4.5) return color.text2;
  }
  return accent;
}

// The lane's identity mark (Graphite): an 8px dot in the lane's resolved accent, beside a name set in
// plain text colour. It replaces the old 3px top bar. A dot is decorative (the name carries the meaning),
// so it takes the raw accent with no contrast floor; an un-accented lane gets the quiet text-3 grey. A
// done lane shows a check mark instead: done is quiet, and green means live only.
function LaneDot({ accent, done = false }: { accent: string | null; done?: boolean }) {
  if (done) return <span aria-hidden data-testid="lane-dot" style={{ width: 10, flexShrink: 0, color: accent ?? color.text3,
    fontSize: fs.sm, lineHeight: 1, textAlign: "center" }}>✓</span>;
  return <span aria-hidden data-testid="lane-dot" style={{ width: 8, height: 8, borderRadius: radius.pill, flexShrink: 0,
    background: accent ?? color.text3 }} />;
}

// The lifted lane's DragOverlay preview — the lane's own header, so the thing under the pointer is
// recognisably the lane being moved.
function LaneDragPreview({ col }: { col: KanbanColumn | undefined }) {
  const theme = useResolvedTheme(); // above the early return: hooks must run on every render
  if (!col) return null;
  const accent = columnAccent(col);
  return (
    <div data-testid="lane-drag-preview"
      style={{ width: 220, background: color.laneBg, border: `1px solid ${color.lineStrong}`, borderRadius: radius.lg,
        boxShadow: shadow.pop, transform: "rotate(-1deg)", cursor: "grabbing" }}>
      <SectionLabel style={{ color: labelColorFor(accent, theme), margin: 0, padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: color.text2 }}>⠿</span>
        <LaneDot accent={accent} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{col.label}</span>
      </SectionLabel>
    </div>
  );
}

function Column({ col, tasks, filterActive, workers, policyByTask, onOpen, multiRepo, repos, primaryRepoPath, titleById, cardCount, laneTotal, onRevealMore, revealPending,
  index, laneCount, collapsed, onCollapse, onMoveLane, reordering, laneDragging, dropEdge, dropCard, reorderIndex }:
  { col: KanbanColumn; tasks: BoardTask[]; filterActive: boolean; workers: Map<string, SessionListItem>;
    policyByTask: Record<string, CardPolicyCardStatus>; onOpen: (id: string) => void; multiRepo: boolean;
    repos: RepoRegistryEntry[]; primaryRepoPath: string; titleById: Map<string, string>; cardCount: number;
    /** Card a483cbec — the server's TRUE lane length when THIS lane came back windowed, else undefined. */
    laneTotal?: number; onRevealMore?: () => void; revealPending?: boolean;
    /** Card 67c43038 — this lane's position, collapse state, and the order/collapse actions. */
    index: number; laneCount: number; collapsed: boolean; onCollapse: (on: boolean) => void;
    onMoveLane: (toIndex: number) => void; reordering: boolean;
    /** This lane is the one being dragged (it stays in place, ghosted, while its preview follows the pointer). */
    laneDragging: boolean;
    /** This lane is the current lane-drag target: the dragged lane lands on this side of it. */
    dropEdge: "before" | "after" | null;
    /** Card 68800f89 — a card from ANOTHER lane is being dragged over this one (else null). */
    dropCard: BoardTask | null;
    /** Card 139cfc3d — this lane's OWN card is being dragged to a new slot: the index of the rendered card
     *  the line sits above (the list's length for "last"), else -1. Never set on the done lane. */
    reorderIndex: number }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: col.key, data: { type: "lane", key: col.key } satisfies BoardDragData });
  // A lane is ALSO draggable, by its header (card 67c43038). Only the header's handle carries the
  // listeners; the ⋯ button sits outside it so a click there never starts a drag.
  // Disabled while a reorder is saving, like the ⋯ menu and Alt+arrows: a second drag on top of a pending
  // reorder would send an order built from the pre-save columns, and the two could briefly flip the board.
  const laneDrag = useDraggable({ id: laneDragId(col.key), data: { type: "lane", key: col.key } satisfies BoardDragData, disabled: reordering });
  // The card-drop highlight is for CARD drags only; a lane drag shows an insertion edge instead.
  const cardOver = isOver && (active?.data.current as BoardDragData | undefined)?.type !== "lane";
  const doneLane = isDoneColumn(col);
  // Two ways this lane can be showing one page, and they are not interchangeable (card a483cbec):
  //  · SERVER-WINDOWED (`laneTotal` set, i.e. no filter is active) — `tasks` already IS the page, so
  //    there is nothing to slice, and revealing more means FETCHING more. That window is a query
  //    parameter, so it necessarily lives in Board; it is also inherently board-wide (a board has one
  //    terminal lane), so nothing per-lane is lost by it living there.
  //  · CLIENT-CAPPED (`laneTotal` undefined) — the whole set is in hand, either because a filter is
  //    active or because nothing asked for a window. 7da27eb5's render cap applies, and its reveal
  //    state stays HERE so it is genuinely per-lane and survives the 4s poll (Column's key is stable
  //    across a refetch, and carries the project id, so a project switch collapses the lane again).
  const serverWindowed = laneTotal !== undefined;
  const [expanded, setExpanded] = useState(false);
  // `tasks` arrives already filtered (Board's search/priority/column filter) and already sorted, so
  // slicing here caps only what is RENDERED — a search that matches an old done card has already pulled
  // it out of the full set by the time we get here, and it lands inside the first page.
  const visible = doneLane && !serverWindowed && !expanded ? tasks.slice(0, DONE_LANE_PAGE) : tasks;
  // The lane's real length: the server's total when windowed, else what we were handed.
  const laneLength = laneTotal ?? tasks.length;
  const hidden = laneLength - visible.length;
  // A windowed reveal loads the NEXT page rather than everything at once — one click on a 4,763-card
  // lane would re-pay the whole payload the window exists to avoid. So the button offers a page (or
  // just the remainder, when that is smaller), and `hidden` stays the honest count behind it.
  const step = serverWindowed ? Math.min(DONE_LANE_PAGE, hidden) : hidden;
  // Where a card dragged in from another lane will LAND (card 68800f89). A lane move keeps the card's
  // priority and position, and the lane renders sorted, so the honest insertion point is wherever this
  // lane's own comparator puts it — not under the pointer. A done lane sorts newest-first, and the move
  // stamps updatedAt, so there it lands on top. Past the rendered page, the line sits under the last card.
  const dropIndex = dropCard
    ? Math.min(visible.length, (() => {
        const incoming: BoardTask = doneLane ? { ...dropCard, updatedAt: new Date().toISOString() } : dropCard;
        const cmp = doneLane ? byRecentlyDone : byPriorityThenPosition;
        const at = visible.findIndex((t) => cmp(incoming, t) < 0);
        return at < 0 ? visible.length : at;
      })())
    : -1;
  // One line per lane: a card from another lane (comparator slot, above), or this lane's own card being
  // reordered (card 139cfc3d — the pointer's slot, clamped to the card's priority band by Board).
  const lineIndex = dropCard ? dropIndex : reorderIndex;
  // ONE resolved color for the lane (role → tone, else accentColor, else null). Drives the accent bar,
  // the header label, and each card's left border so all three agree. null = un-accented: transparent
  // bar, neutral AA-safe label, neutral hairline card border.
  const accent = columnAccent(col);
  const theme = useResolvedTheme();
  const labelColor = labelColorFor(accent, theme); // resolved accent if it clears AA on this theme's panel, else textDim
  // SOFT WIP limit (advisory, never blocks). Shown as "N / limit" WHENEVER a limit is set (so an
  // approaching "2 / 3" is visible, not just a breach) — neutral under, amber AT-or-over. The count is
  // the column's TRUE card load (`laneTotal` when the lane came back windowed, else `cardCount`,
  // unfiltered), NOT the filtered `tasks.length`, so neither an active board filter nor a done window
  // can make the WIP count / over-limit state read wrong.
  const wipCount = laneTotal ?? cardCount;
  const hasWipLimit = col.wipLimit !== undefined;
  const atOrOverWip = hasWipLimit && wipCount >= col.wipLimit!;

  // Keyboard focus (card 591fe6ed): this lane's items in render order, and which one (if the board's Tab
  // stop is in this lane) gets tabIndex 0. Everything else in the grid is -1, so the whole board is one
  // Tab stop. Only RENDERED cards are items: a collapsed lane is its rail alone, and the done lane's
  // capped/windowed tail is reached through its "Show N more" button, never focused while hidden.
  const nav = useBoardNav();
  const navItems = collapsed ? [NAV_HEAD] : [NAV_HEAD, ...visible.map((t) => t.id), ...(hidden > 0 ? [NAV_MORE] : [])];
  const stop = nav && nav.lane === col.key ? resolveLaneItem(navItems, nav.item, nav.index) : undefined;
  const tabFor = (item: string) => (item === stop ? 0 : -1);
  // A focused node this lane just removed (a reveal button that vanished, a card the poll moved) leaves
  // focus on <body>; the board puts it back on the Tab stop. Runs on this lane's own renders too, since a
  // client-side reveal re-renders the lane without re-rendering the board.
  useEffect(() => { nav?.repairIfLost(); nav?.pruneSelection(); });

  // The header shows the label, its resolved role tint and the card count / soft-WIP readout, plus the
  // two ORDER/VIEW controls (card 67c43038): drag by the header to reorder, and the ⋯ lane menu. Column
  // CRUD (add/rename/delete/role/accent/WIP) still lives ONLY in Settings › Board Columns (ColumnManager).
  //
  // The insertion edge for a lane drag: an inset cobalt bar on the side the dragged lane will land.
  const dropShadow = dropEdge === "before" ? `inset 3px 0 0 ${color.accent}` : dropEdge === "after" ? `inset -3px 0 0 ${color.accent}` : undefined;
  // Graphite: a lane is a tinted WELL (lane-bg, radius 12, no border). The 1px border slot stays reserved
  // (transparent at rest) so the dashed "this lane is being dragged" outline costs no layout shift. A card
  // dragged over the lane tints it with the selection fill.
  const laneChrome: React.CSSProperties = {
    background: cardOver ? color.selected : color.laneBg, borderRadius: radius.lg,
    border: `1px ${laneDragging ? "dashed" : "solid"} ${laneDragging ? color.lineStrong : "transparent"}`,
    display: "flex", flexDirection: "column", minHeight: 200, maxHeight: "75vh", boxShadow: dropShadow,
    opacity: laneDragging ? 0.35 : 1, transition: "background-color 120ms ease",
  };

  // Collapsed: a slim rail with the label + count, still a drop target for cards. The whole rail is the
  // expand control; reorder needs the lane expanded (its menu lives in the full header).
  if (collapsed) {
    return (
      <div ref={setNodeRef} data-testid={`lane-${col.key}`} data-lane-key={col.key} data-collapsed=""
        style={laneChrome}>
        <button type="button" className="loom-lane-rail" data-lane-expand={col.key} data-testid={`lane-expand-${col.key}`}
          data-board-nav={NAV_HEAD} tabIndex={tabFor(NAV_HEAD)}
          aria-expanded={false} aria-label={`Expand the ${col.label} lane (${laneLength} card${laneLength === 1 ? "" : "s"})`}
          title={`Expand ${col.label}`} onClick={() => onCollapse(false)} style={{ color: labelColor }}>
          <span className="loom-lane-rail-label">{col.label} <span style={{ fontWeight: 500 }}>({laneLength})</span></span>
        </button>
      </div>
    );
  }

  // Bounded, viewport-relative height so a long column scrolls internally instead of stretching the
  // page. Flex column: header stays pinned; the card list is the lone flex:1 scroll region. The
  // droppable ref stays on this outer wrapper, so a drop lands anywhere over the column (incl. when
  // scrolled — dnd-kit measures this wrapper's rect, and its auto-scroll drives the inner list).
  return (
    // `.loom-grid` stays on the lane: it is inert in Graphite (--loom-grid-line is transparent) but it is
    // the hook every board spec locates a lane by, so it is part of the lane's contract, not decoration.
    <div ref={setNodeRef} className="loom-grid" data-testid={`lane-${col.key}`} data-lane-key={col.key} style={laneChrome}>
      {/* The lane head (Graphite): the accent dot plus the lane name in plain text colour, sentence case
          as the owner typed it. The accent rides the dot only, so every lane name reads at full contrast. */}
      <SectionLabel className="loom-lane-head" style={{ color: color.text, fontSize: fs.sm, margin: 0, padding: "12px 8px 8px 12px", display: "flex", alignItems: "center", gap: 6 }}>
        {/* The drag handle: grip + dot + label. Pointer-only by design: the keyboard path is the ⋯ menu
            below (a dnd-kit keyboard drag would nudge the lane 25px per keypress, which is no way to reorder). */}
        <span ref={laneDrag.setNodeRef} {...laneDrag.listeners} data-testid={`lane-handle-${col.key}`}
          className="loom-lane-handle" data-drag-disabled={reordering ? "true" : undefined}
          title={reordering ? "Saving the lane order…" : "Drag to reorder this lane"}
          style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, touchAction: "none" }}>
          <span aria-hidden className="loom-lane-grip">⠿</span>
          <LaneDot accent={accent} done={doneLane} />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{col.label}</span>
        </span>
        {hasWipLimit ? (
          <span aria-label={`${wipCount} of ${col.wipLimit} cards${atOrOverWip ? ", at or over the soft WIP limit" : ""}`}
            title={atOrOverWip
              ? `At or over the soft WIP limit of ${col.wipLimit} (advisory — does not block; counts the column's true load)`
              : `Soft WIP limit of ${col.wipLimit} (advisory; counts the column's true load)`}
            style={{ marginLeft: "auto", flexShrink: 0, fontFamily: font.mono, fontWeight: atOrOverWip ? 600 : 400,
              color: atOrOverWip ? color.attnText : color.text3 }}>
            {wipCount} / {col.wipLimit}
          </span>
        ) : (
          <span style={{ marginLeft: "auto", flexShrink: 0, fontFamily: font.mono, fontWeight: 400, color: color.text3 }}>({laneLength})</span>
        )}
        <LaneMenu col={col} index={index} count={laneCount} disabled={reordering}
          onMove={onMoveLane} onCollapse={() => onCollapse(true)} navItem={NAV_HEAD} tabIndex={tabFor(NAV_HEAD)} />
      </SectionLabel>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
        {visible.map((task, i) => (
          <Fragment key={task.id}>
            {i === lineIndex && <CardDropLine first={i === 0} />}
            <Card task={task} worker={workers.get(task.id)} policy={policyByTask[task.id]} multiRepo={multiRepo} repos={repos} primaryRepoPath={primaryRepoPath} titleById={titleById} isDoneLane={doneLane} onOpen={() => onOpen(task.id)} tabIndex={tabFor(task.id)} />
          </Fragment>
        ))}
        {lineIndex === visible.length && visible.length > 0 && <CardDropLine first={false} />}
        {/* The reveal for the done-lane page. Sits INSIDE the lane's own scroll region (so it trails the
            last rendered card rather than pinning to the lane footer) and is full-width so it reads as
            the continuation of the list it extends, not as a card. One-way: revealing more is not a
            state the user then has to undo, and a collapse control would only re-hide what they asked
            for. Absent entirely when nothing is hidden, so an un-paged lane is byte-identical.

            Windowed, this is a FETCH, so it gets the one state a pure unhide never needed: while the
            next page is in flight the label says so, the button is inert, and `aria-busy` carries the
            same fact to a screen reader rather than leaving it to the visible text alone. The lane keeps
            showing the page it already has (keepPreviousData), so nothing flashes empty underneath. */}
        {hidden > 0 && (
          <Button variant="ghost" data-board-nav={NAV_MORE} tabIndex={tabFor(NAV_MORE)}
            onClick={() => (serverWindowed ? onRevealMore?.() : setExpanded(true))}
            disabled={serverWindowed && revealPending}
            aria-busy={serverWindowed && revealPending ? true : undefined}
            aria-label={serverWindowed && revealPending
              ? `Showing ${step} more card${step === 1 ? "" : "s"} in ${col.label}`
              : `Show ${step} more card${step === 1 ? "" : "s"} in ${col.label}`}
            title={serverWindowed ? `${hidden} older card${hidden === 1 ? "" : "s"} not loaded yet` : undefined}
            style={{ width: "100%", marginTop: 2, color: color.text2, border: `1px dashed ${color.lineStrong}` }}>
            {serverWindowed && revealPending ? `Showing ${step} more…` : `Show ${step} more`}
          </Button>
        )}
        {/* Filtered-empty state: the filter hid every card in this column. Reads as deliberate, not broken. */}
        {laneLength === 0 && filterActive && (
          <div style={{ color: color.text3, fontSize: fs.sm, padding: "8px 2px" }}>no matches</div>
        )}
        {/* Genuinely-empty lane (no filter): a calm placeholder that doubles as a drop-target hint, so an
            empty column reads as intentional rather than a broken blank — and lights up when dragged over. */}
        {laneLength === 0 && !filterActive && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 72, textAlign: "center",
            color: cardOver ? color.accentFg : color.text3, fontFamily: font.ui, fontSize: fs.sm,
            border: `1px dashed ${cardOver ? color.accentEdge : color.lineStrong}`, borderRadius: radius.base,
            transition: "color 120ms ease, border-color 120ms ease" }}>
            {cardOver ? "drop to move here" : "no cards yet"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bulk bar (card 19074e42) ───────────────────────────────────────────────────
// Shown while at least one card is selected, or while the last action's outcome is still on screen. It sits
// UNDER the lane grid and sticks to the viewport's bottom edge, so appearing never pushes the cards being
// clicked; the two selects are actions (they reset to their prompt after each pick), not state.
function BulkBar({ count, columns, pending, result, onDismissResult, onClear, onMove, onPriority, onHold }:
  { count: number; columns: KanbanColumn[]; pending: string | null; result: BulkResult | null;
    onDismissResult: () => void; onClear: (e: React.MouseEvent<HTMLButtonElement>) => void; onMove: (col: KanbanColumn) => void;
    onPriority: (p: TaskPriority) => void; onHold: (held: boolean) => void }) {
  const busy = pending !== null;
  const actionSelect: React.CSSProperties = { fontSize: fs.sm, padding: "3px 8px", maxWidth: 220, borderRadius: radius.base };
  // Sticky at the viewport's bottom edge, so it shares the request pill's corner — register it so the
  // pill rises above "Clear selection" instead of sitting on it (lib/bottomDock.ts, card 3094c4aa).
  const dockRef = useRef<HTMLDivElement>(null);
  useBottomDock(dockRef);
  return (
    <div ref={dockRef} data-testid="board-bulk-bar" data-board-bulk-bar="" aria-busy={busy || undefined}
      style={{ position: "sticky", bottom: 12, zIndex: 2, marginTop: 10, background: color.surface, borderRadius: radius.lg,
        boxShadow: shadow.panel, border: `1px solid ${color.line}`, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      {count > 0 && (
        <div role="toolbar" aria-label="Selected cards" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span data-testid="board-bulk-count" style={{ fontSize: fs.sm, fontWeight: 600, color: color.text }}>
            {count} selected
          </span>
          <Select aria-label="Move the selected cards to a lane" value="" disabled={busy} style={actionSelect}
            onChange={(e) => { const col = columns.find((c) => c.key === e.target.value); if (col) onMove(col); }}>
            <option value="" disabled>Move to lane…</option>
            {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
          <Select aria-label="Set the priority of the selected cards" value="" disabled={busy} style={actionSelect}
            onChange={(e) => { const p = e.target.value as TaskPriority; if (PRIORITIES.includes(p)) onPriority(p); }}>
            <option value="" disabled>Set priority…</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].short} · {PRIORITY_META[p].label}</option>)}
          </Select>
          <Button disabled={busy} onClick={() => onHold(true)} title="Hold: the owner's brake, nothing works or nags these cards">Hold</Button>
          <Button disabled={busy} onClick={() => onHold(false)}>Release hold</Button>
          {busy && <span style={{ fontSize: fs.sm, color: color.text3 }}>Updating {cardsWord(count)}…</span>}
          <Button variant="ghost" onClick={onClear} title="Esc" style={{ marginLeft: "auto" }}>Clear selection</Button>
        </div>
      )}
      {result && (
        <div role={result.failed.length ? "alert" : "status"} data-testid="board-bulk-result"
          style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: fs.sm,
            color: result.failed.length ? color.attnText : color.text2 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{bulkSummary(result)}{result.failed.length ? ". The failed cards are still selected:" : "."}</div>
            {result.failed.length > 0 && (
              <ul data-testid="board-bulk-failures" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {result.failed.map((f) => (
                  <li key={f.id} data-task-id={f.id}>
                    <span style={{ color: color.text, fontWeight: 500 }}>{f.title}</span>
                    <span style={{ fontFamily: font.mono, color: color.text3 }}> {f.id.slice(0, 8)}</span>: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button variant="ghost" onClick={onDismissResult}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────────
// Tiny uppercase group label (font.ui) preceding a row of toggle chips. aria-hidden — each
// toggle carries its own descriptive aria-label, so the visual label would only be redundant noise
// to a screen reader.
const groupLabel = { fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: color.text2 } as const;

// A multi-select toggle chip. Off: outlined + dim. On: filled with its signal tone (the established
// PriorityChip "pop" look). `muted` fills with the lighter text-dim grey instead of the near-invisible
// muted grey so the dark on-fill label keeps AA contrast. Native <button> → Enter/Space + focus ring
// (.loom-toggle in global.css) come for free; aria-pressed exposes the on/off state.
// `count` (optional) renders as a quiet mono number after the label — how many cards on the board carry
// this value. A zero-count chip dims but stays clickable: it is still a true filter, just an empty one.
function ToggleChip({ label, ariaLabel, t, active, onToggle, count }:
  { label: string; ariaLabel: string; t: Tone; active: boolean; onToggle: () => void; count?: number }) {
  // Graphite capsule: outlined at rest; on, it takes the tone's soft fill, text and edge. A muted tone has
  // no edge of its own, so its "on" state borrows the strong line to stay distinguishable from rest.
  const edge = t === "muted" ? color.lineStrong : tone[t];
  return (
    <button type="button" aria-pressed={active} aria-label={ariaLabel} title={ariaLabel} onClick={onToggle}
      className={`loom-toggle${active ? " is-active" : ""}`}
      style={{
        fontFamily: font.ui, fontSize: fs.sm, fontWeight: active ? 600 : 500,
        padding: "3px 10px", borderRadius: radius.pill, lineHeight: "16px",
        color: active ? toneText[t] : color.text2, background: active ? toneSoft[t] : "transparent",
        border: `1px solid ${active ? edge : color.line}`,
        opacity: count === 0 && !active ? 0.55 : 1,
      }}>
      {label}
      {count !== undefined && (
        <span data-testid="filter-chip-count" style={{ marginLeft: 5, fontFamily: font.mono, fontSize: fs.xs, fontWeight: 400,
          color: active ? "inherit" : color.text3 }}>{count}</span>
      )}
    </button>
  );
}

// A hairline between two filter groups that share a row. Decorative.
function GroupSep() {
  return <span aria-hidden style={{ width: 1, height: 18, background: color.line, flexShrink: 0 }} />;
}

// One filter group: its label and its controls, wrapping as a unit. `role="group"` + aria-label names the
// group for a screen reader (the visual label stays aria-hidden, as before — each control names itself).
function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={`${label} filter`} data-filter-group={label.toLowerCase()}
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span aria-hidden style={groupLabel}>{label}</span>
      {children}
    </div>
  );
}

// The Epic / Repo single-selects: compact, and tinted with the accent edge once a value is picked so an
// active select reads as "on" the same way a pressed chip does.
const filterSelect = (on: boolean): React.CSSProperties => ({
  fontSize: fs.sm, padding: "3px 8px", maxWidth: 260, borderRadius: radius.base,
  ...(on ? { borderColor: color.accentEdge, color: color.accentFg } : {}),
});

// The Repo select's "any" value. "" is taken (it means the PRIMARY repo, a card with no repoKey), and a
// space can never be inside a registry key, so this can never collide with one.
const ANY_REPO = " any";

type FilterCounts = { pri: Map<string, number>; type: Map<string, number>; state: Map<string, number> };

function FilterBar({ search, onSearch, counts, priFilter, onTogglePri, types, typeFilter, onToggleType,
  stateFilter, onToggleState, epics, epicFilter, onEpic, repos, repoFilter, onRepo, shown, total, active, onClear }:
  { search: string; onSearch: (v: string) => void; counts: FilterCounts;
    priFilter: Set<TaskPriority>; onTogglePri: (p: TaskPriority) => void;
    types: string[]; typeFilter: Set<string>; onToggleType: (t: string) => void;
    stateFilter: Set<CardState>; onToggleState: (s: CardState) => void;
    epics: { id: string; title: string; count: number }[]; epicFilter: string | null; onEpic: (id: string | null) => void;
    repos: RepoRegistryEntry[] | null; repoFilter: string | null; onRepo: (key: string | null) => void;
    shown: number; total: number; active: boolean; onClear: () => void }) {
  // Narrow widths (card c315f579): the two facet rows fold behind a "Filters" toggle, so the first card
  // is not pushed most of the way down a phone screen. Search stays out, it is the filter people reach
  // for first. The toggle's count says how many facet filters are on while the rows are folded away.
  const narrow = useNarrowViewport(FILTER_FOLD_BELOW);
  const [open, setOpen] = useState(false);
  const facetCount = priFilter.size + typeFilter.size + stateFilter.size + (epicFilter !== null ? 1 : 0) + (repoFilter !== null ? 1 : 0);
  const showFacets = !narrow || open;
  const facetsId = useId();
  return (
    <div data-testid="board-filter-bar" style={{ marginTop: 10, background: color.surface, borderRadius: radius.lg, boxShadow: shadow.panel,
      padding: narrow ? "8px 10px" : "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Row 1: search + live result count + clear-all (+ the facet toggle at narrow widths) */}
      <div style={{ display: "flex", alignItems: "center", gap: narrow ? 8 : 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", flex: narrow ? "1 1 140px" : "1 1 240px", maxWidth: 460 }}>
          <span aria-hidden style={{ position: "absolute", left: 8, color: color.text3, fontSize: fs.body, pointerEvents: "none" }}>⌕</span>
          <Input value={search} onChange={(e) => onSearch(e.target.value)}
            aria-label="Search tasks by id, title, or description" placeholder={narrow ? "search tasks…" : "search tasks by id or text…"}
            onKeyDown={(e) => { if (e.key === "Escape" && search) { e.stopPropagation(); onSearch(""); } }}
            style={{ width: "100%", paddingLeft: 26, paddingRight: search ? 26 : 8 }} />
          {search && (
            <button type="button" aria-label="Clear search" title="Clear search" onClick={() => onSearch("")}
              className="loom-toggle" style={{ position: "absolute", right: 6, background: "transparent", border: "none",
                color: color.text3, cursor: "pointer", fontSize: fs.body, lineHeight: 1, padding: 2, borderRadius: radius.sm }}>✕</button>
          )}
        </div>
        <span aria-live="polite" style={{ fontSize: fs.sm, whiteSpace: "nowrap",
          color: active ? color.accentFg : color.text3 }}>
          {shown} of {total} shown
        </span>
        {narrow && (
          <button type="button" className={`loom-toggle${facetCount > 0 ? " is-active" : ""}`} data-testid="board-filter-toggle"
            aria-expanded={open} aria-controls={facetsId} onClick={() => setOpen((v) => !v)}
            style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: facetCount > 0 ? 600 : 500, padding: "3px 10px",
              borderRadius: radius.pill, lineHeight: "16px", cursor: "pointer", whiteSpace: "nowrap",
              color: facetCount > 0 ? color.accentFg : color.text2, background: "transparent",
              border: `1px solid ${facetCount > 0 ? color.accentEdge : color.line}` }}>
            {facetCount > 0 ? `Filters (${facetCount})` : "Filters"}
            <span aria-hidden style={{ marginLeft: 5, color: color.text3 }}>{open ? "▴" : "▾"}</span>
          </button>
        )}
        {active && <Button variant="ghost" onClick={onClear} style={{ marginLeft: "auto" }}>Clear filters</Button>}
      </div>
      {showFacets && <div id={facetsId} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Row 2: what the card IS — priority + the title's commit type. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <FilterGroup label="Priority">
          {PRIORITIES.map((p) => (
            <ToggleChip key={p} label={PRIORITY_META[p].short} count={counts.pri.get(p) ?? 0}
              ariaLabel={`Filter by ${PRIORITY_META[p].label} priority`}
              t={PRIORITY_META[p].tone} active={priFilter.has(p)} onToggle={() => onTogglePri(p)} />
          ))}
        </FilterGroup>
        {types.length > 0 && <GroupSep />}
        {types.length > 0 && (
          <FilterGroup label="Type">
            {types.map((t) => (
              <ToggleChip key={t} label={t} count={counts.type.get(t) ?? 0}
                ariaLabel={t === OTHER_TYPE ? "Filter by cards whose title has no commit type" : `Filter by ${t} cards`}
                t="muted" active={typeFilter.has(t)} onToggle={() => onToggleType(t)} />
            ))}
          </FilterGroup>
        )}
      </div>
      {/* Row 3: where the card STANDS — state facts, then the epic it belongs to and the repo it targets. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <FilterGroup label="State">
          {CARD_STATES.map((s) => (
            <ToggleChip key={s.key} label={s.label} count={counts.state.get(s.key) ?? 0}
              ariaLabel={`Filter by ${s.aria}`} t={STATE_TONE[s.key]}
              active={stateFilter.has(s.key)} onToggle={() => onToggleState(s.key)} />
          ))}
        </FilterGroup>
        <GroupSep />
        <FilterGroup label="Epic">
          <Select aria-label="Filter by epic (shows every card under it)" value={epicFilter ?? ""}
            onChange={(e) => onEpic(e.target.value || null)} style={filterSelect(epicFilter !== null)}
            disabled={epics.length === 0 && epicFilter === null}>
            <option value="">{epics.length === 0 ? "no epics" : "any epic"}</option>
            {epics.map((e) => <option key={e.id} value={e.id}>{e.title} ({e.count})</option>)}
          </Select>
        </FilterGroup>
        {/* Only on a project with a repo registry — the same gate as the card's repo badge. */}
        {repos && (
          <FilterGroup label="Repo">
            <Select aria-label="Filter by target repo" value={repoFilter ?? ANY_REPO}
              onChange={(e) => onRepo(e.target.value === ANY_REPO ? null : e.target.value)}
              style={filterSelect(repoFilter !== null)}>
              <option value={ANY_REPO}>any repo</option>
              <option value="">primary</option>
              {repos.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
            </Select>
          </FilterGroup>
        )}
      </div>
      </div>}
    </div>
  );
}
// Below this width the facet rows fold behind the "Filters" toggle (card c315f579).
const FILTER_FOLD_BELOW = 820;

// A State chip's "on" tone matches the badge the card itself wears for that state, so the chip and the
// cards it keeps read as the same thing.
const STATE_TONE: Record<CardState, Tone> = { held: "muted", deferred: "muted", policy: "danger", request: "attn", blocked: "muted" };

// A worker bound to this task → show its live status + branch (links the board to the spine). The same
// precedence as fleet's `sessionStatus`: not live > waiting on you (it holds a PENDING owner Request it
// filed) > working > idle.
function workerStatus(w: SessionListItem, waitingOnYou: boolean): { tone: Tone; label: string; glow?: boolean; solid?: boolean } {
  if (w.processState !== "live") return { tone: "muted", label: w.processState };
  if (waitingOnYou) return { ...WAITING_ON_YOU };
  return w.busy ? { tone: "work", label: "working", glow: true } : { tone: "live", label: "idle" };
}

// Direction C — the merge-gate hairline sweep meter + live timer (card 7b7fa6d; the merged/rejected/
// failed 3-way split is the d1aee5f1 follow-up). A worker with a `pendingMerge` op gets a 2px hairline
// flush at the card's BOTTOM edge — an amber oscilloscope sweep while the gate RUNS, a solid full-width
// fill once settled — plus a live M:SS timer riding the right edge of the worker row. Compact by
// construction: the hairline is absolutely positioned over the card's existing bottom edge, so it adds
// NO card height.
//
// @decision d1aee5f1 — A settled merge op stays visible via PendingOpRegistry's retained-view opt-in for
// a brief window after it settles, instead of reverting to nothing the instant `peek()` would otherwise
// show it gone.
//
// That retained window is what gives the terminal fill below a real chance to render before
// `pendingMerge` reverts to null and the card falls back to its normal worker-status row. `pm.outcome`
// (not the raw `pm.state`, which can't tell a merge SUCCESS from a gate REJECTION — both resolve to
// "done") drives which of the four fills renders: "merged" (phosphor), "cancelled" (cyan — card
// 361520a0, Half Four: NO verdict was reached, so this must never render as the same amber "rejected"
// fill a real refusal gets — checked before "rejected" below since a cancelled outcome also carries
// `merged:false`), "rejected" (amber — a distinct solid fill from the RUNNING sweep, which is also amber
// but animated), or "failed" (red — a thrown exception during confirm; driven by the raw `pm.state`, NOT
// `pm.outcome`, since card 479f449f: a thrown confirm classifies as `outcome:"unknown"`, never "failed" —
// the confirm could not prove the merge failed, only that it couldn't confirm the outcome either way, and
// `state === "failed"` alone already unambiguously identifies "an exception was thrown" without needing
// the softer `outcome` string to agree). `outcome` is only absent for a legacy/synthetic "done" with no
// outcome field (e.g. an older cached row) — that degrades to "merged" for backward compatibility,
// matching the old done⇒merged reading.
//
// "queued" (card 53ad9ed3) is the WAITING half of `state:"running"`, read off `pm.gatePhase` — see
// PendingMerge's own doc. Without it, this pill showed "merging" (plus a ticking timer) for an op that
// hadn't reached GateSemaphore admission yet, i.e. one that had done zero seconds of actual gate work —
// exactly the misread the card was filed to close. Rendered muted/static rather than the amber sweep so
// the two are never confusable at a glance.
type MergeState = "queued" | "running" | "merged" | "cancelled" | "rejected" | "failed";
type MergeDisplay = { state: MergeState; tone: Tone; label: string; startedAt: string };
function mergeDisplay(pm: PendingMerge | null | undefined): MergeDisplay | null {
  if (!pm) return null;
  if (pm.state === "running") {
    if (pm.gatePhase === "queued") return { state: "queued", tone: "muted", label: "queued", startedAt: pm.startedAt };
    return { state: "running", tone: "work", label: "merging", startedAt: pm.startedAt };
  }
  if (pm.state === "failed") return { state: "failed", tone: "danger", label: "failed", startedAt: pm.startedAt };
  if (pm.outcome === "cancelled") return { state: "cancelled", tone: "muted", label: "cancelled", startedAt: pm.startedAt };
  // Card 99a1cf6f: "stale-base" (a benign canonical-main-moved rejection, `ConfirmMergeResult
  // .gateBaseInvalidated`) renders identically to an ordinary "rejected" — nothing landed either way, and
  // the board has no reason to teach a viewer the internal cache-eviction taxonomy. Without this, an
  // unrecognized outcome string fell through to the final `merged`/phosphor return below and rendered a
  // REJECTED branch as a successful green merge.
  // Card c59165b8: ONLY a "merged" (or absent, legacy/synthetic "done") outcome may render green; any other string, including one this
  // build does not know yet ("gate-tip-moved", "worktree-dirty", a future outcome), renders as rejected — never as a successful merge.
  if (pm.outcome !== undefined && pm.outcome !== "merged") return { state: "rejected", tone: "attn", label: "rejected", startedAt: pm.startedAt };
  return { state: "merged", tone: "live", label: "merged", startedAt: pm.startedAt }; // "merged", or a legacy/synthetic "done" with no outcome
}

// Live M:SS elapsed since `startedAt`, ticking once a second. Shown only while the gate is RUNNING — it's
// a liveness cue, and a settled merge carries no end time to compute a final duration from. tabular-nums
// so ticking digits never jitter the row width.
function MergeTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const started = Date.parse(startedAt);
  const secs = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em" }}>
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
    </span>
  );
}

// The merge-state pill for the worker row: a StatusPill-shaped capsule (dot + label) that also carries
// the live timer INLINE while running. Bundling the timer into the pill (rather than a separate far-right
// flex item) is what keeps the merging card the SAME height as a plain worker card — both rows then hold
// exactly two flex items (pill + branch chip), so they wrap identically on a tight lane. Mirrors
// StatusPill's own capsule chrome (components/ui) property for property, so it reads as one system AND
// is the same height as the StatusPill it replaces — board-merge-meter.spec.ts compares the two cards.
function MergePill({ merge }: { merge: MergeDisplay }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px 4px 8px", borderRadius: radius.pill,
      background: toneSoft[merge.tone], color: toneText[merge.tone], fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500,
      lineHeight: 1, whiteSpace: "nowrap",
    }}>
      <Dot tone={merge.tone} style={{ width: 6, height: 6 }} />
      <span>{merge.label}</span>
      {(merge.state === "running" || merge.state === "queued") && <MergeTimer startedAt={merge.startedAt} />}
    </span>
  );
}

// The bottom-edge hairline itself. RUNNING → an amber segment sweeping left↔right (the CSS keyframes
// degrade to a static amber bar under prefers-reduced-motion); QUEUED → a static muted bar (no sweep — a
// queued op hasn't reached the gate, so animating it would read as active work it isn't doing); settled →
// a solid full-width fill from the tone fills — live green (merged), info (cancelled — no verdict
// reached, deliberately NOT the same amber a real rejection gets), amber (rejected — a solid bar, distinct
// from the RUNNING sweep's animated one), or red (failed). aria-hidden — the worker-row pill already names
// the state in text.
function MergeTrack({ merge }: { merge: MergeDisplay }) {
  const fillStyle: React.CSSProperties =
    merge.state === "merged" ? { background: toneFill.live }
    : merge.state === "cancelled" ? { background: toneFill.muted }
    : merge.state === "rejected" ? { background: toneFill.attn }
    : merge.state === "queued" ? { background: toneFill.muted }
    : { background: toneFill.danger };
  return (
    <div className="loom-merge-track" aria-hidden>
      {merge.state === "running" ? <span className="loom-merge-sweep" /> : <span className="loom-merge-fill" style={fillStyle} />}
    </div>
  );
}

// The held/deferred STATE tag on a card: a small tonal capsule (soft fill + tone text), Graphite's
// status shape, rather than the old solid uppercase block.
const cardStateTag: React.CSSProperties = { flexShrink: 0, fontFamily: font.ui, fontSize: fs.xs, fontWeight: 600,
  borderRadius: radius.pill, padding: "1px 7px", lineHeight: "16px" };

// Card 68800f89 — the insertion line a card drag shows in its target lane: a 2px cobalt rule, the same
// accent the lane-drag insertion edge uses. Between cards it sits inside the 8px gap (negative margins,
// so the lane does not reflow under the pointer); above the first card there is no gap, so it takes 8px.
function CardDropLine({ first }: { first: boolean }) {
  return <div data-testid="card-drop-line" aria-hidden
    style={{ height: 2, borderRadius: radius.pill, background: color.accent, margin: first ? "0 0 6px" : "-5px 0 3px" }} />;
}

// Card 68800f89 — the lifted card's DragOverlay preview: the card's priority and title on the card
// surface, lifted with the pop shadow. dnd-kit sizes the overlay to the source card, so it reads as the
// card itself; it never mounts a second <Card> (that would register a second draggable under one id).
function CardDragPreview({ task }: { task: BoardTask }) {
  return (
    <div data-testid="card-drag-preview"
      style={{ height: "100%", boxSizing: "border-box", display: "flex", alignItems: "flex-start", gap: 6,
        padding: "8px 10px", background: color.cardBg, border: `1px solid ${color.lineStrong}`, borderRadius: radius.base,
        boxShadow: shadow.pop, transform: "rotate(-1deg)", cursor: "grabbing", fontSize: fs.sm, color: color.text, overflow: "hidden" }}>
      <span aria-hidden style={{ color: color.text3, fontFamily: font.mono, fontSize: fs.mono, lineHeight: "16px", flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, margin: "-4px -6px -4px -11px" }}>⠿</span>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, minWidth: 0, flex: 1 }}>
        <PriorityChip priority={prio(task)} />
        {/* The card face's own title type (Card's card-title span), so the lifted card reads as the card. */}
        <span style={{ flex: "1 1 120px", minWidth: 0, overflowWrap: "break-word", fontFamily: font.ui, fontSize: fs.body,
          fontWeight: 500, lineHeight: 1.4 }}>{task.title}</span>
      </div>
    </div>
  );
}

function Card({ task, worker, policy, multiRepo, repos, primaryRepoPath, titleById, isDoneLane, onOpen, tabIndex }:
  { task: BoardTask; worker?: SessionListItem; policy?: CardPolicyCardStatus; multiRepo: boolean; repos: RepoRegistryEntry[]; primaryRepoPath: string; titleById: Map<string, string>; isDoneLane: boolean; onOpen: () => void;
    /** The board's roving Tab stop (card 591fe6ed): 0 on the one focusable item, -1 everywhere else. */
    tabIndex: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { type: "card" } satisfies BoardDragData });
  // One shared react-query key, so every card reads the same cached request list (no extra polling).
  const decisions = usePendingDecisionsBySession();
  const st = worker ? workerStatus(worker, decisions.has(worker.id)) : null;
  const merge = worker ? mergeDisplay(worker.pendingMerge) : null;
  const hasBody = task.hasBody;
  // Hierarchy (card 1ae4f88c) — every field defaults to empty, so on an older daemon `hier` is all-zero,
  // `hasBoardHierarchy` is false, and this card renders exactly as it did before the card existed.
  const hier = boardHierarchy(task);
  // Multi-select (card 19074e42): read straight off the board's nav context.
  const nav = useBoardNav();
  const selected = !!nav?.selected.has(task.id);
  return (
    // Card 68800f89 — with a mouse or pen the whole face starts a drag (after the sensor's 6px, so a click
    // still opens and a modified click still selects). Touch is left to the grip, so a swipe across a card
    // scrolls its lane instead of grabbing it. Only the pointer listener rides the face: the keyboard
    // listener stays on the grip, so Enter/Space on the open target can never start a drag.
    <div ref={setNodeRef}
      onPointerDown={(e) => { if (e.pointerType !== "touch") listeners?.onPointerDown?.(e); }}
      className="loom-board-card" data-card-id={task.id} data-selected={selected ? "" : undefined} data-dragging={isDragging ? "" : undefined}
      style={{
        // position:relative anchors the merge-gate hairline (MergeTrack), which is absolutely positioned
        // flush at the card's bottom edge so it adds no height.
        position: "relative",
        // Graphite: a card is a tonal step above its lane well (card-bg), with a hairline and a short
        // shadow in light only (the card-border/card-shadow tokens are transparent/none in dark). The
        // lane's identity rides its head dot, not a per-card edge. Held reads as braked WHEREVER the card
        // sits: a muted strong edge plus a 3px muted left rule, so a held card never blends into a lane.
        // Selected: the selection fill plus the accent edge, and an inset accent ring so the mark survives
        // the held card's own left rule. Held keeps its rule either way.
        border: `1px solid ${selected ? color.accentEdge : task.held ? color.lineStrong : color.cardBorder}`,
        borderLeft: task.held ? `3px solid ${color.text3}` : `1px solid ${selected ? color.accentEdge : color.cardBorder}`, borderRadius: radius.base,
        boxShadow: selected ? `inset 0 0 0 1px ${color.accentEdge}` : shadow.card, padding: "8px 10px", marginBottom: 8,
        background: selected ? color.selected : color.cardBg,
        // The source stays in place, ghosted, while its preview (the DragOverlay) follows the pointer.
        opacity: isDragging ? 0.4 : 1,
        fontSize: fs.sm, color: color.text,
      }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        {/* The grip is the drag affordance, and the only drag handle on touch. The grip keeps the mono face: the sans has no braille glyph, and the fallback face draws ⠿
            wider, which pushes a reflowed title off the card's left edge on a tight lane. */}
        {/* tabIndex -1 over dnd-kit's own 0: the grip is a pointer handle, and leaving it a Tab stop would
            put two stops on every card and break the board's single one (card 591fe6ed). A keyboard user
            moves a card from its dialog's "Move to lane". */}
        {/* Card 68800f89: a 24×24 hit area (was the 7×16 glyph), so it is a real touch target. The negative
            margins spend the card's own left padding + border on it and leave a 7px layout footprint (the
            glyph's own width), so the title does not move — board.spec's tight-lane reflow guard pins the
            title's x within 40px of the lane edge, and a wider footprint breaks it. Its pointerdown
            is the same handler the face calls; dnd-kit marks the event captured, so the bubble to the
            face's handler is a no-op rather than a second drag. */}
        <span {...listeners} {...attributes} tabIndex={-1} title="Drag to move" className="loom-card-grip"
          style={{ cursor: "grab", color: color.text3, fontFamily: font.mono, fontSize: fs.mono, lineHeight: "16px", touchAction: "none", userSelect: "none",
            display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            width: 24, height: 24, margin: "-4px -6px -4px -11px" }}>⠿</span>
        {/* The card's open target is a real control, not a clickable div (card a6d7a102): the detail
            dialog had no keyboard way in at all, and with nothing focused when it opened, Esc left a
            keyboard user at <body> with the whole page to re-Tab through. role=button + Enter/Space is
            the minimal shape — a <button> element would reset the card's whole type/layout here, and
            this subtree carries only spans, never a nested link, so no interactive content is buried
            inside it (see the note in components/taskLinks.tsx on why the card deliberately has none). */}
        {/* A press with Ctrl/⌘ or Shift is a selection gesture (card 19074e42): its mousedown is suppressed
            so neither text selection nor the focus move happens before the board reads its anchor, and its
            click never opens the card. A plain press opens it exactly as before. */}
        {/* The open target and the worker row are SIBLINGS in one column (card fa4234ab): the worker
            pill is a real link to its session, and a link may not sit inside role=button. */}
        <div style={{ flex: 1, minWidth: 0 }}>
        <div role="button" tabIndex={tabIndex} data-board-nav={task.id} className="loom-board-open"
          aria-keyshortcuts={isDoneLane ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          onMouseDown={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.preventDefault(); }}
          onClick={(e) => { if (!nav?.press(task.id, e)) onOpen(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
          title="Open task" style={{ cursor: "pointer", minWidth: 0 }}>
          {/* flexWrap is the phone-density hinge: the priority chip + a held/deferred badge share this
              line with the title. On a TIGHT lane (phone ~200px / the 240px desktop floor) a chip + badge
              starve the title's slice, so the title's 120px flex-basis no longer fits beside them and
              wraps to its OWN full-width line below the badge row — giving a long word the whole lane so
              it never breaks mid-word. On a WIDE lane the basis fits inline and the row stays one line,
              unchanged. Self-adjusting: only a genuinely starved title reflows (a chip-only card with room
              keeps its title inline). */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <PriorityChip priority={prio(task)} />
            {task.held && (
              <span title="Held — won't be worked or nagged (the owner's brake)"
                style={{ ...cardStateTag, color: toneText.muted, background: toneSoft.muted }}>
                ⏸ held
              </span>
            )}
            {/* Repo badge (multi-repo epic 49136451, phase 3) — rendered ONLY for a card routed at a
                NON-primary registered repo on a project that HAS a registry. A single-repo project (no
                registry) and a primary-targeted card both render nothing, so the common card is
                byte-identical to before multi-repo: the badge is a positive signal that this card lands
                somewhere other than where you'd assume, never decoration on every card. Muted/outline
                rather than a filled chip, so it can't compete with held (amber) or deferred (cyan),
                which are STATE; this is a target. */}
            {multiRepo && task.repoKey && (
              <span title={`Targets the "${task.repoKey}" repo — this card's worktree, branch and gate all land there, not on the primary repo`}
                style={{ flexShrink: 0, fontFamily: font.mono, fontSize: fs.xs, letterSpacing: "0.04em",
                  color: color.text2, background: "transparent", borderRadius: radius.sm, padding: "0 4px",
                  border: `1px solid ${color.line}`, maxWidth: 110, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⑂ {task.repoKey}
              </span>
            )}
            {/* The deferred badge NAMES what it's waiting on when the board row knows (card 1ae4f88c):
                `deferredUntilTaskId` is now an alias over a gates_deferral blocks edge, so a deferred
                card's blocker surfaces as `blockedByFirst`. The badge keeps its one-word label — the
                lane is 240px and this is the owner's densest surface — and the blocker's title rides in
                the tooltip, while the ⊘ marker on the meta row below shows it without a hover. */}
            {task.deferred && (
              <span title={hier.blockedByFirst
                ? `Deferred until "${hier.blockedByFirst.title}"${hier.blockedByOpen > 1 ? ` (and ${hier.blockedByOpen - 1} more)` : ""} — a manager's own sequencing marker, won't nag (not the owner's brake)`
                : "Deferred — a manager's own sequencing marker, won't nag (not the owner's brake)"}
                style={{ ...cardStateTag, color: toneText.muted, background: toneSoft.muted }}>
                deferred
              </span>
            )}
            {/* Card policies (card 61d32daf): only when a requirement would block the card today, so a card
                no policy touches, or one whose requirements are all met or waived, keeps its height. */}
            <CardPolicyBadge status={policy} />
            {/* `break-word` (not `anywhere`): normal titles wrap at WORD boundaries, and only a genuinely
                long unbroken token breaks mid-word. `anywhere` makes the title's min-content width one
                character, so at a crushed lane width the flex row collapses it to one letter per row. */}
            {/* `data-testid` is load-bearing for e2e locators since card 1ae4f88c: the parent chip on the
                meta row below renders the PARENT's title as card text, so a card's title is no longer
                unique text on the board and `getByText(title)` resolves the card PLUS every child of it.
                This gives specs the card's OWN title to filter on. */}
            <span data-testid="card-title" style={{ flex: "1 1 120px", minWidth: 0, overflowWrap: "break-word",
              fontFamily: font.ui, fontSize: fs.body, fontWeight: 500, lineHeight: 1.4 }}>{task.title}</span>
            {/* The selection mark for a screen reader; the fill and edge carry it visually. */}
            {selected && <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>(selected)</span>}
            {hasBody && <span title="has a description" style={{ color: color.text3, flexShrink: 0 }}>≣</span>}
            {/* Ship-state (card 1eebc46a) — a compact "landed" marker naming the sha; the REPO it landed on
                (which may differ from the target-repo badge above, though it normally agrees) is in the
                tooltip rather than crowding the card — the drawer's Shipped line spells it out in full.
                Gated to a DONE/terminal lane: a re-tasked card still carries its PRIOR landing's mergedSha
                (correctly — see finalizeMerge's own doc) while it's actively being reworked in a live
                lane, where a "✓ shipped" marker would read as done when it visibly isn't. */}
            {task.mergedSha && isDoneLane && (
              <span title={`Landed as ${task.mergedSha} on ${shipRepoLabel(task.mergedRepoKey, repos, primaryRepoPath)}${shipVerificationStyle(task.mergedVerification).suffix}`}
                style={{ flexShrink: 0, fontFamily: font.mono, fontSize: fs.xs, color: shipVerificationStyle(task.mergedVerification).color }}>
                ✓ {task.mergedSha}
              </span>
            )}
          </div>
          {/* Hierarchy meta row (card 1ae4f88c) — ONE extra 10px line, and ONLY for a card that genuinely
              has a parent, children or an open blocker. This is the Overview-embedded board too (the
              owner's primary surface), so a plain card must stay exactly as tall as it was: the gate below
              is what guarantees that, since most cards carry none of the three. Deliberately kept OFF the
              badge row above — that row already competes for a 240px lane between the priority chip, held,
              repo, deferred, the title and the ship marker. */}
          {hasBoardHierarchy(hier) && (
            <BoardCardHierarchy h={hier} parentTitle={hier.parentId ? titleById.get(hier.parentId) ?? null : null} />
          )}
        </div>
          {worker && st && (
            // A press on the row's empty space still opens the card, exactly as it did when this row sat
            // inside the open target; only the pill itself leaves for the session.
            <div onClick={(e) => { if (!nav?.press(task.id, e)) onOpen(); }}
              style={{ marginTop: 5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}>
              {/* While a merge gate is in flight the pill speaks the MERGE state (merging/merged/failed)
                  plus a live timer, and the branch chip yields to it — a merge pill + branch chip would
                  overflow a tight (~240px) lane and wrap, growing the card. Keeping the row to the single
                  merge pill holds the card at the SAME height as a plain worker card; the branch chip
                  returns the instant the op settles + evicts (pendingMerge → null). */}
              {/* The pill is the card's link to its worker session (card fa4234ab). It adds NO width: a
                  trailing ↗ pushed the branch chip onto a second line in a 240px lane and grew the card
                  (board-merge-meter.spec's footprint check caught it), so the link cue is hover-only.
                  tabIndex -1 keeps the
                  board's single roving Tab stop (card 591fe6ed), same as the drag grip: the keyboard way in
                  is the dialog's Worker row. stopPropagation so the row's own open-the-card click doesn't
                  also fire under the navigation. */}
              <Link to={workerSessionPath(worker.id)} tabIndex={-1} className="loom-card-worker"
                data-testid="card-worker-link" title={`Open ${worker.agentName}'s session`}
                onClick={(e) => e.stopPropagation()}>
                {merge
                  ? <MergePill merge={merge} />
                  : <StatusPill tone={st.tone} label={st.label} glow={st.glow} solid={st.solid} />}
              </Link>
              {!merge && worker.branch && <Chip label="branch" value={worker.branch} tone="muted" />}
            </div>
          )}
        </div>
      </div>
      {merge && <MergeTrack merge={merge} />}
    </div>
  );
}

// Dialog focus, shared by the three task-detail dialogs below (card a6d7a102). Opening a card moves
// focus INTO the panel and closing hands it back to the exact card you opened from — without the
// restore, Esc drops a keyboard user at <body> and they re-Tab from the top of the page to get back
// to where they were. The PANEL takes focus (tabIndex -1), not the first field: Esc is then the first
// key the dialog answers, and nothing lands in the title input by accident.
//
// Safe across the dialog's own swaps. A done card renders TaskDrawerLoading first and TaskDrawer after
// it resolves, and `key={drawerTask.id}` remounts the drawer when you follow a link to another card —
// React runs a commit's cleanups before its effects, so each swap restores to the opener, re-captures
// it, and focuses the new panel, in that order. `isConnected` guards the case where the board's 4s
// refetch has since dropped the opener's row.
function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return ref;
}

// The modal SHELL both drawer placeholders below share (card 230cb6e3 — it was duplicated verbatim in
// each): backdrop, Esc-to-close, click-outside-to-close, and the panel geometry matched to TaskDrawer's
// own, so the dialog never visibly jumps when the real drawer takes its place. Content is centred in a
// column — for the single-child loading state that renders identically to the row layout it replaces,
// and the error state's button pair stacks under its message exactly as before.
function TaskDrawerPlaceholder({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useDialogFocus<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} role="dialog" aria-modal
      style={{ position: "fixed", inset: 0, background: color.scrim, zIndex: 50, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        // outline:none on the PANEL only — it is a programmatic focus target, not a control a user
        // can Tab to, and its own border plus the dimmed backdrop already delimit it. Measured: open
        // a card from the keyboard without this and Chromium paints its UA ring (`auto` 1px) around
        // the whole panel, a bright frame the design never specified and that appears on the keyboard
        // path alone. Nothing a user can reach loses a ring here.
        style={{ outline: "none", width: "min(820px, 92vw)", maxWidth: "100%", minHeight: "min(820px, 85vh)", maxHeight: "88vh",
          background: color.surface, border: `1px solid ${color.line}`, boxShadow: shadow.pop, borderRadius: radius.lg,
          padding: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 10, boxSizing: "border-box" }}>
        {children}
      </div>
    </div>
  );
}

// Shown for the brief window between opening a DONE card (whose body the board list omits) and its lazy
// GET /api/tasks/:id resolving.
function TaskDrawerLoading({ onClose }: { onClose: () => void }) {
  return (
    <TaskDrawerPlaceholder onClose={onClose}>
      <span style={{ color: color.text3, fontSize: fs.sm }}>Loading task…</span>
    </TaskDrawerPlaceholder>
  );
}

// Card 3485a489: the single-task fetch backing a DONE card's drawer (needsBodyFetch above) can fail
// outright — e.g. a remote bind with no route for it — leaving `detail` permanently null. Without this,
// the drawer fell back to TaskDrawerLoading forever with no way out but Escape/click-outside.
function TaskDrawerError({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  return (
    <TaskDrawerPlaceholder onClose={onClose}>
      <span style={{ color: color.danger, fontSize: fs.sm }}>couldn’t load this task</span>
      {/* Kit Buttons, not bare <button>s (card 95eabed1): there is no `color-scheme: dark`, so an
          unstyled button renders the UA's light bevel — two white chips on the Panel. `primary` is the
          recovery action, `default` the dismissal, matching every other action/dismiss pair in the app.
          Both carry the kit's own type, so no inline type overrides remain. */}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={onRetry}>retry</Button>
        <Button onClick={onClose}>close</Button>
      </div>
    </TaskDrawerPlaceholder>
  );
}

// Human-readable repo label for a persisted ship-state (card 1eebc46a) — the SAME repoKey → path
// resolution the Repo picker's own path line already does (below), just against the STAMPED
// `mergedRepoKey` (recorded at merge time) rather than the live edit-in-progress `repoKey` state. A key
// that no longer names a registry entry (removed after the card shipped) reads as "no longer registered"
// rather than silently falling back to primary — same posture as the picker's own `stale` handling.
function shipRepoLabel(mergedRepoKey: string | null | undefined, repos: RepoRegistryEntry[], primaryRepoPath: string): string {
  if (!mergedRepoKey) return primaryRepoPath || "primary";
  const entry = repos.find((r) => r.key === mergedRepoKey);
  return entry ? entry.path : `${mergedRepoKey} — no longer registered`;
}

// Ship-state verification tier (card 52e978ad) — "content" and "pathset" are both real verification (a
// live byte-diff or a gc-surviving path-set digest against the commit's own ancestry); render them with
// the SAME confident tick, never weakened to look like the weaker case. "trailer-only" (pre-fix history —
// the commit predates any content/path check, trailer PRESENCE alone) is the one tier that must NOT read
// as a second confident tick — muted color + a qualifying tooltip suffix, but still shown, never hidden.
// "ledger" (card aa09a59a) is ALSO a confident tick — it names a sha Loom's own merge code
// content-verified at landing time — but still carries its own qualifying suffix (never silently
// bucketed with the unqualified default) since the read-time re-check only re-proves reachability, not
// content, and typically fires once the worker's branch is already gone.
// `null`/undefined (unknown — not yet computed, or a legacy row) reads the same as a confident tick: this
// is the byte-identical default every pre-existing "✓ sha" render already had before this field existed.
function shipVerificationStyle(verification: Task["mergedVerification"]): { color: string; suffix: string } {
  if (verification === "trailer-only") return { color: color.text3, suffix: " (unverified content — pre-dates path-set verification)" };
  if (verification === "ledger") return { color: color.liveFg, suffix: " (verified when Loom landed it; branch since deleted)" };
  return { color: color.liveFg, suffix: "" };
}

// Centered modal detail dialog: view + edit a task's title and description (the `body` field that the
// MCP task tools read/write but the card never showed). Renders as a centered overlay OVER the current
// page — backdrop, ✕, click-outside or Esc closes; keyed by task id so switching cards resets the fields.
// Mirrors the RequestModal chrome (components/requests.tsx) so the task-detail and request-detail
// surfaces feel like one system. zIndex 50 sits BELOW the RequestModal's 60, so a "view ↗" from the
// Linked-requests section opens the request dialog ABOVE this one. Save patches the shared task store,
// then the board refetches. EVERY entry point (a Board card click, the `?task=` deep-link, a Request's
// reverse linked-task chip → /board?task=) funnels through Board's openTaskId state into this one modal.
function TaskDrawer({ task, column, worker, repos, primaryRepoPath, trailersOff, links, linksUnavailable, columns, titleById, cards, onOpenTask, onClose, onSave, saving, saved, saveError, onDismissConflict, onAddChild, onDelete, deleting, deleteError, onMoveLane, moving }:
  { task: Task;
    /** A Save of THIS card made in this session has landed (card f58b1250, audit A-12): the only thing
     *  that may put "saved" beside the button. An untouched card has not been saved. */
    saved: boolean; column: KanbanColumn | null; repos: RepoRegistryEntry[]; primaryRepoPath: string;
    /** The session working this card, if any — the same `workerByTask` pick the board card shows. */
    worker?: SessionListItem;
    /** Card 67c43038 — move this card to another lane NOW (the keyboard twin of dragging it). Not part of
     *  the staged Save: a lane move is the same immediate action the drag already is. */
    onMoveLane: (columnKey: string) => void; moving: boolean;
    /** Whether this project writes NO reserved merge trailers, so a missing landing proves nothing. */
    trailersOff: boolean;
    links: TaskLinks; linksUnavailable: boolean; columns: KanbanColumn[]; titleById: Map<string, string>;
    /** Every card on the loaded board, for the relation picker (card 03d9db6e). */
    cards: PickerCard[]; onOpenTask: (id: string) => void;
    onClose: () => void; onSave: (patch: TaskEditPatch) => void; saving: boolean; saveError: TaskUpdateConflictError | null; onDismissConflict: () => void;
    /** Create a child of this card NOW (card 92259dac). Immediate, like a lane move: not part of the staged Save. */
    onAddChild: (title: string) => Promise<unknown>;
    onDelete: () => void; deleting: boolean; deleteError: string | null }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [priority, setPriority] = useState<TaskPriority>(prio(task));
  const [held, setHeld] = useState<boolean>(task.held ?? false);
  const theme = useResolvedTheme();
  const [deferred, setDeferred] = useState<boolean>(task.deferred ?? false);
  // Which registered repo this card targets. "" = primary. Only editable when the project HAS a
  // registry — see the Repo field below.
  const [repoKey, setRepoKey] = useState<string>(task.repoKey ?? "");
  // Parent (card 1ae4f88c) — keyed by the 8-char prefix the rest of Loom names cards by. It was once the
  // ONE hierarchy write this drawer offered ("no overkill"); card 03d9db6e added the four relation kinds
  // below it, on the owner's own ask. This control is unchanged by that: a typed id/prefix with a named
  // resolution line is still the right affordance for a single-valued field on a board of thousands.
  //
  // NOT seeded into state at mount: `links.parentId` rides on the single-task read, which resolves AFTER
  // this component mounts, so a mount-time initializer captures `null` and never catches up — the field
  // would read "no parent" for a card that has one, and compare as a pending CLEAR. The displayed value
  // falls through to the live server value until the user types; Reset drops back to that fall-through.
  //
  // Collapsed at rest: the open field + resolution line cost ~56px on EVERY drawer for something most
  // cards never set. One line here, editor on demand.
  const [parentDraft, setParentDraft] = useState<string | null>(null);
  const [parentEditing, setParentEditing] = useState(false);
  // Relations (card 03d9db6e) — the SAME fall-through shape as parentDraft above, and for the same
  // reason: `links.relations` rides on the single-task read, which resolves AFTER this component mounts,
  // so a mount-time initializer captures EMPTY arrays and never catches up — every kind would read as
  // empty and compare as a pending CLEAR of every edge on the card. `null` means untouched: the editor
  // is handed `relationBase` until the first edit, which snapshots the draft off it.
  //
  // Once snapshotted, the 4s detail poll no longer moves it. Deliberate: the write is a whole-set
  // replace, so a staged set IS the user's intended set for the kinds they touched — while a kind they
  // never touched is omitted from the patch entirely, so an agent's concurrent write to a DIFFERENT kind
  // still survives their Save.
  const relationBase = useMemo(() => relationBaseline(links), [links]);
  const [relationDraft, setRelationDraft] = useState<RelationDraft | null>(null);
  const relations = relationDraft ?? relationBase;
  const relationsChanged = relationsDirty(relations, relationBase);
  const parentServer = links.parentId ? links.parentId.slice(0, 8) : "";
  const parentInput = parentDraft ?? parentServer;
  const parentRes = resolveParentInput(parentInput, task.id, titleById);
  // The summary's clickable row (card 6ed6d8b2). `parentId` can be set while `parent` is still null — the
  // resolved form is absent for a parent on another project's board, or for one archived since. Falling
  // back to the 8-char handle keeps the row readable AND keeps TaskLinkRow's own not-on-this-board branch
  // the thing that decides clickability, instead of a second guess about it here.
  const parentRef: TaskRef = links.parent
    ?? { id: links.parentId ?? "", title: links.parentId?.slice(0, 8) ?? "", columnKey: "", resolved: false, released: false };
  // Collapse back to the summary once a save actually SUCCEEDS — staying in the editor after a committed
  // write leaves the drawer looking like it still has pending work. Dropping the draft at the same time
  // hands the field back to the server value, which the edit mutation has just invalidated and refetched.
  // Keyed on the saving true→false EDGE with no error, so a FAILED save keeps the editor (and the user's
  // entry) open rather than swallowing it.
  const wasSaving = useRef(false);
  useEffect(() => {
    // The relation draft is dropped on the same edge and for the same reason: the write landed, so the
    // server value it would be diffed against is now the staged value — keeping the draft would leave
    // the dialog looking dirty forever after a successful Save.
    if (wasSaving.current && !saving && !saveError) { setParentDraft(null); setParentEditing(false); setRelationDraft(null); }
    wasSaving.current = saving;
  }, [saving, saveError]);
  // What a Save would actually persist — null clears the parent. `undefined` means "don't touch it": an
  // unresolvable entry must NEVER be read as a clear, which is what sending null on a typo would do. Save
  // is disabled in that state instead (see the button's own `disabled`).
  const parentPatch: string | null | undefined =
    parentRes.state === "empty" ? null : parentRes.state === "ok" ? parentRes.id : undefined;
  const parentChanged = parentPatch !== undefined && parentPatch !== links.parentId;
  const parentBlocked = parentPatch === undefined;
  // This card names a repo the registry no longer has (the entry was removed after the card was written —
  // supported, since removal is only blocked while a live worktree session holds the card). The picker and
  // the path line both have to say so rather than silently reading as primary.
  const stale = !!task.repoKey && !repos.some((r) => r.key === task.repoKey);
  // Two-step delete: a first click arms the confirm so the destructive action can't fire on a single misclick.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dirty = title !== task.title || body !== (task.body ?? "") || priority !== prio(task)
    || held !== (task.held ?? false) || deferred !== (task.deferred ?? false)
    || (repoKey || null) !== (task.repoKey ?? null)
    // An unresolvable parent entry counts as dirty too — it's an edit in progress, so the close guard must
    // still fire rather than letting a typed-but-unsaveable value vanish on Esc.
    || parentChanged || (parentBlocked && parentDraft !== null)
    || relationsChanged;
  // Card 0b36702e: the version this drawer instance actually LOADED — captured ONCE (this initializer
  // runs only at mount, since `key={task.id}` on the caller never remounts this component for the same
  // card), never re-derived from a later prop refresh. This is deliberate: `task` is a prop, so if we
  // read `task.version` again at save time instead of trusting this captured value, a save-time re-read
  // would always match itself and the whole conflict check would be a no-op — exactly the bug this card
  // exists to fix (see §COMPANION in the card body for a shipped specimen of that exact mistake).
  const [loadedVersion, setLoadedVersion] = useState(task.version);
  // Once local edits match the server's last-known row again (a save just completed and the board
  // refetched `task`), adopt its new version as the baseline — this is what lets a SECOND save in the
  // same sitting use the version the FIRST save just produced, instead of spuriously conflicting with
  // its own prior write. Never fires while `dirty` (mid-edit, or sitting on an unresolved conflict whose
  // fields intentionally still differ from the stale `task` prop — see the Reload handler below, which
  // sets loadedVersion directly instead of relying on this effect).
  useEffect(() => {
    if (!dirty) setLoadedVersion(task.version);
  }, [task.version, dirty]);
  // The fresh task the server returned alongside a 409 — null unless the last save attempt conflicted.
  const saveConflict = saveError?.conflict ? (saveError.current ?? null) : null;
  // Where the last refusal belongs on screen (card 03d9db6e). The structure validator names the field or
  // the cycle in the message itself, so a refusal can be shown AT the control that caused it instead of
  // only in the generic line beside Save — a message like "attach it to <id> (its own parent) instead" is
  // actionable, and an actionable message half a panel away from its control reads as a mystery. Every
  // scope it recognises has a home below; `null` (anything it doesn't) still falls through to that line.
  const relationErr = saveError && !saveConflict ? relationErrorTarget(saveError.message) : null;
  // Guard every path OUT of this card against silently discarding unsaved edits. When dirty, the request
  // arms an in-drawer confirm (mirroring the delete two-step) instead of leaving; when clean it leaves
  // immediately, zero extra friction. Two kinds of exit share one pending-nav state so the guard can't be
  // bypassed by the newer one: closing (backdrop / Esc / ✕ → `to: null`) and following a links-block
  // link to ANOTHER card (card 1ae4f88c → `to: <id>`), which unmounts this drawer just as thoroughly.
  // A third kind (card fa4234ab): the Worker row's links leave the board for a route (`route`), which
  // unmounts the whole board, drawer and edits with it.
  const [pendingNav, setPendingNav] = useState<{ to: string | null; route?: string } | null>(null);
  const requestClose = () => { if (dirty) setPendingNav({ to: null }); else onClose(); };
  const panelRef = useDialogFocus<HTMLDivElement>();
  const requestOpen = (id: string) => { if (dirty) setPendingNav({ to: id }); else onOpenTask(id); };
  const navigate = useNavigate();
  const decisions = usePendingDecisionsBySession(); // the Worker row's pill, same reading as the card's
  // The Worker row's links are real anchors (middle-click / new tab still work); only a plain click on a
  // dirty card is held back for the discard confirm.
  const requestRoute = (path: string, e: ReactMouseEvent) => {
    if (!dirty || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setPendingNav({ to: null, route: path });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (dirty) setPendingNav({ to: null }); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  // ── Voice dictation for the Description field (v1: this field only) ───────────────────────────
  // Reuses the same Web Speech recognizer the terminal composer uses (lib/useSpeechRecognition), so
  // there is ONE recording state machine + privacy posture across the app. The transcript is inserted
  // AT THE CARET captured when recording started — interim text shows live and is replaced as it
  // finalizes — so existing description text is never clobbered. Absence/insecure context degrade to a
  // disabled, explained mic button (the recognizer no-ops); the drawer is otherwise untouched.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [voiceLang] = useVoiceLang(); // shared, persisted app-wide language (read-only here)
  // Caret split captured at start: text before/after the insertion point. Insertion grows between them.
  const anchorRef = useRef<{ before: string; after: string } | null>(null);
  const [finals, setFinals] = useState(""); // finalized transcript accrued during the current recording
  const speech = useSpeechRecognition({
    lang: voiceLang,
    onFinalTranscript: (chunk) => {
      const piece = chunk.trim();
      if (!piece) return;
      setFinals((f) => (f ? `${f.replace(/\s+$/, "")} ${piece}` : piece));
    },
  });
  const dictating = speech.status === "listening" || speech.status === "requesting";
  // Compose `before + <finals + live interim> + after` into the field on every recognizer update, and
  // park the caret just past the inserted text so continued dictation reads naturally. Only while a
  // recording is live — outside that, the user owns the textarea (manual edits aren't fought).
  useEffect(() => {
    if (!dictating) return;
    const a = anchorRef.current;
    if (!a) return;
    const live = [finals.trimEnd(), speech.interim.trim()].filter(Boolean).join(" ");
    const lead = a.before && live && !/\s$/.test(a.before) ? " " : "";
    const tail = a.after && live && !/^\s/.test(a.after) ? " " : "";
    const next = a.before + lead + live + tail + a.after;
    setBody(next);
    const caret = a.before.length + lead.length + live.length;
    const ta = bodyRef.current;
    if (ta) requestAnimationFrame(() => { try { ta.setSelectionRange(caret, caret); } catch { /* detached */ } });
  }, [finals, speech.interim, dictating]);
  const startDictation = () => {
    const ta = bodyRef.current;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : body.length;
    anchorRef.current = { before: body.slice(0, caret), after: body.slice(caret) };
    setFinals("");
    speech.start();
  };
  const labelStyle = { fontFamily: font.ui, fontSize: fs.xs, color: color.text2 } as const;

  // ── Connected requests (Dossier right rail, card 8c1f27f0) ──────────────────────────────────────
  // Every Request (pending/answered/consumed) connected to this card. Matches commit 9e5a733's
  // `db.listQuestionsForTask` project+task scoping guard client-side: filter the global inbox
  // (`openQuestions(true)` folds in consumed history) by BOTH `projectId` AND `taskId`, so a foreign-
  // project question that happens to carry this task's id can never leak in (there is no task-scoped REST
  // endpoint — 9e5a733 built the read as MCP tools only; this is the equivalent human/REST read).
  // Since 76b4bdb, `question_ask` stores the RESOLVED FULL task id, so a fresh row always matches the
  // exact `q.taskId === task.id` check below — but a row filed BEFORE that fix landed can still carry a
  // raw 8-char id-PREFIX (`question_ask({taskId: "28f425c2"})`), which never equals the card's full id.
  // The `startsWith` fallback is belt-and-suspenders for those legacy rows (card c089a959).
  const questions = useQuery({ queryKey: ["openQuestions", "history"], queryFn: ({ signal }) => api.openQuestions(true, signal) });
  const linked = (questions.data ?? []).filter(
    (q) => q.projectId === task.projectId && (q.taskId === task.id || (!!q.taskId && task.id.startsWith(`${q.taskId}-`))),
  );
  const hasRequests = linked.length > 0;
  // Per-user COLLAPSED preference, persisted so it survives reopen. Tri-state: `null` = no explicit
  // choice yet → default to expanded when the card HAS connected requests, collapsed when it has none.
  // Once the user toggles, their explicit boolean sticks (localStorage), regardless of the request count.
  const RAIL_KEY = "loom.taskRail.collapsed";
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(() => {
    try { const v = localStorage.getItem(RAIL_KEY); return v === null ? null : v === "1"; } catch { return null; }
  });
  const railCollapsed = collapsedPref ?? !hasRequests;
  // Below 600px a side rail leaves the form ~250px and slices its text (audit B-15), so the requests
  // become a disclosure row above Description instead. Same collapsed preference drives both shapes.
  const narrow = useNarrowViewport(600);
  const toggleRail = () => {
    const next = !railCollapsed;
    setCollapsedPref(next);
    try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch { /* storage may be unavailable */ }
  };

  return (
    <div onClick={requestClose} role="dialog" aria-modal
      style={{ position: "fixed", inset: 0, background: color.scrim, zIndex: 50, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        // outline:none for the same reason as TaskDrawerPlaceholder's panel above — read it there.
        style={{ outline: "none", width: "min(820px, 92vw)", maxWidth: "100%",
          // Grow toward the viewport height on a large window (the flex:1 description below absorbs the
          // extra room and scrolls internally): floor at min(820px, 85vh) — 820px mirrors the width cap
          // and bounds the height on a huge monitor — and cap at 88vh (with the overlay's 6vh top/bottom
          // padding that's an exact fit). Sibling to the width cap.
          //
          // Three bands (card 92259dac, audit B-08): a pinned head (header + discard prompt), ONE scroll
          // region, and a pinned footer. The panel used to scroll as a whole, so on any card taller than
          // the window Save/Reset/Delete sat below the fold and a staged edit had no visible state.
          minHeight: "min(820px, 85vh)", maxHeight: "88vh", overflow: "hidden",
          background: color.surface, border: `1px solid ${color.line}`, boxShadow: shadow.pop,
          borderRadius: radius.lg, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ flexShrink: 0, padding: "16px 16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Dossier header: TASK · id · priority · lane · close. The priority chip reflects the LIVE
            edited priority (updates as you pick below); the lane chip is tinted by the column's role. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SectionLabel style={{ margin: 0 }}>Task · {task.id.slice(0, 8)}</SectionLabel>
          <PriorityChip priority={priority} />
          {/* The lane chip doubles as the "Move to lane" control: a native select, so it is fully keyboard
              operable, tinted on its left edge by the lane's own resolved accent. Moves immediately. */}
          {column && (
            <Select value={column.key} aria-label="Move to lane" title="Move to lane" data-testid="task-move-lane"
              disabled={moving} onChange={(e) => { if (e.target.value !== column.key) onMoveLane(e.target.value); }}
              style={{ width: "auto", padding: "2px 6px", fontSize: fs.sm, fontFamily: font.ui, fontWeight: 600,
                color: labelColorFor(columnAccent(column), theme),
                borderLeft: `3px solid ${columnAccent(column) ?? color.lineStrong}` }}>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Select>
          )}
          {moving && <span style={{ color: color.text3, fontSize: fs.sm }} aria-live="polite">moving…</span>}
          <span style={{ flex: 1 }} />
          <Button onClick={requestClose} title="Close (Esc)">✕</Button>
        </div>
        {/* Unsaved-edit guard: an exit request while dirty arms this confirm instead of discarding. The
            wording names WHICH exit is pending, so "Discard" never looks like it might keep the card open. */}
        {pendingNav && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: radius.base,
            background: color.attnSoft }}>
            <span style={{ flex: 1, color: toneText.attn, fontSize: fs.sm, fontFamily: font.ui }}>
              {pendingNav.route ? "Discard unsaved changes and leave the board?"
                : pendingNav.to ? "Discard unsaved changes and open that card?" : "Discard unsaved changes?"}
            </span>
            <Button variant="danger" onClick={() => {
              const { to, route } = pendingNav;
              if (route) navigate(route); else if (to) onOpenTask(to); else onClose();
            }}>
              {pendingNav.route ? "Discard and leave" : pendingNav.to ? "Discard and open" : "Discard"}
            </Button>
            <Button onClick={() => setPendingNav(null)}>Cancel</Button>
          </div>
        )}
        </div>
        <div data-testid="task-dialog-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          padding: "10px 16px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Card → worker → review (card fa4234ab): who is on this card and the two hops out of it. Only a
            card some session holds renders anything, so an unworked card's dialog is unchanged. */}
        {worker && <CardWorkerRow worker={worker} status={workerStatus(worker, decisions.has(worker.id))}
          onNavigate={requestRoute} />}
        {/* Card policies (card 61d32daf): same register as the links block, and the same two rules — nothing
            renders when no policy applies, and a failed read says so rather than reading as "no policy". */}
        <CardPolicyBlock taskId={task.id} projectId={task.projectId} />
        {/* Dossier body: LEFT = task editing, RIGHT = connected-requests rail. When the rail is collapsed
            the left column expands to full width (single-column); flexWrap lets the two stack on a narrow
            panel. Grows to fill the panel down to its min-height, but never SHRINKS below its content:
            inside the scroll region a shrinking row lets the form overflow it, and the rail stops short. */}
        <div style={{ display: "flex", gap: 14, flex: "1 0 auto", alignItems: "stretch",
          flexWrap: railCollapsed ? "nowrap" : "wrap" }}>
          <div data-testid="task-edit-column" style={{ flex: railCollapsed ? "1 1 auto" : "2 1 360px", minWidth: 0, display: "flex",
            flexDirection: "column", gap: 10, minHeight: 0 }}>
        <span style={labelStyle}>Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        <span style={labelStyle}>Priority</span>
        <div style={{ display: "flex", gap: 4 }}>
          {PRIORITIES.map((p) => {
            const m = PRIORITY_META[p];
            const active = priority === p;
            const c = tone[m.tone];
            return (
              <button key={p} type="button" onClick={() => setPriority(p)} title={m.label}
                style={{
                  flex: 1, cursor: "pointer", fontFamily: font.ui, fontSize: fs.sm, padding: "5px 4px", borderRadius: radius.sm, color: active ? color.bg : c, background: active ? c : "transparent",
                  border: `1px solid ${active ? c : color.line}`,
                }}>
                {m.short} <span style={{ fontSize: fs.xs, opacity: 0.8 }}>{m.label}</span>
              </button>
            );
          })}
        </div>
        {/* ── RELATIONS (card 03d9db6e) — the owner's "UI Features in board card dialog for users to set
            and adjust Task relations". The heading is authored HERE, like every other section label in
            this dialog, so the PARENT control below falls under it: parent is part of the same card
            graph, and leaving it heading-less above the section read as a stray line under PRIORITY.
            Its own control is NOT rebuilt inside the editor — a second parent editor would be a second
            place for the same write to diverge — but since card 6ed6d8b2 this section is the ONE place
            the dialog states the parent at all, so the summary row below is clickable like every chip. */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={labelStyle}>Relations</span>
          <span style={{ fontSize: fs.sm, color: color.text3 }}>
            same board only · staged until you save
          </span>
        </div>
        {/* @decision 230cb6e3 — a failed links read must say so rather than render silently; otherwise
            it's indistinguishable from a card that genuinely has no connections (a false zero). Sits at
            the head of Relations because the parent, the editor and Children all read that same links. */}
        {linksUnavailable && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: color.text3,
            fontSize: fs.sm }}>
            <Dot tone="attn" />
            <span>links unavailable — couldn’t read this card’s connections (retrying…)</span>
          </div>
        )}
        {/* Parent — a card id or any unambiguous PREFIX, empty to clear. A plain field rather than a
            picker: this board runs to thousands of cards, so a <select>/datalist of every one is a DOM
            cost paid on every drawer open for a field most cards never set, and an 8-char prefix is
            already how the owner and every agent name a card. The resolution line is the whole safety
            story — it names the card you actually landed on BEFORE you save, and every failure mode reads
            differently, so "type more characters" is distinguishable from "wrong id". */}
        {parentEditing ? (
          <>
            <span style={labelStyle}>Parent</span>
            <Input value={parentInput} onChange={(e) => setParentDraft(e.target.value)} spellCheck={false}
              autoFocus aria-label="Parent card id" placeholder="card id or 8-char prefix — empty for no parent"
              style={{ width: "100%", boxSizing: "border-box" }} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: -4, minWidth: 0 }}>
              <span data-testid="parent-resolution" style={{ flex: 1, fontSize: fs.sm, minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: parentRes.state === "ok" ? color.text2 : parentRes.state === "empty" ? color.text3 : color.attnText }}
                title={parentRes.state === "ok" ? parentRes.title : undefined}>
                {parentRes.state === "ok" ? `→ ${parentRes.title}`
                  : parentRes.state === "empty" ? "no parent"
                  : parentRes.state === "self" ? "that's this card — a card can't be its own parent"
                  : parentRes.state === "ambiguous" ? `${parentRes.matches} cards start with that — type more characters`
                  : "no card on this board starts with that"}
              </span>
              {/* Cancel, not Reset: this abandons the parent edit alone and re-collapses, leaving any
                  title/priority/description edits in the same drawer untouched. Reset still drops them all. */}
              <Button variant="ghost" style={{ flexShrink: 0, fontSize: fs.sm }}
                onClick={() => { setParentDraft(null); setParentEditing(false); }}>cancel</Button>
            </div>
          </>
        ) : (
          /* At rest: ONE line. Either the resolved parent with edit/clear, or a bare "Set parent…" — so a
             card that will never have a parent costs a single ghost link instead of a labelled field.

             Laid out on `relationGrid` — the SAME grid object the editor's own rows below use, not a
             look-alike — so PARENT's value starts on the same vertical rule as BLOCKED BY's and
             DISCOVERED FROM's. It used to be a plain flex row, which put its value at
             `width("PARENT") + 4` while the editor's values sat at its own auto-sized column + 10:
             two rules ~50px apart in a block that reads as one list of relations. The label column's
             width is the editor's exported constant for the same reason — see RELATION_LABEL_COL. */
          <div data-testid="parent-summary" style={relationGrid}>
            {links.parentId ? (
              <>
                <span style={relationRowLabel}>Parent</span>
                {/* The SAME TaskLinkRow the editor's chips below use, so the parent reads as one of the
                    five relation rows rather than a different kind of thing — and so this dialog's ONLY
                    statement of the parent is the clickable one.

                    @decision 03d9db6e — keep the link's shrink bounded by a MODEST `minWidth` floor and
                    the cell wrapping. Remove either and TaskLinkRow's unshrinkable lane badge plus
                    edit/clear crush the title to four characters at 420px (measured).

                    The wrap happens inside the grid's VALUE cell, not across the whole row, so a
                    wrapped edit/clear lands under the name rather than under the label. */}
                <div data-testid="parent-summary-value" style={{ display: "flex", alignItems: "center",
                  flexWrap: "wrap", columnGap: 4, rowGap: 2, minWidth: 0 }}>
                  <span style={{ flexGrow: 0, flexShrink: 1, flexBasis: "auto", minWidth: 140,
                    maxWidth: "100%", display: "flex" }}>
                    <TaskLinkRow ref_={parentRef} columns={columns} titleById={titleById}
                      onOpenTask={requestOpen} glyph="↳" />
                  </span>
                  <Button variant="ghost" style={{ flexShrink: 0, fontSize: fs.sm }} aria-label="Change parent"
                    onClick={() => setParentEditing(true)}>edit</Button>
                  {/* Clear STAGES the change (empties the field and opens the editor) rather than saving on
                      the spot — every other field in this drawer persists on Save, and a one-click write
                      hiding among staged ones is exactly the inconsistency that makes Save untrustworthy. */}
                  <Button variant="ghost" style={{ flexShrink: 0, fontSize: fs.sm }} aria-label="Clear parent"
                    onClick={() => { setParentDraft(""); setParentEditing(true); }}>clear</Button>
                </div>
              </>
            ) : (
              // No parent yet: the ghost link spans BOTH grid columns, so it keeps sitting on the dialog's
              // own left rule (TITLE/PRIORITY/HOLD) rather than being indented into the value column —
              // there is no label beside it to align to. The negative margin cancels the button's own left
              // padding so its text, not its hover fill, is what lands on that rule.
              <div style={{ gridColumn: "1 / -1" }}>
                <Button variant="ghost" style={{ fontSize: fs.sm, padding: "2px 6px", marginLeft: -6 }}
                  onClick={() => { setParentDraft(""); setParentEditing(true); }}>Set parent…</Button>
              </div>
            )}
          </div>
        )}
        {/* A parentId refusal the client could not have caught — the depth cap, or a parent on another
            project's board. The resolution line above only ever speaks for what THIS board can resolve,
            so a server refusal needs its own line here rather than the footer's generic one. */}
        {relationErr?.scope === "parent" && saveError && (
          <span role="alert" data-testid="parent-server-error"
            style={{ fontSize: fs.sm, color: color.danger, lineHeight: 1.4, marginTop: -4 }}>
            {saveError.message}
          </span>
        )}
        {/* The four kinds this card can write about ITSELF, staged onto the same Save as every other
            field here. The read-only links block above keeps what it CANNOT (children's parentage lives
            on the child; `discoveries` is the inverse of another card's `discoveredFrom`). A server
            refusal is placed at the row — or, for a cycle, the section — it names, rather than only in
            the generic line beside Save: see relationErrorTarget, which decides placement, never wording. */}
        <TaskRelationsEditor selfId={task.id} links={links} draft={relations} baseline={relationBase}
          cards={cards} columns={columns} titleById={titleById}
          saveErrorMessage={saveError && !saveConflict ? saveError.message : null}
          onChange={setRelationDraft} onOpenTask={requestOpen} />
        {/* Card-context block: the children, and the relations this card cannot write about itself (the
            writable kinds and the parent live in the editor above — see hasTaskContextLinks for why the
            gate moved with them).

            @decision 1ae4f88c — reserves no loading placeholder: that would flash an empty panel on every
            open for the common case of a card with no links. Placed after Relations since card 92259dac
            (audit I-01), so the dialog reads Title, Priority, then the card graph. */}
        {hasTaskContextLinks(links) && (
          <TaskLinksBlock links={links} columns={columns} titleById={titleById} onOpenTask={requestOpen} />
        )}
        <AddChildCard onAdd={onAddChild} />
        {/* Target repo (multi-repo epic 49136451, phase 3). Rendered ONLY when the project has a
            registry — a single-repo project's drawer is byte-identical to before. Shows the RESOLVED
            absolute path of whatever is currently selected, which is the thing a human actually needs to
            confirm ("is this landing where I think it is") and is why this reads as a target, not a
            state toggle. Retargeting is guarded server-side: it FAILS CLOSED while any session ever
            bound to this card still holds a worktree or an undeleted branch, because the worktree is
            physically rooted in the repo it was cut from — that 400 surfaces verbatim next to Save. */}
        {repos.length > 0 && (
          <>
            <span style={labelStyle}>Repo</span>
            <Select value={repoKey} onChange={(e) => setRepoKey(e.target.value)} aria-label="Target repo"
              style={{ width: "100%", boxSizing: "border-box" }}>
              <option value="">primary</option>
              {repos.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
              {/* A card can outlive the registry entry it targets (removing an entry is allowed once no
                  live worktree session holds the card). Without an option matching that key the Select
                  falls back to rendering the FIRST option — so it would read "primary" while the card
                  actually targets `site`, i.e. the control would state the opposite of the truth. Carry
                  an explicit option for the orphaned key instead, labelled for what it is; the path line
                  below says the same thing in words. Selecting anything else is a real retarget and
                  validates normally. */}
              {stale && <option value={task.repoKey!}>{task.repoKey} — no longer registered</option>}
            </Select>
            {/* flexShrink:0 is load-bearing, not defensive: this span sets `overflow: hidden` for the
                ellipsis, which removes the automatic min-height floor a flex item normally gets — so in
                this overflowing flex column it was being crushed to ZERO height and the path never
                rendered at all (caught by eyeballing it; the DOM node was present the whole time). */}
            <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3, marginTop: -4, flexShrink: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={repoKey ? (repos.find((r) => r.key === repoKey)?.path ?? "") : primaryRepoPath}>
              {repoKey ? (repos.find((r) => r.key === repoKey)?.path ?? "unknown repo — this key is no longer registered") : (primaryRepoPath || "the project's primary repo")}
            </span>
          </>
        )}
        {/* Ship-state (card 1eebc46a) — read-only: which commit this card's work landed as, and which
            repo it landed ON (not just which repo the card TARGETS, above). Persisted at merge-confirm
            time (or lazily backfilled on this drawer's first open for a card that shipped before this
            existed); null on a card that hasn't merged yet, so nothing renders for the common case. */}
        {task.mergedSha && (
          <>
            <span style={labelStyle}>Shipped</span>
            <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: shipVerificationStyle(task.mergedVerification).color }}
              title={`Landed on ${shipRepoLabel(task.mergedRepoKey, repos, primaryRepoPath)}${task.mergedDate ? ` — ${task.mergedDate}` : ""}${shipVerificationStyle(task.mergedVerification).suffix}`}>
              ✓ {task.mergedSha} <span style={{ color: color.text3 }}>on</span> {shipRepoLabel(task.mergedRepoKey, repos, primaryRepoPath)}
            </span>
          </>
        )}
        {/* Card bd828fb3 — with `orchestration.commitTrailers: "off"` this project writes no Loom-*
            trailer paragraph, so Loom's retroactive merge discovery has nothing to read: a card with no
            recorded landing is UNKNOWN, not unshipped. Says so in the ship-state slot the Shipped line
            above would occupy, in the same muted-value + qualifying-tooltip shape shipVerificationStyle
            already uses for its weakest tier — the alternative is a reader taking a blank as a negative.
            Only ever INSTEAD of a real landing: a recorded mergedSha came from Loom's own DB write, which
            is unaffected by the trailer switch, so that line stays authoritative and unqualified. */}
        {!task.mergedSha && trailersOff && (
          <>
            <span style={labelStyle}>Shipped</span>
            <span data-testid="ship-state-trailers-off" title={SHIP_STATE_TRAILERS_OFF.title}
              style={{ fontSize: fs.sm, color: color.text3 }}>
              {SHIP_STATE_TRAILERS_OFF.value}
            </span>
          </>
        )}
        {/* Owner HOLD gate — the SOLE human brake (Board Hold Model): held=true means this card won't be
            worked (spawnWorker refuses to dispatch onto it) AND won't nag (excluded from the idle-watcher's
            actionable count) — in whatever column it sits. Distinct from priority/column — an owner-only
            "don't touch this" signal. Persisted on the same task store the MCP tools read.
            The manager DEFERRED marker beside it is orthogonal: a manager's own sequencing signal (won't
            nag the idle watchdog) that, UNLIKE Hold, never blocks worker_spawn.
            One row of two switches since card 92259dac (audit I-02): the two boxed full-width rows cost
            ~130px above the description for two booleans. The state text IS each switch's label. */}
        <div role="group" aria-label="Card state" data-testid="task-state-toggles"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <StateSwitch on={held} onToggle={() => setHeld((h) => !h)}
            ariaLabel="Held — won't be worked or nagged"
            title={held
              ? "Held — won't be worked or nagged. No worker will be dispatched onto this card and the idle watchdog won't nag about it. Click to release."
              : "Not held — click to hold this card so it won't be worked or nagged."}
            label={held ? "⏸ Held — won't be worked or nagged" : "Not held"} />
          <StateSwitch on={deferred} onToggle={() => setDeferred((d) => !d)}
            ariaLabel="Deferred — sequencing marker, won't nag"
            title={deferred
              ? "Deferred — your own sequencing marker; won't nag the idle watchdog, but a worker can still be dispatched onto it. Click to un-defer."
              : "Not deferred — click to defer this card as your own sequencing marker (not a brake)."}
            label={deferred ? "Deferred — sequencing marker, won't nag" : "Not deferred"} />
        </div>
        {/* Narrow viewport: the connected requests as a disclosure row here instead of a side rail. */}
        {narrow && (railCollapsed
          ? <RequestsDisclosureRow count={linked.length} onExpand={toggleRail} />
          : <ConnectedRequestsRail linked={linked} onCollapse={toggleRail} inline />)}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...labelStyle, flex: 1 }}>Description</span>
          <DescriptionMic speech={speech} dictating={dictating} onStart={startDictation} />
        </div>
        <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false}
          placeholder="No description yet — agents fill this in via the task tools, or write one here."
          style={{
            flex: 1, minHeight: 200, width: "100%", boxSizing: "border-box", resize: "none",
            fontSize: fs.body, lineHeight: 1.5,
            background: color.inset, color: color.text, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8,
          }} />
        {speech.supported && <DescriptionVoiceNote speech={speech} />}
          </div>
          {/* RIGHT rail — the card's connected requests (card 8c1f27f0). Collapsed → a slim, clickable
              strip so the left editing column takes the full width; expanded → the full dossier rail.
              Wide viewports only: below 600px the same requests render inline above Description. */}
          {!narrow && (railCollapsed
            ? <CollapsedRequestsStrip count={linked.length} onExpand={toggleRail} />
            : <ConnectedRequestsRail linked={linked} onCollapse={toggleRail} />)}
        </div>
        </div>
        {/* Pinned footer (card 92259dac, audit B-08): Save, Reset, the unsaved/saved state and Delete stay
            in view however long the card is. Errors and the conflict prompt wrap onto their own row
            (`order: 1`) so they never push Delete off its right edge. */}
        <div data-testid="task-dialog-footer" style={{ flexShrink: 0, display: "flex", alignItems: "center",
          flexWrap: "wrap", gap: 8, padding: "10px 16px", borderTop: `1px solid ${color.line}`,
          background: color.surface }}>
          {/* `repoKey` rides along ONLY when it actually changed. Both write paths validate an explicit
              repoKey against the CURRENT registry BEFORE their no-op exemption applies, so sending it
              unconditionally made a card whose key was later de-registered un-saveable for EVERY field —
              a pure title edit would 400 with `repoKey "site" does not name a registered repo`. Registry
              removal is supported whenever no live worktree session holds the card, so that state is
              reachable, not hypothetical. Omitting an unchanged key matches the exemption the server
              already models, and leaves retargeting (the only case that SHOULD be validated) untouched. */}
          {/* `parentBlocked` blocks the save outright rather than dropping the field: the alternative is
              saving the OTHER fields while silently discarding a parent the user clearly meant to set,
              which reads as "Save didn't work" with no explanation. The resolution line above already says
              what's wrong with it. */}
          <Button variant="primary" disabled={!dirty || saving || parentBlocked} onClick={() => onSave({
            title, body, priority, held, deferred,
            ...(repoKey !== (task.repoKey ?? "") ? { repoKey: repoKey || null } : {}),
            // `parentId` rides along ONLY when it actually changed — same rule as repoKey above, and the
            // same reason generalized: an unchanged field that the daemon may not know about yet must not
            // be sent at all, so this drawer keeps saving cleanly against a daemon without the hierarchy
            // write route (card 3df86c87) as long as nobody touches the Parent field.
            ...(parentChanged ? { parentId: parentPatch } : {}),
            // Only the relation kinds that actually CHANGED (card 03d9db6e) — same omit-an-untouched-field
            // rule as repoKey/parentId above, and load-bearing here rather than merely tidy: each kind is
            // a whole-set replace, so echoing an untouched one back would re-declare a `released:true`
            // edge the baseline deliberately dropped.
            ...relationPatch(relations, relationBase),
            // baseVersion (card 0b36702e): the version THIS drawer loaded, never re-fetched at save time —
            // see loadedVersion's own doc above for why that distinction is the entire fix.
            baseVersion: loadedVersion,
          })}>{saving ? "Saving…" : "Save"}</Button>
          {dirty
            ? <Button onClick={() => { setTitle(task.title); setBody(task.body ?? ""); setPriority(prio(task)); setHeld(task.held ?? false); setDeferred(task.deferred ?? false); setRepoKey(task.repoKey ?? ""); setParentDraft(null); setParentEditing(false); setRelationDraft(null); }}>Reset</Button>
            : saved && <span data-testid="task-dialog-saved" style={{ color: color.liveFg, fontSize: fs.sm }}>saved</span>}
          {dirty && (
            <span data-testid="task-dialog-unsaved" aria-live="polite"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, color: color.attnText, fontSize: fs.sm }}>
              <Dot tone="attn" />Unsaved changes
            </span>
          )}
          {/* The catch-all failure line. A refusal the Relations section has already placed at the row
              (or section) it names is suppressed HERE rather than printed twice — one message, shown at
              the control the human has to go fix. `relationErrorTarget` returning null (anything it does
              not recognise) falls through to this line, so nothing is ever swallowed. */}
          {saveError && !saveConflict && !relationErr && (
            <span role="alert" style={{ fontSize: fs.sm, color: color.danger, lineHeight: 1.4, flex: "1 1 100%", order: 1 }}>{saveError.message}</span>
          )}
          {/* Card 0b36702e's "detect-and-warn" remedy: a stale save doesn't clobber — it surfaces the fresh
              server row and lets the human choose. Reload adopts the fresh row (discarding local edits) and
              re-arms the baseline for a clean re-save; Overwrite anyway keeps the local edits and re-saves
              WITHOUT baseVersion, the human's explicit override (same blind write the route always did
              before this card — see api.updateTask's own doc for why omitting it means "write blind"). */}
          {saveConflict && (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 100%", order: 1,
              flexWrap: "wrap", padding: "6px 8px", borderRadius: radius.sm, background: color.inset, border: `1px solid ${color.attn}` }}>
              <span style={{ flex: 1, color: color.attnText, fontSize: fs.sm }}>
                This card changed while you had it open — reload to see the latest, or overwrite anyway.
              </span>
              <Button onClick={() => {
                setTitle(saveConflict.title); setBody(saveConflict.body ?? "");
                setPriority(prio(saveConflict)); setHeld(saveConflict.held ?? false);
                setDeferred(saveConflict.deferred ?? false); setRepoKey(saveConflict.repoKey ?? "");
                setParentDraft(null); setParentEditing(false); setRelationDraft(null);
                setLoadedVersion(saveConflict.version);
                onDismissConflict();
              }}>Reload</Button>
              <Button variant="danger" disabled={parentBlocked} onClick={() => onSave({
                title, body, priority, held, deferred,
                ...(repoKey !== (task.repoKey ?? "") ? { repoKey: repoKey || null } : {}),
                ...(parentChanged ? { parentId: parentPatch } : {}),
                ...relationPatch(relations, relationBase),
              })}>Overwrite anyway</Button>
            </div>
          )}
          {/* Destructive delete, pushed to the right and visually separated from Save. Two-step confirm. */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {confirmingDelete ? (
              <>
                <span style={{ color: color.danger, fontSize: fs.sm }}>Delete?</span>
                <Button variant="danger" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : "Confirm"}</Button>
                <Button disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingDelete(true)}>Delete</Button>
            )}
          </div>
          {/* The server's live-session guard (or any failure) surfaces here rather than silently closing. */}
          {deleteError && <span role="alert" style={{ color: color.danger, fontSize: fs.sm, flex: "1 1 100%", order: 1 }}>{deleteError}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Lanes past the grid's edges (card c315f579) ──────────────────────────────────────────────────
// Seven lanes at their floor are wider than most windows, and the grid's own scrollbar sits below the
// fold, so the lanes behind an edge were simply invisible. This reads which lanes are cut off on each
// side, live: on scroll, and whenever the grid or any lane changes size (a resize, a collapse). The
// result drives the edge fade (data-more-* on the grid) and the "N more lanes" chips.
const LANE_FADE_AFTER = 48;
const LANE_FADE_BEFORE = 32;
// Each lane's span in the grid's SCROLL coordinates (what scrollLeft is measured in).
const laneSpans = (grid: HTMLElement): LaneSpan[] => {
  const origin = grid.getBoundingClientRect().left + grid.clientLeft - grid.scrollLeft;
  return [...grid.querySelectorAll<HTMLElement>(":scope > [data-lane-key]")].map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.laneKey!, left: r.left - origin, right: r.right - origin };
  });
};
function useLaneOverflow(gridRef: React.RefObject<HTMLDivElement | null>, layoutKey: string): LaneOverflow {
  const [o, setO] = useState<LaneOverflow>({ before: [], after: [] });
  // Layout effect: the first read lands before paint, so the chip row doesn't pop in a frame late.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const read = () => {
      const next = laneOverflow(laneSpans(grid), grid.scrollLeft, grid.scrollLeft + grid.clientWidth);
      setO((p) => (p.before.join() === next.before.join() && p.after.join() === next.after.join() ? p : next));
    };
    read();
    grid.addEventListener("scroll", read, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    ro?.observe(grid);
    for (const el of grid.querySelectorAll(":scope > [data-lane-key]")) ro?.observe(el);
    return () => { grid.removeEventListener("scroll", read); ro?.disconnect(); };
  }, [gridRef, layoutKey]);
  return o;
}

// The chip on an edge with lanes behind it: says how many, names them in its tooltip, and scrolls the
// nearest one fully into view. Lanes are never hidden by this, only reached.
/** The one-time keyboard hint for the lane grid (card 78eaac95). `x`, not Space, selects: Space opens a
 *  card exactly as Enter does (19074e42's record). Pointer events off, so it never takes a click. */
function BoardNavHint() {
  return (
    <div className="loom-board-navhint" data-testid="board-nav-hint">
      <span className="loom-board-navhint-keys"><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd></span> move
      <span className="loom-board-navhint-sep">·</span><kbd>Enter</kbd> opens
      <span className="loom-board-navhint-wide"><span className="loom-board-navhint-sep">·</span><kbd>X</kbd> selects</span>
    </div>
  );
}

function LaneOverflowChip({ side, keys, columns, gridRef }:
  { side: "before" | "after"; keys: string[]; columns: KanbanColumn[]; gridRef: React.RefObject<HTMLDivElement | null> }) {
  if (keys.length === 0) return null;
  const names = keys.map((k) => columns.find((c) => c.key === k)?.label ?? k);
  const n = keys.length;
  const text = side === "after" ? `${n} more ${n === 1 ? "lane" : "lanes"} →` : `← ${n} ${n === 1 ? "lane" : "lanes"}`;
  const scroll = () => {
    const grid = gridRef.current;
    if (!grid) return;
    const to = scrollTargetFor(laneSpans(grid), grid.scrollLeft, grid.scrollLeft + grid.clientWidth, side,
      side === "after" ? LANE_FADE_AFTER : LANE_FADE_BEFORE);
    if (to === null) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    grid.scrollTo({ left: to, behavior: reduce ? "auto" : "smooth" });
  };
  const label = `Scroll ${side === "after" ? "right" : "left"} to ${n === 1 ? "the" : n} ${n === 1 ? "lane" : "lanes"} out of view: ${names.join(", ")}`;
  return (
    <button type="button" className="loom-lane-more-chip" data-testid={`lane-overflow-${side}`} data-count={n}
      aria-label={label} title={names.join(", ")} onClick={scroll}>
      {text}
    </button>
  );
}

// Below `px` wide? Live, via matchMedia, so a rotate or resize re-lays the dialog without a reopen.
function useNarrowViewport(px: number): boolean {
  const query = `(max-width: ${px - 1}px)`;
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

// One of the dialog's two state switches (Hold, Defer). Sized to its label, so the pair shares a row.
function StateSwitch({ on, onToggle, ariaLabel, title, label }:
  { on: boolean; onToggle: () => void; ariaLabel: string; title: string; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={ariaLabel} title={title} onClick={onToggle}
      className="loom-toggle"
      style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left",
        minHeight: 32, padding: "5px 10px 5px 8px", borderRadius: radius.sm, background: color.inset,
        border: `1px solid ${on ? color.lineStrong : color.line}`, color: on ? color.text : color.text2 }}>
      <span aria-hidden style={{ width: 30, height: 16, borderRadius: radius.pill, flexShrink: 0, position: "relative",
        background: on ? color.text3 : color.line, transition: "background 0.12s" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 12, height: 12, borderRadius: radius.pill,
          background: color.bg, transition: "left 0.12s" }} />
      </span>
      <span style={{ fontSize: fs.sm }}>{label}</span>
    </button>
  );
}

// "+ Add child card" (card 92259dac, audit G-03). Creates the card at once with `parentId` set, rather
// than staging it on Save: a new card is a create, like a lane move, not an edit of this one. The field
// stays open after an add so an epic can be decomposed in one sitting.
function AddChildCard({ onAdd }: { onAdd: (title: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const close = () => { setOpen(false); setTitle(""); setError(null); };
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try { await onAdd(t); setTitle(""); setAdded(t); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  if (!open) {
    return (
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <Button variant="ghost" data-testid="add-child-open" style={{ fontSize: fs.sm, padding: "2px 6px", marginLeft: -6 }}
          onClick={() => { setOpen(true); setAdded(null); }}>+ Add child card</Button>
      </div>
    );
  }
  return (
    <div data-testid="add-child" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus disabled={busy}
          aria-label="New child card title" placeholder="Child card title"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void submit(); }
            // Close only this field, never the dialog: the dialog's Esc listener is a native `window`
            // handler, which React's synthetic stopPropagation does not reach.
            if (e.key === "Escape") { e.nativeEvent.stopPropagation(); close(); }
          }}
          style={{ flex: "1 1 220px", minWidth: 0 }} />
        <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
          {busy ? "Adding…" : "Add child"}</Button>
        <Button variant="ghost" style={{ fontSize: fs.sm }} onClick={close}>cancel</Button>
      </div>
      <span aria-live="polite" style={{ fontSize: fs.sm, lineHeight: 1.4,
        color: error ? color.danger : color.text3 }}>
        {error ?? (added ? `Added "${added}" to Inbox` : "Lands in Inbox as a child of this card")}
      </span>
    </div>
  );
}

// ── Connected-requests rail (Dossier RIGHT column, card 8c1f27f0) ─────────────────────────────────
// The expanded rail: header (title + count + collapse control), a by-state summary line, then one
// signal row per connected request — the same visual language as the Requests inbox (components/
// requests.tsx): a 3px left edge signed by the type's color, a bordered type tag + lifecycle state
// chip, the title, and the asking-agent/time meta. Each row inline-expands to its recorded answer.
function ConnectedRequestsRail({ linked, onCollapse, inline = false }:
  { linked: QuestionInboxItem[]; onCollapse: () => void;
    /** Narrow viewport: rendered full-width in the form, not beside it, so it collapses UP (▾), not right. */
    inline?: boolean }) {
  const now = Date.now();
  const pending = linked.filter((q) => q.state === "pending").length;
  const answered = linked.filter((q) => q.state === "answered").length;
  const consumed = linked.filter((q) => q.state === "consumed").length;
  const cancelled = linked.filter((q) => q.state === "cancelled").length;
  // Card 59fa6403 — a notice (web twin of mcp/tasks.ts's summarizeTaskRequests) gets its OWN bucket here
  // too, for the same reason: it's state-distinct from pending/answered/consumed/cancelled, and folding
  // it into any of those would make this line's counts stop summing to `linked.length`.
  const notices = linked.filter((q) => q.state === "notice").length;
  return (
    <div data-testid="task-requests-rail"
      style={{ ...(inline ? { flexShrink: 0, maxHeight: 320 } : { flex: "1 1 280px", minWidth: 240 }),
        maxWidth: "100%", display: "flex", flexDirection: "column",
        minHeight: 0, background: color.inset, border: `1px solid ${color.line}`, borderRadius: radius.base }}>
      {/* Header (pinned) — title + count + collapse control. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 8px", borderBottom: `1px solid ${color.line}` }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text2 }}>
          Connected requests
        </span>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, fontWeight: 700, color: linked.length > 0 ? color.text2 : color.text3 }}>{linked.length}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCollapse} aria-expanded aria-label="Collapse connected requests"
          title="Collapse the requests rail" data-testid="task-requests-collapse" className="loom-toggle"
          style={{ background: "transparent", border: "none", cursor: "pointer", color: color.text2,
            fontSize: fs.lg, lineHeight: 1, padding: "2px 4px", borderRadius: radius.sm }}>{inline ? "▴" : "›"}</button>
      </div>
      {linked.length === 0 ? (
        // Empty state — reads as intentional, not broken. (A card with no requests defaults to collapsed,
        // but the user can still expand the empty rail.)
        <div style={{ padding: "14px 10px", color: color.text3, fontSize: fs.sm, lineHeight: 1.5 }}>
          No requests connected to this card yet. A manager links owner Requests to a card so the answer travels with the work.
        </div>
      ) : (
        <>
          {/* By-state summary line. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap",
            fontSize: fs.sm, color: color.text3, borderBottom: `1px solid ${color.line}` }}>
            <span style={{ color: pending > 0 ? color.attnText : color.text3 }}>{pending} pending</span>
            <span aria-hidden>·</span>
            <span>{answered} answered</span>
            <span aria-hidden>·</span>
            <span>{consumed} consumed</span>
            {cancelled > 0 && <><span aria-hidden>·</span><span style={{ color: color.danger }}>{cancelled} cancelled</span></>}
            {notices > 0 && <><span aria-hidden>·</span><span>{notices} notice{notices === 1 ? "" : "s"}</span></>}
          </div>
          {/* Signal rows — the lone scroll region so the header + summary stay pinned. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 10 }}>
            {linked.map((q) => <ConnectedRequestRow key={q.id} q={q} now={now} />)}
          </div>
        </>
      )}
    </div>
  );
}

// One connected-request signal row. The header (type tag · state chip · title · agent/time meta) toggles
// an inline answer readout; "Open request ↗" opens the shared Request detail modal for the full view.
function ConnectedRequestRow({ q, now }: { q: QuestionInboxItem; now: number }) {
  const openRequest = useOpenRequest();
  // @decision b472645a — in a dev install's "View as: End-user" Platform preview this rail renders the
  // PREVIEWED home's own requests, and opening one reaches writes that act on that home's session; the
  // button must be held there (card edfd8295).
  //
  // Read from the context, not a prop: this row is three hops inside a component with five mount sites,
  // only one of which is the preview — `lib/previewOnly.tsx` has the full reasoning, including why the
  // writes themselves (the app-root modal) are out of any prop's reach. This is the VISIBLE half of the
  // gate; `useOpenRequest` is itself inert under the same context, so a `disabled` lost in a later
  // tidy-up re-opens nothing — it only costs the user the explanation.
  const previewOnly = usePreviewOnly();
  const [open, setOpen] = useState(false);
  const edge = tone[REQUEST_TYPE_TONE[q.type]];
  return (
    <div style={{ border: `1px solid ${color.line}`, borderLeft: `3px solid ${edge}`, borderRadius: radius.sm, background: color.surface }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? "Hide the answer" : "Show the answer"} className="loom-toggle"
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4, borderRadius: radius.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <RequestTypeTag type={q.type} />
          <DecisionStateChip q={q} now={now} />
          <span aria-hidden style={{ marginLeft: "auto", color: color.text3, fontSize: fs.sm, flexShrink: 0,
            transition: "transform 120ms ease", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        </div>
        <span style={{ fontSize: fs.sm, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
        <span style={{ fontSize: fs.sm, color: color.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <RequestProvenance q={q} compact /> · {relativeAge(q.state === "pending" ? q.createdAt : q.state === "cancelled" ? q.cancelledAt : q.answeredAt, now)}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${color.line}`, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <ConnectedRequestAnswer q={q} />
          <Button variant="ghost" disabled={previewOnly} onClick={() => openRequest(q.id)}
            title={previewOnly ? PREVIEW_REQUEST_HELD_TITLE : "Open the full request"}
            style={{ padding: "0 6px", alignSelf: "flex-start" }}>Open request ↗</Button>
        </div>
      )}
    </div>
  );
}

// The inline-expanded answer for a connected request. Mirrors requests.tsx › AnsweredReadout: a credential
// NEVER shows a value — only the ack + the target env var (the read tool never returns a secret). A pending
// request has no answer yet, so it shows the ask body + a type-colored "needs …" hint instead.
function ConnectedRequestAnswer({ q }: { q: QuestionInboxItem }) {
  if (q.state === "pending") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {q.body && <span style={{ fontSize: fs.sm, color: color.text2, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{q.body}</span>}
        <span style={{ fontSize: fs.sm, color: tone[REQUEST_TYPE_TONE[q.type]] }}>{requestHint(q)} · awaiting your answer</span>
      </div>
    );
  }
  if (q.state === "cancelled") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: fs.sm, color: color.danger }}>cancelled · never answered</span>
        <span style={{ fontSize: fs.sm, color: color.text2, whiteSpace: "pre-wrap" }}>
          {q.cancelledReason ?? "no reason given"} · by {q.cancelledBy === "agent" ? "the asking agent" : "a human"}
        </span>
      </div>
    );
  }
  if (q.state === "notice") {
    // Mirrors requests.tsx's AnsweredReadout: a notice was never answered — show the body (the FYI
    // content) under its own label, never fall through to the generic decision/input "chose …/note"
    // rendering below, which would show a misleading "—" (a notice never carries chosenOption/note).
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: fs.sm, color: color.text2 }}>FYI · no answer needed</span>
        {q.body && <span style={{ fontSize: fs.sm, color: color.text, whiteSpace: "pre-wrap" }}>{q.body}</span>}
      </div>
    );
  }
  if (q.type === "credential") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: fs.sm, color: color.text2 }}>provided · encrypted, never shown</span>
        {q.credentialEnvVar && (
          <span style={{ fontSize: fs.sm, color: color.text3 }}>
            target env var: <span style={{ color: color.text2, fontFamily: font.mono }}>{q.credentialEnvVar}</span>
          </span>
        )}
      </div>
    );
  }
  if (q.type === "permission") {
    const authorized = q.chosenOption === "authorize";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: fs.sm, color: authorized ? color.liveFg : color.danger }}>{authorized ? "authorized" : "denied"}</span>
        {q.note && <span style={{ fontSize: fs.sm, color: color.text2, whiteSpace: "pre-wrap" }}>{q.note}</span>}
      </div>
    );
  }
  // decision / input — chosen option + note (the note IS the answer for a note-only ask).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {q.chosenOption && <span style={{ fontSize: fs.sm, color: color.text }}>chose <span style={{ color: color.text2 }}>{q.chosenOption}</span></span>}
      {q.note && <span style={{ fontSize: fs.sm, color: color.text2, whiteSpace: "pre-wrap" }}>{q.note}</span>}
      {!q.chosenOption && !q.note && <span style={{ color: color.text3, fontSize: fs.sm }}>—</span>}
    </div>
  );
}

// The COLLAPSED connected-requests rail: a slim, full-height vertical strip pinned to the modal's right
// edge. Clicking it re-expands the rail; while collapsed the left editing column takes the full width.
// Keeps the requests DISCOVERABLE (a count badge) without spending horizontal room.
function CollapsedRequestsStrip({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" onClick={onExpand} aria-expanded={false} aria-label={`Expand connected requests (${count})`}
      title="Expand connected requests" data-testid="task-requests-collapsed"
      style={{ flex: "0 0 auto", alignSelf: "stretch", width: 36, display: "flex", flexDirection: "column",
        alignItems: "center", gap: 10, padding: "10px 0", cursor: "pointer",
        background: color.inset, border: `1px solid ${color.line}`, borderRadius: radius.base }}>
      <span aria-hidden style={{ color: color.text2, fontSize: fs.body, lineHeight: 1 }}>‹</span>
      <span aria-hidden style={{ fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, writingMode: "vertical-rl" }}>
        Inbox
      </span>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, fontWeight: 700, color: count > 0 ? color.text2 : color.text3 }}>{count}</span>
    </button>
  );
}

// The narrow-viewport twin of CollapsedRequestsStrip (card 92259dac, audit B-15): one full-width
// disclosure row above Description instead of a 36px rail that leaves the form too narrow to read.
function RequestsDisclosureRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" onClick={onExpand} aria-expanded={false} aria-label={`Expand connected requests (${count})`}
      data-testid="task-requests-disclosure" className="loom-toggle"
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 36, padding: "6px 10px",
        cursor: "pointer", textAlign: "left", background: color.inset, border: `1px solid ${color.line}`,
        borderRadius: radius.base, color: color.text2 }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700 }}>Connected requests</span>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, fontWeight: 700, color: count > 0 ? color.text2 : color.text3 }}>{count}</span>
      <span aria-hidden style={{ marginLeft: "auto", fontSize: fs.body, lineHeight: 1 }}>▾</span>
    </button>
  );
}

// Click-only mic toggle beside the Description label. Idle → click to dictate; listening → red pulse +
// click to stop. Always rendered (so the capability is discoverable) but disabled — with an explaining
// tooltip — when the browser lacks the Web Speech API (e.g. Firefox) or the page isn't a secure context.
function DescriptionMic({ speech, dictating, onStart }:
  { speech: SpeechRecognitionApi; dictating: boolean; onStart: () => void }) {
  const listening = speech.status === "listening";
  const requesting = speech.status === "requesting";
  const disabled = !speech.supported || !speech.secure || requesting;
  const title = !speech.supported
    ? "Voice dictation isn't available in this browser — try Chrome"
    : !speech.secure
      ? "Voice dictation needs a secure context (https or localhost)"
      : listening
        ? "Stop dictation"
        : "Dictate into the description — the transcript inserts at the caret (review before saving)";
  return (
    <Button
      type="button"
      variant={listening ? "danger" : "default"}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? "Stop voice dictation" : "Start voice dictation for the description"}
      title={title}
      onClick={dictating ? speech.stop : onStart}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px" }}
    >
      <span
        className={listening ? "loom-mic-pulse" : undefined}
        style={{ width: 7, height: 7, borderRadius: radius.base, display: "inline-block",
          background: listening ? color.danger : disabled ? color.text3 : color.text2 }}
      />
      {listening ? "Stop" : requesting ? "starting…" : "Dictate"}
    </Button>
  );
}

// One muted line under the Description: live recognition state on the left, the standing privacy
// disclosure on the right. Local-first honesty: browser dictation is NOT on-device — Chrome streams the
// captured audio to Google's speech service — so we say so plainly rather than implying it stays local.
function DescriptionVoiceNote({ speech }: { speech: SpeechRecognitionApi }) {
  const { status, interim, error, secure } = speech;
  let node: React.ReactNode = null;
  if (!secure) node = <span style={{ color: color.attnText }}>voice needs a secure context</span>;
  else if (status === "requesting") node = <span style={{ color: color.text2 }}>requesting microphone…</span>;
  else if (status === "listening") node = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <StatusPill tone="danger" label="rec" glow />
      {interim
        ? <span style={{ color: color.text3, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{interim}…</span>
        : <span style={{ color: color.text2 }}>listening — speak, then Stop</span>}
    </span>
  );
  else if (status === "denied") node = <span style={{ color: color.danger }}>mic permission denied — allow it in your browser site settings</span>;
  else if (status === "error") node = <span style={{ color: color.danger }}>{error ?? "voice error"} — click Dictate to retry</span>;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 2,
      fontSize: fs.sm, minHeight: 16 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{node}</span>
      <span title="The browser Web Speech API is not on-device — Chrome streams audio to Google's speech service."
        style={{ color: color.text3, whiteSpace: "nowrap" }}>dictation may send audio to your browser's speech service</span>
    </div>
  );
}

function NewTask({ repos, onCreate, error }: { repos: RepoRegistryEntry[]; onCreate: (title: string, repoKey: string | null) => Promise<unknown>; error: string | null }) {
  const [title, setTitle] = useState("");
  // Which repo the new card targets. "" = primary (the default, and the ONLY option a single-repo project
  // has). Deliberately NOT reset on submit: filing several cards against the same repo in a row is the
  // normal multi-repo rhythm, and re-picking every time would be pure friction.
  const [repoKey, setRepoKey] = useState("");
  // Card a1ec70a6: the title is cleared only once the create RESOLVES — and only if it still holds the
  // submitted text, so typing on while the write is in flight doesn't get eaten either. `submitDraft` owns
  // both rules; passing `setTitle` straight through is what lets it apply the second one (it hands over a
  // functional update). The ref is the re-entry guard (`creating` state is only the visible half — it has
  // not re-rendered when a second click in the same tick reads it).
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(false);
  const submit = () => {
    void submitDraft({
      draft: title,
      inFlight: () => inFlight.current,
      setInFlight: (v) => { inFlight.current = v; setCreating(v); },
      create: () => onCreate(title, repoKey || null),
      updateDraft: setTitle,
    });
  };
  // ONE row at every width (card c315f579): the input and repo picker shrink (min-width 0) and the button
  // keeps its size, so a phone no longer spends a second row on the button. Nothing can overflow the page:
  // every flexible item can shrink to zero. Enter submits (keyboard parity with the button).
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <div data-testid="board-new-task-row" style={{ display: "flex", gap: 6, flexWrap: "nowrap", minWidth: 0 }}>
        {/* `data-board-new-task` is the board's `n` shortcut target (card 591fe6ed); the placeholder
            advertises it the way the session composer advertises Ctrl/Cmd+Enter. */}
        <Input placeholder="new task title  (N)" aria-label="New task title" aria-keyshortcuts="N" data-board-new-task=""
          value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          style={{ flex: "1 1 260px", minWidth: 0 }} />
        {/* Repo picker — rendered ONLY when the project actually has a registry. A single-repo project
            gets no extra control at all (the DoD's zero-UI-tax requirement), and the card it files is
            identical to what it filed before multi-repo existed. */}
        {repos.length > 0 && (
          <Select value={repoKey} onChange={(e) => setRepoKey(e.target.value)} aria-label="Target repo"
            title="Which repo this card targets. One task = one repo — work spanning two repos is two cards."
            style={{ flex: "0 1 150px", minWidth: 0 }}>
            <option value="">primary repo</option>
            {repos.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
          </Select>
        )}
        <Button variant="primary" disabled={!title.trim() || creating} onClick={submit} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
          {creating ? "Adding…" : "Add to Inbox"}
        </Button>
      </div>
      {error && (
        <span role="alert" style={{ fontSize: fs.sm, color: color.danger, lineHeight: 1.5 }}>{error}</span>
      )}
    </div>
  );
}

// First-load placeholder for the board — a few lane shells matching the real column chrome (the lane
// well, its radius, a head line and card-sized blocks) so the layout doesn't pop in from a blank page. The
// faint pulse (.loom-skeleton) is dropped under prefers-reduced-motion. Reuses .loom-board-grid so it's
// responsive too.
function BoardSkeleton() {
  return (
    <div className="loom-board-grid loom-skeleton" style={{ marginTop: 10 }} aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{ background: color.laneBg, border: "1px solid transparent", borderRadius: radius.lg,
          minHeight: 200, maxHeight: "75vh", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 11, width: "44%", margin: "14px 12px 12px", background: color.track, borderRadius: radius.sm }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 12px 12px" }}>
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} style={{ height: 40, background: color.cardBg, border: `1px solid ${color.cardBorder}`,
                borderRadius: radius.base }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
