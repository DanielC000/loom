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
//     behavior for the raise (durable across a reboot) and documents the REMAINING residual: a raise in
//     this exact shape still overwrites the degraded occupant's own file (pre-existing, unfixed by this
//     card — see the decision record for the precise shape).
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
      + "fresh raise is durable across a reboot via BOTH of enterMergeQuarantine's own opt-out shapes. The "
      + "brand-new-entry branch's own occupant-overwrite residual is reported, not fixed, here (a VERIFIED "
      + "raiser — see card 2a6a8073); the pending-merge branch's own residual (an UNVERIFIED raiser) IS "
      + "fixed (card d4b25feb — that branch no longer reaches writeMergeQuarantineLatch at all for an "
      + "unverified raiser). The guard still allows a legitimate resolvable-different-identity overwrite "
      + "THROUGH A GUARDED CALLER (never the opted-out enterMergeQuarantine path). clear(S) is deliberately "
      + "out of scope — see the decision record."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card e1cb7d33.`);
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
  MERGE_QUARANTINE_DIR, listActiveMergeQuarantines,
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
    // the opt-out restores that pre-fix durability, and separately documents the REMAINING residual (the
    // degraded occupant's own file is still destroyed in this exact shape — pre-existing, unfixed here).
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
      "(documented residual, pre-existing — see the decision record) the write proceeded and X's own physical file is now teamA's content, not X's",
      JSON.parse(fs.readFileSync(xAtKpPath, "utf8")).repoPath === teamA,
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
    check(
      "(documented residual, pre-existing) X is no longer independently active after the reboot either — its data was genuinely overwritten, not merely subsumed into a union",
      boot2.activeMergeQuarantineFor(x) === undefined,
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
