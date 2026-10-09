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
  quarantineLatchIdFor, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const report = (label, text) => { console.log(`REPORT  ${label}: ${text}`); }; // observation only — never counted as a failure
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
      check("(in-memory) no fresh-hash file was ever created for Y's own migration (the write was genuinely skipped, not silently retried elsewhere)", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json")).length === 2);
    }
  } else if (scenarioName === "in-memory-twin-clear-destroys-degraded-file") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 3, FINDING 2 (MAJOR, "Repro B") + the still-open in-memory twin (card d4b25feb, NOT fixed
    // here) in ONE fixture. The degraded-collision fall-through STILL unions X (degraded) and Y
    // (resolvable) into ONE in-memory entry (armQuarantineKey is unconditional, unchanged by this card on
    // purpose — only the WRITE is gated).
    //   - X's own backing file (sha(Ky).json): a human clearing Y lifts the shared union's `armedKeys`
    //     and deletes it as a side effect — the in-memory twin of 4480b077's own on-disk defect. This
    //     scenario REPORTS that result (card d4b25feb); it does not assert pass/fail on it.
    //   - Y's own migrating source (stale-y.json): round 2 left it UNTRACKED by the skip branch, so the
    //     SAME clear left it behind, and the NEXT boot re-migrated it successfully (X's own file is now
    //     gone too, so nothing blocks it) — resurrecting Y's quarantine the human just cleared. Round 3
    //     folds it into the shared union's own `orphanLatchFiles` so the SAME clear's existing orphan-sweep
    //     removes it too. THIS half IS asserted (pass/fail) — it's the fix round 3 actually makes.
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

    // THE CHECK — a human issues the ordinary, legitimate clear for Y (the resolvable repo).
    clearMergeQuarantine(y);

    const xFileSurvived = fs.existsSync(xFile);
    if (xFileSurvived) {
      report("in-memory-twin", "DID NOT REPRODUCE — X's own backing file survived clearMergeQuarantine(y). See the decision record for why (if determined) before relying on this as a general guarantee.");
    } else {
      report("in-memory-twin", "REPRODUCED — clearMergeQuarantine(y) deleted X's own backing file (sha(Ky).json) as a side effect of lifting the in-memory union's shared armedKeys. This is the in-memory twin of 4480b077's own on-disk defect, NOT fixed by card d4b25feb — split out and tracked on card c9114934.");
    }
    console.log(`(in-memory-twin) X's backing file exists after clearMergeQuarantine(y): ${xFileSurvived}`);

    // *** THE FIX (finding 2) *** — Y's own stale source must be swept too (via the fold into the
    // shared union's own orphanLatchFiles, consumed by clearMergeQuarantineByKey's existing orphan-sweep
    // loop), or it survives untouched and resurrects Y's quarantine on the next boot.
    check("*** THE FIX *** Y's own stale source is swept by the SAME clear (folded into the union's orphanLatchFiles)", !fs.existsSync(yFile));

    const reboot1 = await rebootSim();
    const foundAfterClear = reboot1.reenterMergeQuarantinesAtBoot([y, x]);
    check("*** THE FIX *** Y does NOT resurrect on a later boot — the human's clear actually stuck", !foundAfterClear.some((e) => e.repoPath === y));
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
