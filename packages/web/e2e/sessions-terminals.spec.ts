// Unified terminal + sessions e2e spec (card d01311b6, STAGE 6 of the terminal-unification epic) — drives
// the UNIFIED <TerminalCard> and the sessions surfaces against real, seeded LIVE sessions and asserts the
// per-variant feature set on the rendered UI. This file covers the three surfaces that mount the
// full-feature **TerminalTile** (single-session /session/:id, the project Overview grid, and the global
// /terminals grid), the sessions-list GROUPING (manager row + its worker on /terminals), and the Overview
// fleet-row **SessionCockpit** (role-scoped tabs). PlatformSessionTile + CompanionTerminal live in the
// sibling spec `terminal-variants.spec.ts` (split per the card — this one would be too long otherwise).
//
// SEEDING (the no-real-claude invariant): every live session is a `processState:"live"` DB row inserted
// through the test-only POST /internal/test/seed (`loomDaemon.seedLiveSession`, fixtures/daemon.ts) — NEVER
// startSession, which spawns a real claude and would trip the fixture's `[pty] spawn` no-spawn guard.
// Boot-reconcile (which resumes live sessions → spawns a pty) runs ONLY at daemon boot on the EMPTY DB, so
// a row inserted POST-boot is never reconciled: it renders live in the list + the card chrome mounts, and
// the /ws/term attach is a genuine no-op (deps.pty.subscribe over a non-existent live entry). So every
// assertion here is on the card's CHROME / sub-panels / metadata, NEVER a live pty stream.
//
// SUB-PANEL NOTE — queue: the SessionQueue sub-panel reads PtyHost.getPendingEntries (the LIVE pty's
// in-memory `pending` FIFO), so it structurally CANNOT render for a no-pty seeded session — there is no DB
// path to seed it. It shares the identical `subPanels` prop path as the wakes + task sub-panels, which ARE
// DB-backed and therefore seeded + asserted below; asserting those proves the shared sub-panel wiring the
// queue rides on. (Documented in the DoD report.)
//
// Determinism (shared worker daemon — playwright.config workers:1): /session/:id and /overview are single-
// session or active-project-scoped, so page-level assertions are deterministic. /terminals shows EVERY
// live session across projects, so those tests scope via its project-filter dropdown to the test's own
// freshly-seeded project.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// Isolation is baked into the fixture (fixtures/daemon.ts): the FirstRunWelcome overlay is dismissed
// globally, and after each test every seeded live session is archived + every spawned host shell is
// hard-killed — so a lingering `live` row can't pollute a later spec's global "no live sessions"
// empty-state (usage.spec) and a live ShellTile can't leak a host pty into a sibling's Shells lane. This
// spec re-derives neither.

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const shortId = (id: string) => id.slice(0, 8);

// The /terminals page has several <select>s (the header active-project picker, per-tile voice-language
// pickers). The one we want is the page's project FILTER — the only select whose options include an
// "All (N)" entry — so scope by that text to target it unambiguously on the shared worker daemon.
const projectFilter = (page: Page) => page.locator("select").filter({ hasText: "All (" });

// ── TerminalTile — the FULL-feature reference variant (Fork / Stop / maximize / presets / queue / wakes /
// task + composer). Asserted most exhaustively on /session/:id (a single tile ⇒ fully deterministic). ────
test.describe("TerminalTile (unified full-feature card)", () => {
  test("/session/:id exposes the full unified feature set and its controls actually work", async ({ page, loomDaemon }) => {
    const seeded = await loomDaemon.seedLiveSession({
      role: "plain",
      task: { title: `st-task-${Date.now()}` },
      wake: { note: `st-wake-${Date.now()}` },
    });
    await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);

    // The single live tile mounts — the identity line appears in BOTH the SessionView header AND the tile
    // title (showProject on), so match the first.
    await expect(page.getByText(new RegExp(`${seeded.agentName} · ${shortId(seeded.sessionId)}`)).first()).toBeVisible();

    // The full header action cluster: Fork (idle-only) + graceful Stop + Presets + Maximize.
    await expect(page.getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Presets" })).toBeVisible();
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();
    // The body sub-panels + composer: the bound task card, the wake chip, and the turn composer.
    await expect(page.getByText(seeded.taskTitle!, { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(seeded.wakeNote!))).toBeVisible();
    await expect(page.getByRole("button", { name: "Send turn" })).toBeVisible();

    // EXERCISE #1 — Presets: clicking opens the preset popover dialog (observable state change), Esc closes.
    await page.getByRole("button", { name: "Presets" }).click();
    await expect(page.getByRole("dialog", { name: "Preset prompts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Preset prompts" })).toHaveCount(0);

    // EXERCISE #2 — Maximize: opening swaps the tile for the full-viewport overlay (the Restore control
    // appears), Esc restores it (a clean, reversible before/after).
    await page.getByTitle("Maximize terminal").click();
    await expect(page.getByTitle("Restore terminal (Esc)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Restore terminal (Esc)")).toHaveCount(0);
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();

    // EXERCISE #3 — the bound task card opens its read-only drawer (headers with the short task id).
    await page.getByText(seeded.taskTitle!, { exact: true }).click();
    await expect(page.getByText(`Task · ${shortId(seeded.taskId!)}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText(`Task · ${shortId(seeded.taskId!)}`)).toHaveCount(0);
  });

  test("the project Overview grid tiles the live session with the full control set", async ({ page, loomDaemon }) => {
    const seeded = await loomDaemon.seedLiveSession({ role: "plain", task: { title: `ov-task-${Date.now()}` } });
    await pinActiveProject(page, seeded.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The Terminals section header reports one live session, and the tile carries the full cluster + task.
    await expect(page.getByText("(1 live)", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Presets" })).toBeVisible();
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send turn" })).toBeVisible();
    // The task title appears in the tile's SessionTaskCard AND the Overview Board card below — match first.
    await expect(page.getByText(seeded.taskTitle!, { exact: true }).first()).toBeVisible();
  });

  test("the global /terminals grid tiles the live session at parity", async ({ page, loomDaemon }) => {
    const seeded = await loomDaemon.seedLiveSession({ role: "plain" });
    await page.goto(`${loomDaemon.baseURL}/terminals`);

    // /terminals shows EVERY project's live sessions — scope to this test's project via the filter dropdown
    // so the assertions are deterministic on the shared worker daemon.
    await projectFilter(page).selectOption({ label: seeded.projectName });

    // The same TerminalTile chrome the Overview grid renders (shared component ⇒ can't drift).
    await expect(page.getByText(`${seeded.agentName} · ${shortId(seeded.sessionId)}`, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Presets" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send turn" })).toBeVisible();
  });
});

// ── Sessions list — the /terminals grid GROUPS a manager and its parented worker, with each row's role +
// live state rendered (manager pill + worker count on the row header, role + idle/busy pill in each tile). ─
test.describe("sessions list (role + state)", () => {
  test("groups a seeded manager and its worker, showing role and live state", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "Mgr" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker", busy: true,
      parentSessionId: mgr.sessionId,
    });
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    await projectFilter(page).selectOption({ label: mgr.projectName });

    // The manager ROW header names the manager (a "manager" status pill) and its worker count.
    await expect(page.getByText("manager", { exact: true })).toBeVisible();
    await expect(page.getByText("(1 worker)", { exact: true })).toBeVisible();

    // Both tiles render, each TileTitle carrying its role + a live-state pill (manager idle, worker busy).
    await expect(page.getByText(new RegExp(`Mgr · manager · ${shortId(mgr.sessionId)}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`Mgr · worker · ${shortId(wkr.sessionId)}`))).toBeVisible();
    // The worker was seeded busy → its tile wears a "busy" pill (the seeded live STATE is reflected).
    await expect(page.getByText("busy", { exact: true })).toBeVisible();
  });
});

// ── SessionCockpit — the Overview fleet-row inline cockpit. Now a <TerminalCard> binding with role-scoped
// tabs: Terminal + Transcript always, a manager's Timeline / a worker's Diff. The tab set is the cockpit's
// UNIQUE contribution (the ProjectTerminals TerminalTiles below have no tabs), so Timeline/Diff/Transcript
// are clean witnesses even though presets/maximize/task also appear on the sibling tiles. ────────────────
test.describe("SessionCockpit (Overview fleet expand)", () => {
  test("expanding a manager row opens a cockpit with Terminal/Transcript/Timeline tabs + presets/maximize/task", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "MgrCk",
      task: { title: `ck-task-${Date.now()}` },
    });
    // A worker under it, so the accordion has a nested worker row (and its Diff cockpit) to drill next.
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      parentSessionId: mgr.sessionId,
    });
    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The Fleet accordion (expanded by default) lists both sessions by their role-tagged handles.
    await expect(page.getByText(new RegExp(`mgr ${shortId(mgr.sessionId)}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`w:${shortId(wkr.sessionId)}`))).toBeVisible();

    // Expand the manager row (managers render first ⇒ its caret is the first "Expand…" control).
    await page.getByTitle("Expand to this session's cockpit").first().click();

    // The cockpit is the ONLY card with a Timeline tab — pin it as the manager cockpit's Panel and assert
    // its chrome within (presets + maximize also appear on the sibling ProjectTerminals tiles, so scope).
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible();
    const cockpit = page.locator("div")
      .filter({ has: page.getByRole("button", { name: "Timeline" }) })
      .filter({ has: page.getByRole("button", { name: "Presets" }) })
      .last();
    await expect(cockpit.getByRole("button", { name: "Terminal" })).toBeVisible();
    await expect(cockpit.getByRole("button", { name: "Transcript" })).toBeVisible();
    await expect(cockpit.getByRole("button", { name: "Timeline" })).toBeVisible();
    await expect(cockpit.getByRole("button", { name: "Diff" })).toHaveCount(0); // Diff is worker-only
    await expect(cockpit.getByRole("button", { name: "Presets" })).toBeVisible();
    await expect(cockpit.getByTitle("Maximize terminal")).toBeVisible();
    await expect(cockpit.getByText(mgr.taskTitle!, { exact: true })).toBeVisible();

    // EXERCISE — switch to the Timeline tab: the orchestration-events panel mounts (empty for a seeded
    // manager) — an observable tab change, not just a rendered bar.
    await cockpit.getByRole("button", { name: "Timeline" }).click();
    await expect(cockpit.getByText("No events yet.")).toBeVisible();
    // …and back to Transcript (the shared TranscriptPane) — the tab bar drives the body.
    await cockpit.getByRole("button", { name: "Transcript" }).click();
    await expect(cockpit.getByRole("button", { name: "Timeline" })).toBeVisible(); // tab bar persists
  });

  test("expanding a worker row opens a cockpit with a Diff tab (and no Timeline)", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "MgrDf" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      parentSessionId: mgr.sessionId, branch: "loom/seeded-branch",
    });
    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // Expand the WORKER row: after the caret's title flips on the manager, the worker's is the remaining
    // "Expand…" control. (Expand the manager first, then the worker — single-open, so the worker's caret is
    // the only "Expand…" left once the manager's reads "Collapse…".)
    await page.getByTitle("Expand to this session's cockpit").first().click(); // manager
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible();
    await page.getByTitle("Expand to this session's cockpit").click(); // now the sole remaining = worker

    // The worker cockpit carries a Diff tab (worker-only) and NO Timeline (manager-only).
    await expect(page.getByRole("button", { name: "Diff" })).toBeVisible();
    const cockpit = page.locator("div")
      .filter({ has: page.getByRole("button", { name: "Diff" }) })
      .filter({ has: page.getByRole("button", { name: "Presets" }) })
      .last();
    await expect(cockpit.getByRole("button", { name: "Terminal" })).toBeVisible();
    await expect(cockpit.getByRole("button", { name: "Transcript" })).toBeVisible();
    await expect(cockpit.getByRole("button", { name: "Timeline" })).toHaveCount(0);

    // EXERCISE — the Diff tab mounts the branch-diff panel (the seeded worker has no real branch content,
    // so it resolves to the graceful "No diff" message — an observable tab change either way).
    await cockpit.getByRole("button", { name: "Diff" }).click();
    await expect(cockpit.getByText(/No diff|Loading diff|no changes/i)).toBeVisible();
  });
});

// ── ShellTile — the raw-shell <TerminalCard> variant. A raw shell is an ephemeral PtyHost process (NOT a
// DB Session row), so unlike every other variant here it can't ride /internal/test/seed — the ONLY way to
// make one render is a REAL `POST /api/terminals`, which spawns a local host shell and logs
// `[pty] spawnShell …`. That USED to trip the fixture's no-spawn guard (an over-broad `/[pty] spawn/`
// substring-matched `spawnShell`), which is why this was previously empty-state-only. The guard is now
// narrowed to `/[pty] spawn\b/` (fixtures/daemon.ts): a benign LOCAL, UNMETERED shell is let through while a
// real claude `[pty] spawn …` is STILL caught (regression-proofed in no-spawn-guard.spec.ts). So we now
// exercise the LIVE ShellTile chrome directly: resizable pane, two-step Kill confirm, Maximize, and NO
// composer — plus the empty-state lane chrome. ────────────────────────────────────────────────────────
test.describe("ShellTile (shells lane)", () => {
  test("the Shells lane and its spawn control render (empty-state chrome)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    // The Shells lane's spawn control renders (the "Shells" label is a mixed text+count+button node, so the
    // "+ Shell" button is the clean lane witness).
    await expect(page.getByRole("button", { name: "+ Shell" })).toBeVisible();
    // The Shells lane is GLOBAL (unlike the sessions grid below, it has no project filter), so its empty
    // state holds whenever no shell is alive. Tests run serially (workers:1) and the afterEach hard-kills
    // any spawned shell, and no OTHER spec spawns shells — so no shell is alive here and the copy stands.
    await expect(page.getByText(/No shells\. Open one in a project's repo/)).toBeVisible();
  });

  test("a LIVE shell renders the ShellTile chrome and its controls actually work", async ({ page, loomDaemon }) => {
    // Spawn ONE real host shell (default shell ⇒ cross-platform). afterEach hard-kills any survivor.
    const shell = await loomDaemon.spawnShell();
    await page.goto(`${loomDaemon.baseURL}/terminals`);

    // The Shells lane is GLOBAL (no project filter — the page's project dropdown scopes only the Claude
    // sessions grid, and this shell's project has no live SESSION so it wouldn't even be an option there).
    // Serial tests + afterEach kill mean this is the ONLY live shell, so the tile is unambiguous.
    const shortShell = shell.id.slice(0, 8);
    // The tile's title: a "shell" pill + the shell's own `<label> · <short-id>` (label = "<project> · shell").
    await expect(page.getByText(new RegExp(`${shell.projectName} · shell · ${shortShell}`))).toBeVisible();
    // The empty-state copy is gone now that a shell is live.
    await expect(page.getByText(/No shells\. Open one in a project's repo/)).toHaveCount(0);

    // A ShellTile withholds the turn Composer (it's not a turn-based DB Session) — assert NO "Send turn".
    await expect(page.getByRole("button", { name: "Send turn" })).toHaveCount(0);
    // …and it has no graceful "Stop" (a shell has a hard Kill instead) nor Fork (no conversation to branch).
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fork" })).toHaveCount(0);

    // EXERCISE #1 — two-step Kill confirm: clicking Kill swaps the button for a "kill shell?" confirm cluster
    // (Confirm + Cancel), and Cancel reverts it — an observable before/after WITHOUT killing the shell.
    await expect(page.getByRole("button", { name: "Kill" })).toBeVisible();
    await page.getByRole("button", { name: "Kill" }).click();
    await expect(page.getByText("kill shell?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("kill shell?")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Kill" })).toBeVisible(); // reverted to the armed button

    // EXERCISE #2 — Maximize: the base's ⤢ swaps the tile for the full-viewport overlay (Restore appears),
    // Esc restores it (a clean, reversible before/after — the shell keeps running through it).
    await page.getByTitle("Maximize terminal").click();
    await expect(page.getByTitle("Restore terminal (Esc)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Restore terminal (Esc)")).toHaveCount(0);
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();

    // EXERCISE #3 — the live resizable pane mounts an xterm (the resizable shell body, not an empty-state).
    // The .xterm root is the observable witness that a LIVE pane rendered (vs. the seed-less empty lane).
    await expect(page.locator(".xterm").first()).toBeVisible();

    // EXERCISE #4 — actually Kill it: Kill → Confirm removes the tile (the lane returns to empty-state for
    // this project), proving the confirm path drives the real DELETE /api/terminals lifecycle.
    await page.getByRole("button", { name: "Kill" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(new RegExp(`shell · ${shortShell}`))).toHaveCount(0);
    await expect(page.getByText(/No shells\. Open one in a project's repo/)).toBeVisible();
  });
});
