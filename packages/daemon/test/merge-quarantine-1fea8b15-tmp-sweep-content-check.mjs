import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1fea8b15 — `deleteMergeQuarantineLatchByKey`'s own trailing tmp-residue sweep (the ONE call
// site 21ec39e5 deliberately left `unconditional-owner-protected`, on the strength of a comment claiming
// `protectForeignTmpResidueBeforeSweep` "already" content-protected it) is now `content-checked` too.
//
// THE GAP THIS CLOSES: `protectForeignTmpResidueBeforeSweep` deliberately skips protecting a tmp whose
// own `repoPath` is currently RESOLVABLE (card d2582692's own "a resolvable leftover is safe to
// overwrite today" exclusion) and one whose content carries no string `repoPath` at all — the
// unconditional sweep right after then deleted exactly those two shapes with NO content check
// whatsoever. 21ec39e5 already established a `.json.tmp-<pid>` residue CAN be the only durable copy of
// a token — this card's own repro shows that premise defeats d2582692's resolvable-is-safe exclusion
// concretely: a foreign tmp holding a disjoint, uncovered token, for an identity that has since become
// resolvable (its directory recreated, but still no `.git` of its own — so it never gets its OWN key),
// was destroyed with zero record anywhere (no `contentKeptRepoPaths`, no `stillBlockedCoOccupants`).
//
// THE FIX: the trailing sweep now runs with `candidateTokens: clearedEntry?.tokens ?? []` instead of the
// removed `unconditional-owner-protected` mode — the same shared `orphanSweepSafeToDelete` chokepoint
// every other Fix-A (21ec39e5) call site already uses, which has neither of
// `protectForeignTmpResidueBeforeSweep`'s own two exclusions. Its own REFERENCE-owned keep outcomes are
// folded into this function's own `kept` return; its CONTENT-only keeps are a separate `contentKept`
// field (round 2, Code Review BLOCKING 2 — a content-kept entry has no live entry backing it and must
// never be reported as a blocked co-occupant with a working `{id}` route).
//
// ROUND 2 (Code Review): `protectForeignTmpResidueBeforeSweep`'s own `ownTokens` is now PER-FILE
// (`ownTokensByFile`), never a flat, cross-file-mergeable list — round 1's flat shape let a same-identity
// stray tmp's own tokens wrongly cover a DIFFERENT, genuinely foreign tmp sharing the same hash (BLOCKING
// 1). The dead `unconditional-owner-protected` mode/branch was deleted (nothing called it any more).
//
// See docs/decisions/1fea8b15-content-check-the-clear-time-tmp-sweep.md for the full repro narrative,
// the ruling on d2582692's exclusion, the round-2 findings above, and why the residual below is FAIL-OPEN
// AT RUNTIME (not merely "bounded") until the next boot.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq1fea8b-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// A genuinely fresh ESM module instance per "boot" — mirrors 21ec39e5's own test's own freshBootModule.
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq1fea8b@loom -c user.name=mq1fea8b";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq1fea8b-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-1fea8b15-tmp-sweep-content-check\n");
  execSync(`git init -q && git config user.email mq1fea8b@loom && git config user.name mq1fea8b`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function plantStrandedTmp(key, repoPath, token, suffix) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({
    repoPath, branch: "d-branch", reason: "D's own real raise, never promoted (torn write)",
    enteredAt: Date.now() - 1000, tokens: [token],
  }, null, 2) + "\n");
  return tmpPath;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-resolvable-foreign-tmp-protected (THE MAIN FINDING) — D's own stranded tmp (a disjoint,
  // uncovered token) must survive R's clear once D becomes resolvable, instead of being destroyed blind.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("resolvable-r");
    const d = path.join(r, "ghost-subdir"); // no own .git — walks up to R's own key
    const key = canonicalRepoLockKey(r);
    check("(resolvable) precondition: D's key collides with R's (ancestor walk)", canonicalRepoLockKey(d) === key);

    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const dToken = "D-DISJOINT-TOKEN-resolvable";
    const strandedDTmp = plantStrandedTmp(key, d, dToken, "88881-cafed001");
    check("(resolvable) precondition: D's stranded tmp exists before D remounts", fs.existsSync(strandedDTmp));

    // D "remounts" — the directory now exists, but still has no .git of its own.
    fs.mkdirSync(d, { recursive: true });
    check("(resolvable) D's key STILL collides with R's after remount (no own .git)", canonicalRepoLockKey(d) === key);

    const clearResult = clearMergeQuarantine(r);
    check("*** THE FIX (resolvable) *** D's foreign tmp residue SURVIVES R's clear", fs.existsSync(strandedDTmp));
    // @decision 25d0d45b — the residual this closed for this exact shape: D is now armed/enforced
    // IN-PROCESS immediately, not merely kept-and-deferred-to-the-next-boot. See the decision record.
    check("*** 25d0d45b CLOSES THE RUNTIME RESIDUAL (resolvable) *** D is now armed in-process immediately", assertRepoNotQuarantined(d).ok === false);
    // @decision 25d0d45b (Code Review, MAJOR 1) — SUPERSEDES the original 1fea8b15 round-2 framing: once
    // armed, D is a genuine live entry with a working `{id}` route — report it via
    // `stillBlockedCoOccupants`, never `contentKeptRepoPaths`. See the decision record.
    check("(resolvable) D is NOT in contentKeptRepoPaths (it is now a genuine live entry, not content-only)",
      !clearResult.contentKeptRepoPaths?.includes(d));
    const dCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
    check("*** THE FIX IS CORRECTLY REPORTED (resolvable) *** D IS in stillBlockedCoOccupants, with a route id", !!dCoOccupant?.route?.id);
    check("(resolvable) result-says-blocked === assertRepoNotQuarantined-refuses", !!dCoOccupant === (assertRepoNotQuarantined(d).ok === false));
    // Prove the route is GENUINELY working, not merely structurally present: actually clear D by that id.
    // @decision 25d0d45b (Round 3, NIT 7) — guarded: a RED run (route.id missing) must report a FAIL
    // here, never throw a TypeError that aborts the process and hides every scenario after this one.
    const dClearById = dCoOccupant?.route?.id ? clearMergeQuarantineLatchFile(dCoOccupant.route.id) : { ok: false, liftedRepoPaths: [] };
    check("(resolvable) D's own {id} route is a REAL, WORKING clear route", dClearById.ok === true && dClearById.liftedRepoPaths.includes(d));
    check("(resolvable) ...and D now reads unblocked after clearing it by that id", assertRepoNotQuarantined(d).ok === true);

    try { fs.unlinkSync(strandedDTmp); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-unresolvable-foreign-tmp-still-protected (CONTROL) — the pre-existing protection for a
  // currently-unresolvable foreign occupant is unaffected by this card's own trailing-sweep fix. D's
  // content is still durably protected — relocated to a fresh pending-divert record, per
  // `protectForeignTmpResidueBeforeSweep`'s own pre-existing behavior — and its now-redundant ORIGINAL
  // tmp (content fully duplicated into that new record) is cleaned up rather than left as dead residue
  // (this card's OWN companion fix — see `protectForeignTmpResidueBeforeSweep`'s own `@decision 1fea8b15`
  // comment). The file PATH changes; the TOKEN never disappears.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("unresolvable-r");
    const d = path.join(r, "ghost-subdir");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const dToken = "D-DISJOINT-TOKEN-unresolvable";
    const strandedDTmp = plantStrandedTmp(key, d, dToken, "88882-cafed002");
    check("(unresolvable) precondition: D's tmp exists, D stays unresolvable", fs.existsSync(strandedDTmp) && !fs.existsSync(d));

    const clearResult = clearMergeQuarantine(r);
    // @decision 1fea8b15 (round 2) — EXACT channel: this is a REAL, relocated pending record (a live
    // entry with a working `{id}` clear-by-id route), so it belongs in `stillBlockedCoOccupants`, never
    // `contentKeptRepoPaths` (that channel is reserved for a PURE content-parse with no live entry).
    check("(unresolvable control) D's content is still durably protected via a real route in stillBlockedCoOccupants",
      !!clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === d));
    check("(unresolvable control) D is NOT in contentKeptRepoPaths (it has a real, live, working route)",
      !clearResult.contentKeptRepoPaths?.includes(d));
    check("(unresolvable control) the now-redundant ORIGINAL tmp is cleaned up (content duplicated elsewhere, never lost)",
      !fs.existsSync(strandedDTmp));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-ownTokens-never-leak-cross-file (Code Review round 2, BLOCKING 1) — a same-identity
  // (R's own) stray tmp's own tokens must NEVER cover a DIFFERENT, genuinely foreign tmp's own check, even
  // when both tmps happen to share one of their tokens. Round 1's own `protectForeignTmpResidueBeforeSweep`
  // returned a FLAT `ownTokens: string[]`, merged globally into the trailing sweep's one candidateTokens
  // list — so R-stray's own tokens (including one that happens to also appear in D's own tmp) wrongly
  // "covered" D's own, wholly unrelated, genuinely foreign content. Fixed by scoping `ownTokensByFile`
  // STRICTLY per `sourceFile`, mirroring `reconciledPlaceholderTokens`'s own per-file discipline.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("ownleak-r");
    const d = path.join(r, "ghost-subdir");
    const key = canonicalRepoLockKey(r);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");

    // D's OWN foreign tmp, holding ONLY its own token.
    const dTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88888-leakd01`);
    fs.writeFileSync(dTmp, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own foreign tmp", enteredAt: Date.now() - 1000, tokens: ["D-ONLY"],
    }, null, 2) + "\n");

    // D must be RESOLVABLE (no own .git) so `protectForeignTmpResidueBeforeSweep`'s own resolvable-skip
    // leaves D's tmp for the TRAILING sweep to decide — otherwise D is already relocated/protected by the
    // earlier pass, before the trailing sweep (and this per-file leak) is ever reached at all.
    fs.mkdirSync(d, { recursive: true });
    check("(ownleak) precondition: D is resolvable, still shares R's key", fs.existsSync(d) && canonicalRepoLockKey(d) === key);

    // R's OWN stray tmp (same identity as the clearer) — coincidentally ALSO names D's own token.
    const rStrayTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88889-leakr02`);
    fs.writeFileSync(rStrayTmp, JSON.stringify({
      repoPath: r, branch: "r-stray-branch", reason: "R's own stray tmp (coincidentally also naming D's token)",
      enteredAt: Date.now() - 1000, tokens: ["R-STRAY", "D-ONLY"],
    }, null, 2) + "\n");
    check("(ownleak) precondition: both tmps exist", fs.existsSync(dTmp) && fs.existsSync(rStrayTmp));

    const clearResult = clearMergeQuarantine(r);
    check("*** THE FIX (round 2, ownleak) *** D's foreign tmp SURVIVES — its own token was never genuinely covered",
      fs.existsSync(dTmp));
    check("(ownleak) R's own stray tmp IS swept (own-identity residue — the intended WFR-2 behavior, unaffected)",
      !fs.existsSync(rStrayTmp));
    // @decision 25d0d45b (Code Review, MAJOR 1) — D is armed here too (resolvable, foreign, uncovered),
    // so it is now a live referencer, never a content-only keep. See the decision record.
    check("(ownleak) D is NOT in contentKeptRepoPaths (it is now a genuine live entry)",
      !clearResult.contentKeptRepoPaths?.includes(d));
    const dCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
    check("*** THE FIX IS CORRECTLY REPORTED (ownleak) *** D IS in stillBlockedCoOccupants, with a route id", !!dCoOccupant?.route?.id);
    check("(ownleak) result-says-blocked === assertRepoNotQuarantined-refuses", !!dCoOccupant === (assertRepoNotQuarantined(d).ok === false));

    try { fs.unlinkSync(dTmp); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-no-repopath-tmp-protected — a tmp whose content carries no string `repoPath` at all is
  // ALSO protected regardless of resolvability (the card's second named gap).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("norp-r");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const strandedTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88883-cafed003`);
    fs.writeFileSync(strandedTmp, JSON.stringify({
      branch: "d-branch", reason: "no repoPath on this record", enteredAt: Date.now() - 1000,
      tokens: ["NO-REPOPATH-DISJOINT-TOKEN"],
    }, null, 2) + "\n");
    check("(no-repoPath) precondition: tmp with no repoPath field exists", fs.existsSync(strandedTmp));

    clearMergeQuarantine(r);
    check("*** THE FIX (no-repoPath) *** a tmp with no string repoPath SURVIVES the clear", fs.existsSync(strandedTmp));

    try { fs.unlinkSync(strandedTmp); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-still-sweeps-pure-subset-tmp (POSITIVE CONTROL) — the common case is unchanged: a tmp
  // whose own tokens are a provable subset of what this clear's own entry already covers is still swept.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("subset-r");
    const key = canonicalRepoLockKey(r);
    const t1 = enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const subsetTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88884-cafed004`);
    fs.writeFileSync(subsetTmp, JSON.stringify({
      repoPath: r, branch: "stale-earlier-attempt", reason: "a genuinely superseded earlier attempt",
      enteredAt: Date.now() - 1000, tokens: [t1],
    }, null, 2) + "\n");
    check("(subset control) precondition: the subset tmp exists", fs.existsSync(subsetTmp));

    clearMergeQuarantine(r);
    check("(subset control) a genuine subset tmp is STILL swept (common case unchanged)", !fs.existsSync(subsetTmp));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-undefined-clearedentry-keeps-foreign-tmp-then-boot-recovers — when `clearedEntry` is
  // undefined at this key (nothing active armed there), `candidateTokens` falls back to `[]` — the
  // conservative, fail-closed default. A foreign tmp at that key survives (never wrongly deleted).
  //
  // R is deliberately NEVER raised here: raising R first, then clearing it, now ARMS D immediately (this
  // card's own main fix) — occupying K — so a SECOND `clearMergeQuarantine(r)` call (the original
  // two-clear shape this scenario used) no longer sees `clearedEntry===undefined`; it finds D's own
  // just-armed entry instead, and (via the pre-existing, unrelated `1872935d` mechanism) ALSO DURABLY
  // RELEASES D, deleting D's own tmp and naming D in `liftedRepoPaths` — see the DEDICATED scenario right
  // after this one, which restores and pins exactly that two-clear shape as current, disclosed behavior.
  // THIS scenario tests the single-clear, genuinely-undefined-`clearedEntry` shape in isolation, with no
  // such second-clear interaction to route around. Never raising R at all reaches
  // `deleteMergeQuarantineLatchByKey` with a genuinely undefined `clearedEntry` on the FIRST (and only)
  // clear call.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("undefined-entry-r"); // never raised
    const d = path.join(r, "ghost-subdir");
    const key = canonicalRepoLockKey(r);
    const dToken = "D-DISJOINT-TOKEN-undefined-clearedentry";
    const strandedDTmp = plantStrandedTmp(key, d, dToken, "88885-cafed005");
    fs.mkdirSync(d, { recursive: true }); // D remounts, still no own .git

    // `clearMergeQuarantineByKey`'s own `entry = activeQuarantines.get(key)` lookup is undefined here —
    // R was never raised, so nothing has EVER occupied K — making `deleteMergeQuarantineLatchByKey`'s
    // `clearedEntry` undefined on this ONE call, no second clear needed.
    const clearResult = clearMergeQuarantine(r);
    check("*** THE FIX (undefined-clearedentry) *** D's foreign tmp residue SURVIVES a clear with no active entry at K", fs.existsSync(strandedDTmp));
    // @decision 25d0d45b — the residual this closed for this exact shape: D is now armed/enforced
    // IN-PROCESS immediately (ACTIVE, since D is resolvable and K was genuinely unoccupied), never
    // merely kept-and-deferred-to-the-next-boot. See the decision record.
    check("*** 25d0d45b CLOSES THE RUNTIME RESIDUAL (undefined-clearedentry) *** D is armed in-process immediately", assertRepoNotQuarantined(d).ok === false);
    // @decision 25d0d45b (Code Review, MAJOR 1) — armed means a genuine live referencer, never content-only.
    check("(undefined-clearedentry) D is NOT in contentKeptRepoPaths (it is now a genuine live entry)",
      !clearResult.contentKeptRepoPaths?.includes(d));
    const dCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
    check("*** THE FIX IS CORRECTLY REPORTED (undefined-clearedentry) *** D IS in stillBlockedCoOccupants, with a route id", !!dCoOccupant?.route?.id);
    check("(undefined-clearedentry) result-says-blocked === assertRepoNotQuarantined-refuses", !!dCoOccupant === (assertRepoNotQuarantined(d).ok === false));
    const dEntryInProcess = activeMergeQuarantineFor(d);
    check("(undefined-clearedentry) ...carrying D's own real token", !!dEntryInProcess && dEntryInProcess.tokens.includes(dToken));

    // The boot leg is KEPT (unchanged intent): a fresh boot reconcile still independently recovers the
    // same tmp residue, consistent with the in-process state above — no split, never a permanent-only-
    // via-boot residual for this shape any more.
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    const dActive = fresh.activeMergeQuarantineFor(d);
    check("(undefined-clearedentry) a fresh boot reconcile ALSO recovers D's kept tmp, with its own token intact",
      !!dActive && dActive.tokens.includes(dToken));
    check("(undefined-clearedentry) the tmp residue itself is gone after boot recovery (promoted to a real final, not left stranded)",
      !fs.existsSync(strandedDTmp));
    check("(undefined-clearedentry) in-process verdict === post-reboot verdict (no split)",
      assertRepoNotQuarantined(d).ok === fresh.assertRepoNotQuarantined(d).ok);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-undefined-clearedentry-TWO-CLEAR-second-clear-durably-releases-D.
  //
  // @decision 25d0d45b (Code Review, MAJOR 2) — never assume a second clear of the host is harmless
  // once the first clear has armed a co-located occupant: it durably releases that occupant too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("undefined-entry-twoclear-r");
    const d = path.join(r, "ghost-subdir");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const dToken = "D-DISJOINT-TOKEN-twoclear";
    const strandedDTmp = plantStrandedTmp(key, d, dToken, "88889-cafed009");
    fs.mkdirSync(d, { recursive: true }); // D remounts, still no own .git

    const clearResult1 = clearMergeQuarantine(r);
    check("(twoclear, first clear) R's final is gone, D's tmp SURVIVES", fs.existsSync(strandedDTmp) && clearResult1.liftedRepoPaths.includes(r));
    check("(twoclear, first clear) D is armed and reports as a genuine blocked co-occupant",
      clearResult1.stillBlockedCoOccupants?.some((c) => c.repoPath === d) && assertRepoNotQuarantined(d).ok === false);

    const clearResult2 = clearMergeQuarantine(r);
    check("*** PINNED, DISCLOSED BEHAVIOR (twoclear, second clear) *** the second clear ALSO durably releases D — named in liftedRepoPaths",
      clearResult2.liftedRepoPaths.includes(r) && clearResult2.liftedRepoPaths.includes(d));
    check("(twoclear, second clear) D's own tmp residue is deleted (durably released, not merely in-process)", !fs.existsSync(strandedDTmp));
    check("(twoclear, second clear) D now reads UNBLOCKED in-process", assertRepoNotQuarantined(d).ok === true);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    check("(twoclear) a later boot ALSO finds D unblocked (the release is durable, not a transient in-process artifact)",
      fresh.assertRepoNotQuarantined(d).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO read-failure-vs-no-repopath-both-protected-for-different-reasons — closes the card's own
  // named test gap: nothing previously tested the `readFailed` vs "readable but no repoPath" split in
  // `orphanSweepSafeToDelete`'s own classification (0 test hits for `readFailed` in this corpus before
  // this scenario). Both shapes end up PROTECTED, but via genuinely different branches — asserted here by
  // the exact, distinct log text each branch produces (21ec39e5 round 2's own fix: `readFailed` is the
  // ONLY reliable read-failure signal, never inferred from a bare `!parsedRepoPath`).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("readfail-r");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);

    // A genuine, non-ENOENT read failure: a DIRECTORY sitting where a tmp file is expected (EISDIR) —
    // orphanSweepSafeToDelete's own catch only special-cases ENOENT, so this hits `readFailed: true`.
    const readFailTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88886-cafed006`);
    fs.mkdirSync(readFailTmp, { recursive: true });

    const lines = [];
    const realError = console.error;
    console.error = (...args) => { lines.push(args.join(" ")); realError(...args); };
    try {
      clearMergeQuarantine(r);
    } finally {
      console.error = realError;
    }
    check("(read-failure) the genuine read-failure tmp SURVIVES the clear", fs.existsSync(readFailTmp));
    check("*** THE GAP THIS CLOSES (read-failure) *** the log text names a read failure, never 'no repoPath'",
      lines.some((l) => l.includes(path.basename(readFailTmp)) && l.includes("could not be read")));
    try { fs.rmSync(readFailTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  {
    const r = makeRepo("norp2-r");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "r-branch", "r's own real raise");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);

    // A genuinely READABLE record that merely lacks a string `repoPath` — the OTHER branch.
    const noRepoPathTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-88887-cafed007`);
    fs.writeFileSync(noRepoPathTmp, JSON.stringify({
      branch: "d-branch", reason: "no repoPath here either", enteredAt: Date.now() - 1000, tokens: ["NO-REPOPATH-2"],
    }, null, 2) + "\n");

    const lines = [];
    const realError = console.error;
    console.error = (...args) => { lines.push(args.join(" ")); realError(...args); };
    try {
      clearMergeQuarantine(r);
    } finally {
      console.error = realError;
    }
    check("(no-repoPath split) the readable-but-no-repoPath tmp SURVIVES the clear", fs.existsSync(noRepoPathTmp));
    check("*** THE GAP THIS CLOSES (no-repoPath split) *** the log text names 'no repoPath', never a read failure",
      lines.some((l) => l.includes(path.basename(noRepoPathTmp)) && l.includes("names no repoPath") && !l.includes("could not be read")));
    try { fs.unlinkSync(noRepoPathTmp); } catch { /* best-effort */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `deleteMergeQuarantineLatchByKey`'s own trailing tmp-residue sweep is content-checked, "
    + "closing the resolvable-leftover and no-repoPath gaps `protectForeignTmpResidueBeforeSweep` left open, "
    + "while the common subset-sweep case stays unchanged and a read-failure is never conflated with a "
    + "readable-but-anonymous record."
  : `\n❌ ${failures} FAILURE(S) — reproduces (or regresses the fix for) board card 1fea8b15.`);
process.exit(failures === 0 ? 0 : 1);
