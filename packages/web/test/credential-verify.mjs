// Hermetic unit test for lib/credentialVerify.ts — card a1ec70a6 round 2: the ONE three-state classifier
// both credential paths verify through, and the pending-candidate hold that keeps an UNCHECKED candidate
// retryable. Run:
//   node --experimental-strip-types packages/web/test/credential-verify.mjs
//
// Why three states and not a boolean: round 1 collapsed "the daemon said no" and "we never got an answer"
// into one `false`, so a dropped connection or a reverse proxy's pre-auth 403 was reported to the user as
// a REFUSAL — a claim nobody had observed — and `loom open`'s one-shot `?token=` link was thrown away for
// it. `invalid` is the only state a refusal may be claimed for; `unknown` means exactly "ask again".
//
// SCOPE: the classifier's status algebra and the hold's storage algebra. WHICH statuses prove passage is
// each path's own business (its probe route decides that), so those maps are asserted next to the path —
// test/loopback-token-link.mjs and test/gateway-credential.mjs — against the real verify functions.
import assert from "node:assert/strict";
import fs from "node:fs";

// A tiny in-memory sessionStorage so the hold runs off-browser (the module guards `window`).
const mem = new Map();
let storageThrows = false;
globalThis.window = {
  sessionStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { if (storageThrows) throw new Error("private mode"); mem.set(k, String(v)); },
    removeItem: (k) => { if (storageThrows) throw new Error("private mode"); mem.delete(k); },
  },
};

const V = await import("../src/lib/credentialVerify.ts");

let pass = 0;
const reset = () => { mem.clear(); storageThrows = false; };
const check = (name, fn) => { reset(); fn(); pass++; console.log(`ok   ${name}`); };
const acheck = async (name, fn) => { reset(); await fn(); pass++; console.log(`ok   ${name}`); };

// Every probe below records its own call count, so "was the daemon asked at all?" is observable.
const probing = (answer) => {
  const fn = async () => { fn.calls++; if (answer instanceof Error) throw answer; return { status: answer }; };
  fn.calls = 0;
  return fn;
};
const anyStatusPasses = () => true;

// ── card f53eaa57: a 401 is `invalid` only when the path's OWN provesRefusal affirms it ────────────────
await acheck("a BARE 401 with no provesRefusal is `unknown` — a path must supply one to ever claim `invalid`", async () => {
  assert.equal(await V.classifyCredentialProbe(probing(401), anyStatusPasses), "unknown",
    "a bare 401 could be an intermediary's own answer, not the daemon's — it is never assumed");
});

await acheck("a 401 IS `invalid` once the path's provesRefusal affirms it — the daemon's own coded body", async () => {
  const coded = async () => ({ status: 401, json: async () => ({ code: "gateway-token-required" }) });
  assert.equal(await V.classifyCredentialProbe(coded, anyStatusPasses, async (r) => (await r.json()).code === "gateway-token-required"), "invalid");
});

await acheck("a thrown probe is `unknown`, never `invalid` — a dropped request is not a refusal", async () => {
  const probe = probing(new Error("Failed to fetch"));
  assert.equal(await V.classifyCredentialProbe(probe, anyStatusPasses), "unknown");
  assert.equal(probe.calls, 1, "…and the throw was the probe's own, not a crash in the classifier");
});

await acheck("a status the path does not count as passage is `unknown`, however suggestive", async () => {
  // 403 is the stated case: a reverse proxy's CSRF/Host hook refuses BEFORE the token is ever looked at,
  // so the credential is untested. The rest are here because an intermediary, not the auth layer, is the
  // likeliest author of them — treating any of these as a refusal would be a fabricated observation.
  for (const status of [403, 408, 429, 500, 502, 504]) {
    assert.equal(await V.classifyCredentialProbe(probing(status), (s) => s === 200), "unknown", String(status));
  }
});

await acheck("the path's own passage predicate decides `valid` — the classifier never guesses it", async () => {
  // The two real paths disagree on purpose: loopback probes an UPDATE-by-id route with a fresh uuid, so its
  // 404 is proof the guard let us through; the gateway probes GET /api/version, where a 404 means some
  // intermediary answered and proves nothing. One classifier, two predicates — never one hardcoded map.
  assert.equal(await V.classifyCredentialProbe(probing(404), (s) => s !== 403), "valid");
  assert.equal(await V.classifyCredentialProbe(probing(404), (s) => s >= 200 && s < 300), "unknown");
  assert.equal(await V.classifyCredentialProbe(probing(200), (s) => s >= 200 && s < 300), "valid");
});

await acheck("provesPassage is never even asked about a 401 — a path must not be able to call its own refusal a success", async () => {
  let calls = 0;
  const spyPasses = (s) => { calls++; return true; };
  assert.equal(await V.classifyCredentialProbe(probing(401), spyPasses), "unknown");
  assert.equal(calls, 0, "the passage predicate must never even run for a 401");
});

// ── card a1ec70a6 round 3 / f53eaa57: provesRefusal decides EVERY refusal, 401 included, consulted LAST ──
await acheck("provesRefusal can name a non-401 refusal — but only for a response that would be `unknown`", async () => {
  const coded = async () => ({ status: 429, json: async () => ({ code: "gateway-token-required" }) });
  // The gateway's case: the daemon answers a coded 429 only to a token whose verification just failed.
  assert.equal(await V.classifyCredentialProbe(coded, (s) => s >= 200 && s < 300, async (r) => r.status === 429), "invalid");
  // It must not be able to turn a PASSING response into a refusal: passage is decided first.
  const ok = async () => ({ status: 200, json: async () => ({}) });
  assert.equal(await V.classifyCredentialProbe(ok, (s) => s >= 200 && s < 300, async () => true), "valid",
    "a path that proved passage has its answer — the refusal hook is a last resort, not an override");
  // A 401 whose body the path's own refusal check declines to affirm is `unknown`, not `invalid`.
  assert.equal(await V.classifyCredentialProbe(probing(401), anyStatusPasses, async () => false), "unknown");
});

await acheck("a provesRefusal that THROWS (an unreadable body) falls back to `unknown`, never a rejection", async () => {
  const notJson = async () => ({ status: 429, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  assert.equal(await V.classifyCredentialProbe(notJson, (s) => s === 200, async (r) => (await r.json()).code === "x"), "unknown",
    "an intermediary's HTML error page proves nothing — and must not reject the verify either");
  assert.equal(await V.classifyCredentialProbe(probing(503), (s) => s === 200, async () => { throw new Error("boom"); }), "unknown");
});

await acheck("omitting provesRefusal: passage still decides `valid`/`unknown`, and a 401 can never be `invalid`", async () => {
  // Card f53eaa57: a path with no provesRefusal has no way to prove a 401 refusal at all, so it is
  // `unknown` — not the `invalid` a bare 401 used to get before any path could supply one.
  for (const [status, predicate, expected] of [[404, (s) => s !== 403, "valid"], [403, (s) => s !== 403, "unknown"], [401, () => true, "unknown"]]) {
    assert.equal(await V.classifyCredentialProbe(probing(status), predicate), expected, String(status));
  }
});

await acheck("the probe runs exactly once per classification", async () => {
  const probe = probing(200);
  await V.classifyCredentialProbe(probe, anyStatusPasses);
  assert.equal(probe.calls, 1, "a credential probe is a guarded round trip — never retried silently here");
});

// ── the pending hold: an UNCHECKED candidate kept retryable, and never readable as a credential ───────
check("the hold round-trips, reads null when empty, and clears", () => {
  const hold = V.pendingCandidateStore("loom.test.pending");
  assert.equal(hold.read(), null);
  hold.write("  candidate-secret \n");
  assert.equal(hold.read(), "candidate-secret", "stored trimmed, like every other candidate in these modules");
  hold.clear();
  assert.equal(hold.read(), null);
});

check("an empty candidate is never held (nothing to retry) and clearing twice is harmless", () => {
  const hold = V.pendingCandidateStore("loom.test.pending");
  hold.write("   \n ");
  assert.equal(hold.read(), null);
  hold.clear();
  hold.clear();
  assert.equal(hold.read(), null);
});

check("two holds with different keys never see each other's candidate", () => {
  const a = V.pendingCandidateStore("loom.test.a");
  const b = V.pendingCandidateStore("loom.test.b");
  a.write("a-secret");
  assert.equal(b.read(), null, "the loopback and gateway holds are separate credentials, as their stores are");
  b.write("b-secret");
  assert.equal(a.read(), "a-secret");
});

check("a sessionStorage that throws (private mode) is swallowed — never a broken render or a lost page", () => {
  const hold = V.pendingCandidateStore("loom.test.pending");
  storageThrows = true;
  hold.write("candidate-secret");
  assert.equal(hold.read(), null, "no hold, no retry affordance — but nothing throws");
  hold.clear();
});

// Comments are stripped first: this module's own doc comments SAY "never localStorage", and a scan that
// cannot tell the prose from the code would read that prohibition as a violation of itself.
const codeOf = (file) => fs.readFileSync(new URL(file, import.meta.url), "latin1")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

check("the hold uses sessionStorage, NOT localStorage: it dies with the tab and is never a stored credential", () => {
  const code = codeOf("../src/lib/credentialVerify.ts");
  assert.ok(code.includes("sessionStorage.getItem"), "positive control: the scan is reading the real module's code");
  assert.equal(/\blocalStorage\s*\./.test(code), false,
    "an unverified candidate must never land where the live credential lives — that is the whole defect");
  assert.ok(/\blocalStorage\s*\./.test("window.localStorage.setItem(k, v)"), "negative control: the pattern matches the bad shape");
});

// ── the structural half: both paths classify HERE, so they cannot drift apart again ───────────────────
check("both credential paths verify through this one classifier", () => {
  for (const f of ["loopbackCredential.ts", "gatewayCredential.ts"]) {
    const src = fs.readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "latin1");
    assert.ok(src.includes("classifyCredentialProbe("), `${f} must verify through the shared classifier`);
    assert.equal(/return\s+r\.status\s*!==\s*401/.test(src), false, `${f} must not re-implement the status algebra`);
  }
});

console.log(`\n${pass} checks passed`);
