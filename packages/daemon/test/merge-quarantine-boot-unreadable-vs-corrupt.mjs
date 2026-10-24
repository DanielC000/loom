import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 702b4241 — reenterMergeQuarantinesAtBoot's PASS 1 (~final `.json`), PASS 1b (~tmp residue)
// and the safety-tmp recovery loop each wrapped `fs.readFileSync` AND `JSON.parse` in ONE try/catch, so a
// non-ENOENT/EISDIR READ failure (EACCES/EMFILE/EPERM/EBUSY/...) was treated identically to genuinely
// corrupt/unparsable JSON — a resolvable-matched hit then migrated/wrote a fail-closed CORRUPT placeholder
// at the EXACT SAME physical file, destroying real, never-actually-corrupt tokens (card discovered as a
// follow-up from Code Review 5d01bfbf of 63e49ee2, which fixed only the RUNTIME read-failure split).
//
// FIX: each of the three catch blocks now checks the caught error's own errno `.code` BEFORE doing
// anything else. ENOENT/EISDIR (nothing real there) and a JSON.parse/field-validation failure (no `.code`
// at all) keep using the existing, unchanged corrupt-latch cascade. Any OTHER code diverts through the
// new `divertUnreadableBootLatch` chokepoint: marks the file `keptUnreadableLatchFiles` and pushes a
// `PLACEHOLDER_BRANCH_UNREADABLE` entry straight to `pendingUnresolvedQuarantines`, self-referencing the
// file — which `bootWriteLatch`'s own backstop (card ef651188) refuses to ever write over, and which the
// existing clear/sweep chokepoints (`sweepOwnLatchFileUnlessOwnedElsewhere`/
// `sweepOrphanLatchFileIfUnreferenced`, both already `keptUnreadableLatchFiles`-aware since 63e49ee2)
// refuse to ever delete.
//
// See docs/decisions/702b4241-boot-unreadable-vs-corrupt-latch.md for the full repro + fix narrative.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-boot-unreadable-vs-corrupt.mjs
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
  "pass1-final-eacces-survives-pending-fail-closed",
  "pass1b-tmp-emfile-survives-pending-fail-closed",
  "safety-tmp-eperm-survives-pending-fail-closed",
  "no-match-unreadable-goes-orphan-and-kept",
  "corrupt-json-unchanged-non-regression",
  "corrupt-field-validation-unchanged-non-regression",
  "errno-matrix-unreadable-vs-enoent-eisdir",
  "clear-after-unreadable-boot-keeps-file",
  "multiboot-recovery-once-readable",
  // Round 2 (Code Review `12c5623d`, NOT MERGEABLE on round 1) — the two MAJOR additions.
  "query-after-boot-reingests-real-record",
  "transient-sibling-tmp-preserves-token",
  "transient-sibling-migrate-preserves-token",
  // Round 3-5 (Code Review `b939aead`, NOT MERGEABLE on round 2).
  "raise-while-unreadable-never-overwrites-final",
  "fresh-raise-after-readable-keeps-older-ondisk-identity",
  "reingest-detects-legacy-stray-union-provenance",
  // Round 4 (re-review of round 3, NOT MERGEABLE — a second repro of the same review round).
  "mintpendingdivert-uses-returned-redirect-target",
  // Round 7 (re-review `eadada0b` of commit `8869255f`) — the MAJOR fix above is covered by the extended
  // `mintpendingdivert-uses-returned-redirect-target` scenario; this is the round 7 MINOR (the stray
  // synthetic-placeholder-token leak via `divertRaiseEntry`'s hand-rolled merge, caught WITHOUT the
  // in-process query that would otherwise graduate/reingest it away first).
  "raise-while-unreadable-no-query-exact-token-set",
  // Card 656fdf39 — once a `keptUnreadableLatchFiles` mark is set at boot, a human full clear used to
  // leave the marked file on disk even after it became readable again (the coverage proof can never
  // match a boot-time placeholder's own synthetic token against the real on-disk token), so the NEXT
  // boot re-armed the exact identity the clear believed it had lifted. Fix: a marked file that is
  // readable right now and genuinely belongs to the identity being cleared discharges the mark instead
  // of staying kept forever (mirrors 702b4241 round 7's writePendingDivertFile re-read discharge).
  "human-clear-after-unreadable-final-readable-does-not-rearm",
  "human-clear-after-unreadable-tmp-readable-does-not-rearm",
  // Code Review 66fad7ed (NOT-MERGEABLE on round 1): round 1's identity-only discharge destroyed an
  // uncovered token (B1) and let an ambiguous union's own refusal never fire (B2). Round 2 replaced it
  // with re-ingest-then-let-the-existing-checks-decide; B1 is covered by merge-quarantine-raise-protect-
  // failure.mjs's own pre-existing `95ea8d3f-adversarial`/`25f6a7dc-l1318` scenarios (which round 1
  // regressed and round 2 restores green). This is B2, as a committed scenario.
  "human-clear-by-id-reingested-ambiguous-union-refuses",
  // Code Review d1e02886 (round 3, NOT-MERGEABLE on round 2 — commit 56934e55). Round 2's re-ingest at
  // the top of clearMergeQuarantineByKey (a SHARED unit a TOKEN-scoped clear also reaches via
  // clearMergeQuarantineByToken -> clearActiveEntryTokenAtKey's full-lift) made the coverage proof
  // TAUTOLOGICAL for a token-scoped clear, and reconcileClearedEntryIfPlaceholder's own field merge
  // OVERWROTE (never unioned) resolvedKey(s)/orphanLatchFiles/contributorRepoPaths. Fix: thread an
  // explicit `identityWideHumanClear` flag from only the three genuinely identity-wide human clear
  // routes, and merge every field forward instead of overwriting.
  "656fdf39-round3-b1y-token-clear-old-tok-survives",
  "656fdf39-round3-orphan-collision-never-silently-dropped",
  "656fdf39-round3-contributor-repo-paths-placeholder-clear-by-id-refuses",
  // Code Review d19f0490 (round 4, MERGEABLE-WITH-NITS on round 3 — commit 2bec865d). MINOR: three of
  // round 3's own gates (sweepTmpResidueForHashIfUnreferenced's own `&& identityWideHumanClear` and
  // clearTokenFromPendingIndices' own `false`) were removable with every EXISTING test still green —
  // the round-3 coverage proved the FINAL-file/active-token shape, never the TMP-residue shape or a
  // genuinely pending (non-twin) entry's own full-lift.
  "656fdf39-round4-m6-tmp-shape-active-token-clear-old-tok-survives",
  "656fdf39-round4-m2-pending-entry-token-clear-old-tok-survives",
  // M8 (clearMergeQuarantineByKey's own pending-loop reconcile gate) was investigated but deliberately
  // NOT added here — see the decision record's "Round 4" section for why a discriminating test could not
  // be constructed, and do not re-attempt one without reading that section first.
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
    ? "\n✅ ALL SCENARIOS PASS — a genuinely UNREADABLE boot-time latch (final/tmp/safety-tmp) is kept "
      + "byte-identical and retried later, never migrated/overwritten/deleted like genuine corruption; "
      + "ENOENT/EISDIR and real parse/validation failures are unaffected; a human clear of the resulting "
      + "placeholder may lift in-memory enforcement, but never unlinks or overwrites the real file underneath it."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 702b4241.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqbuvc-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, clearMergeQuarantineReporting,
  clearMergeQuarantineLatchFile,
  MERGE_QUARANTINE_DIR, PLACEHOLDER_BRANCH_UNREADABLE, PLACEHOLDER_BRANCH_CORRUPT,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqbuvc@loom -c user.name=mqbuvc";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRealRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqbuvc-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqbuvc@loom && git config user.name mqbuvc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

/** Monkeypatch `fs.readFileSync` to throw `{code}` for calls matching `targetPath` exactly, any other
 *  path reads through normally. Mirrors `merge-quarantine-protect-read-failure.mjs`'s own `injectReadFailure`
 *  (same technique, duplicated here per this test suite's own no-shared-fixture convention). */
function injectReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let interceptCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (p === targetPath) {
      interceptCount++;
      const err = new Error(`${code}: injected for test`);
      err.code = code;
      throw err;
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => interceptCount };
}

/** Round 2 (Code Review `12c5623d`) — the TRANSIENT twin of {@link injectReadFailure}: fails ONLY the
 *  very FIRST read of `targetPath`, succeeds on every read after that — the shape that exercises a
 *  same-boot sibling write recovering content `divertUnreadableBootLatch`'s own first failed read
 *  diverted. Mirrors the Code Reviewer's own probe script's `transient` flag exactly. */
function injectReadFailureTransient(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let hits = 0;
  fs.readFileSync = (p, ...rest) => {
    if (p === targetPath && hits === 0) {
      hits++;
      const err = new Error(`${code}: injected for test (transient)`);
      err.code = code;
      throw err;
    }
    if (p === targetPath) hits++;
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => hits };
}

try {
  if (scenarioName === "pass1-final-eacces-survives-pending-fail-closed") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE MAIN REPRO. D's real final latch is written durably via a real `enterMergeQuarantine` raise.
    // A "reboot" (fresh module reimport against the SAME MERGE_QUARANTINE_DIR) with a persistent EACCES
    // on D's own final must leave the file byte-identical, not overwrite it with a CORRUPT placeholder.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("pass1");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — must survive an unreadable boot read");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    check("(precondition) D's own final latch file exists", fs.existsSync(dFinal));
    const beforeBytes = fs.readFileSync(dFinal, "utf8");
    check("(precondition) D's final latch carries real content", JSON.parse(beforeBytes).branch === "real-branch");
    check("(precondition) D's final latch carries the real raise token", JSON.parse(beforeBytes).tokens.includes(realToken));

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    let bootResult;
    try {
      bootResult = boot1.reenterMergeQuarantinesAtBoot([d]);
    } finally {
      inject.restore();
    }
    check("(repro) the injected read failure was actually hit at least once", inject.count() >= 1);

    const afterBytes = fs.readFileSync(dFinal, "utf8");
    check("*** THE FIX *** D's final latch file content is UNCHANGED after an unreadable boot read", afterBytes === beforeBytes);
    check(
      "*** THE FIX *** D's final latch still parses with its REAL branch, not a corrupt placeholder",
      (() => { try { return JSON.parse(afterBytes).branch === "real-branch"; } catch { return false; } })(),
    );
    // @decision 702b4241 (round 2) — read via listActiveMergeQuarantines (a pure read, never consumes a
    // pending entry), NOT activeMergeQuarantineFor — the latter graduates the pending placeholder, and
    // since the injection is already restored here (and this placeholder's own sourceFile IS `final`
    // itself), round 2's own re-ingestion fix (MAJOR 1) correctly replaces it with the REAL record —
    // see the dedicated "query-after-boot-reingests-real-record" scenario for THAT behavior. This check
    // is about what BOOT itself armed, before any later query touches it.
    const bootArmed = boot1.listActiveMergeQuarantines().find((e) => e.repoPath === d);
    check("D is still reported as quarantined this boot (fail-closed)", !!bootArmed);
    check("D's pending/active placeholder carries PLACEHOLDER_BRANCH_UNREADABLE, never CORRUPT", bootArmed?.branch === PLACEHOLDER_BRANCH_UNREADABLE);
    check("the pending placeholder carries placeholder:true", bootArmed?.placeholder === true);
    const allEntries = bootResult;
    check("reenterMergeQuarantinesAtBoot's own return value also carries the pending entry", allEntries.some((e) => e.repoPath === d && e.branch === PLACEHOLDER_BRANCH_UNREADABLE));

  } else if (scenarioName === "pass1b-tmp-emfile-survives-pending-fail-closed") {
    // PASS 1b's own tmp-residue twin: a `.json.tmp-<pid>` whose own final never cleanly parsed this boot
    // (so the "stale residue beside a clean final" shortcut never fires and the tmp is actually read).
    const d = makeRealRepo("pass1b");
    const kd = canonicalRepoLockKey(d);
    const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-999001`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realEntry = {
      repoPath: d, branch: "real-tmp-branch", reason: "D's real tmp reason",
      enteredAt: Date.now(), tokens: ["real-tmp-token-abc"],
    };
    fs.writeFileSync(dTmp, JSON.stringify(realEntry, null, 2) + "\n");
    const beforeBytes = fs.readFileSync(dTmp, "utf8");

    const inject = injectReadFailure(dTmp, "EMFILE");
    const boot1 = await freshBootModule();
    try {
      boot1.reenterMergeQuarantinesAtBoot([d]);
    } finally {
      inject.restore();
    }
    check("(repro, tmp) the injected read failure was actually hit", inject.count() >= 1);
    const afterBytes = fs.readFileSync(dTmp, "utf8");
    check("*** THE FIX (tmp) *** D's tmp residue is UNCHANGED after an unreadable boot read", afterBytes === beforeBytes);
    const activeAfter = boot1.activeMergeQuarantineFor(d);
    check("D is still reported as quarantined (tmp shape, fail-closed)", !!activeAfter);
    check("the placeholder (tmp shape) carries PLACEHOLDER_BRANCH_UNREADABLE", activeAfter?.branch === PLACEHOLDER_BRANCH_UNREADABLE);

  } else if (scenarioName === "safety-tmp-eperm-survives-pending-fail-closed") {
    // The safety-tmp recovery loop's own twin — a `.json.tmp-safety-<pid>-<hex>` residue.
    const d = makeRealRepo("safetytmp");
    const kd = canonicalRepoLockKey(d);
    const dSafetyTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-safety-999002-abcd1234`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realEntry = {
      repoPath: d, branch: "real-safety-branch", reason: "D's real safety-tmp reason",
      enteredAt: Date.now(), tokens: ["real-safety-token-xyz"],
    };
    fs.writeFileSync(dSafetyTmp, JSON.stringify(realEntry, null, 2) + "\n");
    const beforeBytes = fs.readFileSync(dSafetyTmp, "utf8");

    const inject = injectReadFailure(dSafetyTmp, "EPERM");
    const boot1 = await freshBootModule();
    try {
      boot1.reenterMergeQuarantinesAtBoot([d]);
    } finally {
      inject.restore();
    }
    check("(repro, safety-tmp) the injected read failure was actually hit", inject.count() >= 1);
    const afterBytes = fs.readFileSync(dSafetyTmp, "utf8");
    check("*** THE FIX (safety-tmp) *** D's safety-tmp residue is UNCHANGED after an unreadable boot read", afterBytes === beforeBytes);
    const activeAfter = boot1.activeMergeQuarantineFor(d);
    check("D is still reported as quarantined (safety-tmp shape, fail-closed)", !!activeAfter);
    check("the placeholder (safety-tmp shape) carries PLACEHOLDER_BRANCH_UNREADABLE", activeAfter?.branch === PLACEHOLDER_BRANCH_UNREADABLE);

  } else if (scenarioName === "no-match-unreadable-goes-orphan-and-kept") {
    // An unreadable latch whose filename hash matches NO registered repo at any tier. Must still land in
    // the orphan fail-closed-for-everyone cascade (same as an unmatched corrupt file always has), but the
    // FILE ITSELF must be untouched (never a write target for the orphan references).
    const d = makeRealRepo("nomatch-registered"); // registered, but shares no hash with the orphan below
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const orphanPath = path.join(MERGE_QUARANTINE_DIR, "deadbeefdeadbeefdeadbeef.json");
    const realEntry = { repoPath: "/some/unregistered/repo", branch: "orphan-branch", reason: "orphan reason", enteredAt: Date.now(), tokens: ["orphan-token"] };
    fs.writeFileSync(orphanPath, JSON.stringify(realEntry, null, 2) + "\n");
    const beforeBytes = fs.readFileSync(orphanPath, "utf8");

    const inject = injectReadFailure(orphanPath, "EBUSY");
    const boot1 = await freshBootModule();
    try {
      boot1.reenterMergeQuarantinesAtBoot([d]);
    } finally {
      inject.restore();
    }
    check("(repro, no-match) the injected read failure was actually hit", inject.count() >= 1);
    const afterBytes = fs.readFileSync(orphanPath, "utf8");
    check("*** THE FIX (no-match) *** the unmatched unreadable file is UNCHANGED", afterBytes === beforeBytes);
    const dActive = boot1.activeMergeQuarantineFor(d);
    check("every registered repo (D) gets a fail-closed orphan reference for the unmatched unreadable file", !!dActive && dActive.orphanLatchFiles?.includes("deadbeefdeadbeefdeadbeef.json"));

  } else if (scenarioName === "corrupt-json-unchanged-non-regression") {
    // NEGATIVE CONTROL (requirement from the approved design): genuinely corrupt/unparsable JSON must
    // still take the EXISTING corrupt path — overwritten with a CORRUPT placeholder — unaffected by this
    // fix, since a JSON.parse SyntaxError carries no `.code` at all.
    const d = makeRealRepo("corruptjson");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, "{ this is not valid json at all");

    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    const afterBytes = fs.readFileSync(dFinal, "utf8");
    check("*** non-regression *** genuinely corrupt JSON still gets overwritten with a CORRUPT placeholder", afterBytes !== "{ this is not valid json at all");
    const activeAfter = boot1.activeMergeQuarantineFor(d);
    check("the placeholder is CORRUPT, never UNREADABLE, for genuinely corrupt content", activeAfter?.branch === PLACEHOLDER_BRANCH_CORRUPT);

  } else if (scenarioName === "corrupt-field-validation-unchanged-non-regression") {
    // NEGATIVE CONTROL #2 (requirement from the approved design): valid JSON that FAILS the
    // repoPath/branch/reason field validation (the manual `throw new Error(...)`, which also carries no
    // `.code`) must ALSO still take the corrupt path, never the new unreadable branch.
    const d = makeRealRepo("fieldvalidation");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, JSON.stringify({ someOtherField: "no repoPath/branch/reason here" }));

    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    const afterBytes = fs.readFileSync(dFinal, "utf8");
    check("*** non-regression *** valid-but-field-invalid JSON still gets overwritten (takes the corrupt path)", afterBytes !== JSON.stringify({ someOtherField: "no repoPath/branch/reason here" }));
    const activeAfter = boot1.activeMergeQuarantineFor(d);
    check("the placeholder is CORRUPT, never UNREADABLE, for a field-validation failure", activeAfter?.branch === PLACEHOLDER_BRANCH_CORRUPT);

  } else if (scenarioName === "errno-matrix-unreadable-vs-enoent-eisdir") {
    // Unit-level check (requirement from the approved design): every errno OTHER than ENOENT/EISDIR
    // takes the unreadable branch — including one UNKNOWN code, which must default to unreadable, never
    // corrupt. ENOENT/EISDIR must NOT take the unreadable branch (they fall through to the existing,
    // unchanged corrupt-latch cascade, which is safe for them — nothing real is lost either way).
    const UNREADABLE_CODES = ["EACCES", "EMFILE", "EPERM", "EBUSY", "EWEIRD_UNKNOWN_CODE"];
    for (const code of UNREADABLE_CODES) {
      const d = makeRealRepo(`matrix-${code}`);
      const realToken = enterMergeQuarantine(d, "real-branch", `real reason for ${code}`);
      const kd = canonicalRepoLockKey(d);
      const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
      const beforeBytes = fs.readFileSync(dFinal, "utf8");

      const inject = injectReadFailure(dFinal, code);
      const boot1 = await freshBootModule();
      try {
        boot1.reenterMergeQuarantinesAtBoot([d]);
      } finally {
        inject.restore();
      }
      const afterBytes = fs.readFileSync(dFinal, "utf8");
      check(`[${code}] file content is UNCHANGED (unreadable branch taken)`, afterBytes === beforeBytes);
      check(`[${code}] still parses with the real raise token`, (() => { try { return JSON.parse(afterBytes).tokens.includes(realToken); } catch { return false; } })());
      // @decision 702b4241 (round 2) — read via listActiveMergeQuarantines (a pure read, never consumes a
      // pending entry), NOT activeMergeQuarantineFor — the latter graduates the pending placeholder, and
      // since the injection is already restored here, round 2's own re-ingestion fix (MAJOR 1) correctly
      // replaces its branch with the REAL one, which would make this specific assertion fail for the
      // right reason. This check is about what BOOT itself armed, not what a later query re-ingests.
      const bootArmed = boot1.listActiveMergeQuarantines().find((e) => e.repoPath === d);
      check(`[${code}] placeholder is PLACEHOLDER_BRANCH_UNREADABLE`, bootArmed?.branch === PLACEHOLDER_BRANCH_UNREADABLE);
    }

    // ENOENT: the file genuinely does not exist — readFileSync throws ENOENT naturally, no injection
    // needed. Nothing real to lose; must NOT take the unreadable branch (no placeholder of either kind
    // is expected to be UNREADABLE-branded — if anything is armed at all, it must be CORRUPT-branded).
    {
      const d = makeRealRepo("matrix-ENOENT-registered");
      const dOrphan = makeRealRepo("matrix-ENOENT-target");
      const kd2 = canonicalRepoLockKey(dOrphan);
      const ghostPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd2)}.json`);
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      // Never actually written — simulates the file vanishing between readdir and read, which this
      // module already treats as "nothing real there" via the EXISTING corrupt cascade (unchanged).
      const boot1 = await freshBootModule();
      // There is no injectable "appears then disappears" shape via mtime-based readdir in a unit test
      // without racing the real filesystem — assert the PRECONDITION instead (ENOENT falls through to
      // the pre-existing, long-tested corrupt-latch handling, which this card deliberately leaves alone)
      // by confirming no new UNREADABLE-branded entry exists for a path that was simply never written.
      boot1.reenterMergeQuarantinesAtBoot([d, dOrphan]);
      check("[ENOENT] a never-written latch produces no UNREADABLE-branded entry for the target repo", boot1.activeMergeQuarantineFor(dOrphan)?.branch !== PLACEHOLDER_BRANCH_UNREADABLE);
      void ghostPath;
    }

  } else if (scenarioName === "clear-after-unreadable-boot-keeps-file") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Manager-required addition #1: the CLEAR path must not delete the unreadable file. Boot survives
    // (pending + keptUnreadableLatchFiles, per the main repro), then a human clears the resulting
    // placeholder BY ID while the read failure is STILL in effect. The clear legitimately LIFTS in-memory
    // enforcement (human-authoritative routes may do that without proving coverage first — see the
    // inline @decision comment below) but must leave the physical file byte-identical, never deleted, and
    // (round 2, MINOR) must say so via `latchKept:true` rather than a bare, unqualified success.
    //
    // *** CORRECTION (round 2, Code Review `12c5623d`): this scenario DOES go RED on unfixed `main`, for
    // the SAME root cause as the main repro, not a separate one — on `main` the destructive overwrite
    // already happens DURING BOOT ITSELF (see "pass1-final-eacces-survives-pending-fail-closed" above),
    // so by the time this scenario's own clear call runs, `beforeBytes` (captured before boot) no longer
    // matches what's on disk — the `afterClearBytes === beforeBytes` assertion below already fails at
    // that point, on the unfixed code, for the boot-time reason, not a clear-time one. Round 1's own
    // comment here claimed the opposite; that claim was wrong, not merely imprecise. *** What this
    // scenario pins POST-fix is the DOWNSTREAM clear path, which was ALREADY `keptUnreadableLatchFiles`-
    // aware before this card (63e49ee2) for the UNLINK decision — the `latchKept` REPORTING gap (round 2,
    // MINOR) was separate and is fixed in `deleteMergeQuarantineLatchByKey`, see the decision record.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("clearafter");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — must survive a clear too");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    const beforeBytes = fs.readFileSync(dFinal, "utf8");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    const pending = boot1.activeMergeQuarantineFor(d); // also lazily attempts (and, per the log, fails to
    // durably persist) a graduation — pre-existing 63e49ee2-era machinery, unaffected by this card.
    check("(precondition) D is pending/fail-closed after the unreadable boot", !!pending);

    const idsBeforeClear = boot1.quarantineLatchFileIdsFor(pending);
    const clearResult = boot1.clearMergeQuarantineLatchFile(idsBeforeClear[0]);
    // @decision 702b4241 — `clearMergeQuarantineLatchFile`/`clearMergeQuarantineReporting` are the HUMAN-
    // authoritative clear routes: they are entitled to lift IN-MEMORY enforcement for a repo on request
    // without proving the physical content's coverage first (unlike the automatic, token-scoped
    // `clearMergeQuarantineByToken`) — so `ok:true`/`wasQuarantined:true` here, with D no longer reported
    // quarantined afterward, is EXPECTED, not a regression. What this scenario actually pins is narrower
    // and unconditional: the PHYSICAL FILE this card protects is never unlinked or overwritten by that
    // clear, regardless of what it reports about in-memory state — `sweepOwnLatchFileUnlessOwnedElsewhere`
    // (pre-existing, 63e49ee2) still refuses to touch a `keptUnreadableLatchFiles`-marked file even while
    // granting the human's clear request.
    check("the clear-by-id call succeeds (lifts in-memory enforcement, as designed)", clearResult?.ok === true);
    check("*** THE FIX (round 2, MINOR) *** the clear reports latchKept:true (never a bare, unqualified success)", clearResult?.ok === true && clearResult.latchKept === true);
    inject.restore();
    const afterClearBytes = fs.readFileSync(dFinal, "utf8");
    check("*** THE FIX *** D's final latch FILE is BYTE-IDENTICAL after the clear attempt (never deleted/overwritten)", afterClearBytes === beforeBytes);
    check("D's real raise token still survives on disk after the clear attempt", JSON.parse(afterClearBytes).tokens.includes(realToken));
    check("(sanity) the file still physically exists at all — clear-by-id did not unlink it", fs.existsSync(dFinal));

  } else if (scenarioName === "multiboot-recovery-once-readable") {
    // Once the transient failure lifts, a LATER boot must recover the REAL content cleanly — the file
    // was never touched, so there is nothing to recover FROM except the original, still-intact bytes.
    const d = makeRealRepo("multiboot");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — recoverable after the glitch clears");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    inject.restore(); // the transient glitch is over

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const activeAfterBoot2 = boot2.activeMergeQuarantineFor(d);
    check("*** recovery *** after the glitch clears, a later boot sees D's REAL branch again", activeAfterBoot2?.branch === "real-branch");
    check("*** recovery *** the real raise token is intact", activeAfterBoot2?.tokens?.includes(realToken));
    check("*** recovery *** no UNREADABLE-branded placeholder lingers once content is readable again", activeAfterBoot2?.branch !== PLACEHOLDER_BRANCH_UNREADABLE);

  } else if (scenarioName === "query-after-boot-reingests-real-record") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 2, MAJOR 1 (Code Review `12c5623d`). The `none` shape: no sibling tmp/migrate at all, so
    // nothing writes during boot and `keptUnreadableLatchFiles` stays set. The FIRST
    // `activeMergeQuarantineFor` call AFTER the read failure lifts graduates the pending UNREADABLE
    // placeholder — pre-fix (round 1), that graduation's own `foldInOnDiskTokensIfMarked` call only
    // unioned TOKENS forward, durably stamping the placeholder's own fake branch/reason over the just-
    // recovered real content, both in memory AND on disk. Fixed via `reconcileMarkedBasenameBeforeWrite`'s
    // new re-ingestion branch.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("reingest");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — must survive a post-boot query");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    inject.restore(); // the glitch lifts — final is genuinely readable again from here on

    const activeAfterQuery = boot1.activeMergeQuarantineFor(d); // graduates the pending placeholder
    check("*** THE FIX (round 2, MAJOR 1) *** post-boot query re-ingests the REAL branch, never the placeholder's", activeAfterQuery?.branch === "real-branch");
    check("*** THE FIX *** post-boot query re-ingests the REAL reason", activeAfterQuery?.reason === "D's real reason — must survive a post-boot query");
    check("*** THE FIX *** post-boot query carries the REAL raise token", activeAfterQuery?.tokens?.includes(realToken));
    check("*** THE FIX *** the re-ingested entry is no longer placeholder-shaped", !activeAfterQuery?.placeholder);
    // Round 4, item 3: the plain (no-raise) query path must carry ONLY the genuine token(s) — the
    // placeholder's own synthetic `randomUUID()` must never ride along just because it once shared
    // `entry.tokens` with this record before the reingest branch unioned things forward.
    check("*** THE FIX (round 4) *** the query shows ONLY the genuine token, never the placeholder's own synthetic one", JSON.stringify([...(activeAfterQuery?.tokens ?? [])].sort()) === JSON.stringify([realToken]));

    const onDiskAfterQuery = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    check("*** THE FIX *** the on-disk branch is REAL after the graduation's own durable write", onDiskAfterQuery.branch === "real-branch");
    check("*** THE FIX *** the on-disk reason is REAL after the graduation's own durable write", onDiskAfterQuery.reason === "D's real reason — must survive a post-boot query");
    check("*** THE FIX *** the on-disk record carries the real token", onDiskAfterQuery.tokens.includes(realToken));
    check("*** THE FIX *** the on-disk record is no longer placeholder-shaped", onDiskAfterQuery.placeholder !== true);
    check("*** THE FIX (round 4, on disk) *** the on-disk record carries ONLY the genuine token", JSON.stringify([...onDiskAfterQuery.tokens].sort()) === JSON.stringify([realToken]));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const activeAfterBoot2 = boot2.activeMergeQuarantineFor(d);
    check("*** THE FIX (boot2) *** the REAL branch survives a full reboot too", activeAfterBoot2?.branch === "real-branch");
    check("*** THE FIX (round 4, boot2) *** boot2 shows ONLY the genuine token too", JSON.stringify([...(activeAfterBoot2?.tokens ?? [])].sort()) === JSON.stringify([realToken]));
    check("*** THE FIX (boot2) *** the REAL token survives a full reboot too", activeAfterBoot2?.tokens?.includes(realToken));

  } else if (scenarioName === "transient-sibling-tmp-preserves-token" || scenarioName === "transient-sibling-migrate-preserves-token") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 2, MAJOR 2 (Code Review `12c5623d`). A TRANSIENT failure (only the FIRST read of `final`
    // fails; every later read within the SAME boot succeeds) plus a sibling (tmp residue, or a stale
    // migrate source) for the SAME key. Boot's own torn-write-recovery/migrate write reconciles T1
    // (final's own real token) onto disk correctly — but pre-fix (round 1), `bootWriteLatch`'s own
    // caller (`byRepoKey`) never received that reconciled object, only the write did. The kept mark
    // clears on that successful write, so a LATER post-boot query has nothing left to re-reconcile from
    // and writes the STALE, pre-reconcile in-memory entry back over the disk, losing T1. Fixed by having
    // `bootWriteLatch` itself reconcile-then-sync `byRepoKey` BEFORE every write.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const isTmp = scenarioName === "transient-sibling-tmp-preserves-token";
    const d = makeRealRepo(isTmp ? "transtmp" : "transmigrate");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — must survive a transient glitch plus a sibling");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    let siblingToken;
    if (isTmp) {
      const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-999003`);
      siblingToken = "real-tmp-sibling-token";
      fs.writeFileSync(dTmp, JSON.stringify({ repoPath: d, branch: "real-tmp-sibling", reason: "sibling tmp reason", enteredAt: Date.now(), tokens: [siblingToken] }, null, 2) + "\n");
    } else {
      const staleMigratePath = path.join(MERGE_QUARANTINE_DIR, `${"ab".repeat(12)}.json`);
      siblingToken = "real-migrate-sibling-token";
      fs.writeFileSync(staleMigratePath, JSON.stringify({ repoPath: d, branch: "real-migrate-sibling", reason: "sibling migrate reason", enteredAt: Date.now(), tokens: [siblingToken] }, null, 2) + "\n");
    }

    const inject = injectReadFailureTransient(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    inject.restore();
    check("(precondition) the injected transient failure was hit exactly once (the FIRST read only)", inject.count() >= 1);

    const onDiskAfterBoot1 = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    check("*** THE FIX (round 2, MAJOR 2, on disk after boot1) *** D's own real token survives the sibling union", onDiskAfterBoot1.tokens.includes(realToken));
    check("*** THE FIX (on disk after boot1) *** the sibling's own token also survives the union", onDiskAfterBoot1.tokens.includes(siblingToken));

    const activeAfterQuery = boot1.activeMergeQuarantineFor(d); // graduates any leftover pending divert
    check("*** THE FIX (in memory after query) *** D's own real token is still present in memory", activeAfterQuery?.tokens?.includes(realToken));
    check("*** THE FIX (in memory after query) *** the sibling's own token is still present in memory", activeAfterQuery?.tokens?.includes(siblingToken));
    const onDiskAfterQuery = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    check("*** THE FIX (on disk after query) *** D's own real token STILL survives after the post-boot query's own write", onDiskAfterQuery.tokens.includes(realToken));
    check("*** THE FIX (on disk after query) *** the sibling's own token STILL survives after the post-boot query's own write", onDiskAfterQuery.tokens.includes(siblingToken));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const activeAfterBoot2 = boot2.activeMergeQuarantineFor(d);
    check("*** THE FIX (boot2) *** D's own real token survives a full reboot too", activeAfterBoot2?.tokens?.includes(realToken));
    check("*** THE FIX (boot2) *** the sibling's own token survives a full reboot too", activeAfterBoot2?.tokens?.includes(siblingToken));

  } else if (scenarioName === "raise-while-unreadable-never-overwrites-final") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 3 (Code Review `b939aead`, CRITICAL, pre-existing since round 1). `divertRaiseEntry`'s own
    // `base.sourceFile` write CAN BE the boot-time UNREADABLE placeholder's self-referenced final `f`
    // (`divertUnreadableBootLatch` pushes `sourceFile: f`) — `writePendingDivertFile` never checked
    // `keptUnreadableLatchFiles` before renaming over it, so a fresh raise for the SAME identity while
    // `f` is STILL unreadable durably destroyed the real branch/reason/opId/resolvedKeys/tokens, replacing
    // them with nothing but the placeholder's own synthetic union. Round 5 also fixed a SECOND, adjacent
    // defect this scenario's own token checks catch: the reingest branch used to drop the fresh raiser's
    // own token too, not just the placeholder's bare synthetic one.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("raisewhileunreadable");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realToken = "real-longoutstanding-token-r3";
    // A GENUINE secondary key, distinct from `kd` (the file's own primary key) — `reconcileMarkedBasenameBeforeWrite`'s
    // reingest branch deliberately excludes the file's OWN primary-key hash from the on-disk secondary-key
    // union (150aed7b's own rule), so asserting survival of `kd` itself here would be a degenerate check.
    const secondaryKey = path.join(os.tmpdir(), `loom-mqbuvc-repo-raisewhileunreadable-secondary-${freshSfx()}`);
    const realRecord = {
      repoPath: d, branch: "real-branch-r3", reason: "D's real reason — longest outstanding, must survive a raise while still unreadable",
      opId: "real-op-id-r3", enteredAt: 1, tokens: [realToken],
      resolvedKey: kd, resolvedKeys: [kd, secondaryKey], provenanceTracked: true,
    };
    fs.writeFileSync(dFinal, JSON.stringify(realRecord, null, 2) + "\n");
    const beforeBytes = fs.readFileSync(dFinal, "utf8");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    // A pure read (never graduates the pending placeholder) — the injection is still live, so a query
    // here would hit the SAME reconcile chokepoint this scenario means to exercise via a RAISE instead.
    check("(precondition) D is pending/fail-closed after the unreadable boot", boot1.listActiveMergeQuarantines().some((e) => e.repoPath === d && e.placeholder === true));

    // RAISE while the final is STILL unreadable — the critical repro.
    const freshToken = boot1.enterMergeQuarantine(d, "fresh-branch-r3", "a fresh raise while the final is still unreadable");
    check("(repro) the injected read failure was actually hit", inject.count() >= 1);
    inject.restore(); // restore BEFORE the test's own byte-identical read below — the injection is global (monkeypatches `fs.readFileSync` itself), not production-code-scoped.

    const afterRaiseBytes = fs.readFileSync(dFinal, "utf8");
    check("*** THE FIX (round 3) *** D's final latch file is BYTE-IDENTICAL after a raise while still unreadable", afterRaiseBytes === beforeBytes);

    // Round 4, item 2 (re-review `b939aead`'s own gap): an IN-PROCESS query, in the SAME boot1 instance,
    // right after the glitch clears — this is the ACTUAL negative control for round 5's token-union fix.
    // Reverting ONLY that one line (dropping the `entry.tokens` union back to `reingested.tokens` alone)
    // keeps every OTHER check in this file green; only this in-process query catches it going RED.
    const activeInBoot1 = boot1.activeMergeQuarantineFor(d);
    check("*** THE FIX (round 5, in-process) *** the fresh raiser's OWN token survives THIS SAME process's own query, not just a later reboot", activeInBoot1?.tokens?.includes(freshToken));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const activeAfterBoot2 = boot2.activeMergeQuarantineFor(d);
    check("*** THE FIX (boot2) *** D's REAL branch survives once readable again", activeAfterBoot2?.branch === "real-branch-r3");
    check("*** THE FIX (boot2) *** D's REAL opId survives", activeAfterBoot2?.opId === "real-op-id-r3");
    check("*** THE FIX (boot2) *** D's REAL secondary resolvedKey survives", Array.isArray(activeAfterBoot2?.resolvedKeys) && activeAfterBoot2.resolvedKeys.includes(secondaryKey));
    check("*** THE FIX (round 5) *** D's REAL long-outstanding token survives", activeAfterBoot2?.tokens?.includes(realToken));
    check("*** THE FIX (round 5) *** the fresh raiser's OWN token ALSO survives (not silently dropped by reingest)", activeAfterBoot2?.tokens?.includes(freshToken));

    const onDiskAfterBoot2 = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    check("*** THE FIX (boot2, on disk) *** the real branch is durably on disk", onDiskAfterBoot2.branch === "real-branch-r3");
    check("*** THE FIX (boot2, on disk) *** the fresh raiser's own token is durably on disk", onDiskAfterBoot2.tokens.includes(freshToken));

  } else if (scenarioName === "raise-while-unreadable-no-query-exact-token-set") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 7 MINOR (re-review `eadada0b` of commit `8869255f`). The NO-QUERY variant of
    // "raise-while-unreadable-never-overwrites-final" — same repro, but WITHOUT the in-process
    // `activeMergeQuarantineFor(d)` query that scenario makes right after the glitch clears. That query
    // graduates/reingests the placeholder immediately, so by the time THAT scenario's own boot2 reads the
    // final, the stray synthetic placeholder token has already been filtered (round 4's own
    // `unreadablePlaceholderTokens` filter, in `reconcileMarkedBasenameBeforeWrite`'s reingest branch).
    // Skipping the query instead leaves `divertRaiseEntry`'s own hand-rolled merge (which unions
    // `base.entry.tokens` — the boot placeholder's own bare synthetic UUID, included — with NO filter of
    // its own) as the thing that durably persists, via the collision-diverted pending record, all the way
    // to boot2's own on-disk read. An EXACT token-set assertion here (not `.includes`) is what catches it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("raisewhileunreadablenoquery");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realToken = "real-longoutstanding-token-r7noquery";
    const realRecord = {
      repoPath: d, branch: "real-branch-r7nq", reason: "D's real reason — longest outstanding, must survive a raise while still unreadable, no in-process query",
      opId: "real-op-id-r7nq", enteredAt: 1, tokens: [realToken],
    };
    fs.writeFileSync(dFinal, JSON.stringify(realRecord, null, 2) + "\n");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);

    // RAISE while the final is STILL unreadable — no query of any kind in between.
    const freshToken = boot1.enterMergeQuarantine(d, "fresh-branch-r7nq", "a fresh raise while the final is still unreadable, no in-process query");
    check("(repro) the injected read failure was actually hit", inject.count() >= 1);
    inject.restore();
    // Deliberately NO `boot1.activeMergeQuarantineFor(d)` call here — straight to boot2.

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const onDiskAfterBoot2 = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    const exactTokenSet = [...onDiskAfterBoot2.tokens].sort();
    const expectedTokenSet = [realToken, freshToken].sort();
    check(
      `*** THE FIX (round 7) *** boot2's on-disk token set is EXACTLY [realToken, freshToken] — no stray synthetic placeholder token (got: ${JSON.stringify(exactTokenSet)})`,
      exactTokenSet.length === expectedTokenSet.length && exactTokenSet.every((t, i) => t === expectedTokenSet[i]),
    );
    const activeAfterBoot2 = boot2.activeMergeQuarantineFor(d);
    const exactInMemoryTokenSet = [...(activeAfterBoot2?.tokens ?? [])].sort();
    check(
      `*** THE FIX (round 7) *** boot2's in-memory token set is ALSO EXACTLY [realToken, freshToken] (got: ${JSON.stringify(exactInMemoryTokenSet)})`,
      exactInMemoryTokenSet.length === expectedTokenSet.length && exactInMemoryTokenSet.every((t, i) => t === expectedTokenSet[i]),
    );

  } else if (scenarioName === "fresh-raise-after-readable-keeps-older-ondisk-identity") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 4 (same review, MINOR). Once `f` is readable again, `enterMergeQuarantine`'s pending-merge
    // branch unions the boot placeholder with a FRESH raise via `unionQuarantineEntries` — which
    // correctly never lets a placeholder win identity over a real raiser (`92c645cc`) — so the union's
    // own branch becomes the fresh raiser's, not the placeholder's. But the genuinely OLDER on-disk
    // identity (written long before boot even ran) was never compared against anything in THAT union;
    // `reconcileMarkedBasenameBeforeWrite`'s generic branch used to only ever union tokens/keys forward,
    // discarding the real, longer-outstanding branch/reason/enteredAt/opId in favor of the fresh raiser's.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("freshraiseafterreadable");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realToken = "real-longoutstanding-token-r4";
    const realRecord = {
      repoPath: d, branch: "real-branch-r4", reason: "D's real, genuinely older reason",
      opId: "real-op-id-r4", enteredAt: 1, tokens: [realToken], resolvedKey: kd, provenanceTracked: true,
    };
    fs.writeFileSync(dFinal, JSON.stringify(realRecord, null, 2) + "\n");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    inject.restore(); // the glitch lifts BEFORE any raise happens — final is genuinely readable from here on

    const freshToken = boot1.enterMergeQuarantine(d, "fresh-branch-r4", "a fresh raise after the final became readable again");
    const active = boot1.activeMergeQuarantineFor(d);
    check("*** THE FIX (round 4) *** the genuinely OLDER on-disk identity wins the branch", active?.branch === "real-branch-r4");
    check("*** THE FIX (round 4) *** the genuinely OLDER on-disk identity wins the reason", active?.reason === "D's real, genuinely older reason");
    check("*** THE FIX (round 4) *** the genuinely OLDER on-disk identity wins opId", active?.opId === "real-op-id-r4");
    check("*** THE FIX (round 4) *** the genuinely OLDER on-disk identity wins enteredAt", active?.enteredAt === 1);
    check("the long-outstanding real token still survives (enforcement intact either way)", active?.tokens?.includes(realToken));
    check("the fresh raiser's own token ALSO survives", active?.tokens?.includes(freshToken));

    const onDisk = JSON.parse(fs.readFileSync(dFinal, "utf8"));
    check("*** THE FIX (round 4, on disk) *** the older identity is durably on disk", onDisk.branch === "real-branch-r4" && onDisk.opId === "real-op-id-r4");

  } else if (scenarioName === "reingest-detects-legacy-stray-union-provenance") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 4 (MINOR). The reingest branch used to force `provenanceTracked: true` unconditionally and
    // never ran `detectUnknownProvenance` at all — a LEGACY (pre-48aeb324) stray union recovered through
    // this branch lost its due `provenanceUnknown` flagging, so clear-by-id on it would fail open.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("legacystrayunion");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // A LEGACY (pre-48aeb324) stray union: 2+ tokens, a `resolvedKey` whose own hash does NOT match this
    // file's own basename hash (the tell `detectUnknownProvenance` looks for), no `provenanceTracked`/
    // `provenanceUnknown` field at all (pre-dates both).
    const foreignKey = path.join(os.tmpdir(), `loom-mqbuvc-repo-legacyforeign-${freshSfx()}`);
    const legacyRecord = {
      repoPath: d, branch: "legacy-branch", reason: "a pre-48aeb324 stray union with no provenance fields",
      enteredAt: 1, tokens: ["legacy-tok-1", "legacy-tok-2"], resolvedKey: foreignKey,
    };
    fs.writeFileSync(dFinal, JSON.stringify(legacyRecord, null, 2) + "\n");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    inject.restore();

    const active = boot1.activeMergeQuarantineFor(d); // graduates the placeholder, reingests the legacy record
    check("*** THE FIX (round 4, MINOR) *** the reingested legacy stray union is flagged provenanceUnknown", active?.provenanceUnknown === true);
    check("the reingested record still carries its real branch", active?.branch === "legacy-branch");
    check("the reingested record still carries both legacy tokens", active?.tokens?.includes("legacy-tok-1") && active?.tokens?.includes("legacy-tok-2"));

  } else if (scenarioName === "mintpendingdivert-uses-returned-redirect-target") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 4 MAJOR (re-review `b939aead` of commit `fdec6e9a`). TWO of round 3's "structurally
    // unreachable" claims were false: (a) boot's PASS 1 read loop iterates every `.json` file, including
    // `pending-<hash>.json` records — a read failure on ONE of those ALSO calls `divertUnreadableBootLatch`,
    // which marks it `keptUnreadableLatchFiles` exactly like a real quarantine final; (b)
    // `reconcilePendingDivertTarget` returns the PRIMARY pending-divert name whenever it is readable NOW,
    // with no regard for that mark persisting after the glitch clears. So `mintPendingDivert`'s own write
    // CAN redirect too — and it ignored the returned `{filename, entry}`, recording `sourceFile: primary`
    // (the ORIGINAL, still-marked name) while the REAL durable bytes land at a freshly-minted collision
    // file nothing in memory references — an untracked orphan a human clear can never find or sweep.
    //
    // Round 7 (re-review `eadada0b` of commit `8869255f`) — the round-4 fix above still re-quarantined X
    // on a LATER boot even after a human clear "succeeded": `reconcilePendingDivertTarget`'s own
    // successful, same-identity read of the marked primary proves overwriting it IN PLACE is safe, but
    // `writePendingDivertFile` used to redirect anyway on the STALE mark alone, leaving the primary's own
    // (now-superseded) bytes on disk, marked kept forever — exactly what a later boot re-reads and
    // re-quarantines from. FIX: `writePendingDivertFile` itself now re-reads a marked `filename` right
    // before deciding; a successful same-identity read discharges the mark and overwrites in place (no
    // collision file, no orphan survives) — the ONE write chokepoint every diverting caller (including
    // `divertRaiseEntry`/`mergeTokenIntoPendingEntries`) funnels through, so this fixes the gap for every
    // caller at once. Run for BOTH the registered and unregistered boot variants: X's own
    // `pending-<hash>.json` hash never matches boot's `quarantineHashFor`-keyed lookups either way (two
    // deliberately disjoint hash spaces, `d4b25feb`), so a read failure on it always falls to the generic
    // orphan cascade regardless of registration, and both variants reach this fix through the SAME
    // `mintPendingDivert`/`reconcilePendingDivertTarget` path on the second raise. The ONLY difference
    // registering X adds is a wholly separate, pre-existing mechanism (boot's own "no registered repo's
    // hash matched — defensively quarantine EVERY registered repo" orphan fallback) that can leave the
    // CLEAR's own `latchKept` field `true` from an unrelated ordering artifact — immaterial to this card,
    // so only the file-system-level outcome is asserted below, never `clearResult.latchKept` itself.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    for (const registered of [true, false]) {
      const label = registered ? "registered" : "unregistered";
      const x = path.join(os.tmpdir(), `loom-mqbuvc-repo-r7major-${label}-${freshSfx()}`); // never created — unresolvable
      const beforeFiles = new Set(fs.existsSync(MERGE_QUARANTINE_DIR) ? fs.readdirSync(MERGE_QUARANTINE_DIR) : []);
      const t1 = enterMergeQuarantine(x, "x-branch", `x reason — unresolvable raise, mints a pending-divert record (${label})`);
      const primaryFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => !beforeFiles.has(f) && f.startsWith("pending-") && !f.includes("-collision-"));
      check(`(precondition, ${label}) a primary pending-divert file was minted for the unresolvable raise`, primaryFiles.length === 1);
      const primaryFile = primaryFiles[0];
      const primaryPath = path.join(MERGE_QUARANTINE_DIR, primaryFile);
      check(`(precondition, ${label}) the primary pending-divert file carries the first raise's own token`, JSON.parse(fs.readFileSync(primaryPath, "utf8")).tokens.includes(t1));

      const inject = injectReadFailure(primaryPath, "EACCES");
      const boot1 = await freshBootModule();
      boot1.reenterMergeQuarantinesAtBoot(registered ? [x] : []);
      inject.restore(); // readable again — a stale mark must not force a redirect any more (round 7).
      check(`(repro, ${label}) the injected read failure on the PENDING file was actually hit`, inject.count() >= 1);

      // A fresh raise for the SAME still-unresolvable identity, now that `primaryFile` is genuinely
      // readable again — *** THE FIX (round 7) *** discharges the mark and overwrites it IN PLACE,
      // never redirecting to a fresh collision file.
      const t2 = boot1.enterMergeQuarantine(x, "x-branch-2", `a fresh raise once the primary pending-divert file is readable again (${label})`);
      const filesAfterRaise2 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => !beforeFiles.has(f));
      check(`*** THE FIX (round 7, ${label}) *** no collision file was minted — the primary is overwritten in place`, filesAfterRaise2.length === 1 && filesAfterRaise2[0] === primaryFile);
      const primaryAfterRaise2 = JSON.parse(fs.readFileSync(primaryPath, "utf8"));
      check(`*** THE FIX (round 7, ${label}) *** the primary carries BOTH raises' own tokens (unioned in place, never dropped)`, primaryAfterRaise2.tokens.includes(t1) && primaryAfterRaise2.tokens.includes(t2));
      check(`*** THE FIX (round 7, ${label}) *** the primary's own REAL (first-raise) branch survives the union`, primaryAfterRaise2.branch === "x-branch");

      // The human clear route must find the one, fully-reconciled record and genuinely resolve it — never
      // leave a stale, superseded primary behind (see this scenario's own header for why `latchKept`
      // itself is not asserted on here).
      boot1.clearMergeQuarantineReporting(x);
      const filesAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => !beforeFiles.has(f));
      check(`*** THE FIX (round 7, ${label}) *** the primary is genuinely removed by the clear — nothing stale left behind`, filesAfterClear.length === 0);

      const boot2 = await freshBootModule();
      boot2.reenterMergeQuarantinesAtBoot(registered ? [x] : []);
      check(`*** THE FIX (boot2, ${label}) *** X is NOT re-quarantined — the very raise that was cleared stays cleared`, !boot2.activeMergeQuarantineFor(x));
      const filesAfterBoot2 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => !beforeFiles.has(f));
      check(`*** THE FIX (boot2, ${label}) *** no orphan/collision file remains for X after a second boot`, filesAfterBoot2.length === 0);
    }

  } else if (scenarioName === "human-clear-after-unreadable-final-readable-does-not-rearm") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card 656fdf39. D's real FINAL latch is marked unreadable at boot (the main 702b4241 repro). The
    // glitch clears BEFORE a human full clear runs (`clearMergeQuarantineReporting`, the same helper
    // `POST /internal/merge-quarantine/clear` calls) — final is genuinely readable right now. Pre-fix,
    // the clear's own coverage proof (`markedFinalFullyCoveredByClear`) can never match: the in-memory
    // entry being cleared is boot's own PLACEHOLDER (a synthetic token), never the real on-disk token, so
    // the file stayed on disk, still marked kept — and a second boot re-read it and re-armed D's real
    // quarantine, even though the human clear had reported success.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("humanclearfinal");
    const realToken = enterMergeQuarantine(d, "real-branch", "D's real reason — must not re-arm after a readable human clear");
    const kd = canonicalRepoLockKey(d);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    check("(precondition) D's own final latch file exists", fs.existsSync(dFinal));

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    check("(precondition) the injected read failure was actually hit at least once", inject.count() >= 1);
    check("(precondition) D is pending/fail-closed after the unreadable boot", !!boot1.listActiveMergeQuarantines().find((e) => e.repoPath === d));
    inject.restore(); // the glitch clears BEFORE the human clear runs — final is genuinely readable now.

    const clearResult = boot1.clearMergeQuarantineReporting(d);
    check("the human full clear reports D no longer quarantined", clearResult?.wasQuarantined === true);
    check("*** THE FIX *** the clear does NOT report latchKept (the stale mark discharged, not just lifted in memory)", !clearResult?.latchKept);
    check("*** THE FIX *** D's final latch file is actually REMOVED by the clear (not left on disk, still marked kept)", !fs.existsSync(dFinal));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    check("*** THE FIX (boot2) *** D is NOT re-quarantined — the real human clear stays stuck", !boot2.activeMergeQuarantineFor(d));
    check("(sanity) D's real raise token is not resurrected anywhere on disk", !fs.existsSync(MERGE_QUARANTINE_DIR) || !fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).tokens?.includes(realToken); } catch { return false; }
    }));

  } else if (scenarioName === "human-clear-after-unreadable-tmp-readable-does-not-rearm") {
    // The TMP-residue twin of the scenario above: PASS 1b's own `.json.tmp-<pid>` residue (D never wrote a
    // clean FINAL at all) is what's marked unreadable at boot, so the identity's own pending placeholder
    // self-references the TMP file as `sourceFile` — the same `sweepOwnLatchFileUnlessOwnedElsewhere`
    // chokepoint this card fixes, reached via `clearMergeQuarantineByKey`'s pending "remove" sweep instead
    // of `deleteMergeQuarantineLatchByKey`'s own final-file check (which never even runs here — D's
    // canonical `.json` never existed).
    const d = makeRealRepo("humancleartmp");
    const kd = canonicalRepoLockKey(d);
    const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-999002`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const realToken = "real-tmp-token-656fdf39";
    const realEntry = {
      repoPath: d, branch: "real-tmp-branch", reason: "D's real tmp reason — must not re-arm after a readable human clear",
      enteredAt: Date.now(), tokens: [realToken],
    };
    fs.writeFileSync(dTmp, JSON.stringify(realEntry, null, 2) + "\n");

    const inject = injectReadFailure(dTmp, "EMFILE");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    check("(precondition, tmp) the injected read failure was actually hit", inject.count() >= 1);
    // @decision 702b4241 (round 2) — read via listActiveMergeQuarantines (a pure read), NEVER
    // activeMergeQuarantineFor here: the latter GRADUATES the pending placeholder (attempting, and here
    // failing, a durable write while the tmp is still injected-unreadable) as a side effect, which would
    // leave D's in-memory state in a DIFFERENT shape than the plain pending-only one this scenario means
    // to exercise through clearMergeQuarantineByKey's pending sweep.
    check("(precondition, tmp) D is pending/fail-closed (tmp shape) after the unreadable boot", !!boot1.listActiveMergeQuarantines().find((e) => e.repoPath === d));
    inject.restore(); // the glitch clears BEFORE the human clear runs — the tmp residue is readable now.

    const clearResult = boot1.clearMergeQuarantineReporting(d);
    check("the human full clear reports D no longer quarantined (tmp shape)", clearResult?.wasQuarantined === true);
    check("*** THE FIX (tmp) *** the clear does NOT report latchKept (the stale mark discharged, not just lifted in memory)", !clearResult?.latchKept);
    check("*** THE FIX (tmp) *** D's tmp residue file is actually REMOVED by the clear (not left on disk, still marked kept)", !fs.existsSync(dTmp));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    check("*** THE FIX (boot2, tmp) *** D is NOT re-quarantined — the real human clear stays stuck", !boot2.activeMergeQuarantineFor(d));
    check("(sanity, tmp) D's real raise token is not resurrected anywhere on disk", !fs.existsSync(MERGE_QUARANTINE_DIR) || !fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).tokens?.includes(realToken); } catch { return false; }
    }));

  } else if (scenarioName === "human-clear-by-id-reingested-ambiguous-union-refuses") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review 66fad7ed, B2. D's final latch is a genuine, pre-existing AMBIGUOUS UNION on disk
    // (repoPath D, BOTH tokenA and tokenB, provenanceUnknown:true — exactly the shape db0a9db0's own
    // clear-by-id refusal exists to protect) — but it is marked unreadable at boot, so the in-memory
    // record self-referencing it is boot's own blank PLACEHOLDER (no provenanceUnknown of its own at
    // all). Round 1's identity-only discharge would have unlinked this the moment it became readable,
    // silently losing tokenB. The fix: reconcile the placeholder with the real on-disk content BEFORE
    // the clear-by-id ambiguity check runs, so the real provenanceUnknown marker is visible to it, and
    // the EXISTING db0a9db0 refusal fires correctly instead.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("b2union");
    const tokenA = "token-a-b2union";
    const tokenB = "token-b-b2union";
    const kd = canonicalRepoLockKey(d);
    const idHash = hashForKey(kd);
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${idHash}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own genuine union with a second raiser, pre-existing on disk",
      enteredAt: Date.now(), tokens: [tokenA, tokenB], provenanceUnknown: true,
    }, null, 2) + "\n");

    const inject = injectReadFailure(dFinal, "EACCES");
    const boot1 = await freshBootModule();
    boot1.reenterMergeQuarantinesAtBoot([d]);
    check("(precondition) the injected read failure was actually hit", inject.count() >= 1);
    check("(precondition) D is pending/fail-closed after the unreadable boot", !!boot1.listActiveMergeQuarantines().find((e) => e.repoPath === d));
    inject.restore(); // the glitch clears BEFORE the clear-by-id call runs — final is genuinely readable now.

    const clearIdResult = boot1.clearMergeQuarantineLatchFile(idHash);
    check("*** THE FIX (B2) *** clear-by-id is REFUSED (ambiguous union), never a silent unlink", clearIdResult?.ok === false);
    check("*** THE FIX (B2) *** the refusal names the incomplete-provenance reason", typeof clearIdResult?.reason === "string" && clearIdResult.reason.includes("provenance"));
    const afterBytes = fs.readFileSync(dFinal, "utf8");
    check("*** THE FIX (B2) *** D's final latch file is BYTE-IDENTICAL (never unlinked)", JSON.parse(afterBytes).tokens.includes(tokenA) && JSON.parse(afterBytes).tokens.includes(tokenB));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const freshTokens = new Set(boot2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (B2, reboot) *** tokenA SURVIVES", freshTokens.has(tokenA));
    check("*** THE FIX (B2, reboot) *** tokenB SURVIVES (never destroyed as collateral)", freshTokens.has(tokenB));

  } else if (scenarioName === "656fdf39-round3-b1y-token-clear-old-tok-survives") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review d1e02886 (round 3), BLOCKING 1 / reviewer probe-b1y. Round 2 put the re-ingest at the
    // TOP of clearMergeQuarantineByKey — a SHARED unit a TOKEN-scoped clear also reaches
    // (clearMergeQuarantineByToken -> clearActiveEntryTokenAtKey's own full-lift ->
    // clearMergeQuarantineByKey). F is a genuine, pre-existing final latch holding OLD-TOK. A fresh raise
    // (t2) for the SAME identity is still placeholder-shaped (as `divertRaiseEntry`'s own merge — and a
    // later lazy-graduation attempt whose write to F fails while F is marked unreadable — would leave it:
    // `branch`/`placeholder` still carry the boot placeholder's own shape even though it now holds t2 as
    // a REAL token, round 5 of 702b4241's own documented behavior) by the time F becomes readable again.
    // A TOKEN-scoped clear of t2 reduces that entry to zero tokens and reaches clearMergeQuarantineByKey's
    // own full-lift path. Pre-fix (round 2), the unconditional re-ingest adopted OLD-TOK from F into the
    // entry being cleared, made the coverage proof pass TRIVIALLY, and F was unlinked — losing OLD-TOK.
    // *** THE FIX (round 3) *** — `identityWideHumanClear` is `false` on this path (never threaded from a
    // token-scoped clear), so F is never re-ingested; the pre-existing coverage proof correctly refuses
    // (OLD-TOK is not one of t2's own tokens), F survives on disk, and OLD-TOK is still outstanding after
    // a reboot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("b1y");
    const kd = canonicalRepoLockKey(d);
    const oldTok = "OLD-TOK-b1y-656fdf39";
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, JSON.stringify({
      repoPath: d, branch: "rb", reason: "old", enteredAt: Date.now() - 30000, tokens: [oldTok], resolvedKey: kd,
    }, null, 2) + "\n");

    const boot1 = await freshBootModule();
    boot1.markLatchFileUnreadableTestOnly(path.basename(dFinal));
    const t2 = "t2-fresh-raise-656fdf39";
    // Directly arms the shape a fresh raise + lazy-graduation attempt leaves while F is marked
    // unreadable: still placeholder-shaped (branch/placeholder unchanged — the durable write to F never
    // succeeded), but holding t2 as a REAL, already-outstanding token.
    boot1.setActiveQuarantineTestOnly(kd, {
      repoPath: d, branch: boot1.PLACEHOLDER_BRANCH_UNREADABLE, reason: "fresh", enteredAt: Date.now(),
      tokens: [t2], placeholder: true,
    });
    check("(precondition) F still carries OLD-TOK on disk right before the token clear", JSON.parse(fs.readFileSync(dFinal, "utf8")).tokens.includes(oldTok));

    boot1.clearMergeQuarantineByToken(d, t2);

    check("*** THE FIX (round 3) *** F still EXISTS on disk after the token-scoped clear (never unlinked)", fs.existsSync(dFinal));
    check("*** THE FIX (round 3) *** F's own OLD-TOK is UNCHANGED (never lost as collateral)", fs.existsSync(dFinal) && JSON.parse(fs.readFileSync(dFinal, "utf8")).tokens.includes(oldTok));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const freshTokens2 = new Set(boot2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 3, reboot) *** OLD-TOK is STILL outstanding after a reboot", freshTokens2.has(oldTok));

  } else if (scenarioName === "656fdf39-round3-orphan-collision-never-silently-dropped") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review d1e02886 (round 3), BLOCKING 2. reconcileClearedEntryIfPlaceholder's own `...reingested`
    // spread OVERWROTE (never unioned) orphanLatchFiles/contributorRepoPaths with disk's (which has
    // neither) — so a genuinely outstanding pending-divert "collision" file this identity's own in-memory
    // placeholder still references via orphanLatchFiles was silently dropped from the reconciled entry
    // BEFORE clearMergeQuarantineByKey ever reads it to build its own `orphanFilesToSweep` set. A human
    // full clear then reported CLEAN SUCCESS while the collision file survived on disk, unswept, still
    // holding a real outstanding token — and the NEXT boot re-armed this identity from it.
    // *** THE FIX (round 3) *** — orphanLatchFiles is now UNIONED (entry's own retained, never dropped),
    // so the collision file is correctly swept as part of this SAME clear (its own token is already one
    // of the entry's own, now-unioned tokens) — never clean success with the file surviving.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("orphancollision");
    const kd = canonicalRepoLockKey(d);
    const oldTok = "OLD-TOK-orphancollision-656fdf39";
    const collisionTok = "COLLISION-TOK-orphancollision-656fdf39";
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "old-raise", enteredAt: Date.now() - 30000, tokens: [oldTok],
    }, null, 2) + "\n");
    const collisionFile = `pending-${hashForKey(`${d}-collision`)}.json`;
    const collisionPath = path.join(MERGE_QUARANTINE_DIR, collisionFile);
    fs.writeFileSync(collisionPath, JSON.stringify({
      repoPath: d, branch: "d-branch-2", reason: "collision-raise", enteredAt: Date.now(), tokens: [collisionTok],
    }, null, 2) + "\n");

    const boot1 = await freshBootModule();
    boot1.markLatchFileUnreadableTestOnly(path.basename(dFinal));
    // Directly arms the shape a fresh raise + lazy-graduation attempt leaves while F is marked
    // unreadable: still placeholder-shaped, holding the collision raise's own REAL token, and still
    // referencing its own diverted collision file via orphanLatchFiles (the write-fails-folds-to-orphan
    // shape 188b145f/8a1bc2ef's own decision records describe).
    boot1.setActiveQuarantineTestOnly(kd, {
      repoPath: d, branch: boot1.PLACEHOLDER_BRANCH_UNREADABLE, reason: "collision-raise", enteredAt: Date.now(),
      tokens: [collisionTok], placeholder: true, orphanLatchFiles: [collisionFile],
    });
    check("(precondition) the collision file exists on disk right before the clear", fs.existsSync(collisionPath));

    const clearResult = boot1.clearMergeQuarantineReporting(d);
    const cleanSuccess = clearResult?.wasQuarantined === true && !clearResult?.latchKept;
    const collisionSurvives = fs.existsSync(collisionPath);
    check(
      "*** THE FIX (round 3) *** never clean success WITH the collision file surviving (either swept, or reported latchKept)",
      !(cleanSuccess && collisionSurvives),
    );

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    check("*** THE FIX (round 3, reboot) *** D is NOT re-armed from a surviving, unswept collision file", !boot2.activeMergeQuarantineFor(d));

  } else if (scenarioName === "656fdf39-round3-contributor-repo-paths-placeholder-clear-by-id-refuses") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review d1e02886 (round 3), SHOULD-FIX. reconcileClearedEntryIfPlaceholder's own `...reingested`
    // spread also OVERWROTE (never unioned) `contributorRepoPaths` — an in-memory-only marker (another
    // raiser's own identity folded into this union at RUNTIME, 82032b5c) that the on-disk bytes never
    // carried, and that db0a9db0/82032b5c's own clear-by-id ambiguity refusal depends on seeing.
    // *** THE FIX (round 3) *** — contributorRepoPaths is now UNIONED (entry's own retained), so the
    // refusal still fires correctly even though disk itself carries no such marker.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("contribplaceholder");
    const kd = canonicalRepoLockKey(d);
    const idHash = hashForKey(kd);
    const tokenA = "token-a-contribplaceholder";
    const dFinal = path.join(MERGE_QUARANTINE_DIR, `${idHash}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dFinal, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "old-raise", enteredAt: Date.now() - 30000, tokens: [tokenA],
    }, null, 2) + "\n");

    const boot1 = await freshBootModule();
    boot1.markLatchFileUnreadableTestOnly(path.basename(dFinal));
    // Directly arms the shape a SECOND, different identity's own raise folded into at RUNTIME while F was
    // marked unreadable (82032b5c's `existing`-branch absorb) leaves: still placeholder-shaped, but
    // carrying the OTHER identity's own repoPath in contributorRepoPaths — a marker disk itself never had.
    boot1.setActiveQuarantineTestOnly(kd, {
      repoPath: d, branch: boot1.PLACEHOLDER_BRANCH_UNREADABLE, reason: "folded-sibling", enteredAt: Date.now(),
      tokens: [tokenA], placeholder: true, contributorRepoPaths: ["/some/other/repo-656fdf39"],
    });

    const clearIdResult = boot1.clearMergeQuarantineLatchFile(idHash);
    check("*** THE FIX (round 3) *** clear-by-id is REFUSED (contributorRepoPaths ambiguity), never a silent unlink", clearIdResult?.ok === false);
    check("*** THE FIX (round 3) *** D's final latch file is BYTE-IDENTICAL (never unlinked)", fs.existsSync(dFinal) && JSON.parse(fs.readFileSync(dFinal, "utf8")).tokens.includes(tokenA));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const freshTokens3 = new Set(boot2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 3, reboot) *** tokenA SURVIVES", freshTokens3.has(tokenA));

  } else if (scenarioName === "656fdf39-round4-m6-tmp-shape-active-token-clear-old-tok-survives") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review d19f0490 (round 4), M6. The reviewer's own probe (probe-tmp-tok.mjs) found round 3's
    // test coverage only proved the FINAL (`.json`) shape of BLOCKING 1 — a `.json.tmp-<pid>` residue
    // reaches `sweepTmpResidueForHashIfUnreferenced`'s own `&& identityWideHumanClear` gate through a
    // COMPLETELY DIFFERENT call path than `deleteMergeQuarantineLatchByKey`'s own final-file coverage
    // check (`markedFinalFullyCoveredByClear`) — and no existing scenario drove that path at all. Without
    // the gate (M6), the tmp residue's own OLD-TOK is adopted into the entry being token-cleared, the
    // coverage proof passes trivially, and the tmp is unlinked — destroying OLD-TOK as collateral.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("m6tmp");
    const kd = canonicalRepoLockKey(d);
    const oldTok = "OLD-TOK-m6tmp-d19f0490";
    const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-999`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dTmp, JSON.stringify({
      repoPath: d, branch: "rb", reason: "old", enteredAt: Date.now() - 30000, tokens: [oldTok], resolvedKey: kd,
    }, null, 2) + "\n");

    const boot1 = await freshBootModule();
    boot1.markLatchFileUnreadableTestOnly(path.basename(dTmp));
    const t2 = "t2-fresh-raise-m6tmp";
    // Same precondition shape as the round-3 B1y scenario, but the marked physical backing is a TMP
    // residue, not a FINAL — `sweepTmpResidueForHashIfUnreferenced`'s own gate, never
    // `deleteMergeQuarantineLatchByKey`'s final-file coverage check, is what this exercises.
    boot1.setActiveQuarantineTestOnly(kd, {
      repoPath: d, branch: boot1.PLACEHOLDER_BRANCH_UNREADABLE, reason: "fresh", enteredAt: Date.now(),
      tokens: [t2], placeholder: true,
    });
    check("(precondition) the TMP residue still carries OLD-TOK on disk right before the token clear", JSON.parse(fs.readFileSync(dTmp, "utf8")).tokens.includes(oldTok));

    boot1.clearMergeQuarantineByToken(d, t2);

    check("*** THE FIX (round 4, M6) *** the TMP residue still EXISTS on disk after the token-scoped clear (never unlinked)", fs.existsSync(dTmp));
    check("*** THE FIX (round 4, M6) *** the TMP residue's own OLD-TOK is UNCHANGED (never lost as collateral)", fs.existsSync(dTmp) && JSON.parse(fs.readFileSync(dTmp, "utf8")).tokens.includes(oldTok));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const freshTokensM6 = new Set(boot2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 4, M6, reboot) *** OLD-TOK is STILL outstanding after a reboot", freshTokensM6.has(oldTok));

  } else if (scenarioName === "656fdf39-round4-m2-pending-entry-token-clear-old-tok-survives") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review d19f0490 (round 4), M2. `clearTokenFromPendingIndices`'s own "remove" branch (reached
    // for a genuinely PENDING, non-twin entry whose full token set is being lifted) calls
    // `deleteMergeQuarantineLatchByKey` directly, with its own HARDCODED `false` — never threading
    // `identityWideHumanClear` from its caller (`clearMergeQuarantineByToken` has no identity-wide
    // authority of its own to thread). Without that `false` (M2's mutation: flip it to `true`), the SAME
    // tautological-adoption shape as BLOCKING 1 reopens, reached through THIS branch instead of
    // `clearActiveEntryTokenAtKey`'s.
    //
    // Constructs a genuinely PENDING (non-twin) entry — via the new `pushPendingQuarantineTestOnly` test
    // seam — holding `t2` ALONE, structurally tied to a SEPARATE active entry at the same key (also
    // holding only `t2`, so `entryStillOwnsKey`'s token-subset branch accepts the tie) — never the same
    // object reference, so `clearMergeQuarantineByToken`'s own twin-exclusion never routes it through
    // `clearActiveEntryTokenAtKey` instead.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const d = makeRealRepo("m2pending");
    const kd = canonicalRepoLockKey(d);
    const oldTok = "OLD-TOK-m2pending-d19f0490";
    const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kd)}.json.tmp-999`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(dTmp, JSON.stringify({
      repoPath: d, branch: "rb", reason: "old", enteredAt: Date.now() - 30000, tokens: [oldTok], resolvedKey: kd,
    }, null, 2) + "\n");

    const boot1 = await freshBootModule();
    boot1.markLatchFileUnreadableTestOnly(path.basename(dTmp));
    const t2 = "t2-fresh-raise-m2pending";
    // A NORMAL (non-placeholder) active entry holding ONLY t2 — `entryStillOwnsKey`'s token-subset
    // branch needs `occupant.tokens` (this entry's) to be a subset of the PENDING entry's own tokens.
    boot1.setActiveQuarantineTestOnly(kd, {
      repoPath: d, branch: "d-branch-active", reason: "t2-raise", enteredAt: Date.now(), tokens: [t2],
    });
    // A DIFFERENT object, still placeholder-shaped (so reconciling it, if the gate is ever removed,
    // would adopt OLD-TOK from disk) — tied to the active entry above via `armedKeys`, never by
    // reference, so it lands in `clearTokenFromPendingIndices`'s own non-twin set.
    boot1.pushPendingQuarantineTestOnly({
      repoPath: d, branch: boot1.PLACEHOLDER_BRANCH_UNREADABLE, reason: "t2-raise-pending-twin", enteredAt: Date.now(),
      tokens: [t2], placeholder: true, armedKeys: [kd],
    }, path.basename(dTmp));
    check("(precondition) the TMP residue still carries OLD-TOK on disk right before the token clear", JSON.parse(fs.readFileSync(dTmp, "utf8")).tokens.includes(oldTok));

    boot1.clearMergeQuarantineByToken(d, t2);

    check("*** THE FIX (round 4, M2) *** the TMP residue still EXISTS on disk after the token-scoped clear (never unlinked)", fs.existsSync(dTmp));
    check("*** THE FIX (round 4, M2) *** the TMP residue's own OLD-TOK is UNCHANGED (never lost as collateral)", fs.existsSync(dTmp) && JSON.parse(fs.readFileSync(dTmp, "utf8")).tokens.includes(oldTok));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([d]);
    const freshTokensM2 = new Set(boot2.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 4, M2, reboot) *** OLD-TOK is STILL outstanding after a reboot", freshTokensM2.has(oldTok));

  } else {
    throw new Error(`unknown scenario ${scenarioName}`);
  }
} finally {
  // Test-only reset: the quarantine dir is shared across every scenario IN THIS ONE PROCESS (the
  // production LOOM_HOME const is frozen at this process's first module import) — but each scenario here
  // already runs in its OWN child process (driver mode above), so this is purely defensive.
  try { fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exitCode = failures === 0 ? 0 : 1;
