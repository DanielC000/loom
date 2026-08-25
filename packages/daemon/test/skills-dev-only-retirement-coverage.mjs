import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Drift guard for board card 426dbb37: `research` sat in `DEV_ONLY_SKILLS`
// (scripts/curate-release-skills.mjs — the OMISSION set that keeps a skill out of the published
// loomctl bundle) for a full release window (v0.13.0-...) WITHOUT a matching entry in
// `RETIRED_BUNDLED_SKILL_NAMES` (packages/daemon/src/skills/store.ts — the boot-time auto-retire
// allowlist), silently stranding an orphaned store dir for any end user seeded during the window it WAS
// bundled (v0.3.0-v0.12.0). The two lists encode the SAME lifecycle fact from two different angles and
// can drift apart with no compiler or runtime signal.
//
// This test asserts the relationship directly: every name in DEV_ONLY_SKILLS is EITHER in
// RETIRED_BUNDLED_SKILL_NAMES OR carries an explicit, documented exemption below — so the next skill
// curated out of the public bundle can't repeat this silently. An exemption is valid ONLY for a skill
// that was NEVER actually bundled in any published release (so no end-user store was ever seeded and
// there is nothing to retire) — anything else must retire.
//
// Hermetic: only READS the two constants (no fs mutation), but sets an isolated LOOM_HOME before
// importing dist/skills/store.js anyway, matching this suite's convention of never letting an import's
// path computation resolve against the real ~/.loom.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// card f273ebb9: no cleanup call needed here — this path is never mkdir'd (this file, curate-release-skills.mjs,
// and store.js's module load are all fs-inert; ensureDirs() is only ever called from index.ts's real boot
// path), so nothing is ever created on disk to leak.
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-skills-devonly-coverage-${Date.now()}-${process.pid}`);
process.env.LOOM_PORT = "45425";

const { DEV_ONLY_SKILLS } = await import("../../../scripts/curate-release-skills.mjs");
const { RETIRED_BUNDLED_SKILL_NAMES } = await import("../dist/skills/store.js");

// Names in DEV_ONLY_SKILLS that were NEVER bundled in any published `loomctl` release, so no end-user
// store was ever seeded with them and there is nothing for retireOrphanedBundledSkillDirs() to clean up.
// A name belongs here ONLY with a cited reason; anything else must be in RETIRED_BUNDLED_SKILL_NAMES.
const NEVER_PUBLISHED_EXEMPTIONS = {
  // Gated behind LOOM_DEV at the SAME commit (0cd238f0, 2026-06-15) that introduced DEV_ONLY_SKILLS
  // itself — two days BEFORE the first ever published release (v0.3.0, 2026-06-17). No published
  // tarball ever shipped these, so no end-user store was ever seeded.
  "platform-lead": "gated behind LOOM_DEV before the first published release (v0.3.0) ever existed",
  "platform-audit": "gated behind LOOM_DEV before the first published release (v0.3.0) ever existed",
};

for (const name of DEV_ONLY_SKILLS) {
  const retires = RETIRED_BUNDLED_SKILL_NAMES.includes(name);
  const exempt = Object.prototype.hasOwnProperty.call(NEVER_PUBLISHED_EXEMPTIONS, name);
  check(`"${name}" either retires on unbundle or carries a documented never-published exemption`,
    retires || exempt);
}

// Guard the guard: an exemption for a name that ISN'T even in DEV_ONLY_SKILLS is stale bookkeeping —
// catches the exemption list itself drifting away from what it's supposed to document.
for (const name of Object.keys(NEVER_PUBLISHED_EXEMPTIONS)) {
  check(`exemption "${name}" still refers to a real DEV_ONLY_SKILLS entry`, DEV_ONLY_SKILLS.includes(name));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every DEV_ONLY_SKILLS entry either auto-retires an orphaned store dir on unbundle or has a documented reason it never needed to."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
