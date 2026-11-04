import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The npm-ci-against-a-committed-lock mechanism (card 66ab2bc0) — HERMETIC, no real npm network: every
// scenario here drives ensureNpmPinnedAsync's real atomic-install logic against a FAKE child process
// (__setSpawnForTest), the same seam npm-pinned-provision.mjs's own atomic-install tests use. The REAL
// end-to-end `npm ci` spawn (against a real local fixture tarball) is covered separately in
// npm-pinned-real-spawn.mjs; this file is specifically about the npm-ci COMMAND SHAPE and the
// lock-asset fail-closed contract, never about whether a real npm binary behaves as expected.
//
// Proves:
//   (i)   the install command is `npm ci` (never `npm install`) — captured via the fake spawn — and the
//         package.json WRITTEN into the install dir is the synthesized `{dependencies:{[pkg]:version}}`
//         shape, never a committed/static file; the committed lock asset is copied in alongside it
//         byte-for-byte.
//   (ii)  a non-zero `npm ci` exit (the real `EUSAGE` "lock file does not satisfy" text shape, faked here
//         since reproducing it against a real registry non-hermetically would depend on npm's own,
//         observed-to-be-cache-sensitive, resolution behavior — see this card's decision record) makes
//         the row fail loud: outcome 'install-failed', with the real npm error text preserved in
//         errorTail, never silently 'ready' and never silently falling back to an unpinned install. This
//         is a GENERIC non-zero-exit classification, not stale-lock-specific detection — see the case's
//         own "Honesty note" below.
//   (iii) a missing committed lock asset makes the row fail CLOSED: outcome 'lock-missing', BEFORE any
//         tmp dir is created and BEFORE anything is ever spawned (the fake spawn is proven never called).
//   (D1-a) card 66ab2bc0 round 2: a lock-CONTENT change (a NEW committed asset, simulating a version-bump
//          regeneration per the bump ritual) produces a DIFFERENT final install dir and a genuinely FRESH
//          install — never reuses a tree that resolved under a different lock's content.
//   (D1-b) a PRE-EXISTING, old-shape (pre-round-2, version-only, no content-hash suffix) install dir with
//          a real bin sitting in it is NOT treated as ready — the row still installs fresh into the new,
//          hash-suffixed dir.
//   (R3-hotpath) card 66ab2bc0 round 3 (Code Review MINOR 1): `npmPinnedLockContentHash` never caches a
//          `null` (missing-lock) result forever — a lock added AFTER a prior missing-file call is picked
//          up on the very next call, no restart — and an in-place content overwrite at the SAME path is
//          detected on the very next call too (the memo is keyed on mtime+size, not cached permanently).
//   (R3-ensure) `ensureNpmPinnedAsync` hashes and installs the SAME bytes it read for the committed lock
//          (closing a hash-vs-write TOCTOU) — an in-place overwrite of the committed asset reaches a
//          FRESH, correctly-named dir on the very next provisioning attempt, no restart, and the dir it
//          lands in always contains exactly the bytes its own hash names.
//
// The RED/GREEN negative-control proofs for (i) (round 1), D1-a/D1-b (round 2), and R3-hotpath/R3-ensure
// (round 3) are recorded in docs/decisions/66ab2bc0-npm-pinned-lockfile-pin.md's own "Verification"
// section — never only in a worker_report, which isn't reachable from here later.
//
// Run: 1) build, 2) node test/npm-pinned-lock-asset.mjs
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-lock-asset-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION; // exercise the real provisioning logic, not the disabled seam

const {
  ensureNpmPinnedAsync, loomNpmPinnedDir, loomNpmPinnedBin, npmPinnedLockAssetPath, npmPinnedLockContentHash, __setSpawnForTest,
} = await import("../dist/capabilities/npm-pinned.js");

/** A throwaway, valid-SHAPED fixture lock asset — content is never read by the fake spawn below, only
 *  copied byte-for-byte by the real (non-faked) code under test, so its exact content is what (i) checks. */
function writeFixtureLock(targetPath, pkg, version) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "loom-npm-pinned-install", version: "0.0.0", dependencies: { [pkg]: version } },
      [`node_modules/${pkg}`]: { version, resolved: `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`, integrity: "sha512-fixture==" },
    },
  };
  fs.writeFileSync(targetPath, JSON.stringify(lock, null, 2));
  return lock;
}

/** A fake child that writes the expected bin into opts.cwd (modeling a successful `npm ci`) before
 *  settling via "close" — mirrors npm-pinned-provision.mjs's own (8a2)-style fake spawn shape. Captures
 *  every (command, opts) pair it's called with, so a test can assert on the EXACT command string and cwd
 *  contents afterward. */
function makeCapturingSpawn(binRel, pkg) {
  const calls = [];
  const impl = (command, opts) => {
    calls.push({ command, cwd: opts.cwd });
    const ee = new EventEmitter();
    ee.kill = () => {};
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    const binPath = path.join(opts.cwd, "node_modules", pkg, binRel);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "// fake npm-ci-installed bin\n");
    process.nextTick(() => ee.emit("close", 0));
    return ee;
  };
  return { impl, calls };
}

// ===================== (i) the install command is `npm ci`, with a SYNTHESIZED package.json =====================
{
  const pkg = "lock-asset-case-i";
  const version = "1.0.0";
  const binRel = "bin/cli.js";
  const lockPath = path.join(process.env.LOOM_HOME, "fixtures", "case-i-lock.json");
  const committedLock = writeFixtureLock(lockPath, pkg, version);

  const { impl, calls } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(impl);
  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  __setSpawnForTest();

  check("(i) precondition: the install resolved 'ready'", result.outcome === "ready");
  check("(i) the fake spawn was called exactly once", calls.length === 1);
  check("(i) the install command is `npm ci` (never `npm install`)", /^npm ci\b/.test(calls[0]?.command ?? "") && !/npm install/.test(calls[0]?.command ?? ""));
  check("(i) the command carries --ignore-scripts --no-audit --no-fund", /--ignore-scripts/.test(calls[0].command) && /--no-audit/.test(calls[0].command) && /--no-fund/.test(calls[0].command));

  // The temp install dir was renamed into the FINAL dir on success — read the package.json/lock that were
  // actually written there (not from calls[0].cwd, which no longer exists post-rename).
  const finalDir = loomNpmPinnedDir(pkg, version, npmPinnedLockContentHash(lockPath));
  const writtenPkgJson = JSON.parse(fs.readFileSync(path.join(finalDir, "package.json"), "utf8"));
  check("(i) the written package.json is the SYNTHESIZED shape {dependencies:{[pkg]:version}}, not a committed file",
    writtenPkgJson.dependencies?.[pkg] === version && writtenPkgJson.name === "loom-npm-pinned-install");
  const writtenLock = JSON.parse(fs.readFileSync(path.join(finalDir, "package-lock.json"), "utf8"));
  check("(i) the copied lock is object-equal to the committed asset (copied byte-for-byte, never regenerated)", JSON.stringify(writtenLock) === JSON.stringify(committedLock));
}

// ===================== (ii) a non-zero `npm ci` exit classifies as 'install-failed', text preserved =====================
// Honesty note (card 66ab2bc0 Code Review, m2): this does NOT exercise any stale-lock-SPECIFIC detection
// logic — there is none; `ensureNpmPinnedAsync` classifies ANY non-zero exit as 'install-failed' with the
// captured output preserved, generically. This case fakes the real EUSAGE shape npm produces for a
// package.json/lock version mismatch (verified directly against the real npm binary during this card's
// investigation: two real registry versions, package.json wanting one, the lock recording the other —
// "npm error code EUSAGE" + "Invalid: lock file's X does not satisfy Y", non-zero exit, no fetch, no
// extraction) purely so the preserved errorTail is a realistic, recognizable string — it would pass
// identically against pre-66ab2bc0-round-2 code, since nothing here is specific to the lock-content-keyed
// install dir either. See (D1-a)/(D1-b) below for the assertions that are actually new in round 2.
{
  const pkg = "lock-asset-case-ii";
  const version = "1.0.0";
  const binRel = "bin/cli.js";
  const lockPath = path.join(process.env.LOOM_HOME, "fixtures", "case-ii-lock.json");
  writeFixtureLock(lockPath, pkg, version);

  const EUSAGE_TEXT = `npm error code EUSAGE\nnpm error\nnpm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.\nnpm error\nnpm error Invalid: lock file's ${pkg}@${version} does not satisfy ${pkg}@2.0.0`;
  __setSpawnForTest((_command, _opts) => {
    const ee = new EventEmitter();
    ee.kill = () => {};
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    process.nextTick(() => {
      ee.stderr.emit("data", Buffer.from(EUSAGE_TEXT));
      ee.emit("close", 1);
    });
    return ee;
  });
  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  __setSpawnForTest();

  check("(ii) a non-zero `npm ci` exit classifies as 'install-failed', never 'ready'", result.outcome === "install-failed" && result.binary === null);
  check("(ii) the real npm error text is preserved in errorTail", typeof result.errorTail === "string" && result.errorTail.includes("EUSAGE") && result.errorTail.includes("does not satisfy"));
  check("(ii) the FINAL install dir was never created (no partial/wrong tree visible to the hot path)", !fs.existsSync(loomNpmPinnedDir(pkg, version, npmPinnedLockContentHash(lockPath))));
}

// ===================== (iii) a missing lock asset fails CLOSED, before any spawn =====================
{
  const pkg = "lock-asset-case-iii";
  const version = "1.0.0";
  const binRel = "bin/cli.js";
  const missingLockPath = path.join(process.env.LOOM_HOME, "fixtures", "does-not-exist-lock.json");
  check("precondition: the lock asset genuinely does not exist", !fs.existsSync(missingLockPath));

  let spawnCalled = false;
  __setSpawnForTest(() => { spawnCalled = true; throw new Error("must never spawn when the lock asset is missing"); });
  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: missingLockPath });
  __setSpawnForTest();

  check("(iii) a missing lock asset classifies as 'lock-missing', never 'ready' or a silent fallback", result.outcome === "lock-missing" && result.binary === null);
  check("(iii) errorTail names the package/version and the expected asset path", typeof result.errorTail === "string" && result.errorTail.includes(pkg) && result.errorTail.includes(version) && result.errorTail.includes(missingLockPath));
  check("(iii) the fake spawn was NEVER called (checked before any tmp dir / install attempt)", !spawnCalled);
  check("(iii) the FINAL install dir was never created", !fs.existsSync(loomNpmPinnedDir(pkg, version, null)));
  check("(iii) not even the PARENT install dir was created — the check genuinely runs before any mkdirSync", !fs.existsSync(path.dirname(loomNpmPinnedDir(pkg, version, null))));

  // Same contract via the PRODUCTION path (no override) — a package/version with no real committed asset
  // under packages/daemon/assets/npm-pinned-locks/** must ALSO fail closed, never fall back to npm install.
  const prodPkg = "lock-asset-case-iii-prod-path";
  const prodVersion = "1.0.0";
  check("precondition: no real committed asset exists for this throwaway package/version", !fs.existsSync(npmPinnedLockAssetPath(prodPkg, prodVersion)));
  let prodSpawnCalled = false;
  __setSpawnForTest(() => { prodSpawnCalled = true; throw new Error("must never spawn"); });
  const prodResult = await ensureNpmPinnedAsync({ package: prodPkg, version: prodVersion, binRelativeToPackageJson: binRel });
  __setSpawnForTest();
  check("(iii) the PRODUCTION lock-asset path (no override) ALSO fails closed with 'lock-missing'", prodResult.outcome === "lock-missing");
  check("(iii) …and never spawns, via the production path either", !prodSpawnCalled);
}

// ===================== (D1-a) a lock-CONTENT change mints a FRESH dir + a fresh install =====================
// Card 66ab2bc0 round 2: the final install dir is keyed on BOTH version AND a content hash of the
// committed lock — two DIFFERENT lock contents for the SAME package/version (simulating the bump ritual's
// own "regenerate the lock in place for the same version" step) must resolve to two DIFFERENT dirs, and
// the second install must actually run (never short-circuited by the first's now-unrelated tree).
{
  const pkg = "d1-content-keyed-pkg";
  const version = "1.0.0";
  const binRel = "bin/cli.js";

  const lockA = path.join(process.env.LOOM_HOME, "fixtures", "d1-lock-a.json");
  writeFixtureLock(lockA, pkg, version);
  const { impl: implA, calls: callsA } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(implA);
  const resultA = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockA });
  __setSpawnForTest();
  check("(D1-a) precondition: install A (lock content X) resolved 'ready'", resultA.outcome === "ready");
  const hashA = npmPinnedLockContentHash(lockA);
  const dirA = loomNpmPinnedDir(pkg, version, hashA);
  check("(D1-a) install A actually spawned (a real install, not a cache hit)", callsA.length === 1);
  check("(D1-a) install A's final dir exists and matches the hash of lock content X", fs.existsSync(dirA));

  // A DIFFERENT committed lock, same package/version — a different top-level integrity value is enough
  // to change the content hash without needing a different dependency tree shape.
  const lockB = path.join(process.env.LOOM_HOME, "fixtures", "d1-lock-b.json");
  fs.mkdirSync(path.dirname(lockB), { recursive: true });
  fs.writeFileSync(lockB, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "loom-npm-pinned-install", version: "0.0.0", dependencies: { [pkg]: version } },
      [`node_modules/${pkg}`]: { version, resolved: `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`, integrity: "sha512-DIFFERENT-CONTENT==" },
    },
  }, null, 2));
  const { impl: implB, calls: callsB } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(implB);
  const resultB = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockB });
  __setSpawnForTest();
  check("(D1-a) precondition: install B (lock content Y) resolved 'ready'", resultB.outcome === "ready");
  const hashB = npmPinnedLockContentHash(lockB);
  const dirB = loomNpmPinnedDir(pkg, version, hashB);

  check("(D1-a) the two lock contents hash DIFFERENTLY", hashA !== hashB);
  check("(D1-a) the two installs landed in DIFFERENT final dirs", dirA !== dirB);
  check("(D1-a) install B actually spawned a FRESH install (never short-circuited by install A's unrelated tree)", callsB.length === 1);
  check("(D1-a) BOTH final dirs exist independently — B's install never overwrote/reused A's", fs.existsSync(dirA) && fs.existsSync(dirB));
}

// ===================== (D1-b) an OLD-SHAPE (pre-round-2, version-only) dir is NOT treated as ready =====================
{
  const pkg = "d1-old-shape-pkg";
  const version = "1.0.0";
  const binRel = "bin/cli.js";

  // Simulate a PRE-round-2 (version-only, no content-hash suffix) install left over from before this
  // card — a real bin sitting directly at the OLD final-dir shape.
  const oldShapeDir = path.join(process.env.LOOM_HOME, "node", pkg, version);
  const oldBinPath = path.join(oldShapeDir, "node_modules", pkg, binRel);
  fs.mkdirSync(path.dirname(oldBinPath), { recursive: true });
  fs.writeFileSync(oldBinPath, "// pre-round-2 (old-shape) install — must never be mistaken for ready\n");
  check("(D1-b) precondition: the OLD-shape bin exists on disk", fs.existsSync(oldBinPath));

  const lockPath = path.join(process.env.LOOM_HOME, "fixtures", "d1-b-lock.json");
  writeFixtureLock(lockPath, pkg, version);
  const hash = npmPinnedLockContentHash(lockPath);
  const newShapeBin = loomNpmPinnedBin(pkg, version, binRel, hash);
  check("(D1-b) the new hash-suffixed bin path is a DIFFERENT path from the old version-only one", newShapeBin !== oldBinPath);
  check("(D1-b) precondition: the new-shape bin does not exist yet", !fs.existsSync(newShapeBin));

  const { impl, calls } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(impl);
  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  __setSpawnForTest();
  check("(D1-b) resolves 'ready' via a FRESH install into the NEW hash-suffixed dir, never short-circuited by the old-shape dir", result.outcome === "ready" && result.binary === newShapeBin);
  check("(D1-b) a real install was actually attempted (never treated the old-shape dir as already-ready)", calls.length === 1);
}

// ===================== (R3-hotpath) npmPinnedLockContentHash: no stale-null, detects an in-place overwrite =====================
// Card 66ab2bc0 round 3 (Code Review MINOR 1): the memo used to cache a `null` (missing-lock) result
// FOREVER per path, and never invalidated a cached hash when the file's content later changed in place —
// both are now closed by keying the cache on the file's own (mtimeMs, size), re-stat'd on every call.
{
  const lockPath = path.join(process.env.LOOM_HOME, "fixtures", "r3-hotpath-lock.json");
  check("(R3-hotpath) precondition: the lock asset genuinely does not exist yet", !fs.existsSync(lockPath));
  check("(R3-hotpath) npmPinnedLockContentHash returns null for a missing lock", npmPinnedLockContentHash(lockPath) === null);

  // Added AFTER the first (null) call above — a permanently-cached null would make this return null forever.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { x: "1.0.0" } } } }));
  const hash1 = npmPinnedLockContentHash(lockPath);
  check("(R3-hotpath) a lock added AFTER a prior missing-file call is picked up on the VERY NEXT call (no restart)", typeof hash1 === "string" && hash1.length === 12);

  // Overwrite the SAME path in place with genuinely different (and longer, so size alone already
  // differs — robust even if the filesystem's mtime resolution were too coarse to tick within this test).
  fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { x: "2.0.0" } } }, extra: "x".repeat(64) }));
  const hash2 = npmPinnedLockContentHash(lockPath);
  check("(R3-hotpath) an in-place content overwrite is detected on the VERY NEXT call — hash changes, no restart needed", hash2 !== hash1);

  // An UNCHANGED file on a repeat call still returns the SAME hash (the cache still helps the hot path).
  const hash2b = npmPinnedLockContentHash(lockPath);
  check("(R3-hotpath) an unchanged file returns the SAME hash on a repeat call", hash2b === hash2);
}

// ===================== (R3-ensure) ensureNpmPinnedAsync hashes+installs the SAME bytes it read; an
// in-place overwrite of the committed asset reaches a FRESH, correctly-named dir with no restart =====================
// Card 66ab2bc0 round 3 (Code Review MINOR 1 sibling): ensureNpmPinnedAsync used to hash via the memoized
// npmPinnedLockContentHash but then copyFileSync the lock FRESH from disk — a stale cached hash could name
// a dir whose content didn't actually match. It now reads the lock's bytes ONCE, hashes + installs those
// SAME bytes, so the dir name and the installed content can never disagree.
{
  const pkg = "r3-ensure-pkg";
  const version = "1.0.0";
  const binRel = "bin/cli.js";
  const lockPath = path.join(process.env.LOOM_HOME, "fixtures", "r3-ensure-lock.json");

  const lockV1 = writeFixtureLock(lockPath, pkg, version);
  const { impl: impl1, calls: calls1 } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(impl1);
  const result1 = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  __setSpawnForTest();
  check("(R3-ensure) precondition: install 1 (lock content V1) resolved 'ready'", result1.outcome === "ready");
  check("(R3-ensure) install 1 actually spawned (a real install, not a cache hit)", calls1.length === 1);
  const hash1 = npmPinnedLockContentHash(lockPath);
  const dir1 = loomNpmPinnedDir(pkg, version, hash1);
  check("(R3-ensure) install 1 landed at the bin path named after lock content V1's hash", result1.binary === loomNpmPinnedBin(pkg, version, binRel, hash1));
  const writtenLock1 = JSON.parse(fs.readFileSync(path.join(dir1, "package-lock.json"), "utf8"));
  check("(R3-ensure) the installed lock bytes equal what was committed at install time (V1)", JSON.stringify(writtenLock1) === JSON.stringify(lockV1));

  // Overwrite the SAME committed asset path IN PLACE — the bump ritual's sanctioned "transitive-only fix"
  // case — with no process restart, same test run.
  const lockV2 = {
    lockfileVersion: 3,
    packages: {
      "": { name: "loom-npm-pinned-install", version: "0.0.0", dependencies: { [pkg]: version } },
      [`node_modules/${pkg}`]: { version, resolved: `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`, integrity: `sha512-OVERWRITTEN-${"y".repeat(40)}==` },
    },
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockV2, null, 2));

  const { impl: impl2, calls: calls2 } = makeCapturingSpawn(binRel, pkg);
  __setSpawnForTest(impl2);
  const result2 = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  __setSpawnForTest();
  check("(R3-ensure) precondition: install 2 (post-overwrite, lock content V2) resolved 'ready'", result2.outcome === "ready");
  check("(R3-ensure) install 2 actually ran a FRESH install (never short-circuited by install 1's unrelated tree)", calls2.length === 1);
  const hash2 = npmPinnedLockContentHash(lockPath);
  const dir2 = loomNpmPinnedDir(pkg, version, hash2);
  check("(R3-ensure) the overwrite changed the content hash", hash2 !== hash1);
  check("(R3-ensure) install 2 landed in a DIFFERENT, freshly-named dir — reached with NO restart", dir2 !== dir1 && result2.binary === loomNpmPinnedBin(pkg, version, binRel, hash2));
  const writtenLock2 = JSON.parse(fs.readFileSync(path.join(dir2, "package-lock.json"), "utf8"));
  check("(R3-ensure) the dir name (hash2) matches a hash of the EXACT bytes installed under it (V2, never a stale V1)", JSON.stringify(writtenLock2) === JSON.stringify(lockV2));
  const writtenLock1Again = JSON.parse(fs.readFileSync(path.join(dir1, "package-lock.json"), "utf8"));
  check("(R3-ensure) install 1's own dir is untouched — still exists with its OWN (V1) content, never overwritten", fs.existsSync(dir1) && JSON.stringify(writtenLock1Again) === JSON.stringify(lockV1));
}

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the npm-pinned install kind runs `npm ci` (never `npm install`) against a synthesized package.json + the copied committed lock asset, a non-zero `npm ci` exit (the real EUSAGE text shape) classifies as a loud 'install-failed' with the real npm error text preserved, a missing lock asset fails CLOSED (lock-missing, no spawn attempted) both via an explicit override and via the real production lock-asset path, a lock-CONTENT change mints a fresh dir + a fresh install (D1-a), a pre-existing old-shape (version-only) dir is never mistaken for ready (D1-b), the lock-content-hash memo never caches a stale null and detects an in-place overwrite with no restart (R3-hotpath), and ensureNpmPinnedAsync hashes+installs the exact same bytes it read so an in-place overwrite reaches a fresh, correctly-named dir with no restart (R3-ensure)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
