import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card f103dd2d, extended by card 52c96c6e) — a test file that calls the REAL production
// `createWorktree()` must have a temp LOOM_HOME in force BEFORE it can reach the real `~/.loom-worktrees`.
// `paths.ts` derives WORKTREES_DIR as a SIBLING of LOOM_HOME, evaluated when `../dist/…` is first imported.
// Card aac489a2 fixed the two files (batch-merge.mjs, batch-merge-robustness.mjs) that leaked real
// worktrees this way; that fix is per-file, and a NEW test file can reintroduce the defect without
// touching any `.ts` source, so no transpile-identity / `.ts`-keyed scanner list would ever notice it —
// hence a place in STATIC_GUARD_REPO_PATHS (git/worktrees.ts).
//
// WHAT THIS ASSERTS — PRESENCE + textual ORDER (NOT the value): every `packages/daemon/test/*.mjs` whose
// comment-stripped text contains a real `createWorktree(` CALL must satisfy ONE of
//   (a) a `useOwnLoomHome(` call or a `process.env.LOOM_HOME =` assignment appears textually BEFORE the
//       first `../dist/` import (static `from`/`import` or dynamic `import(`) — AND no STATICALLY-imported
//       local `./_*.mjs` helper (followed transitively through its own `./_*.mjs` imports) hides an
//       unguarded TOP-LEVEL `../dist/` import of its own (see card 52c96c6e below — a hoisted static
//       import always runs before anything in THIS file, so no ordering in this file's own text can ever
//       beat one); OR
//   (b) a `requireHermeticEnv(` call appears textually BEFORE the first `createWorktree(` call — fail-closed:
//       it aborts the process unless LOOM_HOME is a temp dir, so a bare run cannot leak (the two
//       live-daemon-shaped tests that get LOOM_HOME from the operator use this form). This still saves a
//       file even when a statically-imported helper hides an unguarded dist import, because it's a
//       RUNTIME check that aborts before the `createWorktree(` call ever runs — ordering inside the
//       importing file's own text is irrelevant to it.
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
// CARD 52c96c6e — THE HIDDEN-HELPER EXTENSION: the original check above only ever looked at the ../dist/
// imports textually present IN THE SCANNED FILE ITSELF. The real incident (Code Review of card 043d83d2,
// B1) was `batch-merge-head-moved.mjs` STATICALLY importing `./_emit-compare-fixtures.mjs`, a local helper
// whose own top level does `await import("../dist/git/worktrees.js")`. A static `import … from "./_x.mjs"`
// is HOISTED — the ES module spec evaluates every statically-imported module before any of the importing
// module's OWN top-level code runs — so the helper's dist import executed before the importing file's own
// `useOwnLoomHome()` call ever had a chance to run, no matter where that call sat in the file's text. The
// importing file's OWN text looked perfectly ordered (and passed the un-extended guard); the leak was
// entirely inside the helper. A DYNAMIC `await import("./_x.mjs")` does NOT have this hazard — it executes
// at its own textual position, like any other statement, so the pre-existing order-based reasoning already
// covers it (this is exactly why `batch-merge-reduced-gate.mjs:47-52` sets LOOM_HOME, THEN dynamically
// imports `_emit-compare-fixtures.mjs` — see that file's own comment). So this extension follows ONLY
// STATIC imports of a local `./_*.mjs` helper (one level, and transitively through any further `./_*.mjs`
// helper THAT helper statically imports, cycle-safe) and asks: does any reachable helper contain a
// TOP-LEVEL (not deferred inside a function/closure — see `depthAt` below) `../dist/` import that isn't
// itself preceded, in that SAME helper's own text, by that helper's own top-level LOOM_HOME set? If so,
// predicate (a) can never hold for the importing file regardless of its own ordering, and only (b) can
// still save it. Keep the NO-ALLOWLIST posture — fix the real file (convert the static helper import to a
// dynamic one placed after the LOOM_HOME set, the way `batch-merge-reduced-gate.mjs` does), never add an
// exemption here.
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
//  (iv)  the helper chase (card 52c96c6e) follows only a STATIC `./_*.mjs` specifier — a DYNAMIC
//        `import("./_x.mjs")` of a local helper is deliberately NOT followed (see above: it isn't hoisted,
//        so it has no hidden-timing hazard to chase), and neither is a bare-specifier/`node:`-scheme import
//        or a helper reached only by being spawned as its OWN child process (`path.join(here, "_x.mjs")`
//        handed to `child_process`/`fork` — that's a separate process with its own module graph, not an
//        import at all).
//  (v)   the "top level vs. deferred inside a function" check (`depthAt`) tracks `"`/`'` quote state but
//        not template-literal (`` ` ``) content — the SAME deferred gap `_strip-comments.mjs`'s own header
//        names for backtick content; not hit by any helper in this corpus as surveyed at card time
//        (52c96c6e: zero template-literal-bracket collisions in the reachable `./_*.mjs` graph).
// This guard's own source is excluded from the scan (its prose/fixtures mention the patterns).
//
// Run: node packages/daemon/test/createworktree-loom-home-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import os from "node:os";
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
// A STATIC import of a local `./_*.mjs` helper — `import … from "./_x.mjs"`, a bare side-effect
// `import "./_x.mjs"`, or a re-export (`export … from "./_x.mjs"`, `export * from "./_x.mjs"` — these are
// just as hoisted and module-eval-time as a plain `import`). Deliberately excludes a DYNAMIC
// `import("./_x.mjs")`/`await import("./_x.mjs")`: the required whitespace after `import`/`export`
// (`\s+`) never matches the `(` of a dynamic call — see gap (iv) above.
const LOCAL_HELPER_IMPORT_RE = /\b(?:import|export)\s+(?:[^;()'"]*\bfrom\s+)?["'](\.\/_[^"']+\.mjs)["']/g;

/** @returns {number} bracket/brace/paren nesting depth AT `index` in (comment-stripped) `text` — 0 means
 *  "top level", i.e. runs at module-evaluation time rather than being deferred inside a function/closure
 *  body. Tracks `"`/`'` quote state (bracket chars inside a quoted string don't count) with the SAME scope
 *  `_strip-comments.mjs` already accepts for its own trailing-comment cut — see gap (v) above. */
function depthAt(text, index) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < index && i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
  }
  return depth;
}

/** @returns {number} the index of the first TOP-LEVEL (`depthAt` === 0) match of `re` in `text`, or -1. */
function firstTopLevelMatch(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    if (depthAt(text, m.index) === 0) return m.index;
  }
  return -1;
}

/** @returns {string[]} the `./_*.mjs` specifiers (comment-stripped) `text` STATICALLY imports. */
function localHelperSpecs(text) {
  const specs = [];
  for (const m of text.matchAll(LOCAL_HELPER_IMPORT_RE)) specs.push(m[1]);
  return specs;
}

/** Does `helperPath` (or any `./_*.mjs` file IT statically imports, followed transitively, cycle-safe via
 *  `seen`) contain a TOP-LEVEL `../dist/` import that is NOT itself preceded, in that SAME file's own
 *  text, by a TOP-LEVEL `useOwnLoomHome(`/`LOOM_HOME=` set? A hoisted static import is evaluated before
 *  ANY of the importing module's own top-level code — including a `useOwnLoomHome(` call that textually
 *  precedes the `import` statement in the IMPORTING file — so that ordering can never beat it; only the
 *  HELPER's own internal ordering (or `requireHermeticEnv()` in the caller, checked separately) can. An
 *  unresolved specifier (the file doesn't exist — e.g. a specifier built from a runtime variable this
 *  textual scan can't follow) is treated as "nothing to flag", not a failure. */
function helperHasUnguardedTopLevelDistImport(helperPath, seen) {
  if (seen.has(helperPath)) return false;
  seen.add(helperPath);
  let raw;
  try { raw = fs.readFileSync(helperPath, "utf8"); } catch { return false; }
  const t = stripComments(raw);
  const distIdx = firstTopLevelMatch(t, DIST_IMPORT_RE);
  if (distIdx >= 0) {
    const setIdx = firstTopLevelMatch(t, HOME_SET_RE);
    if (!(setIdx >= 0 && setIdx < distIdx)) return true;
  }
  for (const spec of localHelperSpecs(t)) {
    if (helperHasUnguardedTopLevelDistImport(path.join(path.dirname(helperPath), spec), seen)) return true;
  }
  return false;
}

/** @returns {"n/a"|"pass-a"|"pass-b"|"fail"} verdict for ONE file's raw text. `baseDir`, when given, is
 *  the directory `./_*.mjs` specifiers resolve against — the hidden-helper chase (card 52c96c6e) only
 *  runs when it's provided, since the synthetic string controls below have no real file to resolve
 *  against; omitting it reproduces the pre-card f103dd2d behavior exactly. */
export function classify(raw, baseDir) {
  const t = stripComments(raw);
  const call = t.search(CALL_RE);
  if (call < 0) return "n/a";
  const hiddenUnsafeHelper = !!baseDir && localHelperSpecs(t).some((spec) =>
    helperHasUnguardedTopLevelDistImport(path.join(baseDir, spec), new Set()));
  if (!hiddenUnsafeHelper) {
    const dist = t.search(DIST_IMPORT_RE);
    const set = t.search(HOME_SET_RE);
    if (set >= 0 && dist >= 0 && set < dist) return "pass-a";
  }
  const herm = t.search(HERMETIC_RE);
  if (herm >= 0 && herm < call) return "pass-b";
  return "fail";
}

// ── (control) synthetic fixtures — each MUST classify as stated, or the predicate cannot be trusted ──────
const IMPORT = `const { createWorktree } = await import("../dist/git/worktrees.js");\nawait createWorktree(r, p, t);\n`;
const ctl = (label, src, want, baseDir) => check(`(control) ${label} → ${want}`, classify(src, baseDir) === want);
ctl("harness-only shape (the 2ed7f86e~1 specimen: sets nothing, dist import + call)", IMPORT, "fail");
ctl("useOwnLoomHome before the dist import", `useOwnLoomHome("x-");\n${IMPORT}`, "pass-a");
ctl("hand-rolled LOOM_HOME assignment before the dist import", `process.env.LOOM_HOME = tmp;\n${IMPORT}`, "pass-a");
ctl("useOwnLoomHome AFTER the dist import (order matters)", `${IMPORT}useOwnLoomHome("x-");\n`, "fail");
ctl("`==` comparison is not an assignment", `if (process.env.LOOM_HOME == null) {}\n${IMPORT}`, "fail");
ctl("LOOM_HOME set only in a comment", `// process.env.LOOM_HOME = tmp;\n${IMPORT}`, "fail");
ctl("requireHermeticEnv before the call, no pre-import set (form b)", `import { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv({ port: true });\n${IMPORT}`, "pass-b");
ctl("requireHermeticEnv AFTER the call does not count", `${IMPORT}requireHermeticEnv();\n`, "fail");
ctl("createWorktree named only in a comment → not in scope", `// createWorktree( is mentioned\nconst x = 1;\n`, "n/a");

// ── (control) the hidden-helper extension (card 52c96c6e) — needs REAL files on disk to resolve the
// `./_*.mjs` specifiers against, so these are built in their own scratch dir and cleaned up immediately
// after. This is the reproduction of the real incident: a helper's own top-level dist import, reached only
// through a STATIC import, is invisible to every check above (none of them ever read a second file).
const helperCtlDir = fs.mkdtempSync(path.join(os.tmpdir(), "cwt-guard-helper-ctl-"));
try {
  fs.writeFileSync(path.join(helperCtlDir, "_unsafe-helper.mjs"),
    'export const { x } = await import("../dist/git/worktrees.js");\n');
  fs.writeFileSync(path.join(helperCtlDir, "_safe-helper.mjs"),
    'export async function load() {\n  return await import("../dist/git/worktrees.js");\n}\n');
  fs.writeFileSync(path.join(helperCtlDir, "_wrapper-of-unsafe.mjs"),
    'export { x } from "./_unsafe-helper.mjs";\n');

  ctl("hidden top-level dist import in a STATICALLY-imported local helper (hoisting beats this file's own useOwnLoomHome)",
    `import { x } from "./_unsafe-helper.mjs";\nuseOwnLoomHome("x-");\n${IMPORT}`, "fail", helperCtlDir);
  ctl("(negative) a statically-imported helper whose OWN dist import is deferred inside a function — not a hoist-time hazard",
    `import { load } from "./_safe-helper.mjs";\nuseOwnLoomHome("x-");\nawait load();\n${IMPORT}`, "pass-a", helperCtlDir);
  ctl("transitively-unsafe helper (statically imports a wrapper that itself statically imports the real offender)",
    `import { x } from "./_wrapper-of-unsafe.mjs";\nuseOwnLoomHome("x-");\n${IMPORT}`, "fail", helperCtlDir);
  ctl("requireHermeticEnv() before the call still saves it even with a hidden unsafe helper (a runtime check, immune to hoisting)",
    `import { x } from "./_unsafe-helper.mjs";\nimport { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv({ port: true });\n${IMPORT}`, "pass-b", helperCtlDir);
  ctl("(negative) a DYNAMIC import of the same unsafe helper is NOT chased (it isn't hoisted — order already governs it)",
    `useOwnLoomHome("x-");\nconst { x } = await import("./_unsafe-helper.mjs");\n${IMPORT}`, "pass-a", helperCtlDir);
} finally {
  fs.rmSync(helperCtlDir, { recursive: true, force: true });
}

// ── the real corpus ─────────────────────────────────────────────────────────────────────────────────────
const tally = { "n/a": 0, "pass-a": 0, "pass-b": 0, fail: 0 };
const offenders = [];
for (const f of fs.readdirSync(TEST_DIR).filter((n) => n.endsWith(".mjs") && n !== SELF)) {
  const v = classify(fs.readFileSync(path.join(TEST_DIR, f), "utf8"), TEST_DIR);
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
