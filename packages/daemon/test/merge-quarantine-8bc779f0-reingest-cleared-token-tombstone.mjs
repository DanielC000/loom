import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 8bc779f0 — two reingest branches (reconcileMarkedBasenameBeforeWrite's write-side one, and
// its human-clear twin reconcileClearedEntryIfPlaceholder) unioned raw, unfiltered on-disk tokens: an
// already-tombstoned (clearedTokens) token could ride back in. See the decision record.
//
// SCENARIO 1 — reconcileMarkedBasenameBeforeWrite (the write-side chokepoint). Single identity y,
// single key k:
//   1. y is genuinely raised twice (tokens T1/T2), disk at k holds both, fully readable.
//   2. T1 is cleared via the real clearMergeQuarantineByToken(y, T1) route — an entirely ordinary,
//      unmarked write. T2 remains outstanding. This is the ONLY step that populates the module's
//      global `clearedTokens` set with T1; disk is correctly rewritten to [T2] by this same step.
//   3. k's physical bytes are then forced back to a STALE snapshot that still carries T1 (plus a THIRD,
//      disk-only token neither raise above ever told the in-memory copy about) — standing in for
//      whatever real-world mechanism re-exposes a marked file's pre-clear bytes (the module's own
//      702b4241 decision record documents several; this test engineers the END STATE directly via the
//      same test-only hooks every sibling scenario in this corpus already uses, rather than replaying
//      one specific causal chain).
//   4. The in-memory entry is forced into card 702b4241's own UNREADABLE-placeholder shape at k (so the
//      NEXT write reaches the REINGEST branch, not the generic one), and k's basename is marked
//      keptUnreadableLatchFiles.
//   5. A PLAIN third raise for y (enterMergeQuarantine) reaches the reingest branch with NO drop of its
//      own for T1 (dropped.tokens is whatever enterMergeQuarantine's own existing-branch call passes —
//      never T1 specifically). Pre-fix, T1 resurrects into memory AND the durable write. Post-fix, T1
//      stays filtered out (clearedTokens), while the disk-only token (never cleared) and T2 (the plain
//      survivor) both correctly survive — proving the fix does not drop a genuinely outstanding token.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-8bc779f0-reingest-cleared-token-tombstone.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq8bc779-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  setActiveQuarantineTestOnly, markLatchFileUnreadableTestOnly, listActiveMergeQuarantines,
  PLACEHOLDER_BRANCH_UNREADABLE, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function freshRepo(tag) {
  const p = path.join(os.tmpdir(), `loom-mq8bc779-${tag}-${freshSfx()}`);
  fs.mkdirSync(p, { recursive: true });
  registerForCleanup(p);
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — reconcileMarkedBasenameBeforeWrite's reingest branch (the write-side chokepoint).
// Steps 1-2 — two genuine raises, then a genuine, unmarked partial clear of the FIRST token. This is
// the ONLY step that populates the real, module-global clearedTokens set with T1.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const y = freshRepo("y");
const k = canonicalRepoLockKey(y);
const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);

const t1 = enterMergeQuarantine(y, "y-branch-first", "8bc779f0: y's first raise (to be cleared)");
const t2 = enterMergeQuarantine(y, "y-branch-second", "8bc779f0: y's second raise (survivor)");

const onDiskAfterRaises = JSON.parse(fs.readFileSync(finalPath, "utf8"));
check("(precondition) disk carries both raises' tokens", [t1, t2].every((t) => (onDiskAfterRaises.tokens ?? []).includes(t)));

clearMergeQuarantineByToken(y, t1); // ordinary, unmarked partial clear — t2 remains outstanding

const onDiskAfterClear = JSON.parse(fs.readFileSync(finalPath, "utf8"));
check("(precondition) disk correctly dropped t1 after the ordinary clear", !(onDiskAfterClear.tokens ?? []).includes(t1));
check("(precondition) disk still carries t2 after the ordinary clear", (onDiskAfterClear.tokens ?? []).includes(t2));
check("(precondition) t1 is genuinely gone from the live entry", !(listActiveMergeQuarantines().find((e) => e.repoPath === y)?.tokens ?? []).includes(t1));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Step 3 — force k's physical bytes back to a stale, pre-clear snapshot: t1 (already tombstoned above)
// PLUS t2 (the genuine survivor) PLUS a third, disk-only token the in-memory copy never learned at all.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const diskOnlyToken = `8bc779f0-disk-only-${freshSfx()}`;
fs.writeFileSync(finalPath, JSON.stringify({
  repoPath: y, branch: "y-real-branch", reason: "8bc779f0: stale pre-clear snapshot, never re-read since",
  enteredAt: Date.now() - 60_000, tokens: [t1, t2, diskOnlyToken],
}, null, 2) + "\n");

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Step 4 — force the in-memory entry into card 702b4241's own UNREADABLE-placeholder shape at k, and
// mark k's basename unreadable, so the NEXT write reaches the REINGEST branch specifically.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const syntheticPlaceholderToken = `8bc779f0-synthetic-${freshSfx()}`;
const placeholderEntry = {
  repoPath: y, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "8bc779f0: boot-minted placeholder",
  enteredAt: Date.now() - 120_000, tokens: [syntheticPlaceholderToken, t2], placeholder: true, armedKeys: [k],
};
setActiveQuarantineTestOnly(k, placeholderEntry);
markLatchFileUnreadableTestOnly(path.basename(finalPath));

check("(precondition) y is placeholder-shaped in memory, holding only the synthetic token + t2", (() => {
  const e = listActiveMergeQuarantines().find((x) => x.repoPath === y);
  return !!e && e.placeholder === true && e.tokens.includes(t2) && !e.tokens.includes(t1) && !e.tokens.includes(diskOnlyToken);
})());

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Step 5 — a PLAIN third raise reaches the reingest branch. Pre-fix: t1 (already cleared/tombstoned)
// resurrects. Post-fix: t1 stays gone, while t2 and the disk-only token (never cleared) both survive.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const t3 = enterMergeQuarantine(y, "y-branch-third", "8bc779f0: y's third raise, after the stale revert");

const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
note(`(8bc779f0) in-memory y after the third raise: ${JSON.stringify(memAfter)}`);
check("*** THE FIX *** the cleared token t1 does NOT resurrect in memory", !!memAfter && !memAfter.tokens.includes(t1));
check("(sanity) the genuine survivor t2 is still present", !!memAfter && memAfter.tokens.includes(t2));
check("(sanity) the never-cleared disk-only token survives the reingest", !!memAfter && memAfter.tokens.includes(diskOnlyToken));
check("(sanity) the fresh third raise's own token is present", !!memAfter && memAfter.tokens.includes(t3));

const onDiskAfterThirdRaise = JSON.parse(fs.readFileSync(finalPath, "utf8"));
note(`(8bc779f0) disk after the third raise: ${JSON.stringify(onDiskAfterThirdRaise.tokens)}`);
check("*** THE FIX *** the cleared token t1 does NOT resurrect on disk either", !(onDiskAfterThirdRaise.tokens ?? []).includes(t1));
check("(sanity) disk's survivor + disk-only + fresh tokens are all present", [t2, diskOnlyToken, t3].every((t) => (onDiskAfterThirdRaise.tokens ?? []).includes(t)));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — reconcileClearedEntryIfPlaceholder, the human-clear twin (folded into this card by the
// manager's ruling: same class, same file, same fix). Driven through clearMergeQuarantineLatchFile
// (clear-by-id), one of the three identity-wide human-clear routes named in that function's own doc
// comment. `ambiguousIdentitiesFor` reads `entry.contributorRepoPaths` as a bare field (no requirement
// that the contributor was raised for real), so planting it directly in the stale disk snapshot — same
// engineered-end-state posture as scenario 1 above — is enough to make clear-by-id fail CLOSED
// (ambiguous) rather than fully lifting the entry, leaving the just-reconciled entry observable in
// memory afterward instead of deleted.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const z = freshRepo("z");
  const key = canonicalRepoLockKey(z);
  const finalPath2 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`);

  const s2t1 = enterMergeQuarantine(z, "s2-branch-first", "8bc779f0 s2: z's first raise (to be cleared)");
  const s2t2 = enterMergeQuarantine(z, "s2-branch-second", "8bc779f0 s2: z's second raise (survivor)");
  clearMergeQuarantineByToken(z, s2t1); // ordinary, unmarked partial clear -> clearedTokens.add(s2t1)
  const onDiskAfterS2Clear = JSON.parse(fs.readFileSync(finalPath2, "utf8"));
  check("(precondition s2) disk correctly dropped s2t1 after the ordinary clear", !(onDiskAfterS2Clear.tokens ?? []).includes(s2t1));

  // Force the physical bytes back to a stale, pre-clear snapshot carrying s2t1 again, PLUS a genuine
  // contributorRepoPaths entry (so the eventual clear-by-id refuses on ambiguity instead of fully
  // lifting the entry) and a disk-only token the in-memory copy never learned.
  const s2DiskOnlyToken = `8bc779f0-s2-disk-only-${freshSfx()}`;
  const s2Contributor = `8bc779f0-s2-contributor-${freshSfx()}`;
  fs.writeFileSync(finalPath2, JSON.stringify({
    repoPath: z, branch: "s2-GENUINE", reason: "8bc779f0 s2: z's own genuine stale record",
    enteredAt: Date.now() - 60_000, tokens: [s2t1, s2t2, s2DiskOnlyToken], contributorRepoPaths: [s2Contributor],
  }, null, 2) + "\n");

  // Force the in-memory entry into card 702b4241's own UNREADABLE-placeholder shape at `key`, same
  // test-only hooks as scenario 1, so reconcileClearedEntryIfPlaceholder's own gate fires.
  const s2SyntheticToken = `8bc779f0-s2-synthetic-${freshSfx()}`;
  setActiveQuarantineTestOnly(key, {
    repoPath: z, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "8bc779f0 s2: boot-minted placeholder",
    enteredAt: Date.now() - 120_000, tokens: [s2SyntheticToken, s2t2], placeholder: true, armedKeys: [key],
  });
  markLatchFileUnreadableTestOnly(path.basename(finalPath2));

  check("(precondition s2) z is placeholder-shaped in memory before the clear", (() => {
    const e = listActiveMergeQuarantines().find((x) => x.repoPath === z);
    return !!e && e.placeholder === true && !e.tokens.includes(s2t1) && !e.tokens.includes(s2DiskOnlyToken);
  })());

  const clearResult = clearMergeQuarantineLatchFile(hashForKey(key));
  note(`(8bc779f0 s2) clearMergeQuarantineLatchFile(z's id) => ${JSON.stringify(clearResult)}`);
  check("(precondition s2) clear-by-id fails closed on the genuine ambiguity (never a bare lift)", clearResult.ok === false || clearResult.refusedBeforeClear === true);

  const memAfterS2 = listActiveMergeQuarantines().find((e) => e.repoPath === z);
  note(`(8bc779f0 s2) in-memory z after the refused clear: ${JSON.stringify(memAfterS2)}`);
  check("*** THE FIX (s2) *** the cleared token s2t1 does NOT resurrect in the reconciled in-memory entry", !!memAfterS2 && !memAfterS2.tokens.includes(s2t1));
  check("(sanity s2) the genuine survivor s2t2 is still present", !!memAfterS2 && memAfterS2.tokens.includes(s2t2));
  check("(sanity s2) the never-cleared disk-only token survives the reconcile", !!memAfterS2 && memAfterS2.tokens.includes(s2DiskOnlyToken));
  check("(sanity s2) the contributor is still correctly folded in (the reconcile's other fields are untouched)", (memAfterS2?.contributorRepoPaths ?? []).includes(s2Contributor));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
