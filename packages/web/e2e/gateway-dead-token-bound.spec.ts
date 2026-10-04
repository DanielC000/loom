// Card a6d7bf36 — a REMOTE page holding a DEAD gateway token, and the two halves of the fix.
//
// THE DEFECT. After a reload on a proxied origin with a dead token still in localStorage, the WS upgrade
// 401s, so no socket ever OPENS and the browser reports a bare 1006 with no reason — there was no socket
// for the daemon to close with its 1008 contract (card f8d2684d). classifySocketClose therefore says
// retry, correctly, and noteRemoteSocketRefusal returns false because a token IS held. So the page
// retried a handshake that can only ever 401, forever, at the 10s cap — and a rejected WS upgrade spends
// the trusted proxy's ONE shared PROXY_FAILED_AUTH_PER_MIN bucket, 429ing unrelated remote callers.
//
// WHAT THIS PROVES, end to end against a REAL daemon through a REAL reverse proxy in a REAL browser:
//  1. the ladder STOPS, and the held-token probe is what stopped it (the probe's own unique log line is
//     read, so the stop is attributed rather than merely observed);
//  2. a VALID token's page is NOT stopped — the probe's `valid` leaves the ladder running, which is the
//     polarity that must never regress: locking a healthy page whenever the daemon merely restarts would
//     be worse than the loop being removed;
//  3. re-entering a token RE-ATTACHES the feed IN PLACE, with no page reload — the half that makes (1)
//     safe at all. Before this card nothing in the app subscribed to the gateway lock except the banner
//     that raises it, so a stopped socket could only be revived by reloading.
//
// (1) IS AN ABSENCE CLAIM, so it carries a POSITIVE CONTROL: test (2) rises the SAME counter on the SAME
// instrument from a close that differs only in whether the token is still good. Without it "the count
// stayed flat" passes identically whether the fix works, the recorder is broken, or nothing ever
// connected. (3) is asserted as a before/after on that counter PLUS a page-lifetime sentinel, because a
// reload would satisfy "a new socket opened" just as well while proving the opposite of what is claimed.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts — an isolated daemon (own temp LOOM_HOME, LOOM_PORT=0,
// first-run marker pre-stamped, LOOM_DEV/scheduler off, so no Setup Assistant and no real `claude`),
// behind an in-test proxy, so the page's origin is non-loopback and its sockets are gateway-token
// authenticated. The real daemon on 4317 and the real ~/.loom are never touched. Revokes and mints go
// through the REAL REST routes on the daemon's own LOOPBACK surface, where a human owner does them.
//
// SCOPE, stated rather than implied: the socket exercised here is the app-wide /ws/fleet feed, which
// mounts on every page. The app has THREE socket clients and all carry the IDENTICAL wiring (the same
// shared episode and the same re-attach nonce). This rig seeds no session, so TerminalPane's half is
// covered by test/socket-close-wiring.mjs checks (8)-(10), which now run over every socketAuth( caller
// the scan discovers rather than a hand-written list. CompanionChat's re-attach additionally gets its own
// browser round trip on the loopback rig, in companion-credential-reattach.spec.ts.
import { expect, test } from "@playwright/test";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });

// Serial, and in THIS order on purpose. A revoke is irreversible, so the live-token control must run
// first; and the long 401-spraying measurement runs LAST so its own failed-auth spend cannot land on the
// paste in the middle test. (A valid token is never subject to that throttle — verify-first,
// remote-rate-limit.ts — so the paste is safe regardless, but there is no reason to lean on it.)
test.describe.configure({ mode: "serial" });

let rig: GatewayProxyRig;
test.beforeAll(async () => { rig = await startGatewayProxyRig(); });
test.afterAll(async () => { await rig?.stop(); });

/** Records every WebSocket the PAGE constructs and keeps the last one, so a test can close it with a
 *  chosen code. It only records — it never substitutes the socket, so the app's own feed runs for real,
 *  and the close listener uses addEventListener so it never clobbers the app's own onclose. */
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

/** The substring of FleetSocketProvider's `stopForRefusal` log line. That line is emitted from ONE place
 *  and reached from ONE outcome — the held-token probe answering `invalid` — so it is what ATTRIBUTES a
 *  stopped ladder to the probe rather than to "nothing ever tried", which looks identical in a count of
 *  sockets. Reword the log line and this test must be updated with it; that is the intended coupling. */
const REFUSAL_LOG = "the gateway token this browser holds was refused";

/** Open the proxy-origin page with `token` already in storage.
 *
 *  `versionRequests` counts `/api/version` — the held-token probe's own request, but NOT only that: the
 *  Sidebar's `["version"]` query reads the same route, so this is a POPULATION, never the probe alone.
 *  Only a BASELINED delta around a controlled moment says anything about the probe; an absolute count
 *  does not. `refusalLogs` is the unambiguous half. */
async function openWithToken(page: import("@playwright/test").Page, token: string): Promise<{
  versionRequests: () => number;
  refusalLogs: () => number;
}> {
  let versionRequests = 0;
  let refusalLogs = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/version") versionRequests += 1; });
  page.on("console", (m) => { if (m.text().includes(REFUSAL_LOG)) refusalLogs += 1; });
  await page.context().addInitScript(INSTRUMENT);
  await page.context().addInitScript((t: string) => {
    try {
      localStorage.setItem("loom.gatewayToken", t);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, token);
  await page.goto(rig.origin + "/");
  return { versionRequests: () => versionRequests, refusalLogs: () => refusalLogs };
}

/** The rig's own seeded/minted tokens, by name — FIXTURE IDENTITY. A stray daemon, a changed seed or a
 *  leaked token from another spec fails loudly here instead of silently acting on something else. */
async function tokenIdByName(name: string): Promise<string> {
  const list = await fetch(`${rig.loopbackURL}/api/gateway-tokens`, { headers: rig.loopbackAuth });
  expect(list.ok, `listing tokens failed (${list.status})`).toBe(true);
  const tokens = (await list.json()) as { id: string; name: string }[];
  const match = tokens.filter((t) => t.name === name);
  expect(match.length, `expected exactly one token named ${name}, saw ${JSON.stringify(tokens.map((t) => t.name))}`).toBe(1);
  return match[0]!.id;
}

async function revoke(tokenId: string): Promise<void> {
  const res = await fetch(`${rig.loopbackURL}/api/gateway-tokens/${tokenId}`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify({ status: "revoked" }),
  });
  expect(res.ok, `revoke failed (${res.status})`).toBe(true);
  expect(((await res.json()) as { status: string }).status).toBe("revoked");
}

async function mint(name: string): Promise<string> {
  const res = await fetch(`${rig.loopbackURL}/api/gateway-tokens`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.ok, `mint failed (${res.status})`).toBe(true);
  const body = (await res.json()) as { plaintext: string };
  expect(body.plaintext, "a minted token must come back with its plaintext ONCE").toBeTruthy();
  return body.plaintext;
}

test("CONTROL: a VALID token's ladder keeps running — the probe's `valid` must never stop a healthy page", async ({ page }) => {
  // This is the positive control for the absence claim in the last test, and a real assertion of its own:
  // the whole hazard in bounding the ladder is stopping a page whose credential was fine and whose daemon
  // was merely restarting. The close here is retryable and the token is good, so the episode's probe
  // answers `valid` — and the count must still rise.
  const { versionRequests, refusalLogs } = await openWithToken(page, rig.token);
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  await expect.poll(() => page.evaluate(lastReadyState)).toBe(1); // OPEN — a live feed for the close below to cut
  const before = await page.evaluate(fleetOpens);
  expect(before, "the recorder must have seen the feed connect at all").toBeGreaterThan(0);
  // BASELINE taken at a controlled moment, AFTER the Sidebar's own `["version"]` read has settled, so the
  // delta below is attributable to the close. An absolute count here would be the Sidebar's read plus the
  // probe's, indistinguishable from two probes.
  const versionsBeforeClose = versionRequests();

  // 4001 is in the application-defined range a browser lets a client send (1001 et al. are refused with
  // InvalidAccessError). It routes through the same handleSocketClose the dead-token path uses, differing
  // only in whether the held token is still good.
  await page.evaluate(() => (window as unknown as { __wsLast: WebSocket | null }).__wsLast?.close(4001, "control"));
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(page.getByText("This address needs a gateway token.")).toHaveCount(0);
  await expect(page.getByText("This access token was")).toHaveCount(0);
  // A `valid` probe must never reach the stop. This is the polarity that would be expensive to get wrong:
  // the same close shape happens on every daemon restart, and stopping there would lock a healthy page.
  expect(refusalLogs(), "a VALID held token must never trip the refusal stop").toBe(0);
  // ...and the probe is armed per EPISODE, never per retry, because it rides the same shared failed-auth
  // budget it exists to protect. 0 is equally correct: the socket may reconnect before a probe resolves.
  expect(versionRequests() - versionsBeforeClose, "at most ONE held-token probe per refusal episode")
    .toBeLessThanOrEqual(1);
});

test("re-entering a token RE-ATTACHES the feed in place, with no page reload", async ({ page }) => {
  await revoke(await tokenIdByName("e2e-proxy"));
  const replacement = await mint("e2e-replacement"); // minted BEFORE the page opens, so the paste is prompt

  const { versionRequests } = await openWithToken(page, rig.token); // the now-DEAD token
  // The banner is the re-entry surface. Its generic headline is raised by the REST 401s too, so its mere
  // presence proves nothing about this card — it is the stage, not the assertion.
  await expect(page.getByLabel("Gateway token")).toBeVisible({ timeout: 20_000 });
  const frozen = await page.evaluate(fleetOpens);
  // A refused upgrade still CONSTRUCTS a socket, so the recorder must have seen at least one. Without
  // this, `toBeGreaterThan(frozen)` below would be satisfied by a first-ever connection on a page whose
  // feed had simply never started — which is not a re-attach.
  expect(frozen, "the dead-token page must have attempted its feed at least once").toBeGreaterThan(0);

  // A page-lifetime sentinel, set AFTER load and NOT by an init script: a reload gives the page a fresh
  // window, so this is gone if one happened. Without it "a new socket opened" is satisfied by the old
  // reload-to-reconnect behaviour just as well as by the re-attach this card is about.
  await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = Date.now(); });

  await page.getByLabel("Gateway token").fill(replacement);
  await page.getByRole("button", { name: "Use token" }).click();

  // THE DEFECT ASSERTION, first: the feed re-attached. Pre-fix the fleet socket had no path back at all
  // once its ladder stopped — the page sat on its 10s polling fallback until the user reloaded.
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(frozen);
  // ...IN PLACE. Both halves matter: the counter did not reset (an init script would have re-zeroed it)
  // and the sentinel survived.
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload ?? null),
    "the re-attach must not have come from a page reload").not.toBeNull();
  // And the lock is genuinely cleared, so the banner is gone rather than merely re-worded.
  await expect(page.getByLabel("Gateway token")).toHaveCount(0);
  expect(versionRequests(), "the paste's own verify had to reach the daemon for any of this to mean anything")
    .toBeGreaterThan(0);
});

test("a DEAD held token BOUNDS the ladder — and the held-token probe is what stopped it", async ({ page }) => {
  test.setTimeout(90_000); // the 14s observation window plus the preconditions' own polls
  await revoke(await tokenIdByName("e2e-replacement"));
  const { refusalLogs } = await openWithToken(page, rig.token);

  // Wait for the first failed handshake to have been recorded, so the window below measures the LADDER
  // rather than racing the very first attempt. This precondition is true under pre-fix and post-fix code
  // alike (both construct a socket and both see it close), so it never couples the control to the fix.
  await expect.poll(() => page.evaluate(fleetOpens), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(fleetCloseCodes).then((c) => c.length), { timeout: 20_000 }).toBeGreaterThan(0);
  // The browser sees 1006, NOT the daemon's 1008 — the upgrade was rejected, so there was never a socket
  // to close with a reason. That is the whole reason the close cannot be classified and a probe is needed.
  expect(await page.evaluate(fleetCloseCodes)).toContain(1006);
  const settled = await page.evaluate(fleetOpens);

  // THE DEFECT ASSERTION, and the one that discriminates: NOTHING RETRIES. The capped ladder would have
  // fired at 1s, 2s, 4s and 8s inside this window, and the CONTROL above proved a rise is observable on
  // this exact instrument and in this exact rig, so a flat count is a real absence rather than a blind
  // one. It is also the assertion that reddens when only the probe's VERDICT is defeated and every symbol
  // the fix adds is left in place — which is the control worth running, rather than a full revert.
  await page.waitForTimeout(14_000);
  expect(await page.evaluate(fleetOpens),
    "a refused held credential must not keep re-handshaking — it spends the daemon's shared failed-auth budget").toBe(settled);

  // ...AND THE PROBE IS WHY. A page can also go quiet because nothing ever tried, which is identical in a
  // count of sockets; this log line is reached from exactly one outcome, so it names the cause. It is NOT
  // the discriminating assertion (it is absent on pre-fix code for the trivial reason that the code is),
  // which is why it is read after the count and not instead of it.
  expect(refusalLogs(), "the stop must come from the held-token probe refusing, not from nothing trying")
    .toBeGreaterThan(0);
  // The re-entry surface is still on screen, which is what makes stopping safe at all.
  await expect(page.getByLabel("Gateway token")).toBeVisible();
});
