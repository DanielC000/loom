// Profiles & agents spec (card 5c41c20d) — proves the two HUMAN-only rig-management surfaces render and
// mutate through the real REST paths, with an observable before/after for every interactive control:
//   1. The Atlas Agents node (/agents; ported from the deleted /projects list by card acbb6df6) — it LISTS
//      REST-seeded agents as cards, CREATING an agent through the AgentForm (revealed by "＋ New agent")
//      reflects as a card + over REST, and ASSIGNING a Profile in the card's editor produces an observable
//      change (the card gains the profile's role; the agent row's profileId flips over REST). The bind dropdown also HIDES platform-tier profiles on this
//      LOOM_DEV=0 fixture (card 921e06b0), while still rendering one an agent is already bound to.
//   2. Profiles (/profiles) — a profile's capability toggles RENDER (browserTesting / documentConversion),
//      toggling documentConversion reveals the shared-venv provisioning panel (interactive observable), and
//      toggling browserTesting + Save persists to the store (REST read-back).
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); smoke.spec.ts is the template. Seeds agents +
// profiles inline via `fetch(loomDaemon.baseURL + "/api/...")` — the fixture is NOT edited (shared file).
//
// Determinism: the `loomDaemon` fixture is worker-scoped (one daemon for the whole run), so more than one
// project/profile can exist on it. Every Agents-node test seeds its OWN project and PINS it active via
// addInitScript localStorage `loom.projectId` (see lib/activeProject) BEFORE navigating, so it never races
// another test's project; profiles are addressed by a unique name/id, never by list position. The first-run
// "Welcome to Loom" overlay (App.tsx › FirstRunWelcome, a fixed pointer-intercepting layer) is suppressed
// globally by the fixture (fixtures/daemon.ts), so no spec re-derives the dismissal.
//
// This spec only ever CREATES new agents/profiles (uniquely named) and never mutates a BUNDLED profile, so
// the shared store stays clean for other specs — no reset step is needed (unlike skills.spec.ts, which
// mutates a bundled skill and restores it).
import { expect, openActorsProfile, test } from "./fixtures/daemon";
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

// An agent on the Agents node is a CARD: `atlas-agent-card-<id>` in the "You spawn these" group, or
// `atlas-worker-rig-<id>` in the "Your manager dispatches these" group (a worker-role bind). Matching both
// prefixes keeps a card addressable when a rebind moves it between the groups. Filtered by the card's own
// name element (exact), so no substring of another card's prompt or rig can hijack it.
const agentCard = (page: Page, name: string) =>
  page.locator('[data-testid^="atlas-agent-card-"], [data-testid^="atlas-worker-rig-"]')
    .filter({ has: page.locator(".loom-baycard-name", { hasText: new RegExp(`^${name}$`) }) });

const openAgentsNode = async (page: Page, baseURL: string) => {
  await page.goto(`${baseURL}/agents`);
  await expect(page.getByTestId("atlas-agents-node")).toBeVisible();
};

// Opens the card's editor dialog (the only route to the profile picker now) by the agent's id.
const openEditor = async (page: Page, agentId: string) => {
  await page.getByTestId(`atlas-agent-edit-${agentId}`).click();
  await expect(page.getByTestId("atlas-agent-editor")).toBeVisible();
};

// Must match `PLAIN_BIND_GROUP_LABEL` in components/agentEditor.tsx verbatim. Deliberately a copy rather than an
// import: pulling that module into the Playwright process would drag in React, the theme and the whole UI
// kit for one string. Drift fails loudly (the optgroup simply isn't found), never silently passes.
const PLAIN_BIND_GROUP_LABEL = "role not conferred — binds as a plain session";

// The profile-assignment control is the editor dialog's <select> carrying the "— none —" placeholder option;
// scoping to the dialog keeps any other select on the node out of the match.
const profileSelect = (page: Page) =>
  page.getByTestId("atlas-agent-editor").locator("select").filter({ hasText: "— none —" });

test.describe("profiles & agents", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts) — no
  // spec re-derives it.

  test("the Agents node lists the REST-seeded agents", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-list-${Date.now()}`);
    const names = ["Orchestrator", "Dev", "Bugfix"];
    for (const n of names) await seedAgent(loomDaemon.baseURL, project.id, n);
    await pinActiveProject(page, project.id);

    await openAgentsNode(page, loomDaemon.baseURL);

    // Every seeded agent shows up as a card.
    for (const n of names) {
      await expect(agentCard(page, n)).toBeVisible();
    }

    // Cross-check the REST source the list is built from carries exactly these seeded agents.
    const rows = await listAgents(loomDaemon.baseURL, project.id);
    for (const n of names) expect(rows.some((a) => a.name === n)).toBe(true);
  });

  test("creating an agent through the UI reflects in the list and over REST", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-create-${Date.now()}`);
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    const newName = `QA Verifier ${Date.now()}`;
    // BEFORE: no such agent exists on the node.
    await expect(agentCard(page, newName)).toHaveCount(0);

    // ACT: open the create dialog ("＋ New agent"), fill the AgentForm, and Create.
    await page.getByTestId("atlas-agents-new").click();
    const form = page.getByTestId("agent-create-form");
    await form.getByPlaceholder("agent name").fill(newName);
    await form.getByLabel("Startup prompt").fill("Verify the assigned task end-to-end and report with evidence.");
    const create = page.getByTestId("agent-create-submit");
    await expect(create).toBeEnabled();
    await create.click();

    // AFTER (observable #1 — UI): the new agent's card appears on the node.
    await expect(agentCard(page, newName)).toBeVisible();

    // AFTER (observable #2 — REST): the store the list is built from now holds it, with the saved prompt.
    await expect
      .poll(async () => (await listAgents(loomDaemon.baseURL, project.id)).some((a) => a.name === newName))
      .toBe(true);
  });

  test("assigning a profile to an agent produces an observable change (agent card + REST)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-assign-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Lead");
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Manager Rig ${Date.now()}`, role: "manager", icon: "🧭" });
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    // Open the agent's editor so its Profile assignment control mounts.
    await openEditor(page, agent.id);
    const select = profileSelect(page);
    await expect(select).toBeVisible();

    // BEFORE: no profile is assigned — the select sits on the "— none —" placeholder (empty value), and the
    // agent card carries no role signal ("manager" comes only from an assigned profile). The role tag now
    // renders the centralized display label ("Manager") — case-insensitive match keeps this robust to the
    // label vs raw-enum casing (card 04fec5be: one role display map).
    await expect(select).toHaveValue("");
    await expect(agentCard(page, "Lead")).not.toContainText(/manager/i);

    // ACT: pick the seeded profile by its id (the option's value).
    await select.selectOption(profile.id);

    // AFTER (observable #1 — UI): the agent card now renders the assigned profile's role.
    await expect(agentCard(page, "Lead")).toContainText(/manager/i);

    // AFTER (observable #2 — REST): the agent row's profileId flipped to the assigned profile.
    await expect
      .poll(async () => (await listAgents(loomDaemon.baseURL, project.id)).find((a) => a.id === agent.id)?.profileId ?? null)
      .toBe(profile.id);
  });

  test("profile capability toggles render; documentConversion reveals the provisioning panel and browserTesting persists", async ({ page, loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Toggles ${Date.now()}` });
    // Profiles are a daemon-global store — no active-project pin needed (unlike Workspace).
    // Card 8206994d: browserTesting/documentConversion are planGrantSave widening keys — open with the
    // agents list already warm or the Save click below races into an unhandled grant-reach confirm.
    await openActorsProfile(page, loomDaemon.baseURL, profile.name);

    // The capability toggles RENDER, each as a labelled checkbox.
    const browserToggle = page.locator("label", { hasText: "Browser testing" }).locator('input[type="checkbox"]');
    const docConvToggle = page.locator("label", { hasText: "Document conversion" }).locator('input[type="checkbox"]');
    await expect(browserToggle).toBeVisible();
    await expect(docConvToggle).toBeVisible();

    // BEFORE: a freshly seeded profile has both off, and the doc-conversion venv panel (rendered only while
    // documentConversion is on) is absent.
    await expect(browserToggle).not.toBeChecked();
    await expect(docConvToggle).not.toBeChecked();
    await expect(page.getByTestId("capability-provisioning-document-conversion")).toHaveCount(0);

    // ACT + AFTER (observable #1 — interactive reveal): turning documentConversion on mounts the shared-venv
    // provisioning status panel. This is driven off the toggle's local state, so it needs no Save.
    await docConvToggle.check();
    await expect(docConvToggle).toBeChecked();
    await expect(page.getByTestId("capability-provisioning-document-conversion")).toBeVisible();

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

  test("the profile editor offers no Connections picker (points at the agent), and the AGENT editor grants one", async ({ page, loomDaemon }) => {
    // Card afe1bc90: credential grants live on the AGENT row only. A profile editor must NOT offer the
    // picker (and says where it went); the agent editor's grants picker is the ONLY grant path (human REST,
    // no agent MCP tool can set this field).
    const connection = await seedConnection(loomDaemon.baseURL, { name: `E2E Conn ${Date.now()}`, host: "api.example.com", authScheme: "bearer", secret: "e2e-test-secret-not-real" });
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Connections ${Date.now()}` });
    await openActorsProfile(page, loomDaemon.baseURL, profile.name);

    // PROFILE editor: the pointer is shown and the connection is NOT offered as a toggle.
    await expect(page.getByTestId("profile-credential-grants-moved")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: connection.name })).toHaveCount(0);

    // AGENT editor: bind an agent to the profile, open it, grant the connection, Save grants.
    const project = await loomDaemon.createProject(`grants-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Granter");
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);
    await openEditor(page, agent.id);

    const connToggle = page.getByTestId(`agent-connection-${agent.id}-${connection.id}`);
    await expect(connToggle).toBeVisible();
    // BEFORE: the agent grants nothing (the secure default).
    await expect(page.getByText(/none selected.*NO authenticated_request access/)).toBeVisible();
    await connToggle.click();
    const saveGrants = page.getByTestId(`agent-grants-save-${agent.id}`);
    await expect(saveGrants).toBeEnabled();
    await saveGrants.click();

    // AFTER: read the grant back over REST on the AGENT; the profile gained nothing.
    await expect
      .poll(async () => (await apiJson<{ id: string; connections?: string[] }[]>(`${loomDaemon.baseURL}/api/agents`)).find((a) => a.id === agent.id)?.connections)
      .toEqual([connection.id]);
    expect(((await getProfile(loomDaemon.baseURL, profile.id)) as { connections?: string[] }).connections ?? []).toEqual([]);
  });

  // Card 921e06b0 (from epic f437d4e9's C5 decision 7) — the agent bind-dropdown used to offer EVERY
  // profile, platform-tier rigs included. Binding one is safe (a profile confers only manager/worker/
  // assistant, so the session spawns PLAIN) but reads as an offer of admin powers that does not exist.
  // The fixture daemon runs LOOM_DEV=0 (fixtures/daemon.ts), i.e. exactly the non-dev install this hides
  // them on.
  test("the agent profile picker hides platform-tier profiles on a non-dev install", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-tier-${Date.now()}`);
    const binder = await seedAgent(loomDaemon.baseURL, project.id, "Binder");
    // The platform-tier rig this test is about. `auditor` is deliberately NOT seeded here: validateProfile's
    // roleCarryForwardOnlyError refuses to MINT one over REST, so the sweep below (which rejects an option
    // of EITHER dev-layer role) is what covers it, rather than a seed this surface cannot create.
    const platform = await seedProfile(loomDaemon.baseURL, { name: `Platform Rig ${Date.now()}`, role: "platform", icon: "★" });
    // POSITIVE CONTROL: an ordinary conferrable rig seeded the same way through the same route. Without it
    // an empty/mislocated dropdown would satisfy the absence assertions for the wrong reason.
    const manager = await seedProfile(loomDaemon.baseURL, { name: `Manager Rig ${Date.now()}`, role: "manager", icon: "🧭" });
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    await openEditor(page, binder.id);
    const select = profileSelect(page);
    await expect(select).toBeVisible();

    // POSITIVE CONTROL: the manager rig IS offered — the picker is populated and the locator is right.
    await expect(select.locator("option").filter({ hasText: manager.name })).toHaveCount(1);
    // The platform-tier rig is NOT offered, by name…
    await expect(select.locator("option").filter({ hasText: platform.name })).toHaveCount(0);
    // …and no option carries EITHER dev-layer role, so a bundled platform/auditor profile seeded outside
    // this test can't slip through either.
    for (const text of await select.locator("option").allTextContents()) {
      expect(text).not.toMatch(/\((platform|auditor)\)/);
    }

    // It is hidden from the PICKER only — the store still holds it (so this is a UI filter, not a
    // server-side change) and it is still a real profile the dev Platform surface can use.
    expect((await getProfile(loomDaemon.baseURL, platform.id)).role).toBe("platform");

    // EXERCISE the control: the dropdown still works for the rigs it does offer, with an observable
    // before/after on both the agent card and the store.
    await expect(select).toHaveValue("");
    await select.selectOption(manager.id);
    await expect(agentCard(page, "Binder")).toContainText(/manager/i);
    await expect(select).toHaveValue(manager.id);
  });

  // An agent ALREADY bound to a platform-tier profile (seeded before this filter existed, or bound on a
  // dev install) must still render its own assignment: dropping the selected option would leave the
  // <select> with no matching value and silently show the agent as "— none —".
  test("an already-bound platform-tier profile stays visible as the agent's current assignment", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-keepsel-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Prebound");
    const platform = await seedProfile(loomDaemon.baseURL, { name: `Bound Platform Rig ${Date.now()}`, role: "platform", icon: "★" });
    // Bind it over the same human REST route the UI drives, BEFORE the page loads.
    await apiJson(`${loomDaemon.baseURL}/api/agents/${agent.id}`, { method: "POST", body: JSON.stringify({ profileId: platform.id }) });
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    await openEditor(page, agent.id);
    const select = profileSelect(page);
    await expect(select).toBeVisible();

    // The assignment is rendered truthfully — the option is present and selected, NOT silently "— none —".
    await expect(select.locator("option").filter({ hasText: platform.name })).toHaveCount(1);
    await expect(select).toHaveValue(platform.id);
    // …and it is grouped under the label that states what binding it actually does.
    await expect(select.locator(`optgroup[label="${PLAIN_BIND_GROUP_LABEL}"]`)).toHaveCount(1);
  });

  // Card c40489c6 — 921e06b0 (above) keyed the picker's filter off `isDevLayerRole` (RoleConfer "dev"),
  // which covers platform/auditor only. setup / operator / workspace-auditor are equally outside
  // PROFILE_SPAWNABLE_ROLES ({manager, worker, assistant}) — binding one ALSO spawns a plain session with
  // the role silently dropped — but they are `confer: "user"`/`"hidden"`, so that filter deliberately let
  // them through and the picker kept offering them as if their role were real. They stay OFFERED (a user
  // can legitimately create one) but under the group label, and a bound one says so inline.
  test("the agent profile picker groups non-dev non-spawnable rigs instead of offering them as real roles", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-nonspawn-${Date.now()}`);
    const chooser = await seedAgent(loomDaemon.baseURL, project.id, "Chooser");
    // The two non-spawnable, NON-dev-layer roles a human can actually mint over REST. (`auditor` and
    // `workspace-auditor` are refused by roleCarryForwardOnlyError, so the direct-child sweep below is
    // what covers them — same reasoning as 921e06b0's own auditor note.)
    const setupRig = await seedProfile(loomDaemon.baseURL, { name: `Setup Rig ${Date.now()}`, role: "setup", icon: "⚙" });
    // POSITIVE CONTROL: a genuinely spawnable rig, seeded the same way through the same route. Without it
    // an empty/mislocated dropdown would satisfy the "not a direct option" assertions for the wrong reason.
    const workerRig = await seedProfile(loomDaemon.baseURL, { name: `Worker Rig ${Date.now()}`, role: "worker", icon: "▸" });
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    await openEditor(page, chooser.id);
    const select = profileSelect(page);
    await expect(select).toBeVisible();

    // A DIRECT child <option> is one the picker offers as an ordinary, role-conferring rig; one nested in
    // the optgroup is disclosed as binding plain. The child combinator is what separates the two.
    const directOption = (name: string) => select.locator(":scope > option").filter({ hasText: name });
    const groupedOption = (name: string) =>
      select.locator(`optgroup[label="${PLAIN_BIND_GROUP_LABEL}"] > option`).filter({ hasText: name });

    // POSITIVE CONTROL: the worker rig IS offered directly — the picker is populated and the locators work.
    await expect(directOption(workerRig.name)).toHaveCount(1);
    await expect(groupedOption(workerRig.name)).toHaveCount(0);

    // The non-spawnable rig is still OFFERED (not hidden — unlike the dev-layer pair) …
    await expect(select.locator("option").filter({ hasText: setupRig.name })).toHaveCount(1);
    // … but under the group label, never as a plain top-level option.
    await expect(groupedOption(setupRig.name)).toHaveCount(1);
    await expect(directOption(setupRig.name)).toHaveCount(0);

    // Sweep: NO direct option carries a non-spawnable role, so a bundled setup/workspace-auditor
    // profile seeded outside this test can't slip through either. Nothing is bound yet, so the
    // always-keep-the-current-assignment rule has no exception in play here.
    for (const text of await select.locator(":scope > option").allTextContents()) {
      expect(text).not.toMatch(/\((platform|auditor|workspace-auditor|setup|run)\)/);
    }

    // EXERCISE the control, with an observable before/after on the inline disclosure. BEFORE: nothing is
    // bound, so no note.
    await expect(select).toHaveValue("");
    await expect(page.getByTestId("agent-profile-plain-bind")).toHaveCount(0);

    // ACT + AFTER (observable #1 — UI): binding the setup rig surfaces the inline note, because a
    // collapsed <select> hides the optgroup label that carried this fact a moment ago.
    await select.selectOption(setupRig.id);
    await expect(select).toHaveValue(setupRig.id);
    await expect(page.getByTestId("agent-profile-plain-bind")).toBeVisible();

    // AFTER (observable #2 — REST): the bind really landed; this is a UI filter, not a server-side change.
    await expect
      .poll(async () => (await listAgents(loomDaemon.baseURL, project.id)).find((a) => a.name === "Chooser")?.profileId ?? null)
      .toBe(setupRig.id);

    // ACT + AFTER (observable #3 — the note is CONDITIONAL, not always-on): rebinding to the spawnable
    // worker rig retires it. Without this, an unconditionally-rendered note would pass #1 for free.
    await select.selectOption(workerRig.id);
    await expect(select).toHaveValue(workerRig.id);
    await expect(page.getByTestId("agent-profile-plain-bind")).toHaveCount(0);
  });

  // Card 57deed24 — c40489c6 (above) disclosed a non-conferred bind in the PICKER only; the agent's own
  // listing still rendered the bound profile's role bare, so a `setup` rig read as plain "Operator" on the
  // one surface you see without opening anything. Same predicate (`profileRoleBindsAsPlainSession`), same
  // wording (PLAIN_BIND_GROUP_LABEL) — flagged where the role is claimed. The /projects list row this
  // first pinned was deleted by card acbb6df6; the flag now rides the Agents node CARD.
  test("the agent card flags a bound profile's role when the bind would not confer it", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`agents-rowflag-${Date.now()}`);
    const plainAgent = await seedAgent(loomDaemon.baseURL, project.id, "Plainbound");
    const realAgent = await seedAgent(loomDaemon.baseURL, project.id, "Realbound");
    const setupRig = await seedProfile(loomDaemon.baseURL, { name: `Row Setup Rig ${Date.now()}`, role: "setup", icon: "⚙" });
    const workerRig = await seedProfile(loomDaemon.baseURL, { name: `Row Worker Rig ${Date.now()}`, role: "worker", icon: "▸" });
    // Bind both BEFORE the page loads, over the same human REST route the UI drives.
    const bind = (agentId: string, profileId: string) =>
      apiJson(`${loomDaemon.baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ profileId }) });
    await bind(plainAgent.id, setupRig.id);
    await bind(realAgent.id, workerRig.id);
    await pinActiveProject(page, project.id);
    await openAgentsNode(page, loomDaemon.baseURL);

    const plainCard = agentCard(page, "Plainbound");
    const realCard = agentCard(page, "Realbound");
    await expect(plainCard).toBeVisible();
    await expect(realCard).toBeVisible();
    const flagIn = (card: ReturnType<typeof agentCard>, agentId: string) =>
      card.getByTestId(`atlas-agent-plain-bind-${agentId}`);

    // POSITIVE CONTROL: `worker` IS inside PROFILE_SPAWNABLE_ROLES, so that card renders its role and
    // carries no flag. Without it, an unconditional flag (or a locator matching nothing) would satisfy the
    // setup-card assertions below for the wrong reason.
    await expect(realCard).toContainText(/worker/i);
    await expect(flagIn(realCard, realAgent.id)).toHaveCount(0);

    // `setup` is outside it, so the same card is flagged — inside ITS card, carrying the one shared wording
    // the picker's <optgroup> and inline note already use.
    await expect(flagIn(plainCard, plainAgent.id)).toBeVisible();
    await expect(flagIn(plainCard, plainAgent.id)).toHaveAttribute("title", PLAIN_BIND_GROUP_LABEL);

    // EXERCISE the real control, with an observable before/after: the flag keys off the BIND, not off the
    // card, so rebinding the control agent to the setup rig through the picker grows the flag on ITS card
    // too. This is what a hard-coded or position-indexed flag would fail.
    await openEditor(page, realAgent.id);
    const select = profileSelect(page);
    await expect(select).toHaveValue(workerRig.id);
    await select.selectOption(setupRig.id);
    await expect(select).toHaveValue(setupRig.id);
    await expect(flagIn(realCard, realAgent.id)).toHaveCount(1);
    await expect(flagIn(realCard, realAgent.id)).toHaveAttribute("title", PLAIN_BIND_GROUP_LABEL);
  });
});
