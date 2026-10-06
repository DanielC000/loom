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
  "pass1", "pass1b", "residual", "negative-control-cross-key", "direct-verified-guard",
  "clear-x-unmounted", "clear-r-truthful-reporting",
  "stale-armedkeys-no-collateral", "clear-unmasks-different-blocker", "clear-stale-pending-not-blocking",
  "token-clear-identity-drift", "deferred-flush-no-stale-snapshot",
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
  clearMergeQuarantineByToken, quarantineLatchIdFor,
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
    // from the registered-repo-paths list passed to reenterMergeQuarantinesAtBoot — including it would
    // make PASS 1b's EARLIER, unrelated `matchedRepo && cleanlyParsedKeys.has(canonicalRepoLockKey(
    // matchedRepo))` guard recompute `canonicalRepoLockKey(nested)` fresh (degraded, since nested stays
    // unresolvable here) = Kr, which IS in cleanlyParsedKeys (T's own clean parse added it) — a DIFFERENT,
    // adjacent false-positive (reported separately, not fixed by this card) that would silently unlink X's
    // tmp as "already-superseded stale residue" before ever reaching the dual-arm code this scenario
    // targets. Omitting it isolates the dual-arm shape this card's fix actually changes.
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
    // SCENARIO deferred-flush-no-stale-snapshot — discriminates round 2's own finding-5 fix (deferred
    // divert flush) directly: X1 and X2 are BOTH unresolvable, BOTH with resolvedKey manufactured to the
    // SAME colliding value — a legitimate same-pass union at that key (armQuarantineKey unions
    // unconditionally, by design, for two entries genuinely sharing a key). Whichever is processed FIRST
    // (readdir order, never assumed) would have its OWN immediate push be a STALE pre-union snapshot if
    // PASS 1 pushed right away instead of deferring — this assertion is order-independent: it only checks
    // the FINAL listing is consistent (exactly one entry for this key, carrying BOTH tokens), which a
    // stale snapshot would violate regardless of which side went stale.
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
