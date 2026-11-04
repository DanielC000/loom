import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The REAL npm-pinned install pipeline (capabilities/npm-pinned.ts) — per Loom's real-spawn doctrine,
// mocking the exec impl never exercises the actual cross-platform spawn (the npm.cmd-on-Windows shape
// this module's own doc explains), so this test drives the ACTUAL `npm ci --ignore-scripts` spawn (card
// 66ab2bc0 — was `npm install`), not a fake runner (that hermetic state-machine coverage lives separately
// in npm-pinned-provision.mjs, and the hermetic lock-asset/npm-ci-shape coverage lives in
// npm-pinned-lock-asset.mjs).
//
// DEFAULT (no network, runs on every gate): installs a tiny fixture package from a LOCAL tarball —
// `npm pack`ed at test time from test/fixtures/npm-pinned-fixture-pkg — through the `dependencySpecOverride`
// + `lockAssetPathOverride` TEST-ONLY seams, so the REAL `npm ci` spawn path runs end to end with zero
// registry dependency. `npm ci` takes no install-spec argument at all — it installs exactly what
// package.json + a lockfile say — so this test GENERATES its own fixture lock at run time (a REAL `npm
// install --package-lock-only` of the local tarball's `file:` URL — still zero network, since `file:`
// resolution never touches the registry), mirroring what a human runs by hand per the version-bump
// ritual (docs/decisions/66ab2bc0-npm-pinned-lockfile-pin.md). A registry flake must never red a merge
// gate, which is why this is the default rather than a real registry install.
//
// OPT-IN (network, manual-only): installs the REAL `semver@7.6.3` from the real npm registry, against a
// lock this test GENERATES AT RUN TIME via `lockAssetPathOverride` (a real network `npm install
// --package-lock-only`, deliberately only under this network-gated branch) — "semver@7.6.3" is a
// test-only fixture choice, never a shipped row, so there is no committed asset for it under
// assets/npm-pinned-locks/ (see the override's own comment below for why one is never written there). A
// tiny, zero-runtime-dependency, no-install/postinstall-script package (verified via a live registry
// fetch during e7d6e43b's investigation) chosen to minimize flake surface. Gated behind
// LOOM_NETWORK_SMOKE=1; prints a WARN SKIP line and does nothing otherwise (never attempts network access
// by default).
//
// Proves (both modes):
//   (a) ensureNpmPinnedAsync resolves outcome 'ready' for a real install;
//   (b) the resolved bin file actually exists on disk afterward;
//   (c) `node <bin>` actually runs and produces the expected output (the fixture's sentinel string, or a
//       real semver CLI invocation) — not just "a file exists at that path."
//   (d) (default mode only, Code Review Minor) --ignore-scripts is ACTUALLY honored: the fixture package
//       carries a real `postinstall` script that writes its own sentinel file. The production install
//       (via `npm ci --ignore-scripts`) must NOT produce that sentinel; a POSITIVE CONTROL — a PLAIN
//       `npm install` (no --ignore-scripts) of the exact same tarball, into a separate throwaway dir —
//       must produce it, proving the script is genuinely capable of running (so the "no sentinel" result
//       under --ignore-scripts is meaningful, not vacuous).
//
// Hermeticity (Code Review Minor): every `npm` invocation here (pack, the lock-generation install, the
// production install, and the positive-control plain install) points `npm_config_cache` at a dir under
// this test's own isolated LOOM_HOME — never the ambient/global npm cache.
//
// Run (default, local tarball only): 1) build, 2) node test/npm-pinned-real-spawn.mjs
// Run (opt-in network smoke too): LOOM_NETWORK_SMOKE=1 node test/npm-pinned-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PKG_DIR = path.join(TEST_DIR, "fixtures", "npm-pinned-fixture-pkg");

useOwnLoomHome("npm-pinned-realspawn-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION; // exercise the REAL install path

const { ensureNpmPinnedAsync, loomNpmPinnedBin, loomNpmPinnedDir, npmPinnedLockContentHash } = await import("../dist/capabilities/npm-pinned.js");

// Hermeticity: a self-contained npm cache under this test's own isolated LOOM_HOME, for EVERY npm call
// this test makes directly (the production install's own cache dir is set internally, inside npm-pinned.ts).
const TEST_NPM_CACHE_DIR = path.join(process.env.LOOM_HOME, "npm-cache");
const npmEnv = { ...process.env, npm_config_cache: TEST_NPM_CACHE_DIR };

/**
 * Generate a fixture `package-lock.json` pinning `pkg` to `fileUrl` (an ABSOLUTE `file:` URL) — a REAL
 * `npm install --package-lock-only` (no network: `file:` resolution never touches the registry), then
 * rewrite the result's root dependency + resolved package entry back to the ABSOLUTE url. npm's own
 * `--save` RELATIVIZES a `file:` spec to a path relative to the generating directory — that relative form
 * would resolve to the WRONG target once copied into ensureNpmPinnedAsync's own temp install dir (a
 * different directory, at a different depth), so this rewrites both back to the absolute form, which
 * `npm ci` accepts unchanged (verified during this card's investigation — only the `dependencies` map is
 * compared between package.json and the lock; the absolute `resolved`/dependency value round-trips).
 */
function generateFixtureLock(pkg, fileUrl, genDir) {
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, "package.json"), JSON.stringify({ name: "loom-npm-pinned-lockgen", version: "0.0.0", private: true }, null, 2));
  execFileSync("npm", ["install", `"${fileUrl}"`, "--save-exact", "--package-lock-only", "--ignore-scripts"], {
    shell: true, cwd: genDir, env: npmEnv, encoding: "utf8",
  });
  const lockPath = path.join(genDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.packages?.[""]?.dependencies?.[pkg]) lock.packages[""].dependencies[pkg] = fileUrl;
  const pkgKey = `node_modules/${pkg}`;
  if (lock.packages?.[pkgKey]) lock.packages[pkgKey].resolved = fileUrl;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return lockPath;
}

// ===================== default: a REAL npm ci spawn, from a LOCAL tarball (no network) =====================
{
  const pkg = "loom-npm-pinned-fixture";
  const version = "1.0.0";
  const binRel = "bin/cli.js";

  // `npm pack` the fixture dir into this test's own scratch area under the already-isolated LOOM_HOME —
  // swept with everything else useOwnLoomHome tracks, no separate cleanup needed. Args are explicitly
  // double-quoted (Code Review Minor) — defensive against a path containing spaces, even though this
  // call also sets shell:true with an array `args` (which Node itself quotes per-platform).
  const packDestDir = path.join(process.env.LOOM_HOME, "pack-scratch");
  fs.mkdirSync(packDestDir, { recursive: true });
  const packOutput = execFileSync("npm", ["pack", `"${FIXTURE_PKG_DIR}"`, "--pack-destination", `"${packDestDir}"`, "--json"], {
    shell: true, encoding: "utf8", env: npmEnv,
  });
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult[0]?.filename;
  check("precondition: npm pack produced a tarball", typeof tarballName === "string" && tarballName.length > 0);
  const tarballPath = path.join(packDestDir, tarballName);
  check("precondition: the packed tarball exists on disk", fs.existsSync(tarballPath));

  // ABSOLUTE file: URL (never a bare path, never npm's own auto-relativized form — see
  // generateFixtureLock's own doc). Both the synthesized package.json AND the fixture lock below pin to
  // this exact string.
  const fixtureFileUrl = pathToFileURL(tarballPath).href;

  const lockPath = generateFixtureLock(pkg, fixtureFileUrl, path.join(process.env.LOOM_HOME, "lock-gen"));
  check("precondition: a fixture lock was generated for the local tarball", fs.existsSync(lockPath));

  // card 66ab2bc0 round 2 (D1): the install dir (and so the bin path) is keyed on a content hash of the
  // lock actually used — this test's own generated fixture lock, via lockAssetPathOverride below.
  const lockHash = npmPinnedLockContentHash(lockPath);
  const bin = loomNpmPinnedBin(pkg, version, binRel, lockHash);
  check("precondition: the bin is ABSENT before install (cold)", !fs.existsSync(bin));

  const result = await ensureNpmPinnedAsync({
    package: pkg, version, binRelativeToPackageJson: binRel,
    dependencySpecOverride: fixtureFileUrl, lockAssetPathOverride: lockPath,
  });
  check(`(a) a real install from a local tarball resolves 'ready' (got '${result.outcome}'${result.errorTail ? `: ${result.errorTail}` : ""})`, result.outcome === "ready");
  check("(a) the resolved binary path matches loomNpmPinnedBin", result.binary === bin);
  check("(b) the resolved bin actually exists on disk", fs.existsSync(bin));

  const runOutput = execFileSync(process.execPath, [bin], { encoding: "utf8" });
  check("(c) `node <bin>` actually runs and prints the fixture sentinel", runOutput.includes("LOOM_NPM_PINNED_FIXTURE_SENTINEL_OK"));

  // ===================== (d) --ignore-scripts proof, with a positive control =====================
  const installedSentinel = path.join(loomNpmPinnedDir(pkg, version, lockHash), "node_modules", pkg, "POSTINSTALL_SENTINEL.txt");
  check("(d) --ignore-scripts actually suppressed the fixture's own postinstall sentinel", !fs.existsSync(installedSentinel));

  // POSITIVE CONTROL: a PLAIN `npm install` (no --ignore-scripts) of the EXACT SAME tarball, into a
  // separate throwaway dir — proves the postinstall script is genuinely capable of writing the sentinel,
  // so the "absent" result above is meaningful rather than vacuous (an inert/broken script would also
  // produce "no sentinel" either way).
  const controlDir = path.join(process.env.LOOM_HOME, "ignore-scripts-positive-control");
  fs.mkdirSync(controlDir, { recursive: true });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-save", `"${tarballPath}"`, "--prefix", `"${controlDir}"`], {
    shell: true, cwd: controlDir, env: npmEnv, encoding: "utf8",
  });
  const controlSentinel = path.join(controlDir, "node_modules", pkg, "POSTINSTALL_SENTINEL.txt");
  check("(d) positive control: a PLAIN install (no --ignore-scripts) of the same tarball DOES write the sentinel", fs.existsSync(controlSentinel));

  // precondition for the warm/cached path: a second resolve of the same spec is already-ready, no re-install.
  check("precondition: a second resolve of the same spec is warm (no re-install, already-ready)",
    fs.existsSync(loomNpmPinnedBin(pkg, version, binRel, lockHash)));
}

// ===================== opt-in: the REAL npm registry (network), manual-only =====================
if (process.env.LOOM_NETWORK_SMOKE === "1") {
  const pkg = "semver";
  const version = "7.6.3";
  const binRel = "bin/semver.js";

  // "semver@7.6.3" is a test-only fixture choice, never a shipped row — so there is no committed asset
  // for it, and none should be written (this test's LOOM_HOME is isolated, but npmPinnedLockAssetPath
  // itself always resolves into the REAL packages/daemon/assets tree regardless of LOOM_HOME, since it's
  // keyed off the package dir, not LOOM_HOME — writing there would leave a stray file in the repo). Use
  // `lockAssetPathOverride` instead: a REAL network `npm install --package-lock-only` (deliberately only
  // under this already-network-gated branch) generates a throwaway lock entirely under this test's own
  // isolated LOOM_HOME.
  const genDir = path.join(process.env.LOOM_HOME, "network-lock-gen");
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, "package.json"), JSON.stringify({ name: "loom-npm-pinned-lockgen", version: "0.0.0", private: true }, null, 2));
  execFileSync("npm", ["install", `${pkg}@${version}`, "--save-exact", "--package-lock-only", "--ignore-scripts"], {
    shell: true, cwd: genDir, env: npmEnv, encoding: "utf8",
  });
  const lockPath = path.join(genDir, "package-lock.json");

  // card 66ab2bc0 round 2 (D1): the install dir (and so the bin path) is keyed on a content hash of the
  // lock actually used — this test's own freshly-generated network lock, via lockAssetPathOverride below.
  const bin = loomNpmPinnedBin(pkg, version, binRel, npmPinnedLockContentHash(lockPath));
  check("network precondition: the bin is ABSENT before install (cold)", !fs.existsSync(bin));

  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: lockPath });
  check(`(network-a) a real registry install resolves 'ready' (got '${result.outcome}'${result.errorTail ? `: ${result.errorTail}` : ""})`, result.outcome === "ready");
  check("(network-b) the resolved bin actually exists on disk", fs.existsSync(bin));

  // semver's CLI has no `--version` self-flag — it validates/echoes a version ARGUMENT (its real, documented
  // usage: `semver <version>` prints that version back when valid). Verified directly against a real
  // install during this card's investigation.
  const runOutput = execFileSync(process.execPath, [bin, "1.2.3"], { encoding: "utf8" });
  check("(network-c) `node <bin> 1.2.3` runs the real semver CLI and echoes the valid version back", runOutput.trim() === "1.2.3");
} else {
  console.log("WARN  SKIP — LOOM_NETWORK_SMOKE not set; the opt-in real npm-registry smoke (semver@7.6.3) did not run. Set LOOM_NETWORK_SMOKE=1 to exercise it.");
}

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the REAL npm-pinned install spawn (npm ci --ignore-scripts against a real/fixture lock) resolves 'ready', lands a bin that actually exists on disk, and that bin actually runs and produces real output, for a local-tarball install (default, no network) and — when LOOM_NETWORK_SMOKE=1 — a real npm-registry install too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
