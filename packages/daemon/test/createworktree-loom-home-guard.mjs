import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card f103dd2d) — a test file that calls the REAL production `createWorktree()` must have
// a temp LOOM_HOME in force BEFORE it can reach the real `~/.loom-worktrees`. `paths.ts` derives
// WORKTREES_DIR as a SIBLING of LOOM_HOME, evaluated when `../dist/…` is first imported. Card aac489a2
// fixed the two files (batch-merge.mjs, batch-merge-robustness.mjs) that leaked real worktrees this way;
// that fix is per-file, and a NEW test file can reintroduce the defect without touching any `.ts` source,
// so no transpile-identity / `.ts`-keyed scanner list would ever notice it — hence a place in
// STATIC_GUARD_REPO_PATHS (git/worktrees.ts).
//
// WHAT THIS ASSERTS — PRESENCE + textual ORDER (NOT the value): every `packages/daemon/test/*.mjs` whose
// comment-stripped text contains a real `createWorktree(` CALL must satisfy ONE of
//   (a) a `useOwnLoomHome(` call or a `process.env.LOOM_HOME =` assignment appears textually BEFORE the
//       first `../dist/` import (static `from`/`import` or dynamic `import(`); OR
//   (b) a `requireHermeticEnv(` call appears textually BEFORE the first `createWorktree(` call — fail-closed:
//       it aborts the process unless LOOM_HOME is a temp dir, so a bare run cannot leak (the two
//       live-daemon-shaped tests that get LOOM_HOME from the operator use this form).
//
// ⭐ THE "HARNESS-PROVIDED" PATTERN IS NOT AN EXCEPTION AND HAS NO ALLOWLIST — the card's DoD-2 asked for a
// harness-only set as a first-class pass, but its DoD-3 specimen (`git show 2ed7f86e~1:packages/daemon/
// test/batch-merge.mjs`) IS that shape: it sets nothing and relies on `scripts/test-daemon.mjs` `runOne`
// giving each child a temp LOOM_HOME. Green under the harness, but a bare `node test/x.mjs` run (no
// LOOM_HOME) leaks into the owner's real worktrees dir — the actual incident. DoD-3 is the concrete,
// falsifiable requirement, so it wins. The harness-provided case is reached FIRST-CLASS through (a):
// `useOwnLoomHome` REUSES the harness's own per-test home when one is already set, and mkdtemp's its own
// (registered for cleanup) when run bare. Nothing to maintain, nothing to rot.
//
// GAPS, NAMED (this check does NOT cover):
//  (i)   the VALUE — `process.env.LOOM_HOME = <anything>` passes; only (b) and `_guard.mjs`'s exit hook
//        (which refuses to delete a non-tmpdir home) bring a runtime temp-dir proof.
//  (ii)  INDIRECT callers — a test that reaches createWorktree only through service/merge code without a
//        direct `createWorktree(` call is not scanned. SIZED at card time by widening the trigger to "any
//        `../dist/` import": 207 of 1112 non-`_` test files (2026-09-24, HEAD fe7db5c0; predicate (a) or
//        any-`requireHermeticEnv`) failed, mostly pure-unit tests that touch no LOOM_HOME state — too
//        many to police soundly here, so the trigger stays `createWorktree(`.
//  (iii) textual order approximates execution order (a hoisted function defined earlier but invoked later
//        counts as "before").
// This guard's own source is excluded from the scan (its prose/fixtures mention the patterns).
//
// Run: node packages/daemon/test/createworktree-loom-home-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const CALL_RE = /\bcreateWorktree\s*\(/;
const DIST_IMPORT_RE = /(?:import\s*\(|from\s*|import\s+)["']\.\.\/dist\//;
const HOME_SET_RE = /\buseOwnLoomHome\s*\(|process\.env\.LOOM_HOME\s*=(?!=)/;
const HERMETIC_RE = /\brequireHermeticEnv\s*\(/;

/** @returns {"n/a"|"pass-a"|"pass-b"|"fail"} verdict for ONE file's raw text */
export function classify(raw) {
  const t = stripComments(raw);
  const call = t.search(CALL_RE);
  if (call < 0) return "n/a";
  const dist = t.search(DIST_IMPORT_RE);
  const set = t.search(HOME_SET_RE);
  if (set >= 0 && dist >= 0 && set < dist) return "pass-a";
  const herm = t.search(HERMETIC_RE);
  if (herm >= 0 && herm < call) return "pass-b";
  return "fail";
}

// ── (control) synthetic fixtures — each MUST classify as stated, or the predicate cannot be trusted ──────
const IMPORT = `const { createWorktree } = await import("../dist/git/worktrees.js");\nawait createWorktree(r, p, t);\n`;
const ctl = (label, src, want) => check(`(control) ${label} → ${want}`, classify(src) === want);
ctl("harness-only shape (the 2ed7f86e~1 specimen: sets nothing, dist import + call)", IMPORT, "fail");
ctl("useOwnLoomHome before the dist import", `useOwnLoomHome("x-");\n${IMPORT}`, "pass-a");
ctl("hand-rolled LOOM_HOME assignment before the dist import", `process.env.LOOM_HOME = tmp;\n${IMPORT}`, "pass-a");
ctl("useOwnLoomHome AFTER the dist import (order matters)", `${IMPORT}useOwnLoomHome("x-");\n`, "fail");
ctl("`==` comparison is not an assignment", `if (process.env.LOOM_HOME == null) {}\n${IMPORT}`, "fail");
ctl("LOOM_HOME set only in a comment", `// process.env.LOOM_HOME = tmp;\n${IMPORT}`, "fail");
ctl("requireHermeticEnv before the call, no pre-import set (form b)", `import { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv({ port: true });\n${IMPORT}`, "pass-b");
ctl("requireHermeticEnv AFTER the call does not count", `${IMPORT}requireHermeticEnv();\n`, "fail");
ctl("createWorktree named only in a comment → not in scope", `// createWorktree( is mentioned\nconst x = 1;\n`, "n/a");

// ── the real corpus ─────────────────────────────────────────────────────────────────────────────────────
const tally = { "n/a": 0, "pass-a": 0, "pass-b": 0, fail: 0 };
const offenders = [];
for (const f of fs.readdirSync(TEST_DIR).filter((n) => n.endsWith(".mjs") && n !== SELF)) {
  const v = classify(fs.readFileSync(path.join(TEST_DIR, f), "utf8"));
  tally[v]++;
  if (v === "fail") offenders.push(f);
}
// Population sanity: the scan must actually have SEEN createWorktree callers, or a broken CALL_RE would
// turn this whole guard vacuously green (paired with the controls above, which prove the predicate itself).
check(`(population) the scan saw real createWorktree( callers (${tally["pass-a"] + tally["pass-b"] + tally.fail}; tally ${JSON.stringify(tally)})`,
  tally["pass-a"] + tally["pass-b"] + tally.fail >= 20);
check(`every test that calls createWorktree( sets a temp LOOM_HOME before the dist import, or requireHermeticEnv()s before the call${offenders.length ? ` — OFFENDERS: ${offenders.join(", ")} (add useOwnLoomHome("<prefix>-") + requireHermeticEnv() above the ../dist import; do NOT allowlist)` : ""}`,
  offenders.length === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
