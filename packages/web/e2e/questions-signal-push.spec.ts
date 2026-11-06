// Card 55de3b68: the Request inbox (`GET /api/questions`, query key ["openQuestions"]) moved from seven
// `refetchInterval` polls (3-5s; ~20 req/min idle) onto a contentless `{t:"questions"}` change signal on the
// app-wide `/ws/fleet` socket (Db.questionsChangeListener -> FleetHub -> FleetSocketProvider invalidates the
// inbox queries; REST stays the source of truth).
//
// Each test seeds through the daemon's own insertQuestion writer (loomDaemon.seedQuestion, the same writer
// question_ask uses), so a new Request can only reach the page via the real signal path.
//
// TEST 1 is a CONJUNCTION (as orchestration-events-push.spec.ts): a Request seeded AFTER load APPEARS, AND zero
// /api/questions requests are issued across a dwell sized off the removed polls. Either half alone is
// worthless — a dead feed can still show a row (a poll found it), and a zero count can mean "my counter is
// broken". The instrument control: the counter must have counted the cold-load read before any zero is believed.
//
// TEST 2 isolates the RESYNC. While the socket is held down by routeWebSocket, the REST inbox reads are ABORTED
// too, so the disconnected-only fallback poll cannot deliver anything: the only way a Request seeded during the
// outage reaches the screen is the on-reconnect re-read. A Request seeded after the reconnect then proves the
// live signal works again.
//
// TEST 4 is the JOINED-field case (the inbox row JOINs the asking session's liveness, which changes without any
// write to the questions table): a live manager's answered-but-unpulled Request shows an enabled "Nudge mgr";
// stopping that session must disable it with no reload and no poll — the daemon signals the process_state transition.
//
// TEST 3 is the disconnected fallback: with the socket refused for good, the inbox still refreshes (the C6
// fallback timer, 10s) — the removed polls must not have left a screen stale when the push is unavailable.
import type { Page } from "@playwright/test";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

const QUESTIONS_ENDPOINT = /\/api\/questions(\?|$)/;
// The removed polls ran at 3s, 4s and 5s. A 9s dwell catches two ticks of the 3s/4s family; it would not catch
// a restored 15s poll (the honest limit of this check).
const DWELL_MS = 9_000;
const mintTitle = (p: string) => `${p} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const titleOnScreen = (page: Page, title: string) => page.locator("main").getByText(title).first();

async function seed(loomDaemon: LoomDaemon, title: string) {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `QsMgr${Date.now()}${Math.random().toString(36).slice(2, 6)}` });
  await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title, body: "signal body", options: ["a", "b"] });
}

test.describe("Request inbox over /ws/fleet (card 55de3b68)", () => {
  test.setTimeout(90_000);

  test("a new Request reaches the screen live, and nothing polls /api/questions while connected", async ({ page, loomDaemon }) => {
    let questionRequests = 0;
    let fleetOpened = false;
    await page.route(QUESTIONS_ENDPOINT, async (route) => { questionRequests++; await route.fallback(); });
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => { fleetOpened = true; ws.connectToServer(); });

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect.poll(() => fleetOpened).toBe(true);
    await page.waitForLoadState("networkidle"); // the on-open resync's reads have settled
    expect(questionRequests, "instrument control: the counter must have counted the cold-load reads").toBeGreaterThan(0);
    const before = questionRequests;

    const title = mintTitle("Live request");
    await seed(loomDaemon, title); // seeded AFTER load: only a pushed signal can bring it in
    await expect(titleOnScreen(page, title)).toBeVisible();
    // Settle: waitForLoadState("networkidle") is a no-op once the page has loaded, so quiescence is observed
    // directly — the counter must hold still across a 1.5s window (the follow-up re-read the page issues after
    // the signal lands within ~200ms of it).
    await expect.poll(async () => { const seen = questionRequests; await page.waitForTimeout(1_500); return questionRequests === seen; }, { timeout: 15_000 }).toBe(true); // eslint-disable-line playwright/no-wait-for-timeout
    const afterPush = questionRequests;
    expect(afterPush - before, "the signal costs a bounded number of re-reads, not a poll").toBeLessThanOrEqual(3);
    // The dwell is anchored to an observable: the live row has already appeared, so this window measures
    // whether anything still polls, not whether the push worked.
    await page.waitForTimeout(DWELL_MS); // eslint-disable-line playwright/no-wait-for-timeout
    expect(questionRequests - afterPush, "no /api/questions request may be issued while the socket is connected and idle").toBe(0);
  });

  test("a Request seeded while the socket is down arrives on reconnect via the resync, and live push resumes", async ({ page, loomDaemon }) => {
    let blocked = false;
    let attempts = 0;
    let live: { close: (o?: { code?: number }) => void } | null = null;
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => {
      if (blocked) { attempts++; ws.close({ code: 1011 }); return; }
      ws.connectToServer();
      live = ws;
    });
    // While blocked, REST inbox reads are aborted too: the fallback poll (10s) cannot be what delivers.
    await page.route(QUESTIONS_ENDPOINT, async (route) => { if (blocked) await route.abort(); else await route.fallback(); });

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect.poll(() => live !== null).toBe(true);
    await page.waitForLoadState("networkidle");

    blocked = true;
    live!.close({ code: 1011 });
    await expect.poll(() => attempts, { timeout: 15_000 }).toBeGreaterThan(0); // observable: the page is retrying and being refused

    const missed = mintTitle("Missed request");
    await seed(loomDaemon, missed); // missed by the push: no socket exists
    await expect(titleOnScreen(page, missed)).toHaveCount(0);

    blocked = false;
    await expect(titleOnScreen(page, missed)).toBeVisible({ timeout: 20_000 }); // the reconnect's resync read

    const resumed = mintTitle("Resumed request");
    await seed(loomDaemon, resumed); // and the push path works again after the reconnect
    await expect(titleOnScreen(page, resumed)).toBeVisible();
  });

  test("an asking session exiting flips the row's liveness live: 'Nudge mgr' disables with no reload and no poll", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `QsLive${Date.now()}`, ptyBytes: "ready" });
    const title = mintTitle("Stuck answered");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision", options: ["a", "b"], body: "b",
      state: "answered", chosenOption: "a", answeredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    let questionRequests = 0;
    await page.route(QUESTIONS_ENDPOINT, async (route) => { questionRequests++; await route.fallback(); });
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const nudge = page.getByTestId("request-row").filter({ hasText: title }).getByRole("button", { name: "Nudge mgr" });
    await expect(nudge, "control: a LIVE asking session leaves the button enabled").toBeEnabled();
    await expect.poll(() => questionRequests).toBeGreaterThan(0);

    await loomDaemon.exitSeededSession(mgr.sessionId); // the real Db.setProcessState transition a pty exit makes
    await expect(nudge).toBeDisabled({ timeout: 10_000 }); // only the process_state signal can flip it: no reload, no interval
  });

  test("with the socket unavailable the inbox still refreshes via the disconnected fallback timer", async ({ page, loomDaemon }) => {
    let refused = 0;
    await page.routeWebSocket(/\/ws\/fleet/, (ws) => { refused++; ws.close({ code: 1011 }); });
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect.poll(() => refused, { timeout: 15_000 }).toBeGreaterThan(0); // observable: the push channel is really down

    const title = mintTitle("Fallback request");
    await seed(loomDaemon, title);
    await expect(titleOnScreen(page, title)).toBeVisible({ timeout: 30_000 }); // FALLBACK_POLL_MS is 10s
  });
});
