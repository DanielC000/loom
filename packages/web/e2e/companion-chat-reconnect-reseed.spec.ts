// Card 37b1ed5f — the companion chat panel re-seeds its history on an ORDINARY reconnect (an ordinary
// disconnect/reconnect, not a terminal 1008 close), not only at mount/credential-reattach.
//
// THE DEFECT: a reply (or any other turn) persisted to `companion_messages` WHILE this socket was down —
// e.g. landed via another channel, or via the daemon's own writer — never reached an already-open chat
// panel: `connect()`'s own reconnect path reopened the socket but never re-fetched
// GET /api/companion/messages/:sessionId, so the new row stayed invisible until a manual page reload.
//
// ⚠️ WHAT THE INSTRUMENT IS. The close is delivered by dispatching a real, NON-1008 `CloseEvent` (code
// 1006 — an ordinary drop) on the live socket, which invokes the app's own assigned `onclose` — so the
// real reconnect ladder (lib/socketReconnect's `retry` branch), the real `connect()`, and the real
// `ws.onopen` re-seed all run for real. The new row is inserted directly into the DB (the test-only seed
// endpoint — mirrors how `companion-chat-close-kind.spec.ts` forces a close) WHILE the socket is down, so
// it is never pushed as a live `{type:"chat"}` frame to this panel; the ONLY way it can appear without a
// reload is the reconnect re-seed this card adds.
//
// ⭐ CONTROL: the seeded text is asserted ABSENT right up to the forced close (proving it is not already
// on the page by some other path) and the pill is asserted to leave "connected" before the seed lands
// (proving the message really was written while this pane was offline, not before).
//
// ROUND 2 (code review): the re-seed's first pass REPLACED the transcript with the fetched history
// outright. Between `onopen` firing and that fetch resolving, the reopened socket's own `onmessage` can
// already deliver a live frame — the replace then wiped it from view until the next reload, the very
// failure this card exists to close, just narrowed into the re-seed's own fetch window. The second test
// below holds the re-fetch open with a controlled route delay and delivers a live frame WHILE it is in
// flight, proving the fix (`mergeReconnectHistory`, @decision 37b1ed5f) keeps it.
//
// @decision 02f0e8a6 — this spec's seeded `companion_config` row outlives its session; left behind it
// accumulates in the picker and a sibling spec's "/companion" page can land its "focus the most active
// companion" tie-break on it instead of the one that spec just seeded (companion.spec.ts's own test did
// exactly this). Do not drop the afterEach cleanup.
import { expect, test } from "./fixtures/daemon";

const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true);
  }
});

/** Records the last `/ws/companion` socket the page constructs — mirrors companion-chat-close-kind.spec.ts's
 *  own instrument. Records only — never substitutes the socket, so the chat still connects for real. */
const INSTRUMENT = () => {
  const w = window as unknown as { __companionWs: WebSocket | null };
  w.__companionWs = null;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/ws/companion")) w.__companionWs = sock;
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

/** Fire an ORDINARY (non-1008) close at the live companion socket's own handler — the daemon restarting,
 *  a laptop sleep, a flaky link. `classifySocketClose` reads this as `{retry:true}`, so the app's real
 *  reconnect ladder (not a terminal state) takes over. */
async function closeOrdinary(page: import("@playwright/test").Page) {
  const delivered = await page.evaluate(() => {
    const sock = (window as unknown as { __companionWs: WebSocket | null }).__companionWs;
    if (!sock) return false;
    sock.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
    return true;
  });
  expect(delivered, "the instrument must have captured the live companion socket").toBe(true);
}

test("an ordinary reconnect re-seeds history — a reply persisted while the socket was down now shows without a reload", async ({ page, loomDaemon }) => {
  // A UNIQUE name: the e2e worker daemon is SHARED and companion-config rows outlive session archival, so
  // sibling specs' default-named ("Ada") companions accumulate in the picker and the page's "focus the
  // most active companion" tie-break can land on one of theirs (mirrors companion-credential-reattach.spec.ts).
  const name = `Reconnect-${Math.random().toString(36).slice(2, 10)}`;
  const { sessionId } = await loomDaemon.seedCompanion({ name });
  seededConfigSessionIds.push(sessionId);
  const offlineReply = `seeded-while-offline-${Math.random().toString(36).slice(2)}`;

  await page.addInitScript(INSTRUMENT);
  await page.goto(`${loomDaemon.baseURL}/companion`);
  const chat = page.locator("#companion-panel-chat");
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();

  // Not present yet — the row doesn't exist in the DB, and nothing has pushed it live.
  await expect(chat.getByText(offlineReply)).toHaveCount(0);

  await closeOrdinary(page);
  // BEFORE → the pill must actually leave "connected" — otherwise the close never reached the app and the
  // rest of this test would just be re-proving the initial render.
  await expect(chat.getByText("connected", { exact: true })).toHaveCount(0);

  // Written directly to the DB while this pane is offline — never a live push to this socket.
  await loomDaemon.seedCompanionConversations(sessionId, [[{ author: "companion", text: offlineReply }]]);

  // The real reconnect ladder (min backoff 1s) brings the socket back up for real.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();

  // AFTER: the reconnect's own re-seed surfaces the row with no reload and no further interaction.
  await expect(chat.getByText(offlineReply)).toBeVisible();
});

test("a message delivered over the socket WHILE the reconnect's re-fetch is in flight survives the merge", async ({ page, loomDaemon }) => {
  const name = `ReconnectRace-${Math.random().toString(36).slice(2, 10)}`;
  const { sessionId } = await loomDaemon.seedCompanion({ name });
  seededConfigSessionIds.push(sessionId);

  await page.addInitScript(INSTRUMENT);
  await page.goto(`${loomDaemon.baseURL}/companion`);
  const chat = page.locator("#companion-panel-chat");
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();

  // Installed only NOW — after the mount's own history fetch already resolved — so this holds open
  // exactly the ONE request the reconnect's own re-seed makes, never the initial load's.
  let release: (() => void) | undefined;
  await page.route(`**/api/companion/messages/${sessionId}`, async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });

  await closeOrdinary(page);
  await expect(chat.getByText("connected", { exact: true })).toHaveCount(0);

  // The real reconnect ladder reopens a NEW socket; its `onopen` fires and kicks off the (now held)
  // re-fetch. Wait for that GET to actually be in flight — `release` is only assigned once the route
  // handler itself runs — before injecting the live frame, so this genuinely lands in the race window.
  await expect.poll(() => release !== undefined, { timeout: 10000 }).toBe(true);

  // Deliver a live frame directly at the socket's own handler (`onmessage`) — the exact mechanism the
  // review finding names — rather than a real companion round trip.
  const liveText = `live-during-fetch-${Math.random().toString(36).slice(2)}`;
  const delivered = await page.evaluate(
    ({ sid, text }) => {
      const sock = (window as unknown as { __companionWs: WebSocket | null }).__companionWs;
      if (!sock) return false;
      sock.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat", chatId: sid, text }) }));
      return true;
    },
    { sid: sessionId, text: liveText },
  );
  expect(delivered, "the instrument must have captured the reconnected companion socket").toBe(true);

  // It renders immediately — `onmessage` appends synchronously, independent of the still-held fetch.
  await expect(chat.getByText(liveText)).toBeVisible();

  // Now let the held history fetch resolve — the exact moment a bare replace would have wiped it.
  release?.();
  await expect(chat.getByText("connected", { exact: true })).toBeVisible();

  // AFTER: the live-delivered message survives the merge, exactly once (never duplicated either).
  await expect(chat.getByText(liveText)).toHaveCount(1);
});
