import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 26084115 — several merge-path surfaces rendered a canonical-git refusal via
// `describeGitFailure(e).text` (capped at 400 chars) instead of `canonicalFailureMessage`, so a
// pinMismatch refusal's human guidance (verify on disk; the re-pin route; escalate to the Platform
// Lead) and a commondirRedirect refusal's escalation wording were silently cut off on a realistically
// long (Loom worktree-shaped) path. Fixed sites: `landBranchCommitsIndividually`'s identity-fallback
// probe catch (git/batch-merge.ts) and both `mergeMainIntoWorktree`/`mergeBranchLocked`'s identity-
// fallback probe catches (git/worktrees.ts) — see the card body for the full `describeGitFailure(`
// consumer sweep.
//
// This proves the fix end to end through the REAL production call sites — `assembleBatchBranches`
// (batch-merge.ts) and `mergeMainIntoWorktree` (worktrees.ts) — against REAL git repos/worktrees, with
// ONLY the identity probe's own git handle faulted via `deps.identityProbeGitFactory`, the sanctioned
// test seam `unpinnedProbeFactoryFromLegacy`'s own doc comment names for exactly this (also used by
// canonical-git-commondir-refusal.mjs's own scenario (11) and batch-merge-identity-fallback.mjs). The
// commondir-trust mechanics (checkCommondirTrust's shape dispatch, the pin-first branch) are already
// exhaustively covered by canonical-git-commondir-refusal.mjs — this file is about the RENDER SITE, not
// the classification logic.
//
// Uses a realistic (~140-char) Loom-worktree-shaped live/pinned toplevel so the raw reason genuinely
// exceeds describeGitFailure's 400-char cap (matching the card's own "measured 1018 chars" citation),
// with the human guidance clause landing well past that cut line — so a bare `.text` render (the
// pre-fix behavior) demonstrably LACKS it, while `canonicalFailureMessage` (the fix) still carries it in
// full via its structured, never-truncated pinnedToplevel/liveToplevel fields.
//
// RED/GREEN proof (negative-control, card 616e5ec2's own tool — never `git show HEAD:`, which re-derives
// a moving target; this pins the comparison to a FIXED ref instead):
//   pnpm --filter @loom/daemon negative-control \
//     --file packages/daemon/src/git/batch-merge.ts --file packages/daemon/src/git/worktrees.ts \
//     --test packages/daemon/test/canonical-refusal-guidance-on-every-surface.mjs
//   (default --ref HEAD: the fix is an uncommitted working-tree edit on top of HEAD at the time this was
//   written — pass --ref HEAD~1 or an explicit sha once the fix is committed.)
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
const { mergeMainIntoWorktree } = await import(pathToFileURL(path.join(distDir, "worktrees.js")).href);
const { CanonicalGitPinMismatchRefusal, describeGitFailure, canonicalFailureMessage } = await import(pathToFileURL(path.join(distDir, "bounded.js")).href);

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
// other git call in the real `assembleBatchBranches`/`mergeMainIntoWorktree` code under test is real.
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
  check("(A) sanity: the drop reason is the identity-fallback probe refusal this card's fix touches", reason.includes("identity-fallback probe refused:"));
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
  check("(B) sanity: the refusal is the identity-fallback probe refusal this card's fix touches", reason.includes("identity-fallback probe refused:"));
  check("(B) the worktrees.ts union-merge reason carries the LIVE toplevel", reason.includes(liveToplevel));
  for (const s of guidanceSubstrings) {
    check(`(B) the worktrees.ts union-merge reason carries the guidance clause "${s}"`, ciIncludes(reason, s));
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a long, realistically-shaped canonical-git refusal's human guidance (verify on disk; the re-pin route; escalate to the Platform Lead) survives on both the batch-merge rejection path and the worktrees.ts union-merge path, despite describeGitFailure's own 400-char text cap."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
