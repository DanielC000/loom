// Card fa8a2887 (Atlas audit A-30): a "Skip to content" link, and the Atlas tree as ONE Tab stop with the
// tree-view arrow keys. Before it, reaching the page took 3 Tab presses per project (twist, row, `＋`).
//
// Every movement claim is read off `document.activeElement` after a REAL key press, and every
// expand/collapse claim off the twist's own `aria-expanded` plus the child row actually rendering, so a
// handler that only moved a class (or only flipped state nobody draws) fails here.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/activeProject.tsx owns the project key.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try {
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable — assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** ALPHA (pinned) runs a manager with one worker, so its branch is two levels deep; BRAVO is idle and
 *  exists so the tree holds more than one project row. Distinct agent names and id prefixes, so two
 *  rows can never be confused for each other. */
async function seed(loomDaemon: LoomDaemon) {
  const alpha = await loomDaemon.createProject(uniq("kbd-alpha"));
  const bravo = await loomDaemon.createProject(uniq("kbd-bravo"));
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mgr = await loomDaemon.seedLiveSession({
    project: alpha, role: "manager", agentName: `KbdMgr-${stamp}`, id: `e2e-kbdmgr-${stamp}`,
  });
  const worker = await loomDaemon.seedLiveSession({
    project: alpha, role: "worker", agentName: `KbdWorker-${stamp}`, id: `e2e-kbdwrk-${stamp}`,
    parentSessionId: mgr.sessionId, branch: "loom/atlas-tree-keyboard",
  });
  return { alpha, bravo, mgr, worker };
}

const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

/** Press Tab from the document until `pred` holds for the focused element, counting presses. */
async function tabUntil(page: Page, pred: () => boolean, max = 40): Promise<number> {
  for (let n = 1; n <= max; n++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(pred)) return n;
  }
  return -1;
}

async function ringOf(page: Page) {
  return page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
}

test.describe("Atlas keyboard: skip link + tree roving focus (card fa8a2887)", () => {
  test("the skip link is the first stop, shows on focus, and moves focus to the page", async ({ page, loomDaemon }) => {
    const { alpha } = await seed(loomDaemon);
    await pinProject(page, alpha.id);
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();

    const skip = page.getByTestId("atlas-skip-link");
    // Hidden at rest: off the top of the viewport, never a painted chip over the tree's head.
    const rest = await skip.boundingBox();
    expect(rest, "the skip link is not in the DOM").not.toBeNull();
    expect(rest!.y + rest!.height, "the skip link is visible before anything focused it").toBeLessThanOrEqual(0);

    await page.keyboard.press("Tab");
    await expect(skip, "the skip link is not the shell's first Tab stop").toBeFocused();
    await expect(skip).toHaveText("Skip to content");
    // Shown on focus, inside the viewport, with the ring every stop carries.
    await expect.poll(async () => (await skip.boundingBox())!.y, { message: "the focused skip link stayed off-screen" })
      .toBeGreaterThanOrEqual(0);
    const ring = await ringOf(page);
    expect(ring.style, "the focused skip link has no focus ring").not.toBe("none");
    expect(ring.width).toBeGreaterThan(0);

    await page.keyboard.press("Enter");
    await expect(page.locator("main#atlas-content"), "Enter on the skip link did not focus <main>").toBeFocused();
    expect(new URL(page.url()).hash, "the skip link wrote a hash the router would read").toBe("");
    expect(new URL(page.url()).pathname).toBe("/home");

    // The next Tab lands on a control INSIDE the page, past the tree and the top bar.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && el !== document.body && !!el.closest("main#atlas-content");
    }), "Tab after the skip link did not land inside <main>").toBe(true);
  });

  test("the tree is one Tab stop, and ↑↓ →← Home/End move, open and close it", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const { alpha, bravo, mgr, worker } = await seed(loomDaemon);
    await pinProject(page, alpha.id);
    await page.goto(loomDaemon.baseURL + "/home");
    const tree = page.getByTestId("atlas-tree");
    await expect(tree).toBeVisible();

    const alphaRow = page.getByTestId("atlas-project-node"); // the SELECTED project's row
    const alphaTwist = page.getByTestId(`atlas-project-twist-${alpha.id}`);
    const mgrRow = page.getByTestId(`atlas-session-${mgr.sessionId}`);
    const mgrTwist = page.getByTestId(`atlas-session-twist-${mgr.sessionId}`);
    const workerRow = page.getByTestId(`atlas-session-${worker.sessionId}`);
    const bravoRow = tree.locator("button.loom-atlas-node.is-branch").filter({ hasText: bravo.name });
    await expect(alphaRow).toContainText(alpha.name); // fixture identity: the pinned project is selected
    await expect(workerRow).toBeVisible();
    // The shared daemon holds every earlier spec's projects too, so the tree has at least these two.
    expect(await tree.locator("button.loom-atlas-node.is-branch").count()).toBeGreaterThanOrEqual(2);

    // ── ONE Tab stop ─────────────────────────────────────────────────────────────────────────────
    // On /home the stop is the landed Home row, so exactly one control in the whole tree is tabbable
    // however many projects, twists and `＋`s it renders.
    const tabbable = () => tree.evaluate((nav) =>
      [...nav.querySelectorAll<HTMLElement>("a, button")].filter((el) => el.tabIndex >= 0).length);
    expect(await tabbable(), "more than one tree control is in the Tab order").toBe(1);
    const reached = await tabUntil(page, () => !!document.activeElement?.closest("[data-testid=atlas-tree]"));
    expect(reached, "Tab never reached the tree").toBeGreaterThan(0);
    expect(await focusedTestId(page), "the tree's stop is not the landed Home row").toBe("atlas-home-workspace");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !document.activeElement?.closest("[data-testid=atlas-tree]")),
      "a second Tab stayed inside the tree").toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await focusedTestId(page)).toBe("atlas-home-workspace");

    // ── ↓ walks the rows in document order, ring on each ─────────────────────────────────────────
    const order = await tree.evaluate((nav) =>
      [...nav.querySelectorAll<HTMLElement>("[data-atlas-tree-item]")].map((el) => el.getAttribute("data-atlas-tree-item")));
    const alphaIndex = order.indexOf(`project:${alpha.id}`);
    expect(alphaIndex, "alpha's row is not a tree item").toBeGreaterThan(0);
    for (let i = 1; i <= alphaIndex; i++) {
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-atlas-tree-item")),
        `ArrowDown #${i} did not land on the next row`).toBe(order[i]);
      const ring = await ringOf(page);
      expect(ring.style, `row ${order[i]} has no focus ring`).not.toBe("none");
    }
    await expect(alphaRow).toBeFocused();
    // The stop follows focus: now the project row AND its `＋` are the tree's only tabbable controls.
    expect(await tabbable()).toBe(2);
    await page.keyboard.press("ArrowUp");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-atlas-tree-item"))).toBe(order[alphaIndex - 1]);
    await page.keyboard.press("ArrowDown");
    await expect(alphaRow).toBeFocused();

    // ── ← collapses, → expands, → again steps into the first child ───────────────────────────────
    await expect(alphaTwist).toHaveAttribute("aria-expanded", "true"); // selected ⇒ open by default
    await page.keyboard.press("ArrowLeft");
    await expect(alphaTwist).toHaveAttribute("aria-expanded", "false");
    await expect(mgrRow).toHaveCount(0);
    await expect(alphaRow, "collapsing moved focus off the row").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(alphaTwist).toHaveAttribute("aria-expanded", "true");
    await expect(mgrRow).toBeVisible();
    await expect(alphaRow, "expanding moved focus off the row").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(mgrRow, "→ on an open row did not step into its first child").toBeFocused();
    // One level deeper: the manager's own workers.
    await page.keyboard.press("ArrowRight");
    await expect(workerRow).toBeFocused();
    // ← on a leaf steps OUT to its parent; ← on the open parent collapses it.
    await page.keyboard.press("ArrowLeft");
    await expect(mgrRow, "← on a leaf did not return to its parent").toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(mgrTwist).toHaveAttribute("aria-expanded", "false");
    await expect(workerRow).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(alphaRow, "← on a closed child did not return to the project row").toBeFocused();

    // ── Home / End ───────────────────────────────────────────────────────────────────────────────
    await page.keyboard.press("End");
    const last = await tree.evaluate((nav) =>
      [...nav.querySelectorAll<HTMLElement>("[data-atlas-tree-item]")].at(-1)!.getAttribute("data-atlas-tree-item"));
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-atlas-tree-item"))).toBe(last);
    await page.keyboard.press("Home");
    expect(await focusedTestId(page)).toBe("atlas-home-workspace");

    // ── Enter opens the focused row ──────────────────────────────────────────────────────────────
    // A project row that is not selected: Enter scopes to it and opens its node.
    await bravoRow.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname, { message: "Enter on a project row did not open it" }).toBe("/project");
    await expect(page.getByTestId("atlas-project-node")).toContainText(bravo.name);
    // A session row: Enter goes to that session's node. Alpha's branch is still open (→ opened it by
    // hand above, and expansion is not selection), so its manager row is still rendered.
    await expect(alphaTwist).toHaveAttribute("aria-expanded", "true");
    await expect(mgrRow).toBeVisible();
    await mgrRow.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname, { message: "Enter on a session row did not open it" })
      .toBe(`/session/${mgr.sessionId}`);
  });
});
