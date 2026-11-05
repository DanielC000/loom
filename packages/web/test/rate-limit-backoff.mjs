// Hermetic unit test for the shared-fetch 429 backoff (card 4729d007) — src/lib/rateLimitBackoff.ts, the SAME
// source the app ships. Run: node --experimental-strip-types packages/web/test/rate-limit-backoff.mjs
import assert from "node:assert/strict";

import { register } from "node:module";
// rateLimitBackoff.ts imports ./gatewayCredential extensionless (bundler style); the loader hook resolves it.
// Registered before the DYNAMIC imports below (a static import would be hoisted past register()).
register("./_tsxLoaderHook.mjs", import.meta.url);

const B = await import("../src/lib/rateLimitBackoff.ts");
const G = await import("../src/lib/gatewayCredential.ts");

const res = (status, headers = {}, body = {}) => new Response(JSON.stringify(body), { status, headers });
const noJitter = () => 0;

// (1) Retry-After parsing: seconds, HTTP-date, junk, zero, negative.
assert.equal(B.parseRetryAfterMs("7"), 7000);
assert.equal(B.parseRetryAfterMs("1.5"), 1500);
assert.equal(B.parseRetryAfterMs("Wed, 21 Oct 2015 07:28:10 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")), 10_000);
assert.equal(B.parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:28:10 GMT")), null, "a past date is unusable");
for (const bad of [null, undefined, "", "soon", "0", "-3"]) assert.equal(B.parseRetryAfterMs(bad), null, `unusable: ${String(bad)}`);

// (2) Delay: exponential, capped; Retry-After honoured, capped, never undercut by jitter.
assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((a) => B.rateLimitDelayMs(a, null, 0, noJitter)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
assert.equal(B.rateLimitDelayMs(0, "12", 0, noJitter), 12_000, "Retry-After beats the exponential step");
assert.equal(B.rateLimitDelayMs(5, "2", 0, noJitter), 2_000, "Retry-After beats it even when SMALLER than the step");
assert.equal(B.rateLimitDelayMs(0, "9999", 0, noJitter), B.RATE_LIMIT_RETRY_AFTER_CAP_MS, "Retry-After is capped");
assert.equal(B.rateLimitDelayMs(0, "10", 0, () => 0.999999), 12_500, "jitter adds at most 25%");
assert.ok(B.rateLimitDelayMs(2, "10", 0, () => 0.5) >= 10_000, "jitter never undercuts the floor");
const total = [0, 1, 2, 3, 4, 5].reduce((s, a) => s + B.rateLimitDelayMs(a, null, 0, noJitter), 0);
assert.ok(total >= 60_000, `the unjittered retry budget (${total}ms) spans one full 60s server window`);

// (3) A scripted fetch: 429 x3 then 200. The waits are the backoff schedule, NOT zero (never immediate), and
//     the banner state is published while sleeping and cleared after.
{
  const seq = [429, 429, 429, 200];
  let calls = 0;
  const waits = [];
  const snaps = [];
  const unsub = B.subscribeRateLimit(() => snaps.push(B.rateLimitSnapshot().waiting));
  const r = await B.fetchWithRateLimitBackoff("/api/x", undefined, async () => res(seq[calls++]), {
    sleep: async (ms) => { waits.push(ms); }, rand: noJitter,
  });
  unsub();
  assert.equal(r.status, 200);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(snaps, [1, 0, 1, 0, 1, 0], "published as waiting while asleep, idle after each wake");
  assert.equal(B.rateLimitSnapshot().waiting, 0);
}

// (4) Retry-After from the response is what the sleep uses.
{
  let calls = 0;
  const waits = [];
  await B.fetchWithRateLimitBackoff("/api/x", { method: "GET" }, async () => (calls++ === 0 ? res(429, { "retry-after": "5" }) : res(200)), {
    sleep: async (ms) => { waits.push(ms); }, rand: noJitter,
  });
  assert.deepEqual(waits, [5000]);
}

// (5) Exhaustion THROWS (an error, not a 429 Response a pane could mistake for data), after exactly maxRetries waits.
{
  let calls = 0;
  const waits = [];
  await assert.rejects(
    B.fetchWithRateLimitBackoff("/api/vault/tree", undefined, async () => { calls++; return res(429); }, { sleep: async (ms) => { waits.push(ms); }, rand: noJitter }),
    (e) => e instanceof B.RateLimitedError && e.message === "/api/vault/tree -> 429" && e.status === 429,
  );
  assert.equal(calls, B.RATE_LIMIT_MAX_RETRIES + 1);
  assert.equal(waits.length, B.RATE_LIMIT_MAX_RETRIES);
  assert.equal(B.rateLimitSnapshot().waiting, 0, "no wait state leaks past exhaustion");
}

// (6) What must NOT be retried: a write, a non-429, the coded failed-auth throttle.
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  let calls = 0;
  const r = await B.fetchWithRateLimitBackoff("/api/w", { method }, async () => { calls++; return res(429); }, { sleep: async () => assert.fail("must not sleep"), rand: noJitter });
  assert.equal(r.status, 429); assert.equal(calls, 1, `${method} is returned untouched`);
}
{
  let calls = 0;
  const r = await B.fetchWithRateLimitBackoff("/api/x", undefined, async () => { calls++; return res(500); }, { sleep: async () => assert.fail("must not sleep") });
  assert.equal(r.status, 500); assert.equal(calls, 1);
}
{
  let calls = 0;
  const r = await B.fetchWithRateLimitBackoff("/api/x", undefined, async () => { calls++; return res(429, {}, { error: "too many failed attempts", code: G.GATEWAY_TOKEN_REQUIRED_CODE }); }, { sleep: async () => assert.fail("must not sleep") });
  assert.equal(r.status, 429); assert.equal(calls, 1, "a bad token is not fixed by waiting");
}

// (7) An aborted request stops waiting instead of sleeping out its budget, and leaves no wait state behind.
{
  const ac = new AbortController();
  const p = B.fetchWithRateLimitBackoff("/api/x", { signal: ac.signal }, async () => res(429), { rand: noJitter });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(B.rateLimitSnapshot().waiting, 1, "sleeping");
  ac.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.equal(B.rateLimitSnapshot().waiting, 0);
}

console.log("rate-limit-backoff: all assertions passed");
