import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Panel, SectionLabel, Select } from "../components/ui";
import { BandEmpty, BandFoot } from "../components/atlasHome";
import { SessionTerminalList, type SessionListTestIds } from "../components/sessionTerminals";
import { projectFilterOptions } from "../lib/sessions";
import { workspaceRunningSessions, workspaceSessionsSummary } from "../lib/workspaceSessions";
import { api } from "../lib/api";
import { color, font } from "../theme";

// THE WORKSPACE TERMINALS NODE — card b439c2dc, the owner's own words: "add a terminals page with a
// terminals page like the one on the current ui. In the left sidebar place it between home and
// Platform."
//
// WHY THIS IS A NEW ADDRESS AND NOT `/terminals`. The classic rail's own Terminals destination is
// still `/terminals` (src/nav.tsx's NAV_PAGES row), but under Atlas that address was taken down to
// PROJECT depth by card 25c08fba — it is the project node's "Sessions" tab, and AtlasShell routes it
// at <ProjectHome/>. So the workspace tier has no address left to put a god-eye terminals page on,
// and mounting a second <Route> on one literal path is the precedence contest AtlasShell's own
// REHOMED_TAB_PATHS note forbids. This node therefore follows the precedent card 595e2a47 set for the
// workspace Settings node: an ATLAS_HOMES row at an Atlas-only path, which the CLASSIC shell does not
// mount at all. The classic Terminals page is untouched — same route, same component, same grid.
//
// 🔴 IT IS NOT THE CLASSIC GRID, AND THAT IS THE POINT. pages/Terminals.tsx mounts ONE TerminalTile
// PER SHOWN SESSION — N live `/ws/term` attaches and N xterm instances on one page. CLAUDE.md names
// that cost directly ("a heavy page that mounts a live-session terminal freezes its CDP renderer"),
// and it is why this page reuses components/sessionTerminals.tsx instead: that component's whole
// contract is at most ONE mounted terminal, nothing at rest, and a click that MOVES the mount rather
// than adding a second. Everything the attach itself does — the socket, the xterm, the pinned pty
// geometry, the reconnect ladder, the companion stdin guard — is TerminalPane's, reached through the
// one TerminalCard variant that component is allowed to mount. Nothing here re-implements any of it.
//
// WHAT THIS PAGE ADDS OVER THE WORKSPACE NODE'S OWN "Sessions" CARD (card 9b6be377), which mounts the
// same list: the card is one band among many on a deck, so it is bounded to ~8 visible rows and a
// 460px terminal. This node is the whole content column, so it spends that room on the two things a
// reader came to a dedicated terminals page for — a deeper row track and a taller terminal — plus the
// PROJECT FILTER, which is the control the classic god-eye page has and the deck card has no width
// for. The populations are deliberately identical (`workspaceRunningSessions`), so the two surfaces
// can never state different counts for the same word.
//
// @decision b439c2dc — never render the classic tile GRID here, and never mount a second terminal
// beside SessionTerminalList's. One attach at a time is this page's whole performance contract; a
// "show all" affordance would be the cockpit freeze CLAUDE.md warns about, one click away.

/** The `aria-controls` target — one region, because there is only ever one mount. */
const TERMINAL_REGION = "atlas-terminals-node-terminal";

/**
 * This node's own testids.
 *
 * ⛔ DISTINCT FROM THE WORKSPACE NODE'S `atlas-session-*` SET (pages/WorkspaceHome.tsx) even though
 * both mount the same list. A spec on either surface must never be satisfiable by the other's rows,
 * and the two surfaces now render the SAME population — so a shared stem would make a passing spec
 * prove nothing at all about which page it was looking at.
 */
const TERMINALS_NODE_IDS: SessionListTestIds = {
  list: "atlas-terminals-list",
  terminal: "atlas-terminals-terminal",
  row: "atlas-terminals-row",
  expand: "atlas-terminals-expand",
  open: "atlas-terminals-open",
};

/** The terminal's HUG cap here. Taller than the deck card's 460 — this node is the whole column. */
const TERMINAL_HEIGHT = 620;

// The filter group's micro-label. Same grammar as pages/Terminals.tsx's own `barLabelStyle`, and
// deliberately NOT `SectionLabel`: that kit primitive is a BLOCK heading at weight 700, a louder
// voice than a field label sitting beside its own field.
const filterLabelStyle: CSSProperties = {
  fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim,
};

export default function WorkspaceTerminals() {
  // The SAME cross-project cache entry the tree, the Workspace node and the classic page all poll,
  // so this node costs no request of its own and cannot disagree with any of them about who is live.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  // The population rule is lib/workspaceSessions' — not a companion, and actually running — stated
  // once there and delegated to here, exactly as the project node's own Sessions card delegates.
  const all = useMemo(() => workspaceRunningSessions(sessions.data), [sessions.data]);

  const [filter, setFilter] = useState("");  // a projectName; "" = every project
  // The CURRENT filter value is offered whether or not a session still names it (lib/sessions'
  // projectFilterOptions): the last session in a project can exit while that project is selected,
  // and a <select> whose value matches no <option> renders as its FIRST option — i.e. silently as
  // "All", while the list below it is still filtered to nothing.
  const projectNames = useMemo(() => projectFilterOptions(all, [filter]), [all, filter]);
  const rows = useMemo(
    () => (filter ? all.filter((s) => s.projectName === filter) : all),
    [all, filter],
  );

  // Filtering to another project takes an open terminal down with it, and needs no handling here:
  // SessionTerminalList re-derives its mount through `liveExpandedSession` against the rows it is
  // GIVEN, so an expansion whose row is no longer listed resolves to null on the next render.

  return (
    <div className="loom-atlas-home" data-testid="atlas-terminals-node">
      <Panel className="loom-wsessions loom-termpage" data-testid="atlas-terminals-card">
        <div className="loom-bandhead">
          <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>Running</SectionLabel>
          <span className="loom-bandcount" data-testid="atlas-terminals-count">{rows.length}</span>
          {/* ⛔ The "one terminal at a time" cost model is NOT stated here, unlike on the Workspace
              node's own card. It is said in the reserved seat below instead — the spot a reader is
              actually looking at when the question ("why is no terminal showing?") occurs to them,
              rather than in a head they read before they had it. Saying it in both would be the
              same sentence twice on one screen. */}
          <span style={{ flex: 1 }} />
          {/* The filter rides the HEAD rather than a bar of its own: it acts on the list directly
              below it, and a second full-width row above a scroll track would read as a divider
              between the heading and the thing it heads. Offered only once there is more than one
              project to choose between — with one, every option filters to the whole list. */}
          {projectNames.length > 1 && (
            <span className="loom-termpage-filter">
              <span style={filterLabelStyle} id="atlas-terminals-filter-label">Project</span>
              <Select data-testid="atlas-terminals-filter" aria-labelledby="atlas-terminals-filter-label"
                value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All ({all.length})</option>
                {projectNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </span>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="loom-bandbody" data-testid="atlas-terminals-empty">
            {/* Two different facts, said differently: "your filter excludes everything" is a thing
                the reader can undo in one click, and "the fleet is idle" is not. One sentence for
                both would leave the first case looking like the second. */}
            <BandEmpty>
              {filter
                ? `Nothing is running in ${filter}. Widen the project filter to see the rest of the fleet.`
                : "Nothing is running."}
            </BandEmpty>
            {!filter && (
              <BandFoot>
                A manager is started from its project's Agents tab, and it dispatches its own workers.
                Standing operators live on <Link to="/platform" className="loom-inlinelink">Platform</Link> and{" "}
                <Link to="/companion" className="loom-inlinelink">Companion</Link>.
              </BandFoot>
            )}
          </div>
        ) : (
          <>
            {/* `showProject`: a cross-project list that did not name each row's project would leave
                "and where" unanswered — the half of a session's identity a project-scoped list never
                has to state. It stays on under a filter too: the filter is a control a reader can
                have forgotten they set, and the row is where that shows. */}
            <SessionTerminalList rows={rows} ids={TERMINALS_NODE_IDS} regionId={TERMINAL_REGION}
              showProject height={TERMINAL_HEIGHT} atRest={<TerminalSeat />} />
            <BandFoot>
              {workspaceSessionsSummary(rows)} Companions are driven from their own chat surface and
              are not listed.
            </BandFoot>
          </>
        )}
      </Panel>
    </div>
  );
}

/**
 * The terminal's seat while nothing is in it.
 *
 * WHY IT EXISTS, measured rather than assumed: at 1440 the node at rest drew a ~310px panel over
 * ~600px of empty column, because the one thing this page is FOR had no presence until a row was
 * clicked. A reader meeting it had no way to learn where the terminal lands, or that opening one
 * releases another, without first clicking something. The seat answers both where the answer is
 * needed, and mounts nothing to do it.
 *
 * TOP-LEFT, not centred. Centred copy in a tall box is the generic empty-state look, and it would
 * also put the text somewhere the terminal never appears — the point of the seat is that it marks
 * the real position, so the eye has already learnt it by the time a pane lands there.
 */
function TerminalSeat() {
  return (
    <div className="loom-termpage-seat" data-testid="atlas-terminals-seat">
      <p className="loom-termpage-seatlead">Select a session to attach its terminal.</p>
      <p className="loom-termpage-seatnote">
        One terminal is mounted at a time, so opening another releases the one before it. A session's
        own controls, its bound task and its queue are on <span className="loom-termpage-seatkey">Open ↗</span>.
      </p>
    </div>
  );
}
