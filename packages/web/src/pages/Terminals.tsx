import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, ShellTerminal } from "@loom/shared";
import { api } from "../lib/api";
import { byManagerThenCreated, groupSessionRows, isCompanionSession, projectFilterOptions, type SessionRowGroup } from "../lib/sessions";
import { useStopSession, useForkSession } from "../lib/useSessionActions";
import { TerminalPane } from "../components/Terminal";
import { TerminalTile } from "../components/TerminalTile";
import { TerminalCard } from "../components/TerminalCard";
import { useSessionQueuesBulk, useSessionWakesBulk, useInvalidateSessionQueueWakesBulk } from "../lib/useSessionQueueWakesBulk";
import { Button, Select, Input, StatusPill, SectionLabel } from "../components/ui";
import { AgentQuickStart } from "../components/atlasAgents";
import { HarnessMixProvider } from "../components/HarnessPicker";
import {
  AUTO_GRID_TEMPLATE, DEFAULT_TILE_LAYOUT, GRID_COLUMN_CHOICES, TILE_MAX_HEIGHT, applyTileOrder, gridTemplateColumns,
  moveTileInOrder, readTileLayout, writeTileLayout, type GridColumns, type TileLayout,
} from "../lib/terminalLayout";
import { maxPinnedCols, usePinnedCols } from "../lib/pinnedGeometry";
import { color, font, fs, radius } from "../theme";

// Tiles flow horizontally then wrap; reused per manager row and the catch-all rows. alignItems:"start" so
// each tile hugs its own content up to its cap rather than being stretched to the tallest tile in the row
// (which padded a bare card out below its composer). Content-dynamic per-card height is the intended shape.
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: AUTO_GRID_TEMPLATE, gap: 12, alignItems: "start" };

/** What each column choice is called in the picker. `auto` names what it does, not its number. */
const COLUMN_LABELS: Record<GridColumns, string> = {
  auto: "Auto", "1": "1 column", "2": "2 columns", "3": "3 columns",
};

// The micro-label on each group in the controls bar. Hoisted out of the one call site it used to
// have (the project filter) so every group in that bar reads at the same weight and tracking — two
// controls side by side under labels that differed by a font-weight would look like two unrelated
// widgets rather than one bar. Deliberately NOT `SectionLabel`: that kit primitive is a BLOCK heading
// at weight 700, which is a louder voice than a field label beside its own field wants, and adopting
// it here would also silently re-weight the filter label the classic shell has always drawn.
const barLabelStyle: CSSProperties = {
  fontFamily: font.ui, fontSize: fs.sm, color: color.text2,
};

// One rendered row of the Claude-sessions grid. A "manager" row = its manager tile first then the
// workers it parented; "orphans"/"standalone" are the trailing catch-all rows. The grouping itself
// lives in lib/sessions.ts (groupSessionRows) — pure + hermetically tested; companions are excluded there.
type SessionRow = SessionRowGroup<SessionListItem>;

// Global Live Terminals grid: all running sessions, with a project filter, tiled, maximizable.
// Also reachable per-project by pre-selecting the filter.
//
// `projectName` is that pre-selection, made a prop by card 25c08fba so the Atlas project node can
// mount this page as its "Sessions" tab at project depth. The classic shell passes nothing, so its
// filter still starts at "" (= all) and the page is byte-identical there.
// @decision eb516fba — inside a project node the filter is LOCKED to that node's project; never put a
// picker back there, it could point the grid away from the node it sits under.
//
// `projectId` (card f3b18f27) is the SECOND half of that same pre-selection, and the one the quick-
// start needs: a roster is read by project id, never by name. It is what gates the control rather
// than a separate flag — the god-eye mount has no single project to start a session IN, so passing
// nothing is both the classic shell's state and the honest answer, and the page stays byte-identical
// there. Both props are optional and independent on purpose: a host that knows only the name still
// gets the filter pre-selection it got before this card.

// `layoutKey` (card 17420720) is the THIRD, independent host prop, and the one the Atlas WORKSPACE
// Terminals node needs. It names the storage slot the reader's own grid layout is kept under, and it
// is what the columns picker and the per-tile order gate on — previously that was `projectId`, which
// conflated two different questions: "is there ONE project to start a session in" (the quick-start's
// question, still `projectId`'s) and "is there a slot to persist this grid's layout under" (this
// one). The god-eye workspace mount answers NO to the first and YES to the second: it has no single
// project to spawn into, but it is a standing page a reader lays out once and comes back to. Both
// remain optional and independent, so a host passing neither — the CLASSIC page — keeps
// `DEFAULT_TILE_LAYOUT`, draws no columns picker and no reorder controls, byte-identically to before.
//
// @decision ac0cfe91 — the column control NEVER resizes a pty (a narrowed pane re-solves its font for
// the daemon's pinned grid, which TerminalPane already did), and ShellsSection stays off it: a shell
// FITS its grid and pushes the new geometry to the real pty.
export default function Terminals({ projectId, projectName, layoutKey }: {
  projectId?: string; projectName?: string; layoutKey?: string;
} = {}) {
  const [filter, setFilter] = useState<string>(projectName ?? "");  // projectName filter ("" = all)
  // Re-sync when the host changes which project it is showing — the Atlas tab stays MOUNTED across a
  // project switch (it is parked with `hidden`, never unmounted), so a mount-time initial value alone
  // would leave it filtered to the project the reader has since navigated away from. Only ever
  // written when the host actually names one, so the god-eye mount never has its "all" reset.
  useEffect(() => { if (projectName !== undefined) setFilter(projectName); }, [projectName]);

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const stop = useStopSession();
  const fork = useForkSession();
  // Companion (assistant-role) sessions are EXCLUDED here at the source: a companion is driven ONLY
  // through its chat surface (/companion, over /ws/companion/:id), never a raw pty tile + STDIN
  // Composer. Filtering at `live` keeps them out of every downstream view — the project dropdown, the
  // counts, `shown`, and all grouping sub-lists (managers/orphans/standalone) — so this page never
  // OFFERS a raw-STDIN path for one. That is a UX guarantee, not the security boundary: the daemon
  // refuses an assistant-role stdin write itself, on both inbound surfaces (lib/sessions'
  // isCompanionSession carries the decision anchor).
  const live = (sessions.data ?? []).filter((s) => s.processState === "live" && !isCompanionSession(s));
  // The live set is only HALF the option list — the scoped project and the current filter value are
  // offered whether or not a session names them, or the control renders "All" while filtering (card
  // d72994d7). Derivation + why both held names are load-bearing: lib/sessions' projectFilterOptions.
  const projectNames = useMemo(
    () => projectFilterOptions(live, [projectName, filter]),
    [live, projectName, filter],
  );
  // Tile order: the STABLE shared key (lib/sessions.ts byManagerThenCreated) — managers first, then
  // createdAt DESC (newest first), tiebreak by id within each bucket. A session keeps its slot whether
  // it's busy or idle, so the grid never reshuffles on a poll (the old activity sort made rows jump).
  // Shared with Overview so the two flat live-grids can't drift.
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort(byManagerThenCreated);
  // Manager-centric layout: one ROW per manager — the manager tile leftmost, then ITS workers to
  // the right ordered newest→oldest (createdAt DESC). Workers attach to their manager via
  // parentSessionId. Two catch-all rows trail the manager rows so nothing is dropped: orphan workers
  // (parent absent from the live set — a recycled/stopped manager) and standalone sessions (no role /
  // no parent — plain human sessions, platform leads — which must never anchor a manager row).
  // The grouping itself is the pure, hermetically-tested groupSessionRows (lib/sessions.ts), which also
  // drops companion/assistant sessions at the source so they can never render a pty tile in any row.
  const rows = useMemo<SessionRow[]>(() => groupSessionRows(shown), [shown]);

  // ── The reader's own layout for this grid (card ac0cfe91; `layoutKey` added by card 17420720) ──
  // The gate is STRUCTURAL rather than merely consistent with the quick-start's: the preference is
  // stored under one key (lib/terminalLayout.ts `tileLayoutStorageKey`), and a mount with no slot to
  // store it under has nowhere to keep it. What supplies that slot is now either prop — `projectId`
  // for a project-scoped mount, or an explicit `layoutKey` for a standing cross-project page. A host
  // passing NEITHER (the classic page) keeps `DEFAULT_TILE_LAYOUT`, exactly as before.
  //
  // ⛔ `layoutKey` FIRST, deliberately: a host passing both is naming the slot explicitly, and the
  // project id is then its fallback, not an override of what it asked for.
  const layoutScope = layoutKey ?? projectId;
  //
  // Read in an effect rather than a `useState` initialiser because this component is MOUNTED across a
  // project switch — the Atlas node parks every visited tab body with `hidden` instead of unmounting it
  // — exactly like the filter re-sync above. An initialiser would pin the first project's layout and
  // then apply it to every project the reader navigated to afterwards.
  const [layout, setLayout] = useState<TileLayout>(DEFAULT_TILE_LAYOUT);
  useEffect(() => { setLayout(layoutScope ? readTileLayout(layoutScope) : DEFAULT_TILE_LAYOUT); }, [layoutScope]);
  const saveLayout = useCallback((next: TileLayout) => {
    setLayout(next);
    if (layoutScope) writeTileLayout(layoutScope, next);
  }, [layoutScope]);

  // A manager row's manager is held at its own row's head — see `applyTileOrder`'s own note: RowHeader
  // names `list[0]` as the manager and counts the rest as its workers, so promoting a worker above it
  // would relabel both. `row.key` IS that manager's id (groupSessionRows), checked against the row's
  // own membership so a key with nothing behind it can never be injected into the saved order.
  const pinnedIdOf = (row: SessionRow) =>
    (row.kind === "manager" && row.list.some((s) => s.id === row.key) ? row.key : undefined);
  const orderedRows = useMemo<SessionRow[]>(
    () => (layout.order.length === 0
      ? rows
      : rows.map((r) => ({ ...r, list: applyTileOrder(r.list, layout.order, { pinnedFirstId: pinnedIdOf(r) }) }))),
    [rows, layout.order],
  );

  // One move rewrites the WHOLE saved order from what is currently on screen, not just the pair that
  // swapped: the stored list is a flat snapshot across every row, so writing back the full rendered
  // sequence is what keeps it a faithful description of the grid (and quietly drops the ids of sessions
  // that have since exited). `row` here is always an ORDERED row, so `row.list` is the sequence the
  // reader is looking at — the one their "earlier" is relative to.
  const moveTile = useCallback((row: SessionRow, id: string, delta: number) => {
    const pinnedId = pinnedIdOf(row);
    const moved = moveTileInOrder(row.list.filter((s) => s.id !== pinnedId).map((s) => s.id), id, delta);
    const nextRowIds = pinnedId ? [pinnedId, ...moved] : moved;
    saveLayout({
      ...layout,
      order: orderedRows.flatMap((r) => (r.key === row.key ? nextRowIds : r.list.map((s) => s.id))),
    });
  }, [orderedRows, layout, saveLayout]);

  // ONE bulk queue/wakes poll for the whole grid instead of 2×N per-card round-trips (perf profile
  // 2026-07-16 finding #4) — every tile below reads its own slice via queueData/wakesData props instead
  // of running its own useQuery. Keyed off `shown` (the flat live set), not per-row, so the same two
  // queries cover every row on the page.
  const shownIds = useMemo(() => shown.map((s) => s.id), [shown]);
  const queues = useSessionQueuesBulk(shownIds);
  const wakes = useSessionWakesBulk(shownIds);
  const { invalidateQueues, invalidateWakes } = useInvalidateSessionQueueWakesBulk();
  // Each tile's pinned column count, as its pane learned it from the daemon (card eb516fba). `auto`
  // widens its tile floor for a row whose grid is too wide to stay readable two-up; see autoGridTemplate.
  const pinnedCols = usePinnedCols();

  // The slim bound-task bar is fetched + rendered by TerminalTile itself (per-session), so no task
  // lookup or prop pass is needed here — every tile shows it automatically, identically to Overview.
  const renderTile = (s: SessionListItem, moveControls?: ReactNode) => (
    <TerminalTile key={s.id} s={s} height={TILE_MAX_HEIGHT} showProject
      onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
      onStop={() => stop.mutate(s.id)} stopPending={stop.isPending}
      queueData={queues.data?.[s.id] ?? []} wakesData={wakes.data?.[s.id] ?? []}
      actionsExtra={moveControls}
      onQueueMutated={invalidateQueues} onWakeCancelled={invalidateWakes} />
  );

  return (
    // `shown` — not `live` — is deliberately the mix set: it respects the project filter above, so
    // filtering down to a single-harness project stops badging every claude tile (@decision b8e52cfe).
    <HarnessMixProvider sessions={shown}>
    <div>
      <ShellsSection />
      {/* ONE bar for every control that acts on the grid below, so a control added here has a declared
          home rather than a fresh row of its own — which is where card ac0cfe91's Columns and Reset
          landed. It wraps at narrow widths and each group keeps its label with its control, so a
          wrapped bar never leaves a label stranded above the wrong field. */}
      <div className="loom-sessionbar" data-testid="sessions-bar">
        <div className="loom-sessionbar-group">
          <span style={barLabelStyle}>Project</span>
          {/* Locked inside a project node (see the signature note): the node already names its project,
              so the bar states it rather than offering a way to point the grid somewhere else. */}
          {projectId && projectName ? (
            <span data-testid="sessions-project-locked" title="This tab always shows its own project's sessions"
              style={{ fontFamily: font.ui, fontSize: fs.body, color: color.text, fontWeight: 500 }}>
              {projectName}
            </span>
          ) : (
            <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All ({live.length})</option>
              {projectNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          )}
        </div>
        {/* Only where there IS one project to start in — see the `projectId` note on the signature.
            The label lives here, with the filter's own, so the bar's two groups are typographically
            one row; the component owns the roster and the controls, never the chrome around them. */}
        {projectId && (
          <div className="loom-sessionbar-group">
            <span style={barLabelStyle}>Start a session</span>
            <AgentQuickStart projectId={projectId} projectName={projectName} />
          </div>
        )}
        {/* Columns, and — only once there is one to undo — the way back out of a chosen order. Both
            ride the SAME bar as the filter and the quick-start, per the note above it. Gated on the
            LAYOUT SLOT, not on `projectId`: a control whose only effect is to write a preference must
            appear exactly where that preference has somewhere to be written. */}
        {layoutScope && (
          <div className="loom-sessionbar-group">
            <span style={barLabelStyle}>Columns</span>
            <Select data-testid="sessions-columns" aria-label="Terminal grid columns"
              value={layout.columns}
              onChange={(e) => saveLayout({ ...layout, columns: e.target.value as GridColumns })}>
              {GRID_COLUMN_CHOICES.map((c) => <option key={c} value={c}>{COLUMN_LABELS[c]}</option>)}
            </Select>
          </div>
        )}
        {/* Hidden until it has something to do: with no saved order there is nothing to reset, and a
            control whose only state is disabled teaches the reader nothing about what it would undo.
            The ordering affordance itself lives on each tile, where the thing being ordered is.

            The button reads "Reset" and not "Reset order" because the group's own label already says
            Order an inch to its left, and the pair would otherwise stutter. The `aria-label` carries
            the full phrase for a reader who gets the button without its label — and it CONTAINS the
            visible word, so the accessible name still matches what is on screen (WCAG 2.5.3). */}
        {layoutScope && layout.order.length > 0 && (
          <div className="loom-sessionbar-group">
            <span style={barLabelStyle}>Order</span>
            <Button data-testid="sessions-order-reset" aria-label="Reset the terminal order"
              title="Drop your own tile order and go back to the default"
              onClick={() => saveLayout({ ...layout, order: [] })}>Reset</Button>
          </div>
        )}
      </div>
      {shown.length === 0 && <p style={{ color: color.text3 }}>No running sessions.</p>}
      {orderedRows.map((row) => {
        // The pinned manager occupies slot 0, so the first slot the reader may move is the one after
        // it. A row with fewer than two movable tiles gets NO controls at all rather than a pair of
        // permanently-dead buttons on a lone tile — there is nothing in it to put in an order.
        const firstMovable = pinnedIdOf(row) === undefined ? 0 : 1;
        const reorderable = !!layoutScope && row.list.length - firstMovable >= 2;
        return (
          <section key={row.key} style={{ marginBottom: 20 }}>
            <RowHeader row={row} />
            <div style={{ ...gridStyle, gridTemplateColumns: gridTemplateColumns(layout.columns, maxPinnedCols(pinnedCols, row.list.map((s) => s.id))) }}
              data-testid={`sessions-grid-${row.key}`} data-columns={layout.columns}>
              {row.list.map((s, i) => renderTile(s, reorderable && i >= firstMovable ? (
                <TileMoveControls id={s.id} canEarlier={i > firstMovable} canLater={i < row.list.length - 1}
                  onMove={(delta) => moveTile(row, s.id, delta)} />
              ) : undefined))}
            </div>
          </section>
        );
      })}
    </div>
    </HarnessMixProvider>
  );
}

/**
 * One tile's order controls, in the card header's own action cluster (card ac0cfe91).
 *
 * TWO BUTTONS, NOT A DRAG HANDLE. The card's body is a live terminal, and selecting text in it is the
 * same press-and-move gesture a drag would have to claim; a button pair takes nothing away from the
 * thing being reordered, is operable from the keyboard and under touch with no extra implementation,
 * and is the affordance the card offered as an alternative ("drag, or move controls"). The cost is
 * that a long move is N presses rather than one drag — acceptable on a grid whose readable size is a
 * handful of tiles, and the Reset in the bar is the escape from a wrong order either way.
 *
 * "Earlier"/"later" rather than left/right or up/down: the SAME press moves a tile sideways at three
 * columns and vertically at one, so a direction word would be wrong in one of the two layouts this
 * card ships. The glyphs are the neutral single-angle quotes for the same reason.
 */
function TileMoveControls({ id, canEarlier, canLater, onMove }: {
  id: string; canEarlier: boolean; canLater: boolean; onMove: (delta: number) => void;
}) {
  return (
    <>
      <Button style={{ padding: "0 6px" }} disabled={!canEarlier} data-testid={`sessions-move-earlier-${id}`}
        aria-label="Move terminal earlier" title="Move this terminal earlier in the order"
        onClick={(ev) => { ev.stopPropagation(); onMove(-1); }}>‹</Button>
      <Button style={{ padding: "0 6px" }} disabled={!canLater} data-testid={`sessions-move-later-${id}`}
        aria-label="Move terminal later" title="Move this terminal later in the order"
        onClick={(ev) => { ev.stopPropagation(); onMove(1); }}>›</Button>
    </>
  );
}

// Header for one Claude-sessions row. A manager row names its manager (project · agent · id) and the
// worker count; the catch-all rows get a plain descriptive label + member count.
function RowHeader({ row }: { row: SessionRow }) {
  if (row.kind === "manager") {
    const m = row.list[0]!; // a manager row is built as [manager, ...workers], so [0] always exists
    const workers = row.list.length - 1;
    return (
      // One line at any width (card eb516fba, audit A-20): the identity ellipsises, and the pill and the
      // worker count never shrink, so a long project + agent name can no longer squeeze "(1 worker)"
      // into a two-line column at the row's edge. The full identity rides the title.
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <StatusPill tone={m.busy ? "work" : "live"} glow={m.busy} label="manager" style={{ flexShrink: 0 }} />
        {/* Split like a tile's own identity (TerminalCard's TileTitle): the names ellipsise, and the short
            id that actually tells two rows apart is the last thing to go. */}
        <span title={`${m.projectName} · ${m.agentName} · ${m.id.slice(0, 8)}`}
          style={{ display: "inline-flex", minWidth: 0 }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.projectName} · {m.agentName}
          </span>
          <span style={{ flexShrink: 0, whiteSpace: "pre", fontFamily: font.mono }}>{` · ${m.id.slice(0, 8)}`}</span>
        </span>
        <span style={{ color: color.text3, fontWeight: 400, flexShrink: 0, whiteSpace: "nowrap" }}>({workers} worker{workers === 1 ? "" : "s"})</span>
      </SectionLabel>
    );
  }
  const label = row.kind === "orphans"
    ? "Orphan workers — parent manager stopped or recycled"
    : "Standalone sessions";
  return (
    <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label}
      <span style={{ color: color.text3, fontWeight: 400 }}>({row.list.length})</span>
    </SectionLabel>
  );
}

// Plain shell terminals (human-spawned pwsh/cmd/bash in a repo cwd). A separate lane above the Claude
// sessions — different lifecycle (ephemeral, not a DB Session) and a resizable xterm.
function ShellsSection() {
  const qc = useQueryClient();
  const [spawning, setSpawning] = useState(false);
  const shells = useQuery({ queryKey: ["terminals"], queryFn: ({ signal }) => api.terminals(signal), refetchInterval: 4000 });
  const kill = useMutation({
    mutationFn: (id: string) => api.killTerminal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals"] }),
  });
  const live = (shells.data ?? []).filter((t) => t.alive);

  return (
    <section style={{ marginBottom: 20 }}>
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Shells
        <span style={{ color: color.text3, fontWeight: 400 }}>({live.length})</span>
        <Button variant="primary" style={{ padding: "0 8px", marginLeft: 4 }} onClick={() => setSpawning(true)}>+ Shell</Button>
      </SectionLabel>
      {live.length === 0 && <p style={{ color: color.text3, marginTop: 0 }}>No shells. Open one in a project's repo with “+ Shell”.</p>}
      {live.length > 0 && (
        <div style={gridStyle}>
          {live.map((t) => <ShellTile key={t.id} t={t} onKill={() => kill.mutate(t.id)} killing={kill.isPending} />)}
        </div>
      )}
      {spawning && <SpawnShellModal onClose={() => setSpawning(false)} />}
    </section>
  );
}

// A plain shell terminal, on the shared <TerminalCard> frame (terminal-unification epic, stage 4). A raw
// shell is NOT a DB Session — it takes keystrokes straight into xterm — so it keeps its DISTINCT body via
// `renderBody` (a resizable FitAddon pane, no turn-Composer / queue / wakes / task) and its DISTINCT
// lifecycle: hard **Kill** (confirm-gated), never graceful Stop. It gains **Maximize** from the base (was
// missing). Fork is withheld (a shell has no conversation to branch). The base's default identity/status
// title is overridden with the shell's own "shell" pill (no live `busy` signal); the Kill/confirm cluster
// rides in `actionsExtra` so the base's built-in confirm-less kill button never doubles it up. FILL height
// ("460px") keeps the old fixed-box pane that the resizable grid fits to — a shell has no grid to hug.
function ShellTile({ t, onKill, killing }: { t: ShellTerminal; onKill: () => void; killing: boolean }) {
  // Kill hard-terminates the process tree, so gate it behind an inline confirm — mirrors the
  // Schedules/Profiles/Skills delete pattern (a confirm/cancel pair in place of the action button).
  const [confirmKill, setConfirmKill] = useState(false);
  const killCluster = confirmKill ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: color.danger, fontSize: fs.sm }}>kill shell?</span>
      <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
        onClick={(ev) => { ev.stopPropagation(); onKill(); }}>Confirm</Button>
      <Button style={{ padding: "0 8px" }}
        onClick={(ev) => { ev.stopPropagation(); setConfirmKill(false); }}>Cancel</Button>
    </span>
  ) : (
    <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
      title="Kill this shell — hard terminate the process tree"
      onClick={(ev) => { ev.stopPropagation(); setConfirmKill(true); }}>Kill</Button>
  );

  return (
    <TerminalCard
      session={{ id: t.id }}
      height="460px"
      offerFork={false}
      lifecycle="none"
      maximizable
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: fs.sm, color: color.text2 }}>
          <StatusPill tone="live" label="shell" />
          <span title={`${t.command}\n${t.cwd}`}>{t.label} · <span style={{ fontFamily: font.mono, fontSize: fs.mono }}>{t.id.slice(0, 8)}</span></span>
        </span>
      }
      actionsExtra={killCluster}
      renderBody={() => (
        // A resizable shell fits the pane to its box (FitAddon) — NOT readOnly (that disables stdin; a
        // shell must take keystrokes) and no Composer (it's not a turn-based DB Session).
        <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={t.id} resizable /></div>
      )}
    />
  );
}

// "+ Shell" modal: pick a project (cwd = its repoPath), an executable (prefilled with the host's
// detected default), and optional args. The spawn is a HUMAN-only REST call (never an MCP tool).
function SpawnShellModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: ({ signal }) => api.projects(signal) });
  const defaultShell = useQuery({ queryKey: ["defaultShell"], queryFn: ({ signal }) => api.defaultShell(signal) });
  const [projectId, setProjectId] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  // Prefill once the queries land: first project + the host default shell.
  useEffect(() => { const first = projects.data?.[0]; if (!projectId && first) setProjectId(first.id); }, [projects.data, projectId]);
  useEffect(() => { if (!command && defaultShell.data?.command) setCommand(defaultShell.data.command); }, [defaultShell.data, command]);

  const create = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.createTerminal({
      projectId,
      command: command.trim() || undefined,
      args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["terminals"] }); onClose(); },
  });

  const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
  const box: CSSProperties = { width: 520, maxWidth: "90vw", padding: 16, background: color.surface, border: `1px solid ${color.line}`, borderRadius: radius.sm };
  const labelStyle: CSSProperties = { fontFamily: font.ui, fontSize: fs.sm, color: color.text2, display: "block", marginBottom: 4 };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <SectionLabel>Open a shell</SectionLabel>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Project (cwd = its repo)</label>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: "100%" }}>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Executable</label>
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pwsh / bash / …" style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Args (optional, space-separated)</label>
          <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-NoLogo" style={{ width: "100%" }} />
        </div>
        {create.isError && <p style={{ color: color.danger, fontSize: fs.sm }}>Failed to spawn — check the executable path.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!projectId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Opening…" : "Open shell"}
          </Button>
        </div>
      </div>
    </div>
  );
}
