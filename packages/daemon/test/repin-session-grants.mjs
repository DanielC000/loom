import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6745e4bc — repinSessionGrants row-writes a manager/worker/platform session's frozen
// capability surface immediately; no forced respawn, no pty touch at all, and recycle's own 298b826e
// freeze stays completely untouched by it.
//
// This test is the service-level functional contract: (1) Tier-1 fields (connections/vaultWrite/
// noCommit) and Tier-2 fields (skills/capabilities/browserTesting/documentConversion/restrictedTools)
// all land on the ROW immediately; (2) the returned/persisted `diff` names only CHANGED fields, and a
// no-op call still returns diff:{} and still files its event; (3) revocation actually EMPTIES a column,
// not just adds; (4) role==="assistant" refuses (points at the companion route), any role outside
// manager/worker/platform refuses too; (5) the codex+restrictedTools refusal (card b94fcb72) refuses
// BEFORE any write; (6) recycleManager/recycleWorker still freeze the row forward afterward; (7) a
// role-divergent re-pin (session role vs. the bound profile's OWN role) actually drops the profile's
// pinned skills subset and files locked_role_skills_dropped (card 509176c8); (8) a real worker row with
// a parent manager attributes grants_repinned's managerSessionId to the PARENT, not the worker's own id;
// (9) a STALE id (archived, or superseded by a recycle successor) refuses, naming the successor when one
// exists.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, same hermetic shape as connections-recycle-freeze-
// contract.mjs: a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam).
//
// Run: 1) build (turbo builds shared first), 2) node test/repin-session-grants.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repin-grants-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-repin-grants-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# repin-session-grants\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rsg@loom -c user.name=rsg");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// Every grant starts EMPTY/OFF — the owner widens the profile AFTER the session already spawned.
db.insertProfile({
  id: "profMgr", name: "MgrRig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null,
  connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
});
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "MgrProfiled", startupPrompt: "MGR_PROMPT", position: 0, profileId: "profMgr" });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; } // mirrors connections-recycle-freeze-contract.mjs — no live OS pty
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const grantsEventsFor = (id) => db.listEventsForSession(id).filter((e) => e.kind === "grants_repinned");
const skillsDroppedEventsFor = (id) => db.listEventsForSession(id).filter((e) => e.kind === "locked_role_skills_dropped");

try {
  // ===================== 1. fresh manager + a full widening re-pin =====================
  const mgr = svc.startManager("agentMgr", "GO");
  check("(1) fresh spawn while every profile grant is empty/off -> session starts with none",
    (db.getSession(mgr.id).connections ?? []).length === 0 && (db.getSession(mgr.id).capabilities ?? []).length === 0);

  const captureBefore = host.capture.length;

  db.updateProfile("profMgr", {
    connections: ["conn-1"], capabilities: [{ slug: "cap-1" }], skills: ["skillA"],
    browserTesting: true, documentConversion: true, restrictedTools: true, noCommit: true, vaultWrite: true,
  });

  const r1 = svc.repinSessionGrants(mgr.id);

  check("(2) NO pty is ever touched by repinSessionGrants (unlike upgradeCompanionCapabilities)", host.capture.length === captureBefore);

  const s1 = db.getSession(mgr.id);
  check("(3) Tier-1 field `connections` lands on the row immediately, no respawn", JSON.stringify(s1.connections) === JSON.stringify(["conn-1"]));
  check("(3) Tier-1 field `vaultWrite` lands on the row immediately, no respawn", s1.vaultWrite === true);
  check("(3) Tier-1 field `noCommit` lands on the row immediately, no respawn", s1.noCommit === true);
  check("(3) Tier-2 field `capabilities` lands on the row (readable BEFORE any respawn, per this card's design)", JSON.stringify(s1.capabilities) === JSON.stringify([{ slug: "cap-1" }]));
  check("(3) Tier-2 field `skills` lands on the row", JSON.stringify(s1.skills) === JSON.stringify(["skillA"]));
  check("(3) Tier-2 field `browserTesting` lands on the row", s1.browserTesting === true);
  check("(3) Tier-2 field `documentConversion` lands on the row", s1.documentConversion === true);
  check("(3) Tier-2 field `restrictedTools` lands on the row", s1.restrictedTools === true);
  check("(4) harness is UNTOUCHED by repinSessionGrants", s1.harness === undefined || s1.harness === null);
  check("(5) the method's own return value matches the persisted row", JSON.stringify(r1.session) === JSON.stringify(s1));

  const expectedChangedKeys = ["connections", "capabilities", "restrictedTools", "noCommit", "skills", "vaultWrite", "browserTesting", "documentConversion"].sort();
  check("(6) diff names exactly the 8 changed fields, nothing more/less", JSON.stringify(Object.keys(r1.diff).sort()) === JSON.stringify(expectedChangedKeys));
  check("(6) diff's `connections` entry carries old:[] new:['conn-1']", JSON.stringify(r1.diff.connections) === JSON.stringify({ old: [], new: ["conn-1"] }));
  check("(6) diff's `vaultWrite` entry carries old:false new:true", JSON.stringify(r1.diff.vaultWrite) === JSON.stringify({ old: false, new: true }));

  const evs1 = grantsEventsFor(mgr.id);
  check("(7) a grants_repinned event was filed, exactly once", evs1.length === 1);
  check("(7) the event's own detail.diff matches the returned diff", JSON.stringify(evs1[0].detail?.diff) === JSON.stringify(r1.diff));
  check("(7) the event is filed under managerSessionId/workerSessionId == this session (no parent)", evs1[0].managerSessionId === mgr.id && evs1[0].workerSessionId === mgr.id);

  // ===================== 2. a NO-OP re-pin (nothing changed on the profile) still records diff:{} =====================
  const r2 = svc.repinSessionGrants(mgr.id);
  check("(8) a no-op re-pin (profile unchanged since last call) returns diff:{}", JSON.stringify(r2.diff) === "{}");
  const evs2 = grantsEventsFor(mgr.id);
  check("(8) a no-op re-pin STILL files its own grants_repinned event (profile_grant_reach precedent — absent row means never re-pinned, not re-pinned-but-lost)", evs2.length === 2);
  // Index guarded: a regression that drops the second event must print FAIL here, not crash the whole
  // run with a TypeError on `evs2[1]` being undefined.
  check("(8) the no-op event's own detail.diff is also {}", evs2.length > 1 && JSON.stringify(evs2[1]?.detail?.diff) === "{}");

  // ===================== 3. REVOCATION — profile narrows again; the row must actually EMPTY, not just stay wide =====================
  db.updateProfile("profMgr", {
    connections: [], capabilities: [], skills: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
  });
  const r3 = svc.repinSessionGrants(mgr.id);
  const s3 = db.getSession(mgr.id);
  check("(9) revocation actually EMPTIES `connections` (not left wide from the earlier grant)", JSON.stringify(s3.connections) === "[]");
  check("(9) revocation actually EMPTIES `capabilities`", JSON.stringify(s3.capabilities) === "[]");
  check("(9) revocation actually NULLS `skills` back to deliver-all", s3.skills === null);
  check("(9) revocation actually clears `vaultWrite`/`browserTesting`/`restrictedTools`/`noCommit` back to false",
    s3.vaultWrite === false && s3.browserTesting === false && s3.restrictedTools === false && s3.noCommit === false);
  check("(9) the revocation diff names the same 8 fields again (all reverted)", JSON.stringify(Object.keys(r3.diff).sort()) === JSON.stringify(expectedChangedKeys));
  check("(9) the revocation diff's `connections` entry carries old:['conn-1'] new:[]", JSON.stringify(r3.diff.connections) === JSON.stringify({ old: ["conn-1"], new: [] }));

  // ===================== 4. ROLE REFUSALS — assistant points elsewhere; anything else is out of scope =====================
  db.insertSession({
    id: "s-assistant", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "assistant", parentSessionId: null,
  });
  let assistantErr = null;
  try { svc.repinSessionGrants("s-assistant"); } catch (e) { assistantErr = e; }
  check("(10) role==='assistant' refuses and points at the companion upgrade route", !!assistantErr && /upgrade/i.test(assistantErr.message));

  db.insertSession({
    id: "s-setup", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "setup", parentSessionId: null,
  });
  let setupErr = null;
  try { svc.repinSessionGrants("s-setup"); } catch (e) { setupErr = e; }
  check("(11) any role outside manager/worker/platform refuses (this card's approved scope)", !!setupErr && /manager, worker, or platform/i.test(setupErr.message));

  // ===================== 5. the "platform" role is explicitly IN scope (cheap check — no full Lead scaffolding needed) =====================
  db.insertSession({
    id: "s-platform", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "platform", parentSessionId: null,
  });
  // profMgr itself is bound role:"manager" — pinning a "skillA-mgr" subset onto it while re-pinning a
  // role:"platform" SESSION deliberately exercises the role-divergence/skills-dropped path
  // (sessionSkillsForRole, card 509176c8): "platform" is a LOCKED_PROFILE_ROLES member whose resolved
  // role ("platform") differs from the bound profile's own role ("manager"), so the subset must drop.
  db.updateProfile("profMgr", { connections: ["conn-plat-1"], skills: ["skillA-mgr"] });
  const r5 = svc.repinSessionGrants("s-platform");
  check("(12) role==='platform' IS re-pinnable, and resolves the SAME explicit role (not clamped to the profile's own role)", JSON.stringify(db.getSession("s-platform").connections) === JSON.stringify(["conn-plat-1"]));
  check("(12) role==='platform' diff carries just the one actually-changed field", JSON.stringify(Object.keys(r5.diff)) === JSON.stringify(["connections"]));
  check("(12) the role-divergent re-pin actually DROPS the profile's pinned skills subset (never applies it)", db.getSession("s-platform").skills === null);
  const platformSkillsDropped = skillsDroppedEventsFor("s-platform");
  check("(12) the skills-dropped path files exactly one locked_role_skills_dropped event for this call", platformSkillsDropped.length === 1);
  check("(12) the skills-dropped event names sessionRole:'platform' / profileRole:'manager' — the actual divergence, not a placeholder",
    platformSkillsDropped[0]?.detail?.sessionRole === "platform" && platformSkillsDropped[0]?.detail?.profileRole === "manager");

  // ===================== 6. codex + restrictedTools refusal (card b94fcb72) — refuses BEFORE any write =====================
  db.insertProfile({
    id: "profCodex", name: "CodexRig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null,
    connections: [], capabilities: [], browserTesting: false, documentConversion: false, restrictedTools: true, noCommit: false, vaultWrite: false,
  });
  db.insertAgent({ id: "agentCodex", projectId: "pP", name: "CodexProfiled", startupPrompt: "", position: 1, profileId: "profCodex" });
  db.insertSession({
    id: "s-codex", projectId: "pP", agentId: "agentCodex", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: null, harness: "codex",
    connections: [], capabilities: [], skills: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, vaultWrite: false,
  });
  const beforeCodexRow = JSON.stringify(db.getSession("s-codex"));
  let codexErr = null;
  try { svc.repinSessionGrants("s-codex"); } catch (e) { codexErr = e; }
  check("(13) a codex-harness session resolving restrictedTools:true refuses", !!codexErr);
  check("(13) the row is UNCHANGED after the refusal (refuses BEFORE any write)", JSON.stringify(db.getSession("s-codex")) === beforeCodexRow);
  check("(13) NO grants_repinned event was filed for the refused call", grantsEventsFor("s-codex").length === 0);

  // ===================== 6b. a REAL role==='worker' row with a PARENT manager — event attribution =====================
  db.insertSession({
    id: "s-mgr-parent", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  db.insertSession({
    id: "s-worker-child", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: "s-mgr-parent",
  });
  db.updateProfile("profMgr", { connections: ["conn-worker-1"] });
  svc.repinSessionGrants("s-worker-child");
  check("(14) role==='worker' with a parent manager IS re-pinnable", JSON.stringify(db.getSession("s-worker-child").connections) === JSON.stringify(["conn-worker-1"]));
  const workerEvents = grantsEventsFor("s-worker-child");
  check("(14) exactly one grants_repinned event filed for the worker's own id", workerEvents.length === 1);
  check("(14) the event attributes managerSessionId to the WORKER'S PARENT manager, not the worker's own id",
    workerEvents[0]?.managerSessionId === "s-mgr-parent" && workerEvents[0]?.workerSessionId === "s-worker-child");

  // ===================== 6c. STALE ID REFUSALS — archived, or superseded by a recycle successor =====================
  db.insertSession({
    id: "s-archived", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  db.archiveSession("s-archived"); // insertSession has no archived_at column — the real setter stamps it
  let archivedErr = null;
  try { svc.repinSessionGrants("s-archived"); } catch (e) { archivedErr = e; }
  check("(15) an archived session refuses", !!archivedErr && /archiv/i.test(archivedErr.message));

  db.insertSession({
    id: "s-stale-pred", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  db.insertSession({
    id: "s-stale-succ", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null, recycledFrom: "s-stale-pred",
  });
  let staleErr = null;
  try { svc.repinSessionGrants("s-stale-pred"); } catch (e) { staleErr = e; }
  check("(16) a session superseded by a recycle successor refuses, naming the successor id", !!staleErr && staleErr.message.includes("s-stale-succ"));
  check("(16) NO grants_repinned event was filed for either stale-id refusal",
    grantsEventsFor("s-archived").length === 0 && grantsEventsFor("s-stale-pred").length === 0);

  // ===================== 7. recycle still freezes afterward — this card's write never leaks INTO recycle's own contract =====================
  // mgr.id's OWN row still reads connections:[] from step 3's revocation (steps 4-6 touched OTHER
  // sessions/profiles, never mgr's own row). Bind the live profile to something ELSE entirely right
  // before recycling — recycleManager must carry mgr's own [] forward, never this fresh profile value.
  db.setBusy(mgr.id, false);
  db.updateProfile("profMgr", { connections: ["conn-after-repin"] });
  const mgrRecycled = await svc.recycleManager(mgr.id, "CONTINUE");
  check("(14) 298b826e's freeze is UNCHANGED by this card: recycleManager still carries mgr's OWN pre-recycle row value ([]) forward, never the live profile",
    JSON.stringify(db.getSession(mgrRecycled.id).connections) === "[]");
} finally {
  db.close();
  cleanupPathSync(tmpHome);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — repinSessionGrants row-writes a manager/worker/platform session's frozen capability surface immediately (Tier-1 and Tier-2 fields alike), touches no pty, diffs old-vs-new accurately (including a true no-op and a true revocation), refuses role==='assistant'/any out-of-scope role/the codex+restrictedTools combination (the latter BEFORE any write), files a grants_repinned event on every successful call, and leaves recycle's own 298b826e freeze completely untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
