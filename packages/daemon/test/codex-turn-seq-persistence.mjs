import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5a8a74e1 — the pilot symptom this closes: worker `d104b870`'s manager saw `turnSeq` settled at 1
// against a demonstrably multi-turn transcript. `codex-queue-state-machine.mjs`'s own `card 361a5520`
// section already proves `PtyHostEvents.onTurnCompleted` FIRES the right number of times across multiple
// codex turns (its `turnCompletedEvents` array — a plain in-memory counter this test file's own author
// wires up). It does NOT prove those firings ever REACH the persisted `sessions.turn_seq` column — that
// is a SEPARATE link (index.ts's real `onTurnCompleted: (sessionId) => db.incrementTurnSeq(sessionId)`
// wiring, never exercised by that file). This test is scoped to exactly that uncovered link: drive the
// REAL `db.incrementTurnSeq` (the same call production makes) from the SAME fake-scripted-codex-pty
// technique, and assert the PERSISTED `db.getSession(id).turnSeq`, not a callback counter.
//
// RESOLUTION (Platform Lead, escalation 112b0310): the pilot's worker `d104b870` genuinely had
// `turnSeq:1` because it genuinely received exactly ONE Loom-turn — the daemon's own event log shows
// ZERO `message_worker`/`flush_worker_composer` events for it (a 3,600-event positive control DB-wide
// proves that absence is real, not an instrumentation gap). The "multi-turn transcript" was 9 codex
// rollout records from that ONE submit — codex's own first-use `AGENTS.md`+environment-context injection
// lands as its own additional user-role record ahead of Loom's real kickoff, so even counting only
// user-role records overcounts. `turnSeq` was correct; this test still stands because it closes a real,
// previously-uncovered gap (callback-fires vs. persisted-column) independent of that finding — it was
// written and run green BEFORE the Lead's answer arrived, and confirms the mechanism was never the cause.
//
// TECHNIQUE: identical to codex-queue-state-machine.mjs (fake `createCodexPty()` override driving the
// REAL submitCodex/armCodexBusyStaleTimer/drainCodexPending state machine under scripted chunks, never a
// real codex process) — see that file's own header for the full rationale. Genuine async waits (the
// freshness timer, the delayed Enter write) are observed via `waitUntil`, never a blind sleep.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-turn-seq-persistence.mjs
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_CODEX_BUSY_STALE_MS = "300";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-turnseq-");
process.env.LOOM_HOME = TMP;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");

const dbFile = `${TMP}/turnseq-test.db`;
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "proj-turnseq";
const agentId = "agent-turnseq";
const SESSION_ID = "codex-turnseq-test";
db.insertProject({ id: projId, name: "TurnSeq", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: null, title: null, cwd: "/fake/codex/worktree",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "worker", harness: "codex",
});
check("(preamble) turnSeq starts at 0 (default, never measured)", db.getSession(SESSION_ID).turnSeq === 0);

/** Same fake, fully-scripted codex pty as codex-queue-state-machine.mjs — no real process, no OS I/O. */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5152,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
    writes,
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

// THE EXACT PRODUCTION PAIR (index.ts): `onTurnCompleted` calls `db.incrementTurnSeq` — nothing else.
// This is the link codex-queue-state-machine.mjs's own plain-array `events.onTurnCompleted` never
// exercises; wiring the real db call here is the entire point of this file.
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy() {}, onExit() {},
  onTurnCompleted(sessionId) { db.incrementTurnSeq(sessionId); },
};
const host = new FakeCodexHost(events);

host.spawn({
  sessionId: SESSION_ID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
  // No startupPrompt — this file drives its turns via enqueueStdin (mirrors codex-submit-confirmation-
  // gap.mjs's own "ordinary mid-session message" framing), so nothing here needs the kickoff-delivery path.
});
const fakePty = host.fakeCodexPtys.get(SESSION_ID);

// Get past boot readiness with an ordinary ready+model frame (no startupPrompt ⇒ boot-ready drains an
// empty queue, a genuine no-op, not a hidden kickoff dependency).
fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("(preamble) boot readiness latched", host.liveCodex.get(SESSION_ID).bootReady === true);
check("(preamble) turnSeq still 0 after boot alone (no turn submitted yet)", db.getSession(SESSION_ID).turnSeq === 0);

/** Drive ONE full submit -> confirm -> idle cycle and return once it's settled, mirroring the causality
 *  discipline every sibling codex test in this suite follows: wait for the real Enter write before
 *  pushing a confirming marker (a marker pushed earlier predates enterWrittenAt and is ignored by CASE 0),
 *  then wait for the marker to go stale (CASE 2 fires, onTurnCompleted included) before returning. */
async function driveOneTurn(label, text) {
  const enq = host.enqueueStdin(SESSION_ID, text, "system", undefined, undefined, "agent");
  check(`${label}: delivered immediately (idle at enqueue time)`, enq.delivered === true);
  await waitUntil(() => host.liveCodex.get(SESSION_ID).enterPending === false, { label: `${label}: own Enter write has actually happened` });
  fakePty.push("Working (1s • esc to interrupt)\n");
  check(`${label}: busy marker confirms the turn`, host.isBusy(SESSION_ID) === true);
  await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: `${label}: turn goes idle once the confirmed marker goes stale` });
}

// 🔴 THE CORE DoD-2 ASSERTION: three genuinely distinct, Loom-observed codex turns must persist as three
// distinct increments to the REAL db column — not merely three firings of an in-memory callback counter
// (already proven elsewhere), and not stuck at 1 the way the pilot's worker `d104b870` was observed to be.
await driveOneTurn("turn 1", "message one");
check("turn 1: persisted turnSeq reads 1 (not stuck at 0, not the callback-fired count read some other way)", db.getSession(SESSION_ID).turnSeq === 1);

await driveOneTurn("turn 2", "message two");
check("turn 2: persisted turnSeq reads 2 — a SECOND distinct Loom-observed turn genuinely advances the persisted column (the exact link the pilot's symptom lives on)", db.getSession(SESSION_ID).turnSeq === 2);

await driveOneTurn("turn 3", "message three");
check("turn 3: persisted turnSeq reads 3 — no double-count, no missed count, no ceiling at 1 or 2", db.getSession(SESSION_ID).turnSeq === 3);

// --- POSITIVE CONTROL: prove this file's own assertions can actually go RED, not just green because
// nothing ever changes — same discipline as worker-status-projection-guard.mjs's own control block.
check("(control) a session that never had onTurnCompleted fire for it stays at turnSeq 0 (proves incrementTurnSeq is scoped to the id it's called with, not a global counter)", (() => {
  db.insertSession({
    id: "codex-turnseq-control", projectId: projId, agentId, engineSessionId: null, title: null, cwd: "/fake/control",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", harness: "codex",
  });
  return db.getSession("codex-turnseq-control").turnSeq === 0;
})());

db.close();
await finishAndExit(failures === 0 ? 0 : 1);
