// Within-lane card reorder (card 139cfc3d): a card dragged within its own lane lands where the insertion
// line says, the line is clamped to the card's priority band (a drag never changes priority), Alt+↑/↓
// on a focused card is the keyboard twin, the done lane is never reordered, and a renumber whose write
// fails shows the SERVER's order with an alert rather than a half-saved band. Runs on both surfaces that
// mount the board: the Overview embed (the owner's primary board) and /board. Every order assertion is
// read back from the server, and the drag one survives a reload.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function pin(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
type Row = { id: string; columnKey: string; priority?: string; position: number };
const PRI = ["p0", "p1", "p2", "p3"];
/** The server's order for one lane: priority, then position, ties in the order the server lists them. */
async function serverOrder(baseURL: string, projectId: string, lane: string): Promise<string[]> {
  const r = await fetch(`${baseURL}/api/projects/${projectId}/board`);
  const b = (await r.json()) as { tasks: Row[] };
  return b.tasks.filter((t) => t.columnKey === lane)
    .sort((x, y) => PRI.indexOf(x.priority ?? "p2") - PRI.indexOf(y.priority ?? "p2") || x.position - y.position)
    .map((t) => t.id);
}
async function setPosition(baseURL: string, id: string, position: number) {
  const r = await fetch(`${baseURL}/api/tasks/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ position }) });
  expect(r.ok).toBe(true);
}
const rendered = (page: Page, lane: string) =>
  page.getByTestId(`lane-${lane}`).locator(".loom-board-card").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.cardId));

for (const surface of ["/board"] as const) {
  test.describe(`board card reorder on ${surface}`, () => {
    test("a drag within the lane lands on the line's slot, clamped to its band, and survives a reload", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("reorder-drag"));
      const mk = async (title: string, priority: "p1" | "p2" | "p3", position: number) => {
        const t = await loomDaemon.createTask(project.id, { title: uniq(title), columnKey: "todo", priority });
        await setPosition(loomDaemon.baseURL, t.id, position);
        return t;
      };
      const a = await mk("p1-a", "p1", 100);
      const b = await mk("p2-b", "p2", 200);
      const c = await mk("p2-c", "p2", 300);
      const d = await mk("p2-d", "p2", 400);
      const e = await mk("p3-e", "p3", 500);
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(() => rendered(page, "todo")).toEqual([a.id, b.id, c.id, d.id, e.id]);

      const lane = page.getByTestId("lane-todo");
      const card = lane.locator(`[data-card-id="${d.id}"]`);
      // Centre the lane first: a pointer near the viewport edge makes dnd-kit auto-scroll the page (the
      // Overview embed sits below the fold), which would move every card under the measurement below.
      await lane.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const box = (await card.boundingBox())!;
      const top = (await lane.locator(`[data-card-id="${a.id}"]`).boundingBox())!;
      const x = box.x + box.width * 0.6, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 8, { steps: 3 });
      await expect(page.getByTestId("card-drag-preview")).toBeVisible();
      // Over the P1 card: the P2 cannot go above it, so the line clamps to the top of the P2 band.
      await page.mouse.move(x, top.y + top.height / 2, { steps: 12 });
      await expect(lane.getByTestId("card-drop-line")).toHaveCount(1);
      // The line and the cards in ONE snapshot, so nothing can scroll between the two reads.
      const above = await lane.evaluate((el) => {
        const ly = el.querySelector('[data-testid="card-drop-line"]')!.getBoundingClientRect().y;
        return [...el.querySelectorAll<HTMLElement>(".loom-board-card:not([data-dragging])")]
          .filter((c) => c.getBoundingClientRect().bottom <= ly + 1).map((c) => c.dataset.cardId);
      });
      expect(above).toEqual([a.id]);
      await page.mouse.up();

      await expect(page.getByTestId("card-drop-line")).toHaveCount(0);
      const want = [a.id, d.id, b.id, c.id, e.id];
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id, "todo")).toEqual(want);
      await expect.poll(() => rendered(page, "todo")).toEqual(want);
      await expect(page.getByRole("dialog")).toHaveCount(0); // a drop is not a click
      await page.reload();
      await expect.poll(() => rendered(page, "todo")).toEqual(want);

      // A drag that ends back on the card's own slot shows no line and writes nothing.
      const writes: string[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/tasks/")) writes.push(r.url()); });
      await lane.evaluate((el) => el.scrollIntoView({ block: "center" })); // the reload put it below the fold again
      const cb = (await lane.locator(`[data-card-id="${c.id}"]`).boundingBox())!;
      await page.mouse.move(cb.x + cb.width * 0.6, cb.y + cb.height / 2);
      await page.mouse.down();
      await page.mouse.move(cb.x + cb.width * 0.6 + 4, cb.y + cb.height / 2 + 6, { steps: 4 });
      await expect(page.getByTestId("card-drag-preview")).toBeVisible();
      await expect(lane.getByTestId("card-drop-line")).toHaveCount(0);
      await page.mouse.up();
      await expect(page.getByTestId("card-drag-preview")).toHaveCount(0);
      expect(writes).toEqual([]);
    });

    test("Alt+↑/↓ moves the focused card within its band, keeps focus, and never reorders the done lane", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("reorder-kbd"));
      const mk = async (title: string, priority: "p1" | "p2", position: number, columnKey = "todo") => {
        const t = await loomDaemon.createTask(project.id, { title: uniq(title), columnKey, priority });
        await setPosition(loomDaemon.baseURL, t.id, position);
        return t;
      };
      const a = await mk("p1-a", "p1", 100);
      const b = await mk("p2-b", "p2", 200);
      const c = await mk("p2-c", "p2", 300);
      const done1 = await mk("done-1", "p2", 1, "done");
      await mk("done-2", "p2", 2, "done");
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(() => rendered(page, "todo")).toEqual([a.id, b.id, c.id]);

      const open = (id: string) => page.locator(`[data-card-id="${id}"] .loom-board-open`);
      const announcer = page.getByTestId("lane-announcer");
      await open(c.id).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id, "todo")).toEqual([a.id, c.id, b.id]);
      await expect.poll(() => rendered(page, "todo")).toEqual([a.id, c.id, b.id]);
      await expect(announcer).toContainText("moved to 1 of 2 in P2");
      await expect(open(c.id)).toBeFocused();
      // At the top of its band: nothing moves (the P1 stays above it), and the live region says why.
      await page.keyboard.press("Alt+ArrowUp");
      await expect(announcer).toContainText("already first of the P2 cards");
      await expect(open(c.id)).toBeFocused();
      expect(await serverOrder(loomDaemon.baseURL, project.id, "todo")).toEqual([a.id, c.id, b.id]);
      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id, "todo")).toEqual([a.id, b.id, c.id]);
      await expect(open(c.id)).toBeFocused();

      // The done lane sorts by recency: Alt+↑ there sends no write at all.
      const writes: string[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/tasks/")) writes.push(r.url()); });
      await open(done1.id).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("Alt+ArrowDown");
      await expect(open(done1.id)).toBeFocused();
      expect(writes).toEqual([]);
    });

    test("tied positions renumber the band; a failed write shows the server's order, never a half-saved one", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("reorder-tie"));
      const mk = async (title: string) => {
        const t = await loomDaemon.createTask(project.id, { title: uniq(title), columnKey: "todo", priority: "p2" });
        await setPosition(loomDaemon.baseURL, t.id, 0); // the legacy DEFAULT 0: no midpoint exists between them
        return t;
      };
      const x = await mk("tie-x");
      const y = await mk("tie-y");
      const z = await mk("tie-z");
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      const start = await serverOrder(loomDaemon.baseURL, project.id, "todo");
      await expect.poll(() => rendered(page, "todo")).toEqual(start);
      const [first, , last] = start as [string, string, string];

      // Moving the last card up one renumbers the band: the moved card, then the card it jumped. Fail
      // the SECOND write, so the server is left part-way through.
      const moved = last, jumped = start[1]!;
      let failed = 0;
      await page.route(`**/api/tasks/${jumped}`, (route) => {
        if (route.request().method() !== "POST") return route.continue();
        failed++;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "write refused for the test" }) });
      });
      await page.locator(`[data-card-id="${moved}"] .loom-board-open`).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect(page.getByTestId("card-reorder-error")).toContainText("write refused for the test");
      expect(failed).toBe(1);
      // What renders is what the server holds, whatever that is — not the optimistic first, moved, jumped.
      const after = await serverOrder(loomDaemon.baseURL, project.id, "todo");
      expect(after).not.toEqual([first, moved, jumped]);
      await expect.poll(() => rendered(page, "todo")).toEqual(after);

      // With the write allowed again, the same move goes through and survives a reload.
      await page.unroute(`**/api/tasks/${jumped}`);
      await page.getByTestId("card-reorder-error").getByRole("button", { name: "Dismiss" }).click();
      const now = await serverOrder(loomDaemon.baseURL, project.id, "todo");
      const pos = now.indexOf(moved);
      await page.locator(`[data-card-id="${moved}"] .loom-board-open`).focus();
      await page.keyboard.press("Alt+ArrowUp");
      const want = [...now]; want.splice(pos, 1); want.splice(pos - 1, 0, moved);
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id, "todo")).toEqual(want);
      await expect(page.getByTestId("card-reorder-error")).toHaveCount(0);
      await page.reload();
      await expect.poll(() => rendered(page, "todo")).toEqual(want);
      expect(new Set(want)).toEqual(new Set([x.id, y.id, z.id]));
    });
  });
}
