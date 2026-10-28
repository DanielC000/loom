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
// The five band panels now sit behind ONE collapsible `Dashboard` bar on the node's single home tab,
// where they used to be split across an Overview tab (band + a 1316px board starting ~670px down) and
// a Deck tab (a 330px rail + a 974px board starting ~257px down). The claim this spec is the witness
// for is that folding the band buys the board the Deck's vertical room WITHOUT spending the
// Overview's width, and costs no content:
//
//   1. THE FOLD ACTUALLY MOVES THE BOARD. The board's own top is measured in both states and
//      compared. A disclosure that toggled an attribute while the band stayed laid out would satisfy
//      every aria assertion and move nothing — which is exactly what `hidden` alone does here, since
//      `.loom-atlas-band`'s `display: grid` out-specifies the UA's `[hidden]` rule (card 25c08fba's
//      record names the same trap from the tab-body side). This is the assertion that catches it.
//   2. THE WIDTH IS NOT THE PRICE. The board's client width is IDENTICAL in both states, and ~1316px
//      in both — the Deck tab's whole trade was 330px of it, so a fold that narrowed the board would
//      have re-introduced the cost the unification exists to remove.
//   3. THE SIGNAL SURVIVES THE FOLD. Collapsed, the bar carries a live count for each panel it hid;
//      expanded, it carries none (the panels themselves are the detail). Both polarities, so a
//      summary row that was simply always rendered cannot pass.
//   4. THE CHOICE PERSISTS, BOTH WAYS. Folded survives a reload, and so does unfolded — the second
//      half is what proves the storage write has a real clear path and is not a one-way latch.
//   5. THE BOARD STAYS WHOLE. All seven lanes and the seeded card, with the band folded. Owner-ruled
//      (card c6bdf358): this embed is the primary board surface and is never shrunk or summarized.
//   6. NO HORIZONTAL PAGE SCROLL AT 820px, in BOTH states.
//   7. SWITCH OFF: the disclosure exists nowhere. The classic UI is untouched.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there first and only then what must not.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const WIDE = { width: 1600, height: 1000 };

// The five panels the fold hides, by their own testids (pages/ProjectHome.tsx). Listed rather than
// counted off whatever is on screen: a band that quietly lost one would otherwise still pass.
const BAND_PANELS = ["needs", "agents", "fleet", "gates", "pulse"];
// One summary pill per hidden panel — `gates` and `pulse` are read as `gates` and `last event`, and
// `fleet` as `spawnable` (the figure its rows are there to act on).
const SUMMARY_PILLS = ["needs", "spawnable", "gates", "event"];

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
  return { project, inboxCard, open: 3, total: 4 };
}

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`. Scoped through the grid so the
// band panels above (Panels too) can never be counted as lanes (same idiom as board.spec.ts).
const lanes = (page: Page) => page.locator(".loom-board-grid > .loom-grid");
const bar = (page: Page) => page.getByTestId("atlas-banddisc-bar");

/**
 * The board's geometry, sampled until two consecutive reads AGREE.
 *
 * ⚠️ Not a single read. An unsettled "before" reports a reflow that never happened, and the figure
 * this spec's whole first claim rests on is a DIFFERENCE between two such reads — so an unsettled
 * one does not merely add noise, it manufactures the result ([[atlas-ui-switch-and-shell-p1-0]]
 * gotcha 2; the same discipline card a6d7a102 used for its own no-reflow compare).
 */
async function boardBox(page: Page): Promise<{ top: number; width: number }> {
  const read = async () => await page.locator(".loom-board-grid").evaluate((el) => {
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

/**
 * The same settled read for the WORKSPACE node's primary surface — its project grid, which is what
 * the fold lifts there (the project node's is its board). One helper shape, two selectors, rather
 * than one helper that guesses which node it is on.
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

test.describe("the project node's dashboard disclosure (card 44f725fe)", () => {
  test("switch ON: folding the dashboard lifts the board without narrowing it, and the choice persists", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    // FIXTURE IDENTITY. Without this a silent fallback to a sibling worker's daemon would still
    // render a plausible, screenshot-able, entirely wrong page — and every figure below would be
    // measured against someone else's board.
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    // …and it really is this spec's board behind the geometry, settled before anything is measured.
    await expect(page.getByTestId("atlas-kpi-cards").locator(".loom-kpi-value")).toHaveText(String(seeded.open));

    // ── (3a) DEFAULT = EXPANDED, and the bar states no counts while the detail is on screen. ──
    // A first visit must look like the page always did and hide nothing by surprise (Lead ruling).
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    const offenders: string[] = [];
    for (const key of BAND_PANELS) {
      if (await page.getByTestId(`atlas-band-${key}`).isVisible() !== true) offenders.push(`${key}: not visible unfolded`);
    }
    expect(offenders, "every band panel is on screen while the dashboard is unfolded").toEqual([]);
    await expect(page.getByTestId("atlas-banddisc-summary")).toBeEmpty();

    const expanded = await boardBox(page);

    // ── (1) THE FOLD. ──
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    // Hidden, not merely attributed: this is the assertion that fails if `.loom-atlas-band[hidden]`
    // is ever dropped and `hidden` is left to lose to the band's own `display: grid`.
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();
    const stillShowing: string[] = [];
    for (const key of BAND_PANELS) {
      if (await page.getByTestId(`atlas-band-${key}`).isVisible()) stillShowing.push(key);
    }
    expect(stillShowing, "a band panel is still on screen with the dashboard folded").toEqual([]);

    const collapsed = await boardBox(page);

    // The board moved UP, and by a real distance — the mockup measured y 710 → y 386 at this exact
    // viewport. A floor rather than those figures: the exact tops follow the node head's own pill
    // row, which is live data, while the DISTANCE is what the fold is for.
    expect(collapsed.top, `board top: ${expanded.top} unfolded → ${collapsed.top} folded`)
      .toBeLessThan(expanded.top - 200);
    // And it is the band's height that moved, not the whole page scrolling: the folded board starts
    // in the upper half of a 1000px viewport, where the unfolded one starts below the fold.
    expect(collapsed.top, "the folded board starts high on the page").toBeLessThan(500);
    expect(expanded.top, "the unfolded board starts below the band").toBeGreaterThan(600);

    // ── (2) THE WIDTH IS NOT THE PRICE. ──
    expect(collapsed.width, `board width: ${expanded.width} unfolded vs ${collapsed.width} folded`)
      .toBe(expanded.width);
    // ~1316px at 1600 — the Overview tab's own width, which the Deck tab spent 330px of on its rail.
    // A band rather than the exact figure (a scrollbar is a few px either way), but tight enough that
    // a reflow into a Deck-shaped two-column layout could not satisfy it.
    expect(collapsed.width, "the folded board keeps the full content width").toBeGreaterThan(1250);

    // ── (3b) THE SIGNAL SURVIVES. One live count per panel the fold hid. ──
    const summary = page.getByTestId("atlas-banddisc-summary");
    await expect(summary).toBeVisible();
    const missing: string[] = [];
    for (const key of SUMMARY_PILLS) {
      if (await summary.getByTestId(`atlas-banddisc-pill-${key}`).count() !== 1) missing.push(key);
    }
    expect(missing, "the folded bar carries a live count for each panel it hid").toEqual([]);
    // Not just PRESENT but READ FROM THE SAME DATA: `needs you` is the project's own attention
    // count, which this fixture has none of — so the pill must say 0 and not a placeholder dash.
    await expect(summary.getByTestId("atlas-banddisc-pill-needs")).toContainText("0");

    // ── (5) THE BOARD IS STILL WHOLE, FOLDED. ──
    await expect(page.getByTestId("atlas-board-embed").getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);
    // The LaneBar moved onto the board head permanently (it was Deck-only) — the one thing genuinely
    // unique to the removed tab, so its arrival here is what makes the removal lossless.
    await expect(page.getByTestId("atlas-board-embed").locator(".loom-lanebar")).toBeVisible();

    // ── (4) IT PERSISTS, BOTH WAYS. ──
    await page.reload();
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(bar(page), "the fold did not survive a reload").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();
    const afterReload = await boardBox(page);
    expect(Math.abs(afterReload.top - collapsed.top),
      `board top after reload: ${afterReload.top} vs ${collapsed.top} before it`).toBeLessThan(40);

    // The OTHER polarity, which is what proves the write has a real clear path rather than being a
    // one-way latch: unfold, reload, and it is still unfolded.
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(bar(page), "the unfold did not survive a reload").toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
  });

  test("switch ON: the keyboard reaches the disclosure, and 820px has no horizontal page scroll either way", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);

    // A real <button>, so it is a Tab stop and Enter/Space work with no handler of our own — focused
    // programmatically here rather than by counting Tab presses, which would pin an unrelated tab
    // order. What IS asserted is that focusing it shows a ring and that the keyboard toggles it.
    await bar(page).focus();
    await expect(bar(page)).toBeFocused();
    // ⛔ `:focus-visible` matching is NOT the assertion: Chromium paints its own UA ring, so it
    // passes with the stylesheet reverted ([[focus-ring-presence-is-vacuous-ua-ring-plus-clipping-
    // track]]). The style is what discriminates.
    expect(await bar(page).evaluate((el) => getComputedStyle(el).outlineStyle),
      "the disclosure bar's focus ring is the app's own, not the UA default").toBe("solid");
    await page.keyboard.press("Enter");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(" ");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");

    // ── (6) 820px, both states. The band folds to one column here and the KPI deck to two, so this
    //        is the width where a summary row that could not wrap would push the page wide. ──
    await page.setViewportSize({ width: 820, height: 1000 });
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();
    const unfolded = await hasHorizontalPageScroll(page);
    expect(unfolded.scrollW, `820 unfolded: scrollWidth ${unfolded.scrollW} vs clientWidth ${unfolded.clientW}`)
      .toBeLessThanOrEqual(unfolded.clientW);

    await bar(page).click();
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();
    await expect(page.getByTestId("atlas-banddisc-summary")).toBeVisible();
    const folded = await hasHorizontalPageScroll(page);
    expect(folded.scrollW, `820 folded: scrollWidth ${folded.scrollW} vs clientWidth ${folded.clientW}`)
      .toBeLessThanOrEqual(folded.clientW);
    // POSITIVE CONTROL on the measurement itself: the board's own grid DOES overflow its container at
    // this width (7 lanes at a 240px minimum need 1740px, card fd99b2d7's measured fact), so the
    // reads above are capable of returning a difference and a clean page result is a real one.
    const gridOverflows = await page.locator(".loom-board-grid").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(gridOverflows, "the board grid does not overflow at 820, so the overflow reads above prove nothing").toBe(true);
  });

  test("switch OFF: no dashboard disclosure exists on the classic project page", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    // Deliberately NOT seedAtlasOn — off is the default. The project is still pinned so the classic
    // page renders its real content rather than a pick-a-project empty state.
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/overview");

    // Presence FIRST: the classic shell AND the classic Overview's own board embed are really here,
    // so the absences below are absences and not a page that never loaded. (Same sentinel trio
    // atlas-home.spec.ts's own switch-OFF leg uses — `h1` is not one: the classic Overview has no
    // bare `<h1>`, measured.)
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByText(seeded.inboxCard, { exact: true })).toBeVisible();
    await expect(lanes(page)).toHaveCount(7);

    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByTestId("atlas-dashboard-band")).toHaveCount(0);
    await expect(page.getByTestId("atlas-banddisc-summary")).toHaveCount(0);
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
    expect(collapsed.top, `grid top: ${expanded.top} unfolded → ${collapsed.top} folded`)
      .toBeLessThan(expanded.top - 200);
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

  // ⭐ ONE PREFERENCE, BOTH NODES — the two bands read the SAME storage key on purpose: the band is
  // the same furniture on both, and two keys would make "fold the dashboard away" mean two different
  // things depending on which node you happened to be standing on when you asked for it. Asserted
  // rather than left implicit, because it is a choice a reader would otherwise have to infer.
  test("switch ON: the fold is one preference shared by both home nodes", async ({ page, loomDaemon }) => {
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

    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
    await expect(bar(page), "folding the workspace band left the project band unfolded")
      .toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("atlas-dashboard-band")).toBeHidden();

    // ...and back the other way, so this is a shared preference rather than a one-way write.
    await bar(page).click();
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(bar(page), "unfolding the project band left the workspace band folded")
      .toHaveAttribute("aria-expanded", "true");
  });

  test("switch OFF: no dashboard disclosure exists on the classic Mission-Control-era pages", async ({ page, loomDaemon }) => {
    const seeded = await seedProjectWithBoard(loomDaemon);
    // Deliberately NOT seedAtlasOn — off is the default.
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/");

    // Presence FIRST: the classic shell really is here, so the absences below are absences and not a
    // page that never loaded.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByTestId("atlas-dashboard-band")).toHaveCount(0);
    await expect(page.getByTestId("atlas-banddisc-summary")).toHaveCount(0);
    // ...and the Atlas-only workspace node is not mounted in the classic shell either.
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
  });
});
