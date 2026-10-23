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
  reenterMergeQuarantinesAtBoot,
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

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — clearTokenFromPendingIndices re-resolves a REPLACED (not spliced) pending "
    + "target by its live identity and re-derives the remove/reduce plan from its CURRENT tokens, instead "
    + "of logging a -1 and leaving the real token stuck forever."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 3315b08a.`);
process.exit(failures === 0 ? 0 : 1);
