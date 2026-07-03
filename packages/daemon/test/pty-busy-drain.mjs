// Deterministic busy-gate / drain-ordering test for PtyHost (M1 + M2 invariants in pty/host.ts).
//
// This is the CLAUDE-FREE regression guard for the two concurrency invariants that previously had
// only LIVE (real-claude) coverage (messaging.mjs / usage-limit-resume.mjs):
//   M1 — submit() arms busy=true SYNCHRONOUSLY (the optimistic set), so a concurrent enqueueStdin
//        QUEUES rather than racing the still-pending Enter.
//   M2 — on Stop, busy is lowered and the FIFO is drained in the SAME synchronous tick (no await
//        between them), so exactly ONE submit() goes out per Stop, in FIFO order, with no interleave
//        of a concurrently-enqueued turn. (The drain COALESCES the whole pending FIFO into that one
//        submit — see pty-coalesce-drain.mjs — so "one submit per Stop" holds even with N queued.)
//
// It exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook/drainPending) against
// a FAKE pty injected via the createPty() seam — NO real claude, NO ~/.claude.json trust writes, no
// daemon, no network. Fully in-process and hermetic.
//
// RUN (no daemon needed): node test/pty-busy-drain.mjs
//   Requires the daemon to be built first (reads ../dist/pty/host.js): from packages/daemon, run
//   `pnpm build` (or `npm run build`) then `node test/pty-busy-drain.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME: host.ts opens a per-session log under LOGS_DIR (= $LOOM_HOME/logs) in
// spawn(). Point it at a throwaway temp dir BEFORE importing host.js (paths.ts reads LOOM_HOME at
// import time), and create the logs dir so createWriteStream succeeds. ---
const tmpHome = path.join(os.tmpdir(), `loom-ptytest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// --- A fake IPty: records every write; onData/onExit are inert. host.ts only uses pid/write/
// onData/onExit/kill, and never depends on onData/onExit firing for the busy/drain machine. ---
const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.push(fake);
  return fake;
}

// Subclass overrides the ONE seam (createPty) → no real spawn, no FS/trust side effects.
class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

// Recording events sink: capture the busy transition log (mirrors the daemon's onBusy persistence).
const busyLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-test";
const ALPHA = "ALPHA_MSG", BETA = "BETA_MSG", GAMMA = "GAMMA_MSG", DELTA = "DELTA_MSG";

// Spawn WITHOUT a startup prompt → busy starts false, no optimistic set yet (clean slate to drive).
host.spawn({
  sessionId: SID,
  cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 },
  sessionEnv: {},
});
const fake = fakes[0];
check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

// Concatenated record of everything written to the pty, and an occurrence counter for a marker.
const written = () => fake.writes.join("");
const countOf = (marker) => written().split(marker).length - 1;
const lastBusy = () => busyLog[busyLog.length - 1];

// A (re)spawned session is NOT ready until SessionStart (the boot-readiness gate that fixes the
// resume-injection race; the ready-gate itself is covered in pty-resume-readiness.mjs). With
// startupModeCycles:0, SessionStart marks ready synchronously — drive it so the M1/M2 immediate-submit
// assertions below hold.
host.deliverHook(SID, { hook_event_name: "SessionStart" });

try {
  // ===================== M1 — optimistic, synchronous busy =====================
  // First enqueue on an idle session submits IMMEDIATELY. Crucially, submit() must arm busy
  // SYNCHRONOUSLY before returning — we assert that by checking the very next enqueue QUEUES.
  const r1 = host.enqueueStdin(SID, ALPHA);
  check("M1: first enqueue on idle session delivered immediately", r1.delivered === true && r1.position === undefined);
  // The optimistic busy set is synchronous → onBusy(true) already recorded, with NO event-loop turn
  // having run between submit() and this line.
  check("M1: submit() armed busy=true SYNCHRONOUSLY (onBusy(true) recorded before any yield)", lastBusy() === true);

  // A concurrent enqueue (next call) now sees busy=true and QUEUES rather than racing ALPHA's
  // pending Enter — this is the whole point of the optimistic set.
  const r2 = host.enqueueStdin(SID, BETA);
  check("M1: concurrent enqueue QUEUES behind the synchronous busy (position 1, not delivered)", r2.delivered === false && r2.position === 1);
  check("M1: BETA was queued, NOT written to the pty", countOf(BETA) === 0);
  check("M1: ALPHA WAS written (the immediate submit)", countOf(ALPHA) === 1);
  check("M1: pending FIFO holds exactly [BETA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([BETA]));

  // ===================== M2 — drain ordering: FIFO, one SUBMIT per Stop, no interleave =====================
  // Enqueue two more while still busy — they must stack FIFO behind BETA.
  const r3 = host.enqueueStdin(SID, GAMMA);
  const r4 = host.enqueueStdin(SID, DELTA);
  check("M2: GAMMA queued at position 2", r3.delivered === false && r3.position === 2);
  check("M2: DELTA queued at position 3", r4.delivered === false && r4.position === 3);
  check("M2: pending FIFO is [BETA, GAMMA, DELTA]", JSON.stringify(host.getPending(SID)) === JSON.stringify([BETA, GAMMA, DELTA]));

  const PASTE_START = "\x1b[200~";
  const pasteBeforeStop = countOf(PASTE_START);
  const busyLenBeforeStop = busyLog.length;
  // First Stop: lowers busy then (same tick) COALESCE-drains the WHOLE FIFO — BETA, GAMMA, DELTA all go
  // out in ONE submit (one paste, one busy re-arm), FIFO order preserved. The M2 invariant is "one
  // SUBMIT per Stop, no interleave" — the coalesce (pty-coalesce-drain.mjs) hands over the whole queue
  // in that single submit instead of just the head.
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: Stop drained the whole FIFO — BETA, GAMMA, DELTA each written once", countOf(BETA) === 1 && countOf(GAMMA) === 1 && countOf(DELTA) === 1);
  check("M2: exactly ONE submit for the coalesced drain (a single new bracketed paste, no interleave)", countOf(PASTE_START) - pasteBeforeStop === 1);
  check("M2: pending fully drained (queue empty)", host.getPending(SID).length === 0);
  // FIFO order preserved within the single concatenated turn.
  const turn = written();
  check("M2: FIFO order preserved in the concatenated turn (BETA < GAMMA < DELTA)", turn.indexOf(BETA) < turn.indexOf(GAMMA) && turn.indexOf(GAMMA) < turn.indexOf(DELTA));
  // The drain happened in the same tick as lowering busy → the transition log shows false THEN true,
  // and busy is re-armed (true) ONCE so the next enqueue would queue again, not race.
  check("M2: busy fell (false) then the single drain re-armed it (true), in order", busyLog.slice(busyLenBeforeStop).join(",") === "false,true" && lastBusy() === true);

  // Second Stop on an empty queue: lowers busy and writes nothing more (no phantom drain).
  const writesBeforeIdleStop = fake.writes.length;
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("M2: Stop on an empty queue lowers busy and stays idle", lastBusy() === false);
  check("M2: Stop on an empty queue writes nothing more (no phantom drain)", fake.writes.length === writesBeforeIdleStop);

  // ===================== sanity: each Stop went out as ONE distinct bracketed paste =====================
  // Two submits total: ALPHA (the immediate idle-submit) + the one coalesced drain of [BETA,GAMMA,DELTA].
  check("Sanity: exactly two submits as bracketed pastes (immediate ALPHA + one coalesced drain)", countOf(PASTE_START) === 2);

  // ===================== kind-based one-per-turn (owner-directed 2026-07-03, card 706cc6fb) =====================
  // Toggle OFF (the default — `host` above was constructed with no opts): an "agent"-kind message never
  // shares a turn with anything else; a "warning"-kind message still coalesces with its same-kind,
  // same-route neighbors; a mixed queue splits its coalescing run at the first kind boundary.
  const SEP = "────────"; // DRAIN_SEPARATOR's visible rule (host.ts)

  // --- (a) 6 queued AGENT messages while busy → 6 SEPARATE turns, FIFO order, one per Stop hook. ---
  {
    const SID2 = "sess-kind-agent-off";
    host.spawn({
      sessionId: SID2, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID2, { hook_event_name: "SessionStart" });
    const fake2 = fakes[fakes.length - 1];
    const written2 = () => fake2.writes.join("");
    const countOf2 = (m) => written2().split(m).length - 1;

    host.enqueueStdin(SID2, "PRIMER2"); // turn in flight → subsequent enqueues queue
    const AGENTS = ["AGENT_ONE", "AGENT_TWO", "AGENT_THREE", "AGENT_FOUR", "AGENT_FIVE", "AGENT_SIX"];
    for (const a of AGENTS) host.enqueueStdin(SID2, a, "system", undefined, undefined, "agent");
    check("kind-off(a): 6 agent messages all queued", host.getPending(SID2).length === 6);

    const pasteBefore2 = countOf2(PASTE_START);
    for (let i = 0; i < AGENTS.length; i++) host.deliverHook(SID2, { hook_event_name: "Stop" });
    check("kind-off(a): 6 Stops drained 6 SEPARATE turns (one bracketed paste each, not coalesced)",
      countOf2(PASTE_START) - pasteBefore2 === AGENTS.length);
    check("kind-off(a): queue fully drained", host.getPending(SID2).length === 0);
    for (const a of AGENTS) check(`kind-off(a): ${a} written exactly once`, countOf2(a) === 1);
    const t2 = written2();
    check("kind-off(a): FIFO order preserved across the separate turns",
      AGENTS.every((a, i) => i === 0 || t2.indexOf(AGENTS[i - 1]) < t2.indexOf(a)));
    // No coalesce separator anywhere near the agent turns — each was its OWN submit, never joined.
    check("kind-off(a): no drain separator joining the agent turns (they were never coalesced together)",
      !AGENTS.some((a, i) => i > 0 && t2.slice(t2.indexOf(AGENTS[i - 1]), t2.indexOf(a)).includes(SEP)));
  }

  // --- (b) N queued WARNING messages while busy → coalesced into ONE turn (unchanged legacy behavior). ---
  {
    const SID3 = "sess-kind-warning-off";
    host.spawn({
      sessionId: SID3, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID3, { hook_event_name: "SessionStart" });
    const fake3 = fakes[fakes.length - 1];
    const countOf3 = (m) => fake3.writes.join("").split(m).length - 1;

    host.enqueueStdin(SID3, "PRIMER3");
    const WARNS = ["WARN_ONE", "WARN_TWO", "WARN_THREE"];
    for (const w of WARNS) host.enqueueStdin(SID3, w, "system", undefined, undefined, "warning");
    const pasteBefore3 = countOf3(PASTE_START);
    host.deliverHook(SID3, { hook_event_name: "Stop" });
    check("kind-off(b): 3 warning messages coalesce into ONE turn (one bracketed paste)",
      countOf3(PASTE_START) - pasteBefore3 === 1);
    check("kind-off(b): queue fully drained in one shot", host.getPending(SID3).length === 0);
    check("kind-off(b): a drain separator joins the coalesced warnings", countOf3(SEP) === WARNS.length - 1);
  }

  // --- (c) a MIXED queue splits its coalescing run at the first kind boundary. ---
  {
    const SID4 = "sess-kind-mixed-off";
    host.spawn({
      sessionId: SID4, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID4, { hook_event_name: "SessionStart" });
    const fake4 = fakes[fakes.length - 1];
    const countOf4 = (m) => fake4.writes.join("").split(m).length - 1;

    host.enqueueStdin(SID4, "PRIMER4");
    host.enqueueStdin(SID4, "W1", "system", undefined, undefined, "warning");
    host.enqueueStdin(SID4, "W2", "system", undefined, undefined, "warning");
    host.enqueueStdin(SID4, "AG1", "system", undefined, undefined, "agent");
    host.enqueueStdin(SID4, "W3", "system", undefined, undefined, "warning");
    check("kind-off(c): pending is [W1,W2,AG1,W3]",
      JSON.stringify(host.getPending(SID4)) === JSON.stringify(["W1", "W2", "AG1", "W3"]));

    // 1st Stop: the leading WARNING run (W1,W2) coalesces into one turn — stops at the agent boundary.
    let pasteBefore4 = countOf4(PASTE_START);
    host.deliverHook(SID4, { hook_event_name: "Stop" });
    check("kind-off(c): drain 1 coalesces exactly W1+W2 (one paste)", countOf4(PASTE_START) - pasteBefore4 === 1);
    check("kind-off(c): drain 1 leaves [AG1,W3] behind",
      JSON.stringify(host.getPending(SID4)) === JSON.stringify(["AG1", "W3"]));
    check("kind-off(c): W1+W2 joined by the drain separator (coalesced together)", countOf4(SEP) >= 1);

    // 2nd Stop: AG1 drains ALONE (one-per-turn), even though W3 (a warning) is right behind it.
    pasteBefore4 = countOf4(PASTE_START);
    host.deliverHook(SID4, { hook_event_name: "Stop" });
    check("kind-off(c): drain 2 is AG1 alone (one paste)", countOf4(PASTE_START) - pasteBefore4 === 1);
    check("kind-off(c): drain 2 leaves [W3] behind — AG1 never mixed with W3",
      JSON.stringify(host.getPending(SID4)) === JSON.stringify(["W3"]));

    // 3rd Stop: W3 drains alone (nothing left to coalesce with).
    host.deliverHook(SID4, { hook_event_name: "Stop" });
    check("kind-off(c): drain 3 fully empties the queue", host.getPending(SID4).length === 0);
  }

  // --- (d) toggle ON (coalesceAgentMessages:true): 6 agent messages coalesce into ONE turn (legacy). ---
  {
    const hostOn = new TestPtyHost(events, { coalesceAgentMessages: true });
    const SIDON = "sess-kind-agent-on";
    hostOn.spawn({
      sessionId: SIDON, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    hostOn.deliverHook(SIDON, { hook_event_name: "SessionStart" });
    const fakeOn = fakes[fakes.length - 1];
    const countOfOn = (m) => fakeOn.writes.join("").split(m).length - 1;

    hostOn.enqueueStdin(SIDON, "PRIMER_ON");
    const AGENTS_ON = ["ON_ONE", "ON_TWO", "ON_THREE", "ON_FOUR", "ON_FIVE", "ON_SIX"];
    for (const a of AGENTS_ON) hostOn.enqueueStdin(SIDON, a, "system", undefined, undefined, "agent");
    check("kind-on(d): 6 agent messages all queued", hostOn.getPending(SIDON).length === 6);

    const pasteBeforeOn = countOfOn(PASTE_START);
    hostOn.deliverHook(SIDON, { hook_event_name: "Stop" });
    check("kind-on(d): toggle ON coalesces all 6 agent messages into ONE turn (one paste)",
      countOfOn(PASTE_START) - pasteBeforeOn === 1);
    check("kind-on(d): queue fully drained in one shot", hostOn.getPending(SIDON).length === 0);
    check("kind-on(d): drain separators join all 6 (legacy full-coalesce, kind ignored)",
      countOfOn(SEP) === AGENTS_ON.length - 1);
    try { hostOn.stop(SIDON, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  for (const sid of ["sess-kind-agent-off", "sess-kind-warning-off", "sess-kind-mixed-off"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — M1 (synchronous optimistic busy) + M2 (FIFO, one-submit-per-Stop coalesced drain, no interleave) hold, claude-free. Kind-based one-per-turn (card 706cc6fb): agent messages drain one-per-turn + warnings coalesce + mixed queues split at the kind boundary when coalesceAgentMessages is OFF (default); toggle ON restores full legacy coalescing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
