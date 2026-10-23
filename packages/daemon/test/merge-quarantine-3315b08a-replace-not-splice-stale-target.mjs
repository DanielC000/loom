import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 3315b08a — Code Review ad5ca27c of card 9c681680 (commit 578f1692): clearTokenFromPendingIndices'
// own remove branch (deleteMergeQuarantineLatchByKey -> protectOccupantContentBeforeDelete's own
// "atFilenameIdx matches, same identity" branch) can ASSIGN a fresh wrapper object into a not-yet-processed
// target's own pendingUnresolvedQuarantines slot — never a splice, so 9c681680's own "resolve indexOf
// fresh" fix does nothing for it: the snapshotted wrapper is detached from the live array with no index to
// ever find it at again.
//
// Construction: pending = [Z_A (real clear target, Z's own canonical pending-divert name, tokens
// [shared-token]), M (real clear target, armedKeys [k], tokens [shared-token]), W (bystander, squats k's
// own physical file's basename, tokens [w-private-token], never a clear target)]. An active twin shares
// M's identity (not M's own reference) at k, via entryStillOwnsKey's "same identity, subset tokens"
// branch — making M's own armedKeys genuinely owned without making M itself an active twin (64283e06's
// own "unreachable today" precondition for clearMergeQuarantineByToken). k's REAL on-disk file holds Z's
// own content directly, with a token ([zdisk-token]) nothing in memory carries yet.
//
// Processing order is descending by index: M (processed first) self-splices out cleanly, then its own
// armed-key cleanup reaches deleteMergeQuarantineLatchByKey(k, ...) -> protectOccupantContentBeforeDelete,
// which reads k's on-disk Z content, unions it with Z_A's own in-memory record (found via
// reconcilePendingDivertTarget's own canonical-name match — atFilenameIdx), and ASSIGNS a brand-new
// wrapper object into Z_A's own array slot (never splicing it) — W (a DIFFERENT identity at
// atFinalBasenameIdx) is left completely untouched, confirming this is the ASSIGN shape, not the SPLICE
// shape 9c681680 already covers.
//
// Processing Z_A next: indexOf(Z_A) is now -1 (detached, not shifted). PRE-FIX this logs the -1 error and
// gives up — shared-token is NEVER dropped from the live (replaced) wrapper, so Z stays stuck holding BOTH
// shared-token AND zdisk-token forever (fails CLOSED; needs a human clear). POST-FIX, the live wrapper is
// re-resolved by identity and the clear plan is RE-DERIVED from its CURRENT tokens — which, because of the
// union, is no longer "remove" (shared-token was Z_A's only token at pre-pass time) but "reduce" (zdisk-
// token survived the union too) — exactly the card's own "a reduce variant is correct post-fix" note.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq3315b08a-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByToken, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
  reenterMergeQuarantinesAtBoot, clearTokenFromPendingIndicesTestOnly,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors the real module's own private quarantineHashForKey (hashes a raw KEY, never a repoPath) — same
// helper every other merge-quarantine*.mjs test file carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

// Mirrors the real module's own private pendingDivertFilenameFor (hashes an identity's
// directPathIdentity) — same technique merge-quarantine-cd5a3cf9-identity-gate.mjs's own
// pendingDivertFilenameForTest and merge-quarantine-9c681680-stale-index-shift-guard.mjs use.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("3315b08a-replace-detaches-a-not-yet-processed-target") — see header above.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Z = path.join(os.tmpdir(), `loom-mq3315b08a-s1-Z-never-${sfx}`);
  const M = path.join(os.tmpdir(), `loom-mq3315b08a-s1-M-never-${sfx}`);
  const W = path.join(os.tmpdir(), `loom-mq3315b08a-s1-W-never-${sfx}`);
  const k = `mq3315b08a-s1-k-${sfx}`;
  const finalBasenameForK = `${hashKey(k)}.json`;
  const zCanonicalName = pendingDivertFilenameForTest(Z);

  // Initial pendingUnresolvedQuarantines array order (indices 0..2):
  //   0: Z_A — real clear target, at Z's own CANONICAL pending-divert filename (atFilenameIdx match)
  //   1: M   — real clear target, tokens=[shared-token] only (full "remove"), armedKeys=[k]
  //   2: W   — bystander, squatting k's own physical file's basename (atFinalBasenameIdx match), a
  //            DIFFERENT identity than Z — never a clear target, never spliced (proves the ASSIGN-only shape)
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Z, branch: "z-a-branch", reason: "3315b08a: Z's own record, at its own canonical pending-divert name", enteredAt: Date.now(), tokens: ["shared-token"] }, sourceFile: zCanonicalName },
    { entry: { repoPath: M, branch: "mid-branch", reason: "3315b08a: real clear target (M), processed first", enteredAt: Date.now(), tokens: ["shared-token"], armedKeys: [k] }, sourceFile: "pending-3315b08a-s1-mid-test.json" },
    { entry: { repoPath: W, branch: "w-branch", reason: "3315b08a: bystander, squatting k's own file", enteredAt: Date.now(), tokens: ["w-private-token"] }, sourceFile: finalBasenameForK },
  ]);

  // occupantMid: a SEPARATE active-only object, same identity as M, tokens=[shared-token], armed at k —
  // makes entryStillOwnsKey(k, M's own entry) true via the "different object, same identity, subset
  // tokens" branch, WITHOUT making M's own entry itself an active twin (which would get excluded from
  // clearMergeQuarantineByToken's own nonTwinPendingIndices filter before it ever reaches
  // clearTokenFromPendingIndices at all — 64283e06's own "today unreachable" precondition).
  const occupantMid = { repoPath: M, branch: "occupant-mid-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token"] };
  setActiveQuarantineTestOnly(k, occupantMid);

  // The REAL on-disk file at k's own physical path — Z's content, with a token NOTHING in memory carries
  // yet (zdisk-token). Written AFTER the inject call above so it is never scanned into memory by anything
  // but this test's own later clear-time reads (same "write after every inject call" technique every
  // sibling merge-quarantine*.mjs test in this family uses).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForK), JSON.stringify({
    repoPath: Z, branch: "z-disk-branch", reason: "3315b08a: Z's own real on-disk content at k", enteredAt: Date.now(), tokens: ["zdisk-token"],
  }, null, 2) + "\n");

  check("(precondition) Z reads blocked before the clear", !assertRepoNotQuarantined(Z).ok);
  check("(precondition) M reads blocked before the clear", !assertRepoNotQuarantined(M).ok);
  check("(precondition) W reads blocked before the clear", !assertRepoNotQuarantined(W).ok);
  check("(precondition) Z carries shared-token only (zdisk-token lives on disk, not yet in memory)", listActiveMergeQuarantines().some((e) => e.repoPath === Z && e.tokens.includes("shared-token") && !e.tokens.includes("zdisk-token")));

  // THE CLEAR under test — lifts "shared-token" everywhere.
  clearMergeQuarantineByToken(M, "shared-token");

  check("*** THE FIX (S1) *** M is fully lifted", assertRepoNotQuarantined(M).ok);
  check("*** THE FIX (S1) *** W's own unrelated quarantine is COMPLETELY untouched (never spliced — proves the ASSIGN-only shape)", listActiveMergeQuarantines().some((e) => e.repoPath === W && e.tokens.length === 1 && e.tokens[0] === "w-private-token"));
  check("*** THE FIX (S1) *** Z is STILL blocked (zdisk-token is genuinely outstanding, never destroyed)", !assertRepoNotQuarantined(Z).ok);
  const zAfter = listActiveMergeQuarantines().find((e) => e.repoPath === Z);
  check("*** THE FIX (S1) *** Z's own shared-token was ACTUALLY dropped (re-derived 'reduce', not left stuck by a swallowed -1)", !!zAfter && !zAfter.tokens.includes("shared-token"));
  check("*** THE FIX (S1) *** Z's own zdisk-token survives the clear untouched", !!zAfter && zAfter.tokens.includes("zdisk-token"));
  check("*** THE FIX (S1) *** Z holds EXACTLY {zdisk-token} — nothing extra, nothing missing", !!zAfter && JSON.stringify([...zAfter.tokens].sort()) === JSON.stringify(["zdisk-token"]));

  // ON DISK: Z's own canonical pending-divert file must reflect the SAME reduced token set.
  const zOnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, zCanonicalName), "utf8")); } catch { return null; } })();
  check("*** THE FIX (S1) *** Z's own on-disk copy holds EXACTLY {zdisk-token} too (shared-token durably dropped)", !!zOnDisk && JSON.stringify([...(zOnDisk.tokens ?? [])].sort()) === JSON.stringify(["zdisk-token"]));

  // shared-token itself must be fully tombstoned — nothing anywhere should still carry it.
  check("*** THE FIX (S1) *** shared-token no longer survives on ANY active entry", !listActiveMergeQuarantines().some((e) => e.tokens.includes("shared-token")));

  // ACROSS A REBOOT: re-import fresh and re-scan — Z must still be blocked by zdisk-token alone.
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([Z, M, W]);
  const zAfterReboot = rb.listActiveMergeQuarantines().find((e) => e.repoPath === Z);
  check("*** REBOOT (S1) *** Z is still blocked, holding EXACTLY {zdisk-token} — shared-token does not re-arm", !!zAfterReboot && JSON.stringify([...zAfterReboot.tokens].sort()) === JSON.stringify(["zdisk-token"]));
  check("*** REBOOT (S1) *** M reads clear after reboot", !rb.listActiveMergeQuarantines().some((e) => e.repoPath === M));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("3315b08a-re-derive-to-remove") — Code Review d7eaad3d test gap 1: same ASSIGN-only shape
// as S1, but the on-disk content at k2 holds ONLY the token being cleared (no survivor), so the
// re-derived plan is REMOVE (not reduce) — exercising the remove branch's own ownedArmedKeys, computed
// fresh via entryStillOwnsKey against the RE-RESOLVED live.entry rather than reused from the stale
// pre-pass plan, and the indexOf(live) splice path (never a stale index). The k2own check below is an
// END-STATE guard only — it cannot isolate ownedArmedKeys' own correctness (see its own comment).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Z2 = path.join(os.tmpdir(), `loom-mq3315b08a-s2-Z2-never-${sfx}`);
  const M2 = path.join(os.tmpdir(), `loom-mq3315b08a-s2-M2-never-${sfx}`);
  const k2 = `mq3315b08a-s2-k2-${sfx}`; // M2's own armed key — its on-disk file holds Z2's identity
  const k2own = `mq3315b08a-s2-k2own-${sfx}`; // Z2's OWN armed key, union-carried through the re-resolve
  const finalBasenameForK2 = `${hashKey(k2)}.json`;
  const z2CanonicalName = pendingDivertFilenameForTest(Z2);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Z2, branch: "z2-branch", reason: "3315b08a S2: Z2's own record, at its own canonical pending-divert name", enteredAt: Date.now(), tokens: ["shared-token-2"], armedKeys: [k2own] }, sourceFile: z2CanonicalName },
    { entry: { repoPath: M2, branch: "m2-branch", reason: "3315b08a S2: real clear target (M2), processed first", enteredAt: Date.now(), tokens: ["shared-token-2"], armedKeys: [k2] }, sourceFile: "pending-3315b08a-s2-m2-test.json" },
  ]);
  // Z2 twin-by-identity at k2own (not by reference) — same technique as S1's occupantMid, so pre-pass
  // entryStillOwnsKey(k2own, Z2.entry) is genuinely true without making Z2 itself an active twin.
  setActiveQuarantineTestOnly(k2own, { repoPath: Z2, branch: "occupant-z2-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token-2"] });
  setActiveQuarantineTestOnly(k2, { repoPath: M2, branch: "occupant-m2-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token-2"] });

  // k2's own REAL on-disk file — Z2's own identity's content, holding ONLY shared-token-2 (no survivor,
  // unlike S1's zdisk-token) so the union produces an EMPTY remainder: REMOVE, not reduce.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForK2), JSON.stringify({
    repoPath: Z2, branch: "z2-disk-branch", reason: "3315b08a S2: Z2's own real on-disk content at k2 (no survivor)", enteredAt: Date.now(), tokens: ["shared-token-2"],
  }, null, 2) + "\n");
  // Z2's OWN armed key (k2own) ALSO needs a REAL on-disk latch file before the clear — a prior draft
  // asserted only "the file doesn't exist after", which is vacuous when no file exists before either.
  // This writes a real one so the END STATE is a genuine assertion, but it CANNOT isolate
  // ownedArmedKeys' own correctness in the remove branch: verified (card 0faffa95's own review) that
  // forcing ownedArmedKeys to [] here still leaves this check green, because
  // clearMergeQuarantineByToken's own phase 2 independently re-discovers and cleans k2own regardless —
  // see docs/decisions/0faffa95-*.md's own "test-design limitation" note for the full argument (in
  // short: a REMOVE-shaped clear's live.entry.tokens is exactly the one token being cleared, and
  // entryStillOwnsKey's subset test forces any occupant it can find to carry that SAME token, which
  // phase 2's own token-filtered walk would independently reach anyway). This check still has value as
  // an end-to-end outcome guard (k2own's file is gone, by whichever path), just not as a unit check of
  // ownedArmedKeys specifically.
  const k2ownLatchPath = path.join(MERGE_QUARANTINE_DIR, `${hashKey(k2own)}.json`);
  fs.writeFileSync(k2ownLatchPath, JSON.stringify({
    repoPath: Z2, branch: "occupant-z2-branch", reason: "3315b08a S2: Z2's own real on-disk latch at k2own, pre-clear", enteredAt: Date.now(), tokens: ["shared-token-2"],
  }, null, 2) + "\n");

  check("(precondition S2) Z2 reads blocked before the clear", !assertRepoNotQuarantined(Z2).ok);
  check("(precondition S2) M2 reads blocked before the clear", !assertRepoNotQuarantined(M2).ok);

  clearMergeQuarantineByToken(M2, "shared-token-2");

  check("*** S2 *** M2 is fully lifted", assertRepoNotQuarantined(M2).ok);
  check("*** S2 *** Z2 is fully lifted too (re-derived REMOVE, not left stuck as a stale reduce)", assertRepoNotQuarantined(Z2).ok);
  check("*** S2 *** no entry anywhere still carries Z2's identity (the re-resolved pending slot was actually spliced, never left dangling at a stale index)", !listActiveMergeQuarantines().some((e) => e.repoPath === Z2));
  check("*** S2 *** Z2's OWN armed key k2own has no latch file left after the clear (end-state only — see the comment above for why this can't isolate ownedArmedKeys itself in the remove branch)", !fs.existsSync(k2ownLatchPath));

  // ACROSS A REBOOT: re-import fresh and re-scan — Z2 must read clear, not resurrected by a stale file.
  const rb2 = await rebootSim();
  rb2.reenterMergeQuarantinesAtBoot([Z2, M2]);
  check("*** REBOOT (S2) *** Z2 reads clear after reboot", !rb2.listActiveMergeQuarantines().some((e) => e.repoPath === Z2));
  check("*** REBOOT (S2) *** M2 reads clear after reboot", !rb2.listActiveMergeQuarantines().some((e) => e.repoPath === M2));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3a ("3315b08a-fail-closed-ambiguous-multiple") — Code Review d7eaad3d test gap 2 (the >1
// half): Y's own canonical slot gets ASSIGNed over by M3's protect call (same ASSIGN-only shape as S1),
// but an UNTOUCHED, independent twin (Y_twin, same identity, a DIFFERENT token never cleared, sitting at
// an unrelated sourceFile M3's protect call never reaches) ALSO survives — so when Y is re-resolved, the
// identity-based scan finds TWO live candidates, not one, and must fail closed (log loudly, leave both
// untouched) rather than guess which is "the" target.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Y = path.join(os.tmpdir(), `loom-mq3315b08a-s3a-Y-never-${sfx}`);
  const M3 = path.join(os.tmpdir(), `loom-mq3315b08a-s3a-M3-never-${sfx}`);
  const W3 = path.join(os.tmpdir(), `loom-mq3315b08a-s3a-W3-never-${sfx}`);
  const k3 = `mq3315b08a-s3a-k3-${sfx}`;
  const finalBasenameForK3 = `${hashKey(k3)}.json`;
  const yCanonicalName = pendingDivertFilenameForTest(Y);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Y, branch: "y-branch", reason: "3315b08a S3a: Y's own record, at its own canonical pending-divert name", enteredAt: Date.now(), tokens: ["shared-token-3"] }, sourceFile: yCanonicalName },
    { entry: { repoPath: M3, branch: "m3-branch", reason: "3315b08a S3a: real clear target (M3), processed first", enteredAt: Date.now(), tokens: ["shared-token-3"], armedKeys: [k3] }, sourceFile: "pending-3315b08a-s3a-m3-test.json" },
    // Y_twin: SAME identity as Y, but a DIFFERENT token M3's own clear never touches, sitting at an
    // UNINVOLVED sourceFile — never matched by M3's protect call (different basename than k3's own), so
    // it stays completely untouched throughout, purely to make Y's own re-resolve-by-identity ambiguous.
    { entry: { repoPath: Y, branch: "y-twin-branch", reason: "3315b08a S3a: untouched independent twin, same identity as Y", enteredAt: Date.now(), tokens: ["y-twin-private-token"] }, sourceFile: "pending-3315b08a-s3a-ytwin-test.json" },
    // W3: a THIRD, unrelated identity squatting k3's own physical latch basename — mirrors S1's own W.
    // deleteMergeQuarantineLatchByKey's own `foreignPending` gate requires SOME pending entry physically
    // AT k3's own hashed basename (with an identity != M3's) before it will even attempt the protect call
    // at all; without this, the protect call that detaches Y's own canonical slot never fires.
    { entry: { repoPath: W3, branch: "w3-branch", reason: "3315b08a S3a: bystander, squats k3's own physical file", enteredAt: Date.now(), tokens: ["w3-private-token"] }, sourceFile: finalBasenameForK3 },
  ]);
  setActiveQuarantineTestOnly(k3, { repoPath: M3, branch: "occupant-m3-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token-3"] });

  // k3's own REAL on-disk file — Y's own identity's content (the same shared-token-3 M3 is lifting).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, finalBasenameForK3), JSON.stringify({
    repoPath: Y, branch: "y-disk-branch", reason: "3315b08a S3a: Y's own real on-disk content at k3", enteredAt: Date.now(), tokens: ["shared-token-3"],
  }, null, 2) + "\n");

  check("(precondition S3a) Y reads blocked before the clear", !assertRepoNotQuarantined(Y).ok);
  check("(precondition S3a) M3 reads blocked before the clear", !assertRepoNotQuarantined(M3).ok);

  let ambiguousLogSeen = false;
  const origConsoleError = console.error;
  console.error = (...args) => { if (String(args[0] ?? "").includes("live same-identity candidate(s)")) ambiguousLogSeen = true; origConsoleError(...args); };
  try {
    clearMergeQuarantineByToken(M3, "shared-token-3");
  } finally {
    console.error = origConsoleError;
  }

  check("*** S3a *** the fail-closed ambiguous-candidate log actually fired (2 live matches, not 1)", ambiguousLogSeen);
  check("*** S3a *** M3 is fully lifted (Y's own ambiguity never blocks an UNRELATED target's own clear)", assertRepoNotQuarantined(M3).ok);
  check("*** S3a *** Y is STILL blocked (shared-token-3 was never guessed-cleared on an ambiguous match)", !assertRepoNotQuarantined(Y).ok);
  const yEntriesAfter = listActiveMergeQuarantines().filter((e) => e.repoPath === Y);
  check("*** S3a *** BOTH of Y's own live candidates survive untouched, nothing destroyed or merged", yEntriesAfter.length === 2);
  check("*** S3a *** Y's reassigned canonical slot still carries shared-token-3 (left exactly as found, not reduced/removed)", yEntriesAfter.some((e) => e.tokens.includes("shared-token-3")));
  check("*** S3a *** Y_twin's own private token survives completely untouched", yEntriesAfter.some((e) => e.tokens.includes("y-twin-private-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3b ("3315b08a-fail-closed-ambiguous-zero") — Code Review d7eaad3d test gap 2 (the 0 half).
// A genuine 0-live-candidates state is PROVABLY UNREACHABLE via any real protectOccupantContentBeforeDelete
// mutation (every real branch there either re-points an EXISTING same-identity slot, preserving it, or
// mints an independent new one — never fewer; see docs/decisions/0faffa95-*.md's own Do-not). This drives
// the private function directly via the clearTokenFromPendingIndicesTestOnly seam, passing the SAME
// index TWICE — something collectPendingIndices (the real caller) can never produce, since it enumerates
// each index at most once — so the first pass's own ordinary "remove" splice runs, and the SECOND pass
// (same stale `pending` reference, now genuinely detached with the array left EMPTY) exercises the
// 0-candidate branch for real.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // Fresh module instance — its own module-global pendingUnresolvedQuarantines/activeQuarantines start
  // empty. The useOwnLoomHome({fresh:true}) call below does NOT, by itself, isolate the physical
  // MERGE_QUARANTINE_DIR this fresh instance reads/writes: that path is derived from paths.ts, a
  // statically-imported module Node's own cache never re-evaluates across a cache-busted dynamic
  // re-import of merge-quarantine.js alone, so it stays pinned to whatever LOOM_HOME resolved to at this
  // whole process's FIRST import, regardless of any later process.env.LOOM_HOME reassignment — a fresh
  // module instance still boot-scans the SAME physical directory S1/S2/S3a's own real latch writes have
  // been cluttering, which would make B land at some OTHER index than 0 if assumed to be index 0. This
  // scenario therefore resolves B's REAL index below (findIdxFresh) rather than relying on isolation.
  useOwnLoomHome("loom-mq3315b08a-s3b-", { fresh: true });
  const freshMod = await rebootSim();
  const {
    assertRepoNotQuarantined: assertRepoNotQuarantinedFresh, listActiveMergeQuarantines: listActiveMergeQuarantinesFresh,
    reenterMergeQuarantinesAtBootTestOnly: reenterFresh, clearTokenFromPendingIndicesTestOnly: clearTestOnlyFresh,
    findPendingIndexByIdentityTestOnly: findIdxFresh,
  } = freshMod;

  const sfx = freshSfx();
  const B = path.join(os.tmpdir(), `loom-mq3315b08a-s3b-B-never-${sfx}`);
  const bCanonicalName = pendingDivertFilenameForTest(B);

  reenterFresh([], [
    { entry: { repoPath: B, branch: "b-branch", reason: "3315b08a S3b: sole entry, no armedKeys", enteredAt: Date.now(), tokens: ["token-4"] }, sourceFile: bCanonicalName },
  ]);

  check("(precondition S3b) B reads blocked before the clear", !assertRepoNotQuarantinedFresh(B).ok);
  // B's own REAL index — see this scenario's own opening comment for why index 0 can't be assumed.
  const bIdx = findIdxFresh(B);
  check("(precondition S3b) B's own index was found", bIdx !== -1);

  let zeroCandidateLogSeen = false;
  const origConsoleError = console.error;
  console.error = (...args) => { if (String(args[0] ?? "").includes("0 live same-identity candidate(s)")) zeroCandidateLogSeen = true; origConsoleError(...args); };
  let threw = null;
  try {
    clearTestOnlyFresh([bIdx, bIdx], "token-4");
  } catch (e) {
    threw = e;
  } finally {
    console.error = origConsoleError;
  }

  check("*** S3b *** calling with a duplicated index never throws", threw === null);
  check("*** S3b *** the fail-closed ambiguous-candidate log fired with 0 live matches", zeroCandidateLogSeen);
  check("*** S3b *** B is fully lifted (the FIRST pass's own ordinary remove already did the real work; the second, duplicate pass is a correctly-harmless no-op)", assertRepoNotQuarantinedFresh(B).ok);
  check("*** S3b *** nothing resurrected or duplicated — no live entry anywhere still carries B's identity", !listActiveMergeQuarantinesFresh().some((e) => e.repoPath === B));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearTokenFromPendingIndices re-resolves a REPLACED (not spliced) pending "
    + "target by its live identity and re-derives the remove/reduce plan from its CURRENT tokens, instead "
    + "of logging a -1 and leaving the real token stuck forever."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 3315b08a.`);
process.exit(failures === 0 ? 0 : 1);
