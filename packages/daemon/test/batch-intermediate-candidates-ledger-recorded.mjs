import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c13666c6 — a real multi-candidate batch writes exactly ONE mainline_landed_commits row per batch
// call (base=the batch's own cut point, tip=the final landed sha — see recordMainlineLandedCommit's two
// call sites, service.ts), never one row per candidate. This proves the half-open-range rule in
// verifyGoneBranchLanding (git/worktrees.ts) still correctly classifies EVERY candidate inside that one
// row's range as "recorded" — not just the last one, whose own commit happens to equal the row's tip.
// See docs/decisions/c13666c6-branch-gone-ledger-cutover-gate.md.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-intermediate-candidates-ledger-recorded.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-bic-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, findLandedSquashCommit } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bic", GIT_AUTHOR_EMAIL: "bic@loom", GIT_COMMITTER_NAME: "bic", GIT_COMMITTER_EMAIL: "bic@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bic@loom -c user.name=bic";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const repo = mkdtempManaged("loom-bic-repo-");
fs.writeFileSync(path.join(repo, "README.md"), "# bic\n");
git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
git(repo, "config", "user.email", "bic@loom"); git(repo, "config", "user.name", "bic");
commitAll(repo, "init", GIT_ID);

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bic-proj-${sfx}`, agentId = `bic-agent-${sfx}`, mgrId = `bic-mgr-${sfx}`;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
db.insertProject({ id: projId, name: "BIC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });

let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `bic-${n}-task-${sfx}`, workerId = `bic-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const ledger = () => db.getGoneBranchLedgerFacts(projId, "primary");

// Warm-up: the very first landing for a (project, repoKey) never writes a ledger row of its own
// (expectedMainlineBranch is captured before that same call's own watermark first-sight establishes it
// — see branch-gone-ledger-cutover-gate.mjs's own comment on this). Establish the watermark first.
const w0 = await addWorker("warmup");
const r0 = await sessions.confirmWorkerMergeTracked(mgrId, w0.workerId);
check("warm-up landing establishes the watermark", r0.settled === true && r0.ok === true);

// A real, multi-candidate batch: both candidates' own commits land individually (cherry-picked, never
// squashed — decision 6801c0a1), each carrying its OWN Loom-Worker-Branch trailer. Only the FINAL
// candidate's own commit equals the batch's recorded ledger row's `tip`; the earlier one is a genuine
// intermediate inside that row's (base, tip] range.
const wa = await addWorker("a");
const wb = await addWorker("b");
const rBatch = await sessions.mergeBatchTracked(mgrId, [wa.workerId, wb.workerId]);
check("the batch lands both candidates", rBatch.settled === true && rBatch.ok === true && rBatch.value?.landed?.length === 2);

check("exactly one ledger row exists for this (project, repoKey, branch) scope's batch landing", ledger().maxRowId() !== null);
check("wa's own worker branch is now gone", git(repo, "branch", "--list", wa.branch) === "");
check("wb's own worker branch is now gone", git(repo, "branch", "--list", wb.branch) === "");

const foundA = await findLandedSquashCommit(repo, wa.branch, "HEAD", { goneBranchLedger: ledger() });
const foundB = await findLandedSquashCommit(repo, wb.branch, "HEAD", { goneBranchLedger: ledger() });
check("THE FIX: candidate A (not the batch's final tip) still reads landed — it's inside the one row's range", foundA !== null);
check("THE FIX: candidate B (the batch's final tip) reads landed too", foundB !== null);
check("the two candidates' own landed commits are genuinely distinct (not both reading the same final tip)", foundA !== foundB);

const headAfterBatch = git(repo, "rev-parse", "HEAD");
check("candidate B's own landed commit IS the batch's final tip", foundB === headAfterBatch);
check("candidate A's own landed commit is a STRICT ancestor of the batch's final tip, never equal to it", foundA !== headAfterBatch && git(repo, "merge-base", foundA, headAfterBatch) === foundA);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
