// Kit `Segmented` keyboard focus ring (card 4249ae1c). `Segmented` (components/ui) renders a bare
// `<button role="tab">` with inline chrome and no `.loom-btn` class, so none of the `:focus-visible`
// rules in global.css reached it. The fix gives each segment `.loom-segment` and a rule carrying the
// same phosphor ring as every other control — at a NEGATIVE outline-offset, because the segments sit
// flush inside a rounded `overflow: hidden` track that clips anything painted outside their border box.
//
// ⚠️ WHY THIS SPEC DOES NOT ASSERT "an outline is present". MEASURED on the pre-fix bundle: Chromium's
// own UA `:focus-visible` rule already applied here — `outline-style: auto`, `1px`, `rgb(16, 16, 16)`,
// `outline-offset: 0px`. So a presence check (`outlineStyle !== "none"`, or `:focus-visible` matching)
// comes back GREEN against the defect: the UA ring is there, it is just near-black on the dark theme
// AND painted outside the border box, where the track clips it away entirely. A screenshot of the
// pre-fix focused segment shows no ring at all. The two assertions below are therefore (a) the exact
// phosphor ring spec, and (b) `outlineOffset + outlineWidth <= 0`, i.e. the ring paints INSIDE the
// border box and so cannot be clipped by the track — which is the visibility claim, not a restatement
// of the CSS. Forcing the shared `+2px` offset inline on the pre-fix page rendered nothing visible.
//
// Selection is on `button[role="tab"]`, markup that predates this card — never on `.loom-segment` —
// so a full revert of the fix still reaches the discriminating assertion instead of dying earlier on a
// missing selector (see the project-memory note on weak negative controls for new testids).
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";

/** `--loom-phosphor`, the one ring colour every other `:focus-visible` rule in global.css uses. */
const PHOSPHOR = "rgb(46, 230, 110)";

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
 * Tab onto `target` for real: focus its sibling segment programmatically, then press Tab. The keypress
 * is a genuine keyboard interaction, so Chromium's `:focus-visible` heuristic fires exactly as it does
 * for a user tabbing through the page — and unlike a blind Tab walk from `<body>` (measured at 18 hops
 * to the first segment on /settings) it does not depend on how many focusables precede the control.
 */
async function tabOnto(page: Page, from: Locator, target: Locator): Promise<Ring> {
  await from.evaluate((n: HTMLElement) => n.focus());
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  return readRing(target);
}

function expectPhosphorRing(ring: Ring, where: string) {
  expect(ring.focusVisible, `${where}: the segment should match :focus-visible after Tab`).toBe(true);
  expect(ring, where).toMatchObject({ style: "solid", width: "2px", color: PHOSPHOR, offset: "-2px" });
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

test("Settings' Interface switch rings on Tab and stays clean on click", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const project = await loomDaemon.createProject(`seg-focus-settings-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
  await page.goto(loomDaemon.baseURL + "/settings");

  const tabs = page.locator('[data-testid="atlas-ui-switch"] button[role="tab"]');
  await expect(tabs).toHaveCount(2);
  const classic = tabs.nth(0);
  const atlas = tabs.nth(1);

  expectPhosphorRing(await tabOnto(page, classic, atlas), "settings/atlas-ui-switch");

  // "Classic" is the active side here, so clicking it cannot swap the shell out from under the test.
  await expectNoRingOnMouseClick(classic, "settings/atlas-ui-switch");
});

test("the Runs and Actors switches ring on Tab and stay clean on click", async ({ page, loomDaemon }) => {
  test.setTimeout(120_000);
  const project = await loomDaemon.createProject(`seg-focus-pages-${Date.now()}`);
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);

  // ── Runs: Runs | Keys & Endpoints (project-scoped, so it needs the project above).
  await page.goto(loomDaemon.baseURL + "/runs");
  const runsTabs = page.getByRole("tablist", { name: "Runs or Keys & Endpoints" }).locator('button[role="tab"]');
  await expect(runsTabs).toHaveCount(2);
  expectPhosphorRing(await tabOnto(page, runsTabs.nth(0), runsTabs.nth(1)), "runs");
  await expectNoRingOnMouseClick(runsTabs.nth(0), "runs");

  // ── Actors: Profiles | Skills.
  await page.goto(loomDaemon.baseURL + "/actors");
  const actorsTabs = page.getByRole("tablist", { name: "Actors — Profiles or Skills" }).locator('button[role="tab"]');
  await expect(actorsTabs).toHaveCount(2);
  expectPhosphorRing(await tabOnto(page, actorsTabs.nth(0), actorsTabs.nth(1)), "actors");
  await expectNoRingOnMouseClick(actorsTabs.nth(0), "actors");
});
