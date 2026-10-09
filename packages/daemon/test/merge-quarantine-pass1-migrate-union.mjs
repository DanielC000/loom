import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board cards 4480b077 + c870618c (from the round-2 Code Review of 8a1bc2ef, reviewers 2ae805f3/44742bf1,
// 2026-10-06) — two PRE-EXISTING defects in reenterMergeQuarantinesAtBoot's PASS 1 migrate branch.
//
// ROUND 1 of this card's own fix (union via armQuarantineKey immediately before each file's own write,
// gated on isKeyVerifiedFor) was itself found NOT mergeable by Code Review round 1 on this card: that
// gate only ever sees what's already been READ into byRepoKey so far in the SAME streaming pass — so (1)
// a stale sibling that sorts BEFORE a repo's own already-correct current latch still overwrites that
// latch before it's ever read, and (2) when the thing occupying a key is a degraded entry NOT YET seen
// this pass (so `priorAtKey` reads as empty), the gate wrongly treats the key as free and overwrites that
// degraded entry's own backing file.
//
// ROUND 2 (this file): restructured to COLLECT during the read pass and WRITE ONCE per key after it —
// the same pattern 92c645cc already uses for PASS 1b's own tmp recovery. See
// docs/decisions/4480b077-migrate-branch-unions-fresh-hash-target.md for the full round-2 narrative
// (what gets written per key, what happens to degraded constituents' files, crash-mid-write safety, and
// the interaction with PASS 1b) and docs/decisions/c870618c-migrate-branch-folds-failed-unlink.md for the
// N-source EBUSY-fold half.
//
// TERMINOLOGY: every scenario below that simulates "a later boot" does so via a FRESH, cache-busted
// `import()` of the compiled module in the SAME process (module-level state like `activeQuarantines` is
// then genuinely empty, mirroring what a real process start sees) — it is NOT an actual OS process
// restart. Checks and comments say "reboot-sim" for this, never "restart", so the wording matches what's
// actually being simulated.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver:
// run with no args to spawn one child per scenario; a child reads `--scenario=<name>` off argv and runs
// only that one scenario inline, exiting non-zero on any failure within it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-pass1-migrate-union.mjs
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
  "sibling-collapse-orderA", "sibling-collapse-orderB",
  "current-plus-stale-sibling-first",
  "ebusy-fold-and-sweep", "ebusy-no-injection-control", "stale-id-clear-keeps-folded-file",
  "migrate-source-collides-with-sibling-target",
  "degraded-receiver-guard", "union-with-degraded-in-memory",
  "in-memory-twin-clear-destroys-degraded-file",
  "in-memory-twin-clear-x-removes-safety-copy",
  "gone-subdir-reblocks-once-then-clearable",
  "foreign-nested-repo-quarantine-survives",
  "dual-collision-union-survives-second-protect",
  "reversed-tie-break-no-protection-report-only",
  "clear-by-id-refused-on-canonical-collision",
  "clear-by-id-ordinary-unchanged",
  "collision-refusal-text-names-clear-by-path",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with LOOM_HOME stripped from its env so
  // `useOwnLoomHome` (called inside the child) mints a genuinely fresh one; never share LOOM_HOME across
  // scenarios, or a residue left by one could mask or fake another's result.
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], {
        env: envWithoutLoomHome, stdio: "inherit",
      });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\n✅ ALL SCENARIOS PASS — PASS 1's migrate branch writes each key's union exactly once, after every "
      + "file (and every PASS 1b tmp) has been read, and never touches a key a degraded entry's own "
      + "trusted resolvedKey occupies."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board cards 4480b077/c870618c.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqp1mu-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, clearMergeQuarantine, clearMergeQuarantineLatchFile,
  quarantineLatchIdFor, MERGE_QUARANTINE_DIR, clearMergeQuarantineByRecordedPath, assertRepoNotQuarantined,
  clearMergeQuarantineByKey,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqp1mu@loom -c user.name=mqp1mu";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A fresh, cache-busted re-import of the compiled module in THIS SAME process — module-level state
// (`activeQuarantines`, `pendingUnresolvedQuarantines`) starts genuinely empty, the same as what a real
// process start would see. This is a REBOOT-SIM, never an actual OS process restart — see this file's
// own header.
let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Matches `quarantineHashForKey`'s own (unexported) formula exactly — the stable hash component of a
// quarantine latch's filename for a given canonical key.
function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Reproduces the OLD (pre-7673d096) key algorithm by hand — realpath + lowercase-on-win32 of the BOUND
// path directly, with no toplevel walk — the same technique merge-quarantine-key-migration.mjs's own
// `oldHashFor` uses. Produces a genuine 24-hex-char id (unlike an arbitrary filename), required by
// `clearMergeQuarantineLatchFile`'s own `QUARANTINE_LATCH_ID_PATTERN` check.
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return hashForKey(key);
}

function makeRepoWithTwoSubdirs(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqp1mu-repo-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  const teamB = path.join(repo, "teamB");
  fs.mkdirSync(teamA, { recursive: true });
  fs.mkdirSync(teamB, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(teamA, "a.txt"), "team a\n");
  fs.writeFileSync(path.join(teamB, "b.txt"), "team b\n");
  execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, teamA, teamB };
}

// P (a repo) with teamA (a plain subdir, no `.git` of its own — collapses onto P's own key Kp) and sub
// (its OWN SEPARATE nested repo, own `.git`, own real key Ksub != Kp) — same shape as
// merge-quarantine-pass1-degraded-union-guard.mjs's own `makeRepoWithNestedRepoAndSubdir`.
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqp1mu-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "sub");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

// Per 54054c01's own "Do not" (never assume fs.readdirSync's order; determine it empirically): write two
// placeholder files first, read back the ACTUAL order, then let the caller assign real content to
// "first-processed" / "second-processed" roles accordingly — never guessed from filenames alone.
function empiricalOrder(fileA, fileB) {
  fs.writeFileSync(fileA, "{}");
  fs.writeFileSync(fileB, "{}");
  const order = fs.readdirSync(path.dirname(fileA));
  const idxA = order.indexOf(path.basename(fileA));
  const idxB = order.indexOf(path.basename(fileB));
  return idxA < idxB ? [fileA, fileB] : [fileB, fileA]; // [firstProcessed, secondProcessed]
}

// Finding 1's own repro needs the STALE file to sort BEFORE a FIXED, hash-derived filename (the "current"
// latch) that is not under this test's control. Measured empirically (this file's own driver run):
// `fs.readdirSync` on this filesystem returns entries in plain alphabetical order, not creation order —
// so a leading `!` (ASCII 0x21, below every digit/letter a hex hash can start with) reliably sorts first
// regardless of the hash's own value. Verified (not assumed) below via a real readdir check.
function placeStaleBeforeFixed(fixedPath, staleCandidatePath) {
  fs.writeFileSync(staleCandidatePath, "{}");
  fs.writeFileSync(fixedPath, "{}");
  const order = fs.readdirSync(path.dirname(fixedPath));
  const idxStale = order.indexOf(path.basename(staleCandidatePath));
  const idxFixed = order.indexOf(path.basename(fixedPath));
  if (idxStale >= idxFixed) {
    throw new Error(`expected ${path.basename(staleCandidatePath)} to sort before ${path.basename(fixedPath)} on this filesystem (readdir order: ${order.join(", ")})`);
  }
}

try {
  if (scenarioName === "sibling-collapse-orderA" || scenarioName === "sibling-collapse-orderB") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // 4480b077 — two sibling subdirs of ONE physical repo (no .git of their own) collapse onto the SAME
    // canonical key. Each carries its OWN stale-keyed (non-hash-named) latch file, so BOTH go through
    // PASS 1's migrate branch, writing to the IDENTICAL fresh-hash target. orderA assigns token-A to
    // whichever file is empirically FIRST-processed; orderB SWAPS that assignment — between the two
    // scenarios, both "A processed first" and "A processed last" are exercised, regardless of which way
    // this filesystem's own fs.readdirSync happens to order two arbitrarily-named files.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, teamB } = makeRepoWithTwoSubdirs(scenarioName);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const sfx = freshSfx();
    const fileX = path.join(MERGE_QUARANTINE_DIR, `stale-x-${sfx}.json`);
    const fileY = path.join(MERGE_QUARANTINE_DIR, `stale-y-${sfx}.json`);
    const [firstProcessed, secondProcessed] = empiricalOrder(fileX, fileY);
    console.log(`(${scenarioName}) empirical order: first=${path.basename(firstProcessed)} second=${path.basename(secondProcessed)}`);

    const entryFirst = scenarioName === "sibling-collapse-orderA"
      ? { repoPath: teamA, branch: "branch-A", reason: "A's real, genuine reason", enteredAt: Date.now() - 60_000, tokens: ["token-A"] }
      : { repoPath: teamB, branch: "branch-B", reason: "B's real, genuine reason", enteredAt: Date.now() - 60_000, tokens: ["token-B"] };
    const entrySecond = scenarioName === "sibling-collapse-orderA"
      ? { repoPath: teamB, branch: "branch-B", reason: "B's real, genuine reason", enteredAt: Date.now(), tokens: ["token-B"] }
      : { repoPath: teamA, branch: "branch-A", reason: "A's real, genuine reason", enteredAt: Date.now(), tokens: ["token-A"] };
    fs.writeFileSync(firstProcessed, JSON.stringify(entryFirst));
    fs.writeFileSync(secondProcessed, JSON.stringify(entrySecond));

    reenterMergeQuarantinesAtBoot([teamA, teamB]);

    const activeA = activeMergeQuarantineFor(teamA);
    const activeB = activeMergeQuarantineFor(teamB);
    check("(boot) both siblings resolve to the SAME in-memory entry", !!activeA && activeA === activeB);
    check("*** THE FIX *** both tokens survive on the in-memory union — no loss either order", (activeA?.tokens ?? []).includes("token-A") && (activeA?.tokens ?? []).includes("token-B"));

    const freshFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && f !== path.basename(fileX) && f !== path.basename(fileY));
    check("(boot) exactly ONE fresh-hash file now exists", freshFiles.length === 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, freshFiles[0]), "utf8"));
    check("*** THE FIX *** the ON-DISK fresh-hash file carries BOTH tokens — union, never overwrite", (onDisk.tokens ?? []).includes("token-A") && (onDisk.tokens ?? []).includes("token-B"));
    check("(boot) the stale source files are both gone (migrated, not duplicated)", !fs.existsSync(fileX) && !fs.existsSync(fileY));

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([teamA, teamB]);
    const activeAAfterReboot = reboot1.activeMergeQuarantineFor(teamA);
    check("(reboot-sim) BOTH tokens still present reading only the migrated file", (activeAAfterReboot?.tokens ?? []).includes("token-A") && (activeAAfterReboot?.tokens ?? []).includes("token-B"));

    clearMergeQuarantine(teamA);
  } else if (scenarioName === "current-plus-stale-sibling-first") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // FINDING 1 — R's OWN CURRENT (correctly-named) latch already sits at sha(K).json. A stale sibling
    // T (a plain subdir of the SAME physical repo, no `.git` of its own) ALSO collapses onto K, under a
    // non-matching filename, forced (empirically) to sort BEFORE R's own file. Round 1's fix wrote the
    // stale sibling's bare content to sha(K).json with NO prior occupant (R's own file hadn't been read
    // yet) — destroying R's real token/reason/branch before PASS 1 ever got to read them. Round 2's
    // collect-then-write fix must read BOTH before writing EITHER.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA: r, teamB: t } = makeRepoWithTwoSubdirs("cpss");
    const k = canonicalRepoLockKey(r); // same for t too — one physical repo
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const sfx = freshSfx();
    const currentPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`); // R's OWN fixed, correct name
    const staleTPath = path.join(MERGE_QUARANTINE_DIR, `!stale-t-${sfx}.json`); // leading `!` forces alphabetical-first
    placeStaleBeforeFixed(currentPath, staleTPath);
    console.log(`(current-plus-stale-sibling-first) empirical order confirmed: ${path.basename(staleTPath)} sorts before ${path.basename(currentPath)}`);

    fs.writeFileSync(currentPath, JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R's real, genuine unconfirmed-kill reason", enteredAt: Date.now() - 60_000, tokens: ["token-R"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTPath, JSON.stringify({
      repoPath: t, branch: "t-branch", reason: "T's own stale-keyed, genuinely separate raise", enteredAt: Date.now(), tokens: ["token-T"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([r, t]);

    check("(boot) R and T resolve to the SAME in-memory entry", activeMergeQuarantineFor(r) === activeMergeQuarantineFor(t));
    const active = activeMergeQuarantineFor(r);
    check("*** THE FIX *** R's own token survives — never overwritten by a not-yet-read stale sibling", (active?.tokens ?? []).includes("token-R"));
    check("(boot) T's token is also present (a real union, not a loss in the other direction)", (active?.tokens ?? []).includes("token-T"));
    check("(boot) R's own file is still at its SAME path (updated in place, never replaced by T's alone)", fs.existsSync(currentPath));
    const onDisk = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    check("*** THE FIX *** the PERSISTED file at R's own path carries BOTH tokens", (onDisk.tokens ?? []).includes("token-R") && (onDisk.tokens ?? []).includes("token-T"));
    check("(boot) T's stale file was migrated away (deleted), not left duplicated", !fs.existsSync(staleTPath));

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([r, t]);
    const activeAfterReboot = reboot1.activeMergeQuarantineFor(r);
    check("(reboot-sim) R's own token is STILL present — the loss is not merely avoided in-process, it never reached disk", (activeAfterReboot?.tokens ?? []).includes("token-R") && (activeAfterReboot?.tokens ?? []).includes("token-T"));

    clearMergeQuarantine(r);
  } else if (scenarioName === "ebusy-fold-and-sweep" || scenarioName === "ebusy-no-injection-control") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // c870618c — a single stale-keyed latch migrates to its fresh-hash target. `ebusy-fold-and-sweep`
    // injects an EBUSY on exactly the stale source file's own unlink during the deferred write pass;
    // `ebusy-no-injection-control` is the same shape with NO injection, proving the ordinary (non-EBUSY)
    // path still cleanly deletes the source with nothing left to fold — the negative control.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA: subdir } = makeRepoWithTwoSubdirs(scenarioName);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const sfx = freshSfx();
    const staleFile = path.join(MERGE_QUARANTINE_DIR, `stale-${sfx}.json`);
    fs.writeFileSync(staleFile, JSON.stringify({
      repoPath: subdir, branch: "branch-X", reason: "pre-upgrade latch needing migration", enteredAt: Date.now(), tokens: ["token-X"],
    }));

    const inject = scenarioName === "ebusy-fold-and-sweep";
    const realUnlinkSync = fs.unlinkSync;
    if (inject) {
      fs.unlinkSync = function patchedUnlinkSync(p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(staleFile)) {
          const err = new Error("EBUSY: resource busy or locked (injected)");
          err.code = "EBUSY";
          throw err;
        }
        return realUnlinkSync.call(this, p, ...rest);
      };
    }
    try {
      reenterMergeQuarantinesAtBoot([subdir]);
    } finally {
      fs.unlinkSync = realUnlinkSync;
    }

    const entry = activeMergeQuarantineFor(subdir);
    const staleStillOnDisk = fs.existsSync(staleFile);
    const foldedIn = !!entry?.orphanLatchFiles?.includes(path.basename(staleFile));

    if (inject) {
      check("(precondition) the injected EBUSY prevented the stale file's unlink", staleStillOnDisk);
      check("*** THE FIX *** the un-unlinkable stale file is folded into orphanLatchFiles", foldedIn);
    } else {
      check("(negative control) with NO injection, the stale file is cleanly deleted", !staleStillOnDisk);
      check("(negative control) nothing is folded when there was nothing to fold", !foldedIn);
    }

    clearMergeQuarantine(subdir); // a human clears the REAL entry, by its own now-fresh key
    const staleSweptByClear = !fs.existsSync(staleFile);
    check(inject ? "*** THE FIX *** the legitimate clear also sweeps the folded stale file" : "(negative control) the clear sweeps the (already-gone) stale file path too", staleSweptByClear);

    const reboot1 = await rebootSim();
    const found2 = reboot1.reenterMergeQuarantinesAtBoot([subdir]);
    const resurrected = found2.some((e) => e.repoPath === subdir);
    check(inject ? "*** THE FIX *** a reboot-sim after the legitimate clear does NOT resurrect the quarantine" : "(negative control) a reboot-sim after the clear does not resurrect anything", !resurrected);
  } else if (scenarioName === "stale-id-clear-keeps-folded-file") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // c870618c, N-SOURCE CASE — TWO sibling subdirs (R, T) of one repo, BOTH stale-keyed, BOTH migrating
    // to the SAME fresh-hash target. R's own unlink is injected to FAIL (EBUSY); T's own unlink succeeds
    // normally. Mirrors merge-quarantine-partial-unlink-fold.mjs's own single-tmp pattern, but for TWO
        // independent migrate SOURCES at once, exercising the deferred write pass's own N-source fold.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA: r, teamB: t } = makeRepoWithTwoSubdirs("sicfk");
    const k = canonicalRepoLockKey(r);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const sfx = freshSfx();
    // R's own stale name is a REAL 24-hex id (the legacy, no-toplevel-walk hash of its own path) — a
    // genuine `clearMergeQuarantineLatchFile` id, not an arbitrary filename, since this scenario clears
    // it BY ID below (that call rejects anything not matching its own 24-hex `QUARANTINE_LATCH_ID_PATTERN`).
    const staleRPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(r)}.json`);
    const staleTPath = path.join(MERGE_QUARANTINE_DIR, `stale-t-${sfx}.json`);
    fs.writeFileSync(staleRPath, JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R — its own unlink is injected to FAIL (EBUSY)", enteredAt: Date.now() - 60_000, tokens: ["token-R"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTPath, JSON.stringify({
      repoPath: t, branch: "t-branch", reason: "T — its own unlink succeeds normally", enteredAt: Date.now(), tokens: ["token-T"],
    }, null, 2) + "\n");

    const freshPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);
    const realUnlinkSync = fs.unlinkSync;
    let hitCount = 0;
    fs.unlinkSync = function patchedUnlinkSync(p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(staleRPath)) {
        hitCount++;
        const err = new Error("EBUSY: resource busy or locked (injected)");
        err.code = "EBUSY";
        throw err;
      }
      return realUnlinkSync.call(this, p, ...rest);
    };
    try {
      reenterMergeQuarantinesAtBoot([r, t]);
    } finally {
      fs.unlinkSync = realUnlinkSync;
    }
    check("(precondition) the injected EBUSY was hit exactly once (R's own source only)", hitCount === 1);

    check("(graduation) the fresh write succeeded", fs.existsSync(freshPath));
    const onDisk = JSON.parse(fs.readFileSync(freshPath, "utf8"));
    check("(graduation) both tokens are present on the written union", (onDisk.tokens ?? []).includes("token-R") && (onDisk.tokens ?? []).includes("token-T"));
    check("(graduation) T's stale source (unlink succeeded) is gone", !fs.existsSync(staleTPath));
    check("(graduation) R's stale source (unlink FAILED) is still on disk", fs.existsSync(staleRPath));
    check("*** THE FIX *** R's stale source is folded into the written entry's own orphanLatchFiles", (onDisk.orphanLatchFiles ?? []).includes(path.basename(staleRPath)));

    // A clear-by-id on R's OWN STALE hash (not the real entry's current key) must KEEP it — it's still
    // referenced by the real, surviving entry's own orphanLatchFiles.
    const staleHash = path.basename(staleRPath, ".json");
    const staleClearResult = clearMergeQuarantineLatchFile(staleHash);
    check("(clear-by-id on STALE hash) call succeeds", staleClearResult.ok === true);
    check("(clear-by-id on STALE hash) wasQuarantined===false — the stale hash matches no entry of its own", staleClearResult.wasQuarantined === false);
    check("*** THE FIX *** clear-by-id on the STALE hash reports the file KEPT", staleClearResult.latchKept === true);
    check("*** THE FIX *** R's stale source survives this id-mismatched clear", fs.existsSync(staleRPath));

    // The ordinary, legitimate clear a human would actually issue — on the REAL fresh hash — must sweep
    // the folded stale file away as part of clearing the entry that owns it.
    const freshHash = quarantineLatchIdFor(r);
    const clearResult = clearMergeQuarantineLatchFile(freshHash);
    check("(human clear on fresh hash) call succeeds", clearResult.ok === true);
    check("(human clear on fresh hash) wasQuarantined===true", clearResult.wasQuarantined === true);
    check("*** THE FIX *** R's folded stale source is swept as part of clearing the real entry", !fs.existsSync(staleRPath));
    check("(human clear on fresh hash) the fresh final is also gone", !fs.existsSync(freshPath));

    const reboot1 = await rebootSim();
    const found = reboot1.reenterMergeQuarantinesAtBoot([r, t]);
    check("(reboot-sim) no resurrection after the legitimate clear", !found.some((e) => e.repoPath === r || e.repoPath === t));
  } else if (scenarioName === "migrate-source-collides-with-sibling-target") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3, FINDING 1 (CRITICAL) — a migration SOURCE for one key can physically BE a DIFFERENT key's
    // own WRITE TARGET. `sub` (a nested repo, own `.git`, real key Ksub) has its OWN latch filed at
    // sha(Kp).json — as if `sub` had once been treated as part of P, before it got its own `.git`.
    // `teamA` (a plain subdir of P, no `.git` of its own, real key Kp) has a stale-named latch forced
    // (empirically) to sort BEFORE sha(Kp).json. Round 2's write pass wrote teamA's own union to
    // sha(Kp).json correctly, THEN deleted sub's own source — which IS that same sha(Kp).json file, now
    // holding teamA's freshly-written data — destroying it (durable fail-open for teamA). Round 3 defers
    // every delete until every write in this pass has landed, and never deletes a source that is ALSO
    // some OTHER key's own write target from this same pass.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("msct");
    const kp = canonicalRepoLockKey(repo); // == teamA's own key too (plain subdir of P)
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    // sub's OWN latch, filed at Kp's own fresh-hash name — a stale key FOR SUB, but it IS teamA's own
    // correct, eventual write target.
    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    console.log(`(migrate-source-collides-with-sibling-target) empirical order confirmed: ${path.basename(staleTeamAPath)} sorts before ${path.basename(subAtKpPath)}`);

    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's own latch, filed before sub had its own .git", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own stale-keyed, genuinely separate raise", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, sub]);

    const activeTeamA = activeMergeQuarantineFor(teamA);
    const activeSub = activeMergeQuarantineFor(sub);
    check("*** THE FIX *** teamA's own quarantine survives (token-teamA)", !!activeTeamA && (activeTeamA.tokens ?? []).includes("token-teamA"));
    check("*** THE FIX *** sub's own quarantine ALSO survives (token-sub), migrated to its OWN key", !!activeSub && (activeSub.tokens ?? []).includes("token-sub"));
    const kpFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const ksubFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    check("(boot) teamA's own file (at Kp) carries teamA's token — never destroyed by sub's own delete", fs.existsSync(kpFile) && (JSON.parse(fs.readFileSync(kpFile, "utf8")).tokens ?? []).includes("token-teamA"));
    check("(boot) sub's own file (at Ksub) carries sub's token", fs.existsSync(ksubFile) && (JSON.parse(fs.readFileSync(ksubFile, "utf8")).tokens ?? []).includes("token-sub"));

    const reboot1 = await rebootSim();
    reboot1.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    check("(reboot-sim) teamA's quarantine STILL survives", (reboot1.activeMergeQuarantineFor(teamA)?.tokens ?? []).includes("token-teamA"));
    check("(reboot-sim) sub's quarantine STILL survives", (reboot1.activeMergeQuarantineFor(sub)?.tokens ?? []).includes("token-sub"));

    clearMergeQuarantine(teamA);
    clearMergeQuarantine(sub);
  } else if (scenarioName === "degraded-receiver-guard" || scenarioName === "union-with-degraded-in-memory") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // FINDING 2 — X never exists at all (no ancestor to walk up to), with its recorded `resolvedKey`
    // deliberately manufactured to COLLIDE with Y's own real, genuinely-resolvable key Ky. CRITICALLY,
    // X's OWN BACKING FILE is written at sha(Ky).json — the REAL invariant (a trusted resolvedKey is
    // ONLY ever set by a past migrate-write to that exact path, per quarantinePathFor/writeMergeQuarantineLatch)
    // round 1's own test got WRONG (it put X's file at sha(X's own path) instead, which is why round 1's
    // bug never showed up there). Y's own latch is ADDITIONALLY stale-keyed, so Y goes through PASS 1's
    // migrate branch targeting the SAME sha(Ky).json X already occupies.
    //   - "degraded-receiver-guard" asserts the ON-DISK/FILE half: X's file is never touched, Y's own
    //     stale file is never migrated or deleted.
    //   - "union-with-degraded-in-memory" asserts the IN-MEMORY half: BOTH x and y still read as
    //     quarantined for this process, even though no file was written for either — "fail-closed, no
    //     durable merge" is actually true, not just asserted.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), `# ${scenarioName}\n`);
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-never-exists-${freshSfx()}`); // deliberately never created
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`); // X's REAL backing-file location
    const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-${freshSfx()}.json`); // non-hash name -> migrates
    const xContent = {
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    };
    fs.writeFileSync(xFile, JSON.stringify(xContent, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine unconfirmed-kill reason", enteredAt: Date.now(), tokens: ["y-token"],
    }, null, 2) + "\n");
    const xFileBytesBefore = fs.readFileSync(xFile);

    reenterMergeQuarantinesAtBoot([y, x]);

    if (scenarioName === "degraded-receiver-guard") {
      check("*** THE GUARD *** X's own backing file is BYTE-IDENTICAL to before — never touched", Buffer.compare(xFileBytesBefore, fs.readFileSync(xFile)) === 0);
      check("*** THE GUARD *** Y's own stale file is left AS WRITTEN — never migrated, never deleted", fs.existsSync(yFile));
      const onDiskX = JSON.parse(fs.readFileSync(xFile, "utf8"));
      check("*** THE GUARD *** X's file still names only X's own repoPath/reason, never Y's", onDiskX.repoPath === x && !(onDiskX.tokens ?? []).includes("y-token"));
      const onDiskY = JSON.parse(fs.readFileSync(yFile, "utf8"));
      check("*** THE GUARD *** Y's own stale file still names only Y's own repoPath/reason, never X's", onDiskY.repoPath === y && !(onDiskY.tokens ?? []).includes("x-token"));

      const reboot1 = await rebootSim();
      reboot1.reenterMergeQuarantinesAtBoot([y, x]);
      check("*** THE GUARD *** after a reboot-sim, X's file is STILL untouched", Buffer.compare(xFileBytesBefore, fs.readFileSync(xFile)) === 0);
      check("*** THE GUARD *** after a reboot-sim, Y's own stale file STILL survives, uncontaminated", fs.existsSync(yFile) && JSON.parse(fs.readFileSync(yFile, "utf8")).repoPath === y);
    } else {
      // union-with-degraded-in-memory
      const activeX = activeMergeQuarantineFor(x);
      const activeY = activeMergeQuarantineFor(y);
      check("*** FAIL-CLOSED *** X still reads quarantined in-process, even with no file ever written for it this way", !!activeX);
      check("*** FAIL-CLOSED *** Y still reads quarantined in-process, even though its own migrate-write was skipped", !!activeY);
      // @decision c9114934 — EXCLUDES a `pending-<24hex>.json` protective copy from this count: that is
      // X's OWN safety record (protectDegradedOccupant), never a write for Y's migration. This check's own
      // job is narrower than "exactly 2 files total" post-c9114934 — it asserts Y's migrate-write target
      // specifically was never created, which a pending-prefixed file can never be confused with (disjoint
      // naming, see the decision record).
      const migrationWriteFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("pending-"));
      check("(in-memory) no fresh-hash file was ever created for Y's own migration (the write was genuinely skipped, not silently retried elsewhere)", migrationWriteFiles.length === 2);
    }
  } else if (scenarioName === "in-memory-twin-clear-destroys-degraded-file" || scenarioName === "in-memory-twin-clear-x-removes-safety-copy") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3, FINDING 2 (MAJOR, "Repro B") + the in-memory twin, now fixed by card c9114934 (right
    // before clearing Y's shared key would destroy X's only backing file, X's own CURRENT on-disk content
    // is copied aside to a NEW disjoint pending-divert filename — see docs/decisions/c9114934-degraded-
    // occupant-safety-copy-before-key-reclaim.md for why this is deliberately a CLEAR-TIME protection,
    // never preemptive at boot). The degraded-collision fall-through STILL unions X (degraded) and Y
    // (resolvable) into ONE in-memory entry at Ky (armQuarantineKey is unconditional, unchanged by this
    // card on purpose — only the WRITE is gated), and clearing Y STILL correctly deletes Ky's own physical
    // file (e1cb7d33's retraction: the clear must PROCEED, never refuse) — but X now survives via its own
    // protective copy, minted in the SAME clear call that destroys Ky's shared file.
    //   - "in-memory-twin-clear-destroys-degraded-file" promotes the ORIGINAL report-only half to full
    //     assertions: Ky's physical file is still correctly deleted (Y legitimately owns Ky now), but X
    //     survives — enforced, findable by its own path, and durable across ≥3 reboots with a STABLE
    //     file count (no new protective copy minted per boot).
    //   - "in-memory-twin-clear-x-removes-safety-copy" (DoD extra (b)) continues from there: clearing X
    //     BY ITS OWN PATH removes its protective copy too, with no residue left behind.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-imt-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# in-memory-twin-clear-destroys-degraded-file\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-imt-never-exists-${freshSfx()}`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine unconfirmed-kill reason", enteredAt: Date.now(), tokens: ["y-token"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(precondition) X's backing file exists before any clear", fs.existsSync(xFile));
    check("(precondition) Y's own stale source exists before any clear", fs.existsSync(yFile));
    check("(precondition) Y reads quarantined before any clear", !!activeMergeQuarantineFor(y));
    // No protective copy exists yet — this card's fix is deliberately CLEAR-TIME, never preemptive at
    // boot (a preemptive copy caused a measured double-report regression — see the decision record).
    check("(precondition) no protective copy exists before the clear runs", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-")).length === 0);

    // THE CHECK — a human issues the ordinary, legitimate clear for Y (the resolvable repo). This still
    // PROCEEDS (e1cb7d33's own retraction) and still deletes Ky's shared physical file — but X's own
    // content is copied aside to a new protective file in the SAME call, before the delete.
    clearMergeQuarantine(y);

    check("Ky's shared physical file is still correctly deleted — Y legitimately owns Ky now", !fs.existsSync(xFile));
    // *** THE FIX *** — Y's own stale source must be swept too (via the fold into the shared union's own
    // orphanLatchFiles, consumed by clearMergeQuarantineByKey's existing orphan-sweep loop), or it
    // survives untouched and resurrects Y's quarantine on the next boot.
    check("*** THE FIX *** Y's own stale source is swept by the SAME clear (folded into the union's orphanLatchFiles)", !fs.existsSync(yFile));
    const protectiveFilesAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("*** THE FIX *** X's protective copy was minted by the SAME clear that destroyed Ky's shared file", protectiveFilesAfterClear.length === 1);
    const xProtectiveFile = path.join(MERGE_QUARANTINE_DIR, protectiveFilesAfterClear[0]);
    // *** ROUND 3, MAJOR #2 *** — the protective copy's own DURABLE content must be X's own, never
    // bled from the live boot-time union `armQuarantineKey` already merged Y's own token into.
    const onDiskProtective = JSON.parse(fs.readFileSync(xProtectiveFile, "utf8"));
    check("*** THE FIX (round 3) *** X's protective copy carries x-token", (onDiskProtective.tokens ?? []).includes("x-token"));
    check("*** THE FIX (round 3) *** X's protective copy does NOT durably carry y-token (no bleed from the boot-time union)", !(onDiskProtective.tokens ?? []).includes("y-token"));
    const activeXAfterClear = activeMergeQuarantineFor(x);
    check("*** THE FIX *** X is STILL enforced, findable by its own path, with its own token intact", !!activeXAfterClear && (activeXAfterClear.tokens ?? []).includes("x-token"));

    if (scenarioName === "in-memory-twin-clear-destroys-degraded-file") {
      // *** ROUND 4, ITEM 1 — PIN THE atFinalBasenameIdx `.entry` OVERWRITE *** — every check above only
      // ever reads the DURABLE FILE (already correct by the time the mutated line would run) or a FRESH
      // reboot (same thing, re-read from disk) — neither can see a stale IN-MEMORY ref left behind by a
      // regressed re-point. This checks the LIVE in-memory object directly, in THIS SAME process, no
      // reboot — the only way a regression here is ever actually caught.
      check("*** THE FIX (round 4, PIN) *** activeMergeQuarantineFor(x) in-process does NOT carry y-token right after the clear", !(activeXAfterClear.tokens ?? []).includes("y-token"));

      // Trigger a SECOND, independent protect for X in THIS SAME process (no reboot) — a genuinely NEW
      // degraded collision at a DIFFERENT key `kw`. If the FIRST protect's own in-memory ref was left
      // stale (the regression), this SECOND protect's own union reads it via `atFilenameIdx` and durably
      // bleeds y-token into the SECOND write too — proving the pin actually matters downstream, not just
      // for the one query above.
      const w = path.join(os.tmpdir(), `loom-mqp1mu-w-imt-pin-${freshSfx()}`);
      fs.mkdirSync(w, { recursive: true });
      tmpDirs.push(w);
      fs.writeFileSync(path.join(w, "README.md"), "# in-memory-twin-pin (w)\n");
      execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: w });
      commitAll(w, "init", GIT_ID);
      const kw = canonicalRepoLockKey(w);
      const xAtKwFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
      fs.writeFileSync(xAtKwFile, JSON.stringify({
        repoPath: x, branch: "x-branch", reason: "X's SECOND manufactured resolvedKey collision, with w",
        enteredAt: Date.now() - 60_000, tokens: ["x-token-2"], resolvedKey: kw,
      }, null, 2) + "\n");
      reenterMergeQuarantinesAtBoot([w, x]); // in-process re-scan (no reimport) — arms X at kw too
      clearMergeQuarantine(w); // triggers the SECOND protect call

      const pendingAfterSecondProtect = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      check("*** THE FIX (round 4, PIN) *** still exactly one protective copy after the second, in-process protect", pendingAfterSecondProtect.length === 1);
      const onDiskAfterSecondProtect = pendingAfterSecondProtect[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, pendingAfterSecondProtect[0]), "utf8")) : {};
      check("*** THE FIX (round 4, PIN) *** the second protect's own written file carries x-token", (onDiskAfterSecondProtect.tokens ?? []).includes("x-token"));
      check("*** THE FIX (round 4, PIN) *** the second protect's own written file carries x-token-2", (onDiskAfterSecondProtect.tokens ?? []).includes("x-token-2"));
      check("*** THE FIX (round 4, PIN) *** the second protect's own written file does NOT carry y-token (no re-bleed via a stale atFilenameIdx ref)", !(onDiskAfterSecondProtect.tokens ?? []).includes("y-token"));
    }

    // ≥3 reboots: Y must never resurrect, X must stay enforced, and the quarantine dir's file count must
    // be STABLE — no new protective copy minted per boot (DoD extra (a)).
    const filesAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length;
    let lastReboot;
    for (let i = 0; i < 3; i++) {
      lastReboot = await rebootSim();
      const foundAfterClear = lastReboot.reenterMergeQuarantinesAtBoot([y, x]);
      check(`*** THE FIX *** Y does NOT resurrect on reboot #${i + 1} — the human's clear actually stuck`, !foundAfterClear.some((e) => e.repoPath === y));
      const xAfterClearEntry = foundAfterClear.find((e) => e.repoPath === x);
      check(`*** THE FIX *** X STILL enforced on reboot #${i + 1}, with its own token`, !!xAfterClearEntry && (xAfterClearEntry.tokens ?? []).includes("x-token"));
      // (nitpick) find/every, never some — some(e => cond && !other) passes if ANY x-entry lacks
      // y-token even while a DIFFERENT x-entry carries it; this must check THE entry, not "any entry".
      check(`*** THE FIX (round 3) *** X does NOT carry y-token on reboot #${i + 1} either`, !!xAfterClearEntry && !(xAfterClearEntry.tokens ?? []).includes("y-token"));
      // (nitpick #7) assert assertRepoNotQuarantined(x) DIRECTLY, not just via reenterMergeQuarantinesAtBoot's own return array.
      check(`*** THE FIX *** assertRepoNotQuarantined(x) directly reports x BLOCKED on reboot #${i + 1}`, lastReboot.assertRepoNotQuarantined(x).ok === false);
      const filesThisBoot = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length;
      check(`*** THE FIX (DoD a) *** quarantine dir file count STABLE after reboot #${i + 1} (no new protective copy minted)`, filesThisBoot === filesAfterBoot1);
    }

    if (scenarioName === "in-memory-twin-clear-x-removes-safety-copy") {
      // DoD extra (b) — clearing X BY ITS OWN PATH removes its protective copy too, with no residue.
      check("(precondition) X's protective copy still exists before clearing X by its own path", fs.existsSync(xProtectiveFile));
      lastReboot.clearMergeQuarantineByRecordedPath(x);
      check("*** THE FIX (DoD b) *** clearing X by its own path removes its protective copy — no residue", !fs.existsSync(xProtectiveFile));
      check("*** THE FIX (DoD b) *** X no longer reads quarantined after clearing it by its own path", !lastReboot.activeMergeQuarantineFor(x));
      check("(nitpick #7) assertRepoNotQuarantined(x) directly confirms x is now FREE", lastReboot.assertRepoNotQuarantined(x).ok === true);
      const reboot4 = await rebootSim();
      const foundAfterXClear = reboot4.reenterMergeQuarantinesAtBoot([y, x]);
      check("*** THE FIX (DoD b) *** X does NOT resurrect on a later boot either", !foundAfterXClear.some((e) => e.repoPath === x));
    }
  } else if (scenarioName === "gone-subdir-reblocks-once-then-clearable") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3 — Lead ruling: FAIL CLOSED. Round 2's `occupantKey === key` skip (this scenario's own
    // former name, `gone-subdir-not-foreign`) is REVERTED — it cannot tell a stale same-repo subdir
    // apart from a genuinely FOREIGN nested repo whose checkout is currently missing (both ancestor-walk
    // to the SAME key right now; see `foreign-nested-repo-quarantine-survives` below for that case). A
    // fail-OPEN loss of a foreign repo's quarantine is unrecoverable; this scenario pins the cost of
    // failing CLOSED instead for the harmless same-repo-subdir case: ONE spurious re-block, cleanly and
    // permanently resolved by the very next ordinary clear once the path is recognizably resolvable.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-gsf-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# gone-subdir-reblocks-once-then-clearable\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const z = path.join(y, "gone-subdir"); // deliberately never created yet — "gone"

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    // `resolvedKey: ky` is set here purely so PASS 1 arms this directly (rather than diverting it to
    // `pendingUnresolvedQuarantines` for having no resolvedKey at all) — z's own ancestor walk would
    // compute the SAME ky even without it.
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "a stale same-repo subdir path, now gone", enteredAt: Date.now(), tokens: ["z-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, z]);
    check("(precondition) z's own ancestor-walked key is the SAME as y's (a plain subdir, no own .git)", canonicalRepoLockKey(z) === ky);
    check("(precondition) z is currently unresolvable (gone)", !fs.existsSync(z));
    check("(precondition) y reads quarantined (z's content occupies y's own key)", !!activeMergeQuarantineFor(y));

    // STEP 1 — clear(y) ⇒ a protective copy IS minted (FAIL CLOSED, even for this same-repo subdir).
    clearMergeQuarantine(y);
    check("y's own physical file is correctly deleted", !fs.existsSync(finalPath));
    const pendingAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("*** FAIL CLOSED *** a protective (pending-divert) copy IS minted for the same-repo subdir path too", pendingAfterClear.length === 1);
    // (nitpick) guard the index — a RED run with ZERO protective copies must still report the rest of
    // this scenario's own checks (a bare `pendingAfterClear[0]` would be `undefined` there, crashing
    // `path.join` and losing every later assertion to an uncaught exception instead of a clean FAIL).
    const onDiskPending = pendingAfterClear[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, pendingAfterClear[0]), "utf8")) : {};
    check("the protective copy carries z's own token", (onDiskPending.tokens ?? []).includes("z-token"));

    // While the subdir is STILL gone, a reboot keeps the protective copy PENDING (not yet resolvable, so
    // never armed at any key) — y stays free in the meantime. `reenterMergeQuarantinesAtBoot`'s own
    // return value legitimately still NAMES z (its pending data survives, which is the entire point of
    // protecting it) — the real assertion is that nothing is ARMED at y's own key, checked directly.
    const rebootWhileGone = await rebootSim();
    rebootWhileGone.reenterMergeQuarantinesAtBoot([y, z]);
    check("(while gone) y stays free — the protective copy hasn't resolved to anything yet", !rebootWhileGone.activeMergeQuarantineFor(y));
    check("(while gone) assertRepoNotQuarantined(y) directly confirms y is free", rebootWhileGone.assertRepoNotQuarantined(y).ok === true);

    // STEP 2 — "subdir restored" ⇒ Y re-blocked ONCE. z now genuinely exists again (a plain subdir, no
    // own `.git`) — on the NEXT boot, its pending-divert entry (no resolvedKey) resolves to ky directly
    // and migrates into a real latch there, re-occupying Y's own key.
    fs.mkdirSync(z, { recursive: true });
    check("(precondition) z now resolves", fs.existsSync(z));
    const rebootAfterRestore = await rebootSim();
    const foundAfterRestore = rebootAfterRestore.reenterMergeQuarantinesAtBoot([y, z]);
    check("*** FAIL CLOSED (the cost) *** Y is RE-BLOCKED once the subdir is restored and a boot runs", !!rebootAfterRestore.activeMergeQuarantineFor(y));
    check("the re-block is z's own migrated entry", foundAfterRestore.some((e) => e.repoPath === z && (e.tokens ?? []).includes("z-token")));

    // STEP 3 — an ORDINARY clear(y) now removes it for good: `differentUnresolvableOccupantRepoPathAt`
    // returns `undefined` for z this time (different identity, but now CURRENTLY RESOLVABLE — "today's
    // behavior" branch) — no new protective copy is minted, the physical file is just deleted outright.
    rebootAfterRestore.clearMergeQuarantine(y);
    const pendingAfterSecondClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("*** THE FIX *** the second, ordinary clear mints NO new protective copy (z is resolvable now)", pendingAfterSecondClear.length === 0);
    check("*** THE FIX *** y is free immediately after this second clear", !rebootAfterRestore.activeMergeQuarantineFor(y));

    const finalReboot = await rebootSim();
    const foundFinal = finalReboot.reenterMergeQuarantinesAtBoot([y, z]);
    check("*** THE FIX *** nothing resurrects on a further reboot — cleared for good", !foundFinal.some((e) => e.repoPath === y || e.repoPath === z));
    check("*** THE FIX *** assertRepoNotQuarantined(y) confirms y is free for good", finalReboot.assertRepoNotQuarantined(y).ok === true);
  } else if (scenarioName === "foreign-nested-repo-quarantine-survives") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3 — the CR's own counter-example to round 2's (reverted) `occupantKey === key` skip: a
    // GENUINELY FOREIGN nested repo (`Y/vendor/foreign-repo`, its OWN `.git`, a real distinct key)
    // whose checkout is simply MISSING at the moment Y is cleared. From THIS process's own inputs at
    // clear time, this is INDISTINGUISHABLE from `gone-subdir-reblocks-once-then-clearable`'s own same-
    // repo subdir (both ancestor-walk to Y's own key while absent) — only what the path turns out to BE
    // once restored tells the two apart, and that information does not exist yet at clear time. FAIL
    // CLOSED protects both; this scenario proves the foreign one survives for real, not just in theory.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-fnr-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# foreign-nested-repo-quarantine-survives\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const foreignRepo = path.join(y, "vendor", "foreign-repo"); // checkout MISSING — not created yet

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: foreignRepo, branch: "foreign-branch", reason: "a foreign nested repo, checkout currently missing", enteredAt: Date.now(), tokens: ["foreign-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, foreignRepo]);
    check("(precondition) foreignRepo's own ancestor-walked key is the SAME as y's while its checkout is missing", canonicalRepoLockKey(foreignRepo) === ky);
    check("(precondition) foreignRepo is currently unresolvable (checkout missing)", !fs.existsSync(foreignRepo));
    check("(precondition) y reads quarantined (foreignRepo's content occupies y's own key)", !!activeMergeQuarantineFor(y));

    // clear(y) — FAIL CLOSED protects foreignRepo's own content before Ky's shared physical file is destroyed.
    clearMergeQuarantine(y);
    const pendingAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("*** THE FIX *** a protective copy is minted for the foreign nested repo too", pendingAfterClear.length === 1);
    check("*** THE FIX *** foreignRepo is still enforced immediately after the clear", !!activeMergeQuarantineFor(foreignRepo));

    // "checkout restored" — foreignRepo now genuinely exists, as its OWN SEPARATE repo (own `.git`, a
    // real, distinct key — never Y's own ky).
    fs.mkdirSync(foreignRepo, { recursive: true });
    fs.writeFileSync(path.join(foreignRepo, "README.md"), "# foreign-repo\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: foreignRepo });
    commitAll(foreignRepo, "init", GIT_ID);
    const kForeign = canonicalRepoLockKey(foreignRepo);
    check("(precondition) foreignRepo's own REAL key is genuinely different from Y's", kForeign !== ky);

    const reboot1 = await rebootSim();
    const found1 = reboot1.reenterMergeQuarantinesAtBoot([y, foreignRepo]);
    check("*** THE FIX *** X (foreignRepo) is STILL quarantined after the reboot — nothing was lost", found1.some((e) => e.repoPath === foreignRepo && (e.tokens ?? []).includes("foreign-token")));
    // (nitpick) assert the ACTUAL claim — armed under kForeign's own canonical slot — not merely that
    // nothing in `found1` happens to carry y's repoPath (a much weaker, indirect proxy for "migrated").
    const kForeignFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kForeign)}.json`);
    check("*** THE FIX *** foreignRepo migrated to its OWN real key (kForeign), never Y's", fs.existsSync(kForeignFile));
    check("*** THE FIX *** Y itself is NOT re-blocked this time (foreignRepo is a genuinely different identity/key)", !reboot1.activeMergeQuarantineFor(y));

    // Cleanup: clear foreignRepo by its own path, leaving no residue.
    reboot1.clearMergeQuarantine(foreignRepo);
    check("(cleanup) foreignRepo's own quarantine is lifted", !reboot1.activeMergeQuarantineFor(foreignRepo));
  } else if (scenarioName === "dual-collision-union-survives-second-protect") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, MAJOR #2 + MINOR #5 — ONE degraded identity X collides (via its own trusted resolvedKey,
    // same shape as the already-fixed in-memory-twin scenarios) with TWO SEPARATE, otherwise-innocent
    // resolvable repos t1/t2 at TWO DIFFERENT keys. Clearing t1 protects X (mints pending-<hash(x)>.json
    // holding X's t1-side token). The OLD, buggy code then EARLY-RETURNED when clearing t2 found that
    // pending file already existed — silently DROPPING t2's own token and never re-persisting anything
    // before t2's own physical collision file was destroyed. The fix unions the SECOND collision's
    // tokens into the EXISTING pending record instead of early-returning or overwriting it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const t1 = path.join(os.tmpdir(), `loom-mqp1mu-t1-dcu-${freshSfx()}`);
    fs.mkdirSync(t1, { recursive: true });
    tmpDirs.push(t1);
    fs.writeFileSync(path.join(t1, "README.md"), "# dual-collision-union-survives-second-protect (t1)\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: t1 });
    commitAll(t1, "init", GIT_ID);
    const k1 = canonicalRepoLockKey(t1);

    const t2 = path.join(os.tmpdir(), `loom-mqp1mu-t2-dcu-${freshSfx()}`);
    fs.mkdirSync(t2, { recursive: true });
    tmpDirs.push(t2);
    fs.writeFileSync(path.join(t2, "README.md"), "# dual-collision-union-survives-second-protect (t2)\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: t2 });
    commitAll(t2, "init", GIT_ID);
    const k2 = canonicalRepoLockKey(t2);
    check("(precondition) t1 and t2 have genuinely different canonical keys", k1 !== k2);

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-dcu-never-exists-${freshSfx()}`); // deliberately never created
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    // X's own TWO independent physical backings — one per colliding key, each with its own trusted
    // resolvedKey and its own distinct token (two separate in-memory armed objects; nothing links them
    // except sharing X's own `repoPath` string — exactly what `pendingDivertFilenameFor` keys on).
    const xAtK1 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
    const xAtK2 = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
    fs.writeFileSync(xAtK1, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with t1",
      enteredAt: Date.now() - 60_000, tokens: ["x-t1-token"], resolvedKey: k1,
    }, null, 2) + "\n");
    fs.writeFileSync(xAtK2, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with t2",
      enteredAt: Date.now() - 60_000, tokens: ["x-t2-token"], resolvedKey: k2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([t1, t2, x]);
    check("(precondition) t1 reads quarantined (X occupies K1)", !!activeMergeQuarantineFor(t1));
    check("(precondition) t2 reads quarantined (X occupies K2)", !!activeMergeQuarantineFor(t2));
    check("(precondition) no protective copy exists before any clear", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-")).length === 0);

    // Clear t1 FIRST — mints X's protective pending record, holding ONLY x-t1-token so far.
    clearMergeQuarantine(t1);
    const pendingAfterT1 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("(after clearing t1) exactly one protective copy exists", pendingAfterT1.length === 1);
    const pendingPath = path.join(MERGE_QUARANTINE_DIR, pendingAfterT1[0]);
    const afterT1 = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    check("(after clearing t1) the protective copy carries x-t1-token", (afterT1.tokens ?? []).includes("x-t1-token"));
    check("(after clearing t1) the protective copy does NOT yet carry x-t2-token", !(afterT1.tokens ?? []).includes("x-t2-token"));

    // THE CHECK — clear t2 SECOND. The old code's own "already protected" early return would discard
    // x-t2-token entirely right here, right before t2's own physical file is unconditionally destroyed.
    clearMergeQuarantine(t2);

    check("t2's own physical file is destroyed (the clear always proceeds, protected or not)", !fs.existsSync(xAtK2));
    const pendingAfterT2 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("*** THE FIX *** still exactly ONE protective copy — union into the existing one, never a second file", pendingAfterT2.length === 1);
    const afterT2 = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    check("*** THE FIX *** x-t1-token SURVIVES clearing t2 (never overwritten)", (afterT2.tokens ?? []).includes("x-t1-token"));
    check("*** THE FIX *** x-t2-token is now ALSO present — unioned, never dropped by the early return", (afterT2.tokens ?? []).includes("x-t2-token"));
    const activeXAfterBoth = activeMergeQuarantineFor(x);
    check("*** THE FIX *** clearing t2 alone still leaves X quarantined — enforced, findable by its own path",
      !!activeXAfterBoth && (activeXAfterBoth.tokens ?? []).includes("x-t1-token") && (activeXAfterBoth.tokens ?? []).includes("x-t2-token"));

    const reboot1 = await rebootSim();
    const found1 = reboot1.reenterMergeQuarantinesAtBoot([t1, t2, x]);
    check("(reboot-sim) neither t1 nor t2 resurrects", !found1.some((e) => e.repoPath === t1 || e.repoPath === t2));
    check("(reboot-sim) X is still enforced with BOTH tokens",
      found1.some((e) => e.repoPath === x && (e.tokens ?? []).includes("x-t1-token") && (e.tokens ?? []).includes("x-t2-token")));
    const filesAfterReboot = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
    check("(reboot-sim) still exactly one protective copy — no duplicate minted on reboot", filesAfterReboot.length === 1);
  } else if (scenarioName === "reversed-tie-break-no-protection-report-only") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, MAJOR #3 (REPORT-ONLY, DEFERRED to card 398f476c per Lead ruling) — TWO wholly
    // unresolvable identities (X, Y) each carry a manufactured, "trusted" `resolvedKey` pointing at the
    // SAME key Ky, armed DIRECTLY via `armQuarantineKey` in PASS 1's own main loop (never the
    // resolvable-sibling migrate-fold shape the already-fixed scenarios above exercise) — the SAME
    // mechanism `c9114934`'s own decision record investigated for its "Hook 2" question, mirroring
    // `merge-quarantine-pass1-degraded-union-guard.mjs`'s own `deferred-flush-no-stale-snapshot` fixture.
    // `unionQuarantineEntries` keeps the OLDER side's own identity — when Y is older, the union's own
    // resulting `repoPath` becomes Y's, so a clear naming `y` as its `identityRepoPath` finds
    // `entry.repoPath === identityRepoPath` and `protectDegradedOccupantBeforeDelete` is never even
    // attempted: this is `a2f381dc`'s own M-2 residual one level over (no surviving object represents
    // X's own identity to protect at all). PRINTED, never asserted — mirroring a2f381dc's own precedent
    // of documenting M-2 without a new assertion.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const anchor = path.join(os.tmpdir(), `loom-mqp1mu-anchor-rtb-${freshSfx()}`);
    fs.mkdirSync(anchor, { recursive: true });
    tmpDirs.push(anchor);
    fs.writeFileSync(path.join(anchor, "README.md"), "# reversed-tie-break-no-protection-report-only\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: anchor });
    commitAll(anchor, "init", GIT_ID);
    const ky = canonicalRepoLockKey(anchor); // a real, stable key — never queried by its own path below

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-rtb-never-exists-${freshSfx()}`);
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-rtb-never-exists-${freshSfx()}`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // X sits at Ky's own "correct" hash-named physical slot (the shape every other scenario's X uses).
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    // Y sits at an arbitrary, non-hash-matching name — its own `resolvedKey` is what routes it into Ky's
    // union directly via armQuarantineKey, never by filename.
    const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-rtb-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision", enteredAt: Date.now(), tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's own manufactured resolvedKey collision — OLDER than X", enteredAt: Date.now() - 60_000, tokens: ["y-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([anchor, x, y]);
    // Query by Y's OWN identity (the expected winner, being older) — `activeMergeQuarantineFor`'s own
    // pending-tier identity match (see its doc) only finds the union's object via whichever side's own
    // repoPath the union actually kept; querying by the LOSING side's identity finds nothing at all, which
    // is itself part of what this scenario is documenting (X's own identity becomes unqueryable).
    const entryAtKy = activeMergeQuarantineFor(y);
    check("(precondition) a single union entry is armed at Ky", !!entryAtKy);
    console.log(`(reversed-tie-break-no-protection-report-only) union winner's own repoPath: ${entryAtKy?.repoPath === y ? "Y (older)" : entryAtKy?.repoPath === x ? "X" : "neither (unexpected)"}`);

    if (entryAtKy?.repoPath === y) {
      // THE DEFERRED GAP (MAJOR #3, card 398f476c) — identityRepoPath === entry.repoPath, so
      // `clearMergeQuarantineByKey`'s own `clearingRepoPath` computation is `undefined`: no protection is
      // even attempted before the unconditional unlink destroys Ky's shared physical file, and X's own
      // token/identity has no surviving record anywhere. PRINTED, never asserted — see the decision
      // record and card 398f476c.
      clearMergeQuarantineByKey(ky, y);
      const pendingAfter = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
      console.log(`(reversed-tie-break-no-protection-report-only) *** DEFERRED GAP (398f476c) *** protective copies minted: ${pendingAfter.length} (expected 0 — X's own identity has no surviving record)`);
      console.log(`(reversed-tie-break-no-protection-report-only) *** DEFERRED GAP (398f476c) *** X still enforced anywhere: ${!!activeMergeQuarantineFor(x)} (expected false)`);
    } else {
      console.log("(reversed-tie-break-no-protection-report-only) union did not pick Y as the winner on this run — nothing to report for the reversed-ordering shape this scenario targets.");
    }
  } else if (scenarioName === "clear-by-id-refused-on-canonical-collision") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 9a55fb90 — clear-by-id must FAIL CLOSED when a different, currently-resolvable identity also
    // canonically owns the matched key, never silently pick one side. Same X/Y fixture as
    // in-memory-twin-clear-destroys-degraded-file, but clearing by the bare latch id (hash(Ky)) instead
    // of by Y's own repoPath. X's own refusal and Y's own refusal resolve to the SAME latch id (X's entry
    // wins activeMergeQuarantineFor's direct-tier unconditionally) — a human reading EITHER refusal and
    // using this id has no way to discriminate, so clear-by-id must refuse rather than guess which side
    // was meant. RED on pre-fix HEAD: this exact call hard-deletes X with no protective copy.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-cbic-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# clear-by-id-refused-on-canonical-collision\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-cbic-never-exists-${freshSfx()}`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-cbic-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine unconfirmed-kill reason", enteredAt: Date.now(), tokens: ["y-token"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(precondition) X's backing file exists before any clear", fs.existsSync(xFile));
    check("(precondition) X reads quarantined", !!activeMergeQuarantineFor(x));
    check("(precondition) Y reads quarantined too (blocked by X's own degraded occupation)", !!activeMergeQuarantineFor(y));
    const xBytesBefore = fs.readFileSync(xFile);

    const result = clearMergeQuarantineLatchFile(hashForKey(ky));

    check("*** THE FIX *** clear-by-id REFUSES on the collision (ok:false)", result.ok === false);
    check("*** THE FIX *** the refusal names BOTH candidate repoPaths", result.ok === false && result.reason.includes(x) && result.reason.includes(y));
    check("*** THE FIX *** the refusal points at clear-by-path", result.ok === false && result.reason.includes("clear-by-path"));
    check("*** THE FIX *** X's physical file is byte-identical — NEVER touched", fs.existsSync(xFile) && Buffer.compare(xBytesBefore, fs.readFileSync(xFile)) === 0);
    check("*** THE FIX *** no protective copy was minted (nothing was ever deleted, so nothing needed protecting)", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-")).length === 0);
    check("*** THE FIX *** X still reads quarantined after the refused clear", !!activeMergeQuarantineFor(x));
    check("*** THE FIX *** Y still reads quarantined (blocked) after the refused clear", !!activeMergeQuarantineFor(y));
    check("*** THE FIX *** Y's own stale source file still exists, untouched", fs.existsSync(yFile));
  } else if (scenarioName === "clear-by-id-ordinary-unchanged") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 9a55fb90, regression guard — an ORDINARY, non-colliding clear-by-id (the overwhelming
    // majority of real clears) must stay byte-identical: canonicalSiblingsFor finds nothing (no other
    // resolvable identity canonically owns this key), so the new refusal branch never fires.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const z = path.join(os.tmpdir(), `loom-mqp1mu-z-ordinary-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# clear-by-id-ordinary-unchanged\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const kz = canonicalRepoLockKey(z);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const zFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kz)}.json`);
    fs.writeFileSync(zFile, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, uncontested quarantine", enteredAt: Date.now(), tokens: ["z-token"], resolvedKey: kz,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z]);
    check("(precondition) Z reads quarantined before the clear", !!activeMergeQuarantineFor(z));

    const result = clearMergeQuarantineLatchFile(hashForKey(kz));

    check("*** UNCHANGED *** an ordinary, non-colliding clear-by-id still SUCCEEDS", result.ok === true);
    check("*** UNCHANGED *** liftedRepoPaths names Z", result.ok === true && result.liftedRepoPaths.includes(z));
    check("*** UNCHANGED *** Z's physical file is actually deleted", !fs.existsSync(zFile));
    check("*** UNCHANGED *** no spurious protective copy was minted", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-")).length === 0);
    check("*** UNCHANGED *** Z no longer reads quarantined", !activeMergeQuarantineFor(z));
  } else if (scenarioName === "collision-refusal-text-names-clear-by-path") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 9a55fb90 — assertRepoNotQuarantined's own refusal text must drop the bare-id shortcut (which
    // would now be refused as ambiguous anyway) and name only clear-by-path, for BOTH x's own refusal
    // AND y's (they resolve to the IDENTICAL q/latchId, per activeMergeQuarantineFor's direct-tier —
    // this is the exact fact that makes "pick the other identity" wrong and FAIL CLOSED the right call).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1mu-y-crt-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# collision-refusal-text-names-clear-by-path\n");
    execSync(`git init -q && git config user.email mqp1mu@loom && git config user.name mqp1mu`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1mu-x-crt-never-exists-${freshSfx()}`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-crt-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine unconfirmed-kill reason", enteredAt: Date.now(), tokens: ["y-token"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);

    const checkX = assertRepoNotQuarantined(x);
    const checkY = assertRepoNotQuarantined(y);
    check("(precondition) both x and y are refused", checkX.ok === false && checkY.ok === false);
    check("*** THE FIX *** x's own refusal points at clear-by-path", checkX.ok === false && checkX.reason.includes("clear-by-path"));
    check("*** THE FIX *** x's own refusal does NOT offer the ambiguous bare-id shortcut", checkX.ok === false && !/\{"id":/.test(checkX.reason));
    check("*** THE FIX *** y's own refusal (the byte-identical blocker) ALSO points at clear-by-path", checkY.ok === false && checkY.reason.includes("clear-by-path"));
    check("*** THE FIX *** y's own refusal ALSO omits the ambiguous bare-id shortcut", checkY.ok === false && !/\{"id":/.test(checkY.reason));
    check("*** THE FIX *** both refusals name both candidate repoPaths",
      checkX.ok === false && checkY.ok === false && checkX.reason.includes(x) && checkX.reason.includes(y) && checkY.reason.includes(x) && checkY.reason.includes(y));
    check("x's and y's refusals are byte-identical (same blocker, same id — exactly why a bare id can't discriminate)",
      checkX.ok === false && checkY.ok === false && checkX.reason === checkY.reason);
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? `\n✅ ${scenarioName}: ALL CHECKS PASS` : `\n❌ ${scenarioName}: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
