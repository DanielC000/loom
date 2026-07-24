// Regression guard for card 92a11aa7 — the sibling of 48fd0fab (skills-inject-worktree-exclude.mjs).
// Claude Code writes its OWN `.claude/settings.local.json` into a worktree under acceptEdits permission
// persistence (confirmed empirically: a live worker worktree carries this file). Before this fix,
// hideFromGit (skills/inject.ts) only wrote `/.claude/skills/*` entries into the shared exclude, so
// `.claude/settings.local.json` was never hidden — a worker's blind `git add -A` would stage it onto the
// user's mainline. The fix adds `/.claude/settings.local.json` (and ONLY that file, not all of `.claude/`)
// to the same shared `.git/info/exclude` that hideFromGit already resolves through a linked worktree to
// the main repo's common dir.
// Hermetic — real git worktrees under a temp dir, no claude. Run after build:
// node test/skills-inject-worktree-exclude-settings.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-worktree-settings-test-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const repoPath = path.join(root, "repo");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(repoPath, { recursive: true });

const git = (args, cwd) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
git("init -q", repoPath);
git('config user.email "test@test.com"', repoPath);
git('config user.name "test"', repoPath);
fs.writeFileSync(path.join(repoPath, "README.md"), "hi");
// A repo-tracked `.claude/settings.json` (NOT .local.json) must stay visible to git — the fix targets
// only the ONE local-settings filename, never the whole `.claude/` dir.
fs.mkdirSync(path.join(repoPath, ".claude"), { recursive: true });
fs.writeFileSync(path.join(repoPath, ".claude", "settings.json"), "{}");
git("add README.md .claude/settings.json", repoPath);
git('commit -q -m "init"', repoPath);

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

try {
  // A real linked worktree, as every worker gets.
  const worktree = path.join(root, "wt1");
  git(`worktree add ${worktree} -b task-1`, repoPath);
  check("worktree's .git is a file (sanity: this is really a linked worktree)", fs.statSync(path.join(worktree, ".git")).isFile());

  // Worker's spawn injects skills (possibly zero, if the store is empty) — this is the ONLY hideFromGit
  // call site, so it must ALSO cover settings.local.json regardless of the skills subset.
  injectSkills(worktree, "sess-worker1", null);

  // Simulate Claude Code's OWN acceptEdits permission-persistence write, AFTER injectSkills ran — mirrors
  // a real session where the harness writes settings.local.json over the course of the turn, not at spawn.
  fs.writeFileSync(path.join(worktree, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["docker"] }));

  // `-uall` forces git to recurse into an untracked dir instead of collapsing a mixed-content dir to one line.
  const status = git("status --porcelain -uall", worktree);
  check("worktree shows NO untracked .claude/settings.local.json (hidden via the shared exclude)", !/\?\? \.claude\/settings\.local\.json/.test(status));
  check("worktree's tracked .claude/settings.json is untouched by the exclude (still clean, not the excluded one)", !/\.claude\/settings\.json/.test(status.replace(/settings\.local\.json/g, "")));

  // The exclude actually lives in the MAIN repo's shared common dir (not duplicated per-worktree).
  const sharedExclude = fs.readFileSync(path.join(repoPath, ".git", "info", "exclude"), "utf8");
  check("the shared .git/info/exclude (main repo) carries the settings.local.json entry", sharedExclude.includes("/.claude/settings.local.json"));
  check("worktree has NO private .git/info/exclude of its own (proves it wrote through to the shared common dir)", !fs.existsSync(path.join(worktree, ".git", "info", "exclude")));

  // `git add -A` must not be able to stage it, even after it exists on disk.
  git("add -A", worktree);
  const staged = git("diff --cached --name-only", worktree);
  check("`git add -A` in the worktree does NOT stage settings.local.json", !staged.split(/\r?\n/).includes(".claude/settings.local.json"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — .claude/settings.local.json is excluded from git in a worker's worktree."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
