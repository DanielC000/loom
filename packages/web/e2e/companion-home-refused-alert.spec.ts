// Companion HOME-ROUTE-REFUSED alert e2e (card 1b0df437 Code Review, item 1) — the matching NAMED READER
// for `CompanionReplyStatus.homeRouteRefused`, the SEPARATE field from `alerting` (see
// companion-zero-reply-alert.spec.ts) this card adds.
//
// The motivating case: an owner with a bad/unbound companion HOME burns a turn per heartbeat/reminder/
// attention-push, with nothing in the UI telling them why. This spec proves the new banner reaches a
// human, AND that it is a genuinely SEPARATE surface from the zero-reply alert — reusing that alert's
// copy ("has stopped replying... check its Terminal tab") would misdirect the owner toward the wrong
// diagnosis for a companion that may be perfectly healthy, just mis-homed.
//
// WHY THIS IS A BEFORE/AFTER SPEC, NOT A RENDER CHECK: see companion-zero-reply-alert.spec.ts's own header
// — an inert banner passes any "the page loads" assertion forever. The transitions are the evidence.
//
// SEEDING: `loomDaemon.seedCompanionHome` is a DIRECT `db.setCompanionHome` write (test-only
// POST /internal/test/seed), bypassing `validateHomeTarget` — the ONLY way an e2e spec can reach "home
// set, no live binding backing it" at all, since every PRODUCTION write path either validates liveness up
// front (`PUT /api/companion/home` 400s without a live binding) or reconciles it away on the next binding
// mutation (see server.ts's own doc on the seed field). The RECOVERY test then binds that SAME chat via
// the REAL `POST /api/companion/bindings` route, proving the field is LIVE-derived (self-heals), not
// latched off the durable `companion_unbound_route_refused` event.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

const alertFor = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="companion-home-refused-alert"][data-session-id="${sessionId}"]`);

// Same cross-spec cleanup discipline as companion-zero-reply-alert.spec.ts — the e2e daemon is SHARED
// across spec files, and a leftover `companion_config` row is another candidate in the Companion page's
// own "focus the most active companion" tie-break.
const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true);
  }
});

async function seedTracked(
  loomDaemon: { seedCompanion: (o: { name: string }) => Promise<{ sessionId: string }> },
  prefix: string,
) {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  seededConfigSessionIds.push(companion.sessionId);
  return { ...companion, name };
}

/** Mirrors companion-zero-reply-alert.spec.ts's own `focusCompanion` — see its doc for the race it avoids. */
async function focusCompanion(page: Page, name: string) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const picker = page.getByRole("group", { name: "Select companion" });
  if ((await picker.count()) === 0) return;
  const button = picker.getByRole("button", { name });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("the chat panel shows no home-refused alert for a companion with no home, and shows one once a stale home is seeded", async ({ page, loomDaemon }) => {
  const { name, ...companion } = await seedTracked(loomDaemon, "HomeRefused");

  // -- BEFORE: no home set at all ------------------------------------------------------------------------
  const before = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(before.sessionId).toBe(companion.sessionId);
  expect(before.homeRouteRefused).toBe(false);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);
  await expect(alertFor(page, companion.sessionId)).toHaveCount(0);

  // -- DRIVE: seed a home with NO live binding backing it ------------------------------------------------
  await loomDaemon.seedCompanionHome(companion.sessionId, { channel: "telegram", chatId: `${Date.now()}1` });

  const after = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(after.homeRouteRefused).toBe(true);

  // -- AFTER: the panel polls the status read, so the banner appears with no reload ----------------------
  const alert = alertFor(page, companion.sessionId);
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("home route is refused");
  await expect(alert).toContainText("Proactive home");
  await expect(alert).toHaveAttribute("role", "alert");

  // It must NEVER be the zero-reply alert's own copy — the two causes stay on separate surfaces.
  await expect(alert).not.toContainText("has stopped replying");
});

test("the home-refused alert clears once the route is actually bound — it tracks live state, not a one-way latch", async ({ page, loomDaemon }) => {
  const { name, ...companion } = await seedTracked(loomDaemon, "HomeRefused");
  const chatId = `${Date.now()}2`;
  await loomDaemon.seedCompanionHome(companion.sessionId, { channel: "telegram", chatId });

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);
  const alert = alertFor(page, companion.sessionId);
  await expect(alert).toBeVisible({ timeout: 15_000 });

  // Bind the SAME route via the REAL write path — this is what a human fixing the problem actually does
  // (Companion → Access, or DM pairing), proving the field is LIVE-derived and self-heals on a real fix.
  const bindRes = await page.request.post(`${loomDaemon.baseURL}/api/companion/bindings`, {
    headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    data: { sessionId: companion.sessionId, channel: "telegram", chatId, scope: "dm" },
  });
  expect(bindRes.ok()).toBe(true);

  const cleared = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(cleared.homeRouteRefused).toBe(false);

  await expect(alert).toHaveCount(0, { timeout: 15_000 });
});

test("a companion whose home IS live-bound never shows the alert", async ({ page, loomDaemon }) => {
  // NEGATIVE CONTROL: a home backed by a live binding from the START must never show the banner — a banner
  // keyed on "a home exists" rather than "the home's route has no live binding" would light up here.
  const { name, ...companion } = await seedTracked(loomDaemon, "HomeRefused");
  const chatId = `${Date.now()}3`;
  const bindRes = await page.request.post(`${loomDaemon.baseURL}/api/companion/bindings`, {
    headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    data: { sessionId: companion.sessionId, channel: "telegram", chatId, scope: "dm" },
  });
  expect(bindRes.ok()).toBe(true);
  const homeRes = await page.request.put(`${loomDaemon.baseURL}/api/companion/home`, {
    headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    data: { sessionId: companion.sessionId, channel: "telegram", chatId },
  });
  expect(homeRes.ok()).toBe(true);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);

  const status = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(status.homeRouteRefused).toBe(false);
  await expect(alertFor(page, companion.sessionId)).toHaveCount(0);
});
