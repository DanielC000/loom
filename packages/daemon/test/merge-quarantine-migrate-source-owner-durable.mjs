import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 97cff6db (discovered from 4480b077 round-3 Code Review, reviewer 3ac19e17):
// reenterMergeQuarantinesAtBoot's write-all pass could land a boot-time write for key Kb on the exact
// physical file that is ANOTHER key Ka's own migrate SOURCE, regardless of whether Ka's own write to its
// fresh target had itself succeeded yet. When Ka's own write then failed (an open/write fault — not a
// rename fault, which already left a recoverable fsync'd tmp), the "old file(s) left in place so nothing
// is lost" fallback was FALSE the moment a sibling key's successful write had already overwritten that
// exact file this same pass — a durable fail-OPEN after a reboot (finding 1). The SAME hazard existed at
// a SECOND write call site, PASS 1b's own tmp-promotion write, which consulted neither
// migratedSourcesByKey nor writeTargetsThisPass at all (finding 1a). A THIRD variant needed no fault at
// all: the degraded-occupied skip folds a colliding sibling's migrate source into the DEGRADED occupant's
// own in-memory orphanLatchFiles only — an ordinary, correct clear of that unrelated degraded entry then
// deletes the sibling's only durable copy as pure collateral via sweepOrphanLatchFileIfUnreferenced's
// "nothing references it, delete" check (finding 1b). A MINOR, separate defect: the degraded-occupied
// fold's own byRepoKey mutation runs AFTER flushDegradedDiverts already snapshotted the pre-fold object
// into pendingUnresolvedQuarantines, so listActiveMergeQuarantines (Set-deduping by reference, not value)
// reports the same quarantine twice (Minor 2).
//
// ROUND 1's first fix (an inline, per-key safety-tmp write, named indistinguishably from an ordinary
// tmp) was itself found NOT MERGEABLE by Code Review 85f0f345 at commit 0f324c36: (CRITICAL 1) the
// safety-tmp was written immediately before a key's OWN write, never before a SIBLING's write that
// could clobber its source first — a crash at the wrong instant still lost data; (CRITICAL 2) two
// OTHER boot-time writes (the deferred-corrupt-tmp placeholder, and PASS 2's own orphan-reference
// writes) were completely ungated and could destroy an unrelated key's still-unprotected source;
// (MAJOR 3) the "blind-delete is always safe for a safety-tmp" premise was false — PASS 1b's shortcut
// gates on ANY clean `.json` resolving to a key, not the one true final, so a second, non-colliding
// stale source for the SAME key made it discard the safety-tmp (and the data it alone held) outright.
//
// ROUND 2's fix (current): ONE dedicated phase, before ANY boot write anywhere in this function,
// computes the complete set of paths the WHOLE boot will write to (every write site — the migrate
// pass, the tmp-promotion pass, the deferred-corrupt-tmp placeholder, and PASS 2's orphan-reference
// writes), then durably secures (fsync'd, directory fsync'd) every at-risk migrate source's safety-tmp
// BEFORE any of those writes runs — closing the ordering hazard. If a safety-tmp write itself fails,
// every write targeting one of ITS colliding sources is also blocked this boot (`blockedWriteTargets`),
// never just the at-risk key's own — closing the "protect A but still let B destroy A's source" gap.
// A safety-tmp is now named distinguishably (`.tmp-safety-<pid>-<hex>`, disjoint by regex from an
// ordinary `.tmp-<pid>(-<hex>)?` residue) so recovery can tell the two apart BY NAME: an ordinary tmp
// keeps today's blind-delete-beside-a-clean-final behavior (closing MAJOR 3 — a safety-tmp simply
// never reaches that code path, regardless of how many other clean sources exist for the same key); a
// safety-tmp instead ALWAYS unions into its key's final, deleted only once that union is durable.
//
// See docs/decisions/97cff6db-migrate-source-owner-durable-before-write.md for the full repro + fix
// narrative and the RED/GREEN accounting.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-migrate-source-owner-durable.mjs
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
  "finding1-migrate-pass-sibling-collision",
  "finding1a-tmp-promotion-pass-sibling-collision",
  "finding1b-degraded-skip-clear-destroys-sibling",
  "minor2-stale-snapshot-double-report",
  "safety-tmp-recovery-always-unions-into-existing-final",
  "safety-tmp-crash-after-success-before-delete-is-fail-closed",
  "round2-A-second-noncolliding-source-defeats-blind-delete-premise",
  "round2-B-deferred-corrupt-tmp-placeholder-write-ungated",
  "round2-C-pass2-orphan-placeholder-write-ungated",
  "round2-D-crash-shaped-no-fault-ordering-hazard",
  "round3-E-degraded-occupied-source-clobbered",
  "round3-F-safety-recovery-write-ungated",
  "round3-minor3-unparseable-safety-tmp-gets-placeholder",
  "round3-minor4-deferred-corrupt-placeholder-survives-phase3-delete",
  "round4-G1-same-boot-graduation-deletes-sibling-target",
  "round4-G2-recovery-writeback-clobbers-degraded-occupant",
  // Card a2f381dc (M-1) — the OTHER tie-break ordering for this same collision shape: the degraded
  // occupant X wins the union instead of sub. See docs/decisions/a2f381dc-same-identity-union-repoint-and-boot-return-dedupe.md.
  "round4-G2-reversed-occupant-wins-union",
  "round4-finding1b-sub-older",
  "round4-minor2-sub-older",
  "round4-E-sub-older",
  "round4-minor1-safety-recovery-double-report",
  "round4-minor2-unparseable-safety-tmp-full-fallback",
  "round4-d163aef5-pass2-degraded-bypass",
  "round5-G1a-same-boot-clear-then-reboot-destroys-safety-tmp",
  "round5-G1a-same-boot-clear-then-reboot-sub-older",
  "round5-minor1-stale-resolvedkey-registration-liveness",
  // Card ef651188 (Code Review e0777155's own SEPARATE finding, not round 5's blocking gap): Phase 0's
  // at-risk set never treated a PENDING entry's own sourceFile as at-risk — see
  // docs/decisions/ef651188-pending-entry-sourcefile-at-risk.md for the full repro + fix narrative.
  "ef651188-site1-deferred-corrupt-tmp-placeholder",
  "ef651188-site2-migrate-pass-order-a",
  "ef651188-site2-migrate-pass-order-b",
  "ef651188-site3-tmp-promotion",
  "ef651188-site4-phase3-repersist-SKIP",
  "ef651188-site5-pass2-existing-orphan-ref-SKIP",
  "ef651188-site6-pass2-fresh-placeholder-order-a",
  "ef651188-site6-pass2-fresh-placeholder-order-b",
  "ef651188-site7-recovery-writeback",
  "ef651188-degraded-coexistence-no-interference",
  "ef651188-safety-write-fails-blocks-colliding-write",
  "ef651188-same-boot-clear-then-reboot-survives",
  "ef651188-negative-control-no-collision",
  "ef651188-backstop-refuses-when-phase0-bypassed",
  // Card ef651188, ROUND 2 (Code Review b4742106) — CRITICAL 1 + MAJOR, both reproduced against round-1
  // commit aea9cac3. See docs/decisions/ef651188-pending-entry-sourcefile-at-risk.md's round-2 section.
  "ef651188-multiboot-clear-in-boot2-order-a",
  "ef651188-multiboot-clear-in-boot2-order-b",
  "ef651188-multiboot-4boot-stability",
  "ef651188-degraded-divert-pass2-orphan-no-growth",
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
    ? "\n✅ ALL SCENARIOS PASS — ONE phase secures every at-risk migrate source's safety-tmp (named "
      + "distinguishably) before ANY boot write runs, blocking a colliding write outright if that "
      + "securing itself fails; a degraded-occupied fold protects a colliding sibling's source from an "
      + "unrelated clear and reports the shared quarantine exactly once; a safety-tmp ALWAYS unions into "
      + "its final, never blind-deleted like an ordinary stale tmp beside a clean final."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 97cff6db.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqmsod-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, reenterMergeQuarantinesAtBootTestOnly, activeMergeQuarantineFor, clearMergeQuarantine, MERGE_QUARANTINE_DIR,
  listActiveMergeQuarantines, PLACEHOLDER_BRANCH_CORRUPT, assertQuarantineIdentityInvariantTestOnly,
  quarantineLatchFileIdsFor, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqmsod@loom -c user.name=mqmsod";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// P (a repo) with teamA (a plain subdir, no `.git` of its own — collapses onto P's own key Kp) and sub
// (its OWN SEPARATE nested repo, own `.git`, own real key Ksub != Kp) — same shape as
// merge-quarantine-pass1-migrate-union.mjs's own `makeRepoWithNestedRepoAndSubdir`.
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqmsod-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "sub");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

function placeStaleBeforeFixed(fixedPath, staleCandidatePath) {
  fs.writeFileSync(staleCandidatePath, "{}");
  fs.writeFileSync(fixedPath, "{}");
  const order = fs.readdirSync(path.dirname(fixedPath));
  const idxStale = order.indexOf(path.basename(staleCandidatePath));
  const idxFixed = order.indexOf(path.basename(fixedPath));
  if (idxStale >= idxFixed) {
    throw new Error(`expected ${path.basename(staleCandidatePath)} to sort before ${path.basename(fixedPath)}`);
  }
}

/** The OTHER age order from {@link placeStaleBeforeFixed} — `staleCandidatePath` sorts AFTER
 *  `fixedPath` on this filesystem. Caller picks a name (e.g. a "~" prefix) that actually achieves this;
 *  this only verifies it, matching `placeStaleBeforeFixed`'s own verify-don't-assume posture. */
function placeStaleAfterFixed(fixedPath, staleCandidatePath) {
  fs.writeFileSync(fixedPath, "{}");
  fs.writeFileSync(staleCandidatePath, "{}");
  const order = fs.readdirSync(path.dirname(fixedPath));
  const idxStale = order.indexOf(path.basename(staleCandidatePath));
  const idxFixed = order.indexOf(path.basename(fixedPath));
  if (idxStale <= idxFixed) {
    throw new Error(`expected ${path.basename(staleCandidatePath)} to sort AFTER ${path.basename(fixedPath)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Card ef651188's own shared fixture helpers — Y is a GENUINELY PENDING entry (no resolvedKey, path
// never exists at all), a DIFFERENT shape from every "sub"/"X" fixture above (always either resolvable
// or degraded-via-resolvedKey). See docs/decisions/ef651188-pending-entry-sourcefile-at-risk.md.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** `repo` (registered, real git repo) + `teamA` (a plain subdir of `repo`, no own `.git` — collapses
 *  onto `repo`'s own key `kp`) + `y` (a path that is NEVER created on disk at all). */
function makeEf651188Fixture(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqef-repo-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  fs.mkdirSync(teamA, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const kp = canonicalRepoLockKey(repo);
  const y = path.join(os.tmpdir(), `loom-mqef-y-ghost-${tag}-${freshSfx()}`); // NEVER created
  check(`(precondition, ${tag}) Y never exists on disk at all`, !fs.existsSync(y));
  return { repo, teamA, kp, y };
}

/** Write Y's own latch directly, with NO `resolvedKey` — hits PASS 1's "no recorded resolvedKey and
 *  could NOT be verified" branch, landing Y in `pendingUnresolvedQuarantines` with `sourceFile` = the
 *  exact filename `atPath` names (the caller picks `atPath` to be the physical collision spot). */
function writeGhostPendingLatch(atPath, y, tag) {
  fs.writeFileSync(atPath, JSON.stringify({
    repoPath: y, branch: "y-branch",
    reason: `Y's REAL reason (${tag}) — must survive teamA's colliding write with no resolvedKey of its own`,
    enteredAt: Date.now() - 60_000, tokens: [`token-y-${tag}`],
  }, null, 2) + "\n");
}

/** Shared post-boot assertions for the whole ef651188 family: teamA's own colliding write actually
 *  landed on Y's exact physical file THIS boot (positive control), then a REAL reboot recovers Y's
 *  pending quarantine (the fix) while teamA itself stays enforced by SOME entry (sanity — teamA's own
 *  content varies by write site: a real raised token for the migrate/tmp-promotion/PASS2 sites, a
 *  fail-closed PLACEHOLDER for the corrupt-tmp/recovery-write-back sites, so this checks presence only;
 *  a scenario wanting teamA's SPECIFIC token adds its own extra check on top). Returns the fresh module
 *  instance for any scenario-specific extra checks/cleanup. */
async function assertEf651188Survival(label, { teamA, y, kpPath, tag, registered }) {
  check(
    `(positive control, ${label}) teamA's own write landed on Y's exact physical file`,
    fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA,
  );
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot(registered);
  const yAfterReboot = fresh.activeMergeQuarantineFor(y);
  check(
    `*** THE FIX (${label}) *** after a real reboot, Y's PENDING quarantine SURVIVES teamA's colliding write`,
    !!yAfterReboot && (yAfterReboot.tokens ?? []).includes(`token-y-${tag}`),
  );
  const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
  check(`(sanity, ${label}) teamA itself is still enforced by some entry after the reboot`, !!teamAAfterReboot);
  return fresh;
}

/** Run `fn` with console.error/console.warn temporarily tee'd into a captured array (still printed to
 *  the real console too), restoring both unconditionally. Used to assert a specific log line did/did
 *  NOT fire, since no scenario in this file has needed that until round 5's own Minor 1 liveness test. */
async function captureConsole(fn) {
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args) => { lines.push(String(args[0] ?? "")); realError(...args); };
  console.warn = (...args) => { lines.push(String(args[0] ?? "")); realWarn(...args); };
  try {
    await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return lines;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "finding1-migrate-pass-sibling-collision") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Finding 1 (MAIN). sub's own latch sits at sha(Kp).json — teamA's own correct, eventual migrate
    // TARGET. teamA ALSO has its own stale-named latch migrating TO sha(Kp).json. Inject a write failure
    // on sub's OWN fresh target (sha(Ksub).json) — teamA's own write (to the SAME shared file sub's stale
    // data occupies) succeeds in the SAME pass regardless.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("f1");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);

    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    // The safety-tmp write and the real write use the IDENTICAL tmp-naming scheme (both target
    // sub's own fresh hash) -- fail only the SECOND matching open (the real write), letting the FIRST
    // (the safety-tmp) succeed, mirroring the card's own "open/write fault on the real write, not the
    // safety floor" repro shape.
    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        if (matchCount === 2) {
          throw Object.assign(new Error("EACCES: simulated migrate-write failure for sub"), { code: "EACCES" });
        }
      }
      return realOpenSync(p, ...rest);
    };
    try {
      reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    } finally {
      fs.openSync = realOpenSync;
    }
    check("(positive control) sub's safety-tmp write AND its real write were both attempted (and the second injected to fail)", matchCount >= 2);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX *** after a real restart, sub's quarantine SURVIVES (recovered from the safety-tmp)",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub"),
    );
    const teamAAfterRestart = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own quarantine is unaffected and still present", !!teamAAfterRestart && (teamAAfterRestart.tokens ?? []).includes("token-teamA"));

    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
    const after2 = await freshBootModule();
    after2.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    check("(cleanup) neither quarantine resurrects after both are cleared", !after2.activeMergeQuarantineFor(teamA) && !after2.activeMergeQuarantineFor(sub));
  } else if (scenarioName === "finding1a-tmp-promotion-pass-sibling-collision") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Finding 1a. SAME shape as finding1, except teamA's own data arrives via a RECOVERED TMP RESIDUE
    // (PASS 1b's own tmp-promotion write pass) instead of a stale-named FINAL (PASS 1's migrate pass).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("f1a");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");

    // teamA has NO proper final at all -- only a tmp residue -- so its only route to sha(Kp).json is
    // the TMP-PROMOTION write pass, not the ordinary migrate pass.
    const teamATmpPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-tmp-${freshSfx()}.json.tmp-999999`);
    fs.writeFileSync(teamATmpPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own recovered-tmp raise", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    // Same technique as finding1's own scenario: fail only the SECOND matching open (the real write),
    // letting the safety-tmp write succeed first.
    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        if (matchCount === 2) {
          throw Object.assign(new Error("EACCES: simulated migrate-write failure for sub"), { code: "EACCES" });
        }
      }
      return realOpenSync(p, ...rest);
    };
    try {
      reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    } finally {
      fs.openSync = realOpenSync;
    }
    check("(positive control) sub's safety-tmp write AND its real write were both attempted (and the second injected to fail)", matchCount >= 2);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (1a) *** after a real restart, sub's quarantine SURVIVES via the tmp-promotion pass's own safety-tmp",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub"),
    );
    const teamAAfterRestart = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own quarantine is unaffected and still present", !!teamAAfterRestart && (teamAAfterRestart.tokens ?? []).includes("token-teamA"));
    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "finding1b-degraded-skip-clear-destroys-sibling") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Finding 1b. "No fault needed" -- an ORDINARY, successful clear of the DEGRADED entry X (no write
    // failure anywhere) used to sweep X's own orphanLatchFiles, which the degraded-skip fold ALSO
    // populated with Y's own still-pending migrate source -- destroying Y's only durable copy as a side
    // effect of a clear that was never about Y at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-y1b-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# finding1b Y\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqmsod-x1b-never-exists-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `!stale-y1b-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-1b"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine reason -- must survive a clear of the UNRELATED degraded entry X",
      enteredAt: Date.now(), tokens: ["y-token-1b"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(this boot) the stale-y file is still on disk, unresolved (degraded-skip never writes/deletes)", fs.existsSync(yFile));

    // An ORDINARY human clear of X -- the only repo a human operating on this collision would know to
    // clear directly (Y's own stale latch is invisible under Y's own identity in this scenario).
    clearMergeQuarantine(x);
    check(
      "*** THE FIX (1b) *** clearing the UNRELATED degraded entry X no longer deletes Y's own still-pending migrate source",
      fs.existsSync(yFile),
    );

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, x]);
    const yAfterRestart = fresh.activeMergeQuarantineFor(y);
    check(
      "*** THE FIX (1b), CONFIRMED *** after restart, Y's quarantine SURVIVES -- no fault/IO error needed to close this",
      !!yAfterRestart && (yAfterRestart.tokens ?? []).includes("y-token-1b"),
    );
    fresh.clearMergeQuarantine(y);
  } else if (scenarioName === "minor2-stale-snapshot-double-report") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Minor 2. The degraded-skip fold mutates byRepoKey to a NEW object (spread) AFTER
    // flushDegradedDiverts already pushed the PRE-fold object reference into pendingUnresolvedQuarantines.
    // listActiveMergeQuarantines Set-dedupes by object identity, so the two different references for
    // conceptually the SAME quarantine both used to survive the dedupe.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# minor2 Y\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqmsod-x-never-exists-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `!stale-y-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine reason", enteredAt: Date.now(), tokens: ["y-token"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);

    // X is the "older" side of the union (its enteredAt is earlier), so the LIVE shared union's own
    // repoPath field is X's. THE MINOR 2 FIX: X's own divert (flushDegradedDiverts's pre-fold snapshot)
    // must be re-pointed to the SAME live object, not left as a second, stale reference — count entries
    // whose repoPath is X's own: exactly one, never two, is what closes Minor 2 specifically.
    const list = listActiveMergeQuarantines();
    const xEntries = list.filter((e) => e.repoPath === x);
    check(
      "*** THE FIX (Minor 2) *** X's own shared-union divert is reported EXACTLY ONCE, never twice (the stale pre-fold snapshot is no longer a second, un-collapsed reference)",
      xEntries.length === 1,
    );
    // Y's own NEW protective entry (card 97cff6db finding 1b's own fix) is a DIFFERENT, legitimately
    // ADDITIVE report -- Y had NO representation at all before that fix, so this is not a duplicate of
    // X's entry and is reported separately, by design (not itself a thing Minor 2 governs).
    const yEntries = list.filter((e) => e.repoPath === y);
    console.log(`REPORT  Y's own additive entry count (from finding 1b's fix, not Minor 2's own scope): ${yEntries.length}`);
    clearMergeQuarantine(x);
  } else if (scenarioName === "safety-tmp-recovery-always-unions-into-existing-final") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Lead ruling 2 (round 2): a SAFETY-TMP residue is named distinguishably (`.tmp-safety-<pid>-<hex>`)
    // so recovery can tell it apart from an ORDINARY stale tmp BY NAME, never by inference. Recovery
    // ALWAYS unions a safety-tmp into the final for its key -- even when (as here) the final already
    // exists with a DIFFERENT, newer token the safety-tmp doesn't have -- and deletes it only once that
    // union is durably re-persisted. This is DELIBERATELY different from an ORDINARY tmp beside a clean
    // final (still a blind delete -- see merge-quarantine-boot-hardening.mjs's TW-stale scenario,
    // merge-quarantine-pass1b-clean-parse-gate.mjs's STALE scenario, and
    // merge-quarantine-pass1-degraded-union-guard.mjs's pass1b-resolvable-stale-tmp-still-deleted): the
    // two tmp shapes are disjoint by filename pattern precisely so BOTH behaviors can coexist correctly.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const k = path.join(os.tmpdir(), `loom-mqmsod-k-${freshSfx()}`);
    fs.mkdirSync(k, { recursive: true });
    tmpDirs.push(k);
    fs.writeFileSync(path.join(k, "README.md"), "# safety-tmp recovery K\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: k });
    commitAll(k, "init", GIT_ID);
    const kk = canonicalRepoLockKey(k);
    const kHash = hashForKey(kk);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${kHash}.json`);
    const safetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${kHash}.json.tmp-safety-424242-aabbccdd`);
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: k, branch: "k-branch", reason: "K's current, up-to-date reason", enteredAt: Date.now(), tokens: ["token-new"],
    }, null, 2) + "\n");
    fs.writeFileSync(safetyTmpPath, JSON.stringify({
      repoPath: k, branch: "k-branch", reason: "K's reason as of an earlier safety-tmp write", enteredAt: Date.now() - 60_000, tokens: ["token-old"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([k]);

    check("(cleanup) the recovered safety-tmp residue is gone after processing", !fs.existsSync(safetyTmpPath));
    const active = activeMergeQuarantineFor(k);
    check("*** THE FIX (ruling 2) *** the final's NEWER token survived", !!active && (active.tokens ?? []).includes("token-new"));
    check("*** THE FIX (ruling 2) *** the safety-tmp's OLDER token was UNIONED IN, never silently dropped", !!active && (active.tokens ?? []).includes("token-old"));
    const persisted = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    check("*** THE FIX (ruling 2) *** the PERSISTED final (not just in-memory) carries BOTH tokens", (persisted.tokens ?? []).includes("token-new") && (persisted.tokens ?? []).includes("token-old"));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([k]);
    const afterRestart = fresh.activeMergeQuarantineFor(k);
    check("(reboot-sim) both tokens still present reading only the on-disk final", (afterRestart?.tokens ?? []).includes("token-new") && (afterRestart?.tokens ?? []).includes("token-old"));
    fresh.clearMergeQuarantine(k);
  } else if (scenarioName === "safety-tmp-crash-after-success-before-delete-is-fail-closed") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Lead condition 3. Document + test the crash window: writeSafetyTmpResidue succeeds, the REAL write
    // then ALSO succeeds, but the crash lands before this process gets to delete the now-redundant safety
    // tmp. The NEXT boot must never resurrect anything WRONG from this -- at worst it re-persists a union
    // that is a harmless superset (an extra, already-stale token folded back in, per the ruling-2 union
    // fix above) -- fail-CLOSED (sticks around a little longer than strictly needed), never fail-OPEN
    // (never loses the entry, never un-quarantines it). Manufacture exactly this post-crash state by hand
    // (both the final AND the safety tmp already on disk, matching what a real crash in that window would
    // leave) rather than injecting into a live write -- the window itself is just a few instructions wide
    // and not meaningfully exercisable any other way in a hermetic test.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const k = path.join(os.tmpdir(), `loom-mqmsod-crashwin-${freshSfx()}`);
    fs.mkdirSync(k, { recursive: true });
    tmpDirs.push(k);
    fs.writeFileSync(path.join(k, "README.md"), "# crash-window K\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: k });
    commitAll(k, "init", GIT_ID);
    const kk = canonicalRepoLockKey(k);
    const kHash = hashForKey(kk);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${kHash}.json`);
    const crashedSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${kHash}.json.tmp-safety-${process.pid}-deadbeef`);
    const content = { repoPath: k, branch: "k-branch", reason: "K's real reason, crash-window scenario", enteredAt: Date.now(), tokens: ["token-k-crashwin"] };
    // The real write succeeded (the final exists) AND the safety tmp (identical content -- it was written
    // moments before the real write, same boot) survived the crash that landed before its own cleanup.
    fs.writeFileSync(finalPath, JSON.stringify(content, null, 2) + "\n");
    fs.writeFileSync(crashedSafetyTmpPath, JSON.stringify(content, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([k]);
    check("(cleanup) the crash-surviving safety tmp is swept on the next boot", !fs.existsSync(crashedSafetyTmpPath));
    const active = activeMergeQuarantineFor(k);
    check(
      "*** THE FIX (condition 3) *** NEVER FAIL-OPEN -- the quarantine is still fully enforced after this cleanup",
      !!active && (active.tokens ?? []).includes("token-k-crashwin"),
    );
    const persisted = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    check("(fail-closed, not corrupted) the persisted final still carries the real token", (persisted.tokens ?? []).includes("token-k-crashwin"));

    // And the OTHER half of the crash window: a human legitimately clears K AFTER this -- the leftover
    // (already-swept, in this run) safety tmp must not be able to resurrect anything on a LATER boot.
    clearMergeQuarantine(k);
    const fresh = await freshBootModule();
    const found = fresh.reenterMergeQuarantinesAtBoot([k]);
    check("(no resurrection) a legitimately cleared quarantine does not come back", !found.some((e) => e.repoPath === k) && !fresh.activeMergeQuarantineFor(k));
  } else if (scenarioName === "round2-A-second-noncolliding-source-defeats-blind-delete-premise") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-2 Code Review 85f0f345, CRITICAL/MAJOR 3. sub has TWO stale sources: s1 at sha(Kp).json
    // (teamA's own correct migrate target -- the usual collision) AND a SECOND, entirely
    // non-colliding stale source s2 (an ordinary extra raise, named anywhere else). PASS 1b's
    // "already covered" shortcut gated on `cleanlyParsedKeys` alone, which ANY clean .json resolving to
    // sub's key populates -- including s2, read well before sub's OWN fresh final is ever written this
    // boot. On a restart after sub's own migrate write fails, s2's own clean parse made the shortcut
    // blind-delete sub's safety-tmp (the ONLY surviving copy of s1) before it was ever read, permanently
    // losing s1. The fix (distinguishable safety-tmp naming, round 2) means this shortcut's own
    // `tmpFiles` scan never matches a safety-tmp at all, regardless of how many OTHER clean sources
    // exist for the same key.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r2a");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({ repoPath: sub, branch: "sub-branch", reason: "sub REAL reason s1", enteredAt: Date.now() - 60_000, tokens: ["token-sub-s1"] }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA"] }, null, 2) + "\n");
    // sub's SECOND, non-colliding stale source -- a distinct, ordinary raise, never at any target path.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `!stale-sub2-${freshSfx()}.json`), JSON.stringify({ repoPath: sub, branch: "sub-branch-2", reason: "sub second raise s2", enteredAt: Date.now(), tokens: ["token-sub-s2"] }, null, 2) + "\n");

    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        if (matchCount === 2) throw Object.assign(new Error("EACCES sim"), { code: "EACCES" });
      }
      return realOpenSync(p, ...rest);
    };
    try { reenterMergeQuarantinesAtBoot([repo, teamA, sub]); } finally { fs.openSync = realOpenSync; }
    check("(positive control) sub's safety-tmp write AND its real write were both attempted", matchCount >= 2);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 2, finding A) *** sub's s1 raise SURVIVES restart despite a second, non-colliding stale source",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub-s1"),
    );
    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round2-B-deferred-corrupt-tmp-placeholder-write-ungated") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-2 Code Review 85f0f345, CRITICAL 2 item (a). teamA's only evidence is a CORRUPT torn-write
    // tmp at its own hash (no real final anywhere for teamA) -- the deferredCorruptTmps resolution's
    // "no real sibling data" branch fabricates a placeholder for teamA and writes it UNGATED, straight
    // to teamA's own target, which physically IS sub's own still-present stale source (sha(Kp).json).
    // This write ran chronologically BEFORE sub ever got a chance to protect itself in the PRE-round-2
    // code (safety-tmp written inline, inside phase 1a, long after this resolution loop had already
    // run). Fixed by gating this write on `blockedWriteTargets`/counting it in `allBootWriteTargets` so
    // Phase 0 secures sub FIRST, and skipping the write outright if sub's own securing failed too.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r2b");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(subAtKpPath, JSON.stringify({ repoPath: sub, branch: "sub-branch", reason: "sub REAL reason s1", enteredAt: Date.now() - 60_000, tokens: ["token-sub-s1"] }, null, 2) + "\n");
    // A CORRUPT torn-write tmp at teamA's OWN hash -- no real final anywhere for teamA.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json.tmp-999999`), "{ torn");

    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        if (matchCount === 1) throw Object.assign(new Error("EACCES sim"), { code: "EACCES" });
      }
      return realOpenSync(p, ...rest);
    };
    try { reenterMergeQuarantinesAtBoot([repo, teamA, sub]); } finally { fs.openSync = realOpenSync; }
    check("(positive control) sub's own safety-tmp write was attempted (and injected to fail)", matchCount >= 1);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 2, finding B) *** sub's s1 raise SURVIVES -- the deferred-corrupt-tmp placeholder write never clobbered it",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub-s1"),
    );
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round2-C-pass2-orphan-placeholder-write-ungated") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-2 Code Review 85f0f345, CRITICAL 2 (PASS 2's own share). `repo` and `teamA` share one key
    // (Kp) and have NO entry of their own from PASS 1/1b (sub's stale data merely happens to be NAMED
    // at hash(Kp), it is never armed there). An unrelated orphan file makes PASS 2 fabricate a fresh,
    // UNGATED placeholder for `repo` (the first registeredRepoPath sharing Kp), writing it straight to
    // quarantinePathFor(repo) == sha(Kp).json == sub's own still-present stale source. Fixed the same
    // way as finding B: PASS 2's own targets are counted in Phase 0's `allBootWriteTargets`, and this
    // write is skipped outright (in-memory only) if sub's own securing failed.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r2c");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(subAtKpPath, JSON.stringify({ repoPath: sub, branch: "sub-branch", reason: "sub REAL reason s1", enteredAt: Date.now() - 60_000, tokens: ["token-sub-s1"] }, null, 2));
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "ffffffffffffffffffffffff.json"), "{ corrupt orphan");

    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        throw Object.assign(new Error("EACCES sim"), { code: "EACCES" });
      }
      return realOpenSync(p, ...rest);
    };
    try { reenterMergeQuarantinesAtBoot([repo, teamA, sub]); } finally { fs.openSync = realOpenSync; }
    check("(positive control) sub's own write(s) were attempted (and injected to fail)", matchCount >= 1);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 2, finding C) *** sub's s1 raise SURVIVES -- PASS 2's own orphan-placeholder write never clobbered it",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub-s1"),
    );
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round2-D-crash-shaped-no-fault-ordering-hazard") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-2 Code Review 85f0f345, CRITICAL 1. NO fault injection at all -- a pure CRASH-shaped repro.
    // The pre-round-2 code wrote a key's own safety-tmp INLINE, immediately before attempting ITS OWN
    // real write, inside a single per-key loop over migratedSourcesByKey -- so whichever key's
    // iteration ran first (readdir/Map insertion order) could complete its ENTIRE write (clobbering the
    // other's still-present stale source) before the OTHER key's iteration -- and so its own safety-tmp
    // -- had even started. Snapshot the disk at the EXACT instant sub's safety-tmp open begins (via a
    // monkeypatched fs.openSync, never throwing -- this is not a fault, just an observation point),
    // then "crash" by restoring that snapshot and booting fresh. Round 2's fix writes EVERY at-risk
    // key's safety-tmp in ONE dedicated phase, fully, BEFORE any real write anywhere in this function
    // runs -- so this snapshot must already show sub's source untouched, regardless of processing order.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r2d");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({ repoPath: sub, branch: "sub-branch", reason: "sub REAL reason s1", enteredAt: Date.now() - 60_000, tokens: ["token-sub-s1"] }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA"] }, null, 2) + "\n");

    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    let snapDir;
    let snapContent;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        if (matchCount === 1) {
          // The instant sub's OWN safety-tmp open begins -- snapshot the directory's byte-for-byte state
          // right here, before letting the real open (and anything after it) proceed.
          snapDir = path.join(os.tmpdir(), `loom-mqmsod-r2d-snap-${freshSfx()}`);
          fs.cpSync(MERGE_QUARANTINE_DIR, snapDir, { recursive: true });
          snapContent = JSON.parse(fs.readFileSync(subAtKpPath, "utf8"));
        }
      }
      return realOpenSync(p, ...rest);
    };
    try { reenterMergeQuarantinesAtBoot([repo, teamA, sub]); } finally { fs.openSync = realOpenSync; }
    check("(positive control) the snapshot was actually taken at sub's own safety-tmp open", matchCount >= 1 && !!snapDir);
    check(
      "*** THE FIX (round 2, finding D) *** AT THE INSTANT sub's safety-tmp open begins, sha(Kp).json STILL holds sub's own data (teamA has not written yet)",
      !!snapContent && (snapContent.tokens ?? []).includes("token-sub-s1"),
    );

    // "Crash" — restore the snapshot (discard anything written after that instant) and boot fresh.
    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
    fs.cpSync(snapDir, MERGE_QUARANTINE_DIR, { recursive: true });
    fs.rmSync(snapDir, { recursive: true, force: true });

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 2, finding D), CONFIRMED *** sub's s1 raise SURVIVES a crash at the exact pre-round-2 ordering hazard",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub-s1"),
    );
    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round3-E-degraded-occupied-source-clobbered") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-3 Code Review b8a7b74f, CRITICAL (repro E, NO fault needed) -- the card's own original
    // finding (b). X degraded-occupies sub's OWN key Ksub (its recorded resolvedKey). sub's own (only)
    // latch sits at sha(Kp).json -- the usual collision shape -- and migrates to Ksub. Phase 0's at-risk
    // computation used to SKIP Ksub entirely because degradedOccupiedKeys.has(Ksub) was true, even
    // though sub's migrate SOURCE is exactly as at-risk as any other: teamA's own (non-degraded) write
    // physically lands on that same file regardless, with no fault needed at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r3e");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r3e-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive X's degraded occupation of Ksub", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    // NO fault injection at all -- this is a pure no-fault repro (the card's own original finding (b)).
    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const onDiskAfterThisBoot = fs.readdirSync(MERGE_QUARANTINE_DIR).map((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).join("\n");
    check("(this boot) sub's own token survives SOMEWHERE on disk (a safety-tmp, since teamA's write clobbers sub's stale location)", onDiskAfterThisBoot.includes("token-sub"));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 3, finding E) *** after a real restart, sub's quarantine SURVIVES despite its migrate target being degraded-occupied",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub"),
    );

    fresh.clearMergeQuarantine(x); // an ordinary clear of the UNRELATED degraded entry
    const after2 = await freshBootModule();
    after2.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterClearAndReboot = after2.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 3, finding E), CONFIRMED *** even after clearing the unrelated degraded entry X, sub is STILL quarantined (fail-closed)",
      !!subAfterClearAndReboot && (subAfterClearAndReboot.tokens ?? []).includes("token-sub"),
    );
    after2.clearMergeQuarantine(teamA);
    after2.clearMergeQuarantine(sub);
  } else if (scenarioName === "round3-F-safety-recovery-write-ungated") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-3 Code Review b8a7b74f, MAJOR/CRITICAL (repro F). A PRIOR boot's own leftover safety-tmp
    // residue for teamA's key Kp sits on disk (no proper .json final for teamA anywhere). sub's own
    // (only) latch ALSO sits at sha(Kp).json (the usual collision -- sub migrates FROM there to its own
    // key Ksub). The end-of-boot safety-tmp recovery write-back used to consult neither
    // allBootWriteTargets nor blockedWriteTargets at all, so when sub's own securing fails (fault
    // injected on sub's own hash), the recovery write-back still went ahead and overwrote sub's only
    // remaining copy with teamA's recovered data.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r3f");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    // A leftover SAFETY-TMP residue for teamA's key (Kp), from an EARLIER boot -- no proper .json final
    // for teamA anywhere; this is its only durable representation on disk right now.
    const teamALeftoverSafetyTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json.tmp-safety-1234-abcdef01`);
    fs.writeFileSync(teamALeftoverSafetyTmp, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own leftover safety-tmp from an earlier boot", enteredAt: Date.now() - 1_000, tokens: ["token-teamA"],
    }, null, 2) + "\n");
    // sub's only latch sits at sha(Kp).json -- the safety-tmp recovery's own eventual write target.
    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive teamA's recovery write-back", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");

    // Fault: sub's OWN write (its migrate target hash) fails on every matching tmp open.
    const ksubHash = hashForKey(ksub);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(ksubHash) && p.includes(".tmp-")) {
        matchCount++;
        throw Object.assign(new Error("EACCES: simulated failure for sub"), { code: "EACCES" });
      }
      return realOpenSync(p, ...rest);
    };
    try {
      reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    } finally {
      fs.openSync = realOpenSync;
    }
    check("(positive control) sub's own write was attempted (and injected to fail)", matchCount >= 1);

    const onDiskAfterThisBoot = fs.readdirSync(MERGE_QUARANTINE_DIR).map((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).join("\n");
    check(
      "*** THE FIX (round 3, finding F) *** with sub's write failing, tok-sub still exists SOMEWHERE on disk (teamA's recovery write-back was BLOCKED, not merely slow)",
      onDiskAfterThisBoot.includes("token-sub"),
    );

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 3, finding F), CONFIRMED *** after a real restart (no fault this time), sub is still quarantined",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub"),
    );
    const teamAAfterRestart = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own recovered quarantine is unaffected and still present", !!teamAAfterRestart && (teamAAfterRestart.tokens ?? []).includes("token-teamA"));
    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round3-minor3-unparseable-safety-tmp-gets-placeholder") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 3, MINOR 3. An UNPARSEABLE/corrupt safety-tmp residue, matching a registered repo's own
    // hash, used to get nothing but a console.error -- no in-memory placeholder at all, unlike the
    // sibling corrupt-.json/corrupt-tmp handling (deferredCorruptJsons/deferredCorruptTmps), which both
    // fail CLOSED via a pendingUnresolvedQuarantines placeholder. A genuinely corrupt safety-tmp (never
    // expected in practice, since Loom writes these itself) left NOTHING enforcing k's quarantine.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const k = path.join(os.tmpdir(), `loom-mqmsod-r3m3-${freshSfx()}`);
    fs.mkdirSync(k, { recursive: true });
    tmpDirs.push(k);
    fs.writeFileSync(path.join(k, "README.md"), "# minor3 K\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: k });
    commitAll(k, "init", GIT_ID);
    const kk = canonicalRepoLockKey(k);
    const kHash = hashForKey(kk);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // A CORRUPT, unparsable safety-tmp -- no proper .json final anywhere for k either.
    const corruptSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${kHash}.json.tmp-safety-999999-deadbeef`);
    fs.writeFileSync(corruptSafetyTmpPath, "{ torn safety-tmp, never valid JSON");

    reenterMergeQuarantinesAtBoot([k]);
    const active = activeMergeQuarantineFor(k);
    check(
      "*** THE FIX (round 3, minor 3) *** an unparseable safety-tmp matching a registered repo gets a FAIL-CLOSED placeholder, never silence alone",
      !!active && active.branch === PLACEHOLDER_BRANCH_CORRUPT,
    );
    // activeMergeQuarantineFor's own PRE-EXISTING lazy-graduation tail (unrelated to this fix) durably
    // persists the pending placeholder as a real final and sweeps the now-superseded safety-tmp residue
    // the moment it's queried -- confirm that graduation is genuinely DURABLE, not just in-memory.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([k]);
    const afterRestart = fresh.activeMergeQuarantineFor(k);
    check(
      "(durability) after a real restart, k's fail-closed placeholder is still enforced from its own graduated final",
      !!afterRestart && afterRestart.branch === PLACEHOLDER_BRANCH_CORRUPT,
    );
    fresh.clearMergeQuarantine(k);
  } else if (scenarioName === "round3-minor4-deferred-corrupt-placeholder-survives-phase3-delete") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round 3, MINOR 4. Repo A has ONLY a corrupt, unparsable torn-write tmp residue (no proper .json
    // final anywhere) -- the deferred-corrupt-tmp "no real sibling data" branch fabricates and writes a
    // fail-closed PLACEHOLDER for A, landing at quarantinePathFor(A). Repo B's own stale latch happens
    // to physically sit at THAT SAME filename (the usual hash-collision shape) and migrates away to B's
    // own (different) target this same boot. Phase 3's delete pass used to have no way to know A's
    // placeholder write had ALSO just landed on that exact filename, so it deleted it as a "superseded"
    // migrate source for B -- destroying A's only durable (fail-closed) record moments after it was
    // written, with no fault involved for B's own write at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repoA = path.join(os.tmpdir(), `loom-mqmsod-r3m4-a-${freshSfx()}`);
    fs.mkdirSync(repoA, { recursive: true });
    tmpDirs.push(repoA);
    fs.writeFileSync(path.join(repoA, "README.md"), "# minor4 A\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: repoA });
    commitAll(repoA, "init", GIT_ID);
    const ka = canonicalRepoLockKey(repoA);
    const kaHash = hashForKey(ka);

    const repoB = path.join(os.tmpdir(), `loom-mqmsod-r3m4-b-${freshSfx()}`);
    fs.mkdirSync(repoB, { recursive: true });
    tmpDirs.push(repoB);
    fs.writeFileSync(path.join(repoB, "README.md"), "# minor4 B\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: repoB });
    commitAll(repoB, "init", GIT_ID);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // B's own stale latch, deliberately placed AT A's own hash -- the collision this scenario needs.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${kaHash}.json`), JSON.stringify({
      repoPath: repoB, branch: "b-branch", reason: "B's REAL reason -- its own stale source physically collides with A's hash", enteredAt: Date.now() - 60_000, tokens: ["token-b"],
    }, null, 2) + "\n");
    // A's own CORRUPT torn-write tmp -- no real final anywhere for A.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${kaHash}.json.tmp-999999`), "{ torn, no real sibling data for A");

    // NO fault injection at all -- this is a pure no-fault repro of the writeTargetsThisPass gap.
    reenterMergeQuarantinesAtBoot([repoA, repoB]);

    const aPlaceholderPath = path.join(MERGE_QUARANTINE_DIR, `${kaHash}.json`);
    check(
      "*** THE FIX (round 3, minor 4) *** A's freshly-written fail-closed placeholder SURVIVES phase 3's delete pass for B's own superseded migrate source",
      fs.existsSync(aPlaceholderPath),
    );
    if (fs.existsSync(aPlaceholderPath)) {
      const persisted = JSON.parse(fs.readFileSync(aPlaceholderPath, "utf8"));
      check("(content) the surviving file is genuinely A's placeholder, not B's stale data", persisted.branch === PLACEHOLDER_BRANCH_CORRUPT);
    }
    const activeA = activeMergeQuarantineFor(repoA);
    check("A's own fail-closed quarantine is enforced", !!activeA && activeA.branch === PLACEHOLDER_BRANCH_CORRUPT);
    const activeB = activeMergeQuarantineFor(repoB);
    check("(sanity) B's own data migrated correctly to its own key and is still enforced", !!activeB && (activeB.tokens ?? []).includes("token-b"));

    clearMergeQuarantine(repoA);
    clearMergeQuarantine(repoB);
  } else if (scenarioName === "round4-G1-same-boot-graduation-deletes-sibling-target") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-4 Code Review 2b079f86, finding G1. SAME setup as round3-E (X degraded-occupies sub's own
    // migrate target Ksub; sub's stale source physically collides with teamA's own migrate target
    // sha(Kp).json). Phase 1b gives sub's migrate source a pending reference whose sourceFile is that
    // RAW collided filename -- a file teamA's own phase-1a write has ALREADY claimed, this same pass.
    //
    // sub's own data is ALSO unconditionally unioned into byRepoKey[Ksub] during PASS 1 itself (the
    // fall-through arm below the migrate-collection branch) -- so activeQuarantines.get(Ksub) is a REAL
    // union of X+sub, not X alone, and activeMergeQuarantineFor(sub)'s `direct` fast path returns that
    // union directly (never touching pendingUnresolvedQuarantines) for as long as X's own union object
    // still occupies Ksub. The dangerous Phase 1b pending reference only gets GRADUATED (via
    // consumeMatchedPendingsIntoArmedEntry) once that shared slot is actually vacated -- i.e. ordinary
    // human clear of the UNRELATED X, in the SAME process (no reboot) -- which deletes activeQuarantines'
    // Ksub slot, making the NEXT same-process query for sub fall through to the pending-match cascade.
    // round3-E's/finding1b's own tests never caught this because they always REBOOT before re-querying,
    // and a reboot's own safety-tmp-recovery read loop (finding E) mints a DIFFERENT, safe pending
    // reference (pointing at the safety-tmp's own unique filename) that supersedes Phase 1b's dangerous
    // one before it can ever be graduated. The real hazard needs clear-X-then-query-sub within ONE
    // process, before any reboot gets a chance to replace the dangerous reference with a safe one.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r4g1");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4g1-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive a same-boot graduation", enteredAt: Date.now() - 60_000, tokens: ["token-sub"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's REAL reason -- must survive sub's same-boot graduation deleting its sourceFile", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    // NO fault injection -- this is a pure no-fault repro. teamA's write lands on sha(Kp).json THIS
    // pass (phase 1a, before phase 1b ever runs).
    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    check(
      "(positive control) teamA's own migrate write landed on sha(Kp).json, the exact file sub's stale source occupied",
      fs.existsSync(subAtKpPath) && JSON.parse(fs.readFileSync(subAtKpPath, "utf8")).repoPath === teamA,
    );

    // THE REPRO: clear the UNRELATED X, then query sub -- both WITHIN THE SAME PROCESS (no reboot). The
    // clear vacates activeQuarantines' shared Ksub slot; the query then falls through to the pending-
    // match cascade and GRADUATES Phase 1b's own dangerous pending reference via
    // consumeMatchedPendingsIntoArmedEntry -> deleteSourceLatchIfSuperseded(sourceFile, armed).
    clearMergeQuarantine(x);
    const subGraduated = activeMergeQuarantineFor(sub);
    check("sub's own same-process graduation succeeded", !!subGraduated && (subGraduated.tokens ?? []).includes("token-sub"));

    check(
      "*** THE FIX (round 4, G1) *** teamA's own live quarantine file SURVIVES sub's same-boot graduation",
      fs.existsSync(subAtKpPath),
    );
    if (fs.existsSync(subAtKpPath)) {
      const persisted = JSON.parse(fs.readFileSync(subAtKpPath, "utf8"));
      check("(content) the surviving file is genuinely teamA's data, not deleted/replaced", persisted.repoPath === teamA && (persisted.tokens ?? []).includes("token-teamA"));
    }
    const teamAStillActive = activeMergeQuarantineFor(teamA);
    check("teamA's own quarantine is still enforced after sub's graduation", !!teamAStillActive && (teamAStillActive.tokens ?? []).includes("token-teamA"));

    clearMergeQuarantine(teamA);
    clearMergeQuarantine(sub);
    clearMergeQuarantine(x);
  } else if (scenarioName === "round4-G2-recovery-writeback-clobbers-degraded-occupant") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-4 Code Review 2b079f86, finding G2. BOOT 1: same collision shape as round3-E, but with the
    // age order FLIPPED (sub OLDER than X, not X older than sub, unlike every pre-round-4 degraded test)
    // -- this is what makes unionQuarantineEntries' tie-break resolve to sub's own RESOLVABLE identity on
    // boot 2, which is what lets the recovery write-back's own (pre-existing, unrelated) resolvability
    // check pass and reach the code that has NO degradedOccupiedKeys check at all (phase 1a and phase 2
    // both have one; this call site never did). BOOT 2: with X still unresolvable, the end-of-boot
    // safety-tmp recovery write-back physically overwrites X's OWN backing file (sha(Ksub).json) with
    // sub's content -- destroying X's real token/reason/branch, no fault needed.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r4g2");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4g2-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    // X is now the YOUNGER side (unlike every pre-round-4 degraded test, which always made X older).
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's REAL reason -- must survive a sub-older union tie-break", enteredAt: Date.now() - 60_000, tokens: ["token-x"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    // sub is now the OLDER side -- this is the flip.
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's own reason", enteredAt: Date.now() - 180_000, tokens: ["token-sub"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise", enteredAt: Date.now(), tokens: ["token-teamA"],
    }, null, 2) + "\n");

    // BOOT 1 -- no fault injection. Creates sub's own safety-tmp for Ksub (degraded-occupied by X) via
    // the ordinary collision path; Ksub's real target is never written while X stays degraded.
    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const filesAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
    const safetyTmpAfterBoot1 = filesAfterBoot1.find((f) => f.includes(hashForKey(ksub)) && f.includes(".tmp-safety-"));
    check("(positive control) boot 1 created sub's own safety-tmp residue for Ksub", !!safetyTmpAfterBoot1);
    check("(positive control) X's own backing file at sha(Ksub).json is UNTOUCHED after boot 1", fs.readFileSync(xAtKsubPath, "utf8").includes("token-x"));

    // BOOT 2 -- fresh module instance, no fault injection. X is re-read fresh (still unresolvable, still
    // degraded-occupies Ksub). The safety-tmp recovery read loop re-arms sub's recovered content into
    // byRepoKey at Ksub, UNIONING with X's own freshly-read entry -- sub wins the tie-break (older).
    const bootTwo = await freshBootModule();
    bootTwo.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);

    const xFileAfterBoot2 = fs.readFileSync(xAtKsubPath, "utf8");
    check(
      "*** THE FIX (round 4, G2) *** X's own backing file SURVIVES the recovery write-back (never clobbered with sub's content)",
      xFileAfterBoot2.includes("token-x") && !xFileAfterBoot2.includes("token-sub"),
    );

    // Per Lead condition 1: a REFUSAL here must leave X still quarantined after a FURTHER reboot, and
    // sub's own data must also still be recoverable (the safety-tmp survives, untouched, for next boot).
    const bootThree = await freshBootModule();
    bootThree.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const xAfterBoot3 = bootThree.activeMergeQuarantineFor(x);
    check(
      "(refusal durability) X is STILL quarantined after a further reboot -- the refusal never silently lifted it",
      !!xAfterBoot3 && (xAfterBoot3.tokens ?? []).includes("token-x"),
    );
    bootThree.clearMergeQuarantine(x);
    const bootFour = await freshBootModule();
    bootFour.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterXCleared = bootFour.activeMergeQuarantineFor(sub);
    check(
      "(no collateral loss) after clearing the UNRELATED X, sub's own quarantine is STILL enforced (its safety-tmp survived every boot untouched)",
      !!subAfterXCleared && (subAfterXCleared.tokens ?? []).includes("token-sub"),
    );
    bootFour.clearMergeQuarantine(teamA);
    bootFour.clearMergeQuarantine(sub);
  } else if (scenarioName === "round4-G2-reversed-occupant-wins-union") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card a2f381dc (M-1) — the SAME collision shape as round4-G2 above, but with the age order
    // FLIPPED BACK (X older than sub, the ordering every pre-round-4 degraded test used) — the ordering
    // round4-G2 itself does NOT cover for armQuarantineKey's own NEW identity-conditional re-point.
    // With X winning unionQuarantineEntries' own tie-break, armed.repoPath stays X's own identity, so
    // the fix's condition (directPathIdentity(prior.repoPath) === directPathIdentity(armed.repoPath))
    // is TRUE and X's own already-flushed pending reference is correctly re-pointed onto the union —
    // asserted here as "X's own report count is exactly 1" (no split), the same style every other
    // scenario in this suite uses, since pendingUnresolvedQuarantines is not itself exported.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r4g2rev");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4g2rev-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    // X is now the OLDER side (reversed from round4-G2 above) -- X must win the tie-break.
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's REAL reason -- must survive, undoubled, winning an X-older union tie-break", enteredAt: Date.now() - 240_000, tokens: ["token-x-rev"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    // sub is now the YOUNGER side (reversed from round4-G2 above).
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's own reason (reversed)", enteredAt: Date.now() - 60_000, tokens: ["token-sub-rev"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise (reversed)", enteredAt: Date.now(), tokens: ["token-teamA-rev"],
    }, null, 2) + "\n");

    // BOOT 1 -- no fault injection, same shape as round4-G2's own boot 1.
    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const filesAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
    const safetyTmpAfterBoot1 = filesAfterBoot1.find((f) => f.includes(hashForKey(ksub)) && f.includes(".tmp-safety-"));
    check("(positive control) boot 1 created sub's own safety-tmp residue for Ksub", !!safetyTmpAfterBoot1);

    const countAfter = (mod) => mod.listActiveMergeQuarantines().filter((e) => (e.tokens ?? []).includes("token-x-rev")).length;
    const boot1Count = countAfter({ listActiveMergeQuarantines });
    // No union has happened yet at boot 1 (that's boot 2, per the comment above) -- X alone, sanity only.
    check("(sanity) boot1 reports X exactly once (no union yet)", boot1Count === 1);

    // BOOT 2 -- fresh module instance, no fault injection. X is re-read fresh (still unresolvable, still
    // degraded-occupies Ksub). The safety-tmp recovery read loop re-arms sub's recovered content into
    // byRepoKey at Ksub, UNIONING with X's own freshly-read entry -- X wins the tie-break (older).
    const bootTwo = await freshBootModule();
    bootTwo.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const boot2Count = countAfter(bootTwo);

    const xAfterBoot2 = bootTwo.activeMergeQuarantineFor(x);
    check(
      "*** THE FIX (a2f381dc, M-1) *** X's own query resolves to the union, with its real data intact",
      !!xAfterBoot2 && (xAfterBoot2.tokens ?? []).includes("token-x-rev"),
    );
    check(
      `*** THE FIX (a2f381dc, M-1) *** X's report count is exactly 1 (no split -- boot1=${boot1Count}, boot2=${boot2Count})`,
      boot1Count === 1 && boot2Count === 1,
    );
    const xFileAfterBoot2 = fs.readFileSync(xAtKsubPath, "utf8");
    check(
      "(recorded, unchanged from round4-G2) X's own backing file at sha(Ksub).json still carries only X's own content -- the union lives in byRepoKey, the physical final is untouched by this card's fix either way",
      xFileAfterBoot2.includes("token-x-rev"),
    );

    const bootThree = await freshBootModule();
    bootThree.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const boot3Count = countAfter(bootThree);
    check(
      `*** 3-BOOT STABILITY (a2f381dc, M-1, reversed order) *** X's report count stays 1 (boot1=${boot1Count}, boot2=${boot2Count}, boot3=${boot3Count})`,
      boot1Count === 1 && boot2Count === 1 && boot3Count === 1,
    );

    // CR baecb690, Minor 2 -- clear by ID (not just by repoPath) AFTER the re-point, to prove the
    // union's own single id lifts X without disturbing sub's own differently-identified pending ref
    // (the exact ambiguity fd189d91's own id-collision backstop exists to police).
    const xAfterBoot3 = bootThree.activeMergeQuarantineFor(x);
    check("(precondition) X is still active going into the id-based clear", !!xAfterBoot3);
    const xIds = bootThree.quarantineLatchFileIdsFor(xAfterBoot3);
    check(`(precondition) X resolves to exactly one latch id (found ${xIds.length})`, xIds.length === 1);
    const clearByIdResult = bootThree.clearMergeQuarantineLatchFile(xIds[0]);
    check(
      "*** THE FIX, CLEAR-BY-ID *** clearing X's own id reports wasQuarantined:true",
      clearByIdResult.ok === true && clearByIdResult.wasQuarantined === true,
    );

    const bootFour = await freshBootModule();
    bootFour.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    check("*** NO RESURRECTION *** X stays cleared after a further reboot", !bootFour.activeMergeQuarantineFor(x));
    // CR baecb690, Minor 2 -- this was only LOGGED before, never asserted. Sub's own pending reference
    // carries a DIFFERENT identity (sub's own repoPath) from X's, and clearMergeQuarantineByKey's own
    // identity gate (merge-quarantine.ts:937, `directPathIdentity(p.entry.repoPath) !== identity`) is
    // exactly what keeps it un-swept by a clear scoped to X's own key -- assert it survives, not just log.
    const subAfterXCleared = bootFour.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX, NO COLLATERAL LOSS *** sub still holds its own token after clearing X by id, then a further reboot",
      !!subAfterXCleared && (subAfterXCleared.tokens ?? []).includes("token-sub-rev"),
    );
    bootFour.clearMergeQuarantine(teamA);
    bootFour.clearMergeQuarantine(sub);
  } else if (scenarioName === "round4-finding1b-sub-older") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Reparametrization of finding1b over the OTHER age order (card 97cff6db round 4, Lead condition 6)
    // -- Y now OLDER than X (every pre-round-4 degraded test, including the original finding1b, made the
    // degraded occupant X the older side).
    //
    // @decision 97cff6db (round 5) — NON-DISCRIMINATING PARITY CHECK, not a regression test: measured
    // (node packages/daemon/test/merge-quarantine-migrate-source-owner-durable.mjs
    // --scenario=round4-finding1b-sub-older, source temporarily reverted to the TRUE pre-round-1 parent
    // 30e7e9b9) GREEN even on code with NONE of card 97cff6db's fixes -- under THIS age order the
    // original finding1b defect never fires, for a reason not yet root-caused. Kept only to document
    // this age order's own behavior stays unregressed across every round; see the decision record.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-r4f1b-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# round4 finding1b Y (sub-older)\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4f1b-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `!stale-r4f1b-y-${freshSfx()}.json`);
    // FLIPPED: X is now the YOUNGER side; Y is now the OLDER side.
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y (sub-older variant)",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-1b-so"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine reason -- must survive a clear of the UNRELATED degraded entry X (sub-older variant)",
      enteredAt: Date.now() - 120_000, tokens: ["y-token-1b-so"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(this boot) the stale-y file is still on disk, unresolved (degraded-skip never writes/deletes)", fs.existsSync(yFile));

    clearMergeQuarantine(x);
    check(
      "*** FIX (1b) HOLDS UNDER THE OTHER AGE ORDER *** clearing the UNRELATED degraded entry X no longer deletes Y's own still-pending migrate source",
      fs.existsSync(yFile),
    );

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, x]);
    const yAfterRestart = fresh.activeMergeQuarantineFor(y);
    check(
      "*** FIX (1b) HOLDS UNDER THE OTHER AGE ORDER, CONFIRMED *** after restart, Y's quarantine SURVIVES",
      !!yAfterRestart && (yAfterRestart.tokens ?? []).includes("y-token-1b-so"),
    );
    fresh.clearMergeQuarantine(y);
  } else if (scenarioName === "round4-minor2-sub-older") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Reparametrization of minor2-stale-snapshot-double-report over the OTHER age order (Lead condition
    // 6). The ORIGINAL minor2 test relies on X being older (so the shared union's repoPath is X's) --
    // flip it: Y older than X. The double-report defect was about OBJECT-REFERENCE identity surviving a
    // mid-pass mutation, not about which side's repoPath wins, so this should hold either way.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-r4m2-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# round4 minor2 Y (sub-older)\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4m2-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    const yFile = path.join(MERGE_QUARANTINE_DIR, `!stale-r4m2-y-${freshSfx()}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y (sub-older variant)",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-m2-so"], resolvedKey: ky,
    }, null, 2) + "\n");
    fs.writeFileSync(yFile, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's real, genuine reason (sub-older variant)", enteredAt: Date.now() - 120_000, tokens: ["y-token-m2-so"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);

    // Filter by TOKEN presence, not repoPath: with Y now older, the shared union's own repoPath field is
    // Y's (unionQuarantineEntries' tie-break), not X's -- a repoPath-equality filter would report zero
    // matches for a reason that has nothing to do with the double-report defect Minor 2 actually governs.
    // The double-report defect is about OBJECT-REFERENCE identity surviving a mid-pass mutation, so any
    // entry carrying X's own token is the same shared union either way -- count THOSE instead.
    const list = listActiveMergeQuarantines();
    const xEntries = list.filter((e) => (e.tokens ?? []).includes("x-token-m2-so"));
    check(
      "*** FIX (Minor 2) HOLDS UNDER THE OTHER AGE ORDER *** the shared union carrying X's own token is reported EXACTLY ONCE",
      xEntries.length === 1,
    );
    clearMergeQuarantine(x);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, x]);
    const yAfterRestart = fresh.activeMergeQuarantineFor(y);
    check("(sanity) Y's own protective entry still survives under this age order too", !!yAfterRestart && (yAfterRestart.tokens ?? []).includes("y-token-m2-so"));
    fresh.clearMergeQuarantine(y);
  } else if (scenarioName === "round4-E-sub-older") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Reparametrization of round3-E over the OTHER age order (Lead condition 6) -- sub older than X.
    // round3-E's own fix (securing a degraded-occupied migrate source via its OWN sources-only union,
    // never byRepoKey.get(key)) must hold regardless of which side wins unionQuarantineEntries' own
    // tie-break, since it deliberately never calls unionQuarantineEntries for X and sub at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r4esub");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4esub-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key (sub-older variant)", enteredAt: Date.now() - 60_000, tokens: ["token-x-so"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason (sub-older variant) -- must survive X's degraded occupation of Ksub", enteredAt: Date.now() - 180_000, tokens: ["token-sub-so"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise", enteredAt: Date.now(), tokens: ["token-teamA-so"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const onDiskAfterThisBoot = fs.readdirSync(MERGE_QUARANTINE_DIR).map((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).join("\n");
    check("(this boot) sub's own token survives SOMEWHERE on disk under this age order too", onDiskAfterThisBoot.includes("token-sub-so"));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterRestart = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** FIX (round 3, finding E) HOLDS UNDER THE OTHER AGE ORDER *** sub's quarantine SURVIVES",
      !!subAfterRestart && (subAfterRestart.tokens ?? []).includes("token-sub-so"),
    );
    fresh.clearMergeQuarantine(x);
    const after2 = await freshBootModule();
    after2.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterClearAndReboot = after2.activeMergeQuarantineFor(sub);
    check(
      "*** FIX (round 3, finding E) HOLDS UNDER THE OTHER AGE ORDER, CONFIRMED *** even after clearing the unrelated degraded entry X, sub is STILL quarantined",
      !!subAfterClearAndReboot && (subAfterClearAndReboot.tokens ?? []).includes("token-sub-so"),
    );
    after2.clearMergeQuarantine(teamA);
    after2.clearMergeQuarantine(sub);
  } else if (scenarioName === "round4-minor1-safety-recovery-double-report") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-4 Code Review 2b079f86, Minor 1. X degraded-occupies Y's own key Ky (manufactured resolvedKey
    // collision, same shape as finding1b). A LEFTOVER safety-tmp for Ky (simulating a prior boot's own
    // securing of Y's data) ALSO sits on disk. PASS 1b's own flushDegradedDiverts used to run BEFORE the
    // safety-tmp recovery loop had a chance to UNION that leftover residue into byRepoKey[Ky] -- so the
    // divert captured X's PRE-union entry, a DIFFERENT object (by reference) from the POST-union object
    // the recovery loop then installs. listActiveMergeQuarantines (Set-dedupes by reference, not value)
    // reported both -- the identical defect minor2's original test covers for Phase 1b's OWN fold, now
    // reached through the safety-tmp recovery read loop's own union instead.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-r4m1-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# round4 minor1 Y\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4m1-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // X's own divert must be a PASS 1b TMP (never a PASS 1 `.json` final) -- PASS 1's OWN divert flushes
    // via the FIRST flushDegradedDiverts() call, long before the safety-tmp recovery loop ever runs,
    // regardless of this fix; only PASS 1b's divert flushes via the SECOND call this fix reorders.
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json.tmp-424242`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token-m1"], resolvedKey: ky,
    }, null, 2) + "\n");
    // A LEFTOVER safety-tmp for Ky, simulating a PRIOR boot's own securing of Y's own data.
    const leftoverSafetyTmp = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json.tmp-safety-999999-ab00cd11`);
    fs.writeFileSync(leftoverSafetyTmp, JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's own leftover safety-tmp from an earlier boot",
      enteredAt: Date.now() - 30_000, tokens: ["y-token-m1"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);

    // Filter by TOKEN presence (age-order-agnostic, same reasoning as round4-minor2-sub-older): any
    // entry carrying X's own token is the SAME shared union, whichever side's repoPath happens to win.
    const list = listActiveMergeQuarantines();
    const xEntries = list.filter((e) => (e.tokens ?? []).includes("x-token-m1"));
    check(
      "*** THE FIX (round 4, Minor 1) *** the shared union carrying X's own token (now ALSO unioned with Y's recovered safety-tmp) is reported EXACTLY ONCE",
      xEntries.length === 1,
    );
    if (xEntries.length >= 1) {
      check("(content) the single reported entry carries BOTH tokens (the union genuinely happened)", (xEntries[0].tokens ?? []).includes("y-token-m1"));
    }
    clearMergeQuarantine(x);
  } else if (scenarioName === "round4-minor2-unparseable-safety-tmp-full-fallback") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-4 Code Review 2b079f86, Minor 2. An unparseable safety-tmp residue used to consult ONLY
    // hashToRepo before giving up silently -- unlike deferredCorruptJsons/deferredCorruptTmps, which also
    // try unresolvedClaimantsByHash and ancestorHashToRepo, and finally join the PASS 2 orphan sweep when
    // nothing matches at all. Exercise the fallback tier that was previously unreachable: TWO
    // unresolvable registered repos sharing the exact same degraded hash (unresolvedClaimantsByHash).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // W1/W2 — two ABSENT subdirs of a real, UNREGISTERED repo Y (the proven shared-degraded-hash
    // fixture shape from merge-quarantine-pass1-degraded-key-writes.mjs's own makeYWithTwoAbsentSubdirsAndZ):
    // both walk up to Y's own toplevel, landing on the SAME degraded key.
    const y = path.join(os.tmpdir(), `loom-mqmsod-r4m2fb-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# round4 minor2 fallback Y\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const xa = path.join(y, "a"); // deliberately NEVER created
    const xb = path.join(y, "b"); // deliberately NEVER created
    check("(precondition) neither claimant exists at all", !fs.existsSync(xa) && !fs.existsSync(xb));
    const sharedKey = canonicalRepoLockKey(xa);
    check("(precondition) both unresolvable claimants share one degraded key", canonicalRepoLockKey(xb) === sharedKey);
    const sharedHash = hashForKey(sharedKey);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${sharedHash}.json.tmp-safety-999999-ab00cd22`);
    fs.writeFileSync(corruptSafetyTmpPath, "{ torn safety-tmp, never valid JSON, matches NO hashToRepo entry");

    reenterMergeQuarantinesAtBoot([xa, xb]);
    const activeA = activeMergeQuarantineFor(xa);
    const activeB = activeMergeQuarantineFor(xb);
    check(
      "*** THE FIX (round 4, Minor 2) *** claimant A gets a fail-closed placeholder via unresolvedClaimantsByHash, not silence",
      !!activeA && activeA.branch === PLACEHOLDER_BRANCH_CORRUPT,
    );
    check(
      "*** THE FIX (round 4, Minor 2) *** claimant B ALSO gets its OWN fail-closed placeholder (per-claimant divert, never just one winner)",
      !!activeB && activeB.branch === PLACEHOLDER_BRANCH_CORRUPT,
    );
    clearMergeQuarantine(xa);
    clearMergeQuarantine(xb);
  } else if (scenarioName === "round4-d163aef5-pass2-degraded-bypass") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card d163aef5's Repro C: PASS 2's own orphan re-persist bypassed degradedOccupiedKeys entirely --
    // its write target came from `existing.repoPath` (X's own, degraded, unresolvable identity),
    // recomputed FRESH via quarantinePathFor, rather than from Ky (the key actually being iterated).
    // X degraded-occupies Y's own real key Ky; an UNRELATED corrupt orphan makes PASS 2 run for every
    // registered repo, including Y. The old code attempted a write for Y using X's OWN union, landing
    // at X's own-path's FRESH (different, unrelated) canonical hash -- a STRAY file neither Y's nor
    // X's own real backing file. bootWriteLatch's degradedOccupiedKeys check (keyed on the explicit
    // `key` parameter, never a repoPath recompute) now refuses the write outright, regardless of where
    // it would have landed.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqmsod-r4d163-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# round4 d163aef5 Y\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqmsod-r4d163-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xOwnFreshKey = canonicalRepoLockKey(x); // X's OWN fresh walk -- deliberately DIFFERENT from ky
    check("(precondition) X's own fresh key differs from Y's real key (the stray-write target, if any, is a THIRD location)", xOwnFreshKey !== ky);
    const strayPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(xOwnFreshKey)}.json`);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y", enteredAt: Date.now() - 60_000, tokens: ["x-token-d163"], resolvedKey: ky,
    }, null, 2) + "\n");
    // An UNRELATED corrupt orphan -- matches NO registered repo at any tier, so PASS 2 runs for everyone.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "eeeeeeeeeeeeeeeeeeeeeeee.json"), "{ corrupt orphan, matches nobody");
    check("(precondition) no stray file at X's own fresh hash exists yet", !fs.existsSync(strayPath));

    // X (the degraded occupant) is deliberately NOT registered — same convention as every other
    // degraded-occupant fixture in this file (finding1b/round3-E/G1/G2's own "X"), and matching card
    // d163aef5's own card body ("registered=[E,Y]" — the occupant, D, was never registered either).
    // Registering X too would make PASS 2 ALSO process X directly as its own registered repo, creating
    // an unrelated, self-interfering placeholder at X's own fresh key that confounds this repro.
    reenterMergeQuarantinesAtBoot([y]);

    check(
      "*** THE FIX (card d163aef5, Repro C) *** no STRAY file was ever written at X's own fresh (unrelated) hash — PASS 2's write for Y was refused outright, never attempted anywhere",
      !fs.existsSync(strayPath),
    );
    check("(sanity) X's own real backing file is untouched", fs.readFileSync(xFile, "utf8").includes("x-token-d163"));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y]);
    const xAfterRestart = fresh.activeMergeQuarantineFor(x);
    check(
      "(refusal durability) X is STILL quarantined after a further reboot — the refusal never silently lifted it",
      !!xAfterRestart && (xAfterRestart.tokens ?? []).includes("x-token-d163"),
    );
    fresh.clearMergeQuarantine(x);
  } else if (scenarioName === "round5-G1a-same-boot-clear-then-reboot-destroys-safety-tmp") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-5 Code Review e0777155, blocking finding. SAME collision setup as round4-G1 (X degraded-
    // occupies sub's own key Ksub; sub's stale source physically collides with teamA's own migrate
    // target sha(Kp).json), but a DIFFERENT sequence: round4-G1's own test clears X then immediately
    // QUERIES sub in the SAME process -- that query graduates sub's pending reference right away,
    // durably rewriting its real final BEFORE anything else can matter. This scenario clears X and
    // deliberately queries NOTHING before a REBOOT -- exposing that the pushed pending reference's own
    // orphanLatchFiles never self-referenced the safety-tmp it points at, so the SAME clear's own
    // sweepTmpResidueForHashIfUnreferenced call deletes that safety-tmp as "unreferenced" well before any
    // reboot ever gets a chance to recover from it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r5g1a");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r5g1a-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    // X OLDER than sub -- the order the review measured the repro in.
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x-r5g1a"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must survive a same-boot clear of X with NO in-process query before the reboot", enteredAt: Date.now() - 60_000, tokens: ["token-sub-r5g1a"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's REAL reason", enteredAt: Date.now(), tokens: ["token-teamA-r5g1a"],
    }, null, 2) + "\n");

    // NO fault injection -- teamA's write lands on sha(Kp).json THIS pass (phase 1a, before phase 1b).
    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    check(
      "(positive control) teamA's own migrate write landed on sha(Kp).json, the exact file sub's stale source occupied",
      fs.existsSync(subAtKpPath) && JSON.parse(fs.readFileSync(subAtKpPath, "utf8")).repoPath === teamA,
    );
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(hashForKey(ksub)) && f.includes(".tmp-safety-"));
    check("(positive control) sub's safety-tmp residue was created for Ksub", !!safetyTmpAfterBoot1);

    // THE REPRO: clear the UNRELATED X -- SAME process -- but query NOTHING afterward. No graduation of
    // sub's own pending reference happens before the process "exits" (the reboot below).
    clearMergeQuarantine(x);
    check(
      "*** THE FIX (round 5) *** sub's safety-tmp residue SURVIVES a same-boot clear of the UNRELATED X with no intervening query",
      !!safetyTmpAfterBoot1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    // REBOOT -- a fresh module instance, re-reading everything from disk. X's own file is gone (cleared);
    // nothing degraded-occupies Ksub any more, so a surviving safety-tmp recovers sub DIRECTLY this boot.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterReboot = fresh.activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 5), CONFIRMED *** after a REBOOT following the same-boot clear of X (no query in between), sub's quarantine SURVIVES",
      !!subAfterReboot && (subAfterReboot.tokens ?? []).includes("token-sub-r5g1a"),
    );
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own quarantine is still enforced after the reboot", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-r5g1a"));

    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round5-G1a-same-boot-clear-then-reboot-sub-older") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Reparametrization attempt of round5-G1a over the OTHER age order (card 97cff6db's own round-4 "Do
    // not test ONLY the age order where the degraded occupant is older" rule) -- sub now OLDER than X.
    //
    // @decision 97cff6db (round 5) — NON-DISCRIMINATING PARITY CHECK, not a regression test for THIS
    // fix: measured (blocking fix alone reverted, round 5's other two fixes left in place) GREEN either
    // way. Root cause, traced via listActiveMergeQuarantines(): because `sub` ITSELF is a resolvable
    // registered repo whose own stale-key content ALSO gets armed directly into byRepoKey[Ksub] (the
    // ordinary stale-key migration arm every resolvable repo goes through, PASS 1's own fall-through at
    // "armedEntry = armQuarantineKey(byRepoKey, currentKey, entry)"), byRepoKey[Ksub] already holds a
    // REAL union of X's and sub's data by the end of boot 1 -- unlike the X-older variant, this is not
    // "occupant = X alone". unionQuarantineEntries' own tie-break then makes the shared entry's
    // `repoPath` equal `sub` (sub wins, being older) -- and X's own `degradedDivertsToFlush` pending
    // divert snapshots that SAME post-union value too (round 4 Minor 1's own fix: it snapshots
    // byRepoKey's post-union state, not a stale pre-union object). So nothing anywhere still carries
    // `repoPath: x` after boot 1 -- `clearMergeQuarantine(x)` (identity-matched against `directPathIdentity
    // (entry.repoPath)`) finds NO active or pending entry to clear at all (`wasQuarantined:false`,
    // confirmed via a direct read of its return value) and is a pure no-op, regardless of which fix is or
    // isn't present. Under this order there is no operation that clears "the unrelated X" without ALSO
    // touching sub's own entry (they share one key, one repoPath, one record) -- the hazard this round's
    // fix closes is specific to the X-older order, where the union's `repoPath` stays `x` and a clear BY
    // `x`'s OWN identity is a genuinely distinct, reachable operation. Kept only to document this age
    // order's own (unrelated, pre-existing) behavior stays unregressed; see the decision record.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested: sub, subdir: teamA } = makeRepoWithNestedRepoAndSubdir("r5g1aso");
    const kp = canonicalRepoLockKey(repo);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) P and sub have genuinely different canonical keys", kp !== ksub);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    const x = path.join(os.tmpdir(), `loom-mqmsod-r5g1aso-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    const xAtKsubPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    // FLIPPED: X is now the YOUNGER side; sub is now the OLDER side.
    fs.writeFileSync(xAtKsubPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key (sub-older variant)", enteredAt: Date.now() - 60_000, tokens: ["token-x-r5g1aso"], resolvedKey: ksub,
    }, null, 2) + "\n");

    const subAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(subAtKpPath, staleTeamAPath);
    fs.writeFileSync(subAtKpPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's own reason (sub-older variant)", enteredAt: Date.now() - 180_000, tokens: ["token-sub-r5g1aso"],
    }, null, 2) + "\n");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own separate stale raise (sub-older variant)", enteredAt: Date.now(), tokens: ["token-teamA-r5g1aso"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    check(
      "(positive control) teamA's own migrate write landed on sha(Kp).json, the exact file sub's stale source occupied",
      fs.existsSync(subAtKpPath) && JSON.parse(fs.readFileSync(subAtKpPath, "utf8")).repoPath === teamA,
    );
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(hashForKey(ksub)) && f.includes(".tmp-safety-"));
    check("(positive control) sub's safety-tmp residue was created for Ksub", !!safetyTmpAfterBoot1);

    const clearResult = clearMergeQuarantine(x);
    check(
      "(parity, non-discriminating — see comment above) clearing X by its own identity is a documented no-op under this age order, not a reachable operation this fix changes",
      clearResult?.wasQuarantined !== true && fs.existsSync(xAtKsubPath),
    );
    check(
      "(parity) sub's safety-tmp residue is untouched by that no-op clear, under either fix state",
      !!safetyTmpAfterBoot1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, sub, x]);
    const subAfterReboot = fresh.activeMergeQuarantineFor(sub);
    check(
      "(parity, confirmed) after a REBOOT, sub's quarantine (unioned with X's under this order) is still enforced",
      !!subAfterReboot && (subAfterReboot.tokens ?? []).includes("token-sub-r5g1aso"),
    );
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own quarantine is still enforced after the reboot", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-r5g1aso"));

    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "round5-minor1-stale-resolvedkey-registration-liveness") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Round-5 Code Review e0777155, Minor 1 (liveness). Phase 0 used to register a migrate key's
    // allBootWriteTargets entry via quarantinePathFor(e.repoPath) -- a FRESH canonicalRepoLockKey
    // recompute -- instead of quarantinePathForKey(key), the SAME key bootWriteLatch itself checks
    // against. teamA is an OLDER, independently-RESOLVABLE repo whose own CORRECTLY-PLACED latch file
    // (no migration needed) carries a STALE `resolvedKey` field pointing at sub's real key (Ksub) --
    // dual-arming teamA's entry at BOTH its own true key (Kp) AND Ksub (PASS 1's ordinary dual-arm
    // fall-through, lines ~1649-1652). sub is a NEWER, separately-resolvable repo whose own latch sits
    // under a stale-NAMED file that must migrate to its real target, hash(Ksub).json -- which ALSO arms
    // (and therefore unions) into byRepoKey[Ksub] via the SAME fall-through, since sub's own canonical
    // key already equals the key it's migrating to. Neither key is degraded-occupied (teamA resolves
    // fine) -- so Phase 0's migratedSourcesByKey loop for Ksub reads byRepoKey.get(Ksub), the UNION of
    // teamA+sub whose `repoPath` is teamA's (the OLDER side wins unionQuarantineEntries' tie-break), and
    // the BUGGY code recomputed quarantinePathFor(teamA) = hash(Kp).json -- the WRONG target. The REAL
    // write Phase 1a then attempts for key=Ksub was refused by bootWriteLatch as UNANTICIPATED, since
    // allBootWriteTargets never actually held hash(Ksub).json at all. Fails CLOSED (nothing destroyed),
    // but sub's quarantine then never durably lands -- a liveness bug, not a data-loss one.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const teamA = path.join(os.tmpdir(), `loom-mqmsod-r5m1-teamA-${freshSfx()}`);
    fs.mkdirSync(teamA, { recursive: true });
    tmpDirs.push(teamA);
    fs.writeFileSync(path.join(teamA, "README.md"), "# round5 minor1 teamA\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: teamA });
    commitAll(teamA, "init", GIT_ID);
    const kp = canonicalRepoLockKey(teamA);

    const sub = path.join(os.tmpdir(), `loom-mqmsod-r5m1-sub-${freshSfx()}`);
    fs.mkdirSync(sub, { recursive: true });
    tmpDirs.push(sub);
    fs.writeFileSync(path.join(sub, "README.md"), "# round5 minor1 sub\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: sub });
    commitAll(sub, "init", GIT_ID);
    const ksub = canonicalRepoLockKey(sub);
    check("(precondition) teamA and sub have genuinely different canonical keys", kp !== ksub);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // teamA's own latch sits at ITS OWN correct physical location (no migration needed) but carries a
    // STALE resolvedKey field pointing at sub's key -- the dual-arm trigger.
    const teamAAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(teamAAtKpPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's REAL reason -- own correct key, stale resolvedKey pointing at Ksub",
      enteredAt: Date.now() - 120_000, tokens: ["token-teamA-r5m1"], resolvedKey: ksub,
    }, null, 2) + "\n");

    // sub's own latch is a NEWER, stale-NAMED file that must migrate to its real target, hash(Ksub).json.
    const staleSubPath = path.join(MERGE_QUARANTINE_DIR, `!stale-sub-${freshSfx()}.json`);
    fs.writeFileSync(staleSubPath, JSON.stringify({
      repoPath: sub, branch: "sub-branch", reason: "sub's REAL reason -- must migrate to its real Ksub target",
      enteredAt: Date.now() - 60_000, tokens: ["token-sub-r5m1"],
    }, null, 2) + "\n");

    const subFinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ksub)}.json`);
    check("(precondition) sub's real target does not exist yet", !fs.existsSync(subFinalPath));

    const bootOneLogs = await captureConsole(() => { reenterMergeQuarantinesAtBoot([teamA, sub]); });
    check(
      "*** THE FIX (round 5, Minor 1) *** no UNANTICIPATED boot-write refusal fired on boot 1",
      !bootOneLogs.some((l) => l.includes("UNANTICIPATED")),
    );
    check(
      "*** THE FIX (round 5, Minor 1) *** the legit write for Ksub landed on boot 1 -- sub's real final exists on disk",
      fs.existsSync(subFinalPath),
    );
    const subQuarantined = activeMergeQuarantineFor(sub);
    check(
      "*** THE FIX (round 5, Minor 1), CONFIRMED *** sub is quarantined at Ksub",
      !!subQuarantined && (subQuarantined.tokens ?? []).includes("token-sub-r5m1"),
    );

    const fresh = await freshBootModule();
    const bootTwoLogs = await captureConsole(() => { fresh.reenterMergeQuarantinesAtBoot([teamA, sub]); });
    check("(stability) a SECOND boot fires no UNANTICIPATED warning either", !bootTwoLogs.some((l) => l.includes("UNANTICIPATED")));
    const subAfterReboot = fresh.activeMergeQuarantineFor(sub);
    check(
      "(stability) sub is STILL quarantined at Ksub after a second boot",
      !!subAfterReboot && (subAfterReboot.tokens ?? []).includes("token-sub-r5m1"),
    );
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(sanity) teamA's own quarantine is still enforced after the second boot", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-r5m1"));

    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(sub);
  } else if (scenarioName === "ef651188-site1-deferred-corrupt-tmp-placeholder") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #1: the deferred-corrupt-tmp "no real sibling data" placeholder write.
    // teamA's only evidence is a CORRUPT torn-write tmp at its own hash (no real final anywhere for
    // teamA) -- which fabricates and writes a fail-closed placeholder straight to sha(Kp).json, the
    // exact file Y's own PENDING (no-resolvedKey, unresolvable) latch occupies. No readdir-order axis
    // applies: Y is read in PASS 1 (the `.json` file list) and teamA's corrupt tmp in PASS 1b (the
    // SEPARATE `.json.tmp-...` list) -- PASS 1 always finishes before PASS 1b runs, regardless of order.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s1");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    writeGhostPendingLatch(kpPath, y, "s1");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json.tmp-999999`), "{ torn");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const fresh = await assertEf651188Survival("site1 deferred-corrupt-tmp placeholder", { teamA, y, kpPath, tag: "s1", registered: [repo, teamA, y] });
    fresh.clearMergeQuarantine(teamA);
  } else if (scenarioName === "ef651188-site2-migrate-pass-order-a") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #2 (the PRIMARY repro from the card body): Phase 1a's migrate-write-ALL
    // pass. teamA has its OWN separate stale-named latch migrating to sha(Kp).json. Order A: teamA's
    // stale file sorts BEFORE Y's file in readdir.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s2a");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "s2a");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason s2a", enteredAt: Date.now(), tokens: ["token-teamA-s2a"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const fresh = await assertEf651188Survival("site2 migrate-pass, order A", { teamA, y, kpPath, tag: "s2a", registered: [repo, teamA, y] });
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(extra) teamA's own SPECIFIC token survives too (not just presence)", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-s2a"));
    fresh.clearMergeQuarantine(teamA);
  } else if (scenarioName === "ef651188-site2-migrate-pass-order-b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #2, OTHER age order (CLAUDE.md's own "a fixture axis held constant hides
    // fail-opens" lesson) -- teamA's stale file sorts AFTER Y's file in readdir. Phase 0 runs AFTER both
    // PASS 1 and PASS 1b have fully finished reading, so this is EXPECTED to be a non-discriminating
    // parity check, not a second distinct hazard -- confirmed, not assumed, by running it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s2b");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `~stale-teamA-${freshSfx()}.json`);
    placeStaleAfterFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "s2b");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason s2b", enteredAt: Date.now(), tokens: ["token-teamA-s2b"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const fresh = await assertEf651188Survival("site2 migrate-pass, order B", { teamA, y, kpPath, tag: "s2b", registered: [repo, teamA, y] });
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(extra) teamA's own SPECIFIC token survives too (not just presence)", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-s2b"));
    fresh.clearMergeQuarantine(teamA);
  } else if (scenarioName === "ef651188-site3-tmp-promotion") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #3: Phase 2's tmp-promotion write-ALL pass. teamA has NO proper final at
    // all -- only a `.json.tmp-<pid>` residue -- so its only route to sha(Kp).json is PASS 1b's
    // tmp-promotion write. Same "no order axis" reasoning as site #1: Y (PASS 1) vs teamA's tmp residue
    // (PASS 1b) are structurally ordered passes, never reordered relative to each other by readdir.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s3");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    writeGhostPendingLatch(kpPath, y, "s3");
    const teamATmpPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-tmp-${freshSfx()}.json.tmp-999999`);
    fs.writeFileSync(teamATmpPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA's own recovered-tmp raise s3", enteredAt: Date.now(), tokens: ["token-teamA-s3"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const fresh = await assertEf651188Survival("site3 tmp-promotion", { teamA, y, kpPath, tag: "s3", registered: [repo, teamA, y] });
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(extra) teamA's own SPECIFIC token survives too (not just presence)", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-s3"));
    fresh.clearMergeQuarantine(teamA);
  } else if (scenarioName === "ef651188-site4-phase3-repersist-SKIP") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #4: Phase 3's re-persist-after-failed-delete-fold. NAMED SKIP, not a
    // silent omission -- reason: this site's own write target is ALWAYS the SAME key (and therefore the
    // SAME basename) that Phase 1a/1b ALREADY wrote this boot; it re-persists the SAME entry after
    // folding a failed-delete source into orphanLatchFiles, never a NEW target. By the time this site
    // could run, that basename is either (a) already secured by my new Phase 0 pending-protection loop
    // (if it collided with a pending entry) or (b) never collided at all -- site #4 introduces no NEW
    // collision surface beyond what sites #2/#3 (the write that precedes it) already exercise.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    console.log("SKIP  site #4 (Phase 3 re-persist-after-failed-delete-fold) — shares its write target with whichever earlier write (migrate/tmp-promotion) already ran this boot; not a distinct collision surface. See the comment above and docs/decisions/ef651188-pending-entry-sourcefile-at-risk.md's own \"Verification\" section.");
  } else if (scenarioName === "ef651188-site5-pass2-existing-orphan-ref-SKIP") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #5: PASS 2's "existing entry, add orphan ref" branch. NAMED SKIP, not a
    // silent omission -- THE STRUCTURAL REASON (round 2, nit 5 — restated from a timing-based argument
    // that was true but not the fundamental one): Phase 0 protects by TARGET BASENAME SET membership,
    // computed ONCE, globally, before any write site runs — it does not distinguish WHICH of the seven
    // call sites will eventually perform the write. Site #5's own write target (an `existing` entry's
    // basename) is counted in that SAME `allBootWriteTargets` set sites #2/#3/#6/#7 already exercise, so
    // any scenario that correctly proves Phase 0 protects a basename in that set necessarily covers site
    // #5 too, by construction — no site-specific scenario can discriminate. `bootWriteLatch`'s own
    // structural backstop is a second, independent guarantee on top, equally indifferent to call site.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    console.log("SKIP  site #5 (PASS 2 \"existing entry, add orphan ref\") — its write target is counted in the SAME allBootWriteTargets set every other site's scenario already exercises; Phase 0 protects by target-set membership, not by call site, so no site-specific scenario can discriminate. See the comment above and docs/decisions/ef651188-pending-entry-sourcefile-at-risk.md's own \"Verification\" section.");
  } else if (scenarioName === "ef651188-site6-pass2-fresh-placeholder-order-a") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #6 (the card body's own SECOND named site): PASS 2's "no existing entry,
    // fresh placeholder" branch (mirrors round2-C's own shape, sub replaced by Y). repo and teamA SHARE
    // Kp and NEITHER has an entry armed anywhere from PASS 1/1b -- Y's own pending latch merely happens
    // to be NAMED at hash(Kp), never armed there. An unrelated corrupt orphan file makes PASS 2 fabricate
    // a fresh, placeholder for `repo` (the first registeredRepoPath sharing Kp), landing on sha(Kp).json.
    // Order A: the orphan file sorts BEFORE Y's file in readdir.
    //
    // NOTE: `y` is deliberately EXCLUDED from `registeredRepoPaths` below (unlike every other ef651188
    // scenario) -- PASS 2's own loop iterates registeredRepoPaths directly and a placeholder is EXEMPT
    // from bootWriteLatch's resolvability check, so including an unresolvable `y` there would make PASS 2
    // ALSO attempt a SEPARATE, unrelated fresh-placeholder write for Y's OWN (degraded, walked-up)
    // identity -- correctly refused as UNANTICIPATED (Phase 0 never registers a target for an
    // unresolvable registeredRepoPath), but a confusing, unrelated red herring next to the write this
    // scenario actually means to exercise. A real daemon would never register a ghost/missing repo path
    // either, so this exclusion matches production reality, not a fixture workaround.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s6a");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const orphanPath = path.join(MERGE_QUARANTINE_DIR, `!orphan-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, orphanPath);
    writeGhostPendingLatch(kpPath, y, "s6a");
    fs.writeFileSync(orphanPath, "{ corrupt orphan");

    reenterMergeQuarantinesAtBoot([repo, teamA]);
    const fresh = await assertEf651188Survival("site6 PASS2 fresh-placeholder, order A", { teamA: repo, y, kpPath, tag: "s6a", registered: [repo, teamA] });
    fresh.clearMergeQuarantine(repo);
  } else if (scenarioName === "ef651188-site6-pass2-fresh-placeholder-order-b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #6, OTHER age order -- the orphan file sorts AFTER Y's file in readdir.
    // Same "expect a parity check, verify rather than assume" posture as site #2's order B. `y` excluded
    // from registeredRepoPaths for the same reason as order A above.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s6b");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const orphanPath = path.join(MERGE_QUARANTINE_DIR, `~orphan-${freshSfx()}.json`);
    placeStaleAfterFixed(kpPath, orphanPath);
    writeGhostPendingLatch(kpPath, y, "s6b");
    fs.writeFileSync(orphanPath, "{ corrupt orphan");

    reenterMergeQuarantinesAtBoot([repo, teamA]);
    const fresh = await assertEf651188Survival("site6 PASS2 fresh-placeholder, order B", { teamA: repo, y, kpPath, tag: "s6b", registered: [repo, teamA] });
    fresh.clearMergeQuarantine(repo);
  } else if (scenarioName === "ef651188-site7-recovery-writeback") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, write site #7: the end-of-boot safety-tmp recovery write-back (mirrors round3-F's
    // own shape, sub replaced by Y). A leftover SAFETY-TMP residue for teamA's key (Kp) from an EARLIER
    // boot -- no proper final for teamA anywhere -- is recovered and written back at the very end of
    // this function. No order axis: Y (PASS 1's `.json` list) vs teamA's leftover safety-tmp (the
    // SEPARATE, dedicated safety-tmp recovery loop) are structurally ordered passes.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("s7");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    writeGhostPendingLatch(kpPath, y, "s7");
    const teamALeftoverSafetyTmp = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json.tmp-safety-1234-abcdef01`);
    fs.writeFileSync(teamALeftoverSafetyTmp, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA's own leftover safety-tmp from an earlier boot (s7)", enteredAt: Date.now() - 1_000, tokens: ["token-teamA-s7"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const fresh = await assertEf651188Survival("site7 recovery write-back", { teamA, y, kpPath, tag: "s7", registered: [repo, teamA, y] });
    const teamAAfterReboot = fresh.activeMergeQuarantineFor(teamA);
    check("(extra) teamA's own SPECIFIC token survives too (not just presence)", !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes("token-teamA-s7"));
    fresh.clearMergeQuarantine(teamA);
  } else if (scenarioName === "ef651188-degraded-coexistence-no-interference") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, degraded interaction. A TRUE "X degrades Y's OWN target" is structurally impossible
    // for Y: Y has no resolvedKey and is never armed/migrated to ANY key, so it has no "target" to be
    // degraded-occupied. (The mutually-exclusive sibling branch in PASS 1 -- a latch WITH a stale
    // resolvedKey -- already gets `degradedOccupiedKeys` protection from the EXISTING 97cff6db round-3
    // fix; that is a different entry shape, not this card's own gap.) What IS meaningfully testable:
    // an UNRELATED degraded entry X (its own key, its own file, no shared basename with Y or teamA)
    // coexists in the SAME boot as the site #2 migrate-pass collision -- confirming no interference
    // between the two protection mechanisms. X's own position is unrelated to Y/teamA's readdir order,
    // so only one order is run here (not a second distinct hazard to reparametrize).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("sdeg");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "sdeg");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason sdeg", enteredAt: Date.now(), tokens: ["token-teamA-sdeg"] }, null, 2) + "\n");

    // X is UNRELATED -- its own, separate repo, degraded-occupying its OWN key (never Kp, never Y's own
    // non-existent identity).
    const xHost = path.join(os.tmpdir(), `loom-mqef-xhost-sdeg-${freshSfx()}`);
    fs.mkdirSync(xHost, { recursive: true });
    tmpDirs.push(xHost);
    fs.writeFileSync(path.join(xHost, "README.md"), "# sdeg xHost\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: xHost });
    commitAll(xHost, "init", GIT_ID);
    const kx = canonicalRepoLockKey(xHost);
    const x = path.join(os.tmpdir(), `loom-mqef-x-never-sdeg-${freshSfx()}`);
    check("(precondition, sdeg) X never exists at all", !fs.existsSync(x));
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own UNRELATED degraded occupation (sdeg)", enteredAt: Date.now() - 120_000, tokens: ["token-x-sdeg"], resolvedKey: kx,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y, xHost]);
    const fresh = await assertEf651188Survival("degraded-coexistence", { teamA, y, kpPath, tag: "sdeg", registered: [repo, teamA, y, xHost] });
    const xAfterReboot = fresh.activeMergeQuarantineFor(x);
    check("(no interference) X's own, UNRELATED degraded quarantine is unaffected by Y's own protection", !!xAfterReboot && (xAfterReboot.tokens ?? []).includes("token-x-sdeg"));
    fresh.clearMergeQuarantine(teamA);
    fresh.clearMergeQuarantine(x);
  } else if (scenarioName === "ef651188-safety-write-fails-blocks-colliding-write") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, fail-closed / never-fail-open. Inject a fault on Y's OWN safety-tmp write (the NEW
    // writeSafetyTmpResidueAtHash call, named by Y's own at-risk hash) -- confirms blockedWriteTargets
    // propagation refuses teamA's colliding write too, so BOTH Y's original file AND teamA's data
    // survive untouched THIS boot (fail-closed: teamA simply isn't durably migrated this one boot).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("sfail");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "sfail");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason sfail", enteredAt: Date.now(), tokens: ["token-teamA-sfail"] }, null, 2) + "\n");

    const kpHash = hashForKey(kp);
    const realOpenSync = fs.openSync;
    let matchCount = 0;
    fs.openSync = (p, ...rest) => {
      if (typeof p === "string" && p.includes(kpHash) && p.includes(".tmp-safety-")) {
        matchCount++;
        throw Object.assign(new Error("EACCES: simulated failure securing Y's own pending safety-tmp"), { code: "EACCES" });
      }
      return realOpenSync(p, ...rest);
    };
    try {
      reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    } finally {
      fs.openSync = realOpenSync;
    }
    check("(positive control) Y's own safety-tmp write was attempted (and injected to fail)", matchCount >= 1);
    check(
      "*** THE FIX (fail-closed) *** teamA's colliding write was BLOCKED -- Y's original file is untouched",
      fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === y,
    );
    check(
      "*** THE FIX (fail-closed) *** teamA's own stale source survives too -- nothing was destroyed",
      fs.existsSync(staleTeamAPath) && JSON.parse(fs.readFileSync(staleTeamAPath, "utf8")).repoPath === teamA,
    );
    const yInProcess = activeMergeQuarantineFor(y);
    check("(fail-closed) Y is STILL enforced in-memory for this process", !!yInProcess && (yInProcess.tokens ?? []).includes("token-y-sfail"));
  } else if (scenarioName === "ef651188-same-boot-clear-then-reboot-survives") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, G1a-equivalent for the NEW safety-tmp: after Y's protection secures it and teamA's
    // write proceeds, a SAME-PROCESS clear of teamA (the sibling who now durably owns the collision
    // target) must NOT sweep Y's safety-tmp via sweepTmpResidueForHashIfUnreferenced -- Y's own
    // self-reference in orphanLatchFiles must hold. No intervening query of Y before the clear+reboot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("sclear");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "sclear");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason sclear", enteredAt: Date.now(), tokens: ["token-teamA-sclear"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check(
      "(positive control) teamA's own write landed on Y's exact physical file",
      fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA,
    );
    const yHash = hashForKey(kp); // Y's safety-tmp is named at the SAME hash as the collision spot
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.startsWith(yHash) && f.includes(".tmp-safety-"));
    check("(positive control) Y's safety-tmp residue was created", !!safetyTmpAfterBoot1);

    // THE REPRO: clear teamA -- SAME process -- but query NOTHING (not even Y) before the reboot below.
    clearMergeQuarantine(teamA);
    check(
      "*** THE FIX *** Y's safety-tmp residue SURVIVES a same-boot clear of teamA with no intervening query",
      !!safetyTmpAfterBoot1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const yAfterReboot = fresh.activeMergeQuarantineFor(y);
    check(
      "*** THE FIX, CONFIRMED *** after a REBOOT following the same-boot clear of teamA, Y's quarantine SURVIVES",
      !!yAfterReboot && (yAfterReboot.tokens ?? []).includes("token-y-sclear"),
    );
  } else if (scenarioName === "ef651188-negative-control-no-collision") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, negative control. Y's own sourceFile does NOT collide with anything this boot --
    // confirms the new Phase 0 loop does not fire (no spurious safety-tmp write) when there is nothing
    // to protect against.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("sneg");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const yPath = path.join(MERGE_QUARANTINE_DIR, `!y-noncolliding-${freshSfx()}.json`);
    writeGhostPendingLatch(yPath, y, "sneg");
    check(
      "(precondition) Y's own sourceFile does NOT equal teamA's own key's final basename",
      path.basename(yPath) !== `${hashForKey(kp)}.json`,
    );

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const filesAfter = fs.readdirSync(MERGE_QUARANTINE_DIR);
    check(
      "(negative control) no safety-tmp was written for Y -- there was nothing to protect against",
      !filesAfter.some((f) => f.includes(".tmp-safety-")),
    );
    check("(sanity) Y's own original file is untouched", fs.existsSync(yPath) && JSON.parse(fs.readFileSync(yPath, "utf8")).repoPath === y);
    const yInProcess = activeMergeQuarantineFor(y);
    check("(sanity) Y is still enforced in-memory, as a pure pending entry", !!yInProcess && (yInProcess.tokens ?? []).includes("token-y-sneg"));
  } else if (scenarioName === "ef651188-backstop-refuses-when-phase0-bypassed") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, the STRUCTURAL BACKSTOP itself. No real (post-fix) code path can leave a
    // `.json`-shaped pending entry present after Phase 0 runs -- that is the whole point of the fix
    // above. To prove the bootWriteLatch backstop actually refuses rather than merely trusting Phase 0's
    // own argument, use the TEST-ONLY `testOnlyInjectUnprotectedPending` seam to push a json-shaped
    // pending entry directly AFTER Phase 0's own protection has already run -- a disk layout no real
    // code path can produce. teamA's own ordinary migrate collides with the INJECTED entry's sourceFile.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("sbackstop");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    // Y's own file is written here too, so the injected pending entry's sourceFile has real bytes
    // behind it to verify survival against (an injected entry with no backing file would prove nothing).
    writeGhostPendingLatch(kpPath, y, "sbackstop");
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason sbackstop", enteredAt: Date.now(), tokens: ["token-teamA-sbackstop"] }, null, 2) + "\n");

    const injected = [{
      entry: {
        repoPath: y, branch: "y-branch", reason: "Y, injected bypassing Phase 0's own protection (backstop test)",
        enteredAt: Date.now() - 60_000, tokens: ["token-y-sbackstop"],
      },
      sourceFile: path.basename(kpPath),
    }];
    const logs = await captureConsole(() => {
      reenterMergeQuarantinesAtBootTestOnly([repo, teamA, y], injected);
    });
    check(
      "*** THE BACKSTOP *** bootWriteLatch logged an UNPROTECTED refusal for the injected pending entry's filename",
      logs.some((l) => l.includes("UNPROTECTED") && l.includes(path.basename(kpPath))),
    );
    check(
      "*** THE BACKSTOP, CONFIRMED *** Y's own original file was NEVER overwritten -- the colliding write was refused",
      fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === y,
    );
    const teamAInProcess = activeMergeQuarantineFor(teamA);
    check(
      "(both sides survive) teamA itself is STILL enforced in-memory for this process, even though its durable write was refused",
      !!teamAInProcess && (teamAInProcess.tokens ?? []).includes("token-teamA-sbackstop"),
    );
  } else if (scenarioName === "ef651188-multiboot-clear-in-boot2-order-a") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, ROUND 2 Code Review b4742106, CRITICAL 1. The round-1 "same-boot-clear-then-reboot"
    // scenario clears teamA in the SAME boot that created Y's safety-tmp -- at that point Y's in-memory
    // pending entry already self-references the tmp (Phase 0's own in-memory re-point), so round 1's
    // fix already passed that scenario even though the self-reference was NEVER baked into the tmp's
    // own persisted bytes. The real gap needs a REAL reboot in between: boot 2 reads Y's safety-tmp back
    // off disk via the ordinary UNRESOLVABLE recovery branch (never passing through Phase 0 again), and
    // only a self-reference that survives THAT read protects a clear performed inside boot 2 itself.
    // Order A: teamA's stale file sorts BEFORE Y's file in readdir (boot 1 setup).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("mb2a");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "mb2a");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason mb2a", enteredAt: Date.now(), tokens: ["token-teamA-mb2a"] }, null, 2) + "\n");

    // BOOT 1 -- creates the collision, secures Y's safety-tmp.
    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check(
      "(positive control) teamA's own write landed on Y's exact physical file",
      fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA,
    );
    const yHash = hashForKey(kp);
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.startsWith(yHash) && f.includes(".tmp-safety-"));
    check("(positive control) Y's safety-tmp residue was created after boot 1", !!safetyTmpAfterBoot1);

    // BOOT 2 -- a REAL reboot (fresh module instance, re-reads everything from disk). Then, IN THIS
    // SAME boot, clear teamA (the sibling who durably owns the collision target) -- no query of Y in
    // between the reboot and the clear.
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    boot2.clearMergeQuarantine(teamA);
    check(
      "*** THE FIX (round 2, CRITICAL 1) *** Y's safety-tmp SURVIVES a clear of teamA performed in BOOT 2, two boots after it was created",
      !!safetyTmpAfterBoot1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    // BOOT 3 -- a SECOND real reboot. Y must still be recoverable.
    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const yAfterBoot3 = boot3.activeMergeQuarantineFor(y);
    check(
      "*** THE FIX (round 2, CRITICAL 1), CONFIRMED *** after BOOT 3, following a clear performed in BOOT 2, Y's quarantine SURVIVES",
      !!yAfterBoot3 && (yAfterBoot3.tokens ?? []).includes("token-y-mb2a"),
    );
  } else if (scenarioName === "ef651188-multiboot-clear-in-boot2-order-b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Reparametrization of the above over the OTHER age order -- teamA's stale file sorts AFTER Y's
    // file in readdir (boot 1 setup). Expected non-discriminating parity (Phase 0 runs after both PASS 1
    // and PASS 1b have finished reading, regardless of order) -- confirmed, not assumed, by running it.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("mb2b");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `~stale-teamA-${freshSfx()}.json`);
    placeStaleAfterFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "mb2b");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason mb2b", enteredAt: Date.now(), tokens: ["token-teamA-mb2b"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check(
      "(positive control) teamA's own write landed on Y's exact physical file",
      fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA,
    );
    const yHash = hashForKey(kp);
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.startsWith(yHash) && f.includes(".tmp-safety-"));
    check("(positive control) Y's safety-tmp residue was created after boot 1", !!safetyTmpAfterBoot1);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    boot2.clearMergeQuarantine(teamA);
    check(
      "*** THE FIX (round 2, CRITICAL 1), OTHER AGE ORDER *** Y's safety-tmp SURVIVES a clear of teamA performed in BOOT 2",
      !!safetyTmpAfterBoot1 && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const yAfterBoot3 = boot3.activeMergeQuarantineFor(y);
    check(
      "*** THE FIX (round 2, CRITICAL 1), OTHER AGE ORDER, CONFIRMED *** after BOOT 3, Y's quarantine SURVIVES",
      !!yAfterBoot3 && (yAfterBoot3.tokens ?? []).includes("token-y-mb2b"),
    );
  } else if (scenarioName === "ef651188-multiboot-4boot-stability") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, round 2 CRITICAL 1, 4-boot stability variant. An EXTRA plain reboot (boot 2, no
    // clear, no query) sits between creation (boot 1) and the clear (boot 3), proving the fix holds
    // across repeated read-back cycles, not merely across a single intervening reboot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeEf651188Fixture("mb4");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "mb4");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA REAL reason mb4", enteredAt: Date.now(), tokens: ["token-teamA-mb4"] }, null, 2) + "\n");

    // BOOT 1 -- creates the collision.
    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const yHash = hashForKey(kp);
    const safetyTmpAfterBoot1 = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.startsWith(yHash) && f.includes(".tmp-safety-"));
    check("(positive control) Y's safety-tmp residue was created after boot 1", !!safetyTmpAfterBoot1);

    // BOOT 2 -- a PLAIN reboot: no clear, no query, just an extra read-back cycle.
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check(
      "(stability) Y's safety-tmp residue still exists after an intervening plain reboot (boot 2)",
      fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    // BOOT 3 -- a REAL reboot. Clear teamA IN THIS boot.
    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    boot3.clearMergeQuarantine(teamA);
    check(
      "*** THE FIX, STABLE ACROSS AN EXTRA REBOOT *** Y's safety-tmp SURVIVES a clear performed in boot 3 (the THIRD boot, not the second)",
      fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmpAfterBoot1)),
    );

    // BOOT 4 -- a FOURTH real reboot. Y must still be recoverable.
    const boot4 = await freshBootModule();
    boot4.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const yAfterBoot4 = boot4.activeMergeQuarantineFor(y);
    check(
      "*** THE FIX, CONFIRMED OVER 4 BOOTS *** Y's quarantine SURVIVES",
      !!yAfterBoot4 && (yAfterBoot4.tokens ?? []).includes("token-y-mb4"),
    );
  } else if (scenarioName === "ef651188-degraded-divert-pass2-orphan-no-growth") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card ef651188, round 2 Code Review b4742106, MAJOR (a REGRESSION vs main). X is a ghost path that
    // degraded-occupies xHost's OWN key Kx (X's only file sits AT sha(Kx).json, carrying resolvedKey:
    // Kx) -- the 883e29bc degraded-divert branch pushes X's own pending reference with sourceFile ==
    // sha(Kx).json, a FINAL-shaped basename, never a tmp. An unrelated corrupt orphan (matching NO
    // registered repo at any hash tier) triggers PASS 2's own orphan loop, which adds EVERY registered
    // repo's own write target to allBootWriteTargets with NO regard for degradedOccupiedKeys --
    // including xHost's, the EXACT basename X's divert already occupies. Round 1's own Phase 0 loop
    // treated this as "at risk" and wrote a fresh, never-cleaned-up safety-tmp EVERY boot, `.map()`-
    // replacing the pushed entry and breaking its reference identity with byRepoKey's own occupant (so
    // listActiveMergeQuarantines' reference-based dedup could no longer collapse the two). Nothing is
    // EVER actually written to sha(Kx).json this boot -- bootWriteLatch's own degradedOccupiedKeys
    // refusal is unconditional -- so there was never anything to protect in the first place.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const xHost = path.join(os.tmpdir(), `loom-mqef-xhost-deg-${freshSfx()}`);
    fs.mkdirSync(xHost, { recursive: true });
    tmpDirs.push(xHost);
    fs.writeFileSync(path.join(xHost, "README.md"), "# xhost-deg\n");
    execSync(`git init -q && git config user.email mqmsod@loom && git config user.name mqmsod`, { cwd: xHost });
    commitAll(xHost, "init", GIT_ID);
    const kx = canonicalRepoLockKey(xHost);
    const x = path.join(os.tmpdir(), `loom-mqef-x-never-deg-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xAtKxPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`);
    fs.writeFileSync(xAtKxPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies xHost's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x-deg"], resolvedKey: kx,
    }, null, 2) + "\n");
    // An unrelated corrupt orphan — matches no registered repo at any hash tier — triggers PASS 2's own
    // orphan loop (the mechanism that pulls xHost's own write target into allBootWriteTargets).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "ffffffffffffffffffffffff.json"), "{ corrupt orphan");

    const countXReports = (listFn) => listFn().filter((e) => (e.tokens ?? []).includes("token-x-deg")).length;
    const countSafetyTmps = () => fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.includes(".tmp-safety-")).length;

    reenterMergeQuarantinesAtBoot([xHost]);
    const boot1Count = countXReports(listActiveMergeQuarantines);
    const boot1Tmps = countSafetyTmps();
    check("(positive control) X is reported at least once after boot 1", boot1Count >= 1);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([xHost]);
    const boot2Count = countXReports(boot2.listActiveMergeQuarantines);
    const boot2Tmps = countSafetyTmps();

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([xHost]);
    const boot3Count = countXReports(boot3.listActiveMergeQuarantines);
    const boot3Tmps = countSafetyTmps();

    check(
      "*** THE FIX (round 2, MAJOR) *** X's own report count does NOT grow across 3 boots (flat, matching main's own flat behavior)",
      boot1Count === boot2Count && boot2Count === boot3Count,
    );
    check(
      "*** THE FIX (round 2, MAJOR) *** no safety-tmp residue is EVER written for this degraded-divert case -- its own write target is always refused by degradedOccupiedKeys, so there was never anything to protect",
      boot1Tmps === 0 && boot2Tmps === 0 && boot3Tmps === 0,
    );

    boot3.clearMergeQuarantine(xHost);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS"
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
