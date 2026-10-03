import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 15806f81 — forkSession carries `role: src.role` through unchanged, so forking a "setup" source
// used to mint a SECOND live row with that role, bypassing startSetup's own "never two LIVE setup
// sessions" singleton (decision ad131671). "platform" is DELIBERATELY NOT subject to any such check —
// decision 8ddcf787 removed startPlatformLead's old singleton guard; multiple concurrent Platform Leads
// coexist by design, and that must stay true on the fork path too.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty/stop seam, mirroring setup-singleton.mjs's own harness). A real temp git repo backs the
// spawn cwd; a real (stub) transcript file is written under the sandboxed HOME so an exited source is
// genuinely resumable (engineTranscriptExists passes) — the same "resumable yet refused anyway" shape
// setup-singleton.mjs already proves for startSetup, now proved for forkSession.
//
//   (A) fork the LIVE setup session itself → refused (it IS the live one; a 2nd row would still be a
//       2nd live setup session).
//   (B) fork an EXITED setup session while a DIFFERENT setup session (same agent) is live → refused.
//   (C) fork an EXITED setup session when NO setup session is live for that agent → succeeds (control).
//   (D) fork a manager source is UNAFFECTED by this check (role gate — control).
//   (E) fork a platform source while ANOTHER platform session is live → SUCCEEDS (negative control
//       proving no singleton check was added for "platform").
//   (F) the REST /fork and /resume routes map MANAGER_SESSION_BARRED_ERROR / the new
//       SETUP_SESSION_FORK_BARRED_ERROR to 409; an unrelated error is NOT remapped (control).
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-session-fork-barred.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time; transcript.ts reads os.homedir()). ---
const tmpHome = path.join(os.tmpdir(), `loom-setup-fork-barred-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
const { commitAll } = await import("./_git-commit.mjs");
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, SETUP_SESSION_FORK_BARRED_ERROR } = await import("../dist/sessions/service.js");
const { MANAGER_SESSION_BARRED_ERROR } = await import("../dist/agents/clone-core.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { buildServer } = await import("../dist/gateway/server.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-setup-fork-barred-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# setup-fork-barred test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=sfb@loom -c user.name=sfb");

// Write a stub engine transcript so a given engine id is genuinely RESUMABLE/FORKABLE
// (engineTranscriptExists resolves <home>/.claude/projects/<encodeProjectDir(cwd)>/<eng>.jsonl).
const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// pHome is `reserved: true` on purpose (it models the Getting Started home for the setup-singleton
// checks (A)-(C)/(E) above). Since decision c30759a0 merged forward, ANY manager-role fork now also
// checks managerSessionBarredFrom(project) — which is unconditionally true for a reserved project — so
// (D)'s manager control needs its OWN, ordinary (non-reserved) project to stay a pure role-gate control
// for the SETUP-specific check (ad131671) rather than tripping the unrelated, correctly-firing c30759a0
// check. c30759a0's own fork behavior is covered by manager-session-barred-recycle-resume-rebind.mjs's
// section (E).
db.insertProject({ id: "pMgrD", name: "pMgrD", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pHome", name: "A", startupPrompt: "SETUP", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pHome", name: "B", startupPrompt: "SETUP", position: 1, profileId: null });
db.insertAgent({ id: "agentC", projectId: "pHome", name: "C", startupPrompt: "SETUP", position: 2, profileId: null });
db.insertAgent({ id: "agentD", projectId: "pMgrD", name: "D", startupPrompt: "MGR", position: 3, profileId: null });
db.insertAgent({ id: "agentE", projectId: "pHome", name: "E", startupPrompt: "LEAD", position: 4, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const seedSession = (id, agentId, role, processState, eng, projectId = "pHome") => {
  writeTranscript(repo, eng);
  db.insertSession({
    id, projectId, agentId, engineSessionId: eng, title: null,
    cwd: repo, processState, resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
  });
};

const allRowCount = () => db.listAllSessionsIncludingArchived().length;

// Sanity: both error-message constants must resolve to real, non-empty strings — guards every later
// `errX?.message === SOME_CONSTANT` check below from a vacuous undefined-equals-undefined pass if a
// future refactor ever stops exporting one of them (the exact trap an earlier draft of this file hit).
check("(setup) SETUP_SESSION_FORK_BARRED_ERROR resolved to a non-empty string", typeof SETUP_SESSION_FORK_BARRED_ERROR === "string" && SETUP_SESSION_FORK_BARRED_ERROR.length > 0);
check("(setup) MANAGER_SESSION_BARRED_ERROR resolved to a non-empty string", typeof MANAGER_SESSION_BARRED_ERROR === "string" && MANAGER_SESSION_BARRED_ERROR.length > 0);

try {
  // ==================== (A) fork the LIVE setup session itself → refused ====================
  seedSession("liveA", "agentA", "setup", "live", "eng-liveA");
  const beforeA = allRowCount();
  let errA;
  try { svc.forkSession("liveA"); } catch (e) { errA = e; }
  check("(A) forking the live setup session itself throws SETUP_SESSION_FORK_BARRED_ERROR", !!errA && typeof SETUP_SESSION_FORK_BARRED_ERROR === "string" && errA.message === SETUP_SESSION_FORK_BARRED_ERROR);
  check("(A) no new row was minted", allRowCount() === beforeA);
  check("(A) the source is untouched — still live", db.getSession("liveA")?.processState === "live");

  // ============== (B) fork an EXITED setup sibling while a DIFFERENT one is live → refused ==============
  seedSession("liveB", "agentB", "setup", "live", "eng-liveB");
  seedSession("exitedB", "agentB", "setup", "exited", "eng-exitedB");
  const beforeB = allRowCount();
  let errB;
  try { svc.forkSession("exitedB"); } catch (e) { errB = e; }
  check("(B) forking an exited setup sibling while another is live throws the same error", !!errB && typeof SETUP_SESSION_FORK_BARRED_ERROR === "string" && errB.message === SETUP_SESSION_FORK_BARRED_ERROR);
  check("(B) no new row was minted", allRowCount() === beforeB);
  check("(B) the exited source stays exited (untouched)", db.getSession("exitedB")?.processState === "exited");
  check("(B) the live sibling stays live (untouched)", db.getSession("liveB")?.processState === "live");

  // ======== (C) fork an EXITED setup session when NONE is live for that agent → succeeds (control) ========
  seedSession("exitedC", "agentC", "setup", "exited", "eng-exitedC");
  const beforeC = allRowCount();
  let forkedC, errC;
  try { forkedC = svc.forkSession("exitedC"); } catch (e) { errC = e; }
  check("(C) CONTROL: no setup session live for this agent → fork succeeds", !errC && !!forkedC);
  check("(C) a new live row was minted (role 'setup')", allRowCount() === beforeC + 1 && forkedC?.role === "setup" && forkedC?.processState === "live");

  // ==================== (D) fork a manager source is UNAFFECTED (role-gate control) ====================
  seedSession("liveD", "agentD", "manager", "live", "eng-liveD", "pMgrD");
  let forkedD, errD;
  try { forkedD = svc.forkSession("liveD"); } catch (e) { errD = e; }
  check("(D) CONTROL: forking a manager source is not subject to this check at all", !errD && forkedD?.role === "manager");

  // ========= (E) fork a platform source while ANOTHER platform session is live → SUCCEEDS =========
  // Negative control proving no "platform" singleton was added — decision 8ddcf787 allows multiple
  // concurrent Leads, and a fork of one must not be refused just because a sibling Lead is live.
  seedSession("liveE1", "agentE", "platform", "live", "eng-liveE1");
  seedSession("exitedE2", "agentE", "platform", "exited", "eng-exitedE2");
  const beforeE = allRowCount();
  let forkedE, errE;
  try { forkedE = svc.forkSession("exitedE2"); } catch (e) { errE = e; }
  check("(E) CONTROL: forking a platform source while a sibling platform session is live still succeeds", !errE && !!forkedE);
  check("(E) a new live platform row was minted (now THREE platform rows total for this agent)",
    allRowCount() === beforeE + 1 && forkedE?.role === "platform" && forkedE?.processState === "live"
    && db.listSessions("agentE").filter((s) => s.role === "platform").length === 3);
  // Forking the still-LIVE liveE1 itself must ALSO succeed (unlike setup's (A) above) — the sharpest proof
  // that "platform" carries no singleton on this path at all.
  let forkedE2, errE2;
  try { forkedE2 = svc.forkSession("liveE1"); } catch (e) { errE2 = e; }
  check("(E) CONTROL: forking the LIVE platform source itself also succeeds (no singleton, unlike setup's (A))", !errE2 && !!forkedE2 && forkedE2.role === "platform");

  // ==================== (F) REST route error-mapping ====================
  const stub = {};
  const sessionsStub = {
    forkSession: (id) => {
      if (id === "setupBarred") throw new Error(SETUP_SESSION_FORK_BARRED_ERROR);
      if (id === "mgrBarred") throw new Error(MANAGER_SESSION_BARRED_ERROR);
      if (id === "boom") throw new Error("plain failure");
      return { id, role: "setup" };
    },
    resume: (id) => {
      if (id === "mgrBarred") throw new Error(MANAGER_SESSION_BARRED_ERROR);
      if (id === "boom") throw new Error("plain failure");
      return { id, role: "manager" };
    },
  };
  const app = await buildServer({ db, pty: stub, sessions: sessionsStub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const rSetup409 = await app.inject({ method: "POST", url: "/api/sessions/setupBarred/fork" });
  check("(F) POST /fork on the new setup-barred refusal ⇒ 409", rSetup409.statusCode === 409);
  check("(F) its body carries the SETUP_SESSION_FORK_BARRED_ERROR text", JSON.parse(rSetup409.body).error === SETUP_SESSION_FORK_BARRED_ERROR);

  const rMgrFork409 = await app.inject({ method: "POST", url: "/api/sessions/mgrBarred/fork" });
  check("(F) POST /fork on MANAGER_SESSION_BARRED_ERROR ⇒ 409 (was falling through to 500)", rMgrFork409.statusCode === 409);
  check("(F) its body carries the MANAGER_SESSION_BARRED_ERROR text", JSON.parse(rMgrFork409.body).error === MANAGER_SESSION_BARRED_ERROR);

  const rForkPlain = await app.inject({ method: "POST", url: "/api/sessions/boom/fork" });
  check("(F) CONTROL: an unrelated /fork error is NOT remapped to 409", rForkPlain.statusCode !== 409);

  const rMgrResume409 = await app.inject({ method: "POST", url: "/api/sessions/mgrBarred/resume" });
  check("(F) POST /resume on MANAGER_SESSION_BARRED_ERROR ⇒ 409 (was falling through to 500 — no catch at all before)", rMgrResume409.statusCode === 409);
  check("(F) its body carries the MANAGER_SESSION_BARRED_ERROR text", JSON.parse(rMgrResume409.body).error === MANAGER_SESSION_BARRED_ERROR);

  const rResumePlain = await app.inject({ method: "POST", url: "/api/sessions/boom/resume" });
  check("(F) CONTROL: an unrelated /resume error is NOT remapped to 409", rResumePlain.statusCode !== 409);

  const rResumeOk = await app.inject({ method: "POST", url: "/api/sessions/ok/resume" });
  check("(F) CONTROL: a successful /resume still returns 200", rResumeOk.statusCode === 200);

  await app.close();
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — forkSession refuses when a role-\"setup\" source would mint a 2nd live setup session (own-live or a live sibling), succeeds once none is live (control), never touches manager/platform forks (platform explicitly stays multi-Lead per decision 8ddcf787), and the REST /fork + /resume routes now map MANAGER_SESSION_BARRED_ERROR and SETUP_SESSION_FORK_BARRED_ERROR to an honest 409 instead of falling through to 500."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
