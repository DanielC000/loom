// Board task-detail modal e2e (card bb68dc66 — owner drop: "make board card drawer a modal window.
// Everywhere."). The Board task-card detail used to open as a side DRAWER; it now opens as a centered
// MODAL dialog (role=dialog, centered over the current page, Esc / ✕ / click-outside to close),
// mirroring the RequestModal chrome so the two detail surfaces feel like one system. This spec is the
// regression witness for the TWO entry points named in the card — the Board card click and the `?task=`
// deep-link — each EXERCISED with an observable before/after (no dialog → dialog → closed) and asserting
// the URL context is preserved (no navigation away from /board).
//
// Determinism (same as board.spec.ts): the board is scoped to the ACTIVE project (localStorage
// `loom.projectId`) and the worker-scoped daemon is SHARED across specs, so each test seeds its OWN
// project and PINS it active BEFORE navigating.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import path from "node:path";

// Screenshot hook (opt-in via LOOM_E2E_SHOTS, same as board.spec.ts): unset in CI, so this is a no-op
// there. Set it to a dir to persist the rendered modal for a visual review.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (page: Page, name: string) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name) }); };

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// The centered panel is the dialog backdrop's immediate child div; its horizontal center should land on
// the viewport's center (that's what "centered modal" means, vs. the old flex-end slide-over drawer).
async function assertHorizontallyCentered(page: Page) {
  const panel = page.getByRole("dialog").locator("> div");
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  const panelCenter = box!.x + box!.width / 2;
  const viewportCenter = viewport!.width / 2;
  // Tolerance covers sub-pixel layout rounding + the backdrop's symmetric side padding.
  expect(Math.abs(panelCenter - viewportCenter)).toBeLessThan(24);
}

test("Board card click opens the detail as a centered modal (dialog role), URL stays /board, Esc closes", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-modal-click-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("modal-card");
  const body = `body ${uniq("desc")}`;
  const task = await loomDaemon.createTask(project.id, { title, body, columnKey: "todo" });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board`);

  // BEFORE: the card renders and NO dialog is open.
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Click the card body → the detail opens as a modal dialog (not a route push).
  const urlBefore = page.url();
  await page.getByText(title, { exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // It's the task detail: headers with the short id and carries the seeded body in its textarea.
  await expect(dialog.getByText(`Task · ${task.id.slice(0, 8)}`)).toBeVisible();
  await expect(dialog.locator("textarea")).toHaveValue(body);
  // Centered over the page, and the URL never left /board (opened IN PLACE).
  await assertHorizontallyCentered(page);
  await shoot(page, "board-task-modal.png");
  expect(page.url()).toBe(urlBefore);
  await expect(page).toHaveURL(/\/board$/);

  // AFTER: Esc dismisses it in place (observable close), still without a navigation.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board$/);
});

test("the ?task= deep-link opens the detail modal and clears the param; ✕ closes it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-modal-deeplink-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("deeplink-card");
  const task = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });

  await page.setViewportSize({ width: 1280, height: 900 });
  // Deep-link straight into the card's detail (the reverse linked-task chip in a Request navigates here).
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(task.id)}`);

  // The modal opens for the deep-linked card…
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`Task · ${task.id.slice(0, 8)}`)).toBeVisible();
  await assertHorizontallyCentered(page);
  // …and the `?task=` param is consumed/cleared so a later close/reopen won't re-open it — but we stay on /board.
  await expect(page).toHaveURL(/\/board$/);
  expect(page.url()).not.toContain("task=");

  // The ✕ close button dismisses it in place (observable close), no navigation.
  await dialog.getByRole("button", { name: "✕" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board$/);
});
