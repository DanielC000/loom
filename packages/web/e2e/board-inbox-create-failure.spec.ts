// Card a1ec70a6 item 2 — Board's Add-to-Inbox field cleared the typed title in the same tick it fired the
// create, so a 400/401 left the user with an error message and no text (the owner's never-clobber-user-input
// rule). The clear is now an effect of SUCCESS, awaited.
//
// This is the WIRING proof that test/draft-submit.mjs (the ordering algebra) structurally cannot give: a
// pure test can't see WHEN this component calls its clear. The create is failed by intercepting the real
// POST, so the failure is the production error path (inline `create.error` via meta.inlineError), not a
// stubbed-out component.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test("a FAILED Add-to-Inbox keeps the typed title, and the retry after it succeeds", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`inbox-fail-${Date.now()}`);
  await pinActiveProject(page, project.id);

  let failCreates = true;
  await page.route(`**/api/projects/${project.id}/tasks`, async (route) => {
    if (route.request().method() !== "POST" || !failCreates) return route.fallback();
    await route.fulfill({
      status: 400, contentType: "application/json",
      body: JSON.stringify({ error: "forced failure (card a1ec70a6)" }),
    });
  });

  await page.goto(`${loomDaemon.baseURL}/board`);
  const field = page.getByPlaceholder("new task title");
  const addButton = page.getByRole("button", { name: "Add to Inbox" });
  await expect(addButton).toBeVisible();

  const title = `inbox-survives-failure-${Date.now()}`;
  await field.fill(title);
  await addButton.click();

  // 1. The failure is surfaced inline (no blocking modal — meta.inlineError). Filtered rather than a bare
  //    getByRole("alert"), so an unrelated attention alert elsewhere on the page can't satisfy it.
  await expect(page.getByRole("alert").filter({ hasText: "forced failure (card a1ec70a6)" })).toBeVisible();

  // 2. THE CARD'S CASE: the typed title is still there, byte-for-byte. Pre-fix it was "".
  await expect(field).toHaveValue(title);

  // 3. Nothing was created — the title survived because the write failed, not because it half-succeeded.
  const afterFail = await (await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`)).json();
  expect((afterFail as { title: string }[]).map((t) => t.title)).not.toContain(title);

  // 4. And the obvious next thing the user does — fix the cause and click again — works off the SAME typed
  //    text, with no retyping. This is also the control that the surviving value is genuinely submittable
  //    rather than a stale render: it has to produce a real card.
  failCreates = false;
  await addButton.click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(field).toHaveValue("", { timeout: 10_000 }); // cleared NOW, on the success
  const afterSuccess = await (await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`)).json();
  expect((afterSuccess as { title: string }[]).filter((t) => t.title === title)).toHaveLength(1);
});
