// Card 97dd97e5 — a REMOTE page holding NO gateway token at all, and FleetSocketProvider's own bound.
//
// THE DEFECT. `FleetSocketProvider`'s retry branch asked `refusalEpisode.check(stopForRefusal)`
// unconditionally — never consulting `noteRemoteSocketRefusal` the way CompanionChat/Terminal do (card
// d56b12d8). With NO gateway token held at all, `probeHeldGatewayToken` settles the episode's own probe
// as `"none"` (nothing to probe), so the episode learns nothing and re-arms the ladder — the handshake
// can only ever 401, so a token-less remote page re-handshakes `/ws/fleet` forever at the 10s cap,
// spending the trusted proxy's ONE shared `PROXY_FAILED_AUTH_PER_MIN` bucket and 429ing unrelated remote
// callers. `test/socket-close-wiring.mjs` check (12) used to name FleetSocketProvider as a KNOWN,
// deliberate gap for exactly this reason; this spec (and the source fix) close it.
//
// WHAT THIS PROVES, end to end against a REAL daemon through a REAL reverse proxy in a REAL browser:
//  1. a token-less page's `/ws/fleet` construction count stays FLAT over an observation window long
//     enough for the pre-fix 1s/2s/4s/8s ladder to have fired several times;
//  2. that flatness is attributable to the fix, not to nothing ever having tried — a positive control on
//     the SAME instrument, in the SAME rig, shows the counter DOES rise when a real close is forced on a
//     page that holds a valid token;
//  3. recovery still works: pasting a token into the gateway banner re-attaches the feed IN PLACE.
//
// (1) is an ABSENCE claim, so it needs (2) as its positive control: a flat count passes identically
// whether the fix works, the recorder is broken, or the fallback poll alone happens to look quiet.
// Without (2), "the count stayed flat" proves nothing about THIS fix in particular.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts — an isolated daemon (own temp LOOM_HOME, LOOM_PORT=0,
// first-run marker pre-stamped, LOOM_DEV/scheduler off, so no Setup Assistant and no real `claude`),
// behind an in-test proxy, so the page's origin is non-loopback and its sockets are gateway-token
// authenticated. The real daemon on 4317 and the real ~/.loom are never touched.
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

// Serial: the recovery test mints a fresh token and must run after the token-less measurement, and the
// long 401-spraying measurement should not race the control's own forced close on the same daemon.
test.describe.configure({ mode: "serial" });

let rig: GatewayProxyRig;
test.beforeAll(async () => { rig = await startGatewayProxyRig(); });
test.afterAll(async () => { await rig?.stop(); });

/** Records every WebSocket the PAGE constructs and keeps the last one, so a test can close it with a
 *  chosen code. It only records — it never substitutes the socket, so the app's own feed runs for real. */
const INSTRUMENT = () => {
  const w = window as unknown as { __wsOpens: string[]; __wsLast: WebSocket | null; __wsCloses: number[] };
  w.__wsOpens = [];
  w.__wsCloses = [];
  w.__wsLast = null;
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    w.__wsOpens.push(String(url));
    w.__wsLast = sock;
    sock.addEventListener("close", (e) => { w.__wsCloses.push((e as CloseEvent).code); });
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

const fleetOpens = () => (window as unknown as { __wsOpens: string[] }).__wsOpens.filter((u) => u.includes("/ws/fleet")).length;
const fleetCloseCodes = () => (window as unknown as { __wsCloses: number[] }).__wsCloses;
const lastReadyState = () => (window as unknown as { __wsLast: WebSocket | null }).__wsLast?.readyState ?? -1;

/** The substring of FleetSocketProvider's `stopForNoToken` log line — reached from exactly ONE outcome
 *  (`noteRemoteSocketRefusal` returning true), so it ATTRIBUTES a flat count to this fix rather than to
 *  "nothing ever tried", which looks identical in a bare count of sockets. */
const NO_TOKEN_LOG = "no gateway token held by this browser — not reconnecting";

/** Open the proxy-origin page, optionally seeding a gateway token first. */
async function openPage(page: import("@playwright/test").Page, token: string | null): Promise<{ noTokenLogs: () => number }> {
  let noTokenLogs = 0;
  page.on("console", (m) => { if (m.text().includes(NO_TOKEN_LOG)) noTokenLogs += 1; });
  await page.context().addInitScript(INSTRUMENT);
  await page.context().addInitScript((t: string | null) => {
    try {
      if (t !== null) localStorage.setItem("loom.gatewayToken", t);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, token);
  await page.goto(rig.origin + "/");
  return { noTokenLogs: () => noTokenLogs };
}

test("CONTROL: a VALID token's ladder keeps running after a forced close — the instrument can rise", async ({ page }) => {
  // The positive control for the absence claim in the next test: on THIS SAME instrument, in THIS SAME
  // rig, a count that is merely quiet (nothing recording, nothing ever connecting) is ruled out.
  const { noTokenLogs } = await openPage(page, rig.token);
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  await expect.poll(() => page.evaluate(lastReadyState)).toBe(1); // OPEN — a live feed for the close below to cut
  const before = await page.evaluate(fleetOpens);
  expect(before, "the recorder must have seen the feed connect at all").toBeGreaterThan(0);

  // 4001 is in the application-defined range a browser lets a client send (1001 et al. are refused with
  // InvalidAccessError). It routes through the same handleSocketClose the token-less path uses, differing
  // only in whether a credential is held at all.
  await page.evaluate(() => (window as unknown as { __wsLast: WebSocket | null }).__wsLast?.close(4001, "control"));
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  // A token IS held, so the token-less arm must never fire here — it would be the wrong attribution.
  expect(noTokenLogs(), "a page holding a real token must never trip the token-less stop").toBe(0);
});

test("no gateway token held at all ⇒ the /ws/fleet ladder is terminal, not a loop", async ({ page }) => {
  test.setTimeout(90_000); // the 14s observation window plus the preconditions' own polls
  const { noTokenLogs } = await openPage(page, null);

  // Wait for the first failed handshake to have been recorded, so the window below measures the LADDER
  // rather than racing the very first attempt. True under pre-fix and post-fix code alike (both construct
  // a socket and both see it close), so it never couples the control to the fix.
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(fleetCloseCodes).then((c) => c.length), { timeout: 20_000 }).toBeGreaterThan(0);
  // The browser sees 1006, NOT the daemon's 1008 — a credential-less upgrade is rejected before there is
  // ever a socket for the daemon to close with a reason.
  expect(await page.evaluate(fleetCloseCodes)).toContain(1006);
  const settled = await page.evaluate(fleetOpens);

  // THE DEFECT ASSERTION, and the one that discriminates: NOTHING RETRIES. The pre-fix ladder would have
  // fired at 1s, 2s, 4s and 8s inside this window, and the CONTROL above proved a rise is observable on
  // this exact instrument and in this exact rig, so a flat count here is a real absence.
  await page.waitForTimeout(14_000);
  expect(await page.evaluate(fleetOpens),
    "a credential-less upgrade must not keep re-handshaking — it spends the daemon's shared failed-auth budget").toBe(settled);

  // ...AND THE FIX IS WHY. A page can also go quiet because nothing ever tried, which looks identical in a
  // count of sockets; this log line is reached from exactly one outcome, so it names the cause.
  expect(noTokenLogs(), "the stop must come from the token-less arm, not from nothing trying").toBeGreaterThan(0);
  // The re-entry surface is still on screen, which is what makes stopping safe at all.
  await expect(page.getByLabel("Gateway token")).toBeVisible();
});

test("re-entering a token RE-ATTACHES the fleet feed in place, with no page reload", async ({ page }) => {
  const minted = await rig.loopbackPost<{ plaintext: string }>("/api/gateway-tokens", { name: "e2e-fleet-no-token" });
  expect(minted.plaintext, "a minted token must come back with its plaintext ONCE").toBeTruthy();

  const { noTokenLogs } = await openPage(page, null);
  await expect(page.getByLabel("Gateway token")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => noTokenLogs(), { timeout: 20_000 }).toBeGreaterThan(0);
  const frozen = await page.evaluate(fleetOpens);
  expect(frozen, "the token-less page must have attempted its feed at least once").toBeGreaterThan(0);

  // A page-lifetime sentinel, set AFTER load and NOT by an init script: a reload gives the page a fresh
  // window, so this is gone if one happened. Without it "a new socket opened" is satisfied by a reload
  // just as well as by the in-place re-attach this card is about.
  await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = Date.now(); });

  await page.getByLabel("Gateway token").fill(minted.plaintext);
  await page.getByRole("button", { name: "Use token" }).click();

  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(frozen);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload ?? null),
    "the re-attach must not have come from a page reload").not.toBeNull();
  await expect(page.getByLabel("Gateway token")).toHaveCount(0);
});
