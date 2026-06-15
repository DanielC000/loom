// Pure, side-effect-free helper shared by the npm-package builder (scripts/build-npm-package.mjs) and
// the daemon dev-flag test (packages/daemon/test/platform-dev-flag.mjs).
//
// The "Platform layer" skills (platform-lead / platform-audit) are part of Loom's DEV-ONLY platform
// layer (gated at runtime behind LOOM_DEV — see packages/daemon/src/paths.ts › isLoomDev) and must NOT
// ship to regular `loomctl` users. The CORE orchestration skills (orchestrate / worker / pickup / etc.)
// ALWAYS ship. Curation is by skill-DIR NAME so it is trivially unit-testable against the real asset
// listing, with no filesystem or build side effects on import.

/** The dev-only Platform-layer skill dirs, OMITTED from the published `assets/skills/`. */
export const DEV_ONLY_SKILLS = ["platform-lead", "platform-audit"];

/**
 * Given the bundled skill dir names, return the subset that SHIPS in the published package — the core
 * skills, with the dev-only Platform-layer skills removed. Pure: no mutation of the input, no I/O.
 */
export function curateSkillDirs(dirNames) {
  return dirNames.filter((name) => !DEV_ONLY_SKILLS.includes(name));
}
