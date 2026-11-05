// Hermetic unit test for src/lib/orchEvents.ts (card 670b2081): the list math + cache patching behind the
// `/ws/fleet` orchestration-event push. No socket, no DOM; a REAL react-query QueryClient so the
// fetching-restart branch is exercised against the library's own state machine rather than a stub.
//   node --experimental-strip-types packages/web/test/orchEvents.mjs
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  EVENTS_BY_KIND_LIMIT, applyEventToList, applyOrchEvent, classifyOrchEventKey, invalidateOrchEventQueries,
} from "../src/lib/orchEvents.ts";

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

await check("applyOrchEvent: a MID-FETCH query (mounted observer) is re-read, so the pushed row survives a stale in-flight response", async () => {
  const qc = new QueryClient();
  const pushed = ev("a", "m1", "pushed");
  const server = [ev("a", "m1", "old")];
  let reads = 0;
  let release;
  let gate = new Promise((r) => { release = r; });
  const observer = new QueryObserver(qc, { queryKey: ["orchEvents", "m1"], staleTime: Infinity, queryFn: async () => { const snapshot = [...server]; reads++; await gate; return snapshot; } });
  const unsub = observer.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 0)); // observable: first read is now in flight
  assert.equal(reads, 1, "control: the first read started");
  qc.setQueryData(["orchEvents", "m1"], [ev("a", "m1", "old")]); // gives the query data while it stays fetching
  assert.equal(qc.getQueryState(["orchEvents", "m1"]).fetchStatus, "fetching", "control: the query is mid-fetch");
  server.push(pushed); // the row is committed server-side; the in-flight response (snapshot) predates it
  const next = new Promise((r) => { gate = Promise.resolve(); r(); });
  applyOrchEvent(qc, pushed);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(reads >= 2, "the stale in-flight read was superseded by a fresh one");
  assert.ok(qc.getQueryData(["orchEvents", "m1"]).some((x) => x.id === "pushed"), "the pushed row is present");
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

console.log(`\n${pass} passed`);
