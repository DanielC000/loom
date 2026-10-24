// The node tab row's overflow menu — card d4350286 (Atlas, epic 9fe8cd4e), owner decision 5b91bcc0
// ("Build the overflow More menu"). Design record: docs/decisions/d4350286-atlas-node-tab-overflow.md.
//
// 🔴 THE CARD'S OWN HEADLINE CLAUSE — "at 1440 the tab ROW is one line" — WAS ALREADY TRUE BEFORE
// THIS CARD, and a leg asserting it would pass on the pre-fix build. MEASURED on the unmodified
// build at 1440: `.loom-atlas-tabrow` was 28px tall with every tab on one `offsetTop`, on all three
// nodes. What was two lines is the tab BLOCK — `.loom-atlas-tabs`, 35px → 74px — because the KPI
// strip card 7874e8c2 put on every tab could not fit BESIDE the row and wrapped under it. That 39px
// is the "~39px" the card asks for, so the discriminating claim this spec pins is the BLOCK's
// height, derived from the row's own line box rather than hardcoded, plus the strip sharing that
// line. Same shape as the wrong DoD clauses cards 7874e8c2 and 49e883a9 each found in their own
// briefs: a DoD sentence can name an assertion that cannot fail — measure before trusting one.
//
// What each leg measures:
//   1. SWITCH ON at 1440 — the project and Workspace nodes' whole tab block is ONE line, strip and
//      all, and the strip still reads its real figures. The PLATFORM node is the INERT control: it
//      has 5 tabs and no strip, they already fit, so it must come out with NO trigger and every tab
//      still in the row. (Stated plainly: that leg is a non-regression control, not a discriminator
//      — it was green before this card too.)
//   2. An overflowed tab selected THROUGH the menu navigates, the panel actually changes (the
//      rendered panel's own text is fingerprinted on both sides, not just a testid flip), and the
//      tab lands back IN THE ROW — this build's active-tab rule, asserted rather than described.
//   3. Keyboard: Enter opens, Space opens, arrows move, Escape closes and returns focus, and a
//      selected item navigates exactly like the tab.
//   4. A typed draft in a panel survives a trip out through the menu and back.
//   5. 720 and 420, where the tree is a drawer (card 49e883a9): no horizontal overflow, the tab row
//      is one line, and the menu still opens and selects.
//   6. SWITCH OFF — no trigger and no menu exist anywhere.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
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
  stripPresent: boolean;
  /** Same test for the KPI strip. `null` when the node renders none (Platform, Overview tabs). */
  stripOnRowLine: boolean | null;
  docOverflow: boolean;
}

/**
 * Everything about the tab block's geometry, read off the live document in one pass — once the row
 * is out of its MEASURING state.
 *
 * @decision 885e7a49 — Never read this geometry on a bare `toBeVisible()`: a measuring pass draws
 * every tab, so the strip wraps and the block reads 74px against a 35px line. Wait on
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
      stripPresent: !!wrap.querySelector(".loom-kpistrip"),
      stripOnRowLine: onRowLine(wrap.querySelector(".loom-kpistrip")),
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

/** Every tab key the node can reach, from both halves — the row and (opening it) the menu. */
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
  test("switch ON at 1440: the project and Workspace blocks are ONE line, strip and all", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const offenders: string[] = [];
    // A strip-carrying tab on each node. ⛔ NOT `/project` or `/home` — Overview is the one tab with
    // no strip (card 7874e8c2), so measuring there would duck the very content that was wrapping.
    for (const [who, path] of [["project", "/board"], ["workspace", "/home?tab=gates"]] as const) {
      await page.goto(loomDaemon.baseURL + path);
      const g = await blockGeometry(page);
      // Identity: this is THIS spec's corpus, not a sibling worker's daemon.
      if (who === "project") {
        await expect(page.locator(".loom-atlas-nodehead h1")).toBeVisible();
        await expect(page.getByTestId("atlas-kpi-pill-cards").locator(".loom-kpipill-v"))
          .toHaveText(String(seeded.open));
      }
      // Presence first, so nothing below is satisfied by a page that merely has no strip yet.
      if (!g.stripPresent) { offenders.push(`${who}: no KPI strip at ${path}`); continue; }
      if (g.blockH !== g.oneLineH) offenders.push(`${who}: block ${g.blockH}px, one line is ${g.oneLineH}px`);
      if (g.rowTops !== 1) offenders.push(`${who}: tabs on ${g.rowTops} lines (${g.tabKeys.join("/")})`);
      if (g.stripOnRowLine !== true) offenders.push(`${who}: the strip is not on the row's line`);
      // The collapse is real, not a row that happened to fit: these nodes carry 9 and 10 tabs.
      if (!g.hasMore) offenders.push(`${who}: no overflow trigger, ${g.tabKeys.length} tabs in the row`);
      if (g.moreOnRowLine !== true) offenders.push(`${who}: the trigger is not on the row's line`);
      if (g.docOverflow) offenders.push(`${who}: the document scrolls horizontally`);
      // ⭐ NOTHING IS LOST, only folded: row + menu together are still the whole declared tab set.
      const reach = await allReachableKeys(page);
      const total = reach.row.length + reach.menu.length;
      if (total < (who === "project" ? 10 : 9)) {
        offenders.push(`${who}: ${total} tabs reachable (row ${reach.row.join("/")} + menu ${reach.menu.join("/")})`);
      }
      if (reach.menu.length === 0) offenders.push(`${who}: the menu is empty`);
      // The ACTIVE tab is never the one folded away (this build's rule — see the record).
      const activeKey = who === "project" ? "board" : "gates";
      if (!reach.row.includes(activeKey)) offenders.push(`${who}: the active tab ${activeKey} is not in the row`);
      if (reach.menu.includes(activeKey)) offenders.push(`${who}: the active tab ${activeKey} is in the menu`);
    }
    expect(offenders, "the project and Workspace tab blocks fit one line at 1440 with every tab still reachable").toEqual([]);
  });

  test("switch ON at 1440: the Platform node, whose tabs already fit, is untouched", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/platform");

    // ⚠️ STATED PLAINLY: this leg was green before this card too — the Platform node has five tabs,
    // no KPI strip, and was never wrapping. It is a NON-REGRESSION control (the collapse must not
    // reach a row that fits), not a discriminator for the overflow itself.
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
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByTestId("atlas-tab-board")).toHaveAttribute("aria-selected", "true");

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
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await page.setViewportSize({ width: 1440, height: 1000 });
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

    const offenders: string[] = [];
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
        // ⭐ THE TAB ROW is one line here — not the whole block: below 820px the KPI strip stops
        // right-aligning and takes a line of its own by design (`.loom-kpistrip { margin-left: 0 }`,
        // card 7874e8c2). Reserving its width here would collapse EVERY tab into the menu.
        if (g.rowTops !== 1) offenders.push(`${at}: tabs on ${g.rowTops} lines (${g.tabKeys.join("/")})`);
        if (g.rowH > 32) offenders.push(`${at}: the row is ${g.rowH}px, taller than one tab`);
        if (!g.hasMore) { offenders.push(`${at}: no trigger, ${g.tabKeys.length} tabs in the row`); continue; }
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
