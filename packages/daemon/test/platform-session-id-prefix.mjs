import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f2f0fafa — session_stop/session_reap/session_message (Platform Lead surface, mcp/platform.ts) each
// previously did an exact-id-only db.getSession lookup deep inside SessionService and threw the generic
// "session not found" for a valid-but-prefixed id — a false-existence claim (the session is NOT gone; the
// tool just needed more characters). session_transcript, in the same file, already accepted a full id OR
// an unambiguous 8-char id-prefix via db.findSessionsByIdPrefix + transcript-read.ts's AMBIGUOUS_ID_ERROR
// (see platform-transcript.mjs's own (e) coverage); the other three never adopted that resolver.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like platform-mgmt-surface.mjs / platform-
// messaging.mjs: a REAL Db + SessionService driven against a FAKE pty (stop/enqueueStdin seams) + an
// injected reapWorktreeProcesses seam, and the REAL PlatformMcpRouter driven over an in-process MCP
// InMemoryTransport (no HTTP, no external daemon, no real OS process enumeration).
//
// Proves the DoD, per tool (session_stop / session_reap / session_message):
//   - an unambiguous 8-char id-prefix resolves to the SAME session an exact full id would — the
//     underlying SessionService method is called with the RESOLVED FULL id, not the caller's prefix;
//   - a genuinely ambiguous 8-char prefix (two sessions share it) returns a DISTINCT error naming BOTH
//     candidate ids (deliberately richer than session_transcript's own plain AMBIGUOUS_ID_ERROR — see
//     docs/decisions/f2f0fafa-session-stop-reap-message-accept-id-prefix.md for why);
//   - a too-short (<8 char) prefix returns that SAME ambiguous/too-short error, never a misleading
//     "session not found";
//   - a well-formed but genuinely unknown id still returns the honest "session not found" (this case
//     must stay GREEN — it is not the defect this card fixes).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-session-id-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (nothing touches the real ~/.loom or ~/.claude). Set BEFORE
// importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-sidpfx-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });
db.insertProject({ id: "p1", name: "P1", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a1", projectId: "p1", name: "Agent1", startupPrompt: "x", position: 0 });

// STOP-TARGET / MESSAGE-TARGET: a live, UUID-shaped session — session_stop/session_message resolve an
// 8-char prefix of THIS id down to the same full row an exact match would.
const stopTargetId = "11111111-aaaa-4a1a-8000-000000000001";
db.insertSession({
  id: stopTargetId, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});

// REAP-TARGET: a live session WITH a worktreePath (session_reap requires one — reapSessionStraysCore
// refuses a manager/plain/run/Lead-shaped session with none, see card cf17ebf3).
const reapTargetId = "22222222-bbbb-4a1a-8000-000000000002";
const worktreePath = path.join(tmpHome, "wt");
fs.mkdirSync(worktreePath, { recursive: true });
db.insertSession({
  id: reapTargetId, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: worktreePath,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  worktreePath, branch: "loom/reap-target",
});

// Two sessions sharing an identical 8-char id-prefix — the AMBIGUOUS resolution fixture (mirrors
// platform-transcript.mjs's own "aaaaaaaa-one"/"aaaaaaaa-two" pair).
const ambigOneId = "dddddddd-aaaa-4a1a-8000-000000000001";
const ambigTwoId = "dddddddd-bbbb-4a1a-8000-000000000002";
db.insertSession({
  id: ambigOneId, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});
db.insertSession({
  id: ambigTwoId, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});

// Fake pty: capture stop()/enqueueStdin() calls (never a real claude, never a real OS signal).
const stopCalls = [];
const enqueued = [];
const host = {
  stop(id, mode) { stopCalls.push({ id, mode }); },
  isAlive() { return false; },
  enqueueStdin(id, text) { enqueued.push({ id, text }); return { delivered: true }; },
  getPid: () => undefined,
};
// Injected reapWorktreeProcesses seam (SessionService opts) — no real OS process enumeration here; see
// worker-session-reap.mjs for the real-OS-process proof of the underlying reap mechanism itself.
const reapCalls = [];
const svc = new SessionService(db, host, new OrchestrationControl(), {
  reapWorktreeProcesses: async (wt, opts) => { reapCalls.push({ worktreePath: wt, excludePids: opts?.excludePids ?? [] }); return { killedPids: [42] }; },
});
const router = new PlatformMcpRouter(db, svc);
const server = router.buildServer();
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "platform-session-id-prefix-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

try {
  // ===================== session_stop =====================
  const stopByPrefix = await call("session_stop", { sessionId: stopTargetId.slice(0, 8), mode: "hard" });
  check("session_stop: an unambiguous 8-char id-prefix resolves + stops (routes to pty.stop with the RESOLVED FULL id)",
    stopByPrefix.stopped === true && stopByPrefix.sessionId === stopTargetId &&
    stopCalls.some((s) => s.id === stopTargetId && s.mode === "hard"));

  const stopAmbig = await call("session_stop", { sessionId: "dddddddd" });
  check("session_stop: a genuinely ambiguous 8-char id-prefix errors, naming BOTH candidate ids",
    typeof stopAmbig.error === "string" && /ambiguous/i.test(stopAmbig.error) &&
    stopAmbig.error.includes(ambigOneId) && stopAmbig.error.includes(ambigTwoId));

  const stopShort = await call("session_stop", { sessionId: "1111" });
  check("session_stop: a too-short (<8 char) prefix returns the ambiguous/too-short error, NOT 'session not found'",
    typeof stopShort.error === "string" && /ambiguous/i.test(stopShort.error));

  const stopUnknown = await call("session_stop", { sessionId: "ffffffff-doesnotexist" });
  check("session_stop: a well-formed but genuinely unknown id STILL returns the honest 'session not found'",
    stopUnknown.error === "session not found");

  // ===================== session_reap =====================
  const reapByPrefix = await call("session_reap", { sessionId: reapTargetId.slice(0, 8) });
  check("session_reap: an unambiguous 8-char id-prefix resolves + reaps the RESOLVED session's OWN worktree",
    reapCalls.some((c) => c.worktreePath === worktreePath) &&
    Array.isArray(reapByPrefix.killedPids) && reapByPrefix.killedPids.includes(42));

  const reapAmbig = await call("session_reap", { sessionId: "dddddddd" });
  check("session_reap: a genuinely ambiguous 8-char id-prefix errors, naming BOTH candidate ids",
    typeof reapAmbig.error === "string" && /ambiguous/i.test(reapAmbig.error) &&
    reapAmbig.error.includes(ambigOneId) && reapAmbig.error.includes(ambigTwoId));

  const reapShort = await call("session_reap", { sessionId: "2222" });
  check("session_reap: a too-short (<8 char) prefix returns the ambiguous/too-short error, NOT 'session not found'",
    typeof reapShort.error === "string" && /ambiguous/i.test(reapShort.error));

  const reapUnknown = await call("session_reap", { sessionId: "ffffffff-doesnotexist" });
  check("session_reap: a well-formed but genuinely unknown id STILL returns the honest 'session not found'",
    reapUnknown.error === "session not found");

  // ===================== session_message =====================
  const msgByPrefix = await call("session_message", { sessionId: stopTargetId.slice(0, 8), text: "hello via prefix" });
  check("session_message: an unambiguous 8-char id-prefix resolves + delivers to the RESOLVED FULL id",
    msgByPrefix.deliveryStatus === "delivered-live" && !msgByPrefix.error &&
    enqueued.some((e) => e.id === stopTargetId && e.text.includes("hello via prefix")));

  const msgAmbig = await call("session_message", { sessionId: "dddddddd", text: "x" });
  check("session_message: a genuinely ambiguous 8-char id-prefix errors, naming BOTH candidate ids",
    typeof msgAmbig.error === "string" && /ambiguous/i.test(msgAmbig.error) &&
    msgAmbig.error.includes(ambigOneId) && msgAmbig.error.includes(ambigTwoId));

  const msgShort = await call("session_message", { sessionId: "1111", text: "x" });
  check("session_message: a too-short (<8 char) prefix returns the ambiguous/too-short error, NOT 'session not found'",
    typeof msgShort.error === "string" && /ambiguous/i.test(msgShort.error));

  const msgUnknown = await call("session_message", { sessionId: "ffffffff-doesnotexist", text: "x" });
  check("session_message: a well-formed but genuinely unknown id STILL returns the honest 'session not found'",
    msgUnknown.error === "session not found");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_stop/session_reap/session_message each accept a full session id OR an unambiguous 8-char id-prefix (resolved to the FULL id before reaching SessionService), a genuinely ambiguous prefix errors naming both candidates, a too-short prefix gets the same distinct error, and a well-formed-but-unknown id still honestly reports 'session not found' — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
