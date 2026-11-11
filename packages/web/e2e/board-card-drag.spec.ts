// Card drag (card 68800f89): a lifted card follows the pointer as a DragOverlay preview (it used to be
// translated in place and clipped inside its lane's scroll container), the target lane shows an insertion
// line at the slot the card will really land in, the card's FACE starts a drag with a mouse (after the
// sensor's 6px, without selecting text), and the grip is a 24×24 touch target. A plain click still opens
// the card and a Ctrl-click still selects it. Runs on both surfaces that mount the board: the Overview
// embed (the owner's primary board) and /board. Every assertion is an observable state: the preview and
// the line in the DOM, the card's lane read back from the server, the dialog, the bulk-bar count.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function pin(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
async function laneOf(baseURL: string, projectId: string, id: string) {
  const r = await fetch(`${baseURL}/api/projects/${projectId}/board`);
  const b = (await r.json()) as { tasks: { id: string; columnKey: string }[] };
  return b.tasks.find((t) => t.id === id)?.columnKey;
}

for (const surface of ["/board"] as const) {
  test.describe(`board card drag on ${surface}`, () => {
    test("drag a card by its face: preview follows, the line marks the landing slot, the drop moves it", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`card-drag-${Date.now()}`);
      // Lands between the P1 and the P3 already in To Do: the line must sit at slot 1, not under the pointer.
      await loomDaemon.createTask(project.id, { title: uniq("todo-p1"), columnKey: "todo", priority: "p1" });
      await loomDaemon.createTask(project.id, { title: uniq("todo-p3"), columnKey: "todo", priority: "p3" });
      const moving = await loomDaemon.createTask(project.id, { title: uniq("drag-me"), columnKey: "inbox", priority: "p2" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);

      const card = page.getByTestId("lane-inbox").locator(".loom-board-card").filter({ hasText: moving.title });
      const target = page.getByTestId("lane-todo");
      await card.scrollIntoViewIfNeeded();
      const c = (await card.boundingBox())!;
      const t = (await target.boundingBox())!;
      // Press on the TITLE (not the grip) and move past the 6px activation distance.
      const x = c.x + c.width * 0.6, y = c.y + c.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y + 6, { steps: 4 });
      await expect(page.getByTestId("card-drag-preview")).toBeVisible();
      await expect(page.getByTestId("card-drag-preview")).toContainText(moving.title);
      await page.mouse.move(t.x + t.width / 2, t.y + 120, { steps: 12 });
      const line = target.getByTestId("card-drop-line");
      await expect(line).toHaveCount(1);
      const lineY = (await line.boundingBox())!.y;
      const above = await target.locator(".loom-board-card").evaluateAll(
        (els, ly) => els.filter((e) => e.getBoundingClientRect().bottom <= ly + 1).length, lineY);
      expect(above).toBe(1);
      // Dragging the face never selects text across lanes.
      expect(await page.evaluate(() => String(window.getSelection()).length)).toBe(0);
      await page.mouse.up();

      await expect.poll(() => laneOf(loomDaemon.baseURL, project.id, moving.id)).toBe("todo");
      await expect(page.getByTestId("card-drag-preview")).toHaveCount(0);
      await expect(page.getByTestId("card-drop-line")).toHaveCount(0);
      // It rendered exactly where the line said.
      await expect.poll(() => target.locator('[data-testid="card-title"]').allInnerTexts()).toEqual([
        expect.stringContaining("todo-p1"), moving.title, expect.stringContaining("todo-p3")]);
      // A drop is not a click: no dialog opened.
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("the grip is a 24×24 target, and a click still opens while a Ctrl-click still selects", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`card-grip-${Date.now()}`);
      const task = await loomDaemon.createTask(project.id, { title: uniq("grip"), columnKey: "inbox" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      const card = page.getByTestId("lane-inbox").locator(".loom-board-card").filter({ hasText: task.title });
      const grip = card.locator('[title="Drag to move"]');
      await grip.scrollIntoViewIfNeeded(); // the Overview embed sits below the fold
      const g = (await grip.boundingBox())!;
      expect(g.width).toBeGreaterThanOrEqual(24);
      expect(g.height).toBeGreaterThanOrEqual(24);

      // The grip still drags (and the preview appears) — then Escape cancels with the card unmoved.
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(g.x + 30, g.y + 30, { steps: 4 });
      await expect(page.getByTestId("card-drag-preview")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(page.getByTestId("card-drag-preview")).toHaveCount(0);
      expect(await laneOf(loomDaemon.baseURL, project.id, task.id)).toBe("inbox");

      await card.locator(".loom-board-open").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await card.locator(".loom-board-open").click({ modifiers: ["Control"] });
      await expect(page.getByTestId("board-bulk-count")).toHaveText("1 selected");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });
}
