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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

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

  test("pause from the bar reads back on the chip, survives a navigation, and resume from the pop-over clears it", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);    await page.goto(loomDaemon.baseURL + "/home");

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

  test("clear usage hold drops the daemon's real latch", async ({ page, loomDaemon }) => {
    // THE BEFORE-STATE. There is no REST or agent write for this latch — only the clear — so seeding it
    // in the daemon's own scratch LOOM_HOME is the documented exception (LoomDaemon.loomHome's own doc),
    // not a shortcut around a surface that exists. usage-awareness.ts reads the file on every call with
    // no in-memory cache, so a file written now is live for the very next request.
    const latch = latchPath(loomDaemon.loomHome);
    mkdirSync(path.dirname(latch), { recursive: true });
    writeFileSync(latch, JSON.stringify({ lastRateLimitAt: new Date().toISOString() }, null, 2), "utf-8");
    expect(existsSync(latch), "the seeded latch must exist before the click — otherwise its absence after proves nothing").toBe(true);
    await page.goto(loomDaemon.baseURL + "/home");

    const bar = page.getByTestId("atlas-fleet-controls-bar");
    const hold = bar.getByTestId("fleet-clear-hold");
    await expect(hold).toHaveText(/Clear usage hold/i);
    // LATCH-ONLY (card 3221d0d9): no session is parked here, only the latch is armed, and
    // GET /api/usage/limits reports `usageHoldArmed`. So this is the FULL-weight button.
    await expect(hold).toHaveAttribute("data-hold", "latch");
    await expect(hold).toHaveClass(/loom-btn-default/);

    await hold.click();

    // The UI's own four-second confirmation…
    await expect(hold).toHaveText(/hold cleared/i);
    // …and the DAEMON-side effect it is claiming. clearClaudeRateLimit() removes the file outright.
    await expect.poll(() => existsSync(latch), {
      message: "POST /api/usage/clear-hold must have removed the daemon's usage latch",
      timeout: 5_000,
    }).toBe(false);
  });

  // Card 3221d0d9: with NO latch and NO parked session the button is absent altogether. The latch file is
  // removed explicitly (the daemon is shared across specs), and the bar's presence is asserted first so
  // a page that is merely still loading cannot satisfy the zero-count.
  test("clear usage hold is hidden when no latch is armed and no session is parked", async ({ page, loomDaemon }) => {
    rmSync(latchPath(loomDaemon.loomHome), { force: true });    const usage = page.waitForResponse((r) => r.url().endsWith("/api/usage/limits") && r.request().method() === "GET");
    await page.goto(loomDaemon.baseURL + "/home");
    const bar = page.getByTestId("atlas-fleet-controls-bar");
    await expect(bar.getByTestId("fleet-pause")).toBeVisible();
    const body = (await (await usage).json()) as { usageHoldArmed?: unknown };
    expect(body.usageHoldArmed, "the daemon must have reported the latch as not armed").toBe(false);
    await expect(bar.getByTestId("fleet-clear-hold")).toHaveCount(0);
  });

  // Card 73b41b5d (Atlas audit A-13): Clear usage hold stood as a full peer of Pause and Kill all even
  // with nothing held. It now carries full weight only while a session is parked or bailed.
  //
  // 🔴 THE PARKED SESSION IS INJECTED INTO THE `GET /api/sessions` READ, not seeded. The test seed route
  // has no `rateLimitedUntil` field, and a real park needs a real rate-limited claude. The injection
  // stops the moment the button is clicked, so the AFTER state is the daemon's own unparked list: the
  // same session, read back without the mark, is what turns the button quiet again.
  test("clear usage hold is full weight only while a session is parked", async ({ page, loomDaemon }) => {
    rmSync(latchPath(loomDaemon.loomHome), { force: true }); // the BEFORE state must be latch-free whatever ran earlier
    const project = await loomDaemon.createProject(uniq("fleethold"));
    const parked = await loomDaemon.seedLiveSession({ project, role: "worker", agentName: "Dev" });

    let inject = false;
    await page.route((url) => url.pathname === "/api/sessions", async (route) => {
      if (!inject || route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const rows = (await res.json()) as { id: string; rateLimitedUntil?: string | null }[];
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      await route.fulfill({ response: res, json: rows.map((r) => (r.id === parked.sessionId ? { ...r, rateLimitedUntil: until } : r)) });
    });
    await page.goto(loomDaemon.baseURL + "/home");
    const hold = page.getByTestId("atlas-fleet-controls-bar").getByTestId("fleet-clear-hold");

    // BEFORE: the seeded session is on screen (fixture identity) and nothing is parked and no latch is
    // armed (card 3221d0d9), so the button is absent.
    await expect(page.getByTestId(`atlas-session-row-${parked.sessionId}`)).toBeVisible();
    await expect(page.getByTestId("atlas-fleet-controls-bar").getByTestId("fleet-pause")).toBeVisible();
    await expect(hold).toHaveCount(0);

    // PARKED: the same page, re-read with the mark on. Full weight.
    inject = true;
    await page.reload();
    await expect(hold).toHaveAttribute("data-hold", "sessions");
    await expect(hold).toHaveClass(/loom-btn-default/);

    // CLEAR: the real POST, then the daemon's own (unparked) list comes back and it goes quiet again.
    inject = false;
    const cleared = page.waitForResponse((r) => r.url().endsWith("/api/usage/clear-hold") && r.request().method() === "POST");
    await hold.click();
    expect((await cleared).status(), "the click must reach the daemon's clear-hold route").toBe(200);
    await expect(hold).toHaveText(/hold cleared/i);
    // …and once the 4 s confirmation is over the daemon's own answer (nothing held) hides it again.
    await expect(hold).toHaveCount(0, { timeout: 8_000 });
  });

  test("kill all is a real two-step — cancel and Escape fire nothing, Confirm fires once and the daemon acts", async ({ page, loomDaemon }) => {
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
    // Audit A-41 (card 1fe4b596): the commit step carries the SOLID danger fill, so it never reads as a
    // normal button beside Cancel, and the armed question is a sentence in the sans, not red mono.
    await expect(bar.getByTestId("fleet-kill-confirm")).toHaveClass(/\bloom-btn-dangerfill\b/);
    expect(await ask.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Instrument Sans/);
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
});
