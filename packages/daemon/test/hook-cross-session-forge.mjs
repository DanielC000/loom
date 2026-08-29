// Card a2407ed4 — /internal/hook accepted a CALLER-SUPPLIED sessionId with no further requirement, so
// any co-resident caller (loopback + a guessable/enumerable sessionId) could forge a hook against a
// SECOND live session it had no relationship to. Fix: a per-session token minted at spawn (Live.hookToken)
// that the caller must present; `verifyHookToken` gates `/internal/hook` before `deliverHook` ever runs.
//
// HERMETIC + CLAUDE-FREE: real gateway server (buildServer) + real PtyHost (fake pty via the
// createSeamHost() seam) + real Db, driven purely via app.inject over the ACTUAL /internal/hook route —
// never calling deliverHook/verifyHookToken directly, so this exercises the exact path a real forged (or
// real legitimate) POST would take. The per-session token is captured via the SAME seam every other test
// in this suite already uses to inspect createPty's args (TestPtyHost overrides createPty(opts,
// hookToken)) — no new production surface was added just for this test.
//
// RED-PROOF (verified manually, not asserted here — see worker_report): reverting host.ts/claude-
// settings.ts/server.ts to pre-fix and rebuilding turns every "forgery REJECTED" check below RED for the
// right reason (the forged hook is accepted and DOES mutate the victim session's state) — while the
// legit-with-token checks stay green (old code never looked at the token field at all).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const RUN_SUFFIX = `${Date.now()}-${process.pid}`;
const tmpHome = path.join(os.tmpdir(), `loom-hookforge-${RUN_SUFFIX}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_TEST = "1";
process.env.LOOM_PORT = String(hermeticPort());

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// Captures the REAL per-session token spawn() mints and threads into createPty — the same seam
// agent-id-prefix.mjs/board-column-mcp.mjs already use to inspect createPty's `opts` argument, extended
// to its second (hookToken) argument.
const tokensBySessionId = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts, hookToken) {
    tokensBySessionId.set(opts.sessionId, hookToken);
    return super.createPty(opts, hookToken);
  }
}

const dbFile = path.join(tmpHome, "test.db");
const db = new Db(dbFile);
const projId = "proj-hookforge";
const agentId = "agent-hookforge";
const SID_A = "sess-A-legit";
const SID_B = "sess-B-victim";
const now = new Date().toISOString();
db.insertProject({ id: projId, name: "HookForge", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "worker", startupPrompt: "work", position: 0 });
for (const id of [SID_A, SID_B]) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "worker",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
}

const events = {
  onEngineSessionId(id, engineId) { db.setEngineSessionId(id, engineId); },
  onBusy() {}, onRateLimited() {}, onExit() {}, onContextStats() {},
};
const host = new TestPtyHost(events);

let app;
try {
  host.spawn({ sessionId: SID_A, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.spawn({ sessionId: SID_B, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const tokenA = tokensBySessionId.get(SID_A);
  const tokenB = tokensBySessionId.get(SID_B);
  check("setup: A and B each minted a real, DISTINCT, non-empty token", !!tokenA && !!tokenB && tokenA !== tokenB);

  const stub = {};
  app = await buildServer({
    db, pty: host, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  const postHook = (sessionId, hook, token) => app.inject({
    method: "POST", url: "/internal/hook", remoteAddress: "127.0.0.1",
    payload: token === undefined ? { sessionId, hook } : { sessionId, hook, token },
  });

  // === Control: A's own relay presents A's own real token — legitimate SessionStart succeeds. ===
  const legit = await postHook(SID_A, { hook_event_name: "SessionStart", session_id: "engine-legit-A" }, tokenA);
  check("control: legit SessionStart for A (A's own token) → 200", legit.statusCode === 200);
  check("control: A's own engineSessionId captured", db.getSession(SID_A)?.engineSessionId === "engine-legit-A");

  // === Forgery 1: no token at all. ===
  const noToken = await postHook(SID_B, { hook_event_name: "SessionStart", session_id: "engine-FORGED-into-B" }, undefined);
  check("forge-1 (no token): REJECTED → 403", noToken.statusCode === 403);
  check("forge-1 (no token): B's engineSessionId untouched", db.getSession(SID_B)?.engineSessionId === null);

  // === Forgery 2: a VALID token — but for the WRONG session (A's token, presented against B). This is
  // the sharpest case: it proves per-session BINDING, not just "any real-looking token gets through". ===
  const wrongSessionToken = await postHook(SID_B, { hook_event_name: "SessionStart", session_id: "engine-FORGED-into-B" }, tokenA);
  check("forge-2 (A's token against B): REJECTED → 403", wrongSessionToken.statusCode === 403);
  check("forge-2 (A's token against B): B's engineSessionId still untouched", db.getSession(SID_B)?.engineSessionId === null);

  // === Forgery 3: a forged Stop, same wrong-session-token shape — the OTHER hook type the card cites
  // as corrupting delivery state (busy/rate-limit), also blocked. ===
  const forgedStop = await postHook(SID_B, { hook_event_name: "Stop", session_id: "engine-FORGED-into-B" }, tokenA);
  check("forge-3 (forged Stop, wrong token): REJECTED → 403", forgedStop.statusCode === 403);
  check("forge-3 (forged Stop, wrong token): B's busy state untouched (still false, never armed)", db.getSession(SID_B)?.busy === false);

  // === Legit for B: B's OWN real token succeeds — fail-closed does NOT break the real relay's own path. ===
  const legitB = await postHook(SID_B, { hook_event_name: "SessionStart", session_id: "engine-legit-B" }, tokenB);
  check("legit-B: B's own token → 200", legitB.statusCode === 200);
  check("legit-B: B's engineSessionId now correctly captured", db.getSession(SID_B)?.engineSessionId === "engine-legit-B");
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  try { host.stop(SID_A, "hard"); } catch { /* ignore */ }
  try { host.stop(SID_B, "hard"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /internal/hook now requires a caller to present the TARGET session's own per-session " +
    "token (minted at spawn) before a hook is processed: a missing token, and a VALID-but-wrong-session " +
    "token, are both rejected with 403 and leave the target session's state untouched, while each " +
    "session's own real token still delivers normally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
