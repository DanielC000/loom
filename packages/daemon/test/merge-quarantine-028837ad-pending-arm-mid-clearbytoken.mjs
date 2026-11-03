import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 028837ad — a cleared token must be lifted from a pending identity armed mid-call (orphan OR
// tmp-residue path, whichever pass arms it), and the durable rewrite that persists this must rebase onto
// the REAL on-disk record — never the arm's own deliberately narrow in-memory model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq028837-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq028837@loom -c user.name=mq028837";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq028837-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-028837ad (${tag})\n`);
  execSync(`git init -q && git config user.email mq028837@loom && git config user.name mq028837`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 1dd00dca's own test file: fold `orphanBasename` into `repoPath`'s own on-disk final
// JSON BEFORE `orphanBasename` itself exists.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule, extra = {}) {
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens, ...extra }));
  return orphanPath;
}

// Same technique as 25d0d45b's own test file: plant a `.json.tmp-<pid>` residue directly at `key`'s own
// hash — the pid/hex suffix MUST match boot's own strict `tmpFiles` filter
// (`/\.json\.tmp-\d+(-[0-9a-f]+)?$/`, merge-quarantine.ts ~:8417).
function plantTmpResidue(key, repoPath, branch, reason, tokens, suffix, againstModule, extra = {}) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(againstModule.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now() - 1000, tokens, ...extra }, null, 2) + "\n");
  return tmpPath;
}

// Same technique as 2dd97aaa's own item-3 test (merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs):
// monkeypatches fs.renameSync to throw EPERM for exactly ONE target path, then restores itself on that one
// trip — a deterministic, cross-platform way to force a durable write failure (a real read-only file
// attribute is not a reliable way to force a rename-over to fail on every platform).
function injectOneShotRenameFailure(targetPath) {
  const real = fs.renameSync;
  let tripped = false;
  fs.renameSync = (src, dest) => {
    if (!tripped && dest === targetPath) {
      tripped = true;
      fs.renameSync = real;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, tripped: () => tripped };
}

// Card 59e758e5 (B1/B3) — same one-shot rename failure as above, but ALSO fails every open of a
// `.tmp-safety-` path: the TRIPLE fault (rename AND the safety-tmp fallback's own write both failing)
// that genuinely leaves memory outrunning STALE disk — now that a DOUBLE fault alone (the fallback
// succeeding) secures the merged content durably before this scenario's own reduce ever runs.
function injectOneShotRenameFailureWithSafetyTmpFailure(targetPath) {
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let tripped = false;
  let safetyHits = 0;
  fs.renameSync = (src, dest) => {
    if (!tripped && dest === targetPath) {
      tripped = true;
      fs.renameSync = realRename;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return realRename(src, dest);
  };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(".tmp-safety-")) {
      safetyHits++;
      throw Object.assign(new Error("ENOSPC: simulated safety-tmp disk-full"), { code: "ENOSPC" });
    }
    return realOpen(p, ...rest);
  };
  return { restore: () => { fs.renameSync = realRename; fs.openSync = realOpen; }, tripped: () => tripped, safetyHits: () => safetyHits };
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (ORPHAN) unresolvable T, armed PENDING mid-call via the orphan-latch sweep. O holds BOTH the clearer
  // A's own token (tA) AND T's own real token (tF) — mirrors 1dd00dca's own scenario (H1)'s durability
  // shape, but T is UNRESOLVABLE (1dd00dca's own scenario (D) shape) instead of resolvable.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("orphan-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (028837ad orphan)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    check("(orphan precondition) A is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const T = path.join(os.tmpdir(), `loom-mq028837-orphan-t-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (028837ad orphan, unresolvable)", [tA, tF], booted);

    booted.clearMergeQuarantineByToken(A, tA);
    const tEntryAfterArm = booted.activeMergeQuarantineFor(T);
    check("*** THE FIX (orphan) *** T's pending entry is reduced to JUST its own real token — tA is gone WITHIN THE SAME call", !!tEntryAfterArm && tEntryAfterArm.tokens.length === 1 && tEntryAfterArm.tokens[0] === tF);

    // Durability (lesson 283): a reboot taken right here must independently re-derive the SAME state.
    const freshRightAfter = await freshBootModule();
    freshRightAfter.reenterMergeQuarantinesAtBoot([A, T]);
    const tEntryRightAfterBoot = freshRightAfter.activeMergeQuarantineFor(T);
    check("*** DURABILITY (orphan) *** a reboot taken right after A's clear agrees — [tF] only, tA genuinely gone from disk too", !!tEntryRightAfterBoot && tEntryRightAfterBoot.tokens.length === 1 && tEntryRightAfterBoot.tokens[0] === tF);

    // T's own later clear now fully lifts it — no strand.
    booted.clearMergeQuarantineByToken(T, tF);
    check("*** NO STRAND (orphan) *** T's own later clear(tF) fully lifts it", booted.assertRepoNotQuarantined(T).ok === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (TMP-RESIDUE-RELOCATE) NOT this card's own arm-helper path — mislabeled as such until Round 3's own
  // audit. R is raised with a SINGLE token and fully lifted, so X's tmp residue (planted at R's own key
  // hash, mirroring the (PROBE) scenario in merge-quarantine-25d0d45b-...mjs) is discovered and preserved
  // by `deleteMergeQuarantineLatchByKey`'s own PRE-EXISTING "protect/relocate a foreign occupant before
  // delete" mechanism (c9114934/d4b25feb — confirmed by its own distinct "... also relocated 1 foreign
  // co-occupant(s) ..." log line), never by `armForeignOrphanContentInMemoryIfUnenforced`. That relocate
  // path already preserved full fidelity before this card existed — kept here as a non-regression pin for
  // IT, not as coverage of this card's own fix. See CONTRIB-TMP below for the real tmp-residue ARM-path
  // coverage (a PARTIAL reduce, which is the only shape that actually reaches the arm helper).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R = makeRepo("tmp-r");
    const tR = enterMergeQuarantine(R, "loom/r-branch", "merge in progress for R (028837ad tmp-residue-relocate)");
    const keyR = canonicalRepoLockKey(R);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([R]);

    const X = path.join(os.tmpdir(), `loom-mq028837-tmp-x-never-exists-${freshSfx()}`);
    const tF2 = randomUUID();
    plantTmpResidue(keyR, X, "loom/x-branch", "merge in progress for X (028837ad tmp-residue-relocate, unresolvable)", [tR, tF2], "99901-cafe0028", booted);

    booted.clearMergeQuarantineByToken(R, tR);
    const xEntryAfterArm = booted.activeMergeQuarantineFor(X);
    check("(tmp-residue-relocate, non-regression) X's pending entry is reduced to JUST its own real token — tR is gone WITHIN THE SAME call", !!xEntryAfterArm && xEntryAfterArm.tokens.length === 1 && xEntryAfterArm.tokens[0] === tF2);

    const freshRightAfter = await freshBootModule();
    freshRightAfter.reenterMergeQuarantinesAtBoot([R, X]);
    const xEntryRightAfterBoot = freshRightAfter.activeMergeQuarantineFor(X);
    check("(tmp-residue-relocate, non-regression) a reboot taken right after R's clear agrees — [tF2] only, tR genuinely gone from disk too", !!xEntryRightAfterBoot && xEntryRightAfterBoot.tokens.length === 1 && xEntryRightAfterBoot.tokens[0] === tF2);

    booted.clearMergeQuarantineByToken(X, tF2);
    check("(tmp-residue-relocate, non-regression) X's own later clear(tF2) fully lifts it", booted.assertRepoNotQuarantined(X).ok === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (CONTROL) a RESOLVABLE foreign T still self-recovers WITHIN THE SAME call, unchanged — the new
  // post-loop pending pass must never alter the pre-existing active-loop behavior.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A2 = makeRepo("control-a2");
    const tA2 = enterMergeQuarantine(A2, "loom/a2-branch", "merge in progress for A2 (028837ad control)");
    const orphanBasename2 = foldOrphanRefIntoOwnFinal(A2, mod);

    const booted2 = await freshBootModule();
    booted2.reenterMergeQuarantinesAtBoot([A2]);

    const T2 = makeRepo("control-t2"); // REAL, resolvable repo
    const tF3 = randomUUID();
    writeOrphanContent(orphanBasename2, T2, "loom/t2-branch", "merge in progress for T2 (028837ad control, resolvable)", [tA2, tF3], booted2);

    booted2.clearMergeQuarantineByToken(A2, tA2);
    const t2EntryAfterArm = booted2.activeMergeQuarantineFor(T2);
    check("(control) a RESOLVABLE T self-recovers WITHIN THE SAME call, unchanged — already reduced to [tF3]", !!t2EntryAfterArm && t2EntryAfterArm.tokens.length === 1 && t2EntryAfterArm.tokens[0] === tF3);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (PENDING-A) ROUND 2 BLOCKING 1 — the arm happens in the PRE-LOOP pass, not the active loop. A is
  // ITSELF pending/unresolvable (never a real repo) — its own full lift runs through
  // `clearTokenFromPendingIndices`'s own "remove" branch (the function's FIRST, pre-loop invocation),
  // whose own orphan sweep can arm a brand-new foreign unresolvable T mid-pass, before that SAME pass's
  // own already-collected indices could ever see it. Proves the identity-exclusion snapshot must be
  // taken at CALL START, never after the pre-loop pass (which is where it lived pre-round-2).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A4 = path.join(os.tmpdir(), `loom-mq028837-pendinga-a4-never-exists-${freshSfx()}`);
    const tA4 = enterMergeQuarantine(A4, "loom/a4-branch", "merge in progress for A4 (028837ad pending-A, unresolvable)");
    check("(pending-A precondition) A4 itself lands PENDING (unresolvable)", mod.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === A4));
    const orphanBasename4 = foldOrphanRefIntoOwnFinal(A4, mod);

    const booted4 = await freshBootModule();
    booted4.reenterMergeQuarantinesAtBoot([A4]);
    check("(pending-A precondition) A4 is STILL pending after a reboot, now carrying the orphan reference", booted4.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === A4) && (booted4.activeMergeQuarantineFor(A4)?.orphanLatchFiles ?? []).includes(orphanBasename4));

    const T4 = path.join(os.tmpdir(), `loom-mq028837-pendinga-t4-never-exists-${freshSfx()}`);
    const tF4 = randomUUID();
    writeOrphanContent(orphanBasename4, T4, "loom/t4-branch", "merge in progress for T4 (028837ad pending-A)", [tA4, tF4], booted4);

    booted4.clearMergeQuarantineByToken(A4, tA4);
    const t4EntryAfterArm = booted4.activeMergeQuarantineFor(T4);
    check("*** BLOCKING 1 FIX (pending-A) *** T4's pending entry is reduced to JUST its own real token — tA4 is gone, even though the arm happened in the PRE-LOOP pass", !!t4EntryAfterArm && t4EntryAfterArm.tokens.length === 1 && t4EntryAfterArm.tokens[0] === tF4);

    const fresh4 = await freshBootModule();
    fresh4.reenterMergeQuarantinesAtBoot([A4, T4]);
    const t4PostReboot = fresh4.activeMergeQuarantineFor(T4);
    check("*** BLOCKING 1 FIX, DURABILITY (pending-A) *** a reboot agrees — [tF4] only", !!t4PostReboot && t4PostReboot.tokens.length === 1 && t4PostReboot.tokens[0] === tF4);

    booted4.clearMergeQuarantineByToken(T4, tF4);
    check("*** BLOCKING 1 FIX, NO STRAND (pending-A) *** T4's own later clear(tF4) fully lifts it", booted4.assertRepoNotQuarantined(T4).ok === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (CONTRIB-ORPHAN) ROUND 2 BLOCKING 2, orphan path — O names T=[tA,tF,tC] AND contributorRepoPaths=[C].
  // C must stay blocked (via `ownIdentityEntryFor`'s own contributor scan, `stillBlockedEntryFor`) BOTH
  // in-process right after the arm+reduce, AND after a reboot reads the REDUCED (not stripped) disk copy.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A5 = makeRepo("contrib-orphan-a5");
    const tA5 = enterMergeQuarantine(A5, "loom/a5-branch", "merge in progress for A5 (028837ad contrib-orphan)");
    const orphanBasename5 = foldOrphanRefIntoOwnFinal(A5, mod);
    const booted5 = await freshBootModule();
    booted5.reenterMergeQuarantinesAtBoot([A5]);

    const T5 = path.join(os.tmpdir(), `loom-mq028837-contrib-orphan-t5-never-exists-${freshSfx()}`);
    const C5 = path.join(os.tmpdir(), `loom-mq028837-contrib-orphan-c5-never-exists-${freshSfx()}`);
    const tF5 = randomUUID();
    const tC5 = randomUUID();
    const t5FakeResolvedKey = `mq028837-contrib-orphan-t5-fake-resolvedkey-${freshSfx()}`;
    const orphanPath5 = writeOrphanContent(orphanBasename5, T5, "loom/t5-branch", "merge in progress for T5 (028837ad contrib-orphan)", [tA5, tF5, tC5], booted5, { contributorRepoPaths: [C5], resolvedKey: t5FakeResolvedKey });

    booted5.clearMergeQuarantineByToken(A5, tA5);
    const t5EntryAfterArm = booted5.activeMergeQuarantineFor(T5);
    check("*** FIX (contrib-orphan) *** T5 is reduced to [tF5, tC5] — tA5 gone, contributorRepoPaths SURVIVES the reduce", !!t5EntryAfterArm && JSON.stringify([...t5EntryAfterArm.tokens].sort()) === JSON.stringify([tC5, tF5].sort()) && (t5EntryAfterArm.contributorRepoPaths ?? []).includes(C5));
    check("*** FIX (contrib-orphan) *** C5 stays blocked in-process (stillBlockedEntryFor, via T5's contributorRepoPaths)", booted5.stillBlockedEntryFor(C5) !== undefined);
    const orphan5OnDisk = JSON.parse(fs.readFileSync(orphanPath5, "utf8"));
    check("*** FIX, ON DISK (contrib-orphan) *** O's own contributorRepoPaths survives the durable reduce-write, not stripped", (orphan5OnDisk.contributorRepoPaths ?? []).includes(C5));
    check("*** FIX, ON DISK (contrib-orphan) *** O's own resolvedKey ALSO survives (every known non-token field preserved, never just contributors)", orphan5OnDisk.resolvedKey === t5FakeResolvedKey);

    const fresh5 = await freshBootModule();
    fresh5.reenterMergeQuarantinesAtBoot([A5, T5]);
    check("*** BLOCKING 2 FIX, DURABILITY (contrib-orphan) *** C5 stays blocked after a reboot too", fresh5.stillBlockedEntryFor(C5) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (CONTRIB-TMP) ROUND 2 BLOCKING 2, tmp-residue path — the SAME shape as CONTRIB-ORPHAN, proven with its
  // own EXECUTED repro per CLAUDE.md's "two-path asymmetry" rule (never inferred from the orphan path).
  // R6 is raised TWICE (two independent tokens at the SAME key) so clearing ONE is a PARTIAL REDUCE, never
  // a full lift — load-bearing: a full lift's own "protect/relocate a foreign occupant before delete"
  // mechanism (c9114934/d4b25feb) is a SEPARATE, pre-existing, already-full-fidelity path that would
  // otherwise race `armForeignOrphanContentInMemoryIfUnenforced`'s own narrow arm for the SAME tmp residue
  // and mask this card's own gap entirely (verified directly: a full-lift construction here produces a
  // "... also relocated 1 foreign co-occupant(s) ..." log line, never the "arming ... as a PENDING
  // quarantine ... from a kept tmp residue" line this card's own arm helper emits — i.e. it never reaches
  // the code this card touches at all). A partial reduce triggers ONLY `clearActiveEntryTokenAtKey`'s own
  // direct `sweepTmpResidueForHashIfUnreferenced` call (merge-quarantine.ts ~:4908) — no delete, so no
  // protect/relocate — isolating the narrow-arm path this card's own BLOCKING 2 fix actually widened.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R6 = makeRepo("contrib-tmp-r6");
    const tR6a = enterMergeQuarantine(R6, "loom/r6-branch", "merge in progress for R6 (028837ad contrib-tmp, first raise)");
    const tR6b = enterMergeQuarantine(R6, "loom/r6-branch", "merge in progress for R6 (028837ad contrib-tmp, second raise, same key)");
    const keyR6 = canonicalRepoLockKey(R6);
    const booted6 = await freshBootModule();
    booted6.reenterMergeQuarantinesAtBoot([R6]);
    check("(contrib-tmp precondition) R6 holds BOTH tokens at its own key after boot", JSON.stringify([...(booted6.activeMergeQuarantineFor(R6)?.tokens ?? [])].sort()) === JSON.stringify([tR6a, tR6b].sort()));

    const X6 = path.join(os.tmpdir(), `loom-mq028837-contrib-tmp-x6-never-exists-${freshSfx()}`);
    const C6 = path.join(os.tmpdir(), `loom-mq028837-contrib-tmp-c6-never-exists-${freshSfx()}`);
    const tF6 = randomUUID();
    const tC6 = randomUUID();
    const x6FakeResolvedKey = `mq028837-contrib-tmp-x6-fake-resolvedkey-${freshSfx()}`;
    const tmpPath6 = plantTmpResidue(keyR6, X6, "loom/x6-branch", "merge in progress for X6 (028837ad contrib-tmp)", [tR6a, tF6, tC6], "99902-cafe0029", booted6, { contributorRepoPaths: [C6], resolvedKey: x6FakeResolvedKey });

    booted6.clearMergeQuarantineByToken(R6, tR6a); // PARTIAL — tR6b stays outstanding; R6's own entry survives, reduced
    check("(contrib-tmp precondition) R6 itself is a PARTIAL reduce, never a full lift — tR6b still outstanding", (booted6.activeMergeQuarantineFor(R6)?.tokens ?? []).includes(tR6b) && !(booted6.activeMergeQuarantineFor(R6)?.tokens ?? []).includes(tR6a));
    const x6EntryAfterArm = booted6.activeMergeQuarantineFor(X6);
    check("*** FIX (contrib-tmp) *** X6 is reduced to [tF6, tC6] — tR6a gone, contributorRepoPaths SURVIVES the reduce", !!x6EntryAfterArm && JSON.stringify([...x6EntryAfterArm.tokens].sort()) === JSON.stringify([tC6, tF6].sort()) && (x6EntryAfterArm.contributorRepoPaths ?? []).includes(C6));
    check("*** FIX (contrib-tmp) *** C6 stays blocked in-process (stillBlockedEntryFor, via X6's contributorRepoPaths)", booted6.stillBlockedEntryFor(C6) !== undefined);
    const tmp6OnDisk = JSON.parse(fs.readFileSync(tmpPath6, "utf8"));
    check("*** FIX, ON DISK (contrib-tmp) *** the tmp residue's own contributorRepoPaths survives the durable reduce-write, not stripped", (tmp6OnDisk.contributorRepoPaths ?? []).includes(C6));
    check("*** FIX, ON DISK (contrib-tmp) *** the tmp residue's own resolvedKey ALSO survives (every known non-token field preserved, never just contributors)", tmp6OnDisk.resolvedKey === x6FakeResolvedKey);

    const fresh6 = await freshBootModule();
    fresh6.reenterMergeQuarantinesAtBoot([R6, X6]);
    check("*** FIX, DURABILITY (contrib-tmp) *** C6 stays blocked after a reboot too", fresh6.stillBlockedEntryFor(C6) !== undefined);
  }

  // @decision 028837ad — T8 must be a DISTINCT identity from the real B8, never the same repoPath
  // string; query B8 (never T8) via the key path, not the identity path.
  {
    const B8 = makeRepo("resolvedkey-b8"); // stays REAL throughout — never removed
    const keyB8 = canonicalRepoLockKey(B8);
    const T8 = path.join(B8, "gone-subdir-never-exists"); // unresolvable on its own, a DISTINCT identity from B8

    const A8 = makeRepo("resolvedkey-a8");
    const tA8 = enterMergeQuarantine(A8, "loom/a8-branch", "merge in progress for A8 (028837ad resolvedkey)");
    const orphanBasename8 = foldOrphanRefIntoOwnFinal(A8, mod);
    const booted8 = await freshBootModule();
    booted8.reenterMergeQuarantinesAtBoot([A8]);

    const tF8 = randomUUID();
    const orphanPath8 = writeOrphanContent(orphanBasename8, T8, "loom/t8-branch", "merge in progress for T8 (028837ad resolvedkey, under a real but distinct B8)", [tA8, tF8], booted8, { resolvedKey: keyB8, orphanLatchFiles: ["zzzz-sibling-8.json"] });

    booted8.clearMergeQuarantineByToken(A8, tA8);
    check("*** FIX, IN-PROCESS (resolvedkey) *** B8 itself (a REAL, resolvable repo, a DISTINCT identity from T8) reads blocked right after the arm+reduce — reachable ONLY via T8's preserved resolvedKey, never via a same-string identity match", booted8.stillBlockedEntryFor(B8) !== undefined);
    const orphan8OnDisk = JSON.parse(fs.readFileSync(orphanPath8, "utf8"));
    check("*** FIX, ON DISK (resolvedkey) *** O's own resolvedKey survives the durable reduce-write, not stripped", orphan8OnDisk.resolvedKey === keyB8);
    check("*** FIX, ON DISK (resolvedkey) *** O's own orphanLatchFiles (a secondary reference, unrelated to this card's own basenames override) survives, UNIONED with the arm's own self-reference — never overriding it", (orphan8OnDisk.orphanLatchFiles ?? []).includes("zzzz-sibling-8.json") && (orphan8OnDisk.orphanLatchFiles ?? []).includes(orphanBasename8));

    const fresh8 = await freshBootModule();
    fresh8.reenterMergeQuarantinesAtBoot([A8, T8]);
    // B8 itself (never T8) is the discriminating check — see the header comment above for why the OLD
    // T===B shape masked it entirely.
    check("*** FIX, DURABILITY (resolvedkey) *** B8 itself reads blocked after a reboot too — RED at `7203bbea` (resolvedKey lost, nothing left to arm T8 ACTIVE at B8's key), GREEN at the fix", fresh8.stillBlockedEntryFor(B8) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (EPERM-UNION, Round 4 B-1) a MEMORY-ONLY token must survive `clearTokenFromPendingIndices`'s own
  // reduce-write rebase onto disk. T10 is raised unresolvable (t1). Its SECOND raise (t2) takes
  // `mergeTokenIntoPendingEntries`'s own union-into-existing branch, whose durable write (~:3800) is
  // forced to fail (EPERM), AND (card 59e758e5, B3) its own safety-tmp fallback is ALSO forced to fail —
  // a genuine TRIPLE fault, restoring this scenario's own original "disk stays stale at [t1] while
  // memory holds [t1,t2]" precondition: a mere DOUBLE fault (the fallback succeeding) now secures the
  // merged content durably elsewhere before this scenario's own reduce ever runs, so it no longer
  // exercises `rebaseOntoRealDiskRecord: true`'s rebase onto genuinely stale disk at all.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const T10 = path.join(os.tmpdir(), `loom-mq028837-eperm-union-t10-never-exists-${freshSfx()}`);
    const t1 = enterMergeQuarantine(T10, "loom/t10-branch", "merge in progress for T10 (028837ad eperm-union, first raise)");
    const t10AfterFirstRaise = mod.activeMergeQuarantineFor(T10);
    check("(eperm-union precondition) T10 lands PENDING (unresolvable) after its first raise, with exactly [t1]", !!t10AfterFirstRaise && t10AfterFirstRaise.tokens.length === 1 && t10AfterFirstRaise.tokens[0] === t1);
    const sourceFile10 = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T10)?.sourceFile;
    const sourcePath10 = path.join(mod.MERGE_QUARANTINE_DIR, sourceFile10);

    const inject10 = injectOneShotRenameFailureWithSafetyTmpFailure(sourcePath10);
    let t2;
    try {
      t2 = enterMergeQuarantine(T10, "loom/t10-branch", "merge in progress for T10 (028837ad eperm-union, second raise, triple fault)");
    } finally {
      inject10.restore();
    }
    check("(eperm-union precondition) the injected rename failure actually tripped", inject10.tripped());
    check("(eperm-union precondition, card 59e758e5 B3) the safety-tmp fallback's own write was ALSO forced to fail (genuine triple fault)", inject10.safetyHits() >= 1);
    const t10AfterSecondRaise = mod.activeMergeQuarantineFor(T10);
    check("(eperm-union precondition) t2 is outstanding IN-MEMORY right now, alongside t1", !!t10AfterSecondRaise && t10AfterSecondRaise.tokens.includes(t1) && t10AfterSecondRaise.tokens.includes(t2));
    const onDiskAfterEperm = JSON.parse(fs.readFileSync(sourcePath10, "utf8"));
    check("(eperm-union precondition) the second raise's own durable write genuinely failed — disk still names ONLY [t1]", JSON.stringify(onDiskAfterEperm.tokens) === JSON.stringify([t1]));

    mod.clearMergeQuarantineByToken(T10, t1);
    const t10EntryAfterReduce = mod.activeMergeQuarantineFor(T10);
    check("T10 holds JUST [t2] in-process — t1 gone, t2 survives the reduce, never silently dropped to zero tokens", !!t10EntryAfterReduce && t10EntryAfterReduce.tokens.length === 1 && t10EntryAfterReduce.tokens[0] === t2);
    const sourceFile10AfterClear = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T10)?.sourceFile;
    const onDiskAfterReduce = JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, sourceFile10AfterClear), "utf8"));
    check("ON DISK (eperm-union) the durable reduce-write persists [t2], not an empty token set", JSON.stringify(onDiskAfterReduce.tokens) === JSON.stringify([t2]));

    const freshT10 = await freshBootModule();
    freshT10.reenterMergeQuarantinesAtBoot([]); // T10 never exists on disk — nothing registered/resolvable
    const t10PostReboot = freshT10.activeMergeQuarantineFor(T10);
    check("*** FIX, DURABILITY (eperm-union) *** a reboot agrees — T10 still holds [t2], not lost", !!t10PostReboot && t10PostReboot.tokens.length === 1 && t10PostReboot.tokens[0] === t2);

    mod.clearMergeQuarantineByToken(T10, t2);
    check("*** NO LOSS, NO STRAND (eperm-union) *** T10's own later clear(t2) fully lifts it in-process", mod.assertRepoNotQuarantined(T10).ok === true);
  }

  // @decision 028837ad — EVERY non-token field (not just tokens) must survive this reduce-write's own
  // rebase; T11's own collision file mirrors card 882d6cff's multi-claimant shape.
  {
    const T11 = path.join(os.tmpdir(), `loom-mq028837-multi-eperm-t11-never-exists-${freshSfx()}`);
    const tA11 = enterMergeQuarantine(T11, "loom/t11-branch", "merge in progress for T11 (028837ad multi-eperm, primary, token a)");
    const sourceFileA11 = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T11)?.sourceFile;
    const sourcePathA11 = path.join(mod.MERGE_QUARANTINE_DIR, sourceFileA11);

    const tB11 = randomUUID();
    const collisionBasename11 = `loom-mq028837-multi-eperm-t11-collision-${freshSfx()}.json`;
    const collisionEntry11 = { repoPath: T11, branch: "loom/t11-collision-branch", reason: "merge in progress for T11 (028837ad multi-eperm, collision, token b)", tokens: [tB11], enteredAt: Date.now() + 1000, provenanceUnknown: true };
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, collisionBasename11), JSON.stringify(collisionEntry11));
    mod.pushPendingQuarantineTestOnly(collisionEntry11, collisionBasename11);
    check("(multi-eperm precondition) T11 now has TWO independent pending records sharing one identity", mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === T11).length === 2);

    // Card 59e758e5 (B3) — a genuine TRIPLE fault (rename AND the safety-tmp fallback's own write both
    // failing) restores this scenario's own original precondition: the primary file stays genuinely
    // stale at [a] in memory's shadow, never swept or relocated.
    const inject11 = injectOneShotRenameFailureWithSafetyTmpFailure(sourcePathA11);
    let tC11;
    try {
      tC11 = enterMergeQuarantine(T11, "loom/t11-branch", "merge in progress for T11 (028837ad multi-eperm, third raise, triple fault)");
    } finally {
      inject11.restore();
    }
    check("(multi-eperm precondition) the injected rename failure actually tripped", inject11.tripped());
    check("(multi-eperm precondition, card 59e758e5 B3) the safety-tmp fallback's own write was ALSO forced to fail (genuine triple fault)", inject11.safetyHits() >= 1);
    check("(multi-eperm precondition) T11's two pending records are now merged into ONE in-memory record", mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === T11).length === 1);
    const t11AfterThirdRaise = mod.activeMergeQuarantineFor(T11);
    check("(multi-eperm precondition) the merged in-memory record carries all THREE tokens, provenanceUnknown, and the collision file as an orphanLatchFiles reference", !!t11AfterThirdRaise && [tA11, tB11, tC11].every((t) => t11AfterThirdRaise.tokens.includes(t)) && t11AfterThirdRaise.provenanceUnknown === true && (t11AfterThirdRaise.orphanLatchFiles ?? []).includes(collisionBasename11));
    check("(multi-eperm precondition) the primary file's own durable write genuinely failed — disk still names ONLY [a], no provenanceUnknown, no orphanLatchFiles", (() => {
      const onDisk = JSON.parse(fs.readFileSync(sourcePathA11, "utf8"));
      return JSON.stringify(onDisk.tokens) === JSON.stringify([tA11]) && onDisk.provenanceUnknown === undefined && onDisk.orphanLatchFiles === undefined;
    })());
    // `writePendingDivertFile`'s own catch path still unlinks ONLY a stranded tmp its own caller already
    // decided is a safe subset elsewhere — on a triple fault, the raise caller KEEPS it (card 59e758e5,
    // B1), so the ORDINARY stranded tmp from this failed rename is expected to survive here too.
    const strandedTmps11 = fs.readdirSync(mod.MERGE_QUARANTINE_DIR).filter((f) => f.startsWith(`${sourceFileA11}.tmp-`) && !f.includes("-safety-"));
    check("*** FIX, B1 (multi-eperm, tmp cleanup) *** the triple-faulted rename leaves the ORDINARY stranded tmp in place, holding the full merge — the accepted fail-closed duplicate, never unlinked before anything could secure it", strandedTmps11.length === 1 && [tA11, tB11, tC11].every((t) => JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, strandedTmps11[0]), "utf8")).tokens.includes(t)));

    mod.clearMergeQuarantineByToken(T11, tA11);
    const t11AfterClearA = mod.activeMergeQuarantineFor(T11);
    check("*** FIX (multi-eperm) *** T11 holds [b,c] in-process — a gone, provenanceUnknown and the collision orphanLatchFiles reference SURVIVE the reduce, never silently dropped", !!t11AfterClearA && [tB11, tC11].every((t) => t11AfterClearA.tokens.includes(t)) && !t11AfterClearA.tokens.includes(tA11) && t11AfterClearA.provenanceUnknown === true && (t11AfterClearA.orphanLatchFiles ?? []).includes(collisionBasename11));
    const sourceFileA11AfterClearA = mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T11)?.sourceFile;
    const primaryOnDiskAfterClearA = JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, sourceFileA11AfterClearA), "utf8"));
    check("*** FIX, ON DISK (multi-eperm) *** the durable reduce-write ALSO persists provenanceUnknown and the collision orphanLatchFiles reference, not just tokens", primaryOnDiskAfterClearA.provenanceUnknown === true && (primaryOnDiskAfterClearA.orphanLatchFiles ?? []).includes(collisionBasename11));

    mod.clearMergeQuarantineByToken(T11, tB11);
    mod.clearMergeQuarantineByToken(T11, tC11); // the full lift — must sweep the now-correctly-referenced collision file
    check("*** NO RE-BLOCK (multi-eperm) *** T11 fully lifts in-process after all three clears", mod.assertRepoNotQuarantined(T11).ok === true);
    check("*** FIX, SWEPT (multi-eperm) *** the collision file is gone — correctly referenced and swept on the full lift, never left stale with an already-released token", !fs.existsSync(path.join(mod.MERGE_QUARANTINE_DIR, collisionBasename11)));
    // @decision 8d80b736 — supersedes the "ACCEPTED RESIDUAL" shape this scenario used to assert below;
    // the stranded tmp is now ALSO tracked in `orphanLatchFiles`, so this full-lift sweep already swept
    // it too, same as the collision file. See the decision record.
    check("*** FIX, 8d80b736, SWEPT (multi-eperm) *** the stranded tmp is ALSO gone — correctly tracked and swept on the full lift, never left for a reboot to resurrect from", strandedTmps11.every((f) => !fs.existsSync(path.join(mod.MERGE_QUARANTINE_DIR, f))));

    // @decision 8d80b736 — formerly an ACCEPTED RESIDUAL (card 59e758e5, B1): a reboot used to re-arm
    // T11 from the untracked stranded tmp. Now swept above, so a reboot finds nothing to re-arm. See
    // the decision record.
    const freshT11 = await freshBootModule();
    freshT11.reenterMergeQuarantinesAtBoot([]);
    check("*** FIX, 8d80b736 (multi-eperm, reboot) *** T11 is genuinely, fully unblocked after the reboot — no stray duplicate re-arms from the (now-swept) stranded tmp", freshT11.assertRepoNotQuarantined(T11).ok === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (TWIN GUARD) a genuine 883e29bc-shaped dual-tracked twin — the SAME entry object reference armed
  // BOTH active (at key) and pending (at sourceFile) — must not be double-processed or wrongly re-reduced
  // by the new post-loop pass. Constructed directly via the real test-only seams (no boot/raise needed).
  // NOTE (round 2, SHOULD 3): Y's identity is ALREADY pending BEFORE `clearMergeQuarantineByToken` is
  // even called, so this scenario is protected by the `identitiesPendingBeforeCall` exclusion ALONE —
  // it does NOT exercise (and is NOT a proof of) the separate `activeMatchesAfterLoop` exclusion; it
  // passes unchanged even reverted to the pre-028837ad original code. Kept as a non-regression pin for
  // the pre-existing dual-tracked-twin shape, not as coverage of the new pass's own second exclusion.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const booted3 = await freshBootModule();
    const Y = makeRepo("twin-y");
    const key = canonicalRepoLockKey(Y);
    const tA3 = randomUUID();
    const twinEntry = { repoPath: Y, branch: "loom/y-branch", reason: "merge in progress for Y (028837ad twin guard)", tokens: [tA3, "wa-token"], enteredAt: Date.now() };
    booted3.setActiveQuarantineTestOnly(key, twinEntry);
    const twinSourceFile = "pending-028837ad-twin-test.json";
    // The dual-tracked-twin rewrite loop (ae79d492) only rewrites a sourceFile that already EXISTS on
    // disk (merge-quarantine.ts ~:4924) — write the twin's own real backing file now, matching what a
    // genuine boot-diverted twin always has, before pushing the in-memory reference.
    fs.mkdirSync(booted3.MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(booted3.MERGE_QUARANTINE_DIR, twinSourceFile), JSON.stringify(twinEntry));
    booted3.pushPendingQuarantineTestOnly(twinEntry, twinSourceFile);
    check("(twin precondition) Y is a genuine dual-tracked twin — same object active AND pending", booted3.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === Y && p.sourceFile === twinSourceFile));

    booted3.clearMergeQuarantineByToken(Y, tA3);

    // Check the pending array + its own physical file FIRST, before any mutating query
    // (`activeMergeQuarantineFor`/`assertRepoNotQuarantined` both perform lazy graduation/cross-tier
    // absorption as a side effect of being queried — see 1dd00dca's own doc on `stillBlockedEntryFor`
    // vs those two — which would legitimately absorb this now-redundant twin into the active side and
    // make it vanish from `pendingUnresolvedQuarantines` for a REASON UNRELATED to this card).
    check("*** TWIN GUARD *** the twin's pending-array entry is NOT removed outright — only reduced", booted3.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === Y));
    const twinPath = path.join(booted3.MERGE_QUARANTINE_DIR, twinSourceFile);
    const twinOnDisk = (() => { try { return JSON.parse(fs.readFileSync(twinPath, "utf8")); } catch { return undefined; } })();
    check("*** TWIN GUARD *** the twin's own pending-side physical file is durably rewritten with the SAME reduced token set, not left stale or wiped", !!twinOnDisk && JSON.stringify((twinOnDisk.tokens ?? []).slice().sort()) === JSON.stringify(["wa-token"]));

    const yActiveAfter = booted3.activeMergeQuarantineFor(Y);
    check("*** TWIN GUARD *** Y's active entry is reduced to EXACTLY its own remaining token, never double-reduced to empty", !!yActiveAfter && yActiveAfter.tokens.length === 1 && yActiveAfter.tokens[0] === "wa-token");
    check("(twin) Y still reads genuinely blocked (its own remaining token, not a dead one)", booted3.assertRepoNotQuarantined(Y).ok === false);
  }

  console.log(failures === 0
    ? "\n✅ ALL SCENARIOS PASS — clearMergeQuarantineByToken's new post-loop pending pass lifts a cleared "
      + "token from a foreign identity armed PENDING mid-call (proven for the orphan arm path, the "
      + "tmp-residue ARM path via CONTRIB-TMP's own partial reduce, and the pre-loop-pass-arm shape), "
      + "durably and reboot-consistently, with the reduce-write itself rebasing onto the REAL on-disk "
      + "record (never the arm's own deliberately narrow in-memory model) so contributorRepoPaths/"
      + "resolvedKey/every other known non-token field survives preserved — without disturbing the "
      + "resolvable self-recovery case, a genuine dual-tracked twin, card 3315b08a's own ambiguous "
      + "multi-record identity, or the separate, pre-existing relocate-path mechanism (TMP-RESIDUE-RELOCATE)."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces (or regresses the fix for) board card 028837ad.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
