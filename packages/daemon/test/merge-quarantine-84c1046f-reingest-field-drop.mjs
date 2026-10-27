import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 84c1046f — reconcileMarkedBasenameBeforeWrite's reingest branch dropped three runtime-folded
// fields (contributorRepoPaths/reducedContributorRepoPaths/orphanLatchFiles); see the decision record for
// the field audit, the scenario walkthroughs, and the canonical-key-hash gotcha.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-84c1046f-reingest-field-drop.mjs
// Solo runtime measured ~0.5s; well under the 60s TEST_TIMEOUT_OVERRIDES threshold.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq84c1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  enterMergeQuarantine, clearMergeQuarantineLatchFile, quarantineLatchFileIdsFor,
  clearMergeQuarantineReporting, clearMergeQuarantine,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const GIT_ID = "-c user.email=mq84c1@loom -c user.name=mq84c1";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// The CANONICAL hash — matches `quarantineHashFor`/`quarantinePathForKey` exactly. See the GOTCHA note above.
function canonicalHashFor(boundPath) {
  const key = canonicalRepoLockKey(boundPath);
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepoWithTwoSubdirs(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq84c1-repo-${tag}-${freshSfx()}`);
  const dSub = path.join(repo, "d-sub");
  const sSub = path.join(repo, "s-sub");
  fs.mkdirSync(dSub, { recursive: true });
  fs.mkdirSync(sSub, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-84c1046f-reingest-field-drop (${tag})\n`);
  execSync(`git init -q && git config user.email mq84c1@loom && git config user.name mq84c1`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, dSub, sSub };
}

function injectPersistentReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let count = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      count++;
      throw Object.assign(new Error(`${code}: simulated persistent read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => count };
}

try {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — contributorRepoPaths + orphanLatchFiles survive the reingest; clear-by-id fails closed.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, dSub, sSub } = makeRepoWithTwoSubdirs("s1");
    const key = canonicalRepoLockKey(sSub);
    check("(s1 precondition) dSub and sSub share one canonical key", canonicalRepoLockKey(dSub) === key);

    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${canonicalHashFor(sSub)}.json`);
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: sSub, branch: "s-branch-genuine", reason: "s-sub's own genuine, durable raise",
      enteredAt: Date.now() - 60_000, tokens: ["s-genuine-token"],
    }, null, 2) + "\n");

    const inject = injectPersistentReadFailure(finalPath);
    reenterMergeQuarantinesAtBoot([sSub]);
    check("(s1 precondition) the latch read was attempted and injected to fail at boot", inject.count() >= 1);

    const afterBootQuery = activeMergeQuarantineFor(sSub);
    check("(s1 precondition) sSub reads as quarantined (placeholder) right after boot", !!afterBootQuery);
    check("(s1 precondition) the graduated entry is genuinely the UNREADABLE placeholder shape", afterBootQuery?.placeholder === true);

    enterMergeQuarantine(dSub, "d-branch-fresh", "dSub's own fresh raise while sSub's latch is unreadable");
    const afterDRaise = activeMergeQuarantineFor(dSub);
    check("(s1 precondition) contributorRepoPaths names dSub right after the raise", (afterDRaise?.contributorRepoPaths ?? []).includes(dSub));
    check("(s1 precondition) the entry is STILL the placeholder shape (never durably reconciled yet)", afterDRaise?.placeholder === true);
    check("(s1 precondition) orphanLatchFiles is non-empty right after the divert (the leftover pending-residue reference)", (afterDRaise?.orphanLatchFiles ?? []).length > 0);
    const orphanBeforeReingest = afterDRaise?.orphanLatchFiles ?? [];

    inject.restore();

    const sToken2 = enterMergeQuarantine(sSub, "s-branch-second", "sSub's own second raise, after the latch became readable again");
    const afterReingest = activeMergeQuarantineFor(sSub);
    check("(s1 sanity) sSub's original genuine token survived the reingest", (afterReingest?.tokens ?? []).includes("s-genuine-token"));
    check("(s1 sanity) sSub's second raise token is present", (afterReingest?.tokens ?? []).includes(sToken2));
    check("(s1 sanity) the entry is no longer the placeholder shape (reingest replaced it)", afterReingest?.placeholder !== true);

    check("*** THE FIX (a) *** contributorRepoPaths SURVIVES the reingest, in memory", (afterReingest?.contributorRepoPaths ?? []).includes(dSub));
    check("*** THE FIX (a) *** orphanLatchFiles SURVIVES the reingest, in memory", orphanBeforeReingest.every((f) => (afterReingest?.orphanLatchFiles ?? []).includes(f)));
    check("*** THE FIX (c) *** provenanceTracked SURVIVES the reingest, in memory", afterReingest?.provenanceTracked === true);

    const onDiskAfterReingest = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    check("*** THE FIX (a) *** contributorRepoPaths SURVIVES the reingest, in the DURABLE on-disk JSON", (onDiskAfterReingest.contributorRepoPaths ?? []).includes(dSub));

    const id = quarantineLatchFileIdsFor(afterReingest)[0];
    check("(s1 precondition) a real latch id resolves for the reconciled entry", typeof id === "string" && id.length > 0);
    const clearByIdResult = clearMergeQuarantineLatchFile(id);
    note(`(s1) clearMergeQuarantineLatchFile(${id}) => ${JSON.stringify(clearByIdResult)}`);
    check("*** THE FIX (b) *** clear-by-id FAILS CLOSED on the ambiguous union (ok:false)", clearByIdResult.ok === false);
    check("*** THE FIX (b) *** the refusal names dSub's own path", clearByIdResult.ok === false && clearByIdResult.reason.includes(dSub));
    check("*** THE FIX (b) *** dSub STAYS quarantined after the refused clear-by-id", !!activeMergeQuarantineFor(dSub));
    check("*** THE FIX (b) *** sSub ALSO stays quarantined (the refusal lifted nothing)", !!activeMergeQuarantineFor(sSub));

    try { clearMergeQuarantineReporting(repo); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — reducedContributorRepoPaths survives the reingest.
  //
  // Isolation note: scenario 1 can leave a stale orphan residue file behind in the SHARED
  // MERGE_QUARANTINE_DIR (its own "keeping orphan latch ... UNTOUCHED (left stale)" fail-closed path,
  // logged above) — a real boot scan would see it too, but within ONE test process it also means
  // scenario 2's own `reenterMergeQuarantinesAtBoot` can pick up scenario 1's leftover file as a
  // STALE-key migration candidate. Wipe the directory AND reimport the module fresh (clean
  // activeQuarantines/pendingUnresolvedQuarantines) before scenario 2 starts, so it never inherits
  // scenario 1's own state either on disk or in memory.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const mod2 = await import(`${mergeQuarantineModuleHref}?scenario2`);
  const {
    reenterMergeQuarantinesAtBoot: reenterMergeQuarantinesAtBoot2, activeMergeQuarantineFor: activeMergeQuarantineFor2,
    enterMergeQuarantine: enterMergeQuarantine2, clearMergeQuarantineReporting: clearMergeQuarantineReporting2,
    clearMergeQuarantine: clearMergeQuarantine2,
  } = mod2;
  {
    const { repo, dSub, sSub } = makeRepoWithTwoSubdirs("s2");
    const key = canonicalRepoLockKey(sSub);
    check("(s2 precondition) dSub and sSub share one canonical key", canonicalRepoLockKey(dSub) === key);

    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${canonicalHashFor(sSub)}.json`);
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: sSub, branch: "s-branch-genuine-2", reason: "s-sub's own genuine, durable raise (scenario 2)",
      enteredAt: Date.now() - 60_000, tokens: ["s-genuine-token-2"],
    }, null, 2) + "\n");

    const inject = injectPersistentReadFailure(finalPath);
    reenterMergeQuarantinesAtBoot2([sSub]);
    activeMergeQuarantineFor2(sSub); // graduate the lone placeholder (still placeholder — unreadable)

    enterMergeQuarantine2(dSub, "d-branch-fresh-2", "dSub's own fresh raise while sSub's latch is unreadable (scenario 2)");
    const afterDRaise = activeMergeQuarantineFor2(dSub);
    check("(s2 precondition) contributorRepoPaths names dSub right after the raise", (afterDRaise?.contributorRepoPaths ?? []).includes(dSub));
    check("(s2 precondition) the entry is STILL the placeholder shape", afterDRaise?.placeholder === true);

    inject.restore();

    // dSub owns no key of its own (it is a bare contributorRepoPaths member) — clearMergeQuarantine(dSub)
    // routes to reduceForeignUnionContributor, which removes dSub from contributorRepoPaths and records
    // it in reducedContributorRepoPaths instead. Its own `ownedKeys` write loop IS the first write to
    // reach the chokepoint since readability returned, and it DOES durably reconcile the physical file
    // (confirmed below, via the on-disk JSON) — and, as of card 4e987303, it now also re-points
    // `activeQuarantines`'s own in-memory slot to match the reconciled object via `writeLatchAndAdopt`
    // (see docs/decisions/4e987303-adopt-the-entry-a-reconciling-write-actually-persisted.md) — the
    // "(s2 precondition)" check below for this is now a POSITIVE assertion, not an unasserted gap.
    // NOTE: reduceForeignUnionContributor stamps `directPathIdentity(repoPath)` into
    // reducedContributorRepoPaths (a NORMALIZED identity, lowercased on win32 — existing, pre-this-card
    // behavior, unrelated to the fix) — contributorRepoPaths instead stores the RAW repoPath string.
    // Compare case-insensitively for this one field so this test is platform-neutral.
    const names = (arr, p) => (arr ?? []).some((x) => x.toLowerCase() === p.toLowerCase());
    const reduceResult = clearMergeQuarantine2(dSub);
    note(`(s2) clearMergeQuarantine(dSub) => ${JSON.stringify(reduceResult)}`);
    check("(s2 sanity) reduceForeignUnionContributor reports wasQuarantined:true", reduceResult.wasQuarantined === true);
    check("(s2 sanity) reduceForeignUnionContributor lifts NOTHING", (reduceResult.liftedRepoPaths ?? []).length === 0);
    check("(s2 precondition) reducedContributorRepoPaths is set in memory right after the reduce", names(activeMergeQuarantineFor2(sSub)?.reducedContributorRepoPaths, dSub));
    // UPDATED (card 4e987303 — this note's own prior claim is now FALSE, corrected here rather than left
    // stale per that card's own "relabel/update 84c1046f's '(s2 precondition)' note" DoD item): the
    // in-memory activeQuarantines entry no longer stays the pre-reconcile placeholder — reduceForeignUnionContributor
    // now routes its write through writeLatchAndAdopt, which re-points memory to whatever the reconcile
    // actually persisted. See docs/decisions/4e987303-adopt-the-entry-a-reconciling-write-actually-persisted.md.
    check("(s2) *** 4e987303 *** the in-memory entry is NO LONGER the pre-reconcile placeholder — it matches disk", activeMergeQuarantineFor2(sSub)?.placeholder !== true && (activeMergeQuarantineFor2(sSub)?.tokens ?? []).includes("s-genuine-token-2"));

    // Read the DURABLE on-disk JSON directly too — still the authoritative proof the reingest branch ran
    // durably (memory now matches it, per the check just above, but disk is the ground truth either way).
    const onDiskAfterReduce = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    check("(s2 sanity) the on-disk JSON carries sSub's own genuine token (reingest ran durably)", (onDiskAfterReduce.tokens ?? []).includes("s-genuine-token-2"));
    check("(s2 sanity) the on-disk JSON is no longer the placeholder shape (reingest replaced it)", !onDiskAfterReduce.branch?.includes("UNREADABLE"));
    check("(s2 sanity) the on-disk JSON's contributorRepoPaths is correctly EMPTY (dSub was reduced out, disk never had it either)", (onDiskAfterReduce.contributorRepoPaths ?? []).length === 0);

    check("*** THE FIX *** reducedContributorRepoPaths SURVIVES the reingest, in the DURABLE on-disk JSON", names(onDiskAfterReduce.reducedContributorRepoPaths, dSub));
    // NOTE: a provenanceTracked check against THIS on-disk JSON would be vacuous — writeMergeQuarantineLatch
    // unconditionally re-stamps provenanceTracked:true on every successful write regardless of this card's
    // own fix, so it can never go RED here. Scenario 1's in-memory check above is the meaningful one.

    check("(s2 postcondition) sSub stays quarantined", !!activeMergeQuarantineFor2(sSub));
    check("(s2 postcondition) dSub ALSO stays quarantined (its own token is still physically outstanding inside the union)", !!activeMergeQuarantineFor2(dSub));

    try { clearMergeQuarantineReporting2(repo); } catch { /* best-effort cleanup */ }
  }

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — card 84c1046f's own fix (carry orphanLatchFiles/contributorRepoPaths/reducedContributorRepoPaths/provenanceTracked forward from both sides in the reingest branch) holds."
    : `\n❌ ${failures} CHECK(S) FAILED.`);
} finally {
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

process.exit(failures === 0 ? 0 : 1);
