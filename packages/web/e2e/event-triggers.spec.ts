// Event Triggers UI spec (card T3 — the human management surface over the Loom Event Triggers subsystem).
// Proves the page does its job with an OBSERVABLE before/after for each control:
//   1. Build a SPAWN trigger through the modal — pick an event kind (from the shared allowlist) + scope +
//      mode Spawn + a target agent → Create → the row appears in the table AND the REST list carries the
//      right eventKind/mode/agentId (the pickers composed correctly).
//   2. Mode↔target coherence — the Create button is DISABLED until the active mode's target is chosen
//      (wake needs a session, spawn needs an agent); an observable enable when the agent is picked. The
//      daemon 404s a REST wake-create with no session (the server-side backstop the client mirrors).
//   3. Inline enable/disable — the table's On/Off toggle flips the row AND the REST row's `enabled`.
// Event Triggers are daemon-GLOBAL (a trigger's project scope is a field; its target may be any project's
// session/agent), so the page is NOT active-project-scoped — no project pin needed. Builds on the shared
// `loomDaemon` fixture; schedules.spec.ts / poll-jobs.spec.ts are the templates.
import { expect, test, type Page } from "./fixtures/daemon";

interface TriggerRow { id: string; eventKind: string; projectId: string | null; mode: "wake" | "spawn"; targetSessionId: string | null; agentId: string | null; enabled: boolean }

async function seedAgent(baseURL: string, projectId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/agents`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`seed agent -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function listTriggers(baseURL: string): Promise<TriggerRow[]> {
  const res = await fetch(`${baseURL}/api/event-triggers`);
  return (await res.json()) as TriggerRow[];
}

// The modal is a role="dialog"; scoping to it keeps locators unambiguous. The three selects are pinned by
// distinctive option text that only ever appears in one of them.
const dialog = (page: Page) => page.getByRole("dialog");
const kindSelect = (page: Page) => dialog(page).locator("select").filter({ hasText: "Merge rejected" });
const scopeSelect = (page: Page) => dialog(page).locator("select").filter({ hasText: "All projects" });
const agentSelect = (page: Page) => dialog(page).locator("select").filter({ hasText: "select an agent" });

test.describe("event triggers UI", () => {
  // Event triggers persist on the SHARED worker daemon, and the dispatcher is ALWAYS ON (unlike the
  // scheduler, which is off in e2e). A trigger this spec leaves ENABLED could fire on an orchestration
  // event a LATER spec seeds (e.g. worker_stuck / merge_request) and spawn a real claude — tripping the
  // fixture's no-spawn guard. Delete every trigger after each test (only this spec creates them) so
  // nothing survives to fire downstream.
  test.afterEach(async ({ loomDaemon }) => {
    for (const t of await listTriggers(loomDaemon.baseURL)) {
      await fetch(`${loomDaemon.baseURL}/api/event-triggers/${t.id}`, { method: "DELETE" });
    }
  });

  test("build a spawn trigger through the modal → table + REST", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`et-${stamp}`);
    const agentName = `Bugfix ${stamp}`;
    const agent = await seedAgent(loomDaemon.baseURL, project.id, agentName);

    await page.goto(`${loomDaemon.baseURL}/event-triggers`);

    // Open the modal.
    await page.getByRole("button", { name: /new trigger/i }).click();
    await expect(dialog(page)).toBeVisible();

    const create = dialog(page).getByRole("button", { name: /create trigger/i });
    // Default mode is Wake with no session chosen → Create is blocked (the coherence gate).
    await expect(create).toBeDisabled();

    // Pick an event kind from the shared allowlist.
    await kindSelect(page).selectOption({ value: "worker_stuck" });
    // Scope stays "All projects" (null) by default — leave it.
    await expect(scopeSelect(page)).toHaveValue("");

    // Switch to Spawn → the target picker swaps to the AGENT select; pick our seeded agent.
    await dialog(page).getByRole("button", { name: /spawn an agent/i }).click();
    await agentSelect(page).selectOption({ label: `${project.name} / ${agentName}` });

    // OBSERVABLE: the target is now coherent, so Create flips to enabled.
    await expect(create).toBeEnabled();
    await create.click();

    // AFTER (UI): the modal closes and a table row carries the humanized kind + raw kind + the target.
    await expect(dialog(page)).toHaveCount(0);
    const row = page.locator("tr", { hasText: `${project.name} / ${agentName}` });
    await expect(row).toBeVisible();
    await expect(row.getByText("Worker stuck")).toBeVisible();
    await expect(row.getByText("worker_stuck")).toBeVisible();
    await expect(row.getByText("spawn", { exact: true })).toBeVisible();

    // AFTER (REST): the store the table is built from carries the trigger with its kind/mode/agent.
    const rows = await listTriggers(loomDaemon.baseURL);
    const created = rows.find((t) => t.agentId === agent.id);
    expect(created).toBeTruthy();
    expect(created!.eventKind).toBe("worker_stuck");
    expect(created!.mode).toBe("spawn");
    expect(created!.projectId).toBeNull();
    expect(created!.targetSessionId).toBeNull();
  });

  test("mode↔target coherence (client gate + server 404)", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`et-coh-${stamp}`);
    const agentName = `Agent ${stamp}`;
    await seedAgent(loomDaemon.baseURL, project.id, agentName);
    // Seed a live session so the wake target picker is NON-empty — this makes the "wake mode requires a
    // target session" inline reason deterministic (the empty-picker case shows a different message).
    await loomDaemon.seedLiveSession({ agentName: `Coh ${stamp}`, title: `coh-sess-${stamp}` });

    await page.goto(`${loomDaemon.baseURL}/event-triggers`);
    await page.getByRole("button", { name: /new trigger/i }).click();
    await expect(dialog(page)).toBeVisible();

    const create = dialog(page).getByRole("button", { name: /create trigger/i });
    // Wake mode, no session → blocked, with an inline reason.
    await expect(create).toBeDisabled();
    await expect(dialog(page).getByText(/wake mode requires a target session/i)).toBeVisible();

    // Switch to Spawn — still blocked until an agent is chosen (the target swapped, coherence re-evaluated).
    await dialog(page).getByRole("button", { name: /spawn an agent/i }).click();
    await expect(create).toBeDisabled();
    await expect(dialog(page).getByText(/spawn mode requires a target agent/i)).toBeVisible();

    // Picking the agent flips the SAME button to enabled — the observable state change.
    await agentSelect(page).selectOption({ label: `${project.name} / ${agentName}` });
    await expect(create).toBeEnabled();

    // Server backstop: a REST wake-create with no targetSessionId is rejected 404 (client mirrors it).
    const res = await fetch(`${loomDaemon.baseURL}/api/event-triggers`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventKind: "worker_stuck", projectId: null, mode: "wake" }),
    });
    expect(res.status).toBe(404);
  });

  test("the table's On/Off toggle enables/disables a trigger", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    // A seeded LIVE session gives us a real wake target (mode "wake" needs an existing session).
    const seeded = await loomDaemon.seedLiveSession({ agentName: `Watcher ${stamp}`, title: `wake-target-${stamp}` });

    // Seed an ENABLED wake trigger directly over REST, then flip it from the table.
    const created = await fetch(`${loomDaemon.baseURL}/api/event-triggers`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventKind: "merge_request", projectId: null, mode: "wake", targetSessionId: seeded.sessionId }),
    }).then((r) => r.json()) as { id: string };

    await page.goto(`${loomDaemon.baseURL}/event-triggers`);
    // Locate the row by its unique target session label (project / agent · title).
    const row = page.locator("tr", { hasText: `wake-target-${stamp}` });
    await expect(row).toBeVisible();

    // BEFORE: the toggle reads ON.
    const toggle = row.getByRole("button", { name: /^on$/i });
    await expect(toggle).toBeVisible();

    // ACT: click it (stopPropagation keeps the row-click editor from opening).
    await toggle.click();

    // AFTER (UI): the toggle now reads OFF.
    await expect(row.getByRole("button", { name: /^off$/i })).toBeVisible();
    // AFTER (REST): the row's enabled flag flipped to false.
    await expect.poll(async () => (await listTriggers(loomDaemon.baseURL)).find((t) => t.id === created.id)?.enabled).toBe(false);
  });
});
