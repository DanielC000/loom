import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f18a2201 (item 2). Nothing used to re-persist when the DB `busy` column disagreed with the
// in-memory `live.busy`: claude heals on its OWN next `setBusy` call regardless of value (no early
// return there), but codex's `setCodexBusy` returns early on an UNCHANGED value (`if (live.busy ===
// busy) return;` — see that method's own doc), so a FAILED falling-edge write (DB stays `busy=1` while
// `live.busy` is already `false` in memory) could sit stale until the NEXT OPPOSITE edge — potentially a
// long time, or never for a worker that goes idle and stays idle.
//
// THE FIX: `PtyHost.persistBusy` now tracks a `busyPersistDirty` flag on the session's `Live`/`CodexLive`
// object (set true in its catch, cleared false on its next success — see that field's own doc), and
// `reconcile()`'s periodic safety net re-persists the CURRENT `live.busy` whenever that flag is set —
// checked BEFORE the codex loop's own `!live.busy` drain-gate (see `reconcile()`'s own comment for why).
//
// This test drives the REAL `armCodexBusyStaleTimer`/`setCodexBusy`/`persistBusy`/`reconcile` code via a
// scripted fake codex pty (same technique as codex-submit-confirmation-gap.mjs / codex-submit-marker-in-
// gap.mjs) with a REAL Db whose `setBusy` is monkey-patched to fail EXACTLY the falling edge once. The
// real async waits (the busy-stale timer) are observed via `waitUntil` (poll for real state), never a
// blind sleep.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-reconcile-busy-repersist.mjs
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_CODEX_BUSY_STALE_MS = "80";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rcm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");

/** Same fake, fully-scripted codex pty as codex-submit-confirmation-gap.mjs — no real process. */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 6161,
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
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
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

const dbFile = path.join(tmpHome, "rcm.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "rcm-proj", agentId = "rcm-agent";
db.insertProject({ id: projId, name: "RCM", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Worker", startupPrompt: "", position: 0 });

const SID = "rcm-codex";
db.insertSession({
  id: SID, projectId: projId, agentId, engineSessionId: `eng-${SID}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", harness: "codex",
});

// Fail EXACTLY the first falling-edge (busy:false) write for SID — every other db.setBusy call (the
// rising edge, and reconcile()'s own later retry) goes through to the real implementation untouched.
const realSetBusy = db.setBusy.bind(db);
let armed = true;
db.setBusy = (id, busy) => {
  if (armed && id === SID && busy === false) {
    armed = false;
    throw new Error("simulated SQLITE_BUSY (reconcile re-persist test)");
  }
  return realSetBusy(id, busy);
};

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy(sessionId, busy) { db.setBusy(sessionId, busy); },
};
const host = new FakeCodexHost(events);

try {
  host.spawn({
    sessionId: SID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const fakePty = host.fakeCodexPtys.get(SID);
  const live = () => host.liveCodex.get(SID);
  fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
  check("preamble: boot readiness latched", live().bootReady === true);

  // Rising edge — delivers immediately (idle at enqueue time), db.setBusy(true) succeeds normally.
  const enq = host.enqueueStdin(SID, "message one", "system", undefined, undefined, "agent");
  check("rising edge: message delivers immediately", enq.delivered === true);
  check("rising edge: busy is true in memory", live().busy === true);
  check("rising edge: busy persisted to the DB cleanly (not dirty)", live().busyPersistDirty === false);
  check("rising edge: the DB row itself reads busy=true", db.getSession(SID).busy === true);
  await waitUntil(() => live().enterPending === false, { label: "message one's own Enter write has happened" });

  // Push a FRESH busy-marker chunk AFTER the Enter write (confirms the turn, re-arms the staleness timer),
  // then let the staleness window elapse with no further marker — CASE 2 fires setCodexBusy(false), whose
  // persistBusy call hits our armed failure.
  fakePty.push("\x1b]0;⠋ loom-fixture...\x07");
  await waitUntil(() => live().busy === false, { label: "the busy-stale timer fired CASE 2 (falling edge)", timeoutMs: 5_000 });

  check("falling edge: db.setBusy's throw was actually exercised (armed flag consumed)", armed === false);
  check("falling edge: busy is false in memory", live().busy === false);
  check("falling edge: busyPersistDirty is now true (the write failed)", live().busyPersistDirty === true);
  check(
    "falling edge: the DB row is LEFT STALE (still busy=true) — this is the bug: codex's own setCodexBusy early-returns on an unchanged value, so nothing else would ever retry this write on its own",
    db.getSession(SID).busy === true,
  );

  // THE FIX under test: reconcile()'s periodic safety net re-persists busyPersistDirty sessions — called
  // ONCE here, with NO further busy edge of any kind in between (proving this isn't "healed by luck on
  // the next opposite edge" — there IS no next edge in this test).
  host.reconcile();

  check("reconcile(): the DB row is healed to busy=false, with no opposing busy edge in between", db.getSession(SID).busy === false);
  check("reconcile(): busyPersistDirty is cleared back to false", live().busyPersistDirty === false);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.reconcile()'s periodic re-persist-on-mismatch heals a stale DB busy column left by a failed falling-edge write, without needing a further opposite busy edge."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
