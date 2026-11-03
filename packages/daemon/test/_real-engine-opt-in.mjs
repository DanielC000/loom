// SHARED structural guard (card dd6e713d) — every file that can launch a REAL claude/codex ENGINE
// process imports this as its FIRST import line, before any other import: `import
// "./_real-engine-opt-in.mjs";`. ESM hoists and evaluates every static import before any body
// statement, in the ORDER they're written — so being first here means this check runs before any
// later import's own module body (including a module that could itself spawn as a side effect), not
// merely before this file's own later statements. Keep `_guard.mjs` (and everything else) untouched by
// this file; this is an ADDITIVE opt-in gate, not a replacement for it.
//
// Membership criterion for `REAL_ENGINE_SPAWN_BASENAMES`, and the mechanism this opt-in is enforced by,
// are both stated ONCE, in `real-engine-spawn-opt-in-guard.mjs`'s own header — read it there, not
// restated here.
//
// @decision dd6e713d — do not re-export `REAL_ENGINE_SPAWN_BASENAMES` from this file: a caller wanting
// only the list would trigger this file's own `process.exit(0)` first. Import it from the side-effect-free
// `_real-engine-spawn-basenames.mjs` instead.

const basename = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "<unknown>";

if (process.env.LOOM_ALLOW_REAL_ENGINE !== "1") {
  // eslint-disable-next-line no-console
  console.log(`WARN  SKIP  ${basename} — real-engine spawn refused (set LOOM_ALLOW_REAL_ENGINE=1 to run this)`);
  process.exit(0);
}
