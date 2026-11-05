// Card 80c4e758 — the project Overview's terminal tile leaves no empty strip right of its grid in the
// 1-column band, WITHOUT growing taller (the board embed below it must not move).
//
// Session terminals have a fixed pty geometry and the pane scales its FONT to fit both axes
// (components/Terminal.tsx). Overview tiles are a fixed 520px HUG cap, so in the 1-column band the
// height term wins and the 80x24 grid stops growing while the card keeps widening — a strip that reached
// ~390px at a 1200px viewport. /terminals fixed the same plateau by raising its height cap (card
// 53dfa70c); Overview instead caps the card's WIDTH to the grid, left-aligned like the rest of the page.
//
// RED before the fix: at 1100px the strip is ~290px, so the poll below times out. Seeded at the REAL
// default geometry (80x24) and filled edge to edge, because the plateau is a property of that aspect
// ratio — a small seeded grid never reaches the height bound.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const GEOMETRY = { cols: 80, rows: 24 };
const FULL_SCREEN = Array.from({ length: GEOMETRY.rows - 1 }, (_, i) =>
  `${String(i).padStart(2, "0")}:` + "X".repeat(GEOMETRY.cols - 4)).join("\r\n");

/** The largest empty strip allowed right of the grid: one cell plus the font solver's 0.1px quantum. */
const MAX_STRIP_PX = 16;

const measure = (page: Page) => page.evaluate(() => {
  const screen = document.querySelector(".xterm-screen") as HTMLElement;
  const pane = screen.closest(".xterm")!.parentElement as HTMLElement;
  let item: HTMLElement = pane;
  while (item.parentElement && getComputedStyle(item.parentElement).display !== "grid") item = item.parentElement;
  const grid = item.parentElement!;
  const tracks = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
  return {
    tracks: tracks.length,
    trackW: parseFloat(tracks[0] ?? "0"),
    cardLeft: item.getBoundingClientRect().left,
    gridLeft: grid.getBoundingClientRect().left,
    cardW: item.getBoundingClientRect().width,
    paneW: pane.clientWidth,
    paneH: pane.clientHeight,
    screenW: screen.getBoundingClientRect().width,
    screenH: screen.getBoundingClientRect().height,
  };
});

test("80c4e758: a 1-column Overview tile is capped to its terminal grid; multi-column tiles are not", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("ovwidth"));
  const sentinel = `OVWIDTH-${Math.floor(Math.random() * 1e6)}`;
  await loomDaemon.seedLiveSession({
    project, id: uniq("ovwidth"), role: "worker", agentName: "Width Probe",
    ptyGeometry: GEOMETRY, ptyBytes: `${sentinel}\r\n` + FULL_SCREEN,
  });
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);

  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`${loomDaemon.baseURL}/overview`);
  // Fixture identity: the pane we measure is THIS seeded session's, not a sibling's.
  await expect(page.locator(".xterm-rows").first()).toContainText(sentinel, { timeout: 20_000 });

  // Precondition: this IS the reported band — one track, far wider than the grid can grow at 520px.
  const first = await measure(page);
  expect(first.tracks, "1100px must be the 1-column band").toBe(1);
  expect(first.trackW, "the track must be wide enough for the height bound to have stalled the grid").toBeGreaterThan(900);

  await expect.poll(async () => { const m = await measure(page); return m.paneW - m.screenW; }, {
    message: "an empty strip remains right of the terminal grid",
    timeout: 10_000,
  }).toBeLessThanOrEqual(MAX_STRIP_PX);

  const capped = await measure(page);
  // Closed by narrowing the CARD, not by growing the grid: the card is well inside its track, left-aligned.
  expect(capped.cardW).toBeLessThan(capped.trackW - 100);
  expect(Math.abs(capped.cardLeft - capped.gridLeft)).toBeLessThanOrEqual(1);
  // The pane hugs exactly the grid it rendered — no clipped rows, no letterbox.
  expect(Math.abs(capped.paneH - capped.screenH)).toBeLessThanOrEqual(1);

  // Multi-column band: the cap is never applied, so the card fills its track exactly as before.
  await page.setViewportSize({ width: 1700, height: 1000 });
  await expect.poll(async () => (await measure(page)).tracks, { timeout: 10_000 }).toBeGreaterThan(1);
  const wide = await measure(page);
  expect(Math.abs(wide.cardW - wide.trackW)).toBeLessThanOrEqual(1);
});
