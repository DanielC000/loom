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

  // A SHORT, realistic worktree-shaped path — the opposite extreme from (A)/(B)'s deliberately long one.
  const shortWorktreePath = "C:\\lw\\a1b2c3d4";
  check("(C) precondition: the short path is genuinely short (never 400-char-truncated)", shortWorktreePath.length < 100);
  // Mirrors checkCommondirTrust's real "FILE-shaped .git, no trustedMainRoot supplied" redirect template
  // (git/bounded.ts) byte-for-byte, with the short path substituted in.
  const redirectRawReason = `canonicalGit: refusing — "${shortWorktreePath}" has a FILE-shaped .git (a linked worktree or --separate-git-dir pointer) and this call supplied no trustedMainRoot to verify it against — refusing rather than trusting an unverified pointer by default (docs/decisions/3a5c5d4a).`;
  check("(C) precondition: the redirect raw reason itself is well under the 400-char cap", redirectRawReason.length < 400);
  const redirectGuidance = ["HUMAN escalation", "Platform Lead", "do not retry"];
  for (const s of redirectGuidance) {
    check(`(C) precondition: the bare, UNTRUNCATED redirect raw reason still LACKS the guidance clause "${s}" — distinct from (A)/(B)'s truncation-caused gap`, !redirectRawReason.toLowerCase().includes(s.toLowerCase()));
  }

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

console.log(failures === 0
  ? "\n✅ ALL PASS — every merge-path CanonicalGitRefusal render site covered here (identity-probe catches on all three surfaces, the FIRST pre-mutation setup read, and the rollback render) keeps its human guidance, with no doubled \"refused: refused\" wording."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
