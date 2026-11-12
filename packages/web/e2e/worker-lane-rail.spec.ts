// The worker LANE RAIL on a manager's session node — card dd5c8724, owner pick "C · Lane rail"
// (request 050b30ba). Derivations: src/lib/workerLanes.ts (unit-tested in test/worker-lanes.mjs).
//
// What is measured here, each against a fixture manager with FICTIONAL workers in varied states:
//   1. the rail renders one lane per worker, sorted needs-a-look first, each on the right lifecycle step;
//   2. selecting a lane reveals ITS actions (and only its), and Review diff only where a review waits;
//   3. the terminal still fits beside the rail at 1440 and 1920: inside its box, left of the rail;
//   4. on a phone the rail is a swipeable strip ABOVE the tab row, with no horizontal page overflow;
//   5. the rail is absent on a worker's node and on a plain session's node.
//
// A merging worker cannot be seeded (`pendingMerge` is the daemon's live op registry, not a DB row), so
// that one lane's `pendingMerge` and one lane's `run_gate` self-check are layered onto the REAL responses
// of `/api/sessions` and `/api/gates/active` by route interception. Everything else is real seeded data.
//
// FIXTURE IDENTITY: the e2e daemon is shared across spec files, so every locator is scoped to this
// run's own session ids (via `data-worker-id`) and the rail asserts its exact lane count.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

async function seedAtlas(page: Page, projectId: string) {
  await page.addInitScript(([a, p, id]) => {
    try { localStorage.setItem(a, "1"); localStorage.setItem(p, id); } catch { /* assertions will say so */ }
  }, [ATLAS_KEY, PROJECT_KEY, projectId] as const);
}

const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

/** A manager running six fictional workers, one per lane state, plus one that finished this hour. */
async function seedFleet(loomDaemon: LoomDaemon) {
  const run = randomUUID().slice(0, 6);
  const mgr = await loomDaemon.seedLiveSession({
    role: "manager", agentName: `Conductor-${run}`, id: `m${run}-${randomUUID()}`,
    ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "\u001b[32m●\u001b[0m worker_report from Web Designer (done)\r\n",
  });
  const worker = (key: string, agentName: string, title: string, extra: Parameters<LoomDaemon["seedLiveSession"]>[0] = {}) =>
    loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", parentSessionId: mgr.sessionId, agentName,
      id: `${key}${run}-${randomUUID()}`, branch: `loom/${key}-${run}`, task: { title: `${title} ${run}` }, ...extra,
    });
  const review = await worker("rv", "Web Designer", "feat(web): add keyboard shortcuts to the board filter row",
    { model: "claude-sonnet-4-5", ctxInputTokens: 126_000 });
  const blocked = await worker("bl", "Dev", "refactor(memory): split the FTS ranker out of the recall path");
  const merging = await worker("mg", "Bugfix", "fix(git): refuse a worktree cut while the index lock is held");
  const working = await worker("wk", "Dev", "fix(pty): re-arm the busy watchdog after a resumed turn", { busy: true });
  const fresh = await worker("fr", "Dev", "feat(daemon): add a per-project spend cap readout");
  const exited = await worker("ex", "QA Tester", "test(web): cover the review panel's request-changes path", { processState: "exited" });

  const ev = (kind: string, w: { sessionId: string; taskId?: string }, detail?: Record<string, unknown>) =>
    loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind, workerSessionId: w.sessionId, taskId: w.taskId, detail });
  await ev("worker_report", review, { status: "done", summary: "Shortcuts land on the filter row. e2e spec added and green." });
  await ev("merge_request", review);
  await ev("worker_report", blocked, { status: "blocked", summary: "Two ranker weights tie.", needs: "Which wins a tie: recency or score?" });
  await ev("worker_report", merging, { status: "done", summary: "Refusal added at the cut chokepoint." });
  await ev("merge_request", merging);
  await ev("worker_report", working, { status: "progress", summary: "Reproduced on resume. Patching the drain." });
  // A worker that already finished: no session row of its own, only its manager's merge_done.
  const finishedId = `fn${run}-${randomUUID()}`;
  await loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind: "merge_done", workerSessionId: finishedId, detail: { branch: null } });
  return { run, mgr, review, blocked, merging, working, fresh, exited, finishedId };
}

/** Layer a running merge op onto one worker's row and a running self-check onto another's. */
async function layerGates(page: Page, mergingId: string, selfCheckId: string, projectId: string) {
  await page.route(/\/api\/sessions(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as { id: string }[];
    const json = rows.map((r) => r.id === mergingId
      ? { ...r, pendingMerge: { opId: "e2e-op", state: "running", startedAt: ago(468), gatePhase: "running" } }
      : r);
    await route.fulfill({ response: res, json });
  });
  await page.route(/\/api\/gates\/active$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { gates: unknown[] };
    body.gates = [...body.gates, {
      id: "e2e-self-check", gateType: "worker", phase: "running", projectId, projectName: "e2e", sessionId: selfCheckId,
      taskId: null, branch: null, workerLabel: null, priority: null, since: ago(252), queuePosition: null, batched: false,
      branchCount: null, batchBranches: null, landingCheckOnly: false, distImporterCheckOnly: false, gateTimeoutMs: null,
      fallbackOfBatchOpId: null,
    }];
    await route.fulfill({ response: res, json: body });
  });
}

const rail = (page: Page) => page.getByTestId("worker-lane-rail");
const lane = (page: Page, id: string) => rail(page).locator(`[data-worker-id="${id}"]`);

async function openManager(page: Page, loomDaemon: LoomDaemon, f: Awaited<ReturnType<typeof seedFleet>>) {
  await layerGates(page, f.merging.sessionId, f.working.sessionId, f.mgr.projectId);
  await seedAtlas(page, f.mgr.projectId);
  await page.goto(`${loomDaemon.baseURL}/session/${f.mgr.sessionId}`);
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).getByTestId("worker-lane")).toHaveCount(6);
}

test.describe("worker lane rail on a manager's session node (card dd5c8724)", () => {
  test("one lane per worker, sorted needs-a-look first, each on its lifecycle step", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const f = await seedFleet(loomDaemon);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openManager(page, loomDaemon, f);

    await expect(rail(page).getByTestId("worker-lane-count")).toHaveText("6");
    const ids = await rail(page).getByTestId("worker-lane").evaluateAll((els) => els.map((e) => e.getAttribute("data-worker-id")));
    expect(ids).toEqual([f.review, f.blocked, f.merging, f.working, f.fresh, f.exited].map((w) => w.sessionId));

    const expectLane = async (id: string, step: string, status: string, label: string) => {
      await expect(lane(page, id)).toHaveAttribute("data-step", step);
      await expect(lane(page, id)).toHaveAttribute("data-status", status);
      await expect(lane(page, id).getByTestId("worker-lane-status")).toHaveText(label);
      await expect(lane(page, id).locator('[aria-current="step"]')).toHaveText(
        { dispatched: "Dispatched", working: "Working", reported: "Reported", review: "Review", merging: "Merging" }[step]!);
    };
    await expectLane(f.review.sessionId, "review", "review", "awaiting review");
    await expectLane(f.blocked.sessionId, "working", "blocked", "blocked");
    await expectLane(f.merging.sessionId, "merging", "merging", "merging");
    await expectLane(f.working.sessionId, "working", "working", "working");
    await expectLane(f.fresh.sessionId, "dispatched", "idle", "idle");
    await expectLane(f.exited.sessionId, "dispatched", "exited", "exited");

    // The card title, the blocked report's Needs line, and the two gate timers.
    await expect(lane(page, f.review.sessionId).getByTestId("worker-lane-title")).toContainText(f.review.taskTitle!);
    await expect(lane(page, f.blocked.sessionId)).toContainText("Needs: Which wins a tie: recency or score?");
    await expect(lane(page, f.fresh.sessionId)).toContainText("No report yet");
    await expect(lane(page, f.merging.sessionId).getByTestId("worker-lane-gate")).toHaveText(/^merge gate \d+:\d\d$/);
    await expect(lane(page, f.working.sessionId).getByTestId("worker-lane-gate")).toHaveText(/^self-check \d+:\d\d$/);

    // The finished footer names the worker that merged this hour.
    await expect(rail(page).getByTestId("worker-lane-finished")).toContainText(`w:${f.finishedId.slice(0, 8)}`);
    await expect(rail(page).getByTestId("worker-lane-finished")).toContainText(/merged \d+s ago|merged \d+m ago/);
  });

  test("selecting a lane reveals its actions, and Review diff only where a review waits", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const f = await seedFleet(loomDaemon);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openManager(page, loomDaemon, f);

    // The top lane starts selected, its actions out; the others' are hidden.
    const reviewActs = lane(page, f.review.sessionId).getByTestId("worker-lane-actions");
    const blockedActs = lane(page, f.blocked.sessionId).getByTestId("worker-lane-actions");
    await expect(reviewActs).toBeVisible();
    await expect(reviewActs.getByTestId("worker-lane-review")).toHaveAttribute("href", `/review/${f.review.sessionId}`);
    await expect(reviewActs.getByTestId("worker-lane-session")).toHaveAttribute("href", `/session/${f.review.sessionId}`);
    await expect(reviewActs.getByTestId("worker-lane-card")).toHaveAttribute("href", `/board?task=${f.review.taskId}`);
    await expect(blockedActs).toBeHidden();

    // Click another lane: its actions come out, the first lane's go away. No review waits there.
    await lane(page, f.blocked.sessionId).click({ position: { x: 20, y: 60 } });
    await expect(blockedActs).toBeVisible();
    await expect(reviewActs).toBeHidden();
    await expect(blockedActs.getByTestId("worker-lane-review")).toHaveCount(0);
    await expect(blockedActs.getByTestId("worker-lane-session")).toBeVisible();

    // Keyboard: focus a lane and press Enter.
    await lane(page, f.working.sessionId).focus();
    await page.keyboard.press("Enter");
    await expect(lane(page, f.working.sessionId).getByTestId("worker-lane-actions")).toBeVisible();
    await expect(blockedActs).toBeHidden();

    // The Session action is a real hop to that worker's node.
    await lane(page, f.working.sessionId).getByTestId("worker-lane-session").click();
    await expect(page).toHaveURL(new RegExp(`/session/${f.working.sessionId}$`));
  });

  for (const width of [1440, 1920]) {
    test(`the terminal still fits beside the rail at ${width}px`, async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const f = await seedFleet(loomDaemon);
      await page.setViewportSize({ width, height: 1000 });
      await openManager(page, loomDaemon, f);
      const box = page.getByTestId("session-node-pane-terminal");
      const screen = box.locator(".xterm-screen");
      await expect(screen).toBeVisible();
      await expect(box).toContainText("worker_report from Web Designer");

      const railBox = (await rail(page).boundingBox())!;
      const termBox = (await box.boundingBox())!;
      expect(termBox.x + termBox.width, "the terminal box runs under the rail").toBeLessThanOrEqual(railBox.x);
      expect(railBox.width, "the rail is not at its 372px track").toBeGreaterThan(360);
      // The grid re-fit to the narrower box: the rendered screen sits wholly inside it, nothing clipped.
      await expect.poll(async () => {
        const s = (await screen.boundingBox())!;
        const b = (await box.boundingBox())!;
        return s.x >= b.x - 1 && s.x + s.width <= b.x + b.width + 1 && s.y + s.height <= b.y + b.height + 1;
      }, { message: "the xterm screen overflows its box" }).toBe(true);
      const overflowX = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
      expect(overflowX, "the page scrolls sideways").toBeLessThanOrEqual(0);
      // The MCP strip runs full width BELOW the split rather than squeezed beside the rail, where it would
      // cross its own 700px container breakpoint and drop its duration column.
      const mcp = (await page.getByTestId("session-node-mcp").boundingBox())!;
      expect(mcp.x + mcp.width, "the MCP strip stops short of the rail's right edge").toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
      expect(mcp.y, "the MCP strip is not below the rail").toBeGreaterThanOrEqual(railBox.y + railBox.height);
    });
  }

  test("on a phone the rail is a swipeable strip above the tabs, with no page overflow", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const f = await seedFleet(loomDaemon);
    await page.setViewportSize({ width: 390, height: 844 });
    await openManager(page, loomDaemon, f);

    const railBox = (await rail(page).boundingBox())!;
    const tabs = (await page.getByTestId("atlas-node-tabs").boundingBox())!;
    expect(railBox.y + railBox.height, "the strip is not above the tab row").toBeLessThanOrEqual(tabs.y);

    const stack = rail(page).getByTestId("worker-lane-stack");
    const dims = await stack.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(dims.sw, "the lane strip does not scroll sideways").toBeGreaterThan(dims.cw);
    // Actions are out on every lane of the strip, not only the selected one.
    await expect(lane(page, f.blocked.sessionId).getByTestId("worker-lane-session")).toBeAttached();
    // It opens at its START, on the top lane — not wherever the scroll-snap re-snapped when the reports
    // landed and re-sorted the lanes (the merging lane sorts first until then).
    await expect(rail(page).getByTestId("worker-lane").first()).toHaveAttribute("data-worker-id", f.review.sessionId);
    await expect.poll(() => stack.evaluate((el) => el.scrollLeft), { message: "the strip opened scrolled mid-way" }).toBe(0);
    const before = await stack.evaluate((el) => el.scrollLeft);
    await stack.evaluate((el) => el.scrollBy({ left: el.clientWidth, behavior: "instant" as ScrollBehavior }));
    await expect.poll(() => stack.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);

    const overflowX = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
    expect(overflowX, "the page scrolls sideways on a phone").toBeLessThanOrEqual(0);
  });

  test("a manager with no workers shows the empty state; an exited worker keeps a muted lane; a worker's and a plain session's nodes have no rail", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const lone = await loomDaemon.seedLiveSession({ role: "manager", agentName: "LoneMgr", id: `lone-${randomUUID()}` });
    const w = await loomDaemon.seedLiveSession({
      project: lone.project, role: "worker", parentSessionId: lone.sessionId, agentName: "Dev", id: `lw-${randomUUID()}`,
    });
    // A second, LIVE worker: an exited session's node renders the ended panel, not a node, so the "no rail
    // on a worker's node" leg needs one that is still running.
    const live = await loomDaemon.seedLiveSession({
      project: lone.project, role: "worker", parentSessionId: lone.sessionId, agentName: "Dev", id: `lv-${randomUUID()}`, busy: true,
    });
    const plain = await loomDaemon.seedLiveSession({ project: lone.project, agentName: "Plain", id: `pl-${randomUUID()}` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAtlas(page, lone.projectId);

    // An exited worker keeps its lane (muted, sorted last) while its row is still listed.
    await loomDaemon.exitSeededSession(w.sessionId);
    await page.goto(`${loomDaemon.baseURL}/session/${lone.sessionId}`);
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByTestId("worker-lane")).toHaveCount(2);
    await expect(lane(page, w.sessionId)).toHaveAttribute("data-status", "exited");
    await expect(rail(page).getByTestId("worker-lane").last()).toHaveAttribute("data-worker-id", w.sessionId);

    for (const id of [live.sessionId, plain.sessionId]) {
      await page.goto(`${loomDaemon.baseURL}/session/${id}`);
      await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();
      await expect(rail(page)).toHaveCount(0);
    }

    const empty = await loomDaemon.seedLiveSession({ role: "manager", agentName: "EmptyMgr", id: `em-${randomUUID()}` });
    await seedAtlas(page, empty.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${empty.sessionId}`);
    await expect(rail(page).getByTestId("worker-lane-empty")).toContainText("No workers running.");
    await expect(rail(page).getByTestId("worker-lane-count")).toHaveText("0");
  });
});
