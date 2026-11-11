// Kit `Segmented` keyboard focus ring (card 4249ae1c). `Segmented` (components/ui) renders a bare
// `<button role="radio">` with inline chrome and no `.loom-btn` class, so none of the `:focus-visible`
// rules in global.css reached it. The fix gives each segment `.loom-segment` and a rule carrying the
// same ring as every other control — at a NEGATIVE outline-offset, because the segments sit flush
// inside a track (rounded, and `overflow: hidden` before Graphite) that clipped anything painted
// outside their border box.
//
// Card 3f28f1c3 later moved Segmented from role="tablist"/"tab" to "radiogroup"/"radio" with a roving
// tabindex (one segment is ever a Tab stop); this spec's `tabOnto` helper below moves onto the sibling
// segment with ArrowRight rather than Tab for that reason — see its own comment.
//
// ⚠️ WHY THIS SPEC DOES NOT ASSERT "an outline is present". MEASURED on the pre-fix bundle: Chromium's
// own UA `:focus-visible` rule already applied here — `outline-style: auto`, `1px`, `rgb(16, 16, 16)`,
// `outline-offset: 0px`. So a presence check (`outlineStyle !== "none"`, or `:focus-visible` matching)
// comes back GREEN against the defect: the UA ring is there, it is just near-black on the dark theme
// AND painted outside the border box, where the track clips it away entirely. A screenshot of the
// pre-fix focused segment shows no ring at all. The two assertions below are therefore (a) the exact
// ring spec, and (b) `outlineOffset + outlineWidth <= 0`, i.e. the ring paints INSIDE the
// border box and so cannot be clipped by the track — which is the visibility claim, not a restatement
// of the CSS. Forcing the shared `+2px` offset inline on the pre-fix page rendered nothing visible.
//
// Selection is on `button[role="radio"]`, markup card 3f28f1c3 settled on — never on `.loom-segment` —
// so a full revert of the fix still reaches the discriminating assertion instead of dying earlier on a
// missing selector (see the project-memory note on weak negative controls for new testids).
//
// Card 95453b80 added the classic Companion mode toggle (`ModeToggle`) here; it was deleted with the classic
// shell by card acbb6df6 — the Atlas companion node's modes are the node's own link tab row, not a segmented
// track — so its leg went with it.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";
import { cssColor } from "./helpers/themeToken";

// The ring colour is `--loom-ring` (cobalt, Graphite card 542f642f), the one every other `:focus-visible`
// rule in global.css uses. It is resolved from the live token (`cssColor`) at the assertion, never typed
// as a literal.

interface Ring {
  style: string;
  width: string;
  color: string;
  offset: string;
  focusVisible: boolean;
}

function readRing(el: Locator): Promise<Ring> {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      style: s.outlineStyle,
      width: s.outlineWidth,
      color: s.outlineColor,
      offset: s.outlineOffset,
      focusVisible: node.matches(":focus-visible"),
    };
  });
}

/**
 * Move onto `target` for real: focus its sibling segment programmatically, then press an arrow key — the
 * roving-tabindex radiogroup's own move-and-select key, not Tab (only the active segment is ever a Tab
 * stop since card 3f28f1c3). The keypress is a genuine keyboard interaction, so Chromium's
 * `:focus-visible` heuristic fires exactly as it does for a user arrowing through the group — and unlike
 * a blind Tab walk from `<body>` (measured at 18 hops to the first segment on /settings) it does not
 * depend on how many focusables precede the control.
 *
 * `key` defaults to ArrowRight (move onto the NEXT segment); pass "ArrowLeft" to move onto the PREVIOUS
 * one instead. Arrowing onto a segment also SELECTS it, so a call site that must not change state arrows
 * onto the segment that is ALREADY active — re-selecting the same value is a no-op for `onChange`'s caller —
 * which proves the ring on a real keyboard focus with nothing re-rendering underneath.
 */
async function tabOnto(page: Page, from: Locator, target: Locator, key: "ArrowRight" | "ArrowLeft" = "ArrowRight"): Promise<Ring> {
  await from.evaluate((n: HTMLElement) => n.focus());
  await page.keyboard.press(key);
  await expect(target).toBeFocused();
  return readRing(target);
}

async function expectFocusRing(page: Page, ring: Ring, where: string) {
  expect(ring.focusVisible, `${where}: the segment should match :focus-visible after Tab`).toBe(true);
  const ringColor = await cssColor(page, "--loom-ring");
  expect(ring, where).toMatchObject({ style: "solid", width: "2px", color: ringColor, offset: "-2px" });
  // The ring's outer edge relative to the border box. <= 0 means it paints inside the segment, so the
  // track's `overflow: hidden` cannot clip it. The pre-fix UA ring (offset 0px + width 1px) is > 0.
  const outerEdge = parseFloat(ring.offset) + parseFloat(ring.width);
  expect(outerEdge, `${where}: the ring must paint inside the border box, not outside the clipping track`)
    .toBeLessThanOrEqual(0);
}

/**
 * The mouse half. Deliberately NOT discriminating against the pre-fix bundle — a pre-fix mouse click
 * showed no ring either. It guards the SHAPE of the fix: a ring hung off `:focus` instead of
 * `:focus-visible` would turn this red. Clicks the already-active segment so no panel swaps underneath.
 */
async function expectNoRingOnMouseClick(active: Locator, where: string) {
  await active.click();
  await expect(active).toBeFocused();
  const ring = await readRing(active);
  expect(ring.focusVisible, `${where}: a mouse click must not match :focus-visible`).toBe(false);
  expect(ring.style, `${where}: a mouse click must draw no ring`).toBe("none");
}

// The Settings leg was the Interface (Atlas/classic) switch until card acbb6df6 deleted it with the classic
// shell; the theme switch is the same Segmented kit control on the same Settings surface (the Workspace
// node's tab), so the claim moves to it rather than being dropped.
test("Settings' theme switch rings on keyboard focus and stays clean on click", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  // Pinned to Dark, so the ACTIVE segment is known (the last of System | Light | Dark) and every move below
  // can land on it: re-selecting the active segment is a no-op, so nothing re-renders under a focus call.
  await page.addInitScript(() => localStorage.setItem("loom.theme", "dark"));
  await page.goto(loomDaemon.baseURL + "/home?tab=settings");

  const tabs = page.locator('[data-testid="theme-switch"] button[role="radio"]');
  await expect(tabs).toHaveCount(3);
  const light = tabs.nth(1);
  const dark = tabs.nth(2);
  await expect(dark).toHaveAttribute("aria-checked", "true");

  // Mouse check FIRST, while nothing in the group is focused yet: clicking the active "Dark" is a genuine
  // focus TRANSITION (none → dark) that changes nothing. Doing it after the keyboard check would click the
  // segment the keyboard just focused — not a transition, so `:focus-visible` would stay true from the
  // keyboard and this check would wrongly fail.
  await expectNoRingOnMouseClick(dark, "settings/theme-switch");

  // Arrow from "Light" (focused programmatically, never selected) onto the already-active "Dark".
  await expectFocusRing(page, await tabOnto(page, light, dark, "ArrowRight"), "settings/theme-switch");
});

test("the Runs and Actors switches ring on keyboard focus and stay clean on click", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const project = await loomDaemon.createProject(`seg-focus-pages-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);

  // ── Runs: Runs | Keys & Endpoints (project-scoped, so it needs the project above).
  await page.goto(loomDaemon.baseURL + "/runs");
  const runsTabs = page.getByRole("radiogroup", { name: "Runs or Keys & Endpoints" }).locator('button[role="radio"]');
  await expect(runsTabs).toHaveCount(2);
  await expectFocusRing(page, await tabOnto(page, runsTabs.nth(0), runsTabs.nth(1)), "runs");
  await expectNoRingOnMouseClick(runsTabs.nth(0), "runs");

  // ── Actors: Profiles | Skills.
  await page.goto(loomDaemon.baseURL + "/actors");
  const actorsTabs = page.getByRole("radiogroup", { name: "Actors — Profiles or Skills" }).locator('button[role="radio"]');
  await expect(actorsTabs).toHaveCount(2);
  await expectFocusRing(page, await tabOnto(page, actorsTabs.nth(0), actorsTabs.nth(1)), "actors");
  await expectNoRingOnMouseClick(actorsTabs.nth(0), "actors");
});
