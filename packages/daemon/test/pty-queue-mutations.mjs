// Deterministic test for the human-facing queue mutators on PtyHost — deleteQueued / editQueued /
// reorderQueued (the #composer-queue feature). All three are id-addressed and SYNCHRONOUS (they only
// touch live.pending — no pty write, no submit), so they must:
//   - delete / edit / reorder a SPECIFIC entry by its stable id, preserving FIFO for the rest;
//   - be a graceful NO-OP for an unknown / already-drained id (the whole reason ids exist — an array
//     index would silently hit the wrong, shifted entry);
//   - SOURCE GATE: touch ONLY a 'human' entry; an op on a 'system' entry (worker report / nudge) is
//     REFUSED (returns false WITH refused:true) and leaves the entry intact — so an agent's queued
//     message can never be rewritten or reordered out from under it;
//   - reorder only permutes HUMAN entries, leaving every 'system' entry pinned to its FIFO slot;
//   - preserve any human entry NOT named in a reorder (e.g. one enqueued after the client's snapshot);
//   - leave the FIFO DRAIN order following the (possibly reordered) queue;
//   - and the existing stop()-clears-the-queue invariant must still hold.
// Also covers the source TAGGING at enqueue: the default is 'system' (every programmatic caller), and
// only an explicit 'human' (the REST composer) marks an entry adjustable.
//
// Like pty-busy-drain.mjs this drives the REAL PtyHost state machine against a FAKE pty injected via
// the createPty() seam — NO real claude, NO ~/.claude.json trust writes, no daemon, no network.
//
// RUN (no daemon needed): node test/pty-queue-mutations.mjs   (build the daemon first — reads ../dist).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-ptyqueue-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const SID = "sess-queue";

host.spawn({
  sessionId: SID, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];
host.deliverHook(SID, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 → synchronous)

const texts = () => host.getPending(SID);                          // string[] back-compat view (service.ts contract)
const entries = () => host.getPendingEntries(SID);                 // {id,text,source}[] UI view
const idOf = (t) => entries().find((e) => e.text === t)?.id;       // robust id lookup by text
const srcOf = (t) => entries().find((e) => e.text === t)?.source;
const written = () => fake.writes.join("");
const countOf = (marker) => written().split(marker).length - 1;

try {
  // ---- arrange: PRIMER delivers immediately (arms busy); then an INTERLEAVED human/system queue ----
  const primer = host.enqueueStdin(SID, "PRIMER"); // idle → submits now, arms busy=true
  check("setup: primer delivered + armed busy", primer.delivered === true);
  host.enqueueStdin(SID, "AAA", "human");
  host.enqueueStdin(SID, "SYS1");          // NO source arg → defaults to 'system'
  host.enqueueStdin(SID, "BBB", "human");
  host.enqueueStdin(SID, "CCC", "human");
  check("setup: queue is [AAA,SYS1,BBB,CCC]", JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "BBB", "CCC"]));

  // ---- SOURCE TAGGING: explicit 'human' marks human; the default (no arg) is 'system' ----
  check("source: explicit 'human' arg → source:'human'", srcOf("AAA") === "human" && srcOf("BBB") === "human");
  check("source: default (no arg) → source:'system'", srcOf("SYS1") === "system");
  const es = entries();
  check("getPendingEntries returns {id,text,source} with stable ids",
    es.length === 4 && es.every((e) => typeof e.id === "string" && e.id.length > 0 && typeof e.text === "string" && (e.source === "human" || e.source === "system")));

  // ---- EDIT: change a HUMAN entry BBB → ZZZ in place (id + FIFO position preserved, body changes) ----
  const idB = idOf("BBB");
  const ed = host.editQueued(SID, idB, "ZZZ");
  check("edit human: returns {edited:true}", ed.edited === true);
  check("edit human: text changed in place, FIFO held → [AAA,SYS1,ZZZ,CCC]", JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ", "CCC"]));
  check("edit human: the entry's id is unchanged (still idB)", idOf("ZZZ") === idB);

  // ---- DELETE: remove a HUMAN entry CCC by id; the rest keep FIFO order ----
  const del = host.deleteQueued(SID, idOf("CCC"));
  check("delete human: returns {deleted:true}", del.deleted === true);
  check("delete human: queue is now [AAA,SYS1,ZZZ]", JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ"]));

  // ---- unknown / already-drained id = graceful no-op: plain false, NO refused flag (not a boundary hit) ----
  const dUnknown = host.deleteQueued(SID, "no-such-id");
  check("delete unknown id: {deleted:false}, NO refused, queue unchanged",
    dUnknown.deleted === false && dUnknown.refused === undefined && JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ"]));
  const eUnknown = host.editQueued(SID, "no-such-id", "NOPE");
  check("edit unknown id: {edited:false}, NO refused, queue unchanged",
    eUnknown.edited === false && eUnknown.refused === undefined && JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ"]));

  // ---- SOURCE GATE: a mutator REFUSES a 'system' entry (refused:true) and leaves it untouched ----
  const idSys = idOf("SYS1");
  const dSys = host.deleteQueued(SID, idSys);
  check("delete system: REFUSED {deleted:false, refused:true}, queue unchanged",
    dSys.deleted === false && dSys.refused === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ"]));
  const eSys = host.editQueued(SID, idSys, "HACKED");
  check("edit system: REFUSED {edited:false, refused:true}, text still 'SYS1'",
    eSys.edited === false && eSys.refused === true && srcOf("SYS1") === "system" && idOf("SYS1") === idSys);
  const roSys = host.reorderQueued(SID, [idSys, idOf("AAA")]); // names a system id → whole op refused
  check("reorder naming a system id: REFUSED {reordered:false, refused:true}, queue unchanged",
    roSys.reordered === false && roSys.refused === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ"]));

  // ---- REORDER: permute HUMAN entries only; the 'system' entry holds its absolute slot ----
  // current [AAA(h,0), SYS1(s,1), ZZZ(h,2)] → human order [ZZZ, AAA] → [ZZZ, SYS1, AAA]
  const ro = host.reorderQueued(SID, [idOf("ZZZ"), idOf("AAA")]);
  check("reorder human: returns {reordered:true}", ro.reordered === true);
  check("reorder human: applied, system slot pinned → [ZZZ,SYS1,AAA]", JSON.stringify(texts()) === JSON.stringify(["ZZZ", "SYS1", "AAA"]));
  check("reorder human: SYS1 still at its slot (index 1)", texts()[1] === "SYS1");

  // ---- reorder PRESERVES an un-named HUMAN entry (e.g. one enqueued after the client's snapshot) ----
  host.enqueueStdin(SID, "EEE", "human"); // appended → [ZZZ,SYS1,AAA,EEE]
  const ro2 = host.reorderQueued(SID, [idOf("AAA")]); // names only AAA; ZZZ + EEE un-named human, SYS1 pinned
  check("reorder subset: named human first, un-named human preserved, system pinned → [AAA,SYS1,ZZZ,EEE]",
    ro2.reordered === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "SYS1", "ZZZ", "EEE"]));

  // ---- DRAIN follows the reordered FIFO: a Stop drains the head (AAA), one per turn boundary ----
  const idA = idOf("AAA"); // capture before it drains, for the already-drained no-op below
  check("pre-drain: nothing from the queue written yet", countOf("AAA") === 0);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("drain: Stop drained the reordered head AAA exactly once", countOf("AAA") === 1);
  check("drain: queue advanced to [SYS1,ZZZ,EEE]", JSON.stringify(texts()) === JSON.stringify(["SYS1", "ZZZ", "EEE"]));
  const dDrained = host.deleteQueued(SID, idA);
  check("drain: deleting an ALREADY-DRAINED human id is a safe no-op (false, no refused)", dDrained.deleted === false && dDrained.refused === undefined);

  // ---- stop() still CLEARS the held queue (the stop-vs-queued-turn invariant) ----
  check("pre-stop: queue non-empty", texts().length === 3);
  host.stop(SID, "graceful");
  check("stop() cleared the held queue", host.getPending(SID).length === 0 && host.getPendingEntries(SID).length === 0);

  // ---- mutators on a dead/unknown session are safe (false), never a throw ----
  check("mutators on unknown session: all false, no throw",
    host.deleteQueued("nope", "x").deleted === false && host.editQueued("nope", "x", "y").edited === false && host.reorderQueued("nope", []).reordered === false);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — queue mutators target one entry by id, no-op on stale ids, REFUSE system entries, permute only human entries (system slots pinned), preserve FIFO + drain order, and stop() still clears."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
