import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card b5c94cbe (discovered from card 6c04633d's worker + CR 2a32633c) — closes a Follow-up gap in
// decision docs/decisions/82032b5c-runtime-union-armed-key-and-contributor-provenance.md's own round 1:
// that card scoped `contributorRepoPaths` inference NARROWLY to `enterMergeQuarantine`'s own `existing`
// branch, leaving `consumeMatchedPendingsIntoArmedEntry`'s cross-tier-sibling union (a DIFFERENT,
// RUNTIME union path — a live query's own lazy-graduation tail, or a raise's own sibling-absorb — never
// boot-time `armQuarantineKey`/`398f476c`'s scope) as a known residual (9a55fb90's own "a NEW runtime
// union path" note).
//
// THREE call sites reach the shared `consumeMatchedPendingsIntoArmedEntry` union; this file drives TWO
// of them directly, by name (the third — `enterMergeQuarantine`'s own `existing`-branch sibling-absorb,
// ~:2738 — is a RAISE on an ALREADY-ARMED key, covered only incidentally by the pre-existing
// `merge-quarantine-cross-tier-sibling-absorb.mjs` corpus, re-run green but not extended here):
//   SITE A — `activeMergeQuarantineFor`'s own lazy-graduation tail (a QUERY) — SCENARIOS 1-3.
//   SITE B — `enterMergeQuarantine`'s own pending-merge branch (~:2831, a fresh RAISE with no pending
//            entry of its own) — SCENARIO 4.
//
// Built on the SAME harness/shape as the sibling `merge-quarantine-cross-tier-sibling-absorb.mjs`
// SCENARIO 1 (SITE 2 — the lazy-graduation tail): toplevel repo R; pending entries for D = R/d-sub
// (newer) and S = R/s-sub (older, enteredAt -100s). A query via D's own identity graduates BOTH into one
// armed entry at R's canonical key — `unionQuarantineEntries`' tie-break (older wins) keeps S's own
// identity as the entry's `repoPath`.
//
// SCENARIO 1 (THE FIX, SITE A) — the graduated entry's own `contributorRepoPaths` now names D (the
// losing identity), mirroring `enterMergeQuarantine`'s own `existing` branch.
//
// SCENARIO 2 (THE MEASURED "MASKED HARD DELETE," now closed, SITE A) — clear-by-id
// (`clearMergeQuarantineLatchFile`) on the union's own armed key, addressed by a bare id naming NEITHER
// identity, now FAILS CLOSED (ambiguous, naming both identities) instead of silently succeeding and
// lifting D's own enforcement too — the SAME shape `82032b5c` closed for `enterMergeQuarantine`'s
// branch, reproduced (pre-fix) and now closed at this second, runtime-union call site. Checked
// in-process, AND across a reboot via a SECOND clear-by-id against the freshly re-parsed entry (not
// merely "is D still active" — a fresh module's own graduation never re-runs the union once only one
// physical file remains, so this is the check that is actually sensitive to whether `contributorRepoPaths`
// round-tripped through the JSON parse, not just to the in-memory runtime stamp).
//
// SCENARIO 3 (CLEAR-BY-PATH'S ACTION IS UNCHANGED — Lead ruling, round 3 of 82032b5c, SITE A) —
// clearing by S's own recorded path still lifts the WHOLE entry, D's folded-in token included
// (already-accepted, documented residual: the entry's own stored identity IS S, and clear-by-path never
// refuses). Clearing by D's own recorded path still reports `wasQuarantined:false` (D still has no entry
// of its own `repoPath` to match) — `clearMergeQuarantineByRecordedPath` deliberately never consults
// `contributorRepoPaths` (round 3's own Lead ruling: "do NOT make clear-by-path honour contributor
// identities — that depends on 398f476c's own token-split question"). This is NOT the defect this card
// closes — see SCENARIO 2 for the route that WAS fixed (clear-by-id, not clear-by-path).
//
// SCENARIO 4 (SITE B — the raise-branch shape) — S is pending (older); D instead RAISES (never queried
// first). D (the RAISER itself) loses `unionQuarantineEntries`' own tie-break to its OWN older sibling —
// `contributorRepoPaths` still correctly names D despite D being both the raiser AND the loser, and
// clear-by-id still fails closed naming D, who stays enforced.
//
// NEGATIVE CONTROL (run by hand, not scripted here — see this card's worker_report): reverting ONLY the
// `consumeMatchedPendingsIntoArmedEntry` stamp (merge-quarantine.ts, `@decision 82032b5c (round 6,
// Follow-up b5c94cbe)`) turns SCENARIOS 1, 2, and 4's own "fix" checks RED, while SCENARIO 3 stays GREEN
// on both sides — proving the fix, not an unrelated behavior change, is what those checks depend on.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqlgca-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile,
  activeMergeQuarantineFor, enterMergeQuarantine, reenterMergeQuarantinesAtBoot,
  quarantineLatchFileIdsFor, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// A genuinely fresh ESM module instance (its OWN empty activeQuarantines/pendingUnresolvedQuarantines) to
// prove a "survives/escapes a reboot" claim — same technique as the sibling repro files. Reads ONLY the
// durable files on disk, never this process's own in-memory state.
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const GIT_ID = "-c user.email=mqlgca@loom -c user.name=mqlgca";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRepoWithTwoSubdirs(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlgca-repo-${tag}-${freshSfx()}`);
  const dSub = path.join(repo, "d-sub");
  const sSub = path.join(repo, "s-sub");
  fs.mkdirSync(dSub, { recursive: true });
  fs.mkdirSync(sSub, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe (${tag})\n`);
  execSync(`git init -q && git config user.email mqlgca@loom && git config user.name mqlgca`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, dSub, sSub };
}

// Builds the D(newer)/S(older) pending fixture, boots them as pending, then graduates both via a query
// through D's own identity — returns the graduated armed entry plus the repo paths/key for the caller to
// act on. Factored out so each scenario below gets its OWN fresh, independent fixture (clearing is
// destructive — scenarios must never share state).
function buildAndGraduate(tag) {
  const { repo, dSub, sSub } = makeRepoWithTwoSubdirs(tag);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(sSub)}.json`), JSON.stringify({
    repoPath: sSub, branch: "s-branch", reason: `${tag} s-sub's own pending raise (older)`, enteredAt: Date.now() - 100_000, tokens: ["tokS"],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(dSub)}.json`), JSON.stringify({
    repoPath: dSub, branch: "d-branch", reason: `${tag} d-sub's own pending raise (newer)`, enteredAt: Date.now(), tokens: ["tokD"],
  }, null, 2) + "\n");

  const parkedRepo = path.join(os.tmpdir(), `loom-mqlgca-parked-${tag}-${freshSfx()}`);
  fs.renameSync(repo, parkedRepo);
  const found = reenterMergeQuarantinesAtBoot([dSub, sSub]);
  check(`(${tag} precondition) boot sees both D and S as pending`, found.length === 2);
  fs.renameSync(parkedRepo, repo);

  const key = canonicalRepoLockKey(dSub);
  check(`(${tag} precondition) D and S share one canonical key`, canonicalRepoLockKey(sSub) === key);

  const activeD = activeMergeQuarantineFor(dSub); // THE GRADUATION QUERY
  check(`(${tag} graduation) D reads as quarantined`, !!activeD);
  check(`(${tag} graduation) tokens unioned (D+S)`, (activeD?.tokens ?? []).includes("tokD") && (activeD?.tokens ?? []).includes("tokS"));
  check(`(${tag} graduation) S (the older identity) wins the union's own repoPath`, activeD?.repoPath === sSub);

  return { repo, dSub, sSub, key, activeD };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — THE FIX: D's own identity is recorded in contributorRepoPaths.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, dSub } = buildAndGraduate("s1");
    const activeD = activeMergeQuarantineFor(dSub);
    check("(s1 FIX) D's own identity IS recorded in contributorRepoPaths", (activeD?.contributorRepoPaths ?? []).some((p) => p === dSub));
    try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — clear-by-id on the union's armed key (a bare id, naming NEITHER identity) now FAILS
  // CLOSED instead of silently lifting D — the measured "masked hard delete" this card closes.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, dSub, sSub } = buildAndGraduate("s2");
    const activeDBefore = activeMergeQuarantineFor(dSub);
    const id = quarantineLatchFileIdsFor(activeDBefore)[0];
    check("(s2 precondition) a real latch id resolves for the union", typeof id === "string" && id.length > 0);

    const clearByIdResult = clearMergeQuarantineLatchFile(id);
    note(`(s2) clearMergeQuarantineLatchFile(${id}) => ${JSON.stringify(clearByIdResult)}`);
    check("(s2 FIX) clear-by-id on an ambiguous cross-tier union now FAILS CLOSED (ok:false)", clearByIdResult.ok === false);
    check("(s2 FIX) the refusal names D's own path", clearByIdResult.ok === false && clearByIdResult.reason.includes(dSub));

    const activeDAfter = activeMergeQuarantineFor(dSub);
    check("(s2 FIX) IN-PROCESS: D is NOT silently lifted", !!activeDAfter);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([dSub, sSub]);
    const activeDAfterReboot = fresh.activeMergeQuarantineFor(dSub);
    check("(s2 FIX) AFTER REBOOT: D is NOT silently lifted", !!activeDAfterReboot);

    // THE PERSISTENCE CHECK (CR finding, Minor 2): the check above alone proves nothing about whether
    // `contributorRepoPaths` round-tripped through disk — the fresh module's own graduation query would
    // re-derive it from the in-memory RUNTIME union the same way regardless (and by this point only ONE
    // physical latch file remains, so there is no second pending entry left to re-union on this boot).
    // Actually drive a SECOND clear-by-id against the FRESH module's own re-parsed entry: it is sensitive
    // ONLY to whether `contributorRepoPaths` survived the JSON round-trip, since `fresh`'s own in-memory
    // graduation never re-runs `consumeMatchedPendingsIntoArmedEntry` here (nothing left to union).
    const idAfterReboot = fresh.quarantineLatchFileIdsFor(activeDAfterReboot)[0];
    const clearByIdAfterReboot = fresh.clearMergeQuarantineLatchFile(idAfterReboot);
    note(`(s2) AFTER REBOOT: fresh.clearMergeQuarantineLatchFile(${idAfterReboot}) => ${JSON.stringify(clearByIdAfterReboot)}`);
    check("(s2 FIX, PERSISTENCE) AFTER REBOOT: clear-by-id still FAILS CLOSED (ok:false)", clearByIdAfterReboot.ok === false);
    check("(s2 FIX, PERSISTENCE) AFTER REBOOT: the refusal still names D's own path", clearByIdAfterReboot.ok === false && clearByIdAfterReboot.reason.includes(dSub));

    try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — clear-by-path's ACTION is UNCHANGED (round-3 Lead ruling on 82032b5c): clearing by S's
  // own recorded path still lifts the whole entry (D's token included — already-accepted); clearing by
  // D's own recorded path still reports wasQuarantined:false (clear-by-path never consults
  // contributorRepoPaths). Neither half of this scenario is the defect this card closes.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, dSub, sSub } = buildAndGraduate("s3");

    // 3a — D's own recorded path: UNCHANGED misreport, by design (not fixed here — see this card's own
    // worker_report for why: round-3 of 82032b5c explicitly rules clear-by-path must never honour
    // contributorRepoPaths; that is 398f476c's own, larger token-split scope).
    const clearDResult = clearMergeQuarantineByRecordedPath(dSub);
    check("(s3a UNCHANGED) clearMergeQuarantineByRecordedPath(D) still reports wasQuarantined:false", clearDResult.wasQuarantined === false);
    check("(s3a UNCHANGED) D is still enforced afterward (fail-closed, never silently lifted)", !!activeMergeQuarantineFor(dSub));

    // 3b — S's own recorded path: UNCHANGED accepted behavior — lifts the whole entry, D included.
    const clearSResult = clearMergeQuarantineByRecordedPath(sSub);
    check("(s3b UNCHANGED) clearMergeQuarantineByRecordedPath(S) reports wasQuarantined:true", clearSResult.wasQuarantined === true);
    check("(s3b UNCHANGED) D's own enforcement is ALSO lifted (same shared token set — accepted, documented in 82032b5c's own DoD)", !activeMergeQuarantineFor(dSub));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([dSub, sSub]);
    check("(s3b UNCHANGED) survives a reboot: D stays lifted too (same shared physical file)", !fresh.activeMergeQuarantineFor(dSub));

    try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 — THE THIRD CALL SITE (CR Probe B shape): `enterMergeQuarantine`'s own pending-merge
  // branch (~:2831), where the RAISER ITSELF ends up the LOSING identity. S is already pending (older);
  // D RAISES (never queried first) — the fresh raise's own `enteredAt` (`Date.now()`) is always newer
  // than S's, so D loses `unionQuarantineEntries`' tie-break to its OWN sibling. Same fix, same site,
  // different entry point than scenarios 1-3 (a raise, not a query).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo, dSub, sSub } = makeRepoWithTwoSubdirs("s4");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

    // Only S is pre-seeded as pending (older). D has NO pending entry of its own — it is about to RAISE.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${oldHashFor(sSub)}.json`), JSON.stringify({
      repoPath: sSub, branch: "s-branch", reason: "s4 s-sub's own pending raise (older)", enteredAt: Date.now() - 100_000, tokens: ["tokS-s4"],
    }, null, 2) + "\n");

    const parkedRepo = path.join(os.tmpdir(), "loom-mqlgca-parked-s4-" + freshSfx());
    fs.renameSync(repo, parkedRepo);
    const found = reenterMergeQuarantinesAtBoot([sSub]);
    check("(s4 precondition) boot sees S as pending", found.length === 1);
    fs.renameSync(parkedRepo, repo);

    const key = canonicalRepoLockKey(dSub);
    check("(s4 precondition) D and S share one canonical key", canonicalRepoLockKey(sSub) === key);

    // THE RAISE — D has no pending entry of its own; this hits enterMergeQuarantine's pending-merge
    // branch (~:2831), which absorbs S's own cross-tier-sibling pending entry via `extra:fresh`.
    const dToken = enterMergeQuarantine(dSub, "s4-d-branch", "s4 d-sub's own fresh raise");
    const activeD = activeMergeQuarantineFor(dSub);
    check("(s4 raise) D reads as quarantined with its own fresh token", !!activeD && (activeD.tokens ?? []).includes(dToken));
    check("(s4 raise) S's own sibling token is absorbed too", (activeD?.tokens ?? []).includes("tokS-s4"));
    check("(s4 raise) S (the older identity) wins the union's own repoPath — D (the RAISER) is the loser", activeD?.repoPath === sSub);
    check("(s4 FIX) D's own identity (the raiser, despite losing) IS recorded in contributorRepoPaths", (activeD?.contributorRepoPaths ?? []).some((p) => p === dSub));

    const id = quarantineLatchFileIdsFor(activeD)[0];
    const clearByIdResult = clearMergeQuarantineLatchFile(id);
    note(`(s4) clearMergeQuarantineLatchFile(${id}) => ${JSON.stringify(clearByIdResult)}`);
    check("(s4 FIX) clear-by-id on this raise-branch union also FAILS CLOSED (ok:false)", clearByIdResult.ok === false);
    check("(s4 FIX) the refusal names D's own path", clearByIdResult.ok === false && clearByIdResult.reason.includes(dSub));
    check("(s4 FIX) D (the raiser) stays enforced — never silently lifted", !!activeMergeQuarantineFor(dSub));

    try { clearMergeQuarantine(repo); } catch { /* best-effort */ }
  }
} finally {
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
