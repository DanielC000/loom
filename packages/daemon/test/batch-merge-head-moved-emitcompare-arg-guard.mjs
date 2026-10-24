import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 043d83d2 — SOURCE-TEXT REGRESSION GUARD for the "pre-gate reduced-gate steer" leg. Split out of
// batch-merge-head-moved.mjs's own scenario (C) into this small, standalone file so it can be registered
// in CHANGED_TS_TEXT_SCANNER_REPO_PATHS (git/worktrees.ts) without also folding that file's much heavier
// real-git scenarios (A)/(B) into every reduced gate that touches a changed .ts file.
//
// WHY THIS CHECK EXISTS, AND WHY NO TIMING-BASED TEST CAN REPLACE IT: batch-merge-head-moved.mjs's own
// scenario (B) proves computeEmitCompareGate's OWN contract (a resolved sha is immune to what HEAD points
// to) — but that function is untouched by this card, so no revert of IT can ever flip (B). The actual fix
// for this leg is the ONE argument sessions/service.ts's batch runGate closure passes to
// computeEmitCompareGate. No timing-based test can observe a regression of just that one line: the batch
// worktree is private to one batch, and this card's OWN pre/post-gate pin checks (scenario A) already
// refuse before a decoy ref could ever reach this call in a race that doesn't also trip (A) first.
// Verified empirically (not asserted, card 043d83d2's own worker_report): with ONLY this one service.ts
// line manually reverted to the literal "HEAD" (nothing else touched), BOTH scenario (B) and the existing
// batch-merge-reduced-gate.mjs stayed fully green — proving neither is a regression test for this exact
// line. This source-text check is what closes that gap.
//
// MEMBERSHIP IN CHANGED_TS_TEXT_SCANNER_REPO_PATHS: this reads real packages/daemon/src/sessions/
// service.ts SOURCE directly (never dist/**) and pattern-matches an UNSTRIPPED, multi-token call-site
// regex — not immune under any of that list's own six documented shapes (not a string-literal-only match,
// not an extracted-function-body comparison, not comment-stripped, not a single-token presence check, not
// a byte-level property, and not a precondition already re-verified live elsewhere). A comment inserted
// INSIDE the call's argument list (between `worktreePath,` and `gateBaseMainSha,`, say) would make the
// FIXED_PATTERN check below spuriously fail even on correctly-fixed code (the `\s*` gaps match whitespace
// only, never comment trivia) — the opposite-direction failure mode from the list's usual "a decoy
// comment elsewhere keeps a broken check green" concern, but the SAME underlying fact (tsc/this raw
// reader keeps comment text, so a comment-only .ts diff can perturb this check's verdict) is exactly why
// membership here, so the reduced gate re-runs it rather than skipping it on a comment-only diff.
//
// FOURTH CODE REVIEW (item 2): also scans for the batch worktree cut passing `forkFrom: baseMainSha` to
// `createWorktree` — scenario (J) in batch-merge-head-moved.mjs proves only its OWN direct cut call does
// this; it cannot see a regression in service.ts's line, which that file never calls through.
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-head-moved-emitcompare-arg-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const serviceSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sessions", "service.ts"), "utf8",
);
const VULNERABLE_PATTERN = /computeEmitCompareGate\(\s*worktreePath,\s*gateBaseMainSha,\s*"HEAD"/;
const FIXED_PATTERN = /computeEmitCompareGate\(\s*worktreePath,\s*gateBaseMainSha,\s*assembledTipSha/;

check("positive control: the vulnerable pattern IS detectable by this regex (proves the matcher isn't vacuous)",
  VULNERABLE_PATTERN.test('const batchEmitCompare = await computeEmitCompareGate(worktreePath, gateBaseMainSha, "HEAD", { timeoutMs: this.gitOpMs }).catch(() => undefined);'));
check("negative control: a bogus pattern finds zero hits", /computeEmitCompareGate_bogus_xyz/.test(serviceSrc) === false);
check("THE FIX IS PRESENT: service.ts's batch runGate closure passes the pinned assembledTipSha", FIXED_PATTERN.test(serviceSrc));
check("THE HOLE IS GONE: service.ts no longer contains the vulnerable literal-\"HEAD\" call shape", !VULNERABLE_PATTERN.test(serviceSrc));

// Card 043d83d2 (S1, fourth Code Review item 2): the batch worktree cut must fork FROM `baseMainSha`
// explicitly — never the repo's current HEAD at cut time (scenario (J) in batch-merge-head-moved.mjs
// only proves ITS OWN direct cut call does this; it cannot see a regression in THIS service.ts line,
// since that file never calls through it). Same source-text-scan shape as the check above.
//
// `CUT_FN` splits the function NAME from its call paren so this file's OWN source text never contains
// the literal substring `createWorktree(` — createworktree-loom-home-guard.mjs's comment-stripped scan
// (card f103dd2d) matches that exact substring to find REAL calls needing a hermetic LOOM_HOME, and
// cannot tell "appears inside a pattern/string literal here" apart from "a genuine call"; this file never
// calls the function at all, only reads service.ts's own source text, so it is a true negative for that
// guard, not an exemption — do NOT allowlist, just avoid the literal substring, as that guard's own file
// does for its own fixtures (see its "this guard's own source is excluded" note for the ONE exemption it
// actually grants, which does not cover this file).
const CUT_FN = "createWorktree";
const CUT_VULNERABLE_PATTERN = new RegExp(`${CUT_FN}\\(\\s*finalRepoPath,\\s*finalProjectId,\\s*batchTaskId\\s*\\)`);
const CUT_FIXED_PATTERN = new RegExp(`${CUT_FN}\\(\\s*finalRepoPath,\\s*finalProjectId,\\s*batchTaskId,\\s*\\{\\},\\s*undefined,\\s*baseMainSha\\s*\\)`);

check("(cut) positive control: the vulnerable no-forkFrom call IS detectable by this regex",
  CUT_VULNERABLE_PATTERN.test(`wt = await ${CUT_FN}(finalRepoPath, finalProjectId, batchTaskId);`));
check("(cut) negative control: a bogus pattern finds zero hits", new RegExp(`${CUT_FN}_bogus_xyz`).test(serviceSrc) === false);
check("(cut) THE FIX IS PRESENT: the batch worktree cut passes forkFrom: baseMainSha", CUT_FIXED_PATTERN.test(serviceSrc));
check("(cut) THE HOLE IS GONE: service.ts no longer cuts the batch worktree with no forkFrom", !CUT_VULNERABLE_PATTERN.test(serviceSrc));

console.log(failures === 0
  ? "\n✅ ALL PASS — service.ts's batch gate-reduction classification is pinned to the assembled tip, never the literal \"HEAD\" (card 043d83d2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
