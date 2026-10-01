// Hermetic unit test for card 509176c8: skills/inject.ts's deliver-all (null/empty subset) default must
// withhold an AGENT-written (or unstamped — fail closed) user-store skill from a LOCKED role's ambient
// .claude/skills, while a human-written one, a bundled one, and an EXPLICIT non-empty subset all still
// flow regardless of role or provenance. Proves the fix against card 4d70cc06's sibling finding: setup's
// skill_write (and the Lead's) writes into the SAME unified store injectSkills reads from, so a
// "always load this" skill would otherwise reach a locked role's context with no human scoping decision.
//
// Sets LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled-asset lookup, for isBundledSkill) to TEMP dirs
// BEFORE importing dist (paths.ts/store.ts read both at module load). No claude, no live daemon.
// Run after build: node test/skills-inject-locked-role-provenance.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-locked-provenance-test-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
fs.mkdirSync(home, { recursive: true });
process.env.LOOM_HOME = home; // BEFORE importing — paths.ts computes SKILLS_DIR/SKILL_PROVENANCE_FILE at load

const assetSkillsDir = path.join(root, "asset-skills");
fs.mkdirSync(path.join(assetSkillsDir, "core-doctrine"), { recursive: true });
process.env.LOOM_ASSET_SKILLS = assetSkillsDir; // BEFORE importing — store.ts computes ASSET_SKILLS at load

const { injectSkills } = await import("../dist/skills/inject.js");
const { writeSkill, skillProvenance } = await import("../dist/skills/store.js");

const skillMd = (name) => `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n`;

// --- Seed the store: one bundled skill (also in LOOM_ASSET_SKILLS, so isBundledSkill() is true), one
// agent-written user skill, one human-written user skill, and one UNSTAMPED user skill (simulating a
// pre-existing skill from before provenance tracking existed — must fail closed like "agent"). ---
// The asset side also gets the SAME content (a real pristine bundled skill, mine==shipped) — not load-
// bearing for the assertions below (card 509176c8 round 3 cut the content-equality gate; locked-role
// trust is bare isBundledSkill again), kept pristine simply because that's the realistic default case.
fs.writeFileSync(path.join(assetSkillsDir, "core-doctrine", "SKILL.md"), skillMd("core-doctrine"));
writeSkill("core-doctrine", skillMd("core-doctrine")); // bundled, pristine — provenance irrelevant
writeSkill("agent-skill", skillMd("agent-skill"), "agent"); // mirrors skillWriteData's user-skill branch
writeSkill("human-skill", skillMd("human-skill"), "human"); // mirrors gateway/server.ts's REST write
writeSkill("unstamped-skill", skillMd("unstamped-skill")); // no provenance arg — unknown, must fail closed

check("provenance recorded: agent-skill", skillProvenance("agent-skill") === "agent");
check("provenance recorded: human-skill", skillProvenance("human-skill") === "human");
check("provenance unknown: unstamped-skill", skillProvenance("unstamped-skill") === null);

const ALL_FOUR = ["agent-skill", "core-doctrine", "human-skill", "unstamped-skill"];
const readDelivered = (cwd) => {
  const dir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n !== ".loom-skills.json").sort();
};

try {
  // (a) + (c-unstamped): a LOCKED role (Companion = "assistant") under the deliver-all default (subset:
  // null) gets the bundled + human-written skills, but NOT the agent-written or unstamped ones.
  const cwdLocked = path.join(root, "companion-cwd");
  fs.mkdirSync(cwdLocked, { recursive: true });
  injectSkills(cwdLocked, "sess-companion", null, "assistant");
  const deliveredLocked = readDelivered(cwdLocked);
  check("(a) locked role (assistant) default: agent-skill WITHHELD", !deliveredLocked.includes("agent-skill"));
  check("(a) locked role (assistant) default: unstamped-skill WITHHELD (fail closed)", !deliveredLocked.includes("unstamped-skill"));
  check("(a) locked role (assistant) default: core-doctrine (bundled) still delivered", deliveredLocked.includes("core-doctrine"));
  check("(a) locked role (assistant) default: human-skill still delivered", deliveredLocked.includes("human-skill"));

  // (b) the SAME default, for an UNLOCKED role (worker), is completely unaffected — all four flow, proving
  // the fix is scoped to locked roles only and doesn't regress the existing deliver-all contract.
  const cwdWorker = path.join(root, "worker-cwd");
  fs.mkdirSync(cwdWorker, { recursive: true });
  injectSkills(cwdWorker, "sess-worker", null, "worker");
  const deliveredWorker = readDelivered(cwdWorker);
  check("(b) unlocked role (worker) default: all four skills delivered (untouched case)", JSON.stringify(deliveredWorker) === JSON.stringify(ALL_FOUR));

  // (c) a locked role with an EXPLICIT non-empty subset naming the agent-written skill BY NAME still
  // receives it — a human deliberately scoping a profile's `skills` field is an attributable grant, not
  // the silent ambient default this fix guards against.
  const cwdExplicit = path.join(root, "companion-explicit-cwd");
  fs.mkdirSync(cwdExplicit, { recursive: true });
  injectSkills(cwdExplicit, "sess-companion-explicit", ["agent-skill"], "assistant");
  const deliveredExplicit = readDelivered(cwdExplicit);
  check("(c) locked role + explicit subset naming agent-skill: still delivered", deliveredExplicit.includes("agent-skill"));
  check("(c) explicit subset excludes what it didn't name", !deliveredExplicit.includes("human-skill") && !deliveredExplicit.includes("unstamped-skill") && !deliveredExplicit.includes("core-doctrine"));

  // (d) a bundled skill reaches a locked role under the default regardless of the (irrelevant) provenance
  // question — already exercised by (a)'s core-doctrine assertion above; re-stated here for a second
  // locked role (setup) as a distinct instance, not a re-run of the same cwd/session.
  const cwdSetup = path.join(root, "setup-cwd");
  fs.mkdirSync(cwdSetup, { recursive: true });
  injectSkills(cwdSetup, "sess-setup", null, "setup");
  const deliveredSetup = readDelivered(cwdSetup);
  check("(d) locked role (setup) default: bundled skill delivered", deliveredSetup.includes("core-doctrine"));
  check("(d) locked role (setup) default: agent-written skill still withheld", !deliveredSetup.includes("agent-skill"));

  // (e) a human-written user skill reaches a locked role under the default — the owner's refinement: the
  // hole is agent-written skills, not human-written ones. Already exercised by (a)'s human-skill
  // assertion; re-stated for a THIRD locked role (operator) to show it's not a fluke of "assistant".
  const cwdOperator = path.join(root, "operator-cwd");
  fs.mkdirSync(cwdOperator, { recursive: true });
  injectSkills(cwdOperator, "sess-operator", null, "operator");
  const deliveredOperator = readDelivered(cwdOperator);
  check("(e) locked role (operator) default: human-written skill still delivered", deliveredOperator.includes("human-skill"));
  check("(e) locked role (operator) default: agent-written skill still withheld", !deliveredOperator.includes("agent-skill"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a locked role's deliver-all default withholds agent-written/unstamped user skills; human-written, bundled, and explicitly-subset skills still flow."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
