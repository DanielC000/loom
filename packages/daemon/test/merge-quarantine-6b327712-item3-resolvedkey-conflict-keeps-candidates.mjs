import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6b327712 (item 3) — pins that a writePendingDivertFile rebase conflict (disk vs memory
// disagreeing on resolvedKey) keeps BOTH keys as resolvedKeys candidates, never drops both — the
// pre-fix drop was fail-open on a reboot's key-addressed query even while the real token stayed outstanding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq6b32-i3-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq6b32@loom -c user.name=mq6b32";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Registers every repo it creates for the SAME guaranteed cleanup useOwnLoomHome's own LOOM_HOME uses
// (card 08638e79's beforeExit + sync-exit backstop) — survives a failed run OR a bare process.exit(),
// unlike a hand-rolled try/finally (process.exit() skips a pending finally block entirely).
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq6b32-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-6b327712 item3 (${tag})\n`);
  execSync(`git init -q && git config user.email mq6b32@loom && git config user.name mq6b32`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // T: an unresolvable ghost identity, whose own pending-divert file (sourceFile) names resolvedKey =
  // KEY_OLD on disk. Memory independently holds the SAME identity with resolvedKey = KEY_NEW (a different,
  // defined key) — the shape item 3's own record traces to 5d0820c7's Step B: armForeignOrphanContentInMemoryIfUnenforced
  // calls armQuarantineKey UNCONDITIONALLY for an unresolvable identity's own secondary key, and that
  // call's own LEGACY union (no conflict detection) can overwrite T's own resolvedKey with an OLDER
  // occupant's own, genuinely different, non-self-referential resolvedKey — never touching disk. Built
  // here directly via the documented dual-track test seams (pushPendingQuarantineTestOnly's own doc calls
  // this a genuine 883e29bc shape) rather than re-enacting that full chain; the chain itself is separately
  // confirmed real below (REACHABILITY block), independent of this scenario's own construction.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const T = path.join(os.tmpdir(), `loom-mq6b32-ghost-T-${freshSfx()}`);
  const REPO_OLD = makeRepo("old");
  const REPO_NEW = makeRepo("new");
  const KEY_OLD = canonicalRepoLockKey(REPO_OLD);
  const KEY_NEW = canonicalRepoLockKey(REPO_NEW);
  check("precondition: KEY_OLD !== KEY_NEW", KEY_OLD !== KEY_NEW);

  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  const basename = `mq6b32-i3-${freshSfx()}.json`;
  const sourcePath = path.join(mod.MERGE_QUARANTINE_DIR, basename);
  const t1 = "tok-t1-" + freshSfx();
  const t2 = "tok-t2-" + freshSfx();
  const diskRecord = { repoPath: T, branch: "loom/t-branch", reason: "merge in progress for T (6b327712 item3)", enteredAt: Date.now(), tokens: [t1, t2], resolvedKey: KEY_OLD };
  fs.writeFileSync(sourcePath, JSON.stringify(diskRecord));

  const memRecord = { ...diskRecord, resolvedKey: KEY_NEW };
  mod.pushPendingQuarantineTestOnly(memRecord, basename);
  const idx = mod.findPendingIndexByIdentityTestOnly(T);
  check("precondition: T's pending entry found", idx !== -1);

  // Exercise the reduce branch: clear t1, leaving t2 outstanding — the clearTokenFromPendingIndices ->
  // writePendingDivertFile(..., rebaseOntoRealDiskRecord:true) path.
  mod.clearTokenFromPendingIndicesTestOnly([idx], t1);

  const onDiskAfter = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  check("post: tokens reduced to [t2] only", JSON.stringify(onDiskAfter.tokens) === JSON.stringify([t2]));
  check("*** FIX *** on-disk resolvedKey (scalar) stays undefined on a genuine conflict — UNCHANGED from before this card", onDiskAfter.resolvedKey === undefined);
  check("*** FIX *** on-disk resolvedKeys (plural) now RETAINS both conflicting keys as candidates — RED before this card (both dropped)", Array.isArray(onDiskAfter.resolvedKeys) && new Set(onDiskAfter.resolvedKeys).size === 2 && new Set(onDiskAfter.resolvedKeys).has(KEY_OLD) && new Set(onDiskAfter.resolvedKeys).has(KEY_NEW));

  // Reboot: PASS 1's own secondaryKeysToAttempt/armKeyUnlessDegradedCollision machinery should now
  // arbitrate and arm BOTH candidates (fail-closed), never a third/invented key.
  let bootReimportCounter = 0;
  async function freshBootModule() {
    bootReimportCounter++;
    return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
  }
  const booted = await freshBootModule();
  booted.reenterMergeQuarantinesAtBoot([REPO_OLD, REPO_NEW]);
  const blockedOld = booted.stillBlockedEntryFor(REPO_OLD);
  const blockedNew = booted.stillBlockedEntryFor(REPO_NEW);
  check("*** FIX *** after a reboot, REPO_OLD (KEY_OLD) reads BLOCKED — RED before this card (undefined)", blockedOld !== undefined);
  check("*** FIX *** after a reboot, REPO_NEW (KEY_NEW) reads BLOCKED too — RED before this card (undefined)", blockedNew !== undefined);
  check("GUARD: T's own real token t2 is still the one outstanding on both reads", (blockedOld?.tokens ?? []).includes(t2) && (blockedNew?.tokens ?? []).includes(t2));
  // GUARD (Lead's own ask): no INVENTED key — armedKeys is exactly {KEY_OLD, KEY_NEW}, nothing more.
  const armedSetOld = new Set(blockedOld?.armedKeys ?? []);
  const armedSetNew = new Set(blockedNew?.armedKeys ?? []);
  check("GUARD: no invented key — REPO_OLD's own armedKeys is exactly {KEY_OLD, KEY_NEW}", armedSetOld.size === 2 && armedSetOld.has(KEY_OLD) && armedSetOld.has(KEY_NEW));
  check("GUARD: no invented key — REPO_NEW's own armedKeys is exactly {KEY_OLD, KEY_NEW}", armedSetNew.size === 2 && armedSetNew.has(KEY_OLD) && armedSetNew.has(KEY_NEW));

  const tStillPending = booted.listPendingMergeQuarantinesTestOnly().some((p) => p.repoPath === T);
  check("T's own pending record (by raw identity) still exists after reboot", tStillPending);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // REACHABILITY (not this card's own fix target — confirms the real mechanism the record traces the
  // divergence to, independent of the direct construction above): armQuarantineKey's own LEGACY union
  // (the one armForeignOrphanContentInMemoryIfUnenforced's Step B calls, unconditionally, for an
  // unresolvable identity) really can overwrite T's own resolvedKey with an OCCUPANT's own, different,
  // non-self-referential key — via an in-memory union alone, no disk I/O. T must be OLDER here: with the
  // OCCUPANT older, `unionQuarantineEntries`'s own `{...older}` spread keeps the OCCUPANT's identity, so
  // the result is no longer "same identity T, divergent resolvedKey" at all — T's own identity must
  // survive (via the `{...older}` spread) for 48bda567's self-key correction to then override ITS OWN
  // self-referential resolvedKey with the occupant's genuinely different one.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const byRepoKey = new Map();
    const U = { repoPath: "U-repo", branch: "b", reason: "r", enteredAt: 2000, tokens: ["tU"], resolvedKey: "key-U-points-at", armedKeys: ["key-occupied-by-U"] };
    byRepoKey.set("key-occupied-by-U", U);
    const Tprime = { repoPath: "T-ghost", branch: "b2", reason: "r2", enteredAt: 1000, tokens: ["tT"], resolvedKey: "key-occupied-by-U" };
    const merged = mod.armQuarantineKeyTestOnly(byRepoKey, "key-occupied-by-U", Tprime);
    check("REACHABILITY: T's own identity survives the union (T is older)", merged.repoPath === "T-ghost");
    check("REACHABILITY: armQuarantineKey's legacy union + 48bda567's self-key correction overwrites T's own (self-referential) resolvedKey with U's DIFFERENT, non-self key — the real mechanism this card's own fix guards the rebase against", merged.resolvedKey === "key-U-points-at");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
