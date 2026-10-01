// Board task-drawer error state (card 3485a489). A DONE card's body is omitted from the board-list
// response (card 4fa2c146), so opening its drawer always depends on the lazy GET /api/tasks/:id fetch
// (Board.tsx's `needsBodyFetch`/`taskDetail`). Before this card, a failure on that fetch (e.g. a remote
// bind with no Tier-1 route for it) left the drawer spinning on "Loading task…" forever — `drawerTask`
// never resolves, so the render fell back to TaskDrawerLoading with no error path out. This spec forces
// that fetch to fail and asserts an observable error state (not an infinite spinner), plus a working
// retry and close.
//
// Determinism (same as board.spec.ts / board-task-modal.spec.ts): the board is scoped to the ACTIVE
// project (localStorage `loom.projectId`) and the worker-scoped daemon is SHARED across specs, so each
// test seeds its OWN project and PINS it active BEFORE navigating.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("a failed single-task fetch shows an error state in the drawer, not an endless spinner", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-drawer-error-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // DONE (the project's default terminal column) — its body is omitted from the board list, so opening
  // it always depends on the single-task fetch this spec forces to fail.
  const title = uniq("drawer-error-card");
  const body = `body ${uniq("desc")}`;
  const task = await loomDaemon.createTask(project.id, { title, body, columnKey: "done" });

  // Force GET /api/tasks/:id to 500 for this one task; leave every other route (incl. the board list)
  // untouched so the card itself renders normally.
  let failRequests = true;
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (!failRequests) return route.fallback();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure (card 3485a489)" }) });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.getByText(title, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The error state renders — never the permanent "Loading task…" spinner.
  await expect(dialog.getByText("couldn’t load this task")).toBeVisible();
  await expect(dialog.getByText("Loading task…")).toHaveCount(0);

  // Retry: once the route stops failing, clicking retry resolves to the real task body.
  failRequests = false;
  await dialog.getByRole("button", { name: "retry" }).click();
  await expect(dialog.locator("textarea")).toHaveValue(body);

  await dialog.getByRole("button", { name: "✕" }).click();
  await expect(dialog).toHaveCount(0);

  // Second card: confirm "close" works from the ERROR state itself too (not just the loaded drawer).
  const title2 = uniq("drawer-error-close-card");
  const task2 = await loomDaemon.createTask(project.id, { title: title2, body: `body ${uniq("desc2")}`, columnKey: "done" });
  await page.route(`**/api/tasks/${task2.id}`, async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure (card 3485a489)" }) });
  });
  await page.reload();
  await expect(page.getByText(title2, { exact: true })).toBeVisible();
  await page.getByText(title2, { exact: true }).click();
  const dialog2 = page.getByRole("dialog");
  await expect(dialog2.getByText("couldn’t load this task")).toBeVisible();
  await dialog2.getByRole("button", { name: "close" }).click();
  await expect(dialog2).toHaveCount(0);
});
