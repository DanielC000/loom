// The Atlas KPI deck's row (card 14e48890 — gap-audit item 10).
//
// The deck is six readouts and the ROW is the readout: a tile pushed onto a second row stops being
// part of it. `.loom-kpideck` declares its count (6 → 3 → 2) rather than deriving tracks from width
// — the old `repeat(auto-fit, minmax(190px, 1fr))` resolved to five columns in the Atlas frame's
// 1156px content column and orphaned the sixth tile on a row of its own.
//
// @decision 269f46ef — do not re-point this file's deck legs at the project node. The deck has ONE
// mount (`/home`); the project node's readings are a briefing line, and leg 1 asserts that absence.
//
// How each claim is measured, and why each could actually fail:
//   1. ONE ROW AT 1440 on the Workspace node, tree expanded. Six tiles, one shared offsetTop, six
//      DISTINCT lefts, and a deck exactly one tile tall. Equal-top alone is vacuous on a deck that
//      lost tiles, so the count and the distinct lefts are what make it mean "six across". Then the
//      project node, at the same viewport, with NO deck at all — the workspace count directly above
//      is that absence's positive control.
//   2. THE CONTROL FOR (1): the same measurement at 1280, below the deck's declared first fold,
//      must report TWO rows. Without it, "they all share a top" is a claim this spec could not have
//      falsified in the same run — a measurement that can only ever come out one way.
//   3. SWITCH OFF: the classic Overview renders its own layout and the deck this card restyled does
//      not exist in that document at all — with the switch-ON count as the positive control that
//      the absence check is capable of returning non-zero.
//
// Two legs moved out with the project node's deck, neither dropped: `KpiTile`'s `fill` rendering is
// asserted at its one remaining mount (the Workspace `plan` tile) by `workspace-plan-window.spec.ts`;
// the red-before-amber context ordering moved to `atlas-project-overview.spec.ts`, on the briefing
// line's `worst context` figure and the roster row's context track. Leg 1 keeps the "a tile with no
// ceiling has no meter" half, re-pointed at the Workspace deck.
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
  test("switch ON at 1440: six tiles on one row on the Workspace node, and no deck on the project node", async ({ page, loomDaemon }) => {
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(WIDE);

    // ── The WORKSPACE node — the deck's one remaining mount (card 269f46ef).
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    // Fixture identity: this is MY corpus, not a sibling daemon's.
    await expect(page.getByText(seeded.project.name, { exact: false }).first()).toBeVisible();
    await expectTreeExpanded(page);
    for (const key of WORKSPACE_KPIS) await expect(page.getByTestId(`atlas-kpi-${key}`)).toBeVisible();

    const root = (await deckRows(page))!;
    expect(root.tiles, "all six tiles are present — equal tops over a shrunken deck would be vacuous").toBe(6);
    expect(root.tops, "all six share one offsetTop").toHaveLength(1);
    expect(root.lefts, "…at six distinct x positions, so that is one row of six and not a stack").toHaveLength(6);
    expect(root.deckHeight, "the deck is exactly one tile tall").toBe(root.tallestTile);

    // A figure with no natural ceiling carries NO meter — so "the deck renders meters" can never be
    // satisfied by a deck that put one under every tile. (The one tile that DOES carry a meter here,
    // `plan`, is asserted with its real fill geometry in workspace-plan-window.spec.ts, which route-
    // intercepts the usage payload this hermetic daemon cannot produce.)
    await expect(page.getByTestId("atlas-kpi-projects").locator(".loom-kpi-track")).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-needs").locator(".loom-kpi-track")).toHaveCount(0);

    // ── The PROJECT node, same viewport: the owner removed the deck from it entirely. Asserted
    // AFTER the workspace count above, which is this absence's positive control — a zero here with
    // nothing proving the locator can be non-zero would pass against a broken testid.
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-overview-roster"),
      "the project node's own primary surface, so this is a loaded page and not a blank one").toBeVisible();
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
    await expect(page.locator(".loom-kpi")).toHaveCount(0);
    for (const key of PROJECT_KPIS) await expect(page.getByTestId(`atlas-kpi-${key}`)).toHaveCount(0);
  });

  test("switch ON: the one-row measurement reports TWO rows below the fold (the control)", async ({ page, loomDaemon }) => {
    // Without this the test above asserts something it could not have falsified: a measurement that
    // reports one row whatever the layout does would pass on a deck that never fitted.
    const seeded = await seedProject(loomDaemon, WARM_PCT);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.setViewportSize(FOLDED);

    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
    await expect(page.getByText(seeded.project.name, { exact: false }).first()).toBeVisible();

    const folded = (await deckRows(page))!;
    expect(folded.tiles, "the same six tiles").toBe(6);
    expect(folded.tops, "two rows at 1280 — the same probe that read one row at 1440").toHaveLength(2);
    expect(folded.lefts, "…three columns, so the fold is 3+3 and never an orphaned tail").toHaveLength(3);
    expect(folded.deckHeight, "and the deck really is taller than one tile here").toBeGreaterThan(folded.tallestTile);
  });
});
