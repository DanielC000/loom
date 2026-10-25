import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 58ae4b34 — a degraded occupant's own contributors were never independently enforced.
//
// 4b6c8d24 round 3, Q named the open probe: a protected/relocated occupant X's own `contributorRepoPaths`
// (82032b5c) is carried forward as DATA through relocation, but `assertRepoNotQuarantined(xSub)` read
// `ok:true` (unblocked) regardless — the card's own title premise ("relocation stops enforcing") was
// INVESTIGATED and FALSIFIED first (worker_report blocked, Lead-approved diagnosis): the gap is
// pre-existing, identical BEFORE any clear ever runs, AFTER a clear, and across a reboot — it is NOT
// caused by relocation. It is simply that `contributorRepoPaths` was never consulted by the actual
// blocking-decision functions (`resolveQuarantineFor` -> `ownIdentityEntryFor`/`activeMergeQuarantineFor`),
// only by disclosure (4b6c8d24's `liftedRepoPaths`) and clear-by-id ambiguity (82032b5c's
// `ambiguousIdentitiesFor`) machinery.
//
// The fix: `ownIdentityEntryFor` now ALSO matches an entry's own `contributorRepoPaths` via
// `directPathIdentity`, for both the active and pending tiers — see that function's own doc. This ONLY
// changes behavior for an UNRESOLVABLE query (resolveQuarantineFor only reaches ownIdentityEntryFor for
// those), so a RESOLVABLE subdirectory contributor (the common/primary production shape — e.g. 82032b5c
// round 6's own real-sibling-subdirectory case) is unaffected: it was already independently enforced via
// ordinary ancestor-walk key-collapse, never via contributorRepoPaths at all. SCENARIO
// `resolvable-subdir-contributor-unaffected` below is the control proving exactly that.
//
// `assertRepoNotQuarantined`'s existing refusal-text machinery (`ambiguousIdentitiesFor`/
// `remediationTextFor`, 82032b5c round 4) ALREADY names the host entry's own repoPath/latch id and the
// one working route (clear-by-path with the host's own path) whenever `contributorRepoPaths` is
// non-empty — so once `ownIdentityEntryFor` resolves a contributor's query to its host entry, the
// refusal is automatically actionable with NO further code change: see `refusal-names-host-entry-not-contributor`.
//
// Does NOT widen any CLEAR route (82032b5c round 4 stands: clear-by-path/clear-by-id still cannot clear a
// contributor BY ITS OWN PATH) — only the enforcement/refusal CHECK is widened. Clearing the HOST entry by
// its own path is still the one working route, and still correctly cascades to unblock its contributor —
// see `clearing-host-unblocks-its-contributor`.
//
// Eviction/re-pointing (protectOccupantContentBeforeDelete's own atFilenameIdx/atFinalBasenameIdx
// mechanics, a SECOND collision re-pointing an already-relocated pending reference) was explicitly left
// UNPROVEN by the investigate-first step — not asserted here either; see docs/decisions/58ae4b34-*.md.
//
// TERMINOLOGY: "reboot-sim" is a FRESH, cache-busted `import()` of the compiled module in the SAME
// process (module-level state starts genuinely empty) — never an actual OS process restart; same
// convention as merge-quarantine-pass1-migrate-union.mjs's own header.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver:
// run with no args to spawn one child per scenario; a child reads `--scenario=<name>` off argv and runs
// only that one scenario inline, exiting non-zero on any failure within it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-58ae4b34-contributor-enforcement.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "ghost-contributor-enforcement-lifecycle",
  "pending-entry-contributor-blocked",
  "resolvable-subdir-contributor-unaffected",
  "own-identity-wins-over-contributor-match",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
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
    ? "\n✅ ALL SCENARIOS PASS — a degraded occupant's own contributors are now independently enforced, "
      + "riding on the host's surviving record (active OR pending), with no change to the unaffected "
      + "resolvable-subdirectory shape and no widening of any clear route."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces/regresses board card 58ae4b34.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-58ae4b34-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  activeMergeQuarantineFor, enterMergeQuarantine, setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly,
  assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=58ae4b34@loom -c user.name=58ae4b34";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// @decision 58ae4b34 (round 2, CR `ebfdb799`) — assert the EXACT `blocking repo '<path>'` clause, never
// a bare `reason.includes(hostPath)`: a contributor path (xSub/pSub) contains its host path as a string
// PREFIX, so a substring check against the host path alone passes vacuously even when the reason only
// ever names the CONTRIBUTOR's own path, not the host's.
function namesAsBlockingRepo(reason, repoPath) {
  return reason.includes(`blocking repo '${repoPath}'`);
}

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-58ae4b34-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# 58ae4b34 fixture (${tag})\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// A fresh, cache-busted re-import of the compiled module in THIS SAME process — a REBOOT-SIM, never an
// actual OS process restart. See this file's own header.
let bootReimportCounter = 0;
async function rebootSim(registeredRepoPaths = []) {
  bootReimportCounter++;
  const mod = await import(`${mergeQuarantineModuleHref}?b58ae4b34=${bootReimportCounter}`);
  mod.reenterMergeQuarantinesAtBoot(registeredRepoPaths);
  return mod;
}

if (scenarioName === "ghost-contributor-enforcement-lifecycle") {
  // The (L) shape from merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs, standalone: a ghost X
  // (never created) squats R's own canonical key, carrying contributorRepoPaths:[xSub]. xSub must read
  // BLOCKED at every stage of X's lifecycle: before any clear, after clear(R) relocates X to the pending
  // tier, and across a reboot of that relocated pending record — never just "after relocation", since the
  // investigate-first step proved the gap (pre-fix) was identical at every one of these stages, not
  // introduced by relocation itself.
  const R = makeRepo("L-R");
  const kR = canonicalRepoLockKey(R);
  const X = path.join(os.tmpdir(), `loom-58ae4b34-L-X-ghost-${sfx}`); // deliberately never created
  const xSub = path.join(X, "subdir");
  const xToken = `x-token-L-${sfx}`;
  const xEntry = {
    repoPath: X, branch: "x-branch", reason: "58ae4b34 fixture: ghost X with its own contributor xSub",
    enteredAt: Date.now(), tokens: [xToken], provenanceUnknown: true, contributorRepoPaths: [xSub],
  };
  setActiveQuarantineTestOnly(kR, xEntry);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kR)}.json`), JSON.stringify({
    repoPath: X, branch: "x-branch", reason: "58ae4b34 fixture", enteredAt: Date.now(), tokens: [xToken],
    provenanceUnknown: true, contributorRepoPaths: [xSub],
  }, null, 2) + "\n");

  // STAGE 1 — before any clear at all: X is still directly armed at kR.
  check("(stage 1) X itself reads blocked", !assertRepoNotQuarantined(X).ok);
  check("*** FIX *** (stage 1, before any clear) xSub reads blocked too", !assertRepoNotQuarantined(xSub).ok);

  // STAGE 2 — clear(R): correctly PROTECTS X (relocates it to the pending tier).
  const resultL = clearMergeQuarantineReporting(R);
  check("(stage 2) R is genuinely unblocked", (resultL.liftedRepoPaths ?? []).includes(R));
  check("(stage 2) X stays blocked (protected/relocated, never lifted)", !assertRepoNotQuarantined(X).ok);
  const xSubAfterClear = assertRepoNotQuarantined(xSub);
  check("*** FIX *** (stage 2, after clear(R)) xSub stays blocked, riding on X's relocated record", xSubAfterClear.ok === false);
  check("*** FIX *** refusal names the HOST entry X (actionable), not xSub itself", xSubAfterClear.ok === false && namesAsBlockingRepo(xSubAfterClear.reason, X));
  check("*** FIX *** refusal points at the one working route: clear-by-path", xSubAfterClear.ok === false && xSubAfterClear.reason.includes("clear-by-path"));

  // STAGE 3 — a reboot-sim of the relocated pending record.
  const rebooted = await rebootSim([R]); // X is a ghost, never registered
  check("(stage 3) X survives the reboot, still blocked", !rebooted.assertRepoNotQuarantined(X).ok);
  const xSubAfterReboot = rebooted.assertRepoNotQuarantined(xSub);
  check("*** FIX *** (stage 3, after a reboot-sim) xSub stays blocked too", xSubAfterReboot.ok === false);
  check("*** FIX *** post-reboot refusal still names the HOST entry X", xSubAfterReboot.ok === false && namesAsBlockingRepo(xSubAfterReboot.reason, X));

  // STAGE 4 — clearing the HOST (X) by its own path must cascade to unblock its contributor. 82032b5c
  // round 4 stands: a contributor can NEVER be cleared by its own path — this clears X directly instead.
  const clearXResult = rebooted.clearMergeQuarantineByRecordedPath(X);
  check("(stage 4) clearing X by its own path genuinely lifts it", (clearXResult.liftedRepoPaths ?? []).includes(X));
  check("(stage 4) X itself is now unblocked", rebooted.assertRepoNotQuarantined(X).ok);
  check("*** FIX *** (stage 4) clearing the host X cascades to unblock its contributor xSub too", rebooted.assertRepoNotQuarantined(xSub).ok);

  // Negative control: xSub's own path was never anyone's primary identity — clearing it directly (not
  // via the host) must be a genuine no-op, never itself report lifting anything (82032b5c round 4: a
  // contributor cannot be cleared by its own path — this fix must not widen that).
  const clearXSubDirectly = rebooted.clearMergeQuarantineByRecordedPath(xSub);
  check("(control) clearing xSub directly (never via the host) is a no-op — wasQuarantined:false", clearXSubDirectly.wasQuarantined === false);
} else if (scenarioName === "pending-entry-contributor-blocked") {
  // A PENDING-tier entry (never active, never relocated via any clear) carrying contributorRepoPaths —
  // proves the fix covers BOTH tiers `ownIdentityEntryFor` scans, not only the relocated-via-clear shape.
  const P = path.join(os.tmpdir(), `loom-58ae4b34-S2-P-ghost-${sfx}`); // never created
  const pSub = path.join(P, "contrib");
  const pToken = `p-token-S2-${sfx}`;
  const pEntry = {
    repoPath: P, branch: "p-branch", reason: "58ae4b34 fixture: pending entry with contributor pSub",
    enteredAt: Date.now(), tokens: [pToken], contributorRepoPaths: [pSub],
  };
  pushPendingQuarantineTestOnly(pEntry, `pending-${hashKey(P)}.json`);

  check("(precondition) P itself reads blocked via the pending tier", !assertRepoNotQuarantined(P).ok);
  const pSubResult = assertRepoNotQuarantined(pSub);
  check("*** FIX *** a PENDING entry's own contributor reads blocked too (never relocated/cleared at all)", pSubResult.ok === false);
  check("*** FIX *** the refusal names the HOST pending entry P", pSubResult.ok === false && namesAsBlockingRepo(pSubResult.reason, P));

  // PRECISION NEGATIVE (CR round 2, item 3): an absent, UNRELATED sibling — never listed in
  // contributorRepoPaths at all — must stay unblocked. Proves the widened match is scoped to genuinely
  // recorded contributors, not every path that happens to share P as a string prefix.
  const pOther = path.join(P, "other");
  check("(precision negative) an unrelated, non-contributor sibling of P stays unblocked", assertRepoNotQuarantined(pOther).ok);
} else if (scenarioName === "resolvable-subdir-contributor-unaffected") {
  // CONTROL: the common/primary production shape (82032b5c's own mechanism, round 6's D/S siblings) — a
  // REAL, resolvable subdirectory contributor. It was ALREADY independently enforced before this card, via
  // ordinary ancestor-walk key-collapse (resolveQuarantineFor never even reaches ownIdentityEntryFor for a
  // resolvable repoPath) — this fix must not change that path's behavior at all.
  const A = makeRepo("S3-A");
  const Asub = path.join(A, "sub"); // real, existing subdirectory, no .git of its own
  fs.mkdirSync(Asub, { recursive: true });
  enterMergeQuarantine(A, "branch-a", "58ae4b34 control: A", undefined);
  enterMergeQuarantine(Asub, "branch-a-sub", "58ae4b34 control: A/sub", undefined);

  const aEntry = activeMergeQuarantineFor(A);
  check("(precondition) A is quarantined with Asub as a recorded contributor", !!aEntry && Array.isArray(aEntry.contributorRepoPaths) && aEntry.contributorRepoPaths.includes(Asub));
  check("(control) A itself stays enforced", !assertRepoNotQuarantined(A).ok);
  check("*** CONTROL unaffected *** A/sub (a real, resolvable subdirectory) is enforced via key-collapse, not contributorRepoPaths", !assertRepoNotQuarantined(Asub).ok);

  clearMergeQuarantineReporting(A); // cleanup
  check("(control cleanup) A/sub is unblocked once the whole entry is genuinely cleared", assertRepoNotQuarantined(Asub).ok);
} else if (scenarioName === "own-identity-wins-over-contributor-match") {
  // CR round 2, item 2: Y holds ITS OWN pending record AND is ALSO named as a contributor of an
  // unrelated ACTIVE host X. The refusal for Y must name Y's OWN record — never X's, and never depend on
  // which tier or Map-insertion order either scan happens to hit first (the precedence fix).
  const X = path.join(os.tmpdir(), `loom-58ae4b34-S4-X-ghost-${sfx}`); // never created
  const Y = path.join(os.tmpdir(), `loom-58ae4b34-S4-Y-ghost-${sfx}`); // never created, own identity
  const kX = canonicalRepoLockKey(makeRepo("S4-kx-anchor")); // a real, distinct key to arm X at
  const xToken = `x-token-S4-${sfx}`;
  const yToken = `y-token-S4-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "58ae4b34 fixture S4: active X, with Y as a contributor",
    enteredAt: Date.now(), tokens: [xToken], contributorRepoPaths: [Y],
  });
  pushPendingQuarantineTestOnly({
    repoPath: Y, branch: "y-branch", reason: "58ae4b34 fixture S4: Y's OWN pending record",
    enteredAt: Date.now() - 1000, tokens: [yToken],
  }, `pending-${hashKey(Y)}.json`);

  const yResult = assertRepoNotQuarantined(Y);
  check("*** FIX (round 2) *** Y's own record wins — refusal names Y, not the unrelated host X", yResult.ok === false && namesAsBlockingRepo(yResult.reason, Y));
  check("*** FIX (round 2) *** the refusal does NOT name X instead", yResult.ok === false && !namesAsBlockingRepo(yResult.reason, X));
} else {
  throw new Error(`unknown scenario: ${scenarioName}`);
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);
