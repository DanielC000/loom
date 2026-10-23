import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card b47cf261 — clearMergeQuarantineByKey's own tied-twin "reduce" branch calls
// writePendingDivertFile(p.sourceFile, updated, ...) and, when that call's own stale-mark
// re-read-and-union branch hands back a FRESH object (provably !== `updated`, by construction — see
// unionIntoOnDiskPendingEntry's own object spread), used to hand-assign only `p.entry` to it — never
// re-pointing `activeQuarantines`'s own slot(s) for this twin's armed key(s), which stayed on the now-
// stale `updated`. This broke decision 64283e06's by-value twin invariant: the SAME logical twin ends up
// represented by two non-reference-equal, non-disjoint-token objects, one on each side.
//
// This scenario constructs a genuine reference twin DIRECTLY via the low-level test-only seams (no
// multi-reboot scaffolding needed): P is armed in activeQuarantines at its own key `kp` via
// setActiveQuarantineTestOnly, and the SAME object is injected into pendingUnresolvedQuarantines via
// reenterMergeQuarantinesAtBootTestOnly's own raw-push seam — a genuine reference twin, tied to the entry
// being cleared (W) via an ORPHAN-FILE reference (W.orphanLatchFiles includes P's own sourceFile), kept
// deliberately independent of W's own key so P's own activeQuarantines slot is directly inspectable.
//
// P's own on-disk backing file is marked keptUnreadableLatchFiles (markLatchFileUnreadableTestOnly) before
// the clear, and carries a THIRD token ("stale-only-token") that exists ONLY on disk, never in the
// in-memory twin — so the written, unioned object is provably !==, and non-disjoint from, the in-memory
// `updated` the reduce branch computes, and the two are trivially distinguishable by content.
//
// Asserts BOTH observables the bug produces: (a) assertQuarantineIdentityInvariantTestOnly flags the
// resulting non-twin, overlapping-token pair as a violation; (b) listActiveMergeQuarantines() reports the
// identity TWICE pre-fix (once stale, missing "stale-only-token"; once correct) and exactly ONCE post-fix,
// with the correct, unioned token set.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-b47cf261-reduce-branch-twin-resync.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqb47cf261-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantineByKey, reenterMergeQuarantinesAtBootTestOnly, setActiveQuarantineTestOnly,
  markLatchFileUnreadableTestOnly, listActiveMergeQuarantines, assertQuarantineIdentityInvariantTestOnly,
  MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// @decision 9c681680 — registerForCleanup (never a bare fs.mkdirSync-and-forget): an empty os.tmpdir()
// dir left behind per call leaks across every run of this file (same shape as the 58957b1e test's own
// freshRepo() nit).
const freshDir = (tag) => {
  const d = path.join(os.tmpdir(), `loom-mqb47cf261-${tag}-${freshSfx()}`);
  fs.mkdirSync(d, { recursive: true });
  registerForCleanup(d);
  return d;
};

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("b47cf261-reduce-branch-twin-resync") — see header above for the full construction.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshDir("y"); // identity shared by W (the entry being cleared) and P (the tied twin)
  const y2 = freshDir("y2"); // used only to derive a key distinct from W's own, for P's independent arming
  const kw = canonicalRepoLockKey(y);
  const kp = canonicalRepoLockKey(y2);
  const pSourceFile = "pending-b47cf261-s1-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);

  const wEntry = {
    repoPath: y, branch: "b47cf261-w-branch", reason: "b47cf261: active entry being cleared",
    tokens: ["w-token"], armedKeys: [kw], orphanLatchFiles: [pSourceFile], enteredAt: Date.now() - 10_000,
  };
  setActiveQuarantineTestOnly(kw, wEntry);

  const pEntryInMemory = {
    repoPath: y, branch: "b47cf261-p-branch", reason: "b47cf261: tied pending twin",
    tokens: ["w-token", "extra-token"], armedKeys: [kp], enteredAt: Date.now() - 5_000,
  };
  // Arm P genuinely in activeQuarantines at its OWN, independent key...
  setActiveQuarantineTestOnly(kp, pEntryInMemory);
  // ...and inject the SAME object reference into pendingUnresolvedQuarantines — a genuine twin.
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntryInMemory, sourceFile: pSourceFile }]);

  // P's own on-disk backing file: stale relative to memory, carrying a token ("stale-only-token") that
  // exists ONLY here, never in pEntryInMemory — mirrors "an earlier reduce whose write failed" (the
  // reduce branch's own pre-existing comment already anticipates this exact shape).
  const pEntryOnDisk = { ...pEntryInMemory, tokens: ["w-token", "extra-token", "stale-only-token"] };
  fs.writeFileSync(pPath, JSON.stringify(pEntryOnDisk, null, 2) + "\n");

  check("(precondition) W active with w-token only", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.length === 1 && e.tokens[0] === "w-token"));
  check("(precondition) P pending+active twin with w-token,extra-token, armed at kp", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("extra-token") && e.armedKeys?.includes(kp)));
  // No "invariant holds before the clear" precondition here, deliberately: W and P's own tokens
  // genuinely OVERLAP on "w-token" pre-clear (that overlap is what makes this clear's own reduce branch
  // fire at all) — assertQuarantineIdentityInvariantTestOnly correctly flags an un-settled, mid-raise
  // overlap like this; the invariant is only meaningful once the clear below has settled.

  // The stale mark: outlived whatever earlier (unmodeled) read failure set it — the file is genuinely
  // readable, same identity, right now — exactly the precondition writePendingDivertFile's own
  // re-read-and-union branch exists for.
  markLatchFileUnreadableTestOnly(pSourceFile);

  clearMergeQuarantineByKey(kw, y);

  const afterIdentity = assertQuarantineIdentityInvariantTestOnly();
  check("*** THE BUG (if reproduced) *** identity invariant holds AFTER the clear (no stale/written twin split)", afterIdentity.ok);
  if (!afterIdentity.ok) console.log(`      violations: ${JSON.stringify(afterIdentity.violations)}`);

  const survivors = listActiveMergeQuarantines().filter((e) => e.repoPath === y);
  check("*** THE BUG (if reproduced) *** exactly ONE surviving object represents this identity (not a stale+written split)", survivors.length === 1);
  check("*** THE BUG (if reproduced) *** the surviving object's tokens are EXACTLY {extra-token,stale-only-token} (the WRITTEN twin's content, not the stale pre-union `updated`)", survivors.length === 1 && JSON.stringify([...survivors[0].tokens].sort()) === JSON.stringify(["extra-token", "stale-only-token"]));
  check("W is fully lifted (w-token gone)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("w-token")));

  const onDiskAfter = (() => { try { return JSON.parse(fs.readFileSync(pPath, "utf8")); } catch { return null; } })();
  check("on-disk pending record durably holds the unioned, dropped-w-token content regardless of the in-memory split", !!onDiskAfter && JSON.stringify([...onDiskAfter.tokens].sort()) === JSON.stringify(["extra-token", "stale-only-token"]));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearMergeQuarantineByKey's reduce branch re-points EVERY in-memory reference "
    + "(both activeQuarantines and pendingUnresolvedQuarantines) to whatever writePendingDivertFile actually "
    + "wrote, never leaving activeQuarantines stuck on a stale pre-union `updated` object."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card b47cf261.`);
process.exit(failures === 0 ? 0 : 1);
