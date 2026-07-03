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

// A fresh isolated daemon has no ordinary projects, so App.tsx pops the full-screen FirstRunWelcome modal
// (a fixed overlay that intercepts pointer events). Pre-set its real dismissal flag before any page script
// runs — mirrors board.spec.ts / platform.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem("loom.setupWelcomeDismissed", "1"); } catch { /* storage may be unavailable */ }
  });
});

// The e2e worker daemon is SHARED across spec files, so archive every seeded live session after each test —
// a lingering `live` row would pollute a later spec's global "no live sessions" empty-state (usage.spec).
test.afterEach(async ({ loomDaemon }) => {
  await loomDaemon.archiveSeededSessions();
});

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

// ── ShellTile — NOT hermetically seedable, documented. A raw shell is an ephemeral PtyHost process (not a
// DB Session row), so the ONLY way to make one render is POST /api/terminals, which spawns a real host
// shell and logs `[pty] spawnShell …` — a substring the fixture's `/[pty] spawn/` no-spawn guard flags,
// failing the whole worker at teardown. So a live ShellTile can't be exercised in this hermetic fixture;
// its unified chrome (resizable pane + hard Kill + Maximize + NO composer) rides the SAME <TerminalCard>
// base the other variants DO exercise here. We still assert the Shells LANE + its "+ Shell" control render
// (the empty-state chrome), so the page section itself is covered. ────────────────────────────────────
test.describe("ShellTile (shells lane)", () => {
  test("the Shells lane and its spawn control render (live shell not hermetically seedable — see note)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    // The Shells lane's spawn control renders (the "Shells" label is a mixed text+count+button node, so the
    // "+ Shell" button is the clean lane witness).
    await expect(page.getByRole("button", { name: "+ Shell" })).toBeVisible();
    // No real shell is spawned (that would trip the no-spawn guard), so the empty-state copy stands.
    await expect(page.getByText(/No shells\. Open one in a project's repo/)).toBeVisible();
  });
});
