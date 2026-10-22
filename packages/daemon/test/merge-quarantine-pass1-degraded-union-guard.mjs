import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 883e29bc (from Code Reviewer 2ae805f3's round-2 review of 8a1bc2ef) — PRE-EXISTING, CRITICAL
// fail-open, same shape as 8a1bc2ef's own round-2 nested-repo repro but reached at BOOT TIME instead of an
// in-process query.
//
// 8a1bc2ef's round-2 fix (isKeyVerifiedFor) closed the IN-PROCESS absorb sites (activeMergeQuarantineFor's
// `direct` fast path, enterMergeQuarantine's `existing`/pending-merge branches) — but never touched
// reenterMergeQuarantinesAtBoot's own PASS 1/1b, which arms a DEGRADED, walked-up dual-arm entry (X — its
// own repoPath unresolvable at boot, so canonicalRepoLockKey walks up to an ENCLOSING repo R and dual-arms
// THERE too) via armQuarantineKey — and armQuarantineKey UNIONS unconditionally with whatever already (or
// later) occupies that key, with NO verification at all. When a genuinely separate, verified sibling (T —
// e.g. a plain subdir of R, collapsing onto R's own canonical key the ordinary way) is ALSO present as its
// own separate on-disk latch at the SAME boot, PASS 1 silently merges X's degraded entry and T's verified
// entry into ONE armed object. A human clearing X by its own recorded key then lifts T's genuine
// quarantine too — and T's own durable record is gone (consumed into the union during T's own ordinary
// migrate-arm), so it stays lifted across a LATER boot as well.
//
// THE FIX: PASS 1/1b's degraded-dual-arm branch now arms ONLY at the entry's own recorded `resolvedKey`
// (trusted per 7673d096) and diverts the degraded, walked-up key's own signal to
// `pendingUnresolvedQuarantines` instead — never into `byRepoKey`/`activeQuarantines` directly.
// `activeMergeQuarantineFor` gained a 4th, dedicated lookup tier (after the three 54054c01/8a1bc2ef tiers,
// which all require either identity equality or current resolvability and so can never find this entry
// while it stays unresolvable): match by `canonicalRepoLockKey` equality alone, gated on STILL being
// unresolvable — so a query for the ancestor R still reads quarantined via X's own entry for as long as
// nothing else genuinely occupies that key, but this tier can only ever return the entry as-is (never
// union/graduate it — every match it can ever produce is unresolvable by construction of its own
// predicate), so it can never absorb — or be absorbed by — a different, verified entry sharing that key.
//
// See docs/decisions/883e29bc-pass1-degraded-arm-never-unions-a-verified-sibling.md for the full repro,
// the design rationale (why a dedicated pending-divert beats either widening armQuarantineKey itself or
// dropping the degraded arm's fail-closed signal entirely), and the two residual properties verified here
// (SCENARIO residual): a clear of the degraded entry sweeps its diverted pending copy too, and a later
// direct query for the degraded entry's own identity, once it remounts, still finds its own quarantine.
//
// ALSO COVERS card `5b40376c` (the "separate, adjacent finding" 883e29bc itself flagged but did not fix):
// PASS 1b's OWN, earlier, unrelated `matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(
// matchedRepo))` short-circuit — reached BEFORE the dual-arm/degraded-divert code this file otherwise
// covers — unlinked an unresolvable X's own tmp residue OUTRIGHT whenever its degraded, walked-up key
// happened to match a wholly unrelated, verified sibling's own clean key. Not merely fail-closed (the
// wrong-attribution 883e29bc's own fix guards against) — fail-OPEN DATA LOSS, with no diverted pending
// copy ever created to recover it. Fixed by also gating that short-circuit on
// `isRepoPathCurrentlyResolvable(matchedRepo)` — see docs/decisions/5b40376c-*.md, and scenarios
// `pass1b-included` / `pass1b-included-convergence` / `pass1b-resolvable-stale-tmp-still-deleted` below.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME (never shared with any other
// scenario in this file, or with any other test) — this file is its own driver: run with no args to spawn
// one child per scenario (collecting pass/fail from each); a child reads `--scenario=<name>` off argv and
// runs only that one scenario inline, exiting non-zero on any failure within it.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-pass1-degraded-union-guard.mjs
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
  "pass1", "pass1b", "pass1b-included", "pass1b-included-convergence",
  "pass1b-resolvable-stale-tmp-still-deleted",
  "residual", "negative-control-cross-key", "direct-verified-guard",
  "clear-x-unmounted", "clear-r-truthful-reporting",
  "stale-armedkeys-no-collateral", "clear-unmasks-different-blocker", "clear-stale-pending-not-blocking",
  "token-clear-identity-drift", "deferred-flush-no-stale-snapshot",
  "dualarm-sibling-key-contamination", "dualarm-sibling-key-contamination-d-first",
  "degraded-divert-rebind-survives-trim-eviction", "degraded-divert-no-duplicate-across-flushes",
  "round3-two-diverts-at-one-key-eviction", "round3-degraded-walkup-to-resolvable-key",
  "round3-chained-eviction-three-parties",
  "round4-p1-resolvable-winner-clear-destroys-loser-file",
  "round4-p2-remounted-walkup-clear-destroys-winner-file",
  "round5-own-raise-lifts-past-inferred-evictee",
  "round6-union-constituent-survives-eviction",
  "round6-mismatch-evictee-survives-clear",
  "d2582692-clear-resolvable-protects-foreign-occupant",
  "d2582692-clearing-union-winner-keeps-loser-pending",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with LOOM_HOME stripped from its env so
  // `useOwnLoomHome` (called inside the child) mints a genuinely fresh one; never share LOOM_HOME across
  // scenarios, or a residue left by one could mask or fake another's result (readdir-order noise is card
  // 4480b077's own concern, not this card's — but a shared directory is an equally real contamination
  // vector regardless of cause).
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
    ? "\n✅ ALL SCENARIOS PASS — PASS 1/1b's degraded-dual-arm branch never unions a verified sibling " +
      "sharing its walked-up key, under its OWN resolvedKey it stays correctly enforced, and both "
      + "mandated residual properties hold, each proven in its own isolated LOOM_HOME."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 883e29bc.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqp1dug-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByKey, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR, clearMergeQuarantine, clearMergeQuarantineReporting,
  quarantineLatchFileIdsFor, clearMergeQuarantineByRecordedPath, enterMergeQuarantine,
  clearMergeQuarantineByToken, quarantineLatchIdFor, assertRepoNotQuarantined,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqp1dug@loom -c user.name=mqp1dug";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the OLD (pre-7673d096) direct-identity key algorithm by hand — same technique as the sibling
// repro files (merge-quarantine-cross-tier-sibling-absorb.mjs).
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// R (a repo) with X = R/nested (its OWN SEPARATE repo, own `.git`) and T = R/teamA (a plain subdir, no
// `.git` of its own — collapses onto R's own key). Same shape as
// merge-quarantine-cross-tier-sibling-absorb.mjs's own `makeRepoWithNestedRepoAndSubdir` (not imported —
// that file's fixture builders aren't exported, and this card's manager directive is "use shared
// HELPERS, not copies" referring to the common `_*.mjs` test utilities below, not a request to restructure
// that file to export its own local fixtures).
function makeRepoWithNestedRepoAndSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqp1dug-repo-${tag}-${freshSfx()}`);
  const nested = path.join(repo, "nested");
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-pass1-degraded-union-guard (${tag})\n`);
  execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: nested });
  fs.writeFileSync(path.join(nested, "README.md"), `# nested own repo (${tag})\n`);
  commitAll(nested, "init", GIT_ID);
  return { repo, nested, subdir };
}

function listingsForKey(mod, expectedKey) {
  return mod.listActiveMergeQuarantines().filter((q) => {
    try { return canonicalRepoLockKey(q.repoPath) === expectedKey; } catch { return false; }
  });
}

// Two SEPARATE listings are the CORRECT outcome at a key shared by a verified entry (T) and a degraded,
// still-unresolvable diverted-pending entry (X) — `listActiveMergeQuarantines` deliberately surfaces a
// pending entry too (so a human reading it never sees a blind spot), and X's own degraded
// canonicalRepoLockKey genuinely still recomputes to this key for as long as it stays unresolvable. The
// FIX is that neither listing's own tokens ever cross into the other's.
function noListingCrossContamination(mod, expectedKey, expectedTokenSets) {
  const listings = listingsForKey(mod, expectedKey);
  if (listings.length !== expectedTokenSets.length) return false;
  const actual = listings.map((q) => new Set(q.tokens ?? [])).sort((a, b) => [...a][0]?.localeCompare([...b][0] ?? "") ?? 0);
  const expected = expectedTokenSets.map((s) => new Set(s)).sort((a, b) => [...a][0]?.localeCompare([...b][0] ?? "") ?? 0);
  return actual.every((set, i) => set.size === expected[i].size && [...set].every((t) => expected[i].has(t)));
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "pass1") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO pass1 — X's latch is an ordinary `.json` final (resolvedKey=Kx already recorded, as if a
    // prior boot had already migrated it once), unresolvable at THIS boot. T's latch is a pre-upgrade
    // `.json` final (no resolvedKey), genuinely resolvable at THIS boot — the ordinary migrate-arm path.
    // Both present as separate on-disk files at the SAME single `reenterMergeQuarantinesAtBoot` call.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("p1");
    const Kx = canonicalRepoLockKey(nested); // X's own TRUE key, captured while X still resolves
    const Kr = canonicalRepoLockKey(repo); // R's own real key — what X's degraded walk-up lands on
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise, recorded under its TRUE key",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-p1-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is genuinely unresolvable at this boot", !fs.existsSync(nested));
    check("(precondition) T is genuinely resolvable at this boot", fs.existsSync(subdir));

    reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // THE SINGLE BOOT CALL UNDER TEST

    const activeR = activeMergeQuarantineFor(repo);
    check("(boot) R reads quarantined via T, the genuinely verified occupant", !!activeR && (activeR.tokens ?? []).includes("t-token"));
    check("*** THE FIX *** X's unverified degraded entry is NEVER unioned into T's verified entry", !!activeR && !(activeR.tokens ?? []).includes("x-token"));
    check("(boot) TWO separate listings at R's key — T's verified entry and X's diverted pending entry, each with only its own token", noListingCrossContamination({ listActiveMergeQuarantines }, Kr, [["t-token"], ["x-token"]]));

    clearMergeQuarantineByKey(Kx, nested); // a human clears X specifically, by its own recorded key
    const activeTAfterClear = activeMergeQuarantineFor(subdir);
    check("(clear X by Kx) T's genuine quarantine SURVIVES, with ONLY its own token", !!activeTAfterClear && (activeTAfterClear.tokens ?? []).length === 1 && activeTAfterClear.tokens.includes("t-token"));

    // RESTART — same parked state (X still unmounted, T still present) — T must survive DURABLY, not just
    // in-process; this is the exact restart shape the card names ("T stays gone after the next boot").
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    const activeTAfterRestart = fresh1.activeMergeQuarantineFor(subdir);
    check("(restart) T's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeTAfterRestart && (activeTAfterRestart.tokens ?? []).length === 1 && activeTAfterRestart.tokens.includes("t-token"));
    check("(restart) X stays cleared — never resurrected", !fresh1.activeMergeQuarantineFor(repo) || !(fresh1.activeMergeQuarantineFor(repo)?.tokens ?? []).includes("x-token"));

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "pass1b") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO pass1b — the SAME shape, but X's latch exists ONLY as a `.json.tmp-<pid>-<hex>` torn-write
    // residue (PASS 1b's own recovery path), never a clean `.json` final. `nested` is deliberately OMITTED
    // from the registered-repo-paths list passed to reenterMergeQuarantinesAtBoot — at the time this
    // scenario was written, including it would have hit PASS 1b's EARLIER, unrelated `matchedRepo &&
    // cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))` guard, which recomputed
    // `canonicalRepoLockKey(nested)` fresh (degraded, since nested stays unresolvable here) = Kr, which IS
    // in cleanlyParsedKeys (T's own clean parse added it) — a DIFFERENT, adjacent false-positive that
    // would silently unlink X's tmp as "already-superseded stale residue" before ever reaching the
    // dual-arm code this scenario targets. Card `5b40376c` fixed that adjacent guard (gated it on
    // `isRepoPathCurrentlyResolvable(matchedRepo)` too), so including `nested` here would no longer
    // collide — this scenario still omits it deliberately, to keep isolating the dual-arm shape it targets
    // from that other guard's own behavior, now covered on its own by the `pass1b-included` and
    // `pass1b-included-convergence` scenarios below.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("p1b");
    const Kx = canonicalRepoLockKey(nested);
    const Kr = canonicalRepoLockKey(repo);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json.tmp-999-deadbeef`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise, torn-write tmp residue",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-p1b-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is genuinely unresolvable at this boot", !fs.existsSync(nested));
    check("(precondition) T is genuinely resolvable at this boot", fs.existsSync(subdir));

    reenterMergeQuarantinesAtBoot([repo, subdir]); // `nested` deliberately omitted — see comment above

    const activeR = activeMergeQuarantineFor(repo);
    check("(boot) R reads quarantined via T, the genuinely verified occupant", !!activeR && (activeR.tokens ?? []).includes("t-token"));
    check("*** THE FIX *** X's unverified tmp-residue entry is NEVER unioned into T's verified entry", !!activeR && !(activeR.tokens ?? []).includes("x-token"));
    check("(boot) TWO separate listings at R's key — T's verified entry and X's diverted pending entry, each with only its own token", noListingCrossContamination({ listActiveMergeQuarantines }, Kr, [["t-token"], ["x-token"]]));

    clearMergeQuarantineByKey(Kx, nested);
    const activeTAfterClear = activeMergeQuarantineFor(subdir);
    check("(clear X by Kx) T's genuine quarantine SURVIVES, with ONLY its own token", !!activeTAfterClear && (activeTAfterClear.tokens ?? []).length === 1 && activeTAfterClear.tokens.includes("t-token"));

    const fresh1b = await freshBootModule();
    fresh1b.reenterMergeQuarantinesAtBoot([repo, subdir]);
    const activeTAfterRestart = fresh1b.activeMergeQuarantineFor(subdir);
    check("(restart) T's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeTAfterRestart && (activeTAfterRestart.tokens ?? []).length === 1 && activeTAfterRestart.tokens.includes("t-token"));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "pass1b-included") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO pass1b-included — card `5b40376c`. The SAME shape as `pass1b` above, but `nested` (X) IS
    // included in `registeredRepoPaths` — the exact shape the `pass1b` scenario deliberately dodges.
    // Pre-fix, PASS 1b's `matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(matchedRepo))` guard
    // recomputed X's DEGRADED walked-up key (= Kr, since X is unresolvable) and found it in
    // `cleanlyParsedKeys` (via T's own, wholly unrelated clean parse) — unlinking X's own tmp residue
    // OUTRIGHT, before the dual-arm/degraded-divert code ever got a chance to run. Not merely fail-closed
    // (the wrong attribution `pass1b` itself guards against) — fail-OPEN DATA LOSS: X's only durable copy
    // is gone, with no diverted pending entry left to recover it, not even across a restart.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("p1binc");
    const Kx = canonicalRepoLockKey(nested);
    const Kr = canonicalRepoLockKey(repo);
    const xTmpPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json.tmp-999-deadbeef`);
    const xFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kx).digest("hex").slice(0, 24)}.json`);
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kr).digest("hex").slice(0, 24)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(xTmpPath, JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise, torn-write tmp residue",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-p1binc-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    check("(precondition) X is genuinely unresolvable at this boot", !fs.existsSync(nested));
    check("(precondition) T is genuinely resolvable at this boot", fs.existsSync(subdir));

    reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // `nested` INCLUDED — the shape `pass1b` dodges

    check("*** THE FIX *** X's own tmp residue is NEVER unlinked — it survives on disk", fs.existsSync(xTmpPath));
    check("(boot) X is never promoted/written to its own final either — it stays PENDING only, no disk write at all", !fs.existsSync(xFinalPath));
    const activeR = activeMergeQuarantineFor(repo);
    check("(boot) R reads quarantined via T, the genuinely verified occupant", !!activeR && (activeR.tokens ?? []).includes("t-token"));
    check("(boot) X's unverified tmp-residue entry is NEVER unioned into T's verified entry", !!activeR && !(activeR.tokens ?? []).includes("x-token"));
    check("(boot) TWO separate listings at R's key — T's verified entry and X's diverted pending entry, each with only its own token", noListingCrossContamination({ listActiveMergeQuarantines }, Kr, [["t-token"], ["x-token"]]));
    check("(boot) T's final was actually written", fs.existsSync(rFinalPath));
    const rFinalContentAfterBoot1 = fs.readFileSync(rFinalPath, "utf8");

    // RESTART-SIM — X still parked/unmounted. Durability check: the loss (if the fix regressed) would be
    // permanent, not an in-memory artifact of one call; and T's own file must stay BYTE-IDENTICAL —
    // confirms X's diversion never feeds a write into T's own key (the open 97cff6db class).
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    check("(restart) X's tmp residue STILL survives — not lost across a restart either", fs.existsSync(xTmpPath));
    check("(restart) X is still never promoted/written to its own final", !fs.existsSync(xFinalPath));
    check("(restart) T's final file is BYTE-IDENTICAL to the first boot — no write fed by X's presence/divert", fs.readFileSync(rFinalPath, "utf8") === rFinalContentAfterBoot1);
    const activeTAfterRestart = fresh1.activeMergeQuarantineFor(subdir);
    check("(restart) T's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeTAfterRestart && (activeTAfterRestart.tokens ?? []).length === 1 && activeTAfterRestart.tokens.includes("t-token"));
    check("(restart) X's diverted pending entry is still reachable via R's own key, with only its own token", noListingCrossContamination({ listActiveMergeQuarantines: fresh1.listActiveMergeQuarantines }, Kr, [["t-token"], ["x-token"]]));

    fs.renameSync(parkedX, nested); // restore for cleanup
  } else if (scenarioName === "pass1b-included-convergence") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO pass1b-included-convergence — card `5b40376c`. SAME setup as `pass1b-included`, but after
    // two boots with X parked, X is REMOUNTED (genuinely resolvable again) before a third boot. Proves the
    // fix doesn't just "stop losing data" — the recovered tmp residue actually CONVERGES once resolvable:
    // X re-arms under its own TRUE key (Kx), its tmp residue is cleaned up (written to a proper final, then
    // unlinked) rather than accumulating forever, and T stays completely unaffected throughout.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("p1bconv");
    const Kx = canonicalRepoLockKey(nested);
    const Kr = canonicalRepoLockKey(repo);
    const xTmpPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json.tmp-999-deadbeef`);
    const xFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kx).digest("hex").slice(0, 24)}.json`);
    const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Kr).digest("hex").slice(0, 24)}.json`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(xTmpPath, JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise, torn-write tmp residue",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-p1bconv-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 1 — X unresolvable
    check("(boot 1) X's tmp residue survives", fs.existsSync(xTmpPath));
    const rFinalContentAfterBoot1 = fs.readFileSync(rFinalPath, "utf8");

    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 2 (restart-sim) — still unresolvable
    check("(boot 2) X's tmp residue still survives", fs.existsSync(xTmpPath));

    fs.renameSync(parkedX, nested); // REMOUNT X — genuinely resolvable from here on
    check("(precondition) X is genuinely resolvable again", fs.existsSync(nested));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([repo, nested, subdir]); // boot 3 (restart-sim) — X now resolvable

    check("*** CONVERGENCE *** X's tmp residue is CLEANED UP once resolvable again (not left accumulating)", !fs.existsSync(xTmpPath));
    check("*** CONVERGENCE *** X is promoted to a proper final under its OWN true key", fs.existsSync(xFinalPath));
    const activeXAfterConvergence = fresh2.activeMergeQuarantineFor(nested);
    check("*** CONVERGENCE *** X's own quarantine is reachable again, with only its own token", !!activeXAfterConvergence && (activeXAfterConvergence.tokens ?? []).includes("x-token"));
    const activeRAfterConvergence = fresh2.activeMergeQuarantineFor(repo);
    check("*** CONVERGENCE *** R's own key now reads ONLY via T — X resolves to its own key and no longer collides", !!activeRAfterConvergence && (activeRAfterConvergence.tokens ?? []).includes("t-token") && !(activeRAfterConvergence.tokens ?? []).includes("x-token"));
    check("*** CONVERGENCE *** T's own final file is still BYTE-IDENTICAL throughout — never touched by X's convergence", fs.readFileSync(rFinalPath, "utf8") === rFinalContentAfterBoot1);
  } else if (scenarioName === "pass1b-resolvable-stale-tmp-still-deleted") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO pass1b-resolvable-stale-tmp-still-deleted — card `5b40376c`'s NEGATIVE CONTROL. P is
    // genuinely resolvable throughout (no degraded key involved at all): a clean, non-placeholder final
    // already exists at P's own current key, plus a stale tmp residue left over at P's own LEGACY hash
    // (an ordinary interrupted-write leftover, nothing to do with any sibling collision). The new
    // `isRepoPathCurrentlyResolvable(matchedRepo)` check must NOT change this ordinary case — the early
    // guard's own original intent ("a proper final for THIS repo already loaded cleanly, this tmp really
    // is stale residue") still applies exactly as before, since P's own fresh key genuinely matches a key
    // that parsed cleanly in PASS 1 — never a degraded stand-in for some OTHER repo's key.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const p = path.join(os.tmpdir(), `loom-mqp1dug-p1brs-${freshSfx()}`);
    fs.mkdirSync(p, { recursive: true });
    tmpDirs.push(p);
    fs.writeFileSync(path.join(p, "README.md"), "# pass1b-resolvable-stale-tmp-still-deleted\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: p });
    commitAll(p, "init", GIT_ID);
    const Kp = canonicalRepoLockKey(p);
    const freshHashP = createHash("sha256").update(Kp).digest("hex").slice(0, 24);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPathP = path.join(MERGE_QUARANTINE_DIR, `${freshHashP}.json`);
    fs.writeFileSync(finalPathP, JSON.stringify({
      repoPath: p, branch: "p-branch", reason: "P's own clean, current, non-placeholder final",
      enteredAt: Date.now(), tokens: ["p-token"],
    }, null, 2) + "\n");
    // @decision 21ec39e5 — the stale tmp's own token must be one the current final ALREADY covers
    // ("p-token" — a genuinely superseded earlier attempt for this SAME raise); an invented, uncovered
    // token is no longer swept blind (see the decision record). This fixture now tests the shape it
    // always meant to.
    const staleTmpPath = path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(p)}.json.tmp-999-feedface`);
    fs.writeFileSync(staleTmpPath, JSON.stringify({
      repoPath: p, branch: "p-branch-stale", reason: "an earlier, now-superseded interrupted write",
      enteredAt: Date.now() - 120_000, tokens: ["p-token"],
    }, null, 2) + "\n");
    check("(precondition) P is genuinely resolvable", fs.existsSync(p));
    check("(precondition) the stale tmp exists before boot", fs.existsSync(staleTmpPath));

    // @decision 21ec39e5 (round 2, MAJOR) — a subset-token fixture alone cannot tell "took the cheap
    // early-exit delete" apart from "fell into the union/deferred-write pipeline and still ended up
    // deleting it afterward" — both leave P with exactly 1 token and no surviving tmp. Capture the
    // final's own bytes + mtime BEFORE boot so this scenario can assert WHICH path ran: the early exit
    // never rewrites `final` at all (byte- and mtime-identical); the union pipeline always rewrites it
    // (a fresh `fs.writeSync`+`renameSync`), even when the rewritten content happens to be equivalent.
    const finalBytesBeforeBoot = fs.readFileSync(finalPathP);
    const finalMtimeBeforeBoot = fs.statSync(finalPathP).mtimeMs;

    reenterMergeQuarantinesAtBoot([p]); // THE CALL UNDER TEST

    check("*** NEGATIVE CONTROL *** P's genuinely stale tmp residue IS still deleted immediately, unaffected by the resolvability gate", !fs.existsSync(staleTmpPath));
    check("*** THE DISCRIMINATOR *** the early-exit's own CHEAP delete path ran — final is byte- AND mtime-IDENTICAL (never rewritten by the union pipeline)",
      fs.existsSync(finalPathP) && fs.readFileSync(finalPathP).equals(finalBytesBeforeBoot) && fs.statSync(finalPathP).mtimeMs === finalMtimeBeforeBoot);
    const activeP = activeMergeQuarantineFor(p);
    check("(boot) P's real quarantine is untouched by the (correctly-deleted) stale tmp", !!activeP && (activeP.tokens ?? []).length === 1 && activeP.tokens.includes("p-token"));
  } else if (scenarioName === "residual") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO residual — the two manager-mandated properties for the accepted "diverted pending copy
    // goes inert" tradeoff (54054c01 precedent): (1) clearing X also sweeps its diverted pending copy via
    // clearMergeQuarantineByKey's directPathIdentity sweep — nothing left to resurrect R's signal; (2) a
    // LATER direct query for X's own identity, once X remounts WITHOUT ever being cleared, still returns
    // X's own quarantine, correctly re-keyed at Kx. No T/sibling involved here — isolates the pending-divert
    // mechanism itself from the cross-tier-union fix it supports.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("res");
    const Kx = canonicalRepoLockKey(nested);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise", enteredAt: Date.now() - 60_000,
      tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-res-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested]);

    const activeRBefore = activeMergeQuarantineFor(repo);
    check("(precondition) R reads quarantined via X's diverted pending entry (the new 4th tier)", !!activeRBefore && (activeRBefore.tokens ?? []).includes("x-token"));

    // Property 2 FIRST (before any clear): X remounts, never cleared — a direct query for X's own
    // identity must still find its own quarantine, genuinely re-keyed at Kx.
    fs.renameSync(parkedX, nested);
    const activeXAfterRemount = activeMergeQuarantineFor(nested);
    check("*** RESIDUAL PROPERTY 2 *** after X remounts (never cleared), querying X directly returns its own quarantine", !!activeXAfterRemount && (activeXAfterRemount.tokens ?? []).includes("x-token"));
    check("*** RESIDUAL PROPERTY 2 *** the returned entry is genuinely re-keyed at Kx now", !!activeXAfterRemount && canonicalRepoLockKey(activeXAfterRemount.repoPath) === Kx);

    // Property 1: clearing X (now resolvable, armed directly at Kx) sweeps every trace, including any
    // diverted-pending residue — nothing left to resurrect R's signal afterward.
    clearMergeQuarantineByKey(Kx, nested);
    const activeRAfterClear = activeMergeQuarantineFor(repo);
    check("*** RESIDUAL PROPERTY 1 *** clearing X by Kx leaves NOTHING behind — R no longer reads quarantined via X", activeRAfterClear === undefined);
    check("*** RESIDUAL PROPERTY 1 *** X itself also reads clear after its own clear", activeMergeQuarantineFor(nested) === undefined);
  } else if (scenarioName === "negative-control-cross-key") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // NEGATIVE CONTROL — two WHOLLY unrelated repos (genuinely different canonical keys): repo A has the
    // exact degraded-union shape (X armed via the diverted pending path at R_A's key); repo B is a totally
    // separate, ordinary raise with no relationship to A at all. Proves the fix's key-scoping never
    // widens into a cross-REPO leak — A's degraded signal must never appear for B, and B's own ordinary
    // quarantine must never absorb or be absorbed by anything from A.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo: repoA, nested: nestedA } = makeRepoWithNestedRepoAndSubdir("ncA");
    const repoB = path.join(os.tmpdir(), `loom-mqp1dug-repo-ncB-${freshSfx()}`);
    fs.mkdirSync(repoB, { recursive: true });
    tmpDirs.push(repoB);
    fs.writeFileSync(path.join(repoB, "README.md"), "# unrelated repo B\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: repoB });
    commitAll(repoB, "init", GIT_ID);

    const KxA = canonicalRepoLockKey(nestedA);
    const KrA = canonicalRepoLockKey(repoA);
    const KrB = canonicalRepoLockKey(repoB);
    check("(precondition) A and B have genuinely different canonical keys", KrA !== KrB);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nestedA)}.json`), JSON.stringify({
      repoPath: nestedA, branch: "xa-branch", reason: "A's own degraded entry", enteredAt: Date.now() - 60_000,
      tokens: ["xa-token"], resolvedKey: KxA,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(repoB)}.json`), JSON.stringify({
      repoPath: repoB, branch: "b-branch", reason: "B's own wholly unrelated raise", enteredAt: Date.now(),
      tokens: ["b-token"],
    }, null, 2) + "\n");

    const parkedXA = path.join(os.tmpdir(), `loom-mqp1dug-parked-ncA-${freshSfx()}`);
    fs.renameSync(nestedA, parkedXA);
    reenterMergeQuarantinesAtBoot([repoA, nestedA, repoB]);

    const activeB = activeMergeQuarantineFor(repoB);
    check("(negative control) B reads quarantined with ONLY its own token", !!activeB && (activeB.tokens ?? []).length === 1 && activeB.tokens.includes("b-token"));
    const activeA = activeMergeQuarantineFor(repoA);
    check("(negative control) A reads quarantined with ONLY its own (degraded) token", !!activeA && (activeA.tokens ?? []).length === 1 && activeA.tokens.includes("xa-token"));

    clearMergeQuarantineByKey(KxA, nestedA);
    const activeBAfterAClear = activeMergeQuarantineFor(repoB);
    check("(negative control) clearing A leaves B completely untouched", !!activeBAfterAClear && (activeBAfterAClear.tokens ?? []).length === 1 && activeBAfterAClear.tokens.includes("b-token"));

    fs.renameSync(parkedXA, nestedA);
  } else if (scenarioName === "direct-verified-guard") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO direct-verified-guard — restores the ONLY coverage (per Code Review, round 2, finding 3)
    // of 8a1bc2ef's own `isKeyVerifiedFor` guard at activeMergeQuarantineFor's `direct` fast path, which
    // this card's fix (never arming a degraded entry directly at a walked-up key) made unreachable via
    // scenario 6's own original construction. Reconstructed via a DIFFERENT route this card's fix does
    // NOT close: X's own repoPath NEVER exists at all (no ancestor to walk up to), but its recorded
    // `resolvedKey` is a deliberately-manufactured COLLISION with Y's own real, genuinely-resolvable key
    // Ky — PASS 1's divert still arms X there (trusting resolvedKey per 7673d096, unconditionally; this
    // card never gated THAT arm). X is thus UNVERIFIED-OCCUPYING Ky (isRepoPathCurrentlyResolvable(X) is
    // permanently false). T2 = Y's own plain subdir (no own .git) starts unresolvable at boot (so PASS 1
    // defers it to pending, no resolvedKey — the ordinary shape) and becomes resolvable AFTER boot.
    // Querying Y (or T2) must find X's entry via the `direct` fast path and, because X fails
    // isKeyVerifiedFor, must NEVER absorb T2's pending entry into it.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1dug-y-${freshSfx()}`);
    const t2 = path.join(y, "teamX");
    fs.mkdirSync(t2, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# direct-verified-guard\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1dug-x-never-exists-${freshSfx()}`); // deliberately never created
    check("(precondition) X never exists at all", !fs.existsSync(x));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // X's own degraded key never resolves to anything useful (no ancestor .git anywhere under os.tmpdir());
    // its resolvedKey is deliberately set to Y's OWN real key — a manufactured collision — so PASS 1's
    // trusted resolvedKey arm (never gated on verification — see this card's own decision record) plants
    // an UNVERIFIED occupant directly at ky, exactly the shape 8a1bc2ef's `direct`-fast-path guard exists for.
    // X never exists, so there is no realpath to hash (oldHashFor would throw) — any filename ending in
    // `.json` works, since PASS 1 reads every such file regardless of its own name, by content alone.
    const xHash = createHash("sha256").update(x).digest("hex").slice(0, 24);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${xHash}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    // T2's own pending latch, pre-upgrade shape (no resolvedKey) — ordinary, while T2 is parked away.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(t2)}.json`), JSON.stringify({
      repoPath: t2, branch: "t2-branch", reason: "T2's own genuinely separate, still-pending raise",
      enteredAt: Date.now(), tokens: ["t2-token"],
    }, null, 2) + "\n");

    const parkedT2 = path.join(os.tmpdir(), `loom-mqp1dug-parked-dvg-${freshSfx()}`);
    fs.renameSync(t2, parkedT2);
    check("(precondition) T2 is genuinely unresolvable at this boot", !fs.existsSync(t2));

    reenterMergeQuarantinesAtBoot([y, x, t2]);

    const activeYBeforeT2Resolves = activeMergeQuarantineFor(y);
    check("(boot) Y reads quarantined via X's unverified, Ky-colliding entry", !!activeYBeforeT2Resolves && (activeYBeforeT2Resolves.tokens ?? []).includes("x-token"));

    fs.renameSync(parkedT2, t2); // T2 now resolves — the exact ordering the guard's own repro needs
    check("(precondition) T2 now resolves on disk", fs.existsSync(t2));

    const activeY = activeMergeQuarantineFor(y); // THE QUERY THE isKeyVerifiedFor GUARD PROTECTS
    check("(query) Y still reads quarantined via X's entry", !!activeY && (activeY.tokens ?? []).includes("x-token"));
    check("*** THE GUARD *** T2's own token is NEVER absorbed into X's unverified entry", !(activeY?.tokens ?? []).includes("t2-token"));
    const t2EntryAfterQuery = listActiveMergeQuarantines().find((q) => q.repoPath === t2);
    check("*** THE GUARD *** T2's own pending record SURVIVES, independent of X's entry", !!t2EntryAfterQuery && (t2EntryAfterQuery.tokens ?? []).length === 1 && t2EntryAfterQuery.tokens.includes("t2-token"));

    // Querying T2 directly computes the SAME key (ky, since T2 is Y's own plain subdir) and so ALSO hits
    // the `direct` fast path first — same as Y's own query, same guard, same result (X's entry, unmerged).
    // This is expected: `direct` always wins over the identity tiers once anything occupies the key at
    // all; T2's own pending entry stays independently findable only by ITS OWN identity (confirmed above).
    const activeT2 = activeMergeQuarantineFor(t2);
    check("(query via T2) T2's query ALSO hits X's unverified entry (same key) — never t2-token", !!activeT2 && (activeT2.tokens ?? []).includes("x-token") && !(activeT2.tokens ?? []).includes("t2-token"));
  } else if (scenarioName === "clear-x-unmounted") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO clear-x-unmounted — Code Review round 2, finding 1. The project-resolved `/clear` route
    // calls `clearMergeQuarantineReporting(repo.path)` -> `clearMergeQuarantine(repoPath)`, which used to
    // address a FRESHLY-recomputed `canonicalRepoLockKey(repoPath)` UNCONDITIONALLY — for X while
    // unmounted, that recompute walks UP to R's own real key Kr, so clearing X actually lifted T (a
    // genuinely separate, verified occupant of Kr) instead of X's own entry. RED on the parent commit
    // (5a3c9326); GREEN now that `clearMergeQuarantine` resolves by STORED IDENTITY instead, when the
    // target path is not currently resolvable.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("cxu");
    const Kx = canonicalRepoLockKey(nested);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise", enteredAt: Date.now() - 60_000,
      tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-cxu-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    check("(precondition) X is genuinely unresolvable", !fs.existsSync(nested));
    check("(precondition) T is quarantined, genuinely verified", !!activeMergeQuarantineFor(subdir) && (activeMergeQuarantineFor(subdir).tokens ?? []).includes("t-token"));

    // THE CLEAR UNDER TEST — addresses X by its OWN repoPath, exactly like the project-resolved /clear
    // route does once it has resolved X's own project to X's own repoPath.
    clearMergeQuarantine(nested);

    const activeTAfterClear = activeMergeQuarantineFor(subdir);
    check("*** THE FIX *** T's genuine quarantine SURVIVES clearing X, with ONLY its own token", !!activeTAfterClear && (activeTAfterClear.tokens ?? []).length === 1 && activeTAfterClear.tokens.includes("t-token"));
    check("*** THE FIX *** X's OWN entry is genuinely gone (lifted by identity, not T's)", !listActiveMergeQuarantines().some((q) => (q.tokens ?? []).includes("x-token")));

    // RESTART — T must survive DURABLY, not just in-process.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    const activeTAfterRestart = fresh.activeMergeQuarantineFor(subdir);
    check("(restart) T's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeTAfterRestart && (activeTAfterRestart.tokens ?? []).length === 1 && activeTAfterRestart.tokens.includes("t-token"));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "clear-r-truthful-reporting") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO clear-r-truthful-reporting — Code Review round 2, finding 2 (abccee85 round-6 Finding 1
    // again, reopened by this card's own diversion). T is ABSENT here (X alone diverted) — clearing R
    // (which IS resolvable, so `clearMergeQuarantine` addresses R's own key unchanged) finds NOTHING at
    // Kr (X diverted elsewhere) and lifts NOTHING — `clearMergeQuarantineReporting` must report this
    // truthfully (R stays blocked; the real blocker is named) rather than a bare wasQuarantined:true that
    // falsely implies success.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested } = makeRepoWithNestedRepoAndSubdir("crtr");
    const Kx = canonicalRepoLockKey(nested);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise", enteredAt: Date.now() - 60_000,
      tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-crtr-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested]);
    check("(precondition) R reads quarantined via X's diverted entry", !!activeMergeQuarantineFor(repo) && (activeMergeQuarantineFor(repo).tokens ?? []).includes("x-token"));

    const result = clearMergeQuarantineReporting(repo); // THE CALL UNDER TEST — simulates /clear on R
    check("*** THE FIX *** wasQuarantined is truthfully true — R genuinely WAS (and still is) quarantined", result.wasQuarantined === true);
    check("*** THE FIX *** a reason is given, since nothing was actually lifted", typeof result.reason === "string" && result.reason.length > 0);
    check("*** THE FIX *** the reason names X's own repoPath, the TRUE blocker", result.reason.includes(nested));
    check("*** THE FIX *** the reason points at /clear-by-path", result.reason.includes("clear-by-path"));

    const activeRAfter = activeMergeQuarantineFor(repo);
    check("*** THE FIX *** R is STILL quarantined — the clear never lifted X's entry", !!activeRAfter && (activeRAfter.tokens ?? []).includes("x-token"));

    // Confirm clear-by-path (identity-addressed) is what actually works, as the reason's own pointer says.
    clearMergeQuarantineByKey(Kx, nested);
    check("(cleanup) clearing X directly by its own key actually lifts it", !activeMergeQuarantineFor(repo));

    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "stale-armedkeys-no-collateral") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO stale-armedkeys-no-collateral — Code Review round 3, finding 1 (extended round 4,
    // CRITICAL: the durable half). Y is a real, resolvable repo; X never exists at all, its recorded
    // resolvedKey deliberately colliding with Y's own real key Ky, and — REALISTIC naming, round 4 —
    // X's own latch file is named hash(Ky).json, exactly as a genuine prior migrate/raise under that key
    // would have written it (never a synthetic filename of its own). PASS 1 diverts X: armed ONLY at Ky,
    // AND pushed into pendingUnresolvedQuarantines with sourceFile=hash(Ky).json. /clear(Y) (Y
    // resolvable — clearMergeQuarantine addresses Ky directly, unchanged) correctly lifts X's ACTIVE
    // arm — but X's OWN pending copy survives untouched (its identity doesn't match Y's), now STALE: its
    // armedKeys still names Ky, which nothing occupies. Y then takes a FRESH, genuine raise at Ky,
    // durably writing ITS OWN latch at the EXACT SAME physical path (hash(Ky).json — the same filename
    // X's own stale sourceFile names). clear-by-path(X) — matching X's now-orphaned pending record by
    // identity — must NOT blindly delete Ky (in-memory) OR hash(Ky).json (on disk, now Y's OWN file)
    // just because X's STALE record still names both: a bare unlink of X's sourceFile would destroy Y's
    // brand-new, wholly unrelated quarantine's own durable record even with its in-memory state correctly
    // untouched — a SECOND reenterMergeQuarantinesAtBoot (restart) is what actually exposes that, since
    // Y's in-memory entry survives the FIRST process regardless of whether its file still exists.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1dug-y-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# stale-armedkeys-no-collateral\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const kyHash = quarantineLatchIdFor(y); // hash(Ky) — the REAL physical filename this key's latch lives at

    const x = path.join(os.tmpdir(), `loom-mqp1dug-x-never-exists-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xLatchPath = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`); // REALISTIC naming — see header
    fs.writeFileSync(xLatchPath, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(precondition) Y reads quarantined via X's unverified entry at Ky", !!activeMergeQuarantineFor(y) && (activeMergeQuarantineFor(y).tokens ?? []).includes("x-token"));

    clearMergeQuarantine(y); // simulates /clear(Y) — lifts X's ACTIVE arm (deleting kyHash.json, correctly
    // — X's own latch, at that moment), leaves X's pending copy stale (sourceFile still names kyHash.json)
    check("(after /clear(Y)) Y reads as clear", !activeMergeQuarantineFor(y));

    const tokY = enterMergeQuarantine(y, "y-branch", "Y's own fresh, genuine raise at Ky"); // reuses Ky
    const activeYFresh = activeMergeQuarantineFor(y);
    check("(precondition) Y's fresh raise is genuinely active, with ONLY its own token", !!activeYFresh && (activeYFresh.tokens ?? []).length === 1 && activeYFresh.tokens.includes(tokY));
    const yLatchPath = path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchFileIdsFor(activeYFresh)[0]}.json`);
    check("(precondition) Y's fresh latch file is the EXACT SAME physical path as X's own stale sourceFile", yLatchPath === xLatchPath);
    check("(precondition) Y's fresh latch file exists on disk", fs.existsSync(yLatchPath));

    clearMergeQuarantineByRecordedPath(x); // simulates clear-by-path(X) — X's now-stale pending record

    check("*** THE FIX *** Y's fresh quarantine SURVIVES in-process — X's stale armedKeys never touched it", !!activeMergeQuarantineFor(y) && (activeMergeQuarantineFor(y).tokens ?? []).includes(tokY));
    check("*** THE FIX (round 4, CRITICAL) *** Y's own latch file SURVIVES on disk too — never a bare unlink of X's stale sourceFile", fs.existsSync(yLatchPath));

    // RESTART — the durable proof: Y's in-memory entry alone would survive regardless; only a fresh boot
    // reveals whether Y's own latch FILE actually survived clear-by-path(X)'s sourceFile handling.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, x]);
    const activeYAfterRestart = fresh.activeMergeQuarantineFor(y);
    check("*** THE FIX (round 4, CRITICAL) *** Y's quarantine SURVIVES a fresh boot, with ONLY its own token", !!activeYAfterRestart && (activeYAfterRestart.tokens ?? []).length === 1 && activeYAfterRestart.tokens.includes(tokY));

    clearMergeQuarantine(y); // cleanup
  } else if (scenarioName === "clear-unmasks-different-blocker") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO clear-unmasks-different-blocker — Code Review round 3, finding 2(a). Full pass1 shape: T
    // (genuinely verified, direct) masks X (diverted, tier 4) at R's own key. /clear(R) genuinely LIFTS
    // T's own entry — but R is STILL quarantined afterward, now via X, which the pre-clear snapshot
    // never named. clearMergeQuarantineReporting must detect this by RE-RESOLVING after the clear, not
    // by whether the pre-clear object (T) still exists (it doesn't — the old check would have wrongly
    // reported a clean, reason-less success).
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, nested, subdir } = makeRepoWithNestedRepoAndSubdir("cudb");
    const Kx = canonicalRepoLockKey(nested);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(nested)}.json`), JSON.stringify({
      repoPath: nested, branch: "x-branch", reason: "X's own prior raise", enteredAt: Date.now() - 60_000,
      tokens: ["x-token"], resolvedKey: Kx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(subdir)}.json`), JSON.stringify({
      repoPath: subdir, branch: "t-branch", reason: "T's own genuinely separate, still-active raise",
      enteredAt: Date.now(), tokens: ["t-token"],
    }, null, 2) + "\n");

    const parkedX = path.join(os.tmpdir(), `loom-mqp1dug-parked-cudb-${freshSfx()}`);
    fs.renameSync(nested, parkedX);
    reenterMergeQuarantinesAtBoot([repo, nested, subdir]);
    check("(precondition) R reads quarantined via T, the direct occupant", !!activeMergeQuarantineFor(repo) && (activeMergeQuarantineFor(repo).tokens ?? []).includes("t-token"));

    const result = clearMergeQuarantineReporting(repo); // THE CALL UNDER TEST
    check("*** THE FIX *** T's own quarantine was genuinely lifted", !listActiveMergeQuarantines().some((q) => (q.tokens ?? []).includes("t-token")));
    check("*** THE FIX *** wasQuarantined is true — R is STILL quarantined (now by X)", result.wasQuarantined === true);
    check("*** THE FIX *** a reason is given, naming X — NOT a bare reason-less success", typeof result.reason === "string" && result.reason.includes(nested));

    const activeRAfter = activeMergeQuarantineFor(repo);
    check("*** THE FIX *** R reads quarantined via X now", !!activeRAfter && (activeRAfter.tokens ?? []).includes("x-token"));

    clearMergeQuarantineByKey(Kx, nested);
    fs.renameSync(parkedX, nested);
  } else if (scenarioName === "clear-stale-pending-not-blocking") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO clear-stale-pending-not-blocking — Code Review round 3, finding 2(b). Same Y/X
    // manufactured-collision setup as `stale-armedkeys-no-collateral`. A SINGLE /clear(Y) call correctly
    // lifts X's ACTIVE arm at Ky — X's own pending copy survives (identity mismatch), but it is HARMLESS:
    // the 4th activeMergeQuarantineFor tier never matches it for a query on Y, since it recomputes BY
    // KEY, and X's own fresh canonicalRepoLockKey recompute is its own degenerate value, never Ky. The
    // OLD object-identity check would have wrongly reported "still quarantined by X" purely because X's
    // entry OBJECT is technically still reachable (in pendingUnresolvedQuarantines) — even though Y is
    // genuinely, fully clear.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const y = path.join(os.tmpdir(), `loom-mqp1dug-y2-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), "# clear-stale-pending-not-blocking\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);

    const x = path.join(os.tmpdir(), `loom-mqp1dug-x2-never-exists-${freshSfx()}`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xHash = createHash("sha256").update(x).digest("hex").slice(0, 24);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${xHash}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
      enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([y, x]);
    check("(precondition) Y reads quarantined via X's unverified entry at Ky", !!activeMergeQuarantineFor(y) && (activeMergeQuarantineFor(y).tokens ?? []).includes("x-token"));

    const result = clearMergeQuarantineReporting(y); // THE CALL UNDER TEST — a SINGLE /clear(Y)
    check("*** THE FIX *** wasQuarantined is true — Y genuinely WAS quarantined", result.wasQuarantined === true);
    check("*** THE FIX *** NO reason — Y is genuinely, fully clear now, despite X's stale pending remnant", result.reason === undefined);
    check("*** THE FIX *** Y reads as clear", !activeMergeQuarantineFor(y));
  } else if (scenarioName === "token-clear-identity-drift") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO token-clear-identity-drift — Code Review round 3, finding 3. subdirT and subdirX are both
    // plain subdirs of repo, collapsing onto repo's own key Kr. T raises FIRST (founding identity,
    // repoPath=subdirT); X raises SECOND — enterMergeQuarantine's `existing` branch appends X's token
    // into T's OWN entry, keeping T's identity (the "longest-outstanding raise wins" rule). Clearing T's
    // OWN token first (in-place update, remaining=[tokX]) leaves the SHARED entry armed at Kr with
    // repoPath=subdirT still, holding only X's token now. BOTH subdirT and subdirX are then removed
    // (leaving repo itself intact, so Kr still resolves via repo's own .git).
    // clearMergeQuarantineByToken(subdirX, tokX) must still durably clear the entry — not silently no-op
    // because clearMergeQuarantine(subdirX) (repoPath-addressed, now identity-resolving since subdirX is
    // unresolvable) can't find a match against the entry's OWN (T's) identity.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqp1dug-tcid-repo-${freshSfx()}`);
    const subdirT = path.join(repo, "subdirT");
    const subdirX = path.join(repo, "subdirX");
    fs.mkdirSync(subdirT, { recursive: true });
    fs.mkdirSync(subdirX, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# token-clear-identity-drift\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(repo);
    check("(precondition) subdirT and subdirX share one canonical key", canonicalRepoLockKey(subdirT) === Kr && canonicalRepoLockKey(subdirX) === Kr);

    const tokT = enterMergeQuarantine(subdirT, "t-branch", "T's own founding raise");
    const tokX = enterMergeQuarantine(subdirX, "x-branch", "X's own raise — absorbed into T's entry");
    const activeAfterBothRaises = activeMergeQuarantineFor(repo);
    check("(precondition) both tokens share ONE entry, under T's own identity", !!activeAfterBothRaises && activeAfterBothRaises.repoPath === subdirT && (activeAfterBothRaises.tokens ?? []).includes(tokT) && (activeAfterBothRaises.tokens ?? []).includes(tokX));

    clearMergeQuarantineByToken(subdirT, tokT); // clears T's OWN token first — in-place update, entry survives
    const activeAfterTClear = activeMergeQuarantineFor(repo);
    check("(precondition) only X's token remains, entry STILL under T's own identity", !!activeAfterTClear && activeAfterTClear.repoPath === subdirT && (activeAfterTClear.tokens ?? []).length === 1 && activeAfterTClear.tokens.includes(tokX));

    fs.rmSync(subdirT, { recursive: true, force: true });
    fs.rmSync(subdirX, { recursive: true, force: true });
    check("(precondition) both subdirs are gone; repo itself still resolves", !fs.existsSync(subdirT) && !fs.existsSync(subdirX) && fs.existsSync(repo));

    clearMergeQuarantineByToken(subdirX, tokX); // THE CALL UNDER TEST
    check("*** THE FIX *** the shared entry is genuinely, durably cleared", !activeMergeQuarantineFor(repo));
    check("*** THE FIX *** no entry anywhere still carries tokX (not left dangling)", !listActiveMergeQuarantines().some((q) => (q.tokens ?? []).includes(tokX)));
  } else if (scenarioName === "deferred-flush-no-stale-snapshot") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO deferred-flush-no-stale-snapshot — card `d163aef5`, round 3 retires the mechanism this
    // scenario originally discriminated (round 2's own "re-read byRepoKey at flush time" deferral) in
    // favor of capturing each divert's own entry snapshot AT DIVERT TIME — but the SAME invariant this
    // scenario has always asserted (exactly one, fully-unioned listing) still holds: `armKeyUnlessDegradedCollision`
    // now rebinds any `degradedDivertsToFlush` record still naming a PRE-union object onto the fresh
    // merged result whenever a real union happens (see its own doc), so X1's divert record (pushed
    // first, before X2 ever unions into it) gets rebound the moment X2 arrives — never left pointing at
    // a stale, pre-union snapshot. X1 and X2 are BOTH unresolvable, BOTH with resolvedKey manufactured to
    // the SAME colliding value — a legitimate same-pass union at that key.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const kxx = `/synthetic/deferred-flush-collision-${freshSfx()}`;
    const x1 = path.join(os.tmpdir(), `loom-mqp1dug-dfns-x1-${freshSfx()}`);
    const x2 = path.join(os.tmpdir(), `loom-mqp1dug-dfns-x2-${freshSfx()}`);
    check("(precondition) X1 and X2 never exist", !fs.existsSync(x1) && !fs.existsSync(x2));
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const x1Hash = createHash("sha256").update(x1).digest("hex").slice(0, 24);
    const x2Hash = createHash("sha256").update(x2).digest("hex").slice(0, 24);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${x1Hash}.json`), JSON.stringify({
      repoPath: x1, branch: "x1-branch", reason: "X1's own manufactured collision", enteredAt: Date.now() - 60_000,
      tokens: ["x1-token"], resolvedKey: kxx,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${x2Hash}.json`), JSON.stringify({
      repoPath: x2, branch: "x2-branch", reason: "X2's own manufactured collision", enteredAt: Date.now() - 30_000,
      tokens: ["x2-token"], resolvedKey: kxx,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([x1, x2]);

    const matching = listActiveMergeQuarantines().filter((q) => (q.tokens ?? []).includes("x1-token") || (q.tokens ?? []).includes("x2-token"));
    check("*** THE FIX *** exactly ONE consistent listing for the colliding key — never a stale duplicate", matching.length === 1);
    check("*** THE FIX *** that ONE listing carries BOTH tokens (the genuine same-pass union)", matching.length === 1 && (matching[0].tokens ?? []).includes("x1-token") && (matching[0].tokens ?? []).includes("x2-token"));
  } else if (scenarioName === "dualarm-sibling-key-contamination" || scenarioName === "dualarm-sibling-key-contamination-d-first") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO dualarm-sibling-key-contamination[-d-first] — card `d163aef5`'s re-scoped, still-open
    // angle: `armQuarantineKey`'s `armedKeys` propagation could carry a DEGRADED constituent onto a key
    // that is NOT in `degradedOccupiedKeys`, clobbering the in-memory (and, on a later query, the
    // ON-DISK) entry for an ENCLOSING/sibling key that is otherwise fully verified and resolvable —
    // falsifying `4480b077`'s "unionEntry guaranteed resolvable" claim.
    //
    // Z is a real, resolvable repo. Z's own `.json` final is correctly named at hash(K1) (K1 = Z's TRUE,
    // current canonical key) — but the FILE's own persisted `resolvedKey` field is K2, a STALE value that
    // no longer equals K1 (models a second key Z was dual-armed under at some earlier point and never got
    // overwritten back to K1 — PASS 1's fallthrough dual-arm does not require resolvedKey to equal
    // currentKey; it only skips the SECOND arm when they're already equal). D never exists on disk at
    // all (permanently unresolvable); D's own recorded resolvedKey is manufactured to COLLIDE with Z's
    // own stale K2 — exactly PASS 1's trusted-resolvedKey divert (`883e29bc`/`7673d096`) reaching a key
    // that ALREADY, independently, holds Z's verified entry (via Z's own dual-arm at K1+K2).
    //
    // THE BUG (pre-fix): `armQuarantineKey(byRepoKey, K2, D)` unioned Z's entry (occupying K2 via its own
    // dual-arm) with D — then spread the RESULT to EVERY key in the union's own `armedKeys`, including K1
    // (inherited from Z's PRIOR dual-arm, nothing to do with D at all). K1 was never added to
    // `degradedOccupiedKeys` (only K2, D's own resolvedKey, was) — so Z's own entry at K1 was silently
    // overwritten with a union carrying D's token, and a later query for Z durably wrote the contaminated
    // union to Z's own, genuinely-verified latch file on disk.
    //
    // THE FIX: `armKeyUnlessDegradedCollision` declines the union in EITHER direction — see its own doc
    // comment. The base scenario forces D's filename to sort strictly AFTER Z's (so Z is armed first,
    // exercising the degraded-divert call site's own guard deciding against an ALREADY-present verified
    // occupant); the `-d-first` variant forces the OPPOSITE order (D arms at K2 standalone BEFORE Z is
    // ever processed), exercising the OTHER call site (Z's own normal dual-arm fallthrough
    // declining-and-evicting an already-degraded occupant). Both orders are forced DETERMINISTICALLY
    // (Code Review, SHOULD-FIX 4) — leaving this to filename-hash luck would make one of the two decline
    // branches above pass only by coincidence, exactly as happened for `82032b5c`'s own fixture.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const dFirst = scenarioName === "dualarm-sibling-key-contamination-d-first";
    const tag = dFirst ? "dsc-df" : "dsc";
    const z = path.join(os.tmpdir(), `loom-mqp1dug-${tag}-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), `# ${scenarioName}\n`);
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const K1 = canonicalRepoLockKey(z);
    const K2 = `/synthetic/${tag}-stale-second-key-${freshSfx()}`; // arbitrary, never a real resolvable key
    const K1hash = createHash("sha256").update(K1).digest("hex").slice(0, 24);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const zLatchPath = path.join(MERGE_QUARANTINE_DIR, `${K1hash}.json`);
    fs.writeFileSync(zLatchPath, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, currently-active raise",
      enteredAt: Date.now() - 60_000, tokens: ["z-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    const d = path.join(os.tmpdir(), `loom-mqp1dug-${tag}-d-never-exists-${freshSfx()}`);
    check("(precondition) D never exists at all", !fs.existsSync(d));
    // d-first: force D's filename to sort strictly BEFORE K1hash. Not-d-first (z-first): force it to
    // sort strictly AFTER — "f" repeated sorts after any lowercase-hex digest of the same length.
    const dFilename = dFirst ? "000000000000000000000000.json" : "ffffffffffffffffffffffff.json";
    if (dFirst) check("(precondition) D's forced filename sorts before Z's real hash filename", dFilename < `${K1hash}.json`);
    else check("(precondition) D's forced filename sorts after Z's real hash filename", dFilename > `${K1hash}.json`);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, dFilename), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own manufactured resolvedKey collision with Z's own stale K2",
      enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z, d]); // THE SINGLE BOOT CALL UNDER TEST

    const activeZAfterBoot = activeMergeQuarantineFor(z);
    check("(sanity) Z's own token survives regardless", !!activeZAfterBoot && (activeZAfterBoot.tokens ?? []).includes("z-token"));
    check("*** THE FIX (card d163aef5) *** Z's own entry, at its OWN verified key K1, is NEVER unioned with D's degraded token", !!activeZAfterBoot && !(activeZAfterBoot.tokens ?? []).includes("d-token"));
    check("*** THE FIX (card d163aef5) *** Z's own reason is untouched by D's own, unrelated reason text", activeZAfterBoot?.reason === "Z's own genuine, currently-active raise");

    const onDiskAfterBoot = JSON.parse(fs.readFileSync(zLatchPath, "utf8"));
    check("*** THE FIX (card d163aef5) *** Z's own ON-DISK latch file is never durably contaminated with D's token either", !(onDiskAfterBoot.tokens ?? []).includes("d-token"));

    // Code Review, SHOULD-FIX 3 — also assert through the PRODUCTION path (assertRepoNotQuarantined ->
    // resolveQuarantineFor -> activeMergeQuarantineFor), not only the internal function. For a
    // CURRENTLY-RESOLVABLE query like `z`, resolveQuarantineFor's own `ownIdentityEntryFor` short-circuit
    // never fires (that's gated on the query being unresolvable) — so this exercises the SAME
    // activeMergeQuarantineFor code path already asserted above, just through its real caller.
    const assertZAfterBoot = assertRepoNotQuarantined(z);
    check("(production path) assertRepoNotQuarantined(z) is blocked by Z's OWN reason, never D's", assertZAfterBoot.ok === false && assertZAfterBoot.reason.includes("Z's own genuine, currently-active raise") && !assertZAfterBoot.reason.includes("d-branch"));

    // Requirement 1 — D must stay FAIL-CLOSED: querying D directly must still report it quarantined
    // (via the existing 883e29bc 4th pending tier — D's own degenerate key, recomputed fresh from D's
    // own unresolvable repoPath, never from the manufactured K2 collision).
    const activeDAfterBoot = activeMergeQuarantineFor(d);
    check("(requirement 1) D itself is STILL reported quarantined, with ONLY its own token", !!activeDAfterBoot && (activeDAfterBoot.tokens ?? []).length === 1 && activeDAfterBoot.tokens.includes("d-token"));
    // Code Review, SHOULD-FIX 3 — same production-path assertion for D. D is UNRESOLVABLE, so this DOES
    // route through `resolveQuarantineFor`'s `ownIdentityEntryFor` short-circuit first — but that
    // branch's own result still has to come from the SAME in-memory state this fix protects.
    check("(production path) assertRepoNotQuarantined(d) is ALSO still blocked", assertRepoNotQuarantined(d).ok === false);

    // Requirement 2 — D must never be re-absorbed into Z LATER through consumeMatchedPendingsIntoArmedEntry
    // / cross-tier-sibling absorption. That path matches via `isRepoPathCurrentlyResolvable(p.entry.repoPath)
    // && canonicalRepoLockKey(p.entry.repoPath) === key` (genuine identity, never a stale resolvedKey) —
    // D's own repoPath is permanently unresolvable, so this predicate can never match it for K1. Querying
    // Z SEVERAL more times must stay clean (not just the first query, in case absorption were order- or
    // count-sensitive).
    for (let i = 0; i < 3; i++) {
      const repeat = activeMergeQuarantineFor(z);
      check(`(requirement 2, query ${i + 1}) repeated queries for Z never absorb D`, !!repeat && !(repeat.tokens ?? []).includes("d-token"));
    }

    // RESTART — the durable proof for BOTH requirements across a reboot.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([z, d]);
    const activeZAfterRestart = fresh.activeMergeQuarantineFor(z);
    check("(restart) Z's quarantine SURVIVES a fresh boot, with ONLY its own token and its own reason", !!activeZAfterRestart && (activeZAfterRestart.tokens ?? []).length === 1 && activeZAfterRestart.tokens.includes("z-token") && activeZAfterRestart.reason === "Z's own genuine, currently-active raise");
    const activeDAfterRestart = fresh.activeMergeQuarantineFor(d);
    check("(requirement 1, restart) D is STILL reported quarantined after a reboot too, with ONLY its own token", !!activeDAfterRestart && (activeDAfterRestart.tokens ?? []).length === 1 && activeDAfterRestart.tokens.includes("d-token"));
    // Code Review, SHOULD-FIX 3 — production path, post-restart.
    const assertZAfterRestart = fresh.assertRepoNotQuarantined(z);
    check("(production path, restart) assertRepoNotQuarantined(z) is still blocked by Z's OWN reason only", assertZAfterRestart.ok === false && assertZAfterRestart.reason.includes("Z's own genuine, currently-active raise") && !assertZAfterRestart.reason.includes("d-branch"));
    check("(production path, restart) assertRepoNotQuarantined(d) is ALSO still blocked", fresh.assertRepoNotQuarantined(d).ok === false);
    const onDiskAfterRestart = JSON.parse(fs.readFileSync(zLatchPath, "utf8"));
    check("(restart) Z's own ON-DISK latch file is still never contaminated after a reboot", !(onDiskAfterRestart.tokens ?? []).includes("d-token"));
  } else if (scenarioName === "degraded-divert-rebind-survives-trim-eviction") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review of 7545166b, BLOCKING 1 (CRITICAL, reviewer-reproduced) — a regression THIS card's own
    // fix introduced. X and D are BOTH degraded (X self-consistently named at hash(K3), dual-arming
    // K3+K2; D a mismatched-name divert, resolvedKey=K2 too) — SAME resolvability, so they legitimately
    // UNION at K2 (883e29bc's own accepted "two degraded entries sharing a manufactured collision"
    // case, unaffected by this card). D's own degraded-divert processing pushes
    // `{resolvedKey:K2, sourceFile:D's file}` into `degradedDivertsToFlush`, NOT YET flushed.
    //
    // Z (real, resolvable) then arms its own SECOND key at K2 too, finds the X+D union there, and
    // (legitimately, since nothing registered backs K2) EVICTS it — trimming the union down to K3 (X's
    // own real key) via the TRIM branch, since the union's `armedKeys` is `[K3,K2]`.
    //
    // THE BUG: `flushDegradedDiverts` (called once, after this entire PASS 1 loop) re-reads
    // `byRepoKey.get(K2)` AT FLUSH TIME — by then K2 holds Z's own clean entry (the eviction's winner),
    // NOTHING to do with D. The pre-fix code pushed `{entry: Z, sourceFile: D's own file}` into
    // `pendingUnresolvedQuarantines` — a later verified query for Z then absorbed this as a "sibling"
    // and durably unlinked D's OWN latch file as a superseded duplicate, even though D's real data
    // (merged into X) was never written to disk anywhere. After a reboot, D's data is gone for good.
    //
    // THE FIX: the TRIM branch now re-binds any `degradedDivertsToFlush` record still targeting the
    // evicted key onto one of the union's OWN surviving keys (K3) — so the deferred flush correctly
    // finds the TRIMMED union (still carrying D's own token, merged with X's) there instead.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const z = path.join(os.tmpdir(), `loom-mqp1dug-b1-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# degraded-divert-rebind-survives-trim-eviction\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const K1 = canonicalRepoLockKey(z);
    const K1hash = createHash("sha256").update(K1).digest("hex").slice(0, 24);
    const K2 = `/synthetic/b1-shared-K2-${freshSfx()}`; // manufactured, shared by X, D, AND Z

    // X: nonexistent, self-consistently named at hash(canonical(X))=K3 — retried (free; X never touches
    // disk) until K3's own hash sorts strictly BEFORE Z's real hash, so X (and D, forced first below)
    // are both read and armed before Z ever is.
    let x, K3, K3hash;
    for (let attempt = 0; ; attempt++) {
      x = path.join(os.tmpdir(), `loom-mqp1dug-b1-x-never-exists-${freshSfx()}`);
      K3 = canonicalRepoLockKey(x);
      K3hash = createHash("sha256").update(K3).digest("hex").slice(0, 24);
      if (K3hash < K1hash) break;
      if (attempt > 200_000) throw new Error("could not force X before Z after 200,000 attempts");
    }
    check("(precondition) X's own hash sorts before Z's", K3hash < K1hash);

    const d = path.join(os.tmpdir(), `loom-mqp1dug-b1-d-never-exists-${freshSfx()}`);
    check("(precondition) D never exists at all", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const zFile = path.join(MERGE_QUARANTINE_DIR, `${K1hash}.json`);
    fs.writeFileSync(zFile, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, currently-active raise",
      enteredAt: Date.now() - 30_000, tokens: ["z-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${K3hash}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own prior raise", enteredAt: Date.now() - 60_000,
      tokens: ["x-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    // D's own filename is a forced-first sentinel (never a real hash) — guaranteed to sort before BOTH
    // X's and Z's own hash-named files, matching the Code Review's own "readdir order X, D, Z" shape
    // (the actual requirement is just "X and D both process before Z"; their own relative order is not
    // load-bearing — see 883e29bc's own order-independent same-tier union design).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "000000000000000000000000.json"), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own manufactured resolvedKey collision with X and Z's shared K2",
      enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z, x, d]); // THE SINGLE BOOT CALL UNDER TEST

    const activeZ = activeMergeQuarantineFor(z);
    check("(sanity) Z's own token survives, never contaminated", !!activeZ && (activeZ.tokens ?? []).length === 1 && activeZ.tokens.includes("z-token"));

    // THE FIX — querying X (the identity that WON the X+D union by age) must still carry D's own token,
    // merged in, exactly as 883e29bc's own accepted same-tier-union design intends. D itself is never
    // independently queryable once merged (same pre-existing residual any two-degraded-entry union
    // carries) — the correctness bar is that its DATA is never lost, not that it stays separately named.
    const activeX = activeMergeQuarantineFor(x);
    check("*** THE FIX (Code Review BLOCKING 1) *** X's own query STILL carries D's token, merged — never lost by the eviction", !!activeX && (activeX.tokens ?? []).includes("x-token") && (activeX.tokens ?? []).includes("d-token"));

    // RESTART — the durable proof; this is where the pre-fix bug actually manifested (D's file had
    // already been unlinked as a wrongly-attributed "superseded duplicate" of Z by this point).
    const fresh1 = await freshBootModule();
    fresh1.reenterMergeQuarantinesAtBoot([z, x, d]);
    const activeXAfterRestart = fresh1.activeMergeQuarantineFor(x);
    check("*** THE FIX (Code Review BLOCKING 1) *** D's token SURVIVES a reboot, still merged into X's own entry", !!activeXAfterRestart && (activeXAfterRestart.tokens ?? []).includes("x-token") && (activeXAfterRestart.tokens ?? []).includes("d-token"));
    const activeZAfterRestart = fresh1.activeMergeQuarantineFor(z);
    check("(restart) Z's own entry is STILL clean, with ONLY its own token", !!activeZAfterRestart && (activeZAfterRestart.tokens ?? []).length === 1 && activeZAfterRestart.tokens.includes("z-token"));
  } else if (scenarioName === "degraded-divert-no-duplicate-across-flushes") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // Code Review of 7545166b, BLOCKING 2 (MAJOR, reviewer-measured) — the zero-remaining-keys (full
    // divert) branch re-pushed a `prior` that an EARLIER `flushDegradedDiverts()` call had ALREADY
    // pushed to `pendingUnresolvedQuarantines`. `degradedDivertsToFlush` is flushed TWICE in one boot —
    // once after PASS 1's own read loop, once after safety-tmp recovery — so a `prior` diverted and
    // flushed during PASS 1 can still be sitting in `byRepoKey` when PASS 1b (or safety-tmp recovery)
    // later evicts it via the SAME key, with `degradedDivertsToFlush` now EMPTY (already drained) —
    // falling through to the `quarantinePathForKey(key)` inference, which is WRONG for this shape (D's
    // real file is its own original, mismatched-name latch, never physically at that path) AND produces
    // a DUPLICATE listing for the same logical entry under two different (one wrong) sourceFile/ids.
    //
    // D is degraded, resolvedKey=K(R) — R a REAL, RESOLVABLE repo that is NOT in `registeredRepoPaths`
    // (so nothing legitimizes the collision). D's divert is pushed+flushed during PASS 1. R's own
    // `.json.tmp-<pid>` torn-write residue is then recovered in PASS 1b, colliding with D (still armed
    // at K(R) from PASS 1) via R's own PRIMARY arm — R wins (tautological), D is evicted a SECOND time.
    //
    // THE FIX: before pushing `prior` to `pendingUnresolvedQuarantines` in the full-divert branch, check
    // whether it is ALREADY there (by object identity) — if so, skip the push entirely; it is already
    // correctly represented with its own real sourceFile from whenever it was first flushed.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const r = path.join(os.tmpdir(), `loom-mqp1dug-b2-r-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# degraded-divert-no-duplicate-across-flushes (r)\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(r);
    const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);

    const d = path.join(os.tmpdir(), `loom-mqp1dug-b2-d-never-exists-${freshSfx()}`);
    check("(precondition) D never exists at all", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // D's own file is a torn-write-looking but ordinary `.json` final, named NOTHING like hash(Kr) — a
    // genuine degraded-divert (mismatched name), never self-consistent.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "d-divert-source.json"), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own manufactured resolvedKey collision with R (unregistered)",
      enteredAt: Date.now() - 30_000, tokens: ["d-token"], resolvedKey: Kr,
    }, null, 2) + "\n");
    // R's own torn-write tmp residue (PASS 1b), recovered AFTER PASS 1's own flush has already drained
    // `degradedDivertsToFlush` once.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`), JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R's own genuine, torn-write-recovered raise",
      enteredAt: Date.now(), tokens: ["r-token"],
    }, null, 2) + "\n");

    // `r` is deliberately NOT in registeredRepoPaths — nothing legitimizes the Kr collision.
    reenterMergeQuarantinesAtBoot([d]);

    const listingAfterBoot = listActiveMergeQuarantines().filter((q) => (q.tokens ?? []).includes("d-token"));
    check("*** THE FIX (Code Review BLOCKING 2) *** D is listed EXACTLY ONCE, never duplicated across the two flush passes", listingAfterBoot.length === 1);
    const activeRAfterBoot = activeMergeQuarantineFor(r);
    check("(sanity) R's own recovered raise is active, with ONLY its own token", !!activeRAfterBoot && (activeRAfterBoot.tokens ?? []).length === 1 && activeRAfterBoot.tokens.includes("r-token"));

    // RESTART ×2 — the Code Review's own repro named "reboots 2-3 list D TWICE under two different
    // latch ids"; a single boot alone did not necessarily surface it (the duplicate's OWN on-disk shape
    // matters), so this checks multiple consecutive reboots explicitly.
    for (let i = 1; i <= 2; i++) {
      const rebooted = await freshBootModule();
      rebooted.reenterMergeQuarantinesAtBoot([d]);
      const listingAfterReboot = rebooted.listActiveMergeQuarantines().filter((q) => (q.tokens ?? []).includes("d-token"));
      check(`*** THE FIX (Code Review BLOCKING 2) *** D is STILL listed exactly once after reboot #${i}`, listingAfterReboot.length === 1);
    }
  } else if (scenarioName === "round3-two-diverts-at-one-key-eviction") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round3-two-diverts-at-one-key-eviction — Code Review round 2 (of `7545166b`), finding B1:
    // armKeyUnlessDegradedCollision's zero-remaining-keys branch used to splice only ONE
    // degradedDivertsToFlush record at the evicted key. D1 and D2 are BOTH degraded (nonexistent paths),
    // BOTH with resolvedKey manufactured to the SAME colliding value K2 — a legitimate same-tier union at
    // K2 (883e29bc's own accepted shape). Z is a real, resolvable repo whose own file carries a STALE
    // secondary resolvedKey, ALSO K2 (same dual-arm shape as `dualarm-sibling-key-contamination`) — when
    // Z arrives, its tautological primary arm (at its OWN key K1) is unaffected, but its SECONDARY arm at
    // K2 evicts the D1+D2 union there to ZERO remaining keys (the union never held any other key).
    //
    // THE BUG (pre-round-3): the old zero-keys branch found and consumed only ONE of the two
    // `degradedDivertsToFlush` records keyed at K2 (by `resolvedKey` lookup) — the OTHER stayed pointing
    // at K2, and `flushDegradedDiverts` later re-read `byRepoKey.get(K2)` to find Z (the eviction's
    // winner), wrongly attributing the other divert's own latch file to Z.
    //
    // THE FIX (round 3): `degradedDivertsToFlush` records now carry their own entry snapshot directly,
    // never a `resolvedKey` to re-look-up — so BOTH D1's and D2's own records flush correctly regardless
    // of what happens to K2 afterward, and the eviction's own push (recovering D1+D2's real sourceFile
    // from whichever tracked pending reference already names it, or inferring one) never discards either.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const z = path.join(os.tmpdir(), `loom-mqp1dug-r3tdk-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# round3-two-diverts-at-one-key-eviction\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const K1 = canonicalRepoLockKey(z);
    const K1hash = createHash("sha256").update(K1).digest("hex").slice(0, 24);
    const K2 = `/synthetic/r3tdk-shared-K2-${freshSfx()}`;

    const d1 = path.join(os.tmpdir(), `loom-mqp1dug-r3tdk-d1-never-exists-${freshSfx()}`);
    const d2 = path.join(os.tmpdir(), `loom-mqp1dug-r3tdk-d2-never-exists-${freshSfx()}`);
    check("(precondition) D1 never exists at all", !fs.existsSync(d1));
    check("(precondition) D2 never exists at all", !fs.existsSync(d2));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const zFile = path.join(MERGE_QUARANTINE_DIR, `${K1hash}.json`);
    fs.writeFileSync(zFile, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, currently-active raise",
      enteredAt: Date.now() - 30_000, tokens: ["z-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    // D1/D2's own filenames are forced-first sentinels (never real hashes) — guaranteed to sort before
    // Z's own real hash filename, so both diverts process (and union at K2) before Z ever does.
    const d1Filename = "000000000000000000000001.json";
    const d2Filename = "000000000000000000000002.json";
    check("(precondition) D1's forced filename sorts before Z's real hash filename", d1Filename < `${K1hash}.json`);
    check("(precondition) D2's forced filename sorts before Z's real hash filename", d2Filename < `${K1hash}.json`);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, d1Filename), JSON.stringify({
      repoPath: d1, branch: "d1-branch", reason: "D1's own manufactured resolvedKey collision with Z's own stale K2",
      enteredAt: Date.now() - 10_000, tokens: ["d1-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, d2Filename), JSON.stringify({
      repoPath: d2, branch: "d2-branch", reason: "D2's own manufactured resolvedKey collision with Z's own stale K2",
      enteredAt: Date.now(), tokens: ["d2-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z, d1, d2]); // THE SINGLE BOOT CALL UNDER TEST

    const activeZ = activeMergeQuarantineFor(z);
    check("(sanity) Z's own token survives, never contaminated", !!activeZ && (activeZ.tokens ?? []).length === 1 && activeZ.tokens.includes("z-token"));

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (Code Review B1) *** D1's token survives the eviction", allTokensAfterBoot.has("d1-token"));
    check("*** THE FIX (Code Review B1) *** D2's token survives the eviction", allTokensAfterBoot.has("d2-token"));
    check("(sanity) D1's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d1Filename)));
    check("(sanity) D2's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d2Filename)));

    // RESTART — the durable proof.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([z, d1, d2]);
    const activeZAfterRestart = fresh.activeMergeQuarantineFor(z);
    check("(restart) Z's own entry is STILL clean, with ONLY its own token", !!activeZAfterRestart && (activeZAfterRestart.tokens ?? []).length === 1 && activeZAfterRestart.tokens.includes("z-token"));
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (Code Review B1, restart) *** D1's token SURVIVES a reboot too", allTokensAfterRestart.has("d1-token"));
    check("*** THE FIX (Code Review B1, restart) *** D2's token SURVIVES a reboot too", allTokensAfterRestart.has("d2-token"));
    check("(restart) D1's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d1Filename)));
    check("(restart) D2's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d2Filename)));
  } else if (scenarioName === "round3-degraded-walkup-to-resolvable-key") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round3-degraded-walkup-to-resolvable-key — Code Review round 2 (of `7545166b`), finding
    // B2: disproves the original "a resolvable prior can never reach armKeyUnlessDegradedCollision's
    // zero-remaining-keys branch" proof. D's own repoPath is a NONEXISTENT subdirectory of R (a real,
    // resolvable, UNREGISTERED repo) — so D's own `canonicalRepoLockKey` walks UP past its own absence to
    // R's OWN real key K(R), and D's persisted `resolvedKey` field is ALSO K(R) — meaning D's PRIMARY arm
    // (tautological, since currentKey===resolvedKey, so the degraded-divert branch never fires at all)
    // lands at EXACTLY R's own key, self-consistently. R's own final (processed earlier in PASS 1, armed
    // normally at K(R) with armedKeys=[K(R)] only) gets evicted to ZERO remaining keys when D's
    // tautological primary arm (processed later, in PASS 1b) claims K(R) for itself.
    //
    // THE FIX (round 3): R is NEVER discarded by this eviction — it is pushed to
    // `pendingUnresolvedQuarantines` with its own real sourceFile inferred deterministically (R reached
    // K(R) via its own self-consistent primary arm, so `quarantinePathForKey(K(R))`'s basename IS R's own
    // real backing file). R's quarantine survives both in-process and across a reboot.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const r = path.join(os.tmpdir(), `loom-mqp1dug-r3dwu-r-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# round3-degraded-walkup-to-resolvable-key\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(r);
    const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
    const d = path.join(r, "gone-subdir"); // never created — D's own repoPath, nonexistent subdir of R
    check("(precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
    fs.writeFileSync(rFile, JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
      enteredAt: Date.now() - 30_000, tokens: ["r-token"],
    }, null, 2) + "\n");
    // D's own PASS 1b tmp residue — resolvedKey manufactured to equal D's OWN walked-up currentKey
    // (K(R), since D never exists and walks up to R) — a self-consistent, TAUTOLOGICAL primary arm.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
      enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: Kr,
    }, null, 2) + "\n");

    // `r` is deliberately NOT in registeredRepoPaths — nothing legitimizes the collision either way.
    reenterMergeQuarantinesAtBoot([]);

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (Code Review B2) *** R's own token survives D's tautological-primary-arm eviction", allTokensAfterBoot.has("r-token"));
    check("(sanity) D's own token is active too", allTokensAfterBoot.has("d-token"));
    check("(production path) assertRepoNotQuarantined(r) is blocked", assertRepoNotQuarantined(r).ok === false);

    // THE CR's own acceptance bar — clear D by its own token, then reboot: R must still block.
    clearMergeQuarantineByToken(d, "d-token");
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const assertRAfterClearAndRestart = fresh.assertRepoNotQuarantined(r);
    check("*** THE FIX (Code Review B2) *** after clearing D by token + reboot, R STILL BLOCKS", assertRAfterClearAndRestart.ok === false);
  } else if (scenarioName === "round3-chained-eviction-three-parties") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round3-chained-eviction-three-parties — LEAD gen 413, round-3 ruling's own test (c): a
    // degraded record survives being evicted TWICE in the same boot — once by a TRIM (still holds
    // another key afterward) and once by a later ZERO-REMAINING-KEYS full divert — with 3+ parties
    // involved and no latch file or token lost across a reboot.
    //
    // D1, D2: both degraded (nonexistent paths), both resolvedKey=K2 — union legitimately at K2.
    // X: degraded (nonexistent path), self-consistently named at its OWN key K3, but ALSO carrying a
    // stale secondary resolvedKey=K2 — unions with D1+D2 at K2 (same tier), so the merged union now holds
    // BOTH K2 and K3 (armedKeys=[K2,K3]).
    // Z: a REAL, resolvable repo, own primary key K1, stale secondary resolvedKey=K2 — evicts the
    // D1+D2+X union from K2 ONLY (a TRIM: the union still holds K3 afterward).
    // W: a SECOND real, resolvable repo, own primary key K4, stale secondary resolvedKey=K3 (X's OWN
    // key) — evicts the (already-trimmed) D1+D2+X union from K3 too — its LAST remaining key, so this is
    // the ZERO-REMAINING-KEYS branch, reached a SECOND time for the SAME logical union. Z must process
    // before W (forced via filename order) or W's own eviction would hit the union still holding K2.
    //
    // THE FIX (round 3): neither eviction ever discards the union — D1's, D2's, and X's own tokens all
    // survive both evictions, and all three physical files (D1's, D2's, and X's own self-consistently-
    // named final) are left untouched, in-process and across a reboot.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const z = path.join(os.tmpdir(), `loom-mqp1dug-r3ce-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# round3-chained-eviction-three-parties (z)\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const K1 = canonicalRepoLockKey(z);
    const K1hash = createHash("sha256").update(K1).digest("hex").slice(0, 24);

    // W: retried (real I/O, but cheap) until its own hash sorts strictly AFTER Z's — so Z processes (and
    // trims the union down to K3) before W ever reaches it, guaranteeing W's own eviction is the SECOND,
    // zero-remaining-keys one, never a trim of its own.
    let w, K4, K4hash;
    for (let attempt = 0; ; attempt++) {
      w = path.join(os.tmpdir(), `loom-mqp1dug-r3ce-w-${freshSfx()}`);
      fs.mkdirSync(w, { recursive: true });
      fs.writeFileSync(path.join(w, "README.md"), "# round3-chained-eviction-three-parties (w)\n");
      execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: w });
      commitAll(w, "init", GIT_ID);
      K4 = canonicalRepoLockKey(w);
      K4hash = createHash("sha256").update(K4).digest("hex").slice(0, 24);
      if (K4hash > K1hash) break;
      fs.rmSync(w, { recursive: true, force: true });
      if (attempt > 1000) throw new Error("could not force W after Z after 1000 attempts");
    }
    tmpDirs.push(w);
    check("(precondition) W's own hash sorts after Z's", K4hash > K1hash);

    const K2 = `/synthetic/r3ce-shared-K2-${freshSfx()}`;

    // X: nonexistent, self-consistently named at hash(canonical(X))=K3 — retried (free; X never touches
    // disk) until K3's own hash sorts strictly BEFORE both Z's and W's own real hashes, so D1/D2/X are
    // all read and armed before either real repo ever is.
    let x, K3, K3hash;
    for (let attempt = 0; ; attempt++) {
      x = path.join(os.tmpdir(), `loom-mqp1dug-r3ce-x-never-exists-${freshSfx()}`);
      K3 = canonicalRepoLockKey(x);
      K3hash = createHash("sha256").update(K3).digest("hex").slice(0, 24);
      if (K3hash < K1hash && K3hash < K4hash) break;
      if (attempt > 200_000) throw new Error("could not force X before both Z and W after 200,000 attempts");
    }
    check("(precondition) X's own hash sorts before both Z's and W's", K3hash < K1hash && K3hash < K4hash);

    const d1 = path.join(os.tmpdir(), `loom-mqp1dug-r3ce-d1-never-exists-${freshSfx()}`);
    const d2 = path.join(os.tmpdir(), `loom-mqp1dug-r3ce-d2-never-exists-${freshSfx()}`);
    check("(precondition) D1 never exists at all", !fs.existsSync(d1));
    check("(precondition) D2 never exists at all", !fs.existsSync(d2));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const zFile = path.join(MERGE_QUARANTINE_DIR, `${K1hash}.json`);
    fs.writeFileSync(zFile, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, currently-active raise",
      enteredAt: Date.now() - 40_000, tokens: ["z-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    const wFile = path.join(MERGE_QUARANTINE_DIR, `${K4hash}.json`);
    fs.writeFileSync(wFile, JSON.stringify({
      repoPath: w, branch: "w-branch", reason: "W's own genuine, currently-active raise",
      enteredAt: Date.now() - 35_000, tokens: ["w-token"], resolvedKey: K3,
    }, null, 2) + "\n");
    const xFile = path.join(MERGE_QUARANTINE_DIR, `${K3hash}.json`);
    fs.writeFileSync(xFile, JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own prior raise, self-consistently named",
      enteredAt: Date.now() - 20_000, tokens: ["x-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    // D1/D2's own filenames are forced-first sentinels — sort before X's, Z's, AND W's own real hashes.
    const d1Filename = "000000000000000000000001.json";
    const d2Filename = "000000000000000000000002.json";
    check("(precondition) D1's forced filename sorts before every real hash filename here", d1Filename < K3hash && d1Filename < K1hash && d1Filename < K4hash);
    check("(precondition) D2's forced filename sorts before every real hash filename here", d2Filename < K3hash && d2Filename < K1hash && d2Filename < K4hash);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, d1Filename), JSON.stringify({
      repoPath: d1, branch: "d1-branch", reason: "D1's own manufactured resolvedKey collision at K2",
      enteredAt: Date.now() - 10_000, tokens: ["d1-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, d2Filename), JSON.stringify({
      repoPath: d2, branch: "d2-branch", reason: "D2's own manufactured resolvedKey collision at K2",
      enteredAt: Date.now(), tokens: ["d2-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z, w, x, d1, d2]); // THE SINGLE BOOT CALL UNDER TEST

    const activeZ = activeMergeQuarantineFor(z);
    check("(sanity) Z's own entry is clean, with ONLY its own token", !!activeZ && (activeZ.tokens ?? []).length === 1 && activeZ.tokens.includes("z-token"));
    const activeW = activeMergeQuarantineFor(w);
    check("(sanity) W's own entry is clean, with ONLY its own token", !!activeW && (activeW.tokens ?? []).length === 1 && activeW.tokens.includes("w-token"));

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 3, chained eviction) *** D1's token survives BOTH evictions", allTokensAfterBoot.has("d1-token"));
    check("*** THE FIX (round 3, chained eviction) *** D2's token survives BOTH evictions", allTokensAfterBoot.has("d2-token"));
    check("*** THE FIX (round 3, chained eviction) *** X's token survives BOTH evictions", allTokensAfterBoot.has("x-token"));
    check("(sanity) D1's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d1Filename)));
    check("(sanity) D2's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d2Filename)));
    check("(sanity) X's own latch file still physically exists", fs.existsSync(xFile));

    // RESTART — the durable proof.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([z, w, x, d1, d2]);
    const activeZAfterRestart = fresh.activeMergeQuarantineFor(z);
    check("(restart) Z's own entry is STILL clean", !!activeZAfterRestart && (activeZAfterRestart.tokens ?? []).length === 1 && activeZAfterRestart.tokens.includes("z-token"));
    const activeWAfterRestart = fresh.activeMergeQuarantineFor(w);
    check("(restart) W's own entry is STILL clean", !!activeWAfterRestart && (activeWAfterRestart.tokens ?? []).length === 1 && activeWAfterRestart.tokens.includes("w-token"));
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 3, chained eviction, restart) *** D1's token SURVIVES a reboot too", allTokensAfterRestart.has("d1-token"));
    check("*** THE FIX (round 3, chained eviction, restart) *** D2's token SURVIVES a reboot too", allTokensAfterRestart.has("d2-token"));
    check("*** THE FIX (round 3, chained eviction, restart) *** X's token SURVIVES a reboot too", allTokensAfterRestart.has("x-token"));
    check("(restart) D1's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d1Filename)));
    check("(restart) D2's own latch file still physically exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d2Filename)));
    check("(restart) X's own latch file still physically exists", fs.existsSync(xFile));
  } else if (scenarioName === "round4-p1-resolvable-winner-clear-destroys-loser-file") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round4-p1-resolvable-winner-clear-destroys-loser-file — CR round 3 (5bb32bae) on cde2bdb3,
    // CRITICAL P1: round 3's own clear-side protect gated on "the entry being cleared is itself
    // unresolvable" (deleteMergeQuarantineLatchByKey's old `clearedEntryIfUnresolvable` param) — but the
    // entry actually being cleared can be a RESOLVABLE eviction WINNER holding a DIFFERENT key only via
    // a STALE SECONDARY arm, and clearing it lifts EVERY one of its armed keys, including that stale
    // one, where a DIFFERENT, degraded LOSER's own real file still physically sits.
    //
    // D's own file lives at ITS OWN natural (self-consistent) location — hash(K2), K2 being D's OWN
    // real (degenerate, since D never exists) canonicalRepoLockKey — with `resolvedKey: K2` too (so D's
    // own primary arm is tautological, not a degraded-divert). Z is a REAL, resolvable repo, correctly
    // named at its OWN real key K1, but carrying a STALE secondary `resolvedKey: K2` — the SAME value as
    // D's own real key, purely coincidental (K2 is D's own degenerate `os.tmpdir()`-ancestor-walk value,
    // not backed by any registered repo). D is forced to process BEFORE Z (filename-sort), so D arms at
    // K2 first; Z's own secondary arm then evicts D from K2 to zero remaining keys — PASS 1's own
    // "never discard" fix (round 3) correctly diverts D to pending there. Z ends up dual-armed [K1,K2].
    //
    // THE BUG (round 3): `clearMergeQuarantineByToken(z, "z-token")` fully clears Z (its only token) —
    // `clearMergeQuarantineByKey` lifts EVERY one of Z's armed keys, [K1,K2]. Z itself IS resolvable, so
    // round 3's resolvability-gated protect never even ran for K2 — `deleteMergeQuarantineLatchByKey(K2)`
    // unconditionally unlinked D's own real file as pure collateral, even though D was never part of
    // this clear at all.
    //
    // THE FIX (round 4): the PRIMARY ownership check — gated on FILE OWNERSHIP via
    // `pendingUnresolvedQuarantines`, never on the cleared entry's own resolvability — finds D's own
    // surviving pending reference (identity `d`, differing from the clear's own identity `z`) naming
    // this EXACT file and protects it before the unlink proceeds.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const z = path.join(os.tmpdir(), `loom-mqp1dug-r4p1-z-${freshSfx()}`);
    fs.mkdirSync(z, { recursive: true });
    tmpDirs.push(z);
    fs.writeFileSync(path.join(z, "README.md"), "# round4-p1-resolvable-winner-clear-destroys-loser-file\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: z });
    commitAll(z, "init", GIT_ID);
    const K1 = canonicalRepoLockKey(z);
    const K1hash = createHash("sha256").update(K1).digest("hex").slice(0, 24);

    // D: nonexistent, retried (free; D never touches disk) until its own hash sorts strictly BEFORE Z's
    // — D must be READ (and so ARMED at its own key) BEFORE Z, or Z's own secondary arm never reaches an
    // already-occupied K2 at all (D would instead claim K2 outright once Z is merely trimmed to K1,
    // never evicted to pending — a completely different, uninteresting shape).
    let d, K2, K2hash;
    for (let attempt = 0; ; attempt++) {
      d = path.join(os.tmpdir(), `loom-mqp1dug-r4p1-d-never-exists-${freshSfx()}`);
      K2 = canonicalRepoLockKey(d); // D's OWN real (degenerate) key — stable for as long as D never exists
      K2hash = createHash("sha256").update(K2).digest("hex").slice(0, 24);
      if (K2hash < K1hash) break;
      if (attempt > 200_000) throw new Error("could not force D before Z after 200,000 attempts");
    }
    check("(precondition) D never exists at all", !fs.existsSync(d));
    check("(precondition) D's own key differs from Z's own key", K2 !== K1);
    check("(precondition) D's own hash sorts before Z's", K2hash < K1hash);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // D's own file at ITS OWN natural (self-consistent) location — resolvedKey matches its own currentKey.
    const dFile = path.join(MERGE_QUARANTINE_DIR, `${K2hash}.json`);
    fs.writeFileSync(dFile, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own genuine raise, self-consistently named",
      enteredAt: Date.now() - 10_000, tokens: ["d-token"], resolvedKey: K2,
    }, null, 2) + "\n");
    // Z's own file at ITS OWN natural location too, but with a STALE secondary resolvedKey coinciding
    // (purely coincidentally) with D's own real key.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${K1hash}.json`), JSON.stringify({
      repoPath: z, branch: "z-branch", reason: "Z's own genuine, currently-active raise",
      enteredAt: Date.now(), tokens: ["z-token"], resolvedKey: K2,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([z, d]); // THE SINGLE BOOT CALL UNDER TEST

    const activeZAfterBoot = activeMergeQuarantineFor(z);
    check("(sanity) Z reads quarantined, dual-armed, with ONLY its own token", !!activeZAfterBoot && (activeZAfterBoot.tokens ?? []).length === 1 && activeZAfterBoot.tokens.includes("z-token"));
    const activeDAfterBoot = activeMergeQuarantineFor(d);
    check("(sanity) D is evicted to pending but still reported quarantined, with ONLY its own token", !!activeDAfterBoot && (activeDAfterBoot.tokens ?? []).length === 1 && activeDAfterBoot.tokens.includes("d-token"));

    // THE CLEAR UNDER TEST — Z is the eviction WINNER, fully cleared by its only token.
    clearMergeQuarantineByToken(z, "z-token");

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([z, d]);
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 4, P1) *** D's token SURVIVES clearing Z + a reboot", allTokensAfterRestart.has("d-token"));
    check("(sanity) Z's own token is genuinely gone", !allTokensAfterRestart.has("z-token"));
    check("*** THE FIX (round 4, P1) *** assertRepoNotQuarantined(d) STILL BLOCKS after clearing Z + a reboot", fresh.assertRepoNotQuarantined(d).ok === false);
  } else if (scenarioName === "round4-p2-remounted-walkup-clear-destroys-winner-file") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round4-p2-remounted-walkup-clear-destroys-winner-file — CR round 3 (5bb32bae) on cde2bdb3,
    // CRITICAL P2: the SAME `round3-degraded-walkup-to-resolvable-key` fixture (D's own repoPath is a
    // nonexistent subdirectory of R, a real resolvable UNREGISTERED repo; D's own tautological primary
    // arm evicts R to pending at K(R)) — but D is REMOUNTED (its own `gone-subdir` created, so D now
    // resolves) BEFORE it is cleared, with no intervening query of R. Round 3's own resolvability-gated
    // protect checked whether D (the entry being cleared) was unresolvable — now that D resolves, that
    // gate skipped the protect entirely, and `clearMergeQuarantineByToken(d, "d-token")` unconditionally
    // unlinked R's own real file as collateral, even though D never wrote there itself.
    //
    // THE FIX (round 4): the PRIMARY ownership check never looks at D's own resolvability at all — it
    // finds R's own surviving pending reference (identity `r`, differing from the clear's own identity
    // `d`) naming this exact file and protects it before the unlink proceeds.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const r = path.join(os.tmpdir(), `loom-mqp1dug-r4p2-r-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# round4-p2-remounted-walkup-clear-destroys-winner-file\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(r);
    const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
    const d = path.join(r, "gone-subdir"); // not created yet — D's own repoPath, nonexistent subdir of R
    check("(precondition) D (R/gone-subdir) never exists yet", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
    fs.writeFileSync(rFile, JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
      enteredAt: Date.now() - 30_000, tokens: ["r-token"],
    }, null, 2) + "\n");
    // D's own PASS 1b tmp residue — resolvedKey manufactured to equal D's OWN walked-up currentKey
    // (K(R), since D never exists yet and walks up to R) — a self-consistent, TAUTOLOGICAL primary arm.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
      enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: Kr,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]); // `r` deliberately NOT in registeredRepoPaths

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity) R's own token survives D's tautological-primary-arm eviction", allTokensAfterBoot.has("r-token"));
    check("(sanity) D's own token is active too", allTokensAfterBoot.has("d-token"));

    // D REMOUNTS — its own `gone-subdir` is created, so D now resolves — with NO query of R in between
    // (an in-process query would lazily re-persist/graduate R, which is exactly what this scenario must
    // NOT rely on to stay fail-closed).
    fs.mkdirSync(d, { recursive: true });
    check("(precondition) D now resolves", fs.existsSync(d));

    // THE CLEAR UNDER TEST — D is cleared by its own (now-resolvable) identity.
    clearMergeQuarantineByToken(d, "d-token");

    // NOTE: D's own `.tmp-999` residue is a SEPARATE physical file from R's own final — clearing D's
    // token only ever addresses the FINAL at Kr (now protected as R's own content, above); it was never
    // the thing durably tracking D in the first place, and is left untouched on disk. On a fresh reboot
    // it is read fresh — and since D genuinely resolves now (a real subdir of R), it legitimately
    // UNIONS with R at their now-shared real key, same as any other now-resolvable sibling would. This
    // scenario's own acceptance bar (per the CR) is R's own survival, never that D's leftover residue
    // stops existing — asserting the latter would assert something this fix neither causes nor prevents.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 4, P2) *** R's token SURVIVES clearing the now-resolvable D + a reboot", allTokensAfterRestart.has("r-token"));
    check("*** THE FIX (round 4, P2) *** assertRepoNotQuarantined(r) STILL BLOCKS after clearing D + a reboot", fresh.assertRepoNotQuarantined(r).ok === false);
  } else if (scenarioName === "round5-own-raise-lifts-past-inferred-evictee") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round5-own-raise-lifts-past-inferred-evictee — LEAD gen 413, round 5 (CR round 4,
    // 891bb19a, on f5e353bf), the ONE blocker: a MAJOR, fail-STUCK regression new in round 4. W is a
    // real, UNREGISTERED repo with an active latch at its own natural file sha(K).json, K =
    // canonicalRepoLockKey(W). D is a nonexistent path (never under W) carrying `resolvedKey: K` — the
    // SAME key as W's own, purely manufactured — but D's OWN walked-up currentKey differs from K, so D is
    // a genuine DEGRADED DIVERT (armKeyUnlessDegradedCollision's secondary, non-tautological arm), armed
    // at K FIRST (D's forced filename sorts before W's real hash filename). W is then read, and its own
    // TAUTOLOGICAL primary arm evicts D from K to zero remaining keys.
    //
    // THE BUG (round 4): with no tracked pending reference yet (D's own record still sits in
    // `degradedDivertsToFlush`, not yet flushed), the eviction's OLD inference blindly trusted
    // `quarantinePathForKey(K)`'s own basename as D's "real source file" — but that file is physically
    // W's OWN final (sha(K).json), not D's. D is pushed to `pendingUnresolvedQuarantines` falsely
    // CLAIMING W's own file as its `sourceFile`. Clearing W (by path OR by token) then finds this
    // "foreign" pending claim naming W's own final, copies W's own content aside under D's own
    // pending-divert name (a circular resurrection), and unlinks the original — w-token survives every
    // clear and every reboot.
    //
    // THE FIX (round 5): the clear-side PRIMARY check now skips the protect when the file's own on-disk
    // content already names the clearer (`quarantineFileRepoPathIdentity(final) === clearIdentity`) —
    // copying it could only ever resurrect the clearer. (Round 5 ALSO shipped an eviction-side "belt" on
    // top of this — round 6 REVERTED that belt byte-for-byte, after it opened two new CRITICAL fail-open
    // losses of its own; see the decision record's "Round 6" section. This clear-side check alone is
    // what fixes the blocker below — the belt was never load-bearing for it.)
    //
    // Both routes the CR named are exercised, each with its OWN fresh fixture: clear-by-path
    // (`clearMergeQuarantineReporting`) and clear-by-token (`clearMergeQuarantineByToken`).
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // `mod` is a FRESH, dedicated module instance per route — `reenterMergeQuarantinesAtBoot` merges its
    // own fresh results into module-level `activeQuarantines`/`pendingUnresolvedQuarantines` state rather
    // than resetting it (see `freshBootModule`'s own doc), so two independent repro instances in one
    // scenario must never share an instance, or route 2's own boot would read route 1's stale state.
    const makeFixture = async (tag) => {
      const mod = await freshBootModule();
      const w = path.join(os.tmpdir(), `loom-mqp1dug-r5orl-w-${tag}-${freshSfx()}`);
      fs.mkdirSync(w, { recursive: true });
      tmpDirs.push(w);
      fs.writeFileSync(path.join(w, "README.md"), `# round5-own-raise-lifts-past-inferred-evictee (${tag})\n`);
      execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: w });
      commitAll(w, "init", GIT_ID);
      const K = canonicalRepoLockKey(w);
      const Khash = createHash("sha256").update(K).digest("hex").slice(0, 24);

      const d = path.join(os.tmpdir(), `loom-mqp1dug-r5orl-d-never-exists-${tag}-${freshSfx()}`); // never created
      check(`(precondition, ${tag}) D never exists at all`, !fs.existsSync(d));
      const dCurrentKey = canonicalRepoLockKey(d);
      check(`(precondition, ${tag}) D's own walked-up key differs from K (a genuine degraded divert, not tautological)`, dCurrentKey !== K);

      // D's forced sentinel filename — must sort BEFORE W's own real hash filename so D is read+armed at
      // K first, and W's own LATER tautological primary arm is the one doing the evicting. Tag-suffixed
      // so route 1's and route 2's own D files never collide on disk (both routes share one quarantine dir).
      const dFilename = `0000000000000000000000${tag === "path" ? "01" : "02"}.json`;
      check(`(precondition, ${tag}) D's forced filename sorts before W's own real hash filename`, dFilename < Khash);

      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, dFilename), JSON.stringify({
        repoPath: d, branch: "d-branch", reason: `D's own manufactured resolvedKey collision at K (${tag}, W's own key)`,
        enteredAt: Date.now() - 10_000, tokens: [`d-token-${tag}`], resolvedKey: K,
      }, null, 2) + "\n");
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Khash}.json`), JSON.stringify({
        repoPath: w, branch: "w-branch", reason: `W's own genuine, currently-active raise (${tag})`,
        enteredAt: Date.now(), tokens: [`w-token-${tag}`],
      }, null, 2) + "\n");

      mod.reenterMergeQuarantinesAtBoot([]); // `w` deliberately NOT registered — nothing legitimizes the collision

      const activeWAfterBoot = mod.activeMergeQuarantineFor(w);
      check(`(sanity, ${tag}) W reads quarantined, with ONLY its own token`, !!activeWAfterBoot && (activeWAfterBoot.tokens ?? []).length === 1 && activeWAfterBoot.tokens.includes(`w-token-${tag}`));
      const allTokensAfterBoot = new Set(mod.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
      check(`(sanity, ${tag}) D's own token survives the eviction (never discarded)`, allTokensAfterBoot.has(`d-token-${tag}`));
      check(`(sanity, ${tag}) D's own physical file is untouched`, fs.existsSync(path.join(MERGE_QUARANTINE_DIR, dFilename)));
      return { mod, w, d, dFilename };
    };

    // ROUTE 1 — clear-by-path.
    const { mod: modPath, w: w1, d: d1, dFilename: d1Filename } = await makeFixture("path");
    const reportResult = modPath.clearMergeQuarantineReporting(w1);
    check("(sanity, path) clear-by-path reports W genuinely lifted, no latch kept", reportResult.wasQuarantined === true && !reportResult.latchKept);
    const freshPath = await freshBootModule();
    freshPath.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterPathClear = new Set(freshPath.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 5, clear-by-path) *** w-token does NOT survive a clear + reboot", !allTokensAfterPathClear.has("w-token-path"));
    check("(sanity, path) D's own token still survives the reboot", allTokensAfterPathClear.has("d-token-path"));
    check("(sanity, path) D's own physical file is still untouched", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d1Filename)));
    check("*** THE FIX (round 5, clear-by-path) *** assertRepoNotQuarantined(d) STILL BLOCKS after clearing W + a reboot", freshPath.assertRepoNotQuarantined(d1).ok === false);

    // ROUTE 2 — clear-by-token, its own FRESH fixture AND module instance (W1 is already cleared above).
    const { mod: modToken, w: w2, d: d2, dFilename: d2Filename } = await makeFixture("token");
    modToken.clearMergeQuarantineByToken(w2, "w-token-token");
    const freshToken = await freshBootModule();
    freshToken.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterTokenClear = new Set(freshToken.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (round 5, clear-by-token) *** w-token does NOT survive a clear + reboot", !allTokensAfterTokenClear.has("w-token-token"));
    check("(sanity, token) D's own token still survives the reboot", allTokensAfterTokenClear.has("d-token-token"));
    check("(sanity, token) D's own physical file is still untouched", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, d2Filename)));
    check("*** THE FIX (round 5, clear-by-token) *** assertRepoNotQuarantined(d) STILL BLOCKS after clearing W + a reboot", freshToken.assertRepoNotQuarantined(d2).ok === false);
  } else if (scenarioName === "round6-union-constituent-survives-eviction") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round6-union-constituent-survives-eviction — CR round 5 (df708ec4) on 2ba1f25e, CRITICAL
    // (a): round 5's own eviction-side "belt" (now REVERTED — see round 6 below) regressed the
    // zero-keys branch's `queuedForFlush` early-skip. D is a degraded divert (resolvedKey=K, forced to
    // sort first) that arms at K via its own secondary arm, queued in `degradedDivertsToFlush`. X = a
    // nonexistent subdir of W (`W/gone-subdir`) that ALSO walks up to K and ALSO carries `resolvedKey:
    // K` — a TAUTOLOGICAL, self-consistent entry physically living AT `sha(K).json` — unions with D
    // (same-tier: both unresolvable) into U, and the existing general union-rebind (Round 3, Part A)
    // correctly re-points D's OWN `degradedDivertsToFlush` record onto U. W (a real, UNREGISTERED repo)
    // then migrates from a stale `ffff…ff.json` and its own TAUTOLOGICAL primary arm evicts U from K to
    // zero remaining keys.
    //
    // THE BUG (round 5 belt): at THIS eviction, U is STILL queued in `degradedDivertsToFlush` (not yet
    // flushed) — round 5's own `queuedForFlush` check saw this and skipped pushing {U, sha(K).json}
    // ENTIRELY, trusting the LATER flush to cover it. But the flush only ever pushes U under D's OWN
    // original sourceFile ("000...001.json") — it NEVER covers X's OWN physical file (`sha(K).json`,
    // U's ACTUAL current backing, since X is the constituent that's physically AT that path). Phase 0
    // never sees `sha(K).json` as at-risk, so W's own migrate write for K — admitted because `sha(K).json`
    // is no longer `degradedOccupiedKeys`-gated once U is evicted (that gate is removed on eviction) —
    // overwrites it UNPROTECTED. x-token is GONE after a plain reboot, no clear needed.
    //
    // THE FIX (round 6): REVERT the eviction-side belt to f5e353bf's exact behaviour (round 5's own
    // "verify-then-claim-or-divert" inference is removed; the zero-keys branch falls straight back to
    // f5e353bf's unconditional `quarantinePathForKey(key)` inference, with no `queuedForFlush` early-skip
    // at all) — this card's own ROUND-4 shape (before round 5's belt) was independently CR-verified
    // fail-open CLEAN. The CLEAR-side fix (`quarantineFileRepoPathIdentity`, kept — see round 5's own
    // scenario above) is what alone fixes round 4's real blocker; the belt was never load-bearing.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqp1dug-r6uce-w-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# round6-union-constituent-survives-eviction\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const K = canonicalRepoLockKey(w);
    const Khash = createHash("sha256").update(K).digest("hex").slice(0, 24);

    const d = path.join(os.tmpdir(), `loom-mqp1dug-r6uce-d-never-exists-${freshSfx()}`); // never created
    const x = path.join(w, "gone-subdir"); // never created — walks up to W's own key K
    check("(precondition) D never exists at all", !fs.existsSync(d));
    check("(precondition) X (W/gone-subdir) never exists", !fs.existsSync(x));

    // D's forced sentinel filename — must sort BEFORE X's real hash filename so D arms at K FIRST (its
    // own secondary arm), and X's later tautological primary arm unions with it rather than the reverse.
    const dFilename = "000000000000000000000001.json";
    check("(precondition) D's forced filename sorts before W's own real hash filename", dFilename < Khash);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, dFilename), JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own manufactured resolvedKey collision at K",
      enteredAt: Date.now() - 10_000, tokens: ["d-token"], resolvedKey: K,
    }, null, 2) + "\n");
    // X: self-consistently named AT sha(K).json — its OWN real physical backing file.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${Khash}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X's own tautological entry, physically at sha(K).json",
      enteredAt: Date.now() - 5_000, tokens: ["x-token"], resolvedKey: K,
    }, null, 2) + "\n");
    // W: real repo, migrating from a stale key — sorts LAST among plain .json files.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "ffffffffffffffffffffffff.json"), JSON.stringify({
      repoPath: w, branch: "w-branch", reason: "W's own genuine, currently-active raise",
      enteredAt: Date.now(), tokens: ["w-token"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]); // `w` deliberately NOT registered — nothing legitimizes the collision

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity) w-token is active after boot", allTokensAfterBoot.has("w-token"));
    check("(sanity) d-token survives the union+eviction", allTokensAfterBoot.has("d-token"));
    check("*** THE FIX (round 6, finding a) *** x-token survives the union+eviction too", allTokensAfterBoot.has("x-token"));

    // THE DURABLE PROOF — a PLAIN REBOOT, no clear needed (per the CR's own repro).
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterReboot = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity, reboot) w-token survives the reboot", allTokensAfterReboot.has("w-token"));
    check("(sanity, reboot) d-token survives the reboot", allTokensAfterReboot.has("d-token"));
    check("*** THE FIX (round 6, finding a, reboot) *** x-token SURVIVES a plain reboot (never discarded)", allTokensAfterReboot.has("x-token"));
    // NOT a fix-detecting check — K itself stays blocked (by W) regardless of x-token's own fate, so
    // this never went RED on 2ba1f25e; a sanity check only, kept for completeness.
    check("(sanity, round 6, finding a) assertRepoNotQuarantined(x) still blocks after a reboot", fresh.assertRepoNotQuarantined(x).ok === false);
  } else if (scenarioName === "round6-mismatch-evictee-survives-clear") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO round6-mismatch-evictee-survives-clear — CR round 5 (df708ec4) on 2ba1f25e, CRITICAL (b):
    // round 5's own "verified-mismatch fallback" (now REVERTED — see round 6 above), when it fired,
    // tracked the evicted entry under `pendingDivertFilenameFor(prior.repoPath)` — a name NEVER written
    // to disk and never a member of `allBootWriteTargets`, so purely in-memory.
    //
    // W (real repo, migrating from a stale `ffff…ff.json`) arms at its own key K first (nothing occupies
    // K yet). Y (`W/gone-two`, nonexistent, `resolvedKey: K`, a TAUTOLOGICAL tmp-residue entry — PASS 1b,
    // so it is read strictly AFTER every plain `.json` final, regardless of filename) then evicts W
    // (cross-tier: W resolvable, Y not) — W's own real backing (`ffff…ff.json`) differs from
    // `quarantinePathForKey(K)` (`sha(K).json`, which does not even exist yet), so this is a genuine
    // MISMATCH, not a verified match. `teamA` (`W/teamA`, a REAL, EXISTING plain subdir of W with no own
    // `.git` — so ALSO resolvable, ALSO walks up to K) then evicts Y in turn (cross-tier the OTHER way:
    // teamA resolvable, Y not) — Y's own real backing (its OWN tmp residue) ALSO differs from
    // `sha(K).json`, a SECOND genuine mismatch. teamA — resolvable — becomes the final occupant, so its
    // own migrate write for K (W's stale source) SUCCEEDS this time, genuinely overwriting `sha(K).json`.
    //
    // THE BUG (round 5 belt): BOTH W's and Y's evictions hit the verified-mismatch fallback, tracking
    // each under its own NEVER-WRITTEN `pendingDivertFilenameFor` name. Phase 0's at-risk computation
    // never sees either as colliding with `sha(K).json` (that bogus name is never a real write target),
    // so NEITHER gets a protective safety-tmp before teamA's successful write. Both w-token and y-token
    // are PERMANENTLY LOST the moment that write lands — no clear even needed, a plain reboot shows it.
    //
    // THE FIX (round 6): reverting the belt restores f5e353bf's unconditional (if occasionally
    // over-eager) inference — `priorSourceFile = quarantinePathForKey(key)`'s own basename, ALWAYS —
    // which correctly registers `sha(K).json` as at-risk for BOTH W's and Y's own pending claims, so
    // Phase 0 durably safety-tmps each of their own reconstructed records before teamA's write proceeds.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqp1dug-r6mec-w-${freshSfx()}`);
    const teamA = path.join(w, "teamA"); // REAL, EXISTING plain subdir, no own .git — ALSO resolvable
    fs.mkdirSync(teamA, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# round6-mismatch-evictee-survives-clear\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const K = canonicalRepoLockKey(w);
    const Khash = createHash("sha256").update(K).digest("hex").slice(0, 24);

    const y = path.join(w, "gone-two"); // never created
    check("(precondition) Y (W/gone-two) never exists", !fs.existsSync(y));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // W: real repo, migrating from a stale name.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "ffffffffffffffffffffffff.json"), JSON.stringify({
      repoPath: w, branch: "w-branch", reason: "W's own genuine, currently-active raise",
      enteredAt: Date.now() - 10_000, tokens: ["w-token"],
    }, null, 2) + "\n");
    // Y: nonexistent, tautological tmp residue, processed BEFORE teamA's own tmp (alphabetical).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "aaaaaaaaaaaaaaaaaaaaaaaa.json.tmp-11111"), JSON.stringify({
      repoPath: y, branch: "y-branch", reason: "Y's own tautological entry, via a tmp residue",
      enteredAt: Date.now() - 5_000, tokens: ["y-token"], resolvedKey: K,
    }, null, 2) + "\n");
    // teamA: REAL/resolvable, tautological tmp residue, processed AFTER Y's own tmp (alphabetical).
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "bbbbbbbbbbbbbbbbbbbbbbbb.json.tmp-22222"), JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own tautological entry, via a tmp residue",
      enteredAt: Date.now(), tokens: ["teamA-token"], resolvedKey: K,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]); // nothing registered — nothing legitimizes any of these collisions

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity) teamA-token is active after boot (the final, resolvable occupant)", allTokensAfterBoot.has("teamA-token"));
    check("*** THE FIX (round 6, finding b) *** w-token survives teamA's successful write", allTokensAfterBoot.has("w-token"));
    check("*** THE FIX (round 6, finding b) *** y-token survives teamA's successful write too", allTokensAfterBoot.has("y-token"));

    // THE DURABLE PROOF — a PLAIN REBOOT, no clear needed (per the CR's own repro).
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterReboot = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity, reboot) teamA-token survives the reboot", allTokensAfterReboot.has("teamA-token"));
    check("*** THE FIX (round 6, finding b, reboot) *** w-token SURVIVES a plain reboot (never discarded)", allTokensAfterReboot.has("w-token"));
    check("*** THE FIX (round 6, finding b, reboot) *** y-token SURVIVES a plain reboot too", allTokensAfterReboot.has("y-token"));
    // NOT a fix-detecting check — K itself stays blocked (by teamA) regardless of y-token's own fate,
    // so this never went RED on 2ba1f25e; a sanity check only, kept for completeness.
    check("(sanity, round 6, finding b) assertRepoNotQuarantined(y) still blocks after a reboot", fresh.assertRepoNotQuarantined(y).ok === false);

    // AND CLEAR — the DoD's own "(and clear)" assertion: w/teamA's own merged entry at K clears cleanly,
    // Y's own SEPARATE pending entry is untouched by it, and both states survive one more reboot.
    const activeAtK = fresh.activeMergeQuarantineFor(w);
    check("(precondition, clear) W reads quarantined (merged with teamA) before the clear", !!activeAtK && (activeAtK.tokens ?? []).includes("w-token"));
    fresh.clearMergeQuarantineReporting(w);
    const freshAfterClear = await freshBootModule();
    freshAfterClear.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterClearReboot = new Set(freshAfterClear.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity, clear) w/teamA's own merged token(s) are genuinely gone after the clear + reboot", !allTokensAfterClearReboot.has("w-token") && !allTokensAfterClearReboot.has("teamA-token"));
    check("*** THE FIX (round 6, finding b, clear) *** y-token is UNAFFECTED by clearing the unrelated w/teamA entry", allTokensAfterClearReboot.has("y-token"));
  } else if (scenarioName === "d2582692-clear-resolvable-protects-foreign-occupant") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO d2582692-clear-resolvable-protects-foreign-occupant — board card d2582692 (from d163aef5
    // CR round 4, 891bb19a, finding 2). Reuses the SAME round3-degraded-walkup-to-resolvable-key fixture
    // (R, a real resolvable, UNREGISTERED repo; D = R/gone-subdir, a nonexistent subdir whose own
    // tautological primary arm evicts R to pending, both sharing R's own key K(R)) — but this time clears
    // R ITSELF (clearMergeQuarantineReporting), never D.
    //
    // THE BUG: a human REST clear of a RESOLVABLE repo R resolves R's own fresh key K(R) and treats
    // WHATEVER is currently armed there (D, a foreign, unrelated, degraded occupant) as "the entry being
    // cleared" — unconditionally deleting D's in-memory record and sweeping D's own physical backing (its
    // own `.tmp-999` residue, via the key's unconditional sweepTmpResidueForHashIfUnreferenced) even
    // though D was never raised by this clear's own requester at all. The pre-existing clear-side protect
    // (protectUnincorporatedOccupantBeforeDelete) also mis-fires in the OPPOSITE direction: it reads
    // `final`'s own on-disk content (which is genuinely R's OWN data — D never actually wrote there) and,
    // comparing it only against D (the armed occupant), wrongly treats R's OWN file as a foreign
    // "unincorporated occupant", duplicating it under a fresh pending-divert name. That duplicate then
    // lazily re-graduates on the very next query, resurrecting R's own token and producing the confusing
    // "quarantined by ANOTHER repo... repoPath R" message — self-referential nonsense, since R is the
    // very identity that just asked to be cleared.
    //
    // THE FIX: a clear by a resolvable repoPath lifts only entries whose identity matches the requester;
    // an armed occupant that is not itself currently verified to belong to this key (D) is left fully
    // alone, in-memory and on disk. D's token and physical file survive untouched; R's own pending record
    // and file are cleared cleanly; the confusing re-block message never appears.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const r = path.join(os.tmpdir(), `loom-mqp1dug-d2582692-r-${freshSfx()}`);
    fs.mkdirSync(r, { recursive: true });
    tmpDirs.push(r);
    fs.writeFileSync(path.join(r, "README.md"), "# d2582692-clear-resolvable-protects-foreign-occupant\n");
    execSync(`git init -q && git config user.email mqp1dug@loom && git config user.name mqp1dug`, { cwd: r });
    commitAll(r, "init", GIT_ID);
    const Kr = canonicalRepoLockKey(r);
    const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
    const d = path.join(r, "gone-subdir"); // never created — D's own repoPath, nonexistent subdir of R
    check("(precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
    fs.writeFileSync(rFile, JSON.stringify({
      repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
      enteredAt: Date.now() - 30_000, tokens: ["r-token"],
    }, null, 2) + "\n");
    // D's own PASS 1b tmp residue — resolvedKey manufactured to equal D's OWN walked-up currentKey
    // (K(R), since D never exists and walks up to R) — a self-consistent, TAUTOLOGICAL primary arm.
    const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
    fs.writeFileSync(dTmpFile, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
      enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: Kr,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]); // `r` deliberately NOT in registeredRepoPaths

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity) R's own token survives D's tautological-primary-arm eviction", allTokensAfterBoot.has("r-token"));
    check("(sanity) D's own token is active too", allTokensAfterBoot.has("d-token"));
    check("(sanity) D's own tmp residue is still on disk before the clear", fs.existsSync(dTmpFile));

    // THE CLEAR UNDER TEST — R itself (the human-REST route), while D (foreign) occupies R's own key.
    const reportResult = clearMergeQuarantineReporting(r);

    check("*** THE FIX *** D's own token SURVIVES clearing R", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token"));
    // D's own ORIGINAL `.tmp-999` residue is swept once its content has been durably copied aside — same
    // acceptance bar as round4-p2's own comment: the content surviving SOMEWHERE on disk is what matters,
    // never that the original filename itself stops existing.
    const survivingFiles = fs.readdirSync(MERGE_QUARANTINE_DIR);
    const dContentSurvivesOnDisk = survivingFiles.some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token"));
    check("*** THE FIX *** D's own content durably survives on disk clearing R (never destroyed as collateral)", dContentSurvivesOnDisk);
    check("*** THE FIX *** assertRepoNotQuarantined(d) still blocks, by D's own identity, after clearing R", assertRepoNotQuarantined(d).ok === false);
    check("*** THE FIX *** the still-quarantined reason never nonsensically names R itself as R's own blocker", !(reportResult.reason ?? "").includes(`repoPath '${r}'`));
    // Code Review follow-up — assert R's OWN clear genuinely succeeded explicitly (ok:true), never only
    // by the absence of a confusing reason string naming R.
    check("*** THE FIX *** assertRepoNotQuarantined(r) is explicitly UNBLOCKED right after the clear", assertRepoNotQuarantined(r).ok === true);

    // DURABLE — across a reboot, D's own token/file must still be there, never resurrected-then-lost.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** THE FIX (restart) *** D's own token SURVIVES clearing R + a reboot", allTokensAfterRestart.has("d-token"));
    check("*** THE FIX (restart) *** assertRepoNotQuarantined(d) STILL BLOCKS after clearing R + a reboot", fresh.assertRepoNotQuarantined(d).ok === false);
    check("*** THE FIX (restart) *** assertRepoNotQuarantined(r) stays explicitly UNBLOCKED after a reboot", fresh.assertRepoNotQuarantined(r).ok === true);
  } else if (scenarioName === "d2582692-clearing-union-winner-keeps-loser-pending") {
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // SCENARIO d2582692-clearing-union-winner-keeps-loser-pending — Code Review follow-up on d2582692,
    // pinning its own interaction with card 398f476c's own documented "MAJOR #3" residual
    // (docs/decisions/c9114934-degraded-occupant-safety-copy-before-key-reclaim.md): TWO wholly
    // unresolvable identities (L1, L2) sharing ONE manufactured `resolvedKey` KS, legitimately unioned
    // in-memory via armQuarantineKey's own same-tier (both-degraded) union — `unionQuarantineEntries`
    // keeps the OLDER side's own identity (L1 here), so the union's own `repoPath` IS L1, and
    // `clearMergeQuarantineByKey`'s own `clearingRepoPath` computes `undefined`
    // (`entry.repoPath === identityRepoPath`) — MAJOR #3's own documented gap, still open, deferred to
    // card 398f476c's identity-model redesign.
    //
    // BEFORE d2582692, protectForeignTmpResidueBeforeSweep did not exist, so clearing L1 (the union's
    // own winning identity) unconditionally swept BOTH L1's and L2's own tmp residue — L2 was silently
    // lifted along with L1, with no copy anywhere, even though L2 was never the identity the clear was
    // addressed at.
    //
    // d2582692's own fix is content-aware, not identity-aware (it reads each tmp file's OWN on-disk
    // `repoPath` directly, never trusting whichever identity the in-memory union happens to report) — so
    // it ALSO protects L2 here, as a side effect: L2's own tmp content differs from `clearIdentity` (L1)
    // and is currently unresolvable, so it gets durably copied aside before the sweep, surviving as its
    // own standalone pending entry. This PINS that side effect as the current, correct behaviour — card
    // 398f476c's own identity-model redesign should start from "clearing L1 already keeps L2 blocked as
    // pending", not from scratch.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    const l1 = path.join(os.tmpdir(), `loom-mqp1dug-398f476c-l1-never-exists-${freshSfx()}`);
    const l2 = path.join(os.tmpdir(), `loom-mqp1dug-398f476c-l2-never-exists-${freshSfx()}`);
    check("(precondition) L1 and L2 never exist", !fs.existsSync(l1) && !fs.existsSync(l2));
    const KS = `/synthetic/398f476c-major3-shared-key-${freshSfx()}`; // manufactured, never a real resolvable key
    const KShash = createHash("sha256").update(KS).digest("hex").slice(0, 24);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // Both L1's and L2's own tmp residue is named at KS's own hash prefix — mirrors the real shape of two
    // separate torn-write raise attempts that BOTH correctly computed KS as their intended target key.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${KShash}.json.tmp-11111`), JSON.stringify({
      repoPath: l1, branch: "l1-branch", reason: "L1's own manufactured collision (tmp residue)",
      enteredAt: Date.now() - 60_000, tokens: ["l1-token"], resolvedKey: KS,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${KShash}.json.tmp-22222`), JSON.stringify({
      repoPath: l2, branch: "l2-branch", reason: "L2's own manufactured collision (tmp residue)",
      enteredAt: Date.now() - 30_000, tokens: ["l2-token"], resolvedKey: KS,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]); // neither L1 nor L2 registered — nothing legitimizes the collision

    const allTokensAfterBoot = new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("(sanity) L1's own token is active after boot", allTokensAfterBoot.has("l1-token"));
    check("(sanity) L2's own token is active too (the same-tier union)", allTokensAfterBoot.has("l2-token"));
    const activeAtKS = activeMergeQuarantineFor(l1);
    check("(sanity) the union's own winning identity is L1 (the older raise)", !!activeAtKS && activeAtKS.repoPath === l1);

    // THE CLEAR UNDER TEST — L1, the union's own winning identity, cleared by its own recorded path.
    const reportResult = clearMergeQuarantineReporting(l1);

    check("*** PINNED (398f476c MAJOR #3) *** L2's own token SURVIVES clearing the union's winner L1", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("l2-token"));
    check("(sanity) L1's own token is genuinely gone", !new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("l1-token"));
    check("*** PINNED (398f476c MAJOR #3) *** assertRepoNotQuarantined(l2) still blocks, by L2's own identity, after clearing L1", assertRepoNotQuarantined(l2).ok === false);
    check("*** PINNED (398f476c MAJOR #3) *** assertRepoNotQuarantined(l1) is explicitly UNBLOCKED", assertRepoNotQuarantined(l1).ok === true);
    check("(sanity) clearing L1 reports wasQuarantined:true", reportResult.wasQuarantined === true);

    // DURABLE — across a reboot, L2's own token must still be there, never resurrected-then-lost.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    const allTokensAfterRestart = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
    check("*** PINNED (398f476c MAJOR #3, restart) *** L2's own token SURVIVES clearing L1 + a reboot", allTokensAfterRestart.has("l2-token"));
    check("(sanity, restart) L1's own token stays gone after a reboot", !allTokensAfterRestart.has("l1-token"));
    check("*** PINNED (398f476c MAJOR #3, restart) *** assertRepoNotQuarantined(l2) STILL BLOCKS after clearing L1 + a reboot", fresh.assertRepoNotQuarantined(l2).ok === false);
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
  : `\n❌ SCENARIO ${scenarioName}: ${failures} FAILURE(S) — reproduces board card 883e29bc.`);
process.exit(failures === 0 ? 0 : 1);
