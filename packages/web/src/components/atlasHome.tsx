// The presentational kit the two Atlas home nodes are built from — card fd99b2d7 (Atlas build plan
// P2-1). Shapes only; every colour, font, radius and tone is the token the rest of the app already
// reads (src/theme.ts), and the chrome lives in styles/global.css beside the tree's own.
//
// ⛔ Nothing here fetches. The home pages do the reading (lib/atlasHome.ts composes it off existing
// `api.*` calls) and hand these components finished values, so a figure and the pop-over detail
// behind it are derived once, in one place, and cannot disagree.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { UsageLimitsStatus } from "@loom/shared";
import { Button, Panel, SectionLabel } from "./ui";
import { useDismissable } from "../lib/useDismissable";
import type { BoardLane } from "../lib/atlasHome";
import { color, columnTone, font, radius, tone, type Tone } from "../theme";

// ── Node tabs ──────────────────────────────────────────────────────────────────────────────────
// Real addresses, not local state: a tab is a `?tab=` on the node's own path, so it is linkable,
// survives a reload, and leaves the back button meaning what it means everywhere else. NavLink is
// deliberately NOT used — its `isActive` matches on pathname alone, so both tabs would read active
// on the same path. The class is the SAME `.loom-navtab` the rest of the app's tab rows wear.

export interface NodeTab {
  key: string;
  label: string;
  /** Rendered after the label in the muted count position, e.g. a lane count. */
  count?: ReactNode;
}

export function NodeTabs({ tabs, active, hrefFor, children }: {
  tabs: NodeTab[];
  active: string;
  hrefFor: (key: string) => string;
  /** Trailing content on the same row — the Deck tab's compact KPI strip sits here. */
  children?: ReactNode;
}) {
  return (
    <div className="loom-atlas-tabs" data-testid="atlas-node-tabs">
      <div className="loom-atlas-tabrow" role="tablist" aria-label="Node tabs">
        {tabs.map((t) => (
          <Link key={t.key} to={hrefFor(t.key)} role="tab" aria-selected={t.key === active}
            data-testid={`atlas-tab-${t.key}`}
            className={`loom-navtab${t.key === active ? " is-active" : ""}`}>
            {t.label}
            {t.count !== undefined && <span className="loom-atlas-tabcount">{t.count}</span>}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}

// ── KPI deck ───────────────────────────────────────────────────────────────────────────────────
// Six readouts at full size, each a button that opens the breakdown behind its own number.
//
// 🔴 SIZE IS THE FEATURE, not decoration. Round 3 shrank these readouts to pills on the tab row and
// the owner read the resulting page as "the board" rather than "an overview" — the dashboard
// furniture had not been removed, it had become too small to register as furniture (card 939922ee,
// round 3's own diagnosis). The Overview tab gets the full tiles; the Deck tab, which IS board-first
// on purpose, gets the compact strip below instead. Don't collapse the two.

export interface KpiItem {
  key: string;
  label: string;
  /** The headline figure. A string so "1·2" and "71%" read as one glyph run, not as a number plus chrome. */
  value: ReactNode;
  /** One line under the figure — what the number is made of. */
  sub?: ReactNode;
  tone?: Tone;
  /** 0–1. Draws the hairline fill under the sub-line; omit for a figure with no natural ceiling. */
  fill?: number;
  /** The breakdown behind the figure. A tile with none is a plain readout, not a button. */
  popover?: ReactNode;
}

export function KpiDeck({ items }: { items: KpiItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="loom-kpideck" data-testid="atlas-kpi-deck">
      {items.map((item, i) => (
        <KpiTile key={item.key} item={item}
          open={open === item.key}
          // The last two tiles hang their pop-over from the RIGHT edge so it stays inside the content
          // column. Index-based rather than measured: the deck's column count is fixed by CSS at each
          // breakpoint, so the edge tiles are known without reading layout back out of the DOM.
          // ⛔ That holds because `.loom-kpideck` DECLARES its count (6 → 3 → 2, card 14e48890). Go
          // back to a width-derived `auto-fit` track list and the count floats between breakpoints,
          // which put the orphaned last tile at the LEFT edge of its own row still right-aligning
          // its pop-over — read that note before changing the grid.
          align={i >= items.length - 2 ? "right" : "left"}
          onToggle={() => setOpen((cur) => (cur === item.key ? null : item.key))}
          onClose={() => setOpen(null)} />
      ))}
    </div>
  );
}

function KpiTile({ item, open, align, onToggle, onClose }: {
  item: KpiItem; open: boolean; align: "left" | "right"; onToggle: () => void; onClose: () => void;
}) {
  // The wrapper holds BOTH the trigger and the panel, which is what makes outside-click correct —
  // clicking inside the pop-over must not close it. Escape closes too (useDismissable).
  const ref = useDismissable<HTMLDivElement>(open, onClose);
  const t = item.tone ?? "phosphor";
  const popId = `atlas-kpi-pop-${item.key}`;
  const body = (
    <>
      <span className="loom-kpi-label">{item.label}</span>
      <span className="loom-kpi-value" style={{ color: tone[t] }}>{item.value}</span>
      {item.sub !== undefined && <span className="loom-kpi-sub">{item.sub}</span>}
      {item.fill !== undefined && (
        <span className="loom-kpi-track" aria-hidden>
          <span className="loom-kpi-fill"
            style={{ width: `${Math.max(0, Math.min(1, item.fill)) * 100}%`, background: tone[t] }} />
        </span>
      )}
    </>
  );

  if (!item.popover) {
    return <div className="loom-kpi" data-testid={`atlas-kpi-${item.key}`}>{body}</div>;
  }
  return (
    <div className="loom-kpi-slot" ref={ref}>
      <button type="button" className={`loom-kpi is-button${open ? " is-open" : ""}`}
        data-testid={`atlas-kpi-${item.key}`}
        aria-expanded={open} aria-controls={open ? popId : undefined}
        // The sub-line ellipsises at this column width, so the hover carries it in full — the
        // pop-over is the real answer, but a title costs nothing and beats a truncated sentence.
        title={`${item.label}${typeof item.sub === "string" ? ` — ${item.sub}` : ""} · open the breakdown`}
        onClick={onToggle}>
        {body}
      </button>
      {open && (
        <div id={popId} className="loom-kpi-pop" data-testid={`atlas-kpi-pop-${item.key}`}
          style={align === "right" ? { right: 0 } : { left: 0 }}>
          <div className="loom-kpi-pophead">
            <SectionLabel style={{ margin: 0 }}>{item.label}</SectionLabel>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" data-testid={`atlas-kpi-close-${item.key}`}
              aria-label={`Close the ${item.label} breakdown`} title="Close"
              onClick={onClose} style={{ padding: "0 6px", lineHeight: 1.2 }}>×</Button>
          </div>
          <div className="loom-kpi-popbody">{item.popover}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Which of a home node's tabs carry the compact strip on their tab row. The rule is not a list of
 * tab keys but a predicate — *every tab whose own body does not already carry the node's readout* —
 * so a tab a later card re-homes onto a node inherits the strip without this being touched.
 *
 * @decision 7874e8c2 — never make this return true for `overview`: the strip and the deck are fed
 * the same `kpis`, so a strip there renders the node's six figures twice on one screen.
 */
export function nodeTabShowsKpiStrip(tab: string): boolean {
  return tab !== "overview";
}

/** The compact readouts carried on every node tab but Overview — the same figures, sized to sit on
 *  the tab row beside the tabs rather than to be read first. Deliberately NOT buttons: the Overview
 *  tab owns the breakdowns. */
export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <div className="loom-kpistrip" data-testid="atlas-kpi-strip">
      {items.map((item) => (
        // Keyed by the SAME `item.key` the deck's own tile testid is built from, so a reader can
        // pair a pill with its tile without going through the label — which CSS upper-cases, and
        // which `innerText` therefore returns in a different case than the source.
        <span key={item.key} className="loom-kpipill" data-testid={`atlas-kpi-pill-${item.key}`}
          title={`${item.label}${item.sub ? ` — ${typeof item.sub === "string" ? item.sub : ""}` : ""}`}>
          <span className="loom-kpipill-v" style={{ color: tone[item.tone ?? "phosphor"] }}>{item.value}</span>
          <span className="loom-kpipill-l">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

// ── Dashboard band ─────────────────────────────────────────────────────────────────────────────

/** One band panel: a head (label · count · an optional way out to the full surface) over a body that
 *  owns its own scroll, so a long list never makes one panel taller than its neighbours. */
export function BandPanel({ label, count, action, children, style, testId }: {
  label: string;
  count?: ReactNode;
  /** The "see all of this" affordance — a link to the destination this panel is a window onto. */
  action?: { to: string; label: string };
  children: ReactNode;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <Panel data-testid={testId} className="loom-bandpanel" style={style}>
      <div className="loom-bandhead">
        {/* nowrap on both: a band column is ~250px wide, and a label allowed to wrap inside the head
            pushes the row to two lines for a reason the reader cannot see. Keep the LABEL short
            instead — the head wrapping is the safety net, not the plan. */}
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>{label}</SectionLabel>
        {count !== undefined && <span className="loom-bandcount">{count}</span>}
        <span style={{ flex: 1 }} />
        {action && (
          <Link to={action.to} className="loom-btn loom-btn-default loom-bandlink" title={`Open ${action.label}`}>
            {action.label} <span aria-hidden>↗</span>
          </Link>
        )}
      </div>
      <div className="loom-bandbody">{children}</div>
    </Panel>
  );
}

/**
 * A panel whose content is a LATER card's job. P2-1 builds the Overview/Deck frame only — the Agents
 * roster (P2-2) and the fleet controls cluster (P2-3) are their own cards — so the band is laid out
 * with their columns already in it rather than reflowing around them when they land.
 *
 * Deliberately visible and deliberately named. A silently-absent column would read as a finished
 * design that simply lacks those controls, which is exactly the misreading the owner would have to
 * catch for us while comparing Atlas against the live app behind the switch.
 */
export function SlotPanel({ slot, label, card, what, bar }: {
  /** Short, stable key for the test id — the card reference below is prose and will be reworded. */
  slot: string; label: string; card: string; what: string;
  /** A full-width notice above the band rather than one of its columns — sizes to its own content. */
  bar?: boolean;
}) {
  return (
    <div className={`loom-bandpanel loom-bandslot${bar ? " is-bar" : ""}`} data-testid={`atlas-slot-${slot}`}>
      <div className="loom-bandhead">
        <SectionLabel style={{ margin: 0, color: color.textMuted }}>{label}</SectionLabel>
      </div>
      <div className="loom-bandbody">
        <p className="loom-slotnote">{what}</p>
        <p className="loom-slotnote loom-slotcard">Arrives with {card}</p>
      </div>
    </div>
  );
}

/** Empty-state line inside a band panel — one muted sentence, never a panel-filling illustration. */
export function BandEmpty({ children }: { children: ReactNode }) {
  return <p className="loom-bandempty">{children}</p>;
}

// ── Lane bar ───────────────────────────────────────────────────────────────────────────────────

/**
 * A board's shape in one 6px bar: one segment per lane, weighted by card count and tinted by the
 * lane's own lifecycle role — the SAME `columnTone` resolver the board header, the card left-border
 * and the drawer's lane badge read, so a project card and that project's board agree on colour.
 * An empty board draws the bare track rather than vanishing, so the row keeps its height.
 */
export function LaneBar({ lanes, title }: { lanes: BoardLane[]; title?: string }) {
  const total = lanes.reduce((n, l) => n + l.count, 0);
  return (
    <span className="loom-lanebar" title={title ?? lanes.map((l) => `${l.label} ${l.count}`).join(" · ")} aria-hidden>
      {total === 0
        ? <span className="loom-laneseg" style={{ flex: 1, background: color.border }} />
        : lanes.filter((l) => l.count > 0).map((l) => (
          <span key={l.key} className="loom-laneseg"
            style={{ flex: l.count, background: l.accentColor ?? (columnTone(l) ? tone[columnTone(l)!] : color.borderStrong) }} />
        ))}
    </span>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────────────────────────

/** A label·value row — the pop-overs' and panels' one list grammar. */
export function DataRow({ label, value, tone: t, title }: {
  label: ReactNode; value: ReactNode; tone?: Tone; title?: string;
}) {
  return (
    <div className="loom-datarow" title={title}>
      <span className="loom-datarow-l">{label}</span>
      <span className="loom-datarow-v" style={t ? { color: tone[t] } : undefined}>{value}</span>
    </div>
  );
}

/** A labelled meter row for a pop-over — a name, a bar, and the figure it measures. */
export function MeterRow({ label, ratio, value, tone: t = "phosphor" }: {
  label: ReactNode; ratio: number; value: ReactNode; tone?: Tone;
}) {
  return (
    <div className="loom-meterrow">
      <span className="loom-meterrow-l">{label}</span>
      <span className="loom-meterrow-track" aria-hidden>
        <span style={{ display: "block", height: "100%", borderRadius: radius.sm,
          width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: tone[t] }} />
      </span>
      <span className="loom-meterrow-v" style={{ color: tone[t] }}>{value}</span>
    </div>
  );
}

/** A daily series as bars — the band's merge-throughput sparkline. Last bar is today, and it is lit. */
export function DayBars({ series, label }: { series: { day: string; branches: number }[]; label: string }) {
  const max = Math.max(1, ...series.map((d) => d.branches));
  return (
    <div className="loom-daybars" role="img" aria-label={`${label}: ${series.map((d) => `${d.day} ${d.branches}`).join(", ")}`}>
      {series.map((d, i) => (
        <span key={d.day} className="loom-daybar" title={`${d.day} · ${d.branches}`}>
          <span style={{
            display: "block", width: "100%", borderRadius: 1,
            height: `${Math.max(2, (d.branches / max) * 100)}%`,
            background: i === series.length - 1 ? color.phosphor : color.borderStrong,
          }} />
        </span>
      ))}
    </div>
  );
}

/** The mono caption used under a panel body — a footer fact, not a second heading. */
export function BandFoot({ children }: { children: ReactNode }) {
  return <div className="loom-bandfoot" style={{ fontFamily: font.mono }}>{children}</div>;
}

// ── Plan usage ─────────────────────────────────────────────────────────────────────────────────
// Lives in the kit rather than on the Workspace node (card 7b893d54) because TWO surfaces read it
// now: that node's plan tile + band panel, and the fleet-controls pop-over, where the headroom
// figures are the context that makes "clear usage hold" a judgement rather than a guess. Still
// fetch-free — the caller hands it a finished value, same as everything else here.

/** `UsageLimitsStatus` is a discriminated union — every window only exists on the AVAILABLE arm, and
 *  the unavailable one carries a `reason` instead. Narrowing once at the read keeps that check off
 *  each of the four gauges below. */
export type AvailableUsage = Extract<UsageLimitsStatus, { available: true }>;

/** The real plan headroom — the daemon's cached OAuth poll, read through the same `["usageLimits"]`
 *  entry components/fleet.tsx's PlanUsageStrip fills. Every failure mode is a muted line, never an
 *  error state: the figure is informational and an unavailable one must not look like a fault. */
export function PlanUsageDetail({ usage }: { usage: AvailableUsage | null }) {
  if (!usage) return <BandEmpty>Plan usage is unavailable on this daemon.</BandEmpty>;
  // Same thresholds components/fleet.tsx's own `usageTone` uses, and the same ones the CONTEXT
  // meters read: phosphor < 80% ≤ amber < 95% ≤ red.
  const t = (u: number): Tone => (u >= 95 ? "red" : u >= 80 ? "amber" : "phosphor");
  return (
    <>
      <MeterRow label="5h session" ratio={usage.fiveHour.utilization / 100}
        value={`${Math.round(usage.fiveHour.utilization)}%`} tone={t(usage.fiveHour.utilization)} />
      <MeterRow label="7d weekly" ratio={usage.sevenDay.utilization / 100}
        value={`${Math.round(usage.sevenDay.utilization)}%`} tone={t(usage.sevenDay.utilization)} />
      {usage.sevenDayOpus && (
        <MeterRow label="7d opus" ratio={usage.sevenDayOpus.utilization / 100}
          value={`${Math.round(usage.sevenDayOpus.utilization)}%`} tone={t(usage.sevenDayOpus.utilization)} />
      )}
      {usage.sevenDaySonnet && (
        <MeterRow label="7d sonnet" ratio={usage.sevenDaySonnet.utilization / 100}
          value={`${Math.round(usage.sevenDaySonnet.utilization)}%`} tone={t(usage.sevenDaySonnet.utilization)} />
      )}
      <BandFoot>5h resets {relativeResets(usage.fiveHour.resetsAt)}.</BandFoot>
    </>
  );
}

/** "in 1h 42m" / "now" / "—" — the countdown grammar components/fleet.tsx's own gauges use. */
export function relativeResets(resetsAt: string | null): string {
  if (!resetsAt) return "—";
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}
