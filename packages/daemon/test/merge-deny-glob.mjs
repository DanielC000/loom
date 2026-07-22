import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// DENY-GLOB merge-review backstop test (card d5d3bdc9). REAL git on temp repos, NO claude and NO live
// daemon — drives SessionService.reviewWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-stale-base-backstop.mjs's in-process style).
//
// THE GAP IT GUARDS: the mockups-first flow (mockup phase → owner pick → build phase on the SAME reused
// branch) has no rule about where mockup deliverables live, so workers have repeatedly committed
// mockups/…/ (HTML + PNGs + README) into the PUBLIC code repo — caught only as a merge-gate diffstat
// surprise, forcing a strip commit + a second full gate run. This is the structural backstop: a WARNING
// (never a block) at worker_merge review time when the branch diff ADDS a file under a project-configured
// deny-glob (default `mockups/**`).
//
// Proves:
//   (A) ADDED — worker's branch adds a new file under mockups/ (default denyGlobs, no explicit config on
//       the project row): reviewWorkerMerge surfaces a "DENY-GLOB" warning clause naming the file, and the
//       merge_request event carries deniedAdds:1. The diff fields are still the real ones.
//   (B) ADDED, NON-MATCHING — worker's branch adds a file that does NOT match any deny-glob: no warning at
//       all — the unchanged path.
//   (C) MODIFIED, NOT ADDED — a deny-glob file already exists on main (committed before the worktree was
//       cut); the worker only MODIFIES it. diffBranch's status for that file is "M", not "A", so it does
//       NOT match — proving the added-only filter (not "touched") is what's actually enforced.
//   (D) RENAME ROBUSTNESS — worker RENAMES an existing file to a path under a deny-glob (a two-path
//       `git diff --name-status` row, e.g. `R100\told\tnew`). reviewWorkerMerge must NEVER throw on this
//       (the whole point of a review-time check being best-effort); diffNameStatus deliberately skips
//       rename/copy rows rather than guess which path they apply to, so this currently does NOT match
//       (a documented scope limit, not a bug) — the test proves the non-throw + non-match together.
//   (E) PREFIX BOUNDARY — worker adds `my-mockups/z.png`: the string "mockups" appears in the path, but
//       it is NOT under the `mockups/` directory. pathGlobToRegExp anchors the translated glob with `^`,
//       so `mockups/**` -> `^mockups/.*$` must NOT match a `my-mockups/` prefix. This is the exact
//       semantic the card cares about (mockups/x/y.png yes, my-mockups no) — pinned as a regression test
//       against any future pathGlobToRegExp change, since the positive (A) and modified (C) cases alone
//       don't exercise this negative boundary.
// Run: 1) build daemon (pnpm build), 2) node test/merge-deny-glob.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdg-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mdg@loom -c user.name=mdg";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p) {
  db.insertProject({ id: p.projId, name: "MDG", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null, ...(p.denyGlobs !== undefined ? { denyGlobs: p.denyGlobs } : {}) });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MDG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo, seedFiles = {}) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mdg\n");
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  execSync(`git init -q && git config user.email mdg@loom && git config user.name mdg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = { projId: `mdg-a-proj-${sfx}`, agentId: `mdg-a-top-${sfx}`, taskId: `mdg-a-task-${sfx}`, mgrId: `mdg-a-mgr-${sfx}`, workerId: `mdg-a-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdg-added-${sfx}`) };
const B = { projId: `mdg-b-proj-${sfx}`, agentId: `mdg-b-top-${sfx}`, taskId: `mdg-b-task-${sfx}`, mgrId: `mdg-b-mgr-${sfx}`, workerId: `mdg-b-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdg-nonmatch-${sfx}`) };
const C = { projId: `mdg-c-proj-${sfx}`, agentId: `mdg-c-top-${sfx}`, taskId: `mdg-c-task-${sfx}`, mgrId: `mdg-c-mgr-${sfx}`, workerId: `mdg-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdg-modonly-${sfx}`) };
const D = { projId: `mdg-d-proj-${sfx}`, agentId: `mdg-d-top-${sfx}`, taskId: `mdg-d-task-${sfx}`, mgrId: `mdg-d-mgr-${sfx}`, workerId: `mdg-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdg-rename-${sfx}`) };
const E = { projId: `mdg-e-proj-${sfx}`, agentId: `mdg-e-top-${sfx}`, taskId: `mdg-e-task-${sfx}`, mgrId: `mdg-e-mgr-${sfx}`, workerId: `mdg-e-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdg-prefix-${sfx}`) };

try {
  // ── (A) ADDED: default denyGlobs (no explicit config on the project row), worker adds mockups/new.html ──
  initRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    fs.mkdirSync(path.join(worktreePath, "mockups", "schedules-history"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "mockups", "schedules-history", "direction-1.html"), "<html></html>\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "add mockup"`, { cwd: worktreePath });
    seed(A);

    const review = await sessions.reviewWorkerMerge(A.mgrId, A.workerId);
    check("(A) reviewWorkerMerge surfaces a DENY-GLOB warning", typeof review.warning === "string" && /DENY-GLOB/.test(review.warning));
    check("(A) warning names the added file", review.warning.includes("mockups/schedules-history/direction-1.html"));
    check("(A) diff fields still reflect the real branch diff (not clobbered by the deny-glob check)",
      review.filesChanged === 1 && review.files.some((f) => f.file === "mockups/schedules-history/direction-1.html"));
    check("(A) merge_request event carries deniedAdds:1",
      db.listEvents(A.mgrId).some((e) => e.kind === "merge_request" && e.detail?.deniedAdds === 1));
  }

  // ── (B) ADDED, NON-MATCHING: worker adds a file outside any deny-glob — the unchanged path ────────────
  initRepo(B.repo);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "feature.ts"), "export const x = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "add feature"`, { cwd: worktreePath });
    seed(B);

    const review = await sessions.reviewWorkerMerge(B.mgrId, B.workerId);
    check("(B) reviewWorkerMerge -> NO warning at all", review.warning === undefined);
    check("(B) diff fields reflect the real branch diff", review.filesChanged === 1 && review.files.some((f) => f.file === "src/feature.ts"));
    const mergeRequestB = db.listEvents(B.mgrId).find((e) => e.kind === "merge_request");
    check("(B) a merge_request event was recorded", mergeRequestB !== undefined);
    check("(B) merge_request event carries NO deniedAdds", mergeRequestB?.detail?.deniedAdds === undefined);
  }

  // ── (C) MODIFIED, NOT ADDED: a deny-glob file already on main, worker only edits it — must NOT warn ───
  initRepo(C.repo, { "mockups/existing/direction-1.html": "<html>v1</html>\n" });
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch;
    fs.writeFileSync(path.join(worktreePath, "mockups", "existing", "direction-1.html"), "<html>v2</html>\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "tweak existing mockup"`, { cwd: worktreePath });
    seed(C);

    const review = await sessions.reviewWorkerMerge(C.mgrId, C.workerId);
    check("(C) reviewWorkerMerge -> NO warning (modified, not added)", review.warning === undefined);
    check("(C) diff fields reflect the real branch diff", review.filesChanged === 1 && review.files.some((f) => f.file === "mockups/existing/direction-1.html"));
    const mergeRequestC = db.listEvents(C.mgrId).find((e) => e.kind === "merge_request");
    check("(C) merge_request event carries NO deniedAdds", mergeRequestC?.detail?.deniedAdds === undefined);
  }
  // ── (D) RENAME ROBUSTNESS: worker renames an existing file INTO a deny-glob path — must not throw ─────
  initRepo(D.repo, { "docs/plan.md": "# plan\n" });
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch;
    fs.mkdirSync(path.join(worktreePath, "mockups"), { recursive: true });
    execSync(`git mv docs/plan.md mockups/plan.md`, { cwd: worktreePath });
    execSync(`git ${GIT_ID} commit -q -m "rename plan into mockups"`, { cwd: worktreePath });
    seed(D);

    let reviewError = null;
    let review;
    try {
      review = await sessions.reviewWorkerMerge(D.mgrId, D.workerId);
    } catch (err) {
      reviewError = err;
    }
    check("(D) reviewWorkerMerge does not throw on a rename row", reviewError === null);
    if (reviewError) console.log(`    threw: ${reviewError?.stack || reviewError}`);
    check("(D) diff still reports the rename as a changed file", review?.filesChanged === 1);
    // Documented scope limit: a rename INTO a deny-glob path is not currently treated as an "add" (the
    // name-status parser deliberately skips two-path R/C rows rather than guess) — no warning fires.
    check("(D) a rename into mockups/ does not (yet) trigger the deny-glob warning", review?.warning === undefined);
  }
  // ── (E) PREFIX BOUNDARY: worker adds my-mockups/z.png — contains "mockups" but isn't under mockups/ ───
  initRepo(E.repo);
  {
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch;
    fs.mkdirSync(path.join(worktreePath, "my-mockups"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "my-mockups", "z.png"), "not-a-real-png\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "add my-mockups file"`, { cwd: worktreePath });
    seed(E);

    const review = await sessions.reviewWorkerMerge(E.mgrId, E.workerId);
    check("(E) reviewWorkerMerge -> NO warning (my-mockups/ is not under mockups/)", review.warning === undefined);
    check("(E) diff fields reflect the real branch diff", review.filesChanged === 1 && review.files.some((f) => f.file === "my-mockups/z.png"));
    const mergeRequestE = db.listEvents(E.mgrId).find((e) => e.kind === "merge_request");
    check("(E) merge_request event carries NO deniedAdds", mergeRequestE?.detail?.deniedAdds === undefined);
  }
} finally {
  db.close();
  for (const p of [A, B, C, D, E]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's review step now flags a branch that ADDS files under a project's deny-glob (default mockups/**) with a WARNING (never a block), stays silent on a non-matching addition, and correctly ignores a MODIFIED (not newly added) deny-glob file."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
