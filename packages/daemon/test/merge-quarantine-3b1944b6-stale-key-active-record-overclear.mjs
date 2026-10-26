import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3b1944b6 — Code Review 85b2edc7's follow-up on 2a169469: `/clear` (clearMergeQuarantineReporting ->
// clearMergeQuarantine) on a RESOLVABLE R/sub that holds its OWN record under a now-stale key LIFTED R's
// REAL, unrelated quarantine instead, leaving sub's own record fully armed. `clearMergeQuarantine`'s
// resolvable branch unconditionally called `clearMergeQuarantineByKey` on a FRESHLY-WALKED key
// (`canonicalRepoLockKey(repoPath)`) with no check that whatever occupies that key is actually repoPath's
// own identity — if sub's `.git` disappears after an independent raise (collapsing its fresh key onto an
// ancestor R that is itself genuinely, separately quarantined), the fresh-key clear destroyed R's real
// entry while sub's own, now-orphaned record under its OLD key survived untouched.
//
// Fix: `clearMergeQuarantine`'s resolvable branch now checks whether repoPath's OWN identity has a
// GENUINELY INDEPENDENT active record at a key other than the fresh one (via the shared
// `activeMatchesAndLiftedKeysFor` + a dual-tracked-twin exclusion filter — see scenario E below for why
// that exclusion exists) before falling back to the plain, unconditional fresh-key clear. See
// docs/decisions/3b1944b6-stale-key-active-record-over-clear.md for the full investigation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq3b1944b6-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantine,
  clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath, assertRepoNotQuarantined,
  setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly, pushPendingQuarantineTestOnly,
  findPendingIndexByIdentityTestOnly, clearMergeQuarantineByToken, MERGE_QUARANTINE_DIR, directPathIdentity,
  quarantineLatchIdFor, clearMergeQuarantineLatchFile, quarantineLatchFileIdsFor,
} = await import(mergeQuarantineModuleUrl);
const repoLockModuleUrl = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { canonicalRepoLockKey } = await import(repoLockModuleUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function freshDir(tag) {
  const d = path.join(os.tmpdir(), `loom-mq3b1944b6-${tag}-${sfx}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function markAsGitRoot(dir) { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); }
function hashKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
function finalPathFor(repoPath) { return path.join(MERGE_QUARANTINE_DIR, `${hashKey(canonicalRepoLockKey(repoPath))}.json`); }
// Round 2: assert two parsed latch-file snapshots are identical EXCEPT `contributorRepoPaths` and (Round
// 3) `reducedContributorRepoPaths` — the two fields the reduce is allowed to touch. `undefined` on both
// sides so `JSON.stringify` omits it uniformly whether a snapshot never had it or had it stripped/added.
function sameExceptContributors(a, b) {
  return JSON.stringify({ ...a, contributorRepoPaths: undefined, reducedContributorRepoPaths: undefined })
    === JSON.stringify({ ...b, contributorRepoPaths: undefined, reducedContributorRepoPaths: undefined });
}
// Round 4 (Lead ruling item 4) — existence-tolerant read: on a BUGGY commit, R's own latch file can be
// genuinely gone (the over-clear this card fixes destroys it outright), and a bare
// JSON.parse(fs.readFileSync(...)) throws ENOENT, aborting the whole test file before later scenarios
// ever run. Returns `null` instead, so a scenario's own checks against a missing file report FAIL (via
// the null-tolerant accessors below) rather than crashing everything after it.
function readLatchFileIfExists(repoPath) {
  try { return JSON.parse(fs.readFileSync(finalPathFor(repoPath), "utf8")); } catch { return null; }
}
function contributorsOf(snapshot) { return snapshot?.contributorRepoPaths ?? []; }
function reducedContributorsOf(snapshot) { return snapshot?.reducedContributorRepoPaths ?? []; }

// Manager-directed, pre-CR3: `sameExceptContributors` above can only ever prove R's OWN latch file is
// unchanged — it is blind to a SECOND file appearing elsewhere in MERGE_QUARANTINE_DIR, which is exactly
// CR2's own Minor-2 repro (a stray file left at sub's old/synthetic key by an unqualified
// `liveArmedKeysOf`/`entryStillOwnsKey` scan). `quarantineDirListing` + `checkDirListingExactly` assert
// the FULL directory listing against an exact expected set, computed per scenario/checkpoint below.
function quarantineDirListing() { return fs.readdirSync(MERGE_QUARANTINE_DIR).sort(); }
function checkDirListingExactly(label, actualBasenames, expectedBasenames) {
  const expected = [...new Set(expectedBasenames)].sort();
  check(label, JSON.stringify([...actualBasenames].sort()) === JSON.stringify(expected));
}

// Round 6 (CR4 finding 1) — same `fs.openSync` injection pattern merge-quarantine-raise-protect-failure.mjs
// already established: fails EVERY `fs.openSync` whose path starts with `prefix`, so the marker's own
// durable write (at R's own final path) can be forced to fail without touching any OTHER write in the
// same process. `node:fs` is one process-wide singleton, so this reaches the daemon's own `fs.openSync`
// calls too, not just this test file's.
function injectOpenSyncFailureForPrefix(prefix, code = "ENOSPC") {
  const real = fs.openSync;
  let count = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.startsWith(prefix)) {
      count++;
      throw Object.assign(new Error(`${code}: simulated disk-full`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.openSync = real; }, count: () => count };
}

// A real reboot — fresh child process, same LOOM_HOME, re-scanning disk from scratch (mirrors
// merge-quarantine-clear-by-path.mjs's own rebootInChildProcess — the DURABILITY proof an in-process
// check alone can never give: "lifted" vs "lifted only until the next boot re-scans disk").
function rebootInChildProcess(repoPaths, tag) {
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-reboot-out-${tag}-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined, listActiveMergeQuarantines } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const repoPaths = ${JSON.stringify(repoPaths)};
    reenterMergeQuarantinesAtBoot(repoPaths);
    const refusals = Object.fromEntries(repoPaths.map((p) => [p, assertRepoNotQuarantined(p).ok]));
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ refusals }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const result = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  return result;
}

// Round 2 (scenario (b)): a REAL reboot (fresh child process, real reenterMergeQuarantinesAtBoot), THEN
// — within that SAME child, after boot has already diverted sub's record to pending — sub reappears
// without its own .git and /clear(sub) runs, all before the child exits. Proves the pending-only-collides-
// with-an-active-ancestor shape holds through the real boot-reentry path, not just a synthetic in-process
// one (scenario (a) above covers the in-process shape).
function rebootThenCollapseAndClearInChildProcess(R, sub, tag) {
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-reboot-clear-out-${tag}-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const path = (await import("node:path")).default;
    const { createHash } = await import("node:crypto");
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, assertRepoNotQuarantined,
      activeMergeQuarantineFor, findPendingIndexByIdentityTestOnly, MERGE_QUARANTINE_DIR,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const { canonicalRepoLockKey } = await import(${JSON.stringify(repoLockModuleUrl)});
    function hashKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
    function finalPathFor(repoPath) { return path.join(MERGE_QUARANTINE_DIR, \`\${hashKey(canonicalRepoLockKey(repoPath))}.json\`); }
    function readLatchFileIfExists(repoPath) { try { return JSON.parse(fs.readFileSync(finalPathFor(repoPath), "utf8")); } catch { return null; } }
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]); // sub is wholly absent here — diverts to pending (883e29bc)
    const dirAfterReboot = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fs.mkdirSync(sub, { recursive: true }); // sub reappears, no own .git — collapses onto R
    activeMergeQuarantineFor(R); // trigger absorption explicitly for a clean pre-reduce snapshot
    const preReduce = readLatchFileIfExists(R);
    const result = clearMergeQuarantineReporting(sub);
    const postReduce = readLatchFileIfExists(R);
    const dirAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      result, preReduce, postReduce, dirAfterReboot, dirAfterClear,
      rStillActive: !!activeMergeQuarantineFor(R),
      rOk: assertRepoNotQuarantined(R).ok,
      subPendingIdx: findPendingIndexByIdentityTestOnly(sub),
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  return out;
}

// ===================== (A) THE BUG — a resolvable R/sub holding its own active record under a stale key =====================
{
  const R = freshDir("A-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);

  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (A)");
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (A)");
  check("(A precondition) two distinct active entries exist (R and sub)", listActiveMergeQuarantines().filter((e) => e.repoPath === R || e.repoPath === sub).length === 2);
  check("(A precondition) sub's key currently differs from R's", canonicalRepoLockKey(sub) !== canonicalRepoLockKey(R));

  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // sub's .git disappears; sub dir itself still resolves
  check("(A precondition) sub's fresh key NOW collapses onto R's", canonicalRepoLockKey(sub) === canonicalRepoLockKey(R));

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (A) *** R's real quarantine is STILL ACTIVE after clearing sub", !!activeMergeQuarantineFor(R));
  // @decision 3b1944b6 (Round 2) — NOT `activeMergeQuarantineFor(sub)?.repoPath !== sub`: sub's key has
  // collapsed onto R, so that lookup resolves through the ancestor to R's OWN still-active entry
  // regardless of whether sub's own record was ever actually lifted — vacuous either way. Assert directly
  // against the active map's own repoPath field instead.
  check("*** THE FIX (A) *** sub's own record is genuinely lifted", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0);
  check("*** THE FIX (A) *** assertRepoNotQuarantined(R).ok is FALSE — R stays genuinely blocked", assertRepoNotQuarantined(R).ok === false);
  check("(A) result reports wasQuarantined:true", result.wasQuarantined === true);
  check("(A) result never names R in liftedRepoPaths", !result.liftedRepoPaths.includes(R));

  // Safety check, not a fix witness: R's own on-disk latch file was never touched by this clear (the fix
  // never reaches R's key at all), so it survives a real reboot regardless of this card's own fix — this
  // confirms the reboot path doesn't ITSELF regress, not that the in-process fix above did anything.
  const rb = rebootInChildProcess([R, sub], "A");
  check("(A, reboot safety check) R is STILL refused after a real reboot (never resurrected-then-lost)", rb.refusals[R] === false);
}

// ===================== (B) CONTROL — must NOT weaken the ancestor-collapse clear for a subdir with NO own record =====================
{
  const R = freshDir("B-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub"); // no own .git, ever — a registry-bound project with no independent identity
  fs.mkdirSync(sub, { recursive: true }); // RESOLVABLE (the branch this card's fix touches), just no own identity

  enterMergeQuarantine(R, "branch-R", "R's own real raise (B)");
  check("(B precondition) R is quarantined, sub has no own record at all", !!activeMergeQuarantineFor(R) && listActiveMergeQuarantines().filter((e) => e.repoPath === R).length === 1);

  const result = clearMergeQuarantineReporting(sub);
  check("*** MUST-NOT-WEAKEN (B) *** clearing the no-own-identity subdir STILL lifts the host R", !activeMergeQuarantineFor(R));
  check("(B) assertRepoNotQuarantined(R).ok is now TRUE (R genuinely, correctly lifted)", assertRepoNotQuarantined(R).ok === true);
  check("(B) result.liftedRepoPaths names R", result.liftedRepoPaths.includes(R));
}

// ===================== (C) CONTROL — a PENDING-only identity match lifts sub's own pending record; R lives in a DIFFERENT, disjoint tree and was never reachable to begin with =====================
// @decision 3b1944b6 (Round 2) — relabeled from "*** THE FIX (C) ***": `sub` here collapses onto
// `otherParent`, never onto `R` (a wholly separate tree) — this scenario PASSES unchanged on HEAD~1 (the
// pre-card code) too, since nothing in it ever gives the bug a chance to fire. It stays as a control (sub's
// own pending-only record is lifted, a genuinely unrelated R is never even a candidate), not a fix witness.
{
  const R = freshDir("C-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise, wholly unrelated to sub (C)");

  const otherParent = freshDir("C-otherParent");
  markAsGitRoot(otherParent);
  const sub = path.join(otherParent, "sub");
  fs.rmSync(sub, { recursive: true, force: true }); // genuinely does not exist yet at raise time
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (C)");
  check("(C precondition) sub's raise never touched R", activeMergeQuarantineFor(R).tokens.length === 1);

  fs.mkdirSync(sub, { recursive: true }); // now resolvable, no own .git — collapses onto otherParent, not R

  const result = clearMergeQuarantineReporting(sub);
  check("(C control) R's real quarantine is STILL ACTIVE and UNTOUCHED", !!activeMergeQuarantineFor(R) && activeMergeQuarantineFor(R).tokens.length === 1);
  check("(C control) assertRepoNotQuarantined(R).ok is FALSE (R still genuinely, separately blocked)", assertRepoNotQuarantined(R).ok === false);
  check("(C control) sub's own pending record is genuinely lifted", assertRepoNotQuarantined(sub).ok === true);
  check("(C control) result reports wasQuarantined:true", result.wasQuarantined === true);
}

// ===================== (D) round-5-finding-3 multi-key-twin shape, through /clear (not just clear-by-path) =====================
{
  const parent = freshDir("D-parent");
  const repo = path.join(parent, "repo"); // no own .git — collapses onto parent, whose own .git is added mid-test
  fs.mkdirSync(repo, { recursive: true });

  enterMergeQuarantine(repo, "b1", "first raise, no enclosing git yet (D)");
  const key1 = canonicalRepoLockKey(repo);
  const hash1 = hashKey(key1);
  markAsGitRoot(parent); // the drift — parent becomes repo's new toplevel
  const key2 = canonicalRepoLockKey(repo);
  check("(D precondition) repo's key actually changed after the drift", key2 !== key1);

  enterMergeQuarantine(repo, "b2", "second raise, same repoPath, DIFFERENT key (D)");
  const hash2 = hashKey(key2);
  check("(D precondition) two distinct active entries now share repo's exact stored repoPath", listActiveMergeQuarantines().filter((e) => e.repoPath === repo).length === 2);

  const result = clearMergeQuarantineReporting(repo);
  check("*** THE FIX (D) *** clearing via /clear reports wasQuarantined:true", result.wasQuarantined === true);
  check("*** THE FIX (D) *** BOTH matching active entries are cleared through /clear's resolvable branch too", listActiveMergeQuarantines().filter((e) => e.repoPath === repo).length === 0);
  check("(D) the first raise's own latch file is gone", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hash1}.json`)));
  check("(D) the second raise's own latch file is ALSO gone", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hash2}.json`)));
}

// ===================== (E) a DEGRADED DUAL-ARM TWIN (883e29bc/64119847) must survive the fix's own multi-match path =====================
// Found by this card's own worker as a real regression while implementing the fix: naively routing EVERY
// multi-match case through the shared identity-wide helper destroyed a tied pending twin's own PRIVATE
// token a second time (card 64119847's own "reduce, never remove" contract) — the twin is ALSO present in
// activeQuarantines at a SECOND key (dual-tracked, 883e29bc's shape), which activeMatchesAndLiftedKeysFor
// correctly reports as its own separate "match" — but it must be left entirely to the fresh key's own
// internal tie/reduce logic, never independently cleared here.
{
  const y = freshDir("E-y");
  markAsGitRoot(y);
  const k = canonicalRepoLockKey(y);
  const k2 = "loom-mq3b1944b6-E-synthetic-secondary-key";

  // W — the real, active entry at y's own fresh key.
  setActiveQuarantineTestOnly(k, { repoPath: y, branch: "e-w", reason: "W (E)", enteredAt: Date.now(), tokens: ["e-s-token"] });
  // P — tied to W via armedKeys=[k] (so W's own clear reduces it), but ALSO independently armed at k2
  // (dual-tracked, same object reference) and carries a PRIVATE token W's clear never touches.
  const p = { repoPath: y, branch: "e-p", reason: "P (E)", enteredAt: Date.now(), tokens: ["e-s-token", "e-private-token"], armedKeys: [k] };
  setActiveQuarantineTestOnly(k2, p);
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: p, sourceFile: "pending-e-p-test.json" }]);

  clearMergeQuarantine(y);
  check("*** THE FIX (E) *** P's private token SURVIVES — never destroyed a second time", listActiveMergeQuarantines().some((e) => e.tokens.includes("e-private-token")));
  check("(E) W's own token is actually gone", !listActiveMergeQuarantines().some((e) => e.tokens.includes("e-s-token")));
  check("(E) y is still blocked (private token outstanding) — correct, not a residual bug", assertRepoNotQuarantined(y).ok === false);

  // The broad human route (clear-by-path) still fully lifts whatever remains — no token is ever stuck.
  const fullyLifted = clearMergeQuarantineByRecordedPath(y);
  check("(E) the broad human route still fully lifts the surviving private token", fullyLifted.wasQuarantined === true && assertRepoNotQuarantined(y).ok === true);
}

// ===================== ROUND 2 — generalizing the gate to `freshIsForeign` (closes a degraded-twin gap Round 1 missed) =====================
// See docs/decisions/3b1944b6-stale-key-active-record-over-clear.md's own "Round 2" section for the full
// design. Scenarios (a)/(b)/(twin)/(file-safety) below must each go RED on 50b9392c (Round 1's own commit)
// and GREEN after Round 2's `freshIsForeign` restructuring.

// ===================== (a) Round 2 — a PENDING-ONLY sub colliding with a genuinely ACTIVE ancestor R =====================
// The named residual from Round 1's own record ("Known residual, named but out of scope"): sub raised
// while absent (pending-only, never active) later becomes resolvable with no own .git, collapsing its
// fresh key onto R — a wholly separate, genuinely ACTIVE quarantine. `clearMergeQuarantineReporting`'s own
// `before` step absorbs sub's pending record into R's union AS A SIDE EFFECT, before `clearMergeQuarantine`
// ever runs (card 8a1bc2ef's cross-tier sibling absorption) — so the fix is a REDUCE (drop sub from R's
// own `contributorRepoPaths`, never touch R's tokens/armedKeys/file), never a lift of anything.
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round2a-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (a)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true }); // genuinely absent at raise time — pending-only
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable, nested under R (a)");
  check("(a precondition) sub's own record is pending-only, R untouched by it", activeMergeQuarantineFor(R).tokens.length === 1);

  fs.mkdirSync(sub, { recursive: true }); // now resolvable, no own .git — collapses onto R
  check("(a precondition) sub's fresh key now collapses onto R's", canonicalRepoLockKey(sub) === canonicalRepoLockKey(R));

  // Trigger absorption explicitly (same underlying path `before` would reach) so we have a clean
  // pre-reduce snapshot of R's own on-disk latch to diff against afterward.
  activeMergeQuarantineFor(R);
  const preReduce = readLatchFileIfExists(R);
  check("(a precondition) absorption folded sub in as a contributor", contributorsOf(preReduce).some((c) => c === sub));

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (a) *** R's real quarantine is STILL ACTIVE after clearing sub", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (a) *** assertRepoNotQuarantined(R).ok is FALSE — R stays genuinely blocked", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (a) *** result never names R in liftedRepoPaths", !result.liftedRepoPaths.includes(R));
  // @decision 3b1944b6 (Round 2) — `clearMergeQuarantineReporting`'s own return type has NO literal
  // `stillQuarantined` field (that's `clearMergeQuarantine`'s own internal type, never surfaced here) —
  // the wrapper's `if (after)` branch instead folds the still-blocked disclosure straight into `reason`.
  check("*** THE FIX (a) *** result says stillQuarantined, naming R", result.wasQuarantined === true && result.reason?.includes("quarantined by ANOTHER repo's own") && result.reason?.includes(R));
  const postReduce = readLatchFileIfExists(R);
  check("*** THE FIX (a) *** R's own latch file is byte-identical except contributorRepoPaths", sameExceptContributors(preReduce, postReduce));
  check("*** THE FIX (a) *** sub is removed from R's own contributorRepoPaths", !contributorsOf(postReduce).some((c) => c === sub));
  check("*** THE FIX (a), Round 4 *** sub is durably recorded in R's own reducedContributorRepoPaths", reducedContributorsOf(postReduce).includes(directPathIdentity(sub)));
  check("(a) sub's own pending record is genuinely gone", findPendingIndexByIdentityTestOnly(sub) === -1);
  check("(a) result reports wasQuarantined:true", result.wasQuarantined === true);
  checkDirListingExactly("*** THE FIX (a), Minor-2 *** latch dir after the clear is EXACTLY baseline + R's own file (no stray file anywhere)", quarantineDirListing(), [...dirBaseline, rBasename]);
}

// ===================== (b) Round 2 — the SAME pending-only collision, reached via a REAL reboot =====================
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round2b-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (b)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (b)");
  // Captured WHILE sub still owns its own real .git-derived key — before it is removed below. On
  // a BUGGY commit, the reduce resurrects a file at exactly this hash (CR2's own Minor-2 repro).
  const subOldBasename = `${hashKey(canonicalRepoLockKey(sub))}.json`;
  check("(b precondition) two distinct active entries exist (R and sub)", listActiveMergeQuarantines().filter((e) => e.repoPath === R || e.repoPath === sub).length === 2);

  fs.rmSync(sub, { recursive: true, force: true }); // sub is wholly ABSENT at boot time (not just its own .git)

  const out = rebootThenCollapseAndClearInChildProcess(R, sub, "b");
  check("*** THE FIX (b) *** R's real quarantine is STILL ACTIVE after the post-reboot clear(sub)", out.rStillActive);
  check("*** THE FIX (b) *** assertRepoNotQuarantined(R).ok is FALSE — R stays genuinely blocked", out.rOk === false);
  check("*** THE FIX (b) *** result never names R in liftedRepoPaths", !out.result.liftedRepoPaths.includes(R));
  check("*** THE FIX (b) *** result says stillQuarantined, naming R", out.result.wasQuarantined === true && out.result.reason?.includes("quarantined by ANOTHER repo's own") && out.result.reason?.includes(R));
  check("*** THE FIX (b) *** R's own latch file is byte-identical except contributorRepoPaths", sameExceptContributors(out.preReduce, out.postReduce));
  check("*** THE FIX (b) *** sub is removed from R's own contributorRepoPaths", !contributorsOf(out.postReduce).some((c) => c === sub));
  check("*** THE FIX (b), Round 4 *** sub is durably recorded in R's own reducedContributorRepoPaths", reducedContributorsOf(out.postReduce).includes(directPathIdentity(sub)));
  check("(b) sub's own (post-reboot, diverted-to-pending) record is genuinely gone", out.subPendingIdx === -1);
  // After the reboot alone (before collapse/absorption), sub's own OLD on-disk file legitimately still
  // sits there — PASS1 hasn't absorbed/deleted it yet. That is the correct, expected shape here, distinct
  // from the post-clear invariant below.
  checkDirListingExactly("*** THE FIX (b), Minor-2 *** latch dir right after the reboot is EXACTLY baseline + R + sub's own old-key file (nothing extra)", out.dirAfterReboot, [...dirBaseline, rBasename, subOldBasename]);
  checkDirListingExactly("*** THE FIX (b), Minor-2 *** latch dir after the clear is EXACTLY baseline + R's own file (sub's old-key file never resurrected)", out.dirAfterClear, [...dirBaseline, rBasename]);
}

// ===================== (twin) Round 2 — sub's ONLY record is a degraded dual-arm twin, while the FRESH KEY is FOREIGN (occupied by R) =====================
// Built with the same setActiveQuarantineTestOnly + pending-inject seam scenario E uses. On 50b9392c
// (Round 1), the dual-arm-twin exclusion empties `ownMatchesElsewhere` even though sub genuinely HAS its
// own record (the twin) — falling through to the plain, unconditional fresh-key clear, which wrongly
// lifts R (the twin's own stale-key collapse target). Round 2's `freshIsForeign` gate fixes this: a
// non-empty `matched` (even when every entry in it is a twin) now routes through the shared helper
// instead of ever reaching the fresh key at all.
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("twin-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (twin)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git, ever — sub's fresh key IS R's own key (foreign)
  check("(twin precondition) sub's fresh key is R's own key", canonicalRepoLockKey(sub) === canonicalRepoLockKey(R));

  const k2 = "loom-mq3b1944b6-twin-synthetic-secondary-key";
  const p = { repoPath: sub, branch: "twin-p", reason: "sub's own degraded twin (twin)", enteredAt: Date.now(), tokens: ["twin-token"], armedKeys: [k2] };
  setActiveQuarantineTestOnly(k2, p);
  pushPendingQuarantineTestOnly(p, "pending-twin-test.json");
  check("(twin precondition) sub's ONLY active match is the degraded twin at k2", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1);

  activeMergeQuarantineFor(R); // trigger absorption explicitly for a clean pre-reduce snapshot
  const preReduce = readLatchFileIfExists(R);
  check("(twin precondition) absorption folded sub in as a contributor", contributorsOf(preReduce).some((c) => c === sub));

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (twin) *** R's real quarantine is STILL ACTIVE after clearing sub", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (twin) *** assertRepoNotQuarantined(R).ok is FALSE — R stays genuinely blocked", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (twin) *** result never names R in liftedRepoPaths", !result.liftedRepoPaths.includes(R));
  check("*** THE FIX (twin) *** result says stillQuarantined, naming R", result.wasQuarantined === true && result.reason?.includes("quarantined by ANOTHER repo's own") && result.reason?.includes(R));
  const postReduce = readLatchFileIfExists(R);
  check("*** THE FIX (twin) *** R's own latch file is byte-identical except contributorRepoPaths", sameExceptContributors(preReduce, postReduce));
  check("*** THE FIX (twin) *** sub is removed from R's own contributorRepoPaths", !contributorsOf(postReduce).some((c) => c === sub));
  check("*** THE FIX (twin), Round 4 *** sub is durably recorded in R's own reducedContributorRepoPaths", reducedContributorsOf(postReduce).includes(directPathIdentity(sub)));
  check("(twin) the degraded twin itself is genuinely gone (sub's own record cleared)", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0);
  // CR2's own Minor-2 repro site: k2 (the twin's synthetic secondary key) never had a real on-disk file —
  // a pre-fix `reduceForeignUnionContributor` could still mint one there (measured: it did, see this
  // card's own decision record). k2's own hash must NEVER appear in this listing.
  checkDirListingExactly("*** THE FIX (twin), Minor-2 *** latch dir after the clear is EXACTLY baseline + R's own file (no stray file at k2's hash)", quarantineDirListing(), [...dirBaseline, rBasename]);
}

// ===================== (file-safety) Round 2 — a pending entry whose sourceFile COLLIDES with R's own final basename =====================
// Verifies the file-safety claim in the Round 2 decision record directly: the pending pass reached from
// the `freshIsForeign`-with-own-record branch must never unlink R's own physical latch file just because
// some OTHER, unrelated pending entry's `sourceFile` happens to collide with it (`sweepOwnLatchFileUnlessOwnedElsewhere`'s
// own `physicalOwnerRepoPaths` ownership check).
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("filesafety-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (file-safety)");
  const rFinalBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;
  check("(file-safety precondition) R's own final latch file exists on disk", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rFinalBasename)));

  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git — sub's fresh key is R's own key (foreign)

  const p = { repoPath: sub, branch: "fs-p", reason: "sub's own PENDING-only record, sourceFile forced to collide with R's final basename (file-safety)", enteredAt: Date.now(), tokens: ["fs-token"] };
  pushPendingQuarantineTestOnly(p, rFinalBasename); // forced collision, via the test-only seam only

  activeMergeQuarantineFor(R); // trigger absorption explicitly for a clean pre-reduce snapshot
  check("(file-safety precondition) R's own final latch file SURVIVES absorption itself", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rFinalBasename)));
  const preReduce = readLatchFileIfExists(R);
  check("(file-safety precondition) absorption folded sub in as a contributor", contributorsOf(preReduce).some((c) => c === sub));

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (file-safety) *** R's own final latch file SURVIVES the clear of an unrelated colliding sourceFile", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rFinalBasename)));
  check("*** THE FIX (file-safety) *** result says stillQuarantined, naming R", result.wasQuarantined === true && result.reason?.includes("quarantined by ANOTHER repo's own") && result.reason?.includes(R));
  const postReduce = readLatchFileIfExists(R);
  check("*** THE FIX (file-safety) *** R's own latch file is byte-identical except contributorRepoPaths", sameExceptContributors(preReduce, postReduce));
  check("*** THE FIX (file-safety) *** sub is removed from R's own contributorRepoPaths", !contributorsOf(postReduce).some((c) => c === sub));
  check("*** THE FIX (file-safety), Round 4 *** sub is durably recorded in R's own reducedContributorRepoPaths", reducedContributorsOf(postReduce).includes(directPathIdentity(sub)));
  check("(file-safety) R's real quarantine is still genuinely active", !!activeMergeQuarantineFor(R));
  check("(file-safety) sub's own pending record is genuinely gone", findPendingIndexByIdentityTestOnly(sub) === -1);
  check("(file-safety) result reports wasQuarantined:true", result.wasQuarantined === true);
  checkDirListingExactly("*** THE FIX (file-safety), Minor-2 *** latch dir after the clear is EXACTLY baseline + R's own file (no stray file anywhere)", quarantineDirListing(), [...dirBaseline, rFinalBasename]);
}

// ===================== (still-liftable) CONTROL — R's OWN owner can still fully lift R after the reduce, in-process and across a reboot =====================
// @decision 3b1944b6 (Round 4, Lead ruling item 3) — relabeled from "*** THE FIX ***" to CONTROL: this
// safety gate held BEFORE this card too (`reduceForeignUnionContributor` never removes identity's own
// token, round 2) and still holds with Round 4's own new `reducedContributorRepoPaths` marker in place —
// it is not something Round 4 newly fixed, so it must not read as if it were.
// The Lead's own safety gate on this design: `identity`'s token stays physically outstanding inside R's
// union after the reduce (tokens are a flat set with no per-contributor tagging — see
// `reduceForeignUnionContributor`'s own doc). Proven via a real-git probe before this was approved: R's
// own owner can still fully lift it via its OWN full `/clear`, never only the narrower per-token
// `clearMergeQuarantineByToken` auto-settle route (which leaves the leftover token armed — pre-existing
// absorption behavior, unrelated to this card).
{
  const R = freshDir("stillliftable-R");
  markAsGitRoot(R);
  const tr = enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (still-liftable)");

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (still-liftable)");
  fs.mkdirSync(sub, { recursive: true }); // collapses onto R

  clearMergeQuarantineReporting(sub); // reduces R's union (drops sub as a contributor)
  check("(still-liftable precondition) sub is gone from contributorRepoPaths", !contributorsOf(activeMergeQuarantineFor(R)).some((c) => c === sub));
  check("(still-liftable precondition, Round 4) sub is durably marked reduced", reducedContributorsOf(activeMergeQuarantineFor(R)).includes(directPathIdentity(sub)));

  // The narrower per-token auto-settle route does NOT fully lift R alone (sub's leftover token keeps it
  // armed) — asserted here so the full-clear proof below isn't mistaken for "nothing was ever outstanding".
  clearMergeQuarantineByToken(R, tr);
  check("(still-liftable) per-token auto-settle alone does NOT fully lift R (sub's leftover token keeps it armed)", !!activeMergeQuarantineFor(R));

  // But R's own owner's FULL clear still works, in-process.
  const fullResult = clearMergeQuarantineReporting(R);
  check("*** CONTROL (still-liftable) *** R's own full /clear(R) still fully lifts it", fullResult.wasQuarantined === true && !activeMergeQuarantineFor(R));
  check("(still-liftable) assertRepoNotQuarantined(R).ok is now TRUE", assertRepoNotQuarantined(R).ok === true);
  check("(still-liftable, Round 4) the marker dies with R's own latch — a fresh raise starts with no history", !reducedContributorsOf(activeMergeQuarantineFor(R)).includes(directPathIdentity(sub)));

  // And again, from scratch, across a REAL reboot.
  const R2 = freshDir("stillliftable2-R");
  markAsGitRoot(R2);
  const tr2 = enterMergeQuarantine(R2, "branch-R2", "R2's own real raise (still-liftable, reboot)");
  const sub2 = path.join(R2, "sub");
  fs.rmSync(sub2, { recursive: true, force: true });
  enterMergeQuarantine(sub2, "branch-sub2", "sub2's own raise while unresolvable (still-liftable, reboot)");
  fs.mkdirSync(sub2, { recursive: true });
  clearMergeQuarantineReporting(sub2);

  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-stillliftable-reboot-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, assertRepoNotQuarantined,
      clearMergeQuarantineReporting,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R2 = ${JSON.stringify(R2)};
    const sub2 = ${JSON.stringify(sub2)};
    reenterMergeQuarantinesAtBoot([R2, sub2]);
    const fullResult = clearMergeQuarantineReporting(R2);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      fullResult, stillActive: !!activeMergeQuarantineFor(R2), ok: assertRepoNotQuarantined(R2).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const rebootOut = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** CONTROL (still-liftable, reboot) *** R2's own full /clear(R2) still fully lifts it after a real reboot", rebootOut.fullResult.wasQuarantined === true && !rebootOut.stillActive);
  check("(still-liftable, reboot) assertRepoNotQuarantined(R2).ok is now TRUE", rebootOut.ok === true);
}

// ===================== ROUND 3 — a SECOND /clear(sub) must never re-open the over-clear the FIRST clear's own reduce just closed =====================
// Code Review b9cef62a's own CRITICAL finding against d94dcb8d (Round 2): the first reduce drops sub from
// R's own `contributorRepoPaths`, which is the ONLY record that sub was ever folded in — so a SECOND
// `/clear(sub)` (or a reboot's own re-arm followed by one) sees `contributorRepoPaths` come up empty and,
// with nothing else to say otherwise, falls through to scenario B's ancestor-collapse clear, lifting R's
// WHOLE union a second time. Each scenario below must go RED on d94dcb8d (R unblocked on the second clear)
// and GREEN after this round's own `reducedContributorRepoPaths` marker + routing fix. Every scenario
// goes through the REAL `/clear` entry point (never the inner function directly — lesson 249).

// A second reboot-collapse-then-double-clear helper, mirroring rebootThenCollapseAndClearInChildProcess
// above but issuing the clear TWICE inside the same child, for the "CR1's (b) shape" scenario below.
function rebootThenCollapseAndDoubleClearInChildProcess(R, sub, tag) {
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-reboot-doubleclear-out-${tag}-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, assertRepoNotQuarantined, activeMergeQuarantineFor,
      MERGE_QUARANTINE_DIR,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]); // sub is wholly absent here — diverts to pending (883e29bc)
    const dirAfterReboot = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fs.mkdirSync(sub, { recursive: true }); // sub reappears, no own .git — collapses onto R
    const first = clearMergeQuarantineReporting(sub);
    const dirAfterClear1 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    const second = clearMergeQuarantineReporting(sub);
    const dirAfterClear2 = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      first, second, dirAfterReboot, dirAfterClear1, dirAfterClear2,
      rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  return out;
}

// ===================== (round4-cc) clear -> clear, in-process =====================
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round4cc-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round4-cc)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true }); // genuinely absent at raise time — pending-only
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable, nested under R (round4-cc)");
  fs.mkdirSync(sub, { recursive: true }); // now resolvable, no own .git — collapses onto R

  const first = clearMergeQuarantineReporting(sub);
  check("(round4-cc precondition) first clear reduces R's union; R stays blocked", first.wasQuarantined === true && !!activeMergeQuarantineFor(R));
  checkDirListingExactly("*** THE FIX (round4-cc), Minor-2 *** latch dir after the FIRST clear is EXACTLY baseline + R's own file", quarantineDirListing(), [...dirBaseline, rBasename]);

  const second = clearMergeQuarantineReporting(sub); // THE SECOND CLEAR — must stay an idempotent no-op
  check("*** THE FIX (round4-cc) *** R's real quarantine is STILL ACTIVE after a SECOND clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round4-cc) *** assertRepoNotQuarantined(R).ok is FALSE after a SECOND clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round4-cc) *** second clear never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
  check("*** THE FIX (round4-cc) *** second clear still reports wasQuarantined:true", second.wasQuarantined === true);
  checkDirListingExactly("*** THE FIX (round4-cc), Minor-2 *** latch dir after the SECOND clear is STILL EXACTLY baseline + R's own file", quarantineDirListing(), [...dirBaseline, rBasename]);
}

// ===================== (round4-crc) clear -> reboot -> clear =====================
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round4crc-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round4-crc)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable, nested under R (round4-crc)");
  fs.mkdirSync(sub, { recursive: true }); // collapses onto R

  const first = clearMergeQuarantineReporting(sub); // first clear/reduce, in-process
  check("(round4-crc precondition) first clear reduces R's union; R stays blocked", first.wasQuarantined === true && !!activeMergeQuarantineFor(R));
  checkDirListingExactly("*** THE FIX (round4-crc), Minor-2 *** latch dir after the FIRST clear is EXACTLY baseline + R's own file", quarantineDirListing(), [...dirBaseline, rBasename]);

  // Reboot (fresh child process, re-scanning disk from scratch), THEN clear(sub) AGAIN inside that SAME
  // child — proves `reducedContributorRepoPaths` actually survives the boot re-entry parse, not just an
  // in-process object reference.
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round4crc-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, activeMergeQuarantineFor, assertRepoNotQuarantined,
      MERGE_QUARANTINE_DIR,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const dirAfterReboot = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    const second = clearMergeQuarantineReporting(sub);
    const dirAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).sort();
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      second, dirAfterReboot, dirAfterClear, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (round4-crc) *** R's real quarantine is STILL ACTIVE after reboot + a SECOND clear(sub)", out.rStillActive);
  check("*** THE FIX (round4-crc) *** assertRepoNotQuarantined(R).ok is FALSE after reboot + a SECOND clear(sub)", out.rOk === false);
  check("*** THE FIX (round4-crc) *** second clear never names R in liftedRepoPaths", !out.second.liftedRepoPaths.includes(R));
  checkDirListingExactly("*** THE FIX (round4-crc), Minor-2 *** latch dir right after the reboot (before the second clear) is EXACTLY baseline + R's own file", out.dirAfterReboot, [...dirBaseline, rBasename]);
  checkDirListingExactly("*** THE FIX (round4-crc), Minor-2 *** latch dir after the SECOND clear is STILL EXACTLY baseline + R's own file", out.dirAfterClear, [...dirBaseline, rBasename]);
}

// ===================== (round4-twin) twin shape, re-cleared a second time after its own first reduce =====================
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round4twin-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (round4-twin)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git, ever — sub's fresh key IS R's own key (foreign)

  const k2 = "loom-mq3b1944b6-round4twin-synthetic-secondary-key";
  const p = { repoPath: sub, branch: "r3twin-p", reason: "sub's own degraded twin (round4-twin)", enteredAt: Date.now(), tokens: ["r3twin-token"], armedKeys: [k2] };
  setActiveQuarantineTestOnly(k2, p);
  pushPendingQuarantineTestOnly(p, "pending-round4twin-test.json");

  activeMergeQuarantineFor(R); // trigger absorption explicitly

  const first = clearMergeQuarantineReporting(sub); // first clear — lifts the twin, reduces R
  check("(round4-twin precondition) first clear lifts sub's own twin record; R stays blocked", first.wasQuarantined === true && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));
  checkDirListingExactly("*** THE FIX (round4-twin), Minor-2 *** latch dir after the FIRST clear is EXACTLY baseline + R's own file (no stray file at k2's hash)", quarantineDirListing(), [...dirBaseline, rBasename]);

  const second = clearMergeQuarantineReporting(sub); // SECOND clear — sub now has NOTHING of its own anywhere
  check("*** THE FIX (round4-twin) *** R's real quarantine is STILL ACTIVE after a SECOND clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round4-twin) *** assertRepoNotQuarantined(R).ok is FALSE after a SECOND clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round4-twin) *** second clear never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
  checkDirListingExactly("*** THE FIX (round4-twin), Minor-2 *** latch dir after the SECOND clear is STILL EXACTLY baseline + R's own file", quarantineDirListing(), [...dirBaseline, rBasename]);
}

// ===================== (round4-crb) CR1's (b) shape — reboot, collapse, THEN clear TWICE in the same child =====================
{
  const dirBaseline = new Set(quarantineDirListing()); // whatever earlier scenarios already left behind
  const R = freshDir("round4crb-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round4-crb)");
  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round4-crb)");
  // Captured WHILE sub still owns its own real .git-derived key — see scenario (b)'s own identical comment.
  const subOldBasename = `${hashKey(canonicalRepoLockKey(sub))}.json`;

  fs.rmSync(sub, { recursive: true, force: true }); // sub is wholly ABSENT at boot time (not just its own .git)

  const out = rebootThenCollapseAndDoubleClearInChildProcess(R, sub, "round4crb");
  check("*** THE FIX (round4-crb) *** R's real quarantine is STILL ACTIVE after reboot + collapse + TWO clears", out.rStillActive);
  check("*** THE FIX (round4-crb) *** assertRepoNotQuarantined(R).ok is FALSE after TWO clears", out.rOk === false);
  check("*** THE FIX (round4-crb) *** neither clear ever names R in liftedRepoPaths", !out.first.liftedRepoPaths.includes(R) && !out.second.liftedRepoPaths.includes(R));
  // Right after the reboot alone (before collapse/absorption), sub's own OLD on-disk file legitimately
  // still sits there — see scenario (b)'s own identical shape/comment.
  checkDirListingExactly("*** THE FIX (round4-crb), Minor-2 *** latch dir right after the reboot is EXACTLY baseline + R + sub's own old-key file (nothing extra)", out.dirAfterReboot, [...dirBaseline, rBasename, subOldBasename]);
  checkDirListingExactly("*** THE FIX (round4-crb), Minor-2 *** latch dir after the FIRST clear is EXACTLY baseline + R's own file", out.dirAfterClear1, [...dirBaseline, rBasename]);
  checkDirListingExactly("*** THE FIX (round4-crb), Minor-2 *** latch dir after the SECOND clear is STILL EXACTLY baseline + R's own file", out.dirAfterClear2, [...dirBaseline, rBasename]);
}

// ===================== ROUND 5 — CR3's own item 4: "shape A" (Round 1's scenario A) has the SAME second-clear reopening =====================
// CR3 (reviewer aaa1c93f, at a29f09b1), item 4 — pre-existing, same user-visible harm CR2 called
// CRITICAL. Shape A: sub holds its OWN genuinely independent ACTIVE record (own real raise, own key);
// its `.git` is then removed, collapsing its fresh key onto a wholly separate, foreign R. The FIRST
// `/clear(sub)` correctly lifts ONLY sub (via `tryClearMergeQuarantineByOwnIdentity`'s "unreduced" own-
// identity path, NEVER `reduceForeignUnionContributor` — sub was never a `contributorRepoPaths` member
// of R's union at all, there is no union here). But once sub's own record is gone, a SECOND
// `/clear(sub)` has nothing left to say sub was ever here, and (pre-fix) falls through to the
// ancestor-collapse clear, lifting R too. The fix: `markIdentityAsReducedOnForeignKey` stamps the SAME
// `reducedContributorRepoPaths` marker onto R the moment the first clear succeeds here, so a later
// `/clear(sub)` routes to the idempotent refuse arm instead. RED at a29f09b1, GREEN after.

// ===================== (round5-shapeA-cc) shape A, clear -> clear, in-process =====================
{
  const R = freshDir("round5shapeAcc-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-shapeA-cc)");

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round5-shapeA-cc)");
  check("(round5-shapeA-cc precondition) two distinct active entries exist (R and sub)", listActiveMergeQuarantines().filter((e) => e.repoPath === R || e.repoPath === sub).length === 2);

  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // sub's .git disappears; sub dir itself still resolves
  check("(round5-shapeA-cc precondition) sub's fresh key NOW collapses onto R's", canonicalRepoLockKey(sub) === canonicalRepoLockKey(R));

  const first = clearMergeQuarantineReporting(sub);
  check("(round5-shapeA-cc precondition) first clear lifts ONLY sub; R stays blocked", first.wasQuarantined === true && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));
  check("(round5-shapeA-cc precondition) first clear never names R in liftedRepoPaths", !first.liftedRepoPaths.includes(R));

  const second = clearMergeQuarantineReporting(sub); // THE SECOND CLEAR — must stay an idempotent refuse, never scenario B
  check("*** THE FIX (round5-shapeA-cc) *** R's real quarantine is STILL ACTIVE after a SECOND clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round5-shapeA-cc) *** assertRepoNotQuarantined(R).ok is FALSE after a SECOND clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round5-shapeA-cc) *** second clear never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
}

// ===================== (round5-shapeA-crc) shape A, clear -> reboot -> clear =====================
{
  const R = freshDir("round5shapeAcrc-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-shapeA-crc)");

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round5-shapeA-crc)");

  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true });

  const first = clearMergeQuarantineReporting(sub); // first clear, in-process
  check("(round5-shapeA-crc precondition) first clear lifts ONLY sub; R stays blocked", first.wasQuarantined === true && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));

  // Reboot, THEN clear(sub) AGAIN inside the SAME child — proves the shape-A marker survives the boot parse.
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round5shapeAcrc-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, activeMergeQuarantineFor, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const second = clearMergeQuarantineReporting(sub);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      second, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (round5-shapeA-crc) *** R's real quarantine is STILL ACTIVE after reboot + a SECOND clear(sub)", out.rStillActive);
  check("*** THE FIX (round5-shapeA-crc) *** assertRepoNotQuarantined(R).ok is FALSE after reboot + a SECOND clear(sub)", out.rOk === false);
  check("*** THE FIX (round5-shapeA-crc) *** second clear never names R in liftedRepoPaths", !out.second.liftedRepoPaths.includes(R));
}

// ===================== (round5-liftedpair) CR3 item 3 — clearing R fully must report BOTH R and sub in liftedRepoPaths =====================
// A reduced-out identity's own token stays physically folded into R's union forever (see "THE TOKEN
// QUESTION" above) — when R is later fully cleared, that identity becomes genuinely unblocked too, and
// belongs in `liftedRepoPaths` alongside R, exactly like the SAME fixture reports `[R, sub]` when there
// is no reduce at all. Compared via `directPathIdentity`, never literal string equality — `reducedContributorRepoPaths`
// stores the NORMALIZED identity (see that field's own doc), not sub's raw, as-typed path.
{
  const R = freshDir("round5liftedpair-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-liftedpair)");

  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round5-liftedpair)");
  fs.mkdirSync(sub, { recursive: true }); // collapses onto R

  clearMergeQuarantineReporting(sub); // reduces R's union
  check("(round5-liftedpair precondition) sub is durably marked reduced on R", reducedContributorsOf(activeMergeQuarantineFor(R)).includes(directPathIdentity(sub)));

  const fullResult = clearMergeQuarantineReporting(R); // R's own full clear — lifts R AND sub's leftover token
  const liftedIdentities = new Set(fullResult.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE FIX (round5-liftedpair), CR3 item 3 *** R's full clear reports BOTH R and sub as lifted (never just [R])",
    liftedIdentities.size === 2 && liftedIdentities.has(directPathIdentity(R)) && liftedIdentities.has(directPathIdentity(sub)));
  check("(round5-liftedpair) R is genuinely, fully lifted", !activeMergeQuarantineFor(R) && assertRepoNotQuarantined(R).ok === true);
}

// ===================== ROUND 5 — CR3's own item 4 (test gap): clear-by-path(R) and clear-by-id(R) after the reduce =====================
// Item 5 (accepted, deliberate, not a bug): clearing R's own quarantine by path or by id lifts EVERYTHING
// held under R, including sub's own leftover token folded in by the earlier reduce — a human clearing
// R's quarantine by id/path lifts everything held under it, and they already separately asked to clear
// sub. Each scenario below asserts exactly that, plus that R's own marker (and its physical file) leaves
// with it — 0 latch files remain referencing R's own key afterward.

// ===================== (round5-clearbypath-noreboot) =====================
{
  const R = freshDir("round5cbpnr-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-clearbypath-noreboot)");
  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round5-clearbypath-noreboot)");
  fs.mkdirSync(sub, { recursive: true });
  clearMergeQuarantineReporting(sub); // reduce
  check("(round5-clearbypath-noreboot precondition) R is durably marked reduced", reducedContributorsOf(activeMergeQuarantineFor(R)).includes(directPathIdentity(sub)));

  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;
  const result = clearMergeQuarantineByRecordedPath(R);
  check("*** THE FIX (round5-clearbypath-noreboot) *** clear-by-path(R) fully lifts R", result.wasQuarantined === true && !activeMergeQuarantineFor(R));
  check("(round5-clearbypath-noreboot) assertRepoNotQuarantined(R).ok is now TRUE", assertRepoNotQuarantined(R).ok === true);
  check("(round5-clearbypath-noreboot, item 5 — accepted) sub's own leftover token is ALSO lifted", assertRepoNotQuarantined(sub).ok === true);
  check("*** THE FIX (round5-clearbypath-noreboot) *** 0 latch files remain referencing R's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rBasename)));
}

// ===================== (round5-clearbypath-reboot) =====================
{
  const R = freshDir("round5cbprb-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-clearbypath-reboot)");
  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round5-clearbypath-reboot)");
  fs.mkdirSync(sub, { recursive: true });
  clearMergeQuarantineReporting(sub); // reduce, in-process

  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round5cbprb-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineByRecordedPath, activeMergeQuarantineFor, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const result = clearMergeQuarantineByRecordedPath(R);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      result, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok, subOk: assertRepoNotQuarantined(sub).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (round5-clearbypath-reboot) *** clear-by-path(R) fully lifts R after a real reboot", out.result.wasQuarantined === true && !out.rStillActive);
  check("(round5-clearbypath-reboot) assertRepoNotQuarantined(R).ok is now TRUE", out.rOk === true);
  check("(round5-clearbypath-reboot, item 5 — accepted) sub's own leftover token is ALSO lifted", out.subOk === true);
  check("*** THE FIX (round5-clearbypath-reboot) *** 0 latch files remain referencing R's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rBasename)));
}

// ===================== (round5-clearbyid-noreboot) =====================
{
  const R = freshDir("round5cbinr-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-clearbyid-noreboot)");
  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round5-clearbyid-noreboot)");
  fs.mkdirSync(sub, { recursive: true });
  clearMergeQuarantineReporting(sub); // reduce

  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;
  const id = quarantineLatchIdFor(R);
  const result = clearMergeQuarantineLatchFile(id);
  check("*** THE FIX (round5-clearbyid-noreboot) *** clear-by-id(R) fully lifts R", result.ok === true && result.wasQuarantined === true && !activeMergeQuarantineFor(R));
  check("(round5-clearbyid-noreboot) assertRepoNotQuarantined(R).ok is now TRUE", assertRepoNotQuarantined(R).ok === true);
  check("(round5-clearbyid-noreboot, item 5 — accepted) sub's own leftover token is ALSO lifted", assertRepoNotQuarantined(sub).ok === true);
  check("*** THE FIX (round5-clearbyid-noreboot) *** 0 latch files remain referencing R's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rBasename)));
}

// ===================== (round5-clearbyid-reboot) =====================
{
  const R = freshDir("round5cbirb-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round5-clearbyid-reboot)");
  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true });
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round5-clearbyid-reboot)");
  fs.mkdirSync(sub, { recursive: true });
  clearMergeQuarantineReporting(sub); // reduce, in-process

  const rBasename = `${hashKey(canonicalRepoLockKey(R))}.json`;
  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round5cbirb-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineLatchFile, quarantineLatchIdFor, activeMergeQuarantineFor, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const id = quarantineLatchIdFor(R);
    const result = clearMergeQuarantineLatchFile(id);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      result, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok, subOk: assertRepoNotQuarantined(sub).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (round5-clearbyid-reboot) *** clear-by-id(R) fully lifts R after a real reboot", out.result.ok === true && out.result.wasQuarantined === true && !out.rStillActive);
  check("(round5-clearbyid-reboot) assertRepoNotQuarantined(R).ok is now TRUE", out.rOk === true);
  check("(round5-clearbyid-reboot, item 5 — accepted) sub's own leftover token is ALSO lifted", out.subOk === true);
  check("*** THE FIX (round5-clearbyid-reboot) *** 0 latch files remain referencing R's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, rBasename)));
}

// ===================== ROUND 6 — CR4 (reviewer 0a642436, delta a29f09b1..c925e5da) =====================
// Finding 1 (BLOCKING): the Round 5 marker was NOT atomic with the own-identity clear it protects, and
// failed OPEN — a crash or write failure between "sub's own record is gone" and "R is marked" left a
// window where a reboot + /clear(sub) still lifted [sub, R]. Fix: stamp the marker FIRST, before touching
// sub's own record, and refuse the whole clear on a durable-write failure (sub's record is kept).
// Finding 2 (BLOCKING, Lead ruling): the stamp used to live ONLY at the /clear call site — clear-by-path,
// clear-by-id, and clear-by-token each independently clear sub's own record too, and each needed the SAME
// stamp. Every scenario below goes through the REAL route named.

// ===================== (round6-markfail) a stubbed write failure on the marker write ⇒ the clear is refused, sub's record is kept, R untouched =====================
{
  const R = freshDir("round6markfail-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round6-markfail)");
  const rFinalPath = finalPathFor(R);
  const rContentBefore = fs.readFileSync(rFinalPath, "utf8");

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round6-markfail)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R
  check("(round6-markfail precondition) sub's fresh key collapses onto R's", canonicalRepoLockKey(sub) === canonicalRepoLockKey(R));

  const inj = injectOpenSyncFailureForPrefix(rFinalPath); // fails the marker's own durable write at R's final path
  let result;
  try {
    result = clearMergeQuarantineReporting(sub);
  } finally {
    inj.restore();
  }
  check("(round6-markfail) the injected failure actually fired at least once", inj.count() > 0);
  check("*** THE FIX (round6-markfail) *** sub's own record is KEPT — the clear never touched it", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1);
  check("*** THE FIX (round6-markfail) *** R's own latch file is byte-identical — untouched by the failed marker write", fs.readFileSync(rFinalPath, "utf8") === rContentBefore);
  check("*** THE FIX (round6-markfail) *** R stays genuinely blocked", !!activeMergeQuarantineFor(R) && assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round6-markfail) *** result never names R in liftedRepoPaths", !result.liftedRepoPaths.includes(R));
  check("(round6-markfail) result reports wasQuarantined:true (sub was, and still is, blocked)", result.wasQuarantined === true);
}

// ===================== (round7-probeA) REPLACES the old (round6-crashsim), a confirmed TAUTOLOGY =====================
// Round 7, test gap (item 4): round6-crashsim's own construction left sub's record genuinely INTACT
// (never cleared) and called /clear(sub) only ONCE, in the SAME process — `matched.length > 0` alone
// (sub's own still-present record) was already enough to avoid scenario B, with or without the marker;
// the scenario passed identically at 50b9392c and at d94dcb8d, before the marker mechanism even existed,
// and would still pass today if `reducedContributorRepoPaths` were deleted entirely.
//
// Code Reviewer 0a642436's own probe A instead: leave the marker durable, leave sub's own latch file
// ALSO genuinely on disk (never cleared — the real crash window between the marker write and sub's own
// clear), then REBOOT INTO A FRESH CHILD PROCESS (forcing a genuine re-ingest from disk, never reused
// in-memory state) and clear(sub) TWICE in that same child. Verified empirically (a scratch probe, not
// assumed) before writing this: at boot, PASS 1 migrates sub's own stale-keyed latch directly into R's
// union (tokens unioned; sub's own independent record is gone), so BOTH post-reboot clears depend
// ENTIRELY on the durable marker surviving the boot parse — never on in-memory convenience.
{
  const R = freshDir("round7probeA-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-probeA)");
  const rKey = canonicalRepoLockKey(R);

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round7-probeA)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R

  // Simulate the crash window: the marker write succeeded and was made durable, but the own-identity
  // clear that should have followed it NEVER ran — sub's own record is left COMPLETELY untouched, on
  // disk and in memory, exactly as if that second step never happened.
  const rEntryBeforeCrashSim = activeMergeQuarantineFor(R);
  const markedEntry = {
    ...rEntryBeforeCrashSim,
    reducedContributorRepoPaths: [...new Set([...(rEntryBeforeCrashSim.reducedContributorRepoPaths ?? []), directPathIdentity(sub)])],
  };
  setActiveQuarantineTestOnly(rKey, markedEntry);
  fs.writeFileSync(finalPathFor(R), JSON.stringify(markedEntry, null, 2) + "\n");
  check("(round7-probeA precondition) R is durably marked while sub's own record/file are UNTOUCHED",
    reducedContributorsOf(readLatchFileIfExists(R)).includes(directPathIdentity(sub))
    && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1);

  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round7probeA-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, activeMergeQuarantineFor, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const first = clearMergeQuarantineReporting(sub);
    const second = clearMergeQuarantineReporting(sub);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      first, second, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (round7-probeA) *** R's real quarantine is STILL ACTIVE after reboot + TWO clear(sub) calls", out.rStillActive);
  check("*** THE FIX (round7-probeA) *** assertRepoNotQuarantined(R).ok is FALSE after reboot + TWO clear(sub) calls", out.rOk === false);
  // @decision 3b1944b6 (Round 8, finding 4) — compare via directPathIdentity, never a raw .includes(R) —
  // same rule (round5-liftedpair)/(round7-p6) already follow; liftedRepoPaths can carry a normalized form.
  const firstLiftedIdentities = new Set(out.first.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  const secondLiftedIdentities = new Set(out.second.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE FIX (round7-probeA) *** neither clear ever names R in liftedRepoPaths (0/0)", !firstLiftedIdentities.has(directPathIdentity(R)) && !secondLiftedIdentities.has(directPathIdentity(R)));
}

// ===================== (round7-probeA-control) same construction, marker NEVER written — proves the probe above is not vacuous =====================
{
  const R = freshDir("round7probeAcontrol-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-probeA-control)");

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round7-probeA-control)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R — the marker is NEVER written this time

  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round7probeAcontrol-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, activeMergeQuarantineFor, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const first = clearMergeQuarantineReporting(sub);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      first, rStillActive: !!activeMergeQuarantineFor(R), rOk: assertRepoNotQuarantined(R).ok,
    }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  const controlLiftedIdentities = new Set(out.first.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("(round7-probeA-control) WITHOUT the marker, the identical construction DOES wrongly lift R — proves (round7-probeA) actually discriminates", controlLiftedIdentities.has(directPathIdentity(R)) && out.rStillActive === false && out.rOk === true);
}

// ===================== (round6-route-path) clear-by-path(sub), then /clear(sub) — must never lift R =====================
{
  const R = freshDir("round6routepath-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round6-route-path)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round6-route-path)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true });

  const first = clearMergeQuarantineByRecordedPath(sub);
  check("(round6-route-path precondition) clear-by-path lifts ONLY sub; R stays blocked", first.wasQuarantined === true && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));

  const second = clearMergeQuarantineReporting(sub); // a LATER /clear(sub) must never lift R
  check("*** THE FIX (round6-route-path) *** R's real quarantine is STILL ACTIVE after /clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round6-route-path) *** assertRepoNotQuarantined(R).ok is FALSE after /clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round6-route-path) *** /clear(sub) never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
}

// ===================== (round6-route-id) clear-by-id(sub), then /clear(sub) — must never lift R =====================
{
  const R = freshDir("round6routeid-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round6-route-id)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round6-route-id)");
  const subId = quarantineLatchIdFor(sub); // captured while sub still owns its own real key
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true });

  const first = clearMergeQuarantineLatchFile(subId);
  check("(round6-route-id precondition) clear-by-id lifts ONLY sub; R stays blocked", first.ok === true && first.wasQuarantined === true && listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));

  const second = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (round6-route-id) *** R's real quarantine is STILL ACTIVE after /clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round6-route-id) *** assertRepoNotQuarantined(R).ok is FALSE after /clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round6-route-id) *** /clear(sub) never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
}

// ===================== (round6-route-token) clearMergeQuarantineByToken(sub, tok), then /clear(sub) — must never lift R =====================
{
  const R = freshDir("round6routetoken-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round6-route-token)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  const subToken = enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round6-route-token)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true });

  clearMergeQuarantineByToken(sub, subToken); // the token-settle path — must ALSO mark R before releasing sub's own record
  check("(round6-route-token precondition) token-settle lifts ONLY sub; R stays blocked", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 0 && !!activeMergeQuarantineFor(R));

  const second = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (round6-route-token) *** R's real quarantine is STILL ACTIVE after /clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round6-route-token) *** assertRepoNotQuarantined(R).ok is FALSE after /clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round6-route-token) *** /clear(sub) never names R in liftedRepoPaths", !second.liftedRepoPaths.includes(R));
}

// ===================== ROUND 7 — Code Review (delta review on top of ROUND 6, f056d721) =====================
// Finding 1 (MAJOR): `preClearForeignKeyStamp` stamped whenever the fresh key was foreign, with NO check
// that `repoPath` has an OWN record (active or pending) actually about to be cleared. A pure
// contributor-token settle (clearMergeQuarantineByToken, scenario D below) and a plain-dir clear-by-path
// with no record at all (scenario D2) each durably marked a foreign entry for an identity that was never
// genuinely having its own record cleared. Fix: the chokepoint now mirrors `clearMergeQuarantine`'s own
// `matched.length > 0 || hasOwnPendingMatch` gate internally, so no caller can forget it.

// ===================== (round7-d) MAJOR finding 1 — a pure contributor-token settle must NEVER stamp =====================
{
  const R = freshDir("round7d-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-d)");

  const S = path.join(R, "sub"); // a registry-bound subdir — NEVER has its own .git, ever
  fs.rmSync(S, { recursive: true, force: true }); // genuinely absent at raise time — pending-only
  const sToken = enterMergeQuarantine(S, "branch-S", "S's own raise while unresolvable, nested under R, never own .git (round7-d)");
  check("(round7-d precondition) S's own record is pending-only, R untouched by it", activeMergeQuarantineFor(R).tokens.length === 1);

  fs.mkdirSync(S, { recursive: true }); // resolvable, no own .git ever — collapses onto R's key
  activeMergeQuarantineFor(R); // trigger the cross-tier sibling absorption explicitly (card 8a1bc2ef) — the same path /clear's own `before` reaches
  check("(round7-d precondition) absorption folded S into R's union as a PURE contributor, with no own record left anywhere",
    contributorsOf(activeMergeQuarantineFor(R)).some((c) => c === S)
    && findPendingIndexByIdentityTestOnly(S) === -1
    && activeMergeQuarantineFor(R).tokens.length === 2);

  clearMergeQuarantineByToken(S, sToken); // S's token settles — a PURE contributor-token settle, never S's OWN record being cleared
  const postSettle = readLatchFileIfExists(R);
  check("*** THE FIX (round7-d) *** R is NEVER durably marked reduced for S — a contributor-token settle is not S's own record being cleared", !reducedContributorsOf(postSettle).includes(directPathIdentity(S)));
  check("(round7-d) R's union otherwise survives untouched — its own token remains, and S's contributor membership is unaffected by a mere token settle", !!activeMergeQuarantineFor(R) && contributorsOf(postSettle).some((c) => c === S));
}

// ===================== (round7-d2) MAJOR finding 1 — clear-by-path on a plain dir with NO record of its own must never stamp either =====================
{
  const R = freshDir("round7d2-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-d2)");

  const plain = path.join(R, "src"); // a plain subdir — never raised, no record of its own, no .git
  fs.mkdirSync(plain, { recursive: true });
  check("(round7-d2 precondition) plain's fresh key collapses onto R's", canonicalRepoLockKey(plain) === canonicalRepoLockKey(R));

  const result = clearMergeQuarantineByRecordedPath(plain);
  check("(round7-d2) clear-by-path on a never-raised plain dir reports wasQuarantined:false", result.wasQuarantined === false);
  const postClear = readLatchFileIfExists(R);
  check("*** THE FIX (round7-d2) *** R is NEVER durably marked reduced for a plain dir that was never its own record", !reducedContributorsOf(postClear).includes(directPathIdentity(plain)));
}

// ===================== (round7-reportreason) MINOR finding 2 — clearMergeQuarantineReporting forwards a REFUSED clear's own reason verbatim =====================
{
  const R = freshDir("round7reportreason-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-reportreason)");
  const rFinalPath = finalPathFor(R);

  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round7-reportreason)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R

  const inj = injectOpenSyncFailureForPrefix(rFinalPath); // fails the marker's own durable write at R's final path
  let result;
  try {
    result = clearMergeQuarantineReporting(sub); // the project-resolved route — must forward the preClear's own refusal reason
  } finally {
    inj.restore();
  }
  check("(round7-reportreason) the injected failure actually fired at least once", inj.count() > 0);
  check("*** THE FIX (round7-reportreason) *** result forwards the preClear's own refusal reason verbatim", !!result.reason && result.reason.includes("could not durably mark"));
  check("*** THE FIX (round7-reportreason) *** result does NOT use the misleading 'ANOTHER repo's own, separate quarantine' wording for this refusal", !result.reason || !result.reason.includes("quarantined by ANOTHER repo's own, separate quarantine"));
  check("(round7-reportreason) sub's own record is KEPT — the clear never touched it", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1);
}

// ===================== (round7-p6) MINOR finding 3 — the "blocked-before" gate for reducedContributorRepoPaths candidates was a tautology =====================
// `ownIdentityEntryFor(c)`, called with no exclusion, ALWAYS found the very entry being cleared (that
// entry's own `reducedContributorRepoPaths` trivially names `c` as one of its members) — it could never
// return false, so the gate never actually filtered anything. Repro: stamp R via shape A, then let sub
// genuinely regain its OWN key (its `.git` restored, never re-raised) — sub is now provably, fully free
// — yet clearing R still named sub as lifted.
{
  const R = freshDir("round7p6-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round7-p6)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round7-p6)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R

  clearMergeQuarantineReporting(sub); // shape A — stamps R's own reducedContributorRepoPaths=[sub]
  check("(round7-p6 precondition) R is now durably marked reduced for sub", reducedContributorsOf(readLatchFileIfExists(R)).includes(directPathIdentity(sub)));

  markAsGitRoot(sub); // sub's .git RESTORED — sub now owns its own, empty key again; never re-raised
  check("(round7-p6 precondition) sub now owns its own key again", canonicalRepoLockKey(sub) !== canonicalRepoLockKey(R));
  check("(round7-p6 precondition) sub is genuinely, fully free — BEFORE the second clear", assertRepoNotQuarantined(sub).ok === true);

  const result = clearMergeQuarantineReporting(R); // a full clear of R
  // @decision 3b1944b6 (Round 5, CR3 item 3's own established rule) — compare via directPathIdentity,
  // never literal string equality: liftedRepoPaths can carry the NORMALIZED identity, not sub's raw,
  // as-typed path.
  const liftedIdentities = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE FIX (round7-p6) *** R's full clear never names sub as lifted — sub was never genuinely blocked by this clear at all", !liftedIdentities.has(directPathIdentity(sub)));
  check("(round7-p6) R is genuinely lifted", assertRepoNotQuarantined(R).ok === true);
}

// ===================== ROUND 8 — delta Code Review (reviewer ff0f9dca, delta f056d721..5defdc99) =====================
// Finding 1 (MAJOR): the Round 7 gate checked "identity has ANY own record", not "THIS clear is clearing
// that own record" — the token route can match a holder whose OWN identity differs from repoPath's, even
// while repoPath separately has an unrelated own record elsewhere. Finding 2 (MINOR): a genuine still-
// blocked disclosure's own reason (already composed with its relocated clause) was recomposed a second
// time at the outer wrapper, duplicating the clause. Finding 3 (MINOR): the Round 7 blocked-before check
// looked at the active map only, missing tier-3/4 PENDING resolution.

// ===================== (round8-q2) MAJOR finding 1 — the token route must key off THIS token's own holder, never "sub has SOME own record" =====================
for (const which of ["own", "contrib"]) {
  const R = freshDir(`round8q2${which}-R`);
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", `R's own real raise (round8-q2-${which})`);

  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no .git yet — folds directly into R's union as a contributor
  const tContrib = enterMergeQuarantine(sub, "branch-sub-contrib", `sub's contributor raise, no .git yet (round8-q2-${which})`);
  markAsGitRoot(sub); // sub now owns its own key
  const tOwn = enterMergeQuarantine(sub, "branch-sub-own", `sub's own independent raise, now has .git (round8-q2-${which})`);
  check(`(round8-q2-${which} precondition) sub's own independent record exists, and a separate contributor token sits in R's union`,
    listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1
    && (activeMergeQuarantineFor(R).contributorRepoPaths ?? []).some((c) => c === sub));

  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses sub's OWN record onto R's key too

  clearMergeQuarantineByToken(sub, which === "own" ? tOwn : tContrib);
  const postSettle = readLatchFileIfExists(R);
  if (which === "own") {
    check(`*** THE FIX (round8-q2-${which}) *** settling sub's OWN token DOES stamp R reduced — this genuinely is sub's own record being cleared`, reducedContributorsOf(postSettle).includes(directPathIdentity(sub)));
  } else {
    check(`*** THE FIX (round8-q2-${which}) *** settling a mere CONTRIBUTOR token must NEVER stamp R reduced — sub's OWN record is untouched by it`, !reducedContributorsOf(postSettle).includes(directPathIdentity(sub)));
  }
}

// ===================== (round8-q2b) MAJOR finding 1 — settling a BOGUS (never-issued) token must never stamp either =====================
{
  const R = freshDir("round8q2b-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round8-q2b)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round8-q2b)");
  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses onto R

  clearMergeQuarantineByToken(sub, "no-such-token-ever-issued");
  const postSettle = readLatchFileIfExists(R);
  check("*** THE FIX (round8-q2b) *** settling a bogus, never-issued token must NEVER stamp R reduced", !reducedContributorsOf(postSettle).includes(directPathIdentity(sub)));
  check("(round8-q2b) sub's own record is untouched — nothing actually matched the bogus token", listActiveMergeQuarantines().filter((e) => e.repoPath === sub).length === 1);
}

// ===================== (round8-q4) MINOR finding 2 — the forwarded still-blocked reason must never duplicate the relocated-co-occupant clause =====================
{
  const R = freshDir("round8q4-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round8-q4)");
  const sub = path.join(R, "sub");
  markAsGitRoot(sub);
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git at raise time (round8-q4)");

  // Plant a FOREIGN occupant's content at sub's own physical latch file (while sub still owns its own
  // key) — this clear's own protect/relocate machinery (card 8db913e2) discovers it and durably
  // relocates it to its own new latch, producing a genuinely still-blocked co-occupant.
  const X = path.join(R, "X-never-exists"); // a never-raised, unrelated identity; never created on disk
  fs.writeFileSync(finalPathFor(sub), JSON.stringify({ repoPath: X, branch: "bx", reason: "X placeholder", enteredAt: Date.now(), tokens: ["x-tok"] }, null, 2) + "\n");

  fs.rmSync(path.join(sub, ".git"), { recursive: true, force: true }); // collapses sub's own key onto R's

  const result = clearMergeQuarantineReporting(sub);
  const occurrences = (result.reason ?? "").split("this clear also found").length - 1;
  check("*** THE FIX (round8-q4) *** the relocated-co-occupant clause appears EXACTLY ONCE in the reason, never twice", occurrences === 1);
  check("(round8-q4) the relocated identity is genuinely reported as a still-blocked co-occupant", (result.stillBlockedCoOccupants ?? []).some((co) => directPathIdentity(co.repoPath) === directPathIdentity(X)));
}

// ===================== (round8-q3) MINOR finding 3 — a reducedContributorRepoPaths marker on a fully-deleted, PENDING entry must still correctly report its candidate as lifted =====================
// CR7's own named test gap: nothing in this file exercised `reducedCandidateBlockedByEntry` for an
// `entry` that is itself PENDING (every other scenario's own `entry` is active) — restoring Round 7's
// `reducedCandidateStillEntangled` body (active-map-only) still passed the WHOLE rest of this file.
//
// @decision 3b1944b6 (Round 8/CR7 item 1) — R is DELIBERATELY NEVER raised here — just a git-root dir.
// Raising R would let sub's own ancestor-walk resolve to R's active entry FIRST, masking the pending
// tier this scenario exercises (a first draft raised R and failed for exactly this reason).
{
  const R = freshDir("round8q3-R");
  markAsGitRoot(R);
  const G = path.join(R, "gone");
  markAsGitRoot(G);
  enterMergeQuarantine(G, "branch-G", "G's own real raise (round8-q3)");
  const sub = path.join(R, "sub"); // created but NEVER raised at all — purely a synthetic marker target
  fs.mkdirSync(sub, { recursive: true });

  // Stamp G's own durable latch with a (synthetic, test-only) reducedContributorRepoPaths marker naming sub.
  const gFinalPath = finalPathFor(G);
  const gOnDisk = JSON.parse(fs.readFileSync(gFinalPath, "utf8"));
  gOnDisk.reducedContributorRepoPaths = [directPathIdentity(sub)];
  fs.writeFileSync(gFinalPath, JSON.stringify(gOnDisk, null, 2) + "\n");

  fs.rmSync(G, { recursive: true, force: true }); // G's entire directory is gone — fully unresolvable

  const outFile = path.join(os.tmpdir(), `loom-mq3b1944b6-round8q3-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const {
      reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, assertRepoNotQuarantined,
    } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const G = ${JSON.stringify(G)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R]);
    const subBefore = assertRepoNotQuarantined(sub).ok;
    const r = clearMergeQuarantineReporting(G);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ subBefore, r, subAfter: assertRepoNotQuarantined(sub).ok }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });

  check("(round8-q3 precondition) sub reads as blocked BEFORE the clear, via G's own durable marker", out.subBefore === false);
  const liftedIdentities = new Set(out.r.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE FIX (round8-q3) *** clearing G reports BOTH G and sub as lifted", liftedIdentities.has(directPathIdentity(G)) && liftedIdentities.has(directPathIdentity(sub)));
  check("(round8-q3) sub reads as free AFTER the clear", out.subAfter === true);
}

// ===================== (round8-route-id-pending) clear-by-id(sub) via the PENDING branch, then /clear(sub) — must never lift R (round6-route-id only covered the ACTIVE branch) =====================
{
  const R = freshDir("round8routeidpending-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "branch-R", "R's own real raise (round8-route-id-pending)");
  const sub = path.join(R, "sub");
  fs.rmSync(sub, { recursive: true, force: true }); // genuinely absent at raise time — pending-only
  enterMergeQuarantine(sub, "branch-sub", "sub's own raise while unresolvable (round8-route-id-pending)");
  const subEntry = listActiveMergeQuarantines().find((e) => e.repoPath === sub);
  const subId = quarantineLatchFileIdsFor(subEntry)[0]; // captured while sub is still pending, under its own identity hash
  fs.mkdirSync(sub, { recursive: true }); // resolvable now, no own .git — collapses onto R's key, but sub's own record stays PENDING (never queried/absorbed yet)
  check("(round8-route-id-pending precondition) sub's own record is still PENDING (never queried/absorbed)", findPendingIndexByIdentityTestOnly(sub) !== -1);

  const first = clearMergeQuarantineLatchFile(subId); // must hit the PENDING branch, not the active one
  check("(round8-route-id-pending precondition) clear-by-id (pending branch) lifts ONLY sub; R stays blocked", first.ok === true && first.wasQuarantined === true && !!activeMergeQuarantineFor(R));

  const second = clearMergeQuarantineReporting(sub); // a LATER /clear(sub) must never lift R
  const secondLiftedIdentities = new Set(second.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** THE FIX (round8-route-id-pending) *** R's real quarantine is STILL ACTIVE after /clear(sub)", !!activeMergeQuarantineFor(R));
  check("*** THE FIX (round8-route-id-pending) *** assertRepoNotQuarantined(R).ok is FALSE after /clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (round8-route-id-pending) *** /clear(sub) never names R in liftedRepoPaths", !secondLiftedIdentities.has(directPathIdentity(R)));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
