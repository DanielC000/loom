import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6b8822d2 (Code Reviewer e001ee19, round 2, item 3) — a quarantine raised in the GAP between
// confirmWorkerMerge's own EARLY, unlocked `assertRepoNotQuarantined` backstop and the combined
// `withCanonicalIndexLock` acquisition that now wraps all three admission-time canonical-dirt probes
// (detectCanonicalStagedDirt/detectCanonicalDirtyOverlap/detectCanonicalUntrackedOverlap) must surface as
// the SAME `{merged:false, quarantined:true, gateRan:false}` refusal shape the early backstop itself uses
// — never `{staged:false}`/`{overlap:false}` falling through to a real (wasted) gate run against a repo
// already known quarantined.
//
// Proves:
//   (Q) a quarantine raised DURING `reviewedTipVerdict` (the real async step confirmWorkerMerge runs
//       between its early backstop and the combined probe lock) is caught by `withCanonicalIndexLock`'s
//       own `guarded()` check, re-thrown as `RepoQuarantinedError`, and converted to the exact quarantined
//       refusal shape: merged:false, quarantined:true, gateRan:false, reason names the quarantine, a
//       merge_rejected(reason:"quarantined") event is recorded, the gate command is NEVER called, and the
//       canonical repo/worktree are left untouched.
//   (CLEAR) after clearing the quarantine, a re-call proceeds normally and lands.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-admission-quarantine.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcaq-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { enterMergeQuarantine, clearMergeQuarantine, assertRepoNotQuarantined } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcaq@loom -c user.name=mcaq";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const noReap = async () => ({ killedPids: [] });
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

const repo = path.join(os.tmpdir(), `loom-mcaq-repo-${sfx}`);
registerForCleanup(repo);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# mcaq\n");
execSync("git init -q && git config user.email mcaq@loom && git config user.name mcaq", { cwd: repo });
commitAll(repo, "init", GIT_ID);

const db = new Db();
const mgrId = `mcaq-mgr-${sfx}`, projId = `mcaq-p-${sfx}`, taskId = `mcaq-t-${sfx}`, workerId = `mcaq-w-${sfx}`;
let gateCalls = 0;
db.insertProject({ id: projId, name: "MCAQ", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: `agent-mcaq-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcaq-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertAgent({ id: `agent-mcaq-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "MCAQ-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const wt = await createWorktree(repo, projId, taskId);
registerForCleanup(wt.worktreePath);
fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
commitAll(wt.worktreePath, "feature", GIT_ID);
db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcaq-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000,
  reapWorktreeProcesses: noReap,
  runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
});

// ── (Q) quarantine raised mid-flight, in the GAP between the early backstop and the combined probe lock ──
check("(Q) precondition: repo is NOT quarantined before the call", assertRepoNotQuarantined(repo).ok === true);
let quarantinedDuringGap = false;
const origReviewedTipVerdict = sessions.reviewedTipVerdict.bind(sessions);
sessions.reviewedTipVerdict = async (...args) => {
  const r = await origReviewedTipVerdict(...args);
  // Fires AFTER confirmWorkerMerge's own early, unlocked assertRepoNotQuarantined backstop has already
  // run and passed (reviewedTipVerdict is called strictly after it) and BEFORE the combined
  // withCanonicalIndexLock probe acquisition further down — exactly the gap item 3 targets.
  if (!quarantinedDuringGap) {
    enterMergeQuarantine(repo, wt.branch, "manufactured for admission-quarantine test (card 6b8822d2)");
    quarantinedDuringGap = true;
  }
  return r;
};

const headBefore = headOf(repo);
const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
check("(Q) the quarantine really landed during the gap (not before the call)", quarantinedDuringGap === true);
check("(Q) confirm settled", r1.settled === true && r1.ok === true);
check("(Q) merged:false", r1.value.merged === false);
check("(Q) quarantined:true (the SAME shape the early backstop uses, not {staged:false}/{overlap:false})", r1.value.quarantined === true);
check("(Q) gateRan:false — the gate command was never spawned", r1.value.gateRan === false && gateCalls === 0);
check("(Q) reason names the manufactured quarantine", /manufactured for admission-quarantine test/.test(r1.value.reason ?? ""));
check("(Q) a merge_rejected(reason:quarantined) event was recorded", db.listEvents(mgrId).some((e) => e.kind === "merge_rejected" && e.detail?.reason === "quarantined"));
check("(Q) canonical HEAD UNCHANGED — nothing was squashed", headOf(repo) === headBefore);
check("(Q) the worker's feature content never landed", !fs.existsSync(path.join(repo, "feature.txt")));
check("(Q) the worktree is retained", fs.existsSync(wt.worktreePath));

// ── (CLEAR) once the quarantine is lifted, a re-call proceeds normally ──────────────────────────────────
clearMergeQuarantine(repo);
check("(CLEAR) precondition: repo is no longer quarantined", assertRepoNotQuarantined(repo).ok === true);
const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked (re-call)" });
check("(CLEAR) never cached: the re-call re-evaluates for real and merges", r2.ok && r2.cacheHit === undefined && gateCalls === 1 && r2.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));

try { db.close(); } catch { /* already closed */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — a quarantine raised between confirmWorkerMerge's early backstop and the combined admission-probe lock is caught and returns the SAME quarantined:true refusal shape (never a probe fail-safe default that would burn a real gate run)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
