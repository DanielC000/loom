// Card b9a7b5eb — FYI (no-action) notices are HELD, never a turn of their own, and ride the NEXT real turn.
//
// Drives the real PtyHost (enqueueStdin / drainPending / submit / reconcile / purge) against a FAKE pty via
// the createSeamHost seam: no real claude, no daemon, hermetic LOOM_HOME.
//   (1) a parked (idle, ready) session gets NO turn from an FYI — not on enqueue, not on reconcile();
//   (2) the next real turn carries it, FYI block FIRST and the real instruction LAST (immediate path);
//   (3) the Stop-drain path carries it too, and it is never absorbed into an agent/warning coalesce run
//       (two senders' directives still drain one-per-turn);
//   (4) a same-tag FYI supersedes the held older copy; the held list is count-capped (oldest first) and
//       TTL-swept; a dropped/expired entry never fires its onDeliver;
//   (5) the worker re-engage purge and the questionId purge reach a held FYI;
//   (6) onDeliver fires exactly when the FYI is bundled into a submitted turn (digest-stamp contract).
// RUN: node test/fyi-held-notice.mjs   (needs `pnpm --filter @loom/daemon build` first)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `lm-fyi-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, FYI_HELD_MAX_COUNT, FYI_HELD_TTL_MS, bundleFyiIntoTurn } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

const spawnReady = (sid) => {
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return fakes.get(sid);
};
const written = (f) => f.writes.join("");
const PASTE = "\x1b[200~";
const pastes = (f) => written(f).split(PASTE).length - 1;
const FYI_TAG = "[loom:fyi, no action needed]";
const fyiOpts = (extra = {}) => ({ fyi: true, ...extra });
const sendFyi = (sid, text, tag, onDeliver) => host.enqueueStdin(sid, text, "system", onDeliver, undefined, "warning", tag, undefined, undefined, undefined, fyiOpts());

try {
  // ============ (1) parked session: an FYI wakes nothing ============
  const SID = "fyi-parked";
  const f = spawnReady(SID);
  const r = sendFyi(SID, "[loom:worker-idle] worker W1 parked — no reply owed", "fyi:worker-idle:W1");
  check("(1) FYI to an idle ready session is HELD (queued, not delivered)", r.delivered === false && r.queued === true && r.deliveryState === "queued");
  check("(1) nothing was written to the pty (no turn started)", f.writes.length === 0);
  check("(1) session did NOT go busy", host.isBusy(SID) === false);
  check("(1) it is NOT in live.pending (so getPending / done-guard never see it)", host.getPending(SID).length === 0);
  check("(1) it IS in the held-FYI list", host.getHeldFyiEntries(SID).length === 1);
  host.reconcile();
  host.reconcile();
  check("(1) reconcile() ticks do not wake the parked session either", f.writes.length === 0 && host.getHeldFyiEntries(SID).length === 1);

  // ============ (2) next real turn carries it: FYI first, instruction last ============
  const delivered = [];
  sendFyi(SID, "[loom:project-memory] note A\nnote A line 2", "fyi:project-memory", () => delivered.push("mem"));
  check("(6) onDeliver has NOT fired while merely held", delivered.length === 0);
  const REAL = "REAL_INSTRUCTION_XYZ";
  const r2 = host.enqueueStdin(SID, REAL, "human", undefined, undefined, "agent");
  check("(2) the real message was delivered immediately", r2.delivered === true);
  const w = written(f);
  check("(2) exactly one turn (one paste) carried everything", pastes(f) === 1);
  check("(2) the FYI block label is present", w.includes(FYI_TAG));
  check("(2) the held idle notice rode the turn", w.includes("worker W1 parked"));
  check("(2) the multi-line memory entry rode verbatim", w.includes("note A\nnote A line 2"));
  check("(2) FYI block comes BEFORE the real instruction", w.indexOf(FYI_TAG) < w.indexOf(REAL) && w.indexOf("[/loom:fyi]") < w.indexOf(REAL));
  check("(2) the real instruction is LAST (nothing of the FYI block follows it)", w.lastIndexOf("worker W1 parked") < w.indexOf(REAL) && w.lastIndexOf("note A") < w.indexOf(REAL));
  check("(2) held list emptied", host.getHeldFyiEntries(SID).length === 0);
  check("(6) onDeliver has NOT fired merely because the turn was written (round 2: only on CONFIRM)", delivered.length === 0);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: REAL });
  check("(6) onDeliver fired on the turn's CONFIRM (UserPromptSubmit)", delivered.length === 1 && delivered[0] === "mem");
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: REAL });
  check("(6) a second confirm hook does not fire it again (exactly once)", delivered.length === 1);
  // The remaining turn text was recorded verbatim for a re-submit (lastPrompt carries the bundled turn).
  check("(2) bundleFyiIntoTurn with no FYI is the identity", bundleFyiIntoTurn([], "x") === "x");

  // ============ (3) Stop-drain path; never absorbed into a coalesce run; FYI alone never drains ============
  host.deliverHook(SID, { hook_event_name: "Stop" }); // busy -> false, nothing queued: must not start a turn
  const before = pastes(f);
  sendFyi(SID, "FYI_ONE_TEXT", "fyi:a");
  host.deliverHook(SID, { hook_event_name: "Stop" });
  host.reconcile();
  check("(3) a Stop with only a held FYI starts NO turn", pastes(f) === before);

  // Make the session busy with a real turn, queue two DIFFERENT senders' agent directives, then an FYI.
  host.enqueueStdin(SID, "TURN_ONE", "human", undefined, undefined, "agent");
  host.enqueueStdin(SID, "DIRECTIVE_S1", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-1");
  host.enqueueStdin(SID, "DIRECTIVE_S2", "system", undefined, undefined, "agent", undefined, undefined, undefined, "sender-2");
  sendFyi(SID, "FYI_TWO_TEXT", "fyi:b");
  check("(3) FYI never joins live.pending behind the directives", host.getPending(SID).length === 2);
  const p0 = pastes(f);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(3) first drain: ONE turn (sender-1's directive alone — cross-sender one-per-turn intact)", pastes(f) - p0 === 1);
  const tail = written(f).slice(written(f).lastIndexOf(PASTE));
  check("(3) the drained turn carries the later FYI block ahead of DIRECTIVE_S1", tail.includes(FYI_TAG) && tail.includes("FYI_TWO_TEXT") && tail.indexOf(FYI_TAG) < tail.indexOf("DIRECTIVE_S1"));
  // FYI_ONE was held BEFORE TURN_ONE, so TURN_ONE's immediate submit (pending empty) took it — not this drain.
  check("(3) FYI_ONE rode TURN_ONE's own immediate turn, not the drain", !tail.includes("FYI_ONE_TEXT") && written(f).indexOf("FYI_ONE_TEXT") < written(f).indexOf("TURN_ONE"));
  check("(3) sender-2's directive was NOT mashed into that turn", !tail.includes("DIRECTIVE_S2"));
  host.deliverHook(SID, { hook_event_name: "Stop" });
  const tail2 = written(f).slice(written(f).lastIndexOf(PASTE));
  check("(3) second drain delivers DIRECTIVE_S2 as its own turn, with no second FYI block", tail2.includes("DIRECTIVE_S2") && !tail2.includes(FYI_TAG));

  // ============ (4) supersede / cap / TTL ============
  const SID4 = "fyi-caps";
  const f4 = spawnReady(SID4);
  const dropped = [];
  sendFyi(SID4, "OLD_COPY", "fyi:worker-idle:W9", () => dropped.push("old"));
  sendFyi(SID4, "NEW_COPY", "fyi:worker-idle:W9", () => dropped.push("new"));
  const held4 = host.getHeldFyiEntries(SID4);
  check("(4) a same-tag FYI supersedes the held older copy", held4.length === 1 && held4[0].text === "NEW_COPY");
  for (let i = 0; i < FYI_HELD_MAX_COUNT + 3; i++) sendFyi(SID4, `CAP_${i}`, `fyi:cap:${i}`);
  const capped = host.getHeldFyiEntries(SID4);
  check("(4) the held list is count-capped", capped.length === FYI_HELD_MAX_COUNT);
  check("(4) oldest dropped first (newest survives, the earliest are gone)", capped[capped.length - 1].text === `CAP_${FYI_HELD_MAX_COUNT + 2}` && !capped.some((e) => e.text === "NEW_COPY" || e.text === "CAP_0"));
  // TTL sweep: a reconcile far in the future drops everything; an expired entry never fires onDeliver.
  const live4 = host.live.get(SID4);
  host.expireHeldFyi(live4, Date.now() + FYI_HELD_TTL_MS + 1000);
  check("(4) TTL sweep drops every aged-out held FYI", host.getHeldFyiEntries(SID4).length === 0);
  check("(4)/(6) neither a superseded nor an expired entry ever fired onDeliver", dropped.length === 0);
  // ...and a still-fresh entry survives the same sweep.
  sendFyi(SID4, "FRESH", "fyi:fresh");
  host.expireHeldFyi(live4, Date.now() + FYI_HELD_TTL_MS - 60_000);
  check("(4) a not-yet-aged entry survives the TTL sweep", host.getHeldFyiEntries(SID4).length === 1);

  // ============ (5) purges reach a held FYI ============
  const SID5 = "fyi-purge";
  const f5 = spawnReady(SID5);
  sendFyi(SID5, "[loom:worker-idle] worker WORKER5 (task t) reported worker_report(done) and is parked — no reply owed", "fyi:worker-idle:WORKER5");
  sendFyi(SID5, "[loom:worker-idle] worker OTHER6 parked — no reply owed", "fyi:worker-idle:OTHER6");
  const removed = host.purgeQueuedWorkerIdleNudges(SID5, "WORKER5");
  check("(5) the worker re-engage purge drops that worker's held idle FYI", removed.length === 1 && host.getHeldFyiEntries(SID5).length === 1);
  check("(5) ...and leaves another worker's held FYI alone", host.getHeldFyiEntries(SID5)[0].text.includes("OTHER6"));
  const removed2 = host.purgeQueuedByQuestionIds(SID5, ["fyi:worker-idle:OTHER6"]);
  check("(5) the questionId purge drops a held FYI by tag", removed2.length === 1 && host.getHeldFyiEntries(SID5).length === 0);
  check("(5) purging never wrote a turn", f5.writes.length === 0);

  // ============ (7) slash-command turns never carry the FYI block (round 2 BLOCKER) ============
  const SID7 = "fyi-slash";
  const f7 = spawnReady(SID7);
  sendFyi(SID7, "SLASH_HELD_FYI", "fyi:slash");
  const r7 = host.enqueueStdin(SID7, "/compact", "human", undefined, undefined, "agent");
  check("(7) the slash command itself was delivered immediately", r7.delivered === true);
  const w7 = written(f7);
  check("(7) the written turn is the bare command (no FYI block ahead of it)", w7.includes("/compact") && !w7.includes(FYI_TAG) && !w7.includes("SLASH_HELD_FYI"));
  check("(7) the FYI stays HELD after a slash turn", host.getHeldFyiEntries(SID7).length === 1);
  host.deliverHook(SID7, { hook_event_name: "Stop" });
  const r7b = host.enqueueStdin(SID7, "  /clear", "system", undefined, undefined, "agent");
  check("(7) a leading-whitespace slash command (companion /new -> /clear shape) also skips the bundle", r7b.delivered === true && !written(f7).slice(w7.length).includes(FYI_TAG) && host.getHeldFyiEntries(SID7).length === 1);
  host.deliverHook(SID7, { hook_event_name: "Stop" });
  // drain path: busy session, a queued slash entry drained on Stop
  host.enqueueStdin(SID7, "BUSY_TURN", "human", undefined, undefined, "agent"); // immediate; takes the held FYI (ordinary turn)
  check("(7) an ordinary turn after the slash turns DOES carry the held FYI", written(f7).slice(w7.length).includes("SLASH_HELD_FYI"));
  host.deliverHook(SID7, { hook_event_name: "UserPromptSubmit", prompt: "BUSY_TURN" });
  sendFyi(SID7, "SLASH_HELD_FYI_2", "fyi:slash2");
  host.enqueueStdin(SID7, "/compact", "human", undefined, undefined, "agent"); // busy -> queued
  const p7 = written(f7).length;
  host.deliverHook(SID7, { hook_event_name: "Stop" });
  check("(7) drain path: a queued slash command is written bare and the FYI stays held", written(f7).slice(p7).includes("/compact") && !written(f7).slice(p7).includes(FYI_TAG) && host.getHeldFyiEntries(SID7).length === 1);

  // ============ (8) give-up: bundled FYI goes BACK on heldFyi, never stamped, no duplicates ============
  const SID8 = "fyi-giveup";
  const f8 = spawnReady(SID8);
  const stamped8 = [];
  sendFyi(SID8, "GU_FYI_A", "fyi:gu:a", () => stamped8.push("a"));
  sendFyi(SID8, "GU_FYI_B", "fyi:gu:b", () => stamped8.push("b"));
  host.enqueueStdin(SID8, "GU_REAL_TURN", "human", undefined, undefined, "agent");
  check("(8) both FYIs were bundled into the turn", written(f8).includes("GU_FYI_A") && written(f8).includes("GU_FYI_B") && host.getHeldFyiEntries(SID8).length === 0);
  check("(8) not stamped when merely written", stamped8.length === 0);
  const live8 = host.live.get(SID8);
  host.requeueGiveUpOrigin(SID8, live8.submitGeneration); // the give-up recovery for the unconfirmed turn
  const reheld = host.getHeldFyiEntries(SID8).map((e) => e.text);
  check("(8) give-up put BOTH FYIs back on heldFyi, in order", reheld.length === 2 && reheld[0] === "GU_FYI_A" && reheld[1] === "GU_FYI_B");
  check("(8) the give-up did NOT stamp them", stamped8.length === 0);
  host.requeueGiveUpOrigin(SID8, live8.submitGeneration); // a second recovery on the same (already-cleared) state must not duplicate
  check("(8) no duplicate re-hold", host.getHeldFyiEntries(SID8).length === 2);
  check("(8) a late confirm for the abandoned turn does not stamp the re-held FYIs", (host.deliverHook(SID8, { hook_event_name: "Stop" }), stamped8.length === 0));

  // ============ (9) Enter-only / no-body redelivery never takes held FYIs; lastPrompt matches the write ============
  const SID9 = "fyi-enteronly";
  const f9 = spawnReady(SID9);
  const live9 = host.live.get(SID9);
  host.enqueueStdin(SID9, "EO_FIRST", "human", undefined, undefined, "agent");
  host.requeueGiveUpOrigin(SID9, live9.submitGeneration); // EO_FIRST re-queued, its lineage marked given-up
  const queued9 = live9.pending[0];
  queued9.giveUpHeldUntil = 0; // release the hold so the drain may redeliver
  live9.composerDirtyLen = 10; live9.composerLen = 0; live9.composerOwnerLineage = new Set([queued9.logicalId]);
  sendFyi(SID9, "EO_FYI", "fyi:eo"); // held BEFORE the drain that re-delivers EO_FIRST
  check("(9) precondition: the re-queued entry is pending and its lineage is marked given-up", live9.pending.length === 1 && live9.giveUpLineages.has(queued9.logicalId));
  const before9 = written(f9).length;
  const log9 = [];
  const origLog9 = console.log;
  console.log = (...a) => { log9.push(a.join(" ")); };
  // No Stop hook here: a Stop is itself a confirm signal that would PURGE the requeued entry instead of redelivering it.
  live9.busy = false;
  try { host.drainPending(SID9); } finally { console.log = origLog9; } // drain re-delivers the given-up entry
  check("(9) precondition: the drain took the Enter-only redelivery branch (a real no-body redelivery)", log9.some((l) => l.includes("retrying the Enter only")));
  check("(9) Enter-only redelivery: the held FYI was NOT taken", host.getHeldFyiEntries(SID9).length === 1);
  check("(9) Enter-only redelivery wrote no FYI body", !written(f9).slice(before9).includes("EO_FYI"));
  check("(9) lastPrompt carries no FYI text (equals what was actually written)", !live9.lastPrompt.includes("EO_FYI") && !live9.lastPrompt.includes(FYI_TAG));
  check("(9) nothing bundled was tracked", !live9.bundledFyi);

  // ============ (10) ownership-mismatch no-body give-up never takes held FYIs either ============
  const SID10 = "fyi-mismatch";
  const f10 = spawnReady(SID10);
  const live10 = host.live.get(SID10);
  host.enqueueStdin(SID10, "MM_FIRST", "human", undefined, undefined, "agent");
  host.requeueGiveUpOrigin(SID10, live10.submitGeneration);
  const queued10 = live10.pending[0];
  queued10.giveUpHeldUntil = 0;
  live10.composerDirtyLen = 10; live10.composerLen = 0; live10.composerOwnerLineage = new Set(["some-other-lineage"]);
  sendFyi(SID10, "MM_FYI", "fyi:mm");
  const before10 = written(f10).length;
  const log10 = [];
  const origErr10 = console.error;
  console.error = (...a) => { log10.push(a.join(" ")); };
  live10.busy = false;
  try { host.drainPending(SID10); } finally { console.error = origErr10; }
  check("(10) precondition: the drain took the ownership-mismatch no-write branch", log10.some((l) => l.includes("composer ownership mismatch, no write attempted")));
  check("(10) ownership-mismatch give-up: the held FYI was NOT taken", host.getHeldFyiEntries(SID10).length === 1);
  check("(10) nothing written", !written(f10).slice(before10).includes("MM_FYI"));
  check("(10) nothing bundled was tracked", !live10.bundledFyi);

  // ============ (11) supersede: a bundled record whose turn never confirmed is RE-HELD, never stamped ============
  const SID11 = "fyi-supersede";
  const f11 = spawnReady(SID11);
  const live11 = host.live.get(SID11);
  const stamped11 = [];
  sendFyi(SID11, "SUP_FYI", "fyi:sup", () => stamped11.push("sup"));
  host.enqueueStdin(SID11, "SUP_TURN_A", "human", undefined, undefined, "agent");
  check("(11) precondition: FYI bundled into turn A and tracked", written(f11).includes("SUP_FYI") && live11.bundledFyi && live11.bundledFyi.held.length === 1);
  host.submit(SID11, "SUP_TURN_B", undefined, undefined, undefined, undefined, "immediate"); // a newer generation starts with neither a confirm nor a give-up
  host.trackBundledFyi(live11, []);
  check("(11) the superseded FYI was re-held", host.getHeldFyiEntries(SID11).map((e) => e.text).join() === "SUP_FYI");
  check("(11) the superseded FYI was NOT stamped delivered", stamped11.length === 0);
  check("(11) the superseded record is cleared", !live11.bundledFyi);

  // ============ (12) confirm: Stop alone (UserPromptSubmit lost) stamps; the generation guard refuses a stale confirm ============
  const SID12 = "fyi-confirm";
  spawnReady(SID12);
  const live12 = host.live.get(SID12);
  const stamped12 = [];
  sendFyi(SID12, "CF_FYI", "fyi:cf", () => stamped12.push("cf"));
  host.enqueueStdin(SID12, "CF_TURN", "human", undefined, undefined, "agent");
  host.deliverHook(SID12, { hook_event_name: "Stop" }); // no UserPromptSubmit ever arrived
  check("(12) a Stop alone confirms the bundled turn: onDeliver fired exactly once", stamped12.length === 1);
  host.deliverHook(SID12, { hook_event_name: "Stop" });
  check("(12) a second Stop does not re-fire it", stamped12.length === 1);
  sendFyi(SID12, "CF_FYI2", "fyi:cf2", () => stamped12.push("cf2"));
  host.enqueueStdin(SID12, "CF_TURN2", "human", undefined, undefined, "agent");
  live12.submitGeneration += 1; // the record now belongs to an OLDER generation
  host.confirmBundledFyi(live12);
  check("(12) confirm generation guard: a stale-generation confirm stamps nothing", stamped12.length === 1 && !!live12.bundledFyi);
  host.reholdBundledFyi(live12, live12.bundledFyi.gen + 1);
  check("(12) rehold generation guard: a give-up of a different generation leaves the record alone", !!live12.bundledFyi && host.getHeldFyiEntries(SID12).length === 0);
  host.reholdBundledFyi(live12, live12.bundledFyi.gen);
  check("(12) rehold with the matching generation re-holds", !live12.bundledFyi && host.getHeldFyiEntries(SID12).map((e) => e.text).join() === "CF_FYI2");

  // ============ (13) a control byte before the slash cannot hide a slash command ============
  const SID13 = "fyi-ctrl-slash";
  const f13 = spawnReady(SID13);
  sendFyi(SID13, "CTRL_HELD_FYI", "fyi:ctrl");
  host.enqueueStdin(SID13, "\x1b/compact", "human", undefined, undefined, "agent");
  check("(13) a control-byte-prefixed slash turn does not carry the FYI block", !written(f13).includes(FYI_TAG) && host.getHeldFyiEntries(SID13).length === 1);

  // ============ dead session: an FYI to nobody is dropped, not held ============
  const rd = sendFyi("no-such-session", "x", "fyi:z");
  check("(dead) FYI to a non-live session reports dropped", rd.delivered === false && rd.deliveryState === "dropped");
} finally {
  for (const sid of ["fyi-parked", "fyi-caps", "fyi-purge", "fyi-slash", "fyi-giveup", "fyi-enteronly", "fyi-mismatch", "fyi-supersede", "fyi-confirm", "fyi-ctrl-slash"]) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — FYI notices are held, never wake a parked session, and ride the next real turn." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
