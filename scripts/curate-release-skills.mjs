// Pure, side-effect-free helper shared by the npm-package builder (scripts/build-npm-package.mjs) and
// the daemon dev-flag test (packages/daemon/test/platform-dev-flag.mjs).
//
// `DEV_ONLY_SKILLS` is the OMISSION set: bundled skill dirs that must NOT ship to regular `loomctl`
// users. Three reasons a skill lands here:
//   - DEV-ONLY, LOOM_DEV-gated: platform-lead / platform-audit (the "Platform layer") and codescape (a
//     separate dev-only feature, not part of the Platform layer, but gated behind the SAME flag — see
//     packages/daemon/src/paths.ts › isLoomDev / isCodescapeSupervisorEnabled) — so it stays loadable in
//     dev but never ships.
//   - PRIVATE PRODUCT: codescape doubles into this bucket too — it's a private product end users cannot
//     obtain, so shipping its skill would only leak awareness of a feature they could never use (card
//     187873f9). Its runtime IS already inert for a regular user (LOOM_DEV-gated, above); this entry is
//     what stops the *doctrine/branding* from leaking into their skill roster too.
//   - INSTALL-SPECIFIC: bespoke to the owner's own vault, not general end-user doctrine (research — a
//     geopolitics/history research rig with a hardcoded source blocklist, dual-terminology rules, and
//     vault-local tooling). Kept in the repo, just not bundled by default.
// The CORE orchestration skills (orchestrate / worker / loom-pickup / etc.) ALWAYS ship. Curation is by
// skill-DIR NAME so it is trivially unit-testable against the real asset listing, with no filesystem or
// build side effects on import.

/** Bundled skill dirs OMITTED from the published `assets/skills/` (dev-only + private-product + install-specific). */
export const DEV_ONLY_SKILLS = ["platform-lead", "platform-audit", "codescape", "research"];

/**
 * Given the bundled skill dir names, return the subset that SHIPS in the published package — the core
 * skills, with the dev-only and install-specific skills removed. Pure: no mutation of the input, no I/O.
 */
export function curateSkillDirs(dirNames) {
  return dirNames.filter((name) => !DEV_ONLY_SKILLS.includes(name));
}
