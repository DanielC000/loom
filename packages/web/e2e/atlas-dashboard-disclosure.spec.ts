// The dashboard disclosure — card 44f725fe, the owner's D1 pick on request fb8de852 ("What is the
// need to have an overview tab, and a deck tab? Feels redundant to me. Unify the pages to one.").
// Design set: vault `Mockups/2026-10-28 Atlas unified project page/`.
//
// Card 4a0ad464 then applied the SAME pattern to the WORKSPACE node, whose Overview/Deck pair the
// owner's words covered just as much — so this file now carries a leg for each node. They are
// deliberately NOT one loop: the two nodes fold DIFFERENT panels onto DIFFERENT primary surfaces
// (the project's board, the workspace's project grid), and a shared loop would stop checking either
// for what it actually is.
//
// 🔴 THE PROJECT NODE NO LONGER HAS A BAND, A DISCLOSURE OR A BOARD (card 269f46ef). The owner's
// next round of feedback on that page was, verbatim, "Remove Board." and "Dashboard cards too
// cluttered on narrower page width. Remove 'AGENTS' card. Rework and Expand the rest of the cards
// now that the board is gone. Improve them." — so this file's original claim, that FOLDING THE BAND
// LIFTS THE BOARD, has neither a band nor a board left on that node to be about. It is not
// re-pointed and not quietly narrowed: the project describe block below asserts the ABSENCE and the
// composition that replaced it, and every fold claim below is now the WORKSPACE node's, which still
// mounts the same `BandDisclosure` over the same `.loom-atlas-band`.
//
// The five band panels sit behind ONE collapsible `Dashboard` bar on the Workspace node's single
// home tab, where they used to be split across an Overview tab and a Deck tab. The claim this spec
// is the witness for is that folding the band buys the node's primary surface vertical room WITHOUT
// spending its width, and costs no content:
//
//   1. THE FOLD ACTUALLY MOVES THE PRIMARY SURFACE. Its own top is measured in both states and
//      compared. A disclosure that toggled an attribute while the band stayed laid out would satisfy
//      every aria assertion and move nothing — which is exactly what `hidden` alone does here, since
//      `.loom-atlas-band`'s `display: grid` out-specifies the UA's `[hidden]` rule (card 25c08fba's
//      record names the same trap from the tab-body side). This is the assertion that catches it.
//   2. THE WIDTH IS NOT THE PRICE. Its client width is IDENTICAL in both states — the Deck tab's
//      whole trade was ~330px of it, so a fold that narrowed it would have re-introduced the cost
//      the unification exists to remove.
//   3. THE SIGNAL SURVIVES THE FOLD. Collapsed, the bar carries a live count for each panel it hid;
//      expanded, it carries none (the panels themselves are the detail). Both polarities, so a
//      summary row that was simply always rendered cannot pass.
//   4. THE CHOICE PERSISTS, BOTH WAYS. Folded survives a navigation, and so does unfolded — the
//      second half is what proves the storage write has a real clear path and is not a one-way
//      latch. (It used to be asserted ACROSS the two nodes, which shared one key; one of the two
//      consumers is gone, so the same leg now proves persistence on the node that remains and
//      checks that the other really draws no bar.)
//   5. THE PROJECT NODE'S OWN COMPOSITION, in the owner's order, with the board whole on its own
//      tab. (The standing directive that made the embed the primary board surface, card c6bdf358,
//      was overridden by the owner himself on card 269f46ef — see
//      docs/decisions/44f725fe-atlas-unified-project-home.md's own amendment.)
//   6. NO HORIZONTAL PAGE SCROLL AT 820px — on the Workspace node in both fold states, and on the
//      project node, each with a positive control that the overflow read can return a difference.
//   7. SWITCH OFF: the disclosure exists nowhere. The classic UI is untouched.
//
// @decision 269f46ef — do not re-point this file's fold claims at the project node. It has no band
// and no embedded board; the fold is the Workspace node's, and the project block below asserts the
// absence plus the composition that replaced it.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there first and only then what must not.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const WIDE = { width: 1600, height: 1000 };

// ⛔ The project node's own five-panel list and its four summary pills lived here until card
// 269f46ef removed that node's band. They are not re-listed as "panels that must be absent": the
// project leg below names the three the rework DISSOLVED and requires the two that SURVIVED as
// full-width cards to be present, which a flat absence list could not express.

// The WORKSPACE node's own five (pages/WorkspaceHome.tsx), and its own summary row.
const WS_BAND_PANELS = ["needs", "operators", "gates", "plan", "pulse"];
// ⚠️ THREE pills for FIVE panels, deliberately — NOT the project node's one-per-panel shape. The
// full-size KPI deck stays on screen when the band folds, and it already states `gate run·queued` and
// `plan 5h` verbatim, so a pill for either would be the same number twice within ~40px — the shape
// card 939922ee's owner rejection names. The bar carries what the fold actually TAKES OFF the page,
// plus `needs you`, which card 44f725fe kept across the same overlap for its own reason (it is the
// panel whose whole point is that it is waiting on you).
const WS_SUMMARY_PILLS = ["needs", "operators", "event"];
// ...and the two the deck already carries, which must NOT be restated on the bar.
const WS_PILLS_THE_DECK_CARRIES = ["gates", "plan"];

async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and that leg would be measuring this
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** A project whose board carries a KNOWN open-card count, so every figure read here is a derivation
 *  off seeded rows rather than "something rendered". The terminal-lane card is what makes `open` a
 *  real derivation: a tile that merely counted rows would read 4, not 3. */
async function seedProjectWithBoard(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("atlasdisc"));
  const inboxCard = uniq("disc-sentinel-INBOX");
  await loomDaemon.createTask(project.id, { title: inboxCard, columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: uniq("disc-sentinel-TODO"), columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: uniq("disc-sentinel-REVIEW"), columnKey: "review" });
  await loomDaemon.createTask(project.id, { title: uniq("disc-sentinel-DONE"), columnKey: "done" });
  return { project, inboxCard, open: 3, inReview: 1, total: 4 };
}

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`. Scoped through the grid so the
// band panels above (Panels too) can never be counted as lanes (same idiom as board.spec.ts).
const lanes = (page: Page) => page.locator(".loom-board-grid > .loom-grid");
const bar = (page: Page) => page.getByTestId("atlas-banddisc-bar");

/**
 * The WORKSPACE node's primary surface — its project grid, which is what the fold lifts there.
 *
 * ⚠️ Sampled until two consecutive reads AGREE, not read once. An unsettled "before" reports a
 * reflow that never happened, and the figure this claim rests on is a DIFFERENCE between two such
 * reads — so an unsettled one does not merely add noise, it manufactures the result
 * ([[atlas-ui-switch-and-shell-p1-0]] gotcha 2; the same discipline card a6d7a102 used for its own
 * no-reflow compare).
 *
 * (Its twin, the project node's `.loom-board-grid` reader, went with the fold it measured — card
 * 269f46ef; that node has no band and no embedded board to lift.)
 */
async function gridBox(page: Page): Promise<{ top: number; width: number }> {
  const read = async () => await page.locator(".loom-projgrid").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + window.scrollY), width: Math.round(el.clientWidth) };
  });
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    const next = await read();
    if (next.top === prev.top && next.width === prev.width) return next;
    prev = next;
  }
  return prev;
}

/** Whether the DOCUMENT scrolls horizontally — the page-level overflow, not a container's own. */
async function hasHorizontalPageScroll(page: Page): Promise<{ scrollW: number; clientW: number }> {
  return await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
}

test.describe("the project node has no dashboard disclosure (cards 44f725fe → 269f46ef)", () => {
  // 🔴 THIS LEG REPLACES THE TWO THAT MEASURED THE FOLD ON THIS NODE (card 269f46ef). Their shared
  // premise — "folding the band lifts the board" — needs a band and a board, and the owner removed
  // both from this tab ("Remove Board." / "Remove 'AGENTS' card. Rework and Expand the rest of the
  // cards now that the board is gone."), then picked direction C · Roster. So the claim is not
  // re-pointed, it is RETIRED on this node and asserted as an absence here; the identical fold
  // claim is still measured in full, on the node that still has a band, in the Workspace describe
  // block below (its own board/grid-lift geometry, its own summary pills, its own persistence).
  //
  // What this leg keeps from them, because neither depended on the band:
  //   · the FIXTURE IDENTITY discipline (a sibling daemon renders a plausible wrong page);
  //   · the 820px no-horizontal-page-scroll check, with a real positive control for the
  //     measurement — the only part of leg 2 that was about the page rather than the disclosure.
  // What it necessarily drops, named rather than quietly lost: the fold's own geometry delta, the
  // width-is-not-the-price compare, the summary-pill set, the persistence round trip and the
  // disclosure's focus ring. Each is a property of `BandDisclosure`, which this node no longer
  // mounts — all five are still asserted, unchanged, on the Workspace node below.
  //
  // @decision 269f46ef — never re-add a disclosure, a band or a board embed to this tab to make an
  // old leg pass again. All three were removed on the owner's own instruction.
  test("switch ON: the project node's Overview has no disclosure, no band and no board, and 820px has no horizontal page scroll", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY. Without this a silent fallback to a sibling worker's daemon would still
    // render a plausible, screenshot-able, entirely wrong page.
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    // …and it really is this spec's board behind the figures, settled before anything is asserted.
    await expect(page.getByTestId("atlas-brief-cards").locator(".loom-ovbrief-n"))
      .toHaveText(String(seeded.open));

    // ── (A) THE COMPOSITION THAT REPLACED THEM, in the owner's own order. `Needs you` is FIRST and
    //        full width — his one amendment to direction C, verbatim: "Overview C: 'Needs you'
    //        should be on top in its own row so it has enough space." Asserted as DOM order plus a
    //        width compare, because "it is on the page" is satisfied by it sitting anywhere.
    const order = await page.evaluate(() => {
      const ids = ["atlas-overview-brief", "atlas-band-needs", "atlas-overview-roster",
        "atlas-overview-board", "atlas-band-pulse"];
      const found = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
      if (found.some((el) => !el)) return null;
      const els = found as Element[];
      return {
        tops: els.map((el) => Math.round(el.getBoundingClientRect().top + window.scrollY)),
        needsW: Math.round(els[1]!.getBoundingClientRect().width),
        rosterW: Math.round(els[2]!.getBoundingClientRect().width),
      };
    });
    expect(order, "one of the five Overview sections is missing entirely").not.toBeNull();
    expect(order!.tops, "the five sections are in brief → needs → roster → board → pulse order")
      .toEqual([...order!.tops].sort((a, b) => a - b));
    expect(order!.needsW, "Needs you is a FULL-WIDTH row, not half of a two-up footer")
      .toBe(order!.rosterW);

    // ── (B) THE DISCLOSURE, THE BAND AND THE BOARD ARE ALL GONE from this tab. Asserted AFTER (A),
    //        which is these zeros' positive control: the page is loaded and composed.
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByTestId("atlas-dashboard-band")).toHaveCount(0);
    await expect(page.getByTestId("atlas-banddisc-summary")).toHaveCount(0);
    await expect(page.getByTestId("atlas-board-embed")).toHaveCount(0);
    await expect(lanes(page), "no board grid is mounted on the home tab").toHaveCount(0);
    // The three band panels the owner's rework dissolved rather than moved. `needs` and `pulse` are
    // deliberately NOT in this list — they survive as full-width cards under their own ids, which
    // (A) already required to be present.
    for (const key of ["agents", "fleet", "gates"]) {
      await expect(page.getByTestId(`atlas-band-${key}`)).toHaveCount(0);
    }

    // ── (C) THE BOARD'S SIGNAL DID NOT GO WITH IT. The lane strip states the same board per lane —
    //        so (B)'s zeros are "the board is on its own tab", not "the board data is gone".
    await expect(page.getByTestId("atlas-overview-board").locator(".loom-lanebar")).toBeVisible();
    await expect(page.getByTestId("atlas-overview-lane-review")).toContainText(String(seeded.inReview));

    // ── (D) 820px: no horizontal PAGE scroll. The briefing line wraps to 2-up here and the roster
    //        rows stack, so this is the width where either one failing to fold pushes the page wide.
    await page.setViewportSize({ width: 820, height: 1000 });
    await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
    const narrow = await hasHorizontalPageScroll(page);
    expect(narrow.scrollW, `820: scrollWidth ${narrow.scrollW} vs clientWidth ${narrow.clientW}`)
      .toBeLessThanOrEqual(narrow.clientW);
    // POSITIVE CONTROL on the measurement itself, kept from the leg this replaces: the board's own
    // grid DOES overflow its container at this width (7 lanes at a 240px minimum need 1740px, card
    // fd99b2d7's measured fact). It is one tab over now, so the control navigates there — the read
    // is capable of returning a difference, which is what makes the clean page result above real.
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    const gridOverflows = await page.locator(".loom-board-grid").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(gridOverflows, "the board grid does not overflow at 820, so the overflow read above proves nothing").toBe(true);
  });
});

test.describe("the Workspace node's dashboard disclosure (card 4a0ad464)", () => {
  // ⭐ CARD 4a0ad464's part C. RED on the pre-card build at every assertion: there was no disclosure
  // bar on `/home` at all — the band sat open and unfoldable on an Overview tab, and the board-first
  // reading lived on a separate `Deck` tab.
  test("switch ON: folding the dashboard lifts the project grid without narrowing it, and the choice persists", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/home");

    // FIXTURE IDENTITY. The workspace tier aggregates every project on a daemon this worker's other
    // specs also seed into, so the sentinel is THIS spec's own project card rather than any total.
    await expect(page.getByTestId(`atlas-project-card-${seeded.project.id}`)).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();

    // ── DEFAULT = EXPANDED, and the bar states no counts while the detail is on screen. ──
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    const offenders: string[] = [];
    for (const key of WS_BAND_PANELS) {
      if (await page.getByTestId(`atlas-band-${key}`).isVisible() !== true) offenders.push(`${key}: not visible unfolded`);
    }
    expect(offenders, "every band panel is on screen while the dashboard is unfolded").toEqual([]);
    await expect(page.getByTestId("atlas-banddisc-summary")).toBeEmpty();

    const expanded = await gridBox(page);
    // The band's own height, read unfolded. Since card 104a31a4 the band aligns to start and its panels
    // are capped rather than fixed at 320px, so a quiet daemon's band is shorter than it used to be: the
    // lift is asserted against what the band actually occupied, not a remembered constant.
    const bandHeight = (await page.getByTestId("atlas-dashboard-band").boundingBox())!.height;
    expect(bandHeight, "the unfolded band occupies real height").toBeGreaterThan(60);

    // ── THE FOLD ACTUALLY MOVES THE PRIMARY SURFACE. ──
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    // Hidden, not merely attributed: the assertion that fails if `.loom-atlas-band[hidden]` is ever
    // dropped and `hidden` is left to lose to the band's own `display: grid` (card 44f725fe's own
    // measured trap, which applies here identically because it is the same band element).
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();
    const stillShowing: string[] = [];
    for (const key of WS_BAND_PANELS) {
      if (await page.getByTestId(`atlas-band-${key}`).isVisible()) stillShowing.push(key);
    }
    expect(stillShowing, "a band panel is still on screen with the dashboard folded").toEqual([]);

    const collapsed = await gridBox(page);
    expect(expanded.top - collapsed.top, `grid top: ${expanded.top} unfolded → ${collapsed.top} folded, band ${bandHeight}px`)
      .toBeGreaterThanOrEqual(bandHeight - 1);
    // ── THE WIDTH IS NOT THE PRICE — the retired Deck tab spent 330px of it on a standing rail. ──
    expect(collapsed.width, `grid width: ${expanded.width} unfolded vs ${collapsed.width} folded`)
      .toBe(expanded.width);
    expect(collapsed.width, "the folded grid keeps the full content width").toBeGreaterThan(1250);

    // ── THE SIGNAL SURVIVES, and does NOT restate the deck. ──
    const summary = page.getByTestId("atlas-banddisc-summary");
    await expect(summary).toBeVisible();
    const missing: string[] = [];
    for (const key of WS_SUMMARY_PILLS) {
      if (await summary.getByTestId(`atlas-banddisc-pill-${key}`).count() !== 1) missing.push(key);
    }
    expect(missing, "the folded bar carries a live count for the signal the fold took off the page").toEqual([]);
    // The other polarity, which is the claim the three-pill shape actually makes: the two figures the
    // deck is still showing are NOT restated on the bar. Without this the list above would be
    // satisfied by a bar that simply carried everything.
    const restated: string[] = [];
    for (const key of WS_PILLS_THE_DECK_CARRIES) {
      if (await summary.getByTestId(`atlas-banddisc-pill-${key}`).count() !== 0) restated.push(key);
    }
    expect(restated, "the folded bar restates a figure the full-size deck is still showing").toEqual([]);
    // ...and the deck IS still showing them, so the absence above is a decision rather than a page
    // that lost its readout entirely.
    await expect(page.getByTestId("atlas-kpi-gates")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-plan")).toBeVisible();

    // ── NOTHING WAS DROPPED. The grid, its foot line (the retired Deck tab's own figure) and the
    //    fleet-controls bar are all still here with the band folded. ──
    await expect(page.getByTestId(`atlas-project-card-${seeded.project.id}`)).toBeVisible();
    await expect(page.getByTestId("atlas-grid-foot")).toContainText("open card");
    await expect(page.getByTestId("atlas-fleet-controls-bar")).toBeVisible();

    // ── IT PERSISTS, BOTH WAYS. ──
    await page.reload();
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page), "the fold did not survive a reload").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page), "the unfold did not survive a reload").toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
  });

  // ⭐ ONE PREFERENCE, ONE NODE NOW — and that is the whole of what is left to assert. This leg used
  // to drive the SAME storage key from both home nodes and prove a fold on one showed up on the
  // other. Card 269f46ef removed the band from the PROJECT node, so `useDashboardOpen` has exactly
  // one consumer (`pages/WorkspaceHome.tsx`) and the cross-node claim has no second node to cross
  // to: run as written it would assert nothing, because `/project` renders no bar at all. ⛔ It is
  // REPLACED here rather than deleted, because the thing worth keeping is one half of it — the
  // preference really is PERSISTED and really does CLEAR, which a one-way latch would also satisfy
  // on a single visit. (That the absent second consumer is genuinely absent, rather than silently
  // broken, is asserted in the project describe block above.)
  test("switch ON: the fold is a persisted preference with a real clear path", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);

    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");

    // It survives a FULL document load, not just a re-render — the write really reached storage.
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page), "the fold did not survive a navigation").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();

    // ...and back the other way, which is what proves it is not a one-way latch.
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page), "the unfold did not survive a navigation").toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    // The project node is pinned for this spec, so a stray bar there would be a real regression and
    // not an un-exercised path — checked once, here, where the key is known to be live.
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(bar(page), "the project node grew a dashboard disclosure back").toHaveCount(0);
  });
});
