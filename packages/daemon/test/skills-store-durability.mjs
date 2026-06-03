// Regression guard for the silent-no-op-skills bug: Loom's per-session injected skills used to be
// Windows JUNCTIONS into the store (~/.loom/skills), so worktree removal's recursive rm followed the
// junction and deleted the STORE's SKILL.md contents — nuking skills for every later session. And
// seedGlobalSkills was dir-keyed ("if dir exists, skip"), so a hollowed dir was NEVER refilled.
// Fixes: inject COPIES (independent per session), and seed self-heals on a missing SKILL.md.
// Hermetic — sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at load). No claude.
// Run after build: node test/skills-store-durability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-durability-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const cwd = path.join(root, "repo");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");
const { seedGlobalSkills } = await import("../dist/skills/seed.js");

try {
  // (a) Injection is a COPY, not a junction: deleting the session's .claude/skills must NOT touch the store.
  fs.mkdirSync(path.join(skillsDir, "loom-a"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "---\nname: loom-a\ndescription: A\n---\nA");
  injectSkills(cwd);

  const injected = path.join(cwd, ".claude", "skills", "loom-a");
  check("injected skill is a real SKILL.md file", fs.existsSync(path.join(injected, "SKILL.md")));
  check("injected dir is NOT a symlink/junction (independent copy)", fs.lstatSync(injected).isSymbolicLink() === false);

  // Simulate worktree removal blowing away the whole session .claude/skills tree.
  fs.rmSync(path.join(cwd, ".claude", "skills"), { recursive: true, force: true });

  // THE regression guard: the STORE still has its SKILL.md (a junction would have let the rm delete it).
  check("store SKILL.md SURVIVES session-dir removal (no store-nuke)", fs.existsSync(path.join(skillsDir, "loom-a", "SKILL.md")));
  check("store SKILL.md content intact", fs.readFileSync(path.join(skillsDir, "loom-a", "SKILL.md"), "utf8").includes("name: loom-a"));

  // (b) seedGlobalSkills self-heals a hollow dir (SKILL.md missing) while preserving a genuine edit.
  //   - doc-hygiene: dir exists but EMPTY (the post-junction-bug state) → must be re-seeded.
  //   - worker: dir has an EDITED SKILL.md → must be left untouched.
  const hollow = path.join(skillsDir, "doc-hygiene");
  fs.mkdirSync(hollow, { recursive: true }); // exists but no SKILL.md
  const edited = path.join(skillsDir, "worker");
  const EDIT = "---\nname: worker\ndescription: edited\n---\nMY LOCAL EDIT";
  fs.mkdirSync(edited, { recursive: true });
  fs.writeFileSync(path.join(edited, "SKILL.md"), EDIT);

  const seeded = seedGlobalSkills();

  check("hollow skill dir re-seeded (SKILL.md restored)", fs.existsSync(path.join(hollow, "SKILL.md")));
  check("re-seeded doc-hygiene reported as seeded", seeded.includes("doc-hygiene"));
  check("edited skill left untouched (UI edit preserved)", fs.readFileSync(path.join(edited, "SKILL.md"), "utf8") === EDIT);
  check("edited skill NOT reported as seeded", !seeded.includes("worker"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — injected skills are copies (store survives worktree removal) and seed self-heals hollow dirs." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
