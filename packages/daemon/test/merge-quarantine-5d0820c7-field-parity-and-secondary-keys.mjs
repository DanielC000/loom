import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 5d0820c7 — the in-process arm must carry every field PASS 1 itself would construct from the
// SAME bytes (Step A: field parity via `latchEntryFromParsedRecord`) and, where Step A alone is not
// enough, attempt every secondary key too (Step B). See the decision record for the full design.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq5d0820-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq5d0820@loom -c user.name=mq5d0820";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq5d0820-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-5d0820c7 (${tag})\n`);
  execSync(`git init -q && git config user.email mq5d0820@loom && git config user.name mq5d0820`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 1dd00dca's/028837ad's own test files: fold `orphanBasename` into `repoPath`'s own
// on-disk final JSON BEFORE `orphanBasename` itself exists.
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
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
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

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SHAPE1-SUBDIR, non-regression) T a ghost subdirectory of B — closed by STEP A ALONE, via the
  // PRE-EXISTING 883e29bc pending-lookup fallback (canonicalRepoLockKey's own ancestor walk reaches B's
  // key regardless of any explicit resolvedKey). Pinned as a non-regression, never attributed to Step B.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("subdir-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 subdir)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const B = makeRepo("subdir-b");
    const keyB = canonicalRepoLockKey(B);
    const T = path.join(B, "never-exists-ghost-subdir-of-b");
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (5d0820c7 subdir, under B)", [tF], booted, { resolvedKey: keyB });

    booted.clearMergeQuarantineByToken(A, tA);
    check("(SHAPE1-SUBDIR) B reads blocked in-process right after the bare arm — via ancestor-walk collapse, not Step B", booted.stillBlockedEntryFor(B) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, B]);
    check("(SHAPE1-SUBDIR) B reads blocked after a reboot too — agrees with in-process", fresh.stillBlockedEntryFor(B) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SHAPE1-UNRELATED) THE card's own real motivating shape — resolvedKey names a repo B, T is a
  // WHOLLY UNRELATED ghost (never nested under B — canonicalRepoLockKey(T)'s own ancestor walk does NOT
  // reach B's key, unlike SHAPE1-SUBDIR above). Only Step B's own secondary-key arm closes this.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("s1u-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 s1 unrelated)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const B = makeRepo("s1u-b");
    const keyB = canonicalRepoLockKey(B);
    const T = path.join(os.tmpdir(), `loom-mq5d0820-s1u-t-never-exists-UNRELATED-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (5d0820c7 s1 unrelated)", [tF], booted, { resolvedKey: keyB });

    booted.clearMergeQuarantineByToken(A, tA);
    check("(SHAPE1-UNRELATED) B reads blocked in-process right after the bare arm — via Step B's own secondary-key arm, never ancestor-walk collapse", booted.stillBlockedEntryFor(B) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, B]);
    check("(SHAPE1-UNRELATED) B reads blocked after a reboot too — agrees with in-process", fresh.stillBlockedEntryFor(B) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SHAPE2-ORPHAN) contributorRepoPaths names a contributor C; T is RESOLVABLE (armed ACTIVE directly).
  // O holds ONLY T's own token (no overlap with the clearer A's) so nothing ever reduces/rewrites T's
  // armed entry — isolating the bare arm from 028837ad's own write/reduce-adopt mechanism.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("s2o-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 s2 orphan)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const T = makeRepo("s2o-t");
    const C = path.join(os.tmpdir(), `loom-mq5d0820-s2o-c-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (5d0820c7 s2 orphan, resolvable)", [tF], booted, { contributorRepoPaths: [C] });

    booted.clearMergeQuarantineByToken(A, tA);
    check("(SHAPE2-ORPHAN) C reads blocked in-process right after the bare arm — via T's contributorRepoPaths, carried through by Step A", booted.stillBlockedEntryFor(C) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, T, C]);
    check("(SHAPE2-ORPHAN) C reads blocked after a reboot too — agrees with in-process", fresh.stillBlockedEntryFor(C) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SHAPE2-TMP) the identical contributor shape, via the `.tmp-residue` twin — planted at the CLEARER
  // A's own key hash, so A's own full lift (clearMergeQuarantineByToken, A holding ONLY tA) reaches it
  // via deleteMergeQuarantineLatchByKey's own trailing sweep. Proves the two-path symmetry this card's
  // own design requires: BOTH sweeps reuse the SAME armForeignOrphanContentInMemoryIfUnenforced body.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("s2t-a");
    const keyA = canonicalRepoLockKey(A);
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 s2 tmp)");

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const T = makeRepo("s2t-t");
    const C = path.join(os.tmpdir(), `loom-mq5d0820-s2t-c-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    plantTmpResidue(keyA, T, "loom/t-branch", "merge in progress for T (5d0820c7 s2 tmp, resolvable)", [tF], "88801-dead1111", booted, { contributorRepoPaths: [C] });

    booted.clearMergeQuarantineByToken(A, tA); // A's own FULL lift (only token) reaches the tmp sweep
    check("(SHAPE2-TMP) C reads blocked in-process right after the bare arm — via T's contributorRepoPaths, carried through by Step A", booted.stillBlockedEntryFor(C) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, T, C]);
    check("(SHAPE2-TMP) C reads blocked after a reboot too — agrees with in-process", fresh.stillBlockedEntryFor(C) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) k occupied by U (raised for real, holding its own token tU,
  // entered BEFORE T — the YOUNGER-T ordering). T is UNRESOLVABLE, carries resolvedKey=k and ONLY its
  // own token tF (no overlap with A's tA, the clearer, OR tU) — so nothing but Step B's own
  // secondary-key arm ever touches k here. Clearing U's OWN token alone must leave k still blocked
  // (T's unioned token outstanding) — the manager-required fail-closed shape. UNRESOLVABLE T is
  // UNCHANGED by the round-2 BLOCKING-1 fix (that fix gates on `resolvableNow` only) — unconditional
  // union here matches bootref exactly, since T never occupies its own primary key to begin with.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("occ-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 occupied-key)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const U = makeRepo("occ-u");
    const keyU = canonicalRepoLockKey(U);
    // Raised via `booted` itself (not the top-level `mod`) so U is tracked in the SAME module instance
    // the rest of this scenario operates on — it must genuinely occupy `booted`'s own `activeQuarantines`
    // at `keyU` for the secondary-key union to have anything to union with.
    const tU = booted.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (5d0820c7 occupied-key)");

    const T = path.join(os.tmpdir(), `loom-mq5d0820-occ-t-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (5d0820c7 occupied-key)", [tF], booted, { resolvedKey: keyU });

    booted.clearMergeQuarantineByToken(A, tA); // arms T, unions its token into U's own occupied key
    const uEntryAfterArm = booted.activeMergeQuarantineFor(U);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U's own entry carries BOTH its own token and T's unioned token right after the arm", !!uEntryAfterArm && uEntryAfterArm.tokens.includes(tU) && uEntryAfterArm.tokens.includes(tF));

    booted.clearMergeQuarantineByToken(U, tU); // U's OWN only token, cleared alone
    const uEntryAfterClear = booted.activeMergeQuarantineFor(U);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U's own entry still EXISTS in-process after clearing its own token alone (not vacuously undefined)", uEntryAfterClear !== undefined);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U STILL reads blocked in-process after clearing its OWN token alone (T's unioned token outstanding) — never a fail-open", booted.stillBlockedEntryFor(U) !== undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U]); // A is fully lifted; U's own disk latch was already reduced
    const uEntryAfterReboot = fresh.activeMergeQuarantineFor(U);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U's own entry still EXISTS after a reboot too (not vacuously undefined)", uEntryAfterReboot !== undefined);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U still reads blocked after a reboot too — agrees with in-process", fresh.stillBlockedEntryFor(U) !== undefined);
    check("(OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T) U's own provenanceUnknown is the SAME in-process as after a reboot (both absent, for this exact construction — never set by Step B's own secondary-key union)", uEntryAfterClear.provenanceUnknown === uEntryAfterReboot.provenanceUnknown);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (OCCUPIED-KEY-UNRESOLVABLE-OLDER-T, SHOULD-2 pin) the SAME unresolvable-T shape as above, but T's
  // own orphan content is planted BEFORE U is raised (T OLDER than U) — pinning that `unionQuarantineEntries`'s
  // own "keep the EARLIER identity" tie-break still agrees with a reboot taken at the same point,
  // regardless of which side is older. Never attributed to Step B's own round-2 fix (unaffected by it).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("occo-a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 occupied-key-older-t)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const U = makeRepo("occo-u");
    const keyU = canonicalRepoLockKey(U);
    const T = path.join(os.tmpdir(), `loom-mq5d0820-occo-t-never-exists-${freshSfx()}`);
    const tF = randomUUID();
    // T's own content planted FIRST (older enteredAt) — U raised AFTER (younger).
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (5d0820c7 occupied-key-older-t)", [tF], booted, { resolvedKey: keyU });
    const tU = booted.enterMergeQuarantine(U, "loom/u-branch", "merge in progress for U (5d0820c7 occupied-key-older-t)");

    booted.clearMergeQuarantineByToken(A, tA);
    const uEntryAfterArm = booted.activeMergeQuarantineFor(U);
    check("(OCCUPIED-KEY-UNRESOLVABLE-OLDER-T) U's own entry carries BOTH tokens right after the arm, T older", !!uEntryAfterArm && uEntryAfterArm.tokens.includes(tU) && uEntryAfterArm.tokens.includes(tF));

    booted.clearMergeQuarantineByToken(U, tU);
    const uBlockedInProcess = booted.stillBlockedEntryFor(U) !== undefined;
    check("(OCCUPIED-KEY-UNRESOLVABLE-OLDER-T) U STILL reads blocked in-process after clearing its own token alone, T older", uBlockedInProcess);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U]);
    check("(OCCUPIED-KEY-UNRESOLVABLE-OLDER-T) U still reads blocked after a reboot too — agrees with in-process, T older", fresh.stillBlockedEntryFor(U) !== undefined);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (OCCUPIED-KEY-RESOLVABLE-T, BLOCKING-1 regression) U raised live (tU, a REAL resolvable repo). O
  // names T (ALSO a REAL resolvable repo), tokens [tF] only, resolvedKey=key(U). The clear on A arms T
  // at its OWN primary key AND attempts the secondary arm at U's key — which MUST be DECLINED (U is a
  // different, genuinely-fresh identity there) rather than unioned, or `armQuarantineKey`'s own
  // armedKeys-driven write-everywhere durably replaces T's own primary-key entry with the merged,
  // U-identity-labeled object (round-2 BLOCKING-1: a permanent strand, confirmed RED at 39e173ac in
  // BOTH clear orders, with a leftover `pending-<hash>.json` and on-disk cross-identity bleed). Proven
  // in BOTH clear orders, since the bug was order-independent.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const order of ["T-then-U", "U-then-T"]) {
    const A = makeRepo(`occr-a-${order}`);
    const tA = enterMergeQuarantine(A, "loom/a-branch", `merge in progress for A (5d0820c7 occupied-key-resolvable, ${order})`);
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const U = makeRepo(`occr-u-${order}`);
    const keyU = canonicalRepoLockKey(U);
    const tU = booted.enterMergeQuarantine(U, "loom/u-branch", `merge in progress for U (5d0820c7 occupied-key-resolvable, ${order})`);

    const T = makeRepo(`occr-t-${order}`); // T is a REAL, resolvable repo — never a ghost
    const keyT = canonicalRepoLockKey(T);
    const tF = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", `merge in progress for T (5d0820c7 occupied-key-resolvable, ${order})`, [tF], booted, { resolvedKey: keyU });

    booted.clearMergeQuarantineByToken(A, tA);
    const tEntryRightAfterArm = booted.activeMergeQuarantineFor(T);
    const uEntryRightAfterArm = booted.activeMergeQuarantineFor(U);
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) T's own entry (queried by its own key) is genuinely T's own, never swapped to U's identity`, tEntryRightAfterArm?.repoPath === T);
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) U's own entry (queried by its own key) is genuinely U's own, never swapped to T's identity — U's secondary claim at keyU was declined, not unioned`, uEntryRightAfterArm?.repoPath === U && (uEntryRightAfterArm?.tokens ?? []).length === 1 && uEntryRightAfterArm.tokens[0] === tU);

    if (order === "T-then-U") {
      booted.clearMergeQuarantineByToken(T, tF);
      booted.clearMergeQuarantineByToken(U, tU);
    } else {
      booted.clearMergeQuarantineByToken(U, tU);
      // Optional (card 62c79512): the FRESH-occupant counterpart to the STALE-OCCUPANT-RESOLVABLE-T
      // scenario's own mid-reboot residual check, below — the SAME gap, not stale-specific, proven here
      // for a fresh U too (T's own orphan content still carries resolvedKey=keyU, now free on disk).
      const midReboot = await freshBootModule();
      midReboot.reenterMergeQuarantinesAtBoot([T]);
      check(`(OCCUPIED-KEY-RESOLVABLE-T, U-then-T) NAMED RESIDUAL (not stale-specific): a reboot taken right after clearing FRESH occupant U still reads keyU blocked (T's on-disk resolvedKey=keyU re-arms it once free) — in-process does not, by design (T's secondary claim was declined there)`, midReboot.stillBlockedEntryFor(U) !== undefined);
      check(`(OCCUPIED-KEY-RESOLVABLE-T, U-then-T) the SAME mid-reboot never touches T's own primary key — T stays blocked there too`, midReboot.stillBlockedEntryFor(T) !== undefined);
      booted.clearMergeQuarantineByToken(T, tF);
    }
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) T is fully lifted in-process after both its own and U's tokens clear`, !booted.stillBlockedEntryFor(T));
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) U is fully lifted in-process after both its own and T's tokens clear`, !booted.stillBlockedEntryFor(U));
    // Scoped to THIS scenario's own orphan file, never a directory-wide count — `MERGE_QUARANTINE_DIR`
    // is shared across every scenario in this file, so a bare file-count would be contaminated by
    // whatever earlier scenarios left behind (unrelated to this scenario, and not this card's scope).
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) T's own orphan file is swept once T is fully lifted (content-aware sweep, unaffected by the decline)`, !fs.existsSync(orphanPath));
    // No file anywhere in the directory should carry a cross-identity swap (T's content on U's physical
    // file or vice versa) — the manager's own explicit "no on-disk cross-identity bleed" requirement.
    const noCrossIdentityBleed = fs.readdirSync(booted.MERGE_QUARANTINE_DIR).every((f) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(booted.MERGE_QUARANTINE_DIR, f), "utf8"));
        return (parsed.repoPath !== U || !(parsed.tokens ?? []).includes(tF))
            && (parsed.repoPath !== T || !(parsed.tokens ?? []).includes(tU));
      } catch { return true; }
    });
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) no on-disk file names U while holding T's own token, or T while holding U's own token — no cross-identity bleed`, noCrossIdentityBleed);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([U, T]);
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) T is not re-blocked after a reboot`, !fresh.stillBlockedEntryFor(T));
    check(`(OCCUPIED-KEY-RESOLVABLE-T, ${order}) U is not re-blocked after a reboot`, !fresh.stillBlockedEntryFor(U));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (STALE-OCCUPANT-RESOLVABLE-T, round-3 BLOCKING-1 widening) U raised live, then its own directory
  // renamed away — a STALE different-identity occupant at keyU, never a fresh one. T a real resolvable
  // repo, resolvedKey=key(U). Both clear orders, each with a reboot taken right after its own first
  // clear.
  //
  // @decision 5d0820c7 (round 3) — the reboot-vs-in-process gap at keyU here is scoped to ANY declined
  // occupant cleared first (fresh or stale, dating from round 2), never to T's own primary key.
  //
  // OCCUPIED-KEY-RESOLVABLE-T's own optional mid-reboot check, below, proves the FRESH-occupant case.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const order of ["T-then-U", "U-then-T"]) {
    const A = makeRepo(`stal-a-${order}`);
    const tA = enterMergeQuarantine(A, "loom/a-branch", `merge in progress for A (5d0820c7 stale-occupant, ${order})`);
    const orphanBasename = foldOrphanRefIntoOwnFinal(A, mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const uDir = makeRepo(`stal-u-${order}`);
    const keyU = canonicalRepoLockKey(uDir);
    const tU = booted.enterMergeQuarantine(uDir, "loom/u-branch", `merge in progress for U (5d0820c7 stale-occupant, ${order})`);
    // Rename U's own dir away — U still occupies keyU in-memory, but it no longer resolves: a STALE
    // different-identity occupant (`isKeyVerifiedFor(uDir, keyU)` now reads false).
    fs.renameSync(uDir, `${uDir}-moved-away`);

    const T = makeRepo(`stal-t-${order}`); // T is a REAL, resolvable repo — never a ghost
    const tF = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", `merge in progress for T (5d0820c7 stale-occupant, ${order})`, [tF], booted, { resolvedKey: keyU });

    booted.clearMergeQuarantineByToken(A, tA);
    const tEntryRightAfterArm = booted.activeMergeQuarantineFor(T);
    const uEntryRightAfterArm = booted.activeMergeQuarantineFor(uDir);
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) T's own entry (queried by its own key) is genuinely T's own, never swapped to U's identity`, tEntryRightAfterArm?.repoPath === T);
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) U's own entry (queried by its own key) is genuinely U's own, never swapped to T's identity — T's secondary claim at keyU was declined (stale occupant), not unioned`, uEntryRightAfterArm?.repoPath === uDir && (uEntryRightAfterArm?.tokens ?? []).length === 1 && uEntryRightAfterArm.tokens[0] === tU);

    if (order === "T-then-U") {
      booted.clearMergeQuarantineByToken(T, tF);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, T-then-U) T is lifted in-process right after its own clear`, !booted.stillBlockedEntryFor(T));
      check(`(STALE-OCCUPANT-RESOLVABLE-T, T-then-U) U is STILL blocked in-process right after T's own clear (U's own token untouched)`, booted.stillBlockedEntryFor(uDir) !== undefined);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, T-then-U) T's own orphan file is swept the instant T is fully lifted`, !fs.existsSync(orphanPath));

      const midReboot = await freshBootModule();
      midReboot.reenterMergeQuarantinesAtBoot([]); // T's own content is already gone from disk
      check(`(STALE-OCCUPANT-RESOLVABLE-T, T-then-U) a reboot taken right after T's own clear agrees — T unblocked (nothing left on disk to re-arm it)`, !midReboot.stillBlockedEntryFor(T));
      check(`(STALE-OCCUPANT-RESOLVABLE-T, T-then-U) a reboot taken right after T's own clear agrees — U still blocked`, midReboot.stillBlockedEntryFor(uDir) !== undefined);

      booted.clearMergeQuarantineByToken(uDir, tU);
    } else {
      booted.clearMergeQuarantineByToken(uDir, tU);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, U-then-T) U is lifted in-process right after its OWN clear (T's secondary claim was declined, never armed at keyU)`, !booted.stillBlockedEntryFor(uDir));
      check(`(STALE-OCCUPANT-RESOLVABLE-T, U-then-T) T is STILL blocked in-process right after U's clear (T's own token untouched)`, booted.stillBlockedEntryFor(T) !== undefined);

      // ⚠️ NAMED, ACCEPTED RESIDUAL (dates from round 2's own unconditional decline, widened — not fixed
      // — by round 3 to also cover a STALE occupant; see the decision record's own Round 3 section):
      // clearing ANY declined different-identity occupant FIRST, fresh or stale, leaves keyU free
      // in-process but still re-armable, from T's own on-disk resolvedKey=keyU, on a reboot taken at
      // this exact point — scoped to keyU alone, never T's own primary key (asserted just below).
      const midReboot = await freshBootModule();
      midReboot.reenterMergeQuarantinesAtBoot([T]);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, U-then-T) NAMED RESIDUAL: a reboot taken right after U's own clear still reads keyU blocked (T's on-disk resolvedKey=keyU re-arms it once free) — in-process does not, by design (T's secondary claim was declined there)`, midReboot.stillBlockedEntryFor(uDir) !== undefined);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, U-then-T) the SAME mid-reboot never touches T's own primary key — T stays blocked there too (the residual is scoped to keyU alone, never T's own primary)`, midReboot.stillBlockedEntryFor(T) !== undefined);

      booted.clearMergeQuarantineByToken(T, tF);
      check(`(STALE-OCCUPANT-RESOLVABLE-T, U-then-T) T's own orphan file is swept once T is fully lifted too`, !fs.existsSync(orphanPath));
    }

    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) T is fully lifted in-process after both its own and U's tokens clear`, !booted.stillBlockedEntryFor(T));
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) U is fully lifted in-process after both its own and T's tokens clear`, !booted.stillBlockedEntryFor(uDir));

    // Scoped to a content-aware cross-identity-bleed scan, never a directory-wide count — `MERGE_QUARANTINE_DIR`
    // is shared across every scenario in this file (see this card's own Do-not list).
    const noCrossIdentityBleed = fs.readdirSync(booted.MERGE_QUARANTINE_DIR).every((f) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(booted.MERGE_QUARANTINE_DIR, f), "utf8"));
        return (parsed.repoPath !== uDir || !(parsed.tokens ?? []).includes(tF))
            && (parsed.repoPath !== T || !(parsed.tokens ?? []).includes(tU));
      } catch { return true; }
    });
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) no on-disk file names U while holding T's own token, or vice versa — no cross-identity bleed`, noCrossIdentityBleed);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]); // both fully lifted and swept — nothing left to register
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) T is not re-blocked after a final reboot`, !fresh.stillBlockedEntryFor(T));
    check(`(STALE-OCCUPANT-RESOLVABLE-T, ${order}) U is not re-blocked after a final reboot`, !fresh.stillBlockedEntryFor(uDir));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SHOULD1-TMP-PROVENANCE) round-2 fix: `detectUnknownProvenance`'s own hash must be derived PASS 1b's
  // way for a tmp residue (never the orphan-only `.slice(0, -".json".length)` form, which is garbage for
  // a `.json.tmp-<pid>-<hex>` filename). T resolvable, ≥2 tokens, NO contributors (so detection actually
  // runs — SHAPE2-TMP's own contributors short-circuit it), planted at the clearer's OWN key hash with
  // resolvedKey matching that SAME key (so a CORRECTLY-derived hash finds no mismatch at all).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("s1p-a");
    const keyA = canonicalRepoLockKey(A);
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (5d0820c7 should1-tmp-provenance)");

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);

    const T = makeRepo("s1p-t");
    const tF1 = randomUUID();
    const tF2 = randomUUID();
    plantTmpResidue(keyA, T, "loom/t-branch", "merge in progress for T (5d0820c7 should1-tmp-provenance, 2 tokens, no contributors)", [tF1, tF2], "77701-beef2222", booted, { resolvedKey: keyA });

    booted.clearMergeQuarantineByToken(A, tA); // A's own FULL lift reaches the tmp sweep at keyA's own hash
    const tEntryInProcess = booted.activeMergeQuarantineFor(T);
    check("(SHOULD1-TMP-PROVENANCE) T's entry exists in-process", tEntryInProcess !== undefined);
    check("(SHOULD1-TMP-PROVENANCE) T's own provenanceUnknown is undefined in-process (hash derived PASS 1b's own way for a tmp filename)", tEntryInProcess?.provenanceUnknown === undefined);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A, T]);
    const tEntryAfterReboot = fresh.activeMergeQuarantineFor(T);
    check("(SHOULD1-TMP-PROVENANCE) T's entry exists after a reboot too", tEntryAfterReboot !== undefined);
    check("(SHOULD1-TMP-PROVENANCE) T's own provenanceUnknown agrees in-process vs after reboot", tEntryInProcess.provenanceUnknown === tEntryAfterReboot.provenanceUnknown);
  }

  console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("TEST CRASHED:", e);
  process.exitCode = 2;
}
