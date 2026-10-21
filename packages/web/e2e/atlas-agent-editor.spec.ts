// The Atlas parity gaps P2-2 could not carry (card 318b5a21): the AGENT EDITOR on the Agents node, the
// quick-spawn `＋` on the PROJECT tree row, and the go-live guard's `starting` hole.
//
// Each claim is measured against real state rather than against "a control rendered":
//   1. THE EDITOR IS THE SAME EDITOR, AND IT REALLY WRITES. Create / re-profile / re-prompt / delete are
//      driven through the dialog against the REAL daemon (none of the four spawns anything), and each is
//      asserted by a BEFORE→AFTER change in what the roster itself shows — the roster is a separate
//      derivation from the editor, so it can only agree if the write landed.
//   2. THE WORKER RIGS ARE EDITABLE AND STILL NOT SPAWNABLE. Both halves: a rig row carries an Edit that
//      opens the editor on THAT agent, and no spawn/stop control anywhere on it.
//   3. THE PROJECT ROW'S `＋` REACHES A PROJECT YOU ARE NOT SCOPED TO, and P1-4's selection contract
//      survives it — the `＋` is a SIBLING of the selector button (never nested), opening it neither
//      navigates nor re-scopes, and the selector still selects afterwards.
//   4. THE GO-LIVE GUARD HOLDS A `starting` MANAGER — on BOTH surfaces, since one shared predicate now
//      decides it. This is the card's "investigate first" item, reproduced rather than reasoned about:
//      a `starting` manager row is seeded directly (no spawn), and the surfaces are read.
//   5. SWITCH OFF: the editor/`＋` reached nothing in the shell a user who never opted in sees, and the
//      Projects page — the editor's original host — still mounts it.
//
// ⛔ NO REAL SPAWN. `loomDaemon.createProject` binds a REAL repo, so POST /api/agents/:id/sessions would
// start a genuinely metered claude and trip the fixture's `[pty] spawn` no-spawn guard at teardown. Every
// spawn click below is answered by a `page.route` fulfilment (the seam atlas-agents.spec.ts established),
// which pins the REQUEST and is the sharper assertion anyway. Agent CRUD is NOT routed: create / update /
// delete are ordinary DB writes with no process behind them, so they hit the daemon for real and the
// roster's own re-read is the evidence.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there first.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and that leg would be measuring this
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// `createProject` returns what the DAEMON stored, not what was asked for, so escape rather than assume
// the stored form carries no regex metacharacter (card e47df20a).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededAgent { id: string; name: string; profileId: string | null }
interface SeededProfile { id: string; name: string; role: string | null }

const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<SeededAgent>(`${baseURL}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });

const seedProfile = (baseURL: string, body: { name: string; role?: string | null; icon?: string | null }) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });

const bindProfile = (baseURL: string, agentId: string, profileId: string) =>
  apiJson(`${baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ profileId }) });

/**
 * The same three-way roster atlas-agents.spec.ts establishes — a MANAGER rig (the only agent the
 * go-live guard can ever hold), a PLAIN agent (the contrast case that must keep its spawn at the same
 * moment), and a WORKER rig (never spawnable, now editable). Plus a SECOND, unbound rig, which is what
 * the re-profile assertion moves the plain agent onto.
 */
async function seedRoster(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("atlaseditor"));
  const mgrRig = await seedProfile(loomDaemon.baseURL, { name: uniq("Mgr Rig"), role: "manager", icon: "◆" });
  const wkrRig = await seedProfile(loomDaemon.baseURL, { name: uniq("Wkr Rig"), role: "worker", icon: "▸" });
  const spareRig = await seedProfile(loomDaemon.baseURL, { name: uniq("Spare Rig"), role: "manager", icon: "◇" });
  // Names share no stem with each other or with the project: several locators below filter by text.
  const manager = await seedAgent(loomDaemon.baseURL, project.id, uniq("Conductor"));
  const plain = await seedAgent(loomDaemon.baseURL, project.id, uniq("Sketchpad"));
  const worker = await seedAgent(loomDaemon.baseURL, project.id, uniq("Hauler"));
  await bindProfile(loomDaemon.baseURL, manager.id, mgrRig.id);
  await bindProfile(loomDaemon.baseURL, worker.id, wkrRig.id);
  return { project, manager, plain, worker, mgrRig, wkrRig, spareRig };
}

/** The spawn split-button's primary, scoped to ONE row/card so a second agent's control can never
 *  satisfy an assertion about this one. */
const spawnIn = (scope: ReturnType<Page["locator"]>) => scope.locator('button[title^="Spawn from profile"]');

/** Answer POST /api/agents/:id/sessions in the browser and hand back what was sent. Nothing reaches the
 *  daemon, so no metered claude can start — and the captured body is the real assertion. */
async function captureSpawns(page: Page): Promise<{ bodies: unknown[]; paths: string[] }> {
  const bodies: unknown[] = [];
  const paths: string[] = [];
  await page.route(
    (url) => /\/api\/agents\/[^/]+\/sessions$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      bodies.push(route.request().postDataJSON() ?? {});
      paths.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e: spawn suppressed" }) });
    },
  );
  return { bodies, paths };
}

test.describe("Atlas agent editor + project-row spawn (card 318b5a21)", () => {
  test("switch ON: the Agents node editor really creates, re-profiles, re-prompts and deletes", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const seeded = await seedRoster(loomDaemon);
    // The global mutation handler alerts with `window.alert` for any mutation without
    // `meta.inlineError` (src/main.tsx), and the delete is behind a `window.confirm`. Both are NATIVE
    // dialogs, so record and answer them: an unhandled one wedges the test rather than failing it.
    const dialogs: string[] = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/agents");

    const node = page.getByTestId("atlas-agents-node");
    await expect(node).toBeVisible();
    const count = page.getByTestId("atlas-agents-count");
    await expect(count).toContainText(new RegExp(`2 agents in ${escapeRe(seeded.project.name)}`));

    // ── (a) CREATE. The ＋ in the head opens the shared create form; the daemon really makes the
    //        agent; the ROSTER — a separate derivation — is what proves it landed.
    const fresh = uniq("Lantern");
    await page.getByTestId("atlas-agents-new").click();
    const dialog = page.getByTestId("atlas-agent-editor");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("agent-create-form")).toBeVisible();
    await dialog.getByLabel("Agent name").fill(fresh);
    await dialog.locator("textarea").fill("first-turn text for the lantern");
    await dialog.getByTestId("agent-create-submit").click();

    // The dialog hands off to the NEW agent's own editor — which also tells us its id, so every later
    // assertion addresses the real row rather than matching on a name.
    const editor = dialog.locator('[data-testid^="agent-editor-"]');
    await expect(editor).toBeVisible();
    const freshId = (await editor.getAttribute("data-testid"))!.replace("agent-editor-", "");
    await expect(dialog.getByTestId(`agent-prompt-${freshId}`)).toHaveValue("first-turn text for the lantern");
    await page.getByTestId("atlas-agent-editor-close").click();
    await expect(dialog).toHaveCount(0);
    // BEFORE→AFTER on the roster itself: a third card, and the head's own count agrees with it.
    await expect(node.getByTestId(`atlas-agent-card-${freshId}`)).toBeVisible();
    await expect(count).toContainText(new RegExp(`3 agents in ${escapeRe(seeded.project.name)}`));

    // ── (b) RE-PROFILE. The card's rig line reads "no rig · plain session" before, and names the rig
    //        after — the roster derives that line from the agent→profile join, so it can only change
    //        if the PATCH landed.
    const freshCard = node.getByTestId(`atlas-agent-card-${freshId}`);
    await expect(freshCard.locator(".loom-agentrow-meta")).toContainText("no rig");
    await freshCard.getByTestId(`atlas-agent-edit-${freshId}`).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId(`agent-profile-${freshId}`).selectOption({ value: seeded.spareRig.id });
    await expect.poll(async () => (await freshCard.locator(".loom-agentrow-meta").innerText()).trim(),
      { message: "the roster's rig line never picked up the profile assignment" })
      .toContain(seeded.spareRig.name);

    // ── (c) RE-PROMPT. Save is held until the text actually differs (the useFormSync `dirty` gate),
    //        then the "saved" state returns — and a REOPEN reads the stored value back, which is the
    //        half that proves the write reached the daemon rather than only the local textarea.
    const save = dialog.getByTestId(`agent-save-${freshId}`);
    await expect(save).toBeDisabled();
    await dialog.getByTestId(`agent-prompt-${freshId}`).fill("rewritten first turn");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog.getByText("saved", { exact: true })).toBeVisible();
    await page.getByTestId("atlas-agent-editor-close").click();
    await freshCard.getByTestId(`atlas-agent-edit-${freshId}`).click();
    await expect(dialog.getByTestId(`agent-prompt-${freshId}`)).toHaveValue("rewritten first turn");

    // ── (d) DELETE. Behind the native confirm (accepted above). The card leaves the roster and the
    //        count returns to 2 — both, because a dialog that merely closed would satisfy neither.
    const confirmsBefore = dialogs.length;
    await dialog.getByTestId(`agent-delete-${freshId}`).click();
    expect(dialogs.length, "the delete must be behind a confirm").toBeGreaterThan(confirmsBefore);
    await expect(dialog).toHaveCount(0); // onDeleted closes it
    await expect(count).toContainText(new RegExp(`2 agents in ${escapeRe(seeded.project.name)}`));
    await expect(node.getByTestId(`atlas-agent-card-${freshId}`)).toHaveCount(0);
    // The two agents that were always there are untouched — a delete that took the roster with it
    // would pass every assertion above.
    await expect(node.getByTestId(`atlas-agent-card-${seeded.manager.id}`)).toBeVisible();
    await expect(node.getByTestId(`atlas-agent-card-${seeded.plain.id}`)).toBeVisible();
  });

  test("switch ON: a worker rig is editable from its row and still carries no spawn or stop", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/agents");

    const rig = page.getByTestId(`atlas-worker-rig-${seeded.worker.id}`);
    await expect(rig).toBeVisible();
    await expect(rig).toContainText(seeded.worker.name);

    // The rig is a DEFINITION, so its row offers no lifecycle control — the half that was always true.
    await expect(spawnIn(rig)).toHaveCount(0);
    await expect(rig.locator("button.loom-btn-danger")).toHaveCount(0);

    // …and the half this card adds: the one control it DOES carry opens the editor on THIS agent.
    await rig.getByTestId(`atlas-agent-edit-${seeded.worker.id}`).click();
    const dialog = page.getByTestId("atlas-agent-editor");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`agent-editor-${seeded.worker.id}`)).toBeVisible();
    await expect(dialog).toContainText(seeded.worker.name);
    // It is an EDITOR, not a second spawn surface — the separation the Agents node is built on.
    await expect(spawnIn(dialog)).toHaveCount(0);
    // Escape closes it, the keyboard path as well as the ×.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("switch ON: the project row's ＋ spawns into THAT project without re-scoping, and selection still works", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const active = await seedRoster(loomDaemon);
    const other = await seedRoster(loomDaemon);
    const spawns = await captureSpawns(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
    await seedAtlasOn(page);
    await pinProject(page, active.project.id);
    // Deliberately NOT on the Agents node: the claim is "spawn into a project you are not scoped to".
    await page.goto(loomDaemon.baseURL + "/board");

    const tree = page.getByTestId("atlas-tree");
    await expect(tree).toBeVisible();
    // The project TIER's own row shape — the locator atlas-project-selection.spec.ts settled on.
    const row = (name: string) =>
      tree.locator("button.loom-atlas-node.is-branch").filter({ hasText: new RegExp(escapeRe(name)) });
    await expect(page.getByTestId("atlas-project-node")).toContainText(active.project.name);

    // STRUCTURE FIRST — the reason this needed a restructure at all. A <button> inside a <button> is
    // invalid HTML, so the `＋` must be a SIBLING: the selector row contains no nested button, and the
    // `＋` shares a parent with it.
    await expect(row(other.project.name).locator("button")).toHaveCount(0);
    const plus = page.getByTestId(`atlas-project-quickspawn-${other.project.id}-open`);
    await expect(plus).toBeVisible();
    expect(await plus.evaluate((el) => {
      const parent = el.parentElement!;
      return parent.classList.contains("loom-atlas-noderow")
        && !!parent.querySelector(":scope > button.loom-atlas-node.is-branch");
    }), "the ＋ must sit beside the selector button in the same flex row, never inside it").toBe(true);
    // And it names the project it acts on, which is what makes a row-level control answerable.
    await expect(plus).toHaveAttribute("aria-label", new RegExp(escapeRe(other.project.name)));

    // ACT: open the OTHER project's quick-spawn. It lists THAT project's roster, not the active one's.
    const urlBefore = page.url();
    await plus.click();
    const dialog = page.getByTestId(`atlas-project-quickspawn-${other.project.id}`);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${other.plain.id}`)).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${active.plain.id}`)).toHaveCount(0);
    // A worker rig is excluded here exactly as everywhere else the roster is shown.
    await expect(dialog.getByTestId(`atlas-agent-row-${other.worker.id}`)).toHaveCount(0);

    // The spawn addresses the OTHER project's agent — the whole reach this control adds.
    await spawnIn(dialog.getByTestId(`atlas-agent-row-${other.plain.id}`)).click();
    await expect.poll(() => spawns.paths.length, { message: "the spawn never reached the network" }).toBe(1);
    expect(spawns.paths[0]).toBe(`/api/agents/${other.plain.id}/sessions`);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // P1-4's CONTRACT SURVIVES, in all three of its parts: opening the ＋ neither navigated nor
    // re-scoped, and the selector button still selects.
    expect(page.url(), "the quick-spawn changed the address").toBe(urlBefore);
    await expect(page.getByTestId("atlas-project-node")).toContainText(active.project.name);
    expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY),
      "spawning into another project silently re-scoped the app").toBe(active.project.id);

    await row(other.project.name).click();
    await expect(page.getByTestId("atlas-project-node")).toContainText(other.project.name);
    await expect(tree.locator("button.loom-atlas-node.is-branch.is-open")).toHaveCount(1);
    expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY)).toBe(other.project.id);
  });

  test("the go-live guard holds a STARTING manager on BOTH shells, and releases it", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const seeded = await seedRoster(loomDaemon);
    // A manager session at `starting` — the state the old `processState === "live"` guard was blind to.
    // Seeded directly: a genuine spawn is exactly what the fixture's no-spawn guard forbids, and this is
    // the same row shape the real startup window produces.
    await loomDaemon.seedLiveSession({
      project: seeded.project, agentId: seeded.manager.id, agentName: seeded.manager.name,
      role: "manager", processState: "starting", id: `e2e-starting-${Date.now()}`,
    });
    const spawns = await captureSpawns(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });

    // ── CLASSIC SHELL first, deliberately: the defect was carried verbatim from Overview's own
    //    AgentControl, so the fix has to be visible THERE, not only in Atlas.
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/overview");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

    // Scoped to each agent's own spawn card by id (`agent-control-<id>`, added by this card so the
    // classic leg can be addressed at all) — a text filter over unclassed Panels resolves whichever
    // ancestors happen to contain the name too.
    const classicCard = (agentId: string) => page.getByTestId(`agent-control-${agentId}`);
    const mgrCard = classicCard(seeded.manager.id);
    await expect(mgrCard).toBeVisible();
    // THE GUARD: a held, disabled button that says what it is actually holding — never "Live" over a
    // session that has not reached live.
    const held = mgrCard.getByRole("button", { name: "Starting…" });
    await expect(held).toBeVisible();
    await expect(held).toBeDisabled();
    await expect(spawnIn(mgrCard)).toHaveCount(0);

    // THE CONTRAST CASE, same page, same moment: the PLAIN agent's spawn is still enabled AND still
    // reaches the network. Without it, "the guard fired" is equally satisfied by a page that lost every
    // control — and it is also the positive control for the route seam, so the manager's missing spawn
    // above is an absence this instrument could have seen.
    const plainSpawn = spawnIn(classicCard(seeded.plain.id));
    await expect(plainSpawn).toBeEnabled();
    await plainSpawn.click();
    await expect.poll(() => spawns.paths.length, { message: "the contrast spawn never reached the network" }).toBe(1);
    expect(spawns.paths[0]).toBe(`/api/agents/${seeded.plain.id}/sessions`);

    // ── THE ATLAS SHELL, same seeded state: one predicate, so both must agree.
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/agents");
    const atlasHeld = page.getByTestId(`atlas-agent-live-${seeded.manager.id}`);
    await expect(atlasHeld).toBeVisible();
    await expect(atlasHeld).toBeDisabled();
    await expect(atlasHeld).toHaveText("Starting…");
    const mgrAtlasCard = page.getByTestId(`atlas-agent-card-${seeded.manager.id}`);
    await expect(spawnIn(mgrAtlasCard)).toHaveCount(0);
    // The Stop stays reachable: a manager stuck mid-startup must still be stoppable from here.
    await expect(page.getByTestId(`atlas-agent-stop-${seeded.manager.id}`)).toBeVisible();
    // Contrast again, on this shell's own roster.
    await expect(spawnIn(page.getByTestId(`atlas-agent-card-${seeded.plain.id}`))).toBeEnabled();
    // And the pill does not call a starting session live. Scoped to the identity HEAD, not the whole
    // card — the held button below it also says "Starting…", so a card-wide text match would pass on
    // the button alone and prove nothing about the pill.
    await expect(mgrAtlasCard.locator(".loom-agentrow-head")).toContainText(/starting/i);
    await expect(mgrAtlasCard.locator(".loom-agentrow-head")).not.toContainText(/\blive\b/i);

    // ── RELEASE. Driven through the daemon's own archive write (the row leaves GET /api/sessions,
    //    which is what the guard reads), not by faking the session list.
    await loomDaemon.archiveSeededSessions();
    await page.reload();
    await expect(spawnIn(page.getByTestId(`atlas-agent-card-${seeded.manager.id}`))).toBeVisible();
    await expect(page.getByTestId(`atlas-agent-live-${seeded.manager.id}`)).toHaveCount(0);
  });

  test("switch OFF: nothing this card built reached the classic shell, and Projects still hosts the editor", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/overview");

    // PRESENCE first: the classic shell really is what rendered.
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    // …and none of this card's Atlas surfaces exist in it.
    await expect(page.getByTestId("atlas-agent-editor")).toHaveCount(0);
    await expect(page.getByTestId("atlas-agents-new")).toHaveCount(0);
    await expect(page.locator(".loom-atlas-plus, .loom-atlas-noderow")).toHaveCount(0);
    await expect(page.locator('[data-testid^="atlas-project-quickspawn-"]')).toHaveCount(0);

    // THE ORIGINAL HOST IS UNTOUCHED — the "one implementation" half of the claim. The editor Projects
    // mounts is the very component the Atlas dialog mounts, so its testids are the same ones.
    await page.goto(loomDaemon.baseURL + "/projects");
    await page.getByText(seeded.plain.name, { exact: true }).click();
    const editor = page.getByTestId(`agent-editor-${seeded.plain.id}`);
    await expect(editor).toBeVisible();
    await expect(page.getByTestId(`agent-prompt-${seeded.plain.id}`)).toBeVisible();
    await expect(page.getByTestId(`agent-delete-${seeded.plain.id}`)).toBeVisible();
    // And it is the PAGE's pane, not a dialog — the frame is the host's call, the editor is shared.
    await expect(page.getByTestId("atlas-agent-editor")).toHaveCount(0);
  });
});
