// Regression guard for card 48fd0fab: a skill added to the store mid-session (manager stays continuously
// alive, never resumes) must still get hidden from git for a WORKER spawned afterwards. Before the fix,
// hideFromGit (skills/inject.ts) no-opped whenever `.git` was a file (a linked worktree — every worker's
// cwd), so a worker's injected skill was never excluded and a `git add -A && commit` landed it on the
// user's mainline verbatim. The fix resolves a worktree's `.git` pointer through to the shared common dir
// (same as `git rev-parse --git-common-dir`) so info/exclude — which git itself keeps SHARED across
// worktrees, not per-worktree — gets the entry no matter which worktree wrote it.
// Hermetic — real git worktrees under a temp dir, no claude. Run after build:
// node test/skills-inject-worktree-exclude.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-worktree-test-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const repoPath = path.join(root, "repo");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(repoPath, { recursive: true });

const mkSkill = (n) => {
  fs.mkdirSync(path.join(skillsDir, n), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`);
};
mkSkill("loom-a"); // present from the start, like a skill the manager already synced on its own spawn

const git = (args, cwd) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
git("init -q", repoPath);
git('config user.email "test@test.com"', repoPath);
git('config user.name "test"', repoPath);
fs.writeFileSync(path.join(repoPath, "README.md"), "hi");
git("add README.md", repoPath);
git('commit -q -m "init"', repoPath);

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

try {
  // Manager's own (repoPath-cwd) spawn syncs the exclude for the skill(s) that exist at that moment.
  injectSkills(repoPath, "sess-manager", null);

  // (a) spawn a worker: a real linked worktree, worker injects the CURRENT store (just loom-a so far).
  const worktree1 = path.join(root, "wt1");
  git(`worktree add ${worktree1} -b task-1`, repoPath);
  injectSkills(worktree1, "sess-worker1", null);
  check("worktree1's .git is a file (sanity: this is really a linked worktree)", fs.statSync(path.join(worktree1, ".git")).isFile());
  // `-uall` forces git to recurse into an untracked dir instead of collapsing it to one `?? .claude/` line —
  // without it, an untracked dir with a MIX of ignored + non-ignored entries still collapses to `?? .claude/`
  // (only a dir with ZERO non-ignored entries is omitted entirely), which would mask a real per-skill leak.
  const status1 = git("status --porcelain -uall", worktree1);
  check("worker1's worktree shows no untracked .claude/skills (pre-existing skill already excluded)", !/\?\? \.claude\/skills\//.test(status1));

  // (b) a skill is added to the store WITHOUT the manager restarting/resuming (no injectSkills(repoPath, …) call here).
  mkSkill("loom-c");

  // (c) spawn a second worker — its injectSkills call must hide loom-c too, purely from the worktree.
  const worktree2 = path.join(root, "wt2");
  git(`worktree add ${worktree2} -b task-2`, repoPath);
  injectSkills(worktree2, "sess-worker2", null);
  check("worktree2 got the new skill delivered", fs.existsSync(path.join(worktree2, ".claude", "skills", "loom-c", "SKILL.md")));

  // (d) the DoD assertion: git status --porcelain in the new worktree shows NO untracked .claude/skills entries.
  const status2 = git("status --porcelain -uall", worktree2);
  check("worker2's worktree shows NO untracked .claude/skills/… (the mid-session-added skill is excluded)", !/\?\? \.claude\/skills\//.test(status2));

  // The exclude actually lives in the MAIN repo's shared common dir (not duplicated per-worktree).
  const sharedExclude = fs.readFileSync(path.join(repoPath, ".git", "info", "exclude"), "utf8");
  check("the shared .git/info/exclude (main repo) carries the loom-c entry", sharedExclude.includes("/.claude/skills/loom-c"));
  check("worktree1 has NO private .git/info/exclude of its own (proves it wrote through to the shared common dir)", !fs.existsSync(path.join(worktree1, ".git", "info", "exclude")));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a skill added mid-session is excluded from git in a worker's worktree spawned afterwards."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
