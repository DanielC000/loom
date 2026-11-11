// Card 53dfa70c — a session tile's terminal text fills a 1-column card instead of stalling part-way.
//
// Session terminals have a fixed pty geometry and the pane scales its FONT to fit both axes
// (components/Terminal.tsx solveFontSize). The tile's numeric height is a HUG cap; at the old 540 the
// height term won from a ~790px card on, so at a 1100px viewport the 80-column grid sat ~763px wide in
// a ~986px pane — a ~223px empty strip on its right. The cap is now high enough that the grid stays
// width-bound across the whole 1-column `auto` band.
//
// RED on the old cap (pages/Terminals.tsx TILE_MAX_HEIGHT = 540): the strip never closes, so the poll
// below times out. Seeded at the REAL default geometry (80x24) and filled edge to edge, because the
// plateau is a property of that aspect ratio — a small seeded grid would never reach the height bound.
import { expect, test } from "./fixtures/daemon";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const GEOMETRY = { cols: 80, rows: 24 };
/** Every row but the sentinel's full, so the screen reads as a real full-width terminal. One short of
 *  `rows` so the sentinel line written first is still on screen, not scrolled into scrollback. */
const FULL_SCREEN = Array.from({ length: GEOMETRY.rows - 1 }, (_, i) =>
  `${String(i).padStart(2, "0")}:` + "X".repeat(GEOMETRY.cols - 4)).join("\r\n");

/** The largest empty strip allowed to the grid's right: one cell plus the font solver's 0.1px quantum. */
const MAX_STRIP_PX = 16;

test("53dfa70c: in the 1-column band the terminal grid fills the card's width", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("tilefill"));
  const sentinel = `TILEFILL-${Math.floor(Math.random() * 1e6)}`;
  await loomDaemon.seedLiveSession({
    project, id: uniq("tilefill"), role: "worker", agentName: "Tile Fill",
    ptyGeometry: GEOMETRY, ptyBytes: `${sentinel}\r\n` + FULL_SCREEN,
  });

  // The Workspace node's Terminals grid (the classic /terminals page until card acbb6df6). Its content
  // column sits beside the 244px entity tree, so the classic 1100px window becomes 1300 here: the same
  // ~1000px, one-column card the precondition below checks for (rather than trusting this number).
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.goto(`${loomDaemon.baseURL}/workspace-terminals`);
  // Fixture identity: the pane we measure is THIS seeded session's, not a sibling's.
  await expect(page.locator(".xterm-rows").first()).toContainText(sentinel, { timeout: 20_000 });

  const measure = () => page.evaluate(() => {
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const pane = screen.closest(".xterm")!.parentElement as HTMLElement;
    let item: HTMLElement = pane;
    while (item.parentElement && getComputedStyle(item.parentElement).display !== "grid") item = item.parentElement;
    const grid = item.parentElement!;
    return {
      tracks: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
      cardW: item.getBoundingClientRect().width,
      paneW: pane.clientWidth,
      screenW: screen.getBoundingClientRect().width,
    };
  });

  // The precondition that makes this the reported band: ONE column, and a card well past the ~790px
  // where the old cap's height bound took over. Without it a layout change could pass this leg vacuously.
  const before = await measure();
  expect(before.tracks, "the window must still be the 1-column band").toBe(1);
  expect(before.cardW, "the card must be wide enough to have stalled under the old cap").toBeGreaterThan(900);

  await expect.poll(async () => { const m = await measure(); return m.paneW - m.screenW; }, {
    message: "the terminal grid stopped growing short of its card (the height bound won)",
    timeout: 10_000,
  }).toBeLessThanOrEqual(MAX_STRIP_PX);
});
