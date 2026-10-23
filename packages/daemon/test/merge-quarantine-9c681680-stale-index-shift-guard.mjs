import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 9c681680 — clearTokenFromPendingIndices precomputed a plan keyed by literal array INDEX,
// then mutated pendingUnresolvedQuarantines in a loop using those SAME stale index numbers
// (pendingUnresolvedQuarantines[idx]) — never re-resolved via indexOf, unlike clearMergeQuarantineByKey's
// own sibling pending loop (fixed by 07e3ad30 to snapshot wrapper OBJECTS and resolve indexOf fresh at
// mutation time).
//
// A protect call reached from THIS function's own "remove" branch (deleteMergeQuarantineLatchByKey ->
// protectOccupantContentBeforeDelete's own "both atFilenameIdx and atFinalBasenameIdx match, same
// identity" branch — confirmed real, and already exercised in the deliberately-MISMATCHED-identity shape
// by merge-quarantine-cd5a3cf9-identity-gate.mjs's own SCENARIO 4) can SPLICE an unrelated entry out of
// the SAME array, at a position BELOW a second, not-yet-processed target index. Every later iteration
// then reads the WRONG, shifted wrapper under the FIRST wrapper's stale precomputed plan.
//
// SCENARIO 1 constructs the primary hazard: array order [Z_B, L, M, Z_A] (indices 0-3), clear targets
// [L, M] (indices 1,2). Processing M (idx 2, descending) first self-splices M out, then its own armed-key
// cleanup unions Z_A+Z_B (both identity Z) and SPLICES Z_B out at index 0 — shifting L (was at 1) down to
// index 0, and the merged Z record (was at 3) down to index 1. Processing "idx 1" next, PRE-FIX, silently
// read the merged Z record instead of L, applying L's own "remove" plan to it: L's real quarantine was
// NEVER visited again (silently never lifted), while Z's own unrelated, correctly-held quarantine was
// spliced out of the pending array AND swept from disk as collateral — a real fail-open, confirmed via a
// hermetic repro before this card's own fix was written.
//
// SCENARIO 2 is the card's own secondary question: with L's plan set to "reduce" instead of "remove", and
// Z's own canonical-name record (Z_A) ALSO genuinely armed (a reference twin, armedKeys=[kZarmed]) —
// does the misrouted "reduce" plan reach the reduce branch's own armed-key WRITE loop (64283e06's own
// posture: "ROUTED, DEFENSIVE... unreachable today ONLY because the caller's own identity-scan already
// catches any active twin first")? PRE-FIX this write loop genuinely fires for Z's own armed key — the
// loop was never supposed to see an object clearMergeQuarantineByToken's own twin-filter never vetted.
// Detected via an fs.openSync intercept on Z's own armed-key latch path (writeMergeQuarantineLatch's own
// write target), never thrown — just counted, so the real write still proceeds either way.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-9c681680-stale-index-shift-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq9c681680-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByToken, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors the real module's own private quarantineHashForKey (hashes a raw KEY, never a repoPath) — same
// helper every other merge-quarantine*.mjs test file carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

// Mirrors the real module's own private pendingDivertFilenameFor (hashes an identity's
// directPathIdentity) — same technique merge-quarantine-cd5a3cf9-identity-gate.mjs's own
// pendingDivertFilenameForTest uses.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("9c681680-stale-index-misroutes-a-later-target") — see header above.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const L = path.join(os.tmpdir(), `loom-mq9c681680-s1-L-never-${sfx}`);
  const M = path.join(os.tmpdir(), `loom-mq9c681680-s1-M-never-${sfx}`);
  const Z = path.join(os.tmpdir(), `loom-mq9c681680-s1-Z-never-${sfx}`);
  const kForeignMid = `mq9c681680-s1-kmid-${sfx}`;
  const finalBasenameForMid = `${hashKey(kForeignMid)}.json`;
  const zCanonicalName = pendingDivertFilenameForTest(Z);

  // Initial pendingUnresolvedQuarantines array order (indices 0..3):
  //   0: Z_B — Z's own record, physically squatting kForeignMid's own on-disk file (finalBasename match)
  //   1: L   — real clear target, tokens=[shared-token] only (full "remove")
  //   2: M   — real clear target, tokens=[shared-token] only (full "remove"), armedKeys=[kForeignMid]
  //   3: Z_A — Z's own record, at Z's own CANONICAL pending-divert filename (atFilenameIdx match)
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Z, branch: "z-b-branch", reason: "Z's own record, squatting kForeignMid's own file", enteredAt: Date.now(), tokens: ["z-token"] }, sourceFile: finalBasenameForMid },
    { entry: { repoPath: L, branch: "low-branch", reason: "9c681680: real clear target (L)", enteredAt: Date.now(), tokens: ["shared-token"] }, sourceFile: "pending-9c681680-s1-low-test.json" },
    { entry: { repoPath: M, branch: "mid-branch", reason: "9c681680: real clear target (M), processed first", enteredAt: Date.now(), tokens: ["shared-token"], armedKeys: [kForeignMid] }, sourceFile: "pending-9c681680-s1-mid-test.json" },
    { entry: { repoPath: Z, branch: "z-a-branch", reason: "Z's own record, at its own canonical pending-divert name", enteredAt: Date.now(), tokens: ["z-token"] }, sourceFile: zCanonicalName },
  ]);

  // occupantMid: a SEPARATE active-only object, same identity as M, tokens=[shared-token], armed at
  // kForeignMid — makes entryStillOwnsKey(kForeignMid, M's own entry) true via the "different object,
  // same identity, subset tokens" branch, WITHOUT making M's own entry itself an active twin (which would
  // get excluded from clearMergeQuarantineByToken's own nonTwinPendingIndices filter before it ever
  // reaches clearTokenFromPendingIndices at all — 64283e06's own "today unreachable" precondition).
  const occupantMid = { repoPath: M, branch: "occupant-mid-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token"] };
  setActiveQuarantineTestOnly(kForeignMid, occupantMid);

  // The REAL on-disk file at kForeignMid's own physical path — Z's content, written AFTER the inject call
  // above so it is never scanned into memory by anything but this test's own later clear-time reads (same
  // "write after every inject call" technique as merge-quarantine-clear-by-path.mjs's own (AJ)/(AK)).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForMid), JSON.stringify({
    repoPath: Z, branch: "z-b-branch", reason: "Z's own record, squatting kForeignMid's own file", enteredAt: Date.now(), tokens: ["z-token"],
  }, null, 2) + "\n");

  check("(S1 precondition) L reads blocked before the clear", !assertRepoNotQuarantined(L).ok);
  check("(S1 precondition) M reads blocked before the clear", !assertRepoNotQuarantined(M).ok);
  check("(S1 precondition) Z reads blocked before the clear", !assertRepoNotQuarantined(Z).ok);
  check("(S1 precondition) L carries shared-token", listActiveMergeQuarantines().some((e) => e.repoPath === L && e.tokens.includes("shared-token")));

  // THE CLEAR under test — lifts "shared-token" everywhere.
  clearMergeQuarantineByToken(M, "shared-token");

  check("*** THE FIX (S1) *** L is fully lifted (the real clear target was actually processed, not skipped)", assertRepoNotQuarantined(L).ok);
  check("*** THE FIX (S1) *** M is fully lifted", assertRepoNotQuarantined(M).ok);
  check("*** THE FIX (S1) *** Z's own unrelated quarantine SURVIVES, untouched, in memory", !assertRepoNotQuarantined(Z).ok);
  check("*** THE FIX (S1) *** Z's own z-token is still present in memory", listActiveMergeQuarantines().some((e) => e.repoPath === Z && e.tokens.includes("z-token")));
  const onDiskNamesS1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (S1) *** Z's own protective copy still exists ON DISK (never collaterally swept)",
    onDiskNamesS1.some((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === Z; } catch { return false; } }));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("9c681680-stale-index-armed-key-loop-unreachable") — the card's own secondary question:
// with the misrouted plan a "reduce" (not "remove"), and the misrouted wrapper ALSO a genuine reference
// twin (armed at its own independent key), does the reduce branch's own armed-key WRITE loop — per
// 64283e06 "unreachable today ONLY because the caller's own identity-scan already catches any active twin
// first" — actually fire for it? Detected via a non-throwing fs.openSync intercept on the twin's own
// armed-key latch path (writeMergeQuarantineLatch's own write target); never thrown, so the real write
// still proceeds and this test asserts the FIXED (zero-intercept) outcome, not a forced failure.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const L = path.join(os.tmpdir(), `loom-mq9c681680-s2-L-never-${sfx}`);
  const M = path.join(os.tmpdir(), `loom-mq9c681680-s2-M-never-${sfx}`);
  const Z = path.join(os.tmpdir(), `loom-mq9c681680-s2-Z-never-${sfx}`);
  const kForeignMid = `mq9c681680-s2-kmid-${sfx}`;
  const kZarmed = `mq9c681680-s2-kzarmed-${sfx}`;
  const finalBasenameForMid = `${hashKey(kForeignMid)}.json`;
  const zCanonicalName = pendingDivertFilenameForTest(Z);
  const zArmedFinalBasename = `${hashKey(kZarmed)}.json`;

  const zAEntry = {
    repoPath: Z, branch: "z-a-branch", reason: "Z's own record, at its own canonical pending-divert name, ALSO genuinely armed",
    enteredAt: Date.now(), tokens: ["z-token"], armedKeys: [kZarmed],
  };

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Z, branch: "z-b-branch", reason: "Z's own record, squatting kForeignMid's own file", enteredAt: Date.now(), tokens: ["z-token"] }, sourceFile: finalBasenameForMid },
    { entry: { repoPath: L, branch: "low-branch", reason: "9c681680: real clear target (L), REDUCE action", enteredAt: Date.now(), tokens: ["shared-token", "low-private-token"] }, sourceFile: "pending-9c681680-s2-low-test.json" },
    { entry: { repoPath: M, branch: "mid-branch", reason: "9c681680: real clear target (M), processed first", enteredAt: Date.now(), tokens: ["shared-token"], armedKeys: [kForeignMid] }, sourceFile: "pending-9c681680-s2-mid-test.json" },
    { entry: zAEntry, sourceFile: zCanonicalName },
  ]);

  const occupantMid = { repoPath: M, branch: "occupant-mid-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token"] };
  setActiveQuarantineTestOnly(kForeignMid, occupantMid);
  // Z_A's own entry is ALSO genuinely armed, as itself (a real reference twin) — mirrors the SAME
  // construction every other merge-quarantine*.mjs twin test uses (setActiveQuarantineTestOnly +
  // reenterMergeQuarantinesAtBootTestOnly's own raw-push seam for the SAME object reference).
  setActiveQuarantineTestOnly(kZarmed, zAEntry);

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForMid), JSON.stringify({
    repoPath: Z, branch: "z-b-branch", reason: "Z's own record, squatting kForeignMid's own file", enteredAt: Date.now(), tokens: ["z-token"],
  }, null, 2) + "\n");

  check("(S2 precondition) L reads blocked before the clear", !assertRepoNotQuarantined(L).ok);
  check("(S2 precondition) Z's own twin is armed at kZarmed", listActiveMergeQuarantines().some((e) => e.repoPath === Z && (e.armedKeys ?? []).includes(kZarmed)));

  // Non-throwing intercept on Z's own armed-key latch write target — counts, never disrupts.
  const realOpenSync = fs.openSync;
  let zArmedWriteAttempts = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(zArmedFinalBasename) && p.includes(".tmp-")) zArmedWriteAttempts++;
    return realOpenSync(p, ...rest);
  };
  try {
    clearMergeQuarantineByToken(M, "shared-token");
  } finally {
    fs.openSync = realOpenSync;
  }

  // L's own plan is "reduce" (it holds a SECOND, private token) — the real clear correctly leaves L
  // blocked, reduced to EXACTLY its own surviving private token, never fully lifted and never untouched.
  const lAfterS2 = listActiveMergeQuarantines().find((e) => e.repoPath === L);
  check("*** THE FIX (S2) *** L was actually processed — reduced to EXACTLY {low-private-token} (shared-token genuinely dropped, not skipped)",
    !!lAfterS2 && JSON.stringify([...lAfterS2.tokens].sort()) === JSON.stringify(["low-private-token"]));
  check("*** THE FIX (S2) *** M is fully lifted", assertRepoNotQuarantined(M).ok);
  check("*** THE FIX (S2) *** Z's own armed-key write loop is NEVER reached for this clear (0 write attempts at kZarmed's own latch path)", zArmedWriteAttempts === 0);
  check("*** THE FIX (S2) *** Z's own twin survives, still armed at kZarmed, tokens untouched", listActiveMergeQuarantines().some((e) => e.repoPath === Z && (e.armedKeys ?? []).includes(kZarmed) && e.tokens.includes("z-token")));
  check("*** THE FIX (S2) *** Z's own unrelated quarantine still reads blocked", !assertRepoNotQuarantined(Z).ok);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearTokenFromPendingIndices resolves every pending entry by its own snapshot "
    + "wrapper OBJECT, never a stale precomputed array index; a protect call's own mid-loop splice of an "
    + "unrelated entry can no longer misroute a later target onto the wrong wrapper."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 9c681680.`);
process.exit(failures === 0 ? 0 : 1);
