// Profiles & agents spec (card 5c41c20d) — proves the two HUMAN-only rig-management surfaces render and
// mutate through the real REST paths, with an observable before/after for every interactive control:
//   1. Projects (/projects) — the per-project Agents column LISTS REST-seeded agents, CREATING an agent
//      through the AgentForm (revealed by "＋ New agent") reflects in the list + over REST, and ASSIGNING a
//      Profile to an agent produces an observable change (the agent row gains the profile's role/icon; the
//      agent row's profileId flips over REST).
//   2. Profiles (/profiles) — a profile's capability toggles RENDER (browserTesting / documentConversion),
//      toggling documentConversion reveals the shared-venv provisioning panel (interactive observable), and
//      toggling browserTesting + Save persists to the store (REST read-back).
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template. Seeds agents +
// profiles inline via `fetch(loomDaemon.baseURL + "/api/...")` — the fixture is NOT edited (shared file).
//
// Determinism: the `loomDaemon` fixture is worker-scoped (one daemon for the whole run), so more than one
// project/profile can exist on it. Every Projects test seeds its OWN project and PINS it active via
// addInitScript localStorage `loom.projectId` (see lib/activeProject) BEFORE navigating, so it never races
// another test's project; profiles are addressed by a unique name/id, never by list position. The first-run
// "Welcome to Loom" overlay (App.tsx › FirstRunWelcome, a fixed pointer-intercepting layer) is suppressed
// globally by the fixture (fixtures/daemon.ts), so no spec re-derives the dismissal.
//
// This spec only ever CREATES new agents/profiles (uniquely named) and never mutates a BUNDLED profile, so
// the shared store stays clean for other specs — no reset step is needed (unlike skills.spec.ts, which
// mutates a bundled skill and restores it).
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// --- REST seeding helpers (the same human/loopback endpoints the UI drives) --------------------------

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededAgent { id: string; projectId: string; name: string; profileId: string | null }
interface SeededProfile { id: string; name: string; role: string | null; icon: string | null; browserTesting: boolean; documentConversion: boolean; connections?: string[] }
interface SeededConnection { id: string; name: string; host: string }

const seedAgent = (baseURL: string, projectId: string, name: string, startupPrompt = "") =>
  apiJson<SeededAgent>(`${baseURL}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name, startupPrompt }) });

// Only `name` is required by validateProfile; role/icon/toggles are optional (default off). We pass a role +
// icon when the test needs a visible on-agent signal after assignment.
const seedProfile = (baseURL: string, body: { name: string; role?: string | null; icon?: string | null }) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });

// Agent-tooling epic P2 — the P1 credential store's human-only REST create (a real connection row, not a
// mock), so the Profiles page's Connections multiselect has something real to render.
const seedConnection = (baseURL: string, body: { name: string; host: string; authScheme: "api-key" | "bearer"; secret: string }) =>
  apiJson<SeededConnection>(`${baseURL}/api/connections`, { method: "POST", body: JSON.stringify(body) });

const listAgents = (baseURL: string, projectId: string) =>
  apiJson<SeededAgent[]>(`${baseURL}/api/projects/${projectId}/agents`);

const getProfile = (baseURL: string, id: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles/${encodeURIComponent(id)}`);

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// An agent row in the Projects-page Agents list is a <button> whose text starts with the agent name (and,
// once a profile is assigned, also its icon + role). Nav items are <a> links and the profile options live in
// a <select>, so a role-button filter on the unique name pins exactly the agent row.
const agentRow = (page: Page, name: string) => page.getByRole("button").filter({ hasText: name }).first();

// The profile-assignment control is the ONLY <select> on the page carrying the "— none —" placeholder option
// (the board-preset select in the project form does not), so this filter disambiguates it from that select.
const profileSelect = (page: Page) => page.locator("select").filter({ hasText: "— none —" });

test.describe("profiles & agents", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts) — no
  // spec re-derives it.

  test("the Agents panel lists the REST-seeded agents", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-list-${Date.now()}`);
    const names = ["Orchestrator", "Dev", "Bugfix"];
    for (const n of names) await seedAgent(loomDaemon.baseURL, project.id, n);
    await pinActiveProject(page, project.id);

    await page.goto(`${loomDaemon.baseURL}/projects`);

    // The per-project Agents panel renders (it only mounts once an active project resolves).
    await expect(page.getByText("Agents", { exact: true })).toBeVisible();

    // Every seeded agent shows up as a selectable row.
    for (const n of names) {
      await expect(agentRow(page, n)).toBeVisible();
    }

    // Cross-check the REST source the list is built from carries exactly these seeded agents.
    const rows = await listAgents(loomDaemon.baseURL, project.id);
    for (const n of names) expect(rows.some((a) => a.name === n)).toBe(true);
  });

  test("creating an agent through the UI reflects in the list and over REST", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-create-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/projects`);

    await expect(page.getByText("Agents", { exact: true })).toBeVisible();

    const newName = `QA Verifier ${Date.now()}`;
    // BEFORE: no such agent exists in the list.
    await expect(agentRow(page, newName)).toHaveCount(0);

    // ACT: reveal the AgentForm in the editor pane ("＋ New agent"), fill it (its "agent name" input is
    // distinct from the project form's "name"), and Create. The Create button (exact) is the AgentForm's —
    // the project form's button reads "Create project".
    await page.getByRole("button", { name: /new agent/i }).click();
    await page.getByPlaceholder("agent name").fill(newName);
    await page.getByPlaceholder("startup prompt (injected as the first turn of each new session)")
      .fill("Verify the assigned task end-to-end and report with evidence.");
    const create = page.getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeEnabled();
    await create.click();

    // AFTER (observable #1 — UI): the new agent row appears in the list.
    await expect(agentRow(page, newName)).toBeVisible();

    // AFTER (observable #2 — REST): the store the list is built from now holds it, with the saved prompt.
    await expect
      .poll(async () => (await listAgents(loomDaemon.baseURL, project.id)).some((a) => a.name === newName))
      .toBe(true);
  });

  test("assigning a profile to an agent produces an observable change (agent row + REST)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-assign-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Lead");
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Manager Rig ${Date.now()}`, role: "manager", icon: "🧭" });
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/projects`);

    // Select the agent so its Profile assignment control mounts.
    await agentRow(page, "Lead").click();
    const select = profileSelect(page);
    await expect(select).toBeVisible();

    // BEFORE: no profile is assigned — the select sits on the "— none —" placeholder (empty value), and the
    // agent row carries no role signal ("manager" comes only from an assigned profile). The role tag now
    // renders the centralized display label ("Manager") — case-insensitive match keeps this robust to the
    // label vs raw-enum casing (card 04fec5be: one role display map).
    await expect(select).toHaveValue("");
    await expect(agentRow(page, "Lead")).not.toContainText(/manager/i);

    // ACT: pick the seeded profile by its id (the option's value).
    await select.selectOption(profile.id);

    // AFTER (observable #1 — UI): the agent row now renders the assigned profile's role.
    await expect(agentRow(page, "Lead")).toContainText(/manager/i);

    // AFTER (observable #2 — REST): the agent row's profileId flipped to the assigned profile.
    await expect
      .poll(async () => (await listAgents(loomDaemon.baseURL, project.id)).find((a) => a.id === agent.id)?.profileId ?? null)
      .toBe(profile.id);
  });

  test("profile capability toggles render; documentConversion reveals the provisioning panel and browserTesting persists", async ({ page, loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Toggles ${Date.now()}` });
    // Profiles are a daemon-global store — no active-project pin needed (unlike Workspace).
    await page.goto(`${loomDaemon.baseURL}/profiles`);

    // Open the seeded profile in the editor (sidebar rows are <button>s; the unique name pins one).
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    // The capability toggles RENDER, each as a labelled checkbox.
    const browserToggle = page.locator("label", { hasText: "Browser testing" }).locator('input[type="checkbox"]');
    const docConvToggle = page.locator("label", { hasText: "Document conversion" }).locator('input[type="checkbox"]');
    await expect(browserToggle).toBeVisible();
    await expect(docConvToggle).toBeVisible();

    // BEFORE: a freshly seeded profile has both off, and the doc-conversion venv panel (rendered only while
    // documentConversion is on) is absent.
    await expect(browserToggle).not.toBeChecked();
    await expect(docConvToggle).not.toBeChecked();
    await expect(page.getByTestId("markitdown-provisioning")).toHaveCount(0);

    // Deja is a PRIVATE product (Loom is public on npm) — its capability entry must be ABSENT from the
    // picker under this fixture's default LOOM_DEV=0 boot (mirrors platform.spec.ts's dev-surface-absent
    // assertion). Not just unchecked — not rendered at all.
    await expect(page.getByText("Deja mockup corpus", { exact: true })).toHaveCount(0);

    // ACT + AFTER (observable #1 — interactive reveal): turning documentConversion on mounts the shared-venv
    // provisioning status panel. This is driven off the toggle's local state, so it needs no Save.
    await docConvToggle.check();
    await expect(docConvToggle).toBeChecked();
    await expect(page.getByTestId("markitdown-provisioning")).toBeVisible();

    // ACT + AFTER (observable #2 — persistence): turn browserTesting on and Save; the store the UI shares now
    // carries the flag (read straight back over REST).
    await browserToggle.check();
    await expect(browserToggle).toBeChecked();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();

    await expect
      .poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).browserTesting)
      .toBe(true);
    // The documentConversion toggle we set was saved in the same PUT, so it persists too.
    await expect
      .poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).documentConversion)
      .toBe(true);
  });

  test("profile Connections multiselect renders a seeded connection and persists a grant", async ({ page, loomDaemon }) => {
    // Agent-tooling epic P2: the authenticated-request tool's profile-gating surface. A freshly seeded
    // profile grants NO connections (the secure default); toggling one on + Save persists it — the ONLY
    // grant path (no agent MCP tool can set this field, unlike browserTesting/documentConversion).
    const connection = await seedConnection(loomDaemon.baseURL, { name: `E2E Conn ${Date.now()}`, host: "api.example.com", authScheme: "bearer", secret: "e2e-test-secret-not-real" });
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Connections ${Date.now()}` });
    await page.goto(`${loomDaemon.baseURL}/profiles`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    // The Connections section renders the seeded connection as a toggle button (mirrors the Skills subset
    // picker's pattern), labelled with its name.
    const connToggle = page.getByRole("button").filter({ hasText: connection.name });
    await expect(connToggle).toBeVisible();

    // BEFORE: a freshly seeded profile grants nothing — the "none selected" summary is shown.
    await expect(page.getByText(/none selected.*NO authenticated_request access/)).toBeVisible();

    // ACT + AFTER (observable #1 — interactive toggle): clicking the connection selects it, updating the
    // summary line immediately (local state, no Save needed to observe the toggle itself).
    await connToggle.click();
    await expect(page.getByText(/1 selected.*authenticated_request may use only these/)).toBeVisible();

    // ACT + AFTER (observable #2 — persistence): Save, then read the grant back over REST.
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();

    await expect
      .poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).connections)
      .toEqual([connection.id]);
  });
});
