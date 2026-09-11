import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card f349f5cb — a cheap, source-text pin of the ONE thing
// recycle-successor-dies-before-session-start.mjs and recycle-successor-double-recycle-chain.mjs cannot
// prove: both drive `SessionService.reconcileNeverStartedRecycleSuccessor` via their OWN `events.onExit`
// shim (mirroring index.ts's real onExit hook body, never importing it), so neither proves that index.ts's
// REAL onExit hook actually calls the method, or that it runs AFTER `sessions.archiveOnExit(exited)` (the
// same relative order both fixture shims assume). This file closes that specific gap — and ONLY that gap;
// it says nothing about the METHOD's own behavior (covered by the two files above).
//
// Reads packages/daemon/src/index.ts's raw SOURCE text (never dist/**), strips comments FIRST (Code
// Review pass 2 minor-2: a bare `indexOf` over raw text would match a commented-out call just as readily
// as a real one — the same trap codescape-supervisor-shutdown-wiring.mjs's own header names; this file
// reuses that file's `stripComments` helper verbatim), then asserts by plain substring search over the
// comment-stripped text:
//   (1) the exact call site exists: `sessions.reconcileNeverStartedRecycleSuccessor(exited.id,
//       info.intended)` — threading `info.intended` through so it lands in the recycle_failed event's own
//       `detail` for audit (per Code Review finding 1); it feeds ONLY that detail, never the
//       recycleTeardownInFlight/hasSuccessor guards themselves, which don't take `intended` as an input.
//   (2) it appears AFTER `sessions.archiveOnExit(exited)` in the same onExit hook body — the ordering
//       recycle-successor-dies-before-session-start.mjs's own shim assumes.
//
// NEGATIVE CONTROLS:
//   - a bogus substring that does NOT appear anywhere returns `-1` from `indexOf`, proving this search
//     mechanism can actually fail rather than vacuously matching everything.
//   - a SYNTHETIC source string where the real call is commented out (`// sessions.reconcile...`) must be
//     reported as ABSENT once comments are stripped — proving the stripper (not a bare `indexOf`) is what
//     actually governs the result, per minor-2.
//
// Run: node test/recycle-successor-onexit-wiring.mjs (no build needed — reads TypeScript SOURCE directly)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Verbatim from codescape-supervisor-shutdown-wiring.mjs (the established per-line discipline this repo
// already uses for exit-code-verdict-guard.mjs / harness-adapter-claude-literal-guard.mjs too): a line
// inside a `/* ... */` block, or whose trimmed text starts with `//`/`*`, is excluded; a trailing `//`
// comment on an otherwise-real code line is cut.
function stripComments(source) {
  const state = { inBlock: false };
  const kept = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (state.inBlock) {
      if (trimmed.includes("*/")) state.inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) state.inBlock = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue; // JSDoc/block-comment continuation
    kept.push(raw.replace(/(?<!:)\/\/.*/, ""));
  }
  return kept.join("\n");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const indexTsPath = path.join(here, "..", "src", "index.ts");
const rawSrc = fs.readFileSync(indexTsPath, "utf-8");
const src = stripComments(rawSrc);

const callNeedle = "sessions.reconcileNeverStartedRecycleSuccessor(exited.id, info.intended)";
const archiveNeedle = "sessions.archiveOnExit(exited)";

// --- negative control 1: prove indexOf can actually miss something, before trusting a hit ---
const bogus = "totallyBogusTokenThatShouldNeverExist_f349f5cb_control";
check("(negative control 1) a bogus token is NOT found in the comment-stripped index.ts (proves the search can fail)",
  src.indexOf(bogus) === -1);

// --- negative control 2 (minor-2): a commented-out call must NOT match once comments are stripped ---
const commentedOutSynthetic = `      if (exited && exited.role !== "run") sessions.archiveOnExit(exited);\n      // ${callNeedle}\n`;
const strippedSynthetic = stripComments(commentedOutSynthetic);
check("(negative control 2) sanity: the synthetic source's raw text DOES contain the call (else the control proves nothing)",
  commentedOutSynthetic.indexOf(callNeedle) !== -1);
check("(negative control 2) a commented-out call is REPORTED ABSENT once comments are stripped — the stripper, not a bare indexOf, governs this test",
  strippedSynthetic.indexOf(callNeedle) === -1);

const callIdx = src.indexOf(callNeedle);
const archiveIdx = src.indexOf(archiveNeedle);

check("(1) index.ts's onExit hook calls reconcileNeverStartedRecycleSuccessor(exited.id, info.intended) verbatim, in real CODE (not merely mentioned in a comment)",
  callIdx !== -1);
check("(setup precondition) index.ts's onExit hook calls archiveOnExit(exited) verbatim in real CODE (needed to check ordering against)",
  archiveIdx !== -1);
check("(2) the reconcile call appears AFTER the archiveOnExit call in source order",
  callIdx !== -1 && archiveIdx !== -1 && callIdx > archiveIdx);

console.log(failures === 0
  ? "\n✅ ALL PASS — index.ts's real onExit hook wires reconcileNeverStartedRecycleSuccessor(exited.id, info.intended) after archiveOnExit(exited), exactly as recycle-successor-dies-before-session-start.mjs's own shim assumes — verified comment-stripped, so a commented-out call (or an adjacent explanatory comment mentioning the same symbol) can't mask a dropped real one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
