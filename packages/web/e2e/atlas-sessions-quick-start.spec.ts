// The Atlas Sessions tab's inline quick-start — card f3b18f27, the owner's Atlas feedback verbatim:
// `Projects › tab "Sessions": Add a quick agent session start UI element.`
// Record: docs/decisions/f3b18f27-atlas-sessions-quick-start.md
//
// The card's claims, and what each leg measures them against:
//   1. The control is on the Sessions TAB (project depth), it offers only the SPAWNABLE agents, and
//      it says what each one will start. Measured against a three-way roster — a manager rig, a plain
//      agent and a worker rig — so a picker that offered everything and one that offered nothing both
//      fail, and the rig line is read on BOTH halves of a real pick change (an interactive control is
//      exercised, not merely rendered).
//   2. Picking an agent and pressing Spawn SENDS the start request for THAT agent, and the session it
//      creates lands in the grid below. The request is asserted by its URL and body; the row is
//      asserted on both sides ("No running sessions." before, the row after), so before/after differ.
//   3. THE GUARDS. A worker rig cannot be started because it is not in the picker (leg 1's absence
//      half), and an agent already holding its go-live slot draws the HELD control plus a graceful
//      Stop — a real click on which sends NOTHING. Measured with a request counter, so "refused" is a
//      measured zero rather than a button that merely looked disabled.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is also satisfied by a page
// that is merely still loading, so every pair asserts what must BE there before what must not.
//
// ⛔ NO REAL CLAUDE IS EVER SPAWNED. The start POST is intercepted (`page.route`) and fulfilled with a
// session this spec seeds through the fixture's own `seedLiveSession` — the test-only insert path —
// so the row that appears in the grid is a genuine daemon row read back over the real `GET
// /api/sessions`, while the daemon's own spawn path is never entered. A real click-through would trip
// `fixtures/daemon.ts`'s `[pty] spawn` guard and redden the whole suite.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/activeProject.tsx owns the project key. Hardcoded rather than imported: the e2e tsconfig covers
// `e2e/` only (tsconfig.e2e.json), the same reason fixtures/daemon.ts hardcodes its own keys.
const PROJECT_KEY = "loom.projectId";

/** The project node's Sessions tab address — src/nav.tsx's PROJECT_NODE_TABS `sessions` row. */
const SESSIONS_PATH = "/terminals";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Writes only while the key is still absent: addInitScript re-runs on EVERY navigation, so an
// unconditional write would re-pin on a reload, and that leg would be measuring this helper instead of the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

// ── REST seeding (the same human/loopback endpoints the UI drives) ─────────────────────────────
// Inline rather than added to fixtures/daemon.ts, following atlas-agents.spec.ts / atlas-project-tabs.
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<{ id: string; name: string }>(`${baseURL}/api/projects/${projectId}/agents`,
    { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });

const seedProfile = (baseURL: string, body: { name: string; role?: string | null }) =>
  apiJson<{ id: string; name: string }>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });

const bindProfile = (baseURL: string, agentId: string, profileId: string) =>
  apiJson(`${baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ profileId }) });

/** What `rigLine` (components/atlasAgents.tsx) prints for an agent with no bound rig. */
const PLAIN_RIG_LINE = "no rig · plain session";

/**
 * A project with a THREE-WAY roster, which is what makes the picker's membership discriminating:
 *   • a MANAGER-rig agent — the only one the go-live guard can ever hold, and the only one whose
 *     Spawn button carries a role in its label,
 *   • a PLAIN agent (no rig) — always spawnable, so it is the contrast case that stops "the guard
 *     fired" from being satisfied by "every control vanished",
 *   • a WORKER-rig agent — which must never be offered, because a manager dispatches those.
 *
 * ⭐ The manager rig's agent is seeded FIRST and named so it sorts LAST ("Zed Lead"): the picker's
 * default pick is the first SPAWNABLE agent in the project's own agent order, so a default that had
 * quietly become alphabetical would be caught here instead of passing by coincidence.
 */
async function seedRoster(loomDaemon: LoomDaemon) {
  const baseURL = loomDaemon.baseURL;
  const project = await loomDaemon.createProject(uniq("qstart"));
  const leadRig = await seedProfile(baseURL, { name: uniq("QS Orchestrator rig"), role: "manager" });
  const devRig = await seedProfile(baseURL, { name: uniq("QS Dev rig"), role: "worker" });

  const lead = await seedAgent(baseURL, project.id, "Zed Lead");
  await bindProfile(baseURL, lead.id, leadRig.id);
  const plain = await seedAgent(baseURL, project.id, "Plain Probe");
  const worker = await seedAgent(baseURL, project.id, "Dispatched Dev");
  await bindProfile(baseURL, worker.id, devRig.id);

  return { project, leadRig, devRig, lead, plain, worker };
}

const bar = (page: Page) => page.getByTestId("sessions-bar");
const quickStart = (page: Page) => page.getByTestId("atlas-quickstart");
const picker = (page: Page) => page.getByTestId("atlas-quickstart-agent");
const rigLine = (page: Page) => page.getByTestId("atlas-quickstart-rig");
/** The split button's PRIMARY — scoped to the quick-start, never the node head's own `Spawn +`. */
const spawnButton = (page: Page) => quickStart(page).getByRole("button", { name: /^Spawn/ });

/** The picker's option labels, in render order — the `spawnPickLabel` output for each entry. */
function pickerOptions(page: Page): Promise<string[]> {
  return picker(page).locator("option").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
}

/**
 * Land on the project node's Sessions tab with the project pinned.
 *
 * It navigates to the tab's own address and then re-selects the tab THROUGH the node tab row: the
 * address alone is enough today, but `openNodeTab` is what makes the leg survive the row's
 * width-derived overflow fold (helpers/nodeTabs.ts) if this tab ever lands in the More menu.
 */
async function gotoSessionsTab(page: Page, loomDaemon: LoomDaemon, projectId: string) {
  await pinProject(page, projectId);
  await page.goto(loomDaemon.baseURL + SESSIONS_PATH);
  await openNodeTab(page, "sessions");
  // PRESENCE FIRST, and it is also the FIXTURE IDENTITY check: the node really is scoped to the
  // project this spec seeded, so everything measured below belongs to it and not to whatever a
  // sibling spec left on the shared worker daemon.
  await expect(page.getByTestId("atlas-tabpanel-sessions")).toBeVisible();
}

test.describe("Atlas Sessions tab — inline quick-start", () => {
  test("offers only the spawnable agents and says what each one will start", async ({ page, loomDaemon }) => {
    const f = await seedRoster(loomDaemon);
    await gotoSessionsTab(page, loomDaemon, f.project.id);

    // The control is in the tab's own controls bar, beside the filter that was already there — not
    // in the frame's node head, which carries the `Spawn +` dialog on every tab.
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText("Start a session");
    await expect(bar(page)).toContainText("Project");
    await expect(quickStart(page)).toBeVisible();

    // THE MEMBERSHIP. Exactly the two spawnable agents, in the project's own agent order…
    await expect(picker(page).locator("option")).toHaveCount(2);
    expect(await pickerOptions(page)).toEqual(["Zed Lead", "Plain Probe"]);
    // …and the worker rig is absent — the half that makes the list a real filter rather than a
    // list that happens to hold two things. Named by its agent name, which IS in the project.
    expect(await pickerOptions(page)).not.toContain("Dispatched Dev");

    // THE DEFAULT PICK is the first spawnable agent in the project's own order (see seedRoster:
    // "Zed Lead" sorts last, so an alphabetical default would read "Plain Probe" here).
    await expect(picker(page)).toHaveValue(f.lead.id);
    await expect(rigLine(page)).toContainText(f.leadRig.name);
    // The role in the Spawn label is the RIG's, server-side truth for a default spawn.
    await expect(spawnButton(page)).toHaveText("Spawn · manager");

    // EXERCISE THE PICKER — an observable before/after on a real interaction, not a render check.
    // Both halves move together: the rig line and the button's own role label.
    await picker(page).selectOption(f.plain.id);
    await expect(picker(page)).toHaveValue(f.plain.id);
    await expect(rigLine(page)).toHaveText(PLAIN_RIG_LINE);
    // A plain agent has no rig role, so the label carries none — the contrast that proves the
    // previous "· manager" was read off the pick rather than printed unconditionally.
    await expect(spawnButton(page)).toHaveText("Spawn");

    // …and back, so the change is shown to be bound to the pick in both directions.
    await picker(page).selectOption(f.lead.id);
    await expect(rigLine(page)).toContainText(f.leadRig.name);
    await expect(spawnButton(page)).toHaveText("Spawn · manager");
  });

  test("starting sends the start request for the picked agent and its session lands in the grid", async ({ page, loomDaemon }) => {
    const f = await seedRoster(loomDaemon);

    // The start POST is intercepted and answered with a session seeded through the fixture's own
    // test-only insert path, so the daemon's real spawn is never entered (see the header).
    const starts: { url: string; body: string | null }[] = [];
    const sessionId = `qsstart-${Date.now()}`;
    await page.route("**/api/agents/*/sessions", async (route) => {
      const url = route.request().url();
      starts.push({ url, body: route.request().postData() });
      const seeded = await loomDaemon.seedLiveSession({
        project: f.project, agentId: f.plain.id, id: sessionId, role: "manager",
      });
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ id: seeded.sessionId }),
      });
    });

    await gotoSessionsTab(page, loomDaemon, f.project.id);

    // BEFORE: the grid is genuinely empty, stated by the page itself. This is the "after" assertion's
    // own control — a row appearing against a grid that already had rows would prove nothing.
    await expect(quickStart(page)).toBeVisible();
    await expect(page.getByTestId("atlas-tabpanel-sessions")).toContainText("No running sessions.");
    await expect(page.getByText(sessionId.slice(0, 8), { exact: false })).toHaveCount(0);

    // Pick the PLAIN agent deliberately — not the default — so the request below proves the picker's
    // choice reached the call, rather than the first roster entry doing so by accident.
    await picker(page).selectOption(f.plain.id);
    await expect(rigLine(page)).toHaveText(PLAIN_RIG_LINE);
    await spawnButton(page).click();

    // THE REQUEST: exactly one, at the picked agent's own address.
    await expect.poll(() => starts.length, { message: "one start request should have been sent" }).toBe(1);
    expect(starts[0]!.url).toContain(`/api/agents/${f.plain.id}/sessions`);
    expect(starts[0]!.url).not.toContain(f.lead.id);
    // NO BODY on a default spawn — `api.startSession` omits it so the rig's own role applies
    // server-side, and a body here would mean a role override was sent that nobody asked for.
    expect(starts[0]!.body).toBeNull();

    // AFTER: the new session is in the grid, read back over the real GET /api/sessions. Both halves —
    // the empty-state line is gone AND the row names this session — so a page that merely re-rendered
    // cannot satisfy it.
    await expect(page.getByTestId("atlas-tabpanel-sessions")).toContainText(sessionId.slice(0, 8));
    await expect(page.getByTestId("atlas-tabpanel-sessions")).not.toContainText("No running sessions.");
  });

  test("an agent already holding its go-live slot is held, and a click on the held control sends nothing", async ({ page, loomDaemon }) => {
    const f = await seedRoster(loomDaemon);
    // The manager rig's agent, already live — the state the go-live guard exists for. `holdsGoLiveSlot`
    // is what reads it (lib/sessions.ts), and this surface inherits that test via `AgentActions`.
    const held = await loomDaemon.seedLiveSession({
      project: f.project, agentId: f.lead.id, id: `qsheld-${Date.now()}`, role: "manager",
    });

    // Every start attempt is counted and refused, so "nothing was sent" is a measured zero. Fulfilled
    // rather than aborted so that a request which DID escape would still be a clean, countable fact.
    let startAttempts = 0;
    await page.route("**/api/agents/*/sessions", async (route) => {
      startAttempts += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "never" }) });
    });

    await gotoSessionsTab(page, loomDaemon, f.project.id);
    await expect(quickStart(page)).toBeVisible();

    // The picker MARKS it, so the changed control below reads as a guard rather than a dead button.
    await expect.poll(() => pickerOptions(page), { message: "the live agent should be marked" })
      .toContain("Zed Lead · live");
    await expect(picker(page)).toHaveValue(f.lead.id);

    // PRESENCE FIRST: the held control and the graceful Stop the guard offers in a Spawn's place…
    const heldControl = quickStart(page).getByTestId(`atlas-agent-live-${f.lead.id}`);
    await expect(heldControl).toBeVisible();
    await expect(heldControl).toBeDisabled();
    await expect(quickStart(page).getByTestId(`atlas-agent-stop-${f.lead.id}`)).toBeVisible();
    // …and no Spawn at all for this pick, which is the guard's whole point.
    await expect(spawnButton(page)).toHaveCount(0);

    // A REAL CLICK sends nothing. `force` skips Playwright's own actionability wait — without it this
    // would time out on the disabled button and never exercise the click at all, which would make the
    // zero below a fact about the test rather than about the product.
    await heldControl.click({ force: true });
    await expect(heldControl).toBeDisabled();
    expect(startAttempts, "a click on the held control must send no start request").toBe(0);

    // THE CONTRAST CASE. The plain agent in the same roster is still startable, so the zero above is
    // the guard acting on one pick — not the control being broken for every pick.
    await picker(page).selectOption(f.plain.id);
    await expect(spawnButton(page)).toBeEnabled();
    await expect(quickStart(page).getByTestId(`atlas-agent-live-${f.lead.id}`)).toHaveCount(0);
    expect(startAttempts, "merely switching the pick must still send nothing").toBe(0);

    // The held session is the one this spec seeded, named in the grid below — so the guard was read
    // off real state rather than off an empty roster.
    await expect(page.getByTestId("atlas-tabpanel-sessions")).toContainText(held.sessionId.slice(0, 8));
  });
});
