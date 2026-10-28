// The node tab row's overflow menu — card d4350286 (Atlas, epic 9fe8cd4e), owner decision 5b91bcc0
// ("Build the overflow More menu"). Design record: docs/decisions/d4350286-atlas-node-tab-overflow.md.
//
// 🔴 CARD 4a0ad464 TOOK THIS CARD'S SUBJECT AWAY AT DESKTOP WIDTHS, deliberately. The overflow
// existed because the KPI strip card 7874e8c2 put on every tab could not fit BESIDE the row and
// wrapped under it, taking the tab BLOCK from 35px to 74px at 1440. The owner then asked for the
// strip itself to go — verbatim: "Chips like … on the tabs row are not necessary and need too much
// space causing the need for a 'More..' tab. remove them." — so the row is alone on its line and
// every declared tab FITS at every desktop width. The machinery stays: it is still what keeps a
// nine-tab row reachable at phone width, where it was never the strip that made the tabs overflow.
//
// MEASURED on this build (card 4a0ad464's own sweep, both home nodes, no strip anywhere): a trigger
// appears at 900 and below with the tree rail present, and — because the rail becomes a DRAWER below
// 820px and hands the column its width back — NOT at 820 or 720 for the project node, then again at
// 600 and below. The block is 35px, one line, at every width in that sweep. So the legs that need a
// real fold now run at `FOLD_WIDTH` rather than 1440.
//
// What each leg measures:
//   1. SWITCH ON at 1280/1440/1920 — card 4a0ad464's own claim: both home nodes' whole tab block is
//      ONE line with NO trigger at all, the row holds the entire declared set, and no KPI strip
//      exists on it. This leg is RED on the pre-card build at every one of those widths.
//   2. The PLATFORM node is the INERT control: 5 tabs, never a strip, never a fold. (Stated plainly:
//      that leg was green before card d4350286 too — a non-regression control, not a discriminator.)
//   3. At FOLD_WIDTH, an overflowed tab selected THROUGH the menu navigates, the panel actually
//      changes (the rendered panel's own text is fingerprinted on both sides, not just a testid
//      flip), and the tab lands back IN THE ROW — this build's active-tab rule.
//   4. Keyboard: Enter opens, Space opens, arrows move, Escape closes and returns focus, and a
//      selected item navigates exactly like the tab.
//   5. A typed draft in a panel survives a trip out through the menu and back.
//   6. 720 and 420, where the tree is a drawer (card 49e883a9): no horizontal overflow, the tab row
//      is one line, and the menu still opens and selects wherever it folds.
//   7. SWITCH OFF — no trigger and no menu exist anywhere.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
//
// @decision 4a0ad464 — don't delete this spec, or the machinery it covers, because no desktop width
// folds any more. Phone width still does, and every leg that needs a fold asserts it rather than
// assuming it, so a width that stopped folding fails loudly instead of going vacuous.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
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

/**
 * A width at which BOTH home nodes' rows genuinely overflow, so the menu legs below have a menu.
 *
 * ⚠️ Not a round desktop number any more: card 4a0ad464 removed the KPI strip, and with the row
 * alone on its line every declared tab fits at 1000 and above. 900 is the widest width in that
 * card's own sweep where both nodes still fold — and it is deliberately ABOVE the 820px drawer
 * breakpoint, so these legs keep exercising the ordinary desktop layout (tree rail present) rather
 * than quietly becoming a second copy of the narrow-width leg at the foot of this file.
 *
 * Each leg that uses it still ASSERTS the fold it depends on rather than assuming it, so a future
 * label change that makes the row fit here fails loudly instead of going vacuous.
 */
const FOLD_WIDTH = 900;

/**
 * A project whose board carries a KNOWN open-card count — the same seed shape atlas-home.spec.ts and
 * atlas-node-kpi-strip.spec.ts use. The terminal card is what makes "open cards" a derivation rather
 * than a row count: a readout that simply counted cards would say 4, not 3. It is this spec's
 * identity sentinel too — without it a silent fallback to a sibling worker's daemon would render a
 * plausible, measurable, entirely wrong tab row.
 */
async function seedProjectWithBoard(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("taboverflow"));
  await loomDaemon.createTask(project.id, { title: uniq("to-INBOX"), columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: uniq("to-TODO"), columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: uniq("to-REVIEW"), columnKey: "review" });
  await loomDaemon.createTask(project.id, { title: uniq("to-DONE"), columnKey: "done" });
  return { project, open: 3 };
}

interface Block {
  tabKeys: string[];
  tabTops: number[];
  /** `.loom-atlas-tabs`' real height — what goes from 35 to 74 when anything on the row wraps. */
  blockH: number;
  /**
   * The height that block WOULD have with everything on one line, derived from the row's own line
   * box plus the wrapper's own padding and border. Derived, never typed: a later card retuning
   * `.loom-atlas-tabs`' padding must not silently turn this assertion into a tautology or a lie.
   */
  oneLineH: number;
  rowH: number;
  rowTops: number;
  hasMore: boolean;
  /** The trigger's vertical centre matches the row's — i.e. it is ON the row's line, not under it. */
  moreOnRowLine: boolean | null;
  /** A tab-row KPI strip, which card 4a0ad464 removed — kept as a REGRESSION detector, asserted false. */
  stripPresent: boolean;
  docOverflow: boolean;
}

/**
 * Everything about the tab block's geometry, read off the live document in one pass — once the row
 * is out of its MEASURING state.
 *
 * @decision 885e7a49 — Never read this geometry on a bare `toBeVisible()`: a measuring pass draws
 * every tab plus the trigger, so a row that settles folded reads unfolded mid-pass. Wait on
 * `data-nt-measuring`, the component's own pass flag — never on the geometry under test, which
 * would make these legs unfalsifiable.
 */
async function blockGeometry(page: Page): Promise<Block> {
  const block = page.getByTestId("atlas-node-tabs");
  await expect(block).toBeVisible();
  await expect
    .poll(() => block.evaluate((el) => el.hasAttribute("data-nt-measuring")),
      { message: "the tab row is still in a measuring pass, so its geometry is mid-flight" })
    .toBe(false);
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".loom-atlas-tabs");
    const row = document.querySelector<HTMLElement>(".loom-atlas-tabrow");
    if (!wrap || !row) throw new Error("no Atlas tab block on this page");
    const cs = getComputedStyle(wrap);
    const rowRect = row.getBoundingClientRect();
    const rowMid = rowRect.top + rowRect.height / 2;
    // `.loom-atlas-tabs` centres its items, so two items on the SAME flex line share a vertical
    // centre and two on different lines cannot. 4px of slack covers sub-pixel layout, nothing more:
    // the row is 28px tall, so a wrapped item is at least 34px away.
    const onRowLine = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.abs(r.top + r.height / 2 - rowMid) <= 4;
    };
    const links = [...row.querySelectorAll<HTMLElement>('[role="tab"]')];
    return {
      tabKeys: links.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, "")),
      tabTops: [...new Set(links.map((el) => el.offsetTop))],
      blockH: Math.round(wrap.getBoundingClientRect().height),
      oneLineH: Math.round(rowRect.height + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)),
      rowH: Math.round(rowRect.height),
      rowTops: new Set(links.map((el) => el.offsetTop)).size,
      hasMore: !!wrap.querySelector('[data-testid="atlas-node-tabs-more"]'),
      moreOnRowLine: onRowLine(wrap.querySelector('[data-testid="atlas-node-tabs-more"]')),
      // By CLASS, not test id: a strip re-rendered without its test id is the same regression.
      stripPresent: !!wrap.querySelector(".loom-kpistrip, .loom-kpipill"),
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

/** Every tab key the node can reach, from both halves — the row and (opening it) the menu. */
/**
 * A node's whole DECLARED tab set, collected from its own HOME tab at a width where nothing folds.
 *
 * The home tab, specifically, because it is the one tab whose body carries the node's full-size KPI
 * deck — so waiting on that deck is a settle signal that belongs to the page rather than to the
 * geometry under test. The no-fold guarantee is now the WIDTH's (1600, far above the ≤1000 where a
 * trigger first appears on this build), and it is asserted here rather than assumed.
 *
 * ⛔ Never hardcode this as a count. Both nodes' tab sets change whenever a card re-homes, adds or
 * removes a surface, and a hardcoded floor goes red for a reason that has nothing to do with the
 * overflow behaviour this spec is about: card `44f725fe` removed the project node's `Deck` tab and
 * reddened two legs here that were otherwise entirely correct.
 */
async function declaredTabKeys(page: Page, loomDaemon: LoomDaemon, homePath: string): Promise<string[]> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(loomDaemon.baseURL + homePath);
  await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
  await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
  await expect(page.getByTestId("atlas-node-tabs-more")).toHaveCount(0);
  return (await blockGeometry(page)).tabKeys.slice().sort();
}

async function allReachableKeys(page: Page): Promise<{ row: string[]; menu: string[] }> {
  const row = (await blockGeometry(page)).tabKeys;
  const more = page.getByTestId("atlas-node-tabs-more");
  if (await more.count() === 0) return { row, menu: [] };
  await more.click();
  await expect(page.getByTestId("atlas-node-tabs-menu")).toBeVisible();
  const menu = await page.locator('[data-testid="atlas-node-tabs-menu"] [role="menuitem"]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, "")));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("atlas-node-tabs-menu")).toHaveCount(0);
  return { row, menu };
}

/**
 * The focused element's `data-testid` (`""` when it has none), read only once focus has SETTLED on
 * something matching `want`.
 *
 * ⛔ NEVER read `document.activeElement` bare after a visibility assertion here. The menu moves focus
 * from a PASSIVE effect (`atlasHome.tsx`: `useEffect(() => { if (open) focusItem(0); }, [open])`),
 * which React runs AFTER the commit that paints the menu — so `toBeVisible()` can resolve a frame
 * before focus has moved anywhere. MEASURED on card 485d67b4: the bare read failed 4 of 20 runs at
 * the Enter-open site, reading back the still-focused trigger ("atlas-node-tabs-more") three times
 * and `document.body` (no testid) once. This RETRIES the read rather than waiting a fixed time, so no
 * timeout is lengthened and the settled path still costs one evaluate.
 *
 * Use it only where the test must DISCOVER which element holds focus. Where the expected element is
 * already a locator, `await expect(locator).toBeFocused()` says the same thing — that is what the
 * sibling keyboard specs (atlas-board-dialog, atlas-keyboard-shortcuts, atlas-switch) use.
 */
async function focusedTestId(page: Page, want: RegExp | string, message: string): Promise<string> {
  const read = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  const poll = expect.poll(read, { message });
  // `""` rather than null so a focus-on-body read FAILS the matcher and is retried, instead of
  // throwing a TypeError out of `toMatch` on the very first poll.
  if (typeof want === "string") await poll.toBe(want);
  else await poll.toMatch(want);
  return read();
}

/** The visible panel's own rendered text, clipped — a fingerprint a testid flip alone cannot fake. */
async function panelFingerprint(page: Page): Promise<string> {
  return page.locator(".loom-atlas-content").evaluate((el) =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400));
}

test.describe("Atlas node tab overflow menu (card d4350286)", () => {
  // ⭐ CARD 4a0ad464's OWN CLAIM, and the DoD clause that asked for 1280/1440/1920 by name. RED on
  // the pre-card build at all three: with the KPI strip beside them neither home node's tabs fitted
  // one line at any of these widths, so both `hasMore` and `stripPresent` came out the other way.
  test("switch ON at 1280/1440/1920: both home blocks are ONE line, with NO strip and NO More menu", async ({ page, loomDaemon }) => {
    test.setTimeout(240_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);

    // Each node's whole declared tab set, read off its own home tab before the measurements below —
    // so "every tab is in the row" is checked against the real set rather than a count.
    const declared: Record<string, string[]> = {
      project: await declaredTabKeys(page, loomDaemon, "/project"),
      workspace: await declaredTabKeys(page, loomDaemon, "/home"),
    };

    const offenders: string[] = [];
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      // A NON-home tab on each node — the tabs that used to carry the strip (card 7874e8c2 put it on
      // every tab but Overview), so this measures exactly where the chips used to be.
      for (const [who, path] of [["project", "/board"], ["workspace", "/home?tab=gates"]] as const) {
        const at = `${width} ${who}`;
        await page.goto(loomDaemon.baseURL + path);
        const g = await blockGeometry(page);
        // Identity: this is THIS spec's corpus, not a sibling worker's daemon. PRESENCE first, so
        // nothing below is satisfied by a page that has not rendered its node chrome yet.
        // ⚠️ NOT the node head's `h1` — on a project node TAB that heading is the TAB's own label
        // ("Board"), and the project's name is the crumb above it. ProjectHome's own hidden marker
        // is the one locator that names the project on every tab of the node.
        if (who === "project") {
          await expect(page.getByTestId("atlas-project-name")).toHaveText(seeded.project.name);
        }
        if (g.tabKeys.length === 0) { offenders.push(`${at}: no tabs rendered at all`); continue; }

        if (g.stripPresent) offenders.push(`${at}: a tab-row KPI strip is back`);
        if (g.hasMore) offenders.push(`${at}: a More trigger, with ${g.tabKeys.length} tabs in the row`);
        if (g.blockH !== g.oneLineH) offenders.push(`${at}: block ${g.blockH}px, one line is ${g.oneLineH}px`);
        if (g.rowTops !== 1) offenders.push(`${at}: tabs on ${g.rowTops} lines (${g.tabKeys.join("/")})`);
        if (g.docOverflow) offenders.push(`${at}: the document scrolls horizontally`);
        // ⭐ EVERY declared tab is IN THE ROW — an equality against the set itself, not a floor on
        // its size, so a row that dropped one tab and invented another could not pass.
        const row = g.tabKeys.slice().sort();
        if (JSON.stringify(row) !== JSON.stringify(declared[who])) {
          offenders.push(`${at}: row ${row.join("/")} != declared ${declared[who]!.join("/")}`);
        }
        await expect(page.getByTestId("atlas-node-tabs-menu"),
          `${at}: a menu exists with nothing folded`).toHaveCount(0);
      }
    }
    expect(offenders, "both home nodes' tab blocks are one unfolded line at every desktop width").toEqual([]);
  });

  test("switch ON at 1440: the Platform node, whose tabs already fit, is untouched", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/platform");

    // ⚠️ STATED PLAINLY: this leg was green before card d4350286 too, and before card 4a0ad464 — the
    // Platform node has five tabs, never carried a KPI strip, and was never wrapping. It is a
    // NON-REGRESSION control (the collapse must not reach a row that fits), not a discriminator.
    const g = await blockGeometry(page);
    expect(g.tabKeys.length, `platform tabs: ${g.tabKeys.join("/")}`).toBe(5);
    expect(g.rowTops, "every platform tab on one line").toBe(1);
    expect(g.blockH, `platform block ${g.blockH}px vs one line ${g.oneLineH}px`).toBe(g.oneLineH);
    expect(g.hasMore, "a row that fits grows no trigger").toBe(false);
    await expect(page.getByTestId("atlas-node-tabs-menu")).toHaveCount(0);
  });

  test("switch ON: an overflowed tab selected through the menu navigates, and lands IN the row", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: FOLD_WIDTH, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByTestId("atlas-tab-board")).toHaveAttribute("aria-selected", "true");
    // The fold this leg is about is ASSERTED, not assumed: card 4a0ad464 made the row fit at every
    // desktop width, so a `FOLD_WIDTH` that stopped folding would leave every assertion below
    // satisfied by a click that never happened rather than failing for the real reason.
    await expect(page.getByTestId("atlas-node-tabs-more"),
      `the row does not fold at ${FOLD_WIDTH}px, so this leg has no menu to test`).toHaveCount(1);

    const before = { fp: await panelFingerprint(page), url: new URL(page.url()).pathname };
    await page.getByTestId("atlas-node-tabs-more").click();
    const menu = page.getByTestId("atlas-node-tabs-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("role", "menu");

    // Driven off whatever the menu actually holds, never a typed key — the split between row and
    // menu is width-derived, so a hardcoded name would silently stop testing the overflow the
    // moment a label's width changed.
    const items = await menu.locator('[role="menuitem"]').evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, "")));
    expect(items.length, `menu items: ${items.join("/")}`).toBeGreaterThan(0);
    const pick = items[items.length - 1]!;

    // A real `<a href>`, same address the tab itself carries — the card's "tabs remain real links".
    const href = await menu.getByTestId(`atlas-more-item-${pick}`).evaluate((el) => (el as HTMLAnchorElement).getAttribute("href"));
    expect(href, `the ${pick} menu item is a real link`).toBeTruthy();

    await menu.getByTestId(`atlas-more-item-${pick}`).click();
    // The menu closes on select, rather than sitting open over the panel it just revealed.
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId(`atlas-tab-${pick}`)).toHaveAttribute("aria-selected", "true");

    const after = { fp: await panelFingerprint(page), url: new URL(page.url()).pathname };
    expect(after.url, "the menu item navigated").not.toBe(before.url);
    expect(after.fp, "the rendered panel actually changed").not.toBe(before.fp);
    expect(after.fp.length, "the new panel rendered something").toBeGreaterThan(0);

    // ⭐ THIS BUILD'S ACTIVE-TAB RULE: the selected tab is pulled back INTO the row (swapping out
    // whichever tab its width displaces) — it is never represented by the trigger instead.
    const g = await blockGeometry(page);
    expect(g.tabKeys, `the row after selecting ${pick}`).toContain(pick);
    expect(g.rowTops, "and the row is still one line").toBe(1);
    expect(g.blockH, `block ${g.blockH}px vs one line ${g.oneLineH}px`).toBe(g.oneLineH);
    // The trigger is still there (something else took the displaced slot), and does NOT claim to be
    // the selected tab — exactly one tab on this row is selected, and it is a real tab.
    expect(g.hasMore, "the row still overflows").toBe(true);
    await expect(page.locator('[data-testid="atlas-node-tabs"] [role="tab"][aria-selected="true"]')).toHaveCount(1);
    await expect(page.getByTestId("atlas-node-tabs-more")).toHaveAttribute("aria-expanded", "false");
  });

  test("switch ON: the menu is operable from the keyboard alone, and Escape returns focus", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: FOLD_WIDTH, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/board");

    const more = page.getByTestId("atlas-node-tabs-more");
    const menu = page.getByTestId("atlas-node-tabs-menu");
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-haspopup", "menu");
    await expect(more).toHaveAttribute("aria-expanded", "false");

    // ENTER opens, and focus moves INTO the menu — a menu button that opens and leaves focus behind
    // is unreachable by keyboard, which no presence assertion on the panel would catch.
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const first = await focusedTestId(page, /^atlas-more-item-/, "focus lands on the first menu item");

    // ARROWS move, and they move to a DIFFERENT item (not merely "still focused somewhere").
    await page.keyboard.press("ArrowDown");
    const second = await focusedTestId(page, /^atlas-more-item-/, "ArrowDown moves to the next item");
    expect(second, "ArrowDown moves to a DIFFERENT item").not.toBe(first);
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId(first), "ArrowUp comes back").toBeFocused();
    await page.keyboard.press("End");
    await focusedTestId(page, /^atlas-more-item-/, "End jumps to the last item");

    // ESCAPE closes AND hands focus back to the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more, "Escape returns focus to the trigger").toBeFocused();

    // SPACE opens it too, and Enter on an item navigates exactly like clicking the tab would.
    await page.keyboard.press(" ");
    await expect(menu).toBeVisible();
    const target = (await focusedTestId(page, /^atlas-more-item-/, "Space opens the menu focused"))
      .replace(/^atlas-more-item-/, "");
    const beforeUrl = new URL(page.url()).pathname;
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId(`atlas-tab-${target}`)).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).pathname, "a keyboard selection navigates").not.toBe(beforeUrl);
  });

  test("switch ON: an open menu keeps keyboard focus across a relayout", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: FOLD_WIDTH, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/board");

    const more = page.getByTestId("atlas-node-tabs-more");
    const menu = page.getByTestId("atlas-node-tabs-menu");
    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    const landed = await focusedTestId(page, /^atlas-more-item-/, "the menu opens focused");
    const itemsAt1440 = await menu.locator('[role="menuitem"]').count();

    // A GENUINE relayout, not the measuring pass the fit split already neutralises: a narrower
    // viewport really changes which tabs overflow, so React unmounts the item holding focus and the
    // browser drops focus to <body> with nothing to put it back (MEASURED 3/3 before the fix).
    await page.setViewportSize({ width: 700, height: 1000 });
    await expect(menu, "the menu is still open across the resize").toBeVisible();
    // ⭐ The control that makes the focus claim below non-vacuous: if the overflow list did NOT
    // change, nothing unmounted and "focus survived" would prove nothing.
    await expect(menu.locator('[role="menuitem"]'), "the overflow list really changed")
      .not.toHaveCount(itemsAt1440);
    const after = await focusedTestId(page, /^atlas-more-item-/, "focus is never stranded on <body>");
    expect(after, `focus moved off ${landed} but stayed inside the menu`).toMatch(/^atlas-more-item-/);

    // And the menu is still operable from there — a focused item that no longer responds to the
    // arrow keys would satisfy every assertion above and still be unusable.
    await page.keyboard.press("ArrowDown");
    await focusedTestId(page, /^atlas-more-item-/, "the arrow keys still work after the relayout");
  });

  test("switch ON: a typed draft survives a trip out through the menu and back", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: FOLD_WIDTH, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/board");

    // The Board tab's own new-card composer — real unfinished input, of exactly the kind the owner's
    // standing rule says a tab click is not consent to discard (the panels stay MOUNTED, parked with
    // `hidden`; this card folds tabs out of the ROW and must not reach the bodies).
    const draft = page.getByPlaceholder("new task title");
    await expect(draft).toBeVisible();
    const text = uniq("unsent-draft");
    await draft.fill(text);
    await expect(draft).toHaveValue(text);

    await page.getByTestId("atlas-node-tabs-more").click();
    const items = await page.locator('[data-testid="atlas-node-tabs-menu"] [role="menuitem"]')
      .evaluateAll((els) => els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, "")));
    const away = items[0]!;
    await page.getByTestId(`atlas-more-item-${away}`).click();
    await expect(page.getByTestId(`atlas-tab-${away}`)).toHaveAttribute("aria-selected", "true");
    // The board's panel is parked, not unmounted — so the draft is still in the document, hidden.
    await expect(page.getByTestId("atlas-tabpanel-board")).toHaveCount(1);

    // Back via the ROW (board is still a visible tab) — the draft must be exactly as it was.
    await page.getByTestId("atlas-tab-board").click();
    await expect(page.getByTestId("atlas-tab-board")).toHaveAttribute("aria-selected", "true");
    await expect(draft, "the unsent draft survived the tab round trip").toHaveValue(text);
  });

  test("switch ON at 720 and 420: nothing overflows the viewport and the menu still works", async ({ page, loomDaemon }) => {
    test.setTimeout(240_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);

    const declared: Record<string, string[]> = {
      project: await declaredTabKeys(page, loomDaemon, "/project"),
      workspace: await declaredTabKeys(page, loomDaemon, "/home"),
    };

    const offenders: string[] = [];
    // Every (width, node) pair that actually folded, so the menu half below is provably exercised
    // somewhere rather than skipped everywhere by a row that happens to fit at both widths.
    const folded: string[] = [];
    for (const width of [720, 420]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [who, path] of [["project", "/board"], ["workspace", "/home?tab=gates"]] as const) {
        const at = `${width} ${who}`;
        await page.goto(loomDaemon.baseURL + path);
        // The tree is a drawer at these widths (card 49e883a9) — it is still in the document, which
        // is what makes the content column, and therefore this measurement, the real narrow layout.
        await expect(page.getByTestId("atlas-tree-toggle")).toBeVisible();
        const g = await blockGeometry(page);
        if (g.docOverflow) offenders.push(`${at}: the document scrolls horizontally`);
        // ⭐ THE TAB ROW is one line here. It is also the whole block now — card 4a0ad464 removed the
        // KPI strip that used to take a line of its own below 820px (`.loom-kpistrip
        // { margin-left: 0 }`), so there is nothing left to share the wrapper with at any width.
        if (g.rowTops !== 1) offenders.push(`${at}: tabs on ${g.rowTops} lines (${g.tabKeys.join("/")})`);
        if (g.rowH > 32) offenders.push(`${at}: the row is ${g.rowH}px, taller than one tab`);
        // ⛔ A TRIGGER IS NOT UNCONDITIONALLY REQUIRED HERE. Below 820px the tree is a drawer, so the
        // content column gets the rail's 244px back and a short enough tab set legitimately fits with
        // nothing to fold — a BETTER outcome than folding, not a defect. MEASURED on this build: at
        // 720 the project node's nine tabs fit and the Workspace node's do not. What must hold either
        // way is that NOTHING IS UNREACHABLE, so that is what is asserted; the menu's own behaviour
        // is then exercised only where a fold actually happened. (Hardcoding "there is always a
        // trigger at 720" is what went red on card `44f725fe`, which removed one project tab and so
        // let the remaining nine fit at 720.)
        if (!g.hasMore) {
          const rowKeys = g.tabKeys.slice().sort();
          if (JSON.stringify(rowKeys) !== JSON.stringify(declared[who])) {
            offenders.push(`${at}: no trigger, and the row ${rowKeys.join("/")} is not the declared set ${declared[who]!.join("/")}`);
          }
          continue;
        }
        folded.push(at);
        if (g.moreOnRowLine !== true) offenders.push(`${at}: the trigger is not on the row's line`);

        await page.getByTestId("atlas-node-tabs-more").click();
        const menu = page.getByTestId("atlas-node-tabs-menu");
        await expect(menu).toBeVisible();
        // The panel itself must stay inside the viewport — a menu hanging off the edge at phone
        // width is not "working", however many items it has.
        const box = await menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, vw: window.innerWidth };
        });
        if (box.left < 0 || box.right > box.vw) offenders.push(`${at}: menu spans ${Math.round(box.left)}..${Math.round(box.right)} in ${box.vw}px`);
        const pick = (await menu.locator('[role="menuitem"]').evaluateAll((els) =>
          els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, ""))))[0];
        if (!pick) { offenders.push(`${at}: the menu is empty`); continue; }
        await page.getByTestId(`atlas-more-item-${pick}`).click();
        await expect(page.getByTestId(`atlas-tab-${pick}`)).toHaveAttribute("aria-selected", "true");
        const afterSelect = await blockGeometry(page);
        if (afterSelect.docOverflow) offenders.push(`${at}: the document scrolls after selecting ${pick}`);
        if (afterSelect.rowTops !== 1) offenders.push(`${at}: ${afterSelect.rowTops} tab lines after selecting ${pick}`);
      }
    }
    expect(offenders, "720 and 420 keep a one-line tab row and a working menu, with no horizontal overflow").toEqual([]);
    // ⭐ And the menu half above was really exercised: at least one (width, node) pair folded. Without
    // this the whole loop could go green on four rows that each fit, and "the menu still works at
    // phone width" would be a claim nothing measured.
    expect(folded.length, "no node folded at 720 or 420, so the menu assertions above never ran").toBeGreaterThan(0);
  });

  test("switch OFF: no overflow trigger or menu exists anywhere", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    // Deliberately NOT seedAtlasOn — off is the default. The project is still pinned so the classic
    // project-scoped pages render their real content rather than a pick-a-project empty state.
    await pinProject(page, seeded.project.id);

    const offenders: string[] = [];
    // The classic addresses behind the node tabs this card folds, at the three widths it measures.
    const addresses = ["/overview", "/board", "/terminals", "/repository", "/memory", "/runs",
      "/archive", "/settings", "/inbox", "/gates", "/automation", "/actors", "/usage", "/platform"];
    for (const width of [1440, 720, 420]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of addresses) {
        await page.goto(loomDaemon.baseURL + path);
        // Presence first: an absence on a page still loading means nothing.
        await expect(page.locator(".loom-rail")).toBeVisible();
        const byTestId = await page.getByTestId("atlas-node-tabs-more").count()
          + await page.getByTestId("atlas-node-tabs-menu").count();
        // The classes too, because a trigger rendered without its testid is still the regression.
        const byClass = await page.locator(".loom-atlas-tabmore, .loom-atlas-tabmenu, .loom-atlas-tabmore-slot").count();
        if (byTestId !== 0 || byClass !== 0) offenders.push(`${width} ${path}: testid=${byTestId} class=${byClass}`);
      }
    }
    expect(offenders, "the classic shell grows no overflow trigger at any width").toEqual([]);
    // And nothing Atlas at all, so the absence above is the switch being off rather than a trigger
    // that merely failed to render inside a mounted frame.
    await expect(page.locator("[class^='loom-atlas-'], [class*=' loom-atlas-']")).toHaveCount(0);
  });
});
