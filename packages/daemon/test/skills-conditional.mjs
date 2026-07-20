// Hermetic unit test for the CONDITIONAL Obsidian-preflight injection in skills/inject.ts.
// injectSkills(cwd, sid, subset, role, obsidianEnabled):
//   - obsidianEnabled=false (default) → every injected SKILL.md is BYTE-IDENTICAL to the store base
//     (no fragment read, no append) — the additive-when-off invariant.
//   - obsidianEnabled=true → ONLY loom-pickup/loom-session-end get the Obsidian "vault preflight" fragment appended
//     after their body (frontmatter intact); every other skill stays byte-identical; repo-own untouched.
// The fragment is the REAL shipped asset (packages/daemon/assets/skill-fragments/obsidian-preflight.md),
// read live from the package dir — this test reads that same file for its expected content.
// Sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at module load). No claude.
// Run after build: node test/skills-conditional.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The real shipped fragment, exactly as inject.ts reads it (paths.ts: <daemon>/assets/skill-fragments/…).
const FRAGMENT = fs.readFileSync(path.join(__dirname, "..", "assets", "skill-fragments", "obsidian-preflight.md"), "utf8");

const root = path.join(os.tmpdir(), `loom-cond-test-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");

// Store skills: the two fragment targets + one non-target. Distinct base bodies, each ending in a newline.
const BASE = {
  "loom-pickup": "---\nname: pickup\ndescription: P\n---\n# Pickup\n\nRead the board.\n",
  "loom-session-end": "---\nname: session-end\ndescription: S\n---\n# Session End\n\nUpdate the board.\n",
  "other-skill": "---\nname: other-skill\ndescription: O\n---\n# Other\n\nUnrelated.\n",
};
for (const [name, body] of Object.entries(BASE)) {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), body);
}

// Two independent repos so the off-run and the on-run never share a .claude/skills.
function makeRepo(sub) {
  const cwd = path.join(root, sub);
  fs.mkdirSync(path.join(cwd, ".claude", "skills", "repo-own"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "skills", "repo-own", "SKILL.md"), "---\nname: repo-own\ndescription: theirs\n---\nKEEP");
  execSync("git init -q", { cwd });
  return cwd;
}
const repoOff = makeRepo("repo-off");
const repoOn = makeRepo("repo-on");

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

const injected = (cwd, name) => fs.readFileSync(path.join(cwd, ".claude", "skills", name, "SKILL.md"), "utf8");
const expectedWithFragment = (name) => {
  const b = BASE[name];
  return `${b.endsWith("\n") ? b : `${b}\n`}\n${FRAGMENT}`;
};

try {
  // (a) OFF (default) → byte-identical to the store base for EVERY skill (incl. the fragment targets).
  injectSkills(repoOff, "sess-off", null, null, false);
  check("(a) off: pickup byte-identical to store base", injected(repoOff, "loom-pickup") === BASE["loom-pickup"]);
  check("(a) off: session-end byte-identical to store base", injected(repoOff, "loom-session-end") === BASE["loom-session-end"]);
  check("(a) off: no fragment text anywhere in pickup", !injected(repoOff, "loom-pickup").includes("Vault preflight"));

  // Explicit default-arg check: omitting obsidianEnabled entirely is the same byte-identical off behavior.
  const repoDefault = makeRepo("repo-default");
  injectSkills(repoDefault, "sess-default", null, null);
  check("(a) default arg (omitted) == off: pickup byte-identical", injected(repoDefault, "loom-pickup") === BASE["loom-pickup"]);

  // (b) ON → pickup/session-end END with the fragment, frontmatter intact.
  injectSkills(repoOn, "sess-on", null, null, true);
  check("(b) on: pickup == base + separator + real fragment", injected(repoOn, "loom-pickup") === expectedWithFragment("loom-pickup"));
  check("(b) on: session-end == base + separator + real fragment", injected(repoOn, "loom-session-end") === expectedWithFragment("loom-session-end"));
  check("(b) on: pickup ends with the fragment", injected(repoOn, "loom-pickup").endsWith(FRAGMENT));
  check("(b) on: pickup frontmatter block intact at the top", injected(repoOn, "loom-pickup").startsWith("---\nname: pickup\ndescription: P\n---\n"));
  check("(b) on: fragment lands AFTER the body (base body precedes the fragment)", injected(repoOn, "loom-pickup").indexOf("Read the board.") < injected(repoOn, "loom-pickup").indexOf("Vault preflight"));

  // (c) a NON-target skill is byte-identical in BOTH the off and on runs.
  check("(c) off: other-skill byte-identical to base", injected(repoOff, "other-skill") === BASE["other-skill"]);
  check("(c) on: other-skill byte-identical to base (no fragment even when enabled)", injected(repoOn, "other-skill") === BASE["other-skill"]);

  // (d) the repo's OWN project-local skill is never touched, off OR on.
  check("(d) off: repo-own untouched", injected(repoOff, "repo-own").includes("KEEP"));
  check("(d) on: repo-own untouched", injected(repoOn, "repo-own").includes("KEEP"));

  // Idempotent: re-injecting ON re-copies the fresh base then appends ONCE (no double fragment).
  injectSkills(repoOn, "sess-on", null, null, true);
  check("re-inject on: pickup still has exactly ONE fragment (append not doubled)", injected(repoOn, "loom-pickup") === expectedWithFragment("loom-pickup"));

  // Flip a live ON session to OFF → the next inject restores the byte-identical base (fragment removed).
  injectSkills(repoOn, "sess-on", null, null, false);
  check("flip on→off: pickup restored byte-identical to base", injected(repoOn, "loom-pickup") === BASE["loom-pickup"]);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0 ? "\n✅ ALL PASS — Obsidian preflight fragment injects ONLY when enabled, byte-identical when off." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
