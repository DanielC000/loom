// Companion RECYCLE control e2e (card 79e030d9). An exhausted Companion (its session carries the terminal
// context-exhaustion mark) shows a "Recycle onto a fresh session" control behind a confirm step; a healthy
// one shows nothing. The POST itself is ROUTE-MOCKED: the fixture daemon's no-spawn guard forbids a real
// claude, and a real recycle spawns a fresh engine session. The daemon-side behaviour (bindings, alerts,
// trust, notice, stale-transcript) is covered by packages/daemon/test/companion-recycle.mjs; this spec
// proves only the UI contract — visible iff exhausted, explicit confirm, the right human-only REST call.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true); // a quiet no-op here would break a LATER spec, not this one
  }
});

async function seedTracked(
  loomDaemon: { seedCompanion: (o: { name: string; contextExhausted?: boolean }) => Promise<{ sessionId: string }> },
  prefix: string,
  contextExhausted: boolean,
) {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name, contextExhausted });
  seededConfigSessionIds.push(companion.sessionId);
  return { ...companion, name };
}

async function focusCompanion(page: Page, name: string) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const picker = page.getByRole("group", { name: "Select companion" });
  if ((await picker.count()) === 0) return;
  const button = picker.getByRole("button", { name });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

const control = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="companion-recycle"][data-session-id="${sessionId}"]`);

test("a healthy companion shows no recycle control; an exhausted one shows it, and confirming fires the human-only recycle call", async ({ page, loomDaemon }) => {
  const healthy = await seedTracked(loomDaemon, "Healthy", false);
  const exhausted = await seedTracked(loomDaemon, "Exhausted", true);

  const posts: string[] = [];
  await page.route(`**/api/companion/${exhausted.sessionId}/recycle`, async (route) => {
    posts.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: exhausted.sessionId, session: { id: exhausted.sessionId } }) });
  });

  await page.goto(`${loomDaemon.baseURL}/companion`);

  // NEGATIVE CONTROL: the healthy companion, focused, shows no control at all.
  await focusCompanion(page, healthy.name);
  await expect(control(page, healthy.sessionId)).toHaveCount(0);

  // POSITIVE: the exhausted one shows it (this 0 -> 1 transition is what makes the absence above meaningful).
  await focusCompanion(page, exhausted.name);
  const ctl = control(page, exhausted.sessionId);
  await expect(ctl).toBeVisible({ timeout: 15_000 });
  await expect(ctl).toContainText("out of context");

  // Explicit confirm: starting does NOT fire the call.
  await ctl.getByTestId("companion-recycle-start").click();
  expect(posts).toHaveLength(0);
  await expect(ctl).toContainText("Chat bindings, memory and grants are kept");

  // Cancel backs out without a call.
  await ctl.getByRole("button", { name: "Cancel" }).click();
  expect(posts).toHaveLength(0);

  // Confirm fires exactly one POST to the recycle route.
  await ctl.getByTestId("companion-recycle-start").click();
  await ctl.getByTestId("companion-recycle-go").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toBe(`POST /api/companion/${exhausted.sessionId}/recycle`);
});
