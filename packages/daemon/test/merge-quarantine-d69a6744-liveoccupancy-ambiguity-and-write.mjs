import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card d69a6744 — the two remaining armedKeys-only consumers 1fc3a561 left untouched:
//   SITE 1 (~:531) ambiguousIdentitiesForLatchId: `entry.armedKeys?.find(...) ?? entry.armedKeys?.[0]`
//   resolves key=undefined for a re-pointed twin (armedKeys:[]), so siblingRepoPaths is ALWAYS [] even
//   when a real canonical sibling collides at the twin's own LIVE-armed key. Advisory-TEXT only (the real
//   clear-by-id decision, clearMergeQuarantineLatchFile, independently re-derives its own key from a live
//   activeQuarantines map scan and never calls this function) — investigated, confirmed NOT fail-open.
//
//   SITE 2 (~:1399) writeMergeQuarantineLatch's freshSecondaryKeys: `(entry.armedKeys ?? []).filter(k =>
//   k !== ownKeyForWrite)` persists resolvedKey/resolvedKeys from STALE armedKeys alone. Investigated and
//   found a REAL, REPRODUCIBLE FAIL-OPEN (not just a theoretical one — the reviewer's single probe on the
//   card did not fail open; this is the proof it can): when a degraded twin's own armedKeys carries a
//   stale key that now genuinely belongs to a DIFFERENT, REGISTERED repo (a "foreign" key), persisting
//   that foreign key into resolvedKey(s) makes PASS1's degraded-arm re-resolve logic
//   (armKeyUnlessDegradedCollision, via informativeKeysFor) durably UNION the degraded twin's own token
//   into the foreign repo's genuine quarantine entry on the VERY NEXT REBOOT — with no clear ever run.
//   Two confirmed shapes:
//     PRIMARY (construction 3 of the investigation) — an ACTIVE-ONLY dual-key twin (no pending backstop
//     at all). After reboot, the twin's own identity becomes COMPLETELY UNREACHABLE by its own repoPath
//     (its quarantine is silently lost) AND its token bleeds into the foreign repo's own active entry.
//     SECOND (construction 2) — a PENDING twin (tiedViaKeyOrOrphanRef reduce shape). After reboot, the
//     foreign repo's own entry is contaminated with the twin's token; clearing the foreign repo by its
//     OWN token no longer fully unblocks it (wrongly stranded by a token it never owned).
//
// Fix (Lead-approved, matching c52b290e/1fc3a561's own established pattern): both sites now derive their
// candidate key set from LIVE occupancy (liveArmedKeysOf) rather than bare armedKeys; site 2 additionally
// filters through entryStillOwnsKey so a foreign key is never persisted even though it's still read off
// armedKeys as a UNION source elsewhere.
//
// SCENARIO 4 is a GREEN-ONLY regression leg (no card-shape bug to reproduce) proving the entryStillOwnsKey
// filter does NOT drop a LEGITIMATE secondary — including one admitted via the SUBSET-TOKEN branch (a
// different, same-identity object occupying the other key), not just the trivial reference-equality case
// 6be6c9ff's own corpus already covers.
//
// The resolvedKeys-RETENTION residual (entry.resolvedKeys/resolvedKey themselves can already carry a
// foreign key forward via unionResolvedKeysRetaining's own never-drop union, if an earlier write/reconcile
// already contaminated them) is DELIBERATELY OUT OF SCOPE here — Lead ruling, filed as card f575cebf.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-mqd69a6744-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByKey, clearMergeQuarantineByRecordedPath, clearMergeQuarantineByToken,
  listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly,
  reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot, enterMergeQuarantine,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=mqd69a6744@loom -c user.name=mqd69a6744";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqd69a6744-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# d69a6744 fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

console.log("\n=== SCENARIO 1 (SITE 1) — ambiguousIdentitiesForLatchId's text correctly flags a real sibling collision ===\n");

function scenario1_site1AmbiguityText() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mqd69a6744-S1-T-never-${sfx}`);
  const tok = `tok-${sfx}`;

  // F: a REAL, resolvable repo that genuinely, canonically keys to kShared — the real sibling that
  // SHOULD make T's own latch id ambiguous.
  const F = makeToplevelRepo("S1-F");
  const kShared = canonicalRepoLockKey(F);
  // F sits PENDING (not yet resolved/armed) at kShared — the 9a55fb90 "resolvable pending sibling"
  // collision shape ambiguousIdentitiesForLatchId exists to catch.
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: { repoPath: F, branch: "f-branch", reason: "S1: real resolvable sibling", enteredAt: Date.now(), tokens: [`f-tok-${sfx}`] }, sourceFile: `pending-mqd69a6744-S1-f-${sfx}.json` }]);

  // T: a re-pointed twin — armedKeys:[] (the protectOccupantContentBeforeDelete re-point shape) — but
  // LIVE-armed by reference AT kShared, the exact key F collides at.
  const tEntry = { repoPath: T, branch: "t-branch", reason: "S1: T re-pointed, armedKeys:[]", enteredAt: Date.now(), tokens: [tok], armedKeys: [] };
  setActiveQuarantineTestOnly(kShared, tEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kShared)}.json`), JSON.stringify({
    repoPath: T, branch: "t-branch", reason: "S1 fixture", enteredAt: Date.now(), tokens: [tok],
  }, null, 2) + "\n");

  check("(S1 precondition) T reads blocked", !assertRepoNotQuarantined(T).ok);
  const refusal = assertRepoNotQuarantined(T);
  console.log("(S1) assertRepoNotQuarantined(T).reason:\n  " + refusal.reason);

  check("*** SITE 1 FIX *** the refusal text correctly flags the latch id as AMBIGUOUS (names the real sibling F)",
    refusal.reason.includes("ambiguous right now") && refusal.reason.includes(F));
  check("*** SITE 1 FIX *** the refusal text does NOT unconditionally offer the bare-id shortcut for an ambiguous id",
    !refusal.reason.includes(`"id"`) || refusal.reason.includes("ambiguous right now"));
}

scenario1_site1AmbiguityText();

console.log("\n=== SCENARIO 2 (SITE 2, PRIMARY) — active-only dual-key twin: own quarantine lost + foreign repo contaminated ===\n");

async function scenario2_activeOnlyTwinPrimary() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mqd69a6744-S2-T-never-${sfx}`);
  const kTwinA = `mqd69a6744-S2-kTwinA-${sfx}`;
  const kTwinB = `mqd69a6744-S2-kTwinB-${sfx}`;
  const sharedToken = `shared-${sfx}`;
  const privateToken = `private-${sfx}`; // survives -> forces reduce, not remove

  // F: a REAL, resolvable, REGISTERED repo with its own genuine, currently-armed, unrelated quarantine.
  const F = makeToplevelRepo("S2-F");
  const kF = canonicalRepoLockKey(F);
  const fToken = enterMergeQuarantine(F, "f-branch", "S2: F's own genuine, unrelated quarantine");
  check("(S2 precondition) F reads blocked (genuine quarantine)", !assertRepoNotQuarantined(F).ok);

  // T: an ACTIVE-ONLY dual-key twin — armed by reference at kTwinA/kTwinB, NEVER present in
  // pendingUnresolvedQuarantines (no independent pending-divert backstop can mask the bug here). STALE,
  // FOREIGN armedKeys: [kF] — simulating the pre-existing, Lead-acknowledged-open root cause
  // (protectOccupantContentBeforeDelete's re-point never stamps armedKeys) handing this entry a key that
  // genuinely belongs to someone else.
  const tEntry = {
    repoPath: T, branch: "twin-branch", reason: "S2: active-only dual-key twin, stale armedKeys=[kF]",
    enteredAt: Date.now(), tokens: [sharedToken, privateToken], armedKeys: [kF],
  };
  setActiveQuarantineTestOnly(kTwinA, tEntry);
  setActiveQuarantineTestOnly(kTwinB, tEntry);
  for (const k of [kTwinA, kTwinB]) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(k)}.json`), JSON.stringify({
      repoPath: T, branch: "twin-branch", reason: "S2 fixture", enteredAt: Date.now(), tokens: [sharedToken, privateToken],
    }, null, 2) + "\n");
  }

  check("(S2 precondition) T reads blocked before the clear", !assertRepoNotQuarantined(T).ok);

  // THE REAL CLEAR — clearMergeQuarantineByToken routes an active, non-pending twin through
  // clearActiveEntryTokenAtKey's reduce branch, which calls writeMergeQuarantineLatch (site 2) at every
  // live-armed key, with NO pending-divert backstop write.
  clearMergeQuarantineByToken(T, sharedToken);

  const kTwinAAfter = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinA)}.json`), "utf8"));
  const kTwinBAfter = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinB)}.json`), "utf8"));
  const kTwinAInformative = [kTwinAAfter.resolvedKey, ...(kTwinAAfter.resolvedKeys ?? [])].filter(Boolean);
  const kTwinBInformative = [kTwinBAfter.resolvedKey, ...(kTwinBAfter.resolvedKeys ?? [])].filter(Boolean);

  check("*** SITE 2 FIX *** kTwinA's persisted record no longer names the FOREIGN key kF", !kTwinAInformative.includes(kF));
  check("*** SITE 2 FIX *** kTwinB's persisted record no longer names the FOREIGN key kF", !kTwinBInformative.includes(kF));
  check("(S2) T still correctly blocked in-process (privateToken genuinely outstanding)", !assertRepoNotQuarantined(T).ok);
  check("(S2) F still correctly, independently blocked in-process", !assertRepoNotQuarantined(F).ok);

  // === REBOOT in a FRESH process-module-instance on the SAME temp LOOM_HOME ===
  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([F]);

  const fEntriesAfter = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === F);
  check("*** THE FAIL-OPEN POLARITY, F SIDE *** F's own entry NEVER carries T's token after reboot", !fEntriesAfter.some((e) => (e.tokens ?? []).includes(privateToken)));
  check("*** THE FAIL-OPEN POLARITY, T SIDE *** T is STILL BLOCKED after reboot (privateToken's own quarantine survives)", !rb.assertRepoNotQuarantined(T).ok);

  // The ORIGINAL (pre-fix) consequence this closes: F could no longer be fully unblocked by clearing its
  // OWN token alone, once contaminated. Confirm post-fix this is no longer true.
  rb.clearMergeQuarantineByToken(F, fToken);
  check("*** THE FAIL-OPEN POLARITY, F SIDE *** F is fully unblocked after clearing ONLY its own token (no stranding)", rb.assertRepoNotQuarantined(F).ok);
  check("*** THE FAIL-OPEN POLARITY, T SIDE *** T is STILL BLOCKED after F's own clear (never silently lifted)", !rb.assertRepoNotQuarantined(T).ok);
}

await scenario2_activeOnlyTwinPrimary();

console.log("\n=== SCENARIO 3 (SITE 2, SECOND) — pending twin: foreign repo stranded by a contaminated union ===\n");

async function scenario3_pendingTwinSecond() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mqd69a6744-S3-T-never-${sfx}`);
  const kMain = `mqd69a6744-S3-kMain-${sfx}`;
  const kTwinA = `mqd69a6744-S3-kTwinA-${sfx}`;
  const kTwinB = `mqd69a6744-S3-kTwinB-${sfx}`;
  const sharedToken = `shared-${sfx}`;
  const privateToken = `private-${sfx}`;

  const F = makeToplevelRepo("S3-F");
  const kF = canonicalRepoLockKey(F);
  const fToken = enterMergeQuarantine(F, "f-branch", "S3: F's own genuine, unrelated quarantine");
  check("(S3 precondition) F reads blocked (genuine quarantine)", !assertRepoNotQuarantined(F).ok);

  const entry = { repoPath: T, branch: "main-branch", reason: "S3: clear target", enteredAt: Date.now(), tokens: [sharedToken] };
  const pSourceFile = `pending-mqd69a6744-S3-${sfx}.json`;
  entry.orphanLatchFiles = [pSourceFile];
  const pEntry = {
    repoPath: T, branch: "twin-branch", reason: "S3: tiedViaKeyOrOrphanRef reduce twin, stale armedKeys=[kF]",
    enteredAt: Date.now(), tokens: [sharedToken, privateToken], armedKeys: [kF],
  };

  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: pSourceFile }]);
  setActiveQuarantineTestOnly(kMain, entry);
  setActiveQuarantineTestOnly(kTwinA, pEntry);
  setActiveQuarantineTestOnly(kTwinB, pEntry);
  for (const [k, branch, tokens] of [
    [kMain, "main-branch", [sharedToken]],
    [kTwinA, "twin-branch", [sharedToken, privateToken]],
    [kTwinB, "twin-branch", [sharedToken, privateToken]],
  ]) {
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(k)}.json`), JSON.stringify({
      repoPath: T, branch, reason: "S3 fixture", enteredAt: Date.now(), tokens,
    }, null, 2) + "\n");
  }

  check("(S3 precondition) T reads blocked before the clear", !assertRepoNotQuarantined(T).ok);

  clearMergeQuarantineByKey(kMain, T);

  const kTwinAAfter = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kTwinA)}.json`), "utf8"));
  const kTwinAInformative = [kTwinAAfter.resolvedKey, ...(kTwinAAfter.resolvedKeys ?? [])].filter(Boolean);
  check("*** SITE 2 FIX *** kTwinA's persisted record no longer names the FOREIGN key kF", !kTwinAInformative.includes(kF));
  check("(S3) T still correctly blocked in-process (privateToken genuinely outstanding)", !assertRepoNotQuarantined(T).ok);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([F]);

  const fEntriesAfter = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === F);
  check("*** THE FAIL-OPEN POLARITY, F SIDE *** F's own entry NEVER carries T's token after reboot", !fEntriesAfter.some((e) => (e.tokens ?? []).includes(privateToken) || (e.tokens ?? []).includes(sharedToken)));
  check("*** THE FAIL-OPEN POLARITY, T SIDE *** T is STILL BLOCKED after reboot", !rb.assertRepoNotQuarantined(T).ok);

  rb.clearMergeQuarantineByToken(F, fToken);
  check("*** THE FAIL-OPEN POLARITY, F SIDE *** F is fully unblocked after clearing ONLY its own token (no stranding by T's foreign token)", rb.assertRepoNotQuarantined(F).ok);
  check("*** THE FAIL-OPEN POLARITY, T SIDE *** T is STILL BLOCKED after F's own clear", !rb.assertRepoNotQuarantined(T).ok);
}

await scenario3_pendingTwinSecond();

console.log("\n=== SCENARIO 4 (GREEN REGRESSION) — a legitimate dual-key entry, including a subset-token-owned secondary, survives reboot ===\n");

async function scenario4_legitimateDualKeyGreenRegression() {
  const sfx = freshSfx();
  const T = path.join(os.tmpdir(), `loom-mqd69a6744-S4-T-never-${sfx}`);
  const key1 = `mqd69a6744-S4-key1-${sfx}`;
  const key2 = `mqd69a6744-S4-key2-${sfx}`;
  const sharedToken = `shared-${sfx}`;
  const privateToken = `private-${sfx}`; // survives -> forces reduce

  // T_main: armed by reference at key1, with a LEGITIMATE (not stale/foreign) armedKeys=[key2] — key2
  // genuinely belongs to the SAME identity, held by a DIFFERENT object (T_sibling), not by reference.
  const tMain = {
    repoPath: T, branch: "main-branch", reason: "S4: legitimate dual-key entry, main side",
    enteredAt: Date.now(), tokens: [sharedToken, privateToken], armedKeys: [key2],
  };
  // T_sibling: a DIFFERENT object, SAME identity (repoPath=T), tokens is a genuine SUBSET of tMain's own
  // tokens (both before and after the clear) — admitted via entryStillOwnsKey's SUBSET branch, never by
  // reference equality (6be6c9ff's own corpus already covers the reference-equality shape).
  const tSibling = {
    repoPath: T, branch: "sibling-branch", reason: "S4: legitimate dual-key entry, subset-token sibling",
    enteredAt: Date.now(), tokens: [privateToken],
  };
  setActiveQuarantineTestOnly(key1, tMain);
  setActiveQuarantineTestOnly(key2, tSibling);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(key1)}.json`), JSON.stringify({
    repoPath: T, branch: "main-branch", reason: "S4 fixture (key1)", enteredAt: Date.now(), tokens: [sharedToken, privateToken],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(key2)}.json`), JSON.stringify({
    repoPath: T, branch: "sibling-branch", reason: "S4 fixture (key2)", enteredAt: Date.now(), tokens: [privateToken],
  }, null, 2) + "\n");

  check("(S4 precondition) T reads blocked before the clear", !assertRepoNotQuarantined(T).ok);

  // Clear sharedToken — only tMain holds it; tSibling (holding only privateToken) is never touched.
  clearMergeQuarantineByToken(T, sharedToken);

  const key1After = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(key1)}.json`), "utf8"));
  const key2After = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(key2)}.json`), "utf8"));
  const key1Informative = [key1After.resolvedKey, ...(key1After.resolvedKeys ?? [])].filter(Boolean);
  const key2Informative = [key2After.resolvedKey, ...(key2After.resolvedKeys ?? [])].filter(Boolean);

  check("*** GREEN REGRESSION *** key1's own persisted record still retains key2 as a live secondary (subset-branch, NOT dropped by the ownership filter)", key1Informative.includes(key2));
  check("*** GREEN REGRESSION *** key2's own persisted record still retains key1 as a live secondary", key2Informative.includes(key1));
  check("(S4) T still correctly blocked in-process (privateToken genuinely outstanding)", !assertRepoNotQuarantined(T).ok);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  check("*** GREEN REGRESSION, REBOOT *** T still reads blocked after reboot — BOTH keys correctly re-armed, neither legitimate secondary was dropped", !rb.assertRepoNotQuarantined(T).ok);
  const tEntriesAfterReboot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === T);
  check("*** GREEN REGRESSION, REBOOT *** the re-armed entry for T still carries privateToken (nothing was silently lost)", tEntriesAfterReboot.some((e) => (e.tokens ?? []).includes(privateToken)));
}

await scenario4_legitimateDualKeyGreenRegression();

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — ambiguousIdentitiesForLatchId and writeMergeQuarantineLatch's freshSecondaryKeys "
    + "both now derive from live occupancy (site 2 additionally filtered by entryStillOwnsKey), closing the "
    + "card d69a6744 fail-open, without dropping a legitimate secondary key."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card d69a6744's fail-open / ambiguity-text hazard.`);
process.exit(failures === 0 ? 0 : 1);
