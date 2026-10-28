import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 26084115 — route a merge-path CanonicalGitRefusal through canonicalFailureMessage, never a
// bare describeGitFailure(e).text/.message/String(e); never prefix its output with a literal
// "<label> refused: " (its own refusal branches already open with "refused," — doubles otherwise).
//
// Full narrative + the standing negative-control recipe: docs/decisions/26084115-canonical-refusal-
// guidance-render-sites.md (pin --ref a4adc243 — card 26084115's own base, not the default --ref HEAD).
//
// This file covers, through REAL production call sites against REAL git repos/worktrees:
// (A) batch-merge.ts's landBranchCommitsIndividually — the identity-fallback probe catch.
// (B) worktrees.ts's mergeMainIntoWorktree — the identity-fallback probe catch.
// (C) batch-merge.ts's landBranchCommitsIndividually — its FIRST call (the branch-tip resolve), a
//     REDIRECT-kind refusal at a SHORT path (card a3a632fa's "second render pattern").
// (D) worktrees.ts's mergeBranchLocked (via the exported mergeBranch) — the identity-fallback probe
//     catch (already fixed by 26084115, never exercised until this card).
// (E) batch-merge.ts's landBranchCommitsIndividually — the rollback render where resetError is itself a
//     CanonicalGitRefusal (already fixed by 26084115, never exercised until this card).
// (F) batch-merge.ts's landBranchCommitsIndividually — the SAME rollback render, but resetError is an
//     ORDINARY (non-refusal) git failure — must say "reset --hard failed:", never "refused" (card a3a632fa
//     round 2).
//
// Card 2968815c (follow-up to 26084115/a3a632fa's own "Do not" list, which named these three gaps
// explicitly rather than claim them already covered):
// (G) batch-merge.ts's landBranchCommitsIndividually — five POST-mutation cherry-pick-loop catches
//     (the empty-stage probe, the original-commit-metadata read, the pre-commit `write-tree` capture, the
//     post-commit HEAD verify, and the final post-loop HEAD read), table-driven: each isolates its OWN
//     targeted call as the one that throws a real CanonicalGitRefusal.
// (H) batch-merge.ts's landBranchCommitsIndividually — the cut-base-ancestry PRE-mutation probe, a
//     refusal/ordinary-error regression pair: before the fix EVERY probe failure (refusal or not) rendered
//     the same "transient git/host condition... re-confirm" wording, which is false for a structural
//     CanonicalGitRefusal.
// (I) worktrees.ts's mergeMainIntoWorktree — the main-tip read's own `transient` flag, which used to be
//     computed BEFORE describeGitFailure(e) existed and so was never gated on `!d.refusal` like this
//     function's own siblings (the owed-landing commit-tree/fast-forward catches).
//
// Card 2968815c, Code Review follow-up round (closing the two sites its own Code Review found the first
// round's fix had missed):
// (J) batch-merge.ts's landBranchCommitsIndividually — rollback()'s own POST-reset verification probe
//     (the HEAD/status/CHERRY_PICK_HEAD reads), reached when `reset --hard` itself succeeds cleanly but
//     one of those reads throws a real CanonicalGitRefusal — distinct from (E)/(F), where the reset
//     itself throws.
// (K) batch-merge.ts's landedTreeDivergesFromExpected (the post-commit content-check against the
//     branch's reviewed tip) — its own `merge-tree`/`rev-parse .../diff` reads used to return a bare
//     `(e as Error).message` for the caller to render raw; now the caller routes the returned error
//     object through describeGitFailure/canonicalFailureMessage.
//
// NOT every merge-path CanonicalGitRefusal render site anywhere in the codebase is covered by this file —
// only the sites listed (A)-(K) above. See card 26084115's own "Do not" list for sites deliberately out
// of scope (the batch post-mutation cherry-pick loop and mergeBranchLocked's PRE-probe entry reads were
// each already closed by a separate card/commit before this file grew to cover them here).
//
// Run: 1) pnpm build, 2) node packages/daemon/test/canonical-refusal-guidance-on-every-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist", "git");
const { assembleBatchBranches } = await import(pathToFileURL(path.join(distDir, "batch-merge.js")).href);
const { mergeMainIntoWorktree, mergeBranch } = await import(pathToFileURL(path.join(distDir, "worktrees.js")).href);
const { CanonicalGitPinMismatchRefusal, CanonicalGitCommondirRefusal, describeGitFailure, canonicalFailureMessage, canonicalGit, defaultTrustedMainRoot } = await import(pathToFileURL(path.join(distDir, "bounded.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-crgs-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=setup@loom", "-c", "user.name=setup", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

// A realistic ~140-char Loom-worktree-shaped path — long enough (combined with its own repeated
// appearance in the real production template) to push the raw reason well past the 400-char cap, with
// the guidance clause landing after the cut — never a bare "x".repeat(N)" synthetic that wouldn't
// resemble what actually trips this in production.
function longWorktreeShapedPath(label) {
  return path.win32.join(
    "C:", "Users", "example", ".loom-worktrees",
    `${label}-11111111-2222-3333-4444-555555555555`,
    "666677778888aaaabbbbccccddddeeeeffff0000111122223333",
    "packages", "daemon",
  );
}

const liveToplevel = longWorktreeShapedPath("live");
const pinnedToplevel = longWorktreeShapedPath("pinned");
check("(precondition) the synthetic live toplevel is realistically long (~140 chars)", liveToplevel.length > 120 && liveToplevel.length < 170);
check("(precondition) the synthetic pinned toplevel is realistically long too", pinnedToplevel.length > 120 && pinnedToplevel.length < 170);

// Mirrors checkCommondirTrust's own real pinMismatch template (git/bounded.ts) byte-for-byte, so the
// truncation behavior measured below is the SAME shape production actually hits — never a hand-wavy
// stand-in message.
const pinnedAt = "2026-01-01T00:00:00.000Z";
const rawReason = `canonicalGit: refusing — live toplevel is now "${liveToplevel}" (was pinned to "${pinnedToplevel}" at ${pinnedAt}, source "bind") for "${liveToplevel}". A worker can cause this (e.g. running "git init" inside a pinned subdir) — verify on disk that the change was made by a human and is intended BEFORE re-pinning (POST /api/projects/:id/commondir-trust-pin/repin, expectedToplevel="${liveToplevel}"); if unsure, escalate to the Platform Lead and do not re-pin (docs/decisions/3a5c5d4a round 5, card a8bc0404).`;
check("(precondition) the realistic raw reason genuinely exceeds the 400-char cap", rawReason.length > 400);

const injectedError = new CanonicalGitPinMismatchRefusal(rawReason, pinnedToplevel, liveToplevel);
const describedFailure = describeGitFailure(injectedError);
check("(precondition) describeGitFailure classifies it as a pinMismatch", describedFailure.pinMismatch === true && describedFailure.text.length === 400);
// Case-insensitive on purpose: checkCommondirTrust's own RAW message (bounded.ts) says "verify on disk",
// canonicalFailureMessage's own FIXED-TEMPLATE rendering says "verify ON DISK" — same guidance, different
// casing between the two real production strings; this test is about the clause surviving, not its case.
const ciIncludes = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());
const guidanceSubstrings = ["verify on disk", "Platform Lead", "commondir-trust-pin/repin"];
for (const s of guidanceSubstrings) {
  check(`(precondition) the bare, pre-fix 400-char-capped .text LACKS the guidance clause "${s}" — this is exactly what the pre-fix render sites showed`, !ciIncludes(describedFailure.text, s));
}
check("(precondition, sanity) canonicalFailureMessage itself DOES carry every guidance clause (unit-level, already covered by canonical-git-commondir-refusal.mjs — restated here only as a baseline before the end-to-end checks below)", guidanceSubstrings.every((s) => ciIncludes(canonicalFailureMessage(describedFailure, "fallback"), s)));

// A SHORT, realistic worktree-shaped path — the opposite extreme from the deliberately long `rawReason`
// above. Hoisted to module scope (card 2968815c) so both (C) and (G) share it: a REDIRECT-kind refusal's
// raw reason never carries the escalation/"do not retry" guidance regardless of length (that wording
// lives ONLY in canonicalFailureMessage's fixed template for this kind) — unlike `rawReason` above, whose
// guidance clauses are part of the RAW text itself and so survive even a bare, unclassified `.message`
// render; a bare-`.message` fault test needs THIS shape to actually discriminate pre/post-fix.
const shortWorktreePath = "C:\\lw\\a1b2c3d4";
check("(precondition) the short path is genuinely short (never 400-char-truncated)", shortWorktreePath.length < 100);
// Mirrors checkCommondirTrust's real "FILE-shaped .git, no trustedMainRoot supplied" redirect template
// (git/bounded.ts) byte-for-byte, with the short path substituted in.
const redirectRawReason = `canonicalGit: refusing — "${shortWorktreePath}" has a FILE-shaped .git (a linked worktree or --separate-git-dir pointer) and this call supplied no trustedMainRoot to verify it against — refusing rather than trusting an unverified pointer by default (docs/decisions/3a5c5d4a).`;
check("(precondition) the redirect raw reason itself is well under the 400-char cap", redirectRawReason.length < 400);
const redirectGuidance = ["HUMAN escalation", "Platform Lead", "do not retry"];
for (const s of redirectGuidance) {
  check(`(precondition) the bare, UNTRUNCATED redirect raw reason still LACKS the guidance clause "${s}" — distinct from (A)/(B)'s truncation-caused gap`, !redirectRawReason.toLowerCase().includes(s.toLowerCase()));
}

// A test seam, not a shortcut: `unpinnedProbeFactoryFromLegacy`'s own doc comment (git/bounded.ts) names
// `identityProbeGitFactory` as exactly the lever "a test needing the pin should pass" to fault-inject the
// identity probe's own git handle — the SAME seam canonical-git-commondir-refusal.mjs's scenario (11) and
// batch-merge-identity-fallback.mjs already rely on. Only the PROBE's `raw()` call is faulted; every
// other git call in the real `assembleBatchBranches`/`mergeMainIntoWorktree`/`mergeBranch` code under
// test is real.
const identityProbeGitFactory = () => ({
  raw: async () => { throw new CanonicalGitPinMismatchRefusal(rawReason, pinnedToplevel, liveToplevel); },
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (A) batch-merge.ts — landBranchCommitsIndividually's identity-fallback probe catch, exercised through
// the real, exported `assembleBatchBranches`.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("batch");
  const branch = `loom/crgs-batch-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const candidate = { workerSessionId: "crgs-wkr", taskId: "crgs-task", branch, taskTitle: "feat(test): crgs" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { identityProbeGitFactory });

  check("(A) sanity: the candidate was dropped (identity probe refusal), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(A) sanity: the drop reason is the identity-fallback probe refusal this card's fix touches", reason.includes("identity-fallback probe:"));
  check('(A) the drop reason does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  check("(A) the batch-merge rejection reason carries the LIVE toplevel", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(A) the batch-merge rejection reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (B) worktrees.ts — mergeMainIntoWorktree's identity-fallback probe catch ("union-merge"), exercised
// through the real, exported function. A worktree cut BEFORE main advances further (never caught up by
// the early merge-base shortcut) reproduces the real "late-range union" shape this catch sits in.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("union");
  const wt = path.join(os.tmpdir(), `loom-crgs-union-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-union-${sfx}`, wt, "HEAD"], { cwd: repo });

  // Main advances AFTER the worktree was cut — the worktree's HEAD no longer has main's new tip as an
  // ancestor, so mergeMainIntoWorktree's own merge-base shortcut does not short-circuit before the
  // identity probe is reached.
  fs.writeFileSync(path.join(repo, "mainline.txt"), `main-advance-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=setup@loom", "-c", "user.name=setup", "commit", "-q", "-m", "main advanced"], { cwd: repo });

  const result = await mergeMainIntoWorktree(repo, wt, { identityProbeGitFactory });

  check("(B) sanity: mergeMainIntoWorktree refused (identity probe refusal)", result.ok === false);
  const reason = result.ok === false ? (result.reason ?? "") : "";
  check("(B) sanity: the refusal is the identity-fallback probe refusal this card's fix touches", reason.includes("identity-fallback probe:"));
  check('(B) the refusal does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  check("(B) the worktrees.ts union-merge reason carries the LIVE toplevel", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(B) the worktrees.ts union-merge reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (C) batch-merge.ts — landBranchCommitsIndividually's FIRST call (resolving the branch tip), exercised
// through the real, exported `assembleBatchBranches`. Card a3a632fa's "second render pattern": a bare
// `${(e as Error).message}` with NO classification at all (unlike (A)/(B), which were already routed
// through `describeGitFailure(e).text`). Deliberately a REDIRECT-kind refusal (not pinMismatch) at a
// SHORT path — its raw reason never carries the escalation/"do not retry" guidance regardless of length
// (that wording lives ONLY in canonicalFailureMessage's fixed template for this kind), so this proves a
// DIFFERENT failure shape than (A)/(B)'s 400-char-truncation one: the bare raw text is short enough to
// never be truncated and still lacks the guidance entirely.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("redirect");
  const branch = `loom/crgs-redirect-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-redirect-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-c.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });
  const branchTipSha = git(wt, ["rev-parse", "HEAD"]);

  const batchWt = path.join(os.tmpdir(), `loom-crgs-redirect-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-redirect-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  // Faults every git.raw() call this branch's own landing can reach — passing `tip` (pinnedTip) below
  // skips resolveBranchTip's OWN internal (error-swallowing) read entirely, so the FIRST call to reach
  // this faulty factory is the explicit `rev-parse --verify` this card's fix touches, exactly as the
  // card's own "its rev-parse --verify is the FIRST call to hit a persistent redirect" states.
  const gitFactory = () => ({ raw: async () => { throw new CanonicalGitCommondirRefusal(redirectRawReason); } });

  const candidate = { workerSessionId: "crgs-wkr-c", taskId: "crgs-task-c", branch, tip: branchTipSha, cutBaseSha: null, taskTitle: "feat(test): crgs-c" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(C) sanity: the candidate was dropped (redirect refusal at the FIRST call), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(C) sanity: the drop reason is the branch-tip-resolve refusal this card's fix touches", reason.includes("failed to resolve branch tip:"));
  for (const s of redirectGuidance) {
    check(`(C) the fixed reason now carries the guidance clause "${s}"`, reason.toLowerCase().includes(s.toLowerCase()));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (D) worktrees.ts — mergeBranchLocked's identity-fallback probe catch, exercised through the real,
// exported `mergeBranch` (the solo squash path). Already fixed by card 26084115 — never exercised by a
// test until now.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("solo");
  const branch = `loom/crgs-solo-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-solo-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-d.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const result = await mergeBranch(repo, branch, "feat(test): crgs-solo", { identityProbeGitFactory });

  check("(D) sanity: mergeBranch (solo squash) refused (identity probe refusal)", result.ok === false);
  const reason = result.ok === false ? (result.reason ?? "") : "";
  check("(D) sanity: the refusal is the identity-fallback probe refusal this card's fix touches", reason.includes("identity-fallback probe:"));
  check('(D) the refusal does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  check("(D) the solo-merge reason carries the LIVE toplevel", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(D) the solo-merge reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (E) batch-merge.ts — landBranchCommitsIndividually's rollback() render where `resetError` is itself a
// CanonicalGitRefusal, exercised through the real, exported `assembleBatchBranches`. Already fixed by
// card 26084115 — never exercised by a test until now. Faults the empty-stage probe (forcing rollback()
// to run after a cherry-pick that otherwise succeeded cleanly) and the rollback's own `reset --hard`
// call, while every OTHER git call (including the real cherry-pick itself) goes through the REAL
// canonical git — so this is a genuine end-to-end exercise of the rollback path, not a stub.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("rollback");
  const branch = `loom/crgs-rollback-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-rollback-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  // A brand-new file — cherry-picks cleanly onto the batch worktree regardless of its own state, so the
  // empty-stage probe right after it is what we fault, never a real cherry-pick conflict.
  fs.writeFileSync(path.join(wt, "feature-e.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-rollback-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-rollback-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        // Forces rollback() to run after an otherwise-clean cherry-pick (the empty-stage probe is the
        // very next call landBranchCommitsIndividually makes after a successful cherry-pick).
        if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
          throw new Error("injected: empty-stage probe failure (forces rollback)");
        }
        if (args[0] === "reset" && args[1] === "--hard") {
          throw new CanonicalGitPinMismatchRefusal(rawReason, pinnedToplevel, liveToplevel);
        }
        return real.raw(...callArgs);
      },
    };
  };

  const candidate = { workerSessionId: "crgs-wkr-e", taskId: "crgs-task-e", branch, taskTitle: "feat(test): crgs-e" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(E) sanity: the candidate was dropped (empty-stage probe failure, rollback attempted), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(E) sanity: the drop reason names the rollback failure", reason.includes("ROLLBACK FAILED"));
  check('(E) the rollback clause is prefixed with "reset --hard" so a bare "nothing changed" clearly refers to the reset', reason.includes("reset --hard"));
  check('(E) the rollback clause does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  check("(E) the rollback clause carries the LIVE toplevel (resetError's own guidance survived)", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(E) the rollback clause carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (F) batch-merge.ts — the SAME rollback() render as (E), but `resetError` this time is an ORDINARY git
// failure (not a CanonicalGitRefusal at all — e.g. an index.lock error, a non-tree-death timeout). Card
// a3a632fa round 2: before that round's fix, this non-refusal fallback was worded "reset --hard refused:
// ...", which is FALSE for a plain failure — it may have left a partial write, unlike a genuine refusal's
// "nothing changed". It must read "reset --hard failed:" instead, and must NOT contain the word "refused"
// anywhere in the reset clause.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("rollback-f");
  const branch = `loom/crgs-rollback-f-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-rollback-f-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-f.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-rollback-f-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-rollback-f-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const ordinaryResetFailureText = "injected: ordinary reset --hard failure (not a refusal)";
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
          throw new Error("injected: empty-stage probe failure (forces rollback)");
        }
        if (args[0] === "reset" && args[1] === "--hard") {
          // A plain Error, deliberately NOT any CanonicalGitRefusal subclass — this is the non-refusal
          // branch of resetErrorMessage's composition.
          throw new Error(ordinaryResetFailureText);
        }
        return real.raw(...callArgs);
      },
    };
  };

  const candidate = { workerSessionId: "crgs-wkr-f", taskId: "crgs-task-f", branch, taskTitle: "feat(test): crgs-f" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(F) sanity: the candidate was dropped (empty-stage probe failure, rollback attempted), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(F) sanity: the drop reason names the rollback failure", reason.includes("ROLLBACK FAILED"));
  check("(F) sanity: the drop reason carries the injected ordinary failure text", reason.includes(ordinaryResetFailureText));
  check('(F) an ORDINARY (non-refusal) reset --hard failure is worded "reset --hard failed:", never "refused"', reason.includes("reset --hard failed:"));
  check('(F) an ORDINARY (non-refusal) reset --hard failure does NOT say "refused" anywhere', !reason.toLowerCase().includes("refused"));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (G) batch-merge.ts — landBranchCommitsIndividually's five POST-mutation cherry-pick-loop catches (card
// 2968815c). Each one runs AFTER the cherry-pick already landed into the batch worktree (`rollback()` is
// called first at four of the five; see the per-site comment for the fifth). Table-driven: each entry
// isolates its OWN targeted call as the one that throws a real CanonicalGitRefusal, via the same
// flip-then-delegate technique as (E)/(F), generalized to a different targeted call per entry.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
function makeOneCommitBatchCandidate(label) {
  const repo = makeRepo(`g-${label}`);
  const branch = `loom/crgs-g-${label}-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-g-${label}-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, `feature-g-${label}.txt`), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-g-${label}-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-g-${label}-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const candidate = { workerSessionId: `crgs-wkr-g-${label}`, taskId: `crgs-task-g-${label}`, branch, taskTitle: `feat(test): crgs-g-${label}` };
  return { repo, batchWt, candidate };
}

// The 3rd/4th occurrences of the EXACT 2-element `["rev-parse","HEAD"]` shape in this call tree are the
// post-commit verify and the final post-loop read, respectively — the 1st is `assembleBatchBranches`'s OWN
// pre-loop "batch sort, initial" read (runs before `landBranchCommitsIndividually` is even called), and the
// 2nd is that function's own `batchHeadBefore` read. Verified empirically (a mis-targeted 2nd-occurrence
// guess initially faulted `batchHeadBefore` instead — see this card's own decision record). No other call
// in this tree (identity probe's `var GIT_*_IDENT`, the branch-tip/cut-base/merge-base reads,
// `verifyCommitParentAndTree`'s `cat-file -p`/`rev-parse ...^{tree}`, `sortCandidatesByEarliestAuthorDate`'s
// own reads) shares this exact 2-element shape, so counting occurrences of it alone correctly isolates
// each site once the true base offset is accounted for.
const batchGSites = [
  { label: "empty-stage-probe", marker: "failed to probe staged changes after cherry-picking", matches: (args) => args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only" },
  { label: "original-commit-metadata", marker: "failed to read original commit metadata for", matches: (args) => args[0] === "log" && args[1] === "-1" },
  { label: "pre-commit-tree-capture", marker: "failed to capture the staged tree before landing", matches: (args) => args[0] === "write-tree" },
  { label: "post-commit-head-verify", marker: "failed to verify commit landed for", matches: (args, counts) => args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && (counts.revParseHead = (counts.revParseHead ?? 0) + 1) === 3 },
  { label: "final-post-loop-head-read", marker: "landed but failed to read the result", matches: (args, counts) => args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && (counts.revParseHead = (counts.revParseHead ?? 0) + 1) === 4 },
];

for (const site of batchGSites) {
  const { repo, batchWt, candidate } = makeOneCommitBatchCandidate(site.label);
  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const counts = {};
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        // @decision 2968815c — a REDIRECT-kind refusal, never the long pinMismatch `rawReason` — its
        // guidance clauses are part of the RAW text itself, so a bare `.message` render would pass this
        // check whether or not the fix is applied. See the decision record for the measured proof.
        if (site.matches(args, counts)) throw new CanonicalGitCommondirRefusal(redirectRawReason);
        return real.raw(...callArgs);
      },
    };
  };

  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check(`(G:${site.label}) sanity: the candidate was dropped, nothing landed`, landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check(`(G:${site.label}) sanity: the drop reason is this site's own catch`, reason.includes(site.marker));
  check(`(G:${site.label}) the drop reason does NOT carry the doubled "refused: refused"`, !reason.includes("refused: refused"));
  check(`(G:${site.label}) the drop reason does NOT say "transient"`, !reason.toLowerCase().includes("transient"));
  check(`(G:${site.label}) the drop reason does NOT say "re-confirm"`, !reason.toLowerCase().includes("re-confirm"));
  for (const s of redirectGuidance) {
    check(`(G:${site.label}) the drop reason carries the guidance clause "${s}"`, reason.toLowerCase().includes(s.toLowerCase()));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (H) batch-merge.ts — landBranchCommitsIndividually's cut-base-ancestry probe (card 2968815c), a
// REFUSAL/ORDINARY-ERROR regression pair, mirroring (E)/(F)'s rollback pair. PRE-mutation (runs before any
// cherry-pick this call). Before the fix, EVERY probe failure — refusal or ordinary — rendered the SAME
// "transient git/host condition... re-confirm" wording, which is false for a genuine CanonicalGitRefusal.
//
// NOTE: `forkPointUnverified` is typed on `LandResult` but is NEVER propagated to `BatchDroppedBranch` —
// confirmed at source, `dropped.push({ ...c, reason, conflict })` carries only those two fields from a
// `LandResult` — so it is not independently observable from this black-box surface. The drop REASON TEXT
// is the only guidance channel a human ever sees for a batch drop, which is exactly what (H1)/(H2) assert.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("h-refusal");
  const cutBaseSha = git(repo, ["rev-parse", "HEAD"]);
  const branch = `loom/crgs-h-refusal-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-h-refusal-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-h1.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-h-refusal-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-h-refusal-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        if (args[0] === "merge-base") throw new CanonicalGitPinMismatchRefusal(rawReason, pinnedToplevel, liveToplevel);
        return real.raw(...callArgs);
      },
    };
  };
  const candidate = { workerSessionId: "crgs-wkr-h1", taskId: "crgs-task-h1", branch, cutBaseSha, taskTitle: "feat(test): crgs-h1" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(H1) sanity: the candidate was dropped (cut-base ancestry probe refusal), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check('(H1) the drop reason does NOT say "transient"', !reason.toLowerCase().includes("transient"));
  check('(H1) the drop reason does NOT say "re-confirm"', !reason.toLowerCase().includes("re-confirm"));
  check('(H1) the drop reason does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  check('(H1) the drop reason does NOT say "failed to compute merge-base" (rules out passing via the naive merge-base catch instead of the cut-base-ancestry probe this scenario targets)', !reason.includes("failed to compute merge-base"));
  check("(H1) the drop reason carries the LIVE toplevel", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(H1) the drop reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

{
  const repo = makeRepo("h-ordinary");
  const cutBaseSha = git(repo, ["rev-parse", "HEAD"]);
  const branch = `loom/crgs-h-ordinary-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-h-ordinary-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-h2.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-h-ordinary-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-h-ordinary-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const ordinaryProbeFailureText = "injected: ordinary merge-base failure (not a refusal)";
  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        if (args[0] === "merge-base") throw new Error(ordinaryProbeFailureText);
        return real.raw(...callArgs);
      },
    };
  };
  const candidate = { workerSessionId: "crgs-wkr-h2", taskId: "crgs-task-h2", branch, cutBaseSha, taskTitle: "feat(test): crgs-h2" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(H2) sanity: the candidate was dropped (ordinary cut-base ancestry probe failure), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(H2) sanity: the drop reason carries the injected ordinary failure text", reason.includes(ordinaryProbeFailureText));
  check('(H2) an ORDINARY (non-refusal) probe failure KEEPS the "transient...re-confirm" wording (regression guard)', reason.includes("transient") && reason.includes("re-confirm"));
  check('(H2) an ORDINARY (non-refusal) probe failure does NOT say "refused" anywhere', !reason.toLowerCase().includes("refused"));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (I) worktrees.ts — mergeMainIntoWorktree's main-tip read (card 2968815c): its `transient` flag used to be
// computed from the raw error BEFORE describeGitFailure(e) existed, so — unlike this function's own
// siblings (the owed-landing commit-tree/fast-forward catches) — it was never gated on `!d.refusal`. A
// CanonicalGitRefusal whose own message happens to look timeout-shaped (embeds "exceeded Nms") proves the
// fix discriminates structurally (`instanceof CanonicalGitRefusal`), never on message-text shape alone.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("maintip-transient-gate");
  const wt = path.join(os.tmpdir(), `loom-crgs-maintip-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-maintip-${sfx}`, wt, "HEAD"], { cwd: repo });

  const timeoutShapedRefusalReason = `canonicalGit: refusing — exceeded 1234ms (host condition) for "${liveToplevel}"`;
  const gitFactory = () => ({ raw: async () => { throw new CanonicalGitPinMismatchRefusal(timeoutShapedRefusalReason, pinnedToplevel, liveToplevel); } });

  const result = await mergeMainIntoWorktree(repo, wt, { gitFactory });

  check("(I) sanity: mergeMainIntoWorktree refused (main-tip read refusal)", result.ok === false);
  const reason = result.ok === false ? (result.reason ?? "") : "";
  check("(I) sanity: the refusal is the main-tip resolve this fix touches", reason.includes("failed to resolve main tip:"));
  check("(I) a CanonicalGitRefusal with a timeout-shaped message is NEVER marked transient:true (gated on !d.refusal, matching this function's own siblings)", result.ok === false && result.transient !== true);
  for (const s of guidanceSubstrings) {
    check(`(I) the main-tip refusal reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (J) batch-merge.ts — landBranchCommitsIndividually's `rollback()` POST-reset verification probe (card
// 2968815c, item 2): reached when `reset --hard` itself SUCCEEDS cleanly but one of the probe's own reads
// (HEAD / status / CHERRY_PICK_HEAD) throws a real CanonicalGitRefusal — distinct from (E)/(F), where
// `reset --hard` itself is what throws. The "status --porcelain --untracked-files=no" call is unique to
// this probe (no other call reachable from assembleBatchBranches shares its exact args), so faulting it
// alone isolates this catch without touching resetError's own, already-covered composition.
//
// @decision 2968815c — uses the SHORT `redirectRawReason`/`CanonicalGitCommondirRefusal` shape (like
// (C)/(G)), never the long pinMismatch `rawReason`, whose guidance survives a bare `.message` render either way.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("rollback-j");
  const branch = `loom/crgs-rollback-j-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-rollback-j-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-j.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-rollback-j-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-rollback-j-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        // Forces rollback() to run after an otherwise-clean cherry-pick, same trick as (E)/(F).
        if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") {
          throw new Error("injected: empty-stage probe failure (forces rollback)");
        }
        // `reset --hard` itself is left REAL (succeeds cleanly) — distinct from (E)/(F), which fault it.
        if (args[0] === "status" && args[1] === "--porcelain") {
          throw new CanonicalGitCommondirRefusal(redirectRawReason);
        }
        return real.raw(...callArgs);
      },
    };
  };

  const candidate = { workerSessionId: "crgs-wkr-j", taskId: "crgs-task-j", branch, taskTitle: "feat(test): crgs-j" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(J) sanity: the candidate was dropped (empty-stage probe failure, rollback's own verify-probe refused), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(J) sanity: the drop reason names the rollback failure", reason.includes("ROLLBACK FAILED"));
  check("(J) sanity: the drop reason names the verify-probe's own catch", reason.includes("failed to verify the rollback left a clean tree:"));
  check('(J) the verify-probe clause does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  for (const s of redirectGuidance) {
    check(`(J) the verify-probe clause carries the guidance clause "${s}"`, reason.toLowerCase().includes(s.toLowerCase()));
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (K) batch-merge.ts — landedTreeDivergesFromExpected's own `git merge-tree --write-tree` read (card
// 2968815c, item 1): runs AFTER the branch's own commit already landed cleanly — the content-check step's
// FIRST git call, and the only bare `merge-tree` call reachable from assembleBatchBranches's own call tree
// (worktrees.ts's `merge-tree` calls, used by the SOLO path's reviewed-tip walk, always pass
// `--attr-source=...` as their own first arg and are never reached here), so faulting a bare `merge-tree`
// first arg unconditionally isolates this catch cleanly without any earlier trick needed to reach it.
//
// @decision 2968815c — uses the SHORT `redirectRawReason`/`CanonicalGitCommondirRefusal` shape (like
// (C)/(G)/(J)), never the long pinMismatch `rawReason`, whose guidance survives a bare `.message` render either way.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const repo = makeRepo("content-check");
  const branch = `loom/crgs-k-${sfx}`;
  const wt = path.join(os.tmpdir(), `loom-crgs-k-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "feature-k.txt"), `content-${sfx}\n`);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", "worker work"], { cwd: wt });

  const batchWt = path.join(os.tmpdir(), `loom-crgs-k-batchwt-${sfx}`);
  tmpDirs.push(batchWt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/crgs-k-batchwt-${sfx}`, batchWt, "HEAD"], { cwd: repo });

  const trustedMainRoot = defaultTrustedMainRoot(repo);
  const gitFactory = (p, ms) => {
    const real = canonicalGit(p, ms, undefined, undefined, undefined, trustedMainRoot);
    return {
      raw: async (...callArgs) => {
        const args = Array.isArray(callArgs[0]) ? callArgs[0] : callArgs;
        if (args[0] === "merge-tree") {
          throw new CanonicalGitCommondirRefusal(redirectRawReason);
        }
        return real.raw(...callArgs);
      },
    };
  };

  const candidate = { workerSessionId: "crgs-wkr-k", taskId: "crgs-task-k", branch, taskTitle: "feat(test): crgs-k" };
  const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate], { gitFactory });

  check("(K) sanity: the candidate was dropped (content-check's own merge-tree read refused), nothing landed", landed.length === 0 && dropped.length === 1);
  const reason = dropped[0]?.reason ?? "";
  check("(K) sanity: the drop reason names the content-check catch", reason.includes("failed to content-check the landed result against its reviewed tip"));
  check('(K) the drop reason does NOT carry the doubled "refused: refused"', !reason.includes("refused: refused"));
  for (const s of redirectGuidance) {
    check(`(K) the drop reason carries the guidance clause "${s}"`, reason.toLowerCase().includes(s.toLowerCase()));
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every CanonicalGitRefusal render site covered by THIS file's own scenarios (A)-(K) — identity-probe catches on all three surfaces, the FIRST pre-mutation setup read, the rollback render, all five POST-mutation cherry-pick-loop catches, the cut-base-ancestry probe, the main-tip read's transient-flag gate, the landed-tree content-check, and the rollback's own post-reset verify probe — keeps its human guidance, with no doubled \"refused: refused\" wording, no misclassified \"transient\"/\"re-confirm\" wording on a structural refusal, and an ORDINARY (non-refusal) failure keeps its own honest \"failed:\"/\"transient\" wording unchanged. This is NOT a claim that every merge-path render site anywhere in the codebase is covered — see this file's own header comment for the explicit list, and card 26084115's \"Do not\" list for sites deliberately out of scope."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
