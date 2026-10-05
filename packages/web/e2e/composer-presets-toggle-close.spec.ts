// Card b6896a96 — the composer's preset ("Spark") popover must be collapsible from its own trigger.
//
// The popover is a deliberate full-bleed overlay of the composer textarea (`position:absolute;
// left/right/bottom:0; z-index:30`) and its trigger lives in a SECOND absolutely-positioned cluster
// pinned to the same bottom-right corner. That cluster carried no z-index of its own, so the popover
// painted over it and swallowed every pointer event at the trigger: `aria-expanded` stayed "true"
// through a real click, and the expand button beside it (whose own handler closes the popover first)
// was dead too. Escape and outside-click worked, but neither is the affordance `aria-expanded` names.
// See docs/decisions/b6896a96-presets-trigger-above-overlay.md.
//
// SHAPE OF THE CONTROL. This spec adds NO markup and selects on NO new testid — the trigger, its
// `aria-expanded`, `role="dialog"` and the preset row all predate the fix — so reverting the fix (the
// cluster's `zIndex` alone suffices) reds on BEHAVIOUR rather than on a missing selector.
//   ⭐ The close is driven by `page.mouse.click` at the trigger's own centre, deliberately NOT
//   `locator.click()`. A plain locator click would fail pre-fix at the actionability check ("element
//   intercepts pointer events") — a red at the ACTION, before the mechanism is ever exercised.
//   `page.mouse.click` always dispatches at the coordinate and lands on whatever is topmost, so pre-fix
//   the red lands on the `aria-expanded` assertion with the popover still open: exactly the state card
//   b6896a96 measured by hand. Assertion ORDER follows from that — the behavioural close is asserted
//   FIRST, and the layout/style facts that merely explain it come after, on a reopened popover.
//
// Why /platform: it is where a composer is reachable with a CANNED pty (no real claude is ever spawned),
// the same rig composer-preset-insert.spec.ts and button-hover-states.spec.ts use.
import { expect, test } from "./fixtures/daemon";
import type { Locator } from "@playwright/test";

const LABEL = "E2E · toggle the presets popover";
const PROMPT = "E2E-TOGGLE-PRESET: nothing is ever sent from this spec.";

/**
 * Is this element the one a real pointer at its own centre would land on? `true` when `elementFromPoint`
 * returns it or a descendant (the trigger's own `<svg>` counts). Viewport-relative, so the element must
 * already be scrolled in — `null` out there means "off-screen", NOT "covered".
 */
function isTopmostAtCentre(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === node || node.contains(top);
  });
}

test("the presets popover closes from its own trigger, and Escape / outside-click still work", async ({ page, loomDaemon }) => {
  // Six open/close round trips on a page that mounts a terminal; comfortably above the 30s default.
  test.setTimeout(120_000);

  // Hermetic seed, same recipe as button-hover-states.spec.ts: one global preset (so the popover renders
  // a real row) plus the reserved Platform operator session as a CANNED pty.
  const created = await (await fetch(`${loomDaemon.baseURL}/api/preset-prompts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, prompt: PROMPT }),
  })).json();
  expect(created.id, "the preset should be created").toBeTruthy();

  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();
  await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 120, rows: 40 },
    ptyBytes: "LOOM-PRESET-TOGGLE\r\ntoggle the presets popover from its own trigger\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(700); // let the height-budget measure + font scale settle before interacting

  const trigger = page.getByRole("button", { name: "Preset prompts" }).first();
  const dialog = page.getByRole("dialog", { name: "Preset prompts" });
  await expect(trigger).toBeVisible();
  // The platform tile is taller than the 1280x720 viewport, so the composer's corner cluster starts BELOW
  // the fold and every `elementFromPoint` answer out there would be a null that means "off-screen". A
  // plain DOM scroll, NOT `scrollIntoViewIfNeeded()` — that is an action and runs the actionability
  // stability check the terminal's endless sub-pixel font settle never satisfies.
  await trigger.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // ── 1. OPEN via the trigger. `force` bypasses only the stability check; the closed trigger is proven
  // pointer-reachable first, so this is not papering over a cover.
  expect(await isTopmostAtCentre(trigger), "the closed trigger should be pointer-reachable").toBe(true);
  await trigger.click({ force: true });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("button", { name: `Edit ${LABEL}` })).toBeVisible();

  // ── 2. THE DEFECT, asserted before anything that explains it: a real pointer click at the trigger's
  // own centre collapses it. Pre-fix this click landed on the popover — which also `stopPropagation`s its
  // own clicks — and `aria-expanded` stayed "true" with the dialog still up.
  const openBox = await trigger.boundingBox();
  expect(openBox, "the open trigger should have a layout box").toBeTruthy();
  await page.mouse.click(openBox!.x + openBox!.width / 2, openBox!.y + openBox!.height / 2);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeHidden();

  // ── 3. The layout fact underneath it, on a REOPENED popover. button-hover-states.spec.ts used to pin
  // the inverse of this ("the open popover is expected to cover its own trigger") as a measured fact;
  // that assertion was flipped by this card.
  await trigger.click({ force: true });
  await expect(dialog).toBeVisible();
  expect(await isTopmostAtCentre(trigger), "the open popover must NOT cover its own trigger").toBe(true);

  // Park the pointer OFF the trigger before reading its open REST appearance: the click above left the
  // pointer sitting on it, so an immediate reading is its HOVER value presented as rest (measured —
  // rgba(46, 230, 110, 0.28) where rest is 0.15). The dialog's top-left corner is the inert "Preset
  // prompts" section label. ⛔ Never park at a viewport corner: that expands the collapsed nav rail,
  // which then intercepts pointer events and times out the next hover.
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox, "the popover should have a layout box").toBeTruthy();
  await page.mouse.move(dialogBox!.x + 4, dialogBox!.y + 4);

  // Consequence: `.loom-btn-on`'s own hover rule is reachable by a real pointer while the popover is up,
  // which it provably was not before (global.css `.loom-btn-on:not(:disabled):hover` → 0.28 fill). The
  // open REST appearance is unchanged — `--loom-phosphor-dim` is rgba(46, 230, 110, 0.15).
  await expect(trigger).toHaveClass(/\bloom-btn-on\b/);
  await expect(trigger).toHaveCSS("background-color", "rgba(46, 230, 110, 0.15)");
  await trigger.hover({ force: true });
  await expect(trigger).toHaveCSS("background-color", "rgba(46, 230, 110, 0.28)");

  // ── 4. The panel RESERVES that corner rather than just losing it: its bottom padding must cover the
  // distance from its own bottom edge up past the trigger's top, so a row scrolled to the end of the
  // list rests clear of the floating icons instead of under them. Pinning the reserve itself, not a
  // row's box — with a single preset the content sits at the top of the flex column, so comparing the
  // row would pass vacuously whatever the padding were.
  const panel = await dialog.evaluate((node) => ({
    paddingBottom: parseFloat(getComputedStyle(node).paddingBottom),
    bottom: node.getBoundingClientRect().bottom,
  }));
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox, "the trigger should have a layout box").toBeTruthy();
  expect(panel.paddingBottom, "the panel's bottom padding must clear the corner cluster")
    .toBeGreaterThanOrEqual(panel.bottom - triggerBox!.y);

  // ── 5. Escape still closes (DoD 1 — the fix is not allowed to trade one dismissal for another).
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeHidden();

  // ── 6. Outside-click still closes (DoD 1). The dismiss point is DERIVED from the `useDismissable`
  // wrapper's own box and then PROVEN to land outside it via `elementFromPoint`, rather than trusting a
  // hand-picked element to be both outside the wrapper and inert. 8px below the wrapper is the composer's
  // collapsed status line / card padding.
  await trigger.click({ force: true });
  await expect(dialog).toBeVisible();
  const outside = await trigger.evaluate((node) => {
    // The wrapper is the nearest ancestor holding BOTH the trigger cluster and the popover.
    let wrap: HTMLElement | null = node.parentElement;
    const POPOVER = "[role='dialog'][aria-label='Preset prompts']";
    while (wrap && !wrap.querySelector(POPOVER)) wrap = wrap.parentElement;
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    const point = { x: r.left + 24, y: r.bottom + 8 };
    const hit = document.elementFromPoint(point.x, point.y);
    return { ...point, outsideWrapper: !!hit && !wrap.contains(hit), hitTag: hit ? hit.tagName : null };
  });
  expect(outside, "the useDismissable wrapper should be locatable from the trigger").toBeTruthy();
  expect(outside!.outsideWrapper,
    `the derived dismiss point must land outside the wrapper (hit <${outside!.hitTag}>)`).toBe(true);
  await page.mouse.click(outside!.x, outside!.y);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeHidden();
});
