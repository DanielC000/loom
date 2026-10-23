// The Atlas NODE HEAD's pills and actions — card 5968d7e0 (Atlas restructure 6 of 11), closing item
// 6 of the Atlas gap audit. Design record: docs/decisions/5968d7e0-atlas-node-head-pills-actions.md.
//
// What the card claims, and how each half is measured rather than asserted by shape:
//   1. SWITCH ON — the project node's head carries REAL readings on every tab: `<N> working` off a
//      seeded busy/idle mix, and `<branch> <sha>` off a repo this spec committed to, so both pills
//      are checked against values the test itself chose rather than against "something rendered".
//   2. NEITHER PILL IS A KPI. The strip one row below carries the node's six figures on every tab
//      but Overview, so the leg asserts the working pill DISAGREES with the `mgr · workers` tile
//      beside it (2 vs 1/2 vs 3 live) and that the head's pill SET is exactly the two declared.
//   3. `Spawn +` OPENS THE EXISTING ROSTER DIALOG AND INHERITS THE GO-LIVE GUARD — exercised, not
//      rendered: the same agent is read with and without a live manager session and the control
//      swaps from the spawn split-button to the held control + Stop. Nothing is ever spawned.
//   4. A SESSION NODE'S HEAD GAINS `gen · turns`, beside (never instead of) the context readout.
//   5. THE GATES LAMPS ARE GONE INSIDE THE FRAME and still present outside it — the occupancy that
//      used to be stated three times on one screen is stated twice, and the classic page is intact.
//   6. SWITCH OFF — no node-head pill, no spawn cluster, anywhere.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that
// is merely still loading, so every pair asserts what must BE there before what must not.
//
// ⛔ NOTHING HERE EVER CLICKS A SPAWN CONTROL. The fixture's no-spawn guard forbids it, and the
// dialog's rows are read, never pressed.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* ditto */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const seededDirs: string[] = [];
test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * A project bound to a repo with a REAL initial commit, so the head pill has a branch and a sha to
 * read — and so this spec knows both, which is what makes `<branch> <sha>` an assertion against
 * chosen values rather than against a regex.
 *
 * ⭐ The branch is read back off git rather than written as "main": `git init` names the first branch
 * from the HOST's own `init.defaultBranch`, so this fixture's repo is `master` on one machine and
 * `main` on another — and a pill hardcoding either would pass for the wrong reason on one of them.
 * That is also exactly why the pill itself reads the branch instead of printing the mockup's `main`.
 *
 * The fixture's own `createProject` can't be used here: it `git init`s an EMPTY repo, which has no
 * HEAD at all, and a repo with no commit is the case the pill deliberately renders nothing for.
 */
async function seedProjectWithRepo(baseURL: string): Promise<{ id: string; name: string; branch: string; sha8: string }> {
  // Under `$LOOM_SCRATCH_DIR` when a Loom session provides one (this session's own out-of-tree
  // scratch root), falling back to the OS temp dir on a CI runner that has none.
  const scratch = mkdtempSync(path.join(process.env.LOOM_SCRATCH_DIR ?? tmpdir(), "loom-nodehead-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "e2e@loom.test"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Loom E2E"]);
  writeFileSync(path.join(repoDir, "README.md"), "# seed\n", "utf8");
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "chore: seed"]);
  const sha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const name = uniq("nodehead");
  const project = await apiJson<{ id: string }>(`${baseURL}/api/projects`, {
    method: "POST", body: JSON.stringify({ name, repoPath: repoDir, vaultPath: vaultDir }),
  });
  return { id: project.id, name, branch, sha8: sha.slice(0, 8) };
}

/**
 * THREE live sessions, two of them BUSY — the mix that makes the working pill discriminating.
 * `working` is 2, the `mgr · workers` tile beside it reads `1/2`, and the node has 3 live sessions:
 * three different numbers, so a pill accidentally wired to either live figure fails outright.
 */
async function seedFleet(loomDaemon: LoomDaemon, project: { id: string; name: string }) {
  const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: uniq("Conductor"), busy: true });
  await loomDaemon.seedLiveSession({ project, role: "worker", agentName: uniq("Hauler"), busy: true, parentSessionId: mgr.sessionId });
  await loomDaemon.seedLiveSession({ project, role: "worker", agentName: uniq("Idler"), busy: false, parentSessionId: mgr.sessionId });
  return { working: 2, live: 3, fleetTile: "1/2", managerSessionId: mgr.sessionId };
}

/** Every tab key the node actually rendered, in row order, read off the live tab row. */
async function renderedTabKeys(page: Page): Promise<string[]> {
  await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
  return page.locator('[data-testid="atlas-node-tabs"] [role="tab"]').evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, "")).filter(Boolean));
}

/** The node head's pills, keyed by their own `key`. `textContent`, not `innerText`: nothing here is
 *  upper-cased by CSS today, and reading the source form keeps that true if a tone class ever is. */
async function headPills(page: Page): Promise<Record<string, string>> {
  return page.locator('[data-testid="atlas-nodehead-pills"] .loom-atlas-headpill').evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [
      (el.getAttribute("data-testid") ?? "").replace(/^atlas-nodehead-pill-/, ""),
      (el.textContent ?? "").trim(),
    ])));
}

/** How many times the whole Atlas content column states the semaphore's lane occupancy. */
async function laneOccupancyMentions(page: Page): Promise<string[]> {
  return page.locator(".loom-atlas-content, .loom-page, body").first().evaluate((el) =>
    ((el as HTMLElement).innerText.match(/\d+\s*(?:\/|of)\s*\d+\s+lanes?\s+busy/gi) ?? []).map((s) => s.trim()));
}

test.describe("Atlas node head pills + actions (card 5968d7e0)", () => {
  test("switch ON: the project node's pills read the seeded fleet and repo on EVERY tab", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const proj = await seedProjectWithRepo(loomDaemon.baseURL);
    const fleet = await seedFleet(loomDaemon, { id: proj.id, name: proj.name });
    await seedAtlasOn(page);
    await pinProject(page, proj.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");

    // Identity: this is THIS spec's corpus. Without it a silent fallback to a sibling worker's
    // daemon would still render a plausible, screenshot-able, entirely wrong head.
    await expect(page.locator(".loom-atlas-nodehead h1")).toContainText(proj.name);

    // The two pills, each against a value this spec chose. `toHaveText` retries, so these double as
    // the settle for the session feed and the two git reads behind them.
    await expect(page.getByTestId("atlas-nodehead-pill-working")).toHaveText(`${fleet.working} working`);
    await expect(page.getByTestId("atlas-nodehead-pill-head")).toHaveText(`${proj.branch} ${proj.sha8}`);

    // ⭐ NOT A KPI, MEASURED: the working pill and the `mgr · workers` tile are different numbers on
    // one screen, and neither is the live count. A pill wired to either live figure reads `1/2` or
    // `3` here and fails. (Overview carries the DECK, so the tile is read off the deck's own tile.)
    await expect(page.getByTestId("atlas-kpi-fleet").locator(".loom-kpi-value")).toHaveText(fleet.fleetTile);
    expect(String(fleet.working)).not.toBe(fleet.fleetTile);
    expect(fleet.working).not.toBe(fleet.live);

    const keys = await renderedTabKeys(page);
    // The node is the ten-tab one card 25c08fba built — otherwise "on every tab" could pass on a
    // node that had lost the tabs this card is about.
    expect(keys.length, `project node tabs: ${keys.join(", ")}`).toBeGreaterThanOrEqual(10);

    // ⭐ Verdicts are COLLECTED and asserted once, never `expect`ed inside the loop: an in-loop
    // expect aborts at the first offender and hides every one after it (card a7f23a2f's lesson).
    const offenders: string[] = [];
    for (const key of keys) {
      await page.getByTestId(`atlas-tab-${key}`).click();
      await expect(page.getByTestId(`atlas-tab-${key}`)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("atlas-nodehead-pills")).toBeVisible();
      const pills = await headPills(page);
      // The pill SET is exactly the two this node declares — a head that picked up a seventh KPI
      // alongside them is the regression this card's whole premise rests on not happening.
      const got = Object.keys(pills).sort().join(",");
      if (got !== "head,working") offenders.push(`${key}: pills=[${got}]`);
      if (pills.working !== `${fleet.working} working`) offenders.push(`${key}: working=${pills.working}`);
      if (pills.head !== `${proj.branch} ${proj.sha8}`) offenders.push(`${key}: head=${pills.head}`);
      // The action cluster rides every tab too, and it is the node's, not a tab body's.
      if (await page.getByTestId("atlas-nodehead-spawn-open").count() !== 1) {
        offenders.push(`${key}: spawn triggers=${await page.getByTestId("atlas-nodehead-spawn-open").count()}`);
      }
    }
    expect(offenders, "every project node tab carries the node's two pills and its spawn control").toEqual([]);
  });

  test("switch ON: the Workspace node carries its own pill and NO spawn cluster", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home");

    // No absolute count here: the Workspace tier aggregates every project on a daemon a sibling
    // spec also seeds into (card 5dcb5ae9's lesson), so the claim is the pill's SHAPE and its
    // disagreement with the tile, not a number the fixture owns.
    await expect(page.getByTestId("atlas-nodehead-pill-working")).toHaveText(/^\d+ working$/);
    const pills = await headPills(page);
    expect(Object.keys(pills), "the workspace head declares exactly one pill").toEqual(["working"]);

    // ⛔ No spawn cluster: the workspace tier's spawnables are standing OPERATORS whose lifecycle
    // lives on the Platform/Companion nodes (card c6160c7d), and this node has no project to spawn
    // into. Presence of the pill above is what makes this absence meaningful.
    await expect(page.getByTestId("atlas-nodehead-actions")).toHaveCount(0);

    // And the pill is NOT the `live sessions` tile beside it: busy ⊆ live, so a head wired to the
    // tile could only ever read >= it. Equal is allowed (every live session may be busy); greater
    // is impossible and would mean the two read different populations in the wrong direction.
    const working = Number((await page.getByTestId("atlas-nodehead-pill-working").textContent() ?? "0").split(" ")[0]);
    const liveTile = Number((await page.getByTestId("atlas-kpi-live").locator(".loom-kpi-value").textContent() ?? "0").trim());
    expect(working, `working ${working} must not exceed live ${liveTile}`).toBeLessThanOrEqual(liveTile);
  });

  test("switch ON: Spawn + opens the roster dialog, and the go-live guard swaps its control", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const proj = await seedProjectWithRepo(loomDaemon.baseURL);
    // A manager-RIG agent: `managerLive` is `profile.role === "manager" && live`, so the rig is what
    // makes this row the one the guard can ever hold (lib/atlasAgents.ts). The plain agent beside it
    // is the contrast case — it keeps spawn in BOTH states, so "the guard fired" can never be
    // satisfied by a dialog that simply lost every control.
    const mgrRig = await apiJson<{ id: string }>(`${loomDaemon.baseURL}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: uniq("Mgr Rig"), role: "manager", icon: "◆" }),
    });
    const manager = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/projects/${proj.id}/agents`, {
      method: "POST", body: JSON.stringify({ name: uniq("Conductor"), startupPrompt: "" }),
    });
    const plain = await apiJson<{ id: string; name: string }>(`${loomDaemon.baseURL}/api/projects/${proj.id}/agents`, {
      method: "POST", body: JSON.stringify({ name: uniq("Sketchpad"), startupPrompt: "" }),
    });
    await apiJson(`${loomDaemon.baseURL}/api/agents/${manager.id}`, { method: "POST", body: JSON.stringify({ profileId: mgrRig.id }) });

    await seedAtlasOn(page);
    await pinProject(page, proj.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.locator(".loom-atlas-nodehead h1")).toContainText(proj.name);

    // BEFORE PRESSING: the dialog does not exist. The trigger is what creates it, which is also why
    // the always-mounted tree issues no roster request until someone asks.
    const trigger = page.getByTestId("atlas-nodehead-spawn-open");
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("atlas-nodehead-spawn")).toHaveCount(0);

    // ACT (1): no live manager yet — the roster offers a real spawn, and no Stop.
    await trigger.click();
    const dialog = page.getByTestId("atlas-nodehead-spawn");
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // It is the EXISTING dialog, not a new one: the roster rows, the exit to the Agents node and
    // the dispatched-workers note are the quick-spawn's own furniture.
    await expect(dialog.getByTestId("atlas-nodehead-spawn-roster")).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${manager.id}`)).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-row-${plain.id}`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="atlas-agent-row-${manager.id}"] button[title^="Spawn from profile"]`)).toBeVisible();
    await expect(dialog.getByTestId(`atlas-agent-stop-${manager.id}`)).toHaveCount(0);
    await expect(dialog.getByTestId(`atlas-agent-live-${manager.id}`)).toHaveCount(0);
    // Escape closes it — the dialog's own handler, inherited with everything else.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atlas-nodehead-spawn")).toHaveCount(0);

    // ACT (2): give that agent a live manager session, then reopen. Inserted directly — no pty, no
    // spawn — which is the same observable the guard actually keys on.
    await loomDaemon.seedLiveSession({
      project: { id: proj.id, name: proj.name }, agentId: manager.id, agentName: manager.name, role: "manager",
    });
    await page.reload();
    await page.getByTestId("atlas-nodehead-spawn-open").click();
    const held = page.getByTestId("atlas-nodehead-spawn").getByTestId(`atlas-agent-live-${manager.id}`);
    await expect(held).toBeVisible();
    await expect(held).toBeDisabled();
    await expect(page.getByTestId("atlas-nodehead-spawn").getByTestId(`atlas-agent-stop-${manager.id}`)).toBeVisible();
    // AFTER: the spawn control for THAT agent is gone — a live manager shows Stop, never a second spawn.
    await expect(page.getByTestId("atlas-nodehead-spawn")
      .locator(`[data-testid="atlas-agent-row-${manager.id}"] button[title^="Spawn from profile"]`)).toHaveCount(0);
    // THE CONTRAST CASE, same dialog, same moment: the plain agent's spawn is still enabled, so the
    // guard is scoped to one row rather than having emptied the roster.
    const plainSpawn = page.getByTestId("atlas-nodehead-spawn")
      .locator(`[data-testid="atlas-agent-row-${plain.id}"] button[title^="Spawn from profile"]`);
    await expect(plainSpawn).toBeVisible();
    await expect(plainSpawn).toBeEnabled();
  });

  test("switch ON: a session node's head gains gen · turns beside its context readout", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const proj = await seedProjectWithRepo(loomDaemon.baseURL);
    const mgr = await loomDaemon.seedLiveSession({
      project: { id: proj.id, name: proj.name }, role: "manager", agentName: uniq("Conductor"),
      busy: true, model: "claude-sonnet-4-5", ctxInputTokens: 410_000,
    });
    // `gen` and `ctxTurns` have no daemon seed path on a hermetic fixture — the test-only
    // /internal/test/seed liveSessions shape carries neither, and both are written only by the pty's
    // own generation/context bookkeeping. Patching the real `GET /api/sessions` response is the same
    // route-interception card 14e48890 used for the plan-usage meter, and it leaves every OTHER
    // field on the row the daemon's own, so the identity assertion below still means something.
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const rows = (await res.json()) as { id: string; gen?: number; ctxTurns?: number }[];
      for (const r of rows) if (r.id === mgr.sessionId) { r.gen = 412; r.ctxTurns = 318; }
      await route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(rows) });
    });

    await seedAtlasOn(page);
    await pinProject(page, proj.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);

    const state = page.getByTestId("session-node-state");
    await expect(state).toBeVisible();
    await expect(page.getByTestId("session-node-gen")).toHaveText("gen 412 · 318 turns");

    // TWO clusters, not one: the gen pill never carries the `%`, which `ctxReadout` beside it owns.
    // 410k of this model's 1,000,000-token window is 41% (contextWindowForModel), so the figure is
    // derivable rather than a magic number.
    await expect(state).toContainText("41%");
    await expect(page.getByTestId("session-node-gen")).not.toContainText("%");

    // It is the FRAME's node head that carries it, not a card header the frame also renders — the
    // de-duplication card a7f23a2f established, which this card adds to rather than undoes.
    await expect(page.locator('[data-testid="atlas-nodehead-extras"] [data-testid="session-node-gen"]')).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("switch ON: the Gates tab states its lane occupancy once, not twice", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    await seedAtlasOn(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home?tab=gates");

    // PRESENCE FIRST — the tab's own body is up, and the node's strip above it already carries the
    // running·queued pair. Only then does the absence of the page's lamps mean anything.
    await expect(page.getByTestId("atlas-tab-gates")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("atlas-kpi-pill-gates")).toBeVisible();
    await expect(page.getByText(/maxConcurrentGates/).first()).toBeVisible();

    // ONE statement of lane occupancy in the whole column: the body's own Semaphore line, which is a
    // strict superset of the two lamps (it names the cap as well). Before this card there were two.
    const mentions = await laneOccupancyMentions(page);
    expect(mentions, `lane-occupancy statements inside the Atlas frame: ${JSON.stringify(mentions)}`).toHaveLength(1);
    expect(mentions[0]).toMatch(/maxConcurrentGates|lanes? busy/i);
  });

  test("switch OFF: no node-head pill or spawn cluster, and the classic Gates head is intact", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const proj = await seedProjectWithRepo(loomDaemon.baseURL);
    await seedFleet(loomDaemon, { id: proj.id, name: proj.name });
    // Deliberately NOT seedAtlasOn — off is the default. The project is still pinned so the classic
    // project-scoped pages render their real content rather than a pick-a-project empty state.
    await pinProject(page, proj.id);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const addresses = ["/project", "/home", "/board", "/memory", "/runs", "/archive", "/agents", "/gates"];
    const offenders: string[] = [];
    for (const addr of addresses) {
      await page.goto(loomDaemon.baseURL + addr);
      // Presence first: the classic shell's own rail must be up before any absence here means
      // anything — a page still loading has no pills either.
      await expect(page.locator(".loom-rail")).toBeVisible();
      // Both the testid and the class, because a pill rendered without its testid would still be
      // the regression this leg exists to catch.
      const byTestId = await page.locator('[data-testid^="atlas-nodehead-"]').count();
      const byClass = await page.locator(".loom-atlas-headpill, .loom-atlas-headpills, .loom-atlas-headactions").count();
      if (byTestId !== 0 || byClass !== 0) offenders.push(`${addr}: testid=${byTestId} class=${byClass}`);
    }
    expect(offenders, "the classic shell renders no node-head pill or spawn cluster anywhere").toEqual([]);
    // And nothing Atlas at all, so the absence above is the switch being off rather than a head that
    // merely failed to render inside a mounted frame.
    await expect(page.locator("[class^='loom-atlas-'], [class*=' loom-atlas-']")).toHaveCount(0);

    // THE OTHER POLARITY of the Gates change: outside the frame the page keeps its own head AND its
    // two occupancy lamps, so this card suppressed them inside the frame rather than deleting them.
    await page.goto(loomDaemon.baseURL + "/gates");
    await expect(page.getByTestId("page-identity")).toBeVisible();
    const classicMentions = await laneOccupancyMentions(page);
    expect(classicMentions, `the classic Gates page keeps its lamp: ${JSON.stringify(classicMentions)}`).toHaveLength(2);
  });

  test("switch ON at 420px: the head wraps and nothing escapes the viewport", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const proj = await seedProjectWithRepo(loomDaemon.baseURL);
    await seedFleet(loomDaemon, { id: proj.id, name: proj.name });
    await seedAtlasOn(page);
    await pinProject(page, proj.id);
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(loomDaemon.baseURL + "/project");

    await expect(page.getByTestId("atlas-nodehead-pill-working")).toBeVisible();
    await expect(page.getByTestId("atlas-nodehead-pill-head")).toBeVisible();
    await expect(page.getByTestId("atlas-nodehead-spawn-open")).toBeVisible();

    // Every pill and the trigger sit INSIDE the node head's own box, and the document does not
    // scroll sideways. Measured off the rendered boxes, never off a screenshot (card 0d0c6cee).
    const escaped = await page.locator(".loom-atlas-nodehead").evaluate((head) => {
      const box = head.getBoundingClientRect();
      return [...head.querySelectorAll(".loom-atlas-headpill, .loom-atlas-headactions .loom-btn")]
        .map((el) => ({ t: (el.textContent ?? "").trim(), r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.right > box.right + 1 || r.left < box.left - 1)
        .map(({ t }) => t);
    });
    expect(escaped, "no node-head pill or control overflows the head").toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the document does not scroll sideways at 420px").toBeLessThanOrEqual(0);
  });
});
