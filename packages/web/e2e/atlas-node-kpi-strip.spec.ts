// THERE IS NO NODE KPI STRIP — card 4a0ad464, inverting card 7874e8c2. Records:
// docs/decisions/4a0ad464-atlas-drop-tab-row-chips-and-page-rows.md, and the superseding section
// appended to docs/decisions/7874e8c2-node-kpi-strip-on-every-tab.md.
//
// The owner's own words (2026-10-28): "Chips like '21 needs you 1/1 mgr · workers 40% worst context
// 0·0 gate run·queued 83 open cards 4 merged today' on the tabs row are not necessary and need too
// much space causing the need for a 'More..' tab. remove them."
//
// This file used to prove the strip rode EVERY tab of both home nodes. It now proves the inverse,
// in the same shape, at the same addresses, over the same app-collected tab sets:
//   1. SWITCH ON — NO tab of either home node carries a strip, or any pill from one. Measured over
//      the node's whole DECLARED tab set, folded tabs included, not whatever the row happens to fit.
//   2. The node's readout is still REAL and still reachable: the home tab's full-size DECK reads the
//      count this spec seeded into named lanes. That is the positive control the absence needs — a
//      page that rendered no readout AT ALL would otherwise satisfy every assertion here.
//   3. SWITCH OFF — unchanged, and still passing: the classic shell never had a strip either.
//
// ⛔ THE TAB SET IS COLLECTED FROM THE APP, NEVER TYPED. A hardcoded list would quietly stop covering
// a tab the moment a later card adds one — the exact shape of the defect card 7874e8c2 existed to
// fix, and just as able to hide a strip that crept back onto a tab nobody listed.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
//
// @decision 4a0ad464 — never re-add a compact figure strip to a node's tab row. Don't weaken these
// legs to a testid check either: a strip rendered without one is the same regression.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { nodeTabKeys, openNodeTab } from "./helpers/nodeTabs";

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
 * A project whose board carries a KNOWN open-card count. Four cards, one of them in the terminal
 * lane: the terminal card is what makes "open cards" a real derivation rather than a row count — a
 * readout that simply counted cards would say 4, not 3. Same shape as atlas-home.spec.ts's own
 * seed, deliberately: this spec's whole claim is that the figure that tab already proved correct
 * now rides every OTHER tab too.
 */
async function seedProjectWithBoard(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("kpistrip"));
  await loomDaemon.createTask(project.id, { title: uniq("kpistrip-INBOX"), columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: uniq("kpistrip-TODO"), columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: uniq("kpistrip-REVIEW"), columnKey: "review" });
  await loomDaemon.createTask(project.id, { title: uniq("kpistrip-DONE"), columnKey: "done" });
  return { project, open: 3, inReview: 1 };
}

/**
 * Every tab key the node actually offers, read off the live node — the row's, plus the ones folded
 * into its More menu since card d4350286. ⛔ Reading the ROW alone would quietly shrink this spec's
 * population to whatever currently fits, which is the same defect in a new costume as the hardcoded
 * list the header above refuses: the node whose nineteen tabs needed a readout still has nineteen.
 */
async function renderedTabKeys(page: Page): Promise<string[]> {
  return nodeTabKeys(page);
}

/** Every destination the rendered tree links to, as a pathname — the second, independent collection. */
async function treeDestinations(page: Page): Promise<string[]> {
  return page.locator(".loom-atlas-tree a[href]").evaluateAll((els) =>
    [...new Set(els.map((el) => new URL((el as HTMLAnchorElement).href).pathname))]);
}

/**
 * Every trace of a tab-row readout the page still carries, by THREE independent handles: the strip's
 * own test id, its class, and the per-pill test id stem. Three because they fail independently — a
 * strip re-rendered without its test id, or a bare `KpiPill` loop put back on the row with no
 * wrapper at all, is the same regression this card forbids and only the class/stem would see it.
 *
 * ⛔ Scoped to `.loom-atlas-tabs` for the CLASS handle, never the whole page: `.loom-kpipill` is also
 * what the dashboard disclosure's collapsed summary bar states its counts in (card 44f725fe), which
 * is a DIFFERENT readout this card deliberately keeps. A page-wide class count would redden on that
 * one and read as a strip that never came back.
 */
async function tabRowReadout(page: Page): Promise<Record<string, number>> {
  return {
    byTestId: await page.getByTestId("atlas-kpi-strip").count(),
    byClass: await page.locator('[data-testid="atlas-node-tabs"] .loom-kpistrip, [data-testid="atlas-node-tabs"] .loom-kpipill').count(),
    byPillStem: await page.locator('[data-testid^="atlas-kpi-pill-"]').count(),
  };
}

/** True when the page carries no tab-row readout at all, by any of the three handles above. */
const noReadout = (r: Record<string, number>) => Object.values(r).every((n) => n === 0);

/** The deck's figures, same keying — so the two readouts can be compared rather than described. */
async function deckFigures(page: Page): Promise<Record<string, string>> {
  return page.locator('[data-testid="atlas-kpi-deck"] .loom-kpi').evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [
      (el.getAttribute("data-testid") ?? "").replace(/^atlas-kpi-/, ""),
      (el.querySelector(".loom-kpi-value")?.textContent ?? "").trim(),
    ])));
}

test.describe("Atlas node tab rows carry no KPI strip (card 4a0ad464)", () => {
  test("switch ON: NO project node tab carries a strip, and the deck still reads the seeded board", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");

    // Identity: this is THIS spec's corpus. Without it a silent fallback to a sibling worker's
    // daemon would still render a plausible, screenshot-able, entirely wrong node.
    await expect(page.locator(".loom-atlas-nodehead h1")).toContainText(seeded.project.name);

    const keys = await renderedTabKeys(page);
    // The node is the nine-tab one card 25c08fba built and card 44f725fe unified the two home tabs
    // of, not a one-tab remnant — otherwise "no tab carries a strip" could pass on a node that had
    // lost the tabs this claim is about.
    expect(keys.length, `project node tabs: ${keys.join(", ")}`).toBeGreaterThanOrEqual(9);
    expect(keys).toContain("board");
    expect(keys).toContain("memory");
    expect(keys).toContain("runs");

    // ⭐ Verdicts are COLLECTED and asserted once, never `expect`ed inside the loop: an in-loop
    // expect aborts at the first offender and hides every one after it (card a7f23a2f's own lesson).
    const offenders: string[] = [];
    for (const key of keys) {
      // Through whichever half holds it (card d4350286); it asserts the tab reads selected after.
      await openNodeTab(page, key);
      // PRESENCE FIRST, on every tab: the tab row itself is up. Without it an absence below is
      // satisfied by a page that merely has not rendered its node chrome yet.
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

      if (key === "overview") {
        // The node's readout lives HERE and nowhere else now. `toHaveText` retries, so this doubles
        // as the settle for the board query behind the figure — and it is the positive control for
        // every absence in this loop: the figures are real, they are just not on the tab row.
        await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
        await expect(page.getByTestId("atlas-kpi-cards").locator(".loom-kpi-value"))
          .toHaveText(String(seeded.open));
        const deck = await deckFigures(page);
        if (deck.cards !== String(seeded.open)) offenders.push(`${key}: deck cards=${deck.cards}`);
      }

      const readout = await tabRowReadout(page);
      if (!noReadout(readout)) offenders.push(`${key}: ${JSON.stringify(readout)}`);
    }
    expect(offenders, "no project node tab carries a tab-row KPI readout, by test id, class or pill stem")
      .toEqual([]);
  });

  test("switch ON: NO Workspace node tab carries a strip, and the deck still declares its six tiles", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home");

    const keys = await renderedTabKeys(page);
    expect(keys.length, `workspace node tabs: ${keys.join(", ")}`).toBeGreaterThanOrEqual(9);
    expect(keys[0]).toBe("overview");

    // The positive control, and deliberately NOT an absolute figure — the Workspace tier aggregates
    // every project on a daemon a sibling spec also seeds into (card 5dcb5ae9's lesson), so a fixed
    // number would be measuring the fixture. What IS pinned: the node's readout still EXISTS, at
    // full size, with all six tiles. Every absence below is read against that.
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    const deck = await deckFigures(page);
    expect(Object.keys(deck).sort(), "the workspace deck's six declared tiles").toHaveLength(6);

    const offenders: string[] = [];
    for (const key of keys) {
      await openNodeTab(page, key);
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
      const readout = await tabRowReadout(page);
      if (!noReadout(readout)) offenders.push(`${key}: ${JSON.stringify(readout)}`);
    }
    expect(offenders, "no workspace node tab carries a tab-row KPI readout").toEqual([]);
  });

  test("switch ON: no address the project node's own tab row links to carries a strip", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.locator(".loom-atlas-nodehead h1")).toContainText(seeded.project.name);

    // Collected from the app, off the node's own tab row. This USED to be that set intersected with
    // the tree's own destinations ("a node tab you can reach from the tree"), which was a real
    // reading while card 25c08fba left every project tab a tree row as well — card ec1aa18e removed
    // those rows, so the intersection is now two addresses and the loop would be near-vacuous.
    // The tab row is the honest population: it IS how a reader reaches these addresses now.
    const tabHrefs = await page.locator('[data-testid="atlas-node-tabs"] [role="tab"]')
      .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
    // ...and the tree is still checked, in the one direction that is still true of it: it links NONE
    // of them. A row creeping back would be caught here as well as in atlas-tree.spec.ts.
    const treeLinked = (await treeDestinations(page)).filter((p) => tabHrefs.includes(p) && p !== "/project");
    expect(treeLinked, "a project node tab is an Atlas tree row again, which card ec1aa18e removed")
      .toEqual([]);

    // The population is real, not empty — an empty set would make the loop below vacuous and this
    // whole leg would pass on a node that rendered no tabs.
    expect(tabHrefs.length, `the project node's tab addresses: ${tabHrefs.join(", ")}`).toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    for (const path of tabHrefs) {
      await page.goto(loomDaemon.baseURL + path);
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
      const isOverviewTab = await page.getByTestId("atlas-tab-overview").getAttribute("aria-selected") === "true";
      if (isOverviewTab) {
        // The ONE address whose body still states the node's figures, and the positive control for
        // every absence collected here — the readout exists, it has simply left the tab row.
        await expect(page.getByTestId("atlas-kpi-cards").locator(".loom-kpi-value")).toHaveText(String(seeded.open));
      }
      const readout = await tabRowReadout(page);
      if (!noReadout(readout)) offenders.push(`${path}: ${JSON.stringify(readout)}`);
    }
    expect(offenders, "no address the project node's tab row links to carries a tab-row KPI readout")
      .toEqual([]);
  });

  // UNCHANGED by card 4a0ad464, and kept deliberately: the classic shell never had a strip, so this
  // leg passed before and after. It is the control that says the ON legs above are measuring the
  // Atlas shell's own chrome rather than an absence that was always true everywhere.
  test("switch OFF: no KPI strip exists at any of those addresses", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    // Deliberately NOT seedAtlasOn — off is the default. The project is still pinned so the classic
    // project-scoped pages render their real content rather than a pick-a-project empty state.
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });

    // The classic addresses behind the node tabs this card touches, plus both node paths. Listed
    // here because with the switch OFF there is no tab row to collect them from — that is the
    // point of the leg — so the ON legs above own the "collected from the app" guarantee.
    const addresses = ["/project", "/home", "/board", "/terminals", "/repository", "/memory",
      "/runs", "/archive", "/settings", "/inbox", "/gates", "/automation", "/actors", "/usage"];

    const offenders: string[] = [];
    for (const path of addresses) {
      await page.goto(loomDaemon.baseURL + path);
      // Presence first: the classic shell's own rail must be up before any absence here means
      // anything — a page still loading has no strip either.
      await expect(page.locator(".loom-rail")).toBeVisible();
      const byTestId = await page.getByTestId("atlas-kpi-strip").count();
      // Both the testid and the class, because a strip rendered without its testid would still be
      // the regression this leg exists to catch.
      const byClass = await page.locator(".loom-kpistrip, .loom-kpipill").count();
      if (byTestId !== 0 || byClass !== 0) offenders.push(`${path}: testid=${byTestId} class=${byClass}`);
    }
    expect(offenders, "the classic shell renders no KPI strip anywhere").toEqual([]);
    // And nothing Atlas at all, so the absence above is the switch being off rather than a strip
    // that merely failed to render inside a mounted frame.
    await expect(page.locator("[class^='loom-atlas-'], [class*=' loom-atlas-']")).toHaveCount(0);
  });
});
