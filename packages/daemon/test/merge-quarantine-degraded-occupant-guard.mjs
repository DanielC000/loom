import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e1cb7d33 (from Code Review baecb690 of a2f381dc) — the PERSISTENCE half of the M-2 identity
// shape 398f476c covers for queries: `activeMergeQuarantineFor`'s fast-path sibling absorb
// (`consumeMatchedPendingsIntoArmedEntry` -> `writeMergeQuarantineLatch`) wrote a runtime union straight
// to a key's physical file WITHOUT checking whether that key's own file is a DIFFERENT, currently-
// unresolvable entry's (a degraded occupant's) exclusive backing — the boot passes already check this
// (`degradedOccupiedKeys`/`bootWriteLatch`), but the runtime write path did not.
//
// Repro shape: ghost X (unresolvable, resolvedKey=Kp) with its own final latch physically AT sha(Kp).json;
// teamA (S) is a subdir of a real repo `repo` that collapses onto the SAME canonical key Kp (card
// 7673d096), with its own SEPARATE, legacy-keyed stale latch that boot migrates into Kp. Before this card,
// the first runtime query/raise touching S's own slot overwrote X's file and unlinked S's stale source —
// destroying X's only durable copy.
//
// LEAD RULINGS (gen 407, after worker 07f6bab0's progress report) are now the spec:
// (1) writeMergeQuarantineLatch's own degraded-occupant guard is DEFAULT-ON, with TWO explicit opt-out
//     families, never just one: bootWriteLatch (Phase 0's safety-tmp already secures boot writes) AND
//     enterMergeQuarantine's own 4 write call sites (a refused RAISE is never persisted, so it would be
//     silently lost at the next reboot — see ruling (3) below for the full reasoning).
// (2) The runtime sibling absorb AND the symmetric lazy-graduation branch REFUSE (both funnel through
//     consumeMatchedPendingsIntoArmedEntry's own single write call, so both inherit the default-on guard
//     for free — this file's own scenarios below drive each branch separately to prove both actually do).
// (3) enterMergeQuarantine (a fresh RAISE) is an explicit OPT-OUT of the guard, exactly like
//     bootWriteLatch — a refused raise is NEVER persisted, so it would be lost at the next reboot
//     (enforcement fails OPEN), which is WORSE than this card's own pre-existing behavior (the raise
//     overwrites the degraded occupant's file, destroying its identity, but the raise itself survives).
//     This file's `fresh-raise-survives-reboot` scenario proves the opt-out restores that pre-fix
//     behavior for the raise (durable across a reboot). The residual this card ITSELF documented (a
//     raise in this exact shape overwrites the degraded occupant's own file) is now FIXED by card
//     `1922be3a` — `enterMergeQuarantine` durably protects the occupant's content aside FIRST, reusing
//     `d163aef5`'s own protect/ownership machinery, before either of its "no `existing`" writes can
//     destroy it. See docs/decisions/1922be3a-*.md.
// (4) clear(S) (an ORDINARY clear of a resolvable repo colliding with a degraded occupant's own key) is
//     OUT OF SCOPE for this card — a draft ruling to refuse it was tried and RETRACTED: card `d4b25feb`
//     already owns this exact consequence (deliberately deferred by 4480b077), and the established
//     precedent (4480b077/883e29bc's own tests) is that the clear PROCEEDS. See the decision record for
//     the full retraction + the union-keys false-positive that also made the refusal the wrong mechanism.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-degraded-occupant-guard.mjs
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
  "runtime-sibling-absorb-refuses-direct-path",
  "runtime-lazy-graduation-refuses",
  "fresh-raise-survives-reboot",
  "pending-merge-fresh-raise-survives-reboot",
  "negative-control-resolvable-occupant-still-overwrites",
  "walkup-raise-protects-pending-occupant-then-clears",
  "existing-branch-raise-protects-foreign-pending-occupant",
  "existing-branch-raise-still-overwrites-own-union-content",
  "existing-branch-raise-token-overlap-pins-no-spurious-divert",
  "round2-protect-splice-does-not-corrupt-own-sibling-index",
  "round2-protect-does-not-duplicate-already-active-occupant",
  "partial-overlap-pending-leftover-stays-blocked-until-both-tokens-cleared",
  "extra-pending-token-stays-blocked-until-cleared",
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
    ? "\n✅ ALL SCENARIOS PASS — a runtime write never destroys a degraded occupant's only durable copy "
      + "(both the sibling-absorb and lazy-graduation branches refuse, in BOTH tie-break age orders); a "
      + "fresh raise is durable across a reboot via BOTH of enterMergeQuarantine's own opt-out shapes, and "
      + "(card 1922be3a) now durably PROTECTS the occupant's own content aside first, in both the "
      + "brand-new-entry branch (a VERIFIED raiser) and the literal walk-up-under-the-raiser shape, rather "
      + "than overwriting it; the pending-merge branch's own residual (an UNVERIFIED raiser) IS fixed "
      + "separately (card d4b25feb — that branch no longer reaches writeMergeQuarantineLatch at all for an "
      + "unverified raiser). The guard still allows a legitimate resolvable-different-identity overwrite "
      + "THROUGH A GUARDED CALLER (never the opted-out enterMergeQuarantine path). clear(S) is deliberately "
      + "out of scope — see the decision record. (Card e0192ffb) the `existing`-truthy region's own two "
      + "writes now ALSO durably protect a foreign, unresolvable pending occupant's sole physical copy "
      + "first (token-overlap discriminated), while still legitimately overwriting the raiser's own "
      + "already-won union content in place when no foreign occupant is present."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card e1cb7d33 / 1922be3a / e0192ffb.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqdog-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, enterMergeQuarantine, clearMergeQuarantine,
  clearMergeQuarantineByToken, MERGE_QUARANTINE_DIR, listActiveMergeQuarantines, assertRepoNotQuarantined,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqdog@loom -c user.name=mqdog";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** Mirrors `pendingDivertFilenameFor`'s own computation (merge-quarantine.ts) for a NEVER-EXISTING
 *  `repoPath` — `directPathIdentity`'s own fallback for a path that doesn't resolve is a plain
 *  `path.resolve`, lower-cased on win32 (never a realpath, which would throw for a missing path). */
function divertFilenameFor(repoPath) {
  const identity = process.platform === "win32" ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath);
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

/** `repo` (registered, real git repo, own key Kp) + `teamA` (a plain subdir of `repo` — collapses onto
 *  Kp too, card 7673d096) + `x` (a path that NEVER exists on disk at all — the degraded ghost occupant). */
function makeFixture(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqdog-repo-${tag}-${freshSfx()}`);
  const teamA = path.join(repo, "teamA");
  fs.mkdirSync(teamA, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const kp = canonicalRepoLockKey(repo);
  const x = path.join(os.tmpdir(), `loom-mqdog-x-ghost-${tag}-${freshSfx()}`); // NEVER created
  check(`(precondition, ${tag}) X never exists on disk at all`, !fs.existsSync(x));
  return { repo, teamA, kp, x };
}

/** Writes X's degraded ghost latch DIRECTLY at its own final (sha(kp).json), with `resolvedKey: kp` —
 *  PASS 1's degraded-arm branch (merge-quarantine.ts ~line 1896) arms it DIRECTLY into `byRepoKey` at
 *  `kp` (never merely pending) whenever `currentKey === resolvedKey`, as it does here (the file's own
 *  name already IS sha(kp)). `enteredAtMsAgo` controls {@link unionQuarantineEntries}'s own "earlier
 *  enteredAt wins the identity tie-break" rule against whatever else ends up sharing this key. */
function writeXDirectlyAtKp(kp, x, tag, enteredAtMsAgo = 60_000) {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const xAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
  fs.writeFileSync(xAtKpPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: `X's REAL reason (${tag}) — degraded-occupies Kp directly`,
    enteredAt: Date.now() - enteredAtMsAgo, tokens: [`token-x-${tag}`], resolvedKey: kp,
  }, null, 2) + "\n");
  return xAtKpPath;
}

/** X's degraded ghost latch WITHOUT a `resolvedKey` field at all — PASS 1's "no recorded resolvedKey and
 *  could NOT be verified against its current key" branch (~line 1851) leaves this PURE PENDING (never
 *  armed into `byRepoKey` at any key at all, and never added to `degradedOccupiedKeys`), unlike
 *  {@link writeXDirectlyAtKp}. Needed for `enterMergeQuarantine`'s own "no existing armed entry at all"
 *  branch and `activeMergeQuarantineFor`'s own bottom graduation tail to be reachable — both require
 *  `activeQuarantines.get(kp)` to be genuinely undefined, which a resolvedKey-equipped X (armed directly)
 *  never allows. */
function writeXAsPurePendingAtKp(kp, x, tag) {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const xAtKpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
  fs.writeFileSync(xAtKpPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: `X's REAL reason (${tag}) — pure pending, no resolvedKey`,
    enteredAt: Date.now() - 60_000, tokens: [`token-x-${tag}`],
  }, null, 2) + "\n");
  return xAtKpPath;
}

/** teamA's own SEPARATE, legacy-keyed stale latch (a random filename — PASS 1 matches by CONTENT, not
 *  filename, exactly like the established ef651188/fd189d91 shared fixtures). `enteredAtMsAgo` — see
 *  {@link writeXDirectlyAtKp}'s own doc on the tie-break this controls. */
function writeTeamAStaleLatch(teamA, tag, enteredAtMsAgo = 0) {
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${tag}-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: `teamA's REAL reason (${tag})`, enteredAt: Date.now() - enteredAtMsAgo, tokens: [`token-teamA-${tag}`],
  }, null, 2) + "\n");
  return staleTeamAPath;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  if (scenarioName === "runtime-sibling-absorb-refuses-direct-path") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE PRIMARY REPRO (card's own repro shape, verified empirically against the REAL dist build before
    // writing these assertions — see docs/decisions/e1cb7d33-*.md for the trace). teamA's OWN stale latch
    // is made the OLDER of the two (`unionQuarantineEntries` keeps the EARLIER `enteredAt`'s identity), so
    // boot's own in-memory union (PASS 1's migrate-vs-degraded-occupied fold) picks teamA's identity as
    // the winner — this is what makes `activeMergeQuarantineFor`'s TOP `direct` fast path pass its own
    // `isKeyVerifiedFor` check (teamA resolves) and proceed to the ACTUAL write call this card is about,
    // rather than short-circuiting on X's own unresolvable identity before ever reaching it. The physical
    // FILE at Kp is untouched by boot either way (bootWriteLatch's own PRE-EXISTING degradedOccupiedKeys
    // refusal — unrelated to this card's own fix) — it is STILL X's own original content, which is
    // exactly what the runtime write, pre-fix, used to clobber.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, x } = makeFixture("absorb");
    const xAtKpPath = writeXDirectlyAtKp(kp, x, "absorb", 60_000);
    const staleTeamAPath = writeTeamAStaleLatch(teamA, "absorb", 120_000); // OLDER than X — wins the union tie-break

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    check("(sanity) X's file is untouched by boot (degraded-occupied key, bootWriteLatch's own pre-existing refusal)", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-absorb"));
    check("(sanity) teamA's stale source survives boot (its own migrate write was refused)", fs.existsSync(staleTeamAPath));
    check("(precondition) the in-memory union already carries BOTH tokens before any runtime query", (listActiveMergeQuarantines().find((e) => e.repoPath === teamA)?.tokens ?? []).includes("token-x-absorb"));

    // The destructive step, pre-fix: the first runtime query for teamA triggers the sibling-absorb write
    // path (`consumeMatchedPendingsIntoArmedEntry` -> `writeMergeQuarantineLatch`), which used to overwrite
    // xAtKpPath unconditionally and unlink teamA's own stale source as "superseded".
    const teamAEntry = activeMergeQuarantineFor(teamA);
    check("*** THE FIX *** teamA is still reported active, carrying BOTH tokens, after the runtime query", !!teamAEntry && (teamAEntry.tokens ?? []).includes("token-teamA-absorb") && (teamAEntry.tokens ?? []).includes("token-x-absorb"));
    check("*** THE FIX *** X's physical file is STILL X's own data after the runtime query (not overwritten)", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-absorb") && !fs.readFileSync(xAtKpPath, "utf8").includes("teamA-branch"));
    check("*** THE FIX *** teamA's stale source file still exists (not unlinked by a refused write)", fs.existsSync(staleTeamAPath));

    // X is a KNOWN, SEPARATE residual (card 398f476c, explicitly out of THIS card's scope): once X's own
    // identity is subsumed into the union, it is no longer independently queryable by its OWN path in
    // THIS process — the union's own winning identity (teamA) answers for the shared key instead. This is
    // the EXISTING query/identity-model gap 398f476c tracks, not something this card regresses or fixes.
    // (Verified empirically: this is true immediately — boot's OWN return-value computation for a
    // registered sibling already triggers it — not merely after a later application-level query.)
    check("(documented, out of scope — card 398f476c) X is NOT independently queryable after being subsumed into the union", activeMergeQuarantineFor(x) === undefined);

    // Act-after-reboot: THIS card's own scope is DURABILITY, not 398f476c's query/identity model — a
    // fresh process re-derives the identical union from disk (X's file untouched, teamA's own stale
    // source still present), so no data was lost across the restart, even though — per 398f476c, same as
    // this process — X stays subsumed and unqueryable by its own path (boot's own return-value pass for
    // the registered teamA sibling re-triggers the identical absorb immediately, same as within this
    // process).
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const teamAEntryBoot2 = boot2.activeMergeQuarantineFor(teamA);
    check("(act-after-reboot) teamA is still active after a real reboot, still carrying BOTH tokens", (teamAEntryBoot2?.tokens ?? []).includes("token-x-absorb") && (teamAEntryBoot2?.tokens ?? []).includes("token-teamA-absorb"));
    check("(act-after-reboot) X's physical file is STILL intact on disk (no data lost across the restart)", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-absorb"));
    check("(act-after-reboot, same 398f476c residual) X is still not independently queryable by its own path", boot2.activeMergeQuarantineFor(x) === undefined);

    // THIRD boot (DoD's own "3 boots" — a single reboot can't distinguish "durable" from "happened to
    // survive one restart"; a THIRD confirms the state is genuinely stable, not merely surviving once).
    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const teamAEntryBoot3 = boot3.activeMergeQuarantineFor(teamA);
    check("(act-after-3rd-boot) teamA is STILL active after a 3rd real reboot, still carrying BOTH tokens", (teamAEntryBoot3?.tokens ?? []).includes("token-x-absorb") && (teamAEntryBoot3?.tokens ?? []).includes("token-teamA-absorb"));
    check("(act-after-3rd-boot) X's physical file is STILL intact on disk after a 3rd reboot", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-absorb"));
    boot3.clearMergeQuarantine(teamA);

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE OPPOSITE AGE ORDER (round 2, item 4) — X OLDER than teamA's stale latch, so X's identity wins
    // `unionQuarantineEntries`'s own tie-break this time (instead of teamA's, above). Verified empirically
    // against the real dist build (never hand-traced — see the decision record's own standing warning: 3
    // prior rounds of hand-traced assumptions about this exact tie-break were wrong) via a debug-instrumented
    // dist build, before writing these assertions: `activeMergeQuarantineFor`'s `direct` fast path gates on
    // `isKeyVerifiedFor(direct.repoPath, key)` — true ONLY when the WINNING identity both resolves AND
    // canonical-keys back to `key`. X never resolves, so whenever X wins the tie-break, that check is FALSE
    // and the function returns `direct` immediately, NEVER reaching the sibling-absorb write call at all —
    // structurally unreachable for this fixture shape, regardless of which repoPath is queried (teamA's own
    // identity-based pending match for X resolves the SAME way: X is still unresolvable, so it returns its
    // own already-merged entry without consuming or writing anything either). This is a DIFFERENT, but
    // equally safe, outcome than the teamA-older case above: not "the write is attempted and refused" but
    // "the write is never attempted in the first place" — nothing is overwritten, and (unlike the
    // teamA-older case, where a refused write still gets attempted) teamA's own stale source file is NOT
    // unlinked either, since no write/supersession step ever runs.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo: repoXOlder, teamA: teamAXOlder, kp: kpXOlder, x: xXOlder } = makeFixture("absorb-xolder");
    const xAtKpPathXOlder = writeXDirectlyAtKp(kpXOlder, xXOlder, "absorb-xolder", 120_000); // OLDER than teamA this time
    const staleTeamAPathXOlder = writeTeamAStaleLatch(teamAXOlder, "absorb-xolder", 60_000); // YOUNGER than X — LOSES the tie-break

    reenterMergeQuarantinesAtBoot([repoXOlder, teamAXOlder, xXOlder]);
    check("(x-older, precondition) the in-memory union already carries BOTH tokens, winning identity is X", (listActiveMergeQuarantines().find((e) => e.repoPath === xXOlder)?.tokens ?? []).includes("token-teamA-absorb-xolder"));

    const teamAEntryXOlder = activeMergeQuarantineFor(teamAXOlder);
    check("(x-older) *** VERIFIED, not hand-traced *** X's identity (not teamA's) answers the query, since X won the tie-break", teamAEntryXOlder?.repoPath === xXOlder);
    check("(x-older) *** VERIFIED *** X's file unchanged (this check alone can't distinguish never-attempted from attempted-then-refused)", fs.readFileSync(xAtKpPathXOlder, "utf8").includes("token-x-absorb-xolder") && !fs.readFileSync(xAtKpPathXOlder, "utf8").includes("teamA-branch"));
    check("(x-older) *** VERIFIED *** teamA's stale source file still exists too (no write means no supersession sweep either)", fs.existsSync(staleTeamAPathXOlder));

    const boot2XOlder = await freshBootModule();
    boot2XOlder.reenterMergeQuarantinesAtBoot([repoXOlder, teamAXOlder, xXOlder]);
    const teamAEntryXOlderBoot2 = boot2XOlder.activeMergeQuarantineFor(teamAXOlder);
    check("(x-older, act-after-reboot) still X's identity, still carrying both tokens, still durable", teamAEntryXOlderBoot2?.repoPath === xXOlder && (teamAEntryXOlderBoot2?.tokens ?? []).includes("token-teamA-absorb-xolder"));
    check("(x-older, act-after-reboot) X's physical file is STILL intact (nothing was ever overwritten, this order or the other)", fs.readFileSync(xAtKpPathXOlder, "utf8").includes("token-x-absorb-xolder"));

    // THIRD boot (DoD's own "3 boots" — same as the teamA-older order above).
    const boot3XOlder = await freshBootModule();
    boot3XOlder.reenterMergeQuarantinesAtBoot([repoXOlder, teamAXOlder, xXOlder]);
    const teamAEntryXOlderBoot3 = boot3XOlder.activeMergeQuarantineFor(teamAXOlder);
    check("(x-older, act-after-3rd-boot) still X's identity, still carrying both tokens, still durable", teamAEntryXOlderBoot3?.repoPath === xXOlder && (teamAEntryXOlderBoot3?.tokens ?? []).includes("token-teamA-absorb-xolder"));
    check("(x-older, act-after-3rd-boot) X's physical file is STILL intact after a 3rd reboot", fs.readFileSync(xAtKpPathXOlder, "utf8").includes("token-x-absorb-xolder"));
    boot3XOlder.clearMergeQuarantine(teamAXOlder);
  } else if (scenarioName === "runtime-lazy-graduation-refuses") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // THE SYMMETRIC BRANCH (lead ruling 2's "symmetric graduation branch") — reached via
    // `activeMergeQuarantineFor`'s BOTTOM graduation tail (a pending entry becomes resolvable and is
    // graduated into its now-known key) rather than the TOP `direct`-fast-path sibling absorb. Both
    // funnel through the SAME `consumeMatchedPendingsIntoArmedEntry` write call (line ~609) — this proves
    // the bottom tail inherits the guard too, not just the top one `runtime-sibling-absorb` already
    // exercises.
    //
    // Shape: teamA's OWN quarantine starts out UNRESOLVABLE (teamA doesn't exist on disk yet at boot —
    // a genuinely pending, no-resolvedKey entry), so boot leaves it pending rather than arming it
    // directly. X degraded-occupies Kp (teamA's eventual key) the whole time. Only AFTER boot does teamA
    // become resolvable (mkdir+git init) — the first runtime query then drives the BOTTOM graduation
    // tail, which must refuse to write over X's file exactly like the top one does.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqdog-repo-grad-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# grad\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const kp = canonicalRepoLockKey(repo);
    const teamA = path.join(repo, "teamA"); // does NOT exist yet — created only after boot, below
    const x = path.join(os.tmpdir(), `loom-mqdog-x-ghost-grad-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    check("(precondition) teamA does not exist yet at boot time", !fs.existsSync(teamA));
    // X is PURE PENDING here (no resolvedKey) — required so `activeQuarantines.get(kp)` stays genuinely
    // undefined (never armed directly), which is what forces the BOTTOM graduation tail rather than the
    // TOP `direct` fast path `runtime-sibling-absorb-refuses-direct-path` already exercises.
    const xAtKpPath = writeXAsPurePendingAtKp(kp, x, "grad");
    // teamA's own genuinely-pending latch (no resolvedKey — it has never been armed under any key, since
    // it never resolved before) sits at an arbitrary stale name, exactly like the ef651188 `y` fixture.
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-grad-${freshSfx()}.json`);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason (grad)", enteredAt: Date.now(), tokens: ["token-teamA-grad"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    check("(sanity) X's file is untouched by boot", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-grad"));
    check("(sanity) teamA's stale source survives boot (still pending, unresolvable)", fs.existsSync(staleTeamAPath));
    check("(sanity) teamA is pending (reported active via its own divert) before it ever resolves", !!activeMergeQuarantineFor(teamA));
    check("(precondition) nothing is armed at Kp yet (both X and teamA are pure pending)", !listActiveMergeQuarantines().some((e) => e.armedKeys?.includes(kp)));

    // Now make teamA resolvable — the FIRST query afterward drives the bottom graduation tail.
    fs.mkdirSync(teamA, { recursive: true });
    fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
    check("(precondition) canonicalRepoLockKey(teamA) now equals Kp (collapses via the toplevel walk)", canonicalRepoLockKey(teamA) === kp);

    const teamAEntry = activeMergeQuarantineFor(teamA);
    check("*** THE FIX (bottom graduation tail) *** teamA is still reported active after graduating", !!teamAEntry && (teamAEntry.tokens ?? []).includes("token-teamA-grad"));
    check("*** THE FIX (bottom graduation tail) *** X's physical file is STILL X's own data (not overwritten)", fs.readFileSync(xAtKpPath, "utf8").includes("token-x-grad"));
    check("*** THE FIX (bottom graduation tail) *** teamA's stale source file still exists (not unlinked)", fs.existsSync(staleTeamAPath));
    check("(sanity) X is still active too (pure pending, never disturbed)", !!activeMergeQuarantineFor(x));
  } else if (scenarioName === "fresh-raise-survives-reboot") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // MANAGER RULING (after the fresh-raise-reachability draft above first shipped): a fail-CLOSED default
    // guard on enterMergeQuarantine's own "brand new entry" branch (no existing active entry, no pending
    // match for teamA) would have introduced a WORSE regression than this card's own original defect — a
    // refused raise is never persisted, so it is silently LOST at the next reboot (enforcement fails
    // OPEN), strictly worse than this shape's own PRE-EXISTING behavior (the raise overwrites the
    // degraded occupant's file, destroying ITS identity, but the raise itself survives). enterMergeQuarantine
    // is therefore an explicit OPT-OUT of the guard, exactly like bootWriteLatch — this scenario proves
    // the opt-out restores that pre-fix durability. Card `1922be3a` additionally FIXES the residual this
    // scenario used to document (the degraded occupant's own file being destroyed in this exact shape) —
    // X's content is now durably protected aside, under its own disjoint divert name, BEFORE teamA's raise
    // writes to X's former slot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, x } = makeFixture("raise");
    // X is PURE PENDING here (no resolvedKey) — required so `activeQuarantines.get(kp)` is genuinely
    // undefined when enterMergeQuarantine looks it up, forcing its "brand new entry" branch (no existing
    // armed entry, no pending match for teamA's own identity) rather than its "existing" merge-a-token-in
    // branch, which a resolvedKey-equipped (directly-armed) X would hit instead (an entirely different,
    // pre-existing code path this card does not change).
    const xAtKpPath = writeXAsPurePendingAtKp(kp, x, "raise");
    // Deliberately NO stale latch for teamA at all — this is a GENUINELY FRESH raise, never quarantined.

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    check("(precondition) teamA has no quarantine of its own yet", !activeMergeQuarantineFor(teamA));
    check("(sanity) X is active (pure pending, its own identity-only divert)", !!activeMergeQuarantineFor(x));

    const token = enterMergeQuarantine(teamA, "teamA-branch", "a genuinely fresh raise over a degraded occupant's own exclusive backing");
    const teamAEntry = activeMergeQuarantineFor(teamA);
    check("*** THE OPT-OUT *** teamA's fresh raise is enforced IN-MEMORY immediately", !!teamAEntry && teamAEntry.tokens.includes(token));
    check(
      "(sanity, unchanged by this card) teamA's write still landed at X's former slot (today's existing shape)",
      JSON.parse(fs.readFileSync(xAtKpPath, "utf8")).repoPath === teamA,
    );
    // (NOT a discriminating check: X's in-memory `pendingUnresolvedQuarantines` entry is untouched by
    // the write itself either way — this passes identically with or without the fix. Only the REBOOT
    // check below, which re-derives state purely from disk, actually discriminates.)
    const xEntryAfterRaise = activeMergeQuarantineFor(x);
    check(
      "(sanity) X is still independently active IN-MEMORY, carrying its own token",
      !!xEntryAfterRaise && (xEntryAfterRaise.tokens ?? []).includes("token-x-raise"),
    );

    // *** THE FIX FOR THIS RULING *** the raise is DURABLE — it survives a real reboot, unlike a
    // fail-closed default would have produced (see the `--ref` behavioral RED this scenario is paired with).
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const teamAAfterReboot = boot2.activeMergeQuarantineFor(teamA);
    check(
      "*** THE FIX *** teamA's fresh raise SURVIVES a real reboot — still quarantined, carrying its own token",
      !!teamAAfterReboot && teamAAfterReboot.tokens.includes(token),
    );
    const xAfterReboot = boot2.activeMergeQuarantineFor(x);
    check(
      "*** THE FIX (card 1922be3a) *** X is STILL independently active after a real reboot too, carrying its own token — its data was protected, not overwritten",
      !!xAfterReboot && (xAfterReboot.tokens ?? []).includes("token-x-raise"),
    );
    boot2.clearMergeQuarantine(teamA);
  } else if (scenarioName === "pending-merge-fresh-raise-survives-reboot") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // ROUND 2, ITEM 3 — the SECOND of `enterMergeQuarantine`'s 4 own opt-out write sites: its PENDING-MERGE
    // branch, reached when the raised repo has its OWN pending (never-yet-resolved) latch to merge into —
    // a DIFFERENT call site than `fresh-raise-survives-reboot`'s own "brand new entry" branch, which only
    // fires when there is NO pending match at all.
    //
    // Shape: X is pure-pending at Kp (no resolvedKey); teamA ALSO has its own stale, pending latch (teamA
    // does not exist yet at boot, so it stays genuinely pending rather than being armed) — i.e. teamA's OWN
    // raise below is itself UNVERIFIED (teamA still doesn't exist on disk when it raises).
    //
    // @decision d4b25feb — UPDATED: this scenario used to document the SAME "documented residual" as
    // `fresh-raise-survives-reboot` (X's physical file overwritten) — card d4b25feb's own fix closes it
    // for THIS specific shape (an UNVERIFIED raiser merging into its own pending latch), while leaving
    // `fresh-raise-survives-reboot`'s own shape (a VERIFIED raiser, teamA genuinely resolves there) fully
    // untouched and still open (tracked separately on card 2a6a8073). teamA's own raise here now diverts
    // via `mergeTokenIntoPendingEntries` instead of ever calling `consumeMatchedPendingsIntoArmedEntry`/
    // `writeMergeQuarantineLatch` at all — so it never reaches, or needs, this call site's own `writeMerge-
    // QuarantineLatch`-based opt-out any more. See docs/decisions/d4b25feb-*.md.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqdog-repo-pendraise-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# pendraise\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const kp = canonicalRepoLockKey(repo);
    const teamA = path.join(repo, "teamA"); // does not exist yet — stays pending at boot
    const x = path.join(os.tmpdir(), `loom-mqdog-x-ghost-pendraise-${freshSfx()}`);
    const xAtKpPath = writeXAsPurePendingAtKp(kp, x, "pendraise");
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-pendraise-${freshSfx()}.json`);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own stale pending latch (pendraise)", enteredAt: Date.now(), tokens: ["token-teamA-pendraise"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    check("(precondition) teamA is reported active via its own pending divert, before any raise", !!activeMergeQuarantineFor(teamA));
    check("(precondition) nothing is armed at Kp yet (both X and teamA are pure pending)", !listActiveMergeQuarantines().some((e) => e.armedKeys?.includes(kp)));

    // The raise merges teamA's OWN pending entry with a fresh one — this is `enterMergeQuarantine`'s
    // pending-merge branch (NOT the "existing"/already-armed branch `fresh-raise-survives-reboot` and
    // `runtime-sibling-absorb-refuses-direct-path` both exercise instead), and NOT the "brand new entry"
    // branch `fresh-raise-survives-reboot` exercises either.
    const token = enterMergeQuarantine(teamA, "teamA-branch", "a fresh raise merging into teamA's own pending latch, over X's degraded Kp occupancy");
    const teamAEntry = activeMergeQuarantineFor(teamA);
    check("*** THE FIX (card d4b25feb) *** teamA's merged raise is enforced IN-MEMORY immediately", !!teamAEntry && (teamAEntry.tokens ?? []).includes(token) && (teamAEntry.tokens ?? []).includes("token-teamA-pendraise"));
    check(
      "*** THE FIX (card d4b25feb) *** X's own physical file is STILL X's own data (never overwritten) — teamA's unverified raise diverted instead of arming at the shared degraded key",
      JSON.parse(fs.readFileSync(xAtKpPath, "utf8")).repoPath === x,
    );
    check(
      "*** THE FIX (card d4b25feb) *** teamA's own stale pending source is REWRITTEN IN PLACE (not deleted) — it is now teamA's own durable pending-divert record",
      fs.existsSync(staleTeamAPath) && JSON.parse(fs.readFileSync(staleTeamAPath, "utf8")).tokens.includes(token),
    );
    check("(sanity) X is still independently active too — never touched by teamA's own merge", !!activeMergeQuarantineFor(x) && (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-pendraise"));

    // *** THE FIX FOR THIS RULING *** durable across a real reboot. Stale as of card d4b25feb: this call
    // site no longer reaches `consumeMatchedPendingsIntoArmedEntry`/`writeMergeQuarantineLatch` at all (an
    // unverified teamA now routes through `mergeTokenIntoPendingEntries`/`writePendingDivertFile` instead,
    // which has no `skipDegradedOccupantGuard` to flip) — durability here comes from that write succeeding
    // on its own terms, not from an opt-out of a guard this path no longer consults. The behavioral RED for
    // THIS shape is d4b25feb's own negative-control (reverting the whole fix), not a flag flip here.
    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const teamAAfterReboot = boot2.activeMergeQuarantineFor(teamA);
    check(
      "*** THE FIX *** teamA's merged raise SURVIVES a real reboot — still quarantined, carrying its own fresh token",
      !!teamAAfterReboot && (teamAAfterReboot.tokens ?? []).includes(token),
    );
    boot2.clearMergeQuarantine(teamA);
  } else if (scenarioName === "negative-control-resolvable-occupant-still-overwrites") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // NEGATIVE CONTROL — a DIFFERENT identity that IS currently resolvable at teamA's own key must still
    // be overwritten exactly as before this card (today's existing, legitimate "stale different repo's
    // leftover file" case) — the guard must discriminate on RESOLVABILITY, never refuse unconditionally.
    //
    // ROUND 2, ITEM 1 (MAJOR correction) — the PRIOR version of this control (through `638136c3`) was
    // ITSELF vacuous, for a DIFFERENT reason than the one its own comment used to document: it drove the
    // write through `enterMergeQuarantine`'s "brand new entry" branch, which — as of `638136c3` — is one
    // of `enterMergeQuarantine`'s own explicit OPT-OUTS from this guard (ruling 3, ratified after that
    // prior version was already written). An opted-out caller can never exercise a guard it never
    // consults at all — "not refused" proved nothing about the guard's own resolvability discrimination,
    // only that the opt-out (correctly) always writes. Verified empirically (never hand-traced): flipping
    // `differentUnresolvableOccupantRepoPathAt`'s own `isRepoPathCurrentlyResolvable(existing.repoPath)`
    // check to `if (false)` left this scenario's old assertions UNCHANGED (still "not refused") — the
    // textbook shape of a vacuous control the project's own standing doctrine warns about.
    //
    // THE FIX: drive the write through a GUARDED caller instead — `activeMergeQuarantineFor`'s own bottom
    // graduation tail (the ONLY one of its two call sites that doesn't also require a `direct` entry
    // already armed at the key, which `other`'s own presence there would complicate). Shape: teamA starts
    // genuinely pending (does not exist yet at boot); `other` (a REAL, resolvable, unrelated repo) is
    // planted directly at teamA's own eventual physical hash AFTER boot, never through boot's own migrate
    // pass — boot would otherwise recognize `other` as resolvable-but-misfiled and migrate it to its OWN
    // correct location before teamA's query ever ran, leaving nothing at the shared hash to collide with
    // (the exact vacuity trap the PRIOR version's own comment already named, just reached a different way
    // this time). Re-verified with the SAME `if (false)` mutation: with the fix in place, that mutation
    // flips this scenario from "not refused" to REFUSED — proof the control now genuinely depends on the
    // guard's own resolvability branch.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqdog-repo-ctrl-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# ctrl\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const kp = canonicalRepoLockKey(repo);
    const teamA = path.join(repo, "teamA"); // does NOT exist yet at boot — stays genuinely pending
    const other = path.join(os.tmpdir(), `loom-mqdog-other-ctrl-${freshSfx()}`); // a DIFFERENT, but RESOLVABLE repo
    fs.mkdirSync(other, { recursive: true });
    tmpDirs.push(other);
    fs.writeFileSync(path.join(other, "README.md"), "# other\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: other });
    commitAll(other, "init", GIT_ID);
    check("(precondition) other is currently resolvable", fs.existsSync(other));
    check("(precondition) teamA does not exist yet at boot time", !fs.existsSync(teamA));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-ctrl-${freshSfx()}.json`);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's own pending latch (ctrl)", enteredAt: Date.now(), tokens: ["token-teamA-ctrl"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([repo, teamA]);
    check("(sanity) teamA is pending (reported active via its own divert) before it ever resolves", !!activeMergeQuarantineFor(teamA));

    // Make teamA resolvable, THEN plant `other`'s leftover directly at its physical hash — AFTER boot, so
    // boot's own migrate pass never gets a chance to see (and "fix") the collision first.
    fs.mkdirSync(teamA, { recursive: true });
    check("(precondition) canonicalRepoLockKey(teamA) now equals Kp (collapses via the toplevel walk)", canonicalRepoLockKey(teamA) === kp);
    const kpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kp)}.json`);
    fs.writeFileSync(kpPath, JSON.stringify({
      repoPath: other, branch: "other-branch", reason: "a resolvable, unrelated leftover planted AFTER boot, directly at teamA's own hash",
      enteredAt: Date.now() - 60_000, tokens: ["token-other"],
    }, null, 2) + "\n");

    // The FIRST query for teamA now drives the bottom graduation tail (THE SAME guarded write call
    // `runtime-lazy-graduation-refuses` exercises against an UNRESOLVABLE occupant) against a RESOLVABLE
    // one instead — this is what the guard must still let through.
    const teamAEntry = activeMergeQuarantineFor(teamA);
    check("(negative control) *** NOT refused, through a GUARDED caller *** teamA's write landed on the shared hash (today's existing behavior, unchanged)", JSON.parse(fs.readFileSync(kpPath, "utf8")).repoPath === teamA);
    check("(sanity) teamA is active, carrying its own token", !!teamAEntry && (teamAEntry.tokens ?? []).includes("token-teamA-ctrl"));
    check("(sanity) teamA's own stale pending source was superseded (deleted) by the successful write", !fs.existsSync(staleTeamAPath));
    clearMergeQuarantine(teamA);
  } else if (scenarioName === "walkup-raise-protects-pending-occupant-then-clears") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD 1922be3a's own literal repro shape (CR probe `--s=runtime`): X is a WALK-UP occupant — a
    // nonexistent path literally UNDER W itself (`W/gone-subdir`), never a disjoint ghost — pure pending
    // (no resolvedKey, required so PASS 1 defers to a lazy re-resolve rather than arming it directly; see
    // `writeXAsPurePendingAtKp`'s own doc), physically backed by its own final AT sha(K).json where
    // K = canonicalRepoLockKey(W). `enterMergeQuarantine(W)` then reaches the SAME "no existing armed
    // entry" region as `fresh-raise-survives-reboot` above — this scenario's own distinct value is
    // carrying the sequence through the probe's own full `clear(W) by path` + reboot steps, proving X's
    // protected copy is untouched by a clear addressed at an entirely different identity (W's own).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const repo = path.join(os.tmpdir(), `loom-mqdog-repo-walkup-${freshSfx()}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# walkup\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const w = repo;
    const kw = canonicalRepoLockKey(w);
    const x = path.join(w, "gone-subdir"); // NEVER created — a literal walk-up path under W itself
    check("(precondition) X (W/gone-subdir) never exists on disk", !fs.existsSync(x));
    check("(precondition) X's own canonical key already walks up to W's own key, tautologically", canonicalRepoLockKey(x) === kw);
    const xAtKwPath = writeXAsPurePendingAtKp(kw, x, "walkup");

    reenterMergeQuarantinesAtBoot([w, x]);
    check("(precondition) W has no quarantine of its own yet", !activeMergeQuarantineFor(w));
    check("(sanity) X is active (pure pending, its own identity-only divert, physically at sha(Kw).json)", !!activeMergeQuarantineFor(x));

    const token = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, over a walk-up occupant's own exclusive backing");
    const wEntry = activeMergeQuarantineFor(w);
    check("*** THE OPT-OUT *** W's fresh raise is enforced IN-MEMORY immediately", !!wEntry && wEntry.tokens.includes(token));
    // `activeMergeQuarantineFor(x)` itself is NOT the right check here any more — X's own fresh
    // canonical key is now tautologically identical to W's, and W is genuinely, verifiably active
    // there, so the pre-existing `direct-verified-guard`/`8a1bc2ef` shortcut correctly answers with W's
    // OWN entry for a query of `x` (never a regression to chase — `398f476c`'s own query/identity scope,
    // unaffected by this card). What this card actually guarantees is DURABILITY of X's own DATA —
    // checked via the full listing, which still carries X's own pending entry under its own, newly
    // protected name.
    // (NOT a discriminating check: X's in-memory pending entry is untouched by the raise's own write
    // either way — this passes identically with or without the fix. Only the two REBOOT checks below,
    // which re-derive state purely from disk, actually discriminate.)
    check(
      "(sanity) X's own data is STILL tracked (via the full listing), carrying its own token",
      listActiveMergeQuarantines().some((e) => (e.tokens ?? []).includes("token-x-walkup")),
    );
    check(
      "(sanity) X's ORIGINAL physical file is now W's own content (the write still lands there — X's copy lives elsewhere)",
      JSON.parse(fs.readFileSync(xAtKwPath, "utf8")).repoPath === w,
    );

    // *** THE PROBE'S OWN SEQUENCE *** clear W by path, then reboot — X must survive BOTH, untouched by a
    // clear addressed at a wholly different identity.
    clearMergeQuarantine(w);
    check("(sanity) clearing W by path lifts W's own quarantine", !activeMergeQuarantineFor(w));
    // (ALSO not yet discriminating: the clear itself never touches X's in-memory entry either way —
    // only the reboot after this re-derives it purely from disk, which is where the fix actually shows.)
    check(
      "(sanity) X survives W's own clear, still active, still carrying its own token",
      (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-walkup"),
    );
    check("(sanity) assertRepoNotQuarantined(x) still blocks after W's clear", assertRepoNotQuarantined(x).ok === false);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([w, x]);
    check(
      "*** THE FIX (card 1922be3a) *** X's token SURVIVES a real reboot too, after the clear",
      (boot2.activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-walkup"),
    );
    check("(sanity) W stays lifted after the reboot (the clear was durable)", !boot2.activeMergeQuarantineFor(w));
    check("*** THE FIX (card 1922be3a) *** assertRepoNotQuarantined(x) still blocks after a real reboot", boot2.assertRepoNotQuarantined(x).ok === false);
  } else if (scenarioName === "existing-branch-raise-protects-foreign-pending-occupant") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CARD e0192ffb's OWN repro — unlike `walkup-raise-protects-pending-occupant-then-clears` above
    // (which drives `enterMergeQuarantine`'s "no `existing`" region, 1922be3a's own scope), this scenario
    // drives the `existing`-TRUTHY region's own two writes, which skipped the degraded-occupant guard for
    // `key` itself without ever protecting a foreign occupant first. Shape: X is pure pending at Kw
    // (never resolves); teamA (S) has its own stale pending latch (does NOT exist yet at boot) whose own
    // key, once teamA resolves, collapses onto the SAME Kw as the enclosing repo W's own key (mirrors
    // `runtime-lazy-graduation-refuses`). teamA graduates at Kw via the bottom tail — that write is
    // correctly refused (X's file survives), but `existing` is now armed at Kw in-memory. `W` itself
    // (teamA's own enclosing toplevel — its fresh key is ALSO Kw) then raises, reaching the `existing`
    // branch pre-fix destroys X's file via its own primary-key write; post-fix it protects X aside first.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqdog-w-existing-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# existing\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const teamA = path.join(w, "teamA"); // does NOT exist yet — created only after boot, below
    const x = path.join(os.tmpdir(), `loom-mqdog-x-ghost-existing-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    check("(precondition) teamA does not exist yet at boot time", !fs.existsSync(teamA));

    const xAtKwPath = writeXAsPurePendingAtKp(kw, x, "existing");
    const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-existing-${freshSfx()}.json`);
    fs.writeFileSync(staleTeamAPath, JSON.stringify({
      repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason (existing)", enteredAt: Date.now(), tokens: ["token-teamA-existing"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([w, teamA, x]);
    check("(sanity) X's file is untouched by boot", fs.readFileSync(xAtKwPath, "utf8").includes("token-x-existing"));
    check("(sanity) teamA's stale source survives boot (still pending, unresolvable)", fs.existsSync(staleTeamAPath));
    check("(precondition) nothing is armed at Kw yet (both X and teamA are pure pending)", !listActiveMergeQuarantines().some((e) => e.armedKeys?.includes(kw)));
    check("(precondition) W has no quarantine of its own yet", !activeMergeQuarantineFor(w));

    // Make teamA resolvable — the first query graduates it at Kw in-memory, with its own write refused
    // (X's own foreign file untouched) — exactly `runtime-lazy-graduation-refuses`'s own shape.
    fs.mkdirSync(teamA, { recursive: true });
    fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
    check("(precondition) canonicalRepoLockKey(teamA) now equals Kw (collapses via the toplevel walk)", canonicalRepoLockKey(teamA) === kw);

    const teamAGraduated = activeMergeQuarantineFor(teamA);
    check("(precondition) teamA graduated at Kw in-memory, carrying its own token", !!teamAGraduated && (teamAGraduated.tokens ?? []).includes("token-teamA-existing"));
    check("(precondition) X's file is STILL untouched after the graduation's own refused write", fs.readFileSync(xAtKwPath, "utf8").includes("token-x-existing"));

    // THE REPRO — W itself raises. W's own fresh key is ALSO Kw, so `enterMergeQuarantine(W)` takes the
    // `existing` branch (`existing` = teamA's just-graduated entry).
    // CR aad53fa6: neither of the next two checks discriminates the fix — the write ALWAYS succeeds here
    // (skipDegradedOccupantGuard is true for this key regardless of this card's own fix), so both pass
    // identically pre-fix and post-fix. Only the reboot checks below, which re-derive state purely from
    // disk, actually discriminate (matches `walkup-raise-protects-pending-occupant-then-clears`'s own
    // labeling convention above).
    const wToken = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, hitting the `existing` branch over a foreign degraded occupant's exclusive backing");
    const wEntry = activeMergeQuarantineFor(w);
    check("(sanity) W's raise is enforced IN-MEMORY immediately, unioned with teamA", !!wEntry && wEntry.tokens.includes(wToken) && (wEntry.tokens ?? []).includes("token-teamA-existing"));
    // X's own data is never absorbed into this union (its identity never matched teamA's or W's) — its
    // ORIGINAL physical slot legitimately becomes the W/teamA union's own content (the write still lands
    // there); X's own copy must live elsewhere, protected, per the full listing below — same shape as
    // `walkup-raise-protects-pending-occupant-then-clears`'s own two checks above.
    check(
      "(sanity) X's own data is STILL tracked (via the full listing), carrying its own token",
      listActiveMergeQuarantines().some((e) => (e.tokens ?? []).includes("token-x-existing")),
    );
    check(
      "(sanity) X's ORIGINAL physical file is now the W/teamA union's own content (X's copy lives elsewhere, protected)",
      JSON.parse(fs.readFileSync(xAtKwPath, "utf8")).repoPath === teamA,
    );

    // *** THE PROBE'S OWN SEQUENCE *** clear W by path, then reboot — X must survive BOTH, untouched by a
    // clear addressed at an entirely different identity.
    clearMergeQuarantine(w);
    check("(sanity) clearing W by path lifts the W/teamA union", !activeMergeQuarantineFor(w) && !activeMergeQuarantineFor(teamA));
    check(
      "(sanity) X survives W's own clear, still active, still carrying its own token",
      (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-existing"),
    );
    check("(sanity) assertRepoNotQuarantined(x) still blocks after W's clear", assertRepoNotQuarantined(x).ok === false);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([w, teamA, x]);
    check(
      "*** THE FIX (card e0192ffb) *** X's token SURVIVES a real reboot too, after the clear",
      (boot2.activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-existing"),
    );
    check("(sanity) W/teamA stay lifted after the reboot (the clear was durable)", !boot2.activeMergeQuarantineFor(w) && !boot2.activeMergeQuarantineFor(teamA));
    check("*** THE FIX (card e0192ffb) *** assertRepoNotQuarantined(x) still blocks after a real reboot", boot2.assertRepoNotQuarantined(x).ok === false);
  } else if (scenarioName === "existing-branch-raise-still-overwrites-own-union-content") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // NEGATIVE CONTROL for card e0192ffb — the exact false-positive risk `1922be3a`'s own scope note
    // named: `existing`'s own winning identity can itself BE an unresolvable occupant (X), the result of
    // an EARLIER boot-time tie-break union — in that case, `key`'s own physical final genuinely IS
    // `entry.repoPath`'s (X's) own data, so a later raise must durably persist the bigger union WITHOUT
    // the new protect call spuriously diverting it aside as if it were foreign.
    //
    // Reuses `makeFixture`'s X-OLDER tie-break shape (X's own `enteredAt` OLDER than teamA's own stale
    // latch, so `unionQuarantineEntries` keeps X's identity as the winner, mirroring
    // `runtime-sibling-absorb-refuses-direct-path`'s own "opposite age order" variant) — boot's own write
    // for teamA's migrate-in is refused (Kp is a `degradedOccupiedKey`), so X's OWN original file is still
    // physically at Kp, genuinely matching the in-memory union's own winning identity.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, x } = makeFixture("ctrl2");
    const xAtKpPath = writeXDirectlyAtKp(kp, x, "ctrl2", 120_000); // OLDER than teamA — wins the union tie-break
    writeTeamAStaleLatch(teamA, "ctrl2", 60_000); // YOUNGER — loses the tie-break

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const unionBefore = listActiveMergeQuarantines().find((e) => e.repoPath === x);
    check("(precondition) the in-memory union's winning identity is X, already carrying both tokens", !!unionBefore && (unionBefore.tokens ?? []).includes("token-teamA-ctrl2") && (unionBefore.tokens ?? []).includes("token-x-ctrl2"));
    check(
      "(precondition) X's own physical file at Kp is untouched (teamA's own migrate write was refused)",
      fs.readFileSync(xAtKpPath, "utf8").includes("token-x-ctrl2") && !fs.readFileSync(xAtKpPath, "utf8").includes("teamA-branch"),
    );
    const divertPathForX = path.join(MERGE_QUARANTINE_DIR, divertFilenameFor(x));
    check("(precondition) no divert file for X exists yet", !fs.existsSync(divertPathForX));

    // `enterMergeQuarantine(teamA)` directly (never through `activeMergeQuarantineFor`'s own
    // `isKeyVerifiedFor` gate, which would short-circuit on X's own unresolvability before ever reaching
    // a write at all) reaches the SAME `existing` branch this card fixes — `existing.repoPath` is X's own
    // identity, genuinely matching what's physically at Kp right now.
    const teamAToken = enterMergeQuarantine(teamA, "teamA-branch", "a fresh raise over its own identity's already-won union, never a foreign occupant");
    const afterRaise = activeMergeQuarantineFor(teamA);
    check(
      "(sanity) teamA's fresh raise is enforced in-memory, union still winning identity X",
      !!afterRaise && afterRaise.repoPath === x && afterRaise.tokens.includes(teamAToken) && afterRaise.tokens.includes("token-x-ctrl2") && afterRaise.tokens.includes("token-teamA-ctrl2"),
    );
    const onDiskAfterRaise = JSON.parse(fs.readFileSync(xAtKpPath, "utf8"));
    check(
      "*** CONTROL *** the write legitimately overwrote X's own file IN PLACE (same identity, bigger union) — never refused, never diverted",
      onDiskAfterRaise.repoPath === x && onDiskAfterRaise.tokens.includes(teamAToken) && onDiskAfterRaise.tokens.includes("token-x-ctrl2") && onDiskAfterRaise.tokens.includes("token-teamA-ctrl2"),
    );
    check("*** CONTROL *** no spurious divert file was created for X's own identity (the protect call correctly no-opped)", !fs.existsSync(divertPathForX));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const afterReboot = boot2.activeMergeQuarantineFor(teamA);
    check(
      "*** CONTROL *** the bigger union is durable across a reboot",
      !!afterReboot && afterReboot.repoPath === x && afterReboot.tokens.includes(teamAToken) && afterReboot.tokens.includes("token-x-ctrl2") && afterReboot.tokens.includes("token-teamA-ctrl2"),
    );
    boot2.clearMergeQuarantine(teamA);
  } else if (scenarioName === "existing-branch-raise-token-overlap-pins-no-spurious-divert") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CR aad53fa6 BLOCKER — the prior control (`existing-branch-raise-still-overwrites-own-union-content`)
    // passes under an IDENTITY-ONLY mutant too, since its disk content's identity already matches
    // `entry.repoPath` (the identity exemption alone already skips protection there, with or without
    // token overlap). THIS scenario pins the card's own actual discriminator — TOKEN OVERLAP, never
    // repoPath identity — via the one shape where identity DIFFERS but the disk occupant's own token is
    // ALREADY a full subset of the fresh union: `teamA` wins the boot-time tie-break (its own `enteredAt`
    // OLDER than X's), so the in-memory union's winning identity is `teamA`, already carrying X's own
    // token from THAT union — but X's OWN original physical file (repoPath=x) is STILL what's at Kp,
    // since teamA's own migrate write was refused (same refused-write shape as the sibling control). A
    // later raise of teamA must recognize X's on-disk token is already incorporated and skip protection;
    // an IDENTITY-ONLY check would instead flag X as foreign (its repoPath differs from teamA's, and X is
    // unresolvable) and mint a spurious, never-synced divert for it — stranding X blocked forever, since
    // no later clear of teamA ever looks at that independent record.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const { repo, teamA, kp, x } = makeFixture("pin3");
    const xAtKpPath = writeXDirectlyAtKp(kp, x, "pin3", 60_000); // YOUNGER than teamA — LOSES the tie-break
    writeTeamAStaleLatch(teamA, "pin3", 120_000); // OLDER than X — wins the union tie-break

    reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    const unionBefore = listActiveMergeQuarantines().find((e) => e.repoPath === teamA);
    check(
      "(precondition) the in-memory union's winning identity is teamA, already carrying X's own token",
      !!unionBefore && (unionBefore.tokens ?? []).includes("token-teamA-pin3") && (unionBefore.tokens ?? []).includes("token-x-pin3"),
    );
    check(
      "(precondition) X's own physical file at Kp is STILL untouched (teamA's own migrate write was refused)",
      fs.readFileSync(xAtKpPath, "utf8").includes("token-x-pin3") && !fs.readFileSync(xAtKpPath, "utf8").includes("teamA-branch"),
    );
    const divertPathForX = path.join(MERGE_QUARANTINE_DIR, divertFilenameFor(x));
    check("(precondition) no divert file for X exists yet", !fs.existsSync(divertPathForX));

    // THE PIN — teamA raises again. `existing.repoPath` is ALREADY teamA (the tie-break winner), so
    // `entry.repoPath` stays teamA — but the physical file at Kp is X's own (a DIFFERENT identity). X's
    // own on-disk token is already a member of `entry.tokens` (absorbed at BOOT time) — the real fix must
    // recognize that and skip protection; an identity-only check cannot, since it never looks at tokens.
    const teamAToken = enterMergeQuarantine(teamA, "teamA-branch", "a fresh raise over teamA's own already-won union, where X's own token is already incorporated but X's own file is a DIFFERENT identity");
    const afterRaise = activeMergeQuarantineFor(teamA);
    check(
      "(sanity) teamA's fresh raise is enforced in-memory, union still winning identity teamA",
      !!afterRaise && afterRaise.repoPath === teamA && afterRaise.tokens.includes(teamAToken) && afterRaise.tokens.includes("token-x-pin3") && afterRaise.tokens.includes("token-teamA-pin3"),
    );
    check(
      "*** THE FIX (card e0192ffb, CR aad53fa6) *** NO spurious divert file was created for X's own identity — its on-disk token was already incorporated",
      !fs.existsSync(divertPathForX),
    );
    check(
      "*** THE FIX (card e0192ffb, CR aad53fa6) *** the write legitimately overwrote X's own file IN PLACE with the bigger union (teamA's identity, all three tokens)",
      JSON.parse(fs.readFileSync(xAtKpPath, "utf8")).repoPath === teamA,
    );

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([repo, teamA, x]);
    boot2.clearMergeQuarantine(teamA);
    boot2.clearMergeQuarantine(repo);
    check(
      "*** THE FIX (card e0192ffb, CR aad53fa6) *** X is FULLY FREED by clearing teamA/repo — no independent spurious record survived to strand it",
      boot2.assertRepoNotQuarantined(x).ok === true,
    );
    check("*** THE FIX (card e0192ffb, CR aad53fa6) *** no latch files remain in the quarantine dir", fs.readdirSync(MERGE_QUARANTINE_DIR).length === 0);
  } else if (scenarioName === "round2-protect-splice-does-not-corrupt-own-sibling-index") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CODE REVIEW d3c36260, BLOCKER 1 — the protect call used to run AFTER pendingIndices/siblingIndices/
    // allPendingIndices were collected, so protectOccupantContentBeforeDelete's own SPLICE (triggered
    // here by X's "two-file" shape: one copy AT sha(Kw).json, a SEPARATE prior-divert copy at its own
    // pending-divert name) corrupted every index already collected. Fixture: X's two files, teamA's own
    // (S, a genuine sibling of W via siblingIndices) stale latch, and Z's own (an UNRELATED ghost) stale
    // latch are all written before boot; teamA's and Z's filenames are forced (a "zz-"/"zzz-" prefix) to
    // sort AFTER both of X's files — so REGARDLESS of which of X's two files boot assigns the lower
    // array index, teamA and Z are always positioned after the one the splice removes, and their
    // indices always shift down by exactly one. Pre-fix, W's OWN siblingIndices (collected BEFORE the
    // splice) kept the STALE, now-shifted index — reading Z's new slot instead of teamA's, silently
    // unioning W's own fresh token into the UNRELATED Z (the CR's own "(1b)" finding).
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqdog-w-r2splice-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# r2splice\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const x = path.join(w, "gone-subdir"); // NEVER created — the degraded walk-up occupant
    const teamA = path.join(w, "teamA"); // NOT created yet — stays genuinely pending at boot
    check("(precondition) X never exists on disk", !fs.existsSync(x));
    check("(precondition) teamA does not exist yet at boot time", !fs.existsSync(teamA));

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    // X's TWO files — one AT sha(Kw).json (the exact key this raise's own protect call targets), one at
    // X's OWN pending-divert name (a PRIOR protect's own durable copy). Neither carries a resolvedKey,
    // so BOTH defer cleanly to pending at boot — no migrate/collision interaction at all.
    const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
    const xDivertPath = path.join(MERGE_QUARANTINE_DIR, divertFilenameFor(x));
    const xContent = JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's two-file shape (r2splice)", enteredAt: Date.now() - 60_000, tokens: ["token-x-r2splice"] }, null, 2) + "\n";
    fs.writeFileSync(xAtKwPath, xContent);
    fs.writeFileSync(xDivertPath, xContent);
    // teamA's (S) and Z's own stale latches, named to sort AFTER BOTH of X's files (a hex digest and a
    // "pending-" prefix both sort before "zz-"/"zzz-" lexicographically) — so the splice ALWAYS shifts
    // them, regardless of which of X's two files lands at the lower array index.
    const teamAStalePath = path.join(MERGE_QUARANTINE_DIR, `zz-stale-teamA-r2splice-${freshSfx()}.json`);
    fs.writeFileSync(teamAStalePath, JSON.stringify({ repoPath: teamA, branch: "teamA-branch", reason: "teamA's own pending latch (r2splice)", enteredAt: Date.now(), tokens: ["token-teamA-r2splice"] }, null, 2) + "\n");
    const z = path.join(os.tmpdir(), `loom-mqdog-z-ghost-r2splice-${freshSfx()}`); // NEVER created — wholly unrelated to w/x
    const zStalePath = path.join(MERGE_QUARANTINE_DIR, `zzz-stale-z-r2splice-${freshSfx()}.json`);
    fs.writeFileSync(zStalePath, JSON.stringify({ repoPath: z, branch: "z-branch", reason: "an UNRELATED ghost's own pending latch (r2splice)", enteredAt: Date.now(), tokens: ["token-z-r2splice"] }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([w, teamA, x]);
    check("(precondition) W has no quarantine of its own yet", !activeMergeQuarantineFor(w));
    check("(sanity) teamA is pending (its own divert) before it ever resolves", !!activeMergeQuarantineFor(teamA));
    check("(sanity) Z is pending too, wholly independent", (activeMergeQuarantineFor(z)?.tokens ?? []).includes("token-z-r2splice"));

    // Make teamA resolvable NOW (after boot, so boot never saw it as resolvable — it stayed cleanly
    // pending rather than triggering a migrate-vs-collision at boot time).
    fs.mkdirSync(teamA, { recursive: true });
    check("(precondition) canonicalRepoLockKey(teamA) now equals Kw (collapses via the toplevel walk)", canonicalRepoLockKey(teamA) === kw);

    const token = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, over a two-file X occupant plus a sibling and an unrelated ghost");
    check("*** THE OPT-OUT *** W's fresh raise is enforced IN-MEMORY immediately", (activeMergeQuarantineFor(w)?.tokens ?? []).includes(token));
    check(
      "*** THE FIX (card 1922be3a, round 2) *** teamA's OWN pending latch is correctly consumed into W's union — NOT lost, NOT misattributed to Z",
      (activeMergeQuarantineFor(w)?.tokens ?? []).includes("token-teamA-r2splice"),
    );
    check(
      "*** THE FIX (round 2) *** Z's OWN pending latch is COMPLETELY UNTOUCHED — still independently active, carrying ONLY its own token",
      (activeMergeQuarantineFor(z)?.tokens ?? []).includes("token-z-r2splice") && !(activeMergeQuarantineFor(z)?.tokens ?? []).includes(token),
    );
    check(
      "(sanity) X's own data is STILL tracked (via the full listing), protected aside before the overwrite",
      listActiveMergeQuarantines().some((e) => (e.tokens ?? []).includes("token-x-r2splice")),
    );
  } else if (scenarioName === "round2-protect-does-not-duplicate-already-active-occupant") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // CODE REVIEW d3c36260, BLOCKER 2 — when the occupant physically sitting at Kw's own final is
    // ALREADY tracked as a LIVE, ACTIVE entry elsewhere (X armed at a wholly DIFFERENT key K2, via its
    // own resolvedKey), the protect call used to mint a SECOND, independently-tracked pending record for
    // the SAME identity. clearMergeQuarantineByToken(x, "token-x-r2dup") then found and lifted ONLY the
    // active copy at K2 — the orphaned duplicate pending copy was never touched, leaving X reported as
    // PERMANENTLY quarantined (fail-stuck) even after the real clear and a reboot.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqdog-w-r2dup-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# r2dup\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const x = path.join(w, "gone-subdir"); // NEVER created — the degraded walk-up occupant
    const v = path.join(os.tmpdir(), `loom-mqdog-v-r2dup-${freshSfx()}`); // a SEPARATE real repo — just for a stable, distinct K2
    fs.mkdirSync(v, { recursive: true });
    tmpDirs.push(v);
    fs.writeFileSync(path.join(v, "README.md"), "# v\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: v });
    commitAll(v, "init", GIT_ID);
    const k2 = canonicalRepoLockKey(v);
    check("(precondition) X never exists on disk", !fs.existsSync(x));
    check("(precondition) K2 (v's own key) differs from Kw", k2 !== kw);

    // X's own LIVE raise — a resolvedKey pointing at K2 (a key wholly unrelated to Kw), so PASS 1 arms
    // it DIRECTLY and ACTIVELY at K2 (e1cb7d33's own documented reachability note).
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xAtK2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
    fs.writeFileSync(xAtK2Path, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own LIVE raise (r2dup)", enteredAt: Date.now(), tokens: ["token-x-r2dup"], resolvedKey: k2 }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([w, v, x]);
    check("*** THE OPT-OUT (e1cb7d33) *** X is active AT K2, carrying its own token", (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-r2dup"));
    // (NOT a precondition check: `activeMergeQuarantineFor(w)` legitimately surfaces X's own
    // resolvedKey-dual-tracking pending-divert twin here — card 883e29bc's own design — via a KEY-based
    // tier match (X's degraded `currentKey` happens to equal Kw too), unrelated to identity and
    // unrelated to this card's own fix. `enterMergeQuarantine`'s OWN `activeQuarantines.get(kw)` check
    // is what actually matters, and it is genuinely empty — confirmed by the raise below reaching the
    // "no existing" region at all.)

    // A SEPARATE, STALE leftover physically at Kw's OWN final — written DIRECTLY, AFTER boot, so
    // nothing in THIS process's own memory has ever read or tracked it yet (the exact "neither
    // atFilenameIdx nor atFinalBasenameIdx" shape the mint-vs-attach decision needs to discriminate).
    const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
    fs.writeFileSync(xAtKwPath, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own STALE leftover, still at Kw (r2dup)", enteredAt: Date.now() - 120_000, tokens: ["token-x-r2dup"] }, null, 2) + "\n");

    const token = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, over a stale leftover of an identity already LIVE elsewhere");
    check("*** THE OPT-OUT *** W's fresh raise is enforced IN-MEMORY immediately", (activeMergeQuarantineFor(w)?.tokens ?? []).includes(token));
    const xEntriesAfterRaise = listActiveMergeQuarantines().filter((e) => e.repoPath === x);
    check(
      "*** THE FIX (card 1922be3a, round 2) *** exactly ONE tracked record exists for X after the raise — no duplicate was minted",
      xEntriesAfterRaise.length === 1 && (xEntriesAfterRaise[0]?.tokens ?? []).includes("token-x-r2dup"),
    );

    // P1 (manager ruling, round 3; CR e3b80d6d BLOCKER B1) — a REBOOT inserted HERE, between the raise
    // and the clear, is what the round-2 fix's own protect call cannot survive: the fold into the live
    // entry's own `orphanLatchFiles` (round 2's `liveEntrySupersettingTokens` branch) is IN-MEMORY ONLY —
    // it never durably rewrites X's own live latch at K2 — so a boot that reads ONLY the still-stale
    // on-disk sha(K2).json re-discovers the durably-protected divert file as an UNREFERENCED, independent
    // pending record. (sanity, ACCEPTED residual — round 2's own in-memory fold is kept as-is, per the
    // round-3 ruling; this card does not prevent the re-discovery) X now DOES carry two records on disk —
    // the live one at K2, and the re-discovered orphaned pending one — both still carrying the token.
    const bootAfterRaise = await freshBootModule();
    bootAfterRaise.reenterMergeQuarantinesAtBoot([w, v, x]);
    const xEntriesAfterRaiseReboot = bootAfterRaise.listActiveMergeQuarantines().filter((e) => e.repoPath === x);
    check(
      "(sanity, accepted residual) X carries (at least) one record after a reboot too, still carrying its own token — the fix's own scope is making the CLEAR below sweep every such record, not preventing the re-discovery",
      xEntriesAfterRaiseReboot.length >= 1 && xEntriesAfterRaiseReboot.every((e) => (e.tokens ?? []).includes("token-x-r2dup")),
    );

    // *** THE PROBE'S OWN CONSEQUENCE, now AFTER the reboot *** clearing X's real token, then clearing W
    // too (so Kw's own direct-verified-guard shortcut no longer shadows a query for X), must fully,
    // durably lift X — no orphaned duplicate left behind to resurrect it, reboot or not.
    bootAfterRaise.clearMergeQuarantineByToken(x, "token-x-r2dup");
    bootAfterRaise.clearMergeQuarantine(w);
    check(
      "*** THE FIX (round 3) *** X is NO LONGER quarantined at all after its own clear, even when a reboot happened between the raise and the clear",
      bootAfterRaise.activeMergeQuarantineFor(x) === undefined,
    );
    check("(sanity) assertRepoNotQuarantined(x) now SUCCEEDS", bootAfterRaise.assertRepoNotQuarantined(x).ok === true);

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([w, v, x]);
    check(
      "*** THE FIX (round 3) *** X stays NOT quarantined after a SECOND real reboot too — nothing resurrects it",
      boot2.activeMergeQuarantineFor(x) === undefined,
    );
  } else if (scenarioName === "partial-overlap-pending-leftover-stays-blocked-until-both-tokens-cleared") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // P8 (manager ruling, round 3; CR e3b80d6d BLOCKER B2) — a same-identity leftover pending record can
    // carry a PARTIAL OVERLAP with a live active entry's own current tokens (a prior clear already lifted
    // ONE of the live entry's own tokens, but a stale leftover — a separate, never-synced copy — still
    // carries BOTH). The round-2 `liveEntrySupersettingTokens` check correctly refuses to fold this
    // leftover into the live entry (no longer a superset) and mints an INDEPENDENT pending record instead
    // — but the OLD `clearMergeQuarantineByToken` stopped at the first match (the active entry) and never
    // swept that independent pending record at all, leaving X's own EXTRA token (tb) fail-stuck forever.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqdog-w-p8-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# p8\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const x = path.join(w, "gone-subdir"); // NEVER created — the degraded walk-up occupant
    const v = path.join(os.tmpdir(), `loom-mqdog-v-p8-${freshSfx()}`); // a SEPARATE real repo — just for a stable, distinct K2
    fs.mkdirSync(v, { recursive: true });
    tmpDirs.push(v);
    fs.writeFileSync(path.join(v, "README.md"), "# v\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: v });
    commitAll(v, "init", GIT_ID);
    const k2 = canonicalRepoLockKey(v);
    check("(precondition) X never exists on disk", !fs.existsSync(x));
    check("(precondition) K2 (v's own key) differs from Kw", k2 !== kw);

    // X's own LIVE raise — armed directly at K2, carrying BOTH tokens.
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xAtK2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
    fs.writeFileSync(xAtK2Path, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own LIVE raise (p8)", enteredAt: Date.now(), tokens: ["token-x-p8-ta", "token-x-p8-tb"], resolvedKey: k2 }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([w, v, x]);
    check(
      "(precondition) X is active at K2, carrying BOTH tokens",
      (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-p8-ta") && (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-p8-tb"),
    );

    // A STALE leftover, written DIRECTLY to Kw's own final WHILE X is still live at K2 holding both
    // tokens — a snapshot of X's content at that moment, carrying the SAME two tokens, never synced since.
    const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
    fs.writeFileSync(xAtKwPath, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own STALE leftover, still at Kw (p8)", enteredAt: Date.now() - 120_000, tokens: ["token-x-p8-ta", "token-x-p8-tb"] }, null, 2) + "\n");

    // The human (or an auto-clear) lifts ONLY "tb" from the LIVE entry — the stale leftover is never told.
    clearMergeQuarantineByToken(x, "token-x-p8-tb");
    check(
      "(precondition) X's LIVE entry now carries only ta — tb was lifted",
      (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-p8-ta") && !(activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-p8-tb"),
    );

    const token = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, over a stale leftover that still outranks the live entry's own reduced token set");
    check("*** THE OPT-OUT *** W's fresh raise is enforced IN-MEMORY immediately", (activeMergeQuarantineFor(w)?.tokens ?? []).includes(token));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([w, v, x]);
    check("(sanity) X is still blocked after a real reboot (ta is live, tb is pending — both fail-closed)", boot2.assertRepoNotQuarantined(x).ok === false);

    boot2.clearMergeQuarantineByToken(x, "token-x-p8-ta");
    check(
      "*** THE FIX (card 1922be3a, round 3) *** X is STILL blocked after clearing ta alone — tb's own independent pending record survives, fail-closed",
      boot2.assertRepoNotQuarantined(x).ok === false,
    );
    boot2.clearMergeQuarantineByToken(x, "token-x-p8-tb");
    // W's own raise is still armed at Kw too — x's degraded walked-up key collides with it, so
    // assertRepoNotQuarantined(x) would read blocked on THAT basis alone until W is also cleared; clear
    // it first so this check discriminates on X's own residual, not W's.
    boot2.clearMergeQuarantine(w);
    check(
      "*** THE FIX (round 3) *** X is finally free once BOTH tokens are cleared",
      boot2.assertRepoNotQuarantined(x).ok === true,
    );

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([w, v, x]);
    check("*** THE FIX (round 3) *** X stays free after a SECOND real reboot too", boot3.assertRepoNotQuarantined(x).ok === true);
  } else if (scenarioName === "extra-pending-token-stays-blocked-until-cleared") {
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    // P3 (manager ruling, round 3) — a same-identity leftover pending record can carry an EXTRA token the
    // live active entry never held AT ALL (tc below) — distinct from P8's PARTIAL-OVERLAP shape (where
    // the leftover and the live entry share SOME, but not all, tokens). Both shapes need the SAME fix:
    // the pending side must be swept on EVERY clearByToken call, never only the one that happens to match
    // the active entry first.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    const w = path.join(os.tmpdir(), `loom-mqdog-w-p3-${freshSfx()}`);
    fs.mkdirSync(w, { recursive: true });
    tmpDirs.push(w);
    fs.writeFileSync(path.join(w, "README.md"), "# p3\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: w });
    commitAll(w, "init", GIT_ID);
    const kw = canonicalRepoLockKey(w);
    const x = path.join(w, "gone-subdir"); // NEVER created — the degraded walk-up occupant
    const v = path.join(os.tmpdir(), `loom-mqdog-v-p3-${freshSfx()}`);
    fs.mkdirSync(v, { recursive: true });
    tmpDirs.push(v);
    fs.writeFileSync(path.join(v, "README.md"), "# v\n");
    execSync(`git init -q && git config user.email mqdog@loom && git config user.name mqdog`, { cwd: v });
    commitAll(v, "init", GIT_ID);
    const k2 = canonicalRepoLockKey(v);
    check("(precondition) X never exists on disk", !fs.existsSync(x));
    check("(precondition) K2 (v's own key) differs from Kw", k2 !== kw);

    // X's own LIVE raise — armed directly at K2, carrying ONLY "ta".
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const xAtK2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
    fs.writeFileSync(xAtK2Path, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own LIVE raise (p3)", enteredAt: Date.now(), tokens: ["token-x-p3-ta"], resolvedKey: k2 }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([w, v, x]);
    check("(precondition) X is active at K2, carrying only ta", (activeMergeQuarantineFor(x)?.tokens ?? []).includes("token-x-p3-ta"));

    // A STALE leftover at Kw's own final, carrying BOTH "ta" AND an extra token "tc" the live entry never
    // held — a distinct identity-matching record never folded into (or synced from) the live entry.
    const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
    fs.writeFileSync(xAtKwPath, JSON.stringify({ repoPath: x, branch: "x-branch", reason: "X's own STALE leftover with an extra token, still at Kw (p3)", enteredAt: Date.now() - 120_000, tokens: ["token-x-p3-ta", "token-x-p3-tc"] }, null, 2) + "\n");

    const token = enterMergeQuarantine(w, "w-branch", "W's own fresh raise, over a stale leftover carrying an extra token the live entry never held");
    check("*** THE OPT-OUT *** W's fresh raise is enforced IN-MEMORY immediately", (activeMergeQuarantineFor(w)?.tokens ?? []).includes(token));

    const boot2 = await freshBootModule();
    boot2.reenterMergeQuarantinesAtBoot([w, v, x]);
    check("(sanity) X is still blocked after a real reboot", boot2.assertRepoNotQuarantined(x).ok === false);

    boot2.clearMergeQuarantineByToken(x, "token-x-p3-tc");
    check(
      "*** THE FIX (card 1922be3a, round 3) *** X is STILL blocked after clearing the extra token tc alone — ta's own live entry survives, fail-closed",
      boot2.assertRepoNotQuarantined(x).ok === false,
    );
    boot2.clearMergeQuarantineByToken(x, "token-x-p3-ta");
    // W's own raise is still armed at Kw too — x's degraded walked-up key collides with it, so
    // assertRepoNotQuarantined(x) would read blocked on THAT basis alone until W is also cleared; clear
    // it first so this check discriminates on X's own residual, not W's.
    boot2.clearMergeQuarantine(w);
    check(
      "*** THE FIX (round 3) *** X is finally free once BOTH ta and tc are cleared",
      boot2.assertRepoNotQuarantined(x).ok === true,
    );

    const boot3 = await freshBootModule();
    boot3.reenterMergeQuarantinesAtBoot([w, v, x]);
    check("*** THE FIX (round 3) *** X stays free after a SECOND real reboot too", boot3.assertRepoNotQuarantined(x).ok === true);
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
