// The presentational kit the two Atlas home nodes are built from — card fd99b2d7 (Atlas build plan
// P2-1). Shapes only; every colour, font, radius and tone is the token the rest of the app already
// reads (src/theme.ts), and the chrome lives in styles/global.css beside the tree's own.
//
// ⛔ Nothing here fetches. The home pages do the reading (lib/atlasHome.ts composes it off existing
// `api.*` calls) and hand these components finished values, so a figure and the pop-over detail
// behind it are derived once, in one place, and cannot disagree.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { UsageLimitsStatus } from "@loom/shared";
import { Button, Panel, SectionLabel } from "./ui";
import { useAtlasNodeHeadSlot } from "../lib/atlasNodeHead";
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

/** The overflow trigger's word. A constant so the measuring pass and the painted chip agree. */
const MORE_LABEL = "More";

/**
 * How many leading tabs the row has room for.
 *
 * @decision 4a0ad464 — the row has no trailing content to budget against any more. Don't re-add a
 * side-width reservation here without a caller that actually puts something on this line.
 */
function computeFit(a: {
  widths: number[]; moreW: number; availW: number;
  rowGap: number; wrapGap: number; activeIdx: number;
}): number {
  const n = a.widths.length;
  const total = a.widths.reduce((s, w) => s + w, 0) + a.rowGap * Math.max(0, n - 1);
  const activeW = (a.activeIdx >= 0 ? a.widths[a.activeIdx] : 0) ?? 0;
  // The whole container width is the budget. Card d4350286 also reserved room for whatever ELSE
  // shared the line — the KPI strip the home nodes used to pass as children — and card 4a0ad464
  // removed that strip on the owner's own instruction, leaving the row alone on its line at every
  // width. The reservation is gone with its only consumer rather than left behind unreachable.
  const budget = a.availW;
  if (total <= budget) return n;
  const room = budget - a.moreW - a.wrapGap;
  // Greedy from the front, stopping at `stopAt` so a pinned active tab's own slot is never also
  // filled by one of the tabs ahead of it.
  const greedy = (limit: number, stopAt: number) => {
    let used = 0, count = 0;
    for (let i = 0; i < n && i !== stopAt; i++) {
      const step = (count === 0 ? 0 : a.rowGap) + (a.widths[i] ?? 0);
      if (used + step > limit) break;
      used += step; count++;
    }
    return count;
  };
  const plain = greedy(room, -1);
  if (a.activeIdx < 0 || a.activeIdx < plain) return plain;
  return greedy(room - activeW - a.rowGap, a.activeIdx);
}

export function NodeTabs({ tabs, active, hrefFor }: {
  tabs: NodeTab[];
  active: string;
  hrefFor: (key: string) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  /** Per-chip widths, captured once from the REAL row while it held every tab (see `measure`). */
  const metrics = useRef<{ widths: number[]; more: number } | null>(null);
  // `measure: true` draws every tab AND the trigger, which is what the layout effect below reads its
  // widths off. It runs before the browser paints, so the complete row is never seen — and it is the
  // reason there is no hidden mirror of the row in the DOM: a second copy of every tab label would
  // make each one an ambiguous page-wide text match (the trap [[atlas-nav-labels-collide-with-
  // exact-text-locators]] records), for widths the real row can hand over directly.
  const [layout, setLayout] = useState<{ fit: number; measure: boolean }>({ fit: tabs.length, measure: true });
  const [open, setOpen] = useState(false);

  const activeIdx = tabs.findIndex((t) => t.key === active);
  const measuring = layout.measure;
  // TWO fits, deliberately. The ROW's goes to `tabs.length` during a measuring pass, because drawing
  // every tab is how the widths get captured. The MENU's does not: `layout.fit` survives a re-measure
  // (`setLayout(cur => ({ ...cur, measure: true }))` never clears it), so the menu keeps rendering the
  // last settled overflow instead of briefly computing [] and tearing its own DOM down.
  //
  // @decision 485d67b4 — an OPEN menu must never lose its DOM, or its focus, to a measuring pass.
  // Never collapse these two back into one `fit`, and never gate the menu's own list on `measuring`.
  const settledFit = Math.max(0, Math.min(layout.fit, tabs.length));
  const fit = measuring ? tabs.length : settledFit;
  // ⭐ THE ACTIVE TAB STAYS ON THE ROW, swapping out whichever tab its width displaces — it is never
  // represented by the trigger instead. The phosphor underline IS this row's entire selected-state
  // affordance, so a row with nothing underlined and the current tab shut inside a closed menu
  // leaves "which tab am I on" unreadable at a glance. The alternative the card allowed — marking
  // More active and showing the active label on it — also gives the trigger a per-tab width this
  // very computation would have to re-derive, in an inline-flex chip that cannot ellipsise
  // (card f76b89b9). Consequence worth knowing: the menu therefore NEVER holds the active tab.
  // What the row holds once a pass has SETTLED — the menu's half of the split above. Identical to
  // `rowTabs` below whenever `measuring` is false, so nothing about a settled render moves.
  const settledPinned = activeIdx >= settledFit ? tabs[activeIdx] : undefined;
  const settledRow = settledPinned
    ? [...tabs.slice(0, settledFit), settledPinned]
    : tabs.slice(0, settledFit);
  const settledKeys = new Set(settledRow.map((t) => t.key));
  // Declaration order, so the menu reads as the rest of the row rather than a reshuffled list.
  const overflow = tabs.filter((t) => !settledKeys.has(t.key));

  const pinActive = !measuring && activeIdx >= fit;
  const pinned = pinActive ? tabs[activeIdx] : undefined;
  const rowTabs: NodeTab[] = measuring
    ? tabs
    : pinned ? [...tabs.slice(0, fit), pinned] : tabs.slice(0, fit);
  const showMore = measuring || overflow.length > 0;

  const chip = (t: NodeTab) => (
    <>
      {t.label}
      {t.count !== undefined && <span className="loom-atlas-tabcount">{t.count}</span>}
    </>
  );

  const recompute = useCallback(() => {
    const wrap = wrapRef.current, row = rowRef.current;
    if (!wrap || !row) return;
    if (!metrics.current) {
      // Only a pass that is currently drawing every tab plus the trigger can be measured.
      const chips = [...row.querySelectorAll<HTMLElement>("[data-nt-chip]")];
      const more = moreRef.current;
      if (chips.length !== tabs.length || !more) return;
      metrics.current = {
        widths: chips.map((el) => el.getBoundingClientRect().width),
        more: more.getBoundingClientRect().width,
      };
    }
    const rowStyle = getComputedStyle(row);
    const wrapStyle = getComputedStyle(wrap);
    const next = computeFit({
      widths: metrics.current.widths,
      moreW: metrics.current.more,
      // Shaded by a pixel: the row keeps its own `flex-wrap` as a safety net, so a sub-pixel
      // over-estimate only wraps instead of clipping — but wrapping still costs the line this
      // whole collapse exists to reclaim.
      availW: wrap.clientWidth - 1,
      rowGap: parseFloat(rowStyle.columnGap) || 0,
      wrapGap: parseFloat(wrapStyle.columnGap) || 0,
      activeIdx,
    });
    setLayout((cur) => (cur.fit === next && !cur.measure ? cur : { fit: next, measure: false }));
  }, [tabs.length, activeIdx]);

  // Deps-free on purpose: a parent re-render is also how a tab's count ticks, and that does not show
  // up in a dependency list. `setLayout` returns the identical object when
  // nothing changed, so React bails out rather than looping.
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;
  useLayoutEffect(() => { recomputeRef.current(); });

  // A label, a count's digit width or a late webfont all invalidate the captured widths. The
  // signature covers the first two; `document.fonts.ready` covers the third.
  const signature = tabs.map((t) => `${t.key}\u0000${t.label}\u0000${String(t.count ?? "")}`).join("\u0001");
  useEffect(() => {
    metrics.current = null;
    setLayout((cur) => ({ ...cur, measure: true }));
  }, [signature]);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => {
      if (!live) return;
      metrics.current = null;
      setLayout((cur) => ({ ...cur, measure: true }));
    }).catch(() => { /* no font API — the captured widths stand */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeRef.current());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  // A collapse that re-absorbed every tab must not leave an orphaned menu open over nothing.
  useEffect(() => { if (open && !measuring && overflow.length === 0) setOpen(false); },
    [open, measuring, overflow.length]);

  const slotRef = useDismissable<HTMLDivElement>(open, () => {
    // Escape arrives on the document with focus still inside the menu, so the trigger has to take
    // it back or the keyboard user is left on a node that is about to stop existing. An outside
    // CLICK has already put focus somewhere deliberate — pulling it back there would fight the user.
    const inside = !!slotRef.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) moreRef.current?.focus();
  });

  const focusItem = (i: number) => {
    const items = itemRefs.current.filter((el): el is HTMLAnchorElement => !!el);
    if (items.length > 0) items[((i % items.length) + items.length) % items.length]?.focus();
  };
  // The menu opens focused: a menu button that opens and leaves focus behind is unusable by keyboard.
  // Always item 0 — the active tab is pinned to the row, so the menu has no "current" item to land on.
  //
  // Keyed on the ITEM LIST as well as `open`, never on `open` alone: a genuine relayout while the
  // menu is open (a real resize, not the measuring pass the split above already neutralises) unmounts
  // the item holding focus, and the browser drops focus to <body> with nothing to put it back.
  // The second pass RECLAIMS focus only from <body> — focus the reader moved somewhere deliberate is
  // never stolen, which is why this is not simply `if (open) focusItem(0)` on every list change.
  const overflowKeys = overflow.map((t) => t.key).join("\u0001");
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;
    const a = document.activeElement;
    if (justOpened || !a || a === document.body) focusItem(0);
  }, [open, overflowKeys]);

  const onMoreKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space already fire `click` on a native <button>; these are the extra menu-button keys.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (open) focusItem(e.key === "ArrowDown" ? 0 : -1);
    else setOpen(true);
  };
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLAnchorElement => !!el);
    const cur = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
    else if (e.key === "Escape") {
      // Handled here as well as by useDismissable's document listener so the focus return happens
      // on the keystroke itself; both closes are idempotent.
      e.preventDefault(); e.stopPropagation();
      setOpen(false); moreRef.current?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };

  const menuId = "atlas-node-tabs-menu";
  // @decision 885e7a49 — `data-nt-measuring` has no runtime consumer by design; don't delete it as
  // unused. It marks a pass that is drawing every tab to capture widths, and is ABSENT once settled,
  // which is what a geometry read in e2e waits for rather than sampling one mid-measure.
  return (
    <div className="loom-atlas-tabs" data-testid="atlas-node-tabs" ref={wrapRef}
      data-nt-measuring={measuring ? "" : undefined}>
      <div className="loom-atlas-tabrow" role="tablist" aria-label="Node tabs" ref={rowRef}>
        {rowTabs.map((t) => (
          <Link key={t.key} to={hrefFor(t.key)} role="tab" aria-selected={t.key === active}
            data-testid={`atlas-tab-${t.key}`} data-nt-chip=""
            className={`loom-navtab${t.key === active ? " is-active" : ""}`}>
            {chip(t)}
          </Link>
        ))}
      </div>
      {/* ⛔ OUTSIDE the tablist: a `role="tablist"` takes `role="tab"` children, and a menu button is
          not one — so the trigger is its own flex item of `.loom-atlas-tabs`, beside the row. */}
      {showMore && (
        <div className="loom-atlas-tabmore-slot" data-nt-slot="more" ref={slotRef}>
          <button type="button" ref={moreRef} className="loom-navtab loom-atlas-tabmore"
            data-testid="atlas-node-tabs-more"
            aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((o) => !o)} onKeyDown={onMoreKeyDown}
            title={`${overflow.length} more ${overflow.length === 1 ? "tab" : "tabs"}`}>
            {MORE_LABEL}
            <span className="loom-atlas-tabmore-dots" aria-hidden="true">⋯</span>
          </button>
          {/* Rendered only while open, never parked with `hidden`: a closed copy would put every
              overflowed tab's label back in the document as a second text match. The tab BODIES stay
              mounted regardless — that is the panels' own contract at each call site, and nothing
              here unmounts one. */}
          {open && overflow.length > 0 && (
            <div className="loom-atlas-tabmenu" role="menu" id={menuId} aria-label="More node tabs"
              data-testid="atlas-node-tabs-menu" onKeyDown={onMenuKeyDown}>
              {overflow.map((t, i) => (
                <Link key={t.key} to={hrefFor(t.key)} role="menuitem" tabIndex={-1}
                  ref={(el) => { itemRefs.current[i] = el; }}
                  data-testid={`atlas-more-item-${t.key}`}
                  className="loom-atlas-tabmenu-item"
                  onClick={() => setOpen(false)}>
                  {chip(t)}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── KPI deck ───────────────────────────────────────────────────────────────────────────────────
// Six readouts at full size, each a button that opens the breakdown behind its own number.
//
// 🔴 SIZE IS THE FEATURE, not decoration. Round 3 shrank these readouts to pills on the tab row and
// the owner read the resulting page as "the board" rather than "an overview" — the dashboard
// furniture had not been removed, it had become too small to register as furniture (card 939922ee,
// round 3's own diagnosis). Card 4a0ad464 then removed the shrunk copy from the tab row outright, on
// the owner's own instruction, so these tiles are now a node's ONLY KPI readout. Don't shrink them,
// and don't mint a compact twin anywhere else on the node.

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

// ── Node head: pills + actions ─────────────────────────────────────────────────────────────────
// What a node portals into the frame's node-head slot (lib/atlasNodeHead.ts) — card 5968d7e0.
//
// A head pill is a STATE READING, never a KPI. The distinction is load-bearing and is what keeps
// this row off the ground the deck below already holds: a pill answers "what is this node doing
// right now" in one phrase (`4 working`, `main 57143a90`, `gen 412 · 318 turns`), while a deck tile
// is a labelled FIGURE from the node's six-item `kpis` array. They are also drawn differently on
// purpose — round corners and a tinted ground here, a full-size figure over a label there — so the
// two never read as one repeated readout.
//
// @decision 5968d7e0 — never feed this a figure the node's own `kpis` array already carries. The
// deck carries all six on the node's home tab, so a KPI restated here is the same number twice
// within ~50px, which is the shape card 939922ee's owner rejection names.

export interface NodeHeadPill {
  key: string;
  /** The whole reading, as one phrase. Not a label+value pair — that shape belongs to `KpiPill`. */
  text: ReactNode;
  tone?: Tone;
  /** The hover that expands a compressed reading (a short sha, an abbreviated branch). */
  title?: string;
}

/**
 * ONE head pill. The only element in the app allowed to wear `.loom-atlas-headpill`, so every pill
 * ellipsises the same way — including the session node's own `gen · turns`, which is drawn from
 * `components/SessionNode.tsx` rather than from a `NodeHeadPill` row.
 *
 * `children` is ONE run of text, nested in its own span: that span is what the ellipsis needs (see
 * `.loom-atlas-headpill-text`'s own note in styles/global.css). A reading made of separated parts
 * expresses its separator IN the text — `genReadout`'s `" · "` — rather than as sibling elements,
 * which the pill's `gap` would space but the ellipsis could no longer treat as one truncatable run.
 */
export function HeadPill({ children, tone: t, title, testId }: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  testId?: string;
}) {
  return (
    <span className={`loom-atlas-headpill is-${t ?? "muted"}`} data-testid={testId} title={title}>
      <span className="loom-atlas-headpill-text">{children}</span>
    </span>
  );
}

/**
 * The node's own pills and action cluster, portalled into the frame's node head.
 *
 * Renders NOTHING outside the frame — the slot is `null` under the classic shell, which has no node
 * head at all, so every consumer's classic path stays untouched by construction rather than by a
 * second branch. (Same contract `useFrameOwnsNodeIdentity` reads, card a7f23a2f.)
 */
export function AtlasNodeHead({ pills, actions }: { pills: NodeHeadPill[]; actions?: ReactNode }) {
  const slot = useAtlasNodeHeadSlot();
  if (!slot) return null;
  if (pills.length === 0 && !actions) return null;
  return createPortal(
    <div className="loom-atlas-nodehead-row" data-testid="atlas-nodehead-row"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div className="loom-atlas-headpills" data-testid="atlas-nodehead-pills">
        {pills.map((p) => (
          <HeadPill key={p.key} tone={p.tone} title={p.title} testId={`atlas-nodehead-pill-${p.key}`}>
            {p.text}
          </HeadPill>
        ))}
      </div>
      {/* Never compresses — the pills beside it are what give up width first, the same priority the
          session node's own header row gives its lifecycle cluster. */}
      {actions && (
        <div className="loom-atlas-headactions" data-testid="atlas-nodehead-actions">{actions}</div>
      )}
    </div>,
    slot,
  );
}

// ⛔ THERE IS NO TAB-ROW KPI STRIP, on any node or any tab — card 4a0ad464, the owner's own words:
// "Chips like … on the tabs row are not necessary and need too much space causing the need for a
// 'More..' tab. remove them." Card 7874e8c2's `nodeTabShowsKpiStrip` predicate and its `KpiStrip`
// are gone with it, and so is the trailing-content slot on `NodeTabs` they rode in. The node's
// readout is the full-size `KpiDeck` on its home tab, where SIZE IS THE FEATURE (see the deck's own
// note above) — a non-home tab simply carries no readout now.
//
// @decision 4a0ad464 — never put a compact figure strip back on a node's tab row. The owner read the
// chips as space the tabs needed; a re-shrunk readout there is the same rejection in a new costume.

/** One compact figure+label pill — the shape the dashboard disclosure's collapsed summary row states
 *  its counts in (card 44f725fe). Deliberately NOT a button: the full-size tiles own the breakdowns. */
export function KpiPill({ value, label, tone: t = "phosphor", title, testId }: {
  value: ReactNode;
  label: ReactNode;
  tone?: Tone;
  title?: string;
  testId?: string;
}) {
  return (
    <span className="loom-kpipill" data-testid={testId} title={title}>
      <span className="loom-kpipill-v" style={{ color: tone[t] }}>{value}</span>
      <span className="loom-kpipill-l">{label}</span>
    </span>
  );
}

// ── Dashboard band ─────────────────────────────────────────────────────────────────────────────

/** Where a viewer's folded/unfolded choice is kept. Stored as `"0"` = folded / ABSENT = unfolded,
 *  never `"1"`/`"0"`: EXPANDED is the default (a first visit must look like the page always did and
 *  hide nothing by surprise — Lead ruling on card 44f725fe), so an absent key is the same state as a
 *  never-visited browser and unfolding leaves no residue to reason about later. Same encoding
 *  discipline as `ATLAS_UI_STORAGE_KEY` (lib/atlasUi.ts). */
export const DASHBOARD_OPEN_STORAGE_KEY = "loom.atlasDashboardOpen";

/**
 * The dashboard disclosure's persisted state — `[open, setOpen]`.
 *
 * A per-browser DISPLAY preference, so it goes nowhere near `resolveConfig`, the platform-config
 * store or any `api.ts` member, and no agent can flip it. EVERY read and write is wrapped: storage
 * can throw outright (private mode, a blocked-cookies origin, quota) and the only safe answer to
 * "can't tell" is the default, which here is OPEN. Deliberately plain `useState` rather than
 * lib/atlasUi.ts's module store + `useSyncExternalStore`: that machinery exists to keep two
 * SEPARATE consumers (the Settings toggle and the shell) in step and to hold a cross-tab change
 * back from hot-applying it; this preference has one consumer and folding a band destroys no
 * unfinished input, so there is nothing for either mechanism to protect.
 */
export function useDashboardOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DASHBOARD_OPEN_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      if (next) localStorage.removeItem(DASHBOARD_OPEN_STORAGE_KEY);
      else localStorage.setItem(DASHBOARD_OPEN_STORAGE_KEY, "0");
    } catch {
      /* storage unavailable — the choice still holds for this page's lifetime, it just won't persist */
    }
  }, []);
  return [open, set];
}

/**
 * The dashboard band behind one disclosure bar (card 44f725fe, the owner's D1 pick on request
 * fb8de852). The bar is a summary ROW, not a tab row: folding costs the reader the DETAIL and never
 * the SIGNAL, because the collapsed bar keeps carrying the band's own live counts. That is the whole
 * trade — the honest cost is that a folded band stops showing the Pulse feed ambiently, and the
 * counts are the mitigation rather than a denial of it.
 *
 * 🔴 `.loom-atlas-band`'s own `display: grid` is an AUTHOR rule, so it OUT-SPECIFIES the UA's
 * `[hidden] { display: none }` and a `hidden` band stays fully laid out and visible. `global.css`
 * carries an explicit `.loom-atlas-band[hidden]` rule for exactly this, and the band element is
 * rendered HERE rather than passed in so the `hidden` attribute and the rule that makes it bite can
 * never drift into two different files. Measured in the mockup before that rule existed: the board
 * sat 1199px down the page with the band "collapsed".
 *
 * (Card 25c08fba's own record names the same trap from the tab-body side.)
 *
 * @decision 44f725fe — never park this band with an inline `display`, and never drop
 * `.loom-atlas-band[hidden]` from global.css: `hidden` alone loses to the band's `display: grid`.
 */
export function BandDisclosure({ open, onToggle, summary, children }: {
  open: boolean;
  onToggle: () => void;
  /** The live counts the bar keeps while the detail is folded — rendered only when it is. */
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="loom-banddisc">
      <button type="button" className="loom-banddisc-bar" data-testid="atlas-banddisc-bar"
        aria-expanded={open} aria-controls="atlas-dashboard-band" onClick={onToggle}
        title={open ? "Fold the dashboard away and give the board the page" : "Unfold the five dashboard panels"}>
        <span className="loom-banddisc-twist" aria-hidden>▸</span>
        <span className="loom-banddisc-lbl">Dashboard</span>
        <span className="loom-banddisc-sum" data-testid="atlas-banddisc-summary">{open ? null : summary}</span>
        <span className="loom-banddisc-hint">{open ? "Fold away" : "Unfold"}</span>
      </button>
      <div className="loom-atlas-band" id="atlas-dashboard-band" hidden={!open} data-testid="atlas-dashboard-band">
        {children}
      </div>
    </div>
  );
}

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
