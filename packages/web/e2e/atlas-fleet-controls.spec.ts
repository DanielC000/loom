// The Atlas fleet-controls cluster — clear usage hold / pause / resume / kill all (card 7b893d54,
// Atlas build plan P2-3). Design record: docs/decisions/7b893d54-atlas-fleet-controls.md.
//
// The card's claims, and what each is measured against:
//   1. ONE cluster, TWO mounts that cannot disagree. Pausing from the Workspace BAR is read back from
//      the crumb-bar CHIP — and, after navigating to a node that has no bar, from the chip's own
//      pop-over cluster. Resuming from the POP-OVER is then read back from the BAR. Each direction is
//      driven in one mount and asserted in the other, so a mount holding private state fails.
//   2. The paused state survives a node navigation and is visible from a node that has no bar at all —
//      the whole reason the chip exists.
//   3. Clear usage hold really drops the daemon's latch. A SEEDED latch file is the before-state and
//      its absence is the after-state, so this is not "a button changed its label".
//   4. Kill all is a genuine TWO-step: the first click fires NOTHING (instrumented, not assumed), the
//      second fires exactly one POST, and Cancel/Escape disarm with zero requests. The daemon's own
//      `{stopped:N}` is cross-checked against the count the confirm displayed.
//   5. SWITCH OFF: Mission Control's own cluster is untouched and nothing Atlas exists.
//
// 🔴 WHAT THIS SPEC CANNOT SHOW, STATED RATHER THAN PAPERED OVER. `killAllWorkers` stops a worker by
// calling `pty.stop(id,"hard")`; the DB row flips to `exited` from the pty's own `onExit`. This fixture
// forbids a real spawn (the no-spawn guard), and a seeded row has no pty — `pty.stop` silently no-ops
// and a canned entry's `kill()`/`onExit` are stubs — so a seeded worker's `processState` CANNOT move
// here, for a reason that has nothing to do with the UI under test. The emptying is therefore asserted
// through the daemon's own reported `stopped` count and through the global pause it performs as part of
// the same call (a real, user-visible state change reachable in this test by NO other route, since
// Pause is never pressed in it). ⛔ Do not "strengthen" this into a live-count assertion — it would be
// asserting the fixture's limitation, and it would fail for a reason the product never caused.
//
// Presence-first everywhere (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there first.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded rather than imported: the e2e
// tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** orchestration/usage-awareness.ts › STATE_PATH, relative to the daemon's own LOOM_HOME. */
const latchPath = (loomHome: string) => path.join(loomHome, "tmp", "claude-usage.json");

/** Leave the shared worker daemon as we found it. Pause and kill are both DAEMON-GLOBAL, and a mid-test
 *  failure would otherwise strand every later spec rendering a paused rail pill — the same backstop
 *  orchestration-status-feed.spec.ts installs for the same reason. Best-effort so a teardown error can
 *  never mask a real failure. */
async function restoreOrchestration(loomDaemon: LoomDaemon) {
  try {
    await fetch(`${loomDaemon.baseURL}/api/orchestration/resume`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
  } catch { /* daemon may already be down during teardown */ }
}

test.describe("Atlas fleet controls (card 7b893d54)", () => {
  test.afterEach(async ({ loomDaemon }) => { await restoreOrchestration(loomDaemon); });

  test("switch ON: pause from the bar reads back on the chip, survives a navigation, and resume from the pop-over clears it", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/home");

    const bar = page.getByTestId("atlas-fleet-controls-bar");
    const barPill = bar.getByTestId("fleet-orch-pill");
    const chip = page.getByTestId("atlas-orch-chip");
    const topbar = page.locator(".loom-atlas-topbar");

    // BEFORE — both mounts present and both reading RUNNING. Asserting the starting state is what
    // makes the change below attributable: a chip that said "paused" from the start would otherwise
    // satisfy the pause assertion without the click doing anything.
    await expect(bar).toBeVisible();
    await expect(barPill).toHaveText(/orchestration: running/i);
    await expect(chip).toHaveText(/running/i);
    await expect(topbar).not.toHaveClass(/is-paused/);

    // ── DRIVE IN THE BAR ───────────────────────────────────────────────────────────────────────
    await bar.getByTestId("fleet-pause").click();

    // READ BACK IN THE OTHER MOUNT. The chip is in the frame, not the page — if it held its own copy
    // of the state rather than the shared ["orchStatus"] entry, this is where that shows.
    await expect(chip).toHaveText(/paused/i);
    await expect(chip).toHaveClass(/is-paused/);
    await expect(barPill).toHaveText(/orchestration: paused/i);
    // The peripheral marker: the frame itself carries the state, so it reads without being looked for.
    await expect(topbar).toHaveClass(/is-paused/);
    // The control swapped — Resume is now the meaningful half, and Pause is gone from the cluster.
    await expect(bar.getByTestId("fleet-resume")).toBeVisible();
    await expect(bar.getByTestId("fleet-pause")).toHaveCount(0);

    // ── (2) ACROSS A NODE NAVIGATION, onto a node that has NO bar ───────────────────────────────
    await page.goto(loomDaemon.baseURL + "/gates");
    await expect(chip).toHaveText(/paused/i);
    await expect(topbar).toHaveClass(/is-paused/);
    // Presence-first: the chip IS here (above) before claiming the bar is not.
    await expect(page.getByTestId("atlas-fleet-controls-bar")).toHaveCount(0);

    // ── THE POP-OVER IS THE SECOND MOUNT OF THE SAME CLUSTER ────────────────────────────────────
    await chip.click();
    const pop = page.getByTestId("atlas-orch-pop");
    await expect(pop).toBeVisible();
    await expect(pop.getByTestId("fleet-orch-pill")).toHaveText(/orchestration: paused/i);

    // ── DRIVE IN THE POP-OVER, READ BACK IN THE BAR ─────────────────────────────────────────────
    await pop.getByTestId("fleet-resume").click();
    await expect(chip).toHaveText(/running/i);
    await expect(chip).not.toHaveClass(/is-paused/);
    await expect(topbar).not.toHaveClass(/is-paused/);

    // The pop-over dismisses on Escape (useDismissable), like every other pop-over in the app.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atlas-orch-pop")).toHaveCount(0);

    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-fleet-controls-bar").getByTestId("fleet-orch-pill"))
      .toHaveText(/orchestration: running/i);
  });

  test("switch ON: clear usage hold drops the daemon's real latch", async ({ page, loomDaemon }) => {
    // THE BEFORE-STATE. There is no REST or agent write for this latch — only the clear — so seeding it
    // in the daemon's own scratch LOOM_HOME is the documented exception (LoomDaemon.loomHome's own doc),
    // not a shortcut around a surface that exists. usage-awareness.ts reads the file on every call with
    // no in-memory cache, so a file written now is live for the very next request.
    const latch = latchPath(loomDaemon.loomHome);
    mkdirSync(path.dirname(latch), { recursive: true });
    writeFileSync(latch, JSON.stringify({ lastRateLimitAt: new Date().toISOString() }, null, 2), "utf-8");
    expect(existsSync(latch), "the seeded latch must exist before the click — otherwise its absence after proves nothing").toBe(true);

    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/home");

    const bar = page.getByTestId("atlas-fleet-controls-bar");
    const hold = bar.getByTestId("fleet-clear-hold");
    await expect(hold).toHaveText(/Clear usage hold/i);

    await hold.click();

    // The UI's own four-second confirmation…
    await expect(hold).toHaveText(/hold cleared/i);
    // …and the DAEMON-side effect it is claiming. clearClaudeRateLimit() removes the file outright.
    await expect.poll(() => existsSync(latch), {
      message: "POST /api/usage/clear-hold must have removed the daemon's usage latch",
      timeout: 5_000,
    }).toBe(false);
  });

  test("switch ON: kill all is a real two-step — cancel and Escape fire nothing, Confirm fires once and the daemon acts", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);

    // A manager plus exactly two workers, in one project. The manager is the control: `killAllWorkers`
    // filters role==="worker", so the count the confirm names must be 2 and not 3 — a cluster that
    // counted "live sessions" would say 3 and this would fail.
    const project = await loomDaemon.createProject(uniq("fleetctl"));
    const manager = await loomDaemon.seedLiveSession({
      project, role: "manager", agentName: uniq("FleetCtl Manager"), id: `e2e-fcmgr-${Date.now()}`,
    });
    for (const n of [1, 2]) {
      await loomDaemon.seedLiveSession({
        project, role: "worker", parentSessionId: manager.sessionId,
        agentName: uniq(`FleetCtl Worker ${n}`), id: `e2e-fcw${n}-${Date.now()}`,
      });
    }

    // THE INSTRUMENT. Counts every kill POST the app actually issues and passes it through to the real
    // daemon (`fallback`, not `fulfill`) — the second click must genuinely reach it. The response body
    // is captured so the daemon's own count can be cross-checked against the confirm's.
    let killPosts = 0;
    let stopped: number | null = null;
    await page.route(/\/api\/orchestration\/kill(\?|$)/, async (route) => {
      killPosts++;
      const res = await route.fetch();
      try { stopped = (await res.json() as { stopped: number }).stopped; } catch { /* asserted below */ }
      await route.fulfill({ response: res });
    });

    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/home");

    const bar = page.getByTestId("atlas-fleet-controls-bar");
    const kill = bar.getByTestId("fleet-kill");
    await expect(kill).toBeVisible();
    await expect(kill).toBeEnabled();

    // ── FIRST CLICK ARMS, AND ARMING IS NOT FIRING ──────────────────────────────────────────────
    await kill.click();
    const ask = bar.getByTestId("fleet-kill-ask");
    await expect(ask).toBeVisible();
    // THE COUNT: two workers, not three sessions. If a sibling spec leaked a live worker onto this
    // shared daemon this reads 3 and fails loudly — which is the correct outcome, not a flake to paper over.
    await expect(ask).toHaveText("Kill all 2 live workers?");
    await expect(bar.getByTestId("fleet-kill-confirm")).toBeVisible();
    // Presence-first: the armed pair is there (above) before claiming the plain button is not.
    await expect(bar.getByTestId("fleet-kill")).toHaveCount(0);
    expect(killPosts, "arming the confirm must not call the kill endpoint").toBe(0);
    // ⛔ Never a modal. Loom confirms destructively in place; this is the measurement of that claim.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // ── CANCEL DISARMS, STILL WITHOUT FIRING ────────────────────────────────────────────────────
    await bar.getByTestId("fleet-kill-cancel").click();
    await expect(bar.getByTestId("fleet-kill")).toBeVisible();
    await expect(bar.getByTestId("fleet-kill-ask")).toHaveCount(0);
    expect(killPosts, "cancelling must not call the kill endpoint").toBe(0);

    // ── THE POP-OVER MOUNT ARMS INDEPENDENTLY, AND ESCAPE DISARMS IT ────────────────────────────
    // Arming is deliberately LOCAL to a mount: arming a destructive control somewhere the reader
    // cannot see is how a misclick becomes a fleet-wide stop.
    const chip = page.getByTestId("atlas-orch-chip");
    await chip.click();
    const pop = page.getByTestId("atlas-orch-pop");
    await expect(pop.getByTestId("fleet-kill")).toBeVisible();
    await pop.getByTestId("fleet-kill").click();
    await expect(pop.getByTestId("fleet-kill-ask")).toBeVisible();
    // The BAR behind it stayed disarmed — the two mounts share state, not an armed flag.
    await expect(bar.getByTestId("fleet-kill")).toBeVisible();
    await expect(bar.getByTestId("fleet-kill-ask")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atlas-orch-pop")).toHaveCount(0);
    expect(killPosts, "Escape out of an armed confirm must not call the kill endpoint").toBe(0);

    // ── THE SECOND CLICK IS THE ONE THAT FIRES ──────────────────────────────────────────────────
    await bar.getByTestId("fleet-kill").click();
    await expect(bar.getByTestId("fleet-kill-ask")).toHaveText("Kill all 2 live workers?");
    await bar.getByTestId("fleet-kill-confirm").click();

    // THE DAEMON ACTED. killAllWorkers pauses "global" as part of the same call, so this pill — which
    // nothing in this test ever pressed Pause to reach — is the user-visible witness that the stop ran.
    await expect(bar.getByTestId("fleet-orch-pill")).toHaveText(/orchestration: paused/i);
    await expect(chip).toHaveText(/paused/i);
    // The confirm disarmed itself on success rather than staying armed over a completed action.
    await expect(bar.getByTestId("fleet-kill")).toBeVisible();

    expect(killPosts, "exactly one kill request, from the SECOND click").toBe(1);
    // CROSS-CHECK: the daemon's own stopped count against the number the confirm displayed. This is
    // what proves the cluster's "live workers" derivation matches `killAllWorkers`'s own filter rather
    // than merely looking plausible.
    expect(stopped, "the daemon must report stopping exactly the 2 workers the confirm named").toBe(2);
  });

  test("switch OFF: Mission Control's own fleet cluster is untouched and nothing Atlas is mounted", async ({ page, loomDaemon }) => {
    // No seedAtlasOn — OFF is the default.
    await page.goto(loomDaemon.baseURL + "/");
    const main = page.locator("main");

    // Presence-first: the classic surface is all still here…
    await expect(main.getByText(/^orchestration: (running|paused)$/)).toBeVisible();
    await expect(main.getByRole("button", { name: "Clear usage hold" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Kill all" })).toBeVisible();
    // …including BOTH pause and resume at once, which is the classic page's own shape and is
    // deliberately NOT what the Atlas cluster does (it swaps one for the other on the live state).

    // …and only then: nothing Atlas exists under the switch's default.
    await expect(page.getByTestId("atlas-orch-chip")).toHaveCount(0);
    await expect(page.getByTestId("atlas-fleet-controls-bar")).toHaveCount(0);
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
  });
});
