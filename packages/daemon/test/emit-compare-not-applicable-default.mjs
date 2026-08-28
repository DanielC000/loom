import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4def0708 — THE DEFAULTED-VALUE DEFECT, at its actual source: `computeEmitCompareGate`'s internal
// `notEligible(reason, notApplicable = false)` let 12 of 16 call sites silently stamp the INFORMATIVE
// value (`notApplicable:false`, i.e. "a real, decided, proven-not-reduced verdict"), including three
// (`:2636` git error, `:2638` empty diff, `:2654` unparseable line) that are MECHANISM failures, not
// verdicts about reducibility. Fixed by replacing the single defaulted constructor with two explicitly-
// named ones (`notReducible`/`notApplicableHere`) so no call site can express the wrong one by omission.
//
// THIS FILE proves the DISCRIMINATING pair DoD-3 requires, directly at the producer (no real git needed —
// `computeEmitCompareGate`'s own `deps.gitFactory` seam replaces `git.raw` entirely, so these are pure,
// fast, non-flaky unit calls, not integration tests through a real repo):
//   (P1) a git ERROR reading the diff -> notApplicable:true (was `false` pre-fix — the exact `:2636` site).
//   (P2) an EMPTY diff -> notApplicable:true (was `false` pre-fix — the exact `:2638` site).
//   (P3) an UNPARSEABLE diff line (no tab) -> notApplicable:true (was `false` pre-fix — the exact `:2654`
//        site — this shape cannot occur from real `git diff --name-status` output, so a real-git
//        integration test could never reach it; the injected seam is the ONLY way to exercise it at all).
//   (P4) the PAIRED predicate-RAN-and-decided-no control DoD-3 also requires: a real, reproducible verdict
//        about the diff's own content (an ADDED, not MODIFIED, compiled .ts file — the `:2682` site) must
//        stay the INFORMATIVE `notApplicable:false` — proving this fix narrowed the true set without also
//        erasing the genuinely-decided cases. A test that only exercised (P1)-(P3) would prove nothing:
//        both the old defaulted code and a naively-always-true "fix" would pass those alone.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-not-applicable-default.mjs
import { computeEmitCompareGate } from "../dist/git/worktrees.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Dummy identifiers — the injected `gitFactory` below answers every `git.raw(...)` call itself, so no real
// repo/worktree ever needs to exist on disk for any of these four cases.
const REPO = "unused-repo-path";
const WORKTREE = "unused-worktree-path";
const BASE = "base-sha";
const REF = "branch-ref";

const fakeGit = (rawImpl) => ({ gitFactory: () => ({ raw: rawImpl }) });

// ── (P1) git error reading the diff -> notApplicable:true ────────────────────────────────────────────
{
  const result = await computeEmitCompareGate(REPO, WORKTREE, BASE, REF, fakeGit(async () => { throw new Error("simulated git failure"); }));
  check("(P1) eligible:false", result.eligible === false);
  check("(P1) reason IS the git-error reason", /git error reading the diff/.test(result.reason ?? ""));
  check("(P1) notApplicable:true — a git error proves nothing about reducibility (card 4def0708 fix)", result.notApplicable === true);
}

// ── (P2) empty diff -> notApplicable:true ─────────────────────────────────────────────────────────────
{
  const result = await computeEmitCompareGate(REPO, WORKTREE, BASE, REF, fakeGit(async () => ""));
  check("(P2) eligible:false", result.eligible === false);
  check("(P2) reason IS the empty-diff reason", /empty diff/.test(result.reason ?? ""));
  check("(P2) notApplicable:true — nothing to prove inert from is not a decided verdict (card 4def0708 fix)", result.notApplicable === true);
}

// ── (P3) unparseable diff line (no tab) -> notApplicable:true ────────────────────────────────────────
{
  const result = await computeEmitCompareGate(REPO, WORKTREE, BASE, REF, fakeGit(async () => "this-line-has-no-tab-separator"));
  check("(P3) eligible:false", result.eligible === false);
  check("(P3) reason IS the unparseable-line reason", /unparseable diff line/.test(result.reason ?? ""));
  check("(P3) notApplicable:true — a malformed line is a parse failure, not a verdict (card 4def0708 fix)", result.notApplicable === true);
}

// ── (P4) PAIRED CONTROL — a real, decided-no verdict must stay notApplicable:false ────────────────────
{
  const result = await computeEmitCompareGate(REPO, WORKTREE, BASE, REF, fakeGit(async () => "A\tpackages/daemon/src/example.ts"));
  check("(P4) eligible:false", result.eligible === false);
  check("(P4) reason IS the non-modify-status reason", /non-modify status/.test(result.reason ?? ""));
  check("(P4) notApplicable:false — a real, reproducible verdict about THIS diff's content, never erased by the fix", result.notApplicable === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeEmitCompareGate's three mechanism-failure sites (git error / empty diff / unparseable line) now report notApplicable:true (omit), never a fabricated decided-not-reduced false; a genuine content-based verdict (non-modify status) still reports notApplicable:false, unchanged (card 4def0708)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
