// Platform node — the Agents grid must stay inside its column at phone width (card dd4f8a16).
//
// THE DEFECT: PlatformView's Agents section laid its two go-live cards out with an unguarded
// `repeat(auto-fill, minmax(360px, 1fr))`. At a 390px viewport the column is narrower than 360px, so the
// single track still floored at 360 and each card spilled ~10px past the grid's right edge. The fix is
// the same `min(100%, …)` guard the terminal grid uses (lib/terminalLayout.ts).
//
// INSTRUMENT: per-BOX fit, not the page's scrollWidth — under Atlas `.loom-atlas-content` scrolls, so a
// page-level reading is non-diagnostic (actors-narrow-viewport.spec.ts measured that). Each card's right
// edge is read against the grid's own right edge, plus the grid's own scrollWidth vs clientWidth.
//
// CONTROL: the same grid at desktop width must still put both cards on ONE row. Without it, a "fix" that
// collapsed the grid to a single column everywhere (or a locator that matched an empty box) would pass.
import { expect, test, type Page } from "./fixtures/daemon";

const PHONE = { width: 390, height: 900 };
const DESKTOP = { width: 1280, height: 900 };
// Sub-pixel rounding only — the defect was ~10px.
const TOLERANCE_PX = 1;
// lib/atlasUi.ts owns this key; hardcoded because the e2e tsconfig cannot import `src/`.
const ATLAS_KEY = "loom.atlasUi";

type GridFit = { cards: number; gridRight: number; overflow: number; maxCardRight: number; rows: number };

async function measureGrid(page: Page): Promise<GridFit> {
  const grid = page.getByTestId("platform-agents-grid");
  await expect(grid).toBeVisible();
  return grid.evaluate((el) => {
    const g = el.getBoundingClientRect();
    const kids = Array.from(el.children).map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    return {
      cards: kids.length,
      gridRight: Math.round(g.right),
      overflow: Math.round(el.scrollWidth - el.clientWidth),
      maxCardRight: Math.round(Math.max(...kids.map((r) => r.right))),
      rows: new Set(kids.map((r) => Math.round(r.top))).size,
    };
  });
}

test.describe("Platform node Agents grid at phone width (card dd4f8a16)", () => {
  test("switch ON: the go-live cards fit the column at 390px and still share a row on desktop", async ({ page, loomDaemon }) => {
    await page.addInitScript((key) => {
      try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
    }, ATLAS_KEY);

    // ── CONTROL: desktop — two cards, one row. ──
    await page.setViewportSize(DESKTOP);
    await page.goto(`${loomDaemon.baseURL}/platform`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    // The shipping end-user edition (LOOM_DEV=0 fixture) — its two go-live buttons are the grid's cards.
    await expect(page.getByRole("button", { name: /^start platform$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /review my workspace/i })).toBeVisible();
    const desktop = await measureGrid(page);
    expect(desktop.cards, "the Agents grid's two go-live cards").toBe(2);
    expect(desktop.rows, "on desktop both cards share one row").toBe(1);

    // ── PHONE: no card crosses the grid's right edge, and the grid itself does not scroll sideways. ──
    await page.setViewportSize(PHONE);
    await expect.poll(async () => (await measureGrid(page)).rows, { message: "the grid should reflow to one column" }).toBe(2);
    const phone = await measureGrid(page);
    expect(phone.cards).toBe(2);
    expect(phone.maxCardRight - phone.gridRight, `card overflow past the grid at 390px: ${JSON.stringify(phone)}`)
      .toBeLessThanOrEqual(TOLERANCE_PX);
    expect(phone.overflow, `grid scrollWidth - clientWidth at 390px: ${JSON.stringify(phone)}`)
      .toBeLessThanOrEqual(TOLERANCE_PX);

    // Opt-in review shots (light + dark) — only when a directory is named, so an ordinary run writes nothing.
    const shotDir = process.env.LOOM_E2E_SHOT_DIR;
    if (shotDir) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), ["loom.theme", theme] as const);
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.getByTestId("platform-agents-grid").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shotDir}/platform-agents-grid-390-${theme}.png` });
      }
    }
  });
});
