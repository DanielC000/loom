// Card d56b12d8 round 2 (Code Review f53d7c8d, the Major) — a TERMINAL pane and a COMPANION pane in the
// same document, on a remote origin, under one dead gateway token. Card 7a77e46b is absorbed here.
//
// THE DEFECT. `Terminal.tsx`'s never-opened close ran the LOOPBACK arm on a remote origin, because
// `isCredentialSocketFailure(everOpened, getLoopbackToken())` is `!everOpened && token === null` and a
// remote page never captures a loopback secret at all (`socketAuth` presents only the gateway token
// there) — so it is trivially TRUE. Raising that lock is not merely the wrong banner: the lock is MODULE
// state, it survives every unmount and SPA navigation, and NOTHING on a remote origin can ever clear it
// (the loopback banner's own "Unlock writes" probe needs a loopback secret that does not exist there).
//
// Round 1 then made the companion panel's "token refused" state TERMINAL, whose only recovery is the
// re-attach nonce — and that nonce bumped on the clearing edge of `loopback !== null || gateway`. With a
// stuck loopback lock the OR never clears, so a VALID paste produced no bump at all: the companion stayed
// dead until a full reload, which is exactly the "self-healing becomes silently dead" outcome
// `a6d7bf36`'s own @decision forbids. Both halves are fixed (the Terminal reorder, and a nonce that bumps
// on EACH lock's own clearing edge); this spec is the end-to-end proof, and it is red on either half alone
// being absent from the Terminal side.
//
// WHAT EACH TEST PROVES — and read the whole header before adding a third, because the ORDER is load-bearing:
//  1. `no gateway token` (card d56b12d8 §1, the runtime half of `test/socket-close-wiring.mjs` check (12)):
//     a companion pane whose attach carries NO credential at all lands on its own terminal pill and does
//     NOT re-handshake. This is NOT a red/green proof of this round — the branch shipped in round 1 — it
//     is the runtime test that round never got, and check (12) is a source scan that provably could not
//     fail for this client (the reviewer MEASURED it: dropping the `return` still passed). Its control is
//     stated at the assertion.
//  2. the Major: a terminal pane AND the companion chat under a dead token, then a valid paste. Asserted
//     three ways, because "the companion came back" alone does not say WHICH half of the fix did it:
//     the terminal pane's own copy names the GATEWAY credential (so the remote arm really ran), the
//     LOOPBACK banner is absent (so the stuck lock was never raised), and the companion returns to
//     `connected` on a NEW socket in the SAME document.
//
// Test 1 runs FIRST because test 2 REVOKES the rig's seeded token and a revoke is irreversible.
//
// HARNESS: ./fixtures/gateway-proxy-rig.ts — an isolated daemon (own temp LOOM_HOME, LOOM_PORT=0,
// first-run marker pre-stamped, LOOM_DEV/scheduler off) behind an in-test reverse proxy, so the page's
// origin is non-loopback and its sockets are gateway-token authenticated. A LOOPBACK page's sockets are
// not token-authenticated at all, so this whole behaviour is unreachable on the shared `loomDaemon`
// fixture and a spec written there would pass vacuously.
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { GATEWAY_PROXY_LAUNCH_OPTIONS, startGatewayProxyRig, type GatewayProxyRig } from "./fixtures/gateway-proxy-rig";

test.use({ launchOptions: GATEWAY_PROXY_LAUNCH_OPTIONS });
test.describe.configure({ mode: "serial" });

let rig: GatewayProxyRig;
let companion: { sessionId: string; name: string };

test.beforeAll(async () => {
  rig = await startGatewayProxyRig();
  const name = `Twin-${randomUUID().slice(0, 8)}`;
  const seeded = await rig.seedCompanion(name);
  companion = { sessionId: seeded.sessionId, name };
});
test.afterAll(async () => { await rig?.stop(); });

/** Records every socket the page CONSTRUCTS, split by endpoint, and keeps the live companion one. The
 *  COUNTS are the discriminating instrument: a stopped ladder and a ladder that was never armed look
 *  identical in any rendered state, so every absence claim below is made on a counter a sibling assertion
 *  proves can rise. Records only — it never substitutes the socket, so both panes connect for real. */
const INSTRUMENT = () => {
  const w = window as unknown as { __compOpens: number; __termOpens: number; __compCloses: number[] };
  w.__compOpens = 0;
  w.__termOpens = 0;
  w.__compCloses = [];
  const Native = window.WebSocket;
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (String(url).includes("/ws/companion")) {
      w.__compOpens += 1;
      sock.addEventListener("close", (e) => { w.__compCloses.push((e as CloseEvent).code); });
    }
    if (String(url).includes("/ws/term")) w.__termOpens += 1;
    return sock;
  } as unknown as typeof WebSocket;
  Patched.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, k, { value: Native[k] });
  }
  window.WebSocket = Patched;
};

const compOpens = () => (window as unknown as { __compOpens: number }).__compOpens;
const termOpens = () => (window as unknown as { __termOpens: number }).__termOpens;
const compCloseCodes = () => (window as unknown as { __compCloses: number[] }).__compCloses;

/** Set AFTER load, so `addInitScript` does NOT re-install it — a reload therefore wipes it. This is what
 *  makes "re-attached IN PLACE" falsifiable: a reload satisfies "a new socket opened" just as well. */
const sentinel = () => (window as unknown as { __pageLife?: string }).__pageLife ?? null;
const SAME_DOCUMENT = "d56b12d8-same-document";

/** Open the proxy-origin Companion page with `token` already in storage, instrumented. */
async function openCompanionPage(page: import("@playwright/test").Page, token: string | null): Promise<void> {
  await page.context().addInitScript(INSTRUMENT);
  await page.context().addInitScript((t: string | null) => {
    try {
      if (t !== null) localStorage.setItem("loom.gatewayToken", t);
      localStorage.setItem("loom.setupWelcomeDismissed", "1");
    } catch { /* storage blocked */ }
  }, token);
  await page.goto(`${rig.origin}/companion`);
}

/** `xterm` here runs its DEFAULT DOM renderer (no webgl/canvas addon), so the pane's painted text really
 *  is in the DOM. Whitespace is stripped from BOTH sides of the comparison because xterm pads every row
 *  to the full column width and hard-wraps a long line mid-word — a raw substring match on the pane's
 *  copy would be a function of the resolved terminal geometry, which is not what any of this is about. */
async function paneText(page: import("@playwright/test").Page): Promise<string> {
  const raw = (await page.locator(".xterm-rows").first().textContent()) ?? "";
  return raw.replace(/\s+/g, "");
}
const squashed = (s: string) => s.replace(/\s+/g, "");

async function tokenIdByName(name: string): Promise<string> {
  const res = await fetch(`${rig.loopbackURL}/api/gateway-tokens`, { headers: rig.loopbackAuth });
  expect(res.ok, `listing tokens failed (${res.status})`).toBe(true);
  const tokens = (await res.json()) as { id: string; name: string }[];
  // FIXTURE IDENTITY: a stray daemon or a token leaked from another spec fails loudly here instead of
  // letting this revoke something else and still look like it worked.
  const match = tokens.filter((t) => t.name === name);
  expect(match.length, `expected exactly one token named ${name}, saw ${JSON.stringify(tokens.map((t) => t.name))}`).toBe(1);
  return match[0]!.id;
}

test("a companion attach carrying NO gateway token is terminal on its own pill, not a ladder", async ({ page }) => {
  test.setTimeout(120_000); // includes a 14s observation window

  // Loaded WITH the live token, because the Companion page's own REST reads need one to resolve the
  // companion list at all. The token is then removed and the panel REMOUNTED — react-query keeps the
  // already-resolved list, so the page keeps rendering this companion while its next attach carries
  // nothing. That is the real-world shape too: a page whose credential was cleared under it.
  await openCompanionPage(page, rig.token);
  const chat = page.locator("#companion-panel-chat");
  await expect(chat.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByText(companion.name, { exact: true })).toBeVisible();
  const openedWhileHealthy = await page.evaluate(compOpens);
  expect(openedWhileHealthy, "the panel must have attached under the live token").toBeGreaterThan(0);

  await page.evaluate(() => { try { localStorage.removeItem("loom.gatewayToken"); } catch { /* blocked */ } });
  // Chat → Manage → Chat UNMOUNTS and remounts the panel, so the next attach runs with `everOpened ===
  // false`. That matters: `noteRemoteSocketRefusal` is false for an already-opened socket by design, so a
  // panel that merely reconnects after connecting once never reaches this branch.
  await page.locator("#companion-tab-manage").click();
  await expect(chat).toHaveCount(0);
  await page.locator("#companion-tab-chat").click();
  await expect(chat).toBeVisible();

  // THE VERDICT. `no gateway token` is reachable from exactly ONE place in the component —
  // `stopForNoToken`, run only by `noteRemoteSocketRefusal` returning true, which needs a remote origin
  // AND no token held. So the pill IS the attribution: a dead-but-held token paints `token refused`, a
  // 1008 paints `token revoked`, and a loopback-origin failure paints neither.
  await expect(chat.getByText("no gateway token", { exact: true })).toBeVisible({ timeout: 30_000 });
  const settled = await page.evaluate(compOpens);
  expect(settled, "the token-less remount must have attempted a socket of its own").toBeGreaterThan(openedWhileHealthy);
  // The browser sees 1006, not a daemon-authored 1008: the upgrade was rejected, so there was never a
  // socket for the daemon to close with a reason.
  expect(await page.evaluate(compCloseCodes)).toContain(1006);

  // ...AND IT IS TERMINAL. CONTROL for this absence claim, stated because the claim is worthless without
  // one: deleting the `return` after `stopForNoToken()` in `CompanionChat.tsx` reddens exactly these two
  // assertions (the pill becomes `reconnecting` and the count rises) — which is the defect
  // `test/socket-close-wiring.mjs` check (12) could not see before this round, since the re-arm it must
  // reject sat outside the slice the check was reading. The counter's own positive control is above: it
  // rose for the healthy attach and again for the remount, on this same instrument in this same page.
  await page.waitForTimeout(14_000);
  expect(await page.evaluate(compOpens),
    "a credential-less upgrade can only ever 401 — it must not keep spending the shared failed-auth budget").toBe(settled);
  await expect(chat.getByText("no gateway token", { exact: true })).toBeVisible();
  await expect(chat.getByText("reconnecting", { exact: true })).toHaveCount(0);
  // The re-entry surface is on screen, which is what makes stopping safe at all — and it is the GATEWAY
  // one. The loopback banner would be a false claim about a credential a remote page never holds.
  await expect(page.getByLabel("Gateway token")).toBeVisible();
  await expect(page.getByLabel("Local access credential")).toHaveCount(0);
});

test("a terminal pane's dead-token close must not strand the companion's re-attach", async ({ page }) => {
  test.setTimeout(150_000);

  const replacement = await rig.loopbackPost<{ plaintext: string }>("/api/gateway-tokens", { name: "e2e-twin-replacement" });
  expect(replacement.plaintext, "a minted token must come back with its plaintext ONCE").toBeTruthy();

  // Open under the LIVE token first, for the same reason as test 1 (the REST reads must resolve the
  // companion list), then kill it through the REAL human route.
  await openCompanionPage(page, rig.token);
  const chat = page.locator("#companion-panel-chat");
  await expect(chat.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByText(companion.name, { exact: true })).toBeVisible();

  const revoked = await fetch(`${rig.loopbackURL}/api/gateway-tokens/${await tokenIdByName("e2e-proxy")}`, {
    method: "POST",
    headers: { ...rig.loopbackAuth, "content-type": "application/json" },
    body: JSON.stringify({ status: "revoked" }),
  });
  expect(revoked.ok, `revoke failed (${revoked.status})`).toBe(true);
  // The daemon closes the token's own open sockets with 1008 + an authored reason (card 3c205fb5), so the
  // live panel lands in `revoked`. Asserted because it proves the revoke actually landed in the browser,
  // and because it is the state the never-opened verdict below must not be confused with.
  await expect(chat.getByText("token revoked", { exact: true })).toBeVisible({ timeout: 30_000 });

  // ── the TERMINAL pane, under the now-dead token ────────────────────────────────────────────────
  // This is the half card 7a77e46b owned. The pane's upgrade 401s, so no socket opens and the browser
  // reports a bare 1006 — the exact close whose credential attribution was wrong.
  await page.locator("#companion-tab-terminal").click();
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(termOpens), { timeout: 30_000 }).toBeGreaterThan(0);
  // DEFECT ASSERTION 1 — the pane names the GATEWAY credential, because the remote arm ran. Pre-fix this
  // read "[no local access credential — live terminals are disabled]" on a page that never had, needed,
  // or could obtain one. Both polarities are asserted: a one-sided check would pass if the pane simply
  // painted nothing at all.
  await expect.poll(() => paneText(page), { timeout: 30_000 })
    .toContain(squashed("access token was refused"));
  expect(await paneText(page), "a remote pane must never claim a missing LOCAL credential")
    .not.toContain(squashed("no local access credential"));

  // DEFECT ASSERTION 2 — and the lock behind that copy was never raised. This is the one that matters: the
  // banner is cosmetic, the LOCK is module state that nothing on a remote origin can clear, and it is what
  // held the re-attach nonce's OR permanently true. The gateway banner IS expected here.
  await expect(page.getByLabel("Local access credential")).toHaveCount(0);
  await expect(page.getByLabel("Gateway token")).toBeVisible();

  // ── back to the chat, which now reaches its own terminal state under the dead token ───────────
  await page.locator("#companion-tab-chat").click();
  await expect(chat).toBeVisible();
  await expect(chat.getByText("token refused", { exact: true })).toBeVisible({ timeout: 30_000 });
  const frozen = await page.evaluate(compOpens);
  expect(frozen, "the dead-token remount must have attempted a socket of its own").toBeGreaterThan(0);
  await page.evaluate((v) => { (window as unknown as { __pageLife: string }).__pageLife = v; }, SAME_DOCUMENT);

  // ── a VALID paste, and the whole point of the card ────────────────────────────────────────────
  await page.getByLabel("Gateway token").fill(replacement.plaintext);
  await page.getByRole("button", { name: "Use token" }).click();

  // DEFECT ASSERTION 3 — the companion comes back. Pre-fix the paste cleared the GATEWAY lock while the
  // terminal pane's stuck LOOPBACK lock kept the nonce's OR true, so no bump was ever emitted and this
  // panel stayed `token refused` for the life of the document.
  await expect(chat.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByText("token refused", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(compOpens), "the re-attach must build a NEW socket").toBeGreaterThan(frozen);
  // THE CONTROL on that count AND on the pill: a reload produces both, while proving the opposite of what
  // is claimed — the nonce path would be dead and the user would have had to reload by hand.
  expect(await page.evaluate(sentinel), "the companion must have re-attached in the SAME document").toBe(SAME_DOCUMENT);
  await expect(page.getByLabel("Gateway token")).toHaveCount(0);
});
