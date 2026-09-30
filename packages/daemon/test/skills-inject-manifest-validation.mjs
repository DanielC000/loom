// Regression guard for card 97e6a1c6: `.loom-skills.json` (the per-session skills manifest at
// <cwd>/.claude/skills/.loom-skills.json) lives in the repo/worktree and is committable, so its entries
// are UNTRUSTED input — they used to flow straight into a prune `fs.rmSync(path.join(targetDir, stale),
// {recursive:true, force:true})` with no validation. A legacy-array manifest `["../../../victim"]` deleted
// an arbitrary sibling directory; `""`/`"."` wiped the whole `.claude/skills` dir; a non-iterable dict
// value (e.g. `{"x":5}`) for ANY session threw and silently disabled injection for the whole session.
// The fix validates every manifest entry (basename-only, non-empty, not "."/"..", a valid kebab-slug skill
// name) before it's ever adopted, and coerces a non-array record to `[]` instead of throwing.
// Hermetic — sets LOOM_HOME to a temp dir BEFORE importing (paths.ts reads it at load). No claude.
// Run after build: node test/skills-inject-manifest-validation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

// Run a section in isolation: on the PRE-FIX code, section (B) can wipe the very directory section (C)'s
// own assertions never touch, and an unguarded read of section (B)'s OWN files there can throw uncaught
// (e.g. ENOENT) and crash the whole script before (C) ever runs. Each section reports independently — an
// unexpected throw inside one is caught and counted as an explicit FAIL, never a silent skip of what comes
// after it.
function runSection(label, fn) {
  try { fn(); }
  catch (e) { console.log(`FAIL  ${label} threw unexpectedly: ${e.message}`); failures++; }
}

const root = path.join(os.tmpdir(), `loom-inject-manifest-validation-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });
const mkSkill = (n) => {
  fs.mkdirSync(path.join(skillsDir, n), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n${n}`);
};
mkSkill("loom-a");

process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR at load
const { injectSkills } = await import("../dist/skills/inject.js");

try {
  // ============ (A) reviewer's exact repro: a path-escape entry in a LEGACY-ARRAY manifest ============
  // `["../../../victim"]` must never reach rmSync unsanitized: path.join(<cwd>/.claude/skills, "../../../victim")
  // walks skills -> .claude -> cwd -> cwd's PARENT, landing on a SIBLING of the repo dir.
  runSection("(A)", () => {
    const repoA = path.join(root, "repoA");
    const targetA = path.join(repoA, ".claude", "skills");
    fs.mkdirSync(targetA, { recursive: true });
    const victim = path.join(root, "victim"); // sibling of repoA
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "marker.txt"), "do-not-delete");
    fs.writeFileSync(path.join(targetA, ".loom-skills.json"), JSON.stringify(["../../../victim"]));

    injectSkills(repoA, "sess-new", null, "worker"); // ANY new session id adopts a legacy array as its own
    check("(A) path-escape entry: sibling victim/ dir SURVIVES", fs.existsSync(path.join(victim, "marker.txt")));
    check("(A) injection still proceeded normally (loom-a delivered)", fs.existsSync(path.join(targetA, "loom-a", "SKILL.md")));
    // (Deliberately NOT asserting the escape entry is absent from the rewritten manifest here: the manifest
    // is always rewritten from `placed` — what was actually copied THIS run — never from the raw `myPrev`
    // it read, so that assertion would pass on the pre-fix code too and can never discriminate the bug.)
  });

  // ============ (B) "" and "." entries must not wipe the WHOLE .claude/skills dir ============
  // path.join(targetDir, "") === targetDir and path.join(targetDir, ".") === targetDir — unsanitized, either
  // one is a prune of the entire skills dir, including every OTHER skill (the owner's personal ones, a
  // repo-own skill) that this session never touched.
  runSection("(B)", () => {
    const repoB = path.join(root, "repoB");
    const targetB = path.join(repoB, ".claude", "skills");
    fs.mkdirSync(path.join(targetB, "repo-own"), { recursive: true });
    fs.writeFileSync(path.join(targetB, "repo-own", "SKILL.md"), "---\nname: repo-own\ndescription: theirs\n---\nKEEP");
    // dict-form manifest: the SAME session id we call injectSkills with claims ["", "."] as its own prior injects.
    fs.writeFileSync(path.join(targetB, ".loom-skills.json"), JSON.stringify({ "sess-empty-dot": ["", "."] }));

    injectSkills(repoB, "sess-empty-dot", null);
    check("(B) '' / '.' entries do not wipe the whole .claude/skills dir (repo-own survives)", fs.existsSync(path.join(targetB, "repo-own", "SKILL.md")));
    check("(B) injection still proceeded normally (loom-a delivered)", fs.existsSync(path.join(targetB, "loom-a", "SKILL.md")));
    // Read via readJsonSafe (returns null on ENOENT etc.) rather than a bare readFileSync: on the pre-fix
    // code, "" prunes targetB itself — including the manifest file this line would otherwise read — and an
    // unguarded read here throws uncaught, crashing the script before section (C) ever runs.
    const manifestB = readJsonSafe(path.join(targetB, ".loom-skills.json"));
    check("(B) neither '' nor '.' is retained in the rewritten manifest", !!manifestB && Array.isArray(manifestB["sess-empty-dot"]) && !manifestB["sess-empty-dot"].includes("") && !manifestB["sess-empty-dot"].includes("."));
  });

  // ============ (C) a non-iterable dict value for ANOTHER session must not disable injection ============
  // The old code cast the parsed dict straight to `Record<string, string[]>` with no validation; iterating
  // a non-array value (`for (const n of ns)`) throws a TypeError for the WHOLE call, silently disabling
  // skill injection for every spawn in this cwd — even though the malformed record belongs to a DIFFERENT
  // session than the one currently spawning.
  runSection("(C)", () => {
    const repoC = path.join(root, "repoC");
    const targetC = path.join(repoC, ".claude", "skills");
    fs.mkdirSync(targetC, { recursive: true });
    fs.writeFileSync(path.join(targetC, ".loom-skills.json"), JSON.stringify({ "sess-other": { x: 5 }, "sess-under-test": ["loom-a"] }));

    let threwC = false;
    try { injectSkills(repoC, "sess-under-test", null); } catch { threwC = true; }
    check("(C) a non-iterable dict value for another session does NOT throw / disable injection", !threwC);
    check("(C) injection still delivers loom-a despite the malformed sibling record", fs.existsSync(path.join(targetC, "loom-a", "SKILL.md")));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the skills manifest rejects path-escaping / malformed entries before pruning."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
