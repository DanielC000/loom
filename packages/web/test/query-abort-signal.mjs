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

// (6) Source scan (card ae30209f): EVERY `get`/`getOrNull`/`getErr` call in lib/api.ts forwards a `signal`, and
//     every `queryFn:` under src/ forwards the query's `{signal}` — except the two non-GET sites below (a POST
//     preview and a HEAD probe, which the GET helpers don't carry). Scans the shipped source text.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const matchClose = (t, i) => { let d = 0; for (let k = i; k < t.length; k++) { if (t[k] === "(") d++; else if (t[k] === ")" && --d === 0) return k; } return t.length; };
  const unsignalledGets = (t) => {
    const out = [], re = /(?<![.\w])(get|getOrNull|getErr)<|(?<![.\w])(get|getOrNull|getErr)\(/g;
    let m;
    while ((m = re.exec(t))) {
      if (/function\s+$/.test(t.slice(Math.max(0, m.index - 20), m.index))) continue;
      let open;
      if (m[1]) { let d = 0, j = m.index + m[0].length - 1; for (; j < t.length; j++) { if (t[j] === "<") d++; else if (t[j] === ">" && t[j - 1] !== "=" && --d === 0) break; } open = t.indexOf("(", j); }
      else open = t.indexOf("(", m.index);
      if (!/signal/.test(t.slice(m.index, matchClose(t, open) + 1))) out.push(t.slice(0, m.index).split("\n").length);
    }
    return out;
  };
  const unsignalledQueryFns = (t) => {
    const out = [], re = /queryFn:\s*/g;
    let x;
    while ((x = re.exec(t))) {
      let d = 0, e = x.index + x[0].length;
      for (; e < t.length; e++) { const c = t[e]; if ("([{".includes(c)) d++; else if (")]}".includes(c)) { if (d === 0) break; d--; } else if (c === "," && d === 0) break; }
      if (!/signal/.test(t.slice(x.index, e))) out.push(t.slice(x.index, e).replace(/\s+/g, " ").trim());
    }
    return out;
  };
  // Negative controls: the scanners must see a bare call / bare reference, and must pass a forwarded one.
  assert.equal(unsignalledGets('a: (id: string) => get<X>(`/api/x/${id}`),').length, 1, "control: a get() without signal is flagged");
  assert.equal(unsignalledGets('a: (id: string, signal?: AbortSignal) => getErr<X>(`/api/x/${id}`, signal),').length, 0, "control: a forwarded get is clean");
  assert.equal(unsignalledQueryFns("useQuery({ queryFn: api.projects })").length, 1, "control: a bare queryFn reference is flagged");
  assert.equal(unsignalledQueryFns("useQuery({ queryFn: () => api.agents(id) })").length, 1, "control: a signal-less arrow is flagged");
  assert.equal(unsignalledQueryFns("useQuery({ queryFn: ({ signal }) => api.agents(id, signal) })").length, 0, "control: a forwarded queryFn is clean");

  const src = new URL("../src/", import.meta.url);
  assert.deepEqual(unsignalledGets(readFileSync(new URL("lib/api.ts", src), "utf8")), [], "every api GET call forwards a signal");
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : /\.tsx?$/.test(e.name) ? [new URL(e.name, u)] : []);
  const files = walk(src);
  assert.ok(files.length > 100, `precondition: scanned the real tree (${files.length} files)`);
  const bare = files.flatMap((f) => unsignalledQueryFns(readFileSync(f, "utf8")).map((s) => `${f.pathname.split("/src/")[1]}: ${s}`));
  assert.deepEqual(bare, [
    "pages/Schedules.tsx: queryFn: () => api.previewSchedule(cron)", // POST
    "pages/Vault.tsx: queryFn: () => api.vaultRawHead(projectId, path)", // HEAD
  ], "every queryFn forwards {signal} except the two documented non-GET probes");
}

console.log("query-abort-signal: all assertions passed");
