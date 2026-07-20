// Mission Control — Wave Replay collapse + activity-feed project attribution (2026-07-20 Product Review §7).
// Two behaviours proven here against the isolated-daemon harness (no real claude):
//   A. Wave Replay is a forensic tool, so it's COLLAPSED by default on the operational home, and its
//      archived-manager picker feed (GET /api/archived-sessions?...&role=manager) is GATED on the open
//      state — so that 300-row poll does NOT fire while replay is closed. Expanding it lazily fetches the
//      picker, which must STILL list old ARCHIVED managers (guardrail card 3a93313 — reachability past the
//      live wave).
//   B. The god-eye activity feed interleaves events from every active project, so each row carries a small
//      project chip. (Scoped to the Mission Control call-site; the project-scoped Overview feed omits it.)
//
// Seeding (the no-real-claude invariant): live/archived manager rows are `processState` DB rows via POST
// /internal/test/seed (never startSession → no `[pty] spawn`); the activity row is a seeded orchestration_
// events row (loomDaemon.seedOrchestrationEvent). One manager is archived mid-test by hitting the same seed
// endpoint directly (archiveSessions) so it becomes an archived-manager the picker must still surface.
import { expect, test } from "./fixtures/daemon";

test.describe("Mission Control — Wave Replay collapse + activity project attribution (Product Review §7)", () => {
  test("Wave Replay is collapsed by default with its archived-manager poll gated, expands to a picker listing archived managers, and activity rows carry a project chip", async ({ page, loomDaemon }) => {
    // Record every archived-MANAGER poll so we can prove it stays idle while replay is closed.
    const managerPolls: string[] = [];
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/archived-sessions") && u.includes("role=manager")) managerPolls.push(u);
    });

    // A distinctly-named project with a LIVE manager (a replay root + the activity event's owner) and a
    // second manager we then ARCHIVE — the picker must still reach it once opened.
    const proj = await loomDaemon.createProject(`mc-replay-${Date.now()}`);
    const liveMgr = await loomDaemon.seedLiveSession({ project: proj, role: "manager", agentName: "LiveMgr" });
    const archMgr = await loomDaemon.seedLiveSession({ project: proj, role: "manager", agentName: "ArchMgr" });
    // Archive ONLY archMgr (leaving liveMgr live) via the test-only seed endpoint, so it drops into the
    // archived-manager set the Run Replay picker reads.
    await fetch(`${loomDaemon.baseURL}/internal/test/seed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ archiveSessions: [archMgr.sessionId] }),
    });

    // One orchestration event on the live manager → an activity-feed row (the project-chip witness).
    await loomDaemon.seedOrchestrationEvent({ managerSessionId: liveMgr.sessionId, kind: "merge_done" });

    // Mission Control is the god-eye home at "/" (nav.tsx) — no active-project pin needed.
    await page.goto(`${loomDaemon.baseURL}/`);

    // ── A. Collapsed by default ──────────────────────────────────────────────────────────────────
    const toggle = page.locator("main").getByRole("button", { name: /Wave replay/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The closed affordance shows its hint; the picker (a combobox) is NOT mounted while collapsed.
    await expect(page.locator("main").getByText("scrub & compare wave audit timelines")).toBeVisible();
    await expect(page.locator("main").getByRole("combobox")).toHaveCount(0);
    // The gated archived-manager poll never fired while replay was closed (the whole point).
    expect(managerPolls).toHaveLength(0);

    // ── B. Activity row carries the owning project's chip ────────────────────────────────────────
    // The god-eye feed row for our seeded event shows the kind AND the project chip in the same row.
    const eventRow = page.locator("main").getByText("merge_done", { exact: true }).first().locator("..");
    await expect(eventRow).toContainText(proj.name);

    // ── A (cont.) Expand → picker appears, lists live + archived managers, poll now fires ─────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Hint is gone once open; the subject picker is mounted.
    await expect(page.locator("main").getByText("scrub & compare wave audit timelines")).toHaveCount(0);
    const subject = page.locator("main").getByRole("combobox").first();
    await expect(subject).toBeVisible();
    // BOTH of THIS project's managers are selectable subjects — the LIVE one (from the live feed) AND the
    // ARCHIVED one (only reachable via the lazily-fetched archived-manager feed). Scoped by the unique
    // project name so archived managers accumulated by sibling specs on the shared daemon can't skew it.
    // archMgr is excluded from the live session feed once archived, so a 2nd option for this project can
    // ONLY have come from the archived-manager picker feed — the guardrail (card 3a93313) in one assertion.
    await expect(subject.locator("option", { hasText: `${proj.name} · mgr` })).toHaveCount(2);

    // The gated poll fired only once opening it flipped `enabled` true (lazy fetch), and that feed genuinely
    // surfaces the archived manager — a direct read of the exact endpoint the picker consumes, so the
    // reachability guarantee doesn't hinge on the seeded session's post-archive processState label.
    await expect.poll(() => managerPolls.length).toBeGreaterThan(0);
    const archFeed = await (await fetch(`${loomDaemon.baseURL}/api/archived-sessions?limit=300&role=manager`)).json() as { items: { id: string }[] };
    expect(archFeed.items.some((s) => s.id === archMgr.sessionId)).toBe(true);
  });
});
