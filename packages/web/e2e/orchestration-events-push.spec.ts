// Card 670b2081: orchestration EVENTS moved from ~14 `refetchInterval` polls of
// `GET /api/orchestration/events` onto the app-wide `/ws/fleet` socket (Db.eventObserver -> FleetHub ->
// `event` frame -> FleetSocketProvider patches the react-query event caches).
//
// The reader used here is the codex isolation-gap attention row (a by-KINDS event list, the family that
// accounted for ~65 of the idle page's requests/min). Each test seeds through the daemon's own appendEvent
// writer, so a frame can only reach the page via the real observer path.
//
// TEST 1 asserts a CONJUNCTION (as orchestration-status-feed.spec.ts does): the row for a freshly seeded
// event APPEARS, AND zero event-endpoint requests are issued across a dwell sized off the slowest removed
// poll. Either half alone is worthless — a dead feed can still show a row (a poll found it), and a zero
// count can mean "my counter is broken". The in-test instrument control: the counter must have counted the
// cold-load request before any zero is believed.
//
// TEST 2 isolates the RESYNC. While the socket is held down by routeWebSocket, the REST event reads are
// ABORTED too, so the disconnected-only fallback poll cannot deliver anything: the only way events seeded
// during the outage can reach the screen is the on-reconnect re-read. Exactly-once / dedupe is pinned at the
// list level in packages/web/test/orchEvents.mjs and at the emitter in daemon/test/ws-fleet-event-push.mjs
// (the attention row collapses duplicates by design, so a DOM count cannot witness it).
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

const GAP_ITEMS = [{ id: "permissionDeny", reason: "this project has authored permission.deny rules that codex cannot honour." }];
const ITEMS_KEY = "permissionDeny";
const EVENTS_ENDPOINT = /\/api\/orchestration\/events(\?|$)/;
// The slowest removed by-kinds poll was 15s, the fastest 4s; 9s fits two of the 4s family with room, the
// same sizing rule the status-feed spec used.
const DWELL_MS = 9_000;

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const gapRowFor = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="attention-row"][data-kind="CODEX ISOLATION GAP"][data-session-id="${sessionId}"]`);

const seededGaps: { agentSentinel: string; workerSessionId: string }[] = [];

async function seedSession(loomDaemon: LoomDaemon, agentName: string) {
  return loomDaemon.seedLiveSession({ id: mintId("evp-cdx"), role: "plain", harness: "codex", agentName });
}

async function seedGap(loomDaemon: LoomDaemon, sessionId: string) {
  const agentSentinel = `evp-agent-${randomUUID()}`;
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: sessionId, workerSessionId: sessionId, kind: "codex_isolation_gap_disclosed",
    detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: sessionId, itemsKey: ITEMS_KEY, nudged: false },
  });
  seededGaps.push({ agentSentinel, workerSessionId: sessionId });
}

// A superseding managed-shape disclosure per seeded gap clears the human's copy, so no row leaks into later
// specs on the shared daemon (same cleanup as codex-isolation-gap-attention.spec.ts).
test.afterEach(async ({ loomDaemon }) => {
  for (const { agentSentinel, workerSessionId } of seededGaps.splice(0)) {
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mintId("evp-cleanup-mgr"), workerSessionId, kind: "codex_isolation_gap_disclosed",
      detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: workerSessionId, itemsKey: ITEMS_KEY, nudged: true },
    });
  }
});

test.describe("orchestration events over /ws/fleet (card 670b2081)", () => {
  test.setTimeout(90_000);

  test("a seeded event reaches the screen live, and nothing polls the events endpoint while connected", async ({ page, loomDaemon }) => {
    let eventRequests = 0;
    let fleetOpened = false;
    await page.route(EVENTS_ENDPOINT, async (route) => { eventRequests++; await route.fallback(); });
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => { fleetOpened = true; ws.connectToServer(); });

    const first = await seedSession(loomDaemon, `EvpFirst${Date.now()}`);
    const second = await seedSession(loomDaemon, `EvpSecond${Date.now()}`);
    await seedGap(loomDaemon, first.sessionId);

    await page.goto(`${loomDaemon.baseURL}/`);
    // Cold load: the pre-seeded event is read over REST (the seed), and the socket is up.
    await expect(gapRowFor(page, first.sessionId)).toBeVisible();
    await expect.poll(() => fleetOpened).toBe(true);
    await page.waitForLoadState("networkidle"); // the on-open resync's reads have settled
    expect(eventRequests, "instrument control: the counter must have counted the cold-load reads").toBeGreaterThan(0);
    const before = eventRequests;

    await seedGap(loomDaemon, second.sessionId); // seeded AFTER load: only a pushed frame can bring it in
    await expect(gapRowFor(page, second.sessionId)).toBeVisible();
    // The dwell is anchored to an observable: the live row has already appeared, so this window measures
    // whether anything still polls, not whether the push worked.
    await page.waitForTimeout(DWELL_MS); // eslint-disable-line playwright/no-wait-for-timeout
    expect(eventRequests - before, "no event-list request may be issued while the socket is connected").toBe(0);
  });

  test("events seeded while the socket is down arrive on reconnect via the resync, and live push resumes", async ({ page, loomDaemon }) => {
    let blocked = false;
    let attempts = 0;
    let live: { close: (o?: { code?: number }) => void } | null = null;
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => {
      if (blocked) { attempts++; ws.close({ code: 1011 }); return; }
      ws.connectToServer();
      live = ws;
    });
    // While blocked, REST event reads are aborted too: the fallback poll (10s) cannot be what delivers.
    await page.route(EVENTS_ENDPOINT, async (route) => { if (blocked) await route.abort(); else await route.fallback(); });

    const down = await seedSession(loomDaemon, `EvpDown${Date.now()}`);
    const resumed = await seedSession(loomDaemon, `EvpResumed${Date.now()}`);
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect.poll(() => live !== null).toBe(true);
    await page.waitForLoadState("networkidle");

    blocked = true;
    live!.close({ code: 1011 });
    await expect.poll(() => attempts, { timeout: 15_000 }).toBeGreaterThan(0); // observable: the page is retrying and being refused

    await seedGap(loomDaemon, down.sessionId); // missed by the push: no socket exists
    await expect(gapRowFor(page, down.sessionId), "control: nothing delivers it while the socket is down").toHaveCount(0);

    blocked = false;
    await expect(gapRowFor(page, down.sessionId)).toBeVisible({ timeout: 20_000 }); // the reconnect's resync read
    await expect(gapRowFor(page, down.sessionId)).toHaveCount(1);

    await seedGap(loomDaemon, resumed.sessionId); // and the push path works again after the reconnect
    await expect(gapRowFor(page, resumed.sessionId)).toBeVisible();
    await expect(gapRowFor(page, resumed.sessionId)).toHaveCount(1);
  });
});
