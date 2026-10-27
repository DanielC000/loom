import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CARD 458028ae — parity test for `predictGitCleanupWhitespace` (git/worktrees.ts) against REAL
// `git stripspace` (no flag). `git commit -m` cleans a non-interactive message under `cleanup=whitespace`
// (never `cleanup=strip`, which only applies when the message is edited in $EDITOR); `git stripspace`'s
// OWN default is also `whitespace` (it keeps `#` lines — only `--strip-comments` removes them), which is
// why this is the right real-git oracle to compare against, not `git commit -m`'s own %B directly.
// `batch-merge.ts`'s `landBranchCommitsIndividually` uses the predictor to decide, BEFORE committing,
// whether a candidate's own trailer paragraph will survive git's real cleanup — see
// docs/decisions/458028ae-predict-git-cleanup-before-batch-commit.md for the full defect this closes.
//
// 14 cases: the checkpoint's own 6 (empty, blank-first-line/the real trailer-only DoS shape, CRLF, a
// `#`-comment line, trailing whitespace, a trailer-only message), the ruling's 3 additions (a
// whitespace-only line between paragraphs, a tab-only line, multiple trailing blank lines), and the
// Code Review's own 5 (formfeed/vtab/NBSP/U+2028/BOM — each real CONTENT to git, never blank).
// Run: 1) build daemon (pnpm build), 2) node test/predict-git-cleanup-whitespace.mjs
import { execFileSync } from "node:child_process";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("pgcw-home-");
requireHermeticEnv();

const { predictGitCleanupWhitespace } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** The real-git oracle: `git stripspace` (no flag) on `message`, piped via stdin — no repo required. */
function realGitStripspace(message) {
  return execFileSync("git", ["stripspace"], { input: message, encoding: "utf8" });
}

const CASES = [
  { tag: "empty", msg: "" },
  { tag: "blank-first-line-only (collapses to nothing, like a pure-blank worker message)", msg: "\n" },
  { tag: "trailer-only (the real card 458028ae DoS shape: leading blanks + a trailer paragraph)", msg: "\n\nLoom-Worker-Branch: real\n" },
  { tag: "crlf", msg: "subject\r\n\r\nbody\r\n" },
  { tag: "hash-comment-kept (whitespace mode, never strip mode)", msg: "subject\n# comment\nbody\n" },
  { tag: "trailing-whitespace-stripped (spaces and a tab, never leading indent)", msg: "  subject   \n  body\t\n" },
  { tag: "whitespace-only-line-between-paragraphs (spaces)", msg: "subject\n   \nbody\n" },
  { tag: "tab-only-line", msg: "subject\n\t\nbody\n" },
  { tag: "multiple-trailing-blank-lines", msg: "subject\n\n\n\n" },
  // Code Review (session e8f1f410) of 458028ae, item 2: git's own blank-line classification is a NARROW
  // byte-level test ([ \t\r] only), not the broad notion of "whitespace" JS's own String.prototype.trim()
  // implements (which also strips \f/\v/NBSP/U+2028/a BOM) — each of these 5 lines is REAL CONTENT to
  // real git (MEASURED: a `git stripspace` middle line of exactly one of these survives untouched), so a
  // predictor using a generic trim-based blank test would wrongly treat it as blank and (in the real
  // defect this card fixes) wrongly drop a perfectly landable candidate.
  { tag: "formfeed-line-is-content-not-blank", msg: "subject\n\f\nbody\n" },
  { tag: "vtab-line-is-content-not-blank", msg: "subject\n\v\nbody\n" },
  { tag: "nbsp-line-is-content-not-blank", msg: "subject\n \nbody\n" },
  { tag: "unicode-line-separator-is-content-not-blank", msg: "subject\n \nbody\n" },
  { tag: "bom-line-is-content-not-blank", msg: "subject\n﻿\nbody\n" },
];

for (const c of CASES) {
  const predicted = predictGitCleanupWhitespace(c.msg);
  const real = realGitStripspace(c.msg);
  check(`(${c.tag}) predictor matches real "git stripspace" byte-for-byte`, predicted === real);
}

// Negative control (per standing doctrine — a search/assertion pair needs proof it CAN fail): a
// deliberately wrong "predictor" (the identity function) must NOT match real stripspace's output on a
// case that genuinely changes under cleanup — proving this comparison actually discriminates, rather
// than vacuously passing every case.
{
  const identityMsg = "subject   \n\n\nbody\n";
  const real = realGitStripspace(identityMsg);
  check("(negative control) a broken predictor (identity) does NOT match real stripspace on a changing case", identityMsg !== real);
  check("(negative control precondition) the real predictor DOES match on that same case", predictGitCleanupWhitespace(identityMsg) === real);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — predictGitCleanupWhitespace matches real \"git stripspace\" (cleanup=whitespace) byte-for-byte across 14 cases, including the exact leading-blank-collapse shape card 458028ae's batch-landing defect depends on predicting correctly, and that git's own blank-line test is byte-narrow (never \\f/\\v/NBSP/U+2028/a BOM, unlike a generic trim)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
