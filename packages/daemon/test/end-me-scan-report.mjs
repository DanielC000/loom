// Auditor `end_me` scan-completion marker (card 72249ae0) — proves SessionService.endMe's `scanReport`
// absence-is-the-signal behavior for BOTH auditor-shaped roles. In-process: drives endMe() against the
// REAL PtyHost state machine (a fake IPty injected via the createPty() seam, mirroring end-me.mjs) — NO
// real claude, no daemon, no network.
//
// Proves:
//   (AUDITOR no scanReport)      → stopped:true; end_me_complete event detail has NO scanReport key; a
//                                   LOW-severity finding is auto-filed onto the reserved Platform board.
//   (AUDITOR with scanReport)    → stopped:true; event detail.scanReport === the given text; NO finding
//                                   auto-filed (task count on the Platform board unchanged).
//   (AUDITOR whitespace-only)    → a whitespace-only scanReport counts as ABSENT (trimmed empty) — same
//                                   auto-file behavior as no scanReport at all.
//   (WORKSPACE-AUDITOR no report)→ stopped:true; a LOW-severity suggestion is filed onto the user's own
//                                   reserved home (mirrors the auditor case on its own reserved project).
//   (WORKSPACE-AUDITOR w/report) → stopped:true; NO suggestion auto-filed.
//   (MANAGER unaffected)         → a non-auditor role passing `{scanReport}` never auto-files anything —
//                                   the field is a no-op outside the two auditor-shaped roles.
//
// Run: 1) build daemon (pnpm build), 2) node test/end-me-scan-report.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tmpHome = path.join(os.tmpdir(), `loom-endme-scanreport-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { seedSetupHome, SETUP_PROJECT_NAME } = await import("../dist/setup/seed.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date().toISOString();

// Same fixture shape as end-me.mjs — endMe's assertions only need the WRITE side, not a real process exit.
const fakes = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const db = new Db();
const sessions = new SessionService(db, host, new OrchestrationControl());

seedPlatformHome(db);
seedSetupHome(db);
const platformHome = db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
const setupHome = db.getReservedProjectByName(SETUP_PROJECT_NAME);

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `endme-sr-proj-${sfx}`, agentId = `endme-sr-ag-${sfx}`;
db.insertProject({ id: projId, name: "EndMeSR", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });

function spawnSession(_tag, role) {
  // A REAL uuid (mirrors production session ids) — NOT a readable `endme-sr-<tag>-<sfx>` id: every such
  // id here would share the same first-8-chars prefix, and auditFileFinding/workspaceAuditSuggest dedupe
  // by normalized TITLE, which embeds that prefix — a shared prefix would collide distinct test findings
  // into one deduped row and hide the very count this test asserts on.
  const id = randomUUID();
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role });
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // → ready
  return id;
}

try {
  // ── (AUDITOR no scanReport) ─────────────────────────────────────────────────────────────────────────
  const platformTasksBefore = db.listTasks(platformHome.id).length;
  const AUD_NONE = spawnSession("aud-none", "auditor");
  const rAudNone = sessions.endMe(AUD_NONE);
  check("(auditor, no scanReport) endMe → {stopped:true}", rAudNone.stopped === true);
  const evAudNone = db.listEvents(AUD_NONE).find((e) => e.kind === "end_me_complete");
  check("(auditor, no scanReport) end_me_complete event recorded with NO scanReport key", !!evAudNone && !("scanReport" in (evAudNone.detail ?? {})));
  const platformTasksAfterNone = db.listTasks(platformHome.id);
  check("(auditor, no scanReport) a LOW-severity finding was auto-filed on the Platform board",
    platformTasksAfterNone.length === platformTasksBefore + 1 &&
    platformTasksAfterNone.some((t) => t.title.includes(AUD_NONE.slice(0, 8)) && /scan-completion report/i.test(t.title)));

  // ── (AUDITOR with scanReport) ───────────────────────────────────────────────────────────────────────
  const AUD_WITH = spawnSession("aud-with", "auditor");
  const rAudWith = sessions.endMe(AUD_WITH, { scanReport: "covered 4 manager transcripts, 0 findings" });
  check("(auditor, with scanReport) endMe → {stopped:true}", rAudWith.stopped === true);
  const evAudWith = db.listEvents(AUD_WITH).find((e) => e.kind === "end_me_complete");
  check("(auditor, with scanReport) event detail.scanReport carries the given text",
    evAudWith?.detail?.scanReport === "covered 4 manager transcripts, 0 findings");
  const platformTasksAfterWith = db.listTasks(platformHome.id);
  check("(auditor, with scanReport) NO finding auto-filed — task count unchanged",
    platformTasksAfterWith.length === platformTasksAfterNone.length);

  // ── (AUDITOR whitespace-only scanReport counts as ABSENT) ──────────────────────────────────────────
  const AUD_WS = spawnSession("aud-ws", "auditor");
  const rAudWs = sessions.endMe(AUD_WS, { scanReport: "   " });
  check("(auditor, whitespace-only scanReport) endMe → {stopped:true}", rAudWs.stopped === true);
  const evAudWs = db.listEvents(AUD_WS).find((e) => e.kind === "end_me_complete");
  check("(auditor, whitespace-only scanReport) treated as absent — no scanReport key", !!evAudWs && !("scanReport" in (evAudWs.detail ?? {})));
  const platformTasksAfterWs = db.listTasks(platformHome.id);
  check("(auditor, whitespace-only scanReport) a finding was auto-filed (same as no-report case)",
    platformTasksAfterWs.length === platformTasksAfterWith.length + 1 &&
    platformTasksAfterWs.some((t) => t.title.includes(AUD_WS.slice(0, 8))));

  // ── (WORKSPACE-AUDITOR no scanReport) ───────────────────────────────────────────────────────────────
  const setupTasksBefore = db.listTasks(setupHome.id).length;
  const WSA_NONE = spawnSession("wsa-none", "workspace-auditor");
  const rWsaNone = sessions.endMe(WSA_NONE);
  check("(workspace-auditor, no scanReport) endMe → {stopped:true}", rWsaNone.stopped === true);
  const setupTasksAfterNone = db.listTasks(setupHome.id);
  check("(workspace-auditor, no scanReport) a LOW-severity suggestion was auto-filed on the user's home",
    setupTasksAfterNone.length === setupTasksBefore + 1 &&
    setupTasksAfterNone.some((t) => t.title.includes(WSA_NONE.slice(0, 8)) && /scan-completion report/i.test(t.title)));

  // ── (WORKSPACE-AUDITOR with scanReport) ─────────────────────────────────────────────────────────────
  const WSA_WITH = spawnSession("wsa-with", "workspace-auditor");
  const rWsaWith = sessions.endMe(WSA_WITH, { scanReport: "reviewed 2 sessions, suggested 1 preset" });
  check("(workspace-auditor, with scanReport) endMe → {stopped:true}", rWsaWith.stopped === true);
  const evWsaWith = db.listEvents(WSA_WITH).find((e) => e.kind === "end_me_complete");
  check("(workspace-auditor, with scanReport) event detail.scanReport carries the given text",
    evWsaWith?.detail?.scanReport === "reviewed 2 sessions, suggested 1 preset");
  const setupTasksAfterWith = db.listTasks(setupHome.id);
  check("(workspace-auditor, with scanReport) NO suggestion auto-filed — task count unchanged",
    setupTasksAfterWith.length === setupTasksAfterNone.length);

  // ── (MANAGER unaffected) — a non-auditor role passing scanReport never auto-files anything ─────────
  const MGR = spawnSession("mgr", "manager");
  const rMgr = sessions.endMe(MGR, { scanReport: "irrelevant for a manager" });
  check("(manager, scanReport passed) endMe → {stopped:true}", rMgr.stopped === true);
  const platformTasksAfterMgr = db.listTasks(platformHome.id).length;
  const setupTasksAfterMgr = db.listTasks(setupHome.id).length;
  check("(manager, scanReport passed) no Platform-board finding or home suggestion filed",
    platformTasksAfterMgr === platformTasksAfterWs.length && setupTasksAfterMgr === setupTasksAfterWith.length);

  await sleep(50); // let any stray deferred writes settle before teardown
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an auditor/workspace-auditor end_me with no scanReport (or a whitespace-only one) auto-files a low-severity finding/suggestion on the existing, already-triaged board; a genuine scanReport suppresses it and is recorded verbatim; a manager passing scanReport is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
