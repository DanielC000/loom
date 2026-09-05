import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH endSquash GATING (card dd961cf9) — `SessionService.mergeBatchTracked`'s own repo-guard release
// call (`this.gateSemaphore.endSquash(finalRepoPath, opId)`) used to fire UNCONDITIONALLY after
// `runBatchedMerge()` returned, even on a `landed.length === 0` batch (every candidate an empty diff) —
// a path where `runBatchedMerge` never calls `runGate` at all (batch-merge.ts:741-743), so this op was
// never admitted into `activeMergeRepos` for `finalRepoPath` in the first place. `GateSemaphore
// .freeRepoPath`'s identity check made this a SAFE no-op (never touched a genuinely-admitted sibling's
// hold), but it logged a spurious, alarming-looking `[gate:repo-guard] refused-not-owner` line on every
// such batch — noise observed in production (op aa9b6e15 vs a genuinely-admitted sibling 0bf14248,
// 2026-09-04T21:02:15.775Z) that degrades the very instrument this card's diagnosis depends on.
//
// This proves the fix: a zero-landed batch (two candidates, each with ZERO commits ahead of canonical
// main — `assembleBatchBranches`/`landBranchCommitsIndividually` classifies each `mergeBase === branchTip`
// as a `STAGE_EMPTY_RETRY` no-op and drops both) no longer logs a `refused-not-owner` line BEFORE this
// call's own first real `[gate:repo-guard]` admission — the exact discriminator between the redundant,
// never-admitted `endSquash` call this fix removes and a legitimate, self-consistent admit/release cycle.
//
// POSITIVE CONTROL (required — see this card's own kickoff): running this SAME check against the
// PRE-FIX source (the unconditional `this.gateSemaphore.endSquash(finalRepoPath, opId);` with no
// `if (batchGateRan)` guard) must show the check going RED — a stray refused-not-owner line DOES appear
// before any real admission. Verified by hand: `git stash`-free revert via a captured diff (see the
// worker's own report for the exact before/after run) — this file's own check is written so that
// re-running it against the un-gated call site fails, not merely so it passes against the gated one.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-endsquash-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-besg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=besg@loom -c user.name=besg";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# besg\n");
  execSync(`git init -q && git config user.email besg@loom && git config user.name besg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const dbs = [];
const worktrees = [];
try {
  const repo = path.join(os.tmpdir(), `loom-besg-${sfx}`);
  makeRepo(repo);
  const projId = `besg-proj-${sfx}`;
  const agentId = `besg-agent-${sfx}`;
  const mgrId = `besg-mgr-${sfx}`;

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BESG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // Two candidates, each with ZERO commits ahead of canonical main (`createWorktree` cuts a new branch
  // pointing at the SAME commit as HEAD; neither worktree is ever written to) — `mergeBase === branchTip`
  // for both, so `assembleBatchBranches` drops both as `STAGE_EMPTY_RETRY` and `runBatchedMerge` returns
  // with `landed.length === 0` WITHOUT ever calling `runGate` (batch-merge.ts:741-743).
  const wA = `besg-wkr-a-${sfx}`, wB = `besg-wkr-b-${sfx}`;
  for (const [wId, label] of [[wA, "a"], [wB, "b"]]) {
    const taskId = `besg-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  }

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

  // Capture console output across the whole batch call. Discriminator: does a `[gate:repo-guard]`
  // mutation line for THIS repoPath ever appear BEFORE this call's own first genuine admission
  // (`site=admit`)? A stray pre-admission `refused-not-owner` is exactly the redundant, never-admitted
  // `endSquash` call this fix removes — a legitimate cycle always logs `admit` first, by construction
  // (GateSemaphore.admit is the ONLY place `activeMergeRepos` is ever populated).
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); origLog(...args); };
  let result;
  try {
    const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    result = r.settled && r.ok ? r.value : { ok: false, landed: [], fallback: [], reason: `did not settle synchronously: ${JSON.stringify(r)}` };
  } finally {
    console.log = origLog;
  }

  check("(precondition) batch landed nothing — both candidates were empty-diff no-ops", result.ok === false && (result.reason ?? "").includes("nothing landed"));

  const repoGuardLines = lines.filter((l) => l.includes("[gate:repo-guard]") && l.includes(repo));
  // Positive control on the FILTER itself: some [gate:repo-guard] activity must exist in this run at all
  // (the two fallback solo confirms each go through a real admit/beginSquash/endSquash cycle for their
  // own empty-diff detection) — a filter that matched nothing would make the discriminator below
  // vacuously pass no matter what the fix does.
  check("(sanity) this run produced at least one [gate:repo-guard] line for this repo (filter isn't vacuous)", repoGuardLines.length > 0);

  const firstAdmitIdx = repoGuardLines.findIndex((l) => l.includes("site=admit"));
  const firstRefusedIdx = repoGuardLines.findIndex((l) => l.includes("refused-not-owner"));
  const strayPreAdmitRefusal = firstRefusedIdx !== -1 && (firstAdmitIdx === -1 || firstRefusedIdx < firstAdmitIdx);
  check("(fix) no stray refused-not-owner logged before this call's own first real admission", !strayPreAdmitRefusal);
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
