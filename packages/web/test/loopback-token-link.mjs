// Hermetic unit test for card a1ec70a6's half of the loopback credential: the `?token=` LINK path must
// VERIFY a candidate secret before it is allowed to overwrite the one this browser already holds, through
// the SAME helper the banner's paste field uses. Everything asserted lives in src/lib/loopbackCredential.ts
// (JSX-free), so this imports the SAME source the app ships. Run:
//   node --experimental-strip-types packages/web/test/loopback-token-link.mjs
//
// The defect: `captureTokenFromUrl` used to write the secret on sight. Any link to
// `127.0.0.1:4317/?token=x` therefore evicted a working credential and broke every write until the next
// `loom open` — while the paste path (and the whole gateway-token path) verified first. Pre-fix, the cases
// below fail: the function was synchronous and returned `undefined`, so both the "KEPT" assertions and the
// returned-outcome assertions go red.
//
// Round 2 covers the second half of the same rule: a verify that never REACHED the daemon is not a refusal.
// It must not be worded as one, and it must not throw away the candidate — `loom open`'s link may be the
// only copy of that secret the user has. The three-state algebra itself lives in
// test/credential-verify.mjs; what is asserted here is this path's own status map and what it then does.
//
// SCOPE: the storage/verify algebra, the link path's control flow, and the banner COPY (pure, so a test
// can read every variant). That CredentialBanner.tsx renders it is a React concern a pure test cannot see
// — the chokepoint scan at the bottom pins the one structural fact about it that matters (no component can
// write the secret at all now), and packages/web/e2e/loopback-token-link.spec.ts proves the wiring against
// a real daemon.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";

// loopbackCredential.ts has a REAL runtime import of ./credentialVerify, written extensionless in the
// bundler style the app uses, which Node's own resolver cannot follow. `_tsxLoaderHook.mjs` exists for
// exactly that; registering it means the module import below must be DYNAMIC (a static one here would be
// hoisted and resolved before `register()` ran) — which it already is.
register("./_tsxLoaderHook.mjs", import.meta.url);

// A tiny in-memory window so the storage helpers run off-browser (the module guards `window`).
// localStorage holds the live credential; sessionStorage holds an unchecked candidate awaiting a retry.
const mem = new Map();
const session = new Map();
let storageThrows = false;
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { if (storageThrows) throw new Error("private mode"); mem.set(k, String(v)); },
  },
  sessionStorage: {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => { session.set(k, String(v)); },
    removeItem: (k) => { session.delete(k); },
  },
  location: { hostname: "127.0.0.1", href: "http://127.0.0.1:4317/board?token=LINK-TOKEN&x=1" },
  history: { replaceState: (_s, _t, url) => { globalThis.window.location.href = String(url); } },
};

const L = await import("../src/lib/loopbackCredential.ts");
const KEY = "loom.loopbackToken";
const DEFAULT_HREF = "http://127.0.0.1:4317/board?token=LINK-TOKEN&x=1";

// A browser that ALREADY holds a working secret — the precondition of the card's own case (a refused link
// must not evict it). Round 3 made the module export NO write path at all, not even a test-only seed, so
// this seeds the fake localStorage directly: the test owns that store, and reaching past the module is
// exactly what proves the module has no door of its own left open.
const seedHeldSecret = (secret) => {
  mem.set(KEY, secret);
  if (L.getLoopbackToken() !== secret) throw new Error("the seed did not land in the slot the module reads");
};

let pass = 0;
const reset = () => {
  mem.clear();
  session.clear();
  storageThrows = false;
  L.resetCredentialLockForTest();
  globalThis.window.location.href = DEFAULT_HREF;
  globalThis.window.history.replaceState = (_s, _t, url) => { globalThis.window.location.href = String(url); };
};
const check = (name, fn) => { reset(); fn(); pass++; console.log(`ok   ${name}`); };
const acheck = async (name, fn) => { reset(); await fn(); pass++; console.log(`ok   ${name}`); };

// Verifiers that record what they were handed, so "was the candidate proved at all?" is observable.
const spyVerify = (answer) => {
  const seen = [];
  const fn = async (t) => { seen.push(t); return answer; };
  fn.seen = seen;
  return fn;
};

// ── this path's own status map: which answers mean refused, which mean "we learned nothing" ───────────
await acheck("verifyLoopbackToken: a CODED 401 is `invalid`; the structural 404 of its own probe is `valid`", async () => {
  const seen = [];
  const GUARD_BODY = { error: "unauthorized — see `loom open` for how to obtain the local access credential" };
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return seen.length === 1 ? { status: 401, json: async () => GUARD_BODY } : { status: 404, json: async () => ({}) };
  };
  assert.equal(await L.verifyLoopbackToken("bad-secret"), "invalid");
  assert.equal(await L.verifyLoopbackToken("good-secret"), "valid",
    "the probe POSTs an empty patch to a fresh uuid, so its 404 is proof the write guard let us through");
  assert.equal(seen[0].init.method, "POST", "a GET would prove nothing: the guard exempts reads");
  assert.equal(seen[0].init.headers.authorization, "Bearer bad-secret", "the candidate is what gets proved");
});

await acheck("verifyLoopbackToken: a pre-guard 403, a throttle, a 5xx and a dropped request are all `unknown`", async () => {
  for (const status of [403, 408, 429, 500, 503]) {
    globalThis.fetch = async () => ({ status, json: async () => ({}) });
    assert.equal(await L.verifyLoopbackToken("candidate"), "unknown", String(status));
  }
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await L.verifyLoopbackToken("candidate"), "unknown",
    "an offline daemon never TESTED the secret — reporting a refusal here is a fabricated observation");
});

// ── card f53eaa57: a BARE/foreign 401 (no coded `loom open` body) must never be `invalid` ──────────────
await acheck("verifyLoopbackToken: a BARE 401 (no readable body) and a FOREIGN-JSON 401 both stay `unknown`; only the guard's own coded body is `invalid`", async () => {
  // A bare 401 — nothing readable as JSON, the shape an intermediary's plain-text refusal gives.
  globalThis.fetch = async () => ({ status: 401, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  assert.equal(await L.verifyLoopbackToken("candidate"), "unknown",
    "a bare 401 could be an intermediary's own answer, not the daemon's guard — never assumed a refusal");
  // A foreign-JSON 401 — valid JSON, but not the guard's own coded message (e.g. the trust-tier wall's
  // bare `unauthorized`, which needs a gateway token, not this secret).
  globalThis.fetch = async () => ({ status: 401, json: async () => ({ error: "unauthorized" }) });
  assert.equal(await L.verifyLoopbackToken("candidate"), "unknown",
    "valid JSON that is not the guard's own coded body proves nothing either");
  // The guard's own coded 401 — the one body this path may claim a refusal from.
  globalThis.fetch = async () => ({ status: 401, json: async () => ({ error: "unauthorized — see `loom open` for how to obtain the local access credential" }) });
  assert.equal(await L.verifyLoopbackToken("candidate"), "invalid");
});

// ── the shared verify-then-store helper ────────────────────────────────────────────────────────────────
await acheck("storeVerifiedLoopbackToken: an empty/whitespace candidate is refused WITHOUT a round trip", async () => {
  const verify = spyVerify("valid");
  assert.equal(await L.storeVerifiedLoopbackToken("   \n ", verify), "refused");
  assert.deepEqual(verify.seen, [], "nothing to prove — never ask the daemon");
  assert.equal(L.getLoopbackToken(), null);
});

// ── card 0045a8cb: the shared shape predicate, and the chokepoint that refuses on it early ────────────
check("isWellFormedLoopbackToken: every RFC 7230 tchar class passes; the daemon's own hex secret passes", () => {
  assert.equal(L.isWellFormedLoopbackToken("abc.DEF-123_~!#$%&'*+^`|"), true);
  assert.equal(L.isWellFormedLoopbackToken("deadbeef00112233"), true, "the real secret is always hex");
});

// The REAL shape, not just a hex-looking fixture: gateway/loopback-secret.ts's getOrCreateLoopbackSecret
// mints `randomBytes(32).toString("hex")` — exactly 64 lowercase hex chars — reproduced here verbatim so
// this predicate is proven against what the daemon ACTUALLY mints, never a guess at its shape. If this
// predicate ever regressed to reject a genuine secret, a real user's browser would be locked out of
// writes and live terminals with no way to self-recover (a fresh `loom open` mints a new file but a
// stuck-rejecting predicate would reject that one too) — this is the test that must never go red.
check("isWellFormedLoopbackToken: the REAL daemon secret shape (randomBytes(32).toString('hex'), 64 lowercase hex chars) passes", () => {
  for (let i = 0; i < 20; i++) {
    const real = randomBytes(32).toString("hex");
    assert.equal(real.length, 64, "sanity: this is really 64 chars, matching the daemon's own secret length");
    assert.match(real, /^[0-9a-f]{64}$/, "sanity: this is really lowercase hex, matching the daemon's own alphabet");
    assert.equal(L.isWellFormedLoopbackToken(real), true, real);
  }
});

check("isWellFormedLoopbackToken: a char a WebSocket subprotocol element can't carry fails — even though it would verify fine over an HTTP Bearer header", () => {
  for (const bad of ["s e/c", "a,b", 'with"quote', "héllo", ""]) {
    assert.equal(L.isWellFormedLoopbackToken(bad), false, JSON.stringify(bad));
  }
});

await acheck("storeVerifiedLoopbackToken: a malformed (non-subprotocol-safe) candidate is refused WITHOUT a round trip", async () => {
  const verify = spyVerify("valid"); // would VERIFY if consulted — proving the refusal happens before that
  for (const bad of ["s e/c", "a,b", 'with"quote', "héllo"]) {
    assert.equal(await L.storeVerifiedLoopbackToken(bad, verify), "refused", bad);
  }
  assert.deepEqual(verify.seen, [], "a candidate socketAuth could never use is never worth asking the daemon about");
  assert.equal(L.getLoopbackToken(), null);
});

await acheck("storeVerifiedLoopbackToken: a malformed candidate never evicts a working held secret", async () => {
  seedHeldSecret("owner-working-secret");
  assert.equal(await L.storeVerifiedLoopbackToken("s e/c", spyVerify("valid")), "refused");
  assert.equal(L.getLoopbackToken(), "owner-working-secret");
});

await acheck("storeVerifiedLoopbackToken: a VERIFIED candidate is stored trimmed", async () => {
  const verify = spyVerify("valid");
  assert.equal(await L.storeVerifiedLoopbackToken("  good-secret \n", verify), "stored");
  assert.deepEqual(verify.seen, ["good-secret"], "the TRIMMED candidate is what gets proved");
  assert.equal(L.getLoopbackToken(), "good-secret");
});

await acheck("storeVerifiedLoopbackToken: a REFUSED candidate writes nothing and keeps the held secret", async () => {
  seedHeldSecret("owner-working-secret");
  assert.equal(await L.storeVerifiedLoopbackToken("bad-secret", spyVerify("invalid")), "refused");
  assert.equal(L.getLoopbackToken(), "owner-working-secret");
});

await acheck("storeVerifiedLoopbackToken: an UNCHECKED candidate is its own outcome, not a refusal", async () => {
  seedHeldSecret("owner-working-secret");
  assert.equal(await L.storeVerifiedLoopbackToken("candidate", spyVerify("unknown")), "unverified");
  assert.equal(L.getLoopbackToken(), "owner-working-secret", "still nothing is written on an unproven candidate");
});

await acheck("storeVerifiedLoopbackToken: a verified candidate localStorage refuses reports 'unstorable'", async () => {
  storageThrows = true;
  assert.equal(await L.storeVerifiedLoopbackToken("good-secret", spyVerify("valid")), "unstorable");
  assert.equal(L.getLoopbackToken(), null);
});

// ── the `?token=` link path ────────────────────────────────────────────────────────────────────────────
await acheck("captureTokenFromUrl (VERIFIES): stored, stripped from the URL, other params kept, page reloaded", async () => {
  let reloads = 0;
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => { reloads++; }), "stored");
  assert.equal(L.getLoopbackToken(), "LINK-TOKEN");
  assert.equal(globalThis.window.location.href.includes("token"), false, "the secret must not linger in the address bar");
  assert.equal(globalThis.window.location.href.includes("x=1"), true, "unrelated params survive");
  assert.equal(reloads, 1, "requests that raced the capture carried no token — reconnect them");
  assert.equal(L.pendingLoopbackToken(), null, "a stored secret leaves nothing to retry");
});

// THE CARD'S CASE. Pre-fix this is the red one: the link's token landed in storage unverified.
await acheck("captureTokenFromUrl (REFUSED): the WORKING stored secret is KEPT, nothing is written, the link is still stripped", async () => {
  seedHeldSecret("owner-working-secret");
  const verify = spyVerify("invalid");
  let reloads = 0;
  assert.equal(await L.captureTokenFromUrl(verify, () => { reloads++; }), "rejected");
  assert.equal(L.getLoopbackToken(), "owner-working-secret", "a crafted ?token= link must never clobber the owner's secret");
  assert.deepEqual(verify.seen, ["LINK-TOKEN"], "…and it was actually proved, not just ignored");
  assert.equal(globalThis.window.location.href.includes("token"), false, "a rejected secret is stripped too");
  assert.equal(reloads, 0, "nothing changed — do not reload");
  assert.equal(L.loopbackLinkOutcome(), "rejected", "the refusal is SURFACED, not silent");
  assert.equal(L.credentialLock(), null, "…but writes are not claimed broken: the held secret is untouched");
  assert.equal(L.pendingLoopbackToken(), null, "a REFUSAL is final — holding it would offer a retry that cannot help");
});

await acheck("captureTokenFromUrl (REFUSED, no secret held): surfaced the same way; still no fabricated lock reason", async () => {
  assert.equal(await L.captureTokenFromUrl(spyVerify("invalid"), () => {}), "rejected");
  assert.equal(L.getLoopbackToken(), null);
  assert.equal(L.loopbackLinkOutcome(), "rejected");
  assert.equal(L.credentialLock(), null, "a refused LINK is not an observed refused write or upgrade");
});

// ROUND 2's CASE. Pre-round-2 this returned "rejected" and discarded the candidate: a daemon that was down
// for a moment cost the user `loom open`'s link, and the banner told them it had been refused.
await acheck("captureTokenFromUrl (UNCHECKED): nothing stored, nothing refused, and the candidate is HELD for a retry", async () => {
  seedHeldSecret("owner-working-secret");
  let reloads = 0;
  assert.equal(await L.captureTokenFromUrl(spyVerify("unknown"), () => { reloads++; }), "unverified");
  assert.equal(L.getLoopbackToken(), "owner-working-secret", "an unproven candidate never overwrites a working secret either");
  assert.equal(L.loopbackLinkOutcome(), "unverified", "its OWN outcome — the copy keyed on this must not claim a refusal");
  assert.equal(L.pendingLoopbackToken(), "LINK-TOKEN", "the candidate survives, so a retry has something to prove");
  assert.equal(globalThis.window.location.href.includes("token"), false,
    "…and it is still stripped: the hold is what preserves it, never the address bar");
  assert.equal(reloads, 0);
  assert.equal(L.credentialLock(), null);
});

await acheck("captureTokenFromUrl (UNSTORABLE): surfaced as its own outcome, and NOT held — a retry cannot fix storage", async () => {
  storageThrows = true;
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => {}), "unstorable");
  assert.equal(L.getLoopbackToken(), null);
  assert.equal(L.loopbackLinkOutcome(), "unstorable");
  assert.equal(L.pendingLoopbackToken(), null);
});

await acheck("captureTokenFromUrl: re-opening a link carrying the ALREADY-held secret is a no-op — no verify, no reload", async () => {
  seedHeldSecret("LINK-TOKEN");
  const verify = spyVerify("invalid"); // would REJECT if consulted — so a consult shows up as a failure here
  let reloads = 0;
  assert.equal(await L.captureTokenFromUrl(verify, () => { reloads++; }), "stored");
  assert.deepEqual(verify.seen, [], "nothing to prove: this is the secret we already hold");
  assert.equal(reloads, 0, "the reload-loop guard — an unstripped URL must not re-enter forever");
  assert.equal(L.getLoopbackToken(), "LINK-TOKEN");
});

// The guard above is load-bearing precisely when the strip did NOT work, so prove that pairing directly:
// a `replaceState` that throws must neither reject this promise (api.ts calls it with a bare `void`) nor
// leave an unstripped URL re-entering the capture forever.
await acheck("captureTokenFromUrl: a THROWING replaceState is swallowed, and the already-held guard bounds the reload", async () => {
  globalThis.window.history.replaceState = () => { throw new Error("replaceState unavailable"); };
  let reloads = 0;
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => { reloads++; }), "stored");
  assert.equal(L.getLoopbackToken(), "LINK-TOKEN");
  assert.equal(globalThis.window.location.href.includes("token=LINK-TOKEN"), true, "the strip genuinely failed");
  assert.equal(reloads, 1, "the first pass still reconnects");
  // The re-entry a reload would cause, on the SAME still-unstripped URL: it must stop here.
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => { reloads++; }), "stored");
  assert.equal(reloads, 1, "…and no further reload: that is the loop guard, not the strip");
});

await acheck("captureTokenFromUrl: no `token` param is a no-op, and `?gwtoken=` is never read as this secret", async () => {
  globalThis.window.location.href = "http://127.0.0.1:4317/board?x=1";
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => {}), "none");
  assert.equal(L.getLoopbackToken(), null);
  globalThis.window.location.href = "http://127.0.0.1:4317/board?gwtoken=GW";
  assert.equal(await L.captureTokenFromUrl(spyVerify("valid"), () => {}), "none", "that param is the GATEWAY credential's");
  assert.equal(L.getLoopbackToken(), null);
});

// ── the retry: the one thing that makes holding a candidate worth anything ─────────────────────────────
await acheck("retryPendingLoopbackToken: nothing held is `none` — no round trip, no banner change", async () => {
  const verify = spyVerify("valid");
  assert.equal(await L.retryPendingLoopbackToken(verify, () => {}), "none");
  assert.deepEqual(verify.seen, []);
  assert.equal(L.loopbackLinkOutcome(), null);
});

await acheck("retryPendingLoopbackToken: the daemon is back — the held candidate is stored, the hold cleared, the page reloaded", async () => {
  await L.captureTokenFromUrl(spyVerify("unknown"), () => {});
  assert.equal(L.pendingLoopbackToken(), "LINK-TOKEN");
  let reloads = 0;
  const verify = spyVerify("valid");
  assert.equal(await L.retryPendingLoopbackToken(verify, () => { reloads++; }), "stored");
  assert.deepEqual(verify.seen, ["LINK-TOKEN"], "the HELD candidate is what gets proved, not a re-read of the URL");
  assert.equal(L.getLoopbackToken(), "LINK-TOKEN");
  assert.equal(L.pendingLoopbackToken(), null);
  assert.equal(L.loopbackLinkOutcome(), null, "the notice settles with it");
  assert.equal(reloads, 1);
});

await acheck("retryPendingLoopbackToken: still no answer — the hold STAYS, so the user can try again", async () => {
  await L.captureTokenFromUrl(spyVerify("unknown"), () => {});
  assert.equal(await L.retryPendingLoopbackToken(spyVerify("unknown"), () => {}), "unverified");
  assert.equal(L.pendingLoopbackToken(), "LINK-TOKEN", "a retry that learned nothing must not discard the candidate");
  assert.equal(L.loopbackLinkOutcome(), "unverified");
});

await acheck("retryPendingLoopbackToken: the daemon says NO — the hold is dropped and the refusal replaces the notice", async () => {
  await L.captureTokenFromUrl(spyVerify("unknown"), () => {});
  const seen = [];
  const off = L.subscribeLoopbackLinkOutcome((o) => seen.push(o));
  assert.equal(await L.retryPendingLoopbackToken(spyVerify("invalid"), () => {}), "rejected");
  assert.equal(L.pendingLoopbackToken(), null, "now it IS final — nothing left to retry");
  assert.deepEqual(seen, ["rejected"], "…and the banner is told the outcome changed");
  off();
});

await acheck("a held candidate is never readable as the credential, and never reaches the live slot", async () => {
  await L.captureTokenFromUrl(spyVerify("unknown"), () => {});
  assert.equal(L.getLoopbackToken(), null, "the only credential reader sees nothing — the hold is not a credential");
  assert.equal(mem.get(KEY), undefined, "…and nothing was written to the live key at all");
  assert.equal(session.size, 1, "it is in sessionStorage, which dies with the tab");
});

// ── the link-outcome signal ────────────────────────────────────────────────────────────────────────────
check("the link-outcome signal notifies, dedupes, and is dismissable", () => {
  const seen = [];
  const off = L.subscribeLoopbackLinkOutcome((o) => seen.push(o));
  L.noteLoopbackLinkOutcome("rejected");
  L.noteLoopbackLinkOutcome("rejected");
  assert.deepEqual(seen, ["rejected"], "a second refusal on the same page-load does not re-render the banner");
  L.noteLoopbackLinkOutcome("unverified");
  assert.deepEqual(seen, ["rejected", "unverified"], "…but a CHANGE of outcome is a change of copy");
  L.dismissLoopbackLinkOutcome();
  assert.deepEqual(seen, ["rejected", "unverified", null]);
  assert.equal(L.loopbackLinkOutcome(), null);
  off();
  L.noteLoopbackLinkOutcome("rejected");
  assert.deepEqual(seen, ["rejected", "unverified", null], "unsubscribe stops delivery");
  assert.equal(L.loopbackLinkOutcome(), "rejected", "the signal itself still updates — only this listener detached");
});

await acheck("Dismiss drops the held candidate too — otherwise the notice would return on the next reload", async () => {
  await L.captureTokenFromUrl(spyVerify("unknown"), () => {});
  assert.equal(L.pendingLoopbackToken(), "LINK-TOKEN");
  L.dismissLoopbackLinkOutcome();
  assert.equal(L.pendingLoopbackToken(), null, "dismissing IS the user declining that link's credential");
});

check("a successful re-entry settles a stale link outcome (clearCredentialLock dismisses it)", () => {
  L.noteLoopbackLinkOutcome("rejected");
  L.noteCredentialLock("write");
  L.clearCredentialLock();
  assert.equal(L.loopbackLinkOutcome(), null, "no caller should have to remember to dismiss it");
  assert.equal(L.credentialLock(), null);
});

check("…and it is dismissed even when there was no lock to clear (the early return must not skip it)", () => {
  L.noteLoopbackLinkOutcome("rejected");
  assert.equal(L.credentialLock(), null);
  L.clearCredentialLock();
  assert.equal(L.loopbackLinkOutcome(), null);
});

check("resetCredentialLockForTest clears the link outcome and the hold too", () => {
  L.noteLoopbackLinkOutcome("unverified");
  session.set("loom.loopbackTokenPending", "LEFTOVER");
  L.resetCredentialLockForTest();
  assert.equal(L.loopbackLinkOutcome(), null);
  assert.equal(L.pendingLoopbackToken(), null);
});

// ── the COPY: pure, so every variant is readable here ─────────────────────────────────────────────────
// The round-2 review's two findings about wording, as assertions: an unanswered check may not be worded as
// a refusal, and NO variant may promise that writes still work — the held secret is unproven at this point
// and the banner's own "Unlock writes" field sits directly below the sentence.
check("the copy claims a refusal ONLY for the daemon's own 401", () => {
  for (const holdsToken of [true, false]) {
    const rejected = L.loopbackLinkCopy("rejected", holdsToken);
    assert.match(rejected.headline, /refused/, "a real 401 says so plainly");
    assert.match(rejected.detail, /was not accepted/);

    const unverified = L.loopbackLinkCopy("unverified", holdsToken);
    for (const word of [/refus/i, /not accepted/i, /reject/i, /invalid/i]) {
      assert.equal(word.test(`${unverified.headline} ${unverified.detail}`), false,
        `an unanswered check must not read as a refusal (${word})`);
    }
    assert.match(unverified.headline, /could not be checked/);
    // Round 3: it must not blame the CONNECTION either. `unknown` also covers answers the daemon itself
    // sent — a pre-auth 403 from a reverse proxy's CSRF/Host hook, a throttle — and "could not reach the
    // daemon" is simply false for those.
    assert.match(unverified.detail, /did not get an answer/i);
    for (const word of [/could not reach/i, /unreachable/i, /offline/i, /reachable/i]) {
      assert.equal(word.test(`${unverified.headline} ${unverified.detail}`), false,
        `a 403 or a throttle came FROM the daemon (${word})`);
    }
    // The Retry sentence is printed only when a candidate is genuinely held — a sessionStorage that
    // refused us leaves the outcome unverified with no button, and the copy must not name one.
    assert.equal(/\bRetry\b/.test(unverified.detail), false, "no hold ⇒ no Retry offered ⇒ no Retry promised");
    const retryVariant = L.loopbackLinkCopy("unverified", holdsToken, true);
    assert.match(retryVariant.detail, /\bRetry\b/);
    assert.equal(/could not reach|unreachable|reachable/i.test(retryVariant.detail), false,
      "…and the Retry sentence must not reintroduce the unreachability claim either");

    const unstorable = L.loopbackLinkCopy("unstorable", holdsToken);
    assert.match(unstorable.detail, /was accepted/, "this one DID verify — the browser is what refused it");
  }
});

check("no variant promises that writes still work", () => {
  for (const outcome of ["rejected", "unverified", "unstorable"]) {
    for (const holdsToken of [true, false]) {
      const copy = L.loopbackLinkCopy(outcome, holdsToken);
      const text = `${copy.headline} ${copy.detail}`;
      assert.equal(/writes still work/i.test(text), false, `${outcome}/${holdsToken}: never observed, so never claimed`);
      assert.equal(/\bunchanged\b/.test(text) && !holdsToken, false, "…and nothing is 'unchanged' on a browser holding nothing");
    }
  }
  assert.match(L.loopbackLinkCopy("rejected", true).detail, /unchanged/,
    "the one true claim survives: a refusal left the held secret alone");
  assert.match(L.loopbackLinkCopy("unverified", false).detail, /stay locked/,
    "…and a browser with no credential is told writes are locked, whatever the outcome");
});

// ── the chokepoint: ONE writer, and now no way to reach it from outside the module ────────────────────
// Round 1 pinned this with a source scan. Round 2 made it language-enforced instead: the writer is
// module-private, so there is no import a component could write the secret through — the scans below check
// the two ways that could regress (re-exporting it, or re-deriving the storage key somewhere else).
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(new URL(`${d.name}/`, dir)) : /\.tsx?$/.test(d.name) ? [new URL(d.name, dir)] : []);
const srcFiles = walk(new URL("../src/", import.meta.url));
const relative = (f) => f.pathname.split("/src/")[1];

check("the storage key is named in ONE file — nobody else can reach the live credential slot", () => {
  assert.ok(srcFiles.length > 20, "the scan must actually see the source tree");
  // `(?!Pending)`: the HOLD's key starts with the live key's own text, and a file naming only the hold
  // would otherwise satisfy a plain substring scan for the slot that actually holds the credential.
  const liveKey = new RegExp(`${KEY.replace(".", "\\.")}(?!Pending)`);
  const namers = srcFiles.filter((f) => liveKey.test(fs.readFileSync(f, "latin1"))).map(relative);
  assert.deepEqual(namers, ["lib/loopbackCredential.ts"],
    "read it with getLoopbackToken and write it through storeVerifiedLoopbackToken — never by key");
  assert.equal(liveKey.test(`const k = "${KEY}Pending";`), false, "negative control: the hold's key is not the live one");
  assert.ok(liveKey.test(`const k = "${KEY}";`), "positive control: the live key still matches");
});

check("the writer is module-private, and there is no test-only seed export beside it either", () => {
  const src = fs.readFileSync(new URL("../src/lib/loopbackCredential.ts", import.meta.url), "latin1");
  assert.ok(src.includes("function writeLoopbackToken("), "positive control: the scan is reading the real module");
  assert.equal(/export\s+(async\s+)?function\s+writeLoopbackToken/.test(src), false,
    "exporting the writer re-opens the hole: a call site could then store a secret it never proved");
  assert.equal(/export\s*\{[^}]*\bwriteLoopbackToken\b/.test(src), false, "…nor via an export list");
  assert.ok(/export\s+\{[^}]*\bwriteLoopbackToken\b/.test("export { getLoopbackToken, writeLoopbackToken };"),
    "negative control: the pattern matches the bad shape");
  // Round 3: the seed export is GONE, not merely unused by app code. A test-only export is still an
  // exported write path — nothing but a convention stops a component importing it — so the rule is
  // language-enforced only once no such door exists. Tests seed their own fake storage instead.
  const seedNamers = srcFiles.filter((f) => /\bseedLoopbackTokenForTest\b/.test(fs.readFileSync(f, "latin1"))).map(relative);
  assert.deepEqual(seedNamers, [], "no src file may name a seed helper — there is no longer one to name");
  assert.ok(/\bseedLoopbackTokenForTest\b/.test("export function seedLoopbackTokenForTest(t) {}"),
    "negative control: the pattern does match the shape it is asserting the absence of");
});

check("CredentialBanner's paste path goes through the shared verify-then-store helper", () => {
  const src = fs.readFileSync(new URL("../src/components/CredentialBanner.tsx", import.meta.url), "latin1");
  assert.ok(src.includes("Writes are locked in this browser."), "positive control: the scan is reading the real banner");
  assert.ok(src.includes("storeVerifiedLoopbackToken("), "the paste path must reuse the one helper");
  assert.ok(src.includes("loopbackLinkCopy("), "…and the link wording must come from the pure helper this file asserts");
  // Its own `unverified` strings (the paste error, the Retry error) are component-local, so the pure
  // copy assertions above cannot see them — scan for the claim this round removed.
  assert.equal(/could not reach the daemon|no answer from the daemon/i.test(src), false,
    "an `unknown` verify may come from a 403 or a throttle the daemon itself sent — never call it unreachable");
  assert.ok(/no answer from the daemon/i.test("Still no answer from the daemon — held."),
    "negative control: the pattern does match the bad copy");
});

console.log(`\n${pass} checks passed`);
