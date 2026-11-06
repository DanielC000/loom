// Companion AUTO-RECYCLE opt-in toggle e2e (card 1837a542). The toggle is the owner's per-Companion, default-OFF
// switch for "recycle me by yourself when my context is exhausted". NOT route-mocked: the PUT hits the fixture
// daemon's real human-only route, and the spec proves the state change on BOTH sides — the checkbox flips, and
// the daemon's stored config read agrees (before: false, after: true, then false again) — and that it survives a
// reload (the checkbox state is read back from the daemon, not local UI state). The recycle itself needs a real
// claude spawn, so it is covered by packages/daemon/test/companion-auto-recycle.mjs.
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

async function focusCompanion(page: Page, name: string) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const picker = page.getByRole("group", { name: "Select companion" });
  if ((await picker.count()) === 0) return;
  const button = picker.getByRole("button", { name });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("the auto-recycle toggle is off by default, and flipping it persists on the daemon (human-only PUT) across a reload", async ({ page, loomDaemon }) => {
  const name = `AutoRecycle-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name, contextExhausted: false });
  seededConfigSessionIds.push(companion.sessionId);

  const stored = async (): Promise<boolean> => {
    const res = await page.request.get(`${loomDaemon.baseURL}/api/companion/config/${companion.sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()).autoRecycleOnExhaustion as boolean;
  };

  const puts: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith(`/api/companion/${companion.sessionId}/auto-recycle`)) puts.push(`${req.method()} ${req.postData()}`);
  });

  // BEFORE: the daemon stores false and the checkbox is unchecked.
  expect(await stored()).toBe(false);
  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);
  const toggle = page.locator(`[data-testid="companion-auto-recycle"][data-session-id="${companion.sessionId}"]`).getByTestId("companion-auto-recycle-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).not.toBeChecked();
  expect(puts).toHaveLength(0);

  // AFTER: one PUT {true}, the checkbox is checked and the daemon agrees.
  await toggle.click(); // controlled input: flips only after the PUT + refetch, so not .check() (it asserts an immediate flip)
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toBe('PUT {"autoRecycleOnExhaustion":true}');
  await expect(toggle).toBeChecked();
  await expect.poll(stored).toBe(true);

  // Survives a reload (read back from the daemon's masked config).
  await page.reload();
  await focusCompanion(page, name);
  await expect(toggle).toBeChecked({ timeout: 15_000 });

  // And back OFF.
  await toggle.click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toBe('PUT {"autoRecycleOnExhaustion":false}');
  await expect.poll(stored).toBe(false);
  await expect(toggle).not.toBeChecked();
});
