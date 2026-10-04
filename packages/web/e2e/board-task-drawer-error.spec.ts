// Board task-drawer error state (card 3485a489). A DONE card's body is omitted from the board-list
// response (card 4fa2c146), so opening its drawer always depends on the lazy GET /api/tasks/:id fetch
// (Board.tsx's `needsBodyFetch`/`taskDetail`). Before this card, a failure on that fetch (e.g. a remote
// bind with no Tier-1 route for it) left the drawer spinning on "Loading task…" forever — `drawerTask`
// never resolves, so the render fell back to TaskDrawerLoading with no error path out. This spec forces
// that fetch to fail and asserts an observable error state (not an infinite spinner), plus a working
// retry and close.
//
// Card 230cb6e3 then (1) made the retry assertion falsifiable — see the comment at the retry step below
// for why the original one could not fail — and (2) added the second test, for a LIVE card, where the
// SAME failed read never reaches TaskDrawerError at all: a live card's row rides along on the board
// response, so its drawer renders and only the links block goes missing — a false "no links" zero.
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
  // Above the 30s default: the retry step below deliberately waits out one full 4s poll interval to make
  // its assertion window unreachable by the poll (see that step's own comment), and this test also seeds
  // and drives a SECOND card after it.
  test.setTimeout(60_000);
  const project = await loomDaemon.createProject(`board-drawer-error-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // DONE (the project's default terminal column) — its body is omitted from the board list, so opening
  // it always depends on the single-task fetch this spec forces to fail.
  const title = uniq("drawer-error-card");
  const body = `body ${uniq("desc")}`;
  const task = await loomDaemon.createTask(project.id, { title, body, columnKey: "done" });

  // Force GET /api/tasks/:id to 500 for this one task; leave every other route (incl. the board list)
  // untouched so the card itself renders normally.
  // `detailRequests` counts EVERY hit on this route, whatever the handler then does with it — the retry
  // assertion below needs to see the request itself, not just its effect on the drawer (card 230cb6e3).
  let detailRequests = 0;
  let failRequests = true;
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    detailRequests++;
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

  // Retry (card 230cb6e3 item 1). The original form of this step — drop the failure, click retry, assert
  // the body appears — COULD NOT FAIL: the drawer query polls at refetchInterval 4000 and keeps polling in
  // its error state, so the next poll heals the drawer within the 5s expect timeout whether or not the
  // button is wired to anything. Assert the REQUEST instead, in a window the poll cannot reach:
  //
  //   1. wait for one poll to land — that puts the next one a full interval out, and
  //   2. require a request within a window well under that interval.
  //
  // With `onRetry` stubbed to a no-op the window stays empty and step 2 fails, which is what makes this a
  // control rather than a tautology. (Verified red against exactly that stub.)
  const atErrorState = detailRequests;
  await expect.poll(() => detailRequests, { timeout: 10_000, intervals: [100] }).toBeGreaterThan(atErrorState);

  failRequests = false;
  const beforeRetry = detailRequests;
  await dialog.getByRole("button", { name: "retry" }).click();
  await expect.poll(() => detailRequests, { timeout: 1_200, intervals: [50] }).toBeGreaterThan(beforeRetry);
  // …and that refetch is the one that resolves the drawer to the real task body.
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

// Card 230cb6e3 item 2 — the live-card half of the same failed read. A LIVE (non-terminal) card keeps its
// full `body` on the board list (card 4fa2c146), so `needsBodyFetch` is false: TaskDrawerError never
// fires and the real drawer renders off the board row. But parent/children/relations live ONLY on the
// single-task read, so when that read fails the links block is simply absent — byte-identical to a card
// that genuinely has no connections. This test pins the line that distinguishes the two.
test("a live card whose detail read fails says its links are unavailable, not that it has none", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-drawer-links-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("drawer-links-card");
  const body = `body ${uniq("desc")}`;
  const task = await loomDaemon.createTask(project.id, { title, body, columnKey: "backlog" });

  let failRequests = true;
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (!failRequests) return route.fallback();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure (card 230cb6e3)" }) });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByText(title, { exact: true }).click();

  const dialog = page.getByRole("dialog");
  // The REAL drawer, editable body and all — never the error placeholder. This is the distinction the
  // test rests on: TaskDrawerError is unreachable here, so the drawer itself has to carry the signal.
  await expect(dialog.locator("textarea")).toHaveValue(body);
  await expect(dialog.getByText("couldn’t load this task")).toHaveCount(0);

  // The false zero this card fixes: before it, the drawer rendered with no links block at all.
  await expect(dialog.getByText("links unavailable", { exact: false })).toBeVisible();

  // And it is transient, not sticky: the 4s poll underneath keeps retrying, so letting the route recover
  // clears the line with no reopen and no manual retry.
  failRequests = false;
  await expect(dialog.getByText("links unavailable", { exact: false })).toHaveCount(0, { timeout: 10_000 });
});
