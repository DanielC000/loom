// Hermetic unit test for skills/inject.ts — mirrors Loom's managed skills (~/.loom/skills) into a
// session's <cwd>/.claude/skills as project-local skills, without clobbering the repo's own skills.
// Sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at module load). No claude.
// Run after build: node test/skills-inject.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-inject-test-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const cwd = path.join(root, "repo");
fs.mkdirSync(path.join(skillsDir, "loom-a"), { recursive: true });
fs.mkdirSync(path.join(skillsDir, "loom-b"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA");
fs.writeFileSync(path.join(skillsDir, "loom-b", "SKILL.md"), "---\nname: loom-b\ndescription: B\n---\nB");
// The repo has its OWN project-local skill that must NEVER be clobbered.
fs.mkdirSync(path.join(cwd, ".claude", "skills", "repo-own"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".claude", "skills", "repo-own", "SKILL.md"), "---\nname: repo-own\ndescription: theirs\n---\nKEEP");
execSync("git init -q", { cwd });

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

const SID = "sess-inject"; // single-session run: the manifest is keyed per session (map form)
try {
  injectSkills(cwd, SID, null); // null subset ⇒ deliver ALL store skills (today's default)
  const tdir = path.join(cwd, ".claude", "skills");
  const has = (n) => fs.existsSync(path.join(tdir, n, "SKILL.md"));
  const manifest = () => JSON.parse(fs.readFileSync(path.join(tdir, ".loom-skills.json"), "utf8"));
  check("loom-a injected (readable SKILL.md)", has("loom-a") && fs.readFileSync(path.join(tdir, "loom-a", "SKILL.md"), "utf8").includes("name: loom-a"));
  check("loom-b injected", has("loom-b"));
  check("repo's own skill left untouched", fs.readFileSync(path.join(tdir, "repo-own", "SKILL.md"), "utf8").includes("KEEP"));
  check("manifest records only Loom-placed names under the session key", JSON.stringify(manifest()[SID].sort()) === JSON.stringify(["loom-a", "loom-b"]));
  const excl = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
  check(".git/info/exclude hides loom-a and loom-b (not repo-own)", excl.includes("/.claude/skills/loom-a") && excl.includes("/.claude/skills/loom-b") && !excl.includes("repo-own"));

  // Idempotent: a second run doesn't duplicate exclude lines.
  injectSkills(cwd, SID, null);
  const excl2 = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8");
  check("idempotent — exclude not duplicated on re-run", (excl2.match(/\/\.claude\/skills\/loom-a/g) || []).length === 1);

  // Stale removal: delete loom-b from the store, re-inject → loom-b removed, repo-own + loom-a kept.
  fs.rmSync(path.join(skillsDir, "loom-b"), { recursive: true, force: true });
  injectSkills(cwd, SID, null);
  check("stale Loom skill removed when deleted from the store", !fs.existsSync(path.join(tdir, "loom-b")));
  check("loom-a still present after stale sweep", has("loom-a"));
  check("repo-own STILL untouched after stale sweep", fs.existsSync(path.join(tdir, "repo-own", "SKILL.md")));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — injectSkills delivers Loom skills project-local without clobbering the repo's own." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
