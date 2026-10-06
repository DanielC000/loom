// Companion "Initial chat id" seed-vs-routing labelling e2e (card 72bd4322, from card a8480338's review).
//
// THE DEFECT: a8480338 narrowed the bootstrap binding-seed to fire only while `bindings_seeded` is false,
// so once a companion has been bound, editing `allowedChatId` no longer re-binds anything — the only
// rebind path is POST /api/companion/bindings. The Manage tab's hint still claimed "editing this only
// changes the boot-seed default the daemon reads on a cold start", which is false after the first seed.
//
// WHAT THIS PINS, and why it needs the server round-trip rather than a render check: the hint is
// STATE-AWARE off `CompanionConfigMasked.bindingsSeeded` (added by this card). The flag cannot be derived
// from the bindings list — a NON-EMPTY list does imply seeded, but ZERO bindings is ambiguous between
// never-seeded and seeded-then-REVOKED, and collapsing those two is exactly the bug a8480338 fixed. So the
// spec drives the REAL binding write and asserts both the wire flag and the copy that hangs off it, in
// both polarities. A one-state check would pass against a hardcoded string.
//
// It also pins the half the card's premise got wrong: `allowedChatId` is NOT inert once seeded — it stays
// the fallback proactive home (`homeChatId: home?.chatId ?? row.allowedChatId`, companion/store.ts)
// whenever no explicit home is set, which is why the field stays EDITABLE rather than going read-only.
//
// CROSS-SPEC CLEANUP: same load-bearing discipline as companion-heartbeat-prompt-default.spec.ts — the
// shared e2e daemon never drops a `companion_config` row on session-archive alone, and a leftover row is
// another candidate in the Companion page's "focus the most active companion" tie-break. This spec deletes
// its own binding and config rows, and asserts each delete actually succeeded (a loopback WRITE is
// bearer-gated, so a cleanup missing the header 401s silently and only ever breaks a LATER spec).
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

test("Manage tab: the initial chat id is labelled as seed + default home, and the seed clause flips once bound", async ({ page, loomDaemon }) => {
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  // A NUMERIC allowedChatId: a dm-scope telegram binding with a non-numeric chatId is refused outright at
  // the upsert chokepoint (card 94754bbe), so a non-numeric seed could never reach the bound state below.
  const chatId = "999";
  const companion = await loomDaemon.seedCompanion({ name, allowedChatId: chatId });
  seededConfigSessionIds.push(companion.sessionId);

  const configUrl = `${loomDaemon.baseURL}/api/companion/config/${companion.sessionId}`;

  // ── State 1: NOT seeded ────────────────────────────────────────────────────────────────────────────
  // Server-side contract first: a freshly seeded config row has never been bound, so the flag is false.
  // (upsertCompanionConfig has no bindingsSeeded input — a new row derives EXISTS(binding for this
  // session), which is 0 here since the test-seed handler never writes one.)
  const preBody = await (await page.request.get(configUrl)).json();
  expect(preBody.bindingsSeeded).toBe(false);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  // Focus OUR companion (the picker renders with >1 companion on the shared worker daemon).
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  // SCOPED to "Run configuration" — the Persona section below has its own "Edit" button, and an unscoped
  // match violates Playwright's strict mode.
  const configSection = page.locator("section").filter({ hasText: "Run configuration" });

  // The read-only summary chip names it as the INITIAL chat, not a live "chat" route.
  await expect(configSection.getByText("initial chat", { exact: true })).toBeVisible();

  await configSection.getByRole("button", { name: "Edit" }).click();

  // The field is relabelled, and is still EDITABLE (it remains the fallback proactive home). `Field`
  // wraps its control in a <label>, so the input is reachable by its accessible name.
  const chatInput = configSection.getByLabel(/Initial chat id/);
  await expect(chatInput).toHaveValue(chatId);
  await expect(chatInput).toBeEditable();

  // Not seeded ⇒ the seed clause is in its FUTURE form, and the Access pointer is present either way.
  await expect(configSection.getByText(/this seeds the first one on the next daemon start/)).toBeVisible();
  await expect(configSection.getByText(/no longer seeds one/)).toHaveCount(0);
  await expect(configSection.getByText(/Inbound routing is owned by the binding under/)).toBeVisible();
  // The second job the field still does, regardless of seed state.
  await expect(configSection.getByText(/default\s+Proactive home\s+while none is set/s)).toBeVisible();

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

  // Seeded ⇒ the clause flips to the PAST form and points at the rebind action.
  await expect(configSection2.getByText(/no longer seeds one/)).toBeVisible();
  await expect(configSection2.getByText(/rebind there to move where messages arrive/)).toBeVisible();
  await expect(configSection2.getByText(/this seeds the first one on the next daemon start/)).toHaveCount(0);
  // Still editable, still disclosing the proactive-home job — the field never goes read-only.
  await expect(configSection2.getByText(/default\s+Proactive home\s+while none is set/s)).toBeVisible();
  await expect(configSection2.getByLabel(/Initial chat id/)).toBeEditable();
});
