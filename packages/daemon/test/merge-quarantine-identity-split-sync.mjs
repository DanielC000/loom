import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card fd189d91 item (d), FOLDED with card a2f381dc per manager ruling — same bug class, two
// distinct trigger sites: a spread-replace on ONE side of the active (byRepoKey)/pending
// (pendingUnresolvedQuarantines) split with no re-point of the OTHER side's matching reference.
//
// Site 1 (fd189d91 item d): Phase 0's own pending-protection pass (the `pendingUnresolvedQuarantines =
// ...map(...)` loop) replaces a pending entry's `.entry` via spread when its `sourceFile` collides with
// `allBootWriteTargets`. A degraded-divert entry (flushDegradedDiverts) has `.entry` reference-equal to
// `byRepoKey`'s own occupant and a `sourceFile` that is NEVER `sha(resolvedKey)` by construction — if
// that raw filename happens to collide with an unrelated sibling's own migrate target, the replace
// orphans byRepoKey's own reference. No orphan file, no PASS 2 trigger needed.
//
// Site 2 (a2f381dc, CR b4742106's R3 repro): PASS 2's own orphan-reference merge (an unrelated corrupt
// orphan latch triggers it) replaces `byRepoKey`'s slot for an existing entry via spread (`updated =
// {...existing, ...}`), with no re-point of any pending reference to the OLD `existing` object.
//
// THE FIX: both sites (plus every other SAME-IDENTITY spread-replace site in this function) now route
// through ONE chokepoint, `replaceEntryEverywhere` (merge-quarantine.ts), which re-points BOTH
// `byRepoKey` and `pendingUnresolvedQuarantines` regardless of which side initiated the replacement.
// `armQuarantineKey`'s OWN internal union is deliberately EXCLUDED — see its own doc comment. A new
// structural invariant, `assertQuarantineIdentityInvariantTestOnly`, catches the NEXT same-identity
// spread-replace site a future change might add, but does NOT catch everything (see its own doc).
//
// KNOWN OPEN RESIDUAL (CR 0a408575, "M-1"), NOT fixed by this file — tracked on card a2f381dc: a union
// performed by `armQuarantineKey` (merge-quarantine.ts:316-320) at a key AFTER `flushDegradedDiverts()`
// has already pushed a pending reference for that SAME key (reached at :1913, :1921-1924, :1825, and
// :2017-2020) leaves that already-flushed pending reference pointing at the PRE-union object — even when
// both sides are the SAME logical identity (e.g. a ghost X plus its own torn `h(Kx).json.tmp` residue,
// no sibling involved at all). This still produces a double report, stable across boots, pre-existing on
// main, and not exercised by any scenario in this file.
//
// See docs/decisions/fd189d91-pending-latch-id-collision.md's "Item (d) + a2f381dc" section.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-identity-split-sync.mjs
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
  "phase0-trigger-order-a",
  "phase0-trigger-order-b",
  "phase0-trigger-3boot-count-stable",
  "phase0-trigger-act-after-reboot-clear-by-id",
  "pass2-trigger-order-a",
  "pass2-trigger-order-b",
  "pass2-trigger-3boot-count-stable",
  "pass2-trigger-act-after-reboot-clear-by-path",
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
    ? "\n✅ ALL SCENARIOS PASS — every spread-replace site in reenterMergeQuarantinesAtBoot re-points BOTH "
      + "byRepoKey and pendingUnresolvedQuarantines through ONE chokepoint; a logical quarantine is never "
      + "reported twice via two non-reference-equal objects, from either trigger site."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board cards fd189d91 (item d) and a2f381dc.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqiss-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, clearMergeQuarantine, clearMergeQuarantineLatchFile,
  clearMergeQuarantineByRecordedPath, quarantineLatchFileIdsFor, listActiveMergeQuarantines,
  assertQuarantineIdentityInvariantTestOnly, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqiss@loom -c user.name=mqiss";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeGitRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqiss-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqiss@loom && git config user.name mqiss`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

/** Shared assertion: the structural identity invariant must hold (every logical quarantine represented
 *  by exactly one object, listActiveMergeQuarantines' count matches the distinct-identity count). Called
 *  after EVERY boot in every scenario below, not just the final one. */
function assertInvariant(mod, label) {
  const result = mod.assertQuarantineIdentityInvariantTestOnly();
  check(`(invariant, ${label}) assertQuarantineIdentityInvariantTestOnly holds (${JSON.stringify(result.violations)})`, result.ok);
}

/**
 * SITE 1 fixture (fd189d91 item d). xHost (real repo, key Kx) with ghost X (resolvedKey: Kx) whose own
 * raw latch is filed AT teamB's own eventual migrate target (sha(Kb).json); teamB (a separate real repo)
 * has its own stale-named latch migrating to that SAME sha(Kb).json this boot. `orderA` controls which
 * of the two files sorts first in readdir — Phase 0 runs after BOTH PASS1/1b have finished reading, so
 * this is expected to be a non-discriminating parity check, confirmed (not assumed) by running it.
 */
function makePhase0TriggerFixture(tag, orderA) {
  const xHost = makeGitRepo(`${tag}-xhost`);
  const kx = canonicalRepoLockKey(xHost);
  const xGhost = path.join(os.tmpdir(), `loom-mqiss-xghost-${tag}-${freshSfx()}`); // never exists
  check(`(precondition, ${tag}) X never exists at all`, !fs.existsSync(xGhost));
  const teamB = makeGitRepo(`${tag}-teamB`);
  const kb = canonicalRepoLockKey(teamB);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const xAtKbPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kb)}.json`);
  const staleTeamBPath = path.join(MERGE_QUARANTINE_DIR, `${orderA ? "!" : "~"}stale-teamB-${freshSfx()}.json`);
  // Write order controls readdir sort order deterministically, mirroring the shared sibling repro idiom.
  if (orderA) { fs.writeFileSync(staleTeamBPath, "{}"); fs.writeFileSync(xAtKbPath, "{}"); }
  else { fs.writeFileSync(xAtKbPath, "{}"); fs.writeFileSync(staleTeamBPath, "{}"); }
  const order = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const idxStale = order.indexOf(path.basename(staleTeamBPath));
  const idxX = order.indexOf(path.basename(xAtKbPath));
  if (orderA && idxStale >= idxX) throw new Error("expected teamB's stale file to sort before X's");
  if (!orderA && idxStale <= idxX) throw new Error("expected teamB's stale file to sort after X's");
  fs.writeFileSync(xAtKbPath, JSON.stringify({
    repoPath: xGhost, branch: "x-branch", reason: `X degraded-diverts to xHost, own file at teamB's target (${tag})`,
    enteredAt: Date.now() - 120_000, tokens: [`token-x-${tag}`], resolvedKey: kx,
  }, null, 2) + "\n");
  fs.writeFileSync(staleTeamBPath, JSON.stringify({
    repoPath: teamB, branch: "teamB-branch", reason: `teamB real raise (${tag})`, enteredAt: Date.now(), tokens: [`token-teamB-${tag}`],
  }, null, 2) + "\n");
  return { xHost, xGhost, teamB, registered: [xHost, teamB] };
}

/**
 * SITE 2 fixture (a2f381dc, CR b4742106's R3 repro). X (a ghost) degraded-occupies xHost's own key Kx —
 * the 883e29bc divert branch pushes X's own pending reference (sourceFile = sha(Kx).json, final-shaped,
 * reference-equal to byRepoKey's own occupant). An unrelated corrupt orphan (matching no registered repo
 * at any hash tier) triggers PASS 2's own orphan loop, which merges an orphan reference into xHost's
 * `existing` entry via spread — the a2f381dc trigger.
 */
function makePass2TriggerFixture(tag) {
  const xHost = makeGitRepo(`${tag}-xhost`);
  const kx = canonicalRepoLockKey(xHost);
  const xGhost = path.join(os.tmpdir(), `loom-mqiss-p2xghost-${tag}-${freshSfx()}`); // never exists
  check(`(precondition, ${tag}) X never exists at all`, !fs.existsSync(xGhost));
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`), JSON.stringify({
    repoPath: xGhost, branch: "x-branch", reason: `X degraded-occupies xHost's own key (${tag})`,
    enteredAt: Date.now() - 120_000, tokens: [`token-x-${tag}`], resolvedKey: kx,
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(`orphan-${tag}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`), "{ corrupt orphan, matches no registered repo");
  return { xHost, xGhost, registered: [xHost] };
}

try {
  if (scenarioName === "phase0-trigger-order-a" || scenarioName === "phase0-trigger-order-b") {
    const orderA = scenarioName.endsWith("order-a");
    const tag = orderA ? "p0a" : "p0b";
    const { xHost, xGhost, teamB, registered } = makePhase0TriggerFixture(tag, orderA);
    reenterMergeQuarantinesAtBoot(registered);
    const entries = listActiveMergeQuarantines();
    const xReports = entries.filter((e) => (e.tokens ?? []).includes(`token-x-${tag}`));
    check(`*** THE FIX (site 1) *** X's quarantine is reported EXACTLY once (found ${xReports.length})`, xReports.length === 1);
    check("(sanity) teamB's own write landed on X's exact physical file", JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(canonicalRepoLockKey(teamB))}.json`), "utf8")).repoPath === teamB);
    assertInvariant({ assertQuarantineIdentityInvariantTestOnly }, `site1-${tag}`);
    clearMergeQuarantine(xHost);
    clearMergeQuarantine(teamB);
  } else if (scenarioName === "phase0-trigger-3boot-count-stable") {
    const { xHost, teamB, registered } = makePhase0TriggerFixture("p0stab", true);
    reenterMergeQuarantinesAtBoot(registered);
    const countAfter = (mod) => mod.listActiveMergeQuarantines().filter((e) => (e.tokens ?? []).includes("token-x-p0stab")).length;
    const boot1Count = countAfter({ listActiveMergeQuarantines });
    assertInvariant({ assertQuarantineIdentityInvariantTestOnly }, "boot1");

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot(registered);
    const boot2Count = countAfter(boot2);
    assertInvariant(boot2, "boot2");

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot(registered);
    const boot3Count = countAfter(boot3);
    assertInvariant(boot3, "boot3");

    check(`*** 3-BOOT STABILITY *** X's report count stays 1 across 3 boots (boot1=${boot1Count}, boot2=${boot2Count}, boot3=${boot3Count})`, boot1Count === 1 && boot2Count === 1 && boot3Count === 1);
    boot3.clearMergeQuarantine(xHost);
    boot3.clearMergeQuarantine(teamB);
  } else if (scenarioName === "phase0-trigger-act-after-reboot-clear-by-id") {
    const { xHost, xGhost, teamB, registered } = makePhase0TriggerFixture("p0clear", true);
    reenterMergeQuarantinesAtBoot(registered);
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot(registered);
    const xEntry = boot2.activeMergeQuarantineFor(xGhost);
    check("(sanity) X is active after a reboot", !!xEntry);
    const xId = boot2.quarantineLatchFileIdsFor(xEntry)[0];
    const clearResult = boot2.clearMergeQuarantineLatchFile(xId);
    check("clearing X by id reports wasQuarantined:true", clearResult.ok === true && clearResult.wasQuarantined === true);
    check("X is gone", !boot2.activeMergeQuarantineFor(xGhost));
    check("(sanity) teamB is unaffected", !!boot2.activeMergeQuarantineFor(teamB));

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot(registered);
    check("*** NO RESURRECTION *** X stays cleared after another reboot", !boot3.activeMergeQuarantineFor(xGhost));
    assertInvariant(boot3, "post-clear-boot3");
    boot3.clearMergeQuarantine(teamB);
  } else if (scenarioName === "pass2-trigger-order-a" || scenarioName === "pass2-trigger-order-b") {
    // No natural "order" axis for this fixture — PASS 2's own orphan loop iterates `registeredRepoPaths`
    // (one entry here), not a readdir-ordered pair of colliding files; order-b re-runs the IDENTICAL
    // construction under a different tag as a parity/determinism check rather than a genuine second order.
    const tag = scenarioName.endsWith("order-a") ? "p2a" : "p2b";
    const { xHost, registered } = makePass2TriggerFixture(tag);
    reenterMergeQuarantinesAtBoot(registered);
    const entries = listActiveMergeQuarantines();
    const xReports = entries.filter((e) => (e.tokens ?? []).includes(`token-x-${tag}`));
    check(`*** THE FIX (site 2, a2f381dc) *** X's quarantine is reported EXACTLY once (found ${xReports.length})`, xReports.length === 1);
    assertInvariant({ assertQuarantineIdentityInvariantTestOnly }, `site2-${tag}`);
    clearMergeQuarantine(xHost);
  } else if (scenarioName === "pass2-trigger-3boot-count-stable") {
    const { xHost, registered } = makePass2TriggerFixture("p2stab");
    reenterMergeQuarantinesAtBoot(registered);
    const countAfter = (mod) => mod.listActiveMergeQuarantines().filter((e) => (e.tokens ?? []).includes("token-x-p2stab")).length;
    const boot1Count = countAfter({ listActiveMergeQuarantines });
    assertInvariant({ assertQuarantineIdentityInvariantTestOnly }, "boot1");

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot(registered);
    const boot2Count = countAfter(boot2);
    assertInvariant(boot2, "boot2");

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot(registered);
    const boot3Count = countAfter(boot3);
    assertInvariant(boot3, "boot3");

    check(`*** 3-BOOT STABILITY (a2f381dc) *** X's report count stays 1 across 3 boots (boot1=${boot1Count}, boot2=${boot2Count}, boot3=${boot3Count})`, boot1Count === 1 && boot2Count === 1 && boot3Count === 1);
    boot3.clearMergeQuarantine(xHost);
  } else if (scenarioName === "pass2-trigger-act-after-reboot-clear-by-path") {
    const { xHost, xGhost, registered } = makePass2TriggerFixture("p2clear");
    reenterMergeQuarantinesAtBoot(registered);
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot(registered);
    check("(sanity) X is active after a reboot", !!boot2.activeMergeQuarantineFor(xGhost));
    const clearResult = boot2.clearMergeQuarantineByRecordedPath(xGhost);
    check("clearing X by its own repoPath reports wasQuarantined:true", clearResult.wasQuarantined === true);
    check("X is gone", !boot2.activeMergeQuarantineFor(xGhost));

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot(registered);
    check("*** NO RESURRECTION *** X stays cleared after another reboot", !boot3.activeMergeQuarantineFor(xGhost));
    assertInvariant(boot3, "post-clear-boot3");
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
