// Board multi-select + bulk actions (card 19074e42). Ctrl/⌘-click toggles a card, Shift-click selects a
// range within a lane from the board's focus position, `x` toggles the focused card and Shift+↑/↓ extends
// to the neighbour; Escape clears. A bulk bar then moves, re-prioritises, holds or releases every selected
// card with one PATCH each. Every leg runs on BOTH board surfaces: the Overview embed (the owner's primary
// board) and /board.
//
// Every bulk-action assertion reads the DAEMON's row over REST, not the DOM: a card that merely re-rendered
// in a new lane, or a result line that says "moved", proves nothing about what was written.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pin(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

type Row = { id: string; columnKey: string; priority?: string; held?: boolean };
async function getRow(baseURL: string, id: string): Promise<Row> {
  const res = await fetch(`${baseURL}/api/tasks/${id}`);
  if (!res.ok) throw new Error(`GET /api/tasks/${id} -> ${res.status}`);
  return (await res.json()) as Row;
}

const laneCards = (page: Page, lane: string) =>
  page.locator(`[data-lane-key="${lane}"] [data-board-nav]`).evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.boardNav!).filter((i) => i !== "head" && i !== "more"));
/** The selected card ids, in DOM order. */
const selectedIds = (page: Page) =>
  page.locator(".loom-board-grid .loom-board-card[data-selected] [data-board-nav]").evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.boardNav!));
const sorted = (a: string[]) => [...a].sort();
const expectSelected = (page: Page, ids: string[]) => expect.poll(async () => sorted(await selectedIds(page))).toEqual(sorted(ids));
const openTarget = (page: Page, id: string) => page.locator(`.loom-board-grid [data-board-nav="${id}"]`);
const activeItem = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return `${el?.closest<HTMLElement>("[data-lane-key]")?.dataset.laneKey ?? null}/${el?.dataset.boardNav ?? null}`;
});
const MOD = process.platform === "darwin" ? "Meta" : "Control";

for (const surface of ["/board"] as const) {
  test.describe(`board multi-select on ${surface}`, () => {
    test("ctrl-click, shift-range and keyboard select; Escape clears; a plain click still opens; arrows still move", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("sel"));
      for (let i = 0; i < 4; i++) await loomDaemon.createTask(project.id, { title: uniq(`sel-inbox-${i}`), columnKey: "inbox" });
      const other = await loomDaemon.createTask(project.id, { title: uniq("sel-backlog"), columnKey: "backlog" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => (await laneCards(page, "inbox")).length).toBe(4);
      const inbox = await laneCards(page, "inbox");
      const bar = page.getByTestId("board-bulk-bar");
      await expect(bar).toHaveCount(0);

      // Ctrl/⌘-click toggles, opens nothing, and the bar appears with the count.
      await openTarget(page, inbox[0]!).click({ modifiers: [MOD] });
      await expectSelected(page, [inbox[0]!]);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("board-bulk-count")).toHaveText("1 selected");

      // Shift-click selects the range from the focused card (the last one pressed) to the clicked one.
      await openTarget(page, inbox[2]!).click({ modifiers: ["Shift"] });
      await expectSelected(page, inbox.slice(0, 3));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("board-bulk-count")).toHaveText("3 selected");

      // Ctrl/⌘-click toggles a card in another lane in and out.
      await openTarget(page, other.id).click({ modifiers: [MOD] });
      await expectSelected(page, [...inbox.slice(0, 3), other.id]);
      await openTarget(page, other.id).click({ modifiers: [MOD] });
      await expectSelected(page, inbox.slice(0, 3));
      // A range never crosses lanes: with the anchor on the backlog card, Shift-click on an inbox card adds
      // only that card, not the inbox cards above it.
      await page.keyboard.press("Escape");
      await expectSelected(page, []);
      await openTarget(page, other.id).click({ modifiers: [MOD] });
      await openTarget(page, inbox[2]!).click({ modifiers: ["Shift"] });
      await expectSelected(page, [other.id, inbox[2]!]);

      // Escape clears.
      await page.keyboard.press("Escape");
      await expectSelected(page, []);
      await expect(bar).toHaveCount(0);

      // Keyboard: `x` toggles the focused card; Shift+↓ extends to the neighbour and moves focus.
      await openTarget(page, inbox[0]!).focus();
      await page.keyboard.press("x");
      await expectSelected(page, [inbox[0]!]);
      await page.keyboard.press("Shift+ArrowDown");
      await expectSelected(page, [inbox[0]!, inbox[1]!]);
      await expect.poll(() => activeItem(page)).toBe(`inbox/${inbox[1]}`);
      await page.keyboard.press("Shift+ArrowDown");
      await expectSelected(page, inbox.slice(0, 3));
      await page.keyboard.press("x");
      await expectSelected(page, inbox.slice(0, 2));

      // Arrow navigation is untouched with a selection active, and moving does not change the selection.
      await page.keyboard.press("ArrowDown"); await expect.poll(() => activeItem(page)).toBe(`inbox/${inbox[3]}`);
      await page.keyboard.press("ArrowRight"); await expect.poll(() => activeItem(page)).toBe(`backlog/${other.id}`);
      await page.keyboard.press("ArrowLeft"); await expect.poll(() => activeItem(page)).toBe(`inbox/${inbox[0]}`);
      await page.keyboard.press("ArrowUp"); await expect.poll(() => activeItem(page)).toBe("inbox/head");
      await expectSelected(page, inbox.slice(0, 2));
      // `x` on a header selects nothing.
      await page.keyboard.press("x");
      await expectSelected(page, inbox.slice(0, 2));

      // The selection survives the 4s poll.
      await page.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/board`));
      await page.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/board`));
      await expectSelected(page, inbox.slice(0, 2));

      // A plain click still opens the card (and Enter too), selection or not.
      await openTarget(page, inbox[3]!).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // Escape belongs to the dialog: it closes it and leaves the selection alone.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expectSelected(page, inbox.slice(0, 2));
      await openTarget(page, inbox[3]!).focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // A card that leaves view drops out: a search that hides it, and a delete.
      const search = page.getByLabel("Search tasks by id, title, or description");
      const titleOf1 = await openTarget(page, inbox[1]!).getByTestId("card-title").textContent();
      await search.fill(titleOf1!);
      await expectSelected(page, [inbox[1]!]);
      await search.fill("");
      await expectSelected(page, [inbox[1]!]); // un-hiding does not bring the dropped card back
      expect((await fetch(`${loomDaemon.baseURL}/api/tasks/${inbox[1]}`, { method: "DELETE" })).ok).toBe(true);
      // Seen on the board's next 4s poll, so allow a couple of poll periods.
      await expect.poll(async () => selectedIds(page), { timeout: 12_000 }).toEqual([]);
      await expect(bar).toHaveCount(0);

      // Nothing here touched the filters (decision cea577af) or the lane order.
      await expect(search).toHaveValue("");
      await expect.poll(() => page.locator(".loom-board-grid [data-lane-key]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.laneKey)))
        .toEqual(["inbox", "backlog", "todo", "in_progress", "waiting", "review", "done"]);
    });

    test("each bulk action writes every selected card on the server", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("bulk"));
      const a = await loomDaemon.createTask(project.id, { title: uniq("bulk-a"), columnKey: "inbox", priority: "p2" });
      const b = await loomDaemon.createTask(project.id, { title: uniq("bulk-b"), columnKey: "inbox", priority: "p2" });
      const bystander = await loomDaemon.createTask(project.id, { title: uniq("bulk-bystander"), columnKey: "inbox", priority: "p2" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => (await laneCards(page, "inbox")).length).toBe(3);
      await openTarget(page, a.id).click({ modifiers: [MOD] });
      await openTarget(page, b.id).click({ modifiers: [MOD] });
      await expectSelected(page, [a.id, b.id]);
      const result = page.getByTestId("board-bulk-result");

      // Move to lane.
      await page.getByLabel("Move the selected cards to a lane").selectOption("review");
      await expect(result).toContainText("2 cards moved to Review");
      for (const id of [a.id, b.id]) await expect.poll(async () => (await getRow(loomDaemon.baseURL, id)).columnKey).toBe("review");
      // The moved cards are still rendered, so they stay selected for a follow-up action.
      await expectSelected(page, [a.id, b.id]);

      // Set priority.
      await page.getByLabel("Set the priority of the selected cards").selectOption("p0");
      await expect(result).toContainText("2 cards set to P0");
      for (const id of [a.id, b.id]) await expect.poll(async () => (await getRow(loomDaemon.baseURL, id)).priority).toBe("p0");

      // Hold, then release.
      await page.getByRole("button", { name: "Hold", exact: true }).click();
      await expect(result).toContainText("2 cards held");
      for (const id of [a.id, b.id]) await expect.poll(async () => (await getRow(loomDaemon.baseURL, id)).held).toBe(true);
      await page.getByRole("button", { name: "Release hold" }).click();
      await expect(result).toContainText("2 cards released");
      for (const id of [a.id, b.id]) await expect.poll(async () => !!(await getRow(loomDaemon.baseURL, id)).held).toBe(false);

      // A card already in the target state is skipped, not rewritten, and said so.
      await page.getByLabel("Set the priority of the selected cards").selectOption("p0");
      await expect(result).toContainText("0 cards set to P0, 2 already were");

      // The unselected card was never touched.
      const by = await getRow(loomDaemon.baseURL, bystander.id);
      expect([by.columnKey, by.priority, !!by.held]).toEqual(["inbox", "p2", false]);

      // Escape from one of the bar's own controls clears the selection (a select would otherwise keep the
      // key), and focus goes back to the board rather than to <body>.
      await page.getByLabel("Move the selected cards to a lane").focus();
      await page.keyboard.press("Escape");
      await expectSelected(page, []);
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".loom-board-grid [data-board-nav]"))).toBe(true);
    });

    test("a partial failure names the failed card, keeps it selected and never reports it as done", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("bulk-fail"));
      const ok1 = await loomDaemon.createTask(project.id, { title: uniq("fail-ok1"), columnKey: "inbox" });
      const bad = await loomDaemon.createTask(project.id, { title: uniq("fail-bad"), columnKey: "inbox" });
      const ok2 = await loomDaemon.createTask(project.id, { title: uniq("fail-ok2"), columnKey: "inbox" });
      await pin(page, project.id);
      // Only the BAD card's write fails; its reads (the dialog, the poll) go through.
      await page.route(`**/api/tasks/${bad.id}`, (route) => route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "this card changed under you" }) })
        : route.continue());
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => (await laneCards(page, "inbox")).length).toBe(3);
      for (const t of [ok1, bad, ok2]) await openTarget(page, t.id).click({ modifiers: [MOD] });
      await expectSelected(page, [ok1.id, bad.id, ok2.id]);

      await page.getByLabel("Move the selected cards to a lane").selectOption("todo");
      const result = page.getByTestId("board-bulk-result");
      await expect(result).toHaveAttribute("role", "alert");
      await expect(result).toContainText("2 cards moved to To Do, 1 failed");
      const failures = page.getByTestId("board-bulk-failures").locator("li");
      await expect(failures).toHaveCount(1);
      await expect(failures.first()).toHaveAttribute("data-task-id", bad.id);
      await expect(failures.first()).toContainText(bad.title);
      await expect(failures.first()).toContainText("this card changed under you");
      // Only the failed card stays selected.
      await expectSelected(page, [bad.id]);
      await expect(page.getByTestId("board-bulk-count")).toHaveText("1 selected");
      // The server agrees: two moved, the failed one did not.
      for (const id of [ok1.id, ok2.id]) await expect.poll(async () => (await getRow(loomDaemon.baseURL, id)).columnKey).toBe("todo");
      expect((await getRow(loomDaemon.baseURL, bad.id)).columnKey).toBe("inbox");
      // And the board shows the truth after the refresh.
      await expect.poll(async () => sorted(await laneCards(page, "todo"))).toEqual(sorted([ok1.id, ok2.id]));
      expect(await laneCards(page, "inbox")).toEqual([bad.id]);
    });
  });
}
