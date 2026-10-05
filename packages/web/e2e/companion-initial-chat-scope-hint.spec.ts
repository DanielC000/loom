// Companion "Initial chat scope" seed-state labelling e2e (card 5b6f30c1, from card 72bd4322's review).
//
// THE DEFECT: the Manage tab's "Chat scope" sub-label read "boot-seed default · routing lives in Access"
// unconditionally. `chatScope`'s only consumer is the one-shot first-binding seed (companion/factory.ts,
// gated on `!cfg.bindingsSeeded` since card a8480338), so "boot-seed default" is false once seeded —
// exactly the staleness card 72bd4322 fixed for the sibling `allowedChatId` field.
//
// THE ASYMMETRY THIS PINS, and why the copy differs from allowedChatId's: `allowedChatId` keeps a SECOND
// LIVE JOB after seeding — it stays the fallback proactive home (`homeChatId: home?.chatId ??
// row.allowedChatId`, companion/store.ts) — so its hint discloses that job in BOTH states. `chatScope` has
// NO such second job: live per-sender authorization reads the BINDING's own `scope` (companion/auth.ts),
// never the config's, so once seeded the field genuinely affects nothing. The seeded copy therefore says so
// plainly and points at Access, where a rebind upserts the real scope (ON CONFLICT(session_id, channel) DO
// UPDATE SET scope). A spec that asserted a proactive-home clause here would be wrong, not just redundant.
//
// WHY THIS NEEDS THE SERVER ROUND-TRIP rather than a render check: the copy is state-aware off
// `CompanionConfigMasked.bindingsSeeded`. That flag cannot be derived from the bindings list — a NON-EMPTY
// list does imply seeded, but ZERO bindings is ambiguous between never-seeded and seeded-then-REVOKED, and
// collapsing those two is exactly the bug a8480338 fixed. So the spec drives the REAL binding write and
// asserts both polarities, each with the OTHER state's copy asserted ABSENT — a one-state check, or one
// without the negative control, would pass against a hardcoded string.
//
// ISOLATION: a unique bot token, not just a unique name. `checkTokenCollision` (gateway/server.ts) refuses
// any config write arming a Telegram token another ENABLED companion already holds, and the fixture's
// default token is shared by every seeded companion whose `companion_config` row outlived its session
// (rows survive session-archive alone) — card 02f0e8a6. This spec never PATCHes config, so the collision
// could not bite it today, but a unique token costs nothing and keeps that true if an assertion is added.
//
// CROSS-SPEC CLEANUP: the shared e2e daemon never drops a `companion_config` row on session-archive, and a
// leftover row is another candidate in the Companion page's "focus the most active companion" tie-break.
// This spec deletes its own binding and config rows and asserts each delete succeeded — a loopback WRITE is
// bearer-gated, so a cleanup missing the header 401s silently and only ever breaks a LATER spec.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const auth = { authorization: `Bearer ${loomDaemon.loopbackSecret}` };
    // Drop the binding first, then the config. Asserting both keeps a silent 401 from leaking rows.
    const binding = await page.request.delete(
      `${loomDaemon.baseURL}/api/companion/bindings/${sessionId}?channel=telegram`, { headers: auth },
    );
    expect(binding.ok()).toBe(true);
    const config = await page.request.delete(
      `${loomDaemon.baseURL}/api/companion/config/${sessionId}`, { headers: auth },
    );
    expect(config.ok()).toBe(true);
  }
});

test("Manage tab: the chat scope is labelled as the first-binding seed, and goes to no-effect once bound", async ({ page, loomDaemon }) => {
  const name = `Scope-${randomUUID().slice(0, 8)}`;
  // A NUMERIC allowedChatId: a dm-scope telegram binding with a non-numeric chatId is refused outright at
  // the upsert chokepoint (card 94754bbe), so a non-numeric seed could never reach the bound state below.
  const chatId = "999";
  const companion = await loomDaemon.seedCompanion({
    name, allowedChatId: chatId, botToken: `123456:scope-${randomUUID().slice(0, 8)}`,
  });
  seededConfigSessionIds.push(companion.sessionId);

  const configUrl = `${loomDaemon.baseURL}/api/companion/config/${companion.sessionId}`;

  // ── State 1: NOT seeded ────────────────────────────────────────────────────────────────────────────
  // Server-side contract first: a freshly seeded config row has never been bound, so the flag is false.
  // (The test-seed handler never passes bindingsSeeded, and upsertCompanionConfig defaults a new row to 0.)
  const preBody = await (await page.request.get(configUrl)).json();
  expect(preBody.bindingsSeeded).toBe(false);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  // Focus OUR companion (the picker renders with >1 companion on the shared worker daemon). The click is
  // necessarily conditional, but the identity assertion after it must not be — see
  // companion-initial-chat-seed-hint.spec.ts for the same ordering.
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  // SCOPED to "Run configuration" — the Persona section below has its own "Edit" button, and an unscoped
  // match violates Playwright's strict mode.
  const configSection = page.locator("section").filter({ hasText: "Run configuration" });

  // The read-only summary chip names it as the INITIAL scope, not a live "scope".
  await expect(configSection.getByText("initial scope", { exact: true })).toBeVisible();

  await configSection.getByRole("button", { name: "Edit" }).click();

  // The control is relabelled and still editable — the seed has not fired yet, so it is still live input.
  // `Field` wraps its control in a <label>, so the select is reachable by its accessible name.
  const scopeSelect = configSection.getByLabel(/Initial chat scope/);
  await expect(scopeSelect).toHaveValue("dm");
  await expect(scopeSelect).toBeEditable();

  // Not seeded ⇒ the FUTURE form, and the stale unconditional copy is gone for good.
  await expect(configSection.getByText(/seeds the first binding's scope · no effect once seeded/)).toBeVisible();
  // Negative controls for state 1: neither the seeded copy nor the old stale label may appear.
  await expect(configSection.getByText(/already seeded · no effect now/)).toHaveCount(0);
  await expect(configSection.getByText(/boot-seed default/)).toHaveCount(0);
  // The asymmetry with allowedChatId: chatScope has no proactive-home job, so it must claim none. Scoped to
  // this field's OWN <label> — an unscoped getByText would match the form ANCESTOR that also contains the
  // allowedChatId hint, where "Proactive home" legitimately appears, and fail for the wrong reason.
  const scopeField = configSection.locator("label").filter({ hasText: "Initial chat scope" });
  await expect(scopeField).toHaveCount(1);
  await expect(scopeField).not.toContainText("Proactive home");
  // Positive control for that scoping: the sibling allowedChatId field DOES disclose the home job, so the
  // "not.toContainText" above is a real check and not a locator that silently matches nothing meaningful.
  await expect(configSection.locator("label").filter({ hasText: "Initial chat id" })).toContainText("Proactive home");

  // ── Flip to State 2 via the REAL rebind path ───────────────────────────────────────────────────────
  // POST /api/companion/bindings is the production rebind write, and it marks bindings_seeded in the SAME
  // transaction (card 3d19ecc7) — nothing here hand-sets the flag, so a broken marker fails this spec.
  const bound = await page.request.post(`${loomDaemon.baseURL}/api/companion/bindings`, {
    headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    data: { sessionId: companion.sessionId, channel: "telegram", chatId, scope: "dm" },
  });
  expect(bound.ok()).toBe(true);

  const postBody = await (await page.request.get(configUrl)).json();
  expect(postBody.bindingsSeeded).toBe(true);

  // ── State 2: SEEDED ───────────────────────────────────────────────────────────────────────────────
  await page.reload();
  const pickerBtn2 = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn2.count()) {
    await pickerBtn2.click();
    await expect(pickerBtn2).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();
  const configSection2 = page.locator("section").filter({ hasText: "Run configuration" });
  await configSection2.getByRole("button", { name: "Edit" }).click();

  // Seeded ⇒ the copy flips to the PAST form, states the no-effect plainly, and points at Access.
  await expect(configSection2.getByText(/already seeded · no effect now · scope lives in Access/)).toBeVisible();
  // Negative control for state 2: the unseeded future-form copy must be gone.
  await expect(configSection2.getByText(/seeds the first binding's scope · no effect once seeded/)).toHaveCount(0);
  await expect(configSection2.getByText(/boot-seed default/)).toHaveCount(0);
  // Still EDITABLE rather than read-only: a save is still the only way to move the row's stored value, and
  // the write-time dm/numeric-chat-id validator (gateway/server.ts) still reads it on every save.
  await expect(configSection2.getByLabel(/Initial chat scope/)).toBeEditable();
});
