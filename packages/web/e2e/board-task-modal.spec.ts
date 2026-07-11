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

// Responsive width cap (owner fast-track: the modal was too narrow — a fixed 520px — on a large window;
// it now uses `min(820px, 92vw)`, so it grows wide on a big viewport and still pads inside a phone one).
test("the detail modal widens on a large viewport and never overflows a narrow one", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-modal-width-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("width-card");
  const task = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });

  const panel = () => page.getByRole("dialog").locator("> div");

  // LARGE viewport: the panel reaches its 820px cap (well past the old 520px), not merely a slice of the
  // window (92vw of 1600 = 1472, so the 820px min() branch is what caps it).
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(task.id)}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  const wide = await panel().boundingBox();
  expect(wide).not.toBeNull();
  expect(Math.round(wide!.width)).toBe(820);

  // NARROW (phone) viewport: the panel falls back to 92vw and stays fully inside the window with padding
  // on both sides — it must never overflow (width ≤ viewport, and both edges clear of 0/viewport width).
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await panel().boundingBox();
  expect(narrow).not.toBeNull();
  expect(narrow!.width).toBeLessThanOrEqual(390);
  expect(narrow!.x).toBeGreaterThan(0);
  expect(narrow!.x + narrow!.width).toBeLessThan(390);
  // 92vw of 390 ≈ 359, so the padded panel is clearly narrower than the full window.
  expect(narrow!.width).toBeLessThan(370);
});

// Responsive height cap (owner fast-track sibling to the width change above: the modal was wide enough
// but too SHORT — content-height (~620px) — on a large window; it now uses `minHeight: min(820px, 85vh)`
// + `maxHeight: 88vh`, so the panel grows tall on a big viewport (the flex:1 description absorbs the room)
// and still fits — panel-scrolling, never overflowing — on a short/phone one).
test("the detail modal grows taller on a tall viewport and always fits a short one", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-modal-height-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("height-card");
  const task = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });

  const panel = () => page.getByRole("dialog").locator("> div");

  // TALL viewport: 85vh of 1000 = 850, so the 820px floor is what sizes it — the panel reaches its
  // min-height (measured 820, well past the ~620px content-height it used to be) and never exceeds the
  // 88vh cap (= 880).
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(task.id)}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  const tall = await panel().boundingBox();
  expect(tall).not.toBeNull();
  // Clearly taller than the old content-height (~620px): the 820px floor, and capped under 88vh.
  expect(tall!.height).toBeGreaterThanOrEqual(780);
  expect(tall!.height).toBeLessThanOrEqual(0.88 * 1000 + 1);
  // Fully inside the window, top and bottom.
  expect(tall!.y).toBeGreaterThan(0);
  expect(tall!.y + tall!.height).toBeLessThanOrEqual(1000);

  // SHORT (phone) viewport: the floor collapses to 82vh and the 88vh cap keeps the panel inside the
  // window — it must never overflow the bottom (top ≥ 0, bottom edge clear of the viewport height).
  await page.setViewportSize({ width: 390, height: 600 });
  const short = await panel().boundingBox();
  expect(short).not.toBeNull();
  expect(short!.height).toBeLessThanOrEqual(0.88 * 600 + 1);
  expect(short!.y).toBeGreaterThanOrEqual(0);
  expect(short!.y + short!.height).toBeLessThanOrEqual(600);
});
