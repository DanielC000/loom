// Unified terminal e2e spec — the NON-project-grid variants (card d01311b6, STAGE 6 of the terminal-
// unification epic; split out of sessions-terminals.spec.ts, which the card sanctions). Two variants:
//   • PlatformSessionTile — the SHARED tile for every Platform session surface. The DEV "Platform Dev
//     grid" is LOOM_DEV-gated and unreachable in this fixture (LOOM_DEV=0, see fixtures/daemon.ts), so we
//     exercise the IDENTICAL component through the shipping End-User Platform "Operator session" tile,
//     which mounts the SAME PlatformSessionTile. It carries the full sub-panel set (presets / wakes / task
//     + composer) but DELIBERATELY WITHHOLDS Fork (forking would mint a second elevated session).
//   • CompanionTerminal — the read-only watch window onto a companion's own pty (maximize, NO composer).
//
// SEEDING (no real claude): the Operator session is a live setup-role row seeded via
// loomDaemon.seedLiveSession (POST /internal/test/seed → deps.db.insertSession, never startSession); the
// companion is seeded via loomDaemon.seedCompanion. Both bypass any real spawn, so the fixture's
// `[pty] spawn` no-spawn guard stays clean. Assertions are on the card chrome, never a live pty stream.
import { expect, test } from "./fixtures/daemon";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem("loom.setupWelcomeDismissed", "1"); } catch { /* storage may be unavailable */ }
  });
});

// Archive the seeded live session after each test — the worker daemon is shared across spec files, so a
// lingering `live` row would pollute a later spec's global "no live sessions" empty-state (usage.spec).
test.afterEach(async ({ loomDaemon }) => {
  await loomDaemon.archiveSeededSessions();
});

// ── PlatformSessionTile (via the End-User Platform Operator session) ─────────────────────────────────
test.describe("PlatformSessionTile (Operator session)", () => {
  test("carries the sub-panels + composer but WITHHOLDS Fork", async ({ page, loomDaemon }) => {
    // Resolve the reserved "Platform" home + its operator agent exactly the way EndUserPlatformView does
    // (role "setup", falling back to the seeded name "Platform"), then seed a LIVE setup-role session bound
    // to it + a pending wake. A wake (DB-backed) makes the SessionWakes sub-panel render; a bound task is
    // deliberately NOT seeded here (the reserved home's board columns differ from a normal project, so a
    // seeded card risks a column mismatch — the task sub-panel is the SAME `subPanels` prop TerminalTile
    // exercises the task card on in sessions-terminals.spec.ts).
    const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
    const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
    const roleOf = (a: { profileId?: string | null }) =>
      profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
    const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
      ?? home.agents.find((a: { name: string }) => a.name === "Platform");
    expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();

    const seeded = await loomDaemon.seedLiveSession({
      project: { id: home.project.id, name: home.project.name },
      agentId: operator.id,
      role: "setup",
      wake: { note: `pf-wake-${Date.now()}` },
    });

    await page.goto(`${loomDaemon.baseURL}/platform`);

    // The Operator session section mounts the live PlatformSessionTile: presets + graceful Stop + maximize
    // in the header, the turn composer + the seeded wake in the body. (Substring, not exact: with a live
    // session the section label carries a status pill, so its full text is "Operator session" + "idle".)
    await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Presets" })).toBeVisible();
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send turn" })).toBeVisible();
    await expect(page.getByText(new RegExp(seeded.wakeNote!))).toBeVisible();

    // The load-bearing platform divergence: Fork is WITHHELD on every Platform tile (no Fork anywhere).
    await expect(page.getByRole("button", { name: "Fork", exact: true })).toHaveCount(0);

    // EXERCISE — maximize opens the overlay (Restore control), Esc restores it.
    await page.getByTitle("Maximize terminal").click();
    await expect(page.getByTitle("Restore terminal (Esc)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Restore terminal (Esc)")).toHaveCount(0);
  });
});

// ── CompanionTerminal (read-only watch window) ───────────────────────────────────────────────────────
test.describe("CompanionTerminal (read-only)", () => {
  test("is read-only with maximize and NO composer / Fork / Stop", async ({ page, loomDaemon }) => {
    await loomDaemon.seedCompanion();
    await page.goto(`${loomDaemon.baseURL}/companion`);

    // Switch to the companion's Terminal tab (Chat is the default face).
    await page.getByRole("tab", { name: "Terminal" }).click();

    // The read-only window: its "read-only" status pill + the disabled-typing hint, with Maximize present…
    await expect(page.getByText("read-only", { exact: true })).toBeVisible();
    await expect(page.getByText(/typing here is disabled/i)).toBeVisible();
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();
    // …and NONE of the interactive session controls (readOnly withholds the composer; a companion is driven
    // through Chat, never stopped/forked from here).
    await expect(page.getByRole("button", { name: "Send turn" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fork", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

    // EXERCISE — maximize opens the overlay (Restore control), Esc restores it.
    await page.getByTitle("Maximize terminal").click();
    await expect(page.getByTitle("Restore terminal (Esc)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Restore terminal (Esc)")).toHaveCount(0);
  });
});
