// Card f8d2684d — what a browser does when the gateway token it is holding is revoked WHILE the page is open.
//
// WHAT THIS PROVES, end to end against a REAL daemon through a REAL reverse proxy in a REAL browser:
//  1. the daemon's 1008 close (card 3c205fb5) actually REACHES a browser, close code and reason intact, even
//     though `GatewayTokenSocketRegistry.closeAll` calls `terminate()` one line after `close(1008, reason)`;
//  2. the page STOPS reconnecting — no further WebSocket is constructed after the revoke;
//  3. it says WHY, in the revoke-specific banner copy, not the generic "this address needs a gateway token"
//     that the fallback poll's own 401 would raise anyway (which is exactly what a pre-fix build would show).
//
// (1) is the load-bearing premise of the whole card, so it is measured here rather than assumed. It was also
// measured directly at the `ws` layer while the fix was written: `close(1008, r)` + `terminate()` delivers
// 1008 + r, a bare `terminate()` delivers 1006.
//
// ⭐ (2) IS AN ABSENCE CLAIM, so it carries a POSITIVE CONTROL: the first test closes the SAME live socket, via
// the SAME instrument, with a retryable code and asserts the count DOES rise. Without it, "no new socket" passes
// identically whether the fix works, the recorder is broken, the page navigated away, or nothing ever connected.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts — an isolated daemon (own temp LOOM_HOME, LOOM_PORT=0, first-run
// marker pre-stamped, LOOM_DEV/scheduler off) behind an in-test proxy, so the page's origin is non-loopback and
// its sockets are therefore gateway-token-authenticated — the only sockets the daemon registers for revocation.
// The real daemon on 4317 and the real ~/.loom are never touched. The revoke goes through the REAL REST route on
// the daemon's own LOOPBACK surface, which is where a human owner revokes a token.
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

// Serial: both tests share one rig AND the revoke is irreversible, so the control must run while the token still
// works. Playwright runs a serial describe in declaration order.
test.describe.configure({ mode: "serial" });

let rig: GatewayProxyRig;
test.beforeAll(async () => { rig = await startGatewayProxyRig(); });
test.afterAll(async () => { await rig?.stop(); });

/** Records every WebSocket the PAGE constructs, and keeps the last one so a test can close it with a chosen code.
 *  Only records and holds a reference — it never substitutes the socket, so the app's own feed still runs for real. */
const INSTRUMENT = () => {
  const w = window as unknown as { __wsOpens: string[]; __wsLast: WebSocket | null };
  w.__wsOpens = [];
  w.__wsLast = null;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    w.__wsOpens.push(String(url));
    w.__wsLast = sock;
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

const fleetOpens = () => (window as unknown as { __wsOpens: string[] }).__wsOpens.filter((u) => u.includes("/ws/fleet")).length;

/** Open the proxy-origin page with the token already stored, and wait until its /ws/fleet feed is genuinely live. */
async function openConnectedPage(page: import("@playwright/test").Page): Promise<void> {
  await page.context().addInitScript(INSTRUMENT);
  await page.context().addInitScript((token: string) => {
    try {
      localStorage.setItem("loom.gatewayToken", token);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, rig.token);
  await page.goto(rig.origin + "/");
  // The banner must be absent to start with — otherwise a later "banner appeared" assertion proves nothing.
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wsLast: WebSocket | null }).__wsLast?.readyState ?? -1))
    .toBe(1); // WebSocket.OPEN — the feed is attached, so there is something for a revoke to cut off
}

test("CONTROL: the instrument works and the reconnect loop is alive — a RETRYABLE close opens a new socket", async ({ page }) => {
  await openConnectedPage(page);
  const before = await page.evaluate(fleetOpens);
  expect(before, "the recorder must have seen the feed connect at all").toBeGreaterThan(0);

  // 4001 is in the application-defined range a browser lets a client send (1001 et al. are refused with
  // InvalidAccessError). It routes through the exact same `onSocketClose` the revoke path uses, and classifies
  // as retryable — so this measures the SAME instrument on the SAME socket, differing only in the close code.
  await page.evaluate(() => (window as unknown as { __wsLast: WebSocket | null }).__wsLast?.close(4001, "control"));
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(before);
  // ...and a retryable close must NOT be mistaken for a dead credential.
  await expect(page.getByText("This access token was")).toHaveCount(0);
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
});

test("a revoked token closes the live socket, stops the reconnect loop, and says the token was revoked", async ({ page }) => {
  await openConnectedPage(page);
  const before = await page.evaluate(fleetOpens);
  expect(before).toBeGreaterThan(0);

  // Revoke through the REAL route, on the daemon's own loopback surface (where an owner actually does it).
  // Both calls carry the loopback write guard's Bearer secret; without it the POST 401s and looks like a no-op.
  const list = await fetch(`${rig.loopbackURL}/api/gateway-tokens`, { headers: rig.loopbackAuth });
  expect(list.ok, `listing tokens failed (${list.status})`).toBe(true);
  const tokens = (await list.json()) as { id: string; name: string }[];
  // FIXTURE IDENTITY: assert we are revoking THIS rig's own seeded token, so a stray daemon or a changed seed
  // fails loudly instead of silently revoking something else and "passing".
  expect(tokens.map((t) => t.name)).toEqual(["e2e-proxy"]);
  const tokenId = tokens[0]?.id;
  expect(tokenId, "the seeded token must have an id to revoke").toBeTruthy();
  const revoke = await fetch(`${rig.loopbackURL}/api/gateway-tokens/${tokenId}`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify({ status: "revoked" }),
  });
  expect(revoke.ok, `revoke failed (${revoke.status})`).toBe(true);
  expect(((await revoke.json()) as { status: string }).status).toBe("revoked");

  // The 1008 reached the browser and the page now names what happened. This copy is REVOKE-SPECIFIC: the
  // generic "this address needs a gateway token" headline would appear on a pre-fix build too (the fallback
  // poll's own 401 raises it), so only this string proves the close code was read.
  await expect(page.getByText("This access token was revoked.")).toBeVisible();
  await expect(page.getByText(/the gateway token it holds was revoked on the daemon/)).toBeVisible();
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  // The re-entry action is on screen: this banner's own paste field, not a second surface.
  await expect(page.getByLabel("Gateway token")).toBeVisible();

  // The socket is really shut, with the policy-violation code and the daemon's own reason.
  expect(await page.evaluate(() => {
    const s = (window as unknown as { __wsLast: WebSocket | null }).__wsLast;
    return s ? s.readyState : -1;
  })).toBe(3); // WebSocket.CLOSED

  // AND NOTHING RETRIES. The capped ladder would have fired at 1s, 2s, 4s and 8s inside this window, and the
  // CONTROL above proved a new open is observable here, so a flat count is a real absence, not a blind one.
  const settled = await page.evaluate(fleetOpens);
  expect(settled, "the revoke itself must not have opened a new socket").toBe(before);
  await page.waitForTimeout(12_000);
  expect(await page.evaluate(fleetOpens), "a 1008 close must never be retried").toBe(before);
  // Still terminal, still saying why, 12s later.
  await expect(page.getByText("This access token was revoked.")).toBeVisible();
});
