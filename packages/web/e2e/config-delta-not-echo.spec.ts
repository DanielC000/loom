// Config delta-not-echo e2e spec (card 654869e2) — proves the three fixed write surfaces send only what
// the human changed, instead of echoing a whole server object back and wiping fields they do not model.
// Each test EXERCISES a real control (not a render check) and asserts an observable before/after over REST:
//
//   1. Settings › Board Columns — editing one lane's LABEL preserves `excludeFromIdleWatchdog` (and
//      accentColor / wipLimit) on an UNTOUCHED lane. The web UI has no control for that flag at all, so
//      before the fix any save here cleared it from every column and re-armed the idle watcher /
//      pending-request gate / wake-impact on a deliberate parking lane.
//   2. Runs › Keys & Endpoints — a key whose allowlisted agent is no longer an endpoint agent stays
//      SAVABLE. Before the fix the stale id was re-sent with no control to clear it and
//      validateEndpointAllowlist 400'd every save of that key, permanently.
//   3. Companion › Manage › Voice provisioning — toggling voice leaves an unrelated daemon-global
//      top-level scalar alone. Before the fix the whole cached platform override was spread back and the
//      platform PATCH shallow-merges top-level keys, so that scalar reverted to this page's stale copy.
//
// Builds on the shared `loomDaemon` fixture (its own LOOM_HOME under a temp dir, LOOM_PORT=0, pre-stamped
// first-run marker, LOOM_DEV=0, no-real-claude asserted) — the isolated throwaway daemon this card's DoD
// asks for, serving the built web dist directly, so there is no dev-proxy target to get wrong.
//
// FIXTURE IDENTITY — every test asserts on a UNIQUE seeded string (a column label, a key name, a scalar
// value) so a silent fall-through to another spec's project on this shared daemon fails loudly instead of
// reading plausibly green. Companion seeding is DB-direct via the fixture (never POST
// /api/companion/provision, which would spawn a real assistant session).
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;

const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** The project's STORED column array, straight off the config override — the field-level source of truth. */
async function storedColumns(baseURL: string, projectId: string) {
  const res = await fetch(`${baseURL}/api/projects`);
  if (!res.ok) throw new Error(`GET /api/projects failed: ${res.status}`);
  const projects = (await res.json()) as { id: string; config: { kanbanColumns?: Record<string, unknown>[] } }[];
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`project ${projectId} not found in /api/projects`);
  return project.config.kanbanColumns ?? [];
}

test("Board Columns: editing one lane's label preserves an agent-only field on another lane", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("colcarry"));
  // The parking lane carries the three fields the editor cannot (or could not) express. Its label is the
  // fixture identity: if the page ever renders a DIFFERENT project's board, this lane is simply absent.
  const parkedLabel = uniq("Dropped");
  const todoLabel = uniq("To-do");
  const putRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/columns`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      columns: [
        { key: "todo", label: todoLabel, role: "defaultLanding" },
        { key: "dropped", label: parkedLabel, role: "parked", accentColor: "#6b8afd", wipLimit: 3, excludeFromIdleWatchdog: true },
        { key: "done", label: "Done", role: "terminal" },
      ],
    }),
  });
  expect(putRes.ok).toBeTruthy();

  // BEFORE — the flag really is stored (otherwise the whole test is vacuous: it would "pass" against a
  // board that never carried the field at all).
  const before = await storedColumns(loomDaemon.baseURL, project.id);
  const beforeParked = before.find((c) => c.key === "dropped");
  expect(beforeParked).toBeDefined();
  expect(beforeParked?.label).toBe(parkedLabel); // fixture identity
  expect(beforeParked?.excludeFromIdleWatchdog).toBe(true);
  expect(beforeParked?.accentColor).toBe("#6b8afd");
  expect(beforeParked?.wipLimit).toBe(3);

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);
  await expect(page.getByText("Board Columns", { exact: true })).toBeVisible();

  // Confirm we are looking at THIS project's board before touching anything — the unique parked label in
  // the middle row is the identity check (another project's board simply does not carry it).
  const labels = page.getByLabel("Column label");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(1)).toHaveValue(parkedLabel);

  // EXERCISE — rename a DIFFERENT lane, then save. Nothing here touches the parking lane.
  // The "Save layout" button's own enabled→disabled flip is the observable: it is driven by this editor's
  // `dirty` diff, and it is unique to this panel (the plain "saved"/"unsaved changes" chips are not —
  // /settings renders several panels with their own).
  const renamed = uniq("Backlog");
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await expect(saveLayout).toBeDisabled();
  await labels.nth(0).fill(renamed);
  await expect(saveLayout).toBeEnabled();
  await saveLayout.click();
  await expect(saveLayout).toBeDisabled();

  // AFTER — the rename landed AND the untouched lane kept every field the editor does not model.
  const after = await storedColumns(loomDaemon.baseURL, project.id);
  expect(after.find((c) => c.key === "todo")?.label).toBe(renamed);
  const afterParked = after.find((c) => c.key === "dropped");
  expect(afterParked?.label).toBe(parkedLabel);
  expect(afterParked?.excludeFromIdleWatchdog).toBe(true); // THE REGRESSION: was undefined before the fix
  expect(afterParked?.accentColor).toBe("#6b8afd");
  expect(afterParked?.wipLimit).toBe(3);
});

test("Keys & Endpoints: a key allowlisting a since-un-flagged agent is still savable", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("keycarry"));
  const agentName = uniq("Endpoint-agent");
  const agentRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: agentName }),
  });
  expect(agentRes.ok).toBeTruthy();
  const agent = (await agentRes.json()) as { id: string };

  // Flag it as an endpoint, mint a key allowlisting it, then UN-flag it — the exact one-click sequence
  // reachable from this very page that used to brick the key's editor.
  const flag = async (endpoint: boolean) => {
    const r = await fetch(`${loomDaemon.baseURL}/api/agents/${agent.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    expect(r.ok).toBeTruthy();
  };
  await flag(true);

  const keyName = uniq("prod-key");
  const keyRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: keyName, endpointAgentIds: [agent.id], caps: {} }),
  });
  expect(keyRes.ok).toBeTruthy();
  await flag(false);

  // BEFORE — the stored key still carries the now-ineligible grant (the precondition under test).
  const listBefore = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/keys`);
  const keysBefore = (await listBefore.json()) as { id: string; name: string; endpointAgentIds: string[] }[];
  const seeded = keysBefore.find((k) => k.name === keyName); // fixture identity
  expect(seeded).toBeDefined();
  expect(seeded?.endpointAgentIds).toContain(agent.id);

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/runs`);
  await page.getByRole("tab", { name: "Keys & Endpoints" }).click();
  await expect(page.getByText(keyName, { exact: false }).first()).toBeVisible();

  // EXERCISE — open the editor, rename the key, save. The ineligible grant has no checkbox to untick, so
  // before the fix this save 400'd on `validateEndpointAllowlist` and the key could never be edited again.
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByText(/no longer\s+an endpoint agent/)).toBeVisible();
  await expect(page.getByText(agentName, { exact: false }).first()).toBeVisible();
  const renamedKey = uniq("prod-key-renamed");
  // KeyAdmin's `Labeled` renders a SectionLabel <div>, not a <label>, so the Name field is located by its
  // own placeholder (only one KeyForm — create or edit — is ever open at a time).
  const nameField = page.getByPlaceholder("e.g. Invest app — prod");
  await nameField.fill(renamedKey);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // AFTER — the save actually committed (the editor closed), the rename landed, and the ineligible grant
  // was dropped rather than re-sent.
  await expect(page.getByText(renamedKey, { exact: false }).first()).toBeVisible();
  const listAfter = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/keys`);
  const keysAfter = (await listAfter.json()) as { id: string; name: string; endpointAgentIds: string[] }[];
  const saved = keysAfter.find((k) => k.id === seeded?.id);
  expect(saved?.name).toBe(renamedKey);
  expect(saved?.endpointAgentIds).not.toContain(agent.id);
});

test("Keys & Endpoints: an UNLOADED endpoint-agent list blocks the save instead of stripping grants", async ({ page, loomDaemon }) => {
  // The regression the first fix introduced and review caught: eligibility was applied in a useState
  // INITIALIZER, which reads the eligible set once at mount. With the agents query unresolved that set is
  // empty, so the seed dropped EVERY grant and a save that only renamed the key silently stripped them
  // all. Failing the agents request outright is the cleanest way to hold the UI in that state for the
  // whole test — it is also a state a real user hits on a flaky first load.
  const project = await loomDaemon.createProject(uniq("keyunloaded"));
  const agentName = uniq("Endpoint-agent");
  const agentRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: agentName }),
  });
  expect(agentRes.ok).toBeTruthy();
  const agent = (await agentRes.json()) as { id: string };
  const flagRes = await fetch(`${loomDaemon.baseURL}/api/agents/${agent.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: true }),
  });
  expect(flagRes.ok).toBeTruthy();

  const keyName = uniq("grants-key");
  const keyRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: keyName, endpointAgentIds: [agent.id], caps: {} }),
  });
  expect(keyRes.ok).toBeTruthy();
  const created = (await keyRes.json()) as { key: { id: string } };

  const readKey = async () => {
    const r = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/keys`);
    expect(r.ok).toBeTruthy();
    const all = (await r.json()) as { id: string; name: string; endpointAgentIds: string[] }[];
    const row = all.find((k) => k.id === created.key.id);
    expect(row).toBeDefined();
    return row!;
  };

  // BEFORE — the grant is stored and the agent IS still a legitimate endpoint, so nothing here is
  // genuinely ineligible. Any drop would be pure fetch-state artifact.
  expect((await readKey()).endpointAgentIds).toEqual([agent.id]);

  // Fail ONLY the endpoint-agent list. The keys list (/keys) and the config PATCH are left alone, so the
  // page still renders the key row and the editor can be opened.
  await pinActiveProject(page, project.id);
  await page.route("**/api/projects/*/agents", (route) => route.abort());
  await page.goto(`${loomDaemon.baseURL}/runs`);
  await page.getByRole("tab", { name: "Keys & Endpoints" }).click();
  await expect(page.getByText(keyName, { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).first().click();

  // The editor must say the list is unavailable, and REFUSE to save — not quietly offer a smaller grant.
  await expect(page.getByText(/Endpoint agents could not be loaded/)).toBeVisible();
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  // Try to commit anyway, the way an impatient user would: edit the name, then click the disabled button
  // (force, so the click is dispatched regardless) — the submit handler's own gate must still hold.
  const nameField = page.getByPlaceholder("e.g. Invest app — prod");
  await nameField.fill(uniq("renamed-while-unloaded"));
  await save.click({ force: true });

  // AFTER — nothing was written at all: the grant survives AND the rename did not land.
  const blocked = await readKey();
  expect(blocked.endpointAgentIds).toEqual([agent.id]); // THE REGRESSION: was [] before this fix
  expect(blocked.name).toBe(keyName);

  // POSITIVE HALF — with the list reachable again the same editor saves normally and KEEPS the grant, so
  // the gate above is a real precondition and not a permanently-stuck button.
  await page.unroute("**/api/projects/*/agents");
  await page.reload();
  await page.getByRole("tab", { name: "Keys & Endpoints" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByText(/Endpoint agents could not be loaded/)).toHaveCount(0);
  const renamed = uniq("renamed-when-loaded");
  await page.getByPlaceholder("e.g. Invest app — prod").fill(renamed);
  const saveAgain = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveAgain).toBeEnabled();
  await saveAgain.click();
  await expect(page.getByText(renamed, { exact: false }).first()).toBeVisible();

  const after = await readKey();
  expect(after.name).toBe(renamed);
  expect(after.endpointAgentIds).toEqual([agent.id]); // an eligible grant is never dropped
});

test("Voice provisioning: toggling voice leaves an unrelated daemon-global scalar alone", async ({ page, loomDaemon }) => {
  const companion = await loomDaemon.seedCompanion({ name: uniq("voice-companion") });

  const setGates = async (maxConcurrentGates: number) => {
    const r = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { maxConcurrentGates } }),
    });
    expect(r.ok).toBeTruthy();
  };
  const readPlatform = async () => {
    const r = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
    expect(r.ok).toBeTruthy();
    return (await r.json()) as { override: Record<string, unknown>; resolved: Record<string, unknown> };
  };

  // TIMING IS THE WHOLE TEST. The defect needs the echoed override to be STALE, so the scalar has to
  // change AFTER this page cached it — seeding it beforehand makes the echo re-assert the same value and
  // the test passes against the bug (measured: an earlier draft of this test did exactly that and stayed
  // green under a reverted fix). So: seed a FIRST value, let the page load and cache it, then move it over
  // REST — standing in for the owner changing it from Settings, or in another tab, after this page opened.
  const staleGates = 2;
  const liveGates = 5;
  await setGates(staleGates);

  const before = await readPlatform();
  expect(before.override.maxConcurrentGates).toBe(staleGates);
  expect(before.resolved.companionVoiceEnabled).toBe(false); // the state the toggle will flip

  await pinActiveProject(page, companion.projectId);
  await page.goto(`${loomDaemon.baseURL}/companion`);
  await page.getByRole("tab", { name: "Manage" }).click();
  // Scope to the Voice provisioning <section>: the Manage tab stacks several sections whose own
  // Enable/Disable buttons would otherwise make these locators ambiguous.
  const voice = page.locator("section").filter({ has: page.getByText("Voice provisioning", { exact: true }) });
  await expect(voice.getByText("Voice provisioning", { exact: true })).toBeVisible();
  // The section's own rendered state proves its platformConfig query has RESOLVED (so the override really
  // is cached) — without this the click could race the first fetch and echo an empty object instead.
  await expect(voice.getByRole("button", { name: "Enable", exact: true })).toBeVisible();

  // The cache is now stale by construction.
  await setGates(liveGates);
  expect((await readPlatform()).override.maxConcurrentGates).toBe(liveGates);

  // EXERCISE — flip the toggle and wait for the enabled state to actually land (not just the click).
  await voice.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(voice.getByRole("button", { name: "Disable", exact: true })).toBeVisible();

  // AFTER — voice flipped, and the unrelated scalar was NOT dragged back to this page's stale copy.
  const after = await readPlatform();
  expect(after.resolved.companionVoiceEnabled).toBe(true);
  expect(after.override.companionVoiceEnabled).toBe(true);
  expect(after.override.maxConcurrentGates).toBe(liveGates); // THE REGRESSION: reverted to 2 before the fix

  // Leave the shared daemon's global state as we found it (this page's config is daemon-global, so a
  // leftover `companionVoiceEnabled:true` / raised gate cap is a forward leak into every later spec).
  // `maxConcurrentGates` clears to inherit via the explicit-null sentinel; `companionVoiceEnabled` is the
  // one key on `platformConfigPatchSchema` that is NOT `.nullable()`, so it has no clear path and is
  // restored by writing its platform default (false) back explicitly — resolves identically.
  const restore = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { companionVoiceEnabled: false, maxConcurrentGates: null } }),
  });
  expect(restore.ok).toBeTruthy();
  const restored = await readPlatform();
  expect(restored.resolved.companionVoiceEnabled).toBe(false);
  expect(restored.override.maxConcurrentGates).toBeUndefined();
});
