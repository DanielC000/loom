// Companion heartbeat-prompt default-pinning e2e (card b95e3bd0).
//
// THE BUG: `maskCompanionConfig` used to resolve an UNSET override straight to the default text
// (`row.heartbeatPrompt || DEFAULT_HEARTBEAT_PROMPT`), so the Manage-tab edit form seeded its textarea
// with that resolved default. Any SUBSEQUENT save — even one that only touched an unrelated field —
// sent that seeded text back as a literal `heartbeatPrompt`, permanently PINNING today's default as a
// stored override. A companion that was inheriting the default silently stopped tracking future changes
// to it. The fix carries the RAW stored value (null when unset) separately from the resolved default, so
// the form seeds an EMPTY field (showing the default only as a placeholder) and an unrelated save sends
// `null`, not the default text.
//
// WHY THIS IS A ROUND-TRIP SPEC, NOT A RENDER CHECK: the defective and fixed masked reads both show
// human-identical TEXT today (the stored override, once pinned, is character-identical to the current
// default) — the observable difference is in the WIRE SHAPE (`null` vs a literal string), which only a
// real save-and-re-read round trip can surface. A bare "the field shows the default" render check would
// pass on both the broken and fixed code.
//
// SEEDING: `loomDaemon.seedCompanion()` creates a config row with NO `heartbeatPrompt` in its seed body
// (gateway/server.ts's seed handler defaults the omitted field to `null`), so it reproduces the exact
// "inheriting the default, nothing stored" starting state the bug needs.
//
// CROSS-SPEC CLEANUP: same load-bearing discipline as companion-zero-reply-alert.spec.ts — the shared e2e
// daemon never drops a `companion_config` row on session-archive alone, and a leftover row is another
// candidate in the Companion page's own "focus the most active companion" tie-break. This spec deletes
// its own config row.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true);
  }
});

test("Manage tab: an unrelated save never pins the default heartbeat prompt as a stored override", async ({ page, loomDaemon }) => {
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  seededConfigSessionIds.push(companion.sessionId);

  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Focus OUR companion (the picker renders with >1 companion on the shared worker daemon).
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  // Sanity: the server-side contract itself, BEFORE any UI interaction — a row seeded with no override
  // reads back raw null (never the resolved default) alongside the separate default field.
  const preEdit = await page.request.get(`${loomDaemon.baseURL}/api/companion/config/${companion.sessionId}`);
  const preBody = await preEdit.json();
  expect(preBody.heartbeatPrompt).toBeNull();
  expect(preBody.heartbeatPromptDefault).toContain("Proactive check-in");

  // Open the edit form. SCOPED to "Run configuration" — the Persona section below also has its own
  // "Edit" button, and an unscoped match violates Playwright's strict mode.
  const configSection = page.locator("section").filter({ hasText: "Run configuration" });
  await configSection.getByRole("button", { name: "Edit" }).click();

  // The heartbeat-prompt textarea must render EMPTY — never seeded with the resolved default text —
  // with that default shown only as a placeholder.
  const prompt = configSection.locator("textarea");
  await expect(prompt).toHaveValue("");
  await expect(prompt).toHaveAttribute("placeholder", /Proactive check-in/);

  // Touch only an UNRELATED field (the heartbeat cadence) — never the prompt textarea — then Save.
  const cadence = configSection.getByRole("spinbutton");
  await cadence.fill("45");
  await configSection.getByRole("button", { name: "Save" }).click();
  await expect(configSection.getByRole("button", { name: "Save" })).toHaveCount(0); // editing closed on success

  // The cadence change landed (proves the save actually round-tripped)... SCOPED to our config section —
  // a page-wide match risks a strict-mode violation if another seeded companion on the shared worker
  // daemon happens to render the same "45m" chip text.
  await expect(configSection.getByText("45m", { exact: true })).toBeVisible();

  // ...and the heartbeat prompt override is STILL unset — the unrelated save must never have pinned the
  // default text as a literal stored value.
  const postSave = await page.request.get(`${loomDaemon.baseURL}/api/companion/config/${companion.sessionId}`);
  const postBody = await postSave.json();
  expect(postBody.heartbeatPrompt).toBeNull();
});
