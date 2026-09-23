import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ea97817c — a codex busy-marker sighting inside `submitCodex`'s own text->\r gap must NOT cancel the
// pending Enter. Real specimen (a real-spawn ascii-fold run, instrumented): codex animates its OSC title
// spinner while it starts MCP servers; that chunk hit `armCodexBusyStaleTimer`, which bumps `busyStaleGen`
// on every arm, and the delayed-Enter closure (which used to compare `busyStaleGen`) read it as a
// stop/redirect and returned without writing "\r". `enterPending` then stayed true forever, the retry
// ladder's CASE 0 no-op'd every fire, and the prompt sat unsubmitted in the composer.
//
// Same fake-pty technique as `codex-stop-redirect-cancel-ladder.mjs` (no real process). Scenarios:
//   D — a title-spinner chunk in the gap: the Enter is still written (RED against the busyStaleGen guard).
//   E — a real graceful stop in the gap (plus a spinner chunk): the Enter is still suppressed.
//   F — a spinner chunk AND a redirect in the gap: alpha's Enter never lands, beta's own Enter does, and
//       beta's enterPending is not clobbered by alpha's stale closure.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-submit-marker-in-gap.mjs
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "60";
process.env.LOOM_CODEX_BUSY_STALE_MS = "40";
process.env.LOOM_CODEX_STOP_GAP_MS = "150";
process.env.LOOM_GRACEFUL_KILL_MS = "300";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const ENTER_DELAY_MS = 60;
// The exact shape codex emits while a spinner animates in the terminal title (BUSY_TITLE_SPINNER_RE).
const SPINNER_CHUNK = "\x1b]0;\u280b loom-fixture...\x07";

const TMP = mkdtempManaged("loom-codex-submit-marker-gap-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5253,
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

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
  onCodexSubmitUnconfirmed() {},
};
const host = new FakeCodexHost(events);

function bootSession(sessionId) {
  host.spawn({
    sessionId, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  const fake = host.fakeCodexPtys.get(sessionId);
  fake.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
  return { fake, live: () => host.liveCodex.get(sessionId) };
}

// === SCENARIO D: a spinner chunk in the gap must not cancel the Enter ==================================
const SESSION_D = "codex-marker-gap-d";
const D = bootSession(SESSION_D);
check("D: boot readiness latched", D.live().bootReady === true);
const enqD = host.enqueueStdin(SESSION_D, "delta text", "system", undefined, undefined, "agent");
check("D: delivered immediately", enqD.delivered === true);
check("D: PRECONDITION — still inside the text->Enter gap", D.live().enterPending === true && !D.fake.writes.includes("\r"));
D.fake.push(SPINNER_CHUNK);
check("D: PRECONDITION — the spinner chunk really re-armed the staleness timer (it is what bumps busyStaleGen)", D.live().busyStaleTimer !== null);
let dEnterLanded = true;
try {
  await waitUntil(() => D.live().enterPending === false, { label: "D: the delayed Enter is written despite the spinner chunk in the gap", timeoutMs: 2000 });
} catch { dEnterLanded = false; }
check("D: FIX CONTRACT — the Enter was written (enterPending cleared)", dEnterLanded);
check("D: FIX CONTRACT — exactly one \"\\r\" reached the pty for this turn", D.fake.writes.filter((w) => w === "\r").length === 1);

// === SCENARIO E: a real stop in the gap still suppresses the Enter ======================================
const SESSION_E = "codex-marker-gap-e";
const E = bootSession(SESSION_E);
const enqE = host.enqueueStdin(SESSION_E, "epsilon text", "system", undefined, undefined, "agent");
check("E: delivered immediately", enqE.delivered === true);
check("E: PRECONDITION — still inside the gap", E.live().enterPending === true);
E.fake.push(SPINNER_CHUNK); // a spinner chunk AND a stop: the stop alone must be what cancels
host.stop(SESSION_E, "graceful");
await sleepPast(ENTER_DELAY_MS * 3, ENTER_DELAY_MS, "E: past the original Enter delay");
check("E: FIX CONTRACT — a stop inside the gap still suppresses the Enter (no \"\\r\" ever written)", !E.fake.writes.includes("\r"));
check("E: the stop itself did write its Ctrl+C (the stop really happened)", E.fake.writes.includes("\x03"));
await waitUntil(() => E.live().alive === false, { label: "E: graceful stop completes", timeoutMs: 3000 });

// === SCENARIO F: a spinner chunk AND a redirect in the gap ==============================================
const SESSION_F = "codex-marker-gap-f";
const F = bootSession(SESSION_F);
const enqAlpha = host.enqueueStdin(SESSION_F, "alpha text", "system", undefined, undefined, "agent");
check("F: alpha delivered immediately", enqAlpha.delivered === true);
check("F: PRECONDITION — still inside alpha's gap", F.live().enterPending === true);
const enqBeta = host.enqueueStdin(SESSION_F, "beta text", "system", undefined, undefined, "agent");
check("F: beta queues behind alpha", enqBeta.queued === true);
F.fake.push(SPINNER_CHUNK);
host.interruptForRedirect(SESSION_F);
check("F: beta drained synchronously by the redirect", F.fake.writes.includes("beta text"));
let fBetaEnter = true;
try {
  await waitUntil(() => F.live().enterPending === false, { label: "F: beta's OWN Enter is written", timeoutMs: 2000 });
} catch { fBetaEnter = false; }
check("F: beta's own Enter was written", fBetaEnter);
// Confirm beta's turn with a real marker so its own (separate, healthy) retry ladder adds no bare Enters
// to the count below.
F.fake.push("Working (1s • esc to interrupt)\n");
const fEntersAtBeta = F.fake.writes.filter((w) => w === "\r").length;
await sleepPast(ENTER_DELAY_MS * 3, ENTER_DELAY_MS, "F: past alpha's original (cancelled) Enter delay");
check("F: FIX CONTRACT — exactly one Enter (beta's): alpha's stale closure wrote nothing", fEntersAtBeta === 1 && F.fake.writes.filter((w) => w === "\r").length === 1);

console.log(failures === 0
  ? "\n✅ ALL PASS — card ea97817c: a busy-marker (title-spinner) sighting inside submitCodex's text->Enter gap no longer cancels the Enter; a real stop or redirect in the gap still does."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
