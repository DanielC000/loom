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
//
// Card fd0d34da adds the coarse `notApplicableKind` classification ON TOP of the above (this file's own
// producer-level seam is the cheapest place to prove it — no real git repo needed):
//   (P5a) Code Review BLOCKING FIX, re-authored: "repo-out-of-domain" is a claim about the REPO's own
//        tree, never inferred from a diff's changed-path set alone — a diff whose ONLY changed path sits
//        outside all four scopes, on a repo whose tree GENUINELY has none of the four scope directories
//        (the `git ls-tree` domain check returns empty) -> notApplicableKind: "repo-out-of-domain". This is
//        the ONLY specimen of that kind this file can produce: the earlier version of this test asserted
//        "repo-out-of-domain" from a diff-only check against an unambiguously Loom-MONOREPO path
//        (packages/shared/**) — i.e. it CERTIFIED the exact defect Code Review caught (a wrong REPO-level
//        claim from diff-only evidence), green, because nothing here ever consulted the repo's own tree.
//   (P5b) THE CASE NOTHING COVERED BEFORE THIS FIX — an IN-DOMAIN repo (the domain check returns non-empty:
//        packages/daemon/src DOES exist in this repo's tree) whose branch-vs-main diff simply doesn't touch
//        it (e.g. a packages/shared-only change) -> notApplicableKind: "path-out-of-scope", NOT
//        "repo-out-of-domain" — the predicate applies to this repo fine, just not to this diff. This is the
//        real Loom-shaped-merge shape the pre-fix code silently mislabeled.
//   (P5c) the domain check ITSELF failing (a real git mechanism failure, not a decided verdict either way)
//        -> notApplicableKind: "git-operation-failed", NEVER a guessed "repo-out-of-domain" — an
//        unresolvable check must fail closed to the mechanism-failure bucket, not to a confident answer it
//        couldn't actually verify.
//   (P6) PATH-OUT-OF-SCOPE: a diff with an IN-SCOPE path (a comment-only-shaped compiled file — this seam
//        never reaches the transpile-compare step, so its content doesn't matter here) FOLLOWED by an
//        out-of-scope path -> notApplicableKind: "path-out-of-scope" — the diff DOES touch scope
//        elsewhere, so the predicate applies to this repo fine, just not to every path in THIS diff. The
//        exact FIRST-TERMINAL-WINS ordering EmitCompareGateResult.notApplicable's own doc names. (This
//        scenario's own diff-level check alone decides it — the repo-tree domain check added for (P5a)-
//        (P5c) never even runs here, since `repoHasAnyInScopePath` already short-circuits it.)
//   (P7) each of (P1)-(P3)'s three mechanism-failure sites gets its OWN distinct kind — never all three
//        collapsed onto one bucket: "git-operation-failed" / "empty-diff" / "unparseable-diff" respectively.
//   (P8) NEGATIVE CONTROL, paired with (P4): the real decided-no verdict must carry NO notApplicableKind at
//        all (`undefined`) — this field is set IFF notApplicable:true, never alongside a genuine false.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-not-applicable-default.mjs
import { computeEmitCompareGate } from "../dist/git/worktrees.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Dummy identifiers — the injected `gitFactory` below answers every `git.raw(...)` call itself, so no real
// repo/worktree ever needs to exist on disk for any of these four cases.
const WORKTREE = "unused-worktree-path";
const BASE = "base-sha";
const REF = "branch-ref";

const fakeGit = (rawImpl) => ({ gitFactory: () => ({ raw: rawImpl }) });

// ── (P1) git error reading the diff -> notApplicable:true ────────────────────────────────────────────
{
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, fakeGit(async () => { throw new Error("simulated git failure"); }));
  check("(P1) eligible:false", result.eligible === false);
  check("(P1) reason IS the git-error reason", /git error reading the diff/.test(result.reason ?? ""));
  check("(P1) notApplicable:true — a git error proves nothing about reducibility (card 4def0708 fix)", result.notApplicable === true);
  check("(P7, card fd0d34da) notApplicableKind: \"git-operation-failed\"", result.notApplicableKind === "git-operation-failed");
}

// ── (P2) empty diff -> notApplicable:true ─────────────────────────────────────────────────────────────
{
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, fakeGit(async () => ""));
  check("(P2) eligible:false", result.eligible === false);
  check("(P2) reason IS the empty-diff reason", /empty diff/.test(result.reason ?? ""));
  check("(P2) notApplicable:true — nothing to prove inert from is not a decided verdict (card 4def0708 fix)", result.notApplicable === true);
  check("(P7, card fd0d34da) notApplicableKind: \"empty-diff\"", result.notApplicableKind === "empty-diff");
}

// ── (P3) unparseable diff line (no tab) -> notApplicable:true ────────────────────────────────────────
{
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, fakeGit(async () => "this-line-has-no-tab-separator"));
  check("(P3) eligible:false", result.eligible === false);
  check("(P3) reason IS the unparseable-line reason", /unparseable diff line/.test(result.reason ?? ""));
  check("(P3) notApplicable:true — a malformed line is a parse failure, not a verdict (card 4def0708 fix)", result.notApplicable === true);
  check("(P7, card fd0d34da) notApplicableKind: \"unparseable-diff\"", result.notApplicableKind === "unparseable-diff");
}

// ── (P4) PAIRED CONTROL — a real, decided-no verdict must stay notApplicable:false ────────────────────
{
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, fakeGit(async () => "A\tpackages/daemon/src/example.ts"));
  check("(P4) eligible:false", result.eligible === false);
  check("(P4) reason IS the non-modify-status reason", /non-modify status/.test(result.reason ?? ""));
  check("(P4) notApplicable:false — a real, reproducible verdict about THIS diff's content, never erased by the fix", result.notApplicable === false);
  check("(P8, card fd0d34da — NEGATIVE CONTROL) notApplicableKind is undefined — never stamped alongside a genuine decided-no verdict", result.notApplicableKind === undefined);
}

// Shared diff for (P5a)/(P5b)/(P5c): a single out-of-scope changed path, so `repoHasAnyInScopePath` alone
// is false and the code MUST fall through to the repo-tree domain check to decide the kind.
const OUT_OF_SCOPE_ONLY_DIFF = "M\tpackages/shared/src/foo.ts";
// Routes by git subcommand — the "diff" call (the classification loop's own read) vs the "ls-tree" call
// (the repo-tree domain check added by Code Review's fix) — so each scenario below can answer them
// differently, exactly like a real repo with two genuinely different queries would.
const routedGit = (diffOutput, lsTreeImpl) => fakeGit(async (args) => {
  if (args.includes("ls-tree")) return lsTreeImpl(args);
  return diffOutput;
});

// ── (P5a, card fd0d34da — RE-AUTHORED per Code Review) REPO-OUT-OF-DOMAIN, now a REPO-level fact ────────
{
  // The domain check itself returns EMPTY — none of the four scope directories exist anywhere in this
  // repo's tree, independent of what this one diff happens to touch.
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, routedGit(OUT_OF_SCOPE_ONLY_DIFF, async () => ""));
  check("(P5a) eligible:false", result.eligible === false);
  check("(P5a) reason IS the out-of-scope catch-all", /path outside emit-compare scope/.test(result.reason ?? ""));
  check("(P5a) notApplicable:true", result.notApplicable === true);
  check("(P5a) notApplicableKind: \"repo-out-of-domain\" — the REPO-TREE domain check (not just this diff) found none of the four scope directories", result.notApplicableKind === "repo-out-of-domain");
}

// ── (P5b, card fd0d34da — THE CASE THE PRE-FIX CODE SILENTLY MISLABELED) IN-DOMAIN repo, zero-in-scope
//        diff -> "path-out-of-scope", NOT "repo-out-of-domain" ──────────────────────────────────────────
{
  // SAME out-of-scope-only diff as (P5a) — the ONLY difference is what the repo-tree domain check reports.
  // A real repo would answer this identically for BOTH scenarios' diff, since it's asking about the TREE,
  // not the diff — this is exactly why a diff-only check (the pre-fix code) could never tell them apart.
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, routedGit(OUT_OF_SCOPE_ONLY_DIFF, async (args) => {
    check("(P5b) sanity: the domain check's ls-tree call actually names ref and the four scope dirs", args.includes(REF) && args.some((a) => a.includes("packages/daemon/src")));
    return "packages/daemon/src\npackages/daemon/test";
  }));
  check("(P5b) eligible:false", result.eligible === false);
  check("(P5b) notApplicable:true", result.notApplicable === true);
  check("(P5b) notApplicableKind: \"path-out-of-scope\" — the repo's OWN tree has scope directories even though THIS diff doesn't touch them; asserting repo-out-of-domain here would be the exact Code Review finding (a wrong REPO claim from diff-only evidence)", result.notApplicableKind === "path-out-of-scope");
}

// ── (P5c, card fd0d34da) the domain check ITSELF fails -> "git-operation-failed", NEVER a guessed verdict ─
{
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, routedGit(OUT_OF_SCOPE_ONLY_DIFF, async () => { throw new Error("simulated ls-tree failure"); }));
  check("(P5c) eligible:false", result.eligible === false);
  check("(P5c) notApplicable:true", result.notApplicable === true);
  check("(P5c) notApplicableKind: \"git-operation-failed\" — an unresolvable domain check must fail closed to the mechanism-failure bucket, never a confident (and here, WRONG) \"repo-out-of-domain\"", result.notApplicableKind === "git-operation-failed");
}

// ── (P6, card fd0d34da) PATH-OUT-OF-SCOPE: the diff ALSO touches an in-scope path elsewhere ──────────────
{
  // First entry is IN SCOPE (a real modified compiled file — this seam never reaches the transpile-compare
  // step, so its content is irrelevant); the SECOND entry is what actually trips the catch-all. Mirrors the
  // FIRST-TERMINAL-WINS ordering EmitCompareGateResult.notApplicable's own doc names — the in-scope path
  // must be seen in the WHOLE diff, not just what the loop consumed before returning.
  const result = await computeEmitCompareGate(WORKTREE, BASE, REF, fakeGit(async () =>
    "M\tpackages/daemon/src/example.ts\nA\tpackages/web/src/helper.ts"));
  check("(P6) eligible:false", result.eligible === false);
  check("(P6) reason IS the out-of-scope catch-all, naming the SECOND (out-of-scope) path", /path outside emit-compare scope: packages\/web\/src\/helper\.ts/.test(result.reason ?? ""));
  check("(P6) notApplicable:true", result.notApplicable === true);
  check("(P6) notApplicableKind: \"path-out-of-scope\" — the SAME diff also touches an in-scope path, so the predicate applies to this repo, just not to every path here", result.notApplicableKind === "path-out-of-scope");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeEmitCompareGate's three mechanism-failure sites (git error / empty diff / unparseable line) now report notApplicable:true (omit), never a fabricated decided-not-reduced false; a genuine content-based verdict (non-modify status) still reports notApplicable:false, unchanged (card 4def0708). Card fd0d34da: each notApplicable:true site now carries its OWN distinct notApplicableKind (never collapsed onto one bucket); a genuine decided-no verdict carries no notApplicableKind at all; and — per Code Review's blocking finding on this card's first pass — repo-out-of-domain vs path-out-of-scope is now correctly decided from a REAL repo-tree domain check (git ls-tree), not from this one diff's changed-path set alone: an in-domain repo whose diff happens to touch no in-scope path reads path-out-of-scope (never the confidently-wrong repo-out-of-domain the pre-fix code would have stamped), a genuinely out-of-domain repo's tree check correctly reads empty, and a failed domain check itself fails closed to git-operation-failed rather than guessing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
