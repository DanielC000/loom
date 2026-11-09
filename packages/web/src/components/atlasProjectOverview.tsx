// The project Overview's own presentational kit — card 269f46ef, the owner's "C · Roster" pick with
// his one amendment ("Needs you should be on top in its own row so it has enough space").
//
// ⛔ A SEPARATE FILE FROM components/atlasHome.tsx ON PURPOSE. That one is shared with the WORKSPACE
// node, which keeps its KPI deck, its five-panel band and its project grid untouched by this card.
// Everything here is mounted by pages/ProjectHome.tsx and by nothing else, so there is no shared
// shape for a change here to reach — the Workspace node renders byte-identically.
//
// What IS reused, deliberately, is the band's own vocabulary: `.loom-bandhead` / `.loom-bandcount` /
// `.loom-bandlink` / `.loom-bandbody` dress every card below, exactly as the Workspace Sessions card
// (`.loom-wsessions`, card 9b6be377) already does. Only `.loom-bandpanel` is left behind, because
// that class is what pins the 320px height that makes a BAND a band — and a full-width card's height
// is its content.
//
// ⛔ Nothing here fetches. ProjectHome does the reading and hands these components finished values,
// the same contract components/atlasHome.tsx states for the kit it owns.
//
// @decision 269f46ef — never move a shape from this file into components/atlasHome.tsx to "share"
// it: that file is mounted by the Workspace node too, and this composition is the project node's
// alone.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Dot, Panel, SectionLabel, Segmented, StatusPill } from "./ui";
import { useDismissable } from "../lib/useDismissable";
import { sentenceCase } from "../lib/textCase";
import type { BoardLane } from "../lib/atlasHome";
import type { RosterRow, RosterScope } from "../lib/atlasProjectOverview";
import { color, columnTone, font, tone, toneFill, type Tone } from "../theme";

// ── The briefing line ──────────────────────────────────────────────────────────────────────────
//
// 🔴 THE INVERSION, AND WHY IT IS NOT THE KPI DECK AGAIN. components/atlasHome.tsx's `KpiDeck` says
// SIZE IS THE FEATURE and "don't mint a compact twin anywhere else on the node", because round 3
// shrank a node's readouts to pills and the owner read the page as "the board" rather than "an
// overview" (card 939922ee). That rule held while the readouts were the only furniture competing
// with a board. This node no longer has a board, and it has a new primary surface — the roster table
// — so the furniture's job inverts: nothing in this line may be LARGER than the table under it, or
// the page goes back to being a dashboard with a list at the bottom. The owner picked this reading
// knowingly, on rendered mockups that state it in those words.
//
// It is a REPLACEMENT, not a twin: the deck is not mounted on this node at all any more, so there is
// no second statement of any figure for a reader to read twice.
//
// @decision 269f46ef — this line replaces the KPI deck on the project node; never mount both, and
// never grow a reading here past the roster table's own type.

export interface BriefReading {
  key: string;
  label: string;
  /** The headline figure. A string so "1·2" and "62%" read as one glyph run. */
  value: ReactNode;
  /** The qualifier beside the figure — muted, same line, never a second row. */
  sub?: ReactNode;
  tone?: Tone;
  title?: string;
  /** The breakdown behind the figure. A reading with none is plain text, not a button. */
  popover?: ReactNode;
}

export function BriefLine({ readings, trailing }: { readings: BriefReading[]; trailing?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="loom-ovbrief" data-testid="atlas-overview-brief">
      {readings.map((r) => (
        <BriefCell key={r.key} reading={r} open={open === r.key}
          onToggle={() => setOpen((cur) => (cur === r.key ? null : r.key))}
          onClose={() => setOpen(null)} />
      ))}
      {trailing}
    </div>
  );
}

function BriefCell({ reading, open, onToggle, onClose }: {
  reading: BriefReading; open: boolean; onToggle: () => void; onClose: () => void;
}) {
  // The wrapper holds BOTH the trigger and the panel, so a click inside the breakdown does not close
  // it — the same shape `KpiTile` uses, and the same `.loom-kpi-pop` chrome, which is already shared
  // with the fleet-controls pop-over rather than copied per call site.
  const ref = useDismissable<HTMLDivElement>(open, onClose);
  const t = reading.tone ?? "live";
  const popId = `atlas-brief-pop-${reading.key}`;
  const body = (
    <>
      <span className="loom-ovbrief-l">{sentenceCase(reading.label)}</span>
      {/* The FIGURE carries its own class so a reader — and a spec — can address it apart from the
          qualifier beside it: the two sit in one line box with no text node between them, so the
          cell's own `textContent` reads "3open · 1 review" and no prefix match can split them. */}
      <span className="loom-ovbrief-v">
        <span className="loom-ovbrief-n" style={{ color: tone[t] }}>{reading.value}</span>
        {reading.sub !== undefined && <em>{reading.sub}</em>}
      </span>
    </>
  );
  if (!reading.popover) {
    return <div className="loom-ovbrief-cell" data-testid={`atlas-brief-${reading.key}`} title={reading.title}>{body}</div>;
  }
  return (
    <div className="loom-ovbrief-slot" ref={ref}>
      <button type="button" className={`loom-ovbrief-cell is-button${open ? " is-open" : ""}`}
        data-testid={`atlas-brief-${reading.key}`}
        aria-expanded={open} aria-controls={open ? popId : undefined}
        title={`${reading.label}${reading.title ? ` — ${reading.title}` : ""} · open the breakdown`}
        onClick={onToggle}>
        {body}
      </button>
      {open && (
        <div id={popId} className="loom-kpi-pop" data-testid={popId}>
          <div className="loom-kpi-pophead">
            <SectionLabel style={{ margin: 0 }}>{reading.label}</SectionLabel>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" data-testid={`atlas-brief-close-${reading.key}`}
              aria-label={`Close the ${reading.label} breakdown`} title="Close"
              onClick={onClose} style={{ padding: "0 6px", lineHeight: 1.2 }}>×</Button>
          </div>
          <div className="loom-kpi-popbody">{reading.popover}</div>
        </div>
      )}
    </div>
  );
}

/** The trailing cell of the briefing line — a reading plus its own chart, which no pop-over could
 *  improve on, so it is a plain readout rather than a fifth button. */
export function BriefTrailing({ label, value, sub, tone: t = "live", children, testId }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; children: ReactNode; testId?: string;
}) {
  return (
    <div className="loom-ovbrief-trail" data-testid={testId}>
      <span className="loom-ovbrief-trailtext">
        <span className="loom-ovbrief-l">{sentenceCase(label)}</span>
        <span className="loom-ovbrief-v">
          <span className="loom-ovbrief-n" style={{ color: tone[t] }}>{value}</span>
          {sub !== undefined && <em>{sub}</em>}
        </span>
      </span>
      <span className="loom-ovbrief-chart">{children}</span>
    </div>
  );
}

// ── The cards ──────────────────────────────────────────────────────────────────────────────────

/**
 * One full-width Overview card. The band panel's head grammar (label · count · a way out to the full
 * surface) over a body whose height is its CONTENT — see this file's own header for why it is not a
 * `.loom-bandpanel`.
 *
 * `bodyMaxHeight` is opt-in and used by exactly one caller: a Pulse feed capped at 100 events would
 * otherwise make the page as long as the day has been busy. Every other card is as tall as it needs.
 */
export function OverviewCard({ label, count, controls, action, children, footer, bodyMaxHeight, testId }: {
  label: string;
  count?: ReactNode;
  /**
   * A control that changes what the body shows, drawn beside the reading it changes rather than
   * above the card or inside the body — so the label, the count it is about to change, and the
   * control that changes it read as one statement. `.loom-bandhead` already wraps, so a narrow
   * viewport drops this onto its own row with the exit link rather than squeezing the label.
   */
  controls?: ReactNode;
  action?: { to: string; label: string };
  children: ReactNode;
  /** A muted caption under the body — the sentence that keeps the card's own label honest. */
  footer?: ReactNode;
  bodyMaxHeight?: number;
  testId?: string;
}) {
  return (
    <Panel data-testid={testId} className="loom-ovcard">
      <div className="loom-bandhead">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>{label}</SectionLabel>
        {count !== undefined && <span className="loom-bandcount">{count}</span>}
        {controls}
        <span style={{ flex: 1 }} />
        {action && (
          <Link to={action.to} className="loom-btn loom-btn-default loom-bandlink" title={`Open ${action.label}`}>
            {action.label} <span aria-hidden>↗</span>
          </Link>
        )}
      </div>
      <div className="loom-bandbody"
        style={bodyMaxHeight === undefined ? undefined : { maxHeight: bodyMaxHeight, overflowY: "auto" }}>
        {children}
      </div>
      {footer && <div className="loom-ovcard-foot"><p>{footer}</p></div>}
    </Panel>
  );
}

// ── The roster table ───────────────────────────────────────────────────────────────────────────
//
// 🔴 ONE GRID, TWO TEMPLATES, THE SAME SEVEN CELLS IN THE SAME ORDER AT BOTH WIDTHS. Below the fold
// (`global.css`, the `.loom-ovroster` block) a row becomes a labelled stacked block rather than
// dropping columns — which is the whole reason this shape was picked over another card grid: the
// built band could only answer 616px by stacking five fixed-height panels into a 980px wall.
//
// Each cell's own label (`.loom-ovroster-lbl`) is in the DOM at EVERY width and hidden by CSS at the
// wide one. That is deliberate: it is what lets the stacked rendering keep all seven facts named
// without a second render path, and a screen reader hears the label either way, where the wide
// `.loom-ovroster-head` row alone would leave the stacked cells unlabelled.

/**
 * Which agents' sessions the roster lists — card effd47d5, the owner's own item on this tab:
 * "Optionaly show either only tarminals of spawnable agents or teminals of all running agents.
 * Adjustable by user preference."
 *
 * `Segmented` (components/ui) rather than a `<Select>`, which is this app's other small-picker
 * vocabulary, for one reason: a collapsed select hides the option the reader did not pick, and the
 * whole point of this control is knowing WHICH population is on screen. Both readings stay visible,
 * and both carry their own count — so the alternative states what it would yield before it is
 * clicked, the same courtesy the Sessions tab's project filter already pays ("All (4)"). The kit
 * owns the chrome and the roving-tabindex keyboard handling; nothing here restyles a segment.
 *
 * @decision effd47d5 — do not shrink these segments with a CSS rule, and do not swap this for a
 * `<Select>`. Segment padding and font size are INLINE in the kit, so a class rule here is silently
 * inert; a collapsed select hides the very population comparison this control exists to state.
 */
export function RosterScopeToggle({ value, onChange, counts, testId }: {
  value: RosterScope;
  onChange: (next: RosterScope) => void;
  counts: { all: number; spawnable: number };
  testId?: string;
}) {
  return (
    <Segmented<RosterScope>
      data-testid={testId}
      aria-label="Which agents' sessions to list"
      title="List every running agent, or only the agents you start by hand"
      value={value}
      onChange={onChange}
      items={[
        { key: "all", label: `All (${counts.all})` },
        { key: "spawnable", label: `You spawn (${counts.spawnable})` },
      ]}
    />
  );
}

export interface RosterCell {
  /** `sessionStatus`'s own reading — the pill that says working / waiting on you / idle / exited / rate-limited. */
  state: { tone: Tone; label: string; glow?: boolean; solid?: boolean };
  card: { text: string; muted: boolean } | null;
  branch: string | null;
  context: { ratio: number; pct: number; tone: Tone } | null;
  lastEvent: { kind: string; at: string } | null;
}

export function RosterTable({ rows, cellFor }: {
  rows: RosterRow[];
  cellFor: (row: RosterRow) => RosterCell;
}) {
  return (
    <div className="loom-ovroster" data-testid="atlas-roster-table">
      <div className="loom-ovroster-head" aria-hidden>
        <span>Agent</span><span>State</span><span>Card</span><span>Branch</span>
        <span>Context</span><span>Last event</span><span />
      </div>
      {rows.map(({ session, child }) => {
        const c = cellFor({ session, child });
        return (
          <div key={session.id} className={`loom-ovroster-row${child ? " is-child" : ""}`}
            data-testid="atlas-roster-row" data-session-id={session.id}>
            <span className="loom-ovroster-agent">
              <Dot tone={c.state.tone} glow={c.state.glow} />
              <b title={session.agentName}>{session.agentName}</b>
              <i>{session.role ?? "session"}</i>
            </span>
            <span className="loom-ovroster-state">
              <StatusPill tone={c.state.tone} label={c.state.label} glow={c.state.glow} solid={c.state.solid}
                data-testid="atlas-roster-state" />
            </span>
            <span className="loom-ovroster-cell is-card" title={c.card?.text ?? undefined}>
              <span className="loom-ovroster-lbl">Card</span>
              {c.card
                ? <span style={c.card.muted ? { color: color.text3 } : undefined}>{c.card.text}</span>
                : <span style={{ color: color.text3 }}>—</span>}
            </span>
            <span className="loom-ovroster-cell is-branch">
              <span className="loom-ovroster-lbl">Branch</span>
              {c.branch
                ? <span style={{ color: color.text2 }} title={c.branch}>{c.branch}</span>
                : <span style={{ color: color.text3 }}>—</span>}
            </span>
            <span className="loom-ovroster-ctx">
              <span className="loom-ovroster-lbl">Context</span>
              {c.context ? (
                <>
                  <span className="loom-ovroster-track" aria-hidden>
                    <span style={{ width: `${Math.max(0, Math.min(1, c.context.ratio)) * 100}%`, background: toneFill[c.context.tone] }} />
                  </span>
                  <span className="loom-ovroster-pct" style={{ color: tone[c.context.tone] }}>{c.context.pct}%</span>
                </>
              ) : <span style={{ color: color.text3 }}>no reading</span>}
            </span>
            <span className="loom-ovroster-cell is-last">
              <span className="loom-ovroster-lbl">Last</span>
              {c.lastEvent
                ? <>{c.lastEvent.kind} <span style={{ color: color.text3 }}>{c.lastEvent.at}</span></>
                : <span style={{ color: color.text3 }}>—</span>}
            </span>
            <span className="loom-ovroster-open">
              <Link to={`/session/${session.id}`} className="loom-btn loom-btn-default loom-bandlink"
                title={`Open ${session.agentName}'s session`}>Open <span aria-hidden>↗</span></Link>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * "Work in flight" for a project with no sessions at all (card 006ed11f, audit G-04). The old line,
 * "No sessions in this project.", stated the fact and stopped; a new user's first visit had no way
 * forward from it. This names WHY nothing is running and offers the step that fixes it, in order:
 * a project with no agents can only define one, a project with agents can spawn one.
 *
 * `spawn` is the caller's `AgentsQuickSpawn`, passed in rather than imported, so the go-live guard
 * stays the one in `AgentActions` and this file keeps to its no-fetch contract. While the agent
 * read is in flight neither sentence is claimed: a loading roster is not an empty one.
 */
export function EmptyNextStep({ hasAgents, agentsLoaded, onNewAgent, spawn }: {
  hasAgents: boolean;
  agentsLoaded: boolean;
  onNewAgent: () => void;
  spawn: ReactNode;
}) {
  if (!agentsLoaded) return <p className="loom-bandempty">No sessions in this project.</p>;
  return (
    <div className="loom-ovempty" data-testid="atlas-overview-empty">
      <p className="loom-bandempty">
        {hasAgents
          ? "Nothing is running in this project. Spawn an agent to start a session."
          : "This project has no agents yet. Define one, then spawn it to start work."}
      </p>
      <div className="loom-ovempty-acts">
        {hasAgents && spawn}
        <Button variant={hasAgents ? "default" : "primary"} onClick={onNewAgent}
          data-testid="atlas-overview-empty-new-agent">
          <span aria-hidden>＋</span> New agent
        </Button>
      </div>
    </div>
  );
}

/** The board's lanes as label+count chips under the lane bar — the whole board signal in one strip,
 *  using the SAME `columnTone` resolver the bar, the board header and the card borders all read.
 *
 *  Each chip is a LINK to the Board tab at that lane (card 006ed11f, audit G-07): `?lane=<key>` is
 *  consumed by pages/Board.tsx, which scrolls the lane into view and marks it briefly. Access only —
 *  the summary itself is the owner's ruling (269f46ef) and is not widened into a board here. */
export function LaneChips({ lanes }: { lanes: BoardLane[] }) {
  return (
    <div className="loom-ovlanes" data-testid="atlas-overview-lanechips">
      {lanes.map((l) => {
        const t = columnTone(l);
        const accent = l.accentColor ?? (t ? tone[t] : color.lineStrong);
        const label = `Open the Board at ${l.label} (${l.count} ${l.count === 1 ? "card" : "cards"})`;
        return (
          <Link key={l.key} to={`/board?lane=${encodeURIComponent(l.key)}`} className="loom-ovlane"
            data-testid={`atlas-overview-lane-${l.key}`} title={label} aria-label={label}>
            <span className="loom-ovlane-dot" style={{ background: l.count > 0 ? accent : color.line }} aria-hidden />
            {l.label}
            <span className="loom-ovlane-n" style={{ color: l.count > 0 ? accent : color.text3, fontFamily: font.mono }}>{l.count}</span>
          </Link>
        );
      })}
    </div>
  );
}
