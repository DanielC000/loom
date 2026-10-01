// Concurrent-agent-write e2e spec (card 65aa951c) — the follow-up half of `config-delta-not-echo.spec.ts`.
// Those three surfaces echoed a whole CACHED SERVER OBJECT; these three echo their own MOUNT-TIME FORM
// STATE, which is the same loss by a different route: Settings' project form, the Profiles editor and the
// Projects agent editor each seeded `useState` once at mount and then re-sent every modelled field on
// Save, reverting whatever an agent had written to that record since.
//
//   1. Settings › project config — a field changed over REST after the page loads survives a save of a
//      DIFFERENT field, and the PATCH body is checked directly: it must not carry (or `unset`) the field
//      the human never touched.
//   2. Settings › Board Columns — saving the column layout no longer makes the project-config form below
//      it read "unsaved changes". That form's dirty check used to diff a CLONE of the whole stored
//      override, which carries `kanbanColumns` — a key it does not even model.
//   3. Actors › Profiles — a profile field rewritten over REST after the editor opens survives a save that
//      only renames the rig.
//   4. Projects › agent startup prompt — a prompt rewritten over REST is ADOPTED into the textarea rather
//      than sitting behind stale text with Save armed to revert it.
//
// 🔴 TIMING IS THE WHOLE TEST, for 1/3/4. The defect needs the form's copy to be STALE, so the server value
// must move AFTER the page has rendered that field — seeding it beforehand makes the save re-assert the
// same value and the test passes against the live bug. Every one of these loads the page, waits for a
// control that proves the query RESOLVED, and only then moves the value over REST.
//
// Builds on the shared `loomDaemon` fixture (its own LOOM_HOME under a temp dir, LOOM_PORT=0, pre-stamped
// first-run marker, LOOM_DEV=0, no-real-claude asserted), which serves the built web dist directly — so
// `pnpm build` must have run against the code under test, and there is no dev-proxy target to get wrong.
//
// FIXTURE IDENTITY — every test asserts on a UNIQUE seeded string (a project name, a profile name, a prompt
// body) so a silent fall-through to another spec's record on this shared daemon fails loudly rather than
// reading plausibly green.
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;

const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Locate a config field's control by the EXACT text of its label <span> — the same helper settings.spec.ts
// uses, and for the same reason: each <label> also nests Hint text, so getByLabel's accessible name is
// polluted and "Gate command" would collide with "Gate command timeout (s)".
function field(page: Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface StoredProject { id: string; config: { orchestration?: { maxConcurrentWorkers?: number; gateCommand?: string } } }

const readProject = async (baseURL: string, id: string) => {
  const all = await apiJson<StoredProject[]>(`${baseURL}/api/projects`);
  const row = all.find((p) => p.id === id);
  if (!row) throw new Error(`project ${id} not found in /api/projects`);
  return row;
};

const patchConfig = (baseURL: string, id: string, config: Record<string, unknown>) =>
  apiJson<StoredProject>(`${baseURL}/api/projects/${id}/config`, { method: "PATCH", body: JSON.stringify({ config }) });

interface SeededProfile {
  id: string; name: string; description: string;
  harness?: "claude" | "codex" | null;
  browserTesting?: boolean; restrictedTools?: boolean; documentConversion?: boolean;
}

// ⚠️ Every profile seeded here is DELETED in afterEach, and that cleanup is load-bearing rather than
// tidiness. The `loomDaemon` fixture is worker-scoped and the suite runs `workers:1`, so ONE profile store
// is shared across every spec file — and `profile-harness.spec.ts` asserts a PAGE-WIDE `harness-tag` count
// of 0 for a freshly seeded rig, which the codex rig below would badge. A leak from here therefore fails a
// sibling spec that has nothing to do with this card; the same trap `profile-harness-codex-save.spec.ts`
// documents at length, and it has already been paid for once there.
const seededProfiles: { baseURL: string; id: string }[] = [];

const seedProfile = async (baseURL: string, body: Record<string, unknown>) => {
  const p = await apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });
  seededProfiles.push({ baseURL, id: p.id });
  return p;
};

// ⚠️ NOT routed through `apiJson`: a bodyless DELETE still carrying `content-type: application/json` is
// rejected by Fastify ("Body cannot be empty…"), so the helper would make every delete fail. Throws loudly
// in THIS file rather than swallowing the error and breaking a different one.
test.afterEach(async () => {
  for (const { baseURL, id } of seededProfiles.splice(0, seededProfiles.length)) {
    const res = await fetch(`${baseURL}/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`cleanup: DELETE profile ${id} -> ${res.status}: ${await res.text()}`);
  }
});

test("Settings: a config field written after load survives a save of a different field", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("cfgcarry"));
  // STALE is the value the form will render and (before the fix) re-assert; LIVE is what an agent writes
  // afterwards. They must differ, or the echo is unobservable.
  const staleWorkers = 3;
  const liveWorkers = 9;
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: staleWorkers } });

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  // The rendered VALUE (not merely a visible panel) is what proves the projects query resolved AND that
  // this form seeded from it — without this the edit below could race the first fetch.
  const workers = field(page, "Max workers / manager");
  await expect(workers).toHaveValue(String(staleWorkers));
  // Fixture identity: this really is the project we seeded, not a sibling spec's. Scoped to the config
  // panel's own "Editing <name>" line — the sidebar rail carries the same name in a collapsed, hidden span.
  await expect(page.locator("p", { hasText: "Editing" }).first()).toContainText(project.name);

  // The form's copy is now stale by construction — stands in for a manager's `project_update` landing while
  // the owner has Settings open.
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: liveWorkers } });
  expect((await readProject(loomDaemon.baseURL, project.id)).config.orchestration?.maxConcurrentWorkers).toBe(liveWorkers);

  // Capture what the Save actually PUTs on the wire. The stored-value assertion below is the outcome; this
  // is the mechanism, and it holds whether or not the page happened to refetch in between.
  const patchBodies: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes(`/api/projects/${project.id}/config`)) {
      patchBodies.push(req.postData() ?? "");
    }
  });

  // EXERCISE — edit a DIFFERENT field and save.
  const gate = field(page, "Gate command");
  const gateValue = uniq("pnpm check");
  await gate.fill(gateValue);
  const save = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled(); // dirty cleared ⇒ the save round-tripped

  // AFTER — the edit landed AND the concurrent write was not dragged back to this form's stale copy.
  await expect
    .poll(async () => (await readProject(loomDaemon.baseURL, project.id)).config.orchestration?.gateCommand ?? null)
    .toBe(gateValue);
  const after = await readProject(loomDaemon.baseURL, project.id);
  expect(after.config.orchestration?.maxConcurrentWorkers).toBe(liveWorkers); // THE REGRESSION: was 3 before the fix

  // MECHANISM — the untouched field was never on the wire at all, in either direction. An `unset` of it
  // would be just as destructive as a stale write, so both are checked.
  expect(patchBodies.length).toBe(1);
  const sent = JSON.parse(patchBodies[0] ?? "{}") as { config?: Record<string, unknown>; unset?: string[] };
  expect(JSON.stringify(sent.config)).not.toContain("maxConcurrentWorkers");
  expect(sent.unset ?? []).not.toContain("orchestration.maxConcurrentWorkers");
  // ...and it is a real delta, not an empty payload that passed vacuously.
  expect(JSON.stringify(sent.config)).toContain(gateValue);
});

test("Settings: saving the column layout does not make the config form below read unsaved", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("coldirty"));
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  // The project-config Save is the FIRST "Save" button in DOM order (the column editor's is "Save layout",
  // RepoPathEditor's is "Rebind"). Disabled + "saved" is the clean baseline this test needs to start from.
  const configSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(field(page, "Gate command")).toBeVisible();
  await expect(configSave).toBeDisabled();
  const savedChip = page.getByText("saved", { exact: true }).first();
  await expect(savedChip).toBeVisible();

  // EXERCISE — rename a lane through the column editor's own atomic endpoint. It invalidates ["projects"],
  // which is what used to push a changed `kanbanColumns` into the config form's cloned baseline below.
  const labels = page.getByLabel("Column label");
  await expect(labels.first()).toBeVisible();
  const renamed = uniq("Backlog");
  await labels.first().fill(renamed);
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await expect(saveLayout).toBeEnabled();
  await saveLayout.click();
  await expect(saveLayout).toBeDisabled(); // the layout save round-tripped and re-baselined

  // AFTER — the column save landed, and the UNRELATED config form below is still clean. Before the fix it
  // flipped to "unsaved changes" with an armed Save the owner never touched.
  await expect(page.getByLabel("Column label").first()).toHaveValue(renamed);
  await expect(configSave).toBeDisabled(); // THE REGRESSION: was enabled before the fix
  await expect(page.getByText("unsaved changes", { exact: true })).toHaveCount(0);
});

test("Profiles: a profile field written after the editor opens survives a save that renames the rig", async ({ page, loomDaemon }) => {
  const originalName = uniq("Rig");
  const profile = await seedProfile(loomDaemon.baseURL, {
    name: originalName, role: null, description: uniq("seeded-description"), allowDelta: [], skills: null, model: null, icon: null,
  });
  const readProfile = () => apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`);

  // Deep-link straight to this rig's editor, so the test never depends on list ordering on a shared daemon.
  await page.goto(`${loomDaemon.baseURL}/actors?profile=${profile.id}`);
  const nameField = field(page, "Name");
  const descriptionField = page.getByPlaceholder(/A human-facing blurb/);
  // BOTH rendered values prove the profile query resolved AND that this editor seeded from THIS row — the
  // description especially, since it is the field the save must not revert.
  await expect(nameField).toHaveValue(originalName);
  await expect(descriptionField).toHaveValue(profile.description);

  // The editor's copy is now stale — stands in for a Platform Lead's profile write landing mid-edit.
  const agentWritten = uniq("agent-rewrote-this");
  await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, {
    method: "PUT",
    body: JSON.stringify({ description: agentWritten }),
  });
  expect((await readProfile()).description).toBe(agentWritten);

  // EXERCISE — rename the rig (a DIFFERENT field) and save.
  const renamed = uniq("Rig-renamed");
  await nameField.fill(renamed);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();

  // AFTER — the rename landed AND the concurrent description write was not reverted to the mount-time text.
  await expect.poll(async () => (await readProfile()).name).toBe(renamed);
  expect((await readProfile()).description).toBe(agentWritten); // THE REGRESSION: reverted to the seed before the fix
});

test("Projects: an agent prompt written after load is adopted, not left armed to revert", async ({ page, loomDaemon }) => {
  interface SeededAgent { id: string; name: string; startupPrompt: string; profileId: string | null }
  const project = await loomDaemon.createProject(uniq("promptcarry"));
  const agentName = uniq("Prompt-agent");
  const seededPrompt = uniq("seeded prompt body");
  const agent = await apiJson<SeededAgent>(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
    method: "POST",
    body: JSON.stringify({ name: agentName, startupPrompt: seededPrompt }),
  });
  // A profile to assign — the "different field" this form can edit beside the prompt. Its save invalidates
  // ["agents", projectId], which is what makes the refetch deterministic instead of focus-dependent.
  const profileName = uniq("Prompt-profile");
  await apiJson<{ id: string }>(`${loomDaemon.baseURL}/api/profiles`, {
    method: "POST",
    body: JSON.stringify({ name: profileName, role: null, description: "", allowDelta: [], skills: null, model: null, icon: null }),
  });
  const readAgent = async () => {
    const all = await apiJson<SeededAgent[]>(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`);
    const row = all.find((a) => a.id === agent.id);
    if (!row) throw new Error(`agent ${agent.id} not found`);
    return row;
  };

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/projects`);
  await page.getByRole("button").filter({ hasText: agentName }).first().click();
  const prompt = page.locator("textarea");
  await expect(prompt).toHaveValue(seededPrompt); // the editor seeded from THIS agent

  // The editor's copy is now stale — stands in for an `agent_update` landing while the owner has it open.
  const agentWritten = uniq("agent rewrote the prompt");
  await apiJson<SeededAgent>(`${loomDaemon.baseURL}/api/agents/${agent.id}`, {
    method: "POST",
    body: JSON.stringify({ startupPrompt: agentWritten }),
  });
  expect((await readAgent()).startupPrompt).toBe(agentWritten);

  // EXERCISE — edit the one OTHER field this form has (the profile assignment), which saves immediately and
  // refetches the agent row.
  await page.locator("select").filter({ hasText: "— none —" }).selectOption({ label: profileName });
  await expect.poll(async () => (await readAgent()).profileId).not.toBeNull();

  // AFTER — the textarea ADOPTED the new prompt (the human had not touched it), Save is not armed with the
  // stale text, and the concurrent write survived the profile save. Before the fix the textarea still held
  // the seeded prompt, `dirty` read true against the new row, and one Save click reverted it.
  await expect(prompt).toHaveValue(agentWritten); // THE REGRESSION: still showed the seeded prompt before the fix
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect((await readAgent()).startupPrompt).toBe(agentWritten);
});

// ── Round 2 (the Code Reviewer's fix round) ─────────────────────────────────────────────────────────
//
// Four gaps the four tests above could not see, every one of them a case where the OUTCOME on the server
// is right while the FORM is wrong — which is exactly the blind spot those four shared: all of their
// assertions describe the stored row.
//
//   5. The save's own re-seed must not clobber a keystroke typed while the PATCH was in flight. Only the
//      Save button is disabled during a save, never the inputs, so this is reachable by hand.
//   6. The conflict notice, in BOTH directions, for all three forms: it appears when an agent rewrites a
//      field the human is editing, and it is GONE after the form's own save — including after a fresh
//      edit of that same field, which is where a never-cleared flag resurfaces as a false accusation.
//   7. The codex switch must put the cleared fields on the wire even when they already equal the seed —
//      otherwise an agent's post-mount `browserTesting: true` stays stored and the save 400s.
//   8. A refetch adopts an untouched field without arming Save.

/** Delay a matching request by `ms` before letting it through — a deterministic in-flight window. */
async function delayRoute(page: Page, pattern: string, method: string, ms: number) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await new Promise((r) => setTimeout(r, ms));
    await route.fallback();
  });
}

test("Settings: a keystroke typed while the save is in flight survives the save's own re-seed", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("inflight"));
  const seededWorkers = 3;
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: seededWorkers } });

  await pinActiveProject(page, project.id);
  // Routed BEFORE navigation so the handler is installed for the save rather than racing it.
  await delayRoute(page, `**/api/projects/${project.id}/config`, "PATCH", 1500);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const workers = field(page, "Max workers / manager");
  const gate = field(page, "Gate command");
  await expect(workers).toHaveValue(String(seededWorkers)); // the form seeded from THIS project
  await expect(page.locator("p", { hasText: "Editing" }).first()).toContainText(project.name);

  // EXERCISE — save field A, then type into field B while that PATCH is still open. The inputs stay
  // enabled throughout (only Save is disabled), so this is the ordinary impatient-owner sequence.
  const gateValue = uniq("pnpm inflight");
  await gate.fill(gateValue);
  const save = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled(); // in flight (pending disables it independently of dirty)
  const draftWorkers = "7";
  await workers.fill(draftWorkers); // ← the draft the re-seed used to destroy

  // AFTER — field A landed, and field B still holds what was typed. Before the fix `onSuccess` ran
  // `applyFields(persisted)` across EVERY field, so this snapped back to 3 with the keystroke gone.
  await expect
    .poll(async () => (await readProject(loomDaemon.baseURL, project.id)).config.orchestration?.gateCommand ?? null)
    .toBe(gateValue);
  await expect(workers).toHaveValue(draftWorkers); // THE REGRESSION: reverted to "3" before the fix
  // ...and the form knows it is still dirty on that field, so the surviving draft is actually saveable.
  await expect(save).toBeEnabled();
  await expect(page.getByText("unsaved changes", { exact: true })).toBeVisible();
  // The in-flight draft was never silently sent either — the server still holds the seeded value.
  expect((await readProject(loomDaemon.baseURL, project.id)).config.orchestration?.maxConcurrentWorkers).toBe(seededWorkers);
});

test("Settings: a refetch adopts an untouched field without arming Save", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("adopt"));
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: 3 } });

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);
  const workers = field(page, "Max workers / manager");
  await expect(workers).toHaveValue("3");
  const configSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(configSave).toBeDisabled();

  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: 9 } });

  // Force a deterministic refetch of ["projects"] from inside the page: the column editor's own atomic
  // save invalidates exactly that key. (react-query otherwise refetches on focus/invalidation only, so a
  // human can sit here for an hour without one — which is why the DELTA, not this, is the safety half.)
  const labels = page.getByLabel("Column label");
  await expect(labels.first()).toBeVisible();
  await labels.first().fill(uniq("Lane"));
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await saveLayout.click();
  await expect(saveLayout).toBeDisabled();

  // AFTER — the untouched field shows the TRUTH, and Save is still disabled: an adopted value is not an
  // edit. (A stale field reading as a pending human edit is the other half of this card's defect.)
  await expect(workers).toHaveValue("9");
  await expect(configSave).toBeDisabled();
  await expect(page.getByTestId("config-conflict-notice")).toHaveCount(0);
  await expect(page.getByText("saved", { exact: true }).first()).toBeVisible();
});

test("Settings: the conflict notice appears on a touched field and retires after this form's own save", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("cfgconflict"));
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: 3 } });

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);
  const workers = field(page, "Max workers / manager");
  await expect(workers).toHaveValue("3");
  const notice = page.getByTestId("config-conflict-notice");
  await expect(notice).toHaveCount(0); // NEGATIVE CONTROL: not simply always on screen

  // TOUCH the field, have an agent rewrite that same field, then force the refetch.
  await workers.fill("7");
  await patchConfig(loomDaemon.baseURL, project.id, { orchestration: { maxConcurrentWorkers: 9 } });
  await page.getByLabel("Column label").first().fill(uniq("Lane"));
  await page.getByRole("button", { name: "Save layout" }).click();

  // DIRECTION 1 — it appears, naming the field, and the human's draft is kept rather than clobbered.
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Max workers / manager");
  await expect(workers).toHaveValue("7");

  // DIRECTION 2 — the form's own save settles it. The notice must not survive the save…
  const save = page.getByRole("button", { name: "Save", exact: true }).first();
  await save.click();
  await expect(save).toBeDisabled();
  await expect
    .poll(async () => (await readProject(loomDaemon.baseURL, project.id)).config.orchestration?.maxConcurrentWorkers)
    .toBe(7);
  await expect(notice).toHaveCount(0);
  // …NOR come back on a fresh edit of the very same field. A `conflicted` list that is never cleared
  // reads clean here only because it is filtered against "is this field changed" at render — re-dirty the
  // field and the stale flag reappears as a conflict that no longer exists.
  await workers.fill("5");
  await expect(save).toBeEnabled();
  await expect(notice).toHaveCount(0);
});

test("Profiles: the conflict notice appears on a touched field and retires after the editor's own save", async ({ page, loomDaemon }) => {
  const profile = await seedProfile(loomDaemon.baseURL, {
    name: uniq("Rig-conflict"), role: null, description: uniq("seed-desc"),
    allowDelta: [], skills: null, model: null, icon: null,
  });
  const readProfile = () => apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`);

  await page.goto(`${loomDaemon.baseURL}/actors?profile=${profile.id}`);
  const description = page.getByPlaceholder(/A human-facing blurb/);
  await expect(description).toHaveValue(profile.description);
  const notice = page.getByTestId("profile-conflict-notice");
  await expect(notice).toHaveCount(0); // NEGATIVE CONTROL

  // TOUCH the description, then have an agent rewrite that same field.
  const mine = uniq("my-description");
  await description.fill(mine);
  const agentWritten = uniq("agent-rewrote-this");
  await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, {
    method: "PUT", body: JSON.stringify({ description: agentWritten }),
  });
  expect((await readProfile()).description).toBe(agentWritten);

  // The refetch has to come from INSIDE the mounted editor — a reload would re-seed from the live row and
  // leave no conflict left to see. `visibilitychange` ON WINDOW is react-query v5's own refetchOnWindowFocus
  // trigger (v5 dropped the `focus` event, so dispatching that one is a silent no-op — it was the first
  // thing tried here and it made this test fail at DIRECTION 1, for the instrument rather than the bug).
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

  // DIRECTION 1 — named, and the draft kept.
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Description");
  await expect(description).toHaveValue(mine);

  // DIRECTION 2 — the editor's own save clears it, and a re-edit does not resurrect it. Before the fix
  // `conflicted` was never cleared on success, so this re-edit accused the human of overwriting a write
  // they had just deliberately replaced.
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect.poll(async () => (await readProfile()).description).toBe(mine);
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await description.fill(uniq("edited-again"));
  await expect(save).toBeEnabled();
  await expect(notice).toHaveCount(0); // THE REGRESSION: the stale flag reappeared here before the fix
});

test("Projects: the agent-prompt conflict notice retires after its own save and does not return on a re-edit", async ({ page, loomDaemon }) => {
  interface SeededAgent { id: string; name: string; startupPrompt: string; profileId: string | null }
  const project = await loomDaemon.createProject(uniq("promptconflict"));
  const agentName = uniq("Conflict-agent");
  const agent = await apiJson<SeededAgent>(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
    method: "POST", body: JSON.stringify({ name: agentName, startupPrompt: uniq("seeded prompt body") }),
  });
  const profileName = uniq("Conflict-profile");
  await seedProfile(loomDaemon.baseURL, {
    name: profileName, role: null, description: "", allowDelta: [], skills: null, model: null, icon: null,
  });
  const readAgent = async () => {
    const all = await apiJson<SeededAgent[]>(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`);
    const row = all.find((a) => a.id === agent.id);
    if (!row) throw new Error(`agent ${agent.id} not found`);
    return row;
  };

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/projects`);
  await page.getByRole("button").filter({ hasText: agentName }).first().click();
  const prompt = page.locator("textarea");
  await expect(prompt).toHaveValue(agent.startupPrompt);
  const notice = page.getByTestId("agent-prompt-conflict");
  await expect(notice).toHaveCount(0); // NEGATIVE CONTROL

  // TOUCH the prompt, then have an agent rewrite it, then refetch. The refetch is driven by assigning a
  // profile — the one OTHER field this form edits — because its save invalidates ["agents", projectId]
  // outright. That is deterministic in a way a focus/visibility event is not, and it leaves the prompt
  // itself untouched on the wire.
  const mine = uniq("my prompt body");
  await prompt.fill(mine);
  await apiJson<SeededAgent>(`${loomDaemon.baseURL}/api/agents/${agent.id}`, {
    method: "POST", body: JSON.stringify({ startupPrompt: uniq("agent rewrote the prompt") }),
  });
  await page.locator("select").filter({ hasText: "— none —" }).selectOption({ label: profileName });
  await expect.poll(async () => (await readAgent()).profileId).not.toBeNull();

  // DIRECTION 1 — surfaced, draft kept.
  await expect(notice).toBeVisible();
  await expect(prompt).toHaveValue(mine);

  // DIRECTION 2 — the editor's own save clears it, and re-editing does not bring it back.
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect.poll(async () => (await readAgent()).startupPrompt).toBe(mine);
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await prompt.fill(uniq("edited again"));
  await expect(save).toBeEnabled();
  await expect(notice).toHaveCount(0); // THE REGRESSION: the stale flag reappeared here before the fix
});

test("Profiles: a codex switch sends the cleared fields even when they already equal the seed", async ({ page, loomDaemon }) => {
  // THE GAP the delta opened. `clearCodexRejectedFields` makes the payload storable, but the delta then
  // drops any cleared field that already equals the SEED — and the seed is the row as it was at MOUNT. An
  // agent writing `browserTesting: true` afterwards leaves the store holding a value codex refuses, the
  // patch carries only `harness`, the server merges the two, and `validateProfile` 400s the save.
  const profile = await seedProfile(loomDaemon.baseURL, {
    name: uniq("Rig-codex-delta"), role: null, description: "", allowDelta: [], skills: null, model: null, icon: null,
  });
  // Fixture identity: the rejected fields really start CLEAR, so a cleared value in the patch below can
  // only have come from the forced include and not from a local edit.
  expect(profile.harness ?? null).toBeNull();
  expect(profile.browserTesting ?? false).toBe(false);

  await page.goto(`${loomDaemon.baseURL}/actors?profile=${profile.id}`);
  const browserToggle = page.locator("label", { hasText: "Browser testing" }).locator('input[type="checkbox"]');
  await expect(field(page, "Name")).toHaveValue(profile.name);
  await expect(browserToggle).not.toBeChecked();

  // The agent write — AFTER the editor has seeded from the clear row.
  await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, {
    method: "PUT", body: JSON.stringify({ browserTesting: true }),
  });
  expect((await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`)).browserTesting).toBe(true);
  // The editor must NOT have refetched — if it had, local would already be true and the forced include
  // would be untested. The precondition is asserted rather than assumed.
  await expect(browserToggle).not.toBeChecked();

  const bodies: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes(`/api/profiles/${profile.id}`)) bodies.push(req.postData() ?? "");
  });

  // EXERCISE — switch harness only. No reject warning shows (local holds nothing to clear), which is
  // precisely why the payload has to carry the clears anyway.
  await page.getByTestId("harness-card-codex").click();
  await expect(page.getByTestId("harness-reject-warning")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // AFTER — the save SUCCEEDED (pre-fix: 400 "browserTesting is not supported on harness codex").
  await expect(page.getByTestId("profile-save-error")).toHaveCount(0);
  await expect
    .poll(async () => (await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`)).harness)
    .toBe("codex");
  const stored = await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`);
  expect(stored.browserTesting).toBe(false);
  expect(stored.restrictedTools).toBe(false);
  expect(stored.documentConversion).toBe(false);
  // MECHANISM — the four rejected fields were on the wire explicitly, not left to the delta.
  expect(bodies.length).toBe(1);
  const sent = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
  expect(sent.harness).toBe("codex");
  expect(sent.browserTesting).toBe(false);
  expect(sent.restrictedTools).toBe(false);
  expect(sent.documentConversion).toBe(false);
  expect(sent.capabilities).toEqual([]);
  // ...and the editor settles rather than latching dirty against a store it just changed.
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
});
