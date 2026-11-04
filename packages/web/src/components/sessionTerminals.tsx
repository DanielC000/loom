// The expandable live-session list that BOTH Atlas home nodes mount — extracted from
// pages/WorkspaceHome.tsx by card 0bcfa530 so the project node's Overview could have the same
// surface without a second copy of it.
//
// ⭐ ONE COMPONENT, TWO MOUNTS, ONE CONTRACT. The Workspace node (card 9b6be377) lists every running
// session across every project; the project node's Overview (card 0bcfa530) lists one project's,
// filtered by that tab's own roster-scope preference (card effd47d5). Those are two POPULATIONS,
// derived by their own pages — everything that is not the population is identical, and that is the
// part that lives here: the single-mount rule, the row grammar, the `starting` note, and the one
// `TerminalCard` variant both nodes are allowed to mount.
//
// ⛔ The CHROME around this list is deliberately NOT here. The Workspace node wears a
// `.loom-wsessions` Panel with the band's own head; the project node wears an `OverviewCard`, which
// is that tab's only card vocabulary. Pulling the head and the footer in here would force one of the
// two nodes to wear the other's furniture, which is exactly the shape card 269f46ef forbids for this
// tab. The caller owns its card; this owns the list inside it.
//
// @decision 9b6be377 — ONE mounted terminal, and NOTHING at rest, on EVERY node that mounts this.
// Never render a second TerminalCard beside it, never pre-expand a row, and never pass `resizable`
// for a claude session (pty geometry is pinned daemon-side).
import { useState } from "react";
import { Link } from "react-router-dom";
import type { SessionListItem } from "@loom/shared";
import { StatusPill } from "./ui";
import { BandEmpty } from "./atlasHome";
import { TerminalCard } from "./TerminalCard";
import { RoleBadge } from "../lib/roleDisplay";
import { relativeTime } from "../lib/atlasHome";
import { goLiveSessionPill } from "../lib/sessions";
import { canMountTerminal, liveExpandedSession, toggleExpandedSession } from "../lib/workspaceSessions";

/** The expanded terminal's HUG cap. `TerminalCard` hugs its real content up to this, so a short
 *  session's card does not pad out to a fixed box — the same model the Terminals-page tiles use at
 *  540 and the project Overview's at 520; a little shorter because this one sits inside a card that
 *  already spent height on its own head and row list. */
export const SESSION_TERMINAL_HEIGHT = 460;

/**
 * The testids one mount of this list answers to, named in full rather than built from a stem.
 *
 * TWO MOUNTS, TWO SETS, and no string arithmetic between them: a spec on either node must never be
 * satisfiable by the other node's card, and a shared stem with a one-letter difference is the kind
 * of near-miss that makes a passing spec prove nothing. They are explicit so `git grep` finds the
 * single place each name is minted.
 */
export interface SessionListTestIds {
  /** The bounded scroll track holding the rows. */
  list: string;
  /** The one terminal region. */
  terminal: string;
  /** Row stems, each suffixed with the session's own id. */
  row: string;
  expand: string;
  open: string;
}

/**
 * The list of running sessions, at most one of them expanded into its live terminal.
 *
 * `rows` is already the caller's finished population, in its own render order — this component makes
 * no decision about WHO is listed, which is why the two nodes can filter differently without a
 * second copy of the single-mount rule. It does decide what happens when a row is clicked, and that
 * decision is the performance contract above.
 *
 * `regionId` is the terminal region's DOM id and the rows' `aria-controls` target, so it must be
 * unique per mount — not per row: there is only ever one region, because there is only ever one
 * mount.
 */
// Card b439c2dc added an `atRest` prop here — a reserved seat drawn where the terminal lands while
// nothing was expanded — for its one whole-PAGE caller, the Atlas Terminals node. Card 17420720
// removed it again: on the owner's verdict that node now mounts the classic tile GRID
// (pages/Terminals.tsx) instead of this list, so the prop had no caller left and its own rationale
// ("it exists for a caller that is a whole page") had stopped being true. Both remaining mounts are
// DECK cards, which never passed it. Don't reintroduce it without such a caller.
export function SessionTerminalList({ rows, ids, regionId, showProject = false, height = SESSION_TERMINAL_HEIGHT }: {
  rows: readonly SessionListItem[];
  ids: SessionListTestIds;
  regionId: string;
  /** Whether a row names its project. False on the project node, where every row shares one. */
  showProject?: boolean;
  height?: number;
}) {
  // `wanted` is what the reader last asked for; the MOUNT is re-derived through
  // `liveExpandedSession` on every render, so an expansion can never outlive its row (a session that
  // exits, is stopped, or is archived while its terminal is open takes the mount with it).
  const [wanted, setWanted] = useState<string | null>(null);
  const expandedId = liveExpandedSession(wanted, rows);
  const expanded = rows.find((s) => s.id === expandedId) ?? null;

  return (
    <>
      <div className="loom-wsessions-list" data-testid={ids.list}>
        {rows.map((s) => (
          <SessionRow key={s.id} s={s} open={s.id === expandedId} ids={ids} regionId={regionId}
            showProject={showProject}
            onToggle={() => setWanted(toggleExpandedSession(expandedId, s.id))} />
        ))}
      </div>
      {expanded && (
        <div className="loom-wsession-term" id={regionId} data-testid={ids.terminal}>
          {canMountTerminal(expanded) ? (
            // Deliberately NOT `TerminalTile`: that variant carries Fork + Stop, and both nodes that
            // mount this are a readout of the fleet rather than a second place to end a session —
            // the reasoning card c6160c7d's own record gives the Operators panel. Lifecycle is one
            // click away on the row's `Open ↗`, which lands on the session node's full tile. The
            // Composer stays: watching without being able to steer is the half of a terminal that is
            // not worth mounting.
            <TerminalCard session={expanded} height={height} showProject={showProject}
              lifecycle="none" maximizable
              subPanels={{ taskCard: true, queue: true, wakes: true }} />
          ) : (
            <BandEmpty>
              {expanded.agentName} is still starting. Its terminal appears once the session is live.
            </BandEmpty>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One running session as a single dense line: state · role · project · agent · short id · uptime.
 *
 * The state pill is `goLiveSessionPill` (lib/sessions.ts), NOT `TileTitle`'s own — `TileTitle` reads
 * `busy` alone, so it prints "idle" over a `starting` row, which is exactly the misreport that
 * resolver exists to prevent (card 318b5a21). Everything else is kit: `RoleBadge` for the role and
 * the mono identity grammar `TileTitle` uses, so a session reads the same here as on its own node.
 *
 * The row's expand target is a `<button>` and the `Open ↗` link is its SIBLING, never nested: an
 * anchor inside a button is invalid and unreachable by keyboard — the same trap `.loom-atlas-noderow`
 * exists to avoid in the tree.
 */
function SessionRow({ s, open, onToggle, ids, regionId, showProject }: {
  s: SessionListItem; open: boolean; onToggle: () => void;
  ids: SessionListTestIds; regionId: string; showProject: boolean;
}) {
  const pill = goLiveSessionPill(s);
  const uptime = relativeTime(s.createdAt).replace(" ago", "");
  // `data-atlas-wsession` carries the session id as a VALUE rather than baked into the testid, so a
  // spec can address the row set as ONE locator and read each row's identity off it — a testid stem
  // can only be matched an id at a time, which cannot assert an ORDER. The attribute name is the
  // Workspace card's own (card 9b6be377) and is now shared by both mounts: each spec already scopes
  // its locator through its card's testid, so one name cannot reach the other node's rows.
  return (
    <div className={`loom-wsessionrow${open ? " is-expanded" : ""}`} data-atlas-wsession={s.id}
      data-testid={`${ids.row}-${s.id}`}>
      <button type="button" className="loom-wsessionbtn" onClick={onToggle}
        aria-expanded={open} aria-controls={open ? regionId : undefined}
        data-testid={`${ids.expand}-${s.id}`}
        title={open ? `Hide ${s.agentName}'s terminal` : `Show ${s.agentName}'s terminal`}>
        <span aria-hidden className={`loom-wsession-twist${open ? " is-expanded" : ""}`}>▶</span>
        {/* State and role travel as ONE fixed-width cluster so every row's identity text starts at
            the SAME x. Both are variable-width ("busy" vs "starting", "Lead" vs "Operator"), and
            left to themselves they gave five rows five different label origins — the ragged edge
            card 3b563642 kept the tree's own entity tier off. `min-width`, never a fixed `width`: a
            longer badge then pushes its own row by a pixel or two instead of being clipped. */}
        <span className="loom-wsession-state">
          <StatusPill tone={pill.pending ? "amber" : "phosphor"} glow={pill.pending} label={pill.label} />
          <RoleBadge role={s.role ?? null} />
        </span>
        {/* The AGENT carries the weight, not the project. On the Workspace node rows are already
            project-major, so a project's rows are adjacent and its name reads as the block's own dim
            boundary; given the weight instead it repeats at full strength on every row of the block
            and buries the one token that actually tells two rows of that block apart. On the PROJECT
            node it is dropped altogether — every row shares one project, so the prefix would be the
            same token on every line, paying width to say nothing. */}
        <span className="loom-wsession-id"
          title={`${showProject ? `${s.projectName} · ` : ""}${s.agentName} · ${s.id}`}>
          {showProject && <span className="loom-wsession-proj">{s.projectName} · </span>}
          <span className="loom-wsession-agent">{s.agentName}</span>
          <span className="loom-wsession-short">{` · ${s.id.slice(0, 8)}`}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span className="loom-wsession-up" title={`Started ${relativeTime(s.createdAt)} · last activity ${relativeTime(s.lastActivity)}`}>
          {uptime}
        </span>
      </button>
      <Link to={`/session/${s.id}`} className="loom-inlinelink loom-wsession-open"
        data-testid={`${ids.open}-${s.id}`}
        title={`Open ${s.agentName} on its own session node`}>
        Open <span aria-hidden>↗</span>
      </Link>
    </div>
  );
}
