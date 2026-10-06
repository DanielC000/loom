import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs) — MUST be the
// FIRST import in this file, before any other import (including the other local helpers below), so
// LOOM_TEST is armed before anything transitively touches real state.
// Board card f5c42043, from the 882d6cff round-3 Code Review (reviewer 5339b48f, 2026-10-06).
// PRE-EXISTING (measured with a single claimant — predates 882d6cff; its "keep every claimant" rule
// only widens how often it is hit). `reenterMergeQuarantinesAtBoot`'s TWO matching tiers for a
// corrupt/unparsable latch (`hashToRepo`: fresh/legacy identity; `unresolvedClaimantsByHash`: a
// CURRENTLY-unresolvable path's own degraded walk) share one blind spot: NEITHER has any memory of the
// hash a registered path (or an intermediate ancestor between it and the walk's old landing spot) would
// have produced via a degraded walk BEFORE it (or that ancestor) had its own `.git`. Once a claimant
// transitions from "unresolvable, degraded-walks to some ancestor Y" to "resolvable, with its OWN
// different toplevel" (the realistic "a removable drive/repo came back" case — `git init` inside what
// used to be a plain absent subdir), its corrupt latch's stale filename hash can never again be matched
// by either tier — it falls to the PASS 2 orphan sweep, which fail-closes EVERY registered repo,
// including a wholly unrelated Z. Violates @decision 7673d096 (one repo's unmatched latch must never
// fall to the every-repo sweep).
//
// THE FIX — @decision f5c42043: a THIRD, LOWEST-precedence matching tier, `ancestorHashToRepo`, built
// for EVERY registered path regardless of its OWN current resolvability: the toplevel hash of EVERY
// STRICT ancestor directory of that path (not just `dirname(p)` — a remount can be TWO OR MORE levels
// above the registered path itself; see the `two-levels-up` scenario below). Consulted ONLY when
// `hashToRepo` and `unresolvedClaimantsByHash` both miss, at both PASS 1's (`.json` final) and PASS 1b's
// (`.json.tmp-<pid>` residue) corrupt-latch lookup sites. A match is ALWAYS a pure pending-divert — an
// ancestor-walk match is never proof of ownership (Lead ruling), so it never writes/arms anywhere; it
// just stops the latch from reaching the orphan sweep. The REAL verified-key write happens later, via
// the EXISTING, unchanged lazy-graduation path (`activeMergeQuarantineFor`) the moment anything genuinely
// queries the now-resolvable claimant — which also durably deletes the stale source file once nothing
// else needs it (`deleteSourceLatchIfSuperseded`'s own existing sibling-awareness, unchanged).
//
// A SEPARATE, SMALLER FIX rides along: `clearMergeQuarantineByKey` (the RESOLVABLE branch `clearMerge-
// Quarantine` delegates to) swept a cleared claimant's own pending `sourceFile` via `sweepOwnLatchFile-
// UnlessOwnedElsewhere` but DISCARDED its `{kept, referencingRepoPaths}` return value outright — so
// clearing ONE claimant of a shared-but-still-pending latch (reachable the moment EITHER claimant in a
// multi-claimant ancestor-tier divert becomes resolvable) reported a bare, unqualified success instead
// of round 4's own `latchKept`/`referencingRepoPaths` signal. Fixed by capturing and surfacing it,
// mirroring `clearMergeQuarantineByRecordedPath`'s existing pattern for the UNRESOLVABLE branch — never
// inventing new semantics, just propagating what was already being computed.
//
// See docs/decisions/f5c42043-ancestor-walk-ghost-hash-pending-divert.md for the full repro + design
// rationale, including why `clearMergeQuarantineReporting` (the REST-route-facing wrapper) never
// surfaces `latchKept` for THIS shape even though `clearMergeQuarantine` called directly does — its own
// eager `before = resolveQuarantineFor(repoPath)` snapshot graduates a resolvable claimant BEFORE the
// clear logic ever runs, so by the time `clearMergeQuarantineByKey` looks, there is nothing pending left
// to find — a real, not-invented nuance, not a bug.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver:
// run with no args to spawn one child per scenario; a child reads `--scenario=<name>` off argv.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-ancestor-tier-pending-divert.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "own-repo-remount-json",
  "own-repo-remount-tmp",
  "two-levels-up-ancestor-match",
  "multi-claimant-both-remount",
  "multi-claimant-graduation-one-leaves-other-pending",
  "graduation-writes-own-key-and-deletes-stale",
  "clear-by-path-while-pending-no-resurrect",
  "clear-by-latch-id-while-pending-no-resurrect",
  "multi-claimant-clear-one-reports-latch-kept",
  "negative-genuinely-unmatched-still-sweeps",
  "regression-shape-ii-enclosing-git-removed",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
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
    ? "\n✅ ALL SCENARIOS PASS — a claimant that remounted as its own git toplevel (never a plain subdir "
      + "sharing its ancestor's key), even never queried before a restart, never falls through to the "
      + "PASS 2 every-repo sweep; a genuinely unmatched latch still correctly does."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card f5c42043.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqatpd-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
  listActiveMergeQuarantines, clearMergeQuarantine, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqatpd@loom -c user.name=mqatpd";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function freshHashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepo(prefix) {
  const dir = path.join(os.tmpdir(), `loom-mqatpd-${prefix}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${prefix}\n`);
  execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "own-repo-remount-json") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE CORE REPRO — Y (never registered) + W1 = Y/a (absent at boot), corrupt FINAL filed at Y's own
    // degraded key sha(Ky). W1 remounts as its OWN git repo (its fresh key genuinely differs from Ky now)
    // but is NEVER QUERIED before a restart. Pre-fix: the stale Ky hash matches neither hashToRepo nor
    // unresolvedClaimantsByHash once W1 is resolvable — orphan — Z BLOCKED. Post-fix: the ancestor tier
    // still finds it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-orm");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a"); // absent at boot 1
    const z = makeRepo("z-orm");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");
    check("(precondition) W1 is genuinely absent", !fs.existsSync(w1));

    reenterMergeQuarantinesAtBoot([w1, z]); // Y deliberately NOT registered
    check("(boot 1) Z is NOT quarantined", activeMergeQuarantineFor(z) === undefined);
    check("(boot 1) W1 diverted pending", !!listActiveMergeQuarantines().find((q) => q.repoPath === w1));

    // Remount W1 as its OWN git repo — never queried.
    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1 own repo\n");
    commitAll(w1, "init", GIT_ID);
    const Kw1 = canonicalRepoLockKey(w1);
    check("(precondition) W1's fresh key now DIFFERS from Ky", Kw1 !== Ky);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** THE FIX *** Z is NOT quarantined after a restart with W1 never queried", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("(boot 2) W1 still attributes (ancestor-tier divert)", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(boot 2) corrupt file left AS WRITTEN (no write at an unverified key)", fs.readFileSync(corruptPath, "utf8") === "{");

    // Stable across a further restart too.
    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, z]);
    check("(boot 3) Z STILL not quarantined", fresh2.activeMergeQuarantineFor(z) === undefined);
    check("(boot 3) corrupt file STILL AS WRITTEN (no accumulation)", fs.readFileSync(corruptPath, "utf8") === "{");
  } else if (scenarioName === "own-repo-remount-tmp") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Site C's own twin — the corrupt latch is a `.json.tmp-<pid>` residue, not a final.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-ormt");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const z = makeRepo("z-ormt");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json.tmp-999-feedbead`);
    fs.writeFileSync(corruptTmpPath, "");

    reenterMergeQuarantinesAtBoot([w1, z]);
    check("(boot 1) Z is NOT quarantined", activeMergeQuarantineFor(z) === undefined);

    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1 own repo\n");
    commitAll(w1, "init", GIT_ID);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** THE FIX *** Z is NOT quarantined (tmp shape)", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("(boot 2) W1 diverted pending", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(boot 2) tmp residue left untouched", fs.existsSync(corruptTmpPath));
  } else if (scenarioName === "two-levels-up-ancestor-match") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Lead ruling (Call 2) — `dirname(p)` ALONE is not enough. W1 = Y/a/b: Y/a (W1's own PARENT) remounts
    // as its OWN git repo, but the corrupt latch was filed under Y's key (TWO levels above W1), from when
    // the whole Y/a/b chain was absent. `ancestorToplevelHashes(W1)` must walk every strict ancestor, not
    // just the immediate parent, or this still falls through to the orphan sweep.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-2up");
    const Ky = canonicalRepoLockKey(y);
    const ya = path.join(y, "a"); // W1's own PARENT — absent at boot 1
    const w1 = path.join(ya, "b"); // the REGISTERED path — two levels below Y
    const z = makeRepo("z-2up");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");
    check("(precondition) W1 and its parent Y/a are both absent", !fs.existsSync(ya) && !fs.existsSync(w1));

    reenterMergeQuarantinesAtBoot([w1, z]);
    check("(boot 1) Z is NOT quarantined", activeMergeQuarantineFor(z) === undefined);
    check("(boot 1) W1 diverted pending", !!listActiveMergeQuarantines().find((q) => q.repoPath === w1));

    // Y/a (W1's PARENT, not W1 itself) remounts as its OWN git repo; W1 = Y/a/b now exists too (a plain
    // subdir of Y/a, no own .git) — `dirname(w1)` is Y/a, whose own fresh key is NOT Ky.
    fs.mkdirSync(ya, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: ya });
    fs.writeFileSync(path.join(ya, "README.md"), "# Y/a own repo\n");
    commitAll(ya, "init", GIT_ID);
    fs.mkdirSync(w1, { recursive: true });
    const Kya = canonicalRepoLockKey(ya);
    check("(precondition) dirname(W1)'s own key differs from Ky — dirname ALONE would miss this", Kya !== Ky);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** THE FIX *** Z is NOT quarantined (two-levels-up ancestor match)", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("(boot 2) W1 still diverted pending (matched via Y, not just Y/a)", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
  } else if (scenarioName === "multi-claimant-both-remount") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Lead ruling — the ancestor tier must be multi-claimant too, never a single winner. W1 and W2 both
    // remount as SEPARATE own git repos, both sharing Y as a strict ancestor; the one corrupt latch at
    // sha(Ky) must divert to BOTH, never just one.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-multi");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const w2 = path.join(y, "b");
    const z = makeRepo("z-multi");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(corruptPath, "{");

    reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("(boot 1) Z is NOT quarantined", activeMergeQuarantineFor(z) === undefined);

    for (const [dir, label] of [[w1, "w1"], [w2, "w2"]]) {
      fs.mkdirSync(dir, { recursive: true });
      execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: dir });
      fs.writeFileSync(path.join(dir, "README.md"), `# ${label} own repo\n`);
      commitAll(dir, "init", GIT_ID);
    }

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("*** THE FIX *** Z is NOT quarantined (multi-claimant own-repo remount)", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("(boot 2) W1 diverted pending", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(boot 2) W2 ALSO diverted pending — never just one winner", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w2));
  } else if (scenarioName === "multi-claimant-graduation-one-leaves-other-pending") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review 2dd4401e, item 3 — W1 and W2 both diverted on Ky. Querying ONLY W1 graduates it to its
    // own real key Kw1; Ky must SURVIVE (W2 still needs it) and W2 must STILL read as blocked. On a
    // RESTART, PIN the exact, measured (not assumed) outcome: W1 RE-DIVERTS from Ky too, appearing TWICE
    // in listActiveMergeQuarantines() (its own real entry at Kw1, PLUS a duplicate ancestor-tier pending
    // entry referencing Ky) — because `ancestorToplevelHashes` indexes every registered path's ancestors
    // regardless of THAT path's own current resolvability, so W1 (now resolvable) still counts as an
    // ancestor-tier claimant of Ky for as long as Ky's file itself survives. This is harmless for
    // ENFORCEMENT (activeMergeQuarantineFor(W1) finds the real `direct` entry at Kw1 first and never
    // touches the duplicate pending one) but is a real, measured diagnostic-listing duplication — never
    // read as "never both" or "only one entry" without re-checking.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-mcgp");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const w2 = path.join(y, "b");
    const z = makeRepo("z-mcgp");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("(precondition) W1 diverted pending", !!listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(precondition) W2 diverted pending", !!listActiveMergeQuarantines().find((q) => q.repoPath === w2));

    for (const [dir, label] of [[w1, "w1"], [w2, "w2"]]) {
      fs.mkdirSync(dir, { recursive: true });
      execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: dir });
      fs.writeFileSync(path.join(dir, "README.md"), `# ${label}\n`);
      commitAll(dir, "init", GIT_ID);
    }
    const Kw1 = canonicalRepoLockKey(w1);
    const Kw1Path = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kw1)}.json`);

    // Query ONLY W1 — graduates it. Never query W2 directly (that would itself graduate W2 too, defeating
    // the scenario) — use the non-mutating listing to observe W2's state instead.
    const graduatedW1 = activeMergeQuarantineFor(w1);
    check("W1 graduates (returns an entry)", !!graduatedW1);
    check("W1's resolvedKey is its OWN key Kw1", graduatedW1?.resolvedKey === Kw1);
    check("Kw1 file now exists", fs.existsSync(Kw1Path));
    check("*** Ky SURVIVES — W2 still needs it ***", fs.existsSync(KyPath));
    check("*** W2 is STILL listed pending (non-mutating check) ***", !!listActiveMergeQuarantines().find((q) => q.repoPath === w2));

    // RESTART — pin the exact measured outcome for W1.
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, w2, z]);
    const listingAfterRestart = fresh1.listActiveMergeQuarantines();
    const w1EntriesAfterRestart = listingAfterRestart.filter((q) => q.repoPath === w1);
    check("*** PINNED: W1 appears TWICE after restart (its own real entry + a re-diverted ancestor-tier pending one) ***", w1EntriesAfterRestart.length === 2);
    check("(of the two) exactly one carries W1's own resolvedKey (the real, graduated entry)", w1EntriesAfterRestart.filter((q) => q.resolvedKey === Kw1).length === 1);
    check("(of the two) exactly one carries NO resolvedKey (the ancestor-tier re-divert)", w1EntriesAfterRestart.filter((q) => q.resolvedKey === undefined).length === 1);
    check("*** W2 STILL pending after restart ***", !!listingAfterRestart.find((q) => q.repoPath === w2));
    check("*** Z STILL open after restart ***", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("enforcement for W1 still correctly resolves via its OWN real key (never the duplicate pending one)", fresh1.activeMergeQuarantineFor(w1)?.resolvedKey === Kw1);
    check("Ky file STILL survives after querying W1 again post-restart (W2 still needs it)", fs.existsSync(KyPath));
  } else if (scenarioName === "graduation-writes-own-key-and-deletes-stale") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // LIFECYCLE (a)+(b), per the Lead ruling: W1 stays BLOCKED (fail-closed) at every boot until
    // queried/cleared, Z stays open throughout; the FIRST genuine query graduates W1 to its own verified
    // key AND durably deletes the stale Ky file — it must never survive to re-divert.
    //
    // NOTE: activeMergeQuarantineFor(w1) is BOTH the enforcement check AND the graduation trigger once
    // W1 is resolvable — querying it "to check if blocked" IS what graduates it. Use
    // listActiveMergeQuarantines() (non-mutating) to observe the still-pending, un-graduated state.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-grad");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const z = makeRepo("z-grad");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, z]);

    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1\n");
    commitAll(w1, "init", GIT_ID);
    const Kw1 = canonicalRepoLockKey(w1);
    const Kw1Path = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Kw1)}.json`);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("(a, boot 2) Z open", fresh1.activeMergeQuarantineFor(z) === undefined);
    check("(a, boot 2) W1 listed pending (never queried, not graduated)", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(a, boot 2) Ky file still exists", fs.existsSync(KyPath));
    check("(a, boot 2) Kw1 file does NOT exist yet", !fs.existsSync(Kw1Path));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, z]);
    check("(a, boot 3) Z STILL open", fresh2.activeMergeQuarantineFor(z) === undefined);
    check("(a, boot 3) W1 STILL listed pending (stable across restarts)", !!fresh2.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(a, boot 3) Ky file stable (not accumulating)", fs.existsSync(KyPath));

    // THE FIRST genuine enforcement query — graduates W1.
    const fresh3 = await freshBootModule();
    fresh3.reenterMergeQuarantinesAtBoot([w1, z]);
    const graduated = fresh3.activeMergeQuarantineFor(w1);
    check("(b) graduation returns an entry", !!graduated);
    check("(b) graduated entry's resolvedKey is W1's OWN verified key", graduated?.resolvedKey === Kw1);
    check("(b) Kw1 file NOW exists", fs.existsSync(Kw1Path));
    check("*** (b) Ky file is GONE — never re-divert bait ***", !fs.existsSync(KyPath));
    check("(b) Z STILL open after graduation", fresh3.activeMergeQuarantineFor(z) === undefined);

    const fresh4 = await freshBootModule();
    fresh4.reenterMergeQuarantinesAtBoot([w1, z]);
    check("(b, boot 5) W1 still blocked via its OWN real key after a restart", !!fresh4.activeMergeQuarantineFor(w1));
    check("(b, boot 5) Z STILL open", fresh4.activeMergeQuarantineFor(z) === undefined);
    check("(b, boot 5) Ky file did not come back", !fs.existsSync(KyPath));
  } else if (scenarioName === "clear-by-path-while-pending-no-resurrect") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // LIFECYCLE (c), by path — clearing W1 WHILE STILL PENDING (never queried, so never graduated) must
    // lift it, sweep the Ky source file (single claimant — nothing else references it), and W1 must stay
    // open across a restart. Z stays open throughout.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-cbp");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const z = makeRepo("z-cbp");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, z]);

    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1\n");
    commitAll(w1, "init", GIT_ID);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("(precondition) W1 diverted pending, never queried", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));

    const clearResult = fresh1.clearMergeQuarantine(w1); // clear BY PATH while still pending
    check("(c) clear reports wasQuarantined", clearResult?.wasQuarantined !== false);
    check("(c) clear lifts W1's pending entry in-process", !fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(c) clear sweeps the Ky source file", !fs.existsSync(KyPath));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** NO RESURRECTION *** W1 stays OPEN after clear + restart", fresh2.activeMergeQuarantineFor(w1) === undefined);
    check("Z stays open throughout", fresh2.activeMergeQuarantineFor(z) === undefined);
  } else if (scenarioName === "clear-by-latch-id-while-pending-no-resurrect") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // LIFECYCLE (c), by the latch's own 24-hex id — the durable-escape route, while still pending.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-cbl");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const z = makeRepo("z-cbl");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyHash = freshHashForKey(Ky);
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${KyHash}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, z]);

    fs.mkdirSync(w1, { recursive: true });
    execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: w1 });
    fs.writeFileSync(path.join(w1, "README.md"), "# W1\n");
    commitAll(w1, "init", GIT_ID);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    const clearResult = fresh1.clearMergeQuarantineLatchFile(KyHash);
    check("(c) clear-by-latch-id reports ok+wasQuarantined", clearResult.ok === true && clearResult.wasQuarantined === true);
    check("(c) clear-by-latch-id lifts W1's pending entry", !fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(c) clear-by-latch-id sweeps the Ky file", !fs.existsSync(KyPath));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** NO RESURRECTION *** W1 stays OPEN", fresh2.activeMergeQuarantineFor(w1) === undefined);
    check("Z stays open", fresh2.activeMergeQuarantineFor(z) === undefined);
  } else if (scenarioName === "multi-claimant-clear-one-reports-latch-kept") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // LIFECYCLE (c), multi-claimant — clearing ONE of two still-pending claimants sharing a latch must
    // report round 4's own `latchKept`/`referencingRepoPaths` signal (never a bare unqualified success),
    // the shared file must SURVIVE (the other claimant still needs it), and on restart the documented,
    // round-4-established behavior holds: BOTH re-divert (nothing records that one was already cleared —
    // multi-claimant tombstoning is a separate card, not this one's job).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-mckl");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const w2 = path.join(y, "b");
    const z = makeRepo("z-mckl");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, w2, z]);

    for (const [dir, label] of [[w1, "w1"], [w2, "w2"]]) {
      fs.mkdirSync(dir, { recursive: true });
      execSync(`git init -q && git config user.email mqatpd@loom && git config user.name mqatpd`, { cwd: dir });
      fs.writeFileSync(path.join(dir, "README.md"), `# ${label}\n`);
      commitAll(dir, "init", GIT_ID);
    }

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("(precondition) W1 diverted pending", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(precondition) W2 diverted pending", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w2));

    // clearMergeQuarantineReporting (the REST-route wrapper) would itself graduate W1 first via its own
    // eager `before` snapshot, preempting the pending-sweep this scenario targets — call
    // clearMergeQuarantine DIRECTLY (as most of this suite's own cleanup calls already do) to exercise it.
    const clearResult = fresh1.clearMergeQuarantine(w1);
    check("*** THE FIX *** clearing W1 alone reports latchKept (round 4 pattern)", clearResult?.latchKept === true);
    check("*** THE FIX *** referencingRepoPaths names W2", (clearResult?.referencingRepoPaths ?? []).includes(w2));
    check("(multi) the shared Ky file SURVIVES (W2 still needs it)", fs.existsSync(KyPath));
    check("(multi) W1 lifted in-process", !fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(multi) W2 still pending", !!fresh1.listActiveMergeQuarantines().find((q) => q.repoPath === w2));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([w1, w2, z]);
    check("(documented, round 4) W1 re-diverts too (nothing recorded it was already cleared)", !!fresh2.listActiveMergeQuarantines().find((q) => q.repoPath === w1));
    check("(documented) W2 still diverts", !!fresh2.listActiveMergeQuarantines().find((q) => q.repoPath === w2));
    check("Z STILL open throughout", fresh2.activeMergeQuarantineFor(z) === undefined);
  } else if (scenarioName === "negative-genuinely-unmatched-still-sweeps") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // REQUIRED NEGATIVE CONTROL — a corrupt latch whose hash matches NO registered path's fresh, legacy,
    // degraded-unresolvable, OR ancestor-walk key must STILL reach the PASS 2 every-repo sweep. The new
    // tier must never weaken 7673d096's genuine fail-closed fallback for a TRULY unmatched latch.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w1 = makeRepo("w1-neg"); // resolvable, own repo — not an ancestor of anything relevant
    const z = makeRepo("z-neg");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // A hash that cannot possibly equal any of W1/Z's own fresh/legacy keys, nor any of their ancestors'
    // (a random, unrelated string — never derived from any real path in this scenario).
    const unrelatedHash = createHash("sha256").update(`totally-unrelated-${freshSfx()}`).digest("hex").slice(0, 24);
    const orphanPath = path.join(MERGE_QUARANTINE_DIR, `${unrelatedHash}.json`);
    fs.writeFileSync(orphanPath, "{");

    reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** NEGATIVE CONTROL *** a genuinely unmatched latch STILL sweeps W1", !!activeMergeQuarantineFor(w1));
    check("*** NEGATIVE CONTROL *** a genuinely unmatched latch STILL sweeps Z too (7673d096's real fallback, unweakened)", !!activeMergeQuarantineFor(z));
    const w1Entry = listActiveMergeQuarantines().find((q) => q.repoPath === w1);
    const zEntry = listActiveMergeQuarantines().find((q) => q.repoPath === z);
    check("(negative control) both entries reference the orphan file", (w1Entry?.orphanLatchFiles ?? []).some((f) => f.includes(unrelatedHash)) && (zEntry?.orphanLatchFiles ?? []).some((f) => f.includes(unrelatedHash)));
  } else if (scenarioName === "regression-shape-ii-enclosing-git-removed") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // REGRESSION (manager's shape ii) — Y's own `.git` is removed entirely (de-initialized) between the
    // original degraded walk and the restart, and W1 remounts as a PLAIN subdir (no own `.git`). This
    // still converges: `resolveGitToplevelSync`'s own "nothing found anywhere" fallback returns the
    // NEAREST EXISTING ancestor's own realpath UNCHANGED regardless of whether a `.git` was ever found
    // there — so `canonicalRepoLockKey(Y)` (an ancestor-tier candidate) still equals the original Ky.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = makeRepo("y-s2");
    const Ky = canonicalRepoLockKey(y);
    const w1 = path.join(y, "a");
    const z = makeRepo("z-s2");

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const KyPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(Ky)}.json`);
    fs.writeFileSync(KyPath, "{");
    reenterMergeQuarantinesAtBoot([w1, z]);
    check("(boot 1) Z open", activeMergeQuarantineFor(z) === undefined);

    fs.rmSync(path.join(y, ".git"), { recursive: true, force: true }); // Y is no longer a git repo at all
    fs.mkdirSync(w1, { recursive: true }); // W1 mounts as a PLAIN subdir — no own .git either
    const KwNow = canonicalRepoLockKey(w1);
    check("(precondition) W1's current key differs from Ky", KwNow !== Ky);

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([w1, z]);
    check("*** REGRESSION HOLDS *** Z is NOT quarantined (Y's own .git removed)", fresh1.activeMergeQuarantineFor(z) === undefined);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? "\n[scenario] all checks passed" : `\n[scenario] ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
