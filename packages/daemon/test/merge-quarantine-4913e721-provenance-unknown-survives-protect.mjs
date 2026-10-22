import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4913e721 — a boot-detected (in-memory-only) `provenanceUnknown` mark on a degraded occupant did
// NOT survive `protectDegradedOccupantBeforeDelete`'s own copy-aside, because that function (via its
// shared tail, `protectOccupantContentBeforeDelete`) derived `provenanceUnknown` ONLY from `final`'s
// on-disk bytes. `detectUnknownProvenance` (db0a9db0) is a pure in-memory boot-time inference that is
// durable on disk only when SOME OTHER write happens to persist it that same boot — a degraded occupant
// whose file is left "AS WRITTEN" (reenterMergeQuarantinesAtBoot's own standing rule: never
// write/migrate/overwrite on an unresolvable or already-self-consistent degraded key) can carry
// `provenanceUnknown:true` in memory forever while the physical bytes never reflect it. A later clear of
// a DIFFERENT identity that happens to collide with the degraded occupant's own key then built a
// protective pending-divert copy from stale, unmarked disk bytes — laundering legacy/unknown provenance
// to "unmarked" and re-opening the exact fail-OPEN clear-by-id db0a9db0 exists to close.
//
// THE FIX (merge-quarantine.ts):
//   - `inMemoryProvenanceUnknownFor(repoPath)` — a NEW helper scanning BOTH tiers (activeQuarantines AND
//     pendingUnresolvedQuarantines), EVERY object for that identity, never just the first match
//     (d4b25feb's own "two objects per identity" case is exactly why) — OR'd into
//     `protectOccupantContentBeforeDelete`'s own `provenanceUnknown` derivation.
//   - `protectDegradedOccupantBeforeDelete` (and its shared tail) ALSO accepts an optional `knownOccupant`
//     — a pre-delete snapshot of whatever was armed at the key, threaded from `deleteMergeQuarantineLatchByKey`'s
//     own `clearedEntry` param — because the live map slot for the SAME object being protected is, in the
//     most common repro shape, already deleted (by this exact clear's own `activeQuarantines.delete(key)`)
//     by the time the protect call runs; `inMemoryProvenanceUnknownFor`'s own live-map scan alone cannot
//     see it anymore in that shape.
//   - `reconcileMarkedBasenameBeforeWrite`'s 702b4241 re-ingestion branch also used to discard the
//     caller's OWN live `entry.provenanceUnknown` outright in favor of disk-only re-derivation — fixed to
//     OR it in too, per db0a9db0's "carry forward at EVERY copy site" rule (a narrower, defensive fix;
//     no independently-reachable hermetic repro was found for this one specific branch within this card's
//     scope — see the worker's own `blocked` report for the investigation).
//
// FIVE SCENARIOS. Only (a) is built from REAL on-disk state read by a REAL boot
// (`reenterMergeQuarantinesAtBootTestOnly([...], [])` with an EMPTY injection list — the array's own
// provenance-unknown mark comes entirely from `detectUnknownProvenance` running against a hand-written
// latch file). (b), (c), (d), and (e) all inject their own "separate pending-tier twin" object directly
// through the `reenterMergeQuarantinesAtBootTestOnly` test-only seam (its second, non-empty argument) —
// that object is never a real on-disk file; it is spliced straight into `pendingUnresolvedQuarantines` to
// stand in for a genuinely different record this scenario doesn't need to construct by hand.
//   (a) the primary repro — the mark lives on the SAME object actually armed (then deleted) at the
//       cleared key; recovered via `knownOccupant`.
//   (b) the "other tier" variant — the mark lives on a SEPARATE (INJECTED) pending-tier object sharing
//       the same identity (d4b25feb's two-objects-per-identity shape), never touched by the clear's own
//       delete; recovered via `inMemoryProvenanceUnknownFor`'s own live scan.
//   (c) the 21ec39e5 tmp-residue-union path (`protectForeignTmpResidueBeforeSweep`) — a THIRD identity's
//       own foreign `.json.tmp-<pid>` residue, swept during the SAME clear, whose mark ALSO lives only on
//       a separate (INJECTED) pending-tier twin — proves the fix at the one shared chokepoint reaches
//       every caller.
//   (d) NEGATIVE — `knownOccupant`'s own IDENTITY gate (round 2, CR e0b0ccd6): a marked occupant z is
//       armed (and later deleted) at the cleared key, but the PHYSICAL bytes there now belong to a THIRD,
//       clean, unresolvable identity w — w's own protective copy must NOT inherit z's mark merely because
//       the two shared a canonical key at different times. Pinned via `withDistMutation`: weakening the
//       gate from identity equality to canonical-key equality goes RED.
//   (e) NEGATIVE — `inMemoryProvenanceUnknownFor`'s own EXACT-IDENTITY match (round 2, CR e0b0ccd6): a
//       clean, self-consistent occupant z sits at the cleared key while a DIFFERENT (INJECTED) identity z2
//       — sharing z's own canonical key purely incidentally — carries the mark on a pending twin. z's own
//       protective copy must NOT inherit z2's mark, and clear-by-id on it must still succeed. Pinned via
//       `withDistMutation`: weakening the pending-tier match from identity equality to canonical-key
//       equality goes RED.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file. Run with no args to spawn one child per scenario; a child reads
// `--scenario=<name>` off argv and runs only that one scenario inline, exiting non-zero on any failure.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-4913e721-provenance-unknown-survives-protect.mjs
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
  "ancestor-walk-degraded-occupant-fails-closed",
  "other-tier-pending-twin-carries-mark",
  "tmp-residue-site-pending-twin-carries-mark",
  "knownoccupant-identity-gate-excludes-foreign-mark",
  "inmemoryscan-identity-gate-excludes-key-sharing-twin",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  // DRIVER MODE — spawn one child per scenario, each with LOOM_HOME stripped from its env so
  // `useOwnLoomHome` (called inside the child) mints a genuinely fresh one.
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
    ? "\n✅ ALL SCENARIOS PASS — a boot-detected, in-memory-only provenanceUnknown mark survives every "
      + "protective copy-aside this card touched, and clear-by-id fails closed on the result."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 4913e721.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-4913e721-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBootTestOnly, activeMergeQuarantineFor, clearMergeQuarantine,
  clearMergeQuarantineLatchFile, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq4913e721@loom -c user.name=mq4913e721";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function pendingIdForBasename(basename) {
  return createHash("sha256").update(basename).digest("hex").slice(0, 24);
}

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-4913e721-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mq4913e721@loom && git config user.name mq4913e721`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// @decision db0a9db0 (round 3, CR) — the real `packages/daemon/dist/` is SHARED across concurrent gate
// lanes; NEVER mutate it in a committed test. Copy the SMALL, fully-enumerated import closure
// `merge-quarantine.js` actually needs into a FRESH `os.tmpdir()` directory, mutate ONLY that copy, and
// import the copy — mirrors `merge-quarantine-unknown-provenance.mjs`'s own `withDistMutation`.
const DIST_ROOT = path.join(__dirname, "..", "dist");
// Closure, enumerated by hand from each file's own `^import` lines (re-verified for this card: unchanged
// from merge-quarantine-unknown-provenance.mjs's own closure — merge-quarantine.ts's own top-level
// imports are still exactly fs/path/crypto/../paths.js/./repo-lock.js).
const CLOSURE_RELATIVE_FILES = [
  "paths.js",
  path.join("pty", "resolve-bin.js"),
  path.join("pty", "claude-dirname.js"),
  path.join("git", "repo-lock.js"),
  path.join("git", "merge-quarantine.js"),
];
const REAL_MERGE_QUARANTINE_PATH = path.join(DIST_ROOT, "git", "merge-quarantine.js");
const hashFile = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const REAL_MERGE_QUARANTINE_HASH_BEFORE = hashFile(REAL_MERGE_QUARANTINE_PATH);

/** ONE-SITE DIST MUTATION, on a throwaway COPY of the minimal import closure — see the `@decision
 *  db0a9db0` comment above. Throws if `find` doesn't occur EXACTLY once in the copy. */
async function withDistMutation(find, replace, fn) {
  const tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-4913e721-distcopy-"));
  tmpDirs.push(tmpDistDir);
  try {
    for (const rel of CLOSURE_RELATIVE_FILES) {
      const dest = path.join(tmpDistDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(DIST_ROOT, rel), dest);
    }
    const copyMqPath = path.join(tmpDistDir, "git", "merge-quarantine.js");
    const original = fs.readFileSync(copyMqPath, "utf8");
    const occurrences = original.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`withDistMutation: expected EXACTLY 1 occurrence of the given find-text in the merge-quarantine.js COPY, found ${occurrences}`);
    }
    fs.writeFileSync(copyMqPath, original.replace(find, replace));
    const mutatedModule = await import(pathToFileURL(copyMqPath).href);
    return await fn(mutatedModule);
  } finally {
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
    check("(byte-identical guard) the REAL dist/git/merge-quarantine.js was never written", hashFile(REAL_MERGE_QUARANTINE_PATH) === REAL_MERGE_QUARANTINE_HASH_BEFORE);
  }
}

const realModule = { reenterMergeQuarantinesAtBootTestOnly, activeMergeQuarantineFor, clearMergeQuarantine, clearMergeQuarantineLatchFile };

if (scenarioName === "ancestor-walk-degraded-occupant-fails-closed") {
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (a) THE PRIMARY REPRO — modeled on merge-quarantine-pass1-migrate-union.mjs's own
  // "gone-subdir-reblocks-once-then-clearable" scenario (same ancestor-walk-collision shape), with the
  // one deliberate change that reaches detectUnknownProvenance: tokens.length=2 (not 1) and a resolvedKey
  // that does NOT hash-match the file's own physical name — the db0a9db0 "stray union" shape.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const y = makeRepo("a-y");
  const ky = canonicalRepoLockKey(y);
  const z = path.join(y, "gone-subdir"); // never created — ancestor-walks up to y, same key as y

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
  const UNRELATED_KEY = "unrelated-key-for-4913e721-repro";
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z, branch: "z-branch", reason: "a stray pre-82032b5c union, now gone (repro)",
    enteredAt: Date.now(), tokens: ["z-token-1", "z-token-2"], resolvedKey: UNRELATED_KEY,
  }, null, 2) + "\n");

  check("(precondition) on-disk bytes have NO provenanceUnknown field before boot",
    JSON.parse(fs.readFileSync(finalPath, "utf8")).provenanceUnknown === undefined);
  check("(precondition) z's own ancestor-walked key is the SAME as y's (gone-subdir shape)", canonicalRepoLockKey(z) === ky);
  check("(precondition) z is currently unresolvable (gone)", !fs.existsSync(z));

  reenterMergeQuarantinesAtBootTestOnly([y, z], []);
  check("(precondition) y reads quarantined (z's content occupies y's own key)", !!activeMergeQuarantineFor(y));
  check("*** boot left the physical file's bytes UNCHANGED (still no provenanceUnknown on disk) ***",
    JSON.parse(fs.readFileSync(finalPath, "utf8")).provenanceUnknown === undefined);

  clearMergeQuarantine(y);
  check("y's own physical file is correctly deleted", !fs.existsSync(finalPath));
  const pendingAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-"));
  check("a protective (pending-divert) copy IS minted for the degraded occupant", pendingAfterClear.length === 1);
  const onDiskPending = pendingAfterClear[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, pendingAfterClear[0]), "utf8")) : {};
  check("the protective copy carries z's own tokens",
    (onDiskPending.tokens ?? []).includes("z-token-1") && (onDiskPending.tokens ?? []).includes("z-token-2"));
  check("*** THE FIX *** the protective copy CARRIES provenanceUnknown forward", onDiskPending.provenanceUnknown === true);

  if (pendingAfterClear[0]) {
    const pendingId = pendingIdForBasename(pendingAfterClear[0]);
    const clearByIdResult = clearMergeQuarantineLatchFile(pendingId);
    check("*** THE FIX (real-world consequence) *** clear-by-id on the protective copy's own id is REFUSED (fail-closed)",
      clearByIdResult.ok === false);
  }
} else if (scenarioName === "other-tier-pending-twin-carries-mark") {
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (b) THE "OTHER TIER" VARIANT — the mark sits on a SEPARATE pending-tier object for the SAME
  // identity (d4b25feb's "two objects per identity" shape), never the object actually armed (and later
  // deleted) at the key being cleared. Recovered via `inMemoryProvenanceUnknownFor`'s own live scan,
  // never `knownOccupant` (which, here, correctly carries NO mark of its own).
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const y = makeRepo("b-y");
  const ky = canonicalRepoLockKey(y);
  const z = path.join(y, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
  // SELF-CONSISTENT (no provenanceUnknown trigger on THIS object) — plain gone-subdir shape.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z, branch: "z-active-branch", reason: "active twin, self-consistent", enteredAt: Date.now(),
    tokens: ["z-token-A"], resolvedKey: ky,
  }, null, 2) + "\n");

  // A SEPARATE pending-tier object for the SAME identity (z), disjoint token, injected directly —
  // simulates a genuinely different record that already carries provenanceUnknown:true from some
  // earlier event this scenario doesn't need to construct by hand.
  const injectedPending = {
    entry: {
      repoPath: z, branch: "z-pending-branch", reason: "pending twin, carries the mark",
      enteredAt: Date.now(), tokens: ["z-token-B"], provenanceUnknown: true,
    },
    sourceFile: "pending-deadbeefdeadbeefdeadbeef.json",
  };

  reenterMergeQuarantinesAtBootTestOnly([y, z], [injectedPending]);
  check("(precondition) y reads quarantined (z's active twin occupies y's own key)", !!activeMergeQuarantineFor(y));

  clearMergeQuarantine(y);
  const pendingAfterClear = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-") && f !== injectedPending.sourceFile);
  check("a NEW protective copy IS minted for the degraded ACTIVE twin", pendingAfterClear.length === 1);
  const onDiskPending = pendingAfterClear[0] ? JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, pendingAfterClear[0]), "utf8")) : {};
  check("*** THE FIX *** the protective copy picks up provenanceUnknown from the SEPARATE pending-tier object",
    onDiskPending.provenanceUnknown === true);

  if (pendingAfterClear[0]) {
    const pendingId = pendingIdForBasename(pendingAfterClear[0]);
    const clearByIdResult = clearMergeQuarantineLatchFile(pendingId);
    check("*** THE FIX (real-world consequence) *** clear-by-id on it is REFUSED (fail-closed)", clearByIdResult.ok === false);
  }
} else if (scenarioName === "tmp-residue-site-pending-twin-carries-mark") {
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (c) THE 21ec39e5 TMP-RESIDUE-UNION PATH — a THIRD identity's own foreign `.json.tmp-<pid>` residue,
  // swept during the SAME clear via `protectForeignTmpResidueBeforeSweep` (never
  // `protectDegradedOccupantBeforeDelete` directly) — proves the fix at the one shared chokepoint
  // (`protectOccupantContentBeforeDelete`) reaches this caller too. The mark again lives only on a
  // separate pending-tier twin, never the tmp's own on-disk bytes.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  const y = makeRepo("c-y");
  const ky = canonicalRepoLockKey(y);
  const z = path.join(y, "gone-subdir-z");
  const w = path.join(y, "gone-subdir-w");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: z, branch: "z-active-branch", reason: "active occupant", enteredAt: Date.now(),
    tokens: ["z-token"], resolvedKey: ky,
  }, null, 2) + "\n");

  // A FOREIGN tmp residue for a THIRD identity (w), self-consistent, sharing the SAME key's hash prefix.
  const tmpPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json.tmp-99999`);
  fs.writeFileSync(tmpPath, JSON.stringify({
    repoPath: w, branch: "w-tmp-branch", reason: "foreign tmp residue", enteredAt: Date.now(),
    tokens: ["w-token-A"],
  }, null, 2) + "\n");

  // A SEPARATE pending-tier object for w's SAME identity, carrying provenanceUnknown:true — the mark
  // lives only here, never on the tmp's own on-disk bytes.
  const injectedPending = {
    entry: {
      repoPath: w, branch: "w-pending-branch", reason: "pending twin carrying the mark",
      enteredAt: Date.now(), tokens: ["w-token-B"], provenanceUnknown: true,
    },
    sourceFile: "pending-cafef00dcafef00dcafef00d.json",
  };

  reenterMergeQuarantinesAtBootTestOnly([y, z, w], [injectedPending]);
  check("(precondition) y reads quarantined (z's active twin occupies y's own key)", !!activeMergeQuarantineFor(y));
  check("(precondition) the foreign tmp residue for w still physically exists before the clear", fs.existsSync(tmpPath));

  clearMergeQuarantine(y);
  check("(sanity) the foreign tmp residue is no longer at its original name (swept/protected)", !fs.existsSync(tmpPath));

  const allPendingFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.startsWith("pending-") && f !== injectedPending.sourceFile);
  let wProtectiveCopy;
  for (const f of allPendingFiles) {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8"));
    if (parsed.repoPath === w) wProtectiveCopy = parsed;
  }
  check("a NEW protective copy exists for w's own tmp-residue content", !!wProtectiveCopy);
  check("*** THE FIX *** w's protective copy picks up provenanceUnknown from its own separate pending-tier twin",
    wProtectiveCopy?.provenanceUnknown === true);
} else if (scenarioName === "knownoccupant-identity-gate-excludes-foreign-mark") {
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (d) NEGATIVE — pins `knownOccupant`'s own IDENTITY gate (round 2, CR e0b0ccd6; merge-quarantine.ts
  // ~:2471's `directPathIdentity(knownOccupant.repoPath) === directPathIdentity(occupantRepoPath)`): z is
  // marked and armed (then deleted) at the cleared key exactly like scenario (a), but by the time the
  // clear's own protect call reads `final`'s bytes, the PHYSICAL file has been overwritten by a THIRD,
  // clean, unresolvable identity w (which ALSO ancestor-walks to the same key). `knownOccupant` (still z,
  // the entry `clearMergeQuarantineByKey` captured before its own delete) must NOT leak its own mark onto
  // w's protective copy just because the two occupied the same canonical key at different times.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  function buildP1Fixture(tag) {
    const y = path.join(os.tmpdir(), `loom-4913e721-d-y-${tag}-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), `# d-y-${tag}\n`);
    execSync(`git init -q && git config user.email mq4913e721@loom && git config user.name mq4913e721`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const z = path.join(y, "gone-subdir-z");
    const w = path.join(y, "gone-subdir-w");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: z, branch: "z-branch", reason: `a stray pre-82032b5c union, now gone (P1-${tag})`,
      enteredAt: Date.now(), tokens: ["z-token-1", "z-token-2"], resolvedKey: `unrelated-key-for-4913e721-p1-${tag}`,
    }, null, 2) + "\n");
    return { y, ky, z, w, finalPath };
  }
  const runP1 = (m, tag) => {
    const { y, ky, z, w, finalPath } = buildP1Fixture(tag);
    check(`(P1-${tag} precondition) w's own ancestor-walked key is the SAME as z's/y's`, canonicalRepoLockKey(w) === ky);
    m.reenterMergeQuarantinesAtBootTestOnly([y, z, w], []);
    check(`(P1-${tag} precondition) y reads quarantined`, !!m.activeMergeQuarantineFor(y));
    // Overwrite the physical file at `ky` with a THIRD, clean, self-consistent identity w — simulating
    // whatever is PHYSICALLY there now belonging to a different identity than the in-memory record
    // (`clearedEntry`/`knownOccupant`) still armed there.
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: w, branch: "w-branch", reason: `a clean, self-consistent, unresolvable identity (P1-${tag})`,
      enteredAt: Date.now(), tokens: ["w-token"], resolvedKey: ky,
    }, null, 2) + "\n");
    m.clearMergeQuarantine(y);
    const matches = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .filter((f) => f.startsWith("pending-"))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })
      .filter((parsed) => parsed?.repoPath === w);
    check(`(P1-${tag}) exactly one protective copy exists for w's own identity`, matches.length === 1);
    return matches[0];
  };
  {
    const protective = runP1(realModule, "baseline");
    check("(P1 baseline, unmutated) w's own protective copy is NOT marked — z's mark does not leak across identities",
      protective?.provenanceUnknown !== true);
  }
  const KNOWNOCCUPANT_GATE_LINE = "|| (knownOccupant !== undefined && directPathIdentity(knownOccupant.repoPath) === directPathIdentity(occupantRepoPath) && knownOccupant.provenanceUnknown === true)";
  await withDistMutation(KNOWNOCCUPANT_GATE_LINE,
    "|| (knownOccupant !== undefined && canonicalRepoLockKey(knownOccupant.repoPath) === canonicalRepoLockKey(occupantRepoPath) && knownOccupant.provenanceUnknown === true)", (m) => {
      const protective = runP1(m, "mutated");
      check("*** PINNED (P1) *** weakening the identity gate to a canonical-key match leaks z's mark onto w's copy — caught",
        protective?.provenanceUnknown === true);
    });
} else if (scenarioName === "inmemoryscan-identity-gate-excludes-key-sharing-twin") {
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // (e) NEGATIVE — pins `inMemoryProvenanceUnknownFor`'s own EXACT-IDENTITY match (round 2, CR e0b0ccd6;
  // merge-quarantine.ts ~:4489-4495's pending-tier `directPathIdentity(p.entry.repoPath) === identity`): a
  // CLEAN, self-consistent occupant z sits at the cleared key, while a DIFFERENT identity z2 — sharing z's
  // own canonical key purely incidentally (both ancestor-walk to the same y) — carries the mark on an
  // INJECTED pending-tier twin. z's own protective copy must NOT inherit z2's mark, and clear-by-id on it
  // must still succeed.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  function buildP2Fixture(tag) {
    const y = path.join(os.tmpdir(), `loom-4913e721-e-y-${tag}-${freshSfx()}`);
    fs.mkdirSync(y, { recursive: true });
    tmpDirs.push(y);
    fs.writeFileSync(path.join(y, "README.md"), `# e-y-${tag}\n`);
    execSync(`git init -q && git config user.email mq4913e721@loom && git config user.name mq4913e721`, { cwd: y });
    commitAll(y, "init", GIT_ID);
    const ky = canonicalRepoLockKey(y);
    const z = path.join(y, "gone-subdir-z");
    const z2 = path.join(y, "gone-subdir-z2");
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(ky)}.json`);
    // z is CLEAN/self-consistent — no provenanceUnknown trigger of its own.
    fs.writeFileSync(finalPath, JSON.stringify({
      repoPath: z, branch: "z-active-branch", reason: `clean active occupant (P2-${tag})`, enteredAt: Date.now(),
      tokens: [`z-token-${tag}`], resolvedKey: ky,
    }, null, 2) + "\n");
    return { y, ky, z, z2 };
  }
  const runP2 = (m, tag) => {
    const { y, ky, z, z2 } = buildP2Fixture(tag);
    check(`(P2-${tag} precondition) z2's own ancestor-walked key is the SAME as z's/y's`, canonicalRepoLockKey(z2) === ky);
    // A SEPARATE pending-tier object for a DIFFERENT identity z2 — carries the mark, shares ky only
    // incidentally (both ancestor-walk to the same y). Never a real on-disk file; injected directly.
    const injectedPending = {
      entry: {
        repoPath: z2, branch: "z2-pending-branch", reason: `z2's own pending twin carrying the mark (P2-${tag})`,
        enteredAt: Date.now(), tokens: [`z2-token-${tag}`], provenanceUnknown: true,
      },
      sourceFile: `pending-${createHash("sha256").update(`p2-${tag}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`,
    };
    m.reenterMergeQuarantinesAtBootTestOnly([y, z, z2], [injectedPending]);
    check(`(P2-${tag} precondition) y reads quarantined`, !!m.activeMergeQuarantineFor(y));
    m.clearMergeQuarantine(y);
    const matches = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .filter((f) => f.startsWith("pending-") && f !== injectedPending.sourceFile)
      .map((f) => ({ f, parsed: (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")); } catch { return undefined; } })() }))
      .filter(({ parsed }) => parsed?.repoPath === z);
    check(`(P2-${tag}) exactly one protective copy exists for z's own identity`, matches.length === 1);
    return { protective: matches[0]?.parsed, pendingId: matches[0] ? pendingIdForBasename(matches[0].f) : undefined };
  };
  {
    const { protective, pendingId } = runP2(realModule, "baseline");
    check("(P2 baseline, unmutated) z's own protective copy is NOT marked — z2's mark does not leak across identities",
      protective?.provenanceUnknown !== true);
    if (pendingId) {
      const clearByIdResult = clearMergeQuarantineLatchFile(pendingId);
      check("(P2 baseline, unmutated) clear-by-id on z's own copy SUCCEEDS (correctly unmarked)", clearByIdResult.ok === true);
    }
  }
  const INMEMORYSCAN_PENDING_LINE = "return pendingUnresolvedQuarantines.some((p) => directPathIdentity(p.entry.repoPath) === identity && p.entry.provenanceUnknown);";
  await withDistMutation(INMEMORYSCAN_PENDING_LINE,
    "return pendingUnresolvedQuarantines.some((p) => canonicalRepoLockKey(p.entry.repoPath) === canonicalRepoLockKey(repoPath) && p.entry.provenanceUnknown);", (m) => {
      const { protective } = runP2(m, "mutated");
      check("*** PINNED (P2) *** weakening the pending-tier match to a canonical-key match leaks z2's mark onto z's copy — caught",
        protective?.provenanceUnknown === true);
    });
} else {
  throw new Error(`unknown scenario: ${scenarioName}`);
}

for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exitCode = failures === 0 ? 0 : 1;
