import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6b327712 (item 1) — pins that a writePendingDivertFile rebase never resurrects an
// already-reduced contributor from a dual-tracked twin's own stale pending file, which pre-fix also
// over-reported that contributor as newly "lifted" on a later real clearMergeQuarantineByKey.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq6b32-i1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mod = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Registers every repo it creates for the SAME guaranteed cleanup useOwnLoomHome's own LOOM_HOME uses
// (card 08638e79's beforeExit + sync-exit backstop) — survives a failed run OR a bare process.exit(),
// unlike a hand-rolled try/finally (process.exit() skips a pending finally block entirely).
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq6b32-i1-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-6b327712 item1 (${tag})\n`);
  execSync(`git init -q && git config user.email mq6b32i1@loom && git config user.name mq6b32i1 && git add -A && git -c user.email=mq6b32i1@loom -c user.name=mq6b32i1 commit -q -m init`, { cwd: repo });
  return repo;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // X: an unresolvable ghost identity, dual-tracked (883e29bc) — armed at a key K AND separately held
  // pending via its own physical pending-divert file P, the SAME object reference in both
  // activeQuarantines/pendingUnresolvedQuarantines (the shape pushPendingQuarantineTestOnly's own doc
  // comment calls a genuine dual-track model). C: a contributor already correctly reduced out of X's
  // record via reduceForeignUnionContributor/markIdentityAsReducedOnForeignKey's own durable write to
  // K's REAL final file — that write never touches a separate pending sourceFile, so P's own on-disk
  // bytes are deliberately constructed here to stay stale (still naming C), exactly as that write leaves
  // them in production.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const X = path.join(os.tmpdir(), `loom-mq6b32-ghost-X-${freshSfx()}`);
  const K = "mq6b32-i1-key-" + freshSfx();
  const C = path.join(os.tmpdir(), `loom-mq6b32-ghost-C-${freshSfx()}`);
  // Production records a reduced-out contributor as its directPathIdentity (reduceForeignUnionContributor /
  // markIdentityAsReducedOnForeignKey add the identity, never the raw path). The raw path only differs from
  // it on win32 (lowercased), which used to mask the reduced-arm behaviour asserted at the end of this
  // scenario on that platform alone — so the fixture uses the production form on every platform.
  const Cid = mod.directPathIdentity(C);
  const t1 = "tok-t1-" + freshSfx();
  const t2 = "tok-t2-" + freshSfx();
  const enteredAt = Date.now();

  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });

  // The ALREADY-REDUCED shared object: contributorRepoPaths dropped, reducedContributorRepoPaths:[C].
  const reducedEntry = { repoPath: X, branch: "loom/x-branch", reason: "merge in progress for X (6b327712 item1)", enteredAt, tokens: [t1, t2], contributorRepoPaths: undefined, reducedContributorRepoPaths: [Cid], armedKeys: [K] };

  // X's own separate PENDING file P: STALE — still names C in contributorRepoPaths.
  const pendingBasename = `mq6b32-i1-pending-${freshSfx()}.json`;
  const pendingPath = path.join(mod.MERGE_QUARANTINE_DIR, pendingBasename);
  const staleDiskPending = { repoPath: X, branch: "loom/x-branch", reason: "merge in progress for X (6b327712 item1)", enteredAt, tokens: [t1, t2], contributorRepoPaths: [C] };
  fs.writeFileSync(pendingPath, JSON.stringify(staleDiskPending));

  mod.setActiveQuarantineTestOnly(K, reducedEntry);
  mod.pushPendingQuarantineTestOnly(reducedEntry, pendingBasename); // SAME object reference — genuine dual-track

  check("precondition: X's own stale pending file P still names contributor C on disk", JSON.stringify(JSON.parse(fs.readFileSync(pendingPath, "utf8")).contributorRepoPaths) === JSON.stringify([C]));
  const beforeRebase = mod.stillBlockedEntryFor(X); // PURE peek — never activeMergeQuarantineFor/resolveQuarantineFor
  check("precondition: X correctly shows NO contributorRepoPaths before the rebase", !!beforeRebase && beforeRebase.contributorRepoPaths === undefined);
  check("precondition: reducedContributorRepoPaths already correctly names C", Array.isArray(beforeRebase.reducedContributorRepoPaths) && beforeRebase.reducedContributorRepoPaths.includes(Cid));

  const idx = mod.findPendingIndexByIdentityTestOnly(X);
  check("precondition: X's pending wrapper found", idx !== -1);

  // Exercise the reduce branch on the PENDING side: clear t1, leaving t2 outstanding.
  mod.clearTokenFromPendingIndicesTestOnly([idx], t1);

  const afterRebase = mod.stillBlockedEntryFor(X);
  check("*** FIX *** C is NOT resurrected into contributorRepoPaths — RED before this card (resurrected)", afterRebase?.contributorRepoPaths === undefined);
  check("reducedContributorRepoPaths still correctly names C (unchanged by this fix)", Array.isArray(afterRebase?.reducedContributorRepoPaths) && afterRebase.reducedContributorRepoPaths.includes(Cid));
  const onDiskAfter = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  check("*** FIX *** on-disk P no longer names C in contributorRepoPaths either", onDiskAfter.contributorRepoPaths === undefined || !onDiskAfter.contributorRepoPaths.includes(C));

  // The consequence: a real human /clear on X's own active key reports C exactly ONCE, via the reduced-out
  // arm (C's identity is still blocked by X until X is cleared — 3b1944b6 rounds 6-8). It must not be
  // listed twice (once via the resurrected contributor entry, once via the reduced arm). This does not
  // discriminate the pre-fix code on its own (the lifted list is de-duplicated); the three resurrection
  // checks above are what pin this card's fix.
  const clearResult = mod.clearMergeQuarantineByKey(K, X, undefined, true);
  check("C is reported as lifted exactly once, via the reduced-out arm", clearResult.liftedRepoPaths.filter((p) => mod.directPathIdentity(p) === Cid).length === 1);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (RE-RAISE, Round 2 B-1) reducedContributorRepoPaths is STICKY and a re-raise can LEGITIMATELY re-add
  // a previously-reduced contributor R to contributorRepoPaths — BOTH fields naming R at once is then a
  // VALID state, not only the stale-pending-file shape above. Y: a ghost dual-tracked (883e29bc) at a
  // REAL repo R's own key K2 (armed AND pending via its own stale file P2, reducedContributorRepoPaths:
  // [R] already). A REAL enterMergeQuarantine(R) re-raise folds R into contributorRepoPaths (R's own
  // token survives inside the SAME union). Clearing an unrelated token on Y's pending side must NOT strip
  // R back out — memory's own contributorRepoPaths still names it — or clear-by-id's own ambiguity
  // refusal (82032b5c/9a55fb90) stops firing and a clear against Y's own id would hard-lift R's genuinely
  // live, just-raised token too.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R = makeRepo("r");
    const K2 = canonicalRepoLockKey(R);
    const Y = path.join(os.tmpdir(), `loom-mq6b32-i1-ghost-Y-${freshSfx()}`);
    const u1 = "tok-u1-" + freshSfx();
    const u2 = "tok-u2-" + freshSfx();
    const enteredAt2 = Date.now();

    // resolvedKey:K2 — the realistic shape (matches item 3's own dual-track construction): a real
    // armForeignOrphanContentInMemoryIfUnenforced-style arm reaches K2 PRECISELY via Y's own resolvedKey
    // field, so Y genuinely carries it; this also lets PASS 1 re-arm Y at K2 on a reboot (secondaryKeysToAttempt).
    const reducedEntry2 = { repoPath: Y, branch: "loom/y-branch", reason: "merge in progress for Y (6b327712 item1 re-raise)", enteredAt: enteredAt2, tokens: [u1, u2], contributorRepoPaths: undefined, reducedContributorRepoPaths: [R], resolvedKey: K2, armedKeys: [K2] };
    const pendingBasename2 = `mq6b32-i1-pending2-${freshSfx()}.json`;
    const pendingPath2 = path.join(mod.MERGE_QUARANTINE_DIR, pendingBasename2);
    fs.writeFileSync(pendingPath2, JSON.stringify({ repoPath: Y, branch: "loom/y-branch", reason: "merge in progress for Y (6b327712 item1 re-raise)", enteredAt: enteredAt2, tokens: [u1, u2], contributorRepoPaths: [R], resolvedKey: K2 }));
    mod.setActiveQuarantineTestOnly(K2, reducedEntry2);
    mod.pushPendingQuarantineTestOnly(reducedEntry2, pendingBasename2);

    const tokR = mod.enterMergeQuarantine(R, "loom/r-branch", "R's own real re-raise (6b327712 item1 re-raise)");
    const afterReraise = mod.stillBlockedEntryFor(Y);
    check("(re-raise precondition) R's own re-raise folds it into contributorRepoPaths in memory", Array.isArray(afterReraise?.contributorRepoPaths) && afterReraise.contributorRepoPaths.includes(R));
    check("(re-raise precondition) reducedContributorRepoPaths STILL also names R — the valid simultaneous state", Array.isArray(afterReraise?.reducedContributorRepoPaths) && afterReraise.reducedContributorRepoPaths.includes(R));
    check("(re-raise precondition) R's own fresh token survived the fold", afterReraise.tokens.includes(tokR));

    const idx2 = mod.findPendingIndexByIdentityTestOnly(Y);
    check("(re-raise precondition) Y's pending wrapper found", idx2 !== -1);
    mod.clearTokenFromPendingIndicesTestOnly([idx2], u1); // reduce: u2 + tokR still outstanding

    const afterRebase2 = mod.stillBlockedEntryFor(Y);
    check("*** FIX (Round 2 B-1) *** R is NOT stripped from contributorRepoPaths — memory's own current claim is authoritative, RED at ae4db934 (wrongly stripped)", Array.isArray(afterRebase2?.contributorRepoPaths) && afterRebase2.contributorRepoPaths.includes(R));

    const id2 = mod.quarantineLatchIdFor(R);
    const clearByIdResult = mod.clearMergeQuarantineLatchFile(id2);
    check("*** FIX (Round 2 B-1) *** clear-by-id(R) is REFUSED as ambiguous — RED at ae4db934 (wrongly ok:true, hard-lifting R's own live token)", clearByIdResult.ok === false);
    check("R stays blocked in-process after the refused clear-by-id", mod.stillBlockedEntryFor(R) !== undefined);

    let bootReimportCounter2 = 0;
    async function freshBootModule2() {
      bootReimportCounter2++;
      return await import(`${pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href}?rb=${bootReimportCounter2}`);
    }
    const booted2 = await freshBootModule2();
    booted2.reenterMergeQuarantinesAtBoot([R]);
    check("R stays blocked after a reboot too", booted2.stillBlockedEntryFor(R) !== undefined);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
