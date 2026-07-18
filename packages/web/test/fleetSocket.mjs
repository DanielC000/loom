// Hermetic unit test for the /ws/fleet delta reducer in src/lib/fleetSocket.ts (C4 of the WS delta-push
// umbrella 1efde4ba — the shared-fleet-store card). No socket, no DOM: it imports the pure TS source
// directly via Node's type stripping and asserts on plain objects, so it exercises the REAL shipped
// reducer FleetSocketProvider.tsx applies to the ["allSessions"] cache on every inbound ServerFleetMessage.
//
// Like fleet.mjs/archive-invalidate.mjs, the web package has no test runner, so this is a self-contained
// node script, wired into @loom/web's `build` script (which `run_gate` runs via `pnpm build`). Run it
// standalone with:
//   node --experimental-strip-types packages/web/test/fleetSocket.mjs
import assert from "node:assert/strict";
import { applyFleetDelta } from "../src/lib/fleetSocket.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// Minimal SessionListItem-shaped fixture — only the fields the reducer reads (id, lastActivity) plus a
// couple more so a row looks plausible in the assertions below.
const row = (id, lastActivity, extra = {}) => ({ id, lastActivity, title: `session ${id}`, ...extra });
const upsert = (session) => ({ t: "session:upsert", session });
const remove = (id) => ({ t: "session:remove", id });

check("session:upsert inserts a new row when the id isn't present", () => {
  const seed = [row("a", "2026-07-18T00:00:00.000Z")];
  const next = applyFleetDelta(seed, upsert(row("b", "2026-07-18T00:00:01.000Z")));
  assert.equal(next.length, 2);
  assert.ok(next.some((s) => s.id === "b"));
  assert.equal(seed.length, 1, "the input array is never mutated");
});

check("session:upsert replaces the row with a matching id in place", () => {
  const seed = [row("a", "2026-07-18T00:00:00.000Z", { busy: false }), row("b", "2026-07-18T00:00:01.000Z")];
  const next = applyFleetDelta(seed, upsert(row("a", "2026-07-18T00:00:02.000Z", { busy: true })));
  assert.equal(next.length, 2, "same id → replace, not insert");
  const a = next.find((s) => s.id === "a");
  assert.equal(a.busy, true, "the replaced row carries the new fields");
});

check("session:upsert re-sorts the result by lastActivity DESC (matches listAllSessions' order)", () => {
  const seed = [row("a", "2026-07-18T00:00:03.000Z"), row("b", "2026-07-18T00:00:01.000Z")];
  // Bump "b" to the most recent activity — it should now sort first.
  const next = applyFleetDelta(seed, upsert(row("b", "2026-07-18T00:00:05.000Z")));
  assert.deepEqual(next.map((s) => s.id), ["b", "a"]);
});

check("session:upsert of a brand-new row also lands in DESC order, not just appended", () => {
  const seed = [row("a", "2026-07-18T00:00:03.000Z"), row("b", "2026-07-18T00:00:01.000Z")];
  const next = applyFleetDelta(seed, upsert(row("c", "2026-07-18T00:00:10.000Z")));
  assert.deepEqual(next.map((s) => s.id), ["c", "a", "b"]);
});

check("session:remove drops the row by id", () => {
  const seed = [row("a", "2026-07-18T00:00:00.000Z"), row("b", "2026-07-18T00:00:01.000Z")];
  const next = applyFleetDelta(seed, remove("a"));
  assert.deepEqual(next.map((s) => s.id), ["b"]);
});

check("session:remove of an unknown id is a no-op (same-reference return)", () => {
  const seed = [row("a", "2026-07-18T00:00:00.000Z")];
  const next = applyFleetDelta(seed, remove("does-not-exist"));
  assert.equal(next, seed, "no matching row → the exact same array reference comes back");
});

check("a non-session:* message (hello/status/event) is ignored — same-reference return", () => {
  const seed = [row("a", "2026-07-18T00:00:00.000Z")];
  assert.equal(applyFleetDelta(seed, { t: "hello", v: 1 }), seed);
  assert.equal(applyFleetDelta(seed, { t: "status", pausedScopes: [], schedulerEnabled: true }), seed);
  assert.equal(applyFleetDelta(seed, { t: "event", managerId: "m", event: { kind: "worker_report", seq: 1 } }), seed);
});

console.log(`\n${pass} passed`);
