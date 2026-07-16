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

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs = 3000, pollMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
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

const { PtyHost } = await import("../dist/pty/host.js");

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
