import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 35cfcbe0 — the INERT-DIFF SKIP squash is pinned to the branch tip its skip decision covered (the two-path sibling of 01777ceb's reuse pin):
//   (IP) a docs-only branch is inert-skipped (no gate); a NON-docs worker commit landing after the decision but before mergeBranch's lock is refused in-lock, never squashed
//        ungated; the re-call re-evaluates (the diff is no longer inert, so a real gate runs) and merges.
//   (RD) re-derivation: the branch moves during the guard wait; a later non-docs commit is still refused, and the covered tip is the re-classified one.
//   (FC) isInertMergeDiff fails closed on an unreadable tip and evaluates the SHA it is given; the helper's discriminated input.
//   (GO) with the gate OFF (`skipReason:"gate-disabled"`) the squash is pinned too (card 6f13746c routed that skip through a `skip:"gate-disabled"` LandingPin): a late commit is refused in-lock, and the re-call lands it.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-inert-skip-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcisp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcisp-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, snapshotGateReflogs } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
const { isInertMergeDiff, expectedTipForLanding } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcisp@loom -c user.name=mcisp";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx, { plant = false, gateCommand = "pnpm gate", docs = false, mergeGate } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcisp-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcisp-mgr-${sfx}`, projId = `mcisp-p-${sfx}`, taskId = `mcisp-t-${sfx}`, workerId = `mcisp-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcisp\n");
  if (docs) { fs.mkdirSync(path.join(repo, "src"), { recursive: true }); fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;"); } // a JS/TS baseline so the inert-prefix applicability guard trusts the repo (card 0910531e)
  execSync("git init -q && git config user.email mcisp@loom && git config user.name mcisp", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCISP", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand, ...(mergeGate ? { mergeGate } : {}) } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcisp-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcisp-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcisp-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCISP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  if (docs) fs.mkdirSync(path.join(wt.worktreePath, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt.worktreePath, docs ? "docs/note.md" : "feature.txt"), "work");
  if (plant) { // single-file-retry needs a real-looking test-daemon.mjs + the named test file inside the worktree
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "test"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "test", "flaky-mid.mjs"), "// stub\n");
  }
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcisp-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, t1: headOf(wt.worktreePath) };
}
const svc = (db, runGate, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate, ...extra });

{
  // (IP) inert-skip pin.
  const { db, mgrId, workerId, repo, worktreePath } = await setup(sfxOf("ip"), { docs: true });
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  let release;
  const held = withCanonicalIndexLock(repo, () => new Promise((r) => { release = r; }));
  const confirming = confirm(sessions, mgrId, workerId);
  await waitUntil(() => db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.skipped === true), { timeoutMs: 60000, label: "the inert-skip decision was recorded" });
  fs.writeFileSync(path.join(worktreePath, "late.txt"), "late"); commitAll(worktreePath, "late non-docs worker commit", GIT_ID);
  release(); await held;
  const r1 = await confirming;
  check("(IP) the inert-skipped merge was REFUSED in-lock as gateTipMoved (nothing squashed, no gate ran)", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipMoved?.phase === "in-lock" && calls === 0 && !fs.existsSync(path.join(repo, "docs", "note.md")) && !fs.existsSync(path.join(repo, "late.txt")));
  check("(IP) it reports gateRan:false", r1.ok && r1.value.gateRan === false);
  check("(IP) the refusal wording names the skip decision, not a gate spawn", r1.ok && /inert/i.test(r1.value.reason ?? "") && !/gate spawned/.test(r1.value.reason ?? ""));
  const rej = db.listEvents(mgrId).find((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_tip_moved");
  check("(IP) the merge_rejected event says it was an inert skip", rej?.detail?.skipped === true && rej.detail.skipReason === "inert-docs-only-diff");
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(IP) never cached: the re-call re-evaluates (no longer inert, so a real gate runs) and merges the late commit", r2.ok && r2.cacheHit === undefined && calls === 1 && r2.value.merged === true && fs.existsSync(path.join(repo, "late.txt")));
}
{
  // (RD) the RE-DERIVATION path: the branch moves (a docs-only commit) while the inert skip waits for the repo guard, so the skip is re-classified on a fresh tip
  // (`reclassifyTip`); a NON-docs commit landing after THAT decision must still be refused in-lock, and the refusal's `covered` tip is the re-classified one.
  // The wait is injected deterministically by wrapping the semaphore's repo-guard acquisition (the exact await the guard-wait sits on).
  const { db, mgrId, workerId, repo, worktreePath } = await setup(sfxOf("rd"), { docs: true });
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  let docsTip = null;
  const origAcquire = sessions.gateSemaphore.acquireRepoGuardOnly.bind(sessions.gateSemaphore);
  sessions.gateSemaphore.acquireRepoGuardOnly = async (...a) => {
    const r = await origAcquire(...a);
    if (docsTip === null) { fs.writeFileSync(path.join(worktreePath, "docs", "extra.md"), "more"); commitAll(worktreePath, "docs-only commit during the guard wait", GIT_ID); docsTip = headOf(worktreePath); }
    return r;
  };
  let release;
  const held = withCanonicalIndexLock(repo, () => new Promise((r) => { release = r; }));
  const confirming = confirm(sessions, mgrId, workerId);
  await waitUntil(() => db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.skipped === true), { timeoutMs: 60000, label: "the re-derived inert-skip decision was recorded" });
  check("(RD) precondition: the docs-only commit landed DURING the guard wait (so the re-derivation path ran)", docsTip !== null);
  fs.writeFileSync(path.join(worktreePath, "late.txt"), "late"); commitAll(worktreePath, "late non-docs worker commit", GIT_ID);
  release(); await held;
  const r1 = await confirming;
  check("(RD) refused in-lock as gateTipMoved after the re-derived skip; nothing squashed, no gate ran", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipMoved?.phase === "in-lock" && r1.value.gateRan === false && calls === 0 && !fs.existsSync(path.join(repo, "late.txt")) && !fs.existsSync(path.join(repo, "docs", "note.md")));
  check("(RD) the refusal's covered tip is the RE-CLASSIFIED tip (the docs-only commit), not the pre-wait one", r1.ok && r1.value.gateTipMoved?.gated === docsTip);
  const rej = db.listEvents(mgrId).find((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_tip_moved");
  check("(RD) the event names the actual skip kind (inert)", rej?.detail?.skipped === true && rej.detail.skipReason === "inert-docs-only-diff" && rej.detail.reused === undefined);
}
{
  // (FC) fail-closed sink + the pin evaluates the SHA it is given: an unreadable tip is never inert; a docs-only SHA stays inert even after the branch NAME moves on.
  const { repo, worktreePath, branch } = await setup(sfxOf("fc"), { docs: true });
  const base = headOf(repo), docsSha = headOf(worktreePath);
  check("(FC) positive control: the docs-only branch sha is inert", (await isInertMergeDiff(repo, base, docsSha)) === true);
  check("(FC) an unreadable tip (undefined) fails closed to not-inert", (await isInertMergeDiff(repo, base, undefined)) === false);
  fs.writeFileSync(path.join(worktreePath, "later.txt"), "later"); commitAll(worktreePath, "non-docs commit moves the branch name", GIT_ID);
  check("(FC) by NAME the moved branch is no longer inert, but the classified SHA still is (the tip that was classified is the tip that gets pinned)", (await isInertMergeDiff(repo, base, branch)) === false && (await isInertMergeDiff(repo, base, docsSha)) === true);
  check("(FC) expectedTipForLanding: gate/skip variants return their tip, only an explicit `unpinned` returns undefined",
    expectedTipForLanding({ kind: "gate", tip: "g" }) === "g" && expectedTipForLanding({ kind: "skip", skip: "inert", tip: "i" }) === "i" && expectedTipForLanding({ kind: "skip", skip: "reuse", tip: "r" }) === "r"
    && expectedTipForLanding({ kind: "skip", skip: "gate-disabled", tip: "d" }) === "d" && expectedTipForLanding({ kind: "skip", skip: "gate-interval", tip: "n" }) === "n"
    && expectedTipForLanding({ kind: "unpinned", reason: "no-gate-configured" }) === undefined);
}
{
  // (GO) gate OFF: pinned (see the header).
  const { db, mgrId, workerId, repo, worktreePath } = await setup(sfxOf("go"), { docs: true, mergeGate: "off" });
  const sessions = svc(db, async () => { throw new Error("no gate may run with the gate off"); });
  let release;
  const held = withCanonicalIndexLock(repo, () => new Promise((r) => { release = r; }));
  const confirming = confirm(sessions, mgrId, workerId);
  await waitUntil(() => db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-disabled"), { timeoutMs: 60000, label: "the gate-disabled skip was recorded" });
  fs.writeFileSync(path.join(worktreePath, "late.txt"), "late"); commitAll(worktreePath, "late worker commit", GIT_ID);
  release(); await held;
  const r1 = await confirming;
  check("(GO) with the gate off the late commit is REFUSED in-lock (gateTipMoved, gateRan:false) and NOT squashed", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipMoved?.phase === "in-lock" && r1.value.gateRan === false && !fs.existsSync(path.join(repo, "late.txt")));
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(GO) never cached: the re-call re-decides and lands the new tip (gate still off, no gate run)", r2.ok && r2.value.merged === true && r2.value.skipReason === "gate-disabled" && fs.existsSync(path.join(repo, "late.txt")));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
