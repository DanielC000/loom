// Atlas accent restore (card 7d7ccee6, owner decision 719d954c): Direction C's semantic map kept, A's
// cobalt brand restored, the Loom mark green again, plus five small accent additions. Checked against the
// RUNNING app in BOTH themes.
//
// What this spec pins:
//   1. the accent is a real hue, not ink: --loom-accent paints with blue well above red (C's ink accent
//      paints r ≈ g ≈ b, so this assertion fails on the pre-restore tokens);
//   2. the Loom mark in the Atlas tree is --loom-live (green), not the accent;
//   3. addition 1: a band heading carries a --loom-accent bar (its ::before);
//   4. addition 2: a band jump link (.loom-btn-default.loom-bandlink) reads in --loom-accent-fg;
//   5. addition 3: the selected Atlas tree node has a 2px --loom-accent inset edge;
//   6. addition 4: empty-band copy opens with an --loom-accent-fg glyph (its ::before);
//   7. addition 5: the active node tab's label is --loom-accent-fg.
// Every expected colour is resolved from the live token (helpers/themeToken.ts), never typed as a literal.
import { expect, test, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

// lib/activeProject.tsx owns the project key.
// Hardcoded because the e2e tsconfig covers `e2e/` only, so a spec cannot import a `src/` module.
const PROJECT_KEY = "loom.projectId";
const THEMES = ["dark", "light"] as const;

/** A CSS colour painted to a canvas and read back as sRGB, so a hue check works whatever notation the
 *  browser keeps the computed value in (Chromium keeps OKLCH tokens as `oklch(...)`). */
function paintedRgb(page: Page, value: string): Promise<[number, number, number]> {
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = resolved;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, value);
}

function pseudo(page: Page, selector: string, prop: string): Promise<string> {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el, "::before").getPropertyValue(p), prop);
}

for (const theme of THEMES) {
  test(`Atlas accents: cobalt brand, green mark and the five additions, in ${theme}`, async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(`atlas-accents-${theme}-${Date.now()}`);
    await page.addInitScript((a: { projectKey: string; id: string; t: string }) => {
      localStorage.setItem(a.projectKey, a.id);
      localStorage.setItem("loom.theme", a.t);
    }, { projectKey: PROJECT_KEY, id: project.id, t: theme });

    // ── Workspace home: the brand hue, the mark, the selected tree node and the active tab. ──
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("atlas-tree")).toBeVisible();

    const [r, g, b] = await paintedRgb(page, "var(--loom-accent)");
    expect(b - r, `--loom-accent is a cobalt hue, not ink (painted rgb ${r},${g},${b})`).toBeGreaterThan(60);

    const mark = page.getByTestId("atlas-tree").locator('svg:has(> path[d^="M8 4 V13.2"])').first();
    await expect(mark).toHaveCSS("color", await cssColor(page, "--loom-live"));

    const home = page.getByTestId("atlas-home-workspace");
    await expect(home).toHaveClass(/\bis-active\b/);
    await expect(home).toHaveCSS("box-shadow", `${await cssColor(page, "--loom-accent")} 2px 0px 0px 0px inset`);

    const activeTab = page.locator(".loom-navtab.is-active").first();
    await expect(activeTab).toHaveCSS("color", await cssColor(page, "--loom-accent-fg"));

    // ── Project overview: a band heading's bar, its jump link and the empty-band glyph. ──
    await page.goto(loomDaemon.baseURL + "/project");
    const roster = page.getByTestId("atlas-overview-roster");
    await expect(roster.getByTestId("atlas-overview-empty")).toBeVisible();

    expect(await pseudo(page, '[data-testid="atlas-overview-roster"] .loom-bandhead', "background-color"))
      .toBe(await cssColor(page, "--loom-accent"));
    await expect(roster.locator(".loom-btn-default.loom-bandlink").first()).toHaveCSS("color", await cssColor(page, "--loom-accent-fg"));

    const empty = '[data-testid="atlas-overview-roster"] .loom-bandempty';
    expect(await pseudo(page, empty, "color")).toBe(await cssColor(page, "--loom-accent-fg"));
    expect(await pseudo(page, empty, "content")).toContain("◇");
  });
}
