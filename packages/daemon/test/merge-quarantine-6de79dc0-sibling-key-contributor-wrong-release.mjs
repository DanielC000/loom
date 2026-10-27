import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6de79dc0 — a key-owning primary's self-clear must not lift a SIBLING repo's genuine
// quarantine folded in as a contributor via a stale secondary key. See the decision record in full.
//
// From card 3be11be4's own CR3 (reviewer cb267228), a pre-existing WRONG RELEASE out of that card's
// scope: S genuinely owns its own key Ks (no ancestor-collapse at all — unlike 3be11be4's own mirror
// shape, where the union's `.repoPath` is a bare subdirectory with no `.git` of its own). S is ALSO
// dual-armed at a SECOND, wholly unrelated key Kr via a legacy stale `resolvedKey` field. R is a REAL,
// independent sibling repo whose OWN genuine canonical key IS Kr. When R raises for real, it hits
// `enterMergeQuarantine`'s `existing` branch and is folded into S's union as a mere `contributorRepoPaths`
// member. `/clear(s)` then lifts every key S is live-armed at, INCLUDING Kr — destroying R's own,
// genuinely separate, outstanding quarantine, even though `selfClearRefusesForStaleKeyContributors`
// (3be11be4) does not fire: S's own `identityAtRaise` is NOT nested under Kr (Ks and Kr are unrelated
// siblings, never an ancestor/descendant pair) — `isNestedUnderKey` correctly returns false for this shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq6de79dc0-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, clearMergeQuarantine, clearMergeQuarantineReporting,
  clearMergeQuarantineByRecordedPath, clearMergeQuarantineLatchFile, assertRepoNotQuarantined,
  directPathIdentity, MERGE_QUARANTINE_DIR, reenterMergeQuarantinesAtBoot, quarantineLatchIdFor,
  pushPendingQuarantineTestOnly, PLACEHOLDER_BRANCH_UNREADABLE, setActiveQuarantineTestOnly,
  alsoReleasedRepoPaths, alsoReleasedWarningFor,
} = await import(mergeQuarantineModuleUrl);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq6de79dc0@loom -c user.name=mq6de79dc0";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
function freshRepo(tag) {
  n++;
  const d = path.join(os.tmpdir(), `loom-mq6de79dc0-${tag}-${sfx}-${n}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq6de79dc0@loom && git config user.name mq6de79dc0`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  return d;
}
function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Builds the card's own shape: S raises for real (genuine identityAtRaise, genuine own key Ks), then its
// OWN on-disk latch is hand-edited to ALSO carry a stale `resolvedKey: Kr` (the legacy dual-arm shape PASS
// 1's own happy-path recognizes — Kr is a SECOND real repo's own genuine key, never a degraded/never-
// exists path, which is what distinguishes this from the `buildDualArmFixture` family in
// merge-quarantine-runtime-union-provenance.mjs). A reboot re-establishes S dual-armed [Ks, Kr] in memory
// with `identityAtRaise` carried forward. R then raises for REAL, genuinely, hitting `enterMergeQuarantine`'s
// `existing` branch at Kr and folding in as S's contributor.
function buildSiblingKeyFixture(tag) {
  const s = freshRepo(`${tag}-s`);
  const r = freshRepo(`${tag}-r`);
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error(`${tag}: ks collided with kr — re-run`);

  enterMergeQuarantine(s, "s-branch", `s raises first, genuinely owns its own key (${tag})`);
  const sFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`);
  const onDisk = JSON.parse(fs.readFileSync(sFile, "utf8"));
  if (onDisk.repoPath !== s) throw new Error(`${tag}: s's own latch file did not land at hash(ks) — fixture assumption broken`);
  // Hand-edit S's own durable latch to ALSO carry a stale secondary key pointing at R's own real key —
  // simulating the artifact some other process/bug left behind (never produced by current code reading
  // this file alone; the point of this fixture is the STATE, not how it got there).
  fs.writeFileSync(sFile, JSON.stringify({ ...onDisk, resolvedKey: kr }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  enterMergeQuarantine(r, "r-branch", `r raises second, genuinely, at its own real key (${tag})`);
  return { s, r, ks, kr };
}

function checkPrecondition(tag, s, r) {
  const sEntry = activeMergeQuarantineFor(s);
  check(`(${tag} precondition) S is dual-armed [Ks, Kr]`, (() => {
    const keys = new Set(sEntry?.armedKeys ?? []);
    return keys.has(canonicalRepoLockKey(s)) && keys.has(canonicalRepoLockKey(r));
  })());
  check(`(${tag} precondition) the union's own .repoPath is S (S genuinely owns its own key, no naming race)`, sEntry?.repoPath === s);
  check(`(${tag} precondition) R is folded in as a contributor`, !!sEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check(`(${tag} precondition) R is genuinely blocked before any clear`, assertRepoNotQuarantined(r).ok === false);
  check(`(${tag} precondition) S is genuinely blocked before any clear`, assertRepoNotQuarantined(s).ok === false);
}

// ===================== (bug) /clear(s) must NOT lift R's own genuine quarantine =====================
{
  const { s, r } = buildSiblingKeyFixture("bug");
  checkPrecondition("bug", s, r);

  const result = clearMergeQuarantineReporting(s);
  console.log(`(bug) clearMergeQuarantineReporting(s) -> ${JSON.stringify(result)}`);
  check("*** THE BUG (pre-fix) / THE FIX (post-fix) *** R is STILL blocked after /clear(s)", assertRepoNotQuarantined(r).ok === false);
  check("(bug) S is reported as having something happen (not a silent no-op)", result.wasQuarantined === true);
  // @decision 6de79dc0 (CR round 2, MAJOR) — the refusal's named route (clear r first) ALSO releases S's
  // own quarantine, unannounced pre-fix — the text must say so explicitly, mirroring the clear-by-path
  // branch's own confirm-no-process clause (see `(explore-clear-r)` below for the real action proof).
  check("*** THE FIX (MAJOR) *** the refusal text names that clearing a contributor ALSO releases S's own quarantine", result.reason?.includes("can ALSO release") && result.reason?.includes(s));
  check("*** THE FIX (MAJOR) *** the refusal text tells the human to confirm no process under S too", result.reason?.includes(`confirm no process is still running under ${JSON.stringify([s])} too`));
}

// ===================== (bug-clearbypath) clear-by-path(s) must NOT lift R's own genuine quarantine =====================
{
  const { s, r } = buildSiblingKeyFixture("bug-clearbypath");
  checkPrecondition("bug-clearbypath", s, r);

  const result = clearMergeQuarantineByRecordedPath(s);
  console.log(`(bug-clearbypath) clearMergeQuarantineByRecordedPath(s) -> ${JSON.stringify(result)}`);
  check("*** THE BUG (pre-fix) / THE FIX (post-fix) *** R is STILL blocked after clear-by-path(s)", assertRepoNotQuarantined(r).ok === false);
}

// ===================== (explore-clear-r) what does /clear(r) — the genuine contributor's OWN clear — =====================
// ===================== do here? Verified empirically, never assumed (manager's own instruction) =====================
// @decision 6de79dc0 (CR round 2, MAJOR) — turned into a REAL assertion test: the refusal text above
// names this as the route that releases everything, so prove it actually does — [r, s] both lifted.
{
  const { s, r } = buildSiblingKeyFixture("explore-clear-r");
  checkPrecondition("explore-clear-r", s, r);

  const result = clearMergeQuarantineReporting(r);
  console.log(`(explore-clear-r) clearMergeQuarantineReporting(r) -> ${JSON.stringify(result)}`);
  const liftedIdentities = new Set(result.liftedRepoPaths.map((rp) => directPathIdentity(rp)));
  check("*** VERIFIED, NOT ASSUMED (explore-clear-r) *** /clear(r) lifts r", liftedIdentities.has(directPathIdentity(r)));
  check("*** VERIFIED, NOT ASSUMED (explore-clear-r) *** /clear(r) ALSO lifts s (the whole union, exactly as the refusal text above now discloses)", liftedIdentities.has(directPathIdentity(s)));
  check("(explore-clear-r) r reads clear afterward", assertRepoNotQuarantined(r).ok === true);
  check("(explore-clear-r) s reads clear afterward too", assertRepoNotQuarantined(s).ok === true);

  // @decision 1872935d (card 1872935d, the Lead's A+D ruling) — A keeps this release exactly as above;
  // D is this post-hoc disclosure: the identity swept up BEYOND the one addressed (r) must be named.
  const alsoReleased = alsoReleasedRepoPaths(result.liftedRepoPaths, [r]);
  const alsoReleasedWarning = alsoReleasedWarningFor(alsoReleased);
  check("*** THE FIX (card 1872935d, option D) *** alsoReleasedRepoPaths names exactly s, never r itself", alsoReleased.length === 1 && directPathIdentity(alsoReleased[0]) === directPathIdentity(s));
  check("*** THE FIX *** alsoReleasedWarning is a string naming s and the confirm-no-process wording", typeof alsoReleasedWarning === "string" && alsoReleasedWarning.includes(s) && alsoReleasedWarning.toLowerCase().includes("confirm no process"));
  check("(explore-clear-r) the warning is explicitly POST-HOC, never a pre-action prompt", alsoReleasedWarning.toLowerCase().includes("already happened"));
}

// ===================== (owner) non-regression — S clearing itself with NO sibling-key contributor still =====================
// ===================== fully releases, byte-identical to before this card =====================
{
  const s = freshRepo("owner-s");
  const ySub = path.join(s, "subdir");
  fs.mkdirSync(ySub, { recursive: true }); // NO own .git — absorbed as a same-key contributor
  enterMergeQuarantine(s, "s-branch", "s raises first, owns its own real key (owner, non-regression)");
  enterMergeQuarantine(ySub, "y-branch", "ySub raises second, absorbed as a SAME-KEY contributor (owner)");
  const entry = activeMergeQuarantineFor(s);
  check("(owner precondition) the union's own .repoPath is s", entry?.repoPath === s);
  check("(owner precondition) ySub is folded in as a contributor", !!entry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(ySub)));
  check("(owner precondition) s is blocked", assertRepoNotQuarantined(s).ok === false);

  const result = clearMergeQuarantineReporting(s);
  check("(owner, non-regression) /clear(s) with no sibling-key contributor still fully releases", result.liftedRepoPaths.length > 0);
  check("(owner, non-regression) s reads clear afterward", assertRepoNotQuarantined(s).ok === true);
  check("(owner, non-regression) ySub reads clear afterward too", assertRepoNotQuarantined(ySub).ok === true);

  // @decision 1872935d — negative control for the disclosure added by option D: an ordinary same-key
  // bare-subdirectory contributor (ySub) is PART OF what `/clear(s)` addresses (clear-by-path with s's
  // own path is understood to cover its own same-key union), so nothing is "also released" here.
  const alsoReleased = alsoReleasedRepoPaths(result.liftedRepoPaths, [s]);
  check("*** NEGATIVE CONTROL (owner) *** alsoReleasedRepoPaths is empty for an ordinary same-key self-clear", alsoReleased.length === 0);
  check("*** NEGATIVE CONTROL (owner) *** alsoReleasedWarningFor returns undefined for an empty input", alsoReleasedWarningFor(alsoReleased) === undefined);
}

// A real `.git` repo created INSIDE an already-existing directory (never its own top-level tmp dir) — for
// the (nested-inner)/(enclosing) fixtures below, where one genuinely separate repo's own directory must
// physically sit inside the other's.
function nestedRepo(parentDir, subdirName, tag) {
  const d = path.join(parentDir, subdirName);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq6de79dc0@loom && git config user.name mq6de79dc0`, { cwd: d });
  commitAll(d, "init", GIT_ID);
  return d;
}

// ===================== (nested-inner) CR round 2, MAJOR — a genuinely separate repo NESTED INSIDE the =====================
// ===================== addressed one must still be reported, never hidden by mere path nesting =====================
// @decision 1872935d (CR round 2) — Round 1's `isNestedUnderKey`-based exclusion hid this: `other` here is
// textually inside `addr`'s own directory, but genuinely owns its OWN key (its own `.git`) — the physical
// nesting is irrelevant; only `canonicalRepoLockKey` equality may exclude it, and here the keys differ.
{
  const addr = freshRepo("nested-inner-addr"); // raises SECOND, the contributor — this is what we clear
  const other = nestedRepo(addr, "nested-other-repo", "nested-inner-other"); // raises FIRST, the union owner; lives INSIDE addr's own directory
  const kAddr = canonicalRepoLockKey(addr);
  const kOther = canonicalRepoLockKey(other);
  if (kAddr === kOther) throw new Error("(nested-inner): kAddr collided with kOther — re-run");

  enterMergeQuarantine(other, "other-branch", "1872935d (nested-inner): other raises first, genuinely owns its own key, nested inside addr's own directory");
  const otherFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kOther)}.json`);
  const otherOnDisk = JSON.parse(fs.readFileSync(otherFile, "utf8"));
  fs.writeFileSync(otherFile, JSON.stringify({ ...otherOnDisk, resolvedKey: kAddr }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  enterMergeQuarantine(addr, "addr-branch", "1872935d (nested-inner): addr raises second, genuinely, at its own real key");

  const otherEntry = activeMergeQuarantineFor(other);
  check("(nested-inner precondition) other is dual-armed [Kother, Kaddr]", (() => {
    const keys = new Set(otherEntry?.armedKeys ?? []);
    return keys.has(kOther) && keys.has(kAddr);
  })());
  check("(nested-inner precondition) addr is folded in as a contributor", !!otherEntry?.contributorRepoPaths?.includes(addr));

  const result = clearMergeQuarantineReporting(addr);
  check("(nested-inner) addr is lifted", result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(addr)));
  check("(nested-inner) other is ALSO lifted (pre-existing, accepted release-everything design)", result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(other)));
  const alsoReleased = alsoReleasedRepoPaths(result.liftedRepoPaths, [addr]);
  check("*** THE FIX (CR round 2, MAJOR) *** a genuinely separate repo NESTED INSIDE the addressed one IS reported, never hidden by nesting", alsoReleased.length === 1 && directPathIdentity(alsoReleased[0]) === directPathIdentity(other));
}

// ===================== (enclosing) CR round 2, MAJOR — a genuinely separate repo that ENCLOSES the =====================
// ===================== addressed one must also be reported, never hidden by mere path nesting =====================
// The mirror direction of (nested-inner): here `other` is the ANCESTOR, `addr` lives inside `other`'s own
// directory. Round 1's bidirectional nesting check hid this shape too (checked both directions).
{
  const other = freshRepo("enclosing-other"); // raises FIRST, the union owner — ENCLOSES addr's own directory
  const addr = nestedRepo(other, "enclosed-addr-repo", "enclosing-addr"); // raises SECOND, the contributor — this is what we clear
  const kOther = canonicalRepoLockKey(other);
  const kAddr = canonicalRepoLockKey(addr);
  if (kAddr === kOther) throw new Error("(enclosing): kAddr collided with kOther — re-run");

  enterMergeQuarantine(other, "other-branch", "1872935d (enclosing): other raises first, genuinely owns its own key, encloses addr's own directory");
  const otherFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kOther)}.json`);
  const otherOnDisk = JSON.parse(fs.readFileSync(otherFile, "utf8"));
  fs.writeFileSync(otherFile, JSON.stringify({ ...otherOnDisk, resolvedKey: kAddr }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  enterMergeQuarantine(addr, "addr-branch", "1872935d (enclosing): addr raises second, genuinely, at its own real key");

  const otherEntry = activeMergeQuarantineFor(other);
  check("(enclosing precondition) other is dual-armed [Kother, Kaddr]", (() => {
    const keys = new Set(otherEntry?.armedKeys ?? []);
    return keys.has(kOther) && keys.has(kAddr);
  })());
  check("(enclosing precondition) addr is folded in as a contributor", !!otherEntry?.contributorRepoPaths?.includes(addr));

  const result = clearMergeQuarantineReporting(addr);
  check("(enclosing) addr is lifted", result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(addr)));
  check("(enclosing) other is ALSO lifted (pre-existing, accepted release-everything design)", result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(other)));
  const alsoReleased = alsoReleasedRepoPaths(result.liftedRepoPaths, [addr]);
  check("*** THE FIX (CR round 2, MAJOR) *** a genuinely separate repo that ENCLOSES the addressed one IS reported, never hidden by nesting", alsoReleased.length === 1 && directPathIdentity(alsoReleased[0]) === directPathIdentity(other));
}

// ===================== (id-multi-claimant) CR round 2, MINOR — clear-by-id's own disclosure for the =====================
// ===================== 882d6cff multi-claimant PENDING shape: two genuinely different-keyed repos sharing =====================
// ===================== one crafted latch id must name the one NOT addressed, never nothing =====================
// @decision 1872935d (CR round 2, MINOR) — gateway/server.ts's {id} route used to pass `liftedRepoPaths`
// against itself (always dead); fixed to source "addressed" from the function's own new
// `addressedRepoPaths` field. See the decision record's "Round 2" section for the full mechanism.
{
  const addr = freshRepo("id-multi-addr");
  const other = freshRepo("id-multi-other");
  if (canonicalRepoLockKey(addr) === canonicalRepoLockKey(other)) throw new Error("(id-multi-claimant): keys collided — re-run");
  const sharedSourceFile = "pending-aaaaaaaaaaaaaaaaaaaaaaaa.json"; // PENDING_DIVERT_RE-shaped
  pushPendingQuarantineTestOnly({
    repoPath: addr, branch: "addr-branch", reason: "1872935d (id-multi-claimant): addr", enteredAt: Date.now(), tokens: ["addr-token"],
  }, sharedSourceFile);
  pushPendingQuarantineTestOnly({
    repoPath: other, branch: "other-branch", reason: "1872935d (id-multi-claimant): other", enteredAt: Date.now() - 1000, tokens: ["other-token"],
  }, sharedSourceFile);
  const sharedId = createHash("sha256").update(sharedSourceFile).digest("hex").slice(0, 24);

  const result = clearMergeQuarantineLatchFile(sharedId);
  check("(id-multi-claimant) clear-by-id succeeds (ok:true) — no ambiguity refusal for this shape", result.ok === true);
  if (result.ok) {
    check("(id-multi-claimant) BOTH genuinely different-keyed identities are lifted (882d6cff's own shape)", result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(addr)) && result.liftedRepoPaths.some((rp) => directPathIdentity(rp) === directPathIdentity(other)));
    const alsoReleased = alsoReleasedRepoPaths(result.liftedRepoPaths, result.addressedRepoPaths ?? []);
    check("*** THE FIX (CR round 2, MINOR) *** the clear-by-id disclosure names the OTHER, genuinely different-keyed identity — never dead", alsoReleased.length === 1);
  }
}

// ===================== (key-throws-unit) Lead review after CR round 2 — a failed ADDRESSED key walk must =====================
// ===================== never let the addressed path report ITSELF as "also released" =====================
// @decision 1872935d (Lead review after CR round 2) — pure unit test: `canonicalRepoLockKey` cannot be
// made to throw with any cheap real input (verified empirically), so `keyFn` is driven directly as the
// test seam it exists for. See the decision record's "Round 2"/Lead-review addendum for the full bug.
{
  const addressedPath = "C:\\fake\\addressed-repo";
  const otherPath = "C:\\fake\\genuinely-other-repo";
  const throwingKeyFn = (p) => {
    if (p === addressedPath) throw new Error("(key-throws-unit) simulated key-walk failure for the addressed path");
    return p; // otherPath's own "key" — anything that differs from a thrown/undefined value
  };
  const alsoReleased = alsoReleasedRepoPaths([addressedPath, otherPath], [addressedPath], throwingKeyFn);
  check("*** THE FIX (Lead review) *** the addressed path is NOT reported even though its own key walk throws", !alsoReleased.includes(addressedPath));
  check("*** THE FIX (Lead review) *** a genuinely different lifted path IS still reported despite the addressed-side failure", alsoReleased.includes(otherPath));
  check("(key-throws-unit) exactly one entry reported", alsoReleased.length === 1);
}

// ===================== (pre-fix-field-less) a union formed BEFORE this card's own fix shipped — =====================
// ===================== `identityAtRaise` is stamped (not fully legacy) but `genuineContributorKeys` =====================
// ===================== was never computed for it — must fail CLOSED BROADLY, never narrowly =====================
{
  const s = freshRepo("pre-fix-field-less-s");
  const r = freshRepo("pre-fix-field-less-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("pre-fix-field-less: ks collided with kr — re-run");

  // Hand-write S's own latch directly, simulating a union that was ALREADY formed and persisted to disk
  // by a daemon running 3be11be4-era code (so `identityAtRaise` is genuinely stamped) BEFORE this card's
  // own fix ever shipped (so `contributorRepoPaths`/`resolvedKey` are already baked in from that prior
  // fold, but `genuineContributorKeys` was never computed and is absent — never an empty array).
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`);
  fs.writeFileSync(sFile, JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "pre-existing union, formed before card 6de79dc0's own fix",
    enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const sEntry = activeMergeQuarantineFor(s);
  check("(pre-fix-field-less precondition) S is dual-armed [Ks, Kr]", (() => {
    const keys = new Set(sEntry?.armedKeys ?? []);
    return keys.has(ks) && keys.has(kr);
  })());
  check("(pre-fix-field-less precondition) identityAtRaise survived the carry-forward (not fully legacy)", sEntry?.identityAtRaise === ks);
  check("(pre-fix-field-less precondition) genuineContributorKeys is genuinely ABSENT (never an empty array)", sEntry?.genuineContributorKeys === undefined);
  check("(pre-fix-field-less precondition) R is folded in as a contributor", !!sEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check("(pre-fix-field-less precondition) R is genuinely blocked before any clear", assertRepoNotQuarantined(r).ok === false);

  const result = clearMergeQuarantineReporting(s);
  console.log(`(pre-fix-field-less) clearMergeQuarantineReporting(s) -> ${JSON.stringify(result)}`);
  check("*** THE BROAD LEGACY FALLBACK *** a field-less (pre-fix) union fails CLOSED too — R stays blocked", assertRepoNotQuarantined(r).ok === false);
  check("(pre-fix-field-less) nothing was lifted", result.liftedRepoPaths.length === 0);
  // @decision 6de79dc0 (CR round 2, MINOR-1) — the broad-fallback refusal must say "Loom cannot tell",
  // never claim a verified fact it has no per-key record to support.
  check("*** THE FIX (MINOR-1) *** the broad-fallback text says Loom cannot tell, never claims a verified genuine-contributor fact", result.reason?.includes("Loom cannot tell whether that separate key is a genuinely different repo's own raise or merely a stale artifact"));
  check("(pre-fix-field-less) the text does NOT make the precise (post-fix) claim it has no data for", !result.reason?.includes("that a genuinely different, independently-raised repo owns"));
}

// ===================== (critical1-divert) CRITICAL-1 (CR round 2) — divertRaiseEntry must union =====================
// ===================== genuineContributorKeys across EVERY matched input, never `base.entry` alone =====================
// Mirrors the reviewer's own probeG: S stale-armed [Ks, Kr] (legacy resolvedKey shape); S itself raises
// once while transiently unresolvable, minting a PENDING twin with its own precise `[]`; R then raises
// genuinely while Kr's own final is transiently unreadable (icacls deny), so `enterMergeQuarantine`'s
// `existing` branch must divert — `divertRaiseEntry` then merges the pending twin (gck=[]) with the
// existing-branch's own fresh baseEntry (gck=["r"], stamped by THIS card's own origin site). Pre-fix,
// `divertRaiseEntry`'s bare `...base.entry` spread took only the OLDEST matched twin's own `[]`, silently
// dropping "r" and reopening the exact wrong release this whole card exists to close.
{
  const s = freshRepo("critical1-divert-s");
  const r = freshRepo("critical1-divert-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("critical1-divert: ks collided with kr — re-run");

  enterMergeQuarantine(s, "s-branch", "critical1-divert s raise");
  const sFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`);
  const onDisk = JSON.parse(fs.readFileSync(sFile, "utf8"));
  fs.writeFileSync(sFile, JSON.stringify({ ...onDisk, resolvedKey: kr }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // S transiently unresolvable -> its re-raise goes PENDING as a distinct object (a precise gck=[] twin).
  fs.renameSync(s, `${s}-away`);
  enterMergeQuarantine(s, "s-branch-2", "critical1-divert s raise while unresolvable");
  fs.renameSync(`${s}-away`, s);

  // R raises genuinely while Kr's own final is transiently unreadable -> enterMergeQuarantine's existing
  // branch must divert (mustDivert), calling divertRaiseEntry to merge the pending S twin with R's fold.
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kr)}.json`);
  fs.writeFileSync(rFile, fs.readFileSync(sFile, "utf8"));
  execSync(`icacls "${rFile}" /deny "${process.env.USERNAME}:(R)"`, { stdio: "ignore" });
  enterMergeQuarantine(r, "r-branch", "critical1-divert r genuine raise");
  execSync(`icacls "${rFile}" /remove:d "${process.env.USERNAME}"`, { stdio: "ignore" });

  check("(critical1-divert precondition) R is folded in as a contributor", !!activeMergeQuarantineFor(s)?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check("(critical1-divert precondition) R is genuinely blocked before any clear", assertRepoNotQuarantined(r).ok === false);

  const result = clearMergeQuarantineReporting(s);
  console.log(`(critical1-divert) clearMergeQuarantineReporting(s) -> ${JSON.stringify(result)}`);
  check("*** THE FIX (CRITICAL-1, divertRaiseEntry) *** R is STILL blocked — the merge did not drop r's own genuine key", assertRepoNotQuarantined(r).ok === false);
  check("(critical1-divert) nothing was lifted", result.liftedRepoPaths.length === 0);
}

// ===================== (critical1-mergetoken) CRITICAL-1 (CR round 2) — mergeTokenIntoPendingEntries =====================
// ===================== must ALSO union genuineContributorKeys across EVERY matched twin =====================
// Two pending twins for the SAME identity s: the OLDER (base, by enteredAt) carries a precise, EMPTY
// gck=[]; the NEWER carries a precise, non-empty gck=["r"] (as if an earlier divertRaiseEntry fold had
// already recorded r as genuine). A fresh re-raise of s while still unresolvable matches BOTH via
// collectPendingIndices and merges them through mergeTokenIntoPendingEntries — pre-fix, the bare
// `...base.entry` spread there took only the OLDER twin's own `[]`, dropping "r" just like CRITICAL-1's
// sibling site.
{
  const s = freshRepo("critical1-mergetoken-s");
  const r = freshRepo("critical1-mergetoken-r"); // never raised for real here — only its PATH is recorded
  fs.renameSync(s, `${s}-away`); // s itself must be unresolvable for every step below
  const olderEntry = {
    repoPath: s, branch: "older", reason: "older pending twin, precise empty gck",
    enteredAt: Date.now() - 60_000, tokens: ["older-token"], genuineContributorKeys: [],
  };
  const newerEntry = {
    repoPath: s, branch: "newer", reason: "newer pending twin, precise non-empty gck",
    enteredAt: Date.now() - 30_000, tokens: ["newer-token"], contributorRepoPaths: [r], genuineContributorKeys: [r],
  };
  pushPendingQuarantineTestOnly(olderEntry, "pending-critical1-mergetoken-older.json");
  pushPendingQuarantineTestOnly(newerEntry, "pending-critical1-mergetoken-newer.json");

  enterMergeQuarantine(s, "s-branch-3", "critical1-mergetoken s re-raise while still unresolvable");
  fs.renameSync(`${s}-away`, s); // restore for the later assertRepoNotQuarantined/clear calls below

  // No precondition check in between: activeMergeQuarantineFor/assertRepoNotQuarantined can themselves
  // trigger lazy graduation as a side effect of merely being queried, so "still pending" is not something
  // this file can observe without disturbing the very state it's trying to observe (82032b5c/2a169469's
  // own documented hazard) — go straight to the explicit graduation raise below and assert its result.
  enterMergeQuarantine(s, "s-branch-4", "critical1-mergetoken graduation raise");
  const sEntry = activeMergeQuarantineFor(s);
  check("(critical1-mergetoken) the graduated entry carries r as a contributor (the merge itself happened)", !!sEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check("*** THE FIX (CRITICAL-1, mergeTokenIntoPendingEntries) *** the merged/graduated entry's own genuineContributorKeys includes r (not silently dropped to the older twin's own empty array)", !!sEntry?.genuineContributorKeys?.some((k) => directPathIdentity(k) === directPathIdentity(r)));
}

// ===================== (critical2-boot-graduation) CRITICAL-2 (CR round 2) — a LEGACY active union =====================
// ===================== (gck=undefined) re-raising while transiently unresolvable must stay undefined =====================
// ===================== through graduation, never silently promoted to a precise `[]`/populated array =====================
// Mirrors the reviewer's own probeH: a pre-6de79dc0 on-disk union (identityAtRaise stamped, NO gck field
// at all, contributorRepoPaths:[r] already baked in from before this card's own fix existed). S then
// raises again while transiently unresolvable — graduation must never turn `undefined` into `[]`.
{
  const s = freshRepo("critical2-boot-graduation-s");
  const r = freshRepo("critical2-boot-graduation-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("critical2-boot-graduation: ks collided with kr — re-run");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "critical2-boot-graduation pre-6de79dc0 union",
    enteredAt: Date.now() - 60_000, tokens: ["s-token", "r-token"],
    resolvedKey: kr, identityAtRaise: ks, contributorRepoPaths: [r], provenanceTracked: true,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(critical2-boot-graduation precondition) gck is genuinely absent at boot", activeMergeQuarantineFor(s)?.genuineContributorKeys === undefined);

  fs.renameSync(s, `${s}-away`);
  enterMergeQuarantine(s, "s-branch-2", "critical2-boot-graduation s raise while unresolvable");
  fs.renameSync(`${s}-away`, s);
  const afterGraduation = activeMergeQuarantineFor(s);
  check("*** THE FIX (CRITICAL-2, absorbing union) *** gck is STILL genuinely absent after graduation — never promoted to a precise empty/partial array", afterGraduation?.genuineContributorKeys === undefined);

  const result = clearMergeQuarantineReporting(s);
  check("*** THE FIX (CRITICAL-2) *** the broad legacy fallback still refuses — R stays blocked", assertRepoNotQuarantined(r).ok === false);
  check("(critical2-boot-graduation) nothing was lifted", result.liftedRepoPaths.length === 0);
}

// ===================== (critical2-reconcile-placeholder) CRITICAL-2 (CR round 2) — reconcileClearedEntryIfPlaceholder =====================
// ===================== must ALSO use the absorbing union, never the plain OR =====================
// S genuinely raises for real, so its own on-disk latch carries a precise genuineContributorKeys:[r]
// (stamped by this card's own origin site once r folds in). The IN-MEMORY active entry at Ks is then
// directly overwritten with an UNREADABLE-PLACEHOLDER-shaped object (never touching the real file on
// disk — `isUnreadablePlaceholderEntry` is a pure shape check, `entry.placeholder===true &&
// entry.branch===PLACEHOLDER_BRANCH_UNREADABLE`, so this is the SAME precondition a real unreadable-then-
// readable transition produces, without the ICACLS timing fragility). `clearMergeQuarantineLatchFile`
// (clear-by-id) is the ONE clear route that reconciles a matched placeholder BEFORE computing ambiguity
// (`activeMatch = {key, entry: reconciled}`, read directly from its own source) — so calling it here
// drives the real `reconcileClearedEntryIfPlaceholder` call and lets us inspect its own output directly.
{
  const s = freshRepo("critical2-reconcile-s");
  const r = freshRepo("critical2-reconcile-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("critical2-reconcile: ks collided with kr — re-run");

  enterMergeQuarantine(s, "s-branch", "critical2-reconcile s raise");
  const sFile = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`);
  const onDiskS = JSON.parse(fs.readFileSync(sFile, "utf8"));
  fs.writeFileSync(sFile, JSON.stringify({ ...onDiskS, resolvedKey: kr }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  enterMergeQuarantine(r, "r-branch", "critical2-reconcile r genuine raise");
  check("(critical2-reconcile precondition) s's own real on-disk content now carries a precise gck naming r", JSON.parse(fs.readFileSync(sFile, "utf8")).genuineContributorKeys?.some((k) => directPathIdentity(k) === directPathIdentity(r)));

  const placeholderEntry = {
    repoPath: s, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "boot found this latch unreadable, not corrupt",
    enteredAt: Date.now(), tokens: ["placeholder-token"], placeholder: true, armedKeys: [ks],
  };
  setActiveQuarantineTestOnly(ks, placeholderEntry);
  check("(critical2-reconcile precondition) the in-memory entry is now placeholder-shaped with gck absent", activeMergeQuarantineFor(s)?.genuineContributorKeys === undefined && activeMergeQuarantineFor(s)?.branch === PLACEHOLDER_BRANCH_UNREADABLE);

  const result = clearMergeQuarantineLatchFile(hashForKey(ks));
  console.log(`(critical2-reconcile) clearMergeQuarantineLatchFile(hash(ks)) -> ${JSON.stringify(result)}`);
  const reconciledEntry = activeMergeQuarantineFor(s);
  check("*** THE FIX (CRITICAL-2, reconcileClearedEntryIfPlaceholder) *** the reconciled entry's own gck stays genuinely absent — the absorbing union never promotes it to a precise array just because the real disk content had one", reconciledEntry?.genuineContributorKeys === undefined);
  check("(critical2-reconcile) the SAME reconcile correctly adopted the real disk content's contributorRepoPaths (the OR-union, unaffected by this card)", !!reconciledEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check("(critical2-reconcile) R is still blocked", assertRepoNotQuarantined(r).ok === false);
}

// ===================== (minor2-clear-by-id) MINOR-2 — clear-by-id for the new field's own shape =====================
{
  const { s, r } = buildSiblingKeyFixture("minor2-clear-by-id");
  checkPrecondition("minor2-clear-by-id", s, r);

  const id = quarantineLatchIdFor(s);
  const result = clearMergeQuarantineLatchFile(id);
  check("(minor2-clear-by-id) clear-by-id refuses (pre-existing, unaffected posture — ambiguous contributorRepoPaths)", result.ok === false);
  check("(minor2-clear-by-id) R is still blocked", assertRepoNotQuarantined(r).ok === false);
  check("(minor2-clear-by-id) S is still blocked", assertRepoNotQuarantined(s).ok === false);
}

// ===================== (minor2-reboot) MINOR-2 — genuineContributorKeys survives a real reboot, and the =====================
// ===================== refusal (and R's own block) survives with it =====================
{
  const { s, r } = buildSiblingKeyFixture("minor2-reboot");
  checkPrecondition("minor2-reboot", s, r);
  const beforeGck = activeMergeQuarantineFor(s)?.genuineContributorKeys;
  check("(minor2-reboot precondition) gck is precise and names r before the reboot", !!beforeGck?.some((k) => directPathIdentity(k) === directPathIdentity(r)));

  reenterMergeQuarantinesAtBoot([]);
  const afterGck = activeMergeQuarantineFor(s)?.genuineContributorKeys;
  check("*** THE FIX (MINOR-2, persistence) *** gck round-trips a real reboot, still naming r", !!afterGck?.some((k) => directPathIdentity(k) === directPathIdentity(r)));

  const result = clearMergeQuarantineReporting(s);
  check("*** THE FIX (MINOR-2, persistence) *** the refusal survives the reboot — R stays blocked", assertRepoNotQuarantined(r).ok === false);
  check("(minor2-reboot) nothing was lifted", result.liftedRepoPaths.length === 0);
}

// ===================== (major-order-independence) MAJOR (CR round 3) — the disclosure fact is ENTRY-level, =====================
// ===================== never per-latch-key: a human addressing the SAME entry by R's own latch id, or by =====================
// ===================== assertRepoNotQuarantined(r), must see it too — regardless of armedKeys insertion order =====================
// Round 2's own fix compared `entry.identityAtRaise` against ONE specific key (the id's own resolved key,
// or `quarantineLatchFileIdsFor(q)[0]`) — the CR's own probe: clear-by-id with R's OWN latch id
// (hash(Kr)) omitted the clause in 8 of 8 runs, yet the recommended `/clear(r)` DOES lift S. Forces BOTH
// `armedKeys` orderings directly (never relying on whichever order boot's own dual-arm mechanism happens
// to produce naturally), so this is never order-dependent by accident of construction either.
for (const order of ["ks-first", "kr-first"]) {
  const { s, r, ks, kr } = buildSiblingKeyFixture(`major-order-${order}`);
  const entry = activeMergeQuarantineFor(s);
  const orderedKeys = order === "ks-first" ? [ks, kr] : [kr, ks];
  const reordered = { ...entry, armedKeys: orderedKeys };
  setActiveQuarantineTestOnly(ks, reordered);
  setActiveQuarantineTestOnly(kr, reordered);

  const idResult = clearMergeQuarantineLatchFile(hashForKey(kr));
  console.log(`(major-order-independence, ${order}) clearMergeQuarantineLatchFile(hash(kr)) -> ${JSON.stringify(idResult)}`);
  check(`(major-order-independence, ${order}) clear-by-id(hash(Kr)) refuses`, idResult.ok === false);
  check(`*** THE FIX (MAJOR, order=${order}) *** clear-by-id(hash(Kr)) — R's OWN latch id — ALSO names the clause`, idResult.ok === false && idResult.reason?.includes("can ALSO release") && idResult.reason?.includes(s));

  const arnq = assertRepoNotQuarantined(r);
  console.log(`(major-order-independence, ${order}) assertRepoNotQuarantined(r) -> ${JSON.stringify(arnq)}`);
  check(`(major-order-independence, ${order}) assertRepoNotQuarantined(r) refuses`, arnq.ok === false);
  check(`*** THE FIX (MAJOR, order=${order}) *** assertRepoNotQuarantined(r) ALSO names the clause`, arnq.ok === false && arnq.reason?.includes("can ALSO release") && arnq.reason?.includes(s));
}

// ===================== (hedge-legacy) CR3 (session d839b41f) — entryGenuinelyOwnsALiveArmedKeyOfItsOwn =====================
// ===================== fails OPEN (omits the clause entirely) for a LEGACY entry (identityAtRaise =====================
// ===================== undefined) even though /clear(r) still lifts S — must HEDGE instead of staying silent =====================
// The pre-tri-state boolean treated "identityAtRaise undefined" identically to a confident "not owned,"
// so the disclosure clause was omitted entirely. Both armedKeys orders, since the entry-level fact must
// never depend on insertion order (same discipline as (major-order-independence) above).
for (const order of ["ks-first", "kr-first"]) {
  const { s, r, ks, kr } = buildSiblingKeyFixture(`hedge-legacy-${order}`);
  const entry = activeMergeQuarantineFor(s);
  const orderedKeys = order === "ks-first" ? [ks, kr] : [kr, ks];
  const legacyEntry = { ...entry, armedKeys: orderedKeys, identityAtRaise: undefined };
  setActiveQuarantineTestOnly(ks, legacyEntry);
  setActiveQuarantineTestOnly(kr, legacyEntry);

  const idResult = clearMergeQuarantineLatchFile(hashForKey(kr));
  console.log(`(hedge-legacy, ${order}) clearMergeQuarantineLatchFile(hash(kr)) -> ${JSON.stringify(idResult)}`);
  check(`(hedge-legacy, ${order}) clear-by-id(hash(Kr)) refuses`, idResult.ok === false);
  check(`*** THE FIX (hedge-legacy, order=${order}) *** clear-by-id(hash(Kr)) names the HEDGED clause (LEGACY identityAtRaise)`, idResult.ok === false && idResult.reason?.includes("may ALSO release") && idResult.reason?.includes("Loom cannot tell whether it genuinely owns this key") && idResult.reason?.includes(s));
  check(`(hedge-legacy, ${order}) the text is the HEDGED variant, never the confident one`, idResult.ok === false && !idResult.reason?.includes("can ALSO release"));

  const arnq = assertRepoNotQuarantined(r);
  console.log(`(hedge-legacy, ${order}) assertRepoNotQuarantined(r) -> ${JSON.stringify(arnq)}`);
  check(`(hedge-legacy, ${order}) assertRepoNotQuarantined(r) refuses`, arnq.ok === false);
  check(`*** THE FIX (hedge-legacy, order=${order}) *** assertRepoNotQuarantined(r) ALSO names the HEDGED clause`, arnq.ok === false && arnq.reason?.includes("may ALSO release") && arnq.reason?.includes("Loom cannot tell whether it genuinely owns this key") && arnq.reason?.includes(s));
  check(`(hedge-legacy, ${order}) assertRepoNotQuarantined(r)'s text is the HEDGED variant, never the confident one`, arnq.ok === false && !arnq.reason?.includes("can ALSO release"));
}

// ===================== (hedge-stale) CR3 (session d839b41f) — entryGenuinelyOwnsALiveArmedKeyOfItsOwn =====================
// ===================== fails OPEN for a STALE entry (identityAtRaise recorded but no longer among the =====================
// ===================== entry's own live-armed keys) — same hedge as (hedge-legacy), different cause =====================
// identityAtRaise here is a genuinely recorded value that simply does not appear in armedKeys any more
// (e.g. a drifted/migrated key) — Loom cannot tell whether S still genuinely owns ANY of its own
// currently-live keys, so the disclosure must hedge rather than silently omit the clause, exactly like
// the LEGACY shape above.
for (const order of ["ks-first", "kr-first"]) {
  const { s, r, ks, kr } = buildSiblingKeyFixture(`hedge-stale-${order}`);
  const entry = activeMergeQuarantineFor(s);
  const orderedKeys = order === "ks-first" ? [ks, kr] : [kr, ks];
  const staleEntry = { ...entry, armedKeys: orderedKeys, identityAtRaise: `${ks}-stale-moved-identity` };
  setActiveQuarantineTestOnly(ks, staleEntry);
  setActiveQuarantineTestOnly(kr, staleEntry);

  const idResult = clearMergeQuarantineLatchFile(hashForKey(kr));
  console.log(`(hedge-stale, ${order}) clearMergeQuarantineLatchFile(hash(kr)) -> ${JSON.stringify(idResult)}`);
  check(`(hedge-stale, ${order}) clear-by-id(hash(Kr)) refuses`, idResult.ok === false);
  check(`*** THE FIX (hedge-stale, order=${order}) *** clear-by-id(hash(Kr)) names the HEDGED clause (STALE identityAtRaise)`, idResult.ok === false && idResult.reason?.includes("may ALSO release") && idResult.reason?.includes("Loom cannot tell whether it genuinely owns this key") && idResult.reason?.includes(s));
  check(`(hedge-stale, ${order}) the text is the HEDGED variant, never the confident one`, idResult.ok === false && !idResult.reason?.includes("can ALSO release"));

  const arnq = assertRepoNotQuarantined(r);
  console.log(`(hedge-stale, ${order}) assertRepoNotQuarantined(r) -> ${JSON.stringify(arnq)}`);
  check(`(hedge-stale, ${order}) assertRepoNotQuarantined(r) refuses`, arnq.ok === false);
  check(`*** THE FIX (hedge-stale, order=${order}) *** assertRepoNotQuarantined(r) ALSO names the HEDGED clause`, arnq.ok === false && arnq.reason?.includes("may ALSO release") && arnq.reason?.includes("Loom cannot tell whether it genuinely owns this key") && arnq.reason?.includes(s));
  check(`(hedge-stale, ${order}) assertRepoNotQuarantined(r)'s text is the HEDGED variant, never the confident one`, arnq.ok === false && !arnq.reason?.includes("can ALSO release"));
}

// ===================== (minor-existing-branch-stamp-legacy) MINOR (CR round 3) — the existing-branch stamp =====================
// ===================== must ALSO route through the shared absorbing helper, never a hand-rolled narrowing =====================
// A genuinely legacy union (identityAtRaise stamped, NO genuineContributorKeys field, NO contributor yet
// — r folds in below via a REAL raise, through enterMergeQuarantine's own existing branch, never a
// hand-written contributorRepoPaths shortcut) must keep gck undefined after the fold, never narrowed to
// `[kr]` (round 2's own hand-rolled version of this exact stamp did exactly that).
{
  const s = freshRepo("minor-stamp-legacy-s");
  const r = freshRepo("minor-stamp-legacy-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("minor-stamp-legacy: ks collided with kr — re-run");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ks)}.json`), JSON.stringify({
    repoPath: s, branch: "s-branch", reason: "minor-stamp-legacy pre-6de79dc0 union, no contributor yet",
    enteredAt: Date.now() - 60_000, tokens: ["s-token"], resolvedKey: kr, identityAtRaise: ks,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(minor-stamp-legacy precondition) gck is genuinely absent before r folds in", activeMergeQuarantineFor(s)?.genuineContributorKeys === undefined);
  check("(minor-stamp-legacy precondition) no contributor yet", (activeMergeQuarantineFor(s)?.contributorRepoPaths ?? []).length === 0);

  enterMergeQuarantine(r, "r-branch", "minor-stamp-legacy r genuine raise — hits the existing branch's own stamp");
  const sEntry = activeMergeQuarantineFor(s);
  check("(minor-stamp-legacy) r folded in as a contributor", !!sEntry?.contributorRepoPaths?.some((c) => directPathIdentity(c) === directPathIdentity(r)));
  check("*** THE FIX (MINOR, existing-branch stamp routed through the absorbing helper) *** gck stays genuinely absent, never narrowed to [kr]", sEntry?.genuineContributorKeys === undefined);

  const result = clearMergeQuarantineReporting(s);
  console.log(`(minor-stamp-legacy) clearMergeQuarantineReporting(s) -> ${JSON.stringify(result)}`);
  check("(minor-stamp-legacy) the broad fallback still refuses — r stays blocked", assertRepoNotQuarantined(r).ok === false);
  check("(minor-stamp-legacy) nothing was lifted", result.liftedRepoPaths.length === 0);
}

// ===================== (entry-vs-perkey-discriminator) CR3 (session d839b41f) =====================
// @decision 6de79dc0 (CR3, Round 4, Item 3) — refuseSelfClearStaleKeyContributors's own per-key
// `entryOwnsKey` and the entry-level ownership fact are NOT value-equivalent; this PINS the current,
// self-contradictory refusal text as a found residual, not fixed here. See the Evidence file.
{
  const s = freshRepo("perkey-discriminator-s");
  const r = freshRepo("perkey-discriminator-r");
  const ks = canonicalRepoLockKey(s);
  const kr = canonicalRepoLockKey(r);
  if (ks === kr) throw new Error("perkey-discriminator: ks collided with kr — re-run");

  const entry = {
    repoPath: s, branch: "s-branch", reason: "perkey-discriminator synthetic union",
    enteredAt: Date.now() - 60_000, tokens: ["s-token"],
    identityAtRaise: ks, contributorRepoPaths: [r], genuineContributorKeys: [kr],
    armedKeys: [kr, ks],
  };
  setActiveQuarantineTestOnly(kr, entry); // inserted FIRST — a brand-new key, never set before
  setActiveQuarantineTestOnly(ks, entry); // inserted SECOND — activeQuarantines' own Map iteration now visits kr first

  check("(perkey-discriminator precondition) S is blocked", assertRepoNotQuarantined(s).ok === false);
  check("(perkey-discriminator precondition) R is blocked (via contributorRepoPaths)", assertRepoNotQuarantined(r).ok === false);

  const result = clearMergeQuarantineReporting(s);
  console.log(`(perkey-discriminator) clearMergeQuarantineReporting(s) -> ${JSON.stringify(result)}`);
  check("(perkey-discriminator) self-clear(s) refuses", result.wasQuarantined === true && result.liftedRepoPaths.length === 0);
  check("*** THE GAP (discriminated, pinned, NOT endorsed) *** the per-key clause reads \"does not own this key itself\"", result.reason?.includes("does not own this key itself"));
  check("*** THE GAP (discriminated, pinned, NOT endorsed) *** the SAME text ALSO reads \"it genuinely owns this key\" — self-contradictory", result.reason?.includes("(it genuinely owns this key)"));
}

console.log(failures === 0 ? "\n✅ ALL CHECKS PASS" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
