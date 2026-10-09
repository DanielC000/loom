import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card d4b25feb (from the round-2 Code Review of 883e29bc, reviewer 16eda3b3) — PRE-EXISTING,
// merge-quarantine fail-open, the RUNTIME (enterMergeQuarantine) twin of 883e29bc's own BOOT-TIME union
// fix. 883e29bc stopped reenterMergeQuarantinesAtBoot's PASS 1/1b from arming a degraded, walked-up key
// directly — but `enterMergeQuarantine` itself had THREE separate, un-fixed sites reaching the identical
// shape at runtime:
//
// (A) RAISE-SIDE APPEND — the "existing" branch unconditionally merged a fresh raise's token into
//     whatever entry ALREADY occupies the raised repoPath's own (possibly degraded, walked-up) `key`,
//     with no check that the RAISING repoPath is itself verified for that key. A raise on an unmounted
//     nested repo X (its own canonicalRepoLockKey walks up to its enclosing repo R's key) silently
//     merged into R's own genuine, unrelated sibling T's entry — and a later human clear(T) lifted X's
//     still-unconfirmed raise too.
// (B) FRESH-BRANCH DEGRADED ARM — the "brand new entry" branch recorded `resolvedKey: key` and armed
//     directly into `activeQuarantines` at `key` even when `key` is a degraded, walked-up value that was
//     NEVER verified to be the raised repoPath's own identity — the exact shape 883e29bc fixed for PASS
//     1/1b's own boot-time union, reachable here through a wholly different, un-fixed call site.
// (C) PENDING-MERGE BRANCH — the SAME defect as (B), reached when the raising repoPath ALREADY has a
//     pending (never-yet-resolved) latch of its own: `consumeMatchedPendingsIntoArmedEntry` arms+writes
//     at the degraded `key` unconditionally, regardless of whether the raiser is verified for it.
//
// THE FIX: `enterMergeQuarantine` now computes `verified = isRepoPathCurrentlyResolvable(repoPath)` ONCE
// and gates every `activeQuarantines`-at-`key` touch on it — the "existing" lookup, the pending-merge
// arm, and the brand-new arm. When `!verified`, the raise is instead diverted into
// `pendingUnresolvedQuarantines` (mirroring 883e29bc's own divert) under a NEW, disjoint on-disk filename
// format (`pending-<24hex>.json`, never a canonical/legacy key hash) — reusing the EXISTING pending-entry
// machinery end to end (boot's own content-based classification needs zero changes; graduation and
// clear-by-path are already filename-agnostic). See docs/decisions/d4b25feb-*.md for the full design.
//
// Side effect, verified and documented in merge-quarantine-degraded-occupant-guard.mjs: this fix ALSO
// closes that file's own `pending-merge-fresh-raise-survives-reboot` scenario's "documented residual"
// (an UNVERIFIED raiser merging into its own pending latch no longer overwrites a degraded occupant's
// physical file) — while `fresh-raise-survives-reboot`'s own residual (a VERIFIED raiser, tracked
// separately on card 2a6a8073) is fully unaffected, still open.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver:
// run with no args to spawn one child per scenario; a child reads `--scenario=<name>` off argv and runs
// only that one scenario inline, exiting non-zero on any failure within it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-unverified-raise-divert.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "raise-into-sibling-key-diverts",
  "fresh-degraded-arm-diverts",
  "second-unverified-raise-merges-in-place",
  "pending-divert-graduates-on-remount",
  "clear-by-id-roundtrips-pending-divert",
  "clear-by-path-lifts-pending-divert",
  "negative-control-verified-raise-unchanged",
  "clear-by-token-never-lifts-separate-active-entry-newer-first",
  "clear-by-token-never-lifts-separate-active-entry-older-first",
  "clear-by-token-finds-pending-despite-sibling-occupying-key",
  "clear-by-id-roundtrips-crash-left-pending-tmp",
  "clear-by-recorded-path-lifts-whole-identity",
  "partial-clear-syncs-armed-twin-across-reboot-and-remount",
  "identity-invariant-accepts-two-legitimate-rejects-overlap",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — one child per scenario, own fresh LOOM_HOME each (never shared across scenarios).
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], { env: envWithoutLoomHome, stdio: "inherit" });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\n✅ ALL SCENARIOS PASS — enterMergeQuarantine never appends an unverified raise into another "
      + "repo's entry, never arms a degraded walked-up key directly (brand-new OR pending-merge branch), "
      + "and a diverted raise is durable, independently queryable/clearable, and converges cleanly once "
      + "its own path resolves — all via the existing pending-entry machinery, under one new, disjoint "
      + "on-disk filename format."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card d4b25feb.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqurd-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantineReporting,
  clearMergeQuarantine, clearMergeQuarantineByRecordedPath, quarantineLatchFileIdsFor,
  clearMergeQuarantineLatchFile, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, clearMergeQuarantineByToken,
  assertRepoNotQuarantined, assertQuarantineIdentityInvariantTestOnly,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqurd@loom -c user.name=mqurd";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** R (enclosing repo) with X = R/nested (its OWN SEPARATE repo, own `.git`) and T = R/teamA (a plain
 *  subdir, no `.git` of its own — collapses onto R's own canonical key). Same shape as 883e29bc's own
 *  fixture (merge-quarantine-pass1-degraded-union-guard.mjs). */
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqurd-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "nested");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-unverified-raise-divert (${tag})\n`);
  execSync(`git init -q && git config user.email mqurd@loom && git config user.name mqurd`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqurd@loom && git config user.name mqurd`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested own repo (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "raise-into-sibling-key-diverts") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // DEFECT A — T (verified) raises first, armed cleanly at R's key. X (its own separate repo) then
    // becomes unmounted and raises SECOND — its degraded, walked-up key lands on the SAME key T already
    // occupies. Pre-fix: X's token silently merges into T's own entry (`existing` branch), and a human
    // clear(T) lifts X's still-unconfirmed raise too. Post-fix: X diverts to its own pending entry; T's
    // entry never sees X's token; clearing T never touches X.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("a");
    const Kr = canonicalRepoLockKey(repo);
    const Kx = canonicalRepoLockKey(nested);

    const tokT = enterMergeQuarantine(subdir, "t-branch", "T's own genuine, founding raise");
    const afterT = activeMergeQuarantineFor(repo);
    check("(precondition) T's raise lands at R's key with only its own token", !!afterT && afterT.repoPath === subdir && (afterT.tokens ?? []).includes(tokT));

    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-a-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is genuinely unresolvable now", !fs.existsSync(nested));
    check("(precondition) X's degraded key walks up to R's key (≠ X's own true key)", canonicalRepoLockKey(nested) === Kr && Kr !== Kx);

    const tokX = enterMergeQuarantine(nested, "x-branch", "X's own raise while unmounted");
    const afterX = activeMergeQuarantineFor(repo);
    check("*** THE FIX *** T's entry is NOT merged with X's unverified raise", !!afterX && afterX.repoPath === subdir && !(afterX.tokens ?? []).includes(tokX));
    // NOTE: activeMergeQuarantineFor(nested) still returns T's entry here, NOT X's own — its own "direct"
    // fast path returns T immediately whenever T's own entry is BOTH present AND key-verified at the exact
    // same key, before ever consulting the identity-based pending tiers (pre-existing design, same
    // query/identity-model gap decision a2f381dc/398f476c already document as accepted/out of scope — see
    // 883e29bc's own "residual property 2"). X's token is NOT lost, though — it survives in the full
    // listing, and (checked below) a query made AFTER T is cleared correctly finds X directly.
    check("*** THE FIX *** X's raise survives, listed separately from T's entry", listActiveMergeQuarantines().some((e) => e.repoPath === nested && (e.tokens ?? []).includes(tokX)));

    const clearResult = clearMergeQuarantineReporting(subdir); // a human clearing T by its own path
    check("(precondition) the human clear of T reports success", clearResult.wasQuarantined === true);
    check("*** THE FIX *** a human /clear(T) does NOT also lift X's still-outstanding raise", !!activeMergeQuarantineFor(nested) && (activeMergeQuarantineFor(nested)?.tokens ?? []).includes(tokX));
    check("*** THE FIX *** T reads clear after its own clear", !activeMergeQuarantineFor(repo));

    // DURABILITY — 3 boots, X still parked throughout.
    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
      const xAfterBoot = boot.activeMergeQuarantineFor(nested);
      check(`(boot ${i + 1}) X's raise SURVIVES, with only its own token`, !!xAfterBoot && (xAfterBoot.tokens ?? []).length === 1 && xAfterBoot.tokens.includes(tokX));
      check(`(boot ${i + 1}) R is NOT falsely reported quarantined (T cleared, X has no resolvedKey to walk up with)`, !boot.activeMergeQuarantineFor(repo));
    }
    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "fresh-degraded-arm-diverts") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // DEFECT B — X (unmounted from the start, no existing entry, no pending match) raises FIRST. Pre-fix:
    // the "brand new entry" branch arms X directly at R's degraded, walked-up key (resolvedKey: Kr),
    // the exact shape 883e29bc fixed for PASS1/1b. Post-fix: X diverts to pending; R does NOT read
    // quarantined via X (consistent with the existing "never-yet-resolved, no-resolvedKey latch never
    // blocks an ancestor" rule, abccee85/round7); T can later raise at R's key uncontaminated.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("b");
    const Kr = canonicalRepoLockKey(repo);

    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-b-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is genuinely unresolvable", !fs.existsSync(nested));
    check("(precondition) no existing entry at Kr yet", !activeMergeQuarantineFor(repo));

    const tokX = enterMergeQuarantine(nested, "x-branch", "X's own FIRST raise, already unmounted");
    check("*** THE FIX *** R does NOT read quarantined via X's degraded raise", !activeMergeQuarantineFor(repo));
    const xOwnEntry = activeMergeQuarantineFor(nested);
    check("*** THE FIX *** X is independently queryable via its OWN identity", !!xOwnEntry && (xOwnEntry.tokens ?? []).includes(tokX));
    check("(disk) a NEW pending-divert file was written, never a canonical/legacy key hash", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => /^pending-[0-9a-f]{24}\.json$/.test(f)));

    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
      check(`(boot ${i + 1}) X's raise SURVIVES`, !!boot.activeMergeQuarantineFor(nested) && (boot.activeMergeQuarantineFor(nested)?.tokens ?? []).includes(tokX));
      check(`(boot ${i + 1}) R still does NOT read quarantined via X`, !boot.activeMergeQuarantineFor(repo));
    }

    // T raises AFTER X's degraded divert — must arm cleanly, uncontaminated (the compound shape: defect
    // B left unfixed would let this raise walk into the buggy "existing" branch and merge into X's entry).
    const tokT = enterMergeQuarantine(subdir, "t-branch", "T's own genuine raise, arriving after X's divert");
    const afterT = activeMergeQuarantineFor(repo);
    check("*** COMPOUND FIX *** T's raise arms cleanly, uncontaminated by X's prior divert", !!afterT && afterT.repoPath === subdir && (afterT.tokens ?? []).length === 1 && afterT.tokens.includes(tokT));

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "second-unverified-raise-merges-in-place") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // DEFECT C (the pending-merge branch gap) — X raises TWICE while STILL unresolvable both times. The
    // second raise must merge into X's OWN already-diverted pending entry (never mint a second one, never
    // arm at the degraded key) — proving `mergeTokenIntoPendingEntries`, not just the brand-new-entry
    // divert `fresh-degraded-arm-diverts` already covers.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("c");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-c-${freshSfx()}`);
    fs.renameSync(nested, parkedX);

    const tok1 = enterMergeQuarantine(nested, "x-branch", "X's own first raise, unmounted");
    const filesAfterFirst = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));
    check("(precondition) exactly ONE pending-divert file after the first raise", filesAfterFirst.length === 1);

    const tok2 = enterMergeQuarantine(nested, "x-branch", "X's own second raise, STILL unmounted");
    const filesAfterSecond = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));
    check("*** THE FIX *** STILL exactly ONE pending-divert file (no duplicate minted)", filesAfterSecond.length === 1 && filesAfterSecond[0] === filesAfterFirst[0]);
    check("(disk) the SAME file is deterministically reused (same hash both times)", filesAfterFirst[0] === filesAfterSecond[0]);

    const xEntry = activeMergeQuarantineFor(nested);
    check("*** THE FIX *** both tokens are unioned into ONE entry", !!xEntry && (xEntry.tokens ?? []).includes(tok1) && (xEntry.tokens ?? []).includes(tok2) && xEntry.tokens.length === 2);
    check("(sanity) R still does not read quarantined via X", !activeMergeQuarantineFor(repo));
    check("(precondition) only ONE entry total represents X (no stray duplicate in the full listing)", listActiveMergeQuarantines().filter((e) => e.repoPath === nested).length === 1);

    const boot = await freshBootModule();
    boot.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    const xAfterBoot = boot.activeMergeQuarantineFor(nested);
    check("(boot) BOTH tokens survive a reboot, still ONE entry", !!xAfterBoot && xAfterBoot.tokens.includes(tok1) && xAfterBoot.tokens.includes(tok2) && xAfterBoot.tokens.length === 2);

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "pending-divert-graduates-on-remount") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CONVERGENCE — a pending-divert entry is not a permanent second-class citizen: once X genuinely
    // remounts, the next query graduates it to its own TRUE canonical key, durably, and cleans up the
    // pending-divert file (never leaves it accumulating).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("d");
    const Kx = canonicalRepoLockKey(nested);
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-d-${freshSfx()}`);
    fs.renameSync(nested, parkedX);

    const tokX = enterMergeQuarantine(nested, "x-branch", "X's own raise while unmounted");
    const pendingFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));
    check("(precondition) a pending-divert file exists", !!pendingFile && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingFile)));

    fs.renameSync(parkedX, nested); // REMOUNT X
    check("(precondition) X is genuinely resolvable again", fs.existsSync(nested));

    const xEntry = activeMergeQuarantineFor(nested); // THE QUERY UNDER TEST — triggers lazy graduation
    check("*** CONVERGENCE *** X is still active, carrying its own token, now under its TRUE key", !!xEntry && (xEntry.tokens ?? []).includes(tokX) && xEntry.resolvedKey === Kx);
    check("*** CONVERGENCE *** the pending-divert file is CLEANED UP (not left accumulating)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingFile)));
    const canonicalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kx).digest("hex").slice(0, 24)}.json`);
    check("*** CONVERGENCE *** X is promoted to a proper final under its OWN true key", fs.existsSync(canonicalPath));

    const boot = await freshBootModule();
    boot.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    const xAfterBoot = boot.activeMergeQuarantineFor(nested);
    check("(boot) X's now-graduated quarantine survives a reboot via its real key", !!xAfterBoot && (xAfterBoot.tokens ?? []).includes(tokX));
  } else if (scenarioName === "clear-by-id-roundtrips-pending-divert") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // quarantineLatchFileIdsFor hands out a 24-hex id for a pending-divert entry (via pendingLatchIdFor's
    // new PENDING_DIVERT_RE branch — hash of the FULL basename, mirroring the pre-existing SAFETY_TMP_RE
    // branch) that clearMergeQuarantineLatchFile can actually resolve back — the id-based clear route must
    // round-trip for this new namespace exactly like it already does for every other pending shape.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("e");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-e-${freshSfx()}`);
    fs.renameSync(nested, parkedX);

    const tokX = enterMergeQuarantine(nested, "x-branch", "X's own raise while unmounted");
    const xEntry = activeMergeQuarantineFor(nested);
    const ids = quarantineLatchFileIdsFor(xEntry);
    check("(precondition) exactly one id, 24-hex", ids.length === 1 && /^[0-9a-f]{24}$/.test(ids[0]));
    const pendingFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));
    check("(precondition) the id is NOT simply the pending-divert file's own hash fragment (full-basename hash, not a substring)", !pendingFile.includes(ids[0]));

    const clearResult = clearMergeQuarantineLatchFile(ids[0]);
    check("*** THE FIX *** clear-by-id resolves and clears the pending-divert entry", clearResult.ok === true && clearResult.wasQuarantined === true && clearResult.liftedRepoPaths.includes(nested));
    check("*** THE FIX *** the pending-divert file is removed from disk", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingFile)));
    check("(sanity) X reads clear now", !activeMergeQuarantineFor(nested));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "clear-by-path-lifts-pending-divert") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // clearMergeQuarantine/clearMergeQuarantineByRecordedPath (the ordinary /clear-by-path route) must
    // also lift a pending-divert entry by X's OWN (unresolvable) repoPath — purely identity-based
    // matching, unaffected by the new filename format.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("f");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-f-${freshSfx()}`);
    fs.renameSync(nested, parkedX);

    enterMergeQuarantine(nested, "x-branch", "X's own raise while unmounted");
    check("(precondition) X reads quarantined via its own identity", !!activeMergeQuarantineFor(nested));
    const pendingFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));

    const result = clearMergeQuarantineByRecordedPath(nested); // X is unresolvable, so clearMergeQuarantine delegates here
    check("*** THE FIX *** clear-by-recorded-path lifts X's own pending-divert entry", result.wasQuarantined === true);
    check("*** THE FIX *** the pending-divert file is removed from disk", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, pendingFile)));
    check("(sanity) X reads clear now", !activeMergeQuarantineFor(nested));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "negative-control-verified-raise-unchanged") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // NEGATIVE CONTROL — the ORDINARY case (both raises genuinely resolvable, no degraded anything) must
    // behave EXACTLY as before this card: a second raise on the SAME repo still merges into the first
    // via the "existing" branch, and a brand-new raise still arms directly at its own real key. This
    // control is satisfied VACUOUSLY if `verified` is somehow always true — proven not to be the case by
    // every scenario above, each of which hits the opposite (`!verified`) branch instead.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqurd-repo-ctrl-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# ctrl\n");
    execSync(`git init -q && git config user.email mqurd@loom && git config user.name mqurd`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(repo);

    const tok1 = enterMergeQuarantine(repo, "r-branch", "first, brand-new raise");
    const entry1 = activeMergeQuarantineFor(repo);
    check("(brand-new, verified) arms directly at the repo's own real key with only its own token", !!entry1 && entry1.resolvedKey === Kr && entry1.tokens.length === 1 && entry1.tokens.includes(tok1));

    const tok2 = enterMergeQuarantine(repo, "r-branch", "second raise on the SAME repo — must merge into the existing entry");
    const entry2 = activeMergeQuarantineFor(repo);
    check("(existing, verified) the second raise merges into the SAME entry, both tokens present", !!entry2 && entry2.tokens.includes(tok1) && entry2.tokens.includes(tok2) && entry2.tokens.length === 2);
    check("(disk) no pending-divert file was ever created for this fully-verified path", !fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => /^pending-[0-9a-f]{24}\.json$/.test(f)));
  } else if (scenarioName === "clear-by-token-never-lifts-separate-active-entry-newer-first") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review beea936c, round 2, CRITICAL — X (R's own NESTED repo) raises ONCE while resolvable (t1,
    // armed at its own true key Kx), then AGAIN after becoming unresolvable (t2, diverted to pending) —
    // the SAME identity now carries TWO wholly SEPARATE, independent entries. Pre-fix,
    // clearMergeQuarantineByToken(X, t2)'s last-token branch delegated to clearMergeQuarantineByRecordedPath
    // — an IDENTITY-WIDE clear that also found and destroyed t1's own, still-outstanding active entry.
    // THIS order: clear the NEWER (pending) token first; the OLDER (active) one must survive, in memory
    // and across ≥3 reboots. Round 3 (Code Review 543456ed): redone with NESTED X (X's own degraded key
    // walks up to R's, matching the real production shape) — entirely through clearMergeQuarantineByToken,
    // the ONLY route a real caller (git/worktrees.ts, git/batch-merge.ts, git/writer.ts, versioner.ts) uses.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("tok-newer");
    const Kx = canonicalRepoLockKey(nested);

    const t1 = enterMergeQuarantine(nested, "x-branch", "t1 — raised while X is still resolvable");
    check("(precondition) t1 arms directly at X's own true key", activeMergeQuarantineFor(nested)?.resolvedKey === Kx && (activeMergeQuarantineFor(nested)?.tokens ?? []).includes(t1));

    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const t2 = enterMergeQuarantine(nested, "x-branch", "t2 — raised AFTER X became unresolvable");
    check("(precondition) TWO separate entries now share X's identity", listActiveMergeQuarantines().filter((e) => e.repoPath === nested).length === 2);

    clearMergeQuarantineByToken(nested, t2); // THE CALL UNDER TEST — clears the NEWER (pending) token

    const afterClear = listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
    check("*** THE FIX *** t2's pending entry is gone", !afterClear.some((e) => (e.tokens ?? []).includes(t2)));
    check("*** THE FIX *** t1's SEPARATE active entry SURVIVES, untouched", afterClear.length === 1 && (afterClear[0].tokens ?? []).includes(t1));

    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, parkedX]);
      const stillActive = boot.listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
      check(`(boot ${i + 1}) t1 survives, t2 never resurrects`, stillActive.length === 1 && (stillActive[0].tokens ?? []).includes(t1) && !(stillActive[0].tokens ?? []).includes(t2));
    }
    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "clear-by-token-never-lifts-separate-active-entry-older-first") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE REVERSE ORDER — same two-separate-entries, NESTED-X setup, but clear the OLDER (active) one
    // FIRST. Round 3 (Code Review 543456ed, MINOR): redone through clearMergeQuarantineByToken(nested, t1)
    // instead of calling clearMergeQuarantineByKey directly — no production caller ever does that; the
    // real path is clearMergeQuarantineByToken's own round-3 identity-scan fallback finding t1's active
    // entry at its historical true key Kx (never reachable via the degraded key Kr alone). The NEWER
    // (pending) entry must survive this just as symmetrically as the other order above.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("tok-older");
    const Kx = canonicalRepoLockKey(nested);

    const t1 = enterMergeQuarantine(nested, "x-branch", "t1 — raised while X is still resolvable");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-rev-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const t2 = enterMergeQuarantine(nested, "x-branch", "t2 — raised AFTER X became unresolvable");
    check("(precondition) TWO separate entries now share X's identity", listActiveMergeQuarantines().filter((e) => e.repoPath === nested).length === 2);
    check("(precondition) X's own degraded key (Kr) differs from its true key (Kx)", canonicalRepoLockKey(nested) !== Kx);

    clearMergeQuarantineByToken(nested, t1); // THE CALL UNDER TEST — via the ONLY route a real caller uses

    const afterClear = listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
    check("*** THE FIX *** t1's active entry is gone", !afterClear.some((e) => (e.tokens ?? []).includes(t1)));
    check("*** THE FIX *** t2's SEPARATE pending entry SURVIVES, untouched", afterClear.length === 1 && (afterClear[0].tokens ?? []).includes(t2));

    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, parkedX]);
      const stillActive = boot.listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
      check(`(boot ${i + 1}) t2 survives, t1 never resurrects`, stillActive.length === 1 && (stillActive[0].tokens ?? []).includes(t2) && !(stillActive[0].tokens ?? []).includes(t1));
    }
    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "clear-by-token-finds-pending-despite-sibling-occupying-key") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review beea936c, round 2, MAJOR — T (verified, a plain subdir of R) is genuinely armed at R's
    // key Kr. X (R's own separate nested repo) becomes unresolvable and raises — diverts to pending (this
    // card's own fix). clearMergeQuarantineByToken(X, tokX) computes `key = canonicalRepoLockKey(X)` = Kr
    // (degraded) — `current = activeQuarantines.get(Kr)` = T's entry, which genuinely does NOT include
    // tokX. Pre-fix, the function returned here without ever trying the pending store, so X's own
    // in-process auto-clear silently never fires. Post-fix, it falls back to clearPendingEntryByToken.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("tok");

    const tokT = enterMergeQuarantine(subdir, "t-branch", "T's own genuine, founding raise");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-tok-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const tokX = enterMergeQuarantine(nested, "x-branch", "X's own raise while unmounted");
    check("(precondition) T is armed, X is diverted to pending, both sharing R's key by coincidence", !!activeMergeQuarantineFor(repo) && listActiveMergeQuarantines().some((e) => e.repoPath === nested && (e.tokens ?? []).includes(tokX)));

    clearMergeQuarantineByToken(nested, tokX); // THE CALL UNDER TEST

    check("*** THE FIX *** X's own pending entry is gone", !listActiveMergeQuarantines().some((e) => e.repoPath === nested));
    const tEntryAfter = activeMergeQuarantineFor(repo);
    check("*** THE FIX *** T's entry is COMPLETELY UNTOUCHED — only its own token, nothing lifted", !!tEntryAfter && tEntryAfter.repoPath === subdir && (tEntryAfter.tokens ?? []).length === 1 && tEntryAfter.tokens.includes(tokT));

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "clear-by-id-roundtrips-crash-left-pending-tmp") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review beea936c, round 2, MINOR — a crash between writePendingDivertFile's own fsync/close and
    // its rename leaves a `pending-<24hex>.json.tmp-<pid>-<hex>` residue. PASS 1b's own pre-existing,
    // content-based "no resolvedKey, unresolvable" branch already recovers it into a proper pending entry
    // with ZERO code changes — this scenario proves that, AND that clear-by-id round-trips for this shape
    // too (pendingLatchIdFor's own new PENDING_DIVERT_TMP_RE branch).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const x = path.join(os.tmpdir(), `loom-mqurd-x-crashtmp-${freshSfx()}`);
    fs.mkdirSync(x, { recursive: true });
    tmpDirs.push(x);
    fs.writeFileSync(path.join(x, "README.md"), "# x-crashtmp\n");
    execSync(`git init -q && git config user.email mqurd@loom && git config user.name mqurd`, { cwd: x });
    commitAll(x, "init", GIT_ID);

    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-crashtmp-${freshSfx()}`);
    fs.renameSync(x, parkedX);
    const tokX = enterMergeQuarantine(x, "x-branch", "X's own raise while unmounted");
    const finalFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => /^pending-[0-9a-f]{24}\.json$/.test(f));
    check("(precondition) the clean pending-divert final exists", !!finalFile);

    // Simulate the crash: the SAME bytes, but under a torn-write tmp name instead of the clean final.
    const tmpFile = `${finalFile}.tmp-999-deadbeef`;
    fs.renameSync(path.join(MERGE_QUARANTINE_DIR, finalFile), path.join(MERGE_QUARANTINE_DIR, tmpFile));
    check("(precondition) only the tmp residue exists now, no clean final", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, finalFile)) && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, tmpFile)));

    const boot = await freshBootModule();
    boot.reenterMergeQuarantinesAtBoot([parkedX]);
    const recovered = boot.activeMergeQuarantineFor(x);
    check("*** ZERO BOOT CHANGES NEEDED *** PASS 1b recovers the crash-left tmp into a proper pending entry", !!recovered && (recovered.tokens ?? []).includes(tokX));

    const ids = boot.quarantineLatchFileIdsFor(recovered);
    check("(precondition) exactly one id, 24-hex", ids.length === 1 && /^[0-9a-f]{24}$/.test(ids[0]));
    const clearResult = boot.clearMergeQuarantineLatchFile(ids[0]);
    check("*** THE FIX *** clear-by-id resolves and clears the crash-left pending-divert tmp", clearResult.ok === true && clearResult.wasQuarantined === true && clearResult.liftedRepoPaths.includes(x));
    check("*** THE FIX *** the tmp residue is removed from disk", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, tmpFile)));

    fs.renameSync(parkedX, x); // restore for cleanup
  } else if (scenarioName === "clear-by-recorded-path-lifts-whole-identity") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review 543456ed, round 3, MAJOR — clearMergeQuarantineByRecordedPath (the identity-wide, human
    // clear-by-path route — exactly what the refusal text `assertRepoNotQuarantined` hands a human points
    // at) used to return success right after clearing the ACTIVE matches, BEFORE ever reaching its own
    // pending branch. Once clearMergeQuarantineByKey's own round-2 fix correctly narrowed to never touch
    // an INDEPENDENT pending entry, this function's own early return left that independent pending entry
    // (X's own later, unverified raise) completely unaddressed — a human's /clear-by-path(X) reported
    // success while X stayed quarantined. Fix: this function now ALWAYS also sweeps every remaining
    // same-identity pending entry, never only when no active match was found.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("recpath");
    const t1 = enterMergeQuarantine(nested, "x-branch", "t1 — raised while X is still resolvable");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-recpath-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    const t2 = enterMergeQuarantine(nested, "x-branch", "t2 — raised AFTER X became unresolvable");
    check("(precondition) TWO separate entries share X's identity before the clear", listActiveMergeQuarantines().filter((e) => e.repoPath === nested).length === 2);
    check("(precondition) X reads quarantined", assertRepoNotQuarantined(nested).ok === false);

    const result = clearMergeQuarantineByRecordedPath(nested); // THE CALL UNDER TEST — the human/broad route
    check("(precondition) the clear reports success", result.wasQuarantined === true);
    check("*** THE FIX *** assertRepoNotQuarantined(X) now PASSES — both t1 AND t2 are gone", assertRepoNotQuarantined(nested).ok === true);
    check("*** THE FIX *** no entry at all remains for X's identity", !listActiveMergeQuarantines().some((e) => e.repoPath === nested));

    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, parkedX]);
      check(`(boot ${i + 1}) X stays genuinely clear`, boot.assertRepoNotQuarantined(nested).ok === true);
    }
    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "partial-clear-syncs-armed-twin-across-reboot-and-remount") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review 543456ed, round 3, MINOR — an 883e29bc boot-diverted TWIN (X's own degraded, walked-up
    // key differs from its recorded, TRUSTED resolvedKey Kx — PASS 1 arms the SAME object at BOTH
    // activeQuarantines.get(Kx) AND pendingUnresolvedQuarantines, by reference). A partial clear (not the
    // last token) that updates only ONE side's reference leaves the OTHER holding the stale, pre-clear
    // object — a later query/reboot can then union the just-cleared token back in. Verified empirically
    // BEFORE this fix: the in-memory listing showed TWO non-reference-equal objects for one identity after
    // a single clearMergeQuarantineByToken call, one correctly updated, one stale with both tokens.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("twinsync");
    const Kx = canonicalRepoLockKey(nested);
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-twinsync-${freshSfx()}`);
    fs.renameSync(nested, parkedX);

    // Manufacture X's own latch DIRECTLY at hash(Kx).json — an 883e29bc-shape degraded-but-trusted-resolvedKey
    // entry (currentKey, the degraded walked-up value, differs from resolvedKey=Kx; PASS 1 arms at Kx AND
    // diverts the degraded signal to pending, pushing the SAME object reference into both).
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const hashKx = createHash("sha256").update(Kx).digest("hex").slice(0, 24);
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashKx}.json`);
    const tokA = "tokA-" + freshSfx(), tokB = "tokB-" + freshSfx();
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own divert-eligible raise",
      enteredAt: Date.now(), tokens: [tokA, tokB], resolvedKey: Kx,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, parkedX]);
    check("(precondition) exactly ONE object represents X, carrying BOTH tokens", listActiveMergeQuarantines().filter((e) => e.repoPath === nested).length === 1);

    clearMergeQuarantineByToken(nested, tokA); // THE CALL UNDER TEST — a PARTIAL clear (tokB stays outstanding)

    const afterClear = listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
    check("*** THE FIX *** STILL exactly ONE object (no stale duplicate)", afterClear.length === 1);
    check("*** THE FIX *** that one object carries ONLY tokB", afterClear.length === 1 && afterClear[0].tokens.length === 1 && afterClear[0].tokens.includes(tokB));
    check("*** THE FIX *** the physical file at Kx is ALSO durably updated to only tokB", JSON.parse(fs.readFileSync(xFile, "utf8")).tokens.join(",") === tokB);

    for (let i = 0; i < 3; i++) {
      const boot = await freshBootModule();
      boot.reenterMergeQuarantinesAtBoot([repo, parkedX]);
      const stillThere = boot.listActiveMergeQuarantines().filter((e) => e.repoPath === nested);
      check(`(boot ${i + 1}, still parked) exactly one object, only tokB — tokA never resurrects`, stillThere.length === 1 && stillThere[0].tokens.length === 1 && stillThere[0].tokens.includes(tokB));
    }

    fs.renameSync(parkedX, nested); // REMOUNT X
    const bootAfterRemount = await freshBootModule();
    bootAfterRemount.reenterMergeQuarantinesAtBoot([repo, nested]);
    const afterRemount = bootAfterRemount.activeMergeQuarantineFor(nested);
    check("*** THE FIX (remount) *** X's own direct query, now resolvable, STILL shows only tokB — graduation never unions tokA back", !!afterRemount && afterRemount.tokens.length === 1 && afterRemount.tokens.includes(tokB));
  } else if (scenarioName === "identity-invariant-accepts-two-legitimate-rejects-overlap") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review 543456ed, round 3, MINOR — assertQuarantineIdentityInvariantTestOnly's own invariant
    // updated: "at most one object per identity" is too strict now that one identity can legitimately own
    // TWO independent objects (one active, one pending, disjoint tokens). It must still reject anything
    // else sharing an identity: 3+ objects, or 2 objects whose tokens OVERLAP (the exact staleness this
    // card's round-3 fix above eliminates — if it ever regressed, this invariant must catch it).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("invariant");
    enterMergeQuarantine(nested, "x-branch", "t1 — raised while X is still resolvable");
    const parkedX = path.join(os.tmpdir(), `loom-mqurd-parked-invariant-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    enterMergeQuarantine(nested, "x-branch", "t2 — raised AFTER X became unresolvable");

    const legit = assertQuarantineIdentityInvariantTestOnly();
    check("*** THE FIX *** the legitimate 'one active + one independent pending, disjoint tokens' shape is ACCEPTED", legit.ok === true && legit.violations.length === 0);

    // Manufacture an OVERLAP by hand — two distinct pending-divert files for the SAME identity sharing one
    // token (the exact staleness shape this card's round-3 fix eliminates; the invariant must still catch
    // it if some future change ever reintroduces it).
    const overlapToken = "overlap-" + freshSfx();
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `!stale-overlap-a-${freshSfx()}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "manufactured overlap A", enteredAt: Date.now() - 1000, tokens: [overlapToken],
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `!stale-overlap-b-${freshSfx()}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "manufactured overlap B", enteredAt: Date.now(), tokens: [overlapToken],
    }, null, 2) + "\n");
    const bootOverlap = await freshBootModule();
    bootOverlap.reenterMergeQuarantinesAtBoot([repo, parkedX]);
    const overlapResult = bootOverlap.assertQuarantineIdentityInvariantTestOnly();
    check("*** THE FIX *** two independent-looking entries sharing a TOKEN is still correctly REJECTED", overlapResult.ok === false && overlapResult.violations.length > 0);

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? `\n✅ SCENARIO ${scenarioName}: ALL PASS`
  : `\n❌ SCENARIO ${scenarioName}: ${failures} FAILURE(S) — reproduces board card d4b25feb.`);
process.exit(failures === 0 ? 0 : 1);
