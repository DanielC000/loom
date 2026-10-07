import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card fd189d91, items (a) + (b) — from Code Review 347406a6 of ef651188 round 2.
//
// (a) A Phase-0-protected pending entry Y's safety-tmp is named under the COLLIDING SIBLING's own key
// hash — `quarantineLatchFileIdsFor` used to hand out that same hash as Y's OWN latch id, byte-identical
// to the sibling's real `armedKeys`-derived id. `clearMergeQuarantineLatchFile` checked `activeQuarantines`
// first and returned immediately on a match, so clearing "Y's id" silently lifted the SIBLING's
// quarantine instead, leaving Y in place. See docs/decisions/fd189d91-pending-latch-id-collision.md.
//
// (b) The safety-tmp recovery loop's plain resolvable-and-not-degraded branch never stripped the tmp's
// own basename from the recovered entry's `orphanLatchFiles` before arming it, so a graduated entry's
// durable final can permanently name a file that was deleted the moment it graduated.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-latch-id-collision.mjs
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
  "primary-distinct-ids-order-a",
  "primary-distinct-ids-order-b",
  "id-stability-across-3-boots",
  "same-identity-self-divert-not-ambiguous",
  "ambiguity-backstop-two-different-repos",
  "every-listed-id-clearable-or-refused",
  "act-after-reboot-clear-by-path",
  "negative-control-no-collision-keeps-bare-id",
  "dangling-orphan-stripped-on-plain-graduation",
  "dangling-orphan-degraded-branch-unchanged",
  "dangling-orphan-unresolvable-branch-unchanged",
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
    ? "\n✅ ALL SCENARIOS PASS — a pending entry's latch id is disambiguated from its colliding sibling's "
      + "own real id, the id is derived from ONE chokepoint shared by the listing and clear routes, the "
      + "clear route refuses rather than guesses when an id is genuinely ambiguous between two different "
      + "repos, and a graduated safety-tmp no longer leaves a dangling self-reference behind."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card fd189d91.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqlic-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, enterMergeQuarantine, clearMergeQuarantine,
  clearMergeQuarantineLatchFile, clearMergeQuarantineByRecordedPath, quarantineLatchFileIdsFor,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqlic@loom -c user.name=mqlic";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** The SAME derivation `pendingLatchIdFor` uses for a `.tmp-safety-`-shaped sourceFile — hashes the
 *  FULL basename, never just its embedded prefix. Duplicated here (rather than imported) deliberately:
 *  this test must derive its EXPECTATION independently of the production code it is checking, or a bug
 *  in the real chokepoint could silently "agree" with a test that just re-ran the same broken logic. */
function expectedSafetyTmpId(basename) {
  return createHash("sha256").update(basename).digest("hex").slice(0, 24);
}

function makeGitRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlic-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqlic@loom && git config user.name mqlic`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function placeStaleBeforeFixed(fixedPath, staleCandidatePath) {
  fs.writeFileSync(staleCandidatePath, "{}");
  fs.writeFileSync(fixedPath, "{}");
  const order = fs.readdirSync(path.dirname(fixedPath));
  const idxStale = order.indexOf(path.basename(staleCandidatePath));
  const idxFixed = order.indexOf(path.basename(fixedPath));
  if (idxStale >= idxFixed) throw new Error(`expected ${path.basename(staleCandidatePath)} to sort before ${path.basename(fixedPath)}`);
}

function placeStaleAfterFixed(fixedPath, staleCandidatePath) {
  fs.writeFileSync(fixedPath, "{}");
  fs.writeFileSync(staleCandidatePath, "{}");
  const order = fs.readdirSync(path.dirname(fixedPath));
  const idxStale = order.indexOf(path.basename(staleCandidatePath));
  const idxFixed = order.indexOf(path.basename(fixedPath));
  if (idxStale <= idxFixed) throw new Error(`expected ${path.basename(staleCandidatePath)} to sort AFTER ${path.basename(fixedPath)}`);
}

/** `repo` (registered, real git repo) + `teamA` (a plain subdir of `repo` — collapses onto `repo`'s own
 *  key `kp`) + `y` (a path that is NEVER created on disk at all) — the ef651188/fd189d91 shared fixture
 *  shape (mirrors merge-quarantine-migrate-source-owner-durable.mjs's own `makeEf651188Fixture`). */
function makeCollisionFixture(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlic-collide-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  fs.mkdirSync(teamA, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqlic@loom && git config user.name mqlic`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const kp = canonicalRepoLockKey(repo);
  const y = path.join(os.tmpdir(), `loom-mqlic-y-ghost-${tag}-${freshSfx()}`); // NEVER created
  check(`(precondition, ${tag}) Y never exists on disk at all`, !fs.existsSync(y));
  return { repo, teamA, kp, y };
}

function writeGhostPendingLatch(atPath, y, tag) {
  fs.writeFileSync(atPath, JSON.stringify({
    repoPath: y, branch: "y-branch",
    reason: `Y's REAL reason (${tag})`, enteredAt: Date.now() - 60_000, tokens: [`token-y-${tag}`],
  }, null, 2) + "\n");
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "primary-distinct-ids-order-a" || scenarioName === "primary-distinct-ids-order-b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE PRIMARY REPRO. Y (pending, no resolvedKey, never exists) has its only latch at sha(Kp).json —
    // teamA's own correct, eventual migrate TARGET. Both age orders, per CLAUDE.md's own "a fixture axis
    // held constant hides fail-opens" lesson — the ORDER axis matters here because Phase 0's own at-risk
    // scan runs after both PASS1/1b have read (order-agnostic), but the FIXTURE must still prove that.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const orderA = scenarioName.endsWith("order-a");
    const tag = orderA ? "pda" : "pdb";
    const { repo, teamA, kp, y } = makeCollisionFixture(tag);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `${orderA ? "!" : "~"}stale-teamA-${freshSfx()}.json`);
    if (orderA) placeStaleBeforeFixed(kpPath, staleTeamAPath); else placeStaleAfterFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, tag);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA real raise", enteredAt: Date.now(), tokens: [`token-teamA-${tag}`] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check("(positive control) teamA's own write landed on Y's exact physical file", fs.existsSync(kpPath) && JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA);

    const teamAEntry = activeMergeQuarantineFor(teamA);
    const yEntry = activeMergeQuarantineFor(y);
    check("(sanity) teamA is active", !!teamAEntry);
    check("(sanity) Y is active (pending, tier-4 divert)", !!yEntry);
    const teamAIds = quarantineLatchFileIdsFor(teamAEntry);
    const yIds = quarantineLatchFileIdsFor(yEntry);
    check(`*** THE FIX *** teamA's id (${teamAIds}) and Y's id (${yIds}) are GENUINELY DIFFERENT`, teamAIds[0] !== yIds[0]);
    check("(sanity) teamA's own id equals the plain hash of its real key", teamAIds[0] === hashForKey(kp));

    const safetyTmp = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(".tmp-safety-"));
    check("(sanity) Y's safety-tmp residue exists on disk", !!safetyTmp);
    check("(sanity) Y's listed id is the full-basename hash of its own safety-tmp, not the embedded prefix", yIds[0] === expectedSafetyTmpId(safetyTmp));

    // Clearing teamA's id must lift ONLY teamA.
    const clearTeamA = clearMergeQuarantineLatchFile(teamAIds[0]);
    check("clearing teamA's id reports ok:true, wasQuarantined:true", clearTeamA.ok === true && clearTeamA.wasQuarantined === true);
    check("clearing teamA's id lifted ONLY teamA", clearTeamA.liftedRepoPaths.length === 1 && clearTeamA.liftedRepoPaths[0] === teamA);
    check("*** THE FIX *** Y is STILL active after clearing teamA's id", !!activeMergeQuarantineFor(y));

    // Clearing Y's id must lift ONLY Y.
    const clearY = clearMergeQuarantineLatchFile(yIds[0]);
    check("clearing Y's id reports ok:true, wasQuarantined:true", clearY.ok === true && clearY.wasQuarantined === true);
    check("clearing Y's id lifted ONLY Y", clearY.liftedRepoPaths.length === 1 && clearY.liftedRepoPaths[0] === y);
    check("Y is gone after clearing its own id", !activeMergeQuarantineFor(y));
  } else if (scenarioName === "id-stability-across-3-boots") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Manager note 1: the disambiguated id must be BYTE-STABLE across reboots while Y stays pending —
    // never re-derived to a new value just because a later boot re-reads the safety-tmp off disk.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeCollisionFixture("stab");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "stab");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-stab"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const idBoot1 = quarantineLatchFileIdsFor(activeMergeQuarantineFor(y))[0];

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const idBoot2 = boot2.quarantineLatchFileIdsFor(boot2.activeMergeQuarantineFor(y))[0];

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const idBoot3 = boot3.quarantineLatchFileIdsFor(boot3.activeMergeQuarantineFor(y))[0];

    check(`*** ID STABILITY *** Y's id is byte-identical across 3 boots (boot1=${idBoot1}, boot2=${idBoot2}, boot3=${idBoot3})`, idBoot1 === idBoot2 && idBoot2 === idBoot3);
    // Negative control on the stability check itself: teamA's own id, by contrast, is NOT expected to
    // equal Y's — proves the equality check above isn't vacuously true because every id happens to match.
    const teamAIdBoot3 = boot3.quarantineLatchFileIdsFor(boot3.activeMergeQuarantineFor(teamA))[0];
    check("(negative control) teamA's id is NOT the same as Y's id (the two are genuinely different entries)", teamAIdBoot3 !== idBoot3);
    boot3.clearMergeQuarantine(teamA);
  } else if (scenarioName === "same-identity-self-divert-not-ambiguous") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // X (a ghost) degraded-occupies xHost's own key Kx — the SAME entry is armed in activeQuarantines at
    // Kx AND present (by reference) in pendingUnresolvedQuarantines via the 883e29bc divert. This is the
    // documented "same object, two structures, report once" shape (listActiveMergeQuarantines' own doc) —
    // NOT ambiguous, and clearing its id must proceed cleanly, never refuse.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const xHost = makeGitRepo("xhost-self");
    const kx = canonicalRepoLockKey(xHost);
    const x = path.join(os.tmpdir(), `loom-mqlic-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies xHost's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x-self"], resolvedKey: kx,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([xHost]);
    const xEntry = activeMergeQuarantineFor(x);
    check("(sanity) X is active, armed at Kx via the degraded divert", !!xEntry);
    const xId = quarantineLatchFileIdsFor(xEntry)[0];
    check("(sanity) X's id is the plain hash of Kx (it IS armed — armedKeys branch wins)", xId === hashForKey(kx));

    const clearX = clearMergeQuarantineLatchFile(xId);
    check("*** NOT AMBIGUOUS *** clearing X's own id (matching both its active arm AND its own pending self-divert) does NOT refuse", clearX.ok === true);
    check("clearing X's own id actually lifts it", clearX.ok === true && clearX.wasQuarantined === true);
    check("X is gone after the clear", !activeMergeQuarantineFor(x));
  } else if (scenarioName === "ambiguity-backstop-two-different-repos") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // A genuine two-DIFFERENT-repos id collision, constructed realistically rather than via a test-only
    // injection seam: boot ONCE while nothing occupies key Ka at all — a ghost B's own ORDINARY (never
    // safety-tmp-shaped) stale residue, filed at a hash prefix that happens to equal Ka, is read as a
    // genuinely pending entry (PASS 1b's own "no resolvedKey, unresolvable" branch; the "already covered,
    // blind-delete" shortcut does NOT fire because nothing with a CLEAN parse occupies Ka yet). THEN, in
    // the SAME process (no reboot), repo A is raised LIVE via enterMergeQuarantine — arming it at Ka
    // through the in-process path, entirely independent of boot-time `cleanlyParsedKeys` bookkeeping.
    // Two different repoPaths now share one id: A (active) and B (pending, a different identity).
    // No natural "age order" axis applies here — there is exactly one file on disk at boot time, so
    // there is nothing for readdir order to vary; see CLAUDE.md's own "SKIP, not silent omission" lesson.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repoA = makeGitRepo("ambA");
    const ka = canonicalRepoLockKey(repoA);
    const repoB = path.join(os.tmpdir(), `loom-mqlic-ambB-ghost-${freshSfx()}`); // NEVER created
    check("(precondition) B never exists at all", !fs.existsSync(repoB));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const bTmpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ka)}.json.tmp-999999`);
    fs.writeFileSync(bTmpPath, JSON.stringify({
      repoPath: repoB, branch: "b-branch", reason: "B's own stray ordinary tmp, named with A's own hash prefix", enteredAt: Date.now() - 60_000, tokens: ["token-b-amb"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repoA, repoB]);
    check("(precondition) A has no quarantine of its own yet", !activeMergeQuarantineFor(repoA));
    const bEntry = activeMergeQuarantineFor(repoB);
    check("(precondition) B is pending (no resolvedKey, unresolvable)", !!bEntry);
    const bId = quarantineLatchFileIdsFor(bEntry)[0];
    check("(precondition) B's id is the plain hash of Ka (an ordinary, non-safety-tmp shape)", bId === hashForKey(ka));

    // Now raise A LIVE, in-process — arms it at Ka independently of boot-time bookkeeping.
    enterMergeQuarantine(repoA, "a-branch", "A's own live raise, same key as B's pending id");
    const aEntry = activeMergeQuarantineFor(repoA);
    check("(precondition) A is now active, armed at Ka", !!aEntry);
    const aId = quarantineLatchFileIdsFor(aEntry)[0];
    check("(precondition) A's id equals B's id — THE GENUINE COLLISION", aId === bId);

    const result = clearMergeQuarantineLatchFile(aId);
    check("*** THE BACKSTOP *** clearing the shared id REFUSES rather than silently picking one side", result.ok === false);
    check("the refusal names BOTH candidate repoPaths", typeof result.reason === "string" && result.reason.includes(repoA) && result.reason.includes(repoB));
    check("(sanity) neither side was actually touched by the refused clear", !!activeMergeQuarantineFor(repoA) && !!activeMergeQuarantineFor(repoB));
    clearMergeQuarantine(repoA);
  } else if (scenarioName === "every-listed-id-clearable-or-refused") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Manager note 2: every id the listing route would emit must be either clearable or refused — never
    // "nothing matches" (the orphan-sweep fallback branch). Mixed fixture: an ordinary active entry, the
    // primary Y+teamA collision pair, and the same-identity self-divert shape.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const ordinary = makeGitRepo("listed-ord");
    const { repo, teamA, kp, y } = makeCollisionFixture("listed");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "listed");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-listed"] }, null, 2) + "\n");
    const xHost = makeGitRepo("listed-xhost");
    const kx = canonicalRepoLockKey(xHost);
    const x = path.join(os.tmpdir(), `loom-mqlic-listed-x-${freshSfx()}`);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kx)}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X self-divert", enteredAt: Date.now() - 120_000, tokens: ["token-x-listed"], resolvedKey: kx,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([ordinary, repo, teamA, y, xHost]);
    enterMergeQuarantine(ordinary, "ord-branch", "an ordinary, unrelated active entry");

    const entries = listActiveMergeQuarantines();
    check("(sanity) the mixed fixture produced at least 4 distinct entries", entries.length >= 4);
    const everyId = [...new Set(entries.flatMap((e) => quarantineLatchFileIdsFor(e)))];
    check(`(sanity) at least 4 distinct ids were collected (found ${everyId.length})`, everyId.length >= 4);

    let notFoundCount = 0;
    for (const id of everyId) {
      const r = clearMergeQuarantineLatchFile(id);
      const isNotFound = r.ok === true && r.wasQuarantined === false;
      if (isNotFound) { notFoundCount++; console.log(`  UNEXPECTED NOT-FOUND for listed id ${id}`); }
    }
    check(`*** THE INVARIANT (manager note 2) *** every listed id is clearable or refused, NEVER not-found (found ${notFoundCount} not-found result(s))`, notFoundCount === 0);
  } else if (scenarioName === "act-after-reboot-clear-by-path") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Act-after-reboot variant: clear Y's quarantine by its own repoPath (not by id) after a real reboot
    // — confirms the id-disambiguation fix did not disturb the UNRELATED, pre-existing by-path clear
    // route at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeCollisionFixture("bypath");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "bypath");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-bypath"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check("(sanity) Y is active after the reboot", !!boot2.activeMergeQuarantineFor(y));
    const byPathResult = boot2.clearMergeQuarantineByRecordedPath(y);
    check("clearing Y by its own repoPath (not by id) reports wasQuarantined:true", byPathResult.wasQuarantined === true);
    check("Y is gone", !boot2.activeMergeQuarantineFor(y));
    check("(sanity) teamA is unaffected by Y's by-path clear", !!boot2.activeMergeQuarantineFor(teamA));
    boot2.clearMergeQuarantine(teamA);
  } else if (scenarioName === "negative-control-no-collision-keeps-bare-id") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Negative control on the fix itself: an ORDINARY pending entry (no safety-tmp, no collision at all)
    // must still get the OLD, plain bare-hash id — the disambiguation must not fire where it isn't needed.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const ghost = path.join(os.tmpdir(), `loom-mqlic-noncolliding-ghost-${freshSfx()}`);
    check("(precondition) the ghost never exists", !fs.existsSync(ghost));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const ghostKey = canonicalRepoLockKey(ghost);
    const ghostPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ghostKey)}.json`);
    fs.writeFileSync(ghostPath, JSON.stringify({ repoPath: ghost, branch: "ghost-branch", reason: "no collision at all", enteredAt: Date.now(), tokens: ["token-ghost-nc"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]);
    const ghostEntry = activeMergeQuarantineFor(ghost);
    check("(sanity) the ghost is pending", !!ghostEntry);
    const ghostId = quarantineLatchFileIdsFor(ghostEntry)[0];
    check("(negative control) a non-colliding pending entry keeps the OLD, plain bare-hash id", ghostId === hashForKey(ghostKey));
    clearMergeQuarantine(ghost);
  } else if (scenarioName === "dangling-orphan-stripped-on-plain-graduation") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Card item (b). BOOT 1: create the Y/teamA collision — Y's safety-tmp is written self-referencing
    // its own basename. BOOT 2: make Y RESOLVABLE (mkdir + git init at Y's own path) and NOT degraded —
    // it graduates via the plain resolvable-and-not-degraded recovery branch. The durably-written final
    // must carry NO dangling reference to the now-deleted safety-tmp.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeCollisionFixture("dangle");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "dangle");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-dangle"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const safetyTmp = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(".tmp-safety-"));
    check("(sanity) Y's safety-tmp residue exists after boot 1", !!safetyTmp);
    const safetyTmpContentBoot1 = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp), "utf8"));
    check("(sanity) the safety-tmp self-references its own basename in orphanLatchFiles", (safetyTmpContentBoot1.orphanLatchFiles ?? []).includes(safetyTmp));

    // Make Y resolvable and non-degraded for boot 2.
    fs.mkdirSync(y, { recursive: true });
    fs.writeFileSync(path.join(y, "README.md"), "# y graduates\n");
    execSync(`git init -q && git config user.email mqlic@loom && git config user.name mqlic`, { cwd: y });
    commitAll(y, "init", GIT_ID);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check("(sanity) Y's safety-tmp was deleted after it graduated", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp)));
    const yAfterGraduation = boot2.activeMergeQuarantineFor(y);
    check("(sanity) Y is active (graduated) after boot 2", !!yAfterGraduation);
    const yFinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(canonicalRepoLockKey(y))}.json`);
    check("(sanity) Y's real final exists on disk", fs.existsSync(yFinalPath));
    const yFinalContent = JSON.parse(fs.readFileSync(yFinalPath, "utf8"));
    check(
      `*** THE FIX (item b) *** Y's durable final carries NO dangling reference to its own (deleted) safety-tmp (orphanLatchFiles=${JSON.stringify(yFinalContent.orphanLatchFiles ?? [])})`,
      !(yFinalContent.orphanLatchFiles ?? []).includes(safetyTmp),
    );
    boot2.clearMergeQuarantine(teamA);
    boot2.clearMergeQuarantine(y);
  } else if (scenarioName === "dangling-orphan-degraded-branch-unchanged") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Regression guard: the DEGRADED recovery branch (97cff6db round 3, finding E) must KEEP its own
    // self-reference — item (b)'s strip must not accidentally reach this branch too.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeCollisionFixture("degbranch");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "degbranch");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-degbranch"] }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const safetyTmp = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(".tmp-safety-"));
    check("(sanity) Y's safety-tmp residue exists after boot 1", !!safetyTmp);

    // Make Y resolvable, AND degraded-occupy its own target key with an unrelated third entry (Z) before
    // boot 2, so Y's recovery goes through the DEGRADED branch instead of the plain one.
    fs.mkdirSync(y, { recursive: true });
    fs.writeFileSync(path.join(y, "README.md"), "# y degraded\n");
    execSync(`git init -q && git config user.email mqlic@loom && git config user.name mqlic`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const z = path.join(os.tmpdir(), `loom-mqlic-z-degoccupy-${freshSfx()}`); // never exists
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`), JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z degraded-occupies Y's own target key", enteredAt: Date.now() - 120_000, tokens: ["token-z-degbranch"], resolvedKey: ky,
    }, null, 2) + "\n");

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    check("(sanity) Y's safety-tmp SURVIVES (degraded branch, not deleted)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp)));
    const survivingContent = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp), "utf8"));
    check(
      "*** REGRESSION GUARD *** the degraded branch's own self-reference is UNCHANGED by item (b)'s strip",
      (survivingContent.orphanLatchFiles ?? []).includes(safetyTmp),
    );
    boot2.clearMergeQuarantine(teamA);
    boot2.clearMergeQuarantine(z);
  } else if (scenarioName === "dangling-orphan-unresolvable-branch-unchanged") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // Regression guard: the UNRESOLVABLE branch (ef651188 round 2, CRITICAL 1's generic backstop) must
    // KEEP self-referencing at read time, across repeated boots while Y never becomes resolvable at all.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, y } = makeCollisionFixture("unresbranch");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
    placeStaleBeforeFixed(kpPath, staleTeamAPath);
    writeGhostPendingLatch(kpPath, y, "unresbranch");
    fs.writeFileSync(staleTeamAPath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA", enteredAt: Date.now(), tokens: ["token-teamA-unresbranch"] }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([repo, teamA, y]);
    const safetyTmp = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(".tmp-safety-"));
    check("(sanity) Y's safety-tmp residue exists after boot 1", !!safetyTmp);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, y]); // Y still never exists — stays unresolvable
    check("(sanity) Y's safety-tmp SURVIVES (unresolvable branch, not deleted)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp)));
    const survivingContent = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, safetyTmp), "utf8"));
    check(
      "*** REGRESSION GUARD *** the unresolvable branch's own self-reference is UNCHANGED by item (b)'s strip",
      (survivingContent.orphanLatchFiles ?? []).includes(safetyTmp),
    );
    boot2.clearMergeQuarantine(teamA);
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
