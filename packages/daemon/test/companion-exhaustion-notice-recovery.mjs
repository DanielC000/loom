import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card da0e3fee — a Companion's "has run out of context" owner notice is retired (daemon-dismissed) when the
// Companion GENUINELY recovers: a COMPLETED turn after the exhaustion mark cleared, not the clear itself.
// Drives SessionService.retireAssistantExhaustionNoticeOnRecovery (what index.ts's onTurnCompleted calls) on a
// REAL Db + SessionService; hermetic (temp LOOM_HOME, no pty, no daemon, no network).
//
// Run: 1) build, 2) node packages/daemon/test/companion-exhaustion-notice-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cmp-exrec-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { ASSISTANT_EXHAUSTION_TITLE_SUFFIX, assistantExhaustionNoticeId } = await import("../dist/orchestration/context-watcher.js");

class SeamHost extends createSeamHost(PtyHost) {}
const now = new Date().toISOString();
const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const db = new Db();
const svc = new SessionService(db, new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} }), new OrchestrationControl());

const projId = randomUUID();
db.insertProject({ id: projId, name: "ExRec", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
const profileId = randomUUID();
db.insertProfile({
  id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
});
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Juno", startupPrompt: "p", position: 0, profileId, endpoint: false, ioSchema: null });

function mkSession(role) {
  const id = randomUUID();
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id.slice(0, 6)}`, title: null, cwd,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, browserTesting: false, documentConversion: false, restrictedTools: false,
    noCommit: false, skills: null, connections: [], capabilities: [],
  });
  return id;
}
function mkCompanion() {
  const id = mkSession("assistant");
  db.upsertCompanionConfig({
    sessionId: id, botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
    heartbeatIntervalMinutes: 5, heartbeatPrompt: null, enabled: true, provisioned: true, name: "Juno",
  });
  return id;
}
function fileNotice(sid, stamp = new Date().toISOString()) {
  const id = assistantExhaustionNoticeId(sid, stamp);
  db.insertQuestion({
    id, sessionId: sid, filedBySessionId: sid, projectId: projId, type: "notice",
    title: `Juno${ASSISTANT_EXHAUSTION_TITLE_SUFFIX}`, body: "b", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null, decidedScope: null, decidedExpiresAt: null,
    credentialEnvVar: null, credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
    provisionConnectionId: null, provisionBindingState: "none", state: "notice", chosenOption: null, note: null,
    createdAt: stamp, answeredAt: stamp, consumedAt: null, cancelledReason: null, cancelledBy: null, cancelledAt: null,
    escalatedAt: null, acknowledgedUntil: null, readAt: null, dismissedAt: null, attachments: [],
  });
  return id;
}
const dismissedAtOf = (id) => db.getQuestion(id)?.dismissedAt ?? null;
const EXH = "Context exhausted — the engine rejected the next prompt as too long (test).";

// (A) RECOVER: exhausted -> notice filed -> mark cleared on the retry's rising edge -> a COMPLETED turn.
{
  const sid = mkCompanion();
  const nid = fileNotice(sid);
  db.setContextExhausted(sid, now, EXH);
  db.setBusy(sid, true); db.clearContextExhaustedOnResume(sid); // the retry starts: mark cleared
  check("(A) the clear alone does NOT dismiss (no completed turn yet)", dismissedAtOf(nid) == null);
  const out = svc.retireAssistantExhaustionNoticeOnRecovery(sid);
  check("(A) a completed turn after the clear dismisses the notice", dismissedAtOf(nid) != null && out.length === 1 && out[0] === nid);
  check("(A) retiring again is a no-op (idempotent)", svc.retireAssistantExhaustionNoticeOnRecovery(sid).length === 0);
}

// (B) FAIL-AGAIN: the retry re-exhausts (mark set again) -> a turn-completion signal must NOT retire the notice.
{
  const sid = mkCompanion();
  const nid = fileNotice(sid);
  db.setContextExhausted(sid, now, EXH);
  db.setBusy(sid, true); db.clearContextExhaustedOnResume(sid);
  db.setContextExhausted(sid, new Date().toISOString(), EXH); // re-marked by the watcher
  const out = svc.retireAssistantExhaustionNoticeOnRecovery(sid);
  check("(B) a re-exhausted Companion keeps its notice", dismissedAtOf(nid) == null && out.length === 0);
}

// (C) RECYCLE then a completed turn: recycle's own dismissal (same db write) first; the retire must not
// double-dismiss (stamp unchanged) and must not throw.
{
  const sid = mkCompanion();
  const nid = fileNotice(sid);
  const recycleStamp = "2026-01-01T00:00:00.000Z";
  db.dismissNotices([nid], recycleStamp);
  let threw = false; let out = null;
  try { out = svc.retireAssistantExhaustionNoticeOnRecovery(sid); } catch { threw = true; }
  check("(C) no error when the notice is already gone", !threw);
  check("(C) no double-dismiss: nothing returned, original stamp untouched", out?.length === 0 && dismissedAtOf(nid) === recycleStamp);
}

// (D) scope: a non-Companion session and an unrelated (non-exhaustion) notice are untouched.
{
  const plain = mkSession("assistant"); // no companion config
  const pn = fileNotice(plain);
  check("(D) a session with no Companion config is untouched", svc.retireAssistantExhaustionNoticeOnRecovery(plain).length === 0 && dismissedAtOf(pn) == null);
  const sid = mkCompanion();
  const other = randomUUID();
  db.insertQuestion({
    id: other, sessionId: sid, filedBySessionId: sid, projectId: projId, type: "notice", title: "Something else", body: "b",
    options: null, recommendation: null, taskId: null, permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null, provisionTarget: null,
    fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none", state: "notice", chosenOption: null, note: null,
    createdAt: now, answeredAt: now, consumedAt: null, cancelledReason: null, cancelledBy: null, cancelledAt: null,
    escalatedAt: null, acknowledgedUntil: null, readAt: null, dismissedAt: null, attachments: [],
  });
  svc.retireAssistantExhaustionNoticeOnRecovery(sid);
  check("(D) an unrelated notice on the Companion is NOT dismissed", dismissedAtOf(other) == null);
}

// (E) wiring: the real onTurnCompleted chokepoint (index.ts) calls the retire — and not from the busy edge.
{
  const idx = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const m = /onTurnCompleted:\s*\(sessionId\)\s*=>\s*\{([\s\S]*?)\r?\n    \},/.exec(idx);
  check("(E) index.ts onTurnCompleted calls retireAssistantExhaustionNoticeOnRecovery", !!m && m[1].includes("retireAssistantExhaustionNoticeOnRecovery(sessionId)"));
  const svcSrc = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
  const edge = /handleBusyEdge\(sessionId: string, busy: boolean\): void \{[\s\S]*?\r?\n  \}\r?\n/.exec(svcSrc);
  check("(E) the busy edge (the clear) does NOT retire the notice", !!edge && !edge[0].includes("retireAssistantExhaustionNotice"));
}

try { db.close?.(); } catch { /* best effort */ }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
