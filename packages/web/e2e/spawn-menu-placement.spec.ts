// SpawnControls spawn-role menu PLACEMENT (card 74915cad). The panel is wider than the ~110px split
// button it hangs off, and it used to anchor `right: 0` — so it grew LEFTWARD, out of its card. On
// Overview's first agent card at 1280px its left edge measured x≈1, underneath the fixed 60px instrument
// rail (`.loom-rail`, z-index 40, which beats this panel's 20): `elementFromPoint` at the panel's own left
// edge returned `SPAN.loom-rail-ico`, and the first ~8 characters of every label were unreadable.
// Separately, "From profile (default)" wrapped to two lines inside `minWidth: 170`.
//
// This file is about GEOMETRY, which is why it is not in button-hover-states.spec.ts (that spec owns the
// same component's computed-style hover behaviour). The two assertions here are deliberately split so each
// lands on ONE mechanism, and each has its own single-property control — see §CONTROLS at the bottom.
//
// Why /overview: AgentControl is the only SpawnControls call site, and an agent with NO live session
// renders no terminal tile, so the page stays light (see CLAUDE.md on the cockpit renderer).
import { expect, test, type LoomDaemon } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";

/** The rail's collapsed width — `--loom-rail-w` in styles/global.css. Read from the live rail, not pinned
 *  here, so a change to that token can never leave this spec asserting against a stale number. */
async function collapsedRailWidth(page: Page): Promise<number> {
  const rail = page.locator(".loom-rail");
  await expect(rail).toHaveCount(1);
  const box = await rail.boundingBox();
  expect(box, "the instrument rail should have a layout box").toBeTruthy();
  return box!.width;
}

/**
 * What a real pointer at `(box.left + inset, vertical centre)` would land on, as a coarse tag so a failure
 * message names the occluder rather than just "false".
 *
 * ⚠️ `elementFromPoint` returns null for a point OUTSIDE the viewport, which is a DIFFERENT fact from "some
 * element covers it" — two facts, one return value. This reports them apart (`"<out-of-viewport>"`) so an
 * off-screen panel can never read as an occluded one.
 */
function hitTestAtLeftEdge(el: Locator, inset: number): Promise<string> {
  return el.evaluate((node, px) => {
    const r = node.getBoundingClientRect();
    const x = r.left + px;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return `<out-of-viewport x=${Math.round(x)} y=${Math.round(y)} vw=${window.innerWidth} vh=${window.innerHeight}>`;
    }
    const top = document.elementFromPoint(x, y);
    if (!top) return "<null>";
    if (top === node || node.contains(top)) return "<the menu>";
    return `${top.tagName}.${Array.from(top.classList).join(".")}`;
  }, inset);
}

/** Open the spawn-role menu on a fresh single-agent project, and hand back the panel + its items. */
async function openSpawnMenu(page: Page, loomDaemon: LoomDaemon, slug: string) {
  const project = await loomDaemon.createProject(`${slug}-${Date.now()}`);
  const agent = await (await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Placement Probe" }),
  })).json();
  expect(agent.id, "the probe agent should be created").toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
  await page.goto(loomDaemon.baseURL + "/overview"); // `/` is Mission Control; the spawn cards are Overview's

  // FIXTURE IDENTITY: exactly one spawn card, and it is the agent this test created — so the panel measured
  // below belongs to this project and not to whatever a sibling spec left on the shared daemon.
  await expect(page.getByText("Placement Probe", { exact: true })).toBeVisible();
  const menuTrigger = page.locator('button[title="Override the spawn role"]');
  await expect(menuTrigger).toHaveCount(1);
  await menuTrigger.click();

  const menu = page.getByTestId("spawn-role-menu");
  await expect(menu).toHaveCount(1);
  const items = menu.locator("button.loom-btn-ghost");
  await expect(items).toHaveCount(3);
  return { menu, items };
}

test("the spawn-role menu opens clear of the instrument rail and inside the viewport", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  const { menu } = await openSpawnMenu(page, loomDaemon, "spawn-menu-rail");

  // The rail must be COLLAPSED for this measurement to mean anything: it expands to `--loom-rail-open`
  // (236px) on `:hover`/`:focus-within`, which would occlude a panel that is genuinely clear of the 60px
  // collapsed rail. Nothing in this test moves the pointer (`elementFromPoint` is a DOM query, not a
  // pointer action) and the trigger click left it on the ▾ inside the card — but assert the premise rather
  // than hoping, since a silently-expanded rail would make the hit-test below fail for the wrong reason.
  const railWidth = await collapsedRailWidth(page);
  expect(railWidth, "the rail must be collapsed (--loom-rail-w), not expanded, while the panel is measured")
    .toBeLessThan(120);

  const box = await menu.boundingBox();
  expect(box, "the open menu should have a layout box").toBeTruthy();

  // (1) THE MECHANISM, as GEOMETRY: the panel's box must not overlap the rail's box at all.
  //
  // ⚠️ Asserted this way, and FIRST, on purpose. How far left the pre-fix panel landed depended on the
  // width of the "Spawn" button it hung off — which varies with the agent's profile role ("Spawn" vs
  // "Spawn · manager"). The card was filed off a real board measuring x≈1.03, i.e. INSIDE the rail's
  // 0–60px band; this fixture's role-less agent gives the narrowest possible button, so the same defect
  // puts the panel at x≈-9, PAST the viewport's left edge. Both are "grew leftward out of the card", and a
  // non-overlap assertion reddens on both. A hit-test alone does not: at x≈-9 `elementFromPoint` is
  // outside the viewport and returns null, which is a different fact from "the rail covers it".
  const railBox = await page.locator(".loom-rail").boundingBox();
  expect(railBox, "the instrument rail should have a layout box").toBeTruthy();
  expect(box!.x, `the menu (x=${box!.x}) must start right of the ${railWidth}px rail, not under or past it`)
    .toBeGreaterThanOrEqual(railBox!.x + railBox!.width);

  // (2) Reachability, as the corroborating check the card names: a real pointer at the panel's own left
  // edge — and 58px in, roughly where the 8 swallowed characters of the longest label sat — must land on
  // the panel. The helper names whatever IS in the way (an occluding element, or the axis on which the
  // point fell outside the viewport), so a failure here is self-diagnosing rather than a bare `false`.
  expect(await hitTestAtLeftEdge(menu, 2), "the menu's left edge must not be under the instrument rail")
    .toBe("<the menu>");
  expect(await hitTestAtLeftEdge(menu, 58), "the first ~8 characters of each label must be reachable")
    .toBe("<the menu>");

  // (3) …and growing rightward must not have traded one clip for another.
  const viewport = page.viewportSize();
  expect(viewport, "the test needs a fixed viewport to bound against").toBeTruthy();
  expect(box!.x + box!.width, "the menu must not overflow the right edge of the viewport")
    .toBeLessThanOrEqual(viewport!.width);
});

test("the spawn-role menu sizes to its longest label instead of wrapping it", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  const { items } = await openSpawnMenu(page, loomDaemon, "spawn-menu-wrap");

  // Height, not width: `whiteSpace: nowrap` makes the panel size to its longest label, so the ONE
  // user-visible consequence is that all three items occupy a single line each. Pre-fix, "From profile
  // (default)" wrapped inside `minWidth: 170` and was measurably TALLER than its two short siblings.
  // Comparing the long item to a short one is font-metric-independent — it pins no px value that a font or
  // padding change could rot.
  const long = items.filter({ hasText: "From profile (default)" });
  const short = items.filter({ hasText: "Manager" });
  await expect(long).toHaveCount(1);
  await expect(short).toHaveCount(1);
  const longBox = await long.boundingBox();
  const shortBox = await short.boundingBox();
  expect(longBox && shortBox, "both items should have layout boxes").toBeTruthy();
  expect(longBox!.height, "'From profile (default)' must occupy one line, like its short siblings")
    .toBeCloseTo(shortBox!.height, 1);

  // Belt and braces, and the sharper form: the label's own text renders as a SINGLE line box. A `Range`
  // over the text node yields one client rect per visual line, so this reads 2 on a wrapped label whatever
  // the surrounding box heights happen to do.
  const lineCount = await long.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects().length;
  });
  expect(lineCount, "the longest label must render as one line box").toBe(1);
});

test("a menu item still spawns with its own role override, and never reaches the daemon", async ({ page, loomDaemon }) => {
  test.setTimeout(60_000);
  const { menu, items } = await openSpawnMenu(page, loomDaemon, "spawn-menu-click");

  // A placement spec that never clicks would not notice a panel repositioned out of the click's way, so
  // exercise the control and assert an observable. What the click must NOT do is reach the daemon:
  // `createProject` git-inits and binds a REAL repo, so `POST /api/agents/:id/sessions` here is a genuinely
  // spawnable session and would trip the fixture's own no-spawn guard (`[pty] spawn`) at teardown — the
  // metered-spawn accident this harness exists to prevent (project memory
  // e2e-createproject-binds-a-real-repo-spawn-hazard). Intercepting it is also the sharper assertion: it
  // pins the ROLE the item sends, which no amount of watching the panel close could show.
  let spawnBody: unknown = null;
  await page.route(
    (url) => /\/api\/agents\/[^/]+\/sessions$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      spawnBody = route.request().postDataJSON();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e: spawn suppressed" }) });
    },
  );
  const manager = items.filter({ hasText: "Manager" });
  expect(await isTopmostAtCentre(manager), "the 'Manager' item should be pointer-reachable").toBe(true);
  await manager.click();
  await expect(menu).toHaveCount(0);
  expect(spawnBody, "the 'Manager' item must send role:manager, not the profile default").toEqual({ role: "manager" });
});

/**
 * Is this element the one a real pointer at its own centre would land on? Mirrors the helper in
 * button-hover-states.spec.ts; kept local so neither spec has to export to the other.
 */
function isTopmostAtCentre(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === node || node.contains(top);
  });
}

// §CONTROLS — measured 2026-10-06, each defeating ONE property and leaving the rest of the change in place.
// A FULL revert is a WEAK control here: it also removes `data-testid="spawn-role-menu"`, so every test above
// reddens at `expect(menu).toHaveCount(1)` in the shared `openSpawnMenu` precondition — a tautological red
// that never reaches either mechanism (project memory full-revert-is-a-weak-control-for-a-new-testid).
// Both of these were run; results are in the card's done-report:
//   • `left: 0` → `right: 0` in SpawnControls.tsx reddens test 1 ONLY, at the hit-test on the mechanism
//     (`SPAN.loom-rail-ico`), with test 2's wrap assertions still green.
//   • dropping `whiteSpace: "nowrap"` reddens test 2 ONLY, at the one-line-box assertion, with test 1 green.
