// Settings spec (card 18e27876) — proves the Settings page (/settings) both RENDERS the resolved config
// and PERSISTS edits through the human/REST config path. Two write surfaces are covered end to end with an
// observable before/after:
//   1. Project config (PATCH /api/projects/:id/config) — the human-only `gateCommand` field (editable here
//      by design; only the agent MCP validator rejects it) round-trips: type → Save → REST read-back shows
//      it → reload re-seeds it into the field.
//   2. Daemon-global platform config (PATCH /api/platform/config) — a watcher/timeout field round-trips to
//      the stored override (canonical ms), read back over REST.
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template.
//
// Determinism note: the Settings project section is scoped to the ACTIVE project (localStorage
// `loom.projectId`, see lib/activeProject.tsx). The worker-scoped daemon is SHARED across the specs in this
// file, so more than one project can exist on it and the auto-resolved "first project" is not stable. Every
// test therefore PINS its own seeded project as active via addInitScript BEFORE navigating, so it never
// races another test's project.
import { expect, test } from "./fixtures/daemon";

// Locate a config field's control by the EXACT text of its label <span>. getByLabel is unusable here: each
// field's <label> also nests its Hint text, which pollutes the accessible name AND makes "Gate command"
// collide with "Gate command timeout (s)". `label:has(> span:text-is(...))` pins the exact label span, then
// descends to the control — precise regardless of the hint text.
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}

async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test("renders the active project's config and the daemon-global config", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-render-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Project section renders, scoped to the pinned project.
  await expect(page.getByText("Project Settings", { exact: true })).toBeVisible();
  await expect(page.getByText("Editing", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Orchestration Caps", { exact: true })).toBeVisible();
  await expect(field(page, "Gate command")).toBeVisible();
  // A resolved "effective: …" hint confirms the seeded/default config actually resolved (not just an empty
  // shell) — resolveConfig ran and rendered real values.
  await expect(page.getByText(/effective:/).first()).toBeVisible();

  // The daemon-global section loads over GET /api/platform/config; "Rate Limits" only appears once that
  // query resolves, so asserting it visible also proves the platform-config read endpoint works.
  await expect(page.getByText("Global / Daemon", { exact: true })).toBeVisible();
  await expect(page.getByText("Rate Limits", { exact: true })).toBeVisible();
  await expect(field(page, "Git push (s)")).toBeVisible();
});

test("editing the project gate command persists (REST read-back + reload)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-project-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const gate = field(page, "Gate command");
  // BEFORE: a freshly seeded project has no gateCommand override, so the field is empty.
  await expect(gate).toHaveValue("");

  await gate.fill("pnpm build");
  // The ConfigEditor Save is the FIRST "Save" button in DOM order (the project section precedes the global
  // section; RepoPathEditor's button is "Rebind", not "Save"). It enables only once the form is dirty.
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  // AFTER (observable #1): the human/REST config path persisted it — read it straight back off the store the
  // UI shares. gateCommand is the card's named human-only field; it is editable on THIS path by design.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { gateCommand?: string } } }>;
      return projects.find((p) => p.id === project.id)?.config?.orchestration?.gateCommand ?? null;
    })
    .toBe("pnpm build");

  // AFTER (observable #2): a full reload re-seeds the field from the persisted override — not just optimistic
  // client state.
  await page.reload();
  await expect(field(page, "Gate command")).toHaveValue("pnpm build");
});

test("toggling dejaCapture persists through the human/REST config path (REST read-back + reload)", async ({ page, loomDaemon }) => {
  // dejaCapture is a HUMAN-ONLY per-project toggle — dropped from the agent config schema, settable ONLY on
  // this REST PATCH path (mirrors gateCommand above). Proves the new TriSelect round-trips on/off.
  const project = await loomDaemon.createProject(`settings-deja-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  const deja = field(page, "Ingest agent-written mockups into Deja");
  // BEFORE: a freshly seeded project has no dejaCapture override, so the TriSelect sits on "inherit".
  await expect(deja).toHaveValue("inherit");

  await deja.selectOption("true");
  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  // AFTER (observable #1): the human/REST config path persisted dejaCapture=true — read it straight off the
  // store the UI shares.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { dejaCapture?: boolean } }>;
      return projects.find((p) => p.id === project.id)?.config?.dejaCapture ?? null;
    })
    .toBe(true);

  // AFTER (observable #2): a full reload re-seeds the TriSelect from the persisted override.
  await page.reload();
  await expect(field(page, "Ingest agent-written mockups into Deja")).toHaveValue("true");

  // ROUND-TRIP OFF: flip it to "false" and confirm the override persists the explicit off (not merely
  // dropped) — the observable inverse of the on-toggle above.
  const dejaAfter = field(page, "Ingest agent-written mockups into Deja");
  await dejaAfter.selectOption("false");
  await expect(projectSave).toBeEnabled();
  await projectSave.click();
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { dejaCapture?: boolean } }>;
      return projects.find((p) => p.id === project.id)?.config?.dejaCapture ?? null;
    })
    .toBe(false);
});

test("editing a daemon-global setting persists to the platform override", async ({ page, loomDaemon }) => {
  // Pin a project so the page is fully populated, though the global section is project-independent.
  const project = await loomDaemon.createProject(`settings-global-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Wait for the platform-config query to resolve (the global fields only mount after it loads).
  const gitPush = field(page, "Git push (s)");
  await expect(gitPush).toBeVisible();

  // 47s is an arbitrary non-default value so the read-back is unambiguous. The form displays SECONDS and
  // stores canonical ms (×1000).
  await gitPush.fill("47");
  // The global Save is the LAST "Save" button (the global section follows the project section in DOM order).
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  await expect(globalSave).toBeEnabled();
  await globalSave.click();

  // Observable: the platform override now carries gitPushMs = 47_000 (47s in canonical ms).
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/platform/config`);
      const body = (await res.json()) as { override?: { timeouts?: { gitPushMs?: number } } };
      return body?.override?.timeouts?.gitPushMs ?? null;
    })
    .toBe(47_000);
});
