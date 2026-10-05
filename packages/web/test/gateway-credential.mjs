// Hermetic unit test for the GATEWAY token a browser needs behind a trusted reverse proxy (card 4cbbc343).
// Everything asserted lives in src/lib/gatewayCredential.ts (JSX-free), so this imports the SAME source the app
// ships. The point of most cases is SEPARATION: the gateway credential must never trip, share state with, or
// alter the loopback credential's (card 093981dd) behaviour. Run:
//   node --experimental-strip-types packages/web/test/gateway-credential.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";

// Card a1ec70a6: both credential modules now have a REAL runtime import of ./credentialVerify (the shared
// three-state verify), written extensionless in the bundler style the app uses, which Node's own resolver
// cannot follow. `_tsxLoaderHook.mjs` exists for exactly that; registering it means the module imports
// below must be DYNAMIC, since a static one here would be hoisted and resolved before `register()` runs.
register("./_tsxLoaderHook.mjs", import.meta.url);

// A tiny in-memory window/localStorage so the storage helpers run off-browser (the module guards `window`).
// sessionStorage is where an UNCHECKED candidate waits for a retry — never the live credential slot.
const mem = new Map();
const session = new Map();
globalThis.window = {
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } },
  sessionStorage: {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => { session.set(k, String(v)); },
    removeItem: (k) => { session.delete(k); },
  },
  location: { hostname: "box.tail1.ts.net", href: "https://box.tail1.ts.net:8443/board?gwtoken=GW-TOKEN&x=1" },
  history: { replaceState: (_s, _t, url) => { globalThis.window.location.href = String(url); } },
};

const G = await import("../src/lib/gatewayCredential.ts");
const L = await import("../src/lib/loopbackCredential.ts");

const DEFAULT_HREF = "https://box.tail1.ts.net:8443/board?gwtoken=GW-TOKEN&x=1";
const LOOPBACK_KEY = "loom.loopbackToken";
// Card a1ec70a6 round 3: `seedLoopbackTokenForTest` is gone — the loopback module exports NO write path at
// all now, so a test that wants a browser already holding a loopback secret seeds its own fake storage.
const seedHeldLoopbackSecret = (secret) => { mem.set(LOOPBACK_KEY, secret); };

let pass = 0;
const reset = () => {
  mem.clear();
  session.clear();
  G.resetGatewayLockForTest();
  L.resetCredentialLockForTest();
  globalThis.window.location.href = DEFAULT_HREF;
  // Restored per case: the reload-loop cases below replace it with a throwing / silently no-op one.
  globalThis.window.history.replaceState = (_s, _t, url) => { globalThis.window.location.href = String(url); };
};
const check = (name, fn) => { reset(); fn(); pass++; console.log(`ok   ${name}`); };

check("isRemoteOrigin: loopback hostnames are NOT remote; a tailnet/other host IS", () => {
  for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1"]) assert.equal(G.isRemoteOrigin(h), false, h);
  for (const h of ["box.tail1.ts.net", "192.168.1.5", "example.com", "127.0.0.1.evil.com", "100.64.1.2"]) assert.equal(G.isRemoteOrigin(h), true, h);
});

check("the daemon's proxy-class 401 body is the gateway discriminator; a bare 401 and the loopback guard's 401 are NOT", () => {
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized", code: "gateway-token-required", hint: "x" }), true);
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized" }), false, "a bare trust-tier 401 (no code) is not it");
  assert.equal(G.isGatewayTokenRequired(401, { error: "unauthorized — see `loom open` for how to obtain the local access credential" }), false);
  assert.equal(G.isGatewayTokenRequired(403, { code: "gateway-token-required" }), false, "only a 401 or the coded failed-auth 429");
  assert.equal(G.isGatewayTokenRequired(429, { error: "too many failed attempts — try again later", code: "gateway-token-required" }), true, "the daemon's failed-auth 429 carries the code (card cf9ebab9)");
  assert.equal(G.isGatewayTokenRequired(429, { error: "rate limit exceeded" }), false, "a bare 429 (no code) is not it");
  assert.equal(G.isGatewayTokenRequired(500, { code: "gateway-token-required" }), false);
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
  seedHeldLoopbackSecret("loop-secret");
  assert.equal(G.getGatewayToken(), "gw-abc", "…nor the other way round");
  assert.equal(L.getLoopbackToken(), "loop-secret", "control: the seed really did land in the loopback slot");
});

// captureGatewayTokenFromUrl is async (it VERIFIES before persisting), so it has its own async harness.
const acheck = async (name, fn) => { reset(); await fn(); pass++; console.log(`ok   ${name}`); };
// Card a1ec70a6: the injected verifier is THREE-state now. UNKNOWN is the one that is not a refusal.
const GOOD = async () => "valid", BAD = async () => "invalid", UNREACHED = async () => "unknown";

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
  assert.equal(G.gatewayLinkOutcome(), "rejected", "the rejection is shown");
  assert.equal(G.gatewayLock(), false, "…but the banner does NOT claim a token is missing when the browser holds a working one");
  G.dismissGatewayLinkOutcome();
  assert.equal(G.gatewayLinkOutcome(), null);
});

await acheck("captureGatewayTokenFromUrl (REFUSED, no token held): also raises the gateway lock so the banner asks for one", async () => {
  assert.equal(await G.captureGatewayTokenFromUrl(BAD, () => {}, true), "rejected");
  assert.equal(G.getGatewayToken(), null);
  assert.equal(G.gatewayLock(), true);
  assert.equal(L.credentialLock(), null);
});

await acheck("captureGatewayTokenFromUrl: a successful verify clears a previous link-rejection; no param / loopback origin do nothing", async () => {
  G.noteGatewayLinkOutcome("rejected", false);
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, true), "stored");
  assert.equal(G.gatewayLinkOutcome(), null);
  mem.clear();
  globalThis.window.location.href = "https://box.tail1.ts.net:8443/?token=LOOPBACK-ONLY";
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, true), "none", "a ?token= param is the LOOPBACK credential's, never captured here");
  assert.equal(G.getGatewayToken(), null);
  globalThis.window.location.href = "http://127.0.0.1:4317/?gwtoken=X";
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => {}, false), "none", "nothing on a loopback origin reads a gateway token");
  assert.equal(G.getGatewayToken(), null);
  assert.equal(globalThis.window.location.href.includes("gwtoken"), false);
});

// ── card a1ec70a6: the same three-state rule as the loopback path, on this path's own probe ───────────
await acheck("verifyGatewayTokenAgainstDaemon: 2xx is `valid`, a 401 is `invalid`, and a 404 proves NOTHING here", async () => {
  const seen = [];
  for (const [status, expected] of [[200, "valid"], [204, "valid"], [401, "invalid"], [404, "unknown"], [403, "unknown"], [429, "unknown"], [502, "unknown"]]) {
    globalThis.fetch = async (url, init) => { seen.push({ url, init }); return { status }; };
    assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), expected, String(status));
  }
  assert.equal(seen[0].url, "/api/version", "a Tier-1 read a remote-class request must authenticate");
  assert.equal(seen[0].init.headers.authorization, "Bearer gw-candidate");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown");
  // The predicate difference from loopback is deliberate, and this is the case that proves it: a proxied
  // origin is exactly where some intermediary, not the daemon, may answer a path it does not route.
  globalThis.fetch = async () => ({ status: 404 });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown",
    "a 404 is proof of passage on the LOOPBACK probe only — never here");
});

// ── card a1ec70a6 round 3 item 3: the daemon's OWN second refusal status, and only that one ───────────
await acheck("verifyGatewayTokenAgainstDaemon: the failed-auth 429 WITH the daemon's code is `invalid`; a bare 429 stays `unknown`", async () => {
  // The daemon answers a coded 429 only to a request whose token just FAILED verification (verify-first,
  // card cf9ebab9), so it IS a refusal this token earned — reporting it as "we learned nothing" sends the
  // user to retry a token the daemon has already rejected.
  globalThis.fetch = async () => ({ status: 429, json: async () => ({ error: "too many failed attempts — try again later", code: "gateway-token-required" }) });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "invalid");
  globalThis.fetch = async () => ({ status: 429, json: async () => ({ error: "rate limit exceeded" }) });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown",
    "a BARE throttle says nothing about whether the credential was ever looked at");
  globalThis.fetch = async () => ({ status: 429, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown",
    "an unreadable body proves nothing either way — and must not reject the verify");
  // The widening must NOT leak to a status an intermediary could have authored, whatever body rides it.
  globalThis.fetch = async () => ({ status: 403, json: async () => ({ code: "gateway-token-required" }) });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown",
    "a pre-auth 403 never reached the token check at all");
  globalThis.fetch = async () => ({ status: 502, json: async () => ({ code: "gateway-token-required" }) });
  assert.equal(await G.verifyGatewayTokenAgainstDaemon("gw-candidate"), "unknown", "…nor a proxy's own 5xx");
});

await acheck("the coded 429 reaches the CAPTURE path as a refusal: the held token survives and the rejection is surfaced", async () => {
  G.setGatewayToken("owner-working-token");
  globalThis.fetch = async () => ({ status: 429, json: async () => ({ error: "too many failed attempts", code: "gateway-token-required" }) });
  let reloads = 0;
  // The REAL verifier here, not an injected one: this is the end-to-end proof that the classification above
  // is what the capture path actually acts on.
  assert.equal(await G.captureGatewayTokenFromUrl(undefined, () => { reloads++; }, true), "rejected");
  assert.equal(G.getGatewayToken(), "owner-working-token");
  assert.equal(G.gatewayLinkOutcome(), "rejected", "…and NOT 'unverified': the daemon did answer about this token");
  assert.equal(G.pendingGatewayToken(), null, "a refusal is final — nothing held for a retry that cannot help");
  assert.equal(reloads, 0);
});

// ── card a1ec70a6 round 3 item 1 (BLOCKING): the reload-loop guard, the twin of the loopback one ──────
// The round-2 change wrapped `replaceState` in a try/catch, which stops a throw from rejecting the promise
// — but this path had no "already holding exactly this token" early return, so a strip that THREW (caught)
// or silently NO-OPPED left `?gwtoken=` in the URL and the capture still verified → stored → reload(), and
// the reload re-entered on the same URL. Measured pre-fix: 5 reloads for 5 re-entries, i.e. an unbounded
// loop in a real browser. Both failure shapes get their own case because they reach the same state by
// different routes, and the try/catch only ever addressed one of them.
await acheck("captureGatewayTokenFromUrl: re-opening a link carrying the ALREADY-held token is a no-op — no verify, no reload", async () => {
  G.setGatewayToken("GW-TOKEN");
  const seen = [];
  const wouldReject = async (t) => { seen.push(t); return "invalid"; }; // a consult shows up as a failure here
  let reloads = 0;
  assert.equal(await G.captureGatewayTokenFromUrl(wouldReject, () => { reloads++; }, true), "stored");
  assert.deepEqual(seen, [], "nothing to prove: this is the token we already hold");
  assert.equal(reloads, 0, "…and nothing to reconnect");
  assert.equal(G.getGatewayToken(), "GW-TOKEN");
  assert.equal(G.gatewayLinkOutcome(), null, "a no-op is not an outcome worth a banner");
});

await acheck("captureGatewayTokenFromUrl: a THROWING replaceState is swallowed, and the already-held guard bounds the reload", async () => {
  globalThis.window.history.replaceState = () => { throw new Error("replaceState unavailable"); };
  let reloads = 0;
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => { reloads++; }, true), "stored");
  assert.equal(G.getGatewayToken(), "GW-TOKEN");
  assert.equal(globalThis.window.location.href.includes("gwtoken=GW-TOKEN"), true, "the strip genuinely failed");
  assert.equal(reloads, 1, "the first pass still reconnects");
  // The re-entry a reload would cause, on the SAME still-unstripped URL: it must stop here.
  assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => { reloads++; }, true), "stored");
  assert.equal(reloads, 1, "…and no further reload: that is the loop guard, not the strip");
});

await acheck("captureGatewayTokenFromUrl: a SILENTLY NO-OP replaceState is bounded by the same guard", async () => {
  // The shape the try/catch cannot see at all: a browser (or a hostile override) whose replaceState
  // returns normally and changes nothing. Pre-fix this measured 5 reloads for 5 re-entries.
  globalThis.window.history.replaceState = () => { /* returns cleanly, strips nothing */ };
  let reloads = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(await G.captureGatewayTokenFromUrl(GOOD, () => { reloads++; }, true), "stored", `re-entry ${i}`);
  }
  assert.equal(globalThis.window.location.href.includes("gwtoken=GW-TOKEN"), true, "the strip genuinely no-opped");
  assert.equal(reloads, 1, "ONE reload across five re-entries — pre-fix this was five, and in a browser unbounded");
});

await acheck("captureGatewayTokenFromUrl (UNCHECKED): nothing stored, no refusal claimed, no lock, and the candidate is HELD", async () => {
  G.setGatewayToken("owner-working-token");
  let reloads = 0;
  assert.equal(await G.captureGatewayTokenFromUrl(UNREACHED, () => { reloads++; }, true), "unverified");
  assert.equal(G.getGatewayToken(), "owner-working-token", "an unproven candidate never overwrites a working token");
  assert.equal(G.gatewayLinkOutcome(), "unverified", "its OWN outcome — the banner copy keyed on it must not say 'refused'");
  assert.equal(G.pendingGatewayToken(), "GW-TOKEN", "held, so a retry has something to prove");
  assert.equal(globalThis.window.location.href.includes("gwtoken"), false, "…and still stripped from the address bar");
  assert.equal(reloads, 0);
});

await acheck("captureGatewayTokenFromUrl (UNCHECKED, no token held): still no lock — 'this address needs a token' is not what happened", async () => {
  assert.equal(await G.captureGatewayTokenFromUrl(UNREACHED, () => {}, true), "unverified");
  assert.equal(G.gatewayLock(), false,
    "the lock asserts the daemon demanded a token; an unanswered check observed nothing of the kind");
  assert.equal(G.pendingGatewayToken(), "GW-TOKEN");
});

await acheck("retryPendingGatewayToken: stores on a later success, keeps the hold while still unknown, drops it on a refusal", async () => {
  await G.captureGatewayTokenFromUrl(UNREACHED, () => {}, true);
  assert.equal(await G.retryPendingGatewayToken(UNREACHED, () => {}), "unverified");
  assert.equal(G.pendingGatewayToken(), "GW-TOKEN", "a retry that learned nothing keeps the candidate");
  let reloads = 0;
  assert.equal(await G.retryPendingGatewayToken(GOOD, () => { reloads++; }), "stored");
  assert.equal(G.getGatewayToken(), "GW-TOKEN");
  assert.equal(G.pendingGatewayToken(), null);
  assert.equal(G.gatewayLinkOutcome(), null);
  assert.equal(reloads, 1);
  assert.equal(L.getLoopbackToken(), null, "the loopback key is never touched by any of this");
});

await acheck("retryPendingGatewayToken: nothing held is `none`; a refusal is terminal", async () => {
  assert.equal(await G.retryPendingGatewayToken(GOOD, () => {}), "none");
  await G.captureGatewayTokenFromUrl(UNREACHED, () => {}, true);
  assert.equal(await G.retryPendingGatewayToken(BAD, () => {}), "rejected");
  assert.equal(G.pendingGatewayToken(), null);
  assert.equal(G.gatewayLinkOutcome(), "rejected");
});

await acheck("the two credentials' holds are separate: a gateway candidate never shows up as a loopback one", async () => {
  await G.captureGatewayTokenFromUrl(UNREACHED, () => {}, true);
  assert.equal(G.pendingGatewayToken(), "GW-TOKEN");
  assert.equal(L.pendingLoopbackToken(), null);
  assert.equal(L.loopbackLinkOutcome(), null, "…nor as a loopback link outcome");
});

// ── card a1ec70a6 round 3 item 4: the gateway banner's COPY, pure — the twin of loopbackLinkCopy ───────
check("gatewayLinkCopy: a refusal ONLY for the daemon's own answer, no unreachability claim, no unrendered Retry", () => {
  for (const holdsToken of [true, false]) {
    const rejected = G.gatewayLinkCopy("rejected", holdsToken);
    assert.match(rejected.headline, /refused/, "a real refusal says so plainly");
    assert.match(rejected.detail, /was not accepted/);

    const unverified = G.gatewayLinkCopy("unverified", holdsToken);
    const text = `${unverified.headline} ${unverified.detail}`;
    for (const word of [/refus/i, /not accepted/i, /reject/i, /invalid/i]) {
      assert.equal(word.test(text), false, `an unanswered check must not read as a refusal (${word})`);
    }
    // Round 3 item 3, as copy: `unknown` also covers answers the DAEMON sent — a pre-auth 403, a bare
    // throttle — so no variant may blame the connection for them.
    for (const word of [/could not reach/i, /unreachable/i, /offline/i, /reachable/i]) {
      assert.equal(word.test(text), false, `a 403 or a throttle came FROM the daemon (${word})`);
    }
    assert.match(unverified.headline, /could not be checked/);
    assert.match(unverified.detail, /did not get an answer/i);
    // The Retry sentence is printed only when a candidate is genuinely HELD — a sessionStorage that
    // refused us leaves the outcome unverified with no button, and the copy must not name one.
    assert.equal(/\bRetry\b/.test(unverified.detail), false, "no hold ⇒ no Retry offered ⇒ no Retry promised");
    assert.match(G.gatewayLinkCopy("unverified", holdsToken, true).detail, /\bRetry\b/);

    const unstorable = G.gatewayLinkCopy("unstorable", holdsToken);
    assert.match(unstorable.detail, /was accepted/, "this one DID verify — the browser is what refused it");
  }
  assert.match(G.gatewayLinkCopy("rejected", true).detail, /unchanged/,
    "the one true claim survives: a refusal left the held token alone");
  assert.match(G.gatewayLinkCopy("unverified", false).detail, /stays locked/,
    "…and a browser holding no token is told this address is locked, whatever the outcome");
  for (const outcome of ["rejected", "unverified", "unstorable"]) {
    const copy = G.gatewayLinkCopy(outcome, false);
    assert.equal(/\bunchanged\b/.test(`${copy.headline} ${copy.detail}`), false,
      `${outcome}: nothing is 'unchanged' on a browser holding no token`);
  }
});

check("GatewayTokenBanner takes its link wording from the pure helper, and explains the Retry under a lock", () => {
  const src = fs.readFileSync(new URL("../src/components/GatewayTokenBanner.tsx", import.meta.url), "latin1");
  assert.ok(src.includes("This address needs a gateway token."), "positive control: the scan is reading the real banner");
  assert.ok(src.includes("gatewayLinkCopy("), "the wording must come from the pure helper this file asserts");
  // The round-3 finding: a lockedNow/revoked banner kept the lock headline and dropped the link copy
  // entirely, while still rendering the Retry button — a button with nothing saying what it retries.
  assert.ok(src.includes("!linkLeads && linkCopy"),
    "a lock-led banner must STILL say what the Retry rendered beside it is retrying");
  assert.equal(/could not reach the daemon/i.test(src), false,
    "…and the unreachability claim must not survive inlined in the JSX either");
  assert.ok(/could not reach the daemon/i.test("Loom could not reach the daemon to check"),
    "negative control: the pattern does match the bad copy");
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

check("socketAuth: loopback (card e4459829) now carries term/companion's loopback secret in the SAME double-subprotocol remote uses, never in the url; fleet still gets nothing", () => {
  assert.deepEqual(G.socketAuth("term", "sec", false, "gw"), { query: "", protocols: ["loom.v1", "loom.bearer.sec"] });
  assert.deepEqual(G.socketAuth("companion", "token.sub-proto_2~ok", false, "gw"), { query: "", protocols: ["loom.v1", "loom.bearer.token.sub-proto_2~ok"] });
  assert.equal(JSON.stringify(G.socketAuth("term", "sec", false, "gw")).includes("?token="), false, "the secret must never ride the url");
  assert.deepEqual(G.socketAuth("term", null, false, "gw"), { query: "" });
  assert.deepEqual(G.socketAuth("fleet", "sec", false, "gw"), { query: "" }, "the loopback fleet feed is ungated: no token in its URL or protocols");
});

check("socketAuth: a REMOTE origin sends the gateway token in the double-subprotocol, NEVER in the URL, and never the loopback secret", () => {
  for (const kind of ["term", "companion", "fleet"]) {
    const a = G.socketAuth(kind, "loopback-secret", true, "gw-9");
    assert.deepEqual(a, { query: "", protocols: ["loom.v1", "loom.bearer.gw-9"] }, kind);
    assert.equal(JSON.stringify(a).includes("loopback-secret"), false);
  }
  assert.deepEqual(G.socketAuth("term", "loopback-secret", true, null), { query: "" }, "no gateway token ⇒ nothing presented (and still never the loopback secret)");
});

// Card e4459829 round 2, item 1 (Code Review regression): a WebSocket subprotocol element must be composed
// ENTIRELY of RFC 7230 `token` chars, or a REAL browser's `new WebSocket(url, protocols)` throws
// SYNCHRONOUSLY — before any network attempt — and the pane dies with no retry (the old `?token=` query
// path instead got a 401 the existing banner/paste recovery already handles). The OLD "s e/c" fixture
// above (replaced in this same change) contained a space and a slash — both invalid — and it still passed,
// because nothing checked the value's shape; that is exactly the bug this test proves fixed. Values below
// are the concrete character classes a stored secret can actually come back mangled with: a raw space (a
// copy/paste that kept word-wrap), a comma (a CSV-pasted list), a double quote (an escaped-JSON paste), and
// a non-ASCII letter (an autocorrect mangle) — none are valid RFC 7230 tokens.
check("socketAuth: a non-token-safe stored secret is treated as ABSENT — never built into a `protocols` array a real WebSocket() would reject — for both the loopback and the gateway token", () => {
  for (const bad of ["s e/c", "a,b", 'with"quote', "héllo"]) {
    assert.deepEqual(G.socketAuth("term", bad, false, "gw"), { query: "" }, `loopback bad=${JSON.stringify(bad)}`);
    assert.deepEqual(G.socketAuth("companion", bad, false, "gw"), { query: "" }, `loopback(companion) bad=${JSON.stringify(bad)}`);
    assert.deepEqual(G.socketAuth("term", "loopback-secret", true, bad), { query: "" }, `remote bad=${JSON.stringify(bad)}`);
  }
  // A token-safe secret (every RFC 7230 tchar class represented) still works, on both paths.
  const safe = "abc.DEF-123_~!#$%&'*+^`|";
  assert.deepEqual(G.socketAuth("term", safe, false, "gw"), { query: "", protocols: ["loom.v1", `loom.bearer.${safe}`] });
  assert.deepEqual(G.socketAuth("term", "loopback-secret", true, safe), { query: "", protocols: ["loom.v1", `loom.bearer.${safe}`] });
});

// Card 0045a8cb: socketAuth's loopback branch must REUSE loopbackCredential.ts's shape predicate, not a
// second hand-written rule — so its verdict must track whatever `isWellFormedLoopbackToken` says, for a
// wider spread of candidates than the fixed bad/safe lists above happen to cover.
check("socketAuth: the loopback branch's verdict always agrees with isWellFormedLoopbackToken — same predicate, not a parallel copy", () => {
  const candidates = ["deadbeef", "abc.DEF-123_~!#$%&'*+^`|", "s e/c", "a,b", 'with"quote', "héllo", "", "x", "!@#"];
  let agreements = 0;
  for (const c of candidates) {
    const wellFormed = L.isWellFormedLoopbackToken(c);
    const result = G.socketAuth("term", c, false, "gw");
    const sawProtocols = "protocols" in result;
    assert.equal(sawProtocols, wellFormed, `candidate=${JSON.stringify(c)}`);
    if (wellFormed) agreements++;
  }
  assert.ok(agreements >= 2, "the positive side of the comparison must actually fire at least once");
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

// ── probeHeldGatewayToken (card a6d7bf36) ──────────────────────────────────────────────────
// The question a refused WebSocket upgrade cannot answer. On a remote origin with a DEAD token in
// storage the upgrade 401s, so no socket opens and the browser reports a bare 1006 with no reason —
// noteRemoteSocketRefusal above returns false for exactly that case (a token IS held). So "the token is
// dead" and "the daemon is restarting" are indistinguishable AT THE CLOSE, and this asks over HTTP.
const HELD = "held-gw-token";

await acheck("probeHeldGatewayToken: a REFUSED held token is `invalid` AND raises the gateway lock", async () => {
  mem.set("loom.gatewayToken", HELD);
  const seen = [];
  assert.equal(await G.probeHeldGatewayToken(async (t) => { seen.push(t); return "invalid"; }, true), "invalid");
  assert.deepEqual(seen, [HELD], "it must probe the token this browser HOLDS, not a candidate");
  assert.equal(G.gatewayLock(), true, "the banner's paste field is the re-entry surface");
  // ...but it must NOT claim WHICH of revoked/paused/rotated/deleted happened: a 401 to a probe does
  // not say, and the banner's revoked copy names a specific change. That is the fabricated observation
  // the three-state split exists to prevent.
  assert.equal(G.gatewayTokenRevoked(), null, "a probe's 401 must never assert a named token-status change");
  assert.equal(L.credentialLock(), null, "and never the LOOPBACK lock");
});

await acheck("probeHeldGatewayToken: `valid` and `unknown` both pass through and raise NOTHING", async () => {
  // This is the half that makes it usable as a retry STOP at all. verifyGatewayTokenAgainstDaemon read
  // as a boolean reports a dropped request as a refusal, so a page would lock itself every time the
  // daemon merely restarted — the exact case the unbounded retry ladder exists to heal.
  for (const outcome of ["valid", "unknown"]) {
    reset();
    mem.set("loom.gatewayToken", HELD);
    assert.equal(await G.probeHeldGatewayToken(async () => outcome, true), outcome);
    assert.equal(G.gatewayLock(), false, outcome + " must not lock the page");
    assert.equal(G.gatewayTokenRevoked(), null);
  }
});

// Card d56b12d8 — the probe is ASYNCHRONOUS and the credential can be REPLACED while one is in flight.
// A paste into the banner is exactly that: it stores a verified token and CLEARS the lock. A probe of the
// OLD token landing afterwards used to raise the lock unconditionally, putting the banner straight back
// up over a working credential. `createRefusalEpisode`'s generation fence cannot cover this — that fence
// drops a superseded `onDead` (the episode's decision to stop a ladder), while this side effect fires
// inside the probe, before any result reaches the episode.
//
// ROUND 2 (Code Review f53d7c8d, minor 3) made the OUTCOME move with the side effect. Round 1 declined to
// raise the lock but still answered `"invalid"`, and `"invalid"` is the one outcome that BOTH raises the
// lock and ends a ladder — so reporting it while skipping the raise let the two halves disagree: the
// ladder stopped on a freshly pasted, working credential with no banner up to explain it. `"unknown"` is
// non-stopping, so the episode re-asks (about the token actually held now) within its own bounded budget.
await acheck("probeHeldGatewayToken: a token REPLACED mid-flight is `unknown` — a stale verdict, not a refusal", async () => {
  mem.set("loom.gatewayToken", HELD);
  const PASTED = "freshly-pasted-gw-token";
  // The swap happens INSIDE the verify, i.e. strictly between the probe capturing its argument and the
  // outcome arriving — the exact window a real paste occupies.
  const outcome = await G.probeHeldGatewayToken(async (t) => {
    assert.equal(t, HELD, "it must have asked about the token held when it started");
    mem.set("loom.gatewayToken", PASTED);
    G.clearGatewayLock(); // what storeVerifiedGatewayToken + the banner do on a successful paste
    return "invalid";
  }, true);
  // `"invalid"` would also be TRUE of the token probed — but nothing downstream wants a verdict about a
  // token nobody holds, and `createRefusalEpisode` treats `"invalid"` as its stopping outcome.
  assert.equal(outcome, "unknown", "a verdict about a token this browser no longer holds must not stop a ladder");
  assert.equal(G.gatewayLock(), false, "a probe of a token this browser no longer holds must not lock the page");
  assert.equal(G.gatewayTokenRevoked(), null);
});

await acheck("probeHeldGatewayToken: the fence compares the TOKEN, not merely whether one is held", async () => {
  // POLARITY CONTROL for the case above — same shape, same timing, the one difference being that the
  // token is still the probed one. Without this, "the lock stayed down" would pass identically if the
  // fence had been written to never raise the lock at all.
  mem.set("loom.gatewayToken", HELD);
  assert.equal(await G.probeHeldGatewayToken(async () => {
    mem.set("loom.gatewayToken", HELD); // re-stored, byte-identical — nothing has actually changed
    return "invalid";
  }, true), "invalid");
  assert.equal(G.gatewayLock(), true, "an unchanged held token IS the one just refused — raise the banner");
});

await acheck("probeHeldGatewayToken: `invalid` and the gateway lock are ONE decision, never two", async () => {
  // The INVARIANT round 2 restored, asserted as an invariant rather than case by case: across every shape
  // of mid-flight swap, `"invalid"` is returned IF AND ONLY IF the lock was raised. A per-case assertion
  // pair can drift apart silently (that is exactly how round 1's gap arrived); this one cannot.
  //
  // The A→B→A case is the one worth naming: swapped away and swapped back, the browser once again holds
  // the very token just refused, so `"invalid"` + a raised lock is the CORRECT answer there — not an
  // exception to the coupling. Same for a swap to the empty/absent case, which is a different held value.
  const CASES = [
    ["unchanged", () => { mem.set("loom.gatewayToken", HELD); }, true],
    ["replaced by a paste", () => { mem.set("loom.gatewayToken", "other-gw-token"); }, false],
    ["A→B→A (swapped away and back)", () => { mem.set("loom.gatewayToken", "other-gw-token"); mem.set("loom.gatewayToken", HELD); }, true],
    ["cleared outright", () => { mem.delete("loom.gatewayToken"); }, false],
  ];
  for (const [label, swap, expectInvalid] of CASES) {
    reset();
    mem.set("loom.gatewayToken", HELD);
    const outcome = await G.probeHeldGatewayToken(async () => { swap(); return "invalid"; }, true);
    assert.equal(outcome === "invalid", expectInvalid, `${label}: wrong outcome (${outcome})`);
    assert.equal(G.gatewayLock(), outcome === "invalid",
      `${label}: "invalid" and a raised gateway lock must always agree (outcome ${outcome}, lock ${G.gatewayLock()})`);
    // ...and the non-stopping answer must be the SPECIFIC one the episode re-asks on, not just "not
    // invalid": `"valid"`/`"none"` also settle the episode, so either would silence it just as wrongly.
    if (!expectInvalid) assert.equal(outcome, "unknown", `${label}: must be the re-askable outcome`);
  }
});

await acheck("probeHeldGatewayToken: `none` when there is nothing to ask about — and it never calls the probe", async () => {
  let calls = 0;
  const count = async () => { calls += 1; return "invalid"; };
  // No token held: a refused handshake is already covered by noteRemoteSocketRefusal, which locks.
  assert.equal(await G.probeHeldGatewayToken(count, true, null), "none");
  // A loopback origin never reads a gateway token at all, so it has none to disprove.
  mem.set("loom.gatewayToken", HELD);
  assert.equal(await G.probeHeldGatewayToken(count, false), "none");
  assert.equal(calls, 0, "`none` must cost no request — this runs on every socket close");
  assert.equal(G.gatewayLock(), false, "and `none` is not an outcome ABOUT a token, so never a refusal");
});

console.log(`\n${pass} checks passed`);
