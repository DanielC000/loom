// Graphite kit (epic e25fa8a9, card 542f642f): the component kit restyled with tonal surfaces, status
// capsules and a cobalt accent, checked against the RUNNING app in BOTH themes.
//
// What this spec pins, each as an observable before/after state change rather than a render:
//   1. every Button variant (primary, default, ghost, danger) changes on hover, changes again on press,
//      and draws the cobalt --loom-ring on keyboard focus;
//   2. a Panel is a borderless tonal surface (no border, radius 12, padding 16, the theme's panel shadow),
//      and selecting it swaps to the --loom-selected fill with an inset --loom-accent-edge ring;
//   3. a Segmented option draws the --loom-ring on keyboard focus, and its chosen option is the raised
//      --loom-seg-on thumb.
// Every expected colour is resolved from the live token (helpers/themeToken.ts), never typed as a literal,
// so one assertion holds in both themes.
//
// Set LOOM_E2E_SHOTS to a directory to persist a screenshot of each checked state for review.
import path from "node:path";
import { expect, test, type Page } from "./fixtures/daemon";
import type { Locator } from "@playwright/test";
import { cssColor } from "./helpers/themeToken";

const shotDir = process.env.LOOM_E2E_SHOTS;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** Seed the theme. `dark` is what the default ("system") resolves to under the suite's emulated dark OS
 *  (playwright.config.ts), so only `light` is written: an init script re-runs on every navigation, and
 *  seeding the default would hide a regression in the default itself. */
async function useTheme(page: Page, theme: Theme) {
  if (theme === "light") await page.addInitScript(() => { try { localStorage.setItem("loom.theme", "light"); } catch { /* blocked */ } });
}

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function shot(page: Page, name: string) {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
}

/**
 * Hover → press → release, each read through `toHaveCSS` (which retries past the 140ms transition, so
 * every reading is a settled end state). The pointer is RELEASED OFF the button so no click fires: the
 * primary would open a form and the danger button would delete a column.
 */
async function hoverAndPress(page: Page, btn: Locator, expected: { rest: string; hover: string; press: string }) {
  await expect(btn).toHaveCSS("background-color", expected.rest);
  await btn.hover();
  await expect(btn).toHaveCSS("background-color", expected.hover);
  await page.mouse.down();
  await expect(btn).toHaveCSS("background-color", expected.press);
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60);
  await page.mouse.up();
  await expect(btn).toHaveCSS("background-color", expected.rest);
}

/**
 * Keyboard focus draws the 2px cobalt ring; it is read only while `:focus-visible` really matches. The
 * focus arrives by a REAL Shift+Tab / Tab round trip, because the press above already focused the button
 * by pointer, and Chromium does not treat a pointer-given or re-applied script focus as :focus-visible.
 */
async function expectRing(page: Page, el: Locator, offset: string) {
  await el.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(el).toBeFocused();
  expect(await el.evaluate((n) => n.matches(":focus-visible")), "keyboard focus matches :focus-visible").toBe(true);
  await expect(el).toHaveCSS("outline-style", "solid");
  await expect(el).toHaveCSS("outline-width", "2px");
  await expect(el).toHaveCSS("outline-offset", offset);
  await expect(el).toHaveCSS("outline-color", await cssColor(page, "--loom-ring"));
}

for (const theme of THEMES) {
  test(`kit Buttons hover, press and focus in ${theme}`, async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const project = await loomDaemon.createProject(`graphite-kit-btn-${theme}-${Date.now()}`);
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await useTheme(page, theme);
    await page.goto(loomDaemon.baseURL + "/settings");
    await expectTheme(page, theme);

    const transparent = "rgba(0, 0, 0, 0)";
    const [accent, accentHover, hover, pressed, btnBg, dangerSoft] = await Promise.all([
      cssColor(page, "--loom-accent"), cssColor(page, "--loom-accent-hover"), cssColor(page, "--loom-hover"),
      cssColor(page, "--loom-pressed"), cssColor(page, "--loom-btn-bg"), cssColor(page, "--loom-danger-soft"),
    ]);
    // The press fills are the exact expressions global.css's :active rules use.
    const primaryPress = await cssColor(page, "color-mix(in oklab, var(--loom-accent-hover) 70%, var(--loom-text-3))");
    const dangerPress = await cssColor(page, "color-mix(in oklab, var(--loom-danger-soft) 80%, var(--loom-danger))");

    // primary: the connections "New connection" button. A solid cobalt fill under an on-accent label (card 7d7ccee6).
    const primary = page.getByRole("button", { name: "New connection" });
    await expect(primary).toBeVisible();
    await expect(primary).toHaveCSS("color", await cssColor(page, "--loom-on-accent"));
    await hoverAndPress(page, primary, { rest: accent, hover: accentHover, press: primaryPress });
    await shot(page, `kit-button-primary-${theme}`);
    await expectRing(page, primary, "2px");

    // default: the session-env "Add variable" button — a filled control on a strong hairline.
    const addVar = page.getByTestId("senv-add");
    await expect(addVar).toBeVisible();
    await expect(addVar).toHaveCSS("border-top-color", await cssColor(page, "--loom-line-strong"));
    await hoverAndPress(page, addVar, { rest: btnBg, hover: hover, press: pressed });
    await addVar.hover();
    await expect(addVar).toHaveCSS("border-top-color", await cssColor(page, "--loom-line-hover"));
    await expectRing(page, addVar, "2px");

    // ghost: a session-env row's remove button (rendered once a row exists). Bare at rest.
    await addVar.click();
    const ghost = page.locator('[data-testid^="senv-remove-"]').first();
    await expect(ghost).toBeVisible();
    await hoverAndPress(page, ghost, { rest: transparent, hover, press: pressed });
    await expectRing(page, ghost, "2px");

    // danger: the board ColumnManager's per-column delete — a red outline that tints on hover.
    const danger = page.locator('button[title="Delete this column"]').first();
    await expect(danger).toBeVisible();
    await expect(danger).toHaveCSS("color", await cssColor(page, "--loom-danger-text"));
    await expect(danger).toHaveCSS("border-top-color", await cssColor(page, "--loom-danger-line"));
    await hoverAndPress(page, danger, { rest: transparent, hover: dangerSoft, press: dangerPress });
    await expectRing(page, danger, "2px");
    await shot(page, `kit-buttons-${theme}`);
  });

  test(`a Panel is a borderless tonal surface, and selecting it is a cobalt selection, in ${theme}`, async ({ page, loomDaemon }) => {
    test.setTimeout(60_000);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `KitPanelMgr-${theme}` });
    const title = `Graphite panel ${theme} ${Date.now()}`;
    const pick = `Keep it ${theme}`;
    const options = [pick, `Change it ${theme}`];
    const id = await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title, body: "Pick one.", options });
    await useTheme(page, theme);
    // The request's own deep link renders the same detail as the inbox modal.
    await page.goto(`${loomDaemon.baseURL}/question/${id}`);
    await expectTheme(page, theme);

    // Fixture identity: THIS spec's request, by its unique title.
    const dialog = page.locator("main");
    await expect(dialog.getByText(title)).toBeVisible();

    // The option Panel is the parent of its option text.
    const panel = dialog.getByText(pick, { exact: true }).locator("..");
    const chrome = () => panel.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, borderWidth: s.borderTopWidth, radius: s.borderTopLeftRadius, padding: s.paddingTop, shadow: s.boxShadow };
    });
    // The theme's own panel shadow, resolved through a probe so it is compared in the browser's notation.
    const panelShadow = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.boxShadow = "var(--loom-panel-shadow)";
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).boxShadow;
      probe.remove();
      return out;
    });
    const surface = await cssColor(page, "--loom-surface");
    const selectedFill = await cssColor(page, "--loom-selected");
    const accentEdge = await cssColor(page, "--loom-accent-edge");

    const rest = await chrome();
    expect(rest).toEqual({ bg: surface, borderWidth: "0px", radius: "12px", padding: "16px", shadow: panelShadow });
    // Dark elevation is tonal (no shadow at all); light is a hairline ring plus a short shadow.
    if (theme === "dark") expect(rest.shadow).toBe("none");
    else expect(rest.shadow).not.toBe("none");
    await shot(page, `kit-panel-rest-${theme}`);

    // Select it: an observable change of fill and ring, with the border still gone.
    await panel.click();
    await expect(panel).toHaveCSS("background-color", selectedFill);
    const selected = await chrome();
    expect(selected.borderWidth).toBe("0px");
    expect(selected.shadow).toContain("inset");
    expect(selected.shadow).toContain(accentEdge);
    expect(selected.bg).not.toBe(rest.bg);
    await shot(page, `kit-panel-selected-${theme}`);

    // Answer it, so no pending request outlives this spec on the shared daemon.
    await dialog.getByRole("button", { name: "Submit answer" }).click();
    await expect(dialog.getByText("Answered", { exact: true })).toBeVisible();
  });

  test(`a Segmented option rings on keyboard focus and raises its chosen thumb, in ${theme}`, async ({ page, loomDaemon }) => {
    test.setTimeout(60_000);
    const project = await loomDaemon.createProject(`graphite-kit-seg-${theme}-${Date.now()}`);
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await useTheme(page, theme);
    await page.goto(loomDaemon.baseURL + "/runs");
    await expectTheme(page, theme);

    const group = page.getByRole("radiogroup", { name: "Runs or Keys & Endpoints" });
    const segs = group.locator('button[role="radio"]');
    await expect(segs).toHaveCount(2);
    const [runs, keys] = [segs.nth(0), segs.nth(1)];
    const segOn = await cssColor(page, "--loom-seg-on");
    await expect(group).toHaveCSS("background-color", await cssColor(page, "--loom-surface-2"));
    await expect(runs).toHaveAttribute("aria-checked", "true");
    await expect(runs).toHaveCSS("background-color", segOn);
    await expect(keys).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    // Arrow onto "Keys": a real keyboard move that also selects, so the thumb moves with the ring.
    await runs.focus();
    await page.keyboard.press("ArrowRight");
    await expect(keys).toBeFocused();
    await expect(keys).toHaveAttribute("aria-checked", "true");
    await expect(keys).toHaveCSS("background-color", segOn);
    await expect(runs).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(keys).toHaveCSS("outline-color", await cssColor(page, "--loom-ring"));
    await expect(keys).toHaveCSS("outline-width", "2px");
    await expect(keys).toHaveCSS("outline-offset", "-2px");
    await shot(page, `kit-segmented-focus-${theme}`);
  });
}
