// A live terminal pane must be GEOMETRICALLY AT REST when nothing is happening (card ebbc4a70).
//
// @decision ebbc4a70 — never assert this from a single geometry reading, and never drop the no-clip
// leg: the defect is an OSCILLATION between two states, one of which clipped ~2 rows, so a one-shot
// read passes on the bad code and "it settled" alone passes on the clipping member.
//
// WHAT WENT WRONG, AND WHY THE INSTRUMENT IS SHAPED LIKE THIS
// `TerminalPane.applyFontSize` solved the font from the renderer's measured cell box and, in HUG mode,
// wrote the resulting grid height onto the very element its own ResizeObserver watches. xterm rounds
// that cell box to whole CSS pixels, so `cell.height / fontSize` moves with the font it was measured at
// (11/9.1 vs 10/8.7 — 5.2%, against a 0.1 font quantum): one solver pass was not a fixed point, the
// pane 2-cycled, and the observer re-fired on its own write. MEASURED on main: 123 real
// `DomRenderer.handleResize` calls in 2000ms (61.5/s), indefinitely, at rest.
//
// The two states were `pane 421px / screen 400px` and `pane 419px / screen 440px`. The SECOND is the
// reason this spec asserts no-clip separately: a 419px pane around a 440px grid loses ~2 rows to the
// pane's `overflow:hidden`, so a fix that merely stops the motion can freeze the terminal in a state
// that silently eats rows. Settling and not-clipping are INDEPENDENT properties; both are asserted.
//
// WHY WE SAMPLE STYLE STRINGS AND NOT SCREENSHOTS OR CHILD COUNTS
// Terminal-adjacent `locator.screenshot()` can never satisfy Playwright's stability check while this
// class of motion exists ("element is not stable", 416 retries measured on card 6b8ff4a2), and counting
// `.xterm-selection` children is timing-dependent (an empty selection leaves zero-geometry ghosts —
// `@decision 6b8ff4a2`). `.xterm-screen`'s own inline height IS the rendered grid (DomRenderer
// `_updateDimensions` writes it), and the pane's inline height is what `applyFontSize` writes, so
// rAF-sampling the pair reads the real geometry with no monkeypatching of the app at all.
//
// WHY THE VIEWPORT IS PINNED, AND WHY 1200x900
// Whether the pane oscillates depends on the resolved HUG budget, not on the shell: swept 1000->1600px
// on main, CLASSIC was red at 8 of 13 widths and ATLAS at 9 of 13, with the identical cycle. 1200x900 is
// red under BOTH shells; 1280x900 (the Playwright default) happens to be a fixed point in classic, so a
// spec left at the default would have false-greened half its legs. 1450x900 was already a fixed point
// under both shells before the fix — it is here as the contrast case, to prove the fix did not buy
// at-rest stability by breaking a case that was already correct.
import { expect, test, type Page } from "./fixtures/daemon";

const atlasShell = (page: Page) => page.getByTestId("atlas-shell");

async function openShell(page: Page, baseURL: string, path: string): Promise<void> {
  await page.goto(baseURL + path);
  await expect(atlasShell(page)).toBeVisible();
}

/**
 * Sample `(pane inline height, .xterm-screen inline height)` once per animation frame for `ms`, and
 * return the DISTINCT pairs seen. At rest that must be exactly one; the oscillation produced two,
 * alternating every single frame, so even a short window separates them decisively.
 */
async function geometryStates(page: Page, ms: number): Promise<string[]> {
  await page.evaluate((duration) => {
    const w = window as unknown as { __geo: string[]; __geoStop?: number };
    w.__geo = [];
    const until = performance.now() + (duration as number);
    const tick = () => {
      const screen = document.querySelector(".xterm-screen") as HTMLElement | null;
      const pane = (document.querySelector(".xterm") as HTMLElement | null)?.parentElement as HTMLElement | null;
      // BOTH axes of the rendered grid, plus the pane height the component writes. Height alone is too
      // narrow a fingerprint: `css.canvas.height` is `rows * round(cell.height)`, so a real refit can
      // land on the same rounded height at a different font while the WIDTH moves — which is exactly
      // how the first draft of this spec's own positive control false-failed.
      if (screen && pane) w.__geo.push(`pane=${pane.style.height} screen=${screen.style.width}x${screen.style.height}`);
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
  await page.waitForTimeout(ms + 250);
  const samples = await page.evaluate(() => (window as unknown as { __geo: string[] }).__geo);
  // A sampler that never ran reports ZERO distinct states, which `toHaveLength(1)` would fail on — but
  // one that ran for only a frame or two reports ONE and passes vacuously. So pin the POPULATION too:
  // ~60fps over `ms` is far above this floor, and the oscillation alternated every single frame.
  expect(samples.length, "the rAF sampler should have collected a real population of frames").toBeGreaterThan(30);
  return Array.from(new Set(samples));
}

/** The pane must be at least as tall as the grid it renders, or `overflow:hidden` eats rows. */
async function clipPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const pane = (document.querySelector(".xterm") as HTMLElement).parentElement as HTMLElement;
    return parseFloat(screen.style.height) - parseFloat(pane.style.height);
  });
}

const SHORT_ID = "atrest00";

test("a live terminal pane is geometrically at rest, and never clips its own grid", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);
  const seeded = await loomDaemon.seedLiveSession({
    role: "worker",
    // A distinctive 8-char prefix, so the tile's rendered short id (`id.slice(0, 8)`) identifies THIS
    // spec's row rather than the fixture's default "e2e-live" that every other seeded session shows —
    // a sibling worker's dev server renders this app identically, so the short id is what pins which
    // data these assertions are actually reading.
    id: `${SHORT_ID}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: "AT-REST-ebbc4a70 resting terminal\r\n$ ",
  });

  // Pinned BEFORE the first paint: the budget is derived during layout, and 1200x900 is the width
  // that oscillates (see the header).
  await page.setViewportSize({ width: 1200, height: 900 });
  // The project node's Sessions tab (`/terminals`), pinned to THIS seeded project so its tile is the only
  // terminal on the page — the instrument reads the document's first `.xterm`. It is a HUG-mode tile (a
  // numeric height budget), which is the mode this spec is about: the classic /overview tile it measured
  // went with that page (card acbb6df6). Not the session node: that renders `height="auto"`, where the
  // solver never writes the pane height this instrument compares against.
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), seeded.projectId);
  await openShell(page, loomDaemon.baseURL, "/terminals");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 20_000 });

  // Identity: this is THIS spec's seeded session, not a sibling's identically-rendered app.
  await expect(page.getByText(seeded.sessionId.slice(0, 8)).first()).toBeVisible();
  expect(seeded.sessionId.slice(0, 8)).toBe(SHORT_ID);

  await page.waitForTimeout(2500); // attach + geometry frame + the one-shot repaint debounce

  // ── AT REST: exactly one geometry state over ~2s (RED on main: two, alternating per frame)
  const atRest = await geometryStates(page, 2000);
  expect(atRest, "pane geometry should be at rest at 1200x900").toHaveLength(1);

  // ── NO CLIP at the pinned, previously-oscillating viewport
  expect(await clipPx(page), "the pane must not be shorter than the grid it renders").toBeLessThanOrEqual(0);

  // ── POSITIVE CONTROL: a REAL container resize must still refit — and then settle again.
  // Without this, "one distinct state" would also pass on a pane that had stopped refitting entirely.
  // 640x900 is MEASURED to move the settled geometry (634x400 -> 583x360). Several wider candidates do
  // NOT: the budget still binds there, so the font — and therefore the whole grid — is unchanged, and a
  // control placed at one of those would fail against a perfectly healthy pane. Don't "fix" a failure
  // here by widening it back.
  const before = atRest[0];
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(1500);
  const afterResize = await geometryStates(page, 2000);
  expect(afterResize, "pane geometry should settle again after a real resize").toHaveLength(1);
  expect(afterResize[0], "a real container resize must actually refit the grid").not.toBe(before);
  expect(await clipPx(page), "no clipping after a real resize either").toBeLessThanOrEqual(0);

  // ── CONTRAST CASE: 1450x900 was ALREADY a fixed point before the fix, so this leg proves at-rest
  // stability was not bought by breaking a case that was already correct.
  await page.setViewportSize({ width: 1450, height: 900 });
  await page.waitForTimeout(1500);
  const fixedPoint = await geometryStates(page, 1500);
  expect(fixedPoint, "the already-stable 1450x900 case must stay stable").toHaveLength(1);
  expect(await clipPx(page), "no clipping at the already-stable viewport").toBeLessThanOrEqual(0);
});
