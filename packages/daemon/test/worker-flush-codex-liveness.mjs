import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 760f2874 (platform escalation a51d9732, DoD-4) — regression guard for `PtyHost.flushComposer`
// (backs the `worker_flush` MCP tool) falsely reporting `{ok:false, reason:"session-dead"}` for a
// genuinely LIVE codex session. Root cause: `flushComposer` read ONLY `this.live` — the CLAUDE-only map
// (decision 353f6dc4 is why a codex session's live state lives in a SEPARATE map, `this.liveCodex`, never
// inside `Live`) — so a codex entry (which is never in `this.live`) always fell into the `!live?.alive`
// branch, reporting the SAME `"session-dead"` a real dead session gets, while `worker_list`/`isAlive`
// (routed through `findAnyLive`, which DOES consult `liveCodex`) correctly read the SAME session as live
// and busy. See docs/decisions/760f2874-codex-worker-flush-false-session-dead.md for the full narrative,
// including what was and wasn't reproduced for this card's OTHER defect (the "codex never submits
// multi-line payloads" claim).
//
// HERMETIC — no real codex install needed. TECHNIQUE: directly registers a CodexLive-shaped object into
// PtyHost's private `liveCodex` map, mirroring `pty-codex-agnostic-methods.mjs`'s own established
// precedent (TypeScript's `private` is compile-time-only; a compiled JS test can read/write it).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-flush-codex-liveness.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { PtyHost } = await import("../dist/pty/host.js");

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
};
const host = new PtyHost(events);

const DEAD_SESSION_ID = "flush-no-such-session";
const CODEX_SESSION_ID = "flush-codex-live-test";

const fakePty = { pid: 424242, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
const fakeLogStream = { write() {}, end() {}, on() {} };
/** Minimal CodexLive-shaped object — mirrors pty-codex-agnostic-methods.mjs's own makeCodexLive(). */
function makeCodexLive() {
  return {
    kind: "codex", pty: fakePty, pid: fakePty.pid, cwd: "/fake/codex/worktree",
    geometry: { cols: 120, rows: 40 },
    hookToken: "", engineSessionId: "engine-abc",
    ring: { chunks: [], bytes: 0 },
    subscribers: new Set(),
    alive: true, killed: false, startedAt: Date.now() - 5000,
    logStream: fakeLogStream, logBroken: false,
    busy: true, // mirrors the escalation's own observed `worker_list` read: processState:"live", busy:true
    pending: [], stopping: false, drainHeld: false,
    role: "worker",
    mcpSeen: false, mcpSeenWaiters: [],
    activeTurnRoute: null, lastPromptRoute: null,
    activeTurnProactive: false, lastPromptProactive: false,
    activeTurnOwnerText: null, lastPromptOwnerText: null,
    recentOwnerTurns: [],
    activeTurnSenderId: null, lastPromptSenderId: null,
    trustDialogAnswered: true, screenScan: "",
    firstTurnStarted: false,
  };
}

// --- Negative control FIRST: a sessionId with NO entry in EITHER map is a genuine "session-dead" — this
// must stay true after the fix, or the fix would have widened the dead case into a false positive too.
{
  const result = await host.flushComposer(DEAD_SESSION_ID);
  check("(control) flushComposer on an unregistered sessionId still reports session-dead", result.ok === false && result.reason === "session-dead");
}

// --- The regression: a LIVE codex entry (registered ONLY in liveCodex, never in `this.live`) must be
// told apart from a genuinely dead session — `isAlive`/`worker_list`'s own view (via findAnyLive) agrees
// the session is alive, so flushComposer must not contradict that with "session-dead".
{
  const live = makeCodexLive();
  host.liveCodex.set(CODEX_SESSION_ID, live);

  check("(sanity) isAlive (findAnyLive, the SAME liveness host.flushComposer must not contradict) reads true for this codex entry", host.isAlive(CODEX_SESSION_ID) === true);
  check("(sanity) isBusy agrees with the escalation's own observed worker_list read (busy:true)", host.isBusy(CODEX_SESSION_ID) === true);

  const result = await host.flushComposer(CODEX_SESSION_ID);
  check("flushComposer does NOT report session-dead for a live codex entry (the bug: this used to be true)", result.reason !== "session-dead");
  check("flushComposer reports the honest not-applicable-codex reason for a live codex entry", result.ok === false && result.reason === "not-applicable-codex");

  // Confirm this call is genuinely read-only against the codex entry — no claude-only reassert/Enter
  // write path can have fired (that mechanism panics on CodexLive's missing fields if ever reached).
  check("the codex entry's own state is untouched by the call (busy still true, pending still empty)", live.busy === true && live.pending.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — flushComposer (worker_flush) no longer reports the claude-only \"session-dead\" for a genuinely live codex session; it now agrees with isAlive/worker_list (both routed through findAnyLive) and reports an honest not-applicable-codex instead, while a truly unregistered sessionId still correctly reports session-dead."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
