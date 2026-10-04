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
// @decision 02f0e8a6 — the unique bot token, the asserted save response and the unconditional focus check
// are three independent layers; collapsing any of them re-opens a different hole. Also: this spec deletes
// its own config rows, so it never becomes the leftover that poisons a later sibling.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

const seededConfigSessionIds: string[] = [];

/** Seed a companion that CANNOT collide with a sibling's leftover row: a unique name (so the picker can
 *  target it) AND a unique bot token (so the enabled-token-collision guard can never refuse its saves —
 *  see layer 1 in the header). Registers it for this file's own afterEach cleanup. */
async function seedIsolatedCompanion(loomDaemon: LoomDaemon) {
  const suffix = randomUUID().slice(0, 8);
  const name = `Ada-${suffix}`;
  const companion = await loomDaemon.seedCompanion({ name, botToken: `123456:e2e-heartbeat-${suffix}` });
  seededConfigSessionIds.push(companion.sessionId);
  return { name, companion };
}

/** Focus THIS spec's own companion, then pin that focus by name. The picker only renders with 2+
 *  companions, so the CLICK is necessarily conditional — the identity assertion after it is NOT (layer 3).
 *  Waiting for the chat to settle first is load-bearing: the page's own "focus the most active companion"
 *  effect runs once the companion list resolves and overrides a selection made ahead of it. */
async function focusOwnCompanion(page: import("@playwright/test").Page, name: string) {
  const chat = page.locator("#companion-panel-chat");
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await expect(chat.getByText(name, { exact: true })).toBeVisible();
}

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true);
  }
});

test("Manage tab: an unrelated save never pins the default heartbeat prompt as a stored override", async ({ page, loomDaemon }) => {
  const { name, companion } = await seedIsolatedCompanion(loomDaemon);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  await focusOwnCompanion(page, name);
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
  // Layer 2 (see header): capture the save's OWN response, so a server-side REFUSAL fails here naming the
  // daemon's reason — rather than surfacing only as the form staying open, which says nothing about why.
  const savePut = page.waitForResponse(
    (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/companion/config/${companion.sessionId}`,
  );
  await configSection.getByRole("button", { name: "Save" }).click();
  const saveRes = await savePut;
  expect(saveRes.status(), `the save must be accepted — the daemon refused it: ${await saveRes.text()}`).toBe(200);
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
// ── card e731bc77: the placeholder is the SERVER's resolved default, never a hardcoded constant ──────
//
// THE PRE-EXISTING DEFECT (daemon-side, fixed in `maskCompanionConfig`): `heartbeatPromptDefault` reported
// the built-in `DEFAULT_HEARTBEAT_PROMPT` even for an env-pinned companion, whose unset override actually
// resolves to `LOOM_COMPANION_HEARTBEAT_PROMPT` (the boot path writes env straight into the row). So the
// Manage form's placeholder misstated what the heartbeat would send.
//
// ⚠️ WHAT THIS SPEC DOES AND DOES NOT PROVE — read before trusting it as the card's evidence:
//   • It PROVES the web contract: the placeholder renders whatever `heartbeatPromptDefault` carries,
//     verbatim, and the env-pinned Callout rides alongside it. A future refactor that re-hardcodes the
//     default text into the component fails here. That is the regression this leg exists to lock.
//   • It does NOT prove the daemon resolves env — the env-pinned read below is FABRICATED via
//     `page.route`, because `envPinned` requires LOOM_COMPANION_* in the DAEMON's own env naming a
//     pre-existing session id, which the shared worker fixture cannot seed (and which would arm a real
//     Telegram long-poll). That half belongs to `packages/daemon/test/companion-config.mjs`, which pins
//     all four arms of the resolution and was shown RED against pre-fix `store.ts`.
//   • The web needed NO code change for the value itself (b95e3bd0 already wired the placeholder to the
//     server field) — only the field's sub-label, which said "blank = default" and now points at the
//     rendered placeholder instead, since that text is no longer always the built-in default.
//
// BOTH POLARITIES, SAME ELEMENT, SAME SESSION: the real (not env-pinned) daemon read first — placeholder
// IS the built-in constant and no Callout — then the same textarea under the env-pinned read. A
// one-polarity check would pass on a component that ignored the server value entirely.
test("Manage tab: the heartbeat-prompt placeholder follows the server's resolved default, env-pinned included", async ({ page, loomDaemon }) => {
  const { name, companion } = await seedIsolatedCompanion(loomDaemon);

  const ENV_PROMPT = `Env-pinned check-in ${randomUUID().slice(0, 8)}: only ping me about the deploy.`;
  const openEditor = async () => {
    await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
    await focusOwnCompanion(page, name);
    await page.getByRole("tab", { name: "Manage" }).click();
    const section = page.locator("section").filter({ hasText: "Run configuration" });
    await section.getByRole("button", { name: "Edit" }).click();
    return section;
  };

  // ── BEFORE: the REAL daemon read. Not env-pinned, so the resolved default IS the built-in constant. ──
  await page.goto(`${loomDaemon.baseURL}/companion`);
  const plainSection = await openEditor();
  const plainPrompt = plainSection.locator("textarea");
  await expect(plainPrompt).toHaveValue(""); // still unset — the placeholder is the only default surface
  await expect(plainPrompt).toHaveAttribute("placeholder", /Proactive check-in/);
  await expect(plainPrompt).not.toHaveAttribute("placeholder", ENV_PROMPT);
  // The sub-label points AT the placeholder rather than naming "the default" (card e731bc77 copy).
  await expect(plainSection.getByText("proactive turn text · blank uses the shown default")).toBeVisible();
  await expect(plainSection.getByTestId("companion-env-pinned-notice")).toHaveCount(0);

  // ── AFTER: the SAME companion read back as env-pinned. Patch only OUR row in the real list response —
  // every other companion on the shared worker daemon is passed through untouched, and the FIXTURE
  // IDENTITY is asserted inside the handler (our sessionId must be present, or the leg is meaningless).
  let patchedOurRow = false;
  await page.route(
    (url) => url.pathname === "/api/companion/config",
    async (route) => {
      const res = await route.fetch();
      const rows = await res.json();
      const ours = rows.filter((r: { sessionId: string }) => r.sessionId === companion.sessionId);
      expect(ours).toHaveLength(1); // fixture identity: we are patching OUR seeded companion, not a sibling's
      expect(ours[0].heartbeatPrompt).toBeNull(); // still inheriting — the state the default field describes
      ours[0].envPinned = true;
      ours[0].heartbeatPromptDefault = ENV_PROMPT;
      patchedOurRow = true;
      await route.fulfill({ response: res, json: rows });
    },
  );

  await page.reload();
  const envSection = await openEditor();
  expect(patchedOurRow).toBe(true); // the override really served this render (not a cached pre-route read)
  const envPrompt = envSection.locator("textarea");
  await expect(envPrompt).toHaveValue(""); // unchanged: a default is shown, never seeded into the field
  await expect(envPrompt).toHaveAttribute("placeholder", ENV_PROMPT);
  await expect(envPrompt).not.toHaveAttribute("placeholder", /Proactive check-in/);
  // ...and the env-pinned Callout is what tells the human WHERE that unfamiliar placeholder comes from.
  await expect(envSection.getByTestId("companion-env-pinned-notice")).toContainText("override");
});
