// Card 25389c3c — before this fix, skills/inject.ts's local `resolveGitCommonDir` returned `null`
// whenever `.git` was a gitfile pointing at a private dir with NO `commondir` file (a submodule, or a
// `--separate-git-dir` repo used as a project's bound repoPath) — unlike git/worktrees.ts's `resolveGitDirs`
// (decision 472f14d1), which correctly falls back to `commonDir = privateDir` for that exact shape.
// Consequence: `hideFromGit` silently no-opped for such a repo — a manager/platform/setup/auditor session
// (repoPath-cwd) bound to a submodule-shaped repo never got `.claude/skills/*` (or the manifest, or
// `.claude/settings.local.json`) added to `info/exclude`, so they showed as untracked and were reachable
// by a blind `git add -A`. The fix: skills/inject.ts now calls git/repo-lock.ts's `resolveGitDirsSync`,
// which has the correct fallback.
//
// RED-FIRST: run this file against the PRE-FIX dist (revert the skills/inject.ts change, rebuild, run) —
// `hideFromGit` no-ops entirely: no `info/exclude` file is ever created in the gitDir, so the skill shows
// as untracked. Then restore + rebuild: the exclude entry lands and the skill shows as excluded.
//
// Hermetic — a hand-built submodule-shaped `.git` fixture (same shape as (D) in
// merged-map-gitfile-canonical-repo.mjs / gitdirs-sync-async-parity.mjs), no real git binary needed for
// the fixture itself (a real `git` is used only to exercise `git status`, proving the exclude actually
// works from git's own point of view, not just that a file got written).
// Run after build: node test/skills-inject-submodule-exclude.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = mkdtempManaged("loom-inject-submodule-test-");
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });

const mkSkill = (n) => {
  fs.mkdirSync(path.join(skillsDir, n), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`);
};
mkSkill("loom-a");

// Build a submodule-shaped repo: a real git repo (so `git status` works), but with its OWN `.git`
// directory relocated to an EXTERNAL dir and replaced by a `gitdir:` pointer file carrying NO `commondir`
// — exactly what a real `git submodule` (or `git init --separate-git-dir`) checkout looks like.
const repoPath = path.join(root, "repo");
const externalGitDir = path.join(root, "external-gitdir"); // stands in for `.git/modules/<name>`
fs.mkdirSync(repoPath, { recursive: true });

const git = (args, cwd) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
git("init -q", repoPath);
git('config user.email "test@test.com"', repoPath);
git('config user.name "test"', repoPath);
fs.writeFileSync(path.join(repoPath, "README.md"), "hi");
git("add README.md", repoPath);
git('commit -q -m "init"', repoPath);

// Relocate the real `.git` dir to `externalGitDir` and replace it with a submodule-shaped pointer file —
// no `commondir` file anywhere, matching fixture (D) in gitdirs-sync-async-parity.mjs.
fs.renameSync(path.join(repoPath, ".git"), externalGitDir);
fs.writeFileSync(path.join(repoPath, ".git"), `gitdir: ${externalGitDir}\n`);
// `git init`'s own template already writes a DEFAULT (empty-of-entries) info/exclude — remove it so the
// "was created" check below actually discriminates (fs.existsSync on git's own pre-existing file would
// trivially pass even if hideFromGit no-ops, which is exactly the shape of the bug this test guards).
fs.rmSync(path.join(externalGitDir, "info", "exclude"), { force: true });
check("fixture sanity: repoPath's .git is a FILE (submodule-shaped)", fs.statSync(path.join(repoPath, ".git")).isFile());
check("fixture sanity: no commondir file exists (the shape under test)", !fs.existsSync(path.join(externalGitDir, "commondir")));
check("fixture sanity: no pre-existing info/exclude (git's own template default removed)", !fs.existsSync(path.join(externalGitDir, "info", "exclude")));
check("fixture sanity: git status still works through the pointer", /nothing to commit/.test(git("status", repoPath)));

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

injectSkills(repoPath, "sess-manager", null);

check("the skill was still delivered into .claude/skills", fs.existsSync(path.join(repoPath, ".claude", "skills", "loom-a", "SKILL.md")));
check("info/exclude was created in the submodule's own gitdir (privateDir == commonDir fallback)", fs.existsSync(path.join(externalGitDir, "info", "exclude")));
const excludeContent = fs.existsSync(path.join(externalGitDir, "info", "exclude")) ? fs.readFileSync(path.join(externalGitDir, "info", "exclude"), "utf8") : "";
check("info/exclude carries the loom-a entry", excludeContent.includes("/.claude/skills/loom-a"));
const status = git("status --porcelain -uall", repoPath);
check("git status shows NO untracked .claude/skills/… (the submodule-shaped repo is excluded)", !/\?\? \.claude\/skills\//.test(status));

console.log(failures === 0
  ? "\n✅ ALL PASS — a submodule-shaped canonical repo gets its injected skills excluded from git."
  : `\n❌ ${failures} FAILURE(S).`);
process.exitCode = failures === 0 ? 0 : 1;
