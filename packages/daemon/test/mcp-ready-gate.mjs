// Claude-free regression guard for card df5e37e7 — the post-`daemon_restart`/crash-recovery resume race
// where a resumed session's injected continuation nudge could reach loom-orchestration tools BEFORE the
// CLI's own async MCP-client handshake to that server finished, hard-failing with "MCP server
// 'loom-orchestration' is not connected". PtyHost has no way to observe the CLIENT's connection state
// directly (its MCP transport is stateless-per-request — see mcp/orchestration.ts) — markMcpSeen /
// waitForMcpSeen are the best-available proxy: "has this session's pty had an HTTP hit on its
// loom-orchestration route since it was (re)spawned". This exercises that primitive directly against the
// real PtyHost state machine with a FAKE pty (the createPty seam, same as pty-resume-readiness.mjs). No
// real claude.
// RUN: pnpm build (from packages/daemon) then `node test/mcp-ready-gate.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/pollMs budget, still
// does a final `pred()` re-check on timeout (unchanged) instead of hardcoding false.
async function waitUntil(pred, timeoutMs = 3000, pollMs = 20) {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs: pollMs, label: "mcp-ready-gate: pred" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return pred();
  }
}

// Guardrail (manager review, card df5e37e7): the deferred-nudge chain
// (waitForMcpSeen().then(...).catch(...)) must NEVER produce an unhandled rejection, even when a session
// dies mid-wait. Track it process-wide across every scenario below.
let unhandledRejections = 0;
process.on("unhandledRejection", (e) => { unhandledRejections++; console.error("[test] UNHANDLED REJECTION:", e); });

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn). Both env vars must
// be set BEFORE importing host.js (the constants are read at import time) — mirrors
// pty-resume-readiness.mjs's LOOM_READY_FALLBACK_MS override.
const tmpHome = path.join(os.tmpdir(), `loom-mcpready-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_READY_FALLBACK_MS = "20000"; // not exercised here — keep it well out of the way
process.env.LOOM_MCP_READY_TIMEOUT_MS = "300"; // short bound so the timeout-fallback scenarios run fast
// Scenarios 10-12's fake pty never feeds a footer, so logLandedMode polls MODE_LOG_MAX_ATTEMPTS(8) times
// before settling with mode:"unknown" — kept fast (worst case 8*5=40ms) so it settles comfortably BEFORE
// the 300ms MCP_READY_TIMEOUT_MS above, leaving a clean window to distinguish "still gated on mcpSeen"
// from "just hasn't settled yet".
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost, MODE_LOG_POLL_MS, MODE_LOG_MAX_ATTEMPTS } = await import("../dist/pty/host.js");
// Worst-case time logLandedMode takes to settle on an unfed footer (mode stays "unknown" the whole time) —
// derived from the SAME real constants host.ts itself polls with, not a bare guessed literal. Scenarios
// 10-11 below need a window comfortably PAST this (so "not yet delivered" genuinely distinguishes "still
// gated on mcpSeen" from "just hasn't settled yet") and comfortably UNDER MCP_READY_TIMEOUT_MS(300ms).
const SETTLE_CEILING_MS = MODE_LOG_POLL_MS * MODE_LOG_MAX_ATTEMPTS;
const NEGATIVE_WINDOW_MS = SETTLE_CEILING_MS + 100;

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null, exitCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); }, // simulate engine output reaching host.onData
    exit: (code = 0) => { if (exitCb) exitCb({ exitCode: code }); }, // simulate the process dying
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const spawnOpts = (id) => ({
  sessionId: id, cwd: tmpHome, resumeId: `engine-${id}`,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});

// Card a57b07af: a FRESH startup-prompt spawn (no resumeId — mirrors a real worker_spawn/recycle), for
// scenarios 10-12 exercising scheduleKickoffGuarantee's own new mcpSeen gate rather than the resume-
// continuation nudge's (already covered above).
const kickoffSpawnOpts = (id, role, startupPrompt) => ({
  sessionId: id, cwd: tmpHome, startupPrompt, role,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;
const PASTE_START = "\x1b[200~";

// The EXACT pattern sessions/service.ts's deferredNudge uses — replicated here so scenarios 7-9 exercise
// the primitive the same way resumeFleetOnBoot/recoverCrashOrphanedWorkers actually consume it.
const deferredNudge = (id, text) => {
  void host.waitForMcpSeen(id).then(() => host.enqueueStdin(id, text)).catch((e) => {
    console.warn(`[test] deferred nudge to ${id} failed unexpectedly: ${e?.message ?? e}`);
  });
};

try {
  // ============ 1) waitForMcpSeen resolves TRUE promptly once markMcpSeen fires ============
  const A = "sess-mcp-A";
  host.spawn(spawnOpts(A));
  let resolvedA = null;
  const pA = host.waitForMcpSeen(A).then((seen) => { resolvedA = seen; });
  await sleep(30);
  check("1: still unresolved shortly after spawn — nothing has marked MCP seen yet", resolvedA === null);
  host.markMcpSeen(A);
  await pA;
  check("1: resolves TRUE promptly once markMcpSeen fires", resolvedA === true);
  check("1: an already-seen session resolves a NEW wait immediately, synchronously true",
    await host.waitForMcpSeen(A) === true);

  // ============ 2) Two concurrent waiters on the SAME session both resolve on the SAME markMcpSeen; a
  // LATE waiter registered after the fact also resolves immediately (not by hanging on a new registration) ==
  const B = "sess-mcp-B";
  host.spawn(spawnOpts(B));
  let r1 = null, r2 = null;
  const w1 = host.waitForMcpSeen(B).then((s) => { r1 = s; });
  const w2 = host.waitForMcpSeen(B).then((s) => { r2 = s; });
  host.markMcpSeen(B);
  await Promise.all([w1, w2]);
  check("2: BOTH concurrent waiters resolve true", r1 === true && r2 === true);
  host.markMcpSeen(B); // idempotent — a repeat call after already-seen must be a harmless no-op
  const r3 = await host.waitForMcpSeen(B);
  check("2: a late waiter registered AFTER markMcpSeen resolves immediately true", r3 === true);

  // ============ 3) Timeout fallback: never marked seen → resolves FALSE after LOOM_MCP_READY_TIMEOUT_MS ====
  const C = "sess-mcp-C";
  host.spawn(spawnOpts(C));
  const t0 = Date.now();
  const seenC = await host.waitForMcpSeen(C);
  const elapsedC = Date.now() - t0;
  check("3: resolves FALSE (never seen) instead of hanging forever", seenC === false);
  check("3: waited roughly the configured timeout, not instantly and not way over",
    elapsedC >= 250 && elapsedC < 2000);

  // ============ 4) A session that DIES mid-wait resolves the wait FALSE promptly (not the full timeout) ====
  const D = "sess-mcp-D";
  host.spawn(spawnOpts(D));
  const fd = fakes[fakes.length - 1];
  const t1 = Date.now();
  const pD = host.waitForMcpSeen(D);
  fd.exit(1); // simulate the pty dying while something is awaiting waitForMcpSeen
  const seenD = await pD;
  const elapsedD = Date.now() - t1;
  check("4: a session dying mid-wait resolves FALSE", seenD === false);
  check("4: resolves promptly on death, well under the full timeout (not waiting it out)", elapsedD < 200);

  // ============ 5) markMcpSeen on an unknown/dead session is a safe no-op (never throws) ============
  let threw5 = null;
  try { host.markMcpSeen("no-such-session"); } catch (e) { threw5 = e; }
  check("5: markMcpSeen on an unknown session does not throw", threw5 === null);
  let threw5b = null;
  try { host.markMcpSeen(D); } catch (e) { threw5b = e; } // D is now dead (exited in scenario 4)
  check("5: markMcpSeen on an already-dead session does not throw", threw5b === null);

  // ============ 6) waitForMcpSeen on an unknown session resolves FALSE immediately (nothing to wait for) ===
  const t2 = Date.now();
  const seenUnknown = await host.waitForMcpSeen("no-such-session-2");
  check("6: unknown session resolves FALSE immediately, no timeout wait",
    seenUnknown === false && (Date.now() - t2) < 100);

  // ============ 7) The deferredNudge pattern itself: never submits/queues before markMcpSeen, delivers
  // promptly once seen. E is deliberately left NOT-ready (no SessionStart delivered), so a delivered nudge
  // lands in the pending FIFO exactly like a real resume-continuation nudge racing the TUI boot too. ======
  const E = "sess-mcp-E";
  host.spawn(spawnOpts(E));
  deferredNudge(E, "[loom:daemon-restarted] continue nudge");
  await sleep(30);
  check("7: nudge NOT delivered/queued yet — MCP not seen", host.getPending(E).length === 0);
  host.markMcpSeen(E);
  await waitUntil(() => host.getPending(E).length === 1);
  check("7: nudge lands in the pending FIFO promptly once markMcpSeen fires (session not ready yet)",
    host.getPending(E).length === 1 && host.getPending(E)[0].includes("continue nudge"));

  // ============ 8) Same pattern, timeout fallback: deferredNudge still delivers (today's pre-fix
  // behavior) even if MCP is never seen — never wedges the resume. ============
  const F = "sess-mcp-F";
  host.spawn(spawnOpts(F));
  deferredNudge(F, "[loom:daemon-restarted] fallback nudge");
  check("8: nothing delivered immediately", host.getPending(F).length === 0);
  await waitUntil(() => host.getPending(F).length === 1, 2000);
  check("8: fallback delivers the nudge anyway once the timeout elapses (never wedges)",
    host.getPending(F).length === 1 && host.getPending(F)[0].includes("fallback nudge"));

  // ============ 9) Same pattern against a session that DIES before markMcpSeen ever fires: the deferred
  // chain must not throw, must not produce an unhandled rejection, and the nudge never lands (enqueueStdin
  // safely no-ops on a dead session — see PtyHost.enqueueStdin's `!live?.alive` guard). ============
  const G = "sess-mcp-G";
  host.spawn(spawnOpts(G));
  const fg = fakes[fakes.length - 1];
  deferredNudge(G, "[loom:daemon-restarted] should never land");
  fg.exit(1);
  await sleep(50);
  check("9: a session that died before markMcpSeen never receives the deferred nudge", host.getPending(G).length === 0);

  // ============ 10) Card a57b07af: scheduleKickoffGuarantee's OWN mcpSeen gate — a "worker"-role fresh
  // spawn's turn-1 kickoff is NOT delivered until markMcpSeen fires, then delivers promptly once it does
  // (mirrors scenario 7's shape, against the kickoff path instead of the resume-nudge path). ============
  const H = "sess-mcp-H";
  const KICKOFF_H = "orchestrate task tk-H";
  host.spawn(kickoffSpawnOpts(H, "worker", KICKOFF_H));
  const fh = fakes[fakes.length - 1];
  host.deliverHook(H, { hook_event_name: "SessionStart" }); // markReady -> logLandedMode -> scheduleKickoffGuarantee's proceed, gated on waitForMcpSeen
  let ctrlSeq = 0;
  const spawnUngatedControl = async (label) => {
    const id = `control-mcp-ready-${ctrlSeq++}-${label.replace(/[^a-z0-9]+/gi, "-")}`;
    host.spawn(kickoffSpawnOpts(id, null, `control kickoff (${label})`)); // role:null — never gated, proves the check itself can go true
    const fake = fakes[fakes.length - 1];
    host.deliverHook(id, { hook_event_name: "SessionStart" });
    const went = await observeOnce({ check: () => countIn(fake, PASTE_START) >= 1, windowMs: 2000 });
    try { host.stop(id, "hard"); } catch { /* ignore */ }
    return went;
  };
  const noPrematureDeliveryH = await assertNeverWithControl({
    label: "10: kickoff NOT delivered while mcpSeen is still unset (gated)",
    check: () => countIn(fh, PASTE_START) >= 1,
    windowMs: NEGATIVE_WINDOW_MS,
    positiveControl: () => spawnUngatedControl("10 positive control"),
  });
  check("10: kickoff NOT delivered yet — MCP not seen", noPrematureDeliveryH);
  host.markMcpSeen(H);
  await waitUntil(() => countIn(fh, PASTE_START) === 1);
  check("10: kickoff delivered promptly once markMcpSeen fires",
    countIn(fh, PASTE_START) === 1 && writtenOf(fh).includes(KICKOFF_H));

  // ============ 11) Same shape, timeout fallback: the kickoff still delivers (bounded by
  // MCP_READY_TIMEOUT_MS) even if MCP is never seen — never wedges turn 1. ============
  const I = "sess-mcp-I";
  const KICKOFF_I = "orchestrate task tk-I";
  host.spawn(kickoffSpawnOpts(I, "assistant", KICKOFF_I));
  const fi = fakes[fakes.length - 1];
  host.deliverHook(I, { hook_event_name: "SessionStart" });
  const noPrematureDeliveryI = await assertNeverWithControl({
    label: "11: nothing delivered yet — MCP not seen (before the timeout fallback)",
    check: () => countIn(fi, PASTE_START) >= 1,
    windowMs: NEGATIVE_WINDOW_MS,
    positiveControl: () => spawnUngatedControl("11 positive control"),
  });
  check("11: nothing delivered yet", noPrematureDeliveryI);
  await waitUntil(() => countIn(fi, PASTE_START) === 1, 2000);
  check("11: fallback delivers the kickoff anyway once the timeout elapses (never wedges)",
    countIn(fi, PASTE_START) === 1 && writtenOf(fi).includes(KICKOFF_I));

  // ============ 12) A role that never mounts loom-orchestration (e.g. "platform") is NOT gated at all —
  // the kickoff delivers on the normal next-tick schedule, never waiting out MCP_READY_TIMEOUT_MS. ============
  const J = "sess-mcp-J";
  const KICKOFF_J = "orchestrate task tk-J";
  host.spawn(kickoffSpawnOpts(J, "platform", KICKOFF_J));
  const fj = fakes[fakes.length - 1];
  host.deliverHook(J, { hook_event_name: "SessionStart" });
  // 200ms: past the worst-case settle (40ms) but well SHORT of the 300ms MCP_READY_TIMEOUT_MS — if this
  // role were (wrongly) gated on mcpSeen, delivery could not land inside this window at all (it would
  // only land at the 300ms fallback), so this genuinely proves "ungated", not just "eventually delivers".
  await waitUntil(() => countIn(fj, PASTE_START) === 1, 200);
  check("12: a non-orchestration role's kickoff delivers ungated, without ever seeing markMcpSeen",
    countIn(fj, PASTE_START) === 1 && writtenOf(fj).includes(KICKOFF_J));

  await sleep(50); // let any straggling microtask/unhandledRejection surface before the final check
  check("no unhandled promise rejections were produced across all scenarios", unhandledRejections === 0);
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — waitForMcpSeen/markMcpSeen (card df5e37e7) resolve true promptly on markMcpSeen, false " +
    "on timeout or session death, never throw on an unknown/dead session, and the deferredNudge pattern " +
    "used by resumeFleetOnBoot/recoverCrashOrphanedWorkers never submits before MCP is seen (or the " +
    "bounded timeout), never wedges, and never leaks an unhandled rejection."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
