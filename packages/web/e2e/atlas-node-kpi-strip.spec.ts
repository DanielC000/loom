// The node KPI strip on every node tab — card 7874e8c2 (Atlas restructure 5 of 11), closing item 5
// of the Atlas gap audit. Design record: docs/decisions/7874e8c2-node-kpi-strip-on-every-tab.md.
//
// What the card claims, and how each half is measured rather than asserted by shape:
//   1. SWITCH ON — every tab of a home node carries the node's readout, and that readout is REAL:
//      the project strip's open-cards pill reads a count this spec seeded into named lanes, on
//      every project tab, not just on the one the strip used to live on.
//   2. Overview is the one tab with no STRIP, because its body already carries the same six figures
//      as the full-size deck — so its leg asserts the DECK reads the same seeded count instead of
//      excusing the tab. The card's own DoD asks for the strip there too; the record above says why
//      that one clause is not satisfied literally.
//   3. SWITCH OFF — no KPI strip exists anywhere, at every one of those same addresses.
//
// ⛔ THE TAB SET IS COLLECTED FROM THE APP, NEVER TYPED. Two independent collections, both read off
// the rendered page: the node's own tab row, and the project-scoped rows of the rendered TREE. A
// hardcoded list would quietly stop covering a tab the moment a later card adds one — which is the
// exact shape of the defect this card exists to fix, nineteen tabs carrying a readout on two.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
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

/** The strip's figures, keyed by the SAME `item.key` the deck's tiles are keyed by. */
async function stripFigures(page: Page): Promise<Record<string, string>> {
  return page.locator('[data-testid="atlas-kpi-strip"] .loom-kpipill').evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [
      (el.getAttribute("data-testid") ?? "").replace(/^atlas-kpi-pill-/, ""),
      // `textContent`, not `innerText`: `.loom-kpipill-l` is upper-cased by CSS, and innerText
      // applies `text-transform` while the source value does not.
      (el.querySelector(".loom-kpipill-v")?.textContent ?? "").trim(),
    ])));
}

/** The deck's figures, same keying — so the two readouts can be compared rather than described. */
async function deckFigures(page: Page): Promise<Record<string, string>> {
  return page.locator('[data-testid="atlas-kpi-deck"] .loom-kpi').evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [
      (el.getAttribute("data-testid") ?? "").replace(/^atlas-kpi-/, ""),
      (el.querySelector(".loom-kpi-value")?.textContent ?? "").trim(),
    ])));
}

test.describe("Atlas node KPI strip (card 7874e8c2)", () => {
  test("switch ON: the project node's strip reads the seeded board on EVERY tab but Overview", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedProjectWithBoard(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");

    // Identity: this is THIS spec's corpus. Without it a silent fallback to a sibling worker's
    // daemon would still render a plausible, screenshot-able, entirely wrong strip.
    await expect(page.locator(".loom-atlas-nodehead h1")).toContainText(seeded.project.name);

    const keys = await renderedTabKeys(page);
    // The node is the ten-tab one card 25c08fba built, not a two-tab remnant — otherwise "every tab
    // carries the strip" could pass on a node that had lost the tabs this card is about.
    expect(keys.length, `project node tabs: ${keys.join(", ")}`).toBeGreaterThanOrEqual(10);
    expect(keys).toContain("board");
    expect(keys).toContain("memory");
    expect(keys).toContain("runs");

    // ⭐ Verdicts are COLLECTED and asserted once, never `expect`ed inside the loop: an in-loop
    // expect aborts at the first offender and hides every one after it (card a7f23a2f's own lesson).
    const offenders: string[] = [];
    for (const key of keys) {
      // Through whichever half holds it (card d4350286); it asserts the tab reads selected after.
      await openNodeTab(page, key);

      if (key === "overview") {
        // Overview's readout is the DECK, not the strip — asserted, not excused. `toHaveText`
        // retries, so this doubles as the settle for the board query behind the figure.
        await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
        await expect(page.getByTestId("atlas-kpi-cards").locator(".loom-kpi-value"))
          .toHaveText(String(seeded.open));
        const deck = await deckFigures(page);
        if (deck.cards !== String(seeded.open)) offenders.push(`${key}: deck cards=${deck.cards}`);
        if (await page.getByTestId("atlas-kpi-strip").count() !== 0) {
          offenders.push(`${key}: carries a strip as well as the deck`);
        }
        continue;
      }

      await expect(page.getByTestId("atlas-kpi-strip")).toBeVisible();
      await expect(page.getByTestId("atlas-kpi-pill-cards").locator(".loom-kpipill-v"))
        .toHaveText(String(seeded.open));
      const figures = await stripFigures(page);
      if (figures.cards !== String(seeded.open)) offenders.push(`${key}: strip cards=${figures.cards}`);
      // The strip is the WHOLE readout, not a surviving pill or two: the same six keys the deck
      // declares. A strip that quietly lost four of them would otherwise still pass on `cards`.
      if (Object.keys(figures).length !== 6) {
        offenders.push(`${key}: ${Object.keys(figures).length} pills (${Object.keys(figures).join("/")})`);
      }
    }
    expect(offenders, "every project node tab carries the node's readout, reading the seeded board").toEqual([]);
  });

  test("switch ON: the Workspace node's strip rides every tab, and is the deck's own figures", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home");

    const keys = await renderedTabKeys(page);
    expect(keys.length, `workspace node tabs: ${keys.join(", ")}`).toBeGreaterThanOrEqual(9);
    expect(keys[0]).toBe("overview");

    // The sentinel here is not an absolute count — the Workspace tier aggregates every project on a
    // daemon a sibling spec also seeds into (card 5dcb5ae9's lesson), so a fixed number would be
    // measuring the fixture. What IS pinned: the strip is the deck's figures, key for key. A strip
    // fed a different array, or a stale one, breaks this however the fixture's totals move.
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    const deck = await deckFigures(page);
    expect(Object.keys(deck).sort(), "the workspace deck's six declared tiles").toHaveLength(6);

    const offenders: string[] = [];
    for (const key of keys) {
      await openNodeTab(page, key);
      if (key === "overview") {
        if (await page.getByTestId("atlas-kpi-strip").count() !== 0) offenders.push(`${key}: strip present`);
        continue;
      }
      await expect(page.getByTestId("atlas-kpi-strip")).toBeVisible();
      const figures = await stripFigures(page);
      if (JSON.stringify(figures) !== JSON.stringify(deck)) {
        offenders.push(`${key}: ${JSON.stringify(figures)} != deck ${JSON.stringify(deck)}`);
      }
    }
    expect(offenders, "every workspace tab's strip is the Overview deck's own figures").toEqual([]);
  });

  test("switch ON: every address the project node's own tab row links to carries the strip", async ({ page, loomDaemon }) => {
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
      if (isOverviewTab) continue; // the node's own path, whose readout is the deck
      if (await page.getByTestId("atlas-kpi-strip").count() === 0) { offenders.push(`${path}: no strip`); continue; }
      await expect(page.getByTestId("atlas-kpi-pill-cards").locator(".loom-kpipill-v")).toHaveText(String(seeded.open));
      const figures = await stripFigures(page);
      if (figures.cards !== String(seeded.open)) offenders.push(`${path}: cards=${figures.cards}`);
    }
    expect(offenders, "every address the project node's tab row links to carries the node's readout")
      .toEqual([]);
  });

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
