// Instrument Rail — collapsed logo alignment (fix: center the Loom logo in the collapsed rail).
//
// The rail is a 60px icon-only column at rest; every glyph below the brand (project sig, nav-item
// icons, footer icons) centers on the rail's mid-axis via the shared `.loom-rail-ico` box (width =
// --loom-rail-w, place-items:center). The brand logo mark used to sit ~4px LEFT of that axis (it lived
// in the brand row's padding, not centered), so collapsed it read as misaligned with the icon column.
// The fix mirrors the `.loom-rail-ico` centering onto `.loom-rail-mark` — but ONLY while collapsed, so
// the EXPANDED lockup (logo + "loom" wordmark, left-aligned) is unchanged.
//
// This spec measures glyph centers off the live DOM (sub-pixel, not a screenshot): collapsed, the logo
// must share the nav-icon column's center; expanded (pinned), the logo must revert to its left-biased
// flow position (left of that axis) with the wordmark revealed — proving the centering is collapsed-only.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const LOGO = ".loom-rail-mark svg";
const NAV_ICON = ".loom-rail-item .loom-rail-ico svg";

// Horizontal centers of the given selectors' first matches (null if absent), measured off the live DOM.
const centers = (page: Page, sels: string[]) =>
  page.evaluate(
    (list) =>
      list.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      }),
    sels,
  );

test.describe("Instrument Rail — collapsed logo centering", () => {
  test("collapsed logo aligns with the nav-icon column; expanded stays left-aligned", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/`);

    const rail = page.locator(".loom-rail");
    await expect(rail).toBeVisible();

    // COLLAPSED (default: unpinned, no hover). Measure the logo mark vs. the first nav-item icon.
    const [logoC, iconC] = await centers(page, [LOGO, NAV_ICON]);
    const railWidth = (await rail.boundingBox())!.width;

    expect(railWidth).toBeLessThan(120); // collapsed rail (~60px), not the expanded 236px
    expect(logoC).not.toBeNull();
    expect(iconC).not.toBeNull();
    // The fix: the logo now shares the nav-icon column's center axis (sub-pixel).
    expect(Math.abs((logoC as number) - (iconC as number))).toBeLessThanOrEqual(1);

    // EXPAND via the pin toggle. The wordmark reveals (opacity → 1) and the logo reverts to its
    // left-biased flow position — center LEFT of the icon axis — proving the centering is collapsed-only.
    await page.locator(".loom-rail-brand").click();
    await expect(page.locator(".loom-rail-wordmark")).toHaveCSS("opacity", "1");

    const [logoE, iconE] = await centers(page, [LOGO, NAV_ICON]);
    expect(logoE).not.toBeNull();
    expect(iconE).not.toBeNull();
    // Expanded logo sits left of the nav-icon axis (unchanged design), not centered on it.
    expect((logoE as number)).toBeLessThan((iconE as number) - 2);
  });
});
