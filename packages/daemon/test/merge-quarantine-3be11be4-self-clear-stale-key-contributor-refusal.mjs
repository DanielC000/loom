import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 3be11be4 — refuse self-clearing a stale-key union with a genuine contributor; never widen
// the guard to fire for a repoPath that genuinely owns its own key. See the decision record in full.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq3be11be4-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantine,
  clearMergeQuarantineReporting, clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile,
  assertRepoNotQuarantined, directPathIdentity, quarantineLatchIdFor, MERGE_QUARANTINE_DIR,
  isNestedUnderKey, reenterMergeQuarantinesAtBoot,
} = await import(mergeQuarantineModuleUrl);
const repoLockModuleUrl = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { canonicalRepoLockKey } = await import(repoLockModuleUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
function freshDir(tag) {
  n++;
  const d = path.join(os.tmpdir(), `loom-mq3be11be4-${tag}-${sfx}-${n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function markAsGitRoot(dir) { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); }

// Builds the card's own mirror shape: `sub` (R/sub, NO own `.git`) raises FIRST — its fresh key walks
// straight up to R's real toplevel (R already has a `.git` on disk, just not yet raised), so this is an
// ACTIVE entry at R's key with `.repoPath = sub` (nothing to union with yet). `R` then raises SECOND, at
// its own genuine key (the SAME key sub already occupies) — `enterMergeQuarantine`'s `existing` branch
// fires; `unionQuarantineEntries`' age-based winner keeps the OLDER (`sub`) as `.repoPath`; `R` folds in
// as a mere `contributorRepoPaths` member. Mirrors 3b1944b6's own Round-3 W/teamA construction exactly,
// roles reversed (there, the REAL-`.git` party raised first and won; here, the bare subdirectory does).
function buildMirrorFixture(tag) {
  const R = freshDir(`${tag}-R`);
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // NO own .git
  enterMergeQuarantine(sub, "branch-sub", `sub raises first, collapses onto R's key immediately (${tag})`);
  enterMergeQuarantine(R, "branch-R", `R raises second, at its own genuine key (${tag})`);
  return { R, sub };
}

function checkMirrorPrecondition(tag, R, sub) {
  const entry = activeMergeQuarantineFor(sub);
  check(`(${tag} precondition) the union's own .repoPath is sub (the age-based naming-race winner)`, entry?.repoPath === sub);
  check(`(${tag} precondition) R is folded in as a contributor`, !!entry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(R)));
  check(`(${tag} precondition) R is genuinely blocked before any clear`, assertRepoNotQuarantined(R).ok === false);
  check(`(${tag} precondition) sub is genuinely blocked before any clear`, assertRepoNotQuarantined(sub).ok === false);
}

// ===================== (i-clear) /clear(sub) refuses; R stays blocked =====================
{
  const { R, sub } = buildMirrorFixture("i-clear");
  checkMirrorPrecondition("i-clear", R, sub);

  const result = clearMergeQuarantineReporting(sub);
  // @decision 3b1944b6 (Round 3's own "Do not") — clearMergeQuarantineReporting's own return type never
  // carries refusedBeforeClear/stillQuarantined; the refusal rides in `reason`/`liftedRepoPaths` alone.
  check("*** THE FIX (i-clear) *** /clear(sub) REFUSES — wasQuarantined is reported true (nothing newly lifted)", result.wasQuarantined === true);
  check("*** THE FIX (i-clear) *** /clear(sub)'s reason says nothing was cleared", result.reason?.includes("Nothing was cleared"));
  check("*** THE FIX (i-clear) *** /clear(sub) lifts NOTHING", result.liftedRepoPaths.length === 0);
  check("*** THE FIX (i-clear) *** R is STILL blocked after /clear(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (i-clear) *** sub is STILL blocked after /clear(sub) (its own hold was never separated out)", assertRepoNotQuarantined(sub).ok === false);
  check("(i-clear) R's own entry is untouched — still armed, still the same object's own contributorRepoPaths", !!activeMergeQuarantineFor(R)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(R)));
  // @decision 3be11be4 (Round 2, item 4) — `?.` here so a future negative-control revert (which can
  // legitimately leave `reason` undefined) fails these three checks rather than crashing past them.
  check("(i-clear) the refusal names R", !!result.reason?.includes(R));
  check("(i-clear) the refusal does NOT recommend clear-by-path with sub's own path (that route now ALSO refuses)", !result.reason?.includes(`clear-by-path with one of ["${sub}"`));
  check("(i-clear) the refusal names the project-resolved /clear route as the one that actually works", !!result.reason?.includes("/internal/merge-quarantine/clear"));
}

// ===================== (i-clearbypath) clear-by-path(sub) refuses; R stays blocked =====================
{
  const { R, sub } = buildMirrorFixture("i-clearbypath");
  checkMirrorPrecondition("i-clearbypath", R, sub);

  const result = clearMergeQuarantineByRecordedPath(sub);
  check("*** THE FIX (i-clearbypath) *** clear-by-path(sub) REFUSES", result.wasQuarantined === true && result.refusedBeforeClear === true);
  check("*** THE FIX (i-clearbypath) *** clear-by-path(sub) lifts NOTHING", result.liftedRepoPaths.length === 0);
  check("*** THE FIX (i-clearbypath) *** R is STILL blocked after clear-by-path(sub)", assertRepoNotQuarantined(R).ok === false);
  check("*** THE FIX (i-clearbypath) *** sub is STILL blocked after clear-by-path(sub)", assertRepoNotQuarantined(sub).ok === false);
  const viaClear = clearMergeQuarantineReporting(sub);
  check("(i-clearbypath) clearMergeQuarantineReporting(sub) agrees — both real routes refuse identically", viaClear.liftedRepoPaths.length === 0 && viaClear.reason?.includes("Nothing was cleared"));
}

// ===================== (iii-clearbyid) clear-by-id still refuses, with the CORRECTED remediation text =====================
{
  const { R, sub } = buildMirrorFixture("iii-clearbyid");
  checkMirrorPrecondition("iii-clearbyid", R, sub);

  const id = quarantineLatchIdFor(sub);
  const result = clearMergeQuarantineLatchFile(id);
  check("(iii-clearbyid) clear-by-id refuses (pre-existing, unaffected posture — ambiguous contributorRepoPaths)", result.ok === false);
  check("*** THE FIX (iii-clearbyid) *** the corrected text no longer recommends clear-by-path with sub's own path", !result.reason.includes(`clear-by-path with one of ["${sub}"`));
  check("*** THE FIX (iii-clearbyid) *** the corrected text names the project-resolved /clear route instead", result.reason.includes("project-resolved POST /internal/merge-quarantine/clear"));
  check("(iii-clearbyid) R is still blocked", assertRepoNotQuarantined(R).ok === false);
}

// ===================== (ii-ownerescape) /clear(R) — R's OWN owner — still fully lifts BOTH =====================
{
  const { R, sub } = buildMirrorFixture("ii-ownerescape");
  checkMirrorPrecondition("ii-ownerescape", R, sub);

  const result = clearMergeQuarantineReporting(R);
  check("*** THE FIX (ii-ownerescape) *** /clear(R) is UNAFFECTED by this card's new guard — it still fully lifts", result.wasQuarantined === true);
  const liftedIdentities = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("(ii-ownerescape) /clear(R) lifts R", liftedIdentities.has(directPathIdentity(R)));
  check("(ii-ownerescape) /clear(R) ALSO lifts sub (the whole union)", liftedIdentities.has(directPathIdentity(sub)));
  check("(ii-ownerescape) R reads clear afterward", assertRepoNotQuarantined(R).ok === true);
  check("(ii-ownerescape) sub reads clear afterward", assertRepoNotQuarantined(sub).ok === true);
}

// ===================== (owner) non-regression — a repo that GENUINELY owns its own key must still fully =====================
// ===================== release everything when cleared BY ITS OWN NAME, contributors included (82032b5c/9e826040) =====================
{
  const x = freshDir("owner-x");
  markAsGitRoot(x);
  const ySub = path.join(x, "subdir");
  fs.mkdirSync(ySub, { recursive: true }); // NO own .git — will be absorbed as a contributor
  enterMergeQuarantine(x, "x-branch", "x raises first, owns its own real key (owner)");
  enterMergeQuarantine(ySub, "y-branch", "ySub raises second, absorbed as a contributor (owner)");
  const entry = activeMergeQuarantineFor(x);
  check("(owner precondition) the union's own .repoPath is x (x raised first too, but ALSO genuinely owns this key)", entry?.repoPath === x);
  check("(owner precondition) ySub is folded in as a contributor", !!entry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(ySub)));
  check("(owner precondition) x is blocked", assertRepoNotQuarantined(x).ok === false);
  check("(owner precondition) ySub is blocked", assertRepoNotQuarantined(ySub).ok === false);

  const result = clearMergeQuarantineByRecordedPath(x);
  check("*** NON-REGRESSION (owner) *** clear-by-path(x) — x GENUINELY OWNS this key — must NOT refuse; must fully lift", result.wasQuarantined === true && !result.refusedBeforeClear);
  check("(owner) x reads clear afterward", assertRepoNotQuarantined(x).ok === true);
  check("(owner) ySub ALSO reads clear afterward (the pre-existing, intentional 'self-clear releases everything' behavior)", assertRepoNotQuarantined(ySub).ok === true);
}

// ===================== (owner-site1) SAME non-regression, but via /clear(x) — clearMergeQuarantine's own =====================
// ===================== fresh-key fallback (SITE 1), never clear-by-path's own tryClearMergeQuarantineByOwnIdentity (SITE 2) =====================
{
  const x = freshDir("owner-site1-x");
  markAsGitRoot(x);
  const ySub = path.join(x, "subdir");
  fs.mkdirSync(ySub, { recursive: true });
  enterMergeQuarantine(x, "x-branch", "x raises first, owns its own real key (owner-site1)");
  enterMergeQuarantine(ySub, "y-branch", "ySub raises second, absorbed as a contributor (owner-site1)");
  check("(owner-site1 precondition) x owns this union's own name and genuinely owns its own key", activeMergeQuarantineFor(x)?.repoPath === x && canonicalRepoLockKey(x) === directPathIdentity(x));

  const result = clearMergeQuarantineReporting(x); // /clear(x) -> clearMergeQuarantine's fresh-key fallback (SITE 1)
  check("*** NON-REGRESSION (owner-site1) *** /clear(x) — SITE 1's own guard check — must NOT refuse; must fully lift", result.wasQuarantined === true);
  const lifted = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("(owner-site1) /clear(x) lifts BOTH x and ySub", lifted.has(directPathIdentity(x)) && lifted.has(directPathIdentity(ySub)));
  check("(owner-site1) x reads clear afterward", assertRepoNotQuarantined(x).ok === true);
  check("(owner-site1) ySub ALSO reads clear afterward", assertRepoNotQuarantined(ySub).ok === true);
}

// ===================== (v-nounion) the non-union shape (no contributors at all) — /clear(sub) still clears =====================
// ===================== normally; this card's new guard must never over-fire =====================
{
  const R = freshDir("v-nounion-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  markAsGitRoot(sub); // sub has its OWN .git this time — an ordinary, wholly independent raise, no union at all
  enterMergeQuarantine(R, "branch-R", "R's own real, genuine raise (v-nounion)");
  enterMergeQuarantine(sub, "branch-sub", "sub's own independent raise, own .git (v-nounion)");
  check("(v-nounion precondition) sub's own entry carries no contributors at all", !activeMergeQuarantineFor(sub)?.contributorRepoPaths?.length);
  check("(v-nounion precondition) sub is blocked", assertRepoNotQuarantined(sub).ok === false);

  // @decision 3be11be4 (Round 2, item 4) — dropped the non-discriminating wasQuarantined/refusedBeforeClear
  // checks (the latter isn't even on this wrapper's own return type) — only "sub reads clear" discriminates.
  clearMergeQuarantineReporting(sub);
  check("*** THE GUARD DOES NOT OVER-FIRE (v-nounion) *** sub reads clear afterward", assertRepoNotQuarantined(sub).ok === true);
  check("(v-nounion) R is UNTOUCHED and still blocked (sub and R were never related)", assertRepoNotQuarantined(R).ok === false);
}

// ═══════════════════════ ROUND 2 (Code Review dede2ffd) ═══════════════════════
// Item 1 — selfClearRefusesForStaleKeyContributors now decides ownership from a STORED armedKey, never a
// live canonicalRepoLockKey re-walk of entry.repoPath. Three real-git bypasses of the Round-1 predicate,
// each proven RED under the OLD predicate and GREEN under the fixed one via a manual revert/rebuild/
// restore cycle (see this card's own worker_report for the exact procedure; not scripted here since it
// requires rebuilding against reverted source).

// ===================== (bypass-a) sub gains its own .git AFTER the union has already formed =====================
{
  const { R, sub } = buildMirrorFixture("bypass-a");
  checkMirrorPrecondition("bypass-a", R, sub);
  markAsGitRoot(sub); // NOW give sub its own .git — the OLD predicate's live walk would read this as "owns its own key"

  clearMergeQuarantineReporting(sub);
  check("*** THE FIX (bypass-a) *** R is STILL blocked despite sub gaining its own .git after the union formed", assertRepoNotQuarantined(R).ok === false);
  check("(bypass-a) sub's own union entry is untouched (still carries R as a contributor)", !!activeMergeQuarantineFor(R)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(R)));
}

// ===================== (bypass-b) sub is deleted/unmounted after the union has formed =====================
{
  const { R, sub } = buildMirrorFixture("bypass-b");
  checkMirrorPrecondition("bypass-b", R, sub);
  fs.rmSync(sub, { recursive: true, force: true }); // the OLD predicate's resolvability exemption fails OPEN here

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (bypass-b) *** /clear(sub) still refuses even though sub no longer resolves", !!result.reason?.includes("Nothing was cleared"));
  check("*** THE FIX (bypass-b) *** R is STILL blocked despite sub being deleted", assertRepoNotQuarantined(R).ok === false);
}

// ===================== (bypass-c) R's .git is temporarily absent while sub still exists =====================
{
  const { R, sub } = buildMirrorFixture("bypass-c");
  checkMirrorPrecondition("bypass-c", R, sub);
  fs.rmSync(path.join(R, ".git"), { recursive: true, force: true }); // sub's own walk now returns its own path — the OLD predicate reads this as "owns"

  const clearResult = clearMergeQuarantine(sub); // the direct function — shows the true internal refusal
  check("*** THE FIX (bypass-c) *** /clear(sub) (direct) refuses even with R's .git temporarily gone", clearResult.refusedBeforeClear === true && clearResult.liftedRepoPaths.length === 0);
  check("(bypass-c) R is STILL blocked via /clear(sub)", assertRepoNotQuarantined(R).ok === false);
}
{
  const { R, sub } = buildMirrorFixture("bypass-c-clearbypath");
  checkMirrorPrecondition("bypass-c-clearbypath", R, sub);
  fs.rmSync(path.join(R, ".git"), { recursive: true, force: true });

  const result = clearMergeQuarantineByRecordedPath(sub);
  check("*** THE FIX (bypass-c-clearbypath) *** clear-by-path(sub) refuses even with R's .git temporarily gone", result.refusedBeforeClear === true && result.liftedRepoPaths.length === 0);
  check("(bypass-c-clearbypath) R is STILL blocked", assertRepoNotQuarantined(R).ok === false);
}

// Item 2 — remediationTextFor's "no honest clear-by-path target" wording now names a verified two-step
// sequence (clear every contributor first, then the primary) rather than a single claim that is a NO-OP
// for a bare-subdirectory contributor. Driven end-to-end in BOTH contributor shapes.

// ===================== (sequence-r-owns) the contributor (R) owns its own real key =====================
{
  const { R, sub } = buildMirrorFixture("sequence-r-owns");
  checkMirrorPrecondition("sequence-r-owns", R, sub);
  const id = quarantineLatchIdFor(sub);
  const refusal = clearMergeQuarantineLatchFile(id);
  check("(sequence-r-owns) the text names the two-step sequence", !!refusal.reason?.includes("clear each contributor's own quarantine directly FIRST"));

  // Step 1: clear the contributor (R) via the project-resolved route named in the text.
  const step1 = clearMergeQuarantineReporting(R);
  check("*** THE FIX (sequence-r-owns) *** step 1 (clear contributor R) fully releases the whole entry — R genuinely owns a real identity of its own", step1.wasQuarantined === true);
  check("(sequence-r-owns) R released after step 1", assertRepoNotQuarantined(R).ok === true);
  check("(sequence-r-owns) sub ALSO released after step 1 (same union)", assertRepoNotQuarantined(sub).ok === true);
  // Step 2: clear the primary — named by the text as what releases "whatever still remains"; here, nothing does.
  const step2 = clearMergeQuarantineByRecordedPath(sub);
  check("(sequence-r-owns) step 2 (clear primary) is a harmless no-op — nothing remained", step2.wasQuarantined === false);
}

// ===================== (sequence-bare-subdir) the contributor (D) is itself a bare subdirectory with no =====================
// ===================== own .git (the b5c94cbe shape) — clearing it alone must NOT claim to release everything =====================
{
  const R = freshDir("sequence-bare-R");
  markAsGitRoot(R);
  const sSub = path.join(R, "s-sub");
  fs.mkdirSync(sSub, { recursive: true });
  const dSub = path.join(R, "d-sub");
  fs.mkdirSync(dSub, { recursive: true });
  enterMergeQuarantine(sSub, "s-branch", "s raises first (sequence-bare-subdir)");
  enterMergeQuarantine(dSub, "d-branch", "d raises second, folds in as a BARE-SUBDIR contributor (sequence-bare-subdir)");
  const entry = activeMergeQuarantineFor(sSub);
  check("(sequence-bare-subdir precondition) the union's own .repoPath is sSub", entry?.repoPath === sSub);
  check("(sequence-bare-subdir precondition) dSub is folded in as a contributor, and does NOT own its own key", !!entry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(dSub)) && canonicalRepoLockKey(dSub) !== directPathIdentity(dSub));

  const id = quarantineLatchIdFor(sSub);
  const refusal = clearMergeQuarantineLatchFile(id);
  check("(sequence-bare-subdir) the text names the two-step sequence here too", !!refusal.reason?.includes("clear each contributor's own quarantine directly FIRST"));

  // Step 1: clear the contributor (D) — a bare subdirectory with no identity of its own.
  const step1 = clearMergeQuarantineReporting(dSub);
  check("*** THE FIX (sequence-bare-subdir) *** step 1 (clear bare-subdir contributor D) lifts NOTHING by itself — it only reduces", step1.liftedRepoPaths.length === 0);
  check("(sequence-bare-subdir) sSub is STILL blocked after step 1 — step 1 alone never released it", assertRepoNotQuarantined(sSub).ok === false);
  // Step 2: clear the primary (S) — per the text, THIS is what releases what remains.
  const step2 = clearMergeQuarantineByRecordedPath(sSub);
  check("*** THE FIX (sequence-bare-subdir) *** step 2 (clear primary S) now releases the whole entry", step2.wasQuarantined === true);
  check("(sequence-bare-subdir) sSub released after step 2", assertRepoNotQuarantined(sSub).ok === true);
  check("(sequence-bare-subdir) dSub ALSO released after step 2", assertRepoNotQuarantined(dSub).ok === true);
}

// Item 3 — this card's own guard is now checked BEFORE preClearForeignKeyStamp in both routes, so a
// refusal never durably stamps an unrelated foreign entry's own latch file. Reviewer's probe3 shape:
// R and A=R/a each with their own `.git`; B=R/a/b without. Raise B, A, R (R wholly unrelated, standalone).
// Delete A's `.git` — B's own fresh-key walk now coincidentally resolves PAST A, to R's own real key,
// making preClearForeignKeyStamp's OWN independent walk treat R's standalone entry as "foreign" to B.

// ===================== (probe3) a refused /clear(B) and a refused clear-by-path(B) must write NOTHING to R's own latch file =====================
{
  function hashKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
  function finalPathFor(repoPath) { return path.join(MERGE_QUARANTINE_DIR, `${hashKey(canonicalRepoLockKey(repoPath))}.json`); }

  const R = freshDir("probe3-R");
  markAsGitRoot(R);
  const A = path.join(R, "a");
  markAsGitRoot(A);
  const B = path.join(A, "b");
  fs.mkdirSync(B, { recursive: true }); // no own .git

  enterMergeQuarantine(B, "b-branch", "B raises first, collapses onto A (probe3)");
  enterMergeQuarantine(A, "a-branch", "A raises second, folds in as B's contributor (probe3)");
  enterMergeQuarantine(R, "r-branch", "R raises third, wholly standalone and unrelated (probe3)");
  check("(probe3 precondition) B's own union carries A as a contributor", !!activeMergeQuarantineFor(B)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(A)));
  check("(probe3 precondition) R has its own, wholly separate active entry", !!activeMergeQuarantineFor(R));

  const rFile = finalPathFor(R);
  check("(probe3 precondition) R's own latch file exists on disk", fs.existsSync(rFile));
  const rBytesBefore = fs.readFileSync(rFile);

  fs.rmSync(path.join(A, ".git"), { recursive: true, force: true }); // A's .git gone — the fresh-key confusion trigger

  const clearResult = clearMergeQuarantine(B);
  check("*** THE FIX (probe3) *** /clear(B) refuses", clearResult.refusedBeforeClear === true && clearResult.liftedRepoPaths.length === 0);
  check("*** THE FIX (probe3) *** R's own latch file is BYTE-IDENTICAL after the refused /clear(B)", Buffer.compare(rBytesBefore, fs.readFileSync(rFile)) === 0);
  check("(probe3) R is still blocked after /clear(B)", assertRepoNotQuarantined(R).ok === false);

  const clearByPathResult = clearMergeQuarantineByRecordedPath(B);
  check("*** THE FIX (probe3) *** clear-by-path(B) ALSO refuses", clearByPathResult.refusedBeforeClear === true && clearByPathResult.liftedRepoPaths.length === 0);
  check("*** THE FIX (probe3) *** R's own latch file is STILL byte-identical after the refused clear-by-path(B)", Buffer.compare(rBytesBefore, fs.readFileSync(rFile)) === 0);
  check("(probe3) R is still blocked after clear-by-path(B)", assertRepoNotQuarantined(R).ok === false);
}

// ═══════════════════════ ROUND 2 (Code Review dede2ffd), isNestedUnderKey consistency ═══════════════════════
// The manager's own review of the Round 2 refinement (not yet CR'd): isNestedUnderKey must stay
// byte/identity-consistent with directPathIdentity on Windows (case, separators, trailing slash), and
// must never be fooled by a sibling merely sharing a textual prefix.

// ===================== (nest-i) byte/identity consistency: a genuine nested pair, via the REAL exported =====================
// ===================== normalization functions end-to-end (never hand-built strings) =====================
{
  const R = freshDir("nest-i-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git
  check("(nest-i) directPathIdentity(R) === canonicalRepoLockKey(R) — the two normalizers agree for R itself", directPathIdentity(R) === canonicalRepoLockKey(R));
  check("*** (nest-i) *** isNestedUnderKey(sub's identity, R's key) is TRUE for a genuine nested pair", isNestedUnderKey(directPathIdentity(sub), canonicalRepoLockKey(R)));
  check("(nest-i) the SAME pair, reversed, is NOT nested (R is not nested under sub)", !isNestedUnderKey(canonicalRepoLockKey(R), directPathIdentity(sub)));
}

// ===================== (nest-sibling) a sibling merely sharing a textual prefix must NEVER read as nested =====================
{
  const R = freshDir("nest-sib-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const sub2 = path.join(R, "sub2"); // shares the literal string prefix "sub" with `sub`, but is NOT nested under it
  fs.mkdirSync(sub2, { recursive: true });
  check("*** (nest-sibling) *** R/sub vs R/sub2: sub2 is NOT nested under sub, despite the shared textual prefix",
    !isNestedUnderKey(directPathIdentity(sub2), directPathIdentity(sub)));
  check("(nest-sibling) the reverse direction is ALSO not nested", !isNestedUnderKey(directPathIdentity(sub), directPathIdentity(sub2)));

  const R2 = path.join(path.dirname(R), `${path.basename(R)}2`); // R2, a sibling of R sharing R's own literal name as a prefix
  fs.mkdirSync(R2, { recursive: true });
  check("*** (nest-sibling) *** R vs R2: R2 is NOT nested under R, despite the shared textual prefix",
    !isNestedUnderKey(directPathIdentity(R2), directPathIdentity(R)));
}

// ===================== (nest-case) Windows case-insensitivity and trailing-slash tolerance, end-to-end =====================
{
  const R = freshDir("nest-case-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true });
  // A differently-cased, differently-slashed SPELLING of the same real locations — directPathIdentity/
  // canonicalRepoLockKey must normalize both to the SAME lowercased, trailing-slash-free string on win32
  // before isNestedUnderKey ever sees them, so nesting is still correctly detected either way.
  const RUpperSpelling = R.toUpperCase();
  const subWithTrailingSep = sub + path.sep;
  check("*** (nest-case) *** an upper-cased spelling of R still normalizes to the SAME key as R itself",
    directPathIdentity(RUpperSpelling) === canonicalRepoLockKey(R));
  check("*** (nest-case) *** a trailing-separator spelling of sub still normalizes to the SAME identity as sub itself",
    directPathIdentity(subWithTrailingSep) === directPathIdentity(sub));
  check("*** (nest-case) *** nesting still holds through differently-spelled (case/trailing-slash) inputs, end-to-end",
    isNestedUnderKey(directPathIdentity(subWithTrailingSep), canonicalRepoLockKey(RUpperSpelling)));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 3 (CR2 CRITICAL-1/2) — the ownership check now compares a FROZEN `identityAtRaise` (stamped
// once, at raise time, via the same alias-resolving primitive every stored key already uses) against
// EVERY key the entry is live-armed at, instead of a live re-walk against one representative key. See
// docs/decisions/3be11be4-self-clear-refuses-stale-key-union-with-contributor.md's Round 3 section.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// Builds the card's own mirror shape, but every path is reached ONLY through a real win32 alias `J` (a
// junction or a directory symlink) pointing at a real, separate physical directory `B`: `R = J\R` (marker
// `.git`), `sub = J\R\sub` (no own `.git`). `linkFn(link, target)` creates the alias and returns `true`/
// `false`; on `false` the caller must skip with a printed reason (not every host can create every alias
// kind — a directory symlink in particular needs SeCreateSymbolicLinkPrivilege).
function buildAliasMirrorFixture(tag, linkFn) {
  const B = freshDir(`${tag}-B`);
  const J = freshDir(`${tag}-J`);
  fs.rmdirSync(J); // the alias call itself must create this path — remove the plain dir freshDir made
  if (!linkFn(J, B)) return null;
  const R = path.join(J, "R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git
  enterMergeQuarantine(sub, "branch-sub", `sub raises first via the alias, collapses onto R's real key (${tag})`);
  enterMergeQuarantine(R, "branch-R", `R raises second via the alias, folds in as contributor (${tag})`);
  return { B, J, R, sub };
}
function checkAliasMirrorPrecondition(tag, R, sub) {
  const entry = activeMergeQuarantineFor(sub);
  check(`(${tag} precondition) the union's own .repoPath is sub`, directPathIdentity(entry?.repoPath) === directPathIdentity(sub));
  check(`(${tag} precondition) R is folded in as a contributor`, !!entry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(R)));
  check(`(${tag} precondition) R is genuinely blocked before any clear`, assertRepoNotQuarantined(R).ok === false);
}
function tryCreateJunction(link, target) {
  try { execFileSync("cmd.exe", ["/c", "mklink", "/J", link, target], { stdio: "pipe" }); return true; }
  catch { return false; }
}
function tryCreateDirSymlink(link, target) {
  try { fs.symlinkSync(target, link, "dir"); return true; }
  catch { return false; }
}

// ===================== (alias-deleted) real junction + sub deleted — CR2 CRITICAL-1's exact repro =====================
if (process.platform !== "win32") {
  console.log("SKIP (alias-deleted) — junctions are a win32-only construct; not running on " + process.platform);
} else {
  const fx = buildAliasMirrorFixture("alias-deleted", tryCreateJunction);
  if (!fx) {
    console.log("SKIP (alias-deleted) — could not create a win32 junction on this host");
  } else {
    const { B, R, sub } = fx;
    checkAliasMirrorPrecondition("alias-deleted", R, sub);
    const realSub = path.join(B, "R", "sub"); // the SAME physical location, reached via the real (non-alias) path
    fs.rmSync(realSub, { recursive: true, force: true });
    check("(alias-deleted precondition) sub no longer exists", !fs.existsSync(realSub));
    const result = clearMergeQuarantineReporting(sub);
    check("*** THE FIX (alias-deleted) *** /clear(sub via the alias) still REFUSES once sub is deleted", result.liftedRepoPaths.length === 0);
    check("*** THE FIX (alias-deleted) *** R is STILL blocked — the alias/deletion bypass is closed", assertRepoNotQuarantined(R).ok === false);
    const resultByPath = clearMergeQuarantineByRecordedPath(sub);
    check("*** THE FIX (alias-deleted, clear-by-path) *** clear-by-path(sub via the alias) ALSO still refuses", resultByPath.liftedRepoPaths.length === 0);
    check("(alias-deleted, clear-by-path) R is STILL blocked", assertRepoNotQuarantined(R).ok === false);
  }
}

// ===================== (alias-junction-removed) the JUNCTION ITSELF is removed after raise =====================
if (process.platform !== "win32") {
  console.log("SKIP (alias-junction-removed) — junctions are a win32-only construct; not running on " + process.platform);
} else {
  const fx = buildAliasMirrorFixture("alias-junction-removed", tryCreateJunction);
  if (!fx) {
    console.log("SKIP (alias-junction-removed) — could not create a win32 junction on this host");
  } else {
    const { J, R, sub } = fx;
    checkAliasMirrorPrecondition("alias-junction-removed", R, sub);
    fs.rmdirSync(J); // remove the LINK itself (a junction removal never touches the real target, B)
    check("(alias-junction-removed precondition) the alias path no longer resolves at all", !fs.existsSync(sub));
    const result = clearMergeQuarantineReporting(sub);
    check("*** THE FIX (alias-junction-removed) *** /clear(sub) still refuses once the alias itself is gone — frozen identityAtRaise needs no live walk", result.liftedRepoPaths.length === 0);
    check("(alias-junction-removed) R is STILL blocked", assertRepoNotQuarantined(R).ok === false);
  }
}

// ===================== (alias-retargeted) the junction is RETARGETED to a wholly different, unrelated dir =====================
if (process.platform !== "win32") {
  console.log("SKIP (alias-retargeted) — junctions are a win32-only construct; not running on " + process.platform);
} else {
  const fx = buildAliasMirrorFixture("alias-retargeted", tryCreateJunction);
  if (!fx) {
    console.log("SKIP (alias-retargeted) — could not create a win32 junction on this host");
  } else {
    const { J, R, sub } = fx;
    checkAliasMirrorPrecondition("alias-retargeted", R, sub);
    const elsewhere = freshDir("alias-retargeted-elsewhere");
    fs.rmdirSync(J);
    const retargeted = tryCreateJunction(J, elsewhere);
    check("(alias-retargeted precondition) the junction now resolves to a DIFFERENT, unrelated directory", retargeted && !fs.existsSync(sub));
    const result = clearMergeQuarantineReporting(sub);
    check("*** THE FIX (alias-retargeted) *** /clear(sub) still refuses once the alias now points elsewhere", result.liftedRepoPaths.length === 0);
    check("(alias-retargeted) R is STILL blocked", assertRepoNotQuarantined(R).ok === false);
  }
}

// ===================== (symlink-deleted) a directory SYMLINK variant, where this host can create one =====================
if (process.platform !== "win32") {
  console.log("SKIP (symlink-deleted) — this variant targets the win32 alias family; not running on " + process.platform);
} else {
  const fx = buildAliasMirrorFixture("symlink-deleted", tryCreateDirSymlink);
  if (!fx) {
    console.log("SKIP (symlink-deleted) — could not create a win32 directory symlink on this host (needs SeCreateSymbolicLinkPrivilege: admin or Developer Mode)");
  } else {
    const { B, R, sub } = fx;
    checkAliasMirrorPrecondition("symlink-deleted", R, sub);
    const realSub = path.join(B, "R", "sub");
    fs.rmSync(realSub, { recursive: true, force: true });
    check("(symlink-deleted precondition) sub no longer exists", !fs.existsSync(realSub));
    const result = clearMergeQuarantineReporting(sub);
    check("*** THE FIX (symlink-deleted) *** /clear(sub via a real symlink) still refuses once sub is deleted", result.liftedRepoPaths.length === 0);
    check("(symlink-deleted) R is STILL blocked", assertRepoNotQuarantined(R).ok === false);
  }
}

// ===================== (reboot-dual-arm) CR2 CRITICAL-2's exact repro: a real reboot leaves the entry =====================
// dual-armed [own fresh key, stale key] — the checked key must never be allowed to be just ONE of them.
{
  const R = freshDir("reboot-dual-arm-R");
  markAsGitRoot(R);
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true }); // no own .git YET
  enterMergeQuarantine(sub, "branch-sub", "sub raises first, collapses onto R's key");
  enterMergeQuarantine(R, "branch-R", "R raises second, folds in as contributor");
  checkMirrorPrecondition("reboot-dual-arm", R, sub);
  markAsGitRoot(sub); // sub NOW gains its own marker .git — its own fresh key diverges from the stale one

  const outFile = path.join(os.tmpdir(), `loom-mq3be11be4-reboot-dual-arm-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, clearMergeQuarantineReporting, assertRepoNotQuarantined, activeMergeQuarantineFor } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    const sub = ${JSON.stringify(sub)};
    reenterMergeQuarantinesAtBoot([R, sub]);
    const armedKeysAfterBoot = activeMergeQuarantineFor(sub)?.armedKeys ?? null;
    const rBlockedBeforeClear = assertRepoNotQuarantined(R).ok === false;
    const result = clearMergeQuarantineReporting(sub);
    const rBlockedAfterClear = assertRepoNotQuarantined(R).ok === false;
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ armedKeysAfterBoot, rBlockedBeforeClear, result, rBlockedAfterClear }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const rebootResult = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });

  check("(reboot-dual-arm) the entry came back dual-armed (more than one live-armed key)", Array.isArray(rebootResult.armedKeysAfterBoot) && rebootResult.armedKeysAfterBoot.length >= 2);
  check("(reboot-dual-arm) R is genuinely blocked before the post-reboot clear", rebootResult.rBlockedBeforeClear === true);
  check("*** THE FIX (reboot-dual-arm) *** /clear(sub) still refuses after a real reboot leaves the entry dual-armed", rebootResult.result.liftedRepoPaths.length === 0);
  check("*** THE FIX (reboot-dual-arm) *** R is STILL blocked after the reboot", rebootResult.rBlockedAfterClear === true);
}

// ===================== (legacy-entry) a genuinely LEGACY entry (no identityAtRaise on disk) fails CLOSED =====================
// and its own remediation route (clear each contributor first, then the primary) actually works end-to-end.
{
  const R = freshDir("legacy-entry-R");
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true });
  markAsGitRoot(R);
  const key = canonicalRepoLockKey(sub); // R's own real key (sub collapses onto it)
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const subFile = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);
  // A hand-written latch, deliberately carrying NO `identityAtRaise` — simulating a latch written by a
  // daemon build that predates this card. No `contributorRepoPaths` yet — R hasn't raised.
  fs.writeFileSync(subFile, JSON.stringify({
    repoPath: sub, branch: "legacy-sub-branch", reason: "a pre-upgrade latch with no identityAtRaise",
    enteredAt: Date.now() - 60_000, tokens: ["legacy-sub-token"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([sub, R]);
  // R raises for REAL, hitting sub's boot-loaded entry's `existing` branch — R becomes a genuine
  // contributor with its own real, currently-matchable identity, exactly like (sequence-r-owns)'s own
  // fixture, except the UNION's own `identityAtRaise` stays whatever sub's legacy, boot-loaded value was
  // (undefined) — the `existing` branch's `{...existing, ...}` spread never recomputes it.
  enterMergeQuarantine(R, "r-branch", "R raises second, folds into the legacy boot-loaded entry");
  check("(legacy-entry precondition) no identityAtRaise is recorded on disk", JSON.parse(fs.readFileSync(subFile, "utf8")).identityAtRaise === undefined);
  check("(legacy-entry precondition) R is folded in as a contributor", !!activeMergeQuarantineFor(sub)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(R)));
  check("(legacy-entry precondition) sub is genuinely blocked before any clear", assertRepoNotQuarantined(sub).ok === false);

  const result = clearMergeQuarantineReporting(sub);
  check("*** THE FIX (legacy-entry) *** a LEGACY entry (no identityAtRaise) fails CLOSED — /clear(sub) refuses even though sub genuinely owns this key", result.liftedRepoPaths.length === 0);
  check("(legacy-entry) sub is STILL blocked", assertRepoNotQuarantined(sub).ok === false);

  // The remediation route: clear the CONTRIBUTOR (R) first via its own project-resolved route — this must
  // actually release the whole union end-to-end, not just be named in the refusal text.
  const contributorClear = clearMergeQuarantineReporting(R);
  check("*** THE FIX (legacy-entry remediation) *** step 1 (clear contributor R) fully releases the whole entry", contributorClear.liftedRepoPaths.length > 0 || assertRepoNotQuarantined(R).ok === true);
  check("(legacy-entry remediation) R released after step 1", assertRepoNotQuarantined(R).ok === true);
  check("*** THE FIX (legacy-entry remediation) *** sub ALSO released after step 1 (same union)", assertRepoNotQuarantined(sub).ok === true);
  // Step 2: clear the primary — named by the text as what releases "whatever still remains"; here, nothing does.
  const primaryClear = clearMergeQuarantineByRecordedPath(sub);
  check("(legacy-entry remediation) step 2 (clear-by-path sub) is a harmless no-op — nothing remained", primaryClear.wasQuarantined === false);
}

// ===================== (persistence-round-trip) raise -> reboot -> identityAtRaise survives on disk =====================
{
  const R = freshDir("persist-rt-R");
  markAsGitRoot(R);
  enterMergeQuarantine(R, "persist-rt-branch", "a genuine, resolvable raise");
  const beforeKey = canonicalRepoLockKey(R);
  const beforeFile = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(beforeKey).digest("hex").slice(0, 24)}.json`);
  const beforeOnDisk = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
  check("(persistence-round-trip precondition) identityAtRaise is written to disk at raise time", typeof beforeOnDisk.identityAtRaise === "string" && beforeOnDisk.identityAtRaise.length > 0);

  const outFile = path.join(os.tmpdir(), `loom-mq3be11be4-persist-rt-out-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const R = ${JSON.stringify(R)};
    reenterMergeQuarantinesAtBoot([R]);
    const entry = activeMergeQuarantineFor(R);
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ identityAtRaise: entry?.identityAtRaise ?? null }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } });
  const rebootResult = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  check("*** THE FIX (persistence-round-trip) *** identityAtRaise is STILL present after a real reboot", typeof rebootResult.identityAtRaise === "string" && rebootResult.identityAtRaise.length > 0);
  check("(persistence-round-trip) the round-tripped identityAtRaise matches the pre-reboot value", rebootResult.identityAtRaise === beforeOnDisk.identityAtRaise);
}

// ===================== (verified-divert-not-legacy) MINOR-1: a VERIFIED brand-new raise that must =====================
// divert (its own key's final is a confirmed foreign, persistently-unreadable occupant) still stamps
// identityAtRaise — never leaving a genuinely NEW raise looking LEGACY — and the stamp survives lazy
// graduation into an active entry. Mirrors merge-quarantine-raise-protect-failure.mjs's own SHAPE 1.
function injectPersistentReadFailureOnce(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; } };
}
{
  const r = freshDir("verified-divert-r");
  markAsGitRoot(r);
  const krHash = createHash("sha256").update(canonicalRepoLockKey(r)).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir"); // a foreign, never-created occupant walking up to r's own key
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${krHash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to r's own real key",
    enteredAt: Date.now(), tokens: ["d-token-verified-divert"],
  }, null, 2) + "\n");
  // No `reenterMergeQuarantinesAtBoot` needed here — nothing is armed into `activeQuarantines` yet, so r's
  // own raise below reaches `enterMergeQuarantine`'s "no existing" region directly.
  const inject = injectPersistentReadFailureOnce(finalPath);
  let rToken;
  try {
    rToken = enterMergeQuarantine(r, "r-branch", "r raises over D's own key, D's final unreadable throughout");
  } finally {
    inject.restore();
  }
  check("(verified-divert-not-legacy precondition) r's own raise persisted IN-PROCESS (diverted, not lost)", listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []).includes(rToken));
  const divertedEntry = listActiveMergeQuarantines().find((q) => (q.tokens ?? []).includes(rToken));
  check("*** THE FIX (verified-divert-not-legacy) *** the diverted entry carries identityAtRaise (a genuinely new raise, never LEGACY)", typeof divertedEntry?.identityAtRaise === "string" && divertedEntry.identityAtRaise.length > 0);

  // Graduate: once D's own read genuinely succeeds again, a direct query for r's own identity absorbs it.
  const graduated = activeMergeQuarantineFor(r);
  check("(verified-divert-not-legacy) r genuinely graduated into an active entry", !!graduated && (graduated.tokens ?? []).includes(rToken));
  check("*** THE FIX (verified-divert-not-legacy, graduation) *** identityAtRaise survives lazy graduation — still NOT legacy", typeof graduated?.identityAtRaise === "string" && graduated.identityAtRaise.length > 0);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
