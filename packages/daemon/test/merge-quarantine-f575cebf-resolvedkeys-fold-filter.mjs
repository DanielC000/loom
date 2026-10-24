import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f575cebf — writeMergeQuarantineLatch's retention union (`unionResolvedKeysRetaining(
// entry.resolvedKeys, freshSecondaryKeys, ...)`) retains entry.resolvedKeys FOREVER, by design (the
// union-never-drop rule of 8db913e2/43cf3b26). d69a6744 correctly filtered the SECOND argument
// (freshSecondaryKeys) through live-occupancy ownership, but entry.resolvedKeys itself (the FIRST,
// UNFILTERED argument) can already be contaminated with a FOREIGN key if an EARLIER write persisted one
// AND reconcileMarkedBasenameBeforeWrite's own fold-in (card 150aed7b) later folds that bad on-disk value
// back into memory, re-persisting it on the very next write — completely bypassing d69a6744's filter,
// which never gets a say over content that entered via the FIRST argument.
//
// THE FIX (Lead ruling, this card): reconcileMarkedBasenameBeforeWrite now filters every newly-FOLDED
// on-disk key (both the whole-record reingest branch and the generic resurrect branch) through
// `positivelyForeignKey` BEFORE it is ever unioned into entry.resolvedKeys. A key is dropped ONLY when the
// live map holds an occupant at that key whose directPathIdentity differs from this entry's own — i.e. a
// key PROVEN to belong to another repo right now. An EMPTY slot, or a same-identity occupant, both
// survive the filter unchanged — this is NOT `entryStillOwnsKey` (which treats an empty slot as
// "unprovable", the wrong polarity here: an entry freshly evicted by the 150aed7b EACCES-during-clear path
// has nothing armed yet, so a LEGITIMATE secondary's own slot reads empty too, and dropping it on that
// basis would be a fail-open in the OTHER direction — the entry never re-arms there after reboot).
//
// SCENARIO "fold-filter-closes-foreign-key" — the full propagation path from the investigate-first phase
// (worker_report blocked, this card), now asserting the FIXED polarity: Y's on-disk record is hand-
// contaminated with a FOREIGN key kF that belongs to a separate, real, currently-ARMED repo F (so the
// filter actually has something live to prove foreignness against). The fold must drop kF; the write must
// not re-persist it; after reboot Y and F stay two separate entries; F carries none of Y's tokens; F
// unblocks cleanly by clearing its own, only-ever-legitimate token; Y stays correctly blocked throughout.
//
// SCENARIO "fold-filter-keeps-empty-slot-secondary" — a GREEN-ONLY regression leg (Lead's own explicit
// ask): Y's on-disk record ALSO carries a second, LEGITIMATE secondary key kS whose slot is EMPTY at fold
// time (nothing currently occupies it — the same shape 150aed7b's own W1/W2 fixture already proves, kept
// here as a dedicated, self-contained leg for this card). The filter must NOT drop kS: Y keeps it through
// the fold and the write, and re-arms at kS after reboot.
//
// SCENARIO "accepted-residual-foreign-key-with-empty-slot" — documents, rather than closes, a named gap
// the Lead's own ruling called out explicitly: if the foreign repo F is NOT currently armed in the live
// map at fold time (never raised, or already cleared), `positivelyForeignKey` cannot prove foreignness —
// the slot reads empty, so kF survives the filter and gets folded in anyway. This is an ACCEPTED residual
// (not widened here) — the eventual closer is card e7652e06, "fix(git): stop boot re-arm merging two
// distinct repos through a contaminated latch resolvedKey" (the "upgrade case": PASS1's own
// armKeyUnlessDegradedCollision unions two resolvable-but-different identities with no identity check
// at all, independent of how resolvedKeys got contaminated).
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-f575cebf-resolvedkeys-fold-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqf575-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  enterMergeQuarantine, clearMergeQuarantineReporting, clearMergeQuarantineByToken,
  markLatchFileUnreadableTestOnly, setActiveQuarantineTestOnly,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqf575@loom -c user.name=mqf575";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqf575-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "R.md"), `# merge-quarantine-f575cebf fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}
function hashForKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
function writeLatchJson(hash, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json`), JSON.stringify(content, null, 2) + "\n");
}
function injectReadFailureOnce(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let count = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      count++;
      throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => count };
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO fold-filter-closes-foreign-key
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n=== SCENARIO fold-filter-closes-foreign-key ===\n");
    const y = makeRepo("y");
    const f = makeRepo("f");
    const kY = canonicalRepoLockKey(y);
    const kF = canonicalRepoLockKey(f);
    const kYHash = hashForKey(kY);
    const kFHash = hashForKey(kF);
    const finalPathY = path.join(MERGE_QUARANTINE_DIR, `${kYHash}.json`);
    const T0 = Date.now() - 120_000;

    // F is OLDER (genuinely raised first, for its own real, unrelated reason) — clean, no secondary keys.
    writeLatchJson(kFHash, {
      repoPath: f, branch: "f-branch", reason: "F's own genuine, pre-existing raise (unrelated to Y)",
      enteredAt: T0, tokens: ["f-token-orig"], provenanceTracked: true,
    });
    // Y is NEWER — initially CLEAN (no contamination yet).
    writeLatchJson(kYHash, {
      repoPath: y, branch: "y-branch-orig", reason: "Y's own genuine raise",
      enteredAt: T0 + 60_000, tokens: ["y-token-orig"], provenanceTracked: true,
    });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) Y is blocked after boot #1", !!activeMergeQuarantineFor(y));
    check("(precondition) F is blocked after boot #1", !!activeMergeQuarantineFor(f));
    const fEntry0 = activeMergeQuarantineFor(f);
    check("(precondition) F's tokens do NOT yet include y-token-orig", !(fEntry0?.tokens ?? []).includes("y-token-orig"));

    // Simulate a PRE-EXISTING contaminated on-disk latch for Y (as a pre-d69a6744-era write bug could
    // leave on a real disk): hand-edit the file to inject the FOREIGN key kF into Y's own resolvedKeys.
    // Y's IN-MEMORY entry stays clean — only the ON-DISK file is contaminated.
    writeLatchJson(kYHash, {
      repoPath: y, branch: "y-branch-orig", reason: "Y's own genuine raise",
      enteredAt: T0 + 60_000, tokens: ["y-token-orig"],
      resolvedKey: kY, resolvedKeys: [kY, kF], // <-- CONTAMINATED: kF is foreign to Y, and F is LIVE/ARMED
      provenanceTracked: true,
    });

    // Trigger the reconcile fold-in: a transient read failure during a clear evicts Y's in-memory entry
    // (per 63e49ee2's documented ordering) while keeping the (now contaminated) file on disk, marking its
    // basename keptUnreadableLatchFiles — same technique as merge-quarantine-reconcile-fold-150aed7b.mjs.
    const inject = injectReadFailureOnce(finalPathY);
    let clearResult;
    try {
      clearResult = clearMergeQuarantineReporting(y);
    } finally {
      inject.restore();
    }
    check("(precondition) the read of Y's own final was actually attempted (and injected to fail)", inject.count() >= 1);
    check("(precondition) clear still reports wasQuarantined:true", clearResult?.wasQuarantined === true);
    check("(precondition) Y's own file survives the failed clear (kept, not deleted)", fs.existsSync(finalPathY));
    check("(precondition) Y's own in-memory entry is gone immediately after the clear", !activeMergeQuarantineFor(y));

    // A fresh raise on Y reaches writeMergeQuarantineLatch's chokepoint for the marked basename,
    // triggering reconcileMarkedBasenameBeforeWrite — which must now DROP kF (F is live/armed at kF with
    // a different identity) before folding anything into entry.resolvedKeys.
    const freshToken = enterMergeQuarantine(y, "y-branch-fresh", "fresh raise after the failed clear");
    check("(precondition) fresh raise reports Y blocked in-memory", !!activeMergeQuarantineFor(y));

    const onDiskAfterRaise = JSON.parse(fs.readFileSync(finalPathY, "utf8"));
    check("*** THE FIX *** on-disk resolvedKeys no longer carries the foreign key kF", !(onDiskAfterRaise.resolvedKeys ?? []).includes(kF));
    check("(sanity) old token survived the fold", (onDiskAfterRaise.tokens ?? []).includes("y-token-orig"));
    check("(sanity) fresh token present too", (onDiskAfterRaise.tokens ?? []).includes(freshToken));

    // Reboot: fresh process state via a cache-busted dynamic re-import, same LOOM_HOME/MERGE_QUARANTINE_DIR.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);

    const yAfterReboot = fresh.activeMergeQuarantineFor(y);
    const fAfterReboot = fresh.activeMergeQuarantineFor(f);
    check("*** THE FIX *** Y's own identity survives reboot (querying Y's key returns Y, not F)", yAfterReboot?.repoPath === y);
    check("*** THE FIX *** F's own identity survives reboot, independent of Y", fAfterReboot?.repoPath === f);
    check("*** THE FIX *** Y and F are now two DISTINCT entry objects (never merged)", yAfterReboot !== fAfterReboot);
    check("*** THE FIX *** F's own tokens carry NONE of Y's tokens", !(fAfterReboot?.tokens ?? []).includes("y-token-orig") && !(fAfterReboot?.tokens ?? []).includes(freshToken));
    check("*** THE FIX *** Y's own tokens carry NONE of F's token", !(yAfterReboot?.tokens ?? []).includes("f-token-orig"));

    // The operational consequence check: F's own human clears F's own, genuine, original token — it must
    // fully unblock F, with no stranding by a foreign token it never owned.
    fresh.clearMergeQuarantineByToken(f, "f-token-orig");
    const fAfterOwnClear = fresh.activeMergeQuarantineFor(f);
    check("*** THE FIX *** F is FULLY unblocked after clearing its own, only-ever-legitimate token (no stranding)", !fAfterOwnClear);
    check("*** THE FIX *** Y stays correctly blocked throughout (F's clear never touches Y)", !!fresh.activeMergeQuarantineFor(y));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO fold-filter-keeps-empty-slot-secondary (GREEN-ONLY regression leg)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n=== SCENARIO fold-filter-keeps-empty-slot-secondary (GREEN regression) ===\n");
    const y = makeRepo("y2");
    const kY = canonicalRepoLockKey(y);
    const kYHash = hashForKey(kY);
    const finalPathY = path.join(MERGE_QUARANTINE_DIR, `${kYHash}.json`);
    // kS is Y's own LEGITIMATE secondary — an arbitrary path nothing else currently claims (the SAME
    // "EMPTY slot at fold time" shape merge-quarantine-reconcile-fold-150aed7b.mjs's own W1/W2 fixture
    // already proves, kept here as a dedicated, self-contained leg for THIS card).
    const s = path.join(os.tmpdir(), `loom-mqf575-s-never-${freshSfx()}`);
    const kS = canonicalRepoLockKey(s);

    writeLatchJson(kYHash, {
      repoPath: y, branch: "y2-branch-orig", reason: "Y2's own genuine raise, legitimately dual-armed at kS",
      enteredAt: Date.now() - 60_000, tokens: ["y2-token-orig"],
      resolvedKey: kY, resolvedKeys: [kY, kS], provenanceTracked: true,
    });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) Y2 is blocked after boot", !!activeMergeQuarantineFor(y));
    check("(precondition) S is blocked after boot (via resolvedKeys)", !!activeMergeQuarantineFor(s));

    const inject = injectReadFailureOnce(finalPathY);
    let clearResult;
    try {
      clearResult = clearMergeQuarantineReporting(y);
    } finally {
      inject.restore();
    }
    check("(precondition) the read of Y2's own final was actually attempted (and injected to fail)", inject.count() >= 1);
    check("(precondition) clear still reports wasQuarantined:true", clearResult?.wasQuarantined === true);
    check("(precondition) Y2's own in-memory entry is gone immediately after the clear", !activeMergeQuarantineFor(y));

    // kS's slot is EMPTY right now (Y2's own entry was just evicted, and S was never independently
    // raised) — positivelyForeignKey must NOT drop kS on that basis.
    enterMergeQuarantine(y, "y2-branch-fresh", "fresh raise after the failed clear");
    const onDiskAfterRaise = JSON.parse(fs.readFileSync(finalPathY, "utf8"));
    check("*** GREEN REGRESSION *** on-disk resolvedKeys STILL carries the legitimate secondary kS (empty slot, never dropped)", (onDiskAfterRaise.resolvedKeys ?? []).includes(kS));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("*** GREEN REGRESSION *** Y2 re-arms correctly after reboot", !!fresh.activeMergeQuarantineFor(y));
    check("*** GREEN REGRESSION *** S re-arms at kS too after reboot (secondary not lost)", !!fresh.activeMergeQuarantineFor(s));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO fold-filter-keeps-same-identity-different-object-secondary (Code Review SF1)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // A secondary key's live occupant can be the SAME identity under a DIFFERENT object reference — the
  // real shape `enterMergeQuarantine`'s existing-raise branch produces (`baseEntry = {...existing}` is a
  // NEW object, folded via `foldInOnDiskTokensIfMarked` BEFORE `replaceEntryEverywhere` ever re-points
  // `existing`'s OTHER keys to it, ~:3216-3233). A mutant that checks `occupant !== entry` (object
  // identity) instead of `directPathIdentity` would wrongly read this as foreign and drop the secondary.
  //
  // NOTE: constructing this through that exact existing-raise branch does NOT discriminate the mutant —
  // `baseEntry.resolvedKeys` already inherits `existing.resolvedKeys` (verified: it already carries kS)
  // BEFORE the fold ever runs, so `unionResolvedKeysRetaining`'s own union-never-drop retention keeps kS
  // in the written record regardless of what this predicate computes; the filter's decision is masked.
  // To actually exercise it, `entry.resolvedKeys` must start EMPTY (the brand-new-raise branch, same as
  // "fold-filter-closes-foreign-key" above) while a SEPARATE, same-identity object independently occupies
  // the secondary key — modelled here via `setActiveQuarantineTestOnly` (a same shape to the "in-memory
  // twin" fixtures `97cff6db`'s own corpus already uses) rather than depending on timing inside
  // `enterMergeQuarantine` itself.
  {
    console.log("\n=== SCENARIO fold-filter-keeps-same-identity-different-object-secondary ===\n");
    const y = makeRepo("ysame");
    const kY = canonicalRepoLockKey(y);
    const kYHash = hashForKey(kY);
    const finalPathY = path.join(MERGE_QUARANTINE_DIR, `${kYHash}.json`);
    const s = path.join(os.tmpdir(), `loom-mqf575-ssame-never-${freshSfx()}`);
    const kS = canonicalRepoLockKey(s);

    // Y's own on-disk latch names BOTH kY and the legitimate secondary kS.
    writeLatchJson(kYHash, {
      repoPath: y, branch: "ysame-branch-orig", reason: "Y's own genuine raise, legitimately dual-armed at kS",
      enteredAt: Date.now() - 60_000, tokens: ["ysame-token-orig"],
      resolvedKey: kY, resolvedKeys: [kY, kS], provenanceTracked: true,
    });

    // Plant a SAME-IDENTITY twin object directly at kS — a DIFFERENT object than the fresh entry raised
    // below. kY itself has no in-process entry at all yet.
    const twin = {
      repoPath: y, branch: "ysame-twin", reason: "a same-identity twin object occupying kS independently",
      enteredAt: Date.now() - 60_000, tokens: ["ysame-twin-token"], armedKeys: [kS],
    };
    setActiveQuarantineTestOnly(kS, twin);
    check("(precondition) kS is occupied by a twin object sharing Y's OWN identity", activeMergeQuarantineFor(s)?.repoPath === y);
    check("(precondition) kY has no in-process entry yet", !activeMergeQuarantineFor(y));

    markLatchFileUnreadableTestOnly(path.basename(finalPathY));

    enterMergeQuarantine(y, "ysame-branch-fresh", "fresh raise while the basename is marked, with a twin at kS");
    const onDiskAfterRaise = JSON.parse(fs.readFileSync(finalPathY, "utf8"));
    check("(sanity) old token survived the fold", (onDiskAfterRaise.tokens ?? []).includes("ysame-token-orig"));
    check("*** SF1 REGRESSION *** on-disk resolvedKeys carries the legitimate secondary kS (same identity, different object, never dropped)", (onDiskAfterRaise.resolvedKeys ?? []).includes(kS));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("*** SF1 REGRESSION *** Y re-arms correctly after reboot", !!fresh.activeMergeQuarantineFor(y));
    check("*** SF1 REGRESSION *** S re-arms at kS too after reboot (secondary not lost)", !!fresh.activeMergeQuarantineFor(s));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO accepted-residual-foreign-key-with-empty-slot (DOCUMENTS a named, accepted gap — not a fix)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n=== SCENARIO accepted-residual-foreign-key-with-empty-slot (documents the open residual) ===\n");
    const y = makeRepo("y3");
    const f = makeRepo("f3");
    const kY = canonicalRepoLockKey(y);
    const kF = canonicalRepoLockKey(f); // F's own real key — but F is NEVER raised in this scenario.
    const kYHash = hashForKey(kY);
    const finalPathY = path.join(MERGE_QUARANTINE_DIR, `${kYHash}.json`);

    writeLatchJson(kYHash, {
      repoPath: y, branch: "y3-branch-orig", reason: "Y3's own genuine raise",
      enteredAt: Date.now() - 60_000, tokens: ["y3-token-orig"],
      resolvedKey: kY, resolvedKeys: [kY, kF], // <-- contaminated with F's key, but F is NOT live
      provenanceTracked: true,
    });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) Y3 is blocked after boot", !!activeMergeQuarantineFor(y));
    // kF's slot is occupied right now, but by Y3 ITSELF (the pre-existing, unrelated boot-time secondary
    // arm every resolvedKeys entry gets at boot — this is the "upgrade case" mechanism the separate PASS1
    // card targets, not this fold-time filter) — same identity, so positivelyForeignKey correctly reads
    // it as NOT foreign. The scenario's real point is what happens AFTER the clear evicts Y3 from BOTH
    // keys (54054c01's "a clear lifts every key an entry was armed under"), leaving kF genuinely empty.
    check("(precondition) kF is occupied by Y3 itself right now (same identity, not F)", activeMergeQuarantineFor(f)?.repoPath === y);

    const inject = injectReadFailureOnce(finalPathY);
    try { clearMergeQuarantineReporting(y); } finally { inject.restore(); }
    check("(precondition) the clear evicts Y3 from kF too — the slot is now genuinely EMPTY", !activeMergeQuarantineFor(f));

    enterMergeQuarantine(y, "y3-branch-fresh", "fresh raise after the failed clear");

    const onDiskAfterRaise = JSON.parse(fs.readFileSync(finalPathY, "utf8"));
    // ACCEPTED RESIDUAL (documented, not asserted as a defect to fix here — Lead ruling, card f575cebf):
    // positivelyForeignKey cannot prove kF foreign when nothing currently occupies it, so it survives the
    // filter. The eventual closer is card e7652e06 (the "upgrade case"), not this one.
    check("(documents the accepted residual) kF slips through the filter when F's slot is empty at fold time", (onDiskAfterRaise.resolvedKeys ?? []).includes(kF));
  }

  console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASS" : `❌ ${failures} CHECK(S) FAILED`} — reconcileMarkedBasenameBeforeWrite now drops only a POSITIVELY FOREIGN newly-folded key (a live occupant with a different identity), never a key merely unprovable (an empty slot, or a same-identity occupant) — closing the write-time resolvedKeys-contamination bypass of d69a6744's own ownership filter, without reopening the union-never-drop rule for a legitimate secondary. The PASS1 boot-time "upgrade case" (an already-contaminated disk file, independent of this fold) stays open on card e7652e06 per the Lead's own ruling.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
