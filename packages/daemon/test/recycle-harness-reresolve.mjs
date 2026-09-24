import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d4b4433 (multi-harness epic df1f94b0) — manager + platform-lead RECYCLE re-resolves the harness
// through resolveAgentSpawn (an `undefined` re-resolve ⇒ claude, so codex→claude works); a WORKER recycle
// and resume stay pinned to the row. Deterministic + claude/codex-free: real Db + SessionService against a
// fake pty for BOTH createPty and createCodexPty, with LOOM_CODEX_BIN at a dead path as a loud backstop.
//
//   (M) manager recycle: claude→codex, codex→claude, agent-missing ⇒ carries old.harness, and the
//       default-layer seam (defaultHarnessForSpawn) feeds the recycled successor.
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
const seed = (role, agentId, harness, extra = {}) => {
  const id = `${role}-${++n}`;
  db.insertSession({
    id, projectId: "pR", agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role, gen: 0, ...(harness ? { harness } : {}), ...extra,
  });
  return id;
};
const harnessOf = (id) => db.getSession(id).harness ?? undefined;

// ---------------- (M) manager ----------------
{
  const m1 = await svc.recycleManager(seed("manager", "aMgrCodex", undefined), "handoff");
  check("(M1) claude→codex: successor row harness is codex", harnessOf(m1.id) === "codex");
  check("(M1) claude→codex: pty.spawn opts.harness is codex, routed via createCodexPty", optsFor(m1.id)?.harness === "codex" && optsFor(m1.id)?.viaCodex === true);

  const m2 = await svc.recycleManager(seed("manager", "aMgrPlain", "codex"), "handoff");
  check("(M2) codex→claude: successor row harness is unset (claude), NOT carried from old", harnessOf(m2.id) === undefined);
  check("(M2) codex→claude: opts.harness undefined, routed via createPty", optsFor(m2.id)?.harness === undefined && optsFor(m2.id)?.viaCodex === false);

  const fkOnM = goneAgent("ghostM"); const ghostM = seed("manager", "ghostM", "codex");
  check("(M3) setup: the agent row is really gone", db.getAgent("ghostM") === undefined && !!db.getSession(ghostM));
  let m3; try { m3 = await svc.recycleManager(ghostM, "handoff"); } finally { fkOnM(); }
  check("(M3) agent missing ⇒ falls back to old.harness (codex), row + opts", harnessOf(m3.id) === "codex" && optsFor(m3.id)?.harness === "codex");

  // default-layer seam: aMgrPlain has no profile harness; stub the default so a manager would resolve codex.
  const orig = svc.defaultHarnessForSpawn;
  svc.defaultHarnessForSpawn = (a, role, r) => (role === "manager" ? { harness: "codex", skipped: undefined } : orig.call(svc, a, role, r));
  const m4 = await svc.recycleManager(seed("manager", "aMgrPlain", undefined), "handoff");
  check("(M4) default-layer seam feeds the recycled manager (claude row → codex)", harnessOf(m4.id) === "codex" && optsFor(m4.id)?.harness === "codex");
  svc.defaultHarnessForSpawn = orig;
  const m5 = await svc.recycleManager(seed("manager", "aMgrPlain", undefined), "handoff");
  check("(M4) CONTROL: with the stub removed the same agent recycles to claude (M4 wasn't vacuous)", harnessOf(m5.id) === undefined);
}

// ---------------- (S) codex flip must NOT strip carried safety/capability fields (M1 of the code review) ----------------
// The profile flips to codex (validateProfile forces restrictedTools/stdio caps off in that same save) but the
// recycled ROW still carries them; createCodexPty ignores restrictedTools, so flipping would run UNrestricted.
// The successor keeps old.harness and the skip is filed as the SAME `harness_default_skipped` event a fresh
// spawn files (card 961da6c6), attributed to the successor, reasons from the shared codexIncompatibilities().
const skipEvent = (predId) => db.listEvents(predId).find((e) => e.kind === "harness_default_skipped");
const skipIds = (predId) => (skipEvent(predId)?.detail?.items ?? []).map((i) => i.id);
for (const [label, extra, needle] of [
  ["restrictedTools", { restrictedTools: true }, "restrictedTools"],
  ["browserTesting", { browserTesting: true }, "browserTesting"],
  ["documentConversion", { documentConversion: true }, "documentConversion"],
  ["capabilities", { capabilities: [{ slug: "some-capability" }] }, "capabilities"],
]) {
  const pm = seed("manager", "aMgrCodex", undefined, extra);
  const sm = await svc.recycleManager(pm, "handoff");
  check(`(S-mgr ${label}) claude row + codex profile + ${label} ⇒ successor stays claude (row + opts via createPty)`, harnessOf(sm.id) === undefined && optsFor(sm.id)?.harness === undefined && optsFor(sm.id)?.viaCodex === false);
  check(`(S-mgr ${label}) harness_default_skipped filed for the successor with the shared reason`, skipEvent(pm)?.workerSessionId === sm.id && JSON.stringify(skipIds(pm)) === JSON.stringify([needle]) && skipEvent(pm).detail.items[0].reason.includes("not supported on harness") && skipEvent(pm).detail.trigger === "recycle");
  check(`(S-mgr ${label}) the carried field itself is unchanged on the successor`, JSON.stringify(db.getSession(sm.id)[label]) === JSON.stringify(extra[label]));
}
{
  const pl = seed("platform", "aLeadCodex", undefined, { restrictedTools: true });
  const sl = await svc.recyclePlatformLead(pl, "handoff");
  check("(S-lead restrictedTools) claude row + codex profile + restrictedTools ⇒ successor stays claude", harnessOf(sl.id) === undefined && optsFor(sl.id)?.viaCodex === false);
  check("(S-lead restrictedTools) skip filed as harness_default_skipped", skipEvent(pl)?.workerSessionId === sl.id && skipIds(pl).join() === "restrictedTools");
  const pl2 = seed("platform", "aLeadCodex", undefined, { capabilities: [{ slug: "some-capability" }] });
  const sl2 = await svc.recyclePlatformLead(pl2, "handoff");
  check("(S-lead capabilities) same for a capability field", harnessOf(sl2.id) === undefined && skipIds(pl2).join() === "capabilities");
  const pc = seed("manager", "aMgrCodex", undefined);
  await svc.recycleManager(pc, "handoff");
  check("(S) REGRESSION/CONTROL: with no incompatible field the same codex-profile flip still lands and records no skip", harnessOf(db.listSessions("aMgrCodex").find((x) => x.recycledFrom === pc).id) === "codex" && skipEvent(pc) === undefined);
}

// ---------------- (P) platform lead ----------------
{
  const p1 = await svc.recyclePlatformLead(seed("platform", "aLeadCodex", undefined), "handoff");
  check("(P1) claude→codex: successor row + opts codex via createCodexPty", harnessOf(p1.id) === "codex" && optsFor(p1.id)?.harness === "codex" && optsFor(p1.id)?.viaCodex === true);
  const p2 = await svc.recyclePlatformLead(seed("platform", "aLeadPlain", "codex"), "handoff");
  check("(P2) codex→claude: successor row + opts unset via createPty", harnessOf(p2.id) === undefined && optsFor(p2.id)?.harness === undefined && optsFor(p2.id)?.viaCodex === false);
  const fkOnP = goneAgent("ghostP"); const ghostP = seed("platform", "ghostP", "codex");
  let p3; try { p3 = await svc.recyclePlatformLead(ghostP, "handoff"); } finally { fkOnP(); }
  check("(P3) agent missing ⇒ falls back to old.harness (codex)", harnessOf(p3.id) === "codex" && optsFor(p3.id)?.harness === "codex");
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
