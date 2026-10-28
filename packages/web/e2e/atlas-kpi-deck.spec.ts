// The Atlas KPI deck's row (card 14e48890 — gap-audit item 10).
//
// The deck is six readouts and the ROW is the readout: a tile pushed onto a second row stops being
// part of it. Inside the Atlas frame the content column is the viewport minus the 244px tree and
// 40px of padding, and the old width-derived `repeat(auto-fit, minmax(190px, 1fr))` track list
// resolved that to FIVE columns at 1440 — orphaning the sixth tile on a row of its own (measured:
// 1156px of deck, five 223px columns, tile six at a second offsetTop). `.loom-kpideck` now declares
// its count instead, 6 → 3 → 2, so no width can produce a part-row.
//
// How each claim is measured, and why each could actually fail:
//   1. ONE ROW AT 1440, both home nodes, tree expanded. Six tiles, one shared offsetTop, six
//      DISTINCT lefts, and a deck exactly one tile tall. Equal-top alone is vacuous on a deck that
//      lost tiles, so the count and the distinct lefts are what make it mean "six across".
//   2. THE CONTROL FOR (1): the same measurement at 1280, below the deck's declared first fold,
//      must report TWO rows. Without it, "they all share a top" is a claim this spec could not have
//      falsified in the same run — a measurement that can only ever come out one way.
//   3. THE METER. The context tile renders a track whose fill is the SEEDED occupancy, and a tile
//      with no natural ceiling renders none — so "a meter" cannot be satisfied by a meter on every
//      tile, which would be a different (and wrong) design.
//   4. TONE ORDER. A seeded 96% context reads RED. Ordered amber-first, `>= 95` was unreachable and
//      the fill under it could never leave phosphor/amber.
//   5. SWITCH OFF: the classic Overview renders its own layout and the deck this card restyled does
//      not exist in that document at all — with the switch-ON count as the positive control that
//      the absence check is capable of returning non-zero.
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
// included, so an unconditional write would re-pin on a reload (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// The card's own viewport, and the width just under the deck's declared first fold (1320px) used as
// the control in (2). 1280 is also the suite's default viewport, so the control doubles as a record
// of what every OTHER atlas spec is now looking at.
const WIDE = { width: 1440, height: 1000 };
const FOLDED = { width: 1280, height: 1000 };

// `claude-sonnet-4-5` resolves to a 1,000,000-token window (shared/types.ts `contextWindowForModel`),
// so a seeded token count IS the percentage the tile must read — no magic number on either side.
const CTX_WINDOW = 1_000_000;
const WARM_PCT = 42;
const RED_PCT = 96;

const TONE_RED = "rgb(255, 92, 92)"; // --loom-red #ff5c5c

/** The six tiles each node declares, by the `key` its testid is built from (components/atlasHome.tsx). */
const WORKSPACE_KPIS = ["projects", "live", "needs", "gates", "plan", "merged"];
const PROJECT_KPIS = ["needs", "fleet", "context", "gates", "cards", "merged"];

/**
 * A project with a board and a live worker whose context occupancy is MEASURED — the project node's
 * meter tile reads `worstContext` over the live set, so without a session reporting context the
 * tile is a dash and has no meter to assert.
 */
async function seedProject(loomDaemon: LoomDaemon, ctxPct: number) {
  const project = await loomDaemon.createProject(uniq("kpideck"));
  const sentinel = uniq("kpideck-sentinel");
  await loomDaemon.createTask(project.id, { title: sentinel, columnKey: "inbox" });
  await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "Orchestrator" });
  await loomDaemon.seedLiveSession({
    project, role: "worker", agentName: "Dev",
    model: "claude-sonnet-4-5", ctxInputTokens: (ctxPct / 100) * CTX_WINDOW,
  });
  return { project, sentinel };
}

/** Deck geometry, read off the live layout rather than inferred from the CSS. */
async function deckRows(page: Page) {
  return page.evaluate(() => {
    const deck = document.querySelector('[data-testid="atlas-kpi-deck"]') as HTMLElement | null;
    if (!deck) return null;
    const tiles = Array.from(deck.querySelectorAll('[data-testid^="atlas-kpi-"]')) as HTMLElement[];
    const box = (el: HTMLElement) => el.getBoundingClientRect();
    return {
      tiles: tiles.length,
      tops: [...new Set(tiles.map((t) => Math.round(box(t).top)))],
      lefts: [...new Set(tiles.map((t) => Math.round(box(t).left)))],
      deckHeight: Math.round(box(deck).height),
      tallestTile: Math.max(0, ...tiles.map((t) => Math.round(box(t).height))),
    };
  });
}

/** The tree really is expanded — so the measured column width is the tree-present one. */
async function expectTreeExpanded(page: Page) {
  await expect(page.locator(".loom-atlas-tree")).toBeVisible();
  // A row that only the full-width rail renders. The reference used to be the open branch's own
  // `Overview` destination (card ec1aa18e), then card 4a0ad464 removed every page row from a
  // project branch — so it is the Workspace tier's Platform node now, which is project-independent
  // and therefore does not depend on which branch happens to be open.
  await expect(page.getByTestId("atlas-node-/platform")).toBeVisible();
  const treeWidth = await page.locator(".loom-atlas-tree").evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(treeWidth, "the tree rail is at its full declared width, not collapsed").toBe(244);
}

test.describe("Atlas KPI deck row (card 14e48890)", () => {
  test("switch ON at 1440: six tiles on one row on both home nodes, with the tree expanded", async ({ page, loomDaemon }) => {
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);

    // ── The PROJECT node.
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    // Fixture identity: this is MY corpus, not a sibling daemon's. Settles the board read too.
    await expect(page.getByTestId("atlas-board-embed").getByText(seeded.sentinel, { exact: true })).toBeVisible();
    await expectTreeExpanded(page);
    for (const key of PROJECT_KPIS) await expect(page.getByTestId(`atlas-kpi-${key}`)).toBeVisible();

    const proj = (await deckRows(page))!;
    expect(proj.tiles, "all six tiles are present — equal tops over a shrunken deck would be vacuous").toBe(6);
    expect(proj.tops, "all six share one offsetTop").toHaveLength(1);
    expect(proj.lefts, "…at six distinct x positions, so that is one row of six and not a stack").toHaveLength(6);
    expect(proj.deckHeight, "the deck is exactly one tile tall").toBe(proj.tallestTile);

    // ── The WORKSPACE node, same viewport, same assertions.
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(page.getByText(seeded.project.name, { exact: false }).first()).toBeVisible();
    await expectTreeExpanded(page);
    for (const key of WORKSPACE_KPIS) await expect(page.getByTestId(`atlas-kpi-${key}`)).toBeVisible();

    const root = (await deckRows(page))!;
    expect(root.tiles).toBe(6);
    expect(root.tops, "the workspace deck shares one offsetTop too").toHaveLength(1);
    expect(root.lefts).toHaveLength(6);
    expect(root.deckHeight).toBe(root.tallestTile);
  });

  test("switch ON: the one-row measurement reports TWO rows below the fold (the control)", async ({ page, loomDaemon }) => {
    // Without this the test above asserts something it could not have falsified: a measurement that
    // reports one row whatever the layout does would pass on a deck that never fitted.
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(FOLDED);

    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(page.getByTestId("atlas-board-embed").getByText(seeded.sentinel, { exact: true })).toBeVisible();

    const folded = (await deckRows(page))!;
    expect(folded.tiles, "the same six tiles").toBe(6);
    expect(folded.tops, "two rows at 1280 — the same probe that read one row at 1440").toHaveLength(2);
    expect(folded.lefts, "…three columns, so the fold is 3+3 and never an orphaned tail").toHaveLength(3);
    expect(folded.deckHeight, "and the deck really is taller than one tile here").toBeGreaterThan(folded.tallestTile);
  });

  test("switch ON: the context tile renders a meter reading its seeded occupancy; a tile without a ceiling has none", async ({ page, loomDaemon }) => {
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    const context = page.getByTestId("atlas-kpi-context");
    await expect(context.locator(".loom-kpi-value")).toHaveText(`${WARM_PCT}%`);
    const track = context.locator(".loom-kpi-track");
    await expect(track).toBeVisible();

    // The fill is the SEEDED ratio, not merely a bar: a track with a 0-width (or full-width) fill
    // would render identically to a reader and mean nothing.
    const fill = context.locator(".loom-kpi-fill");
    const geom = await fill.evaluate((el) => {
      const own = el.getBoundingClientRect().width;
      const parent = (el.parentElement as HTMLElement).getBoundingClientRect().width;
      return { pct: Math.round((own / parent) * 100), spansTile: Math.round(parent) };
    });
    expect(geom.pct, "the fill is the seeded occupancy").toBe(WARM_PCT);
    // Full-tile-width, as the approved mockup draws it (atlas.css `.kpitile .meter`), not a fixed stub.
    const tileInner = await context.evaluate((el) => {
      // `clientWidth`, not the bounding box: the tile carries a 1px border on each side and the
      // track is laid out inside it, so a box-width comparison is off by exactly those 2px.
      const cs = getComputedStyle(el);
      return Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    });
    expect(geom.spansTile).toBe(tileInner);

    // A figure with no natural ceiling carries no meter — "renders a meter" must not be satisfiable
    // by a deck that put one under every tile.
    await expect(page.getByTestId("atlas-kpi-cards").locator(".loom-kpi-track")).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-needs").locator(".loom-kpi-track")).toHaveCount(0);
  });

  test("switch ON: a context above the red threshold reads red, not amber", async ({ page, loomDaemon }) => {
    // Ordered amber-first (`>= 80 ? amber : >= 95 ? red`) the red branch is unreachable, because
    // every value at 95 is also at 80 — so the tile and the meter fill under it could never show
    // the one state the tile exists to surface.
    const seeded = await seedProject(loomDaemon, RED_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");

    const context = page.getByTestId("atlas-kpi-context");
    await expect(context.locator(".loom-kpi-value")).toHaveText(`${RED_PCT}%`);
    await expect(context.locator(".loom-kpi-value")).toHaveCSS("color", TONE_RED);
    await expect(context.locator(".loom-kpi-fill")).toHaveCSS("background-color", TONE_RED);
  });

  test("switch OFF: the classic Overview renders its own layout and no KPI deck exists at all", async ({ page, loomDaemon }) => {
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/overview");

    // PRESENCE first: the classic shell and the classic Overview's own board really are here, at the
    // same 1440 the Atlas legs ran at.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByText(seeded.sentinel, { exact: true })).toBeVisible();
    await expect(page.locator(".loom-board-grid > .loom-grid")).toHaveCount(7);

    // …and the element every rule this card touched is scoped to does not exist in this document, so
    // none of them can reach the classic page. (`.loom-kpi` covers the tile chrome, `.loom-kpi-track`
    // the meter — the deck is the only thing that mounts any of them.)
    await expect(page.locator(".loom-kpideck")).toHaveCount(0);
    await expect(page.locator(".loom-kpi, .loom-kpi-track")).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);

    // POSITIVE CONTROL for that absence: the same locators are non-zero with the switch on, so a
    // zero above is the classic page's real shape and not a selector that matches nothing anywhere.
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.locator(".loom-kpideck")).toHaveCount(1);
    await expect(page.locator(".loom-kpi")).toHaveCount(6);
    await expect(page.locator(".loom-kpi-track")).toHaveCount(1);
  });
});
