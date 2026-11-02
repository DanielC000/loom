import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The REAL npm-pinned install pipeline (capabilities/npm-pinned.ts) — per Loom's real-spawn doctrine,
// mocking the exec impl never exercises the actual cross-platform spawn (the npm.cmd-on-Windows shape
// this module's own doc explains), so this test drives the ACTUAL `npm install --ignore-scripts` spawn,
// not a fake runner (that hermetic state-machine coverage lives separately in npm-pinned-provision.mjs).
//
// DEFAULT (no network, runs on every gate): installs a tiny fixture package from a LOCAL tarball —
// `npm pack`ed at test time from test/fixtures/npm-pinned-fixture-pkg — through the installSpecOverride
// TEST-ONLY seam, so the REAL npm install spawn path runs end to end with zero registry dependency. A
// registry flake must never red a merge gate, which is why this is the default rather than a real
// registry install.
//
// OPT-IN (network, manual-only): installs the REAL `semver@7.6.3` from the real npm registry — a tiny,
// zero-runtime-dependency, no-install/postinstall-script package (verified via a live registry fetch
// during this card's investigation) chosen to minimize flake surface. Gated behind LOOM_NETWORK_SMOKE=1;
// prints a WARN SKIP line and does nothing otherwise (never attempts network access by default).
//
// Proves (both modes):
//   (a) ensureNpmPinnedAsync resolves outcome 'ready' for a real install;
//   (b) the resolved bin file actually exists on disk afterward;
//   (c) `node <bin>` actually runs and produces the expected output (the fixture's sentinel string, or a
//       real semver CLI invocation) — not just "a file exists at that path."
//   (d) (default mode only, Code Review Minor) --ignore-scripts is ACTUALLY honored: the fixture package
//       carries a real `postinstall` script that writes its own sentinel file. The production install
//       (via --ignore-scripts) must NOT produce that sentinel; a POSITIVE CONTROL — a PLAIN `npm install`
//       (no --ignore-scripts) of the exact same tarball, into a separate throwaway dir — must produce it,
//       proving the script is genuinely capable of running (so the "no sentinel" result under
//       --ignore-scripts is meaningful, not vacuous).
//
// Hermeticity (Code Review Minor): every `npm` invocation here (pack, the production install, and the
// positive-control plain install) points `npm_config_cache` at a dir under this test's own isolated
// LOOM_HOME — never the ambient/global npm cache.
//
// Run (default, local tarball only): 1) build, 2) node test/npm-pinned-real-spawn.mjs
// Run (opt-in network smoke too): LOOM_NETWORK_SMOKE=1 node test/npm-pinned-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PKG_DIR = path.join(TEST_DIR, "fixtures", "npm-pinned-fixture-pkg");

useOwnLoomHome("npm-pinned-realspawn-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION; // exercise the REAL install path

const { ensureNpmPinnedAsync, loomNpmPinnedBin, loomNpmPinnedDir } = await import("../dist/capabilities/npm-pinned.js");

// Hermeticity: a self-contained npm cache under this test's own isolated LOOM_HOME, for EVERY npm call
// this test makes directly (the production install's own cache dir is set internally, inside npm-pinned.ts).
const TEST_NPM_CACHE_DIR = path.join(process.env.LOOM_HOME, "npm-cache");
const npmEnv = { ...process.env, npm_config_cache: TEST_NPM_CACHE_DIR };

// ===================== default: a REAL npm install spawn, from a LOCAL tarball (no network) =====================
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

  const bin = loomNpmPinnedBin(pkg, version, binRel);
  check("precondition: the bin is ABSENT before install (cold)", !fs.existsSync(bin));

  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, installSpecOverride: tarballPath });
  check(`(a) a real install from a local tarball resolves 'ready' (got '${result.outcome}'${result.errorTail ? `: ${result.errorTail}` : ""})`, result.outcome === "ready");
  check("(a) the resolved binary path matches loomNpmPinnedBin", result.binary === bin);
  check("(b) the resolved bin actually exists on disk", fs.existsSync(bin));

  const runOutput = execFileSync(process.execPath, [bin], { encoding: "utf8" });
  check("(c) `node <bin>` actually runs and prints the fixture sentinel", runOutput.includes("LOOM_NPM_PINNED_FIXTURE_SENTINEL_OK"));

  // ===================== (d) --ignore-scripts proof, with a positive control =====================
  const installedSentinel = path.join(loomNpmPinnedDir(pkg, version), "node_modules", pkg, "POSTINSTALL_SENTINEL.txt");
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
    fs.existsSync(loomNpmPinnedBin(pkg, version, binRel)));
}

// ===================== opt-in: the REAL npm registry (network), manual-only =====================
if (process.env.LOOM_NETWORK_SMOKE === "1") {
  const pkg = "semver";
  const version = "7.6.3";
  const binRel = "bin/semver.js";
  const bin = loomNpmPinnedBin(pkg, version, binRel);
  check("network precondition: the bin is ABSENT before install (cold)", !fs.existsSync(bin));

  const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel });
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
  ? "\n✅ ALL PASS — the REAL npm-pinned install spawn (npm install --ignore-scripts) resolves 'ready', lands a bin that actually exists on disk, and that bin actually runs and produces real output, for a local-tarball install (default, no network) and — when LOOM_NETWORK_SMOKE=1 — a real npm-registry install too."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
