// Hermetic unit test for the GATEWAY token a browser needs behind a trusted reverse proxy (card 4cbbc343).
// Everything asserted lives in src/lib/gatewayCredential.ts (JSX-free), so this imports the SAME source the app
// ships. The point of most cases is SEPARATION: the gateway credential must never trip, share state with, or
// alter the loopback credential's (card 093981dd) behaviour. Run:
//   node --experimental-strip-types packages/web/test/gateway-credential.mjs
import assert from "node:assert/strict";

// A tiny in-memory window/localStorage so the storage helpers run off-browser (the module guards `window`).
const mem = new Map();
globalThis.window = {
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } },
  location: { hostname: "box.tail1.ts.net", href: "https://box.tail1.ts.net:8443/board?gwtoken=GW-TOKEN&x=1" },
  history: { replaceState: (_s, _t, url) => { globalThis.window.location.href = String(url); } },
};

const G = await import("../src/lib/gatewayCredential.ts");
const L = await import("../src/lib/loopbackCredential.ts");

let pass = 0;
const check = (name, fn) => { mem.clear(); G.resetGatewayLockForTest(); L.resetCredentialLockForTest(); fn(); pass++; console.log(`ok   ${name}`); };

check("isRemoteOrigin: loopback hostnames are NOT remote; a tailnet/other host IS", () => {
  for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1"]) assert.equal(G.isRemoteOrigin(h), false, h);
  for (const h of ["box.tail1.ts.net", "192.168.1.5", "example.com", "127.0.0.1.evil.com", "100.64.1.2"]) assert.equal(G.isRemoteOrigin(h), true, h);
});

check("the daemon's proxy-class 401 body is the gateway discriminator; a bare 401 and the loopback guard's 401 are NOT", () => {
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized", code: "gateway-token-required", hint: "x" }), true);
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized" }), false, "a bare trust-tier 401 (no code) is not it");
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized — see `loom open` for how to obtain the local access credential" }), false);
  assert.equal(G.isGatewayTokenRequired(403, { code: "gateway-token-required" }), false, "only a 401");
  assert.equal(G.isGatewayTokenRequired(401, null), false);
  assert.equal(G.isGatewayTokenRequired(401, "gateway-token-required"), false);
});

check("SEPARATION: the gateway 401 body does NOT trip the loopback banner's predicates", () => {
  const body = { error: "unauthorized", code: "gateway-token-required", hint: "This address needs a gateway token. Mint one on the daemon host …" };
  assert.equal(L.isCredentialGuardFailure(401, body.error), false);
  assert.equal(L.isCredentialGuardMessage(body.error), false);
  assert.equal(L.isCredentialGuardMessage(body.hint), false, "the hint must not contain the loom-open pointer the loopback banner keys on");
  assert.equal(L.credentialLock(), null);
});

check("storage: a SEPARATE key from the loopback token; set/get round-trips; empty is rejected", () => {
  assert.equal(G.getGatewayToken(), null);
  assert.equal(G.setGatewayToken("   "), false);
  assert.equal(G.setGatewayToken("  gw-abc \n"), true);
  assert.equal(G.getGatewayToken(), "gw-abc");
  assert.equal(L.getLoopbackToken(), null, "writing the gateway token never touches the loopback key");
  L.setLoopbackToken("loop-secret");
  assert.equal(G.getGatewayToken(), "gw-abc", "…nor the other way round");
});

// captureGatewayTokenFromUrl is async (it VERIFIES before persisting), so it has its own async harness.
const acheck = async (name, fn) => { mem.clear(); G.resetGatewayLockForTest(); L.resetCredentialLockForTest(); globalThis.window.location.href = "https://box.tail1.ts.net:8443/board?gwtoken=GW-TOKEN&x=1"; await fn(); pass++; console.log(`ok   ${name}`); };
const GOOD = async () => true, BAD = async () => false;

await acheck("captureGatewayTokenFromUrl (token VERIFIES): stored into the gateway key, stripped from the URL, other params kept, page reloaded", async () => {
  let reloads = 0;
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => { reloads++; }, true), "stored");
  assert.equal(G.getGatewayToken(), "GW-TOKEN");
  assert.equal(globalThis.window.location.href.includes("gwtoken"), false);
  assert.equal(globalThis.window.location.href.includes("x=1"), true);
  assert.equal(L.getLoopbackToken(), null, "the loopback key is never touched");
  assert.equal(reloads, 1);
});

await acheck("captureGatewayTokenFromUrl (token REFUSED): NOTHING is stored, a WORKING stored token is KEPT, the link is stripped, the rejection is surfaced", async () => {
  G.setGatewayToken("owner-working-token");
  let reloads = 0;
  assert.equal(await G.captureGatewayTokenFromUrl(BAD, () => { reloads++; }, true), "rejected");
  assert.equal(G.getGatewayToken(), "owner-working-token", "a crafted link must never clobber the owner's token");
  assert.equal(globalThis.window.location.href.includes("gwtoken"), false, "a rejected token must not linger in the address bar either");
  assert.equal(reloads, 0);
  assert.equal(G.gatewayLinkRejected(), true, "the rejection is shown");
  assert.equal(G.gatewayLock(), false, "…but the banner does NOT claim a token is missing when the browser holds a working one");
  G.dismissGatewayLinkRejected();
  assert.equal(G.gatewayLinkRejected(), false);
});

await acheck("captureGatewayTokenFromUrl (REFUSED, no token held): also raises the gateway lock so the banner asks for one", async () => {
  assert.equal(await G.captureGatewayTokenFromUrl(BAD, () => {}, true), "rejected");
  assert.equal(G.getGatewayToken(), null);
  assert.equal(G.gatewayLock(), true);
  assert.equal(L.credentialLock(), null);
});

await acheck("captureGatewayTokenFromUrl: a successful verify clears a previous link-rejection; no param / loopback origin do nothing", async () => {
  G.noteGatewayLinkRejected(false);
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, true), "stored");
  assert.equal(G.gatewayLinkRejected(), false);
  mem.clear();
  globalThis.window.location.href = "https://box.tail1.ts.net:8443/?token=LOOPBACK-ONLY";
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, true), "none", "a ?token= param is the LOOPBACK credential's, never captured here");
  assert.equal(G.getGatewayToken(), null);
  globalThis.window.location.href = "http://127.0.0.1:4317/?gwtoken=X";
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, false), "none", "nothing on a loopback origin reads a gateway token");
  assert.equal(G.getGatewayToken(), null);
  assert.equal(globalThis.window.location.href.includes("gwtoken"), false);
});

check("withGatewayAuth: adds the bearer on a REMOTE origin (reads too); never overrides one the caller set", () => {
  G.setGatewayToken("gw-1");
  const bare = G.withGatewayAuth(undefined, true);
  assert.equal(new Headers(bare.headers).get("authorization"), "Bearer gw-1");
  const withInit = G.withGatewayAuth({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, true);
  const h = new Headers(withInit.headers);
  assert.equal(h.get("authorization"), "Bearer gw-1");
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(withInit.method, "POST");
  const own = { headers: { authorization: "Bearer caller-set" } };
  assert.equal(G.withGatewayAuth(own, true), own, "an explicit authorization is left alone");
});

check("withGatewayAuth: UNCHANGED on a loopback origin (byte-identical) and when no token is held", () => {
  G.setGatewayToken("gw-1");
  const init = { method: "GET" };
  assert.equal(G.withGatewayAuth(init, false), init);
  assert.equal(G.withGatewayAuth(undefined, false), undefined);
  mem.clear();
  assert.equal(G.withGatewayAuth(init, true), init, "no token held ⇒ nothing to add");
});

check("socketAuth: loopback is byte-identical to before (term/companion carry ?token= of the loopback secret; fleet nothing)", () => {
  assert.deepEqual(G.socketAuth("term", "sec", false, "gw"), { query: "?token=sec" });
  assert.deepEqual(G.socketAuth("companion", "s e/c", false, "gw"), { query: "?token=s%20e%2Fc" });
  assert.deepEqual(G.socketAuth("term", null, false, "gw"), { query: "" });
  assert.deepEqual(G.socketAuth("fleet", "sec", false, "gw"), { query: "" }, "the loopback fleet feed is ungated: no token in its URL");
});

check("socketAuth: a REMOTE origin sends the gateway token in the double-subprotocol, NEVER in the URL, and never the loopback secret", () => {
  for (const kind of ["term", "companion", "fleet"]) {
    const a = G.socketAuth(kind, "loopback-secret", true, "gw-9");
    assert.deepEqual(a, { query: "", protocols: ["loom.v1", "loom.bearer.gw-9"] }, kind);
    assert.equal(JSON.stringify(a).includes("loopback-secret"), false);
  }
  assert.deepEqual(G.socketAuth("term", "loopback-secret", true, null), { query: "" }, "no gateway token ⇒ nothing presented (and still never the loopback secret)");
});

check("the gateway lock: its own state + subscription, independent of the loopback lock", () => {
  const seen = [];
  const unsub = G.subscribeGatewayLock((v) => seen.push(v));
  assert.equal(G.gatewayLock(), false);
  G.noteGatewayLock(); G.noteGatewayLock();
  assert.equal(G.gatewayLock(), true);
  assert.deepEqual(seen, [true], "re-noting an unchanged lock does not re-notify");
  assert.equal(L.credentialLock(), null, "the LOOPBACK lock is untouched");
  G.clearGatewayLock();
  assert.deepEqual(seen, [true, false]);
  unsub();
  L.noteCredentialLock("write");
  assert.equal(G.gatewayLock(), false, "and the loopback lock never sets the gateway one");
});

check("noteRemoteSocketRefusal: only a never-opened socket on a remote origin holding NO token; never on loopback; never once opened", () => {
  assert.equal(G.noteRemoteSocketRefusal(false, false, null), false, "loopback origin ⇒ the caller's loopback inference runs instead");
  assert.equal(G.gatewayLock(), false);
  assert.equal(G.noteRemoteSocketRefusal(true, true, null), false, "it opened once ⇒ not a credential problem");
  assert.equal(G.noteRemoteSocketRefusal(false, true, "held-token"), false, "a held token ⇒ a refused handshake is not evidence of a MISSING one");
  assert.equal(G.gatewayLock(), false);
  assert.equal(G.noteRemoteSocketRefusal(false, true, null), true);
  assert.equal(G.gatewayLock(), true);
  assert.equal(L.credentialLock(), null, "and it never sets the loopback lock");
});

console.log(`\n${pass} checks passed`);
