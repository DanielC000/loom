// The Atlas Agents surfaces — the band panel, the Agents node, the tree node and the quick-spawn
// dialog (card c6160c7d, Atlas build plan P2-2: docs/plans/atlas-ui/03-decomposition.md row P2-2).
//
// The card's claim is that the spawn controls round 4 found homeless are now REACHABLE AND REAL, so
// every assertion below is driven against seeded rigs rather than against "something rendered":
//   1. THE ROSTER IS DERIVED, not listed. A worker-rig agent is seeded alongside two spawnable ones
//      and must be ABSENT from the controls and PRESENT in the "dispatched, never spawned here"
//      line — a panel that simply rendered every agent passes neither half.
//   2. THE GO-LIVE GUARD REFUSES AND RELEASES. A live manager's row carries a disabled Live + a
//      Stop and NO spawn control; a non-manager row beside it keeps spawn enabled at the same
//      moment (so the guard is shown to key on liveness+role, not on "something is live"); and the
//      guard RELEASES once that session is gone.
//   3. THE SPAWN SENDS WHAT THE CONTROL PROMISED. The default primary sends no role override and
//      the ▾'s "Manager" sends `role:"manager"` — pinned at the request, which no amount of
//      watching a button go to "Spawning…" could show.
//   4. THE NODE IS A REAL ADDRESS. It is in the tree, it navigates, and the frame names it.
//   5. SWITCH OFF: the classic Overview's own spawn cards are untouched, and `/agents` renders
//      nothing at all in the shell a user who never opted in is looking at.
//
// ⛔ NO REAL SPAWN. `loomDaemon.createProject` git-inits and binds a REAL repo, so POST
// /api/agents/:id/sessions here would start a genuinely metered claude and trip the fixture's own
// `[pty] spawn` no-spawn guard at teardown. Every spawn/stop click below is answered by a
// `page.route` fulfilment — the same seam spawn-menu-placement.spec.ts uses, and the sharper
// assertion anyway, since it pins the REQUEST. Live sessions come from `seedLiveSession`, which
// inserts the row directly and never spawns a pty.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there first.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project
// one. Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
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
// `createProject` returns what the DAEMON stored, not what was asked for, so escape rather than
// assume the stored form carries no regex metacharacter (card e47df20a).
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── REST seeding (the same human/loopback endpoints the UI drives) ─────────────────────────────
// Inline rather than added to fixtures/daemon.ts: that file is shared, and profiles-agents.spec.ts
// already establishes this exact pattern for rigs and agents.
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
 * A project with a THREE-WAY roster, which is what makes the assertions below discriminating:
 *   • a MANAGER-rig agent — the only one the go-live guard can ever hold,
 *   • a PLAIN agent (no rig) — live or not, it always keeps spawn, so it is the contrast case that
 *     stops "the guard fired" from being satisfied by "every control disappeared",
 *   • a WORKER-rig agent — which must never appear among the controls, and must be named in the
 *     dispatched line, so a panel that rendered the raw agent list fails both ways.
 */
async function seedRoster(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("atlasagents"));
  const mgrRig = await seedProfile(loomDaemon.baseURL, { name: uniq("Mgr Rig"), role: "manager", icon: "◆" });
  const wkrRig = await seedProfile(loomDaemon.baseURL, { name: uniq("Wkr Rig"), role: "worker", icon: "▸" });
  // Names share no stem with each other or with the project: several locators below filter by text.
  const manager = await seedAgent(loomDaemon.baseURL, project.id, uniq("Conductor"));
  const plain = await seedAgent(loomDaemon.baseURL, project.id, uniq("Sketchpad"));
  const worker = await seedAgent(loomDaemon.baseURL, project.id, uniq("Hauler"));
  await bindProfile(loomDaemon.baseURL, manager.id, mgrRig.id);
  await bindProfile(loomDaemon.baseURL, worker.id, wkrRig.id);
  return { project, manager, plain, worker };
}

/** The spawn split-button's primary, for ONE roster entry. Scoped through the entry's own test id
 *  so a second agent's control can never satisfy an assertion about this one.
 *
 *  `atlas-agent-row-*` is the COMPACT `AgentRosterRow`, which since card 269f46ef has exactly one
 *  mount left — the tree's quick-spawn dialog (the project Overview's Agents panel, its other
 *  mount, was removed on the owner's instruction). `atlas-agent-card-*` is the full-size
 *  `AgentRosterCard` on the Agents node. Both render the SAME `AgentActions`. */
const spawnCard = (page: Page, agentId: string) =>
  page.getByTestId(`atlas-agent-card-${agentId}`).locator('button[title^="Spawn from profile"]');

/** Answer POST /api/agents/:id/sessions in the browser and hand back what was sent. Nothing reaches
 *  the daemon, so no metered claude can start — and the captured body is the real assertion. */
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

test.describe("Atlas agents (card c6160c7d)", () => {
  // 🔴 THIS LEG MOVED FROM THE OVERVIEW'S BAND PANEL TO THE AGENTS NODE (card 269f46ef). The owner
  // removed the Agents panel from the project Overview by name ("Remove 'AGENTS' card."), so the
  // panel this leg was written against no longer exists. NOTHING about the roster changed: the same
  // `splitRoster` derivation feeds the same `AgentActions` controls, and the Agents node renders
  // them as `AgentRosterCard` (`atlas-agent-card-*`) rather than the band's compact
  // `AgentRosterRow`. Every assertion below is the one it always made, re-pointed at that card —
  // plus a new one, at the end, that the removed panel really is gone.
  test("switch ON: the Agents node is the derived roster, not the agent list", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/agents");

    // The node's own body first, so a half-loaded page cannot satisfy the absences below. P2-1's
    // placeholder slot was the band's; it is gone with the panel, and asserted as such at the end.
    const panel = page.getByTestId("atlas-agents-node");
    await expect(panel).toBeVisible();

    // (1) THE TWO SPAWNABLE AGENTS ARE THERE, each with a real spawn control.
    await expect(panel.getByTestId(`atlas-agent-card-${seeded.manager.id}`)).toBeVisible();
    await expect(panel.getByTestId(`atlas-agent-card-${seeded.plain.id}`)).toBeVisible();
    await expect(spawnCard(page, seeded.manager.id)).toBeVisible();
    await expect(spawnCard(page, seeded.plain.id)).toBeVisible();
    // The primary SAYS which role it will apply — that is the whole point of the label.
    await expect(spawnCard(page, seeded.manager.id)).toHaveText(/manager/i);

    // (2) THE WORKER IS ABSENT FROM THE SPAWN CONTROLS…
    await expect(panel.getByTestId(`atlas-agent-card-${seeded.worker.id}`)).toHaveCount(0);
    // …AND NAMED, WITH NO SPAWN CONTROL, IN THE GROUP THAT SAYS WHY. Both halves, because a roster
    // that simply dropped the worker would pass the first on its own, and that is the round-3 bug
    // this replaced.
    //
    // 🔴 WHERE THE NAME LIVES MOVED, DELIBERATELY (card 699fe92a's Launch Bay rebuild). It used to
    // be a run-together list inside this note, because worker rigs were not drawn at all and the
    // note was the only thing that could answer "where did Dev go?". The rebuild draws every rig as
    // its own `atlas-worker-rig-*` card in a group of its own, so the name is asserted THERE — and
    // the `atlas-agents-worker-note` id was kept, by name, on that group's `why` line (699fe92a
    // record: "The dispatched group's copy keeps the `atlas-agents-worker-note` test id, so the
    // sentence stays addressable under the id it has always had"). So the name is strictly MORE
    // present than it was, which is why this re-points the claim rather than relaxing it: the rig
    // card is also where the LIFECYCLE absence is now observable, and the id-level zero above only
    // says "not in the spawnable set" on its own.
    const rig = panel.getByTestId(`atlas-worker-rig-${seeded.worker.id}`);
    await expect(rig).toBeVisible();
    await expect(rig).toContainText(seeded.worker.name);
    await expect(rig.locator('button[title^="Spawn from profile"]')).toHaveCount(0);
    const note = panel.getByTestId("atlas-agents-worker-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/dispatch it from the manager/i);

    // (3) THE OVERVIEW'S OWN READOUT AGREES WITH THE ROSTER. One derivation (`splitRoster`) feeds
    // both, so a figure reading differently from the rows would mean two. It used to be the
    // `mgr · workers` KPI tile's sub-line; card 269f46ef put it on the briefing line's `fleet`
    // reading, which is the same `roster.spawnable.length`.
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-brief-fleet")).toBeVisible();
    await expect(page.getByTestId("atlas-brief-fleet").locator(".loom-ovbrief-v em")).toHaveText(/\b2 spawnable\b/);

    // (4) …AND THE PANEL THE OWNER REMOVED IS NOT ON THAT PAGE. Asserted after the reading above,
    // which is this zero's positive control: the roster derivation is demonstrably live here.
    await expect(page.getByTestId("atlas-band-agents")).toHaveCount(0);
    await expect(page.getByTestId("atlas-slot-agents")).toHaveCount(0);
    await expect(page.getByTestId(`atlas-agent-row-${seeded.plain.id}`)).toHaveCount(0);
  });

  test("switch ON: the go-live guard holds the live manager, releases it, and never touches its neighbour", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const seeded = await seedRoster(loomDaemon);
    // A live session for the MANAGER agent, inserted directly — no pty, no spawn.
    const live = await loomDaemon.seedLiveSession({
      project: seeded.project, agentId: seeded.manager.id, agentName: seeded.manager.name, role: "manager",
    });
    const stops: string[] = [];
    await page.route(
      (url) => /\/api\/sessions\/[^/]+\/stop$/.test(url.pathname),
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        stops.push(JSON.stringify({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() }));
        // Held open: the button's own pending label is the observable, and letting this resolve
        // would race the assertion against a re-render.
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      },
    );
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    // The Agents node, not the Overview's band panel — card 269f46ef removed that panel (see the
    // first leg's own note). `AgentActions` is the SAME component at both mounts, so the guard this
    // leg exercises is unchanged; only which page renders it is.
    await page.goto(loomDaemon.baseURL + "/agents");

    // BEFORE: the guard is holding. Presence of the guard pair first, then the absence of the
    // control it replaced.
    const guardLive = page.getByTestId(`atlas-agent-live-${seeded.manager.id}`);
    const guardStop = page.getByTestId(`atlas-agent-stop-${seeded.manager.id}`);
    await expect(guardLive).toBeVisible();
    await expect(guardLive).toBeDisabled();
    await expect(guardStop).toBeVisible();
    await expect(spawnCard(page, seeded.manager.id)).toHaveCount(0);

    // THE CONTRAST CASE, at the same moment on the same page: the PLAIN agent's spawn is still
    // enabled. Without it, "the guard fired" is equally satisfied by a roster that lost every
    // control — and the guard's real claim is that it is scoped to one row.
    await expect(spawnCard(page, seeded.plain.id)).toBeVisible();
    await expect(spawnCard(page, seeded.plain.id)).toBeEnabled();

    // ACT: the Stop is a real control. Its pending label is the observable; the captured request is
    // the assertion — it must name THIS session and ask for the graceful mode.
    await guardStop.click();
    await expect(guardStop).toHaveText(/Stopping…/);
    await expect.poll(() => stops.length, { message: "the Stop never reached the network" }).toBe(1);
    expect(JSON.parse(stops[0]!)).toEqual({ path: `/api/sessions/${live.sessionId}/stop`, body: { mode: "graceful" } });

    // AFTER: the guard RELEASES once the session is genuinely gone. Driven through the daemon's own
    // archive write (the session row leaves `GET /api/sessions`, which is what the guard reads), not
    // by faking the session list — a real pty exit is what the fixture's no-spawn guard forbids, and
    // this is the same observable the guard actually keys on.
    await loomDaemon.archiveSeededSessions();
    await page.reload();
    await expect(spawnCard(page, seeded.manager.id)).toBeVisible();
    await expect(page.getByTestId(`atlas-agent-live-${seeded.manager.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`atlas-agent-stop-${seeded.manager.id}`)).toHaveCount(0);
  });

  test("switch ON: a spawn sends the role its control promised, and never reaches the daemon", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    const spawns = await captureSpawns(page);
    // The global mutation handler alerts with `window.alert` unless the mutation set
    // `meta.inlineError` (src/main.tsx) — a NATIVE dialog, so `[role="dialog"]` is the wrong
    // instrument for it. Record any that fires and dismiss it, or an un-opted-out mutation would
    // wedge this test rather than fail it.
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    // The Agents node, for the reason the first leg's own note gives (card 269f46ef).
    await page.goto(loomDaemon.baseURL + "/agents");

    const row = page.getByTestId(`atlas-agent-card-${seeded.plain.id}`);
    await expect(row).toBeVisible();

    // (a) The PRIMARY spawns from the rig — no role override in the body.
    await spawnCard(page, seeded.plain.id).click();
    await expect.poll(() => spawns.bodies.length, { message: "the primary never reached the network" }).toBe(1);
    expect(spawns.paths[0], "the primary must address the agent whose row it sits in")
      .toBe(`/api/agents/${seeded.plain.id}/sessions`);
    expect(spawns.bodies[0], "the primary must send no role override").toEqual({});
    // The refusal lands INLINE, beside the button that asked — and NOT also as a blocking alert.
    // Both halves: the inline message alone is what an un-opted-out mutation would also show.
    await expect(row.locator(".loom-agentrow-err")).toBeVisible();
    expect(nativeDialogs, "a refused spawn must not raise a blocking alert on top of its inline message")
      .toEqual([]);

    // (b) The ▾ overrides the role for THIS spawn. Same shared SpawnControls the classic Overview
    // drives, so the three labels are the real ones.
    await row.locator('button[title="Override the spawn role"]').click();
    const menu = page.getByTestId("spawn-role-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("button.loom-btn-ghost")).toHaveCount(3);
    await menu.locator("button.loom-btn-ghost").filter({ hasText: "Manager" }).click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => spawns.bodies.length, { message: "the override never reached the network" }).toBe(2);
    expect(spawns.bodies[1], "the 'Manager' item must send role:manager").toEqual({ role: "manager" });
  });

  test("switch ON: the Agents node is a real address, with the roster and the worker rigs", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/project");

    // The node is reached from the project node's own TAB ROW, not from a tree row: card ec1aa18e
    // took the tree's copy of every project node tab away, Agents among them, because the owner's
    // feedback was that the sidebar should list what is running rather than the tab row again.
    // `openNodeTab` rather than a direct `atlas-tab-agents` click — the row folds by width.
    await expect(page.getByTestId("atlas-home-agents"),
      "the Agents node is a tree row again, which card ec1aa18e removed").toHaveCount(0);
    await openNodeTab(page, "agents");
    await expect(page).toHaveURL(/\/agents$/);
    // The landed mark is on the project ROW, which is what carries it for every tab on the node
    // since card 4a0ad464 removed the Home row the mark used to sit on. The row is a <button>, so
    // the anchor-scoped `is-active` selector legitimately reads zero here — asserted, because a
    // silently-zero reading is what a broken collector looks like too.
    await expect(page.getByTestId("atlas-project-node")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("atlas-home-project"),
      "the project branch grew a Home row back, which card 4a0ad464 removed").toHaveCount(0);

    // The frame names the NODE, not the tier: a node that is not its tier's head is the deepest
    // crumb and the heading, exactly as a classic destination at that depth is.
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveText("Agents");
    const crumbs = page.getByTestId("atlas-breadcrumb");
    await expect(crumbs).toContainText(seeded.project.name);
    await expect(crumbs).toContainText("Agents");

    // The page holds the same roster at full size …
    await expect(page.getByTestId("atlas-agents-node")).toBeVisible();
    await expect(page.getByTestId(`atlas-agent-card-${seeded.manager.id}`)).toBeVisible();
    await expect(page.getByTestId(`atlas-agent-card-${seeded.plain.id}`)).toBeVisible();
    await expect(spawnCard(page, seeded.plain.id)).toBeVisible();
    await expect(page.getByTestId(`atlas-agent-card-${seeded.worker.id}`)).toHaveCount(0);
    // THE TALLY RECONCILES THE TWO COUNTS (card 699fe92a). The tab badge counts every agent in the
    // project, this head used to count only the spawnable ones, and nothing on screen related them.
    // It is the same `2 spawnable` claim the old assertion made — now with the total and the
    // dispatched count it used to leave unstated, so all three numbers are pinned, not one.
    await expect(page.getByTestId("atlas-agents-count")).toContainText(
      new RegExp(`3 agents in ${escapeRe(seeded.project.name)} — 2 you spawn, 1 your manager dispatches`));

    // … and names the worker rig as a DEFINITION, with no control on it. Both halves: a page that
    // simply listed every agent would pass the first.
    const rig = page.getByTestId(`atlas-worker-rig-${seeded.worker.id}`);
    await expect(rig).toBeVisible();
    await expect(rig).toContainText(seeded.worker.name);
    // No LIFECYCLE control — the claim this row has always made. Narrowed from a flat "no buttons at
    // all" by card 318b5a21, which put an Edit here: editing a rig's DEFINITION is what this node's own
    // footer has always told the reader to do, while spawning or stopping one is still the footgun
    // (a hand-spawned worker gets a branch nobody is reviewing). atlas-agent-editor.spec.ts asserts
    // that Edit's own behaviour; this pair stays the lifecycle absence.
    await expect(rig.locator('button[title^="Spawn from profile"]')).toHaveCount(0);
    await expect(rig.locator("button.loom-btn-danger")).toHaveCount(0);
    // …and it says WHY, where the control would be. The old assertion here was that the static
    // "What a spawn does" panel is visible; the owner asked for that panel to be removed (card
    // 699fe92a), so the claim it was making — "this page explains itself, it is not just buttons" —
    // moves to the two surfaces that now carry it for THIS agent rather than in the abstract: the
    // dispatch stamp in the slot the spawn controls occupy on a spawnable card, and the group's own
    // reason for existing. Asserting the panel's ABSENCE too, so a revert cannot pass this quietly.
    await expect(page.getByTestId("atlas-spawn-explainer")).toHaveCount(0);
    await expect(rig).toContainText(/manager-dispatched/i);
    await expect(page.getByTestId("atlas-agents-worker-note")).toContainText(/dispatch it from the manager/i);
  });

  test("switch ON: the tree's quick-spawn opens the roster without navigating, and closes", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    const spawns = await captureSpawns(page);
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    // Deliberately NOT on the Agents node: the whole claim is "spawn without first navigating".
    await page.goto(loomDaemon.baseURL + "/board");
    const startedAt = new URL(page.url()).pathname;

    // BEFORE: the trigger is there and nothing is open.
    //
    // The PROJECT ROW's own `＋` (card 318b5a21), not the Agents row's: card ec1aa18e removed that
    // row with the rest of the project node's tabs, and this one is the trigger that survived — it
    // is also the better specimen for this claim, since it is `projectId`-addressed and reachable
    // from a branch you are not scoped to.
    await expect(page.getByTestId("atlas-quickspawn-open"),
      "the Agents row's own quick-spawn is back, which card ec1aa18e removed with that row")
      .toHaveCount(0);
    const stem = `atlas-project-quickspawn-${seeded.project.id}`;
    const trigger = page.getByTestId(`${stem}-open`);
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId(stem)).toHaveCount(0);

    await trigger.click();
    const dialog = page.getByTestId(stem);
    await expect(dialog).toBeVisible();
    // It carries the SAME roster — the spawnable two, never the worker rig.
    await expect(dialog.getByTestId(`atlas-agent-row-${seeded.manager.id}`)).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${seeded.plain.id}`)).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${seeded.worker.id}`)).toHaveCount(0);
    // …and it did NOT navigate to get there, which is the entire reason it exists.
    expect(new URL(page.url()).pathname, "opening the quick-spawn must not navigate").toBe(startedAt);

    // The control inside is live, and addresses the right agent.
    await dialog.locator(`[data-testid="atlas-agent-row-${seeded.plain.id}"] button[title^="Spawn from profile"]`).click();
    await expect.poll(() => spawns.paths.length).toBe(1);
    expect(spawns.paths[0]).toBe(`/api/agents/${seeded.plain.id}/sessions`);

    // Escape closes it — the keyboard path, not only the scrim.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname, "closing the quick-spawn must not navigate either").toBe(startedAt);
  });

  test("switch ON: the Workspace Operators panel reads standing operators and offers no controls", async ({ page, loomDaemon }) => {
    const seeded = await seedRoster(loomDaemon);
    // A companion is a standing operator: the workspace fleet counts deliberately exclude it, and
    // this panel is that exclusion's complement.
    const companion = await loomDaemon.seedLiveSession({
      project: seeded.project, agentName: uniq("Deja"), role: "assistant", id: `e2e-oper-${Date.now()}`,
    });
    await seedAtlasOn(page);
    await pinProject(page, seeded.project.id);
    await page.goto(loomDaemon.baseURL + "/home");

    const panel = page.getByTestId("atlas-band-operators");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("atlas-slot-operators")).toHaveCount(0);

    // The seeded operator is listed — the derivation really reads the session plane.
    const row = panel.getByTestId(`atlas-operator-${companion.sessionId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(companion.agentName);
    // …and it points at the surface that owns it, rather than carrying a second copy of its gating.
    await expect(row.getByRole("link", { name: /Companion/ })).toBeVisible();
    // No spawn and no stop anywhere in this panel — deliberate, and pinned so a later card has to
    // read the decision record before adding one (docs/decisions/c6160c7d-atlas-agents-node.md).
    await expect(panel.locator('button[title^="Spawn from profile"]')).toHaveCount(0);
    await expect(panel.locator("button.loom-btn-danger")).toHaveCount(0);
  });
});
