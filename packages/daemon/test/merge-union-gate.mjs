import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// POST-MERGE UNION gate test (card c0aeb5b2 — a real main-red incident). REAL git on temp repos, NO
// claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly against an isolated
// LOOM_HOME (mirrors merge-orphaned-to-main.mjs / merge-stranded-backstop.mjs's in-process style).
//
// THE HOLE IT GUARDS: the build/DoD gate used to run in the worker's worktree BEFORE the squash-merge,
// against the branch's STALE pre-merge state — nothing ever merged/rebased main into the worktree first.
// A branch cut before a main-side change it now conflicts or is incompatible with could sail through a
// green gate (run on the old code) and land a broken union. THE FIX: confirmWorkerMerge now merges
// canonical main's current tip INTO the worktree, IN the worktree, immediately before the gate — so the
// gate validates the actual post-merge union, and a hard textual conflict is caught before any squash.
//
// Proves:
//   (A) DRIFT CAUGHT — a branch cut BEFORE main tightens a requirement the branch doesn't satisfy: the
//       union-merge brings main's stricter gate script into the worktree, the gate now correctly FAILS
//       against the union, confirmWorkerMerge returns merged:false BEFORE any squash, canonical repo
//       untouched, worktree retained.
//   (B) GREEN UNION MERGES — a branch whose union with main's forward progress genuinely satisfies the
//       gate still merges cleanly, and the landed squash commit carries ONLY the branch's own file (no
//       double-apply of main's own advance, which is already on main as common ancestor).
//   (C) HARD CONFLICT — branch and main both edit the same file since divergence: the union-merge
//       conflicts, fails closed (merge --abort), worktree retained, main untouched — caught before any
//       squash is even attempted.
//   (D) ALREADY-LANDED SKIP — a branch that already squash-merged into main (its worktree still present,
//       a stale/racing confirm) still finishes via the ALREADY_MERGED idempotent path (merged:true), NOT
//       a STAGE_EMPTY_RETRY rejection — proving the preLanded union-merge-skip (the bug caught mid-fix:
//       union-merging main's OWN landed squash back into the worktree makes the branch descend from its
//       own trailer commit, indistinguishable from a re-cut branch to findLandedSquashCommit's guard).
// Run: 1) build daemon (pnpm build), 2) node test/merge-union-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mug-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mug@loom -c user.name=mug";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; a no-pty
// worker row (processState 'exited') is !isAlive anyway, so a stub keeps the test hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const mergeRejectedReasons = (mgrId) =>
  db.listEvents(mgrId).filter((e) => e.kind === "merge_rejected").map((e) => e.detail?.reason);

function seed(p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MUG", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MUG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// check.mjs starts lenient (always exits 0) — the state the worktree carries at branch-cut time.
const LENIENT_CHECK = "process.exit(0);\n";
// The strict version main later adopts: requires new-requirement.txt to exist.
const STRICT_CHECK = "const fs=require('fs'); process.exit(fs.existsSync('new-requirement.txt') ? 0 : 1);\n";

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mug\n");
  fs.writeFileSync(path.join(p.repo, "check.mjs"), LENIENT_CHECK);
  execSync(`git init -q && git config user.email mug@loom && git config user.name mug && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mug-${label}-proj-${sfx}`, agentId: `mug-${label}-agent-${sfx}`, taskId: `mug-${label}-task-${sfx}`,
  mgrId: `mug-${label}-mgr-${sfx}`, workerId: `mug-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mug-${label}-${sfx}`), file,
});
const A = mk("a", "feature-a.txt"); // (A) drift caught: main tightens the gate script after branch cut
const B = mk("b", "feature-b.txt"); // (B) genuinely-green union: merges cleanly, lands only the branch's diff
const C = mk("c", "feature-c.txt"); // (C) hard conflict: branch + main both edit README.md
const D = mk("d", "feature-d.txt"); // (D) already-landed: preLanded must skip the union-merge

try {
  // ── (A) DRIFT CAUGHT: branch cut on the lenient gate; main tightens it afterward ─────────────────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    // Worker commits a benign, unrelated change on its branch — never touches check.mjs.
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    // Main advances AFTER the branch was cut: check.mjs is tightened to require new-requirement.txt,
    // which NEITHER main NOR the branch actually provides — the union genuinely fails the new gate.
    fs.writeFileSync(path.join(A.repo, "check.mjs"), STRICT_CHECK);
    execSync(`git add . && git ${GIT_ID} commit -q -m "tighten check.mjs"`, { cwd: A.repo });
    seed(A, "node check.mjs");

    const headBefore = git(A.repo, "rev-parse HEAD");
    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) DRIFT CAUGHT → merged:false (gate fails against the actual post-merge union)", confirmA.merged === false);
    check("(A) reason names the build gate", /gate|build/i.test(confirmA.reason ?? ""));
    check("(A) a merge_rejected event recorded", mergeRejectedReasons(A.mgrId).length > 0);
    check("(A) canonical main UNCHANGED (no bad merge landed)", git(A.repo, "rev-parse HEAD") === headBefore);
    check("(A) worktree RETAINED (manager can re-task)", fs.existsSync(A.worktreePath));
    check("(A) task NOT moved to done", db.getTask(A.taskId).columnKey !== "done");
    // Prove the union-merge is WHY the gate failed: the worktree's own check.mjs is now main's STRICT
    // version (the union actually landed in the worktree, even though the outer merge was rejected).
    // Line-ending normalized: Windows git may rewrite LF→CRLF on checkout (core.autocrlf), which is
    // irrelevant to what's being proven here.
    const norm = (s) => s.replace(/\r\n/g, "\n");
    check("(A) worktree's check.mjs was updated to main's strict version by the union-merge",
      norm(fs.readFileSync(path.join(A.worktreePath, "check.mjs"), "utf8")) === norm(STRICT_CHECK));
  }

  // ── (B) GREEN UNION: main also advances (a harmless file), branch's own change still satisfies the gate ─
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    // Main advances with an unrelated, harmless file — the union should merge clean and stay green.
    fs.writeFileSync(path.join(B.repo, "main-advance.txt"), "main moved forward\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main advance"`, { cwd: B.repo });
    seed(B, "node check.mjs"); // still the lenient check — always passes

    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) GREEN UNION → merged:true", confirmB.merged === true);
    check("(B) main's forward progress (main-advance.txt) is present", fs.existsSync(path.join(B.repo, "main-advance.txt")));
    check("(B) the branch's own file landed", fs.existsSync(path.join(B.repo, B.file)));
    check("(B) the squash landed exactly ONE new commit on main (no double-apply of main's own advance)",
      git(B.repo, "log --oneline -1").length > 0 && git(B.repo, `show --stat -1 HEAD`).includes(B.file) && !git(B.repo, `show --stat -1 HEAD`).includes("main-advance.txt"));
    check("(B) worktree removed (clean merge cleanup)", !fs.existsSync(B.worktreePath));
    check("(B) task moved to done", db.getTask(B.taskId).columnKey === "done");
  }

  // ── (C) HARD CONFLICT: branch and main both edit README.md since divergence ────────────────────────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch;
    fs.writeFileSync(path.join(worktreePath, "README.md"), "branch version\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "branch README"`, { cwd: worktreePath });
    fs.writeFileSync(path.join(C.repo, "README.md"), "main version\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main README"`, { cwd: C.repo });
    seed(C, "node check.mjs");

    const headBefore = git(C.repo, "rev-parse HEAD");
    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) HARD CONFLICT → merged:false, reason names the conflict", confirmC.merged === false && /conflict/i.test(confirmC.reason ?? ""));
    check("(C) canonical main UNTOUCHED", git(C.repo, "rev-parse HEAD") === headBefore);
    check("(C) canonical README still 'main version' (branch change did NOT land)", fs.readFileSync(path.join(C.repo, "README.md"), "utf8").includes("main version"));
    check("(C) worktree RETAINED", fs.existsSync(C.worktreePath));
    // A linked worktree's `.git` is a FILE (a gitdir pointer), not a directory — `.git/MERGE_HEAD` never
    // exists as a path on disk there, so a plain fs.existsSync probe is tautological. Ask git itself.
    let mergeHeadPresent = true;
    try { execSync(`git ${GIT_ID} rev-parse -q --verify MERGE_HEAD`, { cwd: C.worktreePath }); } catch { mergeHeadPresent = false; }
    check("(C) worktree is clean, not mid-merge (no leftover MERGE_HEAD)", !mergeHeadPresent);
    check("(C) worktree's own git status is clean (merge --abort actually ran)", git(C.worktreePath, "status --porcelain") === "");
    check("(C) a merge_rejected event recorded", mergeRejectedReasons(C.mgrId).length > 0);
    check("(C) task NOT moved to done", db.getTask(C.taskId).columnKey !== "done");
  }

  // ── (D) ALREADY-LANDED: the branch already squash-merged into main; worktree still present ──────────
  makeRepo(D);
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch;
    fs.writeFileSync(path.join(worktreePath, D.file), "already landed work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${D.file}"`, { cwd: worktreePath });
    // Land the branch into main out-of-band, carrying its deterministic Loom-Worker-Branch trailer,
    // WITHOUT deleting the branch or removing the worktree — the exact idempotent-re-confirm shape
    // merge-reject-notify-suppress.mjs scenario B and merge-orphaned-to-main.mjs (B) also exercise.
    const landed = await mergeBranch(D.repo, branch, "MUG already-landed");
    check("(D) precondition: branch landed in main with its trailer", landed.ok === true && typeof landed.sha === "string");
    seed(D, "node check.mjs"); // a configured gate — proves the preLanded skip, not just a no-gate path

    const headBefore = git(D.repo, "rev-parse HEAD");
    const confirmD = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) ALREADY-LANDED → merged:true via the idempotent ALREADY_MERGED path", confirmD.merged === true);
    check("(D) emptyKind === 'ALREADY_MERGED' (NOT a STAGE_EMPTY_RETRY rejection)", confirmD.emptyKind === "ALREADY_MERGED");
    check("(D) NO new commit on main (nothing re-committed by a spurious union-merge + squash)",
      git(D.repo, `rev-list --count ${headBefore}..HEAD`) === "0");
    check("(D) worktree removed (idempotent cleanup completed, not left retained by a false rejection)", !fs.existsSync(D.worktreePath));
    check("(D) task moved to done", db.getTask(D.taskId).columnKey === "done");
    check("(D) NO merge_rejected event recorded for this confirm (the preLanded skip avoided a false union_merge_failed/union_conflict)",
      mergeRejectedReasons(D.mgrId).length === 0);
  }
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge_confirm now validates the ACTUAL post-merge union: a branch cut before main tightened a requirement is caught before any squash lands; a genuinely-green union still merges cleanly with no double-apply of main's own advance; a hard branch+main conflict fails closed before any squash is attempted; and a branch that already landed on main skips the union-merge entirely, preserving the idempotent ALREADY_MERGED re-confirm path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
