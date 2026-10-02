import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d4b4433 (multi-harness epic df1f94b0) — manager + platform-lead RECYCLE re-resolves the harness
// through resolveAgentSpawn; a WORKER recycle and resume stay pinned to the row. Deterministic +
// claude/codex-free: real Db + SessionService against a fake pty for BOTH createPty and createCodexPty,
// with LOOM_CODEX_BIN at a dead path as a loud backstop.
//
// Card 7955458e, Code Review CRITICAL fix (this revision): `resolveAgentSpawn`'s own role-based backstop
// now FORCES any resolved codex harness back to claude whenever the RESOLVED session role is a
// TRANSCRIPT_ROOT_DENY_ROLES member — manager and platform ALWAYS are, unconditionally, regardless of
// restrictedTools/browserTesting/documentConversion/capabilities/permissionDeny. This makes a manager or
// platform-lead recycle's "→ codex" direction from (M)/(P) below now land back on claude every time,
// firing `harness_role_forced_claude` instead of ever reaching createCodexPty — the OLD codex-landing
// assertions (and the (S)/(PD) sections' OLD `harness_default_skipped`-via-codexIncompatibilities skip,
// which can now never fire for these two roles at all, since the role-force preempts it first) are
// rewritten below to assert the NEW, forced-to-claude outcome instead of the old codex-landing one.
//
//   (M) manager recycle: codex→claude still works (unaffected); claude row + codex PROFILE is now
//       UNCONDITIONALLY forced back to claude (not landed); agent-missing ALSO now forces claude (ruling
//       1(c), SECOND review round — recycleHarness's own `!spawn` branch forces it directly, since
//       resolveAgentSpawn never runs on that path to force it there instead); the default-layer seam
//       (defaultHarnessForSpawn) is ALSO covered by the same force, regardless of which layer produced codex.
//   (P) platform-lead recycle mirrors (M).
//   (W) worker recycle stays PINNED to the row in both directions, even against a contradicting profile.
//   (R) resume stays row-pinned against a contradicting profile (claude row / codex profile direction only).
//
// NOT COVERED: fork + boot-reconcile pinning (code untouched by this card; no test added here), and
// scope:"fleet" end-to-end (fail-closed until card 4c4eb9af — the default layer is exercised by stubbing
// the resolution seam instead).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-harness-reresolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rhr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-rhr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-harness-reresolve test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rhr@loom -c user.name=rhr");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pR", name: "R", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 }, permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
const prof = (id, role, harness) => db.insertProfile({ id, name: id, role, description: "", allowDelta: [], skills: null, model: null, icon: null, ...(harness ? { harness } : {}) });
prof("profMgrCodex", "manager", "codex"); prof("profMgrPlain", "manager");
prof("profLeadCodex", "platform", "codex"); prof("profLeadPlain", "platform");
prof("profWorkerCodex", "worker", "codex"); prof("profWorkerClaude", "worker", "claude");
const agent = (id, profileId) => db.insertAgent({ id, projectId: "pR", name: id, startupPrompt: id, position: 0, profileId });
agent("aMgrCodex", "profMgrCodex"); agent("aMgrPlain", "profMgrPlain");
agent("aLeadCodex", "profLeadCodex"); agent("aLeadPlain", "profLeadPlain");
agent("aWorkerCodex", "profWorkerCodex"); agent("aWorkerClaude", "profWorkerClaude");

// BOTH spawn chokepoints faked — a codex spawn goes through createCodexPty, which would launch the real binary.
const fakePty = () => {
  let exitCb = null;
  return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit(cb) { exitCb = cb; return { dispose() {} }; }, kill() { const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 }); }, resize() {} };
};
class SeamHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push({ ...opts, viaCodex: false }); return fakePty(); }
  createCodexPty(opts) { this.capture.push({ ...opts, viaCodex: true }); return fakePty(); }
  stop() {}
  isAlive() { return false; } // no real OS pty behind this seam
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.filter((o) => o.sessionId === sid).pop();

// agent row gone, session intact: FK-disabled raw delete (technique from resume-permission-pin-agent-missing.mjs).
// FKs stay OFF through the recycle too — the successor row also references the missing agent, so with FKs on
// insertRecycleSuccessor itself throws (a state production only reaches via a raw delete anyway).
const goneAgent = (id) => {
  db.insertAgent({ id, projectId: "pR", name: id, startupPrompt: id, position: 0, profileId: null });
  db.db.pragma("foreign_keys = OFF");
  db.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  return () => db.db.pragma("foreign_keys = ON");
};
let n = 0;
const seed = (role, agentId, harness, extra = {}, projectId = "pR") => {
  const id = `${role}-${++n}`;
  db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role, gen: 0, ...(harness ? { harness } : {}), ...extra,
  });
  return id;
};
const harnessOf = (id) => db.getSession(id).harness ?? undefined;
const forcedEvent = (predId) => db.listEvents(predId).find((e) => e.kind === "harness_role_forced_claude");

// ---------------- (M) manager ----------------
{
  // Card 7955458e: role:manager is a TRANSCRIPT_ROOT_DENY_ROLES member, so a resolved codex is now
  // UNCONDITIONALLY forced back to claude — this profile would have landed codex before that fix.
  const pM1 = seed("manager", "aMgrCodex", undefined);
  const m1 = await svc.recycleManager(pM1, "handoff");
  check("(M1) claude row + explicit codex profile + role:manager ⇒ FORCED back to claude (card 7955458e backstop)", harnessOf(m1.id) === undefined);
  check("(M1) opts.harness undefined, routed via createPty — never reaches createCodexPty", optsFor(m1.id)?.harness === undefined && optsFor(m1.id)?.viaCodex === false);
  check("(M1) harness_role_forced_claude filed naming role:manager + the source agentId, trigger:recycle",
    forcedEvent(pM1)?.workerSessionId === m1.id && forcedEvent(pM1).detail.role === "manager" && forcedEvent(pM1).detail.agentId === "aMgrCodex" && forcedEvent(pM1).detail.trigger === "recycle" && forcedEvent(pM1).detail.reason.includes("FORCED"));

  const m2 = await svc.recycleManager(seed("manager", "aMgrPlain", "codex"), "handoff");
  check("(M2) codex→claude: successor row harness is unset (claude), NOT carried from old", harnessOf(m2.id) === undefined);
  check("(M2) codex→claude: opts.harness undefined, routed via createPty", optsFor(m2.id)?.harness === undefined && optsFor(m2.id)?.viaCodex === false);

  const fkOnM = goneAgent("ghostM"); const ghostM = seed("manager", "ghostM", "codex");
  check("(M3) setup: the agent row is really gone", db.getAgent("ghostM") === undefined && !!db.getSession(ghostM));
  let m3; try { m3 = await svc.recycleManager(ghostM, "handoff"); } finally { fkOnM(); }
  // Card 7955458e, SECOND Code Review ruling 1(c): agent-missing ⇒ no resolveAgentSpawn to force
  // through, so recycleHarness's own `!spawn` branch forces claude itself — a codex row for a
  // TRANSCRIPT_ROOT_DENY_ROLES role must NEVER land on codex regardless of why the agent is gone.
  check("(M3) agent missing ⇒ recycleHarness's own !spawn branch still forces claude (ruling 1(c))", harnessOf(m3.id) === undefined && optsFor(m3.id)?.harness === undefined && optsFor(m3.id)?.viaCodex === false);
  check("(M3) harness_role_forced_claude filed naming role:manager + the gone agentId, trigger:recycle",
    forcedEvent(ghostM)?.workerSessionId === m3.id && forcedEvent(ghostM).detail.role === "manager" && forcedEvent(ghostM).detail.agentId === "ghostM" && forcedEvent(ghostM).detail.trigger === "recycle");

  // default-layer seam: aMgrPlain has no profile harness; stub the default so a manager would resolve codex.
  // Card 7955458e: the role-force reads rawHarness = resolved.harness || harnessFromDefault.harness, so it
  // catches a DEFAULT-derived codex too, not just an explicit profile one.
  const orig = svc.defaultHarnessForSpawn;
  svc.defaultHarnessForSpawn = (a, role, r) => (role === "manager" ? { harness: "codex", skipped: undefined } : orig.call(svc, a, role, r));
  const pM4 = seed("manager", "aMgrPlain", undefined);
  const m4 = await svc.recycleManager(pM4, "handoff");
  check("(M4) default-layer seam resolves codex for manager, but the role-based backstop STILL forces claude", harnessOf(m4.id) === undefined && optsFor(m4.id)?.harness === undefined && optsFor(m4.id)?.viaCodex === false);
  check("(M4) harness_role_forced_claude filed — the backstop fires regardless of WHICH layer produced codex", forcedEvent(pM4)?.workerSessionId === m4.id && forcedEvent(pM4).detail.role === "manager");
  svc.defaultHarnessForSpawn = orig;
  const pM5 = seed("manager", "aMgrPlain", undefined);
  const m5 = await svc.recycleManager(pM5, "handoff");
  check("(M4) CONTROL: with the stub removed the same agent recycles to claude normally, no forced event (M4 wasn't vacuous)", harnessOf(m5.id) === undefined && forcedEvent(pM5) === undefined);
}

// ---------------- (S) codex flip must NOT strip carried safety/capability fields (M1 of the code review) ----------------
// Card 7955458e: role:manager/role:platform are ALWAYS TRANSCRIPT_ROOT_DENY_ROLES members, so the
// role-based backstop now forces claude BEFORE recycleHarness's own codexIncompatibilities check (the
// restrictedTools/browserTesting/documentConversion/capabilities skip these sections originally tested)
// ever gets a chance to run — that field-specific skip is now STRUCTURALLY UNREACHABLE via a manager/
// platform recycle (the only two roles that ever call recycleHarness). These sections now prove the
// OPPOSITE of what they used to: `harness_role_forced_claude` fires, `harness_default_skipped` does NOT —
// the two mechanisms never double-fire — while the carried field itself is still preserved on the row.
const skipEvent = (predId) => db.listEvents(predId).find((e) => e.kind === "harness_default_skipped");
for (const [label, extra] of [
  ["restrictedTools", { restrictedTools: true }],
  ["browserTesting", { browserTesting: true }],
  ["documentConversion", { documentConversion: true }],
  ["capabilities", { capabilities: [{ slug: "some-capability" }] }],
]) {
  const pm = seed("manager", "aMgrCodex", undefined, extra);
  const sm = await svc.recycleManager(pm, "handoff");
  check(`(S-mgr ${label}) claude row + codex profile + ${label} ⇒ successor stays claude (role-based backstop, row + opts via createPty)`, harnessOf(sm.id) === undefined && optsFor(sm.id)?.harness === undefined && optsFor(sm.id)?.viaCodex === false);
  check(`(S-mgr ${label}) harness_role_forced_claude filed (role:manager alone is sufficient); harness_default_skipped is NOT filed (the field-specific skip never runs)`, forcedEvent(pm)?.workerSessionId === sm.id && forcedEvent(pm).detail.trigger === "recycle" && skipEvent(pm) === undefined);
  check(`(S-mgr ${label}) the carried field itself is unchanged on the successor`, JSON.stringify(db.getSession(sm.id)[label]) === JSON.stringify(extra[label]));
}
{
  const pl = seed("platform", "aLeadCodex", undefined, { restrictedTools: true });
  const sl = await svc.recyclePlatformLead(pl, "handoff");
  check("(S-lead restrictedTools) claude row + codex profile + restrictedTools ⇒ successor stays claude (role-based backstop)", harnessOf(sl.id) === undefined && optsFor(sl.id)?.viaCodex === false);
  check("(S-lead restrictedTools) harness_role_forced_claude filed; harness_default_skipped is NOT", forcedEvent(pl)?.workerSessionId === sl.id && skipEvent(pl) === undefined);
  const pl2 = seed("platform", "aLeadCodex", undefined, { capabilities: [{ slug: "some-capability" }] });
  const sl2 = await svc.recyclePlatformLead(pl2, "handoff");
  check("(S-lead capabilities) same for a capability field", harnessOf(sl2.id) === undefined && forcedEvent(pl2)?.workerSessionId === sl2.id && skipEvent(pl2) === undefined);
  const pc = seed("manager", "aMgrCodex", undefined);
  const scSuccessor = await svc.recycleManager(pc, "handoff");
  check("(S) card 7955458e: even with NO other incompatible field, role:manager ALONE still forces claude (manager can never run codex, period)", harnessOf(scSuccessor.id) === undefined && skipEvent(pc) === undefined && forcedEvent(pc)?.workerSessionId === scSuccessor.id);
}

// ---------------- (PD) permissionDeny — card 7955458e: a non-empty AUTHORED project permission.deny is the
// ONE field `recycleHarness` cannot read off the OLD ROW (unlike restrictedTools/browserTesting/
// documentConversion/capabilities in (S) above) — it has no Session column, so every caller re-derives it
// LIVE from the project's CURRENT resolveConfig(...).permission.deny instead. Same (S)-section caveat
// applies: role:manager's backstop fires BEFORE this field-specific skip ever runs, so this now proves the
// backstop preempts permissionDeny too, not that permissionDeny independently skips a manager recycle (the
// genuinely-reachable permissionDeny-skip case is `worker`, tested in codex-fleet-switch-guard.mjs — worker
// is NOT a TRANSCRIPT_ROOT_DENY_ROLES member, so the backstop never preempts it there).
{
  db.insertProject({ id: "pRD", name: "RD", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 }, permission: { deny: ["Read(//some/secret/**)"] } }, createdAt: now, archivedAt: null });
  db.insertProfile({ id: "profMgrCodexPD", name: "profMgrCodexPD", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
  db.insertAgent({ id: "aMgrCodexPD", projectId: "pRD", name: "aMgrCodexPD", startupPrompt: "aMgrCodexPD", position: 0, profileId: "profMgrCodexPD" });

  const pPD = seed("manager", "aMgrCodexPD", undefined, {}, "pRD");
  const sPD = await svc.recycleManager(pPD, "handoff");
  check("(PD) project's authored permission.deny + role:manager ⇒ successor stays claude (role-based backstop)", harnessOf(sPD.id) === undefined && optsFor(sPD.id)?.harness === undefined && optsFor(sPD.id)?.viaCodex === false);
  check("(PD) harness_role_forced_claude filed; harness_default_skipped is NOT (the permissionDeny-specific skip never runs for this role)", forcedEvent(pPD)?.workerSessionId === sPD.id && skipEvent(pPD) === undefined);
}

// ---------------- (P) platform lead ----------------
{
  // Card 7955458e: role:platform is ALSO a TRANSCRIPT_ROOT_DENY_ROLES member — mirrors (M1) above.
  const pP1 = seed("platform", "aLeadCodex", undefined);
  const p1 = await svc.recyclePlatformLead(pP1, "handoff");
  check("(P1) claude row + explicit codex profile + role:platform ⇒ FORCED back to claude (card 7955458e backstop)", harnessOf(p1.id) === undefined && optsFor(p1.id)?.harness === undefined && optsFor(p1.id)?.viaCodex === false);
  check("(P1) harness_role_forced_claude filed naming role:platform, trigger:recycle", forcedEvent(pP1)?.workerSessionId === p1.id && forcedEvent(pP1).detail.role === "platform" && forcedEvent(pP1).detail.trigger === "recycle");
  const p2 = await svc.recyclePlatformLead(seed("platform", "aLeadPlain", "codex"), "handoff");
  check("(P2) codex→claude: successor row + opts unset via createPty", harnessOf(p2.id) === undefined && optsFor(p2.id)?.harness === undefined && optsFor(p2.id)?.viaCodex === false);
  const fkOnP = goneAgent("ghostP"); const ghostP = seed("platform", "ghostP", "codex");
  let p3; try { p3 = await svc.recyclePlatformLead(ghostP, "handoff"); } finally { fkOnP(); }
  check("(P3) agent missing ⇒ recycleHarness's own !spawn branch still forces claude (ruling 1(c))", harnessOf(p3.id) === undefined && optsFor(p3.id)?.harness === undefined && optsFor(p3.id)?.viaCodex === false);
  check("(P3) harness_role_forced_claude filed naming role:platform + the gone agentId, trigger:recycle",
    forcedEvent(ghostP)?.workerSessionId === p3.id && forcedEvent(ghostP).detail.role === "platform" && forcedEvent(ghostP).detail.agentId === "ghostP" && forcedEvent(ghostP).detail.trigger === "recycle");
}

// ---------------- (W) worker recycle stays pinned; (R) resume stays pinned ----------------
const worktrees = [];
try {
  const spawnW = async (agentId) => {
    const mgr = seed("manager", "aMgrPlain", undefined);
    const taskId = `task-${++n}`;
    db.insertTask({ id: taskId, projectId: "pR", title: `T${n}`, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
    const w = await svc.spawnWorker(mgr, { taskId, agentId, kickoffPrompt: "KICK" });
    worktrees.push(w.worktreePath);
    return { mgr, w };
  };
  // Pin via the profile at spawn (the real path): a codex-profile worker is pinned codex.
  const { mgr: mA, w: wA } = await spawnW("aWorkerCodex");
  check("(W0) setup: codex-profile worker pinned codex at spawn", harnessOf(wA.id) === "codex");
  // Flip the profile to claude, then recycle: the worker must STAY codex (row-pinned).
  db.updateProfile("profWorkerCodex", { harness: "claude" });
  const wA2 = await svc.recycleWorker(mA, wA.id, "handoff");
  check("(W1) codex worker recycled after profile→claude stays codex (row, opts, createCodexPty)", harnessOf(wA2.id) === "codex" && optsFor(wA2.id)?.harness === "codex" && optsFor(wA2.id)?.viaCodex === true);

  const { mgr: mB, w: wB } = await spawnW("aWorkerClaude");
  check("(W0) setup: claude-profile worker pinned claude", harnessOf(wB.id) === "claude");
  db.updateProfile("profWorkerClaude", { harness: "codex" });
  const wB2 = await svc.recycleWorker(mB, wB.id, "handoff");
  check("(W2) claude worker recycled after profile→codex stays claude (NOT re-resolved)", harnessOf(wB2.id) === "claude" && optsFor(wB2.id)?.harness === "claude" && optsFor(wB2.id)?.viaCodex === false);

  // (R) resume: a claude-pinned row under a profile that now resolves codex resumes as claude (codex-transcript resume
  // needs a real codex rollout layout, so only this direction is exercised here).
  const engR = "rhr-eng-0000-0000-000000000000";
  const rId = seed("manager", "aMgrCodex", undefined, { engineSessionId: engR, processState: "exited" });
  const tpath = engineTranscriptPath(repo, engR);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  await svc.resume(rId);
  const rOpts = optsFor(rId);
  check("(R) resume of a claude-pinned row under a codex-resolving profile stays claude", rOpts?.harness === undefined && rOpts?.viaCodex === false && !!rOpts);
} finally {
  try { const { removeWorktree } = await import("../dist/git/worktrees.js"); for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } } catch { /* best-effort */ }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — manager + platform recycle re-resolve the harness (both directions, agent-missing fallback, default-layer seam); worker recycle and resume stay row-pinned."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
