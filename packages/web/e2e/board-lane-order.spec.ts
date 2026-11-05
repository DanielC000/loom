// Board lane controls (card 67c43038): reorder lanes on the board itself (header drag, and the ⋯ lane menu /
// Alt+←→ as the keyboard path), collapse a lane to a rail, and move a card from its dialog's "Move to lane"
// select. Every behaviour runs on BOTH surfaces that mount the board: the Overview embed (the owner's primary
// board) and /board. Each assertion is an observable change: the rendered lane order, the server's stored
// order read back over REST, focus, the announcer text, or the card's lane.
//
// The stale-poll case is the safety property behind the reorder-only route: a reorder computed from a board
// snapshot that predates a server-side column add must NOT delete that column (the whole-array PUT /columns
// would, and re-home its cards). The board's own polling is frozen at the stale snapshot to make that window
// deterministic rather than racing the 4s poll.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const DEFAULT_KEYS = ["inbox", "backlog", "todo", "in_progress", "waiting", "review", "done"];
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pin(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const renderedOrder = (page: Page) =>
  page.locator("[data-lane-key]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.laneKey));
async function serverBoard(baseURL: string, projectId: string) {
  const r = await fetch(`${baseURL}/api/projects/${projectId}/board`);
  return (await r.json()) as { columns: { key: string; label: string }[]; tasks: { id: string; columnKey: string }[] };
}
const serverOrder = async (baseURL: string, projectId: string) => (await serverBoard(baseURL, projectId)).columns.map((c) => c.key);

for (const surface of ["/overview", "/board"] as const) {
  test.describe(`board lane controls on ${surface}`, () => {
    test("drag a lane by its header to reorder it", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`lane-drag-${Date.now()}`);
      const card = await loomDaemon.createTask(project.id, { title: uniq("drag-card"), columnKey: "review" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(() => renderedOrder(page)).toEqual(DEFAULT_KEYS);

      // Drag Review's header onto Inbox: Review lands first.
      const handle = page.getByTestId("lane-handle-review");
      const target = page.getByTestId("lane-inbox");
      await handle.scrollIntoViewIfNeeded();
      const h = (await handle.boundingBox())!;
      const t = (await target.boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 - 20, h.y + h.height / 2, { steps: 4 });
      await expect(page.getByTestId("lane-drag-preview")).toBeVisible();
      await page.mouse.move(t.x + t.width / 2, t.y + 120, { steps: 12 });
      await expect(page.getByTestId("lane-drag-hint")).toContainText("before");
      await page.mouse.up();

      const expected = ["review", ...DEFAULT_KEYS.filter((k) => k !== "review")];
      await expect.poll(() => renderedOrder(page)).toEqual(expected);
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id)).toEqual(expected);
      // A lane drag moves the lane, never a card.
      const after = await serverBoard(loomDaemon.baseURL, project.id);
      expect(after.tasks.find((x) => x.id === card.id)?.columnKey).toBe("review");
    });

    test("move a lane from its menu and with Alt+arrows, keyboard only", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`lane-kbd-${Date.now()}`);
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(() => renderedOrder(page)).toEqual(DEFAULT_KEYS);

      const more = page.getByTestId("lane-menu-button-todo");
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("lane-menu-todo")).toBeVisible();
      // The WHOLE menu is on screen. These lanes are empty, so each is at its 200px floor, shorter than the
      // menu: a menu that stayed inside the lane was clipped by the board grid (overflow-y: hidden) and
      // lost its last item.
      await expect(page.getByTestId("lane-edit-columns-todo")).toBeInViewport({ ratio: 1 });
      // The menu opens focused on its first enabled item: Move left.
      await expect(page.getByTestId("lane-move-left-todo")).toBeFocused();
      await page.keyboard.press("Enter");

      const leftOnce = ["inbox", "todo", "backlog", "in_progress", "waiting", "review", "done"];
      await expect.poll(() => renderedOrder(page)).toEqual(leftOnce);
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id)).toEqual(leftOnce);
      await expect(page.getByTestId("lane-announcer")).toHaveText("To Do moved to position 2 of 7");
      // Focus is back on the moved lane's own menu button, so the next keypress acts on the same lane.
      await expect(more).toBeFocused();

      await page.keyboard.press("Alt+ArrowLeft");
      const leftTwice = ["todo", "inbox", "backlog", "in_progress", "waiting", "review", "done"];
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id)).toEqual(leftTwice);
      await expect.poll(() => renderedOrder(page)).toEqual(leftTwice);
      await expect(more).toBeFocused();

      // At the left edge, Move left is disabled and does nothing.
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("lane-move-left-todo")).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByTestId("lane-move-right-todo")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("lane-menu-todo")).toHaveCount(0);
      await expect(more).toBeFocused();
      await page.keyboard.press("Alt+ArrowRight");
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id)).toEqual(leftOnce);
    });

    test("collapse a lane to a rail, per viewer, and expand it again", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`lane-collapse-${Date.now()}`);
      const title = uniq("collapse-card");
      await loomDaemon.createTask(project.id, { title, columnKey: "waiting" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      const lane = page.getByTestId("lane-waiting");
      await expect(lane.getByText(title, { exact: true })).toBeVisible();

      await page.getByTestId("lane-menu-button-waiting").click();
      await page.getByTestId("lane-collapse-waiting").click();
      await expect(lane).toHaveAttribute("data-collapsed", "");
      await expect(lane.getByText(title, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("lane-expand-waiting")).toBeFocused();
      await expect(page.getByTestId("lane-expand-waiting")).toHaveAccessibleName("Expand the Waiting lane (1 card)");
      const narrow = (await lane.boundingBox())!.width;
      expect(narrow).toBeLessThan(60);
      // A view setting only: the server's layout is unchanged.
      expect(await serverOrder(loomDaemon.baseURL, project.id)).toEqual(DEFAULT_KEYS);

      // Persisted per viewer across a reload.
      await page.reload();
      await expect(page.getByTestId("lane-waiting")).toHaveAttribute("data-collapsed", "");

      await page.getByTestId("lane-expand-waiting").click();
      await expect(page.getByTestId("lane-waiting")).not.toHaveAttribute("data-collapsed", "");
      await expect(page.getByTestId("lane-waiting").getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByTestId("lane-menu-button-waiting")).toBeFocused();
    });

    test("move a card to another lane from its dialog", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`lane-move-card-${Date.now()}`);
      const title = uniq("move-card");
      const card = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);

      await page.getByTestId("lane-todo").getByText(title, { exact: true }).click();
      const select = page.getByTestId("task-move-lane");
      await expect(select).toHaveValue("todo");
      await select.selectOption("review");

      await expect.poll(async () => (await serverBoard(loomDaemon.baseURL, project.id)).tasks.find((x) => x.id === card.id)?.columnKey).toBe("review");
      await expect(select).toHaveValue("review");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("lane-review").getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByTestId("lane-todo").getByText(title, { exact: true })).toHaveCount(0);
    });

    test("a reorder from a stale board never deletes a column added since", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(`lane-stale-${Date.now()}`);
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(() => renderedOrder(page)).toEqual(DEFAULT_KEYS);

      // Freeze the board's polling at the snapshot it already holds.
      const stale = await serverBoard(loomDaemon.baseURL, project.id);
      await page.route(`**/api/projects/${project.id}/board*`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) }));

      // Server-side, a QA column appears (as an agent's board_column_create would) and a card lands in it.
      const doneCol = stale.columns[stale.columns.length - 1]!;
      const withQa = [...stale.columns.slice(0, -1), { key: "qa", label: "QA" }, doneCol];
      const put = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/columns`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ columns: withQa }),
      });
      expect(put.ok).toBeTruthy();
      const qaCard = await loomDaemon.createTask(project.id, { title: uniq("qa-card"), columnKey: "qa" });

      // The stale board still shows 7 lanes and reorders from them.
      await expect.poll(() => renderedOrder(page)).toEqual(DEFAULT_KEYS);
      await page.getByTestId("lane-menu-button-review").focus();
      // Wait for whichever column write the board makes, then read the SERVER first: the property under
      // test is that QA and its card survive, and that must be checked before (not inferred from) the
      // banner — a board that silently applied a whole-array layout would show no banner AND lose QA.
      const write = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/api/projects/${project.id}/columns`));
      await page.keyboard.press("Alt+ArrowLeft");
      await write;
      const after = await serverBoard(loomDaemon.baseURL, project.id);
      expect(after.columns.map((c) => c.key)).toEqual(withQa.map((c) => c.key));
      expect(after.tasks.find((x) => x.id === qaCard.id)?.columnKey).toBe("qa");
      // Refused, and said so.
      await expect(page.getByTestId("lane-reorder-error")).toContainText("QA");
      // The optimistic move was rolled back on screen.
      await expect.poll(() => renderedOrder(page)).toEqual(DEFAULT_KEYS);

      // Once the board catches up, the same move succeeds and keeps QA.
      await page.unroute(`**/api/projects/${project.id}/board*`);
      await expect.poll(() => renderedOrder(page), { timeout: 10_000 }).toEqual(withQa.map((c) => c.key));
      await page.getByTestId("lane-menu-button-review").focus();
      await page.keyboard.press("Alt+ArrowLeft");
      const moved = ["inbox", "backlog", "todo", "in_progress", "review", "waiting", "qa", "done"];
      await expect.poll(() => serverOrder(loomDaemon.baseURL, project.id)).toEqual(moved);
      expect((await serverBoard(loomDaemon.baseURL, project.id)).tasks.find((x) => x.id === qaCard.id)?.columnKey).toBe("qa");
    });
  });
}
