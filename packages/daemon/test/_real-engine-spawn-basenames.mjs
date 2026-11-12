// SIDE-EFFECT-FREE data module (card dd6e713d) — pure export, no top-level opt-in check. Split out of
// `_real-engine-opt-in.mjs` for one reason: ESM evaluates a module's ENTIRE body on import regardless of
// which named export a caller pulls, so a caller that only wants the LIST (e.g.
// `real-engine-spawn-opt-in-guard.mjs`, which must read this array without itself being subject to the
// opt-in gate) would otherwise also trigger `_real-engine-opt-in.mjs`'s own `process.exit(0)` side effect
// — a real bug this project's own guard hit on its first run. `_real-engine-opt-in.mjs` re-exports this
// same array, so every real-engine-spawning test still gets BOTH the list (for its own reference, if it
// ever needs it) and the check from that one import; nothing about that contract changes.
//
// See `_real-engine-opt-in.mjs` for the full membership criterion and WHY list. Judgment-curated — never
// derived from a name pattern (`_probe-*`/`*real-spawn*` is not a reliable proxy either way; card
// dd6e713d's own investigation found a genuine 32nd engine-spawning file, `_smoke-mode-fix-9c03f5a6.mjs`,
// that neither glob names).
export const REAL_ENGINE_SPAWN_BASENAMES = [
  // Manual probes — never discovered by the gate at all (underscore-prefixed), reachable only by a
  // direct `node test/<file>.mjs` invocation or an accidental shell glob.
  "_probe-classifier-search-59a88ac1",
  "_probe-classifier-search2-59a88ac1",
  "_probe-classifier-search3-59a88ac1",
  "_probe-classifier-skip-59a88ac1",
  "_probe-collapsed-placeholder-identity",
  "_probe-composer-clear-2",
  "_probe-composer-clear-overshoot",
  "_probe-composer-clear",
  "_probe-composer-dirty",
  "_probe-empty-paste-provocation",
  "_probe-paste-collapse-production-repeat",
  "_probe-paste-collapse-trigger",
  "_probe-paste-companion",
  "_probe-paste-resume",
  "_probe-paste-stranded-resume",
  "_probe-repaint-wedge",
  "_probe-resume-mode",
  "_probe-session-name",
  "_smoke-mode-fix-9c03f5a6",
  // claude-family, listed in NOT_HERMETIC (scripts/test-daemon.mjs) — manual-only, never selectable via
  // --only=/--only-file= either (discoverHermeticTests excludes them from the discovered set entirely).
  "disallow-harness-scheduling-tools-real-spawn",
  "loom-home-write-deny-real-spawn",
  "bash-loom-home-guard-real-spawn",
  "claude-md-external-import-dialog-real-spawn",
  "instructions-loaded-real-spawn",
  "env-isolation-real-spawn",
  // codex-family — CODEX_REAL_SPAWN_BASENAMES in _codex-real-spawn-lock.mjs. DISCOVERED hermetic (not
  // excluded) and scheduled ALWAYS-ON by scripts/test-daemon.mjs on every ordinary gate/CI run; each
  // self-skips only on a missing/unauthenticated real `codex` CLI. See docs/decisions/
  // dd6e713d-real-engine-spawn-opt-in.md for why this card does NOT change that pre-existing behavior.
  "codex-doctrine-real-spawn",
  "codex-mcp-connect-stuck-real-spawn",
  "codex-mcp-reachability-real-spawn",
  "codex-prompt-ascii-fold-real-spawn",
  "codex-rollout-archive-restore-real-spawn",
  "codex-stateful-runtime-real-spawn",
  "codex-submit-confirmation-real-spawn",
  "codex-transcript-real-spawn",
];
