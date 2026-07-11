// Deterministic test for the human-facing queue mutators on PtyHost — deleteQueued / editQueued /
// reorderQueued (the #composer-queue feature). All three are id-addressed and SYNCHRONOUS (they only
// touch live.pending — no pty write, no submit), so they must:
//   - delete / edit / reorder a SPECIFIC entry by its stable id, preserving FIFO for the rest;
//   - be a graceful NO-OP for an unknown / already-drained id (the whole reason ids exist — an array
//     index would silently hit the wrong, shifted entry);
//   - MUTABILITY GATE, split by op: delete/reorder use isHumanMutable — act on a HUMAN-MUTABLE entry
//     (the human's OWN composed turns, source:'human', OR Loom's OWN operational nudges, kind:'warning',
//     e.g. [loom:worker-idle]) — but REFUSE an agent-AUTHORED entry (source:'system' + kind:'agent' — a
//     worker report / manager direction), returning false WITH refused:true and leaving it intact, so an
//     agent's queued message can never be deleted or reordered out from under it (owner-directed
//     2026-07-11: the human owns the daemon, so both their own and Loom's own queued text are theirs to
//     clear — but another agent's is not). EDIT uses the NARROWER isHumanEditable (source:'human' ONLY):
//     a Loom kind:'warning' nudge is delete/reorder-able but its wording is Loom's, not the human's, so
//     editQueued REFUSES it too — matching the web UI's isEditable = source === 'human';
//   - reorder permutes MUTABLE entries (human + warning) only, leaving every agent-authored entry pinned;
//   - preserve any mutable entry NOT named in a reorder (e.g. one enqueued after the client's snapshot);
//   - leave the FIFO DRAIN order following the (possibly reordered) queue;
//   - and the existing stop()-clears-the-queue invariant must still hold.
// Also covers the source + kind TAGGING at enqueue: the default is source:'system' + kind:'warning'
// (a Loom nudge), an explicit 'human' marks the composer, and an explicit kind:'agent' marks an
// agent-authored message; getPendingEntries now surfaces {id,text,source,kind} for the UI.
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
const entries = () => host.getPendingEntries(SID);                 // {id,text,source,kind}[] UI view
const idOf = (t) => entries().find((e) => e.text === t)?.id;       // robust id lookup by text
const srcOf = (t) => entries().find((e) => e.text === t)?.source;
const kindOf = (t) => entries().find((e) => e.text === t)?.kind;
const written = () => fake.writes.join("");
const countOf = (marker) => written().split(marker).length - 1;

try {
  // ---- arrange: PRIMER delivers immediately (arms busy); then an INTERLEAVED queue of all THREE species:
  //   AAA/BBB/CCC = human (composer); WARN1 = Loom nudge (system + warning); AGT1 = agent-authored
  //   (system + agent — a worker report / manager direction). ----
  const primer = host.enqueueStdin(SID, "PRIMER"); // idle → submits now, arms busy=true
  check("setup: primer delivered + armed busy", primer.delivered === true);
  host.enqueueStdin(SID, "AAA", "human");
  host.enqueueStdin(SID, "WARN1");         // NO source/kind args → defaults to system + warning (a [loom:*] nudge)
  host.enqueueStdin(SID, "AGT1", "system", undefined, undefined, "agent"); // agent-authored — the protected class
  host.enqueueStdin(SID, "BBB", "human");
  host.enqueueStdin(SID, "CCC", "human");
  check("setup: queue is [AAA,WARN1,AGT1,BBB,CCC]", JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "BBB", "CCC"]));

  // ---- SOURCE + KIND TAGGING: explicit 'human' marks human; the default (no arg) is system+warning; an
  //      explicit kind:'agent' marks an agent-authored system entry. ----
  check("tag: explicit 'human' arg → source:'human'", srcOf("AAA") === "human" && srcOf("BBB") === "human");
  check("tag: default (no arg) → source:'system' + kind:'warning' (a Loom nudge)", srcOf("WARN1") === "system" && kindOf("WARN1") === "warning");
  check("tag: explicit kind:'agent' → source:'system' + kind:'agent' (agent-authored)", srcOf("AGT1") === "system" && kindOf("AGT1") === "agent");
  const es = entries();
  check("getPendingEntries returns {id,text,source,kind} with stable ids",
    es.length === 5 && es.every((e) => typeof e.id === "string" && e.id.length > 0 && typeof e.text === "string"
      && (e.source === "human" || e.source === "system") && (e.kind === "warning" || e.kind === "agent")));

  // ---- EDIT: change a HUMAN entry BBB → ZZZ in place (id + FIFO position preserved, body changes) ----
  const idB = idOf("BBB");
  const ed = host.editQueued(SID, idB, "ZZZ");
  check("edit human: returns {edited:true}", ed.edited === true);
  check("edit human: text changed in place, FIFO held → [AAA,WARN1,AGT1,ZZZ]", JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ", "CCC"]));
  check("edit human: the entry's id is unchanged (still idB)", idOf("ZZZ") === idB);

  // ---- DELETE: remove a HUMAN entry CCC by id; the rest keep FIFO order ----
  const del = host.deleteQueued(SID, idOf("CCC"));
  check("delete human: returns {deleted:true}", del.deleted === true);
  check("delete human: queue is now [AAA,WARN1,AGT1,ZZZ]", JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));

  // ---- unknown / already-drained id = graceful no-op: plain false, NO refused flag (not a boundary hit) ----
  const dUnknown = host.deleteQueued(SID, "no-such-id");
  check("delete unknown id: {deleted:false}, NO refused, queue unchanged",
    dUnknown.deleted === false && dUnknown.refused === undefined && JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));
  const eUnknown = host.editQueued(SID, "no-such-id", "NOPE");
  check("edit unknown id: {edited:false}, NO refused, queue unchanged",
    eUnknown.edited === false && eUnknown.refused === undefined && JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));

  // ---- AGENT-AUTHORED GATE: a mutator REFUSES an agent-authored entry (AGT1) and leaves it untouched ----
  const idAgt = idOf("AGT1");
  const dAgt = host.deleteQueued(SID, idAgt);
  check("delete agent-authored: REFUSED {deleted:false, refused:true}, queue unchanged",
    dAgt.deleted === false && dAgt.refused === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));
  const eAgt = host.editQueued(SID, idAgt, "HACKED");
  check("edit agent-authored: REFUSED {edited:false, refused:true}, text still 'AGT1'",
    eAgt.edited === false && eAgt.refused === true && kindOf("AGT1") === "agent" && idOf("AGT1") === idAgt);
  const roAgt = host.reorderQueued(SID, [idAgt, idOf("AAA")]); // names an agent id → whole op refused
  check("reorder naming an agent id: REFUSED {reordered:false, refused:true}, queue unchanged",
    roAgt.reordered === false && roAgt.refused === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));

  // ---- WARNING IS DELETE/REORDER-MUTABLE BUT NOT EDITABLE (the fix): a Loom nudge (WARN1) is
  //      deletable/reorderable exactly like a human entry (the human owns the daemon, so Loom's own
  //      queued text is theirs to clear/reposition) — but its WORDING is Loom's, not the human's, so
  //      editQueued REFUSES to rewrite it, matching the web UI's isEditable = source === 'human'. ----
  const idW = idOf("WARN1");
  const eW = host.editQueued(SID, idW, "WARN1x");
  check("edit warning: REFUSED {edited:false, refused:true}, text still 'WARN1', queue unchanged",
    eW.edited === false && eW.refused === true && kindOf("WARN1") === "warning" && idOf("WARN1") === idW && JSON.stringify(texts()) === JSON.stringify(["AAA", "WARN1", "AGT1", "ZZZ"]));

  // ---- REORDER: permute MUTABLE entries (human + warning) only; the agent-authored entry holds its slot.
  // current [AAA(h,0), WARN1(w,1), AGT1(a,2), ZZZ(h,3)] → mutable slots {0,1,3}; desired mutable order
  // [ZZZ, AAA, WARN1] fills them → [ZZZ, AAA, AGT1, WARN1] (AGT1 pinned at index 2). ----
  const ro = host.reorderQueued(SID, [idOf("ZZZ"), idOf("AAA"), idOf("WARN1")]);
  check("reorder mutable: returns {reordered:true}", ro.reordered === true);
  check("reorder mutable: applied across human+warning, agent slot pinned → [ZZZ,AAA,AGT1,WARN1]", JSON.stringify(texts()) === JSON.stringify(["ZZZ", "AAA", "AGT1", "WARN1"]));
  check("reorder mutable: AGT1 still pinned at its slot (index 2)", texts()[2] === "AGT1");

  // ---- DELETE a WARNING by id (the owner's actual complaint: a [loom:worker-idle] they couldn't remove) ----
  const dW = host.deleteQueued(SID, idOf("WARN1"));
  check("delete warning: ALLOWED {deleted:true}, queue is now [ZZZ,AAA,AGT1]",
    dW.deleted === true && dW.refused === undefined && JSON.stringify(texts()) === JSON.stringify(["ZZZ", "AAA", "AGT1"]));

  // ---- reorder PRESERVES an un-named MUTABLE entry (e.g. one enqueued after the client's snapshot) ----
  host.enqueueStdin(SID, "EEE", "human"); // appended → [ZZZ,AAA,AGT1,EEE]
  const ro2 = host.reorderQueued(SID, [idOf("AAA")]); // names only AAA; ZZZ + EEE un-named mutable, AGT1 pinned
  check("reorder subset: named mutable first, un-named mutable preserved, agent pinned → [AAA,ZZZ,AGT1,EEE]",
    ro2.reordered === true && JSON.stringify(texts()) === JSON.stringify(["AAA", "ZZZ", "AGT1", "EEE"]));

  // ---- DRAIN follows the reordered FIFO. The queue now MIXES kinds ([AAA,ZZZ,AGT1,EEE] — AGT1 is
  //      kind:'agent', which drains ONE-per-turn, while the warning/human entries coalesce), so drive Stops
  //      until it empties and assert the cumulative written order still tracks the reordered FIFO. ----
  const idA = idOf("AAA"); // capture before it drains, for the already-drained no-op below
  check("pre-drain: nothing from the queue written yet", countOf("AAA") === 0);
  for (let i = 0; i < 6 && texts().length > 0; i++) host.deliverHook(SID, { hook_event_name: "Stop" });
  check("drain: every reordered entry written exactly once", countOf("AAA") === 1 && countOf("ZZZ") === 1 && countOf("AGT1") === 1 && countOf("EEE") === 1);
  const turn = written();
  check("drain: reordered FIFO order preserved across the drains ([AAA,ZZZ,AGT1,EEE])",
    turn.indexOf("AAA") < turn.indexOf("ZZZ") && turn.indexOf("ZZZ") < turn.indexOf("AGT1") && turn.indexOf("AGT1") < turn.indexOf("EEE"));
  check("drain: queue fully emptied by the drains", texts().length === 0);
  const dDrained = host.deleteQueued(SID, idA);
  check("drain: deleting an ALREADY-DRAINED human id is a safe no-op (false, no refused)", dDrained.deleted === false && dDrained.refused === undefined);

  // ---- stop() still CLEARS the held queue (the stop-vs-queued-turn invariant) ----
  // Re-populate first (the coalesced drain above emptied the queue): enqueue while the drained turn
  // holds busy, so these are HELD, then assert stop() clears them.
  host.enqueueStdin(SID, "QQQ", "human");
  host.enqueueStdin(SID, "RRR", "human");
  check("pre-stop: queue non-empty (re-populated)", texts().length === 2);
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
  ? "\n✅ ALL PASS — queue mutators target one entry by id, no-op on stale ids; delete/reorder act on human + Loom-warning entries while edit is human-only (REFUSES a warning entry's text); all REFUSE agent-authored entries (pinned in reorder); preserve FIFO + drain order, and stop() still clears."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
