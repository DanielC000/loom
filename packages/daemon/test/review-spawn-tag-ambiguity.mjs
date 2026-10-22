import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 56c10535 Round 2, item 8 (folding in card 46addc1a): spawnWorker's review-spawn path used to pass
// `reviewForkFrom.branch` (a bare NAME) to createWorktree's `forkFrom`, re-resolved independently by
// `git worktree add -b <new> <path> <forkFrom>` at cut time — a SECOND, separate read of the same
// logical value already captured once as `reviewForkFrom.headSha` (and stamped as `reviewBaseSha`). Under
// a same-named tag on the reviewed branch, real git REFUSES that second read outright ("fatal: ambiguous
// object name"), so the review spawn would fail even though the FIRST read (headSha, used for the stamp)
// already resolved correctly. Fixed: pass `reviewForkFrom.headSha` instead — the cut and the stamp now
// read the identical sha, with no second resolution to diverge or refuse on.
//
// REAL git on temp repos, REAL spawnWorker (via a fake pty seam — no real claude, no live daemon).
// Scaffolding mirrors review-spawn-nochanges.mjs's own (C)/(D) scenarios.
//
// Run: 1) build daemon (pnpm build), 2) node test/review-spawn-tag-ambiguity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rsta-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rsta@loom -c user.name=rsta";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const db = new Db();
const SeamHost = createSeamHost(PtyHost);
const seamEvents = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const sessionsSpawn = new SessionService(db, new SeamHost(seamEvents), new OrchestrationControl());

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rsta\n");
  execSync(`git init -q && git config user.email rsta@loom && git config user.name rsta`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const repo = path.join(os.tmpdir(), `loom-rsta-repo-${sfx}`);
const projId = `rsta-proj-${sfx}`;
const agentId = `rsta-ag-${sfx}`;
const mgrId = `rsta-mgr-${sfx}`;
const cleanupDirs = [repo];

initRepo(repo);
db.insertProject({ id: projId, name: "RSTA", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// The author branch under review — one real commit.
const authorTaskId = `rsta-author-task-${sfx}`;
db.insertTask({ id: authorTaskId, projectId: projId, title: "RSTA-AUTHOR", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
const { worktreePath: authorWt, branch: authorBranch } = await createWorktree(repo, projId, authorTaskId);
cleanupDirs.push(authorWt);
fs.writeFileSync(path.join(authorWt, "feature.txt"), "the reviewed change\n");
commitAll(authorWt, "feature", GIT_ID);
const reviewedHeadSha = execSync(`git rev-parse ${authorBranch}`, { cwd: repo }).toString().trim();

// ATTACK: a same-named tag on the author branch, pointing at an UNRELATED attacker commit — the exact
// shape that makes a bare `git worktree add -b <new> <path> <authorBranch>` call ambiguous.
const sibling = path.join(os.tmpdir(), `loom-rsta-sib-${sfx}`);
cleanupDirs.push(sibling);
execSync(`git clone -q "${repo}" "${sibling}"`);
fs.writeFileSync(path.join(sibling, "attacker-content.txt"), "planted by the tag, NOT the review target\n");
execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "attacker commit"`, { cwd: sibling });
const attackerSha = execSync(`git rev-parse HEAD`, { cwd: sibling }).toString().trim();
execSync(`git fetch -q "${sibling}" HEAD:refs/rsta-fetched/attacker`, { cwd: repo });
execSync(`git tag ${authorBranch} ${attackerSha}`, { cwd: repo });

try {
  const C = await sessionsSpawn.spawnWorker(mgrId, { agentId, kickoffPrompt: "REVIEW_TAG", reviewOfTaskId: authorTaskId });
  check("(TAG) spawnWorker succeeds despite the same-named tag (not refused/thrown)", C && typeof C.id === "string");
  if (C && C.worktreePath) cleanupDirs.push(C.worktreePath);
  const cRow = db.getSession(C.id);
  check("(TAG) reviewBaseSha stamped to the REAL reviewed tip, never the tag's attacker sha", cRow.reviewBaseSha === reviewedHeadSha);
  check("(TAG) reviewBaseSha is NOT the attacker's sha", cRow.reviewBaseSha !== attackerSha);
  const worktreeHead = execSync(`git rev-parse HEAD`, { cwd: C.worktreePath }).toString().trim();
  check("(TAG) the cut worktree's HEAD is the REAL reviewed tip (never the tag's attacker sha)", worktreeHead === reviewedHeadSha);
  check("(TAG) the cut worktree carries the REAL reviewed file", fs.existsSync(path.join(C.worktreePath, "feature.txt")));
  check("(TAG) the cut worktree does NOT carry the attacker's file", !fs.existsSync(path.join(C.worktreePath, "attacker-content.txt")));
} finally {
  execSync(`git tag -d ${authorBranch}`, { cwd: repo });
  db.close();
  for (const dir of cleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a review spawn under a same-named tag on the reviewed branch cuts from, and stamps reviewBaseSha to, the REAL reviewed tip (resolved once as headSha and reused for both the cut and the stamp), never the tag's content and never refusing on the ambiguity."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
