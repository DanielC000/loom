import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 92be634e, LEAD round-2 ruling 1: a reduced-gate `--only-file=` overflow write failure
// (buildReducedGateCommand -> ReducedGateOnlyFileError) is a transient prep-time fact, never a verdict
// about the branch's content — it must NEVER be served from the until-superseded verdict cache to a later
// re-call. Mirrors merge-confirm-squash-refusal-recall.mjs's own (never-behind) scenario exactly: REAL git
// on a real temp repo/worktree, the SAME `confirmWorkerMergeTracked` entry point, no stubbed classification.
//
// REAL oversized changedTestFiles set (one worktree adds enough new, hermetic, top-level test/*.mjs files
// to cross REDUCED_GATE_ONLY_INLINE_MAX_CHARS for real) + a REAL write failure (a regular file blocking
// GATE_SPILL_DIR's own path, so writeReducedGateOnlyFileReal's own mkdirSync genuinely throws).
//
// Kept in its own file, not added to merge-confirm-squash-refusal-recall.mjs, for the same per-file
// timeout-ceiling reason _emit-compare-fixtures.mjs's own header documents (card 4dfc648a) — writing ~150+
// real fixture files is extra wall time this scenario alone should not add to that file's own margin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcrg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, REDUCED_GATE_ONLY_INLINE_MAX_CHARS } = await import("../dist/git/worktrees.js");
const { GATE_SPILL_DIR } = await import("../dist/orchestration/gate-spill.js");
const { writeRealTestDaemonScript } = await import("./_emit-compare-fixtures.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcrg@loom -c user.name=mcrg";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcrg\n");
  execSync(`git init -q && git config user.email mcrg@loom && git config user.name mcrg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const ONLY_PREFIX = "pnpm --filter @loom/daemon test:daemon --only=";
const PAD_NAME = (n) => `mcrg-overflow-padding-file-${String(n).padStart(4, "0")}`;
function neededPadCount() {
  let n = 0;
  let total = ONLY_PREFIX.length;
  while (total <= REDUCED_GATE_ONLY_INLINE_MAX_CHARS) {
    total += PAD_NAME(n).length + 1;
    n++;
  }
  return n + 20;
}

async function setupWorkerProject(sfx, reposDir, gateCommand = "pnpm gate") {
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `mcrg-mgr-${sfx}`, projId = `mcrg-p-${sfx}`, taskId = `mcrg-t-${sfx}`, workerId = `mcrg-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  writeRealTestDaemonScript(repo);
  commitAll(repo, "chore: add real test-daemon script", GIT_ID);
  const config = { orchestration: { gateCommand } };
  db.insertProject({ id: projId, name: "MCRG", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcrg-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcrg-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcrg-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCRG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  const padCount = neededPadCount();
  const testDir = path.join(worktreePath, "packages", "daemon", "test");
  for (let i = 0; i < padCount; i++) {
    fs.writeFileSync(path.join(testDir, `${PAD_NAME(i)}.mjs`), "console.log(\"PASS  padding\");\nprocess.exit(0);\n");
  }
  commitAll(worktreePath, "test: add overflow padding files", GIT_ID);
  const names = Array.from({ length: padCount }, (_, i) => PAD_NAME(i));
  const expectedLen = ONLY_PREFIX.length + names.join(",").length;
  if (expectedLen <= REDUCED_GATE_ONLY_INLINE_MAX_CHARS) throw new Error("fixture bug: padding set does not cross the threshold");
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcrg-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, repo, worktreePath, branch };
}

// (never-behind) the solo analogue of batch-merge-reduced-gate-only-file-failure.mjs's own scenario:
// gate passes, but the reduced gate's --only-file= overflow write fails (GATE_SPILL_DIR blocked) -> refused
// distinctly, NEVER cached; once the block clears, a plain re-call genuinely re-attempts and lands.
{
  const sfx = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mcrg-nb-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
  });

  // THE FAILURE INJECTION: a regular FILE sits where GATE_SPILL_DIR needs to become a directory.
  fs.mkdirSync(path.dirname(GATE_SPILL_DIR), { recursive: true });
  fs.writeFileSync(GATE_SPILL_DIR, "a plain file blocking the real gate-output directory\n", "utf8");
  check("[setup] GATE_SPILL_DIR's own path is genuinely blocked by a file, not a directory", fs.statSync(GATE_SPILL_DIR).isFile());

  const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(never-behind) op 1 settled, NOT merged (the overflow write failed before any gate step spawned) — fixture sanity",
    r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
  console.log("  r1 reason:", r1.ok ? r1.value.reason : r1.error);
  check("(never-behind) op 1 carries the distinct reducedGateOnlyFileFailed flag", r1.ok && r1.value.reducedGateOnlyFileFailed === true);
  check("(never-behind) op 1's reason names the real cause", r1.ok && typeof r1.value.reason === "string" && /could not prepare the reduced gate's --only selection/.test(r1.value.reason));

  fs.rmSync(GATE_SPILL_DIR, { force: true }); // clear the blocking condition — the human-fix analogue
  const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  console.log("  r2 cacheHit:", r2.cacheHit, "gateCalls:", gateCalls, "merged:", r2.ok && r2.value.merged);
  check("(never-behind) after the block clears the re-confirm is NOT a replay of the stale refusal (cacheHit undefined)", r2.cacheHit === undefined);
  check("(never-behind) the re-confirm actually gated for real and landed the merge", r2.ok && r2.value.merged === true && gateCalls === 1);

  // STRUCTURAL PIN: classifyOutcome + NEVER_CACHED_OUTCOMES both carry the new outcome string (mirrors
  // merge-confirm-squash-refusal-recall.mjs's own scenario (s)).
  const src = fs.readFileSync(new URL("../src/sessions/service.ts", import.meta.url), "utf8");
  check("(structural) classifyOutcome maps reducedGateOnlyFileFailed to the distinct outcome string",
    /outcome\.value\.reducedGateOnlyFileFailed \? "reduced-gate-only-file-failed"/.test(src));
  const po = fs.readFileSync(new URL("../src/orchestration/pending-ops.ts", import.meta.url), "utf8");
  check("(structural) \"reduced-gate-only-file-failed\" is in NEVER_CACHED_OUTCOMES",
    /NEVER_CACHED_OUTCOMES[^\n]*"reduced-gate-only-file-failed"/.test(po));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
