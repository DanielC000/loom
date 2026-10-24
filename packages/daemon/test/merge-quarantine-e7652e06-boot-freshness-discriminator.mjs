import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e7652e06 — a latch ALREADY contaminated on disk (resolvedKeys naming another registered
// repo's canonical key — e.g. written by a pre-d69a6744 build on a real user's disk) is re-armed at boot
// by PASS1 with NO identity check at all, because armKeyUnlessDegradedCollision only separated identities
// when exactly ONE side was resolvable (priorResolvable !== entryResolvable). For two distinct,
// BOTH-resolvable repos it fell through to the "legitimate same-toplevel union" unconditionally.
//
// Fix (Lead-approved design, @decision e7652e06 in merge-quarantine.ts): the real discriminator is
// FRESHNESS, not resolvability parity.
//   entryFresh = the arm is entry's own tautological PRIMARY key (a secondary arm is never fresh).
//   priorFresh = isKeyVerifiedFor(prior.repoPath, key).
// Four cases:
//   1. Both fresh            -> legitimate same-toplevel union, unchanged (SCENARIO legit-r-s-union).
//   2. priorFresh, !entryFresh -> decline entry's claim at THIS key only; prior untouched
//                                 (SCENARIO forward-order-bug-fixed).
//   3. entryFresh, !priorFresh -> evict prior from THIS key only, entry wins (SCENARIO
//                                 reverse-order-case3, the order-independence half of the fix).
//   4. neither fresh           -> pre-e7652e06 behaviour unchanged: legitimate only when backed by SOME
//                                 registered repo's own fresh identity (9a55fb90's "third party"); else
//                                 the existing resolvability tiebreak/divert (SCENARIO
//                                 third-party-backed-case4-unchanged).
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-e7652e06-boot-freshness-discriminator.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("loom-e7652e06-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  listActiveMergeQuarantines, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
  reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
  clearMergeQuarantineLatchFile, quarantineLatchIdFor, clearMergeQuarantineByRecordedPath,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=e7652e06@loom -c user.name=e7652e06";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Mirrors the real module's own private quarantineHashForKey — same helper every sibling
// merge-quarantine*.mjs test file in this family carries under this exact name.
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-e7652e06-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# e7652e06 fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Same technique merge-quarantine-d69a6744-liveoccupancy-ambiguity-and-write.mjs's own Scenario 2
// established: retry a fresh candidate until ITS OWN hash sorts strictly on the desired side of a fixed
// floor hash, so fs.readdirSync's own (plain alphabetical) boot order is forced deterministically rather
// than assumed.
function makeToplevelRepoSortingAfter(tagPrefix, floorHash) {
  for (let i = 0; i < 25; i++) {
    const candidate = makeToplevelRepo(`${tagPrefix}-${i}`);
    const k = canonicalRepoLockKey(candidate);
    if (hashKey(k) > floorHash) return { repo: candidate, key: k };
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  throw new Error(`could not find a ${tagPrefix} candidate sorting after ${floorHash} within 25 tries`);
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

console.log("\n=== SCENARIO forward-order-bug-fixed (CASE 2) — contaminated disk latch, F read BEFORE Y ===\n");

function scenarioForwardOrderBugFixed() {
  // F: a REAL, resolvable, REGISTERED repo with its own genuine, independent, in-process-raised
  // quarantine. Raised FIRST so it is OLDER (enteredAt) than Y.
  const F = makeToplevelRepo("fwd-F");
  const kF = canonicalRepoLockKey(F);
  const fToken = enterMergeQuarantine(F, "f-branch", "e7652e06 fwd: F's own genuine, unrelated quarantine");
  check("(fwd precondition) F reads blocked (genuine quarantine)", !assertRepoNotQuarantined(F).ok);

  // Y: a REAL, resolvable, REGISTERED repo, chosen so hashKey(kY) sorts STRICTLY AFTER hashKey(kF) —
  // load-bearing for F arriving first and becoming `prior` when Y's own secondary arm reaches kF.
  const { repo: Y, key: kY } = makeToplevelRepoSortingAfter("fwd-Y", hashKey(kF));
  check("(fwd precondition) F's own file sorts BEFORE Y's own file in readdir order", hashKey(kF) < hashKey(kY));

  // Y's OWN on-disk latch, hand-written DIRECTLY — never produced by any in-process raise, clear, or
  // fold-in (f575cebf's write-time fix is never exercised by this repro at all) — modeling a
  // pre-d69a6744 build's own historical contamination already sitting on a real user's disk. Y's own
  // PRIMARY file (named at hashKey(kY), its own currently-fresh key) carries resolvedKeys:[kY, kF] — kF
  // being F's own, completely unrelated, genuine canonical key.
  const yToken = `fwd-y-token-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kY)}.json`), JSON.stringify({
    repoPath: Y, branch: "y-branch", reason: "e7652e06 fwd: Y's own, pre-existing on-disk contamination",
    enteredAt: Date.now(), tokens: [yToken],
    resolvedKey: kY, resolvedKeys: [kY, kF],
  }, null, 2) + "\n");

  const namesOnDisk = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const idxF = namesOnDisk.indexOf(`${hashKey(kF)}.json`);
  const idxY = namesOnDisk.indexOf(`${hashKey(kY)}.json`);
  check("(fwd precondition) F's own file is empirically processed BEFORE Y's own file", idxF !== -1 && idxY !== -1 && idxF < idxY);

  // === THE FIRST BOOT EVER TO SEE THIS DISK LAYOUT — no clear, no fold, no prior in-process state ===
  reenterMergeQuarantinesAtBoot([F, Y]);

  const yBlocked = assertRepoNotQuarantined(Y);
  const fEntries = listActiveMergeQuarantines().filter((e) => e.repoPath === F || e.repoPath === Y);

  check("*** CASE 2 FIX, Y SIDE *** Y is STILL blocked by its OWN identity after an ordinary reboot", !yBlocked.ok);
  check("*** CASE 2 FIX, Y SIDE *** the refusal blocking Y names Y itself, not F", !yBlocked.ok && yBlocked.reason.includes(Y) && !yBlocked.reason.includes(F));
  check("*** CASE 2 FIX, F SIDE *** F's own entry NEVER carries Y's token", !fEntries.some((e) => e.repoPath === F && (e.tokens ?? []).includes(yToken)));
  check("*** CASE 2 FIX, Y SIDE *** Y's own entry carries its OWN token", !!fEntries.find((e) => e.repoPath === Y)?.tokens?.includes(yToken));

  // The real operational consequence the card names: F's own human clears F's own, only-ever-legitimate
  // token, and is fully unblocked — never left stranded by a token it never owned.
  clearMergeQuarantineByToken(F, fToken);
  check("*** CASE 2 FIX, STRANDING *** F is fully unblocked after clearing ONLY its own token", assertRepoNotQuarantined(F).ok);
  check("*** CASE 2 FIX, Y SIDE *** Y is STILL blocked after F's own clear (never silently lifted)", !assertRepoNotQuarantined(Y).ok);
}

scenarioForwardOrderBugFixed();

console.log("\n=== SCENARIO reverse-order-case3 (CASE 3) — Y read BEFORE F; order-independence of the fix ===\n");

function scenarioReverseOrderCase3() {
  // Y: chosen so hashKey(kY) sorts STRICTLY BEFORE hashKey(kF) — Y's own file is read FIRST this time,
  // the REVERSE of the forward-order scenario above.
  const Ybase = makeToplevelRepo("rev-Y-base");
  const kYbase = canonicalRepoLockKey(Ybase);
  const { repo: F, key: kF } = makeToplevelRepoSortingAfter("rev-F", hashKey(kYbase));
  // Rebuild Y so its OWN file definitely sorts before kF (Ybase already does; reuse it directly).
  const Y = Ybase;
  const kY = kYbase;
  check("(rev precondition) Y's own file sorts BEFORE F's own file in readdir order", hashKey(kY) < hashKey(kF));

  const yToken = `rev-y-token-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kY)}.json`), JSON.stringify({
    repoPath: Y, branch: "y-branch", reason: "e7652e06 rev: Y's own, pre-existing on-disk contamination",
    enteredAt: Date.now(), tokens: [yToken],
    resolvedKey: kY, resolvedKeys: [kY, kF],
  }, null, 2) + "\n");

  // F: a REAL, resolvable, REGISTERED repo with its own genuine, independent, in-process-raised
  // quarantine — raised AFTER Y's own file is already written, so F's own file is read SECOND.
  const fToken = enterMergeQuarantine(F, "f-branch", "e7652e06 rev: F's own genuine, unrelated quarantine");
  check("(rev precondition) F reads blocked (genuine quarantine)", !assertRepoNotQuarantined(F).ok);

  const namesOnDisk = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const idxY = namesOnDisk.indexOf(`${hashKey(kY)}.json`);
  const idxF = namesOnDisk.indexOf(`${hashKey(kF)}.json`);
  check("(rev precondition) Y's own file is empirically processed BEFORE F's own file", idxY !== -1 && idxF !== -1 && idxY < idxF);

  // === THE FIRST BOOT EVER TO SEE THIS DISK LAYOUT, in the REVERSE read order ===
  reenterMergeQuarantinesAtBoot([F, Y]);

  const yBlocked = assertRepoNotQuarantined(Y);
  const fBlocked = assertRepoNotQuarantined(F);
  const entries = listActiveMergeQuarantines().filter((e) => e.repoPath === F || e.repoPath === Y);

  check("*** CASE 3 FIX, F SIDE *** F is STILL blocked by its OWN identity (its tautological primary arm evicted Y from kF)", !fBlocked.ok);
  check("*** CASE 3 FIX, F SIDE *** F's own entry NEVER carries Y's token (Y was evicted, never unioned)", !entries.some((e) => e.repoPath === F && (e.tokens ?? []).includes(yToken)));
  // CASE 3 REGRESSION (e) — Y, evicted from kF, must stay blocked at its OWN remaining key kY, with
  // every one of its own tokens intact there — eviction trims a SLOT, it never discards the entry.
  check("*** CASE 3 REGRESSION *** Y is STILL blocked at its own kY after being evicted from kF", !yBlocked.ok);
  check("*** CASE 3 REGRESSION *** Y's own entry still carries its own token after eviction", !!entries.find((e) => e.repoPath === Y)?.tokens?.includes(yToken));

  clearMergeQuarantineByToken(F, fToken);
  check("*** CASE 3 FIX, STRANDING *** F is fully unblocked after clearing ONLY its own token", assertRepoNotQuarantined(F).ok);
  check("*** CASE 3 REGRESSION *** Y is STILL blocked after F's own clear (never silently lifted)", !assertRepoNotQuarantined(Y).ok);
}

scenarioReverseOrderCase3();

console.log("\n=== SCENARIO legit-r-s-union (CASE 1) — genuine toplevel-recompute collision MUST still union ===\n");

function scenarioLegitRsUnion() {
  // R: a real toplevel repo with its own, directly-raised (in-process) quarantine.
  const R = makeToplevelRepo("legit-R");
  const kR = canonicalRepoLockKey(R);
  const rToken = enterMergeQuarantine(R, "r-branch", "e7652e06 legit: R's own genuine quarantine");
  check("(legit precondition) R reads blocked", !assertRepoNotQuarantined(R).ok);

  // S: a plain SUBDIRECTORY of R, with NO .git of its own — canonicalRepoLockKey(S) walks up to R's own
  // toplevel, identical to kR. Still fully resolvable (a real directory on disk) — models "S used to be
  // its own toplevel (e.g. a flattened submodule) and still carries its OWN historical latch."
  const S = path.join(R, "legacy-submodule-subdir");
  fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(path.join(S, "marker.txt"), "was once its own toplevel\n");
  const kS = canonicalRepoLockKey(S);
  check("(legit precondition) S's own canonical key now EQUALS R's (genuine toplevel-recompute collision)", kS === kR);

  const kSOld = `e7652e06-legit-S-historical-toplevel-${freshSfx()}`;
  const sToken = `legit-s-token-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kSOld)}.json`), JSON.stringify({
    repoPath: S, branch: "s-branch", reason: "e7652e06 legit: S's own genuine quarantine, filed back when S had its own .git",
    enteredAt: Date.now() - 60_000, tokens: [sToken], resolvedKey: kSOld,
  }, null, 2) + "\n");

  // === FIRST BOOT to see S's .git removed and R's own real, independent quarantine already live ===
  reenterMergeQuarantinesAtBoot([R, S]);

  const rBlocked = assertRepoNotQuarantined(R);
  const sBlocked = assertRepoNotQuarantined(S);
  check("*** CASE 1 MUST STILL UNION *** R stays blocked (its own genuine quarantine, now sharing the toplevel with S)", !rBlocked.ok);
  check("*** CASE 1 MUST STILL UNION *** S is ALSO blocked (it IS R's own physical toplevel now)", !sBlocked.ok);

  const merged = listActiveMergeQuarantines().find((e) => e.repoPath === R || e.repoPath === S);
  check("*** CASE 1 MUST STILL UNION *** the merged entry carries BOTH R's and S's own genuine tokens",
    !!merged && (merged.tokens ?? []).includes(rToken) && (merged.tokens ?? []).includes(sToken));
}

scenarioLegitRsUnion();

console.log("\n=== SCENARIO third-party-backed-case4-unchanged (CASE 4) — neither colliding side fresh; a third, not-yet-processed registered repo backs the key (9a55fb90/d163aef5 shape) ===\n");

function scenarioThirdPartyBackedCase4Unchanged() {
  // sub: a REAL, resolvable, REGISTERED repo. Its own fresh canonical key kSub is the shared collision
  // point — genuinely, freshly owned by sub alone, neither of the two colliding parties below.
  const sub = makeToplevelRepo("c4-sub");
  const kSub = canonicalRepoLockKey(sub);

  // x: a REAL, resolvable repo with its OWN real key kX — x's OWN on-disk latch carries kSub as a
  // historical/manufactured SECONDARY (resolvedKeys:[kX, kSub]) — x never freshly owns kSub.
  const x = makeToplevelRepo("c4-x");
  const kX = canonicalRepoLockKey(x);
  const xToken = `c4-x-token-${freshSfx()}`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kX)}.json`), JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "e7652e06 c4: x's own secondary squat on sub's key",
    enteredAt: Date.now() - 60_000, tokens: [xToken], resolvedKey: kX, resolvedKeys: [kX, kSub],
  }, null, 2) + "\n");

  // z: a nonexistent (degraded, permanently unresolvable) path whose OWN manufactured resolvedKey is
  // ALSO kSub — z never freshly owns kSub either (z is never resolvable, full stop).
  const z = path.join(os.tmpdir(), `loom-e7652e06-c4-z-never-${freshSfx()}`);
  const zToken = `c4-z-token-${freshSfx()}`;
  const zFile = path.join(MERGE_QUARANTINE_DIR, `stale-c4-z-${freshSfx()}.json`);
  fs.writeFileSync(zFile, JSON.stringify({
    repoPath: z, branch: "z-branch", reason: "e7652e06 c4: z's own degraded claim on sub's key",
    enteredAt: Date.now(), tokens: [zToken], resolvedKey: kSub,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([sub, x]);

  // x and z are expected to UNION at kSub, backed by sub's own genuine (but not-yet-processed-this-way)
  // identity — exactly the pre-existing 9a55fb90/d163aef5 precedent this card must not regress.
  const union = listActiveMergeQuarantines().find((e) => (e.tokens ?? []).includes(xToken) || (e.tokens ?? []).includes(zToken));
  check("*** CASE 4 UNCHANGED *** x and z union into ONE entry, backed by sub's own genuine identity", !!union && (union.tokens ?? []).includes(xToken) && (union.tokens ?? []).includes(zToken));
  check("*** CASE 4 UNCHANGED *** x's own identity stays queryable/blocked (never lost in the union)", !assertRepoNotQuarantined(x).ok);

  // *** CODE REVIEW fb1580b8, SF-2 *** — x's own secondary claim at kSub is non-fresh (x never freshly
  // owns kSub; sub does), so round 4's prior-side check marks THIS union too — a deliberate, measured
  // side effect (see the decision record's "Round 4" section), not an accident. Pin it directly.
  check("*** SF-2 *** the x/z/sub union carries provenanceUnknown (x's own non-fresh claim at kSub)", !!union?.provenanceUnknown);

  const xId = clearMergeQuarantineLatchFile(quarantineLatchIdFor(x));
  check("*** SF-2 *** clear-by-id(x) refuses (ambiguous/incomplete provenance)", xId.ok === false);
  check("*** SF-2 *** x stays blocked after the refused clear-by-id", !assertRepoNotQuarantined(x).ok);

  // The union's own RECORDED repoPath is x (the "older" identity, kept as the base by
  // unionQuarantineEntries) — clear-by-path on THAT identity lifts the whole (disclosed) union and
  // removes every one of its own physical latch files. Check THIS scenario's own two files specifically
  // (never the whole MERGE_QUARANTINE_DIR — earlier scenarios in this file leave their own files behind).
  check("(precondition) the union's own recorded repoPath is x", union?.repoPath === x);
  const xLatchFile = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kX)}.json`);
  const xPath = clearMergeQuarantineByRecordedPath(x);
  check("*** SF-2 *** clear-by-path(x) lifts the union", xPath.wasQuarantined === true);
  check("*** SF-2 *** x is unblocked after clear-by-path(x)", assertRepoNotQuarantined(x).ok);
  check("*** SF-2 *** x's own latch file is gone from disk", !fs.existsSync(xLatchFile));
  check("*** SF-2 *** z's own latch file is gone from disk", !fs.existsSync(zFile));

  reenterMergeQuarantinesAtBoot([sub, x]);
  check("*** SF-2 *** x stays unblocked after a reboot (the clear durably survives, no re-quarantine)", assertRepoNotQuarantined(x).ok);
}

scenarioThirdPartyBackedCase4Unchanged();

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);
