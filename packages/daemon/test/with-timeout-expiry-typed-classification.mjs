// Card 122eb237 — `isWithTimeoutExpiry` (git/worktrees.ts) used to classify a git failure as TRANSIENT
// by matching `/exceeded \d+ms \(hung git child\?\)/` against `.message` text — the lesson-271 shape: a
// hook's stderr, or any message carrying the phrase, could forge it. `withTimeout` (git/bounded.ts) now
// throws a typed `WithTimeoutExpiry` on its own expiry, and `isWithTimeoutExpiry` checks `instanceof`
// instead. This file proves, at each of the 3 real call sites that consult it:
//   - a FORGED message (an ordinary Error whose text happens to contain the old phrase) is NOT
//     classified transient;
//   - a REAL `withTimeout` expiry (a never-settling `git.raw()` under a short `deps.timeoutMs`, via the
//     existing `deps.gitFactory` test seam — no real spawn/kill involved) still IS classified transient,
//     unchanged from before this card.
// `isSpawnLevelFailure` is deliberately left untouched by this card (see its own doc-comment decision
// note in worktrees.ts) — not exercised here.
//
// Pure function-level unit tests: every scenario supplies its own `deps.gitFactory`, so no real git
// repo, DB, or daemon is needed — `repoPath` is never touched by any of the 3 functions under test
// except to forward it (unused) to the factory. Mirrors the established pattern in
// union-merge-transient-classification.mjs (`gitFactory: badRepoGit`, a placeholder repoPath).
//
// RED/GREEN proof (not run automatically by this file):
//   pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts \
//     --file packages/daemon/src/git/worktrees.ts \
//     --test packages/daemon/test/with-timeout-expiry-typed-classification.mjs
// (default --ref HEAD: the pre-fix committed state at this card's own cut) — FORGED_* scenarios go RED
// (the forged message is wrongly classified transient), REAL_* scenarios stay GREEN either way (a real
// withTimeout expiry was always classified transient, before and after this card).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/with-timeout-expiry-typed-classification.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { findAllLandedTrailerCommits, fullTreeEntries, verifyReviewedTipChain, GitTransientReadFailure } =
  await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TIMEOUT_MS = 50;

// A forged message: an ORDINARY Error (never thrown by withTimeout itself) whose text happens to carry
// the exact old-regex phrase — the lesson-271 forgery shape (e.g. a hook's stderr landing in a message).
// `deps.gitFactory` must be the 2-arg `(repoPath, blockTimeoutMs) => Pick<SimpleGit,"raw">` FACTORY
// itself, never an already-constructed `{raw}` object — passing the latter makes `boundedGit`'s own
// `makeGit(repoPath, timeoutMs)` call throw (not a function), which `gitConstructFailure` turns into an
// unrelated rejection that happens to ALSO classify as non-transient, vacuously passing the FORGED
// checks below for the wrong reason. Caught by first seeing the REAL-timeout checks fail too (they'd
// reject immediately instead of waiting out `TIMEOUT_MS`), not by the FORGED checks alone.
const forgedTimeoutMessage = "some-step exceeded 1000ms (hung git child?)";
function forgedGitFactory() { return { async raw() { throw new Error(forgedTimeoutMessage); } }; }

// A REAL withTimeout expiry: the underlying `git.raw()` promise never settles, so withTimeout's own
// timer (bounded by the short `TIMEOUT_MS` below) is what actually fires and rejects.
function neverSettlingGitFactory() { return { raw() { return new Promise(() => {}); } }; }

async function expectThrows(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (e) {
    check(label, predicate(e));
  }
}

// --- site 1: findAllLandedTrailerCommits (git log --grep, worktrees.ts ~8269) ---
{
  const r = await findAllLandedTrailerCommits("fake-repo-path", "loom/x", "HEAD", { gitFactory: forgedGitFactory, timeoutMs: TIMEOUT_MS });
  check("(FORGED_DISCOVERY) a forged 'exceeded Nms (hung git child?)' message is NOT classified transient — resolves to [], never throws", Array.isArray(r) && r.length === 0);
}
await expectThrows(
  "(REAL_DISCOVERY) a real, never-settling git.raw() under withTimeout still classifies transient — throws GitTransientReadFailure",
  () => findAllLandedTrailerCommits("fake-repo-path", "loom/x", "HEAD", { gitFactory: neverSettlingGitFactory, timeoutMs: TIMEOUT_MS }),
  (e) => e instanceof GitTransientReadFailure,
);

// --- site 2: resolveObjectKind, via fullTreeEntries (its one cat-file -t pre-check, worktrees.ts ~8428) ---
{
  const r = await fullTreeEntries("fake-repo-path", SHA_A, { gitFactory: forgedGitFactory, timeoutMs: TIMEOUT_MS });
  check("(FORGED_OBJECT_KIND) a forged message is NOT classified transient — resolves to null (definitive 'missing'), never throws", r === null);
}
await expectThrows(
  "(REAL_OBJECT_KIND) a real, never-settling cat-file -t under withTimeout still classifies transient — throws GitTransientReadFailure",
  () => fullTreeEntries("fake-repo-path", SHA_A, { gitFactory: neverSettlingGitFactory, timeoutMs: TIMEOUT_MS }),
  (e) => e instanceof GitTransientReadFailure,
);

// --- site 3: verifyReviewedTipChain's own outer catch (worktrees.ts ~10162), reached via
// resolveExactTrailerObjectId's rev-parse call (needs an object-id-SHAPED `live`, hence SHA_A) ---
{
  const r = await verifyReviewedTipChain("fake-repo-path", SHA_B, SHA_A, { gitFactory: forgedGitFactory, timeoutMs: TIMEOUT_MS });
  check("(FORGED_CHAIN) a forged message is NOT classified transient — ok:false with no transient flag", r.ok === false && r.transient !== true);
}
{
  const r = await verifyReviewedTipChain("fake-repo-path", SHA_B, SHA_A, { gitFactory: neverSettlingGitFactory, timeoutMs: TIMEOUT_MS });
  check("(REAL_CHAIN) a real, never-settling git.raw() under withTimeout still classifies transient — ok:false, transient:true", r.ok === false && r.transient === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — isWithTimeoutExpiry's 3 call sites (findAllLandedTrailerCommits, resolveObjectKind " +
    "via fullTreeEntries, verifyReviewedTipChain) classify a REAL withTimeout expiry as transient exactly " +
    "as before, and a forged message carrying the old phrase as NOT transient — the forgery this card closes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
