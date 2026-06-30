// Pure, side-effect-free helper shared by the npm-package builder (scripts/build-npm-package.mjs) and
// the daemon dev-flag test (packages/daemon/test/platform-dev-flag.mjs).
//
// `DEV_ONLY_SKILLS` is the OMISSION set: bundled skill dirs that must NOT ship to regular `loomctl`
// users. Two reasons a skill lands here:
//   - DEV-ONLY Platform layer (platform-lead / platform-audit): gated at runtime behind LOOM_DEV — see
//     packages/daemon/src/paths.ts › isLoomDev — so it stays loadable in dev but never ships.
//   - INSTALL-SPECIFIC: bespoke to the owner's own vault, not general end-user doctrine (research — a
//     geopolitics/history research rig with a hardcoded source blocklist, dual-terminology rules, and
//     vault-local tooling). Kept in the repo, just not bundled by default.
// The CORE orchestration skills (orchestrate / worker / pickup / etc.) ALWAYS ship. Curation is by
// skill-DIR NAME so it is trivially unit-testable against the real asset listing, with no filesystem or
// build side effects on import.

/** Bundled skill dirs OMITTED from the published `assets/skills/` (dev-only + install-specific). */
export const DEV_ONLY_SKILLS = ["platform-lead", "platform-audit", "research"];

/**
 * Given the bundled skill dir names, return the subset that SHIPS in the published package — the core
 * skills, with the dev-only and install-specific skills removed. Pure: no mutation of the input, no I/O.
 */
export function curateSkillDirs(dirNames) {
  return dirNames.filter((name) => !DEV_ONLY_SKILLS.includes(name));
}
