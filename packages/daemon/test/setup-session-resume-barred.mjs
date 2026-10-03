import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 39b58667 — resume() carries `role: session.role` through unchanged, so resuming an EXITED "setup"
// row while a DIFFERENT setup row for the same agent is genuinely live used to mint a SECOND live setup
// session, bypassing startSetup's/forkSession's own "never two LIVE setup sessions" singleton (decision
// ad131671, closed for fork by card 15806f81). The refusal here is keyed on VERIFIED `pty.isAlive`, never
// the raw DB "live" flag — that is what lets a boot-time resume of several rows that were ALL still
// DB-flagged "live" from before a crash resolve correctly instead of being falsely refused.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty/stop seam, mirroring setup-session-fork-barred.mjs's own harness). A real temp git repo
// backs the spawn cwd; a real (stub) transcript file is written under the sandboxed HOME so an exited
// setup row is genuinely resumable (engineTranscriptExists passes).
//
//   (A) resume() on the row that IS the live setup session itself → idempotent no-op (the pre-existing
//       pty.isAlive(session.id) short-circuit), never refused, never re-spawned.
//   (B) resume() an EXITED setup sibling while a DIFFERENT setup session (same agent) is GENUINELY
//       (pty-verified) live → refused; nothing mutated (both rows' states untouched, no spawn).
//   (C) resume() an EXITED setup session when NO sibling is pty-verified-live for that agent → succeeds
//       (control) — pty.isAlive flips true, processState flips to "live".
//   (D) THE BOOT-RACE case (the hard part the card's kickoff warned about): two setup rows for ONE agent,
//       BOTH DB-flagged "live" but NEITHER actually pty-alive yet. Round 2 correction: this is NOT
//       "stale post-crash state" — recoverStaleSessions() flips every captured-live row to "exited"
//       before resumeFleetOnBoot's loop ever calls resume() for any of them (index.ts ~309, well before
//       ~1519), so neither row is still DB-live from before the restart by the time either resume() call
//       happens. The genuinely "live" DB flag this scenario exercises is one resume() itself just wrote,
//       moments earlier IN THIS SAME LOOP, for the row resumed first (service.ts's M5 ordering:
//       setProcessState(id, "live") runs, then pty.spawn) — so seeding both rows "live" here is a direct
//       stand-in for that mid-loop state, not a simulation of a pre-crash leftover. The row resumed SECOND
//       is deliberately the MORE-RECENTLY-ACTIVE one by `last_activity` (so it's always the
//       `liveSetupSession` (singular) `.find()` match, regardless of which row this is). Both D1/D2 run
//       the same adversarial construction (fresh row-pairs, different agent ids) — a naive self-exclusion
//       built on the singular helper matches ITSELF when resuming that row and never even looks at the
//       sibling, wrongly succeeding and minting a second live row; this is the sharp regression test
//       `liveSetupSessions` (plural) exists to pass. Resuming the FIRST row must succeed (never falsely
//       refused merely because a sibling ALSO carries a "live" flag); resuming the SECOND must then be
//       correctly refused.
//   (E) resume() a non-setup (manager) row is UNAFFECTED by this check (role-gate control).
//   (F) the REST /resume route maps SETUP_SESSION_RESUME_BARRED_ERROR to 409; an unrelated error is NOT
//       remapped (control).
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-session-resume-barred.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time; transcript.ts reads os.homedir()). ---
const tmpHome = path.join(os.tmpdir(), `loom-setup-resume-barred-${Date.now()}-${process.pid}`);
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
const { SessionService, SETUP_SESSION_RESUME_BARRED_ERROR } = await import("../dist/sessions/service.js");
const { MANAGER_SESSION_BARRED_ERROR } = await import("../dist/agents/clone-core.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { buildServer } = await import("../dist/gateway/server.js");

// --- a real temp git repo so a resume has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-setup-resume-barred-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# setup-resume-barred test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=srb@loom -c user.name=srb");

// Write a stub engine transcript so a given engine id is genuinely RESUMABLE
// (engineTranscriptExists resolves <home>/.claude/projects/<encodeProjectDir(cwd)>/<eng>.jsonl).
const writeTranscript = (cwd, eng) => {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pMgrE", name: "pMgrE", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pHome", name: "A", startupPrompt: "SETUP", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pHome", name: "B", startupPrompt: "SETUP", position: 1, profileId: null });
db.insertAgent({ id: "agentC", projectId: "pHome", name: "C", startupPrompt: "SETUP", position: 2, profileId: null });
db.insertAgent({ id: "agentD1", projectId: "pHome", name: "D1", startupPrompt: "SETUP", position: 3, profileId: null });
db.insertAgent({ id: "agentD2", projectId: "pHome", name: "D2", startupPrompt: "SETUP", position: 4, profileId: null });
db.insertAgent({ id: "agentE", projectId: "pMgrE", name: "E", startupPrompt: "MGR", position: 5, profileId: null });

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

const seedSession = (id, agentId, role, processState, eng, projectId = "pHome", lastActivity = now) => {
  writeTranscript(repo, eng);
  db.insertSession({
    id, projectId, agentId, engineSessionId: eng, title: null,
    cwd: repo, processState, resumability: "unknown", busy: false,
    createdAt: now, lastActivity, lastError: null, role, parentSessionId: null,
  });
};

const allRowCount = () => db.listAllSessionsIncludingArchived().length;

// Sanity: guards every later `err?.message === SOME_CONSTANT` check below from a vacuous
// undefined-equals-undefined pass if a future refactor ever stops exporting the constant.
check("(setup) SETUP_SESSION_RESUME_BARRED_ERROR resolved to a non-empty string", typeof SETUP_SESSION_RESUME_BARRED_ERROR === "string" && SETUP_SESSION_RESUME_BARRED_ERROR.length > 0);

try {
  // ==================== (A) resume() the LIVE setup session itself → idempotent no-op ====================
  seedSession("liveA", "agentA", "setup", "live", "eng-liveA");
  // Make it GENUINELY pty-alive first (real fork/resume semantics assume this) — spawn it via a fresh
  // resume of its own exited predecessor is unnecessary here: forkSession already proves the "first
  // resume of a lone row" path (C below); this scenario needs liveA to already be pty-alive. Resume an
  // exited twin into it isn't needed — directly resuming liveA from a NOT-yet-alive state first primes
  // the pty, then a SECOND resume of the SAME id proves idempotency.
  const primeA = svc.resume("liveA");
  check("(A) priming resume succeeds and liveA is now pty-alive", primeA?.processState === "live" && host.isAlive("liveA"));
  const spawnedBeforeA = host.spawned.length;
  let errA2;
  let r2A;
  try { r2A = svc.resume("liveA"); } catch (e) { errA2 = e; }
  check("(A) re-resuming the SAME already-alive row is a no-op, never refused", !errA2 && r2A?.id === "liveA");
  check("(A) no second spawn happened (the pty.isAlive short-circuit returned early)", host.spawned.length === spawnedBeforeA);

  // ============== (B) resume() an EXITED setup sibling while a GENUINELY-live one exists → refused ==============
  seedSession("exitedB", "agentB", "setup", "exited", "eng-exitedB");
  seedSession("liveB", "agentB", "setup", "live", "eng-liveB");
  svc.resume("liveB"); // make liveB genuinely pty-alive (verified, not just DB-flagged)
  check("(B) liveB is genuinely pty-alive before the refusal check", host.isAlive("liveB"));
  const beforeB = allRowCount();
  const spawnedBeforeB = host.spawned.length;
  let errB;
  try { svc.resume("exitedB"); } catch (e) { errB = e; }
  check("(B) resuming an exited sibling while another is GENUINELY live throws SETUP_SESSION_RESUME_BARRED_ERROR", !!errB && errB.message === SETUP_SESSION_RESUME_BARRED_ERROR);
  check("(B) no new row was minted", allRowCount() === beforeB);
  check("(B) no spawn happened for exitedB (refused before pty.spawn)", host.spawned.length === spawnedBeforeB);
  check("(B) the refused source stays exited (untouched)", db.getSession("exitedB")?.processState === "exited");
  check("(B) the live sibling stays live (untouched)", db.getSession("liveB")?.processState === "live" && host.isAlive("liveB"));

  // ======== (C) resume() an EXITED setup session when NO sibling is live for that agent → succeeds (control) ========
  seedSession("exitedC", "agentC", "setup", "exited", "eng-exitedC");
  let errC, resC;
  try { resC = svc.resume("exitedC"); } catch (e) { errC = e; }
  check("(C) CONTROL: no live sibling for this agent → resume succeeds", !errC && resC?.id === "exitedC");
  check("(C) exitedC is now genuinely pty-alive", host.isAlive("exitedC") && db.getSession("exitedC")?.processState === "live");

  // ==================== (D) THE BOOT-RACE CASE — run twice, independently ====================
  // Two setup rows for ONE agent, BOTH DB-flagged "live" but NEITHER actually pty-alive — a DB-live
  // flag that disagrees with real pty liveness (a phantom-live row, per resume()'s own M5 ordering: see
  // the decision record), never a leftover pre-crash staleness. Resuming EITHER ONE first must succeed
  // (not falsely refused by a sibling's DB-live-but-not-pty-alive row); resuming the SECOND must then be
  // correctly refused once the first has genuinely resumed (both DB-live AND pty-alive by then).
  // `secondId` (the one resumed SECOND) is seeded with a LATER lastActivity than `firstId` — db.liveSessions'
  // own "most-recently-active first" ordering then ALWAYS makes secondId the liveSetupSession (singular,
  // first-by-recency) match, regardless of which row resume() is actually called for. That is exactly the
  // shape that defeats a naive self-exclusion built on the singular helper: resuming secondId would find
  // ITSELF as the "match" and skip checking firstId entirely — see the decision record.
  const runBootRace = (label, agentId, firstId, secondId) => {
    seedSession(firstId, agentId, "setup", "live", `eng-${firstId}`, "pHome", now);
    seedSession(secondId, agentId, "setup", "live", `eng-${secondId}`, "pHome", new Date(Date.parse(now) + 60_000).toISOString());
    check(`${label} neither row is pty-alive yet (DB-live, not pty-verified)`, !host.isAlive(firstId) && !host.isAlive(secondId));
    let errFirst;
    let resFirst;
    try { resFirst = svc.resume(firstId); } catch (e) { errFirst = e; }
    check(`${label} resuming the FIRST row succeeds (never refused by a sibling's DB-live-but-not-pty-alive row)`, !errFirst && resFirst?.id === firstId && host.isAlive(firstId));
    let errSecond;
    try { svc.resume(secondId); } catch (e) { errSecond = e; }
    check(`${label} resuming the SECOND row is now correctly refused (the first is genuinely pty-alive now)`, !!errSecond && errSecond.message === SETUP_SESSION_RESUME_BARRED_ERROR);
    check(`${label} the second row was never actually resumed (stays "live" in DB but genuinely NOT pty-alive)`, !host.isAlive(secondId));
  };
  // D1/D2: the SAME adversarial construction, independently, on two different agents/row-id pairs — both
  // must hold; this is the sharp regression test for a naive liveSetupSession (singular, first-by-recency)
  // reuse, which would always return the SAME (recency-first) match regardless of which row this calls
  // resume() on, so a self-exclusion built on it can mask a genuinely-live OTHER row — see this card's
  // decision record for the exact mechanism. liveSetupSessions (plural) fixes this.
  runBootRace("(D1)", "agentD1", "d1a", "d1b");
  runBootRace("(D2)", "agentD2", "d2b", "d2a");

  // ==================== (E) resume() a manager row is UNAFFECTED (role-gate control) ====================
  seedSession("liveE", "agentE", "manager", "live", "eng-liveE", "pMgrE");
  svc.resume("liveE");
  seedSession("exitedE", "agentE", "manager", "exited", "eng-exitedE", "pMgrE");
  let errE, resE;
  try { resE = svc.resume("exitedE"); } catch (e) { errE = e; }
  check("(E) CONTROL: resuming a manager sibling while another manager is live is UNAFFECTED by this check", !errE && resE?.id === "exitedE" && resE?.role === "manager");

  // ==================== (F) REST /resume route error-mapping ====================
  const stub = {};
  const sessionsStub = {
    resume: (id) => {
      if (id === "setupResumeBarred") throw new Error(SETUP_SESSION_RESUME_BARRED_ERROR);
      if (id === "mgrBarred") throw new Error(MANAGER_SESSION_BARRED_ERROR);
      if (id === "boom") throw new Error("plain failure");
      return { id, role: "setup" };
    },
  };
  const app = await buildServer({ db, pty: stub, sessions: sessionsStub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const rSetupResume409 = await app.inject({ method: "POST", url: "/api/sessions/setupResumeBarred/resume" });
  check("(F) POST /resume on the new setup-resume-barred refusal ⇒ 409", rSetupResume409.statusCode === 409);
  check("(F) its body carries the SETUP_SESSION_RESUME_BARRED_ERROR text", JSON.parse(rSetupResume409.body).error === SETUP_SESSION_RESUME_BARRED_ERROR);

  const rMgrResume409 = await app.inject({ method: "POST", url: "/api/sessions/mgrBarred/resume" });
  check("(F) POST /resume on MANAGER_SESSION_BARRED_ERROR still maps ⇒ 409 (unchanged)", rMgrResume409.statusCode === 409);

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
  ? "\n✅ ALL PASS — resume() refuses when a role-\"setup\" row would mint a 2nd GENUINELY-live setup session, verified via pty.isAlive (never the raw DB flag); re-resuming the same live row stays idempotent; a boot-race of two stale-\"live\" rows resolves to exactly one survivor regardless of resume-call order; manager resumes are unaffected; and the REST /resume route maps SETUP_SESSION_RESUME_BARRED_ERROR to an honest 409."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
