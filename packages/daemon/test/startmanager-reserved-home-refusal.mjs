import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 37e15c26 — a FRESH session whose RESOLVED role is "manager" is refused whenever its project's
// `repoPath` resolves to LOOM_HOME or an ancestor of it (isLoomHomeOrAncestor, vault/versioner.ts),
// checked BEFORE any session row is inserted or any pty is spawned. Round 2 moved this to the shared
// resolved-role chokepoint (`refuseManagerIntoReservedHome`), called from BOTH `startManager` (explicit
// role) and `startNew` ((f)/(g) below — a role-omitted "+New"/poll/webhook spawn can also resolve
// role==="manager" via a Profile). This closes the SESSION-START half of the reserved-home hazard: both
// reserved homes (Platform / Setup) have `repoPath === vaultPath === LOOM_HOME` by design, and an
// unguarded manager spawn there would let the manager's own workers `git worktree add`/squash-merge
// against LOOM_HOME/.git (see createworktree-reserved-home-guard.mjs for the SEPARATE git-chokepoint half,
// and confirmWorkerMerge's own guard, service.ts, for the round-2 re-resolved-repoPath half).
//
// `startPlatformLead`/`startSetup` are DELIBERATELY NOT guarded this way — both reserved homes
// legitimately run with `cwd === LOOM_HOME` by design, and neither seeds a manager-role agent. This test
// proves that side of the invariant too: both still spawn successfully against the SAME reserved-home-
// shaped project `startManager` refuses.
//
// Card d25e4ea7 (cases (h)-(m)): `refuseManagerIntoReservedHome` now keys on the unified
// `managerSessionBarredFrom` (reserved OR isLoomHomeOrAncestor), not `isLoomHomeOrAncestor` alone — so a
// TRULY reserved project (`reserved:true`) whose repoPath has drifted to an ORDINARY repo (no longer
// LOOM_HOME-or-an-ancestor) must STILL refuse a manager session (h) — the mirror of cases (a)/(b), which
// only ever proved the PATH half. (i)-(m) prove the tightening doesn't collide with any other role: the
// guard fires only on resolved role === "manager", so platform/setup/auditor/workspace-auditor/assistant
// all still spawn fine against that SAME reserved project.
//
// See docs/decisions/37e15c26-refuse-reserved-home-worktree-and-manager-session-start.md and
// docs/decisions/d25e4ea7-unify-reserved-and-operational-home-manager-predicates.md.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: isolated LOOM_HOME, a REAL Db + SessionService driven against a
// FAKE pty injected via PtyHost's createPty() seam (_seam-host-fixture.mjs) — no real claude, no daemon.
//
// Run: 1) build, 2) node test/startmanager-reserved-home-refusal.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const loomHome = fs.realpathSync(useOwnLoomHome("loom-startmanager-ophome-"));
fs.mkdirSync(path.join(loomHome, "logs"), { recursive: true }); // so the fake pty's on-disk log stream has somewhere to write

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ===== (a) a RESERVED-HOME-SHAPED project (repoPath === vaultPath === LOOM_HOME) =====
  db.insertProject({ id: "pReserved", name: "Reserved", repoPath: loomHome, vaultPath: loomHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrReserved", projectId: "pReserved", name: "Rogue Manager", startupPrompt: "", position: 0, profileId: null });
  let threwA = null;
  try { svc.startManager("agentMgrReserved"); } catch (e) { threwA = e; }
  check("(a) startManager against a RESERVED-HOME-shaped project (repoPath===LOOM_HOME) is refused",
    threwA instanceof Error && /manager session can never start in this project/i.test(threwA.message));
  // card 37e15c26 round 2 nitpick: liveSessions() filters to processState:"live" and would miss a row
  // stuck at "starting" (the state a refused spawn reconciles to via reconcileFailedSpawn) — listSessions
  // (unfiltered) is the correct assertion that NO row at all was inserted.
  check("(a) …NO session row was inserted for this agent", db.listSessions("agentMgrReserved").length === 0);
  check("(a) …no pty was ever spawned", host.capture.every((o) => o.projectId !== "pReserved"));

  // ===== (b) an ANCESTOR of LOOM_HOME as repoPath =====
  const ancestor = path.dirname(loomHome);
  db.insertProject({ id: "pAncestor", name: "Ancestor", repoPath: ancestor, vaultPath: ancestor, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrAncestor", projectId: "pAncestor", name: "Rogue Manager 2", startupPrompt: "", position: 0, profileId: null });
  let threwB = null;
  try { svc.startManager("agentMgrAncestor"); } catch (e) { threwB = e; }
  check("(b) startManager against a project whose repoPath is an ANCESTOR of LOOM_HOME is refused",
    threwB instanceof Error && /manager session can never start in this project/i.test(threwB.message));

  // ===== (c) NEGATIVE CONTROL: an ORDINARY project (real repo, unrelated to LOOM_HOME) spawns fine =====
  const ordinaryRepo = path.join(fs.realpathSync(mkdtempManaged("loom-startmanager-ordinary-")), "repo");
  initRepo(ordinaryRepo);
  const ordinaryVault = path.join(path.dirname(ordinaryRepo), "vault");
  fs.mkdirSync(ordinaryVault, { recursive: true });
  db.insertProject({ id: "pOrdinary", name: "Ordinary", repoPath: ordinaryRepo, vaultPath: ordinaryVault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrOrdinary", projectId: "pOrdinary", name: "Real Manager", startupPrompt: "", position: 0, profileId: null });
  let threwC = null;
  let sessionC = null;
  try { sessionC = svc.startManager("agentMgrOrdinary"); } catch (e) { threwC = e; }
  check("(c) NEGATIVE CONTROL: startManager against an ORDINARY project is NOT refused", threwC === null && sessionC?.role === "manager");

  // ===== (d) startPlatformLead against the SAME reserved-home-shaped project is NOT refused =====
  db.insertAgent({ id: "agentLead", projectId: "pReserved", name: "Platform Lead", startupPrompt: "", position: 1, profileId: null });
  let threwD = null;
  let sessionD = null;
  try { sessionD = svc.startPlatformLead("agentLead"); } catch (e) { threwD = e; }
  check("(d) startPlatformLead against the reserved-home-shaped project (repoPath===LOOM_HOME) is NOT refused — it legitimately runs there",
    threwD === null && sessionD?.role === "platform" && sessionD?.cwd === loomHome);

  // ===== (e) startSetup against the SAME reserved-home-shaped project is NOT refused =====
  db.insertAgent({ id: "agentSetup", projectId: "pReserved", name: "Platform", startupPrompt: "", position: 2, profileId: null });
  let threwE = null;
  let sessionE = null;
  try { sessionE = svc.startSetup("agentSetup"); } catch (e) { threwE = e; }
  check("(e) startSetup against the reserved-home-shaped project (repoPath===LOOM_HOME) is NOT refused — it legitimately runs there",
    threwE === null && sessionE?.role === "setup" && sessionE?.cwd === loomHome);

  // ===== (f)/(g) round 2 — startNew's PROFILE-resolved manager role is covered by the SAME chokepoint,
  // not just startManager's explicit one (see docs/decisions/37e15c26 round 2). =====
  db.insertProfile({ id: "profMgrRig", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });

  // (f) startNew, profile-resolved role==="manager", against the RESERVED-HOME-shaped project — refused.
  db.insertAgent({ id: "agentNewMgrReserved", projectId: "pReserved", name: "Rogue +New Manager", startupPrompt: "", position: 3, profileId: "profMgrRig" });
  let threwF = null;
  try { svc.startNew("agentNewMgrReserved"); } catch (e) { threwF = e; }
  check("(f) startNew whose PROFILE resolves role==\"manager\" against the reserved-home-shaped project is refused",
    threwF instanceof Error && /manager session can never start in this project/i.test(threwF.message));
  check("(f) …NO session row was inserted for this agent", db.listSessions("agentNewMgrReserved").length === 0);

  // (g) NEGATIVE CONTROL: the SAME manager-rig profile via startNew against the ORDINARY project spawns fine.
  db.insertAgent({ id: "agentNewMgrOrdinary", projectId: "pOrdinary", name: "Real +New Manager", startupPrompt: "", position: 1, profileId: "profMgrRig" });
  let threwG = null;
  let sessionG = null;
  try { sessionG = svc.startNew("agentNewMgrOrdinary"); } catch (e) { threwG = e; }
  check("(g) NEGATIVE CONTROL: startNew whose PROFILE resolves role===\"manager\" against an ORDINARY project is NOT refused",
    threwG === null && sessionG?.role === "manager");

  // ===== (h)-(m) card d25e4ea7 — a TRULY RESERVED project whose repoPath is an ORDINARY repo (NOT
  // LOOM_HOME-or-an-ancestor) must still refuse a manager session (the predicate-unification mirror of
  // (a)/(b)'s path-only proof), while every OTHER role stays unaffected against the SAME project. =====
  const reservedDriftedRepo = path.join(fs.realpathSync(mkdtempManaged("loom-startmanager-reserved-drifted-")), "repo");
  initRepo(reservedDriftedRepo);
  db.insertProject({ id: "pReservedDrifted", name: "Reserved Drifted", repoPath: reservedDriftedRepo, vaultPath: reservedDriftedRepo, config: {}, createdAt: now, archivedAt: null, reserved: true });

  // (h) startManager against the TRULY reserved project is refused even though its repoPath is an
  // ordinary repo — proves `reserved` alone now suffices, independent of the path check.
  db.insertAgent({ id: "agentMgrReservedDrifted", projectId: "pReservedDrifted", name: "Rogue Manager 3", startupPrompt: "", position: 0, profileId: null });
  let threwH = null;
  try { svc.startManager("agentMgrReservedDrifted"); } catch (e) { threwH = e; }
  // Card d25e4ea7 code-review follow-up (6fff4ba4): the repoPath here is an ORDINARY repo, not
  // LOOM_HOME-or-an-ancestor — so the refusal text must NOT claim "the repo path resolves to Loom's own
  // operational home directory" (that was literally false for this exact case before the fix). Assert
  // the dedicated MANAGER_SESSION_BARRED_ERROR wording instead, and that the old, now-inapplicable claim
  // is absent.
  check("(h) startManager against a RESERVED project whose repoPath is an ORDINARY repo is STILL refused, with accurate text",
    threwH instanceof Error
    && /manager session can never start in this project/i.test(threwH.message)
    && /reserved\/system project/i.test(threwH.message)
    && !/operational home directory/i.test(threwH.message));
  check("(h) …NO session row was inserted for this agent", db.listSessions("agentMgrReservedDrifted").length === 0);

  // (i) startPlatformLead against the SAME truly-reserved-but-drifted project is NOT refused.
  db.insertAgent({ id: "agentLeadDrifted", projectId: "pReservedDrifted", name: "Platform Lead 2", startupPrompt: "", position: 1, profileId: null });
  let threwI = null, sessionI = null;
  try { sessionI = svc.startPlatformLead("agentLeadDrifted"); } catch (e) { threwI = e; }
  check("(i) startPlatformLead against the reserved-but-drifted project is NOT refused",
    threwI === null && sessionI?.role === "platform");

  // (j) startSetup against the SAME project is NOT refused.
  db.insertAgent({ id: "agentSetupDrifted", projectId: "pReservedDrifted", name: "Platform 2", startupPrompt: "", position: 2, profileId: null });
  let threwJ = null, sessionJ = null;
  try { sessionJ = svc.startSetup("agentSetupDrifted"); } catch (e) { threwJ = e; }
  check("(j) startSetup against the reserved-but-drifted project is NOT refused",
    threwJ === null && sessionJ?.role === "setup");

  // (k) startAuditor against the SAME project is NOT refused.
  db.insertAgent({ id: "agentAuditorDrifted", projectId: "pReservedDrifted", name: "Auditor Drifted", startupPrompt: "", position: 3, profileId: null });
  let threwK = null, sessionK = null;
  try { sessionK = svc.startAuditor("agentAuditorDrifted"); } catch (e) { threwK = e; }
  check("(k) startAuditor against the reserved-but-drifted project is NOT refused",
    threwK === null && sessionK?.role === "auditor");

  // (l) startWorkspaceAuditor against the SAME project is NOT refused.
  db.insertAgent({ id: "agentWsAuditorDrifted", projectId: "pReservedDrifted", name: "Workspace Auditor Drifted", startupPrompt: "", position: 4, profileId: null });
  let threwL = null, sessionL = null;
  try { sessionL = svc.startWorkspaceAuditor("agentWsAuditorDrifted"); } catch (e) { threwL = e; }
  check("(l) startWorkspaceAuditor against the reserved-but-drifted project is NOT refused",
    threwL === null && sessionL?.role === "workspace-auditor");

  // (m) startNew whose PROFILE resolves role==="assistant" against the SAME project is NOT refused —
  // refuseManagerIntoReservedHome fires only on resolved role==="manager".
  db.insertProfile({ id: "profAssistantRig", name: "Assistant Rig", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: true });
  db.insertAgent({ id: "agentAssistantDrifted", projectId: "pReservedDrifted", name: "Assistant Drifted", startupPrompt: "", position: 5, profileId: "profAssistantRig" });
  let threwM = null, sessionM = null;
  try { sessionM = svc.startNew("agentAssistantDrifted"); } catch (e) { threwM = e; }
  check("(m) startNew whose PROFILE resolves role===\"assistant\" against the reserved-but-drifted project is NOT refused",
    threwM === null && sessionM?.role === "assistant");
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startManager AND startNew's profile-resolved manager role both refuse a fresh manager spawn whose project repoPath is LOOM_HOME or an ancestor of it OR whose project is reserved (even with a drifted, ordinary repoPath), an ordinary project is unaffected either way, and startPlatformLead/startSetup/startAuditor/startWorkspaceAuditor/an assistant-role startNew all still legitimately spawn against the SAME reserved(-shaped/-but-drifted) project."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
