// SIDE-EFFECT-FREE data module (card dd6e713d) — plain, readable-literal synthetic fixture TEXT for
// real-engine-spawn-opt-in-guard.mjs's own RED-PROOF corpus. Lives in its own underscore-prefixed module,
// not inline in the guard, so these can stay ordinary literals instead of being built via string
// concatenation to dodge a textual scan: ensure-trusted-config-dir-redirect-guard.mjs's own real-corpus
// scan skips every underscore-prefixed basename (`!n.startsWith("_")`), so this module is invisible to it,
// whereas a literal `process.env.LOOM_CLAUDE_BIN = ...` assignment sitting beside `.spawn(`-shaped TEXT
// inside the guard file itself would trip that guard's trigger (B) — it matches TEXTUAL presence, with no
// notion that both strings here are fed only as STRING ARGUMENTS to this guard's own AST-based detectors,
// never imported or executed as real code.
//
// @decision dd6e713d — do not inline these strings back into the guard via string concatenation; that
// reintroduces the exact ensure-trusted-config-dir-redirect-guard.mjs false-positive this split avoids.
export const BIN_ASSIGN_FIXTURE_TEXT = "process.env.LOOM_CLAUDE_BIN = wrapperPath;";
export const BIN_OVERRIDE_SPAWN_FIXTURE_TEXT = `${BIN_ASSIGN_FIXTURE_TEXT} const host = new PtyHost(e); host.spawn(x);`;
// The four below are the SAME shape (a LOOM_CLAUDE_BIN/CODEX_BIN mention textually beside a `.spawn(`
// call) built for the guard's item-3 regression + DoD-(c) proofs — moved here for the identical reason as
// the two above, not split out separately from them.
export const BIN_COMPARISON_EQ_FIXTURE_TEXT = "if (process.env.LOOM_CLAUDE_BIN == wrapperPath) { host.spawn(x); }";
export const BIN_COMPARISON_EQEQEQ_FIXTURE_TEXT = "if (process.env.LOOM_CODEX_BIN === wrapperPath) { host.spawn(x); }";
export const BIN_EMPTY_STRING_FIXTURE_TEXT = 'process.env.LOOM_CLAUDE_BIN = ""; host.spawn(x);';
export const BIN_COMMENT_ONLY_MARKER_FIXTURE_TEXT = "// process.env.LOOM_CLAUDE_BIN = x\nconst host = new PtyHost(e); host.spawn(opts);";
