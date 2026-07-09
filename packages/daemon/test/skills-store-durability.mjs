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
  injectSkills(cwd, "sess-durability", null); // null subset ⇒ deliver all (this test doesn't exercise subsets)

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

  // (c) A bundled ungated skill absent from the store is COPIED on a clean seed. The ungated, suggest-only
  // workspace-audit skill (the de-Loom-ified cousin of dev platform-audit) must reach every user's store.
  check("clean store: workspace-audit copied by seedGlobalSkills", seeded.includes("workspace-audit"));
  check("clean store: workspace-audit SKILL.md present after seed", fs.existsSync(path.join(skillsDir, "workspace-audit", "SKILL.md")));

  // (d) Card 7f73979f regression guard: a bundled skill seeded BEFORE the real asset shipped a new
  // supporting file (e.g. orchestrate's scripts/serve-static.mjs, added after the skill's SKILL.md was
  // already in the store) must still receive that file on a LATER boot — seedGlobalSkills is dir-keyed
  // on SKILL.md presence, so a naive "skip if SKILL.md exists" would leave the store permanently missing
  // it. The earlier seedGlobalSkills() call above already fully seeded orchestrate (a fresh store gets
  // every bundled skill in full) — simulate the STALE-store state that predates the scripts/ addition by
  // deleting it back out, and edit SKILL.md too so the backfill's "never touches existing content" half
  // of the guarantee is also exercised.
  const orchestrateStore = path.join(skillsDir, "orchestrate");
  fs.rmSync(path.join(orchestrateStore, "scripts"), { recursive: true, force: true });
  const ORCHESTRATE_EDIT = "---\nname: orchestrate\ndescription: edited\n---\nMY LOCAL EDIT";
  fs.writeFileSync(path.join(orchestrateStore, "SKILL.md"), ORCHESTRATE_EDIT);
  check("precondition: orchestrate store has no scripts/ dir yet", !fs.existsSync(path.join(orchestrateStore, "scripts")));

  const reseeded = seedGlobalSkills();

  check("stale-store orchestrate backfilled with scripts/serve-static.mjs", fs.existsSync(path.join(orchestrateStore, "scripts", "serve-static.mjs")));
  check("backfill never overwrites an existing (edited) SKILL.md", fs.readFileSync(path.join(orchestrateStore, "SKILL.md"), "utf8") === ORCHESTRATE_EDIT);
  check("backfill-only pass is not reported as a fresh seed", !reseeded.includes("orchestrate"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — injected skills are copies (store survives worktree removal) and seed self-heals hollow dirs." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
