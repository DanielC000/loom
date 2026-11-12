// The request pill stays under dialogs and off page buttons (card 3094c4aa, Atlas audit A-01).
//
// Pre-fix the "N requests need you" pill stacked at z-index 2000, so it floated over the open agent editor
// and its scrim, and at phone width it sat on top of whatever a page put last — "Submit answer" on
// /question/:id was mostly hidden under it and could not be scrolled clear. This spec proves both halves:
//   1. At 390px under Atlas, the content scroller reserves the pill's own footprint as bottom padding, so
//      scrolled to the end, "Submit answer" rests ABOVE the pill (box geometry, not a screenshot).
//   2. Dismissing the pill releases the reserve — the scroller goes back to its normal 20px.
//   3. With the agent editor open, the topmost element at the pill's centre is the dialog, not the pill;
//      closed again, the pill is topmost and clickable. `elementFromPoint` is the honest witness here:
//      `toBeVisible` passes for an element painted UNDER a scrim.
//   4. At 1440 no reserve is taken (the pill sits in the corner beside the content there).
//
// Atlas audit B-02 (second test): the pill also covered bottom-DOCKED controls — the board card dialog's
// Save/Delete at 390 (above the scrim), the board bulk bar's "Clear selection" and a session composer's
// "Send turn" at 1440. Each control must be what a click at its own centre hits, with the pill still up;
// the bulk bar's leg also proves the pill drops back to its corner once the bar goes away.
//
// No real claude: the manager is a seeded `processState:"live"` row and the request a seeded DB row.
import { expect, test, type Page } from "./fixtures/daemon";

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

const scrollerPaddingBottom = (page: Page) =>
  page.locator(".loom-atlas-content").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));

/** True when the pill (or a child of it) is what a click at its own centre would actually hit. */
const pillIsTopmost = (page: Page) =>
  page.getByTestId("request-count-pill").evaluate((pill) => {
    const r = pill.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && pill.contains(hit);
  });

/** True when nothing covers `locator`'s element: a hit at its centre AND 3px inside each corner lands on
 *  it. Centre alone is too weak — pre-fix the pill covered the lower half of "Send turn" while the
 *  button's centre sat a pixel above the pill's top edge (measured; a centre-only check stayed green). */
const isTopmost = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.top + 3],
      [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]];
    return pts.every(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return !!hit && el.contains(hit); });
  });

const cornerBottom = (page: Page) =>
  page.getByTestId("toast-corner").evaluate((el) => parseFloat(getComputedStyle(el).bottom));

test.describe("request pill layering (card 3094c4aa)", () => {
  test("reserves its footprint at 390, sits under the agent editor, and costs nothing at 1440", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `PillMgr-${Date.now()}` });
    const questionId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
      title: `Pill layering ${Date.now()}`, options: ["Retry first", "Fail fast"],
    });
    await pinProject(page, mgr.projectId);

    // ── (1) 390px: the last button on /question/:id scrolls clear of the pill.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${loomDaemon.baseURL}/question/${questionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    const pill = page.getByTestId("request-count-pill");
    await expect(pill).toBeVisible();
    const submit = page.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeVisible();

    const pillBox = (await pill.boundingBox())!;
    // The reserve is the pill's own height + its 16px offset + an 8px gap, on top of the normal 20px.
    await expect.poll(() => scrollerPaddingBottom(page)).toBeCloseTo(20 + pillBox.height + 24, 0);
    await page.locator(".loom-atlas-content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => {
      const s = (await submit.boundingBox())!;
      return s.y + s.height;
    }).toBeLessThan(pillBox.y);

    // ── (2) Dismissing the pill releases the reserve.
    await pill.getByRole("button", { name: "dismiss" }).click();
    await expect(page.getByTestId("request-count-pill")).toHaveCount(0);
    await expect.poll(() => scrollerPaddingBottom(page)).toBe(20);

    // ── (3) The agent editor covers the pill; closed, the pill is on top again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/agents`); // a fresh load resets the in-memory dismiss
    await expect(pill).toBeVisible();
    // ── (4) Wide: no reserve.
    await expect.poll(() => scrollerPaddingBottom(page)).toBe(20);
    await expect.poll(() => pillIsTopmost(page)).toBe(true);
    await page.getByTestId(`atlas-agent-edit-${mgr.agentId}`).click();
    const dialog = page.getByTestId("atlas-agent-editor");
    await expect(dialog).toBeVisible();
    await expect.poll(() => pillIsTopmost(page)).toBe(false);
    await page.getByTestId("atlas-agent-editor-close").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => pillIsTopmost(page)).toBe(true);
  });

  test("never covers the card dialog, the board bulk bar or a session composer (B-02)", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    // A busy worker with a bound task and a queued message: the shape that put the composer in the
    // pill's corner at 1440×900 in the audit (the bound-task block pushes the composer down).
    const wkr = await loomDaemon.seedLiveSession({
      role: "worker", busy: true, agentName: `PillWkr-${Date.now()}`,
      task: { title: `fix(web): pill dock card ${Date.now()}`, columnKey: "inbox" },
    });
    await loomDaemon.enqueueMessage({ sessionId: wkr.sessionId, text: "[loom:worker-idle] check-in", kind: "warning" });
    await loomDaemon.seedQuestion({ sessionId: wkr.sessionId, projectId: wkr.projectId, type: "input", title: `Pill dock ${Date.now()}` });
    // Enough Backlog cards that the lanes outgrow the viewport and the bulk bar sticks to its bottom.
    const filler: string[] = [];
    for (let i = 0; i < 30; i++) {
      filler.push((await loomDaemon.createTask(wkr.projectId, { title: `fix(web): filler ${i}`, columnKey: "backlog" })).id);
    }
    await pinProject(page, wkr.projectId);
    const pill = page.getByTestId("request-count-pill");

    // ── Session composer at 1440: Voice, language and "Send turn" stay clickable with the pill up.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/session/${wkr.sessionId}`);
    await expect(pill).toBeVisible();
    const controls = page.getByTestId("composer-controls");
    await expect(controls).toBeVisible();
    await expect.poll(() => isTopmost(controls.getByRole("button", { name: "Send turn" }))).toBe(true);
    // Witness that the fixture really put the composer in the corner (the pill had to rise), so the
    // assertion above cannot pass merely because the composer happened to render clear of it.
    await expect.poll(() => cornerBottom(page)).toBeGreaterThan(16);

    // ── Board bulk bar at 1440: "Clear selection" stays clickable; the pill returns once the bar goes.
    await page.goto(`${loomDaemon.baseURL}/board`);
    const card = (id: string) => page.locator(`.loom-board-grid [data-board-nav="${id}"]`);
    await expect(card(filler[0]!)).toBeVisible();
    await card(filler[0]!).click({ modifiers: ["ControlOrMeta"] });
    await card(filler[1]!).click({ modifiers: ["ControlOrMeta"] });
    const bar = page.getByTestId("board-bulk-bar");
    await expect(bar).toBeVisible();
    await expect(pill).toBeVisible();
    const clear = bar.getByRole("button", { name: "Clear selection" });
    await expect.poll(() => isTopmost(clear)).toBe(true);
    await expect.poll(() => cornerBottom(page)).toBeGreaterThan(16); // witness: the bar was in the corner
    await clear.click();
    await expect(bar).toHaveCount(0);
    await expect.poll(() => cornerBottom(page)).toBe(16);

    // ── Card dialog at 390: the pill is under the scrim; Save and Delete are what a click hits.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${loomDaemon.baseURL}/board?task=${filler[0]}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(pill).toBeAttached();
    await expect.poll(() => pillIsTopmost(page)).toBe(false);
    await expect.poll(() => isTopmost(dialog.getByRole("button", { name: "Save", exact: true }))).toBe(true);
    await expect.poll(() => isTopmost(dialog.getByRole("button", { name: "Delete", exact: true }))).toBe(true);
  });
});
