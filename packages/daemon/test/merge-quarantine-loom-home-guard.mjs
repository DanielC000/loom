import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source-text scan
// STANDING GUARD (card 500fe2df) — a test file that raises a REAL `enterMergeQuarantine(` (directly, or
// indirectly via a `mergeBranch(...)` call carrying its own `timeoutMs`, which can raise one internally on
// an unconfirmed kill) must have a temp LOOM_HOME in force BEFORE that call can reach the real
// `~/.loom/merge-quarantines/` — `merge-quarantine.ts`'s `MERGE_QUARANTINE_DIR` is `path.join(LOOM_HOME,
// "merge-quarantines")`, and `paths.ts` resolves `LOOM_HOME` at IMPORT time, same chokepoint
// `createworktree-loom-home-guard.mjs` already polices for `WORKTREES_DIR`. Six real files were found
// leaking this way at a real boot (13+ stale latches re-armed, `loom-mhdwq-*`/`loom-debug-queued-*` among
// them — the debug-queued one never matched any committed test and is believed to be a one-off manual
// invocation, not a test defect) — this guard is the backstop so a NEW file can't reintroduce the shape.
//
// WHAT THIS ASSERTS — PRESENCE + textual ORDER (NOT the value): every `packages/daemon/test/*.mjs` whose
// comment-stripped text contains a REAL `enterMergeQuarantine(` CALL (never its own `export function`
// declaration, and never a `//`/`*` comment line merely mentioning the name — same exclusion
// `quarantine-reason-windows-guidance.mjs`'s own call-site scan already uses) OR a `mergeBranch(` call
// whose SAME LINE also carries `timeoutMs` (the shape every real kill-confirmation scenario in this corpus
// uses — see GAPS (iii) below) must satisfy ONE of
//   (a) a `useOwnLoomHome(` call or a `process.env.LOOM_HOME =` assignment appears textually BEFORE the
//       first `../dist/` import (static `from`/`import` or dynamic `import(`); OR
//   (b) a `requireHermeticEnv(` call appears textually BEFORE the first triggering call — fail-closed: it
//       aborts the process unless LOOM_HOME is a temp dir, so a bare run cannot leak.
//
// GAPS, NAMED (this check does NOT cover):
//  (i)   the VALUE — `process.env.LOOM_HOME = <anything>` passes; only (b) and `_guard.mjs`'s exit hook
//        (which refuses to delete a non-tmpdir home) bring a runtime temp-dir proof.
//  (ii)  INDIRECT callers one level further removed — a test that reaches `enterMergeQuarantine` only
//        through a helper OTHER than `mergeBranch` (e.g. a future primitive this card's fix didn't touch)
//        is not scanned. Widen the trigger set here, judgment-curated, if one is found — same posture as
//        `createworktree-loom-home-guard.mjs`'s own (ii).
//  (iii) the `mergeBranch(` + `timeoutMs` trigger is SINGLE-LINE only (a regex over one line, not a real
//        call-expression AST walk) — a call whose `timeoutMs` option sits on a LATER line than the
//        `mergeBranch(` token itself is not detected. True of every real call site in this corpus as of
//        card 500fe2df (verified by hand); if a future call site wraps the options object onto its own
//        line, this guard will miss it — widen to a small brace-matching scan if that ever happens, rather
//        than assuming today's shape is permanent.
//  (iv)  textual order approximates execution order (a hoisted function defined earlier but invoked later
//        counts as "before") — same as createworktree-loom-home-guard.mjs's own (iii). A STATIC
//        `import {...} from "../dist/..."` is hoisted ahead of EVERY top-level statement in its own file
//        regardless of textual position, so predicate (a)'s "textually before" is only a valid proxy for
//        a DYNAMIC `await import(...)`. CLOSED (not just named): predicate (a) now passes ONLY when the
//        file has NO static dist import anywhere at all — `hasStaticDistImport` below, single-line only
//        (same limitation as (iii)) — a file with even one static dist import must satisfy (b) instead,
//        regardless of where a `useOwnLoomHome(`/`process.env.LOOM_HOME =` sits relative to it. This is
//        exactly the trap card 500fe2df's own fix hit in vault-commit-quarantine.mjs and
//        git-writer-kill-confirm.mjs (both converted to dynamic imports as part of that fix, specifically
//        so predicate (a) could ever apply to them).
// This guard's own source is excluded from the scan (its prose/fixtures mention the patterns).
//
// Run: node packages/daemon/test/merge-quarantine-loom-home-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DIST_IMPORT_RE = /(?:import\s*\(|from\s*|import\s+)["']\.\.\/dist\//;
// A STATIC import line: `import` followed by whitespace with NO `(` immediately after (that shape is
// always a dynamic `import(...)` expression, never a static declaration — ECMAScript grammar has no
// static form spelled `import (`/`import(` with the "import" keyword followed directly by an open paren).
// Single-line only, same limitation as DIST_IMPORT_RE/the (iii) gap above — a static import whose `from
// "../dist/..."` clause is wrapped onto a later line is not detected; see GAPS (iv).
const STATIC_DIST_IMPORT_LINE_RE = /^\s*import\s+(?!\()[^\n]*["']\.\.\/dist\//;
const HOME_SET_RE = /\buseOwnLoomHome\s*\(|process\.env\.LOOM_HOME\s*=(?!=)/;
const HERMETIC_RE = /\brequireHermeticEnv\s*\(/;

/** True iff `text` contains ANY static (non-dynamic) `../dist/` import — see STATIC_DIST_IMPORT_LINE_RE. */
function hasStaticDistImport(text) {
  return text.split("\n").some((line) => STATIC_DIST_IMPORT_LINE_RE.test(line));
}

/** Every line in `text` that calls `enterMergeQuarantine(` as a RAISE, OR `mergeBranch(` with its OWN
 *  `timeoutMs` on the same line — never a `//`/`*` comment line, never `enterMergeQuarantine`'s own
 *  `export function` declaration. Mirrors `quarantine-reason-windows-guidance.mjs`'s own
 *  `enterMergeQuarantineCallLines` exclusion logic. */
function triggerCallLines(text) {
  return text.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false; // line/block comment
    const isQuarantineRaise = line.includes("enterMergeQuarantine(") && !/^\s*export function enterMergeQuarantine\(/.test(line);
    const isTimedMergeBranch = /\bmergeBranch\s*\(/.test(line) && line.includes("timeoutMs");
    return isQuarantineRaise || isTimedMergeBranch;
  });
}

/** @returns {"n/a"|"pass-a"|"pass-b"|"fail"} verdict for ONE file's raw text */
export function classify(raw) {
  const t = stripComments(raw);
  const triggers = triggerCallLines(t);
  if (triggers.length === 0) return "n/a";
  const firstTrigger = t.indexOf(triggers[0]);
  const dist = t.search(DIST_IMPORT_RE);
  const set = t.search(HOME_SET_RE);
  // (iv): predicate (a) is only a valid proxy for "ran before the dist import" when EVERY dist import in
  // the file is dynamic — a single static one hoists ahead of everything, including a `set` that sits
  // textually earlier.
  if (set >= 0 && dist >= 0 && set < dist && !hasStaticDistImport(t)) return "pass-a";
  const herm = t.search(HERMETIC_RE);
  if (herm >= 0 && herm < firstTrigger) return "pass-b";
  return "fail";
}

// ── (control) synthetic fixtures — each MUST classify as stated, or the predicate cannot be trusted ──────
const QUARANTINE_CALL = `const { enterMergeQuarantine } = await import("../dist/git/merge-quarantine.js");\nenterMergeQuarantine(r, b, "x");\n`;
const TIMED_MERGE_CALL = `const { mergeBranch } = await import("../dist/git/worktrees.js");\nawait mergeBranch(r, b, "t", { timeoutMs: 500 });\n`;
const ctl = (label, src, want) => check(`(control) ${label} → ${want}`, classify(src) === want);
ctl("direct enterMergeQuarantine( call, nothing set → fail", QUARANTINE_CALL, "fail");
ctl("useOwnLoomHome before the dist import (quarantine call)", `useOwnLoomHome("x-");\n${QUARANTINE_CALL}`, "pass-a");
ctl("requireHermeticEnv before the call, no pre-import set (form b, quarantine call)",
  `import { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv();\n${QUARANTINE_CALL}`, "pass-b");
ctl("useOwnLoomHome AFTER the dist import (order matters, quarantine call)", `${QUARANTINE_CALL}useOwnLoomHome("x-");\n`, "fail");
ctl("the enterMergeQuarantine declaration line itself is excluded",
  `export function enterMergeQuarantine(repoPath, branch, reason) {}\n`, "n/a");
ctl("a comment merely mentioning enterMergeQuarantine( is excluded", `// enterMergeQuarantine( is mentioned\nconst x = 1;\n`, "n/a");
ctl("mergeBranch( WITHOUT timeoutMs is excluded (not a kill-confirmation shape)",
  `const { mergeBranch } = await import("../dist/git/worktrees.js");\nawait mergeBranch(r, b, "t");\n`, "n/a");
ctl("mergeBranch( WITH timeoutMs, nothing set → fail", TIMED_MERGE_CALL, "fail");
ctl("useOwnLoomHome before the dist import (timed mergeBranch call)", `useOwnLoomHome("x-");\n${TIMED_MERGE_CALL}`, "pass-a");
ctl("requireHermeticEnv before the call, no pre-import set (form b, timed mergeBranch call)",
  `import { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv();\n${TIMED_MERGE_CALL}`, "pass-b");

// (iv) — the static-import-hoisting trap itself (card 500fe2df's manager follow-up): useOwnLoomHome()
// textually BEFORE a STATIC dist import is NOT actually before it at runtime (static imports hoist), so
// predicate (a) must refuse this shape outright rather than pass it.
const STATIC_IMPORT_QUARANTINE_CALL = `import { enterMergeQuarantine } from "../dist/git/merge-quarantine.js";\nenterMergeQuarantine(r, b, "x");\n`;
ctl("(iv) useOwnLoomHome textually before a STATIC dist import + trigger → fail (hoisting defeats it)",
  `useOwnLoomHome("x-");\n${STATIC_IMPORT_QUARANTINE_CALL}`, "fail");
ctl("(iv) same STATIC dist import, but requireHermeticEnv before the call → pass-b (form (b) is immune to hoisting)",
  `import { requireHermeticEnv } from "./_guard.mjs";\nrequireHermeticEnv();\n${STATIC_IMPORT_QUARANTINE_CALL}`, "pass-b");

// ── the real corpus ─────────────────────────────────────────────────────────────────────────────────────
const tally = { "n/a": 0, "pass-a": 0, "pass-b": 0, fail: 0 };
const offenders = [];
for (const f of fs.readdirSync(TEST_DIR).filter((n) => n.endsWith(".mjs") && n !== SELF)) {
  const v = classify(fs.readFileSync(path.join(TEST_DIR, f), "utf8"));
  tally[v]++;
  if (v === "fail") offenders.push(f);
}
// Population sanity: the scan must actually have SEEN real triggering call sites, or a broken predicate
// would turn this whole guard vacuously green (paired with the controls above, which prove the predicate
// itself). Card 500fe2df's own corpus sweep found 19 direct enterMergeQuarantine( callers alone.
check(`(population) the scan saw real triggering call sites (${tally["pass-a"] + tally["pass-b"] + tally.fail}; tally ${JSON.stringify(tally)})`,
  tally["pass-a"] + tally["pass-b"] + tally.fail >= 15);
check(`every test that raises a real enterMergeQuarantine( (directly, or via a timed mergeBranch() call) sets a temp LOOM_HOME before the dist import, or requireHermeticEnv()s before the call${offenders.length ? ` — OFFENDERS: ${offenders.join(", ")} (add useOwnLoomHome("<prefix>-") + requireHermeticEnv() above the ../dist import; do NOT allowlist)` : ""}`,
  offenders.length === 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
