// Hermetic unit test for src/lib/orchEvents.ts (card 670b2081): the list math + cache patching behind the
// `/ws/fleet` orchestration-event push. No socket, no DOM; a REAL react-query QueryClient so the
// fetching-restart branch is exercised against the library's own state machine rather than a stub.
//   node --experimental-strip-types packages/web/test/orchEvents.mjs
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  EVENTS_BY_KIND_LIMIT, applyEventToList, applyOrchEvent, classifyOrchEventKey, hasFailedOrchEventQuery, invalidateOrchEventQueries, resyncOrchEvents,
} from "../src/lib/orchEvents.ts";
import { register } from "node:module";

// socketReconnect.ts reaches an extensionless import Node cannot resolve; same loader hook socket-reconnect.mjs uses.
register("./_tsxLoaderHook.mjs", import.meta.url);
globalThis.window = { localStorage: { getItem: () => null, setItem: () => {} }, location: { hostname: "localhost", href: "http://localhost/" }, history: { replaceState: () => {} } };
const { createRetryLoop } = await import("../src/lib/socketReconnect.ts");

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`ok   ${name}`); };
let n = 0;
const ev = (kind, managerSessionId = "m1", id = `e${++n}`) => ({ id, ts: `2026-11-05T12:00:${String(n % 60).padStart(2, "0")}.000Z`, managerSessionId, kind });

await check("classify: all four key families, and rejects everything else", () => {
  assert.deepEqual(classifyOrchEventKey(["orchEvents", "m1"]), { family: "manager", managerId: "m1" });
  assert.deepEqual(classifyOrchEventKey(["orchestrationEvents", "run1"]), { family: "manager", managerId: "run1" });
  assert.deepEqual(classifyOrchEventKey(["orchEventsByKind", "a", "b"]), { family: "kinds", kinds: ["a", "b"] });
  assert.deepEqual(classifyOrchEventKey(["orchestrationEventsByKinds", "a"]), { family: "kinds", kinds: ["a"] });
  for (const k of [["allSessions"], ["orchEvents"], ["orchEventsByKind"], ["orchEvents", 3], ["orchEventsByKind", "a", 5], ["orchStatus"]]) {
    assert.equal(classifyOrchEventKey(k), null, JSON.stringify(k));
  }
});

await check("applyEventToList: append for a timeline, prepend for a by-kinds list, never mutates", () => {
  const seed = [ev("x"), ev("y")];
  const e = ev("z");
  assert.deepEqual(applyEventToList(seed, e, "append").map((x) => x.id), [seed[0].id, seed[1].id, e.id]);
  assert.deepEqual(applyEventToList(seed, e, "prepend").map((x) => x.id), [e.id, seed[0].id, seed[1].id]);
  assert.equal(seed.length, 2);
});

await check("applyEventToList: dedupes by id (same reference back), so a replay is idempotent", () => {
  const seed = [ev("x")];
  assert.equal(applyEventToList(seed, { ...seed[0] }, "append"), seed);
  assert.equal(applyEventToList(seed, { ...seed[0] }, "prepend"), seed);
});

await check("applyEventToList: a by-kinds list is capped at the daemon's LIMIT, newest kept", () => {
  const full = Array.from({ length: EVENTS_BY_KIND_LIMIT }, (_, i) => ev("x", "m1", `old-${i}`));
  const e = ev("x", "m1", "newest");
  const next = applyEventToList(full, e, "prepend");
  assert.equal(next.length, EVENTS_BY_KIND_LIMIT);
  assert.equal(next[0].id, "newest");
  assert.equal(next[next.length - 1].id, `old-${EVENTS_BY_KIND_LIMIT - 2}`, "the OLDEST row fell off");
});

await check("applyOrchEvent: patches only the matching manager timeline and matching kind lists", () => {
  const qc = new QueryClient();
  qc.setQueryData(["orchEvents", "m1"], [ev("a", "m1")]);
  qc.setQueryData(["orchEvents", "m2"], [ev("a", "m2")]);
  qc.setQueryData(["orchestrationEvents", "m1"], []);
  qc.setQueryData(["orchEventsByKind", "k1", "k2"], []);
  qc.setQueryData(["orchEventsByKind", "other"], []);
  qc.setQueryData(["orchestrationEventsByKinds", "k1"], []);
  qc.setQueryData(["allSessions"], [{ id: "s" }]);
  const e = ev("k1", "m1", "pushed");
  applyOrchEvent(qc, e);
  const ids = (k) => qc.getQueryData(k).map((x) => x.id);
  assert.ok(ids(["orchEvents", "m1"]).includes("pushed"));
  assert.equal(ids(["orchEvents", "m1"]).at(-1), "pushed", "timeline appends");
  assert.ok(!ids(["orchEvents", "m2"]).includes("pushed"), "other manager untouched");
  assert.deepEqual(ids(["orchestrationEvents", "m1"]), ["pushed"]);
  assert.deepEqual(ids(["orchEventsByKind", "k1", "k2"]), ["pushed"]);
  assert.deepEqual(ids(["orchestrationEventsByKinds", "k1"]), ["pushed"]);
  assert.deepEqual(ids(["orchEventsByKind", "other"]), [], "a list whose kinds exclude this one is untouched");
  assert.deepEqual(qc.getQueryData(["allSessions"]), [{ id: "s" }], "non-event caches untouched");
  applyOrchEvent(qc, e);
  assert.equal(ids(["orchEvents", "m1"]).filter((x) => x === "pushed").length, 1, "delivering twice never double-applies");
});

await check("applyOrchEvent: a query with no data yet is left alone (its mount fetch will read the row)", () => {
  const qc = new QueryClient();
  qc.getQueryCache().build(qc, { queryKey: ["orchEvents", "m1"] });
  applyOrchEvent(qc, ev("k", "m1"));
  assert.equal(qc.getQueryData(["orchEvents", "m1"]), undefined);
});

// Polls an observable condition (never a fixed sleep) so a failure is a timeout, not a flake.
const until = async (cond, what) => {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for: ${what}`);
};

// Mid-fetch scenario shared by the two tests below: a mounted observer whose read is held open.
const midFetch = async (response) => {
  const qc = new QueryClient();
  let reads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const observer = new QueryObserver(qc, { queryKey: ["orchEvents", "m1"], staleTime: Infinity, queryFn: async () => { reads++; await gate; return response; } });
  const unsub = observer.subscribe(() => {});
  await until(() => reads === 1, "first read in flight");
  qc.setQueryData(["orchEvents", "m1"], [ev("a", "m1", "old")]); // gives the query data while it stays fetching
  assert.equal(qc.getQueryState(["orchEvents", "m1"]).fetchStatus, "fetching", "control: the query is mid-fetch");
  return { qc, release, unsub, reads: () => reads };
};

await check("applyOrchEvent: a frame MID-FETCH neither cancels nor restarts the read, and is applied once it settles", async () => {
  const pushed = ev("a", "m1", "pushed");
  const { qc, release, unsub, reads } = await midFetch([ev("a", "m1", "old")]); // the response predates `pushed`
  applyOrchEvent(qc, pushed);
  applyOrchEvent(qc, ev("a", "m1", "pushed2"));
  await new Promise((r) => setTimeout(r, 30)); // dwell: a restart (if any) would have started by now
  assert.equal(reads(), 1, "no second read was started by the frame");
  assert.equal(qc.getQueryState(["orchEvents", "m1"]).fetchStatus, "fetching", "the original read is still in flight (not cancelled)");
  assert.ok(!qc.getQueryData(["orchEvents", "m1"]).some((x) => x.id === "pushed"), "control: nothing applied before the fetch settles");
  release();
  await until(() => qc.getQueryData(["orchEvents", "m1"]).some((x) => x.id === "pushed2"), "queued frames applied after settle");
  assert.deepEqual(qc.getQueryData(["orchEvents", "m1"]).map((x) => x.id), ["old", "pushed", "pushed2"], "response + queued frames, in order");
  assert.equal(reads(), 1, "still exactly one read overall");
  unsub();
});

await check("applyOrchEvent: a queued frame whose row the response already holds is a no-op (id dedupe)", async () => {
  const pushed = ev("a", "m1", "pushed");
  const { qc, release, unsub } = await midFetch([ev("a", "m1", "old"), pushed]);
  applyOrchEvent(qc, pushed);
  release();
  await until(() => qc.getQueryState(["orchEvents", "m1"]).fetchStatus === "idle", "settled");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(qc.getQueryData(["orchEvents", "m1"]).map((x) => x.id), ["old", "pushed"]);
  unsub();
});

await check("invalidateOrchEventQueries: marks only event lists stale", async () => {
  const qc = new QueryClient();
  qc.setQueryData(["orchEvents", "m1"], []);
  qc.setQueryData(["orchEventsByKind", "k"], []);
  qc.setQueryData(["allSessions"], []);
  await invalidateOrchEventQueries(qc);
  assert.equal(qc.getQueryState(["orchEvents", "m1"]).isInvalidated, true);
  assert.equal(qc.getQueryState(["orchEventsByKind", "k"]).isInvalidated, true);
  assert.equal(qc.getQueryState(["allSessions"]).isInvalidated, false);
});

// A failing resync: a mounted list whose re-read throws (retry:false, as main.tsx does for a RateLimitedError).
// The retry loop is the REAL createRetryLoop with a manual timer, so "armed" and "fires" are observable.
const failingResync = async () => {
  const qc = new QueryClient();
  let failing = false;
  let reads = 0;
  const observer = new QueryObserver(qc, { queryKey: ["orchEvents", "m1"], staleTime: Infinity, retry: false, queryFn: async () => { reads++; if (failing) throw new Error("boom"); return [ev("a", "m1", "old")]; } });
  const unsub = observer.subscribe(() => {});
  await until(() => qc.getQueryState(["orchEvents", "m1"])?.status === "success", "initial read");
  failing = true;
  const timers = [];
  const retry = createRetryLoop({ setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (h) => { timers[h - 1] = null; }, backoff: { next: () => 1, reset: () => {} } });
  let settled = 0;
  const start = () => resyncOrchEvents(qc, { retry, isCurrent: () => true, onSettled: () => { settled++; }, again: start });
  return { qc, retry, timers, start, unsub, reads: () => reads, settled: () => settled, heal: () => { failing = false; } };
};

await check("resyncOrchEvents: a failing resync is retried (re-reading again), and stops retrying once the read succeeds", async () => {
  const r = await failingResync();
  r.start();
  await until(() => r.settled() === 1, "first resync settled");
  assert.equal(hasFailedOrchEventQuery(r.qc), true, "control: the list really is in error state (the promise alone never says so)");
  assert.equal(r.timers.filter(Boolean).length, 1, "a retry was armed");
  const before = r.reads();
  r.heal();
  r.timers.find(Boolean)(); // the ladder's timer fires
  await until(() => r.settled() === 2, "retry settled");
  assert.ok(r.reads() > before, "the retry re-read the list");
  assert.equal(hasFailedOrchEventQuery(r.qc), false);
  assert.equal(r.timers.length, 1, "success armed nothing further");
  r.unsub();
});

await check("resyncOrchEvents: a retry armed by a failed resync never fires after disarm, and none is armed after stop", async () => {
  const r = await failingResync();
  r.start();
  await until(() => r.settled() === 1, "first resync settled");
  assert.equal(r.timers.filter(Boolean).length, 1, "control: a retry was armed");
  r.retry.disarm();
  assert.equal(r.timers.filter(Boolean).length, 0, "disarm cancelled the pending retry");
  r.retry.stop();
  r.start();
  await until(() => r.settled() === 2, "second resync settled");
  assert.equal(hasFailedOrchEventQuery(r.qc), true, "control: still failing");
  assert.equal(r.timers.filter(Boolean).length, 0, "a stopped loop arms nothing");
  r.unsub();
});

await check("resyncOrchEvents: an INACTIVE errored list plus a healthy active one arms no retry (invalidate never re-reads inactive lists)", async () => {
  const qc = new QueryClient();
  // Inactive: no observer, left in error state by a past failed read.
  await qc.fetchQuery({ queryKey: ["orchEvents", "gone"], retry: false, queryFn: async () => { throw new Error("old failure"); } }).catch(() => {});
  assert.equal(qc.getQueryState(["orchEvents", "gone"]).status, "error", "control: the inactive list really is in error state");
  // Active and healthy.
  const observer = new QueryObserver(qc, { queryKey: ["orchEvents", "live"], staleTime: Infinity, retry: false, queryFn: async () => [ev("a", "live")] });
  const unsub = observer.subscribe(() => {});
  await until(() => qc.getQueryState(["orchEvents", "live"])?.status === "success", "active list read");
  const timers = [];
  const retry = createRetryLoop({ setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, backoff: { next: () => 1, reset: () => {} } });
  let settled = 0;
  resyncOrchEvents(qc, { retry, isCurrent: () => true, onSettled: () => { settled++; }, again: () => {} });
  await until(() => settled === 1, "resync settled");
  assert.equal(qc.getQueryState(["orchEvents", "gone"]).status, "error", "control: the resync did not touch the inactive list");
  assert.equal(hasFailedOrchEventQuery(qc), false);
  assert.equal(timers.length, 0, "no retry armed");
  unsub();
});

console.log(`\n${pass} passed`);
