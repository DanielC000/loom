// The Atlas project node's parity gaps with the classic /overview — card 102bc915. Six legs: four
// switch-ON over the three gaps that were built, two switch-OFF. What each leg is the witness for, the
// measured RED/GREEN control, and what the End Session leg does NOT claim are in the record.
//
// @decision 102bc915 — never assert a Pulse sentinel as `detail` text, nor on the sentinel's own text
// node: EventRow renders no part of `detail`, and its detail span is squeezed to zero width in a
// band column narrower than the row wants, so either shape fails against a perfectly working feed.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and the leg would be measuring this
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

async function seedAgent(baseURL: string, projectId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/agents`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  expect(res.ok).toBeTruthy();
  return (await res.json()) as { id: string };
}

const deleteSchedule = (baseURL: string, id: string) =>
  fetch(`${baseURL}/api/schedules/${id}`, { method: "DELETE" }).catch(() => {});

// ── 1. Project-scoped schedules, on the Agents tab ────────────────────────────────────────────────
// Classic /overview renders ProjectSchedules inline; under Atlas no project-tier surface carried it at
// all (only the god-eye /automation, which is a WORKSPACE tab). The SAME component is mounted here —
// extracted to components/projectSchedules.tsx so the two mounts cannot drift.
test.describe("the project node's Agents tab carries this project's schedules (card 102bc915)", () => {
  // Schedules are a GLOBAL store that autoIsolation doesn't touch — a leftover row pollutes e.g.
  // schedules.spec.ts's "no schedules yet" empty-state assertion on the shared worker daemon.
  const seededScheduleIds: string[] = [];
  test.afterEach(async ({ loomDaemon }) => {
    for (const id of seededScheduleIds.splice(0)) await deleteSchedule(loomDaemon.baseURL, id);
  });

  test("switch ON: empty → a pointer that routes to Automation; seeded → the cron row, attributed to its agent", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasched"));
    const agentName = uniq("SchedAgent");
    const agent = await seedAgent(loomDaemon.baseURL, project.id, agentName);
    await seedAtlasOn(page);
    await pinProject(page, project.id);

    // EMPTY polarity: the collapsed one-line pointer, on the Agents tab.
    await page.goto(loomDaemon.baseURL + "/agents");
    await expect(page.getByTestId("atlas-agents-node")).toBeVisible();
    const pointer = page.getByRole("button", { name: /add one on the Automation page/i });
    await expect(pointer).toBeVisible();

    // EXERCISE it: the empty state's only control must actually route — and under Atlas `/automation`
    // is a WORKSPACE node tab (card 41eab0eb), so the shell redirects it to `/home?tab=automation`.
    // Asserting the RESOLVED address rather than the href is what proves the pointer reaches the real
    // Automation surface in this shell and not a dead path.
    await pointer.click();
    await expect(page).toHaveURL(/\/home\?tab=automation/);

    // NON-EMPTY polarity: seed two schedules for THIS project's agent (one left ON, one switched OFF)
    // and come back.
    const cron = "0 9 * * *";
    const schedName = uniq("AtlasSched");
    const pausedName = uniq("PausedSched");
    const seed = async (name: string, c: string) => {
      const r = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, agentId: agent.id, cron: c }),
      });
      expect(r.ok).toBeTruthy();
      const id = ((await r.json()) as { id: string }).id;
      seededScheduleIds.push(id);
      return id;
    };
    await seed(schedName, cron);
    const pausedId = await seed(pausedName, "0 9 * * 1");
    const off = await fetch(`${loomDaemon.baseURL}/api/schedules/${pausedId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(off.ok).toBeTruthy();

    await page.goto(loomDaemon.baseURL + "/agents");
    await expect(page.getByTestId("atlas-agents-node")).toBeVisible();
    // The row, AND its agent attribution — the half that fails if the id set were built from the wrong
    // roster (e.g. spawnable only, dropping every worker rig's schedule).
    //
    // SCOPED to the schedules readout itself (card 699fe92a). It used to be a page-wide text match,
    // which this card's new per-agent CRON chip makes ambiguous — and which was always the weaker
    // claim, since any occurrence of the string anywhere on the page satisfied it.
    const strip = page.getByTestId("atlas-agents-schedules");
    await expect(strip).toBeVisible();
    // Card fe689a28: each row leads with the schedule's NAME and reads its cadence in words (the shared
    // describeCron, the same text the Automation table shows), keeping the raw cron on the hover title.
    const row = strip.getByTestId("project-schedule-row").filter({ hasText: schedName });
    await expect(row).toBeVisible();
    await expect(row.getByText("Every day at 9:00 AM", { exact: true })).toBeVisible();
    await expect(row).toHaveAttribute("title", new RegExp(`: ${cron.replace(/\*/g, "\\*")}\\.`));
    await expect(row).toContainText(/next in /);
    await expect(strip.getByText(agentName, { exact: true }).first()).toBeVisible();
    // An OFF schedule says "paused" and shows no next fire time.
    const pausedRow = strip.getByTestId("project-schedule-row").filter({ hasText: pausedName });
    await expect(pausedRow).toContainText("paused");
    await expect(pausedRow).not.toContainText("next");
    // And the agent's own card says it is on a clock — a DIFFERENT statement in a different place
    // (which agents are scheduled, at a glance), not this readout rendered twice. Both are asserted
    // so the pair stays deliberate: a future reader sees two intended sites, not one duplicate.
    // (The card carries one chip per schedule, so this picks the ON schedule's chip out of the two.)
    await expect(page.getByTestId(`atlas-agent-card-${agent.id}`).locator(".loom-baychip.is-cron", { hasText: cron }))
      .toHaveText(cron);
    // ...and only NOW the absence: the pointer is gone because the section un-collapsed.
    await expect(page.getByRole("button", { name: /add one on the Automation page/i })).toHaveCount(0);

    // EXERCISE the row: it is read-only here, so a click goes to where the edit lives.
    await row.click();
    await expect(page).toHaveURL(/\/home\?tab=automation/);
  });
});

// ── 2. End Session on the session node ────────────────────────────────────────────────────────────
// `SessionActions` had exactly ONE mount in the whole app (the classic Overview's fleet accordion) and
// `useEndSession` exactly one consumer, so End Session was the one action with no Atlas home at all —
// Fork and Stop live on the Sessions tab and the session node, Resume on the Archive tab, and
// Clear-rate-limit on an attention row. It now rides TerminalCard's existing `actionsExtra` slot.
test.describe("End Session is reachable on the Atlas session node (card 102bc915)", () => {
  test("switch ON: clicking End Session queues the wrap-up turn on that session", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasend"));
    // A CANNED pty — the end route enqueues onto a real pty FIFO, so the session needs one.
    const mgr = await loomDaemon.seedLiveSession({
      project, role: "manager", agentName: "Orchestrator",
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);

    const endBtn = page.getByRole("button", { name: "End Session" });
    await expect(endBtn).toBeVisible();

    // WHAT IS OBSERVABLE HERE, and what is not — stated rather than overclaimed. The daemon hands the
    // wrap-up turn straight to the session's pty: MEASURED, `POST /end` answers
    // `{delivered:true, deliveryState:"handed-off"}` and the session's `/queue` is `{pending:[]}` both
    // before AND after, in both busy states. So the queue is NOT the witness — the turn never rests
    // there. And no real agent runs in a hermetic fixture, so nothing here can execute
    // `/loom-session-end` + `end_me` and actually retire the session.
    //
    // The strongest TRUE claim is therefore the round trip itself: the click issues the real write and
    // the daemon reports the turn handed off to this session's pty. That is a server-side state change
    // (the text was written to the session's stdin), and it is what fails if the button is rendered but
    // unwired — which is the defect this leg exists to catch.
    const endPost = page.waitForResponse((r) =>
      r.url().endsWith(`/api/sessions/${mgr.sessionId}/end`) && r.request().method() === "POST");

    // EXERCISE: a real click on the real control, not a direct fetch.
    await endBtn.click();

    const res = await endPost;
    expect(res.status(), "End Session must reach the daemon's own end route").toBe(200);
    expect(await res.json(), "the wrap-up turn must be handed to this session, not merely accepted")
      .toMatchObject({ delivered: true });
  });

  test("switch ON: a WORKER's node never offers it, and neither does an EXITED session's", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasendneg"));
    const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "Orchestrator" });
    const worker = await loomDaemon.seedLiveSession({
      project, role: "worker", agentName: "Dev", parentSessionId: mgr.sessionId,
    });
    const exited = await loomDaemon.seedLiveSession({
      project, role: "manager", agentName: "Retired mgr", processState: "exited",
      id: `e2e-exited-${Date.now()}`,
    });
    await seedAtlasOn(page);
    await pinProject(page, project.id);

    // PRESENCE FIRST on the control case, so a bare `toHaveCount(0)` below can't pass on a blank page.
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByRole("button", { name: "End Session" })).toBeVisible();

    // A human must NEVER end a worker out from under the manager that dispatched it.
    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    await expect(page.getByRole("button", { name: /^Fork$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "End Session" })).toHaveCount(0);

    // An already-exited session has no turn to wrap up.
    await page.goto(`${loomDaemon.baseURL}/session/${exited.sessionId}`);
    await expect(page.locator(".loom-atlas-nodehead").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "End Session" })).toHaveCount(0);
  });
});

// ── 3. The Pulse band's exited-manager tier, at the PROJECT tier ──────────────────────────────────
// Card ef86b089 closed this on the WORKSPACE node and left the project node reading `liveManagers`
// alone, so an exited-but-unarchived manager's events were reachable nowhere on this tier while
// classic /overview (which reads every non-archived manager) still showed them.
test.describe("the project node's Pulse reaches an exited manager's events (card 102bc915, extending ef86b089)", () => {
  // ⚠️ THE SENTINEL MUST BE THE EVENT'S WORKER ID, AND EXACTLY 8 CHARS. `EventRow` (components/
  // fleet.tsx) renders a row as time + kind + `w:<workerSessionId.slice(0,8)>` — it renders NO part of
  // `detail`, so a sentinel passed as `detail.branch` is invisible on screen and the leg fails against
  // a perfectly working feed. Measured the hard way; the sibling ef86b089 spec carries the same note.
  // 8 chars exactly, because a longer one is silently truncated to its first 8 and two sentinels
  // sharing a prefix become the same row.
  const sentinelId = () => `px${Math.random().toString(36).slice(2, 8)}`.slice(0, 8);

  const seedExitedWithEvent = async (loomDaemon: LoomDaemon, project: Awaited<ReturnType<LoomDaemon["createProject"]>>) => {
    // The e2e daemon is SHARED across specs, so a sibling's own rows ride along in this band: every
    // assertion here addresses THIS run's seeded event by its sentinel, never a row count.
    const sentinel = sentinelId();
    const gone = await loomDaemon.seedLiveSession({
      project, role: "manager", agentName: `PulseExited-${sentinel}`, processState: "exited",
      // `processState:"exited"` is the whole point — a plain live seed would land in the tier that
      // already worked and the leg would pass on the pre-card build.
      id: `e2e-pulsegone-${sentinel}-${Date.now()}`,
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: gone.sessionId, kind: "worker_spawn",
      workerSessionId: `${sentinel}-${Date.now()}`,
    });
    return { gone, sentinel };
  };

  test("switch ON: the exited manager's event renders in the project node's Pulse", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlaspulse"));
    // A LIVE manager too: the two tiers must COMPOSE, not replace each other.
    const live = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "Orchestrator" });
    const liveSentinel = sentinelId();
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: live.sessionId, kind: "worker_report",
      workerSessionId: `${liveSentinel}-${Date.now()}`,
    });
    const { sentinel } = await seedExitedWithEvent(loomDaemon, project);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.goto(loomDaemon.baseURL + "/project");

    const pulse = page.getByTestId("atlas-band-pulse");
    await expect(pulse).toBeVisible();

    // ⚠️ ASSERT THE ROW, NOT THE SENTINEL TEXT NODE. `EventRow`'s detail span is `flexShrink: 100000`
    // with an ellipsis, and Pulse's band column is narrower than the row wants (195.8px when card
    // 102bc915 measured it; 321px under card b4442d27's weights, still short of the ~479px an
    // `EventRow` needs) — so the span that CARRIES the sentinel is routinely squeezed to ZERO WIDTH
    // and Playwright reports it `hidden` even though the feed is working perfectly. Measured:
    // `toHaveCount(1)` passes on the very render where `toBeVisible()` on that same span fails. The
    // ROW is the thing that is genuinely on screen.
    // Matched on the detail's exact `title` (card 99b98864): the `w:` token is now a child link, so
    // `:text-is` on the span resolves to that `<a>` instead and the filter would find nothing.
    const rowFor = (tag: string) => pulse.locator('[data-testid="activity-event"]')
      .filter({ has: page.locator(`[data-testid="activity-event-detail"][title="w:${tag}"]`) });

    // The band is a FIXED-HEIGHT panel owning its own scroll, so "in the DOM" and "reachable" are two
    // different claims — scroll it into view before asserting the row is visible.
    const exitedRow = rowFor(sentinel);
    await expect(exitedRow).toHaveCount(1, { timeout: 15_000 });
    await exitedRow.scrollIntoViewIfNeeded();
    await expect(exitedRow).toBeVisible();
    // ...and the LIVE tier still renders, so this ADDED a tier rather than swapping one for the other.
    await expect(rowFor(liveSentinel)).toHaveCount(1);
  });
});
