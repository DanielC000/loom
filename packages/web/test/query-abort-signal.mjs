// Hermetic test for react-query abort-signal plumbing through lib/api.ts (card 6ef3a2bc): a cancelled query
// must stop its 429 backoff sleep promptly, start NO further fetch, and surface as an AbortError (never a
// user-visible error). Imports the SAME source the app ships.
// Run: node --experimental-strip-types packages/web/test/query-abort-signal.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_tsxLoaderHook.mjs", import.meta.url);
const B = await import("../src/lib/rateLimitBackoff.ts");
const { api } = await import("../src/lib/api.ts");

const res = (status, headers = {}) => new Response("{}", { status, headers });
const realFetch = globalThis.fetch;
const settleWithin = (p, ms, label) =>
  Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: label }), ms))]);

// (1) End to end through api.ts: a 429 with a 60s Retry-After; aborting mid-sleep rejects promptly with an
//     AbortError and the request is never retried. (Pre-fix `get` took no signal, so the sleep ran its full 60s.)
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(429, { "retry-after": "60" }); };
  try {
    const ac = new AbortController();
    const p = api.allSessions(ac.signal);
    await new Promise((r) => setTimeout(r, 30)); // let the first 429 land and the sleep start
    assert.equal(B.rateLimitSnapshot().waiting, 1, "precondition: the request is asleep in its backoff");
    const t0 = performance.now();
    ac.abort();
    const out = await settleWithin(p, 2000, "abort did not reject the sleeping request");
    assert.equal(out.timeout, undefined, out.timeout);
    assert.ok(B.isAbortError(out.e), `rejects with an AbortError, got ${out.e}`);
    assert.ok(performance.now() - t0 < 1000, "rejects promptly, not after the 60s backoff");
    assert.equal(calls, 1, "no further fetch after the abort");
    assert.equal(B.rateLimitSnapshot().waiting, 0, "the published wait is cleared");
  } finally { globalThis.fetch = realFetch; }
}

// (2) The signal reaches fetch itself, for all three GET helpers' members (allSessions=get, question=getErr).
{
  const seen = [];
  globalThis.fetch = async (_u, init) => { seen.push(init?.signal); return res(200); };
  try {
    const ac = new AbortController();
    await api.allSessions(ac.signal);
    await api.question("q1", ac.signal);
    await api.allSessions(); // no signal -> init untouched
    assert.equal(seen[0], ac.signal);
    assert.equal(seen[1], ac.signal);
    assert.equal(seen[2], undefined);
  } finally { globalThis.fetch = realFetch; }
}

// (3) A sleep that IGNORES the signal, or an abort landing between sleep and retry, still starts no new fetch.
{
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    B.fetchWithRateLimitBackoff("/api/x", { signal: ac.signal }, async () => { calls++; return res(429); }, {
      sleep: async () => { ac.abort(); }, rand: () => 0,
    }),
    (e) => B.isAbortError(e),
  );
  assert.equal(calls, 1, "no fetch after an abort that landed during a signal-ignoring sleep");
}

// (4) An already-aborted signal starts no request at all.
{
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(B.fetchWithRateLimitBackoff("/api/x", { signal: ac.signal }, async () => { calls++; return res(200); }), (e) => B.isAbortError(e));
  assert.equal(calls, 0);
}

// (5) No user-visible error: the abort is not a RateLimitedError, is never retried by react-query's predicate,
//     and a real failure still is (negative control for the predicate).
{
  const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  assert.equal(B.shouldRetryQuery(0, abort), false, "a cancelled query is not retried");
  assert.equal(B.shouldRetryQuery(0, new B.RateLimitedError("/x")), false);
  assert.equal(B.shouldRetryQuery(0, new Error("boom")), true, "control: an ordinary failure still retries");
  assert.equal(B.shouldRetryQuery(3, new Error("boom")), false);
  assert.equal(B.isAbortError(new Error("x")), false);
  // Queries have no global error alert: only the MutationCache alerts (main.tsx) — a query abort can't reach it.
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(!/new QueryCache\(/.test(main), "no QueryCache onError that could toast a cancelled query");
}

console.log("query-abort-signal: all assertions passed");
