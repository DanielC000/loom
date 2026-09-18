// Session Environment panel spec (card 32b23f0f) — the WRITE-ONLY `sessionEnv` editor in project
// Settings. Every test here exists because a bug in this panel DELETES A LIVE SECRET, and since card
// 82b22817 that map is delivered into every session's spawn env, so a deletion breaks running projects.
//
// The load-bearing property under test is that BLANK MEANS KEEP. The panel can never render a stored
// value (they are secrets), so "the value field is blank" is the NORMAL state of every untouched row —
// which means the blank-means-delete convention the modeled scalar fields use would wipe the whole map on
// a render-then-save round-trip. Deletion is instead an explicit staged per-row removal that emits a
// `sessionEnv.<NAME>` dot-path on the PATCH's `unset` array.
//
// Covers:
//   (1) DoD-1/2/3 — add + edit; a stored value is NEVER rendered; an untouched entry survives byte-for-byte.
//   (2) DoD-4 — removal is staged, reversible, and ENABLES Save. The Save-enabled assertion is not
//       decoration: a staged removal changes nothing in the built override (it only adds an `unset` path),
//       so the form's JSON-diff `dirty` check cannot see it and the button would stay disabled — the
//       primary new action silently unperformable. Only an exercised control reveals that.
//   (3) DoD-4 — the render-then-save round-trip: saving an UNRELATED field leaves the map untouched.
//   (4) DoD-5 — every unmodeled key (gateCommand, maxConcurrentManagers, pty, permission.*,
//       kanbanColumns, …) survives a sessionEnv save, under test rather than under comment.
//   (5) A rename with no value re-entered BLOCKS Save instead of dropping the old key and writing nothing.
//
// Builds on the shared `loomDaemon` fixture; settings.spec.ts is the template (including its
// pinActiveProject determinism note — the worker-scoped daemon is shared, so each test pins its own).
import { expect, test } from "./fixtures/daemon";

// Two seeded secrets. Their exact character lengths are asserted against the panel's indicator, so a
// change to either literal must be reflected below.
const ALPHA_VALUE = "alpha-secret-value"; // 18 chars
const BETA_VALUE = "beta-secret-value-longer"; // 24 chars

async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** Seed a project's stored config override through the same human REST PATCH the panel itself uses. */
async function seedConfig(baseURL: string, projectId: string, config: Record<string, unknown>) {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) throw new Error(`seedConfig failed (${res.status}): ${await res.text()}`);
}

async function readConfig(baseURL: string, projectId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as Array<{ id: string; config?: Record<string, unknown> }>;
  return projects.find((p) => p.id === projectId)?.config ?? {};
}

const readSessionEnv = async (baseURL: string, projectId: string) =>
  ((await readConfig(baseURL, projectId)).sessionEnv as Record<string, string> | undefined) ?? null;

const projectSaveButton = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Save", exact: true }).first();

test("renders sessionEnv key names + exact lengths, NEVER a stored value, and editing one entry preserves the others", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-edit-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { ALPHA: ALPHA_VALUE, BETA: BETA_VALUE } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  await expect(page.getByText("Session Environment", { exact: true })).toBeVisible();

  // The indicator is the key name + the EXACT stored length — never the value, never a digest of it.
  await expect(page.getByTestId("senv-indicator-ALPHA")).toHaveText(`set · ${ALPHA_VALUE.length} chars`);
  await expect(page.getByTestId("senv-indicator-BETA")).toHaveText(`set · ${BETA_VALUE.length} chars`);

  // 🔴 DoD-2, the absolute one: neither stored value appears ANYWHERE in the served document, the value
  // inputs are empty rather than pre-filled, and they are masked so a typed value can't be screenshotted.
  const html = await page.content();
  expect(html).not.toContain(ALPHA_VALUE);
  expect(html).not.toContain(BETA_VALUE);
  await expect(page.getByTestId("senv-value-ALPHA")).toHaveValue("");
  await expect(page.getByTestId("senv-value-BETA")).toHaveValue("");
  await expect(page.getByTestId("senv-value-ALPHA")).toHaveAttribute("type", "password");

  // Nothing has been touched, so there is nothing to save.
  await expect(projectSaveButton(page)).toBeDisabled();

  // DoD-3: type a new value for ALPHA ONLY and save. BETA's value was never rendered and is never sent,
  // so it must come back byte-for-byte — the whole point of the card, and the failure mode is silent.
  await page.getByTestId("senv-value-ALPHA").fill("alpha-rotated-0001");
  await expect(projectSaveButton(page)).toBeEnabled();
  await projectSaveButton(page).click();

  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({
    ALPHA: "alpha-rotated-0001",
    BETA: BETA_VALUE,
  });

  // The saved row re-reads its indicator from the SERVER's persisted map, so the length updates to the
  // new value's and BETA's is unchanged — an observable before/after, not just a redraw.
  await expect(page.getByTestId("senv-indicator-ALPHA")).toHaveText("set · 18 chars");
  await expect(page.getByTestId("senv-indicator-BETA")).toHaveText(`set · ${BETA_VALUE.length} chars`);
  await expect(page.getByTestId("senv-value-ALPHA")).toHaveValue("");

  // 🔴 The form must be CLEAN after a sessionEnv write. Regression guard: the dirty comparison is taken
  // over a sessionEnv-free projection of the built override, because the saved baseline would otherwise
  // hold `sessionEnv: {<delta>}` while the re-seeded rows immediately stop producing that key — leaving
  // "unsaved changes" stuck on forever with nothing left to save. A removal-only save is unaffected
  // (the map is absent on both sides), so ONLY an assertion after a WRITE catches it.
  await expect(projectSaveButton(page)).toBeDisabled();

  // DoD-1: adding a brand-new entry, alongside the untouched existing ones.
  await page.getByTestId("senv-add").click();
  await page.getByTestId("senv-name-new-2").fill("GAMMA");
  await page.getByTestId("senv-value-new-2").fill("gamma-value");
  await expect(projectSaveButton(page)).toBeEnabled();
  await projectSaveButton(page).click();

  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({
    ALPHA: "alpha-rotated-0001",
    BETA: BETA_VALUE,
    GAMMA: "gamma-value",
  });
});

test("removing a sessionEnv entry is staged, ENABLES Save, is undoable, and deletes only that key (DoD-4)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-remove-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { ALPHA: ALPHA_VALUE, BETA: BETA_VALUE } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-ALPHA")).toBeVisible();
  await expect(save).toBeDisabled();

  // Stage the removal: the row stays visible and says so, rather than vanishing — that is what makes a
  // removal distinguishable from leaving a row alone.
  await page.getByTestId("senv-remove-ALPHA").click();
  await expect(page.getByTestId("senv-staged-ALPHA")).toHaveText("will be removed on Save");

  // 🔴 THE REGRESSION GUARD FOR THE `dirty` BUG. A staged removal adds only an `unset` dot-path and
  // changes nothing in the built override, so the form's JSON-diff cannot see it. Without the dedicated
  // sessionEnv dirty check this button is DISABLED here and the removal can never be performed at all —
  // a feature whose primary new action silently does nothing. Asserting the button's state is the only
  // thing that catches it; a unit check on the derived flag would not.
  await expect(save).toBeEnabled();

  // Undo puts it back and the form returns to clean — staging is genuinely reversible before Save.
  await page.getByTestId("senv-undo-ALPHA").click();
  await expect(page.getByTestId("senv-indicator-ALPHA")).toBeVisible();
  await expect(save).toBeDisabled();
  expect(await readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ ALPHA: ALPHA_VALUE, BETA: BETA_VALUE });

  // Re-stage and commit it: ONLY ALPHA is deleted; BETA — untouched, never rendered, never sent — stays.
  await page.getByTestId("senv-remove-ALPHA").click();
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ BETA: BETA_VALUE });
  // The removed row is gone from the re-seeded list, and the surviving row is still there.
  await expect(page.getByTestId("senv-row-ALPHA")).toHaveCount(0);
  await expect(page.getByTestId("senv-indicator-BETA")).toHaveText(`set · ${BETA_VALUE.length} chars`);

  // Removing the LAST entry drops the whole `sessionEnv` key rather than leaving a `{}` husk behind.
  await page.getByTestId("senv-remove-BETA").click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toBeNull();
});

test("a render-then-save round-trip NEVER wipes sessionEnv — blank value fields mean KEEP (DoD-4)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-roundtrip-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { ALPHA: ALPHA_VALUE, BETA: BETA_VALUE } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Both rows render with EMPTY value fields (they always do — values are never read). Then save an
  // entirely unrelated field. If blank were ever read as "delete", this is the save that destroys the map.
  await expect(page.getByTestId("senv-value-ALPHA")).toHaveValue("");
  await expect(page.getByTestId("senv-value-BETA")).toHaveValue("");

  await page
    .locator(`label:has(> span:text-is("Gate command"))`)
    .locator("input")
    .fill("pnpm build");
  const save = projectSaveButton(page);
  await expect(save).toBeEnabled();
  await save.click();

  await expect
    .poll(async () => ((await readConfig(loomDaemon.baseURL, project.id)).orchestration as { gateCommand?: string } | undefined)?.gateCommand)
    .toBe("pnpm build");
  expect(await readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ ALPHA: ALPHA_VALUE, BETA: BETA_VALUE });
});

test("every unmodeled config key survives a sessionEnv save (DoD-5)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-preserve-${Date.now()}`);
  // A deliberately broad override: keys this panel models (gateCommand, maxConcurrentManagers, docLint),
  // keys it does NOT model at all (pty, permission.mode/deny, kanbanColumns), and the secret map.
  await seedConfig(loomDaemon.baseURL, project.id, {
    sessionEnv: { ALPHA: ALPHA_VALUE, BETA: BETA_VALUE },
    orchestration: { gateCommand: "pnpm test", maxConcurrentManagers: 3 },
    pty: { cols: 132, rows: 48 },
    permission: { allow: ["Bash(git status:*)"], deny: ["Read(./.env)"], mode: "acceptEdits" },
    docLint: true,
    // The layout validator requires exactly one `defaultLanding` and one `terminal` column, so this is a
    // real three-lane board rather than a bare key/label list.
    kanbanColumns: [
      { key: "backlog", label: "Backlog", role: "defaultLanding" },
      { key: "in_progress", label: "Doing", role: "active" },
      { key: "done", label: "Done", role: "terminal" },
    ],
  });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const before = await readConfig(loomDaemon.baseURL, project.id);
  await expect(page.getByTestId("senv-indicator-ALPHA")).toBeVisible();

  // Edit ONE sessionEnv value and save.
  await page.getByTestId("senv-value-ALPHA").fill("alpha-rotated-9999");
  const save = projectSaveButton(page);
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => (await readSessionEnv(loomDaemon.baseURL, project.id))?.ALPHA)
    .toBe("alpha-rotated-9999");

  // Compare the ENTIRE stored override, before vs after, with only the intended sessionEnv delta applied.
  // Asserting on the whole object (rather than a hand-picked list of keys) is what makes this catch a key
  // nobody thought to name — including one added to the schema after this test was written.
  const after = await readConfig(loomDaemon.baseURL, project.id);
  expect(after).toEqual({ ...before, sessionEnv: { ALPHA: "alpha-rotated-9999", BETA: BETA_VALUE } });
});

test("renaming a sessionEnv key with no value re-entered BLOCKS Save instead of dropping the old key", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-rename-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { ALPHA: ALPHA_VALUE } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-ALPHA")).toBeVisible();

  // Rename with the value left blank. The panel cannot carry over a value it never read, so this is
  // REFUSED at the control with a reason — rather than unsetting ALPHA and writing an empty RENAMED.
  await page.getByTestId("senv-name-ALPHA").fill("RENAMED");
  await expect(page.getByRole("alert")).toContainText("needs its value re-entered");
  await expect(save).toBeDisabled();

  // Supplying the value unblocks it, and the rename lands as one delete + one write.
  await page.getByTestId("senv-value-ALPHA").fill("renamed-value");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ RENAMED: "renamed-value" });
});

// 🔴 The unset/write COLLISION shapes. The server applies the PATCH as `merge` THEN `unset`,
// unconditionally (gateway/server.ts) — so an `unset` path and a write of the SAME name in ONE payload
// end with the unset winning and the just-typed value destroyed. `buildOverride`'s internal ordering
// cannot prevent this: it guarantees a rename only drops its old key alongside a write, but says nothing
// about a DIFFERENT row re-using that same name. Both shapes below are reachable purely through the UI,
// with no error and an HTTP 200 — and "remove it, then add it back fresh" is a natural flow here
// precisely because the panel never shows stored values, so re-adding is how a human replaces one.
test("removing an entry and re-adding the SAME name in one save keeps the new value (unset/write collision)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-collide-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { API_KEY: "old-api-key-value", OTHER: "other-value" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-API_KEY")).toBeVisible();

  // Stage the removal of API_KEY, then add a NEW row re-using that exact name with a fresh value.
  await page.getByTestId("senv-remove-API_KEY").click();
  await page.getByTestId("senv-add").click();
  await page.getByTestId("senv-name-new-2").fill("API_KEY");
  await page.getByTestId("senv-value-new-2").fill("fresh-api-key-value");
  await expect(save).toBeEnabled();
  await save.click();

  // The rotated value must SURVIVE. Pre-fix this returned null — the old secret AND the replacement the
  // human had just typed were both gone, with the parent key pruned, and the UI reported success.
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({
    API_KEY: "fresh-api-key-value",
    OTHER: "other-value",
  });
});

test("rotating two keys in one save (A→B, B→C) destroys neither value (unset/write collision)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-rotate-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { AAA: "value-aaa", BBB: "value-bbb" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-AAA")).toBeVisible();

  // AAA -> BBB and BBB -> CCC in the SAME save. The unset of BBB (from the first rename) collides with
  // the write of BBB (from the same rename's new name). Pre-fix this returned {"CCC": "..."} only.
  await page.getByTestId("senv-name-AAA").fill("BBB");
  await page.getByTestId("senv-value-AAA").fill("rotated-into-bbb");
  await page.getByTestId("senv-name-BBB").fill("CCC");
  await page.getByTestId("senv-value-BBB").fill("rotated-into-ccc");
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({
    BBB: "rotated-into-bbb",
    CCC: "rotated-into-ccc",
  });
});

// The remaining SILENT-NO-OP and ORPHAN shapes, all of which previously reported success while doing
// something other than what the human asked. This panel's contract is to refuse them at the control.
test("a blanked stored name and an invalid new name both BLOCK Save instead of saving nothing", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-invalid-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { ALPHA: ALPHA_VALUE } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-ALPHA")).toBeVisible();

  // Clearing a STORED name writes nothing and unsets nothing — the save would "succeed" and the field
  // would snap back on re-seed. Refused, and it names the action the human actually wanted.
  await page.getByTestId("senv-name-ALPHA").fill("");
  await expect(page.getByRole("alert")).toContainText("use Remove to delete this entry");
  await expect(save).toBeDisabled();
  await page.getByTestId("senv-name-ALPHA").fill("ALPHA");
  await expect(save).toBeDisabled(); // back to clean, nothing staged

  // A name a spawn env cannot represent (a dot, a space, an `=`, a leading digit) is refused up front.
  // Nothing else in the stack validates these: the schema is a bare z.record(z.string(), z.string()).
  await page.getByTestId("senv-add").click();
  await page.getByTestId("senv-name-new-1").fill("MY.VAR");
  await page.getByTestId("senv-value-new-1").fill("dotted");
  await expect(page.getByRole("alert")).toContainText("must be letters, digits and _");
  await expect(save).toBeDisabled();

  await page.getByTestId("senv-name-new-1").fill("MY_VAR");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ ALPHA: ALPHA_VALUE, MY_VAR: "dotted" });
});

test("a pre-existing DOTTED key can have its value changed but NOT be renamed or removed (no silent orphan)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-dotted-${Date.now()}`);
  // Reachable today: the config schema accepts any string key, so a dotted name can already be stored
  // via REST or an elevated MCP write, and this panel is the first thing that offers to manage it.
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { "MY.VAR": "dotted-secret" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-MY.VAR")).toHaveText("set · 13 chars");

  // Renaming it would write the new key and no-op the unset (`sessionEnv.MY.VAR` looks for an object at
  // `sessionEnv.MY`), leaving the OLD secret orphaned and still delivered to every spawn while the UI
  // reported success. Refused instead.
  await page.getByTestId("senv-name-MY.VAR").fill("MY_VAR");
  await page.getByTestId("senv-value-MY.VAR").fill("rotated");
  await expect(page.getByRole("alert")).toContainText("not addressable by the config API");
  await expect(save).toBeDisabled();

  // Staging its removal is refused for the same reason — the unset cannot target it.
  await page.getByTestId("senv-name-MY.VAR").fill("MY.VAR");
  await page.getByTestId("senv-value-MY.VAR").fill("");
  await page.getByTestId("senv-remove-MY.VAR").click();
  await expect(page.getByRole("alert")).toContainText("not addressable by the config API");
  await expect(save).toBeDisabled();

  // But changing its VALUE in place is legitimate and must still work: that is a pure merge write with
  // no unset involved, so refusing it would strand the key with no way to rotate it at all.
  await page.getByTestId("senv-undo-MY.VAR").click();
  await page.getByTestId("senv-value-MY.VAR").fill("rotated-in-place");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ "MY.VAR": "rotated-in-place" });
});

// ⭐ PINS THE Map-VS-PLAIN-OBJECT CHOICE in buildOverride's written-name collection. `constructor` is a
// perfectly legal env var name and passes the name check, but it answers `in` via Object.prototype — so
// with a plain object the collision guard reads "something writes this name back", SUPPRESSES the unset,
// and the Remove silently does nothing. With a Map it is absent and the unset is emitted.
// ⛔ Do not "simplify" that Map away: the whole suite stays green while this exact assertion is what
// fails, and the same prototype lookup also re-opens the rename-orphan path.
test("a prototype-named key (`constructor`) is genuinely removable — pins the Map in the written-name set", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-proto-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { constructor: "proto-named-secret", KEEP: "keep-me" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  // It is storable and manageable: it renders as an ordinary row, with no error on mount.
  await expect(page.getByTestId("senv-indicator-constructor")).toHaveText("set · 18 chars");
  await expect(save).toBeDisabled();

  await page.getByTestId("senv-remove-constructor").click();
  await expect(save).toBeEnabled();
  await save.click();

  // With a plain object this poll never resolves — the key is still there, unset suppressed.
  await expect.poll(() => readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ KEEP: "keep-me" });
  await expect(page.getByTestId("senv-row-constructor")).toHaveCount(0);
});

// `__proto__` passes the env-name shape check, but zod's `z.record` builds its output by plain
// assignment, so the key never becomes an own property and the SERVER silently drops it. Renaming a
// stored key onto that name therefore unsets the old key and stores nothing: both the old secret and the
// just-typed replacement gone, HTTP 200, success reported. Refused in the same gate as a dotted name —
// same reason (a name this panel cannot persist), so one predicate covers both.
test("`__proto__` is refused as a name, because the config store silently drops it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-protoname-${Date.now()}`);
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { API_KEY: "old-secret" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-API_KEY")).toBeVisible();

  // The rename the Critical was measured on: old key unset, new key dropped by the server.
  await page.getByTestId("senv-name-API_KEY").fill("__proto__");
  await page.getByTestId("senv-value-API_KEY").fill("fresh-secret");
  await expect(page.getByRole("alert")).toContainText("silently dropped by the config store");
  await expect(save).toBeDisabled();

  // Same refusal for a brand-new row — it is the NAME that is refused, not the rename.
  await page.getByTestId("senv-name-API_KEY").fill("API_KEY");
  await page.getByTestId("senv-value-API_KEY").fill("");
  await page.getByTestId("senv-add").click();
  await page.getByTestId("senv-name-new-1").fill("__proto__");
  await page.getByTestId("senv-value-new-1").fill("whatever");
  await expect(page.getByRole("alert")).toContainText("silently dropped by the config store");
  await expect(save).toBeDisabled();

  // Nothing reached the server through any of that.
  expect(await readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ API_KEY: "old-secret" });
});

// 🔴 A stored name this panel would refuse to CREATE must never disable the WHOLE project Settings Save
// on mount. `blockingErrors` gates the single Save button shared by every panel on the page, so an error
// raised by an untouched row — one the user cannot remove, rename or clear — bricks gateCommand, the
// caps, Memory, everything, with no control they could touch to recover.
test("a legacy stored name (blank / whitespace-padded) does NOT brick the whole Settings Save on mount", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-senv-legacy-${Date.now()}`);
  // Both are storable through the real validator today: `z.record(z.string(), z.string())` accepts any
  // string key, so these can already exist from a REST or elevated-MCP write.
  await seedConfig(loomDaemon.baseURL, project.id, { sessionEnv: { "": "empty-named", " PADDED ": "padded-named", OK: "fine" } });
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const save = projectSaveButton(page);
  await expect(page.getByTestId("senv-indicator-OK")).toBeVisible();
  // Nothing staged ⇒ no error, and the form is clean rather than phantom-dirty from a trim mismatch.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // The rest of the page still works: an unrelated field saves normally, and the legacy keys survive.
  await page.locator(`label:has(> span:text-is("Gate command"))`).locator("input").fill("pnpm build");
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => ((await readConfig(loomDaemon.baseURL, project.id)).orchestration as { gateCommand?: string } | undefined)?.gateCommand)
    .toBe("pnpm build");
  expect(await readSessionEnv(loomDaemon.baseURL, project.id)).toEqual({ "": "empty-named", " PADDED ": "padded-named", OK: "fine" });
});
