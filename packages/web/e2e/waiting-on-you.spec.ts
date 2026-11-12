// "Waiting on you" (card d2a44f7b, Ink & Signal): a session that holds a PENDING owner Request it filed
// reads "waiting on you" in a SOLID attn capsule, instead of green "idle" or blue "working". The trigger
// is exactly the pending-request map keyed by the asking session id (`usePendingDecisionsBySession`), so a
// session with no pending Request is unaffected, and a worker_report(blocked) is never a signal.
//
// Pinned against the running app on the Atlas project Overview's roster (`sessionStatus` → RosterTable):
//   1. BEFORE: a busy manager reads "working" on the work tone, the idle worker "idle" on live;
//   2. AFTER the manager files a pending Request: its pill reads "waiting on you", filled with --loom-attn
//      under --loom-on-attn; the worker, which filed nothing, is unchanged (the flag is per session).
import { expect, test, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

// lib/activeProject.tsx owns this key; hardcoded because the e2e tsconfig covers e2e/ only.
const PROJECT_KEY = "loom.projectId";

async function openProjectOverview(page: Page, baseURL: string, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try {
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable — the assertions below will say so */ }
  }, [PROJECT_KEY, projectId] as const);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseURL + "/project");
}

/** One roster row's state pill, by the session it draws — never by text a sibling spec could match. */
const statePill = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="atlas-roster-row"][data-session-id="${sessionId}"]`).getByTestId("atlas-roster-state");

test("a session with a pending owner Request reads 'waiting on you' in solid attn; the rest are unchanged", async ({ page, loomDaemon }) => {
  const short = `${Math.floor(Math.random() * 1e6)}`;
  const project = await loomDaemon.createProject(`waiting-${Date.now()}-${short}`);
  const mgr = await loomDaemon.seedLiveSession({
    project, id: `e2e-wmgr-${short}`, agentName: `WaitMgr-${short}`, role: "manager", busy: true,
  });
  const worker = await loomDaemon.seedLiveSession({
    project, id: `e2e-wwkr-${short}`, agentName: `WaitWkr-${short}`, role: "worker", parentSessionId: mgr.sessionId,
  });

  await openProjectOverview(page, loomDaemon.baseURL, project.id);
  // FIXTURE IDENTITY: this project is the one on screen, not a sibling spec's or the default one.
  await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);

  // ── BEFORE: nothing pending. The busy manager is working, the idle worker is idle. ──
  const mgrPill = statePill(page, mgr.sessionId);
  const wkrPill = statePill(page, worker.sessionId);
  await expect(mgrPill).toHaveText("working");
  await expect(mgrPill).toHaveCSS("background-color", await cssColor(page, "--loom-work-soft"));
  await expect(wkrPill).toHaveText("idle");

  // ── The manager files a pending Request (a decision the owner has not answered). ──
  await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: project.id, title: `Ship it? ${short}` });

  // AFTER: the manager's own pill flips (the shared request query refetches on its own interval), to the
  // solid "needs you" capsule: the attn fill under its on-colour, not the soft tint other capsules wear.
  await expect(mgrPill).toHaveText("waiting on you", { timeout: 15_000 });
  await expect(mgrPill).toHaveCSS("background-color", await cssColor(page, "--loom-attn"));
  await expect(mgrPill).toHaveCSS("color", await cssColor(page, "--loom-on-attn"));
  // The worker filed nothing, so the flag did not leak onto it: the map is per asking session.
  await expect(wkrPill).toHaveText("idle");
  await expect(wkrPill).toHaveCSS("background-color", await cssColor(page, "--loom-live-soft"));
});
