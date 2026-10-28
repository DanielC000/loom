import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2a169469 — make quarantine clear disclosures contributor-aware.
//
// From 58ae4b34's Code Review (reviewer aba50f3e, findings 1 + 3). Since 58ae4b34 widened
// `ownIdentityEntryFor` to also match a query against an entry's `contributorRepoPaths`, a repo (Y) can
// stay genuinely quarantined through a DIFFERENT identity's (X's) contributorRepoPaths, even after Y's
// own record is cleared — but the three clear routes never checked for this:
// - clear-by-id (clearMergeQuarantineLatchFile) decided "lifted" via an identity-EQUALITY test
//   (`after.repoPath === queried identity`), missing a surviving HOST found only via the contributor
//   match — a FALSE SUCCESS (scenario A).
// - clear-by-path (clearMergeQuarantineByRecordedPath) never checked at all — correctly reported
//   `liftedRepoPaths:[]` but with no `stillQuarantined`/`reason`, leaving the human with no explanation
//   (scenario B).
// - /clear (clearMergeQuarantineReporting) already checked (`if (after)`), but `stillQuarantinedReason`'s
//   own wording assumed "same repoPath before/after the clear" meant "its own recorded entry" — wrong
//   when the queried repoPath is a pure contributor that never had a record of its own at all
//   (scenario C).
//
// THE FIX: `stillQuarantinedReason` now takes the QUERIED identity directly (never a pre-clear `before`
// entry) and distinguishes three cases: the queried repoPath's own surviving record ("its own recorded
// entry" — unchanged wording, scenario E), a HOST entry the queried repoPath is a recorded contributor
// of (NEW wording, scenarios A/B/C/D), or a genuinely different, unrelated repo's own separate
// quarantine (unchanged wording, scenario F). Both clear-by-id branches, and a new top-priority branch in
// clear-by-path, now gate on `ownIdentityEntryFor(<queried identity>)` (PURE — own-identity-or-contributor,
// exactly what `resolveGenuinelyLiftedRepoPaths` already uses) rather than `resolveQuarantineFor`'s own
// identity-equality test OR `resolveQuarantineFor` itself.
//
// ROUND 1 (round-1 regression, fixed before round 1 was even reported): a first draft used
// `resolveQuarantineFor`/`activeMergeQuarantineFor` directly for the new checks — `resolveQuarantineFor`'s
// ancestor-walk fallback reaches `activeMergeQuarantineFor`, which can itself MUTATE state (lazy sibling
// absorption, card 8a1bc2ef) as a side effect of being merely QUERIED — exactly the "mutation hazard"
// 4b6c8d24's own decision record already names. Confirmed via a real regression
// (merge-quarantine-raise-protect-failure.mjs's own r2-shared/r2-eperm/crnit2 scenarios). Switched to a
// bare `ownIdentityEntryFor` call to close it (3/3 clean reruns).
//
// ROUND 2 (Code Review 85b2edc7) — BLOCKING: that bare `ownIdentityEntryFor` call was ITSELF wrong in the
// OTHER direction — it matches `contributorRepoPaths` regardless of resolvability, but
// `resolveQuarantineFor` (what `assertRepoNotQuarantined` enforces) only ever consults it for an
// UNRESOLVABLE path — producing a NEW false "still quarantined" for a RESOLVABLE contributor (scenario G).
// FIX: ONE shared, PURE helper — `stillBlockedEntryFor` (exported) — that mirrors `resolveQuarantineFor`'s
// own lookup order EXACTLY (the resolvability split; `ownIdentityEntryFor` only for an unresolvable path;
// the key-based tiers, INCLUDING the ancestor walk, for every path) via a new PURE mirror of
// `activeMergeQuarantineFor` (`activeMergeQuarantineForPeek` — same tier chain, never absorbs a
// cross-tier sibling or graduates a pending entry). Used at ALL THREE routes now, including
// `clearMergeQuarantineReporting`'s own `after` (previously `resolveQuarantineFor` directly) — but its
// `before` DELIBERATELY keeps calling the real, mutating `resolveQuarantineFor` (a real regression this
// card's own round 2 found: a pure `before` leaves a pending-but-now-resolvable entry's latch file kept
// on disk instead of cleanly removed; see the decision record's "before stays impure" section). This
// ALSO closes the pre-existing finding 3: an ancestor-blocked ghost
// subdirectory, in both the ghost (scenario H) and the resolvable real-subdir key-collapse shapes, now
// reports `stillQuarantined` instead of a false "lifted"/"not found" — proven
// SAFE (no mutation hazard reopened) by the SAME raise-protect-failure.mjs regression file staying green.
// Scenario I proves the mirror-of-enforcement invariant directly, across every shape in this file.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — this file is its own driver.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-2a169469-contributor-aware-clear-disclosure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  "clear-by-id-y-is-both-no-false-success",
  "clear-by-path-y-is-both-discloses-reason",
  "clear-by-path-pure-contributor-never-cleared-by-own-path",
  "clear-reporting-pure-contributor-wording",
  "cross-route-agreement-on-same-state",
  "same-identity-wording-unchanged",
  "unrelated-separate-wording-unchanged",
  "resolvable-contributor-no-false-positive",
  "ancestor-blocked-ghost-now-discloses",
  "mirror-of-enforcement-invariant",
  "still-quarantined-with-kept-content",
  "clear-by-id-resolvable-contributor-own-record-wording",
  "offered-clear-by-id-is-real-before-graduation",
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
    ? "\n✅ ALL SCENARIOS PASS — all three clear routes now agree on a contributor-blocked identity, "
      + "with no change to what is lifted and no new mutation hazard."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces/regresses board card 2a169469.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-2a169469-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly, assertRepoNotQuarantined,
  clearMergeQuarantineLatchFile, clearMergeQuarantineByRecordedPath, clearMergeQuarantineReporting,
  enterMergeQuarantine, stillBlockedEntryFor, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
  quarantineLatchFileIdsFor, activeMergeQuarantineFor, directPathIdentity,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// A ghost (never created on disk, genuinely unresolvable) path under a unique tmp prefix.
function ghost(tag) {
  return path.join(os.tmpdir(), `loom-2a169469-${tag}-${sfx}`);
}

// The HOST-CONTRIBUTOR wording clause, shared across the three "Y is both"/"pure contributor" scenarios
// so a wording drift in ANY of them is caught the same way everywhere.
function namesHostContributorClause(reason, hostRepoPath) {
  return typeof reason === "string"
    && reason.includes("recorded CONTRIBUTOR folded into another, still-quarantined entry's own token set")
    && reason.includes(`host repoPath '${hostRepoPath}'`);
}

if (scenarioName === "clear-by-id-y-is-both-no-false-success") {
  // Y: unresolvable, holds its OWN active record at kY. X: unrelated active entry at kX, with
  // contributorRepoPaths:[Y] — the exact "Y is both" shape from the card body.
  const X = ghost("A-X");
  const Y = ghost("A-Y");
  const kX = `kX-${sfx}`;
  const kY = `kY-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (A): active X, unrelated, with Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });
  setActiveQuarantineTestOnly(kY, {
    repoPath: Y, branch: "y-branch", reason: "2a169469 (A): Y's OWN active record",
    enteredAt: Date.now() - 1000, tokens: [`y-token-${sfx}`],
  });

  const id = hashKey(kY);
  const result = clearMergeQuarantineLatchFile(id);
  check("(A) clear-by-id succeeds (ok:true)", result.ok === true);
  // Exact-channel assertions — no `||` fallback: a wrong shape must fail loud, not read as "falsy-empty".
  check("*** THE FIX (A) *** liftedRepoPaths is EXACTLY empty — never a false success naming Y", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 0);
  check("*** THE FIX (A) *** stillQuarantined is EXACTLY true", result.stillQuarantined === true);
  check("*** THE FIX (A) *** reason names X as the host contributor-wise", namesHostContributorClause(result.reason, X));
  check("(A) stillBlockedCoOccupants is EXACTLY empty (X is the BLOCKER, not a co-occupant found by a sweep)", Array.isArray(result.stillBlockedCoOccupants) && result.stillBlockedCoOccupants.length === 0);
  check("(A) latchKept is ABSENT (never surfaced alongside stillQuarantined, matching clearMergeQuarantineReporting's own precedence)", result.latchKept === undefined);
  // The negative control: a real refusal, naming X, confirms this was never actually lifted.
  const after = assertRepoNotQuarantined(Y);
  check("(A negative control) assertRepoNotQuarantined(Y) still refuses after the 'successful' clear", after.ok === false);
  check("(A negative control) the refusal names X", after.ok === false && after.reason.includes(`'${X}'`));
} else if (scenarioName === "clear-by-path-y-is-both-discloses-reason") {
  const X = ghost("B-X");
  const Y = ghost("B-Y");
  const kX = `kX-${sfx}`;
  const kY = `kY-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (B): active X, unrelated, with Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });
  setActiveQuarantineTestOnly(kY, {
    repoPath: Y, branch: "y-branch", reason: "2a169469 (B): Y's OWN active record",
    enteredAt: Date.now() - 1000, tokens: [`y-token-${sfx}`],
  });

  const result = clearMergeQuarantineByRecordedPath(Y);
  check("(B) wasQuarantined is true (Y really was blocked before this call)", result.wasQuarantined === true);
  check("*** THE FIX (B) *** liftedRepoPaths is EXACTLY empty", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 0);
  check("*** THE FIX (B) *** stillQuarantined is EXACTLY true — the human is now told WHY nothing lifted", result.stillQuarantined === true);
  check("*** THE FIX (B) *** reason names X as the host contributor-wise", namesHostContributorClause(result.reason, X));
  check("(B) stillBlockedCoOccupants is EXACTLY empty", Array.isArray(result.stillBlockedCoOccupants) && result.stillBlockedCoOccupants.length === 0);
} else if (scenarioName === "clear-by-path-pure-contributor-never-cleared-by-own-path") {
  // @decision 2a169469 (round 2, minor 3) — Y is a PURE contributor (no record of its own at all).
  // `clearMergeQuarantineByRecordedPath(Y)` must still name the host (minor 3's own ask) — but
  // `wasQuarantined` stays FALSE (82032b5c round 4's "never cleared by its own path" ruling is
  // UNCHANGED: this route genuinely acted on nothing of Y's own). This is DELIBERATELY the one shape
  // where `wasQuarantined:false` and `stillQuarantined:true` coexist — see
  // merge-quarantine-runtime-union-provenance.mjs's own pre-existing "contributor path does nothing"
  // assertions, which this exact fix was verified against (round 2, Code Review).
  const X = ghost("K-X");
  const Y = ghost("K-Y-contributor-only");
  const kX = `kX-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (K): active X, with Y as a PURE contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });

  const result = clearMergeQuarantineByRecordedPath(Y);
  check("*** THE FIX (K, minor 3) *** wasQuarantined is EXACTLY false — never cleared by its own path", result.wasQuarantined === false);
  check("*** THE FIX (K, minor 3) *** stillQuarantined is EXACTLY true", result.stillQuarantined === true);
  check("*** THE FIX (K, minor 3) *** reason names X as the host, instead of a bare not-found", namesHostContributorClause(result.reason, X));
  check("(K) Y is still genuinely blocked afterward, via X", !assertRepoNotQuarantined(Y).ok);
} else if (scenarioName === "clear-reporting-pure-contributor-wording") {
  // Y is a PURE contributor — it never has a record of its own at all, only named in X's
  // contributorRepoPaths. This is the shape that actually exercises the WRONG "its own recorded entry"
  // wording (the "Y is both" shape above instead produces the correct, pre-existing "ANOTHER repo's own
  // separate quarantine" text, since `before` also resolves to X before this card's fix).
  const X = ghost("C-X");
  const Y = ghost("C-Y-contributor-only");
  const kX = `kX-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (C): active X, with Y as a PURE contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });

  const result = clearMergeQuarantineReporting(Y);
  check("(C) wasQuarantined is true", result.wasQuarantined === true);
  check("*** THE FIX (C) *** reason names X contributor-wise, never 'its own recorded entry'", namesHostContributorClause(result.reason, X) && !result.reason.includes("its own recorded entry"));
  check("(C) liftedRepoPaths is EXACTLY empty", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 0);
} else if (scenarioName === "cross-route-agreement-on-same-state") {
  // Three INDEPENDENT "Y is both" fixtures (disjoint identities, one per route) — proving all three
  // routes say the SAME thing (the host-contributor clause) for the SAME kind of state, not just that
  // each one individually got fixed.
  const build = (tag) => {
    const X = ghost(`D-${tag}-X`);
    const Y = ghost(`D-${tag}-Y`);
    const kX = `kX-${tag}-${sfx}`;
    const kY = `kY-${tag}-${sfx}`;
    setActiveQuarantineTestOnly(kX, {
      repoPath: X, branch: "x-branch", reason: `2a169469 (D-${tag}): active X, with Y as a contributor`,
      enteredAt: Date.now(), tokens: [`x-token-${tag}-${sfx}`], contributorRepoPaths: [Y],
    });
    setActiveQuarantineTestOnly(kY, {
      repoPath: Y, branch: "y-branch", reason: `2a169469 (D-${tag}): Y's OWN active record`,
      enteredAt: Date.now() - 1000, tokens: [`y-token-${tag}-${sfx}`],
    });
    return { X, Y, kY };
  };

  const idPair = build("id");
  const idResult = clearMergeQuarantineLatchFile(hashKey(idPair.kY));
  const pathPair = build("path");
  const pathResult = clearMergeQuarantineByRecordedPath(pathPair.Y);
  const reportingPair = build("reporting");
  const reportingResult = clearMergeQuarantineReporting(reportingPair.Y);

  check("(D) clear-by-id discloses the host-contributor clause", namesHostContributorClause(idResult.reason, idPair.X));
  check("(D) clear-by-path discloses the host-contributor clause", namesHostContributorClause(pathResult.reason, pathPair.X));
  check("(D) /clear discloses the host-contributor clause", namesHostContributorClause(reportingResult.reason, reportingPair.X));
  check("*** THE FIX (D) *** all three routes agree: stillQuarantined/wasQuarantined all read as still-blocked, none claims a false lift",
    idResult.stillQuarantined === true && idResult.liftedRepoPaths.length === 0
    && pathResult.stillQuarantined === true && pathResult.liftedRepoPaths.length === 0
    && reportingResult.wasQuarantined === true && reportingResult.liftedRepoPaths.length === 0);
} else if (scenarioName === "same-identity-wording-unchanged") {
  // d4b25feb's "two independent raise-groups" shape: X has an ACTIVE record AND a wholly separate,
  // independent PENDING record (disjoint tokens, never tied to the active one) — clearing the active one
  // by id must still report `stillQuarantined` with the UNCHANGED "its own recorded entry" wording, never
  // the new contributor clause (X is not a contributor of anything — it is blocked by its OWN second
  // record).
  const X = ghost("E-X");
  const kX = `kX-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch-active", reason: "2a169469 (E): X's own ACTIVE record",
    enteredAt: Date.now(), tokens: [`x-active-token-${sfx}`],
  });
  pushPendingQuarantineTestOnly({
    repoPath: X, branch: "x-branch-pending", reason: "2a169469 (E): X's own INDEPENDENT pending record",
    enteredAt: Date.now() - 1000, tokens: [`x-pending-token-${sfx}`],
  }, `pending-${hashKey(X)}.json`);

  const result = clearMergeQuarantineLatchFile(hashKey(kX));
  check("(E) clear-by-id on the active record succeeds", result.ok === true);
  check("*** UNCHANGED (E) *** stillQuarantined is true (X's own independent pending record survives)", result.stillQuarantined === true);
  check("*** UNCHANGED (E) *** reason uses the pre-existing 'its own recorded entry' wording", (result.reason ?? "").includes("its own recorded entry"));
  check("*** UNCHANGED (E) *** reason does NOT use the new contributor wording", !(result.reason ?? "").includes("recorded CONTRIBUTOR"));
} else if (scenarioName === "unrelated-separate-wording-unchanged") {
  // Exercises clearMergeQuarantineReporting against the ancestor-walk-to-a-genuinely-unrelated-entry
  // shape: r is actively quarantined; querying a never-raised ghost SUBDIRECTORY of r (never itself
  // quarantined, no identity/contributor relationship to r at all) must still read `reason` with the
  // pre-existing "ANOTHER repo's own, separate quarantine" wording, never the new contributor clause (the
  // ghost is not r's contributor). Round 2: this route now goes through `stillBlockedEntryFor` (same as
  // the other two), but the wording is unchanged — the ancestor branch of `stillQuarantinedReason` was
  // never touched, only WHICH function computes `after`/`before`.
  const repo = ghost("F-r");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  enterMergeQuarantine(repo, "r-branch", "2a169469 (F): r's own real raise");
  const ghostSubdir = path.join(repo, "never-raised-subdir");

  const result = clearMergeQuarantineReporting(ghostSubdir);
  check("(F) wasQuarantined is true (the subdirectory read as blocked via r's own ancestor quarantine)", result.wasQuarantined === true);
  check("*** UNCHANGED (F) *** reason uses the pre-existing 'ANOTHER repo's own, separate quarantine' wording", (result.reason ?? "").includes("ANOTHER repo's own, separate quarantine"));
  check("*** UNCHANGED (F) *** reason does NOT use the new contributor wording", !(result.reason ?? "").includes("recorded CONTRIBUTOR"));
  check("*** UNCHANGED (F) *** reason does NOT use the own-record wording either (the ghost never has its own)", !(result.reason ?? "").includes("its own recorded entry"));
} else if (scenarioName === "resolvable-contributor-no-false-positive") {
  // ROUND 2 BLOCKING finding (Code Review 85b2edc7): a ghost X active at kX names a RESOLVABLE Y as a
  // contributor, but Y ALSO has its own REAL raise. `ownIdentityEntryFor` matches `contributorRepoPaths`
  // regardless of resolvability, but `resolveQuarantineFor` (what `assertRepoNotQuarantined` enforces)
  // only ever consults it for an UNRESOLVABLE path — so clearing Y by id must report `lifted:[Y]`,
  // EXACTLY matching main, never a false `stillQuarantined` steering the human at X instead.
  const X = ghost("G-X"); // never created — the (irrelevant) ghost naming Y as a contributor
  const Y = ghost("G-Y-real");
  fs.mkdirSync(Y, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: Y });
  const kX = `kX-${sfx}`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (G): ghost X, with RESOLVABLE Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });
  enterMergeQuarantine(Y, "y-branch", "2a169469 (G): Y's OWN real raise");
  const yId = quarantineLatchIdFor(Y);

  const result = clearMergeQuarantineLatchFile(yId);
  check("(G) clear-by-id succeeds (ok:true)", result.ok === true);
  check("*** THE FIX (G, round 2) *** liftedRepoPaths is EXACTLY [Y] — matching main, never a false stillQuarantined", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 1 && result.liftedRepoPaths[0] === Y);
  check("*** THE FIX (G, round 2) *** stillQuarantined is ABSENT", result.stillQuarantined === undefined);
  check("(G) a direct query for Y now correctly succeeds", assertRepoNotQuarantined(Y).ok === true);
} else if (scenarioName === "ancestor-blocked-ghost-now-discloses") {
  // Closes finding 3 (pre-existing): d is its OWN entry (independent of r), but d is ALSO a ghost
  // subdirectory of a genuinely, separately, actively-quarantined real repo r. Clearing d's own record
  // must now disclose that d is STILL blocked — via r's own ancestor quarantine — never a false "lifted".
  const r = ghost("H-r");
  fs.mkdirSync(r, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: r });
  enterMergeQuarantine(r, "r-branch", "2a169469 (H): r's own real, independent raise");
  const d = path.join(r, "ghost-subdir-with-its-own-unrelated-record");
  const kD = `kD-${sfx}`;
  setActiveQuarantineTestOnly(kD, {
    repoPath: d, branch: "d-branch", reason: "2a169469 (H): d's own UNRELATED record, never tied to r",
    enteredAt: Date.now(), tokens: [`d-token-${sfx}`],
  });

  const result = clearMergeQuarantineByRecordedPath(d);
  check("(H) wasQuarantined is true (d really had its own record before this call)", result.wasQuarantined === true);
  check("*** THE FIX (H, round 2) *** liftedRepoPaths is EXACTLY empty — d is NOT falsely reported lifted", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 0);
  check("*** THE FIX (H, round 2) *** stillQuarantined is EXACTLY true", result.stillQuarantined === true);
  check("*** THE FIX (H, round 2) *** reason names r as the ancestor blocker", typeof result.reason === "string" && result.reason.includes(`'${r}'`));
  check("(H) a direct query for d still correctly refuses, naming r", !assertRepoNotQuarantined(d).ok);
} else if (scenarioName === "mirror-of-enforcement-invariant") {
  // Code Review 85b2edc7's own required proof: for every probed shape,
  // `!!stillBlockedEntryFor(identity) === !assertRepoNotQuarantined(identity).ok` — the shared helper
  // never disagrees with real enforcement about WHETHER an identity is blocked (it may legitimately
  // differ on WORDING/relation, which `stillQuarantinedReason` handles — never on the boolean itself).
  const shapes = [];
  { // (i) Y's own record, unresolvable — blocked by itself.
    const Y = ghost("I1-Y");
    const kY = `kY-${sfx}`;
    setActiveQuarantineTestOnly(kY, { repoPath: Y, branch: "b", reason: "2a169469 (I1)", enteredAt: Date.now(), tokens: [`t-${sfx}-i1`] });
    shapes.push({ label: "(I1) own unresolvable record", identity: Y });
  }
  { // (ii) Y unresolvable, PURE contributor of ghost X — blocked via the contributor relation.
    const X = ghost("I2-X");
    const Y = ghost("I2-Y-contributor-only");
    const kX = `kX-${sfx}`;
    setActiveQuarantineTestOnly(kX, { repoPath: X, branch: "b", reason: "2a169469 (I2)", enteredAt: Date.now(), tokens: [`t-${sfx}-i2`], contributorRepoPaths: [Y] });
    shapes.push({ label: "(I2) pure unresolvable contributor", identity: Y });
  }
  { // (iii) Y RESOLVABLE, named as a contributor of ghost X — NOT blocked (round 2's own fix).
    const X = ghost("I3-X");
    const Y = ghost("I3-Y-real");
    fs.mkdirSync(Y, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: Y });
    const kX = `kX-${sfx}`;
    setActiveQuarantineTestOnly(kX, { repoPath: X, branch: "b", reason: "2a169469 (I3)", enteredAt: Date.now(), tokens: [`t-${sfx}-i3`], contributorRepoPaths: [Y] });
    shapes.push({ label: "(I3) resolvable contributor (round-2 fix)", identity: Y });
  }
  { // (iv) a never-quarantined resolvable path — not blocked.
    const Z = ghost("I4-Z-real-never-quarantined");
    fs.mkdirSync(Z, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: Z });
    shapes.push({ label: "(I4) never-quarantined resolvable path", identity: Z });
  }
  { // (v) a ghost subdirectory of a genuinely, actively-quarantined real ancestor — blocked via ancestor.
    const r = ghost("I5-r");
    fs.mkdirSync(r, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: r });
    enterMergeQuarantine(r, "b", "2a169469 (I5)");
    shapes.push({ label: "(I5) ancestor-blocked ghost subdirectory", identity: path.join(r, "ghost-subdir") });
  }
  { // (vi) same-identity two-independent-records (d4b25feb) — blocked via its own second record.
    const X = ghost("I6-X");
    const kX = `kX-${sfx}`;
    setActiveQuarantineTestOnly(kX, { repoPath: X, branch: "b-active", reason: "2a169469 (I6) active", enteredAt: Date.now(), tokens: [`t-${sfx}-i6a`] });
    pushPendingQuarantineTestOnly({ repoPath: X, branch: "b-pending", reason: "2a169469 (I6) pending", enteredAt: Date.now() - 1000, tokens: [`t-${sfx}-i6p`] }, `pending-${hashKey(X)}.json`);
    shapes.push({ label: "(I6) same-identity independent second record", identity: X });
  }

  for (const { label, identity } of shapes) {
    const helperVerdict = !!stillBlockedEntryFor(identity);
    const enforcementVerdict = !assertRepoNotQuarantined(identity).ok;
    check(`*** THE INVARIANT (I) *** ${label}: helper(${helperVerdict}) === enforcement(${enforcementVerdict})`, helperVerdict === enforcementVerdict);
  }

  // ROUND 3 (NIT 4) — the invariant above checks `stillBlockedEntryFor` directly, never a real clear
  // ROUTE's own `stillQuarantined` field. Loop a SECOND set of shapes × the three real clear routes,
  // each built FRESH per (shape, route) so clearing one never contaminates another's state, asserting
  // AFTER each route's clear that its own `stillQuarantined` agrees with enforcement AND that the
  // NAMED BLOCKER (parsed from each side's own reason text) agrees too — never just the boolean.
  const namedBlockerFromRouteReason = (reason) => {
    const m = typeof reason === "string" ? reason.match(/repoPath '([^']+)'/) : null;
    return m ? m[1] : undefined;
  };
  const namedBlockerFromAssertion = (verdict) => {
    if (verdict.ok) return undefined;
    const m = verdict.reason.match(/blocking repo '([^']+)'/);
    return m ? m[1] : undefined;
  };
  const routeShapes = [
    {
      // Round 2's own (G) shape, but exercised via the two PATH-addressed routes (G itself only covers
      // clear-by-id) — a RESOLVABLE contributor must never be falsely reported stillQuarantined.
      name: "resolvable contributor",
      routes: ["clear-by-path", "clear-reporting"],
      expectBlockedAfter: false,
      build: (tag) => {
        const X = ghost(`${tag}-X`);
        const Y = ghost(`${tag}-Y-real`);
        fs.mkdirSync(Y, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: Y });
        const kX = `kX-${sfx}-${tag}`;
        setActiveQuarantineTestOnly(kX, {
          repoPath: X, branch: "x-branch", reason: `2a169469 (I-route, ${tag}): ghost X, with RESOLVABLE Y as a contributor`,
          enteredAt: Date.now(), tokens: [`x-token-${sfx}-${tag}`], contributorRepoPaths: [Y],
        });
        enterMergeQuarantine(Y, "y-branch", `2a169469 (I-route, ${tag}): Y's OWN real raise`);
        return { identity: Y };
      },
    },
    {
      // A ghost subdirectory of a real ancestor `r` that holds ONLY a PENDING (never-active) entry for
      // itself — the ancestor walk must reach the pending tier too, not just the active one (round 2's
      // own scenario H only ever covers an ACTIVE ancestor).
      name: "pending-tier ancestor",
      routes: ["clear-by-path", "clear-reporting"],
      expectBlockedAfter: true,
      build: (tag) => {
        const r = ghost(`${tag}-r`);
        fs.mkdirSync(r, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: r });
        pushPendingQuarantineTestOnly({
          repoPath: r, branch: "r-branch", reason: `2a169469 (I-route, ${tag}): r's own PENDING (never-active) raise`,
          enteredAt: Date.now(), tokens: [`r-token-${sfx}-${tag}`],
        }, `pending-${hashKey(r)}-${tag}.json`);
        const ghostSub = path.join(r, "ghost-subdir");
        return { identity: ghostSub, expectedBlockerRepoPath: r };
      },
    },
    {
      // MINOR 1's own shape: `r` active (NEWER enteredAt); a resolvable real subdirectory `r/sub`
      // (no own `.git`, so it canonically collapses onto `r`'s own key) PENDING at that same key with an
      // OLDER enteredAt; a GHOST subdirectory `r/ghostsub` with its OWN, independent active record.
      // `unionQuarantineEntries` keeps the OLDER side's identity, so absorbing `r/sub` into `r` on a
      // cross-tier sibling union hands the WINNING `repoPath` to `r/sub`, never to `r` itself — every
      // route's disclosure must name `r/sub`, matching what `assertRepoNotQuarantined` actually enforces.
      name: "cross-tier sibling union changes the winning identity (minor 1)",
      routes: ["clear-by-id", "clear-by-path", "clear-reporting"],
      expectBlockedAfter: true,
      build: (tag) => {
        const r = ghost(`${tag}-r`);
        fs.mkdirSync(r, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: r });
        enterMergeQuarantine(r, "r-branch", `2a169469 (I-route, ${tag}): r's own active raise (newer)`);
        const sub = path.join(r, "sub");
        fs.mkdirSync(sub, { recursive: true }); // no nested .git — canonically collapses onto r's own key
        pushPendingQuarantineTestOnly({
          repoPath: sub, branch: "sub-branch", reason: `2a169469 (I-route, ${tag}): r/sub pending (OLDER)`,
          enteredAt: Date.now() - 60_000, tokens: [`sub-token-${sfx}-${tag}`],
        }, `pending-${hashKey(sub)}-${tag}.json`);
        const ghostSub = path.join(r, "ghostsub");
        const kGhostSub = `kGhostSub-${sfx}-${tag}`;
        setActiveQuarantineTestOnly(kGhostSub, {
          repoPath: ghostSub, branch: "ghostsub-branch", reason: `2a169469 (I-route, ${tag}): ghostSub's OWN independent active record`,
          enteredAt: Date.now(), tokens: [`ghostsub-token-${sfx}-${tag}`],
        });
        return { identity: ghostSub, ownId: hashKey(kGhostSub), expectedBlockerRepoPath: sub };
      },
    },
  ];

  for (const shape of routeShapes) {
    for (const route of shape.routes) {
      const tag = `I-route-${route}-${Math.random().toString(36).slice(2, 7)}`;
      const { identity, ownId, expectedBlockerRepoPath } = shape.build(tag);
      const result = route === "clear-by-id" ? clearMergeQuarantineLatchFile(ownId)
        : route === "clear-by-path" ? clearMergeQuarantineByRecordedPath(identity)
        : clearMergeQuarantineReporting(identity);
      const assertion = assertRepoNotQuarantined(identity);
      const enforcementBlocked = !assertion.ok;
      // `clearMergeQuarantineReporting` (route 3, "/clear") has NO `stillQuarantined` field of its own —
      // see the decision record's own "do not read the three routes as agreeing on every field" rule.
      // Its "still blocked" signal is a `reason` shaped like `stillQuarantinedReason`'s own output
      // (the ONLY branch that embeds a `repoPath '...'` clause); routes 1/2 keep their real field.
      const routeBlocked = route === "clear-reporting"
        ? namedBlockerFromRouteReason(result.reason) !== undefined
        : result.stillQuarantined === true;
      check(`*** THE INVARIANT (I-route) *** ${shape.name} via ${route}: stillQuarantined(${routeBlocked}) === enforcement(${enforcementBlocked}) === expected(${shape.expectBlockedAfter})`,
        routeBlocked === enforcementBlocked && routeBlocked === shape.expectBlockedAfter);
      if (enforcementBlocked) {
        const routeBlocker = namedBlockerFromRouteReason(result.reason);
        const enforcementBlocker = namedBlockerFromAssertion(assertion);
        check(`*** THE INVARIANT (I-route) *** ${shape.name} via ${route}: named blocker agrees (route '${routeBlocker}' === enforcement '${enforcementBlocker}')`,
          routeBlocker !== undefined && routeBlocker === enforcementBlocker);
        if (expectedBlockerRepoPath !== undefined) {
          check(`*** THE INVARIANT (I-route) *** ${shape.name} via ${route}: named blocker is the expected '${expectedBlockerRepoPath}'`,
            routeBlocker === expectedBlockerRepoPath);
        }
      }
    }
  }
} else if (scenarioName === "still-quarantined-with-kept-content") {
  // Minor 2's own explicit ask: `stillQuarantined` and a kept-content disclosure can fire TOGETHER —
  // clear-by-path must carry BOTH, never dropping the kept-file fields just because stillQuarantined
  // now takes precedence for the `reason`/lift decision.
  const X = ghost("J-X");
  const Y = ghost("J-Y");
  const Z = ghost("J-Z-foreign-content-owner");
  const kX = `kX-${sfx}`;
  const kY = `kY-${sfx}`;
  const orphanBasename = `${hashKey(`j-orphan-${sfx}`)}.json`;
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (J): active X, unrelated, with Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });
  setActiveQuarantineTestOnly(kY, {
    repoPath: Y, branch: "y-branch", reason: "2a169469 (J): Y's OWN active record, carrying an orphan reference",
    enteredAt: Date.now() - 1000, tokens: [`y-token-${sfx}`], orphanLatchFiles: [orphanBasename],
  });
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasename), JSON.stringify({
    repoPath: Z, branch: "z-branch", reason: "2a169469 (J): foreign content, written at Y's own orphan reference",
    enteredAt: Date.now(), tokens: [`z-token-${sfx}`],
  }));

  const result = clearMergeQuarantineByRecordedPath(Y);
  check("(J) wasQuarantined is true", result.wasQuarantined === true);
  check("*** THE FIX (J) *** liftedRepoPaths is EXACTLY empty", Array.isArray(result.liftedRepoPaths) && result.liftedRepoPaths.length === 0);
  check("*** THE FIX (J, minor 2) *** stillQuarantined is EXACTLY true", result.stillQuarantined === true);
  check("*** THE FIX (J, minor 2) *** reason names X as the host contributor-wise", namesHostContributorClause(result.reason, X));
  check("*** THE FIX (J, minor 2) *** latchKept/contentKeptRepoPaths are CARRIED ALONGSIDE stillQuarantined, never dropped", result.latchKept === true && Array.isArray(result.contentKeptRepoPaths) && result.contentKeptRepoPaths.includes(Z));
} else if (scenarioName === "clear-by-id-resolvable-contributor-own-record-wording") {
  // ROUND 4, item 1 (Code Review ff7ea5aa). Real X with an active entry carrying contributorRepoPaths:[Y];
  // Y is a REAL, RESOLVABLE subdirectory of X (no own `.git`) with its OWN, SEPARATE active record.
  // Clearing Y's OWN id lifts that separate record — and, as a side effect of card 3b1944b6's own
  // shared `preClearForeignKeyStamp` chokepoint (every route clearing an identity's own record while its
  // fresh key is foreign durably marks the foreign entry's `reducedContributorRepoPaths`), durably marks
  // Y's identity onto X too.
  //
  // @decision 8d775613 (round 2) — a `reducedContributorRepoPaths` match's text is the NEUTRAL "recorded
  // as reduced" wording, unconditionally — never "ANOTHER repo's own" (this scenario's own ORIGINAL pin,
  // now stale) and never the CONTRIBUTOR/token-set clause (Y's token was never inside X's set).
  const X = ghost("L-X");
  fs.mkdirSync(X, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: X });
  const Y = path.join(X, "sub"); // resolvable, no own .git — collapses onto X's own canonical key
  fs.mkdirSync(Y, { recursive: true });
  // X is RESOLVABLE here (unlike the ghost-X shapes elsewhere in this file) — it must be armed at its
  // OWN REAL canonical key, or the key-based `direct` lookup `activeMergeQuarantineForPeek` performs for
  // a resolvable query (Y) never finds it at all (an arbitrary ghost-style key only works for an
  // UNRESOLVABLE X, found via `ownIdentityEntryFor`'s identity scan instead).
  const kX = canonicalRepoLockKey(X);
  setActiveQuarantineTestOnly(kX, {
    repoPath: X, branch: "x-branch", reason: "2a169469 (L): active X, carrying resolvable Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-${sfx}`], contributorRepoPaths: [Y],
  });
  const kYown = `kYown-${sfx}`;
  setActiveQuarantineTestOnly(kYown, {
    repoPath: Y, branch: "y-branch", reason: "2a169469 (L): Y's OWN separate active record",
    enteredAt: Date.now(), tokens: [`y-own-token-${sfx}`],
  });
  const idYown = hashKey(kYown);

  const result = clearMergeQuarantineLatchFile(idYown);
  check("(L) clear-by-id on Y's own record succeeds (ok:true)", result.ok === true);
  check("(L) stillQuarantined is EXACTLY true (X still blocks Y via the ordinary key-collapse tier)", result.stillQuarantined === true);
  check("*** THE FIX (L, round 4 item 1) *** reason does NOT use the contributor clause", !namesHostContributorClause(result.reason, X));
  check("(L precondition) X is durably marked with Y's identity in reducedContributorRepoPaths (the shared preClearForeignKeyStamp chokepoint)", (activeMergeQuarantineFor(X)?.reducedContributorRepoPaths ?? []).includes(directPathIdentity(Y)));
  check("*** THE FIX (L, round 2 of 8d775613) *** reason is the NEUTRAL 'recorded as reduced' wording, never 'ANOTHER repo's own, separate quarantine'", typeof result.reason === "string" && result.reason.includes("recorded as reduced under") && !result.reason.includes("ANOTHER repo's own, separate quarantine"));
  check("(L negative control) assertRepoNotQuarantined(Y) still refuses after Y's own record is cleared", !assertRepoNotQuarantined(Y).ok);
  check("(L negative control) the refusal names X", !assertRepoNotQuarantined(Y).ok && assertRepoNotQuarantined(Y).reason.includes(`'${X}'`));
} else if (scenarioName === "offered-clear-by-id-is-real-before-graduation") {
  // ROUND 4, item 2 (Code Review ff7ea5aa). `quarantineLatchFileIdsFor`'s old fallback — for a SYNTHETIC,
  // not-yet-graduated Peek union with no real backing of its own — offered `quarantineHashFor(winner.repoPath)`,
  // the hash of the key the union WILL occupy AFTER graduation. No file exists there yet: a human (or this
  // exact reason text's own clear-by-id suggestion) acting on that id got a false `{wasQuarantined:false}`
  // while the repo stayed genuinely blocked. Two of the reviewer's own named repro shapes, each queried
  // BEFORE any enforcement call (so nothing has graduated yet) via the SAME `stillBlockedEntryFor`
  // (pure) + `quarantineLatchFileIdsFor` path `stillQuarantinedReason` itself uses to pick the offered id.
  const mk = (repoPath, ageMs, tag) => ({
    repoPath, branch: `b-${tag}`, reason: `2a169469 (round 4, item 2): ${tag}`,
    enteredAt: Date.now() - ageMs, tokens: [`t-${sfx}-${tag}`],
  });
  const offeredIdIsReal = (identity, label) => {
    const before = stillBlockedEntryFor(identity);
    check(`(${label}) a blocker is found pre-graduation`, !!before);
    const offeredId = before ? quarantineLatchFileIdsFor(before)[0] : undefined;
    check(`(${label}) an id was offered`, typeof offeredId === "string" && offeredId.length > 0);
    const r = offeredId ? clearMergeQuarantineLatchFile(offeredId) : undefined;
    // THE BUG: a fabricated future-key id matches NO real entry, so clear-by-id reports
    // `wasQuarantined:false` (a false no-op) while `before` proves the repo IS genuinely blocked.
    check(`*** THE FIX (${label}, round 4 item 2) *** the offered id's own clear-by-id is REAL (wasQuarantined true — it lifted or touched a genuine entry, never a false no-op)`,
      r !== undefined && r.ok === true && r.wasQuarantined === true);
  };

  { // Shape 1 (reviewer's "multi-pending-plus-sibling"): r and r/sub each hold TWO pending entries;
    // r/sub's OLDEST entry wins the union identity. Query r itself, before any enforcement call.
    const r = ghost("M1-r");
    fs.mkdirSync(r, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: r });
    const sub = path.join(r, "sub");
    fs.mkdirSync(sub, { recursive: true });
    pushPendingQuarantineTestOnly(mk(r, 0, "m1-r-a"), `pending-${hashKey(`m1-r-a-${sfx}`)}.json`);
    pushPendingQuarantineTestOnly(mk(r, 30_000, "m1-r-b"), `pending-${hashKey(`m1-r-b-${sfx}`)}.json`);
    pushPendingQuarantineTestOnly(mk(sub, 10_000, "m1-sub-a"), `pending-${hashKey(`m1-sub-a-${sfx}`)}.json`);
    pushPendingQuarantineTestOnly(mk(sub, 90_000, "m1-sub-b"), `pending-${hashKey(`m1-sub-b-${sfx}`)}.json`); // oldest overall
    offeredIdIsReal(r, "M1");
  }
  { // Shape 2 (reviewer's "ancestor-fallback-with-older-sibling"): r pending; r/sub pending, OLDER —
    // wins the union identity. Query a GHOST subdirectory of r, before any enforcement call.
    const r = ghost("M2-r");
    fs.mkdirSync(r, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: r });
    pushPendingQuarantineTestOnly(mk(r, 0, "m2-r"), `pending-${hashKey(`m2-r-${sfx}`)}.json`);
    const sub = path.join(r, "sub");
    fs.mkdirSync(sub, { recursive: true });
    pushPendingQuarantineTestOnly(mk(sub, 60_000, "m2-sub"), `pending-${hashKey(`m2-sub-${sfx}`)}.json`); // older: wins
    const ghostSub = path.join(r, "ghost-subdir");
    offeredIdIsReal(ghostSub, "M2");
  }
} else {
  throw new Error(`unknown scenario: ${scenarioName}`);
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);
