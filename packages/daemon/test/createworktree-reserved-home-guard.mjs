import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 37e15c26 — `createWorktree` itself (git/worktrees.ts) now refuses a worktree cut whose RAW
// `repoPath`, OR whose git-resolved TOPLEVEL, is LOOM_HOME or an ancestor of it (isLoomHomeOrAncestor,
// vault/versioner.ts), checked before any mutating git call — mirrors GitWriter's own
// `refuseIfOperationalHome` (see git-writer-operational-home-guard.mjs) exactly, for the SEPARATE git
// chokepoint GitWriter never covered: `createWorktree`/`mergeBranch` (git/worktrees.ts) never go through
// GitWriter at all, so a manager/worker bound to a reserved home (Platform/Setup, whose
// repoPath === vaultPath === LOOM_HOME) could `git worktree add` against LOOM_HOME/.git directly.
// See docs/decisions/37e15c26-refuse-reserved-home-worktree-and-manager-session-start.md.
//
// HERMETIC + NETWORK-FREE. Own temp LOOM_HOME (useOwnLoomHome + requireHermeticEnv). Covers:
//   (a) a NON-GIT DESCENDANT of LOOM_HOME (LOOM_HOME has a real .git; the descendant has none of its own)
//       — the critical bypass — refused via the git-resolved-toplevel check, no worktree/branch created;
//   (b) LOOM_HOME itself (raw-path equality) — refused before any mutating git call;
//   (c) an ANCESTOR of LOOM_HOME (raw-path match, the "user's home dir as repoPath" shape) — refused too;
//   (d) PASS CASE (manager directive): a project created under the workspace root INSIDE LOOM_HOME with
//       its OWN `git init` (the real `project_init` shape) resolves its OWN toplevel — NOT an ancestor-or-
//       equal match — and is NOT refused; createWorktree succeeds and actually cuts a real worktree/branch.
//   (e) a toplevel-probe FAILURE (non-"not a git repository") on a non-git descendant of LOOM_HOME is
//       FAIL-CLOSED (refused), never treated like the clean fall-through.
//
// Run: 1) build, 2) node test/createworktree-reserved-home-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Card 8378984b: {fresh:true} — initRepo(loomHome) below unconditionally `git checkout -b main`s the
// home itself; under a reused LOOM_HOME that already carries a `main` branch from an earlier run of this
// same file, that throws outright instead of running this file's actual assertions.
const loomHome = fs.realpathSync(useOwnLoomHome("loom-createworktree-ophome-", { fresh: true }));

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { createWorktree, taskKey } = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout", "-b", "main");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed");
}

// Give LOOM_HOME itself a real .git — the exact shape a real host can carry, and the only shape under
// which git's own upward discovery from a descendant actually finds something to walk up TO.
initRepo(loomHome);
const loomHomeHeadBefore = git(loomHome, "rev-parse", "HEAD").trim();
const loomHomeBranchesBefore = git(loomHome, "branch", "--list").trim();

let caseIdx = 0;
const freshIds = () => { caseIdx++; return { projectId: `proj-${caseIdx}`, taskId: `task-${caseIdx}` }; };

try {
  // ===== (a) a non-git DESCENDANT of LOOM_HOME — the critical bypass =====
  {
    const descendant = path.join(loomHome, "workspaces", "some-vault-only-home");
    fs.mkdirSync(descendant, { recursive: true });
    const { projectId, taskId } = freshIds();
    let threw = null;
    try { await createWorktree(descendant, projectId, taskId); } catch (e) { threw = e; }
    check("(a) createWorktree against a non-git DESCENDANT of LOOM_HOME is refused (RED on old code: git would walk up and worktree-add into LOOM_HOME/.git)",
      threw instanceof Error);
    check("(a) …error names the operational home dir", /operational home directory/i.test(threw?.message ?? ""));
    check("(a) LOOM_HOME's own repo HEAD is UNCHANGED", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
    check("(a) LOOM_HOME's own repo gained NO new branch", git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
    check("(a) no worktree dir was created for this task", !fs.existsSync(path.join(WORKTREES_DIR, projectId, taskId)));
  }

  // ===== (b) LOOM_HOME itself (raw-path equality) =====
  {
    const { projectId, taskId } = freshIds();
    let threw = null;
    try { await createWorktree(loomHome, projectId, taskId); } catch (e) { threw = e; }
    check("(b) createWorktree against LOOM_HOME itself is refused", threw instanceof Error && /operational home directory/i.test(threw.message));
    check("(b) …LOOM_HOME's own repo gained NO new branch", git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
    check("(b) …HEAD still unchanged", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  }

  // ===== (c) an ANCESTOR of LOOM_HOME (raw-path match) =====
  {
    const ancestor = path.dirname(loomHome);
    const { projectId, taskId } = freshIds();
    let threw = null;
    try { await createWorktree(ancestor, projectId, taskId); } catch (e) { threw = e; }
    check("(c) createWorktree against an ANCESTOR of LOOM_HOME is refused", threw instanceof Error && /operational home directory/i.test(threw.message));
  }

  // ===== (d) PASS CASE: a project_init-shaped project nested under LOOM_HOME, its OWN git init =====
  {
    const nestedProject = path.join(loomHome, "workspaces", "my-project");
    initRepo(nestedProject);
    const { projectId, taskId } = freshIds();
    const info = await createWorktree(nestedProject, projectId, taskId);
    check("(d) PASS CASE: a project nested under LOOM_HOME with its OWN git init (project_init shape) is NOT refused",
      typeof info?.worktreePath === "string" && fs.existsSync(info.worktreePath));
    check("(d) …the cut worktree carries the expected branch", info?.branch === `loom/${taskKey(taskId)}`);
    check("(d) …LOOM_HOME's own repo is UNTOUCHED by this (different repo entirely)",
      git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore && git(loomHome, "branch", "--list").trim() === loomHomeBranchesBefore);
  }

  // ===== (e) a toplevel-probe FAILURE (non-"not a git repository") on a non-git descendant of LOOM_HOME
  // must FAIL CLOSED — refused, never treated like the clean "not a git repository" fall-through. Injects
  // a gitDeps.gitFactory (createWorktree's own test seam) whose revparse-via-raw REJECTS with an
  // unrelated error for the toplevel probe specifically, while HEAD rev-parse (if ever reached) would
  // prove the refusal fired too early to matter.
  {
    const descendant2 = path.join(loomHome, "workspaces", "another-vault-only-home");
    fs.mkdirSync(descendant2, { recursive: true });
    const { projectId, taskId } = freshIds();
    const flakyGitFactory = () => ({
      raw: async (args) => {
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) throw new Error("fatal: unexpected host I/O error (simulated)");
        throw new Error(`should never be reached: raw(${JSON.stringify(args)}) (refusal must fire before any other real git call)`);
      },
    });
    let threw = null;
    try { await createWorktree(descendant2, projectId, taskId, {}, null, undefined, { gitFactory: flakyGitFactory }); } catch (e) { threw = e; }
    check("(e) createWorktree is REFUSED when the toplevel probe fails with a non-'not a git repository' error (fail-closed, never falls through)",
      threw instanceof Error);
    check("(e) …error says it could not verify the repo's location (never the clean 'not a git repository' fall-through message)",
      /could not verify this repo.s location/i.test(threw?.message ?? ""));
    check("(e) LOOM_HOME's own repo is STILL untouched", git(loomHome, "rev-parse", "HEAD").trim() === loomHomeHeadBefore);
  }
} finally {
  try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree refuses a worktree cut whose RAW repoPath, or whose git-resolved TOPLEVEL, is LOOM_HOME or an ancestor of it (incl. a non-git descendant — the critical bypass — and a fail-closed toplevel-probe error), while a project_init-shaped project nested under LOOM_HOME with its own git init is NOT refused."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
