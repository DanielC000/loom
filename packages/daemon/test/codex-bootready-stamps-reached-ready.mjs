import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 08c81809 — Code Review round 4 item 4: round 3 fixed codex's `bootReady` composite to also
// fire `PtyHostEvents.onReady` (mirroring claude's `markReady`), so `Session.reachedReadyAt` latches for a
// codex successor too — round 3's own `recycle-settle-lost-to-restart.mjs` suite never actually spawns a
// codex session (its SeamHost fixture's `onData` is a permanent no-op, structurally unable to drive
// codex's screen-scan-based readiness detection), so that fix shipped with NO real-DB proof it stamps the
// column. This file closes that gap directly: a REAL `Db` wired as `onReady: (id) => db.setReachedReady(id)`
// (the exact production wiring in index.ts), a codex session spawned via a scripted fake pty (mirrors
// `codex-queue-state-machine.mjs`'s own established `createCodexPty` override pattern — no real codex
// process), and a direct read of `db.getSession(id).reachedReadyAt` after boot readiness latches.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-bootready-stamps-reached-ready.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-reachedready-");
process.env.LOOM_HOME = TMP;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");

/** Mirrors codex-queue-state-machine.mjs's own makeFakePty/FakeCodexHost — a fully scripted fake codex
 *  pty (no real process); every "chunk" is pushed by this test calling `fakePty.push(text)` directly. */
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

const db = new Db();
const now = new Date().toISOString();
const projectId = "codex-reachedready-project";
const repo = TMP + "/repo";
const fs = await import("node:fs");
fs.mkdirSync(repo, { recursive: true });
db.insertProject({ id: projectId, name: "p", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: `${projectId}-agent`, projectId, name: "A", startupPrompt: "A", position: 0, profileId: null });

const SESSION_ID = "codex-reachedready-session";
db.insertSession({
  id: SESSION_ID, projectId, agentId: `${projectId}-agent`, engineSessionId: null, title: null, cwd: repo,
  processState: "starting", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", harness: "codex",
});

// @decision 08c81809 — the EXACT production wiring index.ts uses for `onReady` (see index.ts's own
// PtyHost construction): the fix under test lives entirely in whether codex's `bootReady` composite ever
// calls this at all, not in this callback's own body.
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onReady: (id) => db.setReachedReady(id) };
const host = new FakeCodexHost(events);

check("(pre) reachedReadyAt is null before boot readiness latches", db.getSession(SESSION_ID)?.reachedReadyAt == null);

host.spawn({ sessionId: SESSION_ID, cwd: repo, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
const fakePty = host.fakeCodexPtys.get(SESSION_ID);

// Ready marker alone (model still loading) must NOT latch bootReady — same byte-exact specimen
// codex-queue-state-machine.mjs's own R1 uses, so this file exercises the identical real ANSI-strip path.
fakePty.push("OpenAI Codex (v1.2.3)\n      │ model:     \x1b[3mloading\x1b[23m   \x1b[38;5;6m\x1b[22m/model\x1b[m\x1b[2m to change                   │\x1b[22m\x1b[K\x1b[2m\r      ›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[22m\x1b[K\r");
check("(pre) still null while the model is only reported as loading (bootReady not yet latched)", db.getSession(SESSION_ID)?.reachedReadyAt == null);

// Model resolves — boot readiness latches, firing onReady.
fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("FIX: bootReady actually latched (sanity — the discriminator this test depends on)", host.liveCodex.get(SESSION_ID)?.bootReady === true);
check("FIX: onReady fired through to a REAL Db — reachedReadyAt is now stamped", db.getSession(SESSION_ID)?.reachedReadyAt != null);

// @decision 08c81809 — Code Review round 5 minor: the ORIGINAL version of this check (pushing a second
// ready-placeholder chunk and asserting the stamp didn't move) was VACUOUS — `onReady` only fires once
// per session's own `!live.bootReady` guard regardless of `setReachedReady`'s own SQL guard, so this
// passed even with that `AND reached_ready_at IS NULL` clause removed from db.ts. Call `db.setReachedReady`
// TWICE directly instead, bypassing the once-only in-process guard entirely, so this actually exercises
// the SQL-level first-write-only contract (`db.ts`, first landed round 3 — NOT round 4, corrected here).
// DETERMINISTIC, not a fixed-wait: `setReachedReady` stamps `new Date().toISOString()`, so a blind sleep
// before the second call would only reduce (never eliminate) the odds of a same-millisecond string
// collision masking a real regression — instead, force the SECOND call's clock reading to be a value that
// could never coincide with the first by swapping the global `Date` constructor for its duration.
const firstStamp = db.getSession(SESSION_ID)?.reachedReadyAt;
const RealDate = Date;
class FarFutureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [RealDate.now() + 365 * 24 * 60 * 60 * 1000])); }
  static now() { return RealDate.now() + 365 * 24 * 60 * 60 * 1000; }
}
globalThis.Date = FarFutureDate;
try {
  db.setReachedReady(SESSION_ID);
} finally {
  globalThis.Date = RealDate;
}
check("FIX: reachedReadyAt is first-write-only at the SQL level — a direct second call (with a clock reading that could never coincide with the first) does not overwrite the original stamp", db.getSession(SESSION_ID)?.reachedReadyAt === firstStamp);

// @decision 08c81809 — Code Review round 5 minor: no committed test pinned "an onReady throw can't skip
// kickoff delivery" (the round-4 item-4 try/catch wraps at pty/host.ts's codex/claude onReady call
// sites). A SEPARATE session with a THROWING onReady callback + a startupPrompt — if the try/catch were
// removed, the throw would propagate out of the onData handler and the kickoff write just below it would
// never run.
const THROW_SESSION_ID = "codex-reachedready-throw-session";
db.insertSession({
  id: THROW_SESSION_ID, projectId, agentId: `${projectId}-agent`, engineSessionId: null, title: null, cwd: repo,
  processState: "starting", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", harness: "codex",
});
const throwingEvents = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onReady: () => { throw new Error("(throw-onReady) injected — onReady must never skip kickoff delivery"); } };
const throwHost = new FakeCodexHost(throwingEvents);
const KICKOFF = "do the assigned task";
throwHost.spawn({ sessionId: THROW_SESSION_ID, cwd: repo, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex", startupPrompt: KICKOFF });
const throwFakePty = throwHost.fakeCodexPtys.get(THROW_SESSION_ID);
throwFakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
check("FIX: bootReady still latched despite the onReady throw", throwHost.liveCodex.get(THROW_SESSION_ID)?.bootReady === true);
check("FIX: the kickoff was STILL delivered despite onReady throwing (round 4 item 4's try/catch)", throwFakePty.writes.some((w) => w.includes(KICKOFF)));

db.close(); // release the sqlite handle before finishAndExit's tmp-dir cleanup tries to unlink it

await finishAndExit(failures === 0 ? 0 : 1);
