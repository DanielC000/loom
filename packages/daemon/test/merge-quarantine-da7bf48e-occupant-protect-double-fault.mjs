import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision da7bf48e — never assert "still blocked" in this file via activeMergeQuarantineFor (it lazily
// self-heals/rewrites the occupant's record as a side effect of being merely queried, silently discarding
// the tracking the fix just added); use the pure, non-mutating stillBlockedEntryFor for every check here.
//
// SCENARIO cp (clear-path) — protectOccupantContentBeforeDelete's double-fault branch, cleared via
// deleteMergeQuarantineLatchByKey. CONFIRMED SAFE pre-fix (a separate, content-aware sweep closes it
// within the same synchronous clear call); included as a regression-safety sanity check, no fix needed.
//
// SCENARIO rp (raise-path) — the same branch reached via enterMergeQuarantine's own mustDivert:true shape.
// Genuinely needed the fix: tracking the stranded tmp AND unioning a same-identity slot's prior
// orphanLatchFiles forward (resolveRaiseOverwrite's own redundant second call otherwise drops the first
// call's own tracked stray). Full mechanism, investigation history and verification:
// docs/decisions/da7bf48e-occupant-protect-double-fault-raise-path.md.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-da7bf48e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=da7bf48e@loom -c user.name=da7bf48e";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-da7bf48e-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# da7bf48e (${tag})\n`);
  execSync(`git init -q && git config user.email da7bf48e@loom && git config user.name da7bf48e`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function hashForKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Fails fs.renameSync ONLY when its SOURCE basename starts with `matchBase` — a genuine, fully-written
// tmp file (unlike fs.openSync injection, which never creates one at all), scoped precisely to ONE
// identity's own mint target so an unrelated write to a DIFFERENT identity/hash in the same call is
// never collaterally failed.
function injectScopedRenameFailure(matchBase, code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = (src, dest) => {
    const base = path.basename(String(src));
    if (base.startsWith(matchBase)) {
      hits++;
      throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

// Same scoping as injectScopedRenameFailure, but fails only the first `failCount` matching renames —
// a TRANSIENT fault (V1/V3/V6): later matching calls for the same identity go through to the real rename.
function injectScopedRenameFailureLimited(matchBase, failCount, code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = (src, dest) => {
    const base = path.basename(String(src));
    if (base.startsWith(matchBase) && hits < failCount) {
      hits++;
      throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

// Counts console.error calls whose text matches `pattern` while active — scoped to the double-fault
// branch's OWN log line ("could not durably write a fresh pending-divert copy"), never the OTHER
// console.error writePendingDivertFile's own catch ALSO emits on the same event; each double-fault
// EVENT fires both lines once, but only this one is unique to protectOccupantContentBeforeDelete itself.
function spyConsoleErrorMatching(pattern) {
  const real = console.error;
  let count = 0;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes(pattern)) count++;
    return real(...args);
  };
  return { restore: () => { console.error = real; }, count: () => count };
}

let moduleImportCounter = 0;
async function freshMergeQuarantineModule() {
  moduleImportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleImportCounter}`);
}
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO cp (clear-path) — the double fault during deleteMergeQuarantineLatchByKey
  // (clearMergeQuarantineReporting clearing R, a resolvable repo, while D — a degraded, never-created
  // subdirectory of R — is armed at R's own canonical key). CONFIRMED SAFE without the fix (the
  // clear-path's own trailing freedKey content-aware sweep already closes it) — asserted here as a
  // regression pin, not a claim this scenario alone proves the fix.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("cp-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = hashForKey(Kr);
  const d = path.join(r, "gone-subdir");

  const mod = await freshMergeQuarantineModule();
  const {
    clearMergeQuarantineReporting, clearMergeQuarantineByToken, reenterMergeQuarantinesAtBoot,
    MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["cp-d-token-1", "cp-d-token-2"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  check("(cp precondition) D is blocked after boot (pure read)", !!stillBlockedEntryFor(d));

  const inject = injectScopedRenameFailure("pending-");
  let reportResult;
  try {
    reportResult = clearMergeQuarantineReporting(r);
  } finally {
    inject.restore();
  }
  check("(cp positive control) a rename was actually injected to fail (a REAL tmp was written then failed to rename)", inject.hits() >= 1);
  check("(cp) D's own self-owned kept record survives the double fault (pure read)", !!stillBlockedEntryFor(d));

  // Post-fix, D's own record now TRACKS the stray tmp — which means R's own clear (D is not the entry
  // being cleared here) sees it as REFERENCED (by D itself) rather than untracked-and-incidentally swept
  // by the trailing freedKey content sweep. The stray can legitimately still be ON DISK right here: it is
  // no longer lost, and the discriminating claim is that it survives UNTIL D's own full lift (below), not
  // that it vanishes on this unrelated clear.
  const dLiveAfterClear = stillBlockedEntryFor(d);
  const dirListingAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strayAfterClear = dirListingAfterClear.filter((n) => n.includes(".json.tmp-"));
  check("(cp) if a stray tmp survives R's own unrelated clear, D's own record tracks it (never untracked)",
    strayAfterClear.every((f) => (dLiveAfterClear?.orphanLatchFiles ?? []).includes(f)));

  clearMergeQuarantineByToken(d, "cp-d-token-1");
  clearMergeQuarantineByToken(d, "cp-d-token-2");
  check("(cp) D is fully unblocked after a full lift (pure read)", !stillBlockedEntryFor(d));

  const dirListingAfterLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("(cp) no stray tmp remains after the full lift either", !dirListingAfterLift.some((n) => n.includes(".json.tmp-")));

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([]);
  const dAfterBoot = rebooted.stillBlockedEntryFor(d);
  check("*** THE 8d80b736 CLAIM (cp, restart) *** D is NOT resurrected after a real reboot (pure read)", !dAfterBoot);
  check("(cp, restart) if D is blocked at all it must be a real outstanding token — never fail-open", !dAfterBoot || (dAfterBoot.tokens ?? []).length > 0);

  if (dAfterBoot) for (const t of dAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(d, t);
  void reportResult;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // @decision da7bf48e — don't regress this scenario to D sharing R's own natural key (never reaches
  // protectOccupantContentBeforeDelete at all); scope the rename-failure injection to X's own EXACT
  // pending-divert mint basename, never a bare "pending-" prefix (also faults teamA/W's own divert).
  //
  // SCENARIO rp (raise-path) — mirrors decision e0192ffb's own established fixture
  // (merge-quarantine-degraded-occupant-guard.mjs's "existing-branch-raise-protects-foreign-pending-
  // occupant"): X is pure pending at Kw's own final (never resolves). teamA (a subdirectory of W that
  // does not exist at boot) has its own stale pending latch; once teamA is created, its own canonical key
  // collapses onto Kw too, and querying it graduates it at Kw in-memory. W itself then raises — its own
  // fresh key is ALSO Kw — reaching `enterMergeQuarantine`'s `existing`-truthy branch with `existing` =
  // teamA's just-graduated entry, a DIFFERENT identity than X, which genuinely occupies Kw's own physical
  // final. THIS is what reaches protectOccupantContentBeforeDelete's double-fault branch for real.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("rp-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-da7bf48e-rp-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["rp-x-token"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["rp-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(rp precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject = injectScopedRenameFailure(xPendingBase);
  try {
    enterMergeQuarantine(w, "w-branch", "W raises for the first time while X occupies its key via teamA's graduation");
  } finally {
    inject.restore();
  }
  check("(rp positive control) X's OWN mint rename was selectively failed (a REAL tmp was written then failed to rename)", inject.hits() >= 1);

  const dirListing1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmps1 = dirListing1.filter((n) => n.includes(".json.tmp-"));
  check("(rp) a REAL stranded tmp survives right after the double fault", strandedTmps1.length >= 1);

  const xPure = stillBlockedEntryFor(x);
  check("(rp) X's own self-owned kept record survives the double fault (pure read)", !!xPure && (xPure.tokens ?? []).includes("rp-x-token"));
  check("*** THE FIX (rp) *** X's own record TRACKS every stranded tmp in orphanLatchFiles (pure read)",
    !!xPure && strandedTmps1.length > 0 && strandedTmps1.every((f) => (xPure.orphanLatchFiles ?? []).includes(f)));

  // Straight to clearing X's own last token — deliberately no intervening activeMergeQuarantineFor/
  // clearMergeQuarantine(w) calls, which would self-heal/mutate X's own record via a SEPARATE, successful
  // protect retry and silently discard this test's own fixture before it ever reaches this assertion
  // (see this file's own header note on the self-healing-reader trap).
  clearMergeQuarantineByToken(x, "rp-x-token");
  check("(rp) X is fully unblocked after clearing its own last token (pure read)", !stillBlockedEntryFor(x));

  const dirListing2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (rp) *** no stray tmp remains after the full lift", !dirListing2.some((n) => n.includes(".json.tmp-")));

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterBoot = rebooted.stillBlockedEntryFor(x);
  check("*** THE FIX (rp, restart) *** X is NOT resurrected after a real reboot (pure read)", !xAfterBoot);
  check("(rp, restart) if X is blocked at all it must be a real outstanding token — never fail-open", !xAfterBoot || (xAfterBoot.tokens ?? []).length > 0);

  if (xAfterBoot) for (const t of xAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(x, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // @decision da7bf48e (M1) — a SUCCESS branch's own written.entry is built from toWrite alone;
  // without carrying a replaced same-identity slot's orphanLatchFiles into toWrite BEFORE the
  // write, a later successful protect silently drops whatever strays the slot was tracking.
  //
  // SCENARIO v1 (transient fault) — same e0192ffb fixture as rp, but ONLY the raise's first
  // internal protect call (protectUnincorporatedOccupantBeforeDelete's own tail) fails; its
  // second, redundant call (resolveRaiseOverwrite's own fallback, reached because the first
  // failed) then SUCCEEDS. The most realistic real-world shape (a one-off EPERM).
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("v1-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-da7bf48e-v1-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    clearMergeQuarantineReporting, MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const kwHashFile = `${hashForKey(kw)}.json`;
  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, kwHashFile);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["v1-x1", "v1-x2"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["v1-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(v1 precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject = injectScopedRenameFailureLimited(xPendingBase, 1);
  const errSpy = spyConsoleErrorMatching("could not durably write a fresh pending-divert copy");
  try {
    enterMergeQuarantine(w, "w-branch", "W raises once; X's own mint rename fails only the first time");
  } finally {
    inject.restore();
    errSpy.restore();
  }
  check("(v1 positive control) exactly ONE X-pending rename was failed (transient, not persistent)", inject.hits() === 1);
  check("(v1 positive control) the double-fault branch's own log fired exactly once (the retry succeeded)", errSpy.count() === 1);

  const dirListing1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmps1 = dirListing1.filter((n) => n.includes(".json.tmp-"));
  check("(v1) a REAL stranded tmp survives the transient fault", strandedTmps1.length >= 1);

  const xLive = stillBlockedEntryFor(x);
  check("(v1) X's own record survives, now re-pointed by the later SUCCESS (pure read)",
    !!xLive && new Set(xLive.tokens ?? []).has("v1-x1") && new Set(xLive.tokens ?? []).has("v1-x2"));
  check("*** THE FIX (v1) *** X's own SUCCESS-written record still tracks the transient fault's stray (pure read)",
    !!xLive && strandedTmps1.every((f) => (xLive.orphanLatchFiles ?? []).includes(f)));
  check("*** THE FIX (v1, M1) *** X's own SUCCESS-written record does NOT self-reference the raiser's own live latch file (pure read)",
    !!xLive && !(xLive.orphanLatchFiles ?? []).includes(kwHashFile));

  // teamA/W's own armed record now physically occupies the SAME `kwHashFile` X used to occupy — the
  // exact shape M1 fixes, since a stale carry-forward would make X's record reference W's live file.
  check("(v1 precondition, M1) teamA/W's own record is armed and lives at that exact file (pure read)",
    !!stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  const xClearResult = clearMergeQuarantineReporting(x);
  check("(v1) X is fully unblocked after its own full clear (pure read)", !stillBlockedEntryFor(x));
  check("*** THE FIX (v1, M1) *** X's clear result does not name teamA/W in referencingRepoPaths",
    !(xClearResult.referencingRepoPaths ?? []).includes(teamA) && !(xClearResult.referencingRepoPaths ?? []).includes(w));
  check("*** THE FIX (v1, M1) *** X's clear result does not name teamA/W in stillBlockedCoOccupants",
    !(xClearResult.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === teamA || c.repoPath === w));
  check("*** THE FIX (v1, M1) *** X's clear result does not report latchKept for the raiser's own live latch file",
    xClearResult.latchKept !== true);
  check("*** THE FIX (v1, M1) *** teamA/W stays blocked in-process after X's full clear, its own latch file surviving on disk (pure read)",
    !!stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  const dirListing2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (v1) *** no stray tmp remains after the full lift", !dirListing2.some((n) => n.includes(".json.tmp-")));

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterBoot = rebooted.stillBlockedEntryFor(x);
  check("*** THE FIX (v1, restart) *** X is NOT resurrected after a real reboot (pure read)", !xAfterBoot);
  check("(v1, restart) if X is blocked at all it must be a real outstanding token — never fail-open", !xAfterBoot || (xAfterBoot.tokens ?? []).length > 0);
  check("*** THE FIX (v1, M1, restart) *** teamA/W stays blocked after a real reboot too, its own latch file surviving on disk (pure read)",
    !!rebooted.stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  if (xAfterBoot) for (const t of xAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(x, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO v6 (persistent double fault, then a SEPARATE later raise with no fault) — the first
  // top-level raise double-faults BOTH its internal protect calls (like rp), tracking both strays
  // via the pre-existing 98b88c99 union-forward fix. A genuinely SECOND, independent top-level
  // raise of W (never cleared in between) then succeeds — M1's own carry-forward must hand BOTH
  // strays into that success, not just the one a single-retry shape (v1) would exercise.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("v6-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-da7bf48e-v6-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    clearMergeQuarantineReporting, MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const kwHashFile = `${hashForKey(kw)}.json`;
  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, kwHashFile);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["v6-x1", "v6-x2"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["v6-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(v6 precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject1 = injectScopedRenameFailure(xPendingBase);
  try {
    enterMergeQuarantine(w, "w-branch-1", "W raises the first time; X's own mint rename persistently fails both internal attempts");
  } finally {
    inject1.restore();
  }
  check("(v6 positive control) BOTH of the first raise's own internal X-pending renames were failed", inject1.hits() >= 2);

  const dirListingAfterFirstRaise = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpsAfterFirstRaise = dirListingAfterFirstRaise.filter((n) => n.includes(".json.tmp-"));
  check("(v6) BOTH stranded tmps from the first raise's own double-double-fault survive on disk", strandedTmpsAfterFirstRaise.length >= 2);
  const xAfterFirstRaise = stillBlockedEntryFor(x);
  check("(v6, pre-existing fix) X's own kept record already tracks BOTH stranded tmps after the first raise alone (pure read)",
    !!xAfterFirstRaise && strandedTmpsAfterFirstRaise.every((f) => (xAfterFirstRaise.orphanLatchFiles ?? []).includes(f)));

  // A genuinely SEPARATE, later top-level raise — no fault this time, X not yet cleared.
  enterMergeQuarantine(w, "w-branch-2", "W raises a second, independent time; X still occupies Kw's own key, no fault now");

  const xAfterSecondRaise = stillBlockedEntryFor(x);
  check("*** THE FIX (v6) *** X's record, now written via the second raise's own SUCCESS branch, still tracks BOTH stranded tmps (pure read)",
    !!xAfterSecondRaise && strandedTmpsAfterFirstRaise.every((f) => (xAfterSecondRaise.orphanLatchFiles ?? []).includes(f)));
  check("*** THE FIX (v6, M1) *** X's own SUCCESS-written record does NOT self-reference the raiser's own live latch file (pure read)",
    !!xAfterSecondRaise && !(xAfterSecondRaise.orphanLatchFiles ?? []).includes(kwHashFile));

  // teamA/W's own armed record now physically occupies the SAME `kwHashFile` X used to occupy — the
  // exact shape M1 fixes, since a stale carry-forward would make X's record reference W's live file.
  check("(v6 precondition, M1) teamA/W's own record is armed and lives at that exact file (pure read)",
    !!stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  const xClearResult = clearMergeQuarantineReporting(x);
  check("(v6) X is fully unblocked after its own full clear (pure read)", !stillBlockedEntryFor(x));
  check("*** THE FIX (v6, M1) *** X's clear result does not name teamA/W in referencingRepoPaths",
    !(xClearResult.referencingRepoPaths ?? []).includes(teamA) && !(xClearResult.referencingRepoPaths ?? []).includes(w));
  check("*** THE FIX (v6, M1) *** X's clear result does not name teamA/W in stillBlockedCoOccupants",
    !(xClearResult.stillBlockedCoOccupants ?? []).some((c) => c.repoPath === teamA || c.repoPath === w));
  check("*** THE FIX (v6, M1) *** X's clear result does not report latchKept for the raiser's own live latch file",
    xClearResult.latchKept !== true);
  check("*** THE FIX (v6, M1) *** teamA/W stays blocked in-process after X's full clear, its own latch file surviving on disk (pure read)",
    !!stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  const dirListingAfterLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (v6) *** no stray tmp remains after the full lift", !dirListingAfterLift.some((n) => n.includes(".json.tmp-")));

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterBoot = rebooted.stillBlockedEntryFor(x);
  check("*** THE FIX (v6, restart) *** X is NOT resurrected after a real reboot (pure read)", !xAfterBoot);
  check("(v6, restart) if X is blocked at all it must be a real outstanding token — never fail-open", !xAfterBoot || (xAfterBoot.tokens ?? []).length > 0);
  check("*** THE FIX (v6, M1, restart) *** teamA/W stays blocked after a real reboot too, its own latch file surviving on disk (pure read)",
    !!rebooted.stillBlockedEntryFor(teamA) && fs.existsSync(xAtKwPath));

  if (xAfterBoot) for (const t of xAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(x, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO v3 (partial clear → reboot → clear → reboot) — same transient-fault shape as v1, but
  // narrows one token at a time instead of a full lift, mirroring bdb09095's own reduce-clear-
  // then-reboot pattern: the carried-forward stray must participate correctly in an INCREMENTAL
  // clear, not only a bulk full lift.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
  const w = makeToplevelRepo("v3-w");
  const kw = canonicalRepoLockKey(w);
  const teamA = path.join(w, "teamA");
  const x = path.join(os.tmpdir(), `loom-da7bf48e-v3-x-ghost-${freshSfx()}`);

  const mod = await freshMergeQuarantineModule();
  const {
    reenterMergeQuarantinesAtBoot, enterMergeQuarantine, clearMergeQuarantineByToken,
    MERGE_QUARANTINE_DIR, stillBlockedEntryFor,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const xAtKwPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(kw)}.json`);
  fs.writeFileSync(xAtKwPath, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own real reason — pure pending, no resolvedKey",
    enteredAt: Date.now() - 60_000, tokens: ["v3-x1", "v3-x2"],
  }, null, 2) + "\n");
  const staleTeamAPath = path.join(MERGE_QUARANTINE_DIR, `!stale-teamA-${freshSfx()}.json`);
  fs.writeFileSync(staleTeamAPath, JSON.stringify({
    repoPath: teamA, branch: "teamA-branch", reason: "teamA's real reason", enteredAt: Date.now(), tokens: ["v3-teamA-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([w, teamA, x]);
  fs.mkdirSync(teamA, { recursive: true });
  fs.writeFileSync(path.join(teamA, "marker.txt"), "teamA now exists\n");
  check("(v3 precondition) teamA's own canonical key now collapses onto Kw", canonicalRepoLockKey(teamA) === kw);

  const xPendingBase = pendingDivertFilenameForTest(x).replace(/\.json$/, "");
  const inject = injectScopedRenameFailureLimited(xPendingBase, 1);
  try {
    enterMergeQuarantine(w, "w-branch", "W raises once; X's own mint rename fails only the first time");
  } finally {
    inject.restore();
  }
  check("(v3 positive control) exactly ONE X-pending rename was failed (transient, not persistent)", inject.hits() === 1);

  const strandedTmps1 = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.includes(".json.tmp-"));
  check("(v3) a REAL stranded tmp survives the transient fault", strandedTmps1.length >= 1);

  // PARTIAL clear: narrow to v3-x2 only, then reboot — v3-x1 must stay durably tombstoned and
  // v3-x2 must stay blocked (never under-blocks, never fail-opens on the still-outstanding token).
  clearMergeQuarantineByToken(x, "v3-x1");
  const rebootedAfterPartial = await freshMergeQuarantineModule();
  rebootedAfterPartial.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterPartialBoot = rebootedAfterPartial.stillBlockedEntryFor(x);
  check("*** THE FIX (v3, partial+restart) *** v3-x1 stays lifted after the partial clear + a real reboot (not resurrected)",
    !xAfterPartialBoot || !(xAfterPartialBoot.tokens ?? []).includes("v3-x1"));
  check("*** THE FIX (v3, partial+restart) *** v3-x2 stays blocked after the partial clear + a real reboot (never under-blocks)",
    !!xAfterPartialBoot && (xAfterPartialBoot.tokens ?? []).includes("v3-x2"));

  // Full lift of the remaining token, on the REBOOTED module — then reboot again.
  rebootedAfterPartial.clearMergeQuarantineByToken(x, "v3-x2");
  check("(v3) X is fully unblocked after clearing the remaining token (pure read)", !rebootedAfterPartial.stillBlockedEntryFor(x));

  const dirListingAfterLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (v3) *** no stray tmp remains after the full lift", !dirListingAfterLift.some((n) => n.includes(".json.tmp-")));

  const rebootedAgain = await freshMergeQuarantineModule();
  rebootedAgain.reenterMergeQuarantinesAtBoot([w, teamA, x]);
  const xAfterFinalBoot = rebootedAgain.stillBlockedEntryFor(x);
  check("*** THE FIX (v3, restart) *** X is NOT resurrected after the second real reboot (pure read)", !xAfterFinalBoot);
  check("(v3, restart) if X is blocked at all it must be a real outstanding token — never fail-open", !xAfterFinalBoot || (xAfterFinalBoot.tokens ?? []).length > 0);

  if (xAfterFinalBoot) for (const t of xAfterFinalBoot.tokens ?? []) rebootedAgain.clearMergeQuarantineByToken(x, t);
  }
} finally {
  // Best-effort — real git repos under os.tmpdir(), never this test's own LOOM_HOME.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — protectOccupantContentBeforeDelete's own double-fault branch never leaves a " +
    "resurrecting stray on the clear-path (pre-existing, unrelated sweep; no fix needed) or on the " +
    "raise-path's own mustDivert:true shape (the fix: tracking the stranded tmp AND unioning a same-" +
    "identity slot's prior orphanLatchFiles forward, closing the real reboot resurrection this card found)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
