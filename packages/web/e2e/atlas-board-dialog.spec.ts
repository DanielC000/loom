// Atlas board cards open the CENTRED DIALOG, on every board surface (card a6d7a102, Atlas build plan
// P2-5: docs/plans/atlas-ui/03-decomposition.md row P2-5).
//
// The owner's rule, verbatim in intent: a board card opens the centred dialog, never a drawer, and the
// board never reflows. Atlas has four board surfaces, and ALL FOUR mount the one `<Board>` component
// (pages/Board.tsx), so there is one dialog implementation and nothing to re-build — this spec is the
// witness that each surface really does get that one shape, which is a different claim from "they
// share an import" and is the only one worth asserting.
//
//   1. the project node's Overview tab   `/project?tab=overview`  (ProjectHome.tsx)
//   2. the project node's Deck tab       `/project?tab=deck`      (ProjectHome.tsx)
//   3. the Board node                    `/board`                 (nav.tsx NAV_PAGES)
//   4. the Platform node's Board tab     `/platform?tab=board`    (PlatformView.tsx)
//
// What each surface is measured on, and why that measurement can fail:
//   · NEVER A DRAWER — the two side margins of the panel are EQUAL. A right-anchored slide-over has
//     them differing by most of the viewport, so this is the discriminating form of "centred"; a bare
//     `role=dialog` check passes against a drawer, and a bare centre-point check is satisfied by a
//     full-bleed panel. The width is pinned to the 820px cap as well, and the overlay to the viewport.
//   · THE BOARD NEVER REFLOWS — the lane count AND the board grid's own bounding box are compared
//     before open / while open / after close. Lane count alone would miss a board squeezed to make
//     room for a panel, which is exactly the failure a drawer causes and what the owner ruled out.
//   · ONE IMPLEMENTATION — `toHaveCount(1)` on `role=dialog`, so a surface that grew its own second
//     detail surface beside the shared one fails here rather than passing on the first match.
//
// The keyboard path is asserted once, on the Board node: Enter opens, focus moves INTO the panel (not
// left on the card behind the modal), Escape closes and hands focus back to the same card.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there before what must not. Geometry is
// sampled until two consecutive reads agree before it is compared (card 757c80dd gotcha 2).
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import type { Locator } from "@playwright/test";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// The default board layout. Pinned as a constant so a change to it fails this spec loudly instead of
// quietly weakening the reflow check into "whatever happens to be on screen, twice".
const DEFAULT_LANES = 7;

// The panel's width cap (`min(820px, 92vw)`, pages/Board.tsx) and the viewport this spec measures at —
// 92vw of 1600 is 1472, so 820 is the branch that wins and the number below is a real cap, not a slice
// of the window.
const PANEL_W = 820;
const VIEWPORT = { width: 1600, height: 1000 };

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and that leg would measure this helper (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`, scoped through the grid so the
// Panels around it can never be counted as lanes (same idiom as board.spec.ts / atlas-home.spec.ts).
const lanesIn = (scope: Locator) => scope.locator(".loom-board-grid > .loom-grid");

// The card's open target — `.loom-board-open`, the role=button region the card click/Enter handler
// lives on (pages/Board.tsx `Card`). Located by it rather than by the title text because the title is
// NOT unique board text: a child card renders its parent's title as a chip (card 1ae4f88c).
const openTargetIn = (scope: Locator, title: string) => scope.locator(".loom-board-open").filter({ hasText: title });

type Geometry = { x: number; y: number; width: number; height: number };

async function boardGeometry(scope: Locator): Promise<Geometry> {
  const box = await scope.locator(".loom-board-grid").boundingBox();
  expect(box, "the board grid must be laid out before its geometry can be compared").not.toBeNull();
  return { x: Math.round(box!.x), y: Math.round(box!.y), width: Math.round(box!.width), height: Math.round(box!.height) };
}

/**
 * The board grid's geometry, sampled until two consecutive reads agree. A box read straight after a
 * navigation is a coin flip while the board's own 4s query and the band above it are still resolving
 * — the P1-0 shell fingerprint hit exactly this and two identical runs disagreed. Comparing an
 * unsettled "before" against a settled "after" would report a reflow that never happened.
 */
async function settledBoardGeometry(scope: Locator): Promise<Geometry> {
  let prev = await boardGeometry(scope);
  for (let i = 0; i < 25; i++) {
    await scope.page().waitForTimeout(120);
    const next = await boardGeometry(scope);
    if (next.x === prev.x && next.y === prev.y && next.width === prev.width && next.height === prev.height) return next;
    prev = next;
  }
  throw new Error(`the board grid never settled to a stable geometry (last read ${JSON.stringify(prev)})`);
}

/**
 * The dialog shape the owner ruled for: ONE centred modal, 820px wide, over a full-viewport overlay,
 * with EQUAL side margins. The margin equality is the "never a drawer" assertion — see the header.
 */
async function assertCentredDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog, "exactly one detail surface — not the shared dialog plus a second one").toHaveCount(1);
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  // The overlay covers the whole viewport. A drawer's backdrop is anchored to one edge.
  const overlay = await dialog.boundingBox();
  expect(overlay).not.toBeNull();
  expect(Math.round(overlay!.width)).toBe(viewport!.width);
  expect(Math.round(overlay!.height)).toBe(viewport!.height);

  const panel = await dialog.locator("> div").boundingBox();
  expect(panel).not.toBeNull();
  expect(Math.round(panel!.width), "the panel's min(820px, 92vw) cap").toBe(PANEL_W);

  const leftGap = panel!.x;
  const rightGap = viewport!.width - (panel!.x + panel!.width);
  expect(leftGap, "the panel is clear of the left edge").toBeGreaterThan(0);
  expect(rightGap, "the panel is clear of the right edge").toBeGreaterThan(0);
  // THE drawer check: a slide-over is flush to one edge, so its gaps differ by hundreds of pixels.
  expect(Math.abs(leftGap - rightGap), "equal side margins — centred, not anchored to an edge").toBeLessThan(2);
}

/**
 * One board surface, end to end: the board is whole and no dialog is open, the card opens the centred
 * dialog, the board behind it is byte-identical in lane count and geometry, and closing leaves it so.
 */
async function assertSurfaceOpensCentredDialog(
  page: Page,
  scope: Locator,
  task: { id: string; title: string },
  label: string,
) {
  // PRESENCE first: the surface, its board and the card really are here…
  await expect(scope, `${label}: the board surface`).toBeVisible();
  const card = openTargetIn(scope, task.title);
  await expect(card, `${label}: the seeded card`).toBeVisible();
  await expect(lanesIn(scope), `${label}: the whole board`).toHaveCount(DEFAULT_LANES);
  // …and only THEN that nothing is open yet.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const before = await settledBoardGeometry(scope);

  await card.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // It is THIS card's detail, not merely a dialog — the short id is the drawer header's own text.
  await expect(page.getByRole("dialog").getByText(`Task · ${task.id.slice(0, 8)}`)).toBeVisible();
  await assertCentredDialog(page);

  // The board behind the modal is untouched: same lanes, same box.
  await expect(lanesIn(scope), `${label}: lanes while the dialog is open`).toHaveCount(DEFAULT_LANES);
  expect(await boardGeometry(scope), `${label}: the board reflowed when the dialog opened`).toEqual(before);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(lanesIn(scope), `${label}: lanes after the dialog closed`).toHaveCount(DEFAULT_LANES);
  expect(await boardGeometry(scope), `${label}: the board reflowed when the dialog closed`).toEqual(before);
}

/** A project with one card in a known non-terminal lane — the card every surface below opens. */
async function seedCard(loomDaemon: LoomDaemon, projectId: string) {
  const title = uniq("dialogcard-SENTINEL");
  const task = await loomDaemon.createTask(projectId, { title, body: `body ${title}`, columnKey: "todo" });
  return { id: task.id, title };
}

test.describe("Atlas board cards open the centred dialog (card a6d7a102)", () => {
  // ── 1 + 2. The project node's two tabs ──────────────────────────────────────────────────────────
  test("switch ON: the project node's Overview and Deck tabs both open the centred dialog", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdlg-overview"));
    const task = await seedCard(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);

    const embed = page.getByTestId("atlas-board-embed");

    await page.goto(`${loomDaemon.baseURL}/project?tab=overview`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertSurfaceOpensCentredDialog(page, embed, task, "project node · Overview");

    // The Deck tab is the board-FIRST read of the same node: a different layout above the board, so
    // the board's own geometry differs between the tabs — which is why each tab captures its own
    // baseline rather than sharing one.
    await page.goto(`${loomDaemon.baseURL}/project?tab=deck`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertSurfaceOpensCentredDialog(page, embed, task, "project node · Deck");
  });

  // ── 3. The Board node, plus the keyboard path ───────────────────────────────────────────────────
  test("switch ON: the Board node opens the centred dialog, and the keyboard path opens and returns focus", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdlg-boardnode"));
    const task = await seedCard(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const main = page.locator("main");
    await assertSurfaceOpensCentredDialog(page, main, task, "Board node");

    // ── The keyboard path. Before card a6d7a102 the card's open target was a plain <div onClick>:
    //    there was no way in from the keyboard at all, and with nothing focused when the dialog
    //    opened, Esc left the user at <body> facing the whole page to re-Tab through.
    const card = openTargetIn(main, task.title);
    await expect(card).toBeVisible();
    // Tab first so Chromium's focus-visible heuristic is in KEYBOARD modality — a ring assertion after
    // a bare programmatic focus measures the heuristic, not the stylesheet.
    await page.keyboard.press("Tab");
    await card.focus();
    await expect(card).toBeFocused();

    // The ring is real AND unclipped. `outlineStyle !== "none"` alone is vacuous — Chromium's own UA
    // ring satisfies it while the control is visibly ringless — so this pins the exact declaration and
    // asserts offset+width <= 0, i.e. painted INSIDE the border box where the lane's own
    // `overflow-y: auto` cannot clip it (measured on card 4249ae1c).
    const ring = await card.evaluate((el) => {
      const s = getComputedStyle(el);
      return { visible: el.matches(":focus-visible"), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset };
    });
    expect(ring.visible, "the focused card matches :focus-visible").toBe(true);
    expect(ring.style).toBe("solid");
    expect(parseFloat(ring.offset) + parseFloat(ring.width), "the ring paints inside the border box, so the lane's scroll container cannot clip it").toBeLessThanOrEqual(0);

    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Focus moved INTO the panel — not left on the card sitting behind the modal.
    await expect(dialog.locator("> div")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card, "Escape hands focus back to the card it was opened from").toBeFocused();
    await expect(lanesIn(main)).toHaveCount(DEFAULT_LANES);
  });

  // ── 4. The Platform node's own Board tab ────────────────────────────────────────────────────────
  test("switch ON: the Platform node's Board tab opens its own card in the centred dialog", async ({ page, loomDaemon }) => {
    // The Platform node's board is the reserved home's, never the active project's (card fa3bb729) —
    // so the card has to be seeded THERE, and removed after: that board is shared with every other
    // spec on this worker's daemon (card 1d3192dc trap 1).
    const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` } });
    expect(res.ok, `GET /api/setup/home -> ${res.status}`).toBe(true);
    const home = (await res.json()) as { project: { id: string; name: string } };
    expect(home.project.name, "the reserved home this leg seeds into").toBe("Platform");

    const task = await seedCard(loomDaemon, home.project.id);
    // A SECOND project, pinned active, so "the Platform board's card opened" cannot be satisfied by
    // the active project's board having been rendered here instead.
    const other = await loomDaemon.createProject(uniq("atlasdlg-zulu"));

    try {
      await seedAtlasOn(page);
      await pinProject(page, other.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=board`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      await assertSurfaceOpensCentredDialog(page, page.getByTestId("platform-panel-board"), task, "Platform node · Board");
    } finally {
      await fetch(`${loomDaemon.baseURL}/api/tasks/${task.id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // ── The other polarity ──────────────────────────────────────────────────────────────────────────
  test("switch OFF: the classic board is untouched and opens the same centred dialog", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasdlg-classic"));
    const task = await seedCard(loomDaemon, project.id);

    await pinProject(page, project.id); // no seedAtlasOn — OFF is the default
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board`);

    // PRESENCE: the classic shell is really the one that mounted…
    await expect(page.locator(".loom-rail")).toBeVisible();
    // …and nothing Atlas is in the document, so this leg cannot be measuring the Atlas frame.
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

    await assertSurfaceOpensCentredDialog(page, page.locator("main"), task, "classic Board page");
  });
});
