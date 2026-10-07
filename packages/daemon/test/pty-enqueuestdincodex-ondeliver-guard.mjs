import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f18a2201 (item 3). `enqueueStdinCodex`'s idle-submit branch (`host.ts`) called the caller-supplied
// `onDeliver` callback unguarded (`onDeliver?.();`), immediately after `submitCodex` had already written
// the text to the pty — unlike every other `onDeliver` call site in this file (`drainCodexPending`,
// `consumePending`, `drainPending`'s own drain loop), all of which wrap it in `try { ... } catch {
// /* never break ... */ }`. Webhook ingress passes no `onDeliver` at all (so this was latent for that
// caller), but any OTHER caller supplying one that throws would have that throw escape straight out of
// `enqueueStdin` — even though the hand-off had already genuinely happened.
//
// NOTE on scope: the card that opened this item also named claude's own idle-submit path
// (`enqueueStdin`'s immediate branch) as unguarded. That's not the case — that branch deliberately never
// calls `onDeliver` at all (see its own comment: "NOT invoking onDeliver here ... there's nothing to
// resolve" — a message delivered straight as a turn is never persisted as a durable `session_message_
// queued`, so submit() never calls it either). This test covers the codex-only scope that's actually real.
//
// Card 0075e20b amendment: this file's own scenario still holds unchanged (codex fires `onDeliver`
// unconditionally on its immediate branch; claude still never does on ITS immediate branch — neither
// changed). What DID change is caller-side: `redriveQueuedMessage`/`carryPendingToSuccessor` (sessions/
// service.ts) no longer assume `onDeliver` will resolve an ALREADY-PERSISTED durable record on a
// `delivered:true` hand-off — they resolve it themselves, idempotently, regardless of which harness
// answered. See `EnqueueResult`'s own doc (pty/host.ts) and docs/decisions/2ca18433-…md's "Card 0075e20b
// amendment" section for the full contract this asymmetry is now a STATED choice under, not drift.
//
// THE FIX: `enqueueStdinCodex`'s idle-submit branch now guards the call exactly like its siblings:
// `if (onDeliver) { try { onDeliver(); } catch { ... } }`.
//
// Same scripted fake-codex-pty technique as codex-submit-confirmation-gap.mjs — no real process.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-enqueuestdincodex-ondeliver-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-esc-ondeliver-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 7171,
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

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
};
const host = new FakeCodexHost(events);

const SID = "esc-ondeliver-test";
try {
  host.spawn({
    sessionId: SID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const fakePty = host.fakeCodexPtys.get(SID);
  // Reaches bootReady synchronously (ready marker + model-loaded + no pending trust dialog) so the
  // enqueue below hits the IMMEDIATE idle-submit branch (enqueueStdinCodex), not the queued path.
  fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
  check("preamble: boot readiness latched (idle-submit branch is reachable)", host.liveCodex.get(SID).bootReady === true);

  const throwingOnDeliver = () => { throw new Error("simulated onDeliver fault"); };

  let enqueueError;
  let result;
  try {
    result = host.enqueueStdin(SID, "WEBHOOK_NUDGE_TEXT_CODEX", "system", throwingOnDeliver, undefined, "agent");
  } catch (e) {
    enqueueError = e;
  }

  check("enqueueStdin does NOT throw even though the idle-submit onDeliver callback faults", !enqueueError);
  check("...and it still reports the hand-off as delivered", result?.delivered === true && result?.deliveryState === "handed-off");
  check("...and the text genuinely reached the pty (submitCodex ran before onDeliver was ever called)", fakePty.writes.some((w) => w.includes("WEBHOOK_NUDGE_TEXT_CODEX")));
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — enqueueStdinCodex's idle-submit onDeliver call is guarded like its sibling call sites: a faulting onDeliver can never undo or hide an already-completed hand-off."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
