import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af902717 — a manager-spawned worker must receive its agent BASE BRIEF (agent.startupPrompt)
// composed ahead of the dynamic part, on BOTH paths (spawn kickoff + recycle handoff). Before this,
// `composeWorkerStartupPrompt` didn't exist and workers only ever got the dynamic text — so the
// Dev/Bugfix/Web-Designer briefs ("Step 0: run `/worker`", "CLAUDE.md is law") were dead config.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like manager-context-block.mjs: isolated LOOM_HOME, a REAL Db +
// SessionService driven against a FAKE pty injected via PtyHost's createPty() seam — no real claude, no
// daemon, no network. A real temp git repo backs the project so spawnWorker/recycleWorker's worktree git
// is real. The fake pty fires its onExit on kill() so recycleWorker's hard-stop wait resolves instantly.
//
// Proves the DoD:
//   (1) pure composeWorkerStartupPrompt: brief leads, dynamic follows; empty/whitespace/undefined ⇒ dynamic-only.
//   (2) SPAWN: a brief-bearing worker's opts.startupPrompt = brief THEN kickoff; an empty-brief worker = kickoff alone.
//   (3) RECYCLE: a brief-bearing worker's successor opts.startupPrompt = brief THEN handoff; empty-brief = handoff alone.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-wprompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeWorkerStartupPrompt } = await import("../dist/sessions/worker-prompt.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

// --- a real temp git repo so worktree git (real) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wprompt-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-prompt test\n");
execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pW", name: "WProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pW", name: "Orchestrator", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pW", name: "Dev", startupPrompt: "DEV_BRIEF", position: 1, profileId: null });
db.insertAgent({ id: "agentQA", projectId: "pW", name: "QA", startupPrompt: "", position: 2, profileId: null }); // empty brief (like the shipped QA agent)
db.insertSession({
  id: "mgr1", projectId: "pW", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const taskA = "11111111-1111-1111-8111-111111111111";
const taskB = "22222222-2222-2222-8222-222222222222";
db.insertTask({ id: taskA, projectId: "pW", title: "A", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pW", title: "B", body: "", columnKey: "todo", position: 2, createdAt: now, updatedAt: now });

// --- fake pty: captures every SpawnOpts, and fires onExit on kill() so recycleWorker's hard-stop wait resolves fast ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242, write() {}, resize() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
    };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);
const order = (s, a, b) => s.includes(a) && s.includes(b) && s.indexOf(a) < s.indexOf(b);

const worktrees = [];
const worktreesR = [];
let repoR = null;
try {
  // ===================== (1) pure composeWorkerStartupPrompt =====================
  const composed = composeWorkerStartupPrompt("BRIEF", "DYNAMIC");
  check("(1) pure: brief leads, dynamic follows", order(composed, "BRIEF", "DYNAMIC"));
  check("(1) pure: undefined brief ⇒ dynamic-only", composeWorkerStartupPrompt(undefined, "DYNAMIC") === "DYNAMIC");
  check("(1) pure: whitespace brief ⇒ dynamic-only (trimmed away)", composeWorkerStartupPrompt("   \n  ", "DYNAMIC") === "DYNAMIC");
  check("(1) pure: empty brief ⇒ dynamic-only", composeWorkerStartupPrompt("", "DYNAMIC") === "DYNAMIC");
  // 2-arg form (no cwd) stays byte-identical — backward-compat for the pure callers/tests.
  check("(1) pure: 2-arg form (no cwd) is byte-unchanged — no location block", composeWorkerStartupPrompt("BRIEF", "DYNAMIC") === "BRIEF\n\n---\n\nDYNAMIC");
  // 3-arg form prepends the worktree location block ahead of the brief, naming the cwd as the edit dir.
  const composedCwd = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path");
  check("(1) pure: cwd ⇒ worktree block leads, then brief, then dynamic", order(composedCwd, "/wt/path", "BRIEF") && order(composedCwd, "BRIEF", "DYNAMIC"));
  check("(1) pure: cwd ⇒ block names the worktree as the edit dir", composedCwd.includes("make ALL edits here") && composedCwd.includes("`/wt/path`"));
  // Block is present even with an EMPTY brief (the QA startupPrompt:"" case) — block then dynamic.
  const composedEmptyCwd = composeWorkerStartupPrompt("", "DYNAMIC", "/wt/path");
  check("(1) pure: empty brief + cwd ⇒ block still present, leads the dynamic part", composedEmptyCwd.includes("`/wt/path`") && order(composedEmptyCwd, "/wt/path", "DYNAMIC"));

  // ===================== (1e) reference-repos epic Phase 3: referenceRepos block =====================
  check("(1e) pure: no referenceRepos (undefined) ⇒ byte-identical to the pre-Phase-3 composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path") === composedCwd);
  check("(1e) pure: empty referenceRepos ⇒ byte-identical to omitted", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", []) === composedCwd);
  check("(1e) pure: no referenceRepos ⇒ no 'Also referenced' block", !composedCwd.includes("Also referenced"));
  const composedWithRefs = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", ["/abs/refA", "/abs/refB"]);
  check("(1e) pure: non-empty referenceRepos ⇒ 'Also referenced' block present", composedWithRefs.includes("Also referenced"));
  check("(1e) pure: both reference repo paths listed", composedWithRefs.includes("/abs/refA") && composedWithRefs.includes("/abs/refB"));
  check("(1e) pure: read-only framing present (never commit there)", /never commit there/i.test(composedWithRefs));
  check("(1e) pure: worktree location block + brief + dynamic all still present alongside the ref block", composedWithRefs.includes("/wt/path") && composedWithRefs.includes("BRIEF") && composedWithRefs.includes("DYNAMIC"));
  // no cwd ⇒ no location block ⇒ referenceRepos is moot too (there's nowhere to anchor it) — still byte-identical to the 2-arg form.
  check("(1e) pure: no cwd ⇒ referenceRepos is ignored, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, ["/abs/refA"]) === "BRIEF\n\n---\n\nDYNAMIC");

  // ===================== (1f) board card 2250836c: reusedDirtyWorktree reconcile-note block =====================
  check("(1f) pure: no reusedDirtyWorktree (undefined) ⇒ byte-identical to the pre-card composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", ["/abs/refA", "/abs/refB"]) === composedWithRefs);
  check("(1f) pure: no reusedDirtyWorktree ⇒ no reconcile block", !composedCwd.includes("Reused worktree"));
  const dirtyInfo = { statusSummary: "?? leftover.txt\n M modified.txt", fileCount: 2, truncated: false };
  const composedDirty = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo);
  check("(1f) pure: reusedDirtyWorktree set ⇒ reconcile block present", composedDirty.includes("Reused worktree"));
  check("(1f) pure: reconcile block names the leftover paths", composedDirty.includes("leftover.txt") && composedDirty.includes("modified.txt"));
  check("(1f) pure: reconcile block tells the worker to finish or revert before new edits", /finish|revert/i.test(composedDirty));
  check("(1f) pure: worktree location block + brief + dynamic still all present alongside the reconcile block", composedDirty.includes("/wt/path") && composedDirty.includes("BRIEF") && composedDirty.includes("DYNAMIC"));
  check("(1f) pure: no cwd ⇒ reusedDirtyWorktree is ignored too, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, undefined, dirtyInfo) === "BRIEF\n\n---\n\nDYNAMIC");
  const truncatedInfo = { statusSummary: "?? a.txt\n?? b.txt", fileCount: 40, truncated: true };
  const composedTruncated = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, truncatedInfo);
  check("(1f) pure: truncated summary surfaces the true total count", composedTruncated.includes("40"));

  // ===================== (2) SPAWN composes the worktree block + brief ahead of the kickoff =====================
  const wA = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "KICKOFF_A" });
  worktrees.push(wA.worktreePath);
  const oWA = optsFor(wA.id);
  check("(2) spawn (brief): startupPrompt carries the agent brief THEN the kickoff", order(oWA?.startupPrompt ?? "", "DEV_BRIEF", "KICKOFF_A"));
  check("(2) spawn (brief): startupPrompt names the worktree cwd as the edit dir, ahead of the brief", (oWA?.startupPrompt ?? "").includes(wA.worktreePath) && (oWA?.startupPrompt ?? "").includes("make ALL edits here") && order(oWA?.startupPrompt ?? "", wA.worktreePath, "DEV_BRIEF"));

  const wQ = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentQA", kickoffPrompt: "KICKOFF_B" });
  worktrees.push(wQ.worktreePath);
  const oWQ = optsFor(wQ.id);
  check("(2) spawn (empty brief): startupPrompt is the worktree block THEN the kickoff (block present even with empty brief)", (oWQ?.startupPrompt ?? "").includes(wQ.worktreePath) && (oWQ?.startupPrompt ?? "").includes("KICKOFF_B") && order(oWQ?.startupPrompt ?? "", wQ.worktreePath, "KICKOFF_B"));
  check("(2) project pW has no referenceRepos ⇒ worker spawns carry NO 'Also referenced' block (byte-identical guarantee)", !(oWA?.startupPrompt ?? "").includes("Also referenced") && !(oWQ?.startupPrompt ?? "").includes("Also referenced"));

  // ===================== (3) RECYCLE composes the worktree block + brief ahead of the handoff =====================
  const rA = await svc.recycleWorker("mgr1", wA.id, "HANDOFF_A");
  const oRA = optsFor(rA.id);
  check("(3) recycle (brief): successor startupPrompt carries the agent brief THEN the handoff", order(oRA?.startupPrompt ?? "", "DEV_BRIEF", "HANDOFF_A"));
  check("(3) recycle (brief): the handoff frame is preserved after the brief", (oRA?.startupPrompt ?? "").includes("[loom:handoff]"));
  check("(3) recycle (brief): successor startupPrompt names the SAME worktree cwd as the edit dir, ahead of the brief", (oRA?.startupPrompt ?? "").includes(rA.worktreePath) && (oRA?.startupPrompt ?? "").includes("make ALL edits here") && order(oRA?.startupPrompt ?? "", rA.worktreePath, "DEV_BRIEF"));

  const rQ = await svc.recycleWorker("mgr1", wQ.id, "HANDOFF_B");
  const oRQ = optsFor(rQ.id);
  check("(3) recycle (empty brief): successor startupPrompt is the worktree block THEN the handoff (block present, no brief prefix)", (oRQ?.startupPrompt ?? "").includes(rQ.worktreePath) && (oRQ?.startupPrompt ?? "").includes("[loom:handoff]") && (oRQ?.startupPrompt ?? "").includes("HANDOFF_B") && order(oRQ?.startupPrompt ?? "", rQ.worktreePath, "[loom:handoff]"));
  check("(3) project pW has no referenceRepos ⇒ recycle successors carry NO 'Also referenced' block (byte-identical guarantee)", !(oRA?.startupPrompt ?? "").includes("Also referenced") && !(oRQ?.startupPrompt ?? "").includes("Also referenced"));

  // ===================== (4) reference-repos epic Phase 3: a project WITH referenceRepos injects the =====
  // 'Also referenced (read-only)' block into REAL worker spawn AND recycle (not just the pure function).
  const refRepoA = path.join(os.tmpdir(), `loom-wprompt-refA-${Date.now()}`);
  const refRepoB = path.join(os.tmpdir(), `loom-wprompt-refB-${Date.now()}`);
  fs.mkdirSync(refRepoA, { recursive: true });
  fs.mkdirSync(refRepoB, { recursive: true });
  repoR = path.join(os.tmpdir(), `loom-wprompt-repoR-${Date.now()}`);
  fs.mkdirSync(repoR, { recursive: true });
  fs.writeFileSync(path.join(repoR, "README.md"), "# ref-repos worker test\n");
  execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repoR });
  db.insertProject({ id: "pWR", name: "WRefProj", repoPath: repoR, vaultPath: repoR, config: {}, createdAt: now, archivedAt: null, referenceRepos: [refRepoA, refRepoB] });
  db.insertAgent({ id: "agentDevRef", projectId: "pWR", name: "Dev", startupPrompt: "DEV_REF_BRIEF", position: 0, profileId: null });
  db.insertSession({
    id: "mgrR", projectId: "pWR", agentId: "agentDevRef", engineSessionId: null, title: null,
    cwd: repoR, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const taskR = "33333333-3333-3333-8333-333333333333";
  db.insertTask({ id: taskR, projectId: "pWR", title: "R", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

  const wR = await svc.spawnWorker("mgrR", { taskId: taskR, agentId: "agentDevRef", kickoffPrompt: "KICKOFF_R" });
  worktreesR.push(wR.worktreePath);
  const oWR = optsFor(wR.id);
  check("(4) referenceRepos worker spawn carries the 'Also referenced' block", (oWR?.startupPrompt ?? "").includes("Also referenced"));
  check("(4) referenceRepos worker spawn lists BOTH reference repo absolute paths", (oWR?.startupPrompt ?? "").includes(refRepoA) && (oWR?.startupPrompt ?? "").includes(refRepoB));
  check("(4) referenceRepos worker spawn carries the read-only framing (never commit there)", /never commit there/i.test(oWR?.startupPrompt ?? ""));
  check("(4) referenceRepos worker spawn still carries its own worktree edit-dir block + brief + kickoff", (oWR?.startupPrompt ?? "").includes(wR.worktreePath) && (oWR?.startupPrompt ?? "").includes("DEV_REF_BRIEF") && (oWR?.startupPrompt ?? "").includes("KICKOFF_R"));

  const rR = await svc.recycleWorker("mgrR", wR.id, "HANDOFF_R");
  worktreesR.push(rR.worktreePath);
  const oRR = optsFor(rR.id);
  check("(4) referenceRepos recycle successor carries the 'Also referenced' block", (oRR?.startupPrompt ?? "").includes("Also referenced"));
  check("(4) referenceRepos recycle successor lists BOTH reference repo absolute paths", (oRR?.startupPrompt ?? "").includes(refRepoA) && (oRR?.startupPrompt ?? "").includes(refRepoB));
  check("(4) referenceRepos recycle successor still carries its handoff + worktree edit-dir block", (oRR?.startupPrompt ?? "").includes("[loom:handoff]") && (oRR?.startupPrompt ?? "").includes(rR.worktreePath));
  try { fs.rmSync(refRepoA, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(refRepoB, { recursive: true, force: true }); } catch { /* best-effort */ }
  // repoR itself is removed in `finally`, AFTER its worktrees are torn down (git worktree remove needs
  // the main repo present).

  // ===================== (5) board card 2250836c: a HARD-STOPPED worker's retained worktree, re-spawned =====
  // onto the SAME task, surfaces reusedDirtyWorktree on the result AND injects a reconcile note into the
  // new worker's OWN kickoff — end-to-end through the real spawnWorker/createWorktree path (no fakes for
  // the git side), same style as the referenceRepos section above.
  const taskD = "44444444-4444-4444-8444-444444444444";
  db.insertTask({ id: taskD, projectId: "pW", title: "D", body: "", columnKey: "todo", position: 3, createdAt: now, updatedAt: now });

  // First spawn: fresh worktree — must NOT carry any reconcile note.
  const wD1 = await svc.spawnWorker("mgr1", { taskId: taskD, agentId: "agentDev", kickoffPrompt: "KICKOFF_D1" });
  worktrees.push(wD1.worktreePath);
  check("(5) fresh spawn never sets reusedDirtyWorktree", wD1.reusedDirtyWorktree === undefined);
  const oWD1 = optsFor(wD1.id);
  check("(5) fresh spawn's kickoff carries NO reconcile block", !(oWD1?.startupPrompt ?? "").includes("Reused worktree"));

  // Simulate worker_stop(hard): the worktree is RETAINED (never removed) and the worker just leaves
  // real uncommitted work behind mid-edit — the exact card 2250836c repro shape.
  fs.writeFileSync(path.join(wD1.worktreePath, "leftover.txt"), "in-progress edit from the hard-stopped worker\n");
  db.setProcessState(wD1.id, "exited"); // frees the one-live-worker-per-task guard for the re-spawn below

  // Re-spawn onto the SAME task → reuses the SAME worktree (dirty).
  const wD2 = await svc.spawnWorker("mgr1", { taskId: taskD, agentId: "agentDev", kickoffPrompt: "KICKOFF_D2" });
  check("(5) re-spawn reuses the SAME worktree path", wD2.worktreePath === wD1.worktreePath);
  check("(5) re-spawn RESULT carries reusedDirtyWorktree", wD2.reusedDirtyWorktree !== undefined);
  check("(5) reusedDirtyWorktree names the leftover file", wD2.reusedDirtyWorktree?.statusSummary.includes("leftover.txt"));
  check("(5) reusedDirtyWorktree.fileCount is 1", wD2.reusedDirtyWorktree?.fileCount === 1);

  const oWD2 = optsFor(wD2.id);
  check("(5) the NEW worker's OWN kickoff carries the reconcile note", (oWD2?.startupPrompt ?? "").includes("Reused worktree"));
  check("(5) the reconcile note names the leftover file", (oWD2?.startupPrompt ?? "").includes("leftover.txt"));
  check("(5) the reconcile note still leads into the manager's kickoff", order(oWD2?.startupPrompt ?? "", "Reused worktree", "KICKOFF_D2"));
  check("(5) the leftover file is STILL ON DISK — spawning never cleaned it", fs.existsSync(path.join(wD2.worktreePath, "leftover.txt")));
} finally {
  for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  if (repoR) { for (const wt of worktreesR) { try { await removeWorktree(repoR, wt); } catch { /* best-effort */ } } }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (repoR) { try { fs.rmSync(repoR, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — workers receive their agent base brief composed ahead of the dynamic part on BOTH spawn and recycle; an empty brief degrades to the dynamic part alone — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
