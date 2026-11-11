// Board lanes and narrow chrome (card c315f579, Atlas audit B-06 / B-09 / B-21 / B-24). Every check is an
// observable change, on BOTH surfaces that mount the board: the Overview embed (the owner's primary board)
// and /board.
//  · B-06: lanes cut off at an edge are counted by a "N more lanes →" chip that scrolls them in; once
//    scrolled, a "← N lanes" chip leads back; a board that fits shows no chip row at all.
//  · B-09: below 820px the facet rows fold behind a "Filters" toggle that reports how many are on, and
//    the quick-add stays one row.
//  · B-21: a card's relation line is 12px.
//  · B-24: an empty board has no filter bar; it comes back with the first card.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function pin(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
// Lanes not fully inside the grid's visible box, measured from the DOM (not from the chip's own claim).
const cutLanes = (page: Page) => page.locator(".loom-board-grid").first().evaluate((g) => {
  const gr = g.getBoundingClientRect();
  return [...g.querySelectorAll<HTMLElement>(":scope > [data-lane-key]")]
    .filter((l) => { const r = l.getBoundingClientRect(); return r.left < gr.left - 1 || r.right > gr.right + 1; })
    .map((l) => l.dataset.laneKey);
});
const scrollLeft = (page: Page) => page.locator(".loom-board-grid").first().evaluate((g) => Math.round(g.scrollLeft));
// The chip scrolls smoothly, and the chips only update once the scroll lands. Wait for two equal reads a
// frame apart, so the next step reads the settled chips rather than a mid-scroll snapshot.
async function settled(page: Page): Promise<number> {
  let prev = -1;
  for (let i = 0; i < 60; i++) {
    const now = await page.locator(".loom-board-grid").first().evaluate((g) =>
      new Promise<number>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(g.scrollLeft))))));
    if (now === prev) return now;
    prev = now;
  }
  throw new Error("board grid never stopped scrolling");
}

for (const surface of ["/board"] as const) {
  test.describe(`board lanes and narrow chrome on ${surface}`, () => {
    test("the more-lanes chip counts the cut-off lanes and scrolls them into view", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("lane-overflow"));
      const done = uniq("done-card");
      await loomDaemon.createTask(project.id, { title: done, columnKey: "done" });
      await pin(page, project.id);
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect(page.getByText(done)).toBeAttached();

      const after = page.getByTestId("lane-overflow-after");
      const before = page.getByTestId("lane-overflow-before");
      // The chip's number is the number of lanes the DOM says are cut off, and it names them.
      const cut = await cutLanes(page);
      expect(cut.length).toBeGreaterThan(0);
      await expect(after).toHaveText(`${cut.length} more ${cut.length === 1 ? "lane" : "lanes"} →`);
      await expect(after).toHaveAttribute("aria-label", /Done/);
      await expect(before).toHaveCount(0);
      expect(await scrollLeft(page)).toBe(0);

      // Clicking moves the grid right; the way back appears.
      await after.click();
      await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0);
      await settled(page);
      await expect(before).toBeVisible();

      // Keep going until nothing is left on the right: Done is then fully in view and the chip is gone.
      for (let i = 0; i < 8 && (await after.count()) > 0; i++) {
        const s = await settled(page);
        await after.click();
        await expect.poll(() => scrollLeft(page)).toBeGreaterThan(s);
        await settled(page);
      }
      await expect(after).toHaveCount(0);
      expect(await cutLanes(page)).not.toContain("done");

      // And all the way back.
      for (let i = 0; i < 8 && (await before.count()) > 0; i++) {
        const s = await settled(page);
        await before.click();
        await expect.poll(() => scrollLeft(page)).toBeLessThan(s);
        await settled(page);
      }
      await expect(before).toHaveCount(0);
      expect(await scrollLeft(page)).toBe(0);
    });

    test("a board whose lanes all fit shows no more-lanes row", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("lane-fit"));
      const t = uniq("fit-card");
      await loomDaemon.createTask(project.id, { title: t, columnKey: "todo" });
      await pin(page, project.id);
      await page.setViewportSize({ width: 2400, height: 900 });
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect(page.getByText(t)).toBeVisible();
      expect(await cutLanes(page)).toEqual([]);
      await expect(page.getByTestId("lane-overflow-row")).toHaveCount(0);
    });

    test("at phone width the facets fold behind a Filters toggle and quick-add is one row", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("narrow-board"));
      const t = uniq("narrow-card");
      await loomDaemon.createTask(project.id, { title: t, columnKey: "inbox", priority: "p0" });
      await pin(page, project.id);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect(page.getByText(t)).toBeAttached();

      const bar = page.getByTestId("board-filter-bar");
      const toggle = page.getByTestId("board-filter-toggle");
      const priority = bar.getByRole("group", { name: "Priority filter" });
      // Search stays out; the facet rows are folded.
      await expect(bar.getByLabel("Search tasks by id, title, or description")).toBeVisible();
      await expect(toggle).toHaveText(/^Filters/);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(priority).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(priority).toBeVisible();
      await priority.getByRole("button", { name: /Filter by .* priority/ }).first().click();
      await expect(toggle).toHaveText(/^Filters \(1\)/);
      // Folded again, the count still says a filter is on.
      await toggle.click();
      await expect(priority).toHaveCount(0);
      await expect(toggle).toHaveText(/^Filters \(1\)/);

      // Quick-add: the input and its button share one row, and the row stays inside the viewport. (Scoped
      // to the row: the classic Overview's own KPI strip overflows 390 by a few px, unrelated to the board.)
      const row = page.getByTestId("board-new-task-row").first();
      const input = row.getByLabel("New task title");
      const add = row.getByRole("button", { name: "Add to Inbox" });
      const [ib, ab, rb] = [await input.boundingBox(), await add.boundingBox(), await row.boundingBox()];
      expect(Math.abs(ib!.y - ab!.y)).toBeLessThan(4);
      expect(rb!.x + rb!.width).toBeLessThanOrEqual(390);
      expect(ab!.x + ab!.width).toBeLessThanOrEqual(390);
    });

    test("an empty board has no filter bar until its first card", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("empty-board"));
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect(page.locator("[data-lane-key='inbox']").first()).toBeVisible();
      await expect(page.getByTestId("board-filter-bar")).toHaveCount(0);

      const t = uniq("first-card");
      await page.getByLabel("New task title").first().fill(t);
      await page.getByRole("button", { name: "Add to Inbox" }).first().click();
      await expect(page.getByText(t)).toBeVisible();
      await expect(page.getByTestId("board-filter-bar")).toBeVisible();
    });

    test("a card's parent line is 12px", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("rel-font"));
      const parent = await loomDaemon.createTask(project.id, { title: uniq("parent"), columnKey: "todo" });
      const childTitle = uniq("child");
      const child: Parameters<typeof loomDaemon.createTask>[1] & { parentId: string } = { title: childTitle, columnKey: "todo", parentId: parent.id };
      await loomDaemon.createTask(project.id, child);
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      const line = page.locator(`[title='Child of "${parent.title}"']`).first();
      await expect(line).toBeVisible();
      expect(await line.evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
    });
  });
}
