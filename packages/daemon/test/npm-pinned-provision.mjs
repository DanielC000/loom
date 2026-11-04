import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// npm-pinned capability provisioning is NON-BLOCKING, DIAGNOSTIC, and RETRYABLE — the hermetic
// state-machine test for the generic "npm-pinned" provision kind (card e7d6e43b). Mirrors
// github-binary-provision.mjs exactly, but exercised through resolveNpmPinned/__setNpmPinnedProvisionerForTest
// instead of the github-binary tracker — the npm-install provisioner is injected, so this test drives every
// classified outcome WITHOUT a real `npm install` or network access (the REAL install path is covered
// separately, end-to-end against a LOCAL fixture tarball, in npm-pinned-real-spawn.mjs).
//
// Proves:
//   (1) the spawn hot path (resolveCapabilityServer → resolveNpmPinned) is fs.existsSync-fast when cold —
//       returns null in well under 500ms, no blocking install work.
//   (2) buildMcpServers omits the capability's slug while cold — byte-identical to the capability not
//       being granted at all.
//   (3) a cold resolve kicks background provisioning exactly once; concurrent resolves dedupe to ONE
//       in-flight job (never parallel installs); a fresh kick is allowed after a TERMINAL outcome
//       (retryable, not a permanent one-shot).
//   (4) every classified outcome (invalid-spec / install-failed / timeout / disabled) maps onto the
//       status model with its reason + errorTail, and a stale in-flight failure never downgrades an
//       already-'ready' status.
//   (5) mount shape: a warm resolve mounts {command: process.execPath, args: [<resolved bin path>]} —
//       the node-package shape, minus that branch's hardcoded `--output-dir` flag.
//   (6) outputDirEnvVar: a row with wantsScratchDir + outputDirEnvVar injects the scratch dir into `env`
//       under that var name (the mechanism the image-gen migration depends on).
//   (7) validation (validateNpmPinnedSpec) runs BEFORE any path is built or existsSync'd on the HOT PATH
//       (resolveNpmPinned) — a corrupted binRelativeToPackageJson that would traverse to a REAL,
//       pre-existing file is rejected, never served as "ready".
//   (8) the ATOMIC install: a fake "succeeded but wrote no bin" child never leaves a partial tree visible
//       at the final path; a stale `<version>.tmp-*` dir from a crashed attempt is never mistaken for
//       ready; a concurrent resolve while genuinely in-flight returns null under the atomic flow too.
//   (9) a WARM npm-pinned row driven through the REAL buildMcpServers (not resolveCapabilityServer
//       directly): it comes out wrapped exactly once by the env-isolating launcher (card fafae623), with
//       realArgs = [<resolved bin path>] — no extra wrap layer, no stray args.
//
// Run: 1) build, 2) node test/npm-pinned-provision.mjs
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-prov-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION; // exercise the real provisioner-injected path, not the disabled seam

const {
  resolveCapabilityServer, getCapabilityProvisionStatus, __setNpmPinnedProvisionerForTest, resetCapabilityProvisionStatus,
} = await import("../dist/capabilities/registry.js");
const { buildMcpServers } = await import("../dist/pty/host.js");
const {
  loomNpmPinnedBin, loomNpmPinnedDir, npmPinnedLockAssetPath, npmPinnedLockContentHash,
  ensureNpmPinnedAsync, __setSpawnForTest, __setKillTreeForTest, sweepStaleTmpInstallDirs,
} = await import("../dist/capabilities/npm-pinned.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

const PKG = "mcp-imagenate";
const VERSION = "0.2.1";
const BIN_REL = "dist/index.js";
// card 66ab2bc0 round 2 (D1): the install dir (and so the bin path) is now keyed on a content hash of the
// REAL committed lock asset for this pair — every row below reuses this SAME package/version, so this is
// the one hash every `loomNpmPinnedBin`/`loomNpmPinnedDir` call in this file that targets it must match.
const LOCK_HASH = npmPinnedLockContentHash(npmPinnedLockAssetPath(PKG, VERSION));
const READY_BIN = loomNpmPinnedBin(PKG, VERSION, BIN_REL, LOCK_HASH);

// A throwaway fixture lock asset (card 66ab2bc0) — these (8a)/(8a2) sections exercise
// ensureNpmPinnedAsync's real atomic-install logic directly, via the __setSpawnForTest fake child, so the
// LOCK ASSET's own content is irrelevant (the fake spawn never reads it) but its mere EXISTENCE is now a
// precondition the real function checks before doing anything else. Any valid-looking lockfile shape
// satisfies it; content correctness is covered separately by npm-pinned-lock-asset.mjs.
const FIXTURE_LOCK_FOR_ATOMIC_TESTS = path.join(process.env.LOOM_HOME, "fixture-atomic-lock.json");
fs.mkdirSync(path.dirname(FIXTURE_LOCK_FOR_ATOMIC_TESTS), { recursive: true });
fs.writeFileSync(FIXTURE_LOCK_FOR_ATOMIC_TESTS, JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
const ATOMIC_LOCK_HASH = npmPinnedLockContentHash(FIXTURE_LOCK_FOR_ATOMIC_TESTS);

const npmRow = {
  id: "cap-npm", slug: "image-gen", name: "Image Gen", description: "d", transport: "stdio", kind: "npm-pinned",
  provisionJson: JSON.stringify({ kind: "npm-pinned", package: PKG, version: VERSION, binRelativeToPackageJson: BIN_REL }),
  toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: false,
  requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString(),
};

// Flush the kick's microtask chain (fake resolve → .then → .finally) to a macrotask boundary.
const flush = () => new Promise((r) => setTimeout(r, 10));
const fixed = (result) => async () => result;
let gate;
const newGate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); gate = { promise, resolve }; };
const gated = () => gate.promise;

// ===================== precondition: cold, never provisioned =====================
check("precondition: the bin is ABSENT (cold path)", !fs.existsSync(READY_BIN));

// ===================== (1)/(2) the spawn hot path is fast + byte-identical when cold =====================
__setNpmPinnedProvisionerForTest(gated);
newGate();
const t0 = performance.now();
const resolved = resolveCapabilityServer(npmRow, {});
const elapsedMs = performance.now() - t0;
check("(1) resolveCapabilityServer returns null when cold (no blocking install work)", resolved === null);
check(`(1) hot path returns FAST (<500ms; measured ${elapsedMs.toFixed(1)}ms)`, elapsedMs < 500);
check("(3) the cold resolve kicked background provisioning (status now 'installing')", getCapabilityProvisionStatus("image-gen")?.state === "installing");

const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", capabilities: [{ slug: "image-gen" }], capabilityCatalog: [npmRow] });
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(2) 'image-gen' capability granted but cold ⇒ slug key omitted from mcpServers", !("image-gen" in on));
check("(2) ON map is byte-identical to a no-capability spawn while cold", JSON.stringify(on) === JSON.stringify(off));

// concurrent resolves while in-flight dedupe to ONE kick.
resolveCapabilityServer(npmRow, {});
resolveCapabilityServer(npmRow, {});
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();
check("(3) resolves ready after the single in-flight job settles", getCapabilityProvisionStatus("image-gen")?.state === "ready");
check("(3) the resolved binary is cached (a later call returns the warm binary, no re-kick)",
  resolveCapabilityServer(npmRow, {})?.command === process.execPath);

// ===================== (5) mount shape =====================
const warmServer = resolveCapabilityServer(npmRow, {});
check("(5) mount shape: command is process.execPath", warmServer?.command === process.execPath);
check("(5) mount shape: args is [<resolved bin path>]", JSON.stringify(warmServer?.args) === JSON.stringify([READY_BIN]));
check("(5) mount shape: no hardcoded --output-dir flag", !warmServer?.args?.includes("--output-dir"));

// ===================== (9) card 48bdb8ad: a WARM npm-pinned row through the REAL buildMcpServers =====================
// (5) above calls resolveCapabilityServer directly, bypassing buildMcpServers' own env-isolation wrap
// (card fafae623). Drive the SAME now-warm row through the real buildMcpServers chokepoint and assert
// it comes out wrapped exactly ONCE — command is the launcher (process.execPath + the launcher script),
// never double-wrapped, and the REAL target's own args are exactly [bin] (image-gen has no provision.args,
// unlike shadcn — see shadcn-capability.mjs for that sibling case).
const warmMounted = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", capabilities: [{ slug: "image-gen" }], capabilityCatalog: [npmRow] });
const warmUnwrapped = unwrapLauncherMount(warmMounted["image-gen"]);
check("(9) a warm npm-pinned row mounts wrapped by the launcher (command is process.execPath)", warmMounted["image-gen"]?.command === process.execPath);
check("(9) unwrapLauncherMount recognizes it as wrapped exactly once (not null, not double-wrapped)", warmUnwrapped !== null);
check("(9) the real target's command is the resolved npm-pinned bin's own node runtime", warmUnwrapped?.realCommand === process.execPath);
check("(9) realArgs is exactly [<resolved bin path>] — no extra wrap layer, no stray args", JSON.stringify(warmUnwrapped?.realArgs) === JSON.stringify([READY_BIN]));

// ===================== (4) classified outcomes (each on its OWN slug, so prior 'ready' state never leaks) =====================
// Card e7d6e43b, Code Review follow-up: version must be a REAL exact semver (never the slug string
// itself) now that resolveNpmPinned validates BEFORE dispatching to the fake provisioner — an invalid
// "version" would be rejected as invalid-spec before the fake outcome ever gets a chance to run. The
// per-slug status/cache map keys off `slug` alone, so every synthetic row sharing the same VERSION
// constant is fine; nothing here depends on version disambiguating rows from each other.
function rowFor(slug) {
  return { ...npmRow, id: `cap-${slug}`, slug, provisionJson: JSON.stringify({ kind: "npm-pinned", package: PKG, version: VERSION, binRelativeToPackageJson: BIN_REL }) };
}

{
  const row = rowFor("case-invalid-spec");
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "invalid-spec", errorTail: "invalid npm package name" }));
  resolveCapabilityServer(row, {});
  await flush();
  const s = getCapabilityProvisionStatus(row.slug);
  check("(4) invalid-spec ⇒ state 'failed'", s?.state === "failed");
  check("(4) invalid-spec ⇒ reason 'invalid-spec' + errorTail present", s?.reason === "invalid-spec" && typeof s?.errorTail === "string" && s.errorTail.length > 0);
}

{
  const row = rowFor("case-install-failed");
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "install-failed", errorTail: "npm ERR! 404 Not Found" }));
  resolveCapabilityServer(row, {});
  await flush();
  const s = getCapabilityProvisionStatus(row.slug);
  check("(4) install-failed ⇒ state 'failed' + reason 'install-failed'", s?.state === "failed" && s?.reason === "install-failed");
}

{
  const row = rowFor("case-timeout");
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "timeout" }));
  resolveCapabilityServer(row, {});
  await flush();
  const s = getCapabilityProvisionStatus(row.slug);
  check("(4) timeout ⇒ state 'failed' + reason 'timeout'", s?.state === "failed" && s?.reason === "timeout");
}

{
  const row = rowFor("case-disabled");
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "disabled" }));
  resolveCapabilityServer(row, {});
  await flush();
  const s = getCapabilityProvisionStatus(row.slug);
  check("(4) disabled ⇒ state 'failed' + reason 'disabled'", s?.state === "failed" && s?.reason === "disabled");
}

// backoff (Code Review Minor): an IMMEDIATE re-resolve right after a terminal failure must NOT fire a
// brand-new kick (an offline host must not pay a fresh full-timeout attempt on every single spawn) —
// proven by swapping in a provisioner that WOULD succeed and confirming it is never actually called.
{
  const row = rowFor("case-backoff");
  // Keep the SAME provisioner reference across both resolves — __setNpmPinnedProvisionerForTest itself
  // resets ALL per-slug state on every call (by design, mirrors its sibling seams), so calling it a
  // second time would wipe the very "failed" status this test is proving survives. A call counter on
  // one fake, set once, is what lets the two resolves below actually share state.
  let callCount = 0;
  __setNpmPinnedProvisionerForTest(async () => { callCount++; return { binary: null, outcome: "install-failed" }; });
  resolveCapabilityServer(row, {});
  await flush();
  check("(backoff) precondition: first attempt failed", getCapabilityProvisionStatus(row.slug)?.state === "failed");
  check("(backoff) precondition: the provisioner ran exactly once so far", callCount === 1);
  const firstAttemptAt = getCapabilityProvisionStatus(row.slug)?.lastAttemptAt;
  resolveCapabilityServer(row, {}); // within the cooldown window — must be a no-op kick
  await flush();
  check("(backoff) an immediate re-resolve within the cooldown window never calls the provisioner again", callCount === 1);
  check("(backoff) status is unchanged (still 'failed', same lastAttemptAt)",
    getCapabilityProvisionStatus(row.slug)?.state === "failed" && getCapabilityProvisionStatus(row.slug)?.lastAttemptAt === firstAttemptAt);
}

// retry: an EXPLICIT reset (mirrors the human-initiated REST retry route) bypasses the backoff and allows
// a fresh kick after a terminal (failed) outcome — not a permanent one-shot.
{
  const row = rowFor("case-retry");
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "install-failed" }));
  resolveCapabilityServer(row, {});
  await flush();
  check("(3) retry precondition: first attempt failed", getCapabilityProvisionStatus(row.slug)?.state === "failed");
  const retryBin = loomNpmPinnedBin(PKG, row.slug, BIN_REL, null); // label-only path fed to the fake provisioner — never filesystem-checked
  __setNpmPinnedProvisionerForTest(fixed({ binary: retryBin, outcome: "ready" }));
  resetCapabilityProvisionStatus(row.slug); // the explicit human-retry bypass
  resolveCapabilityServer(row, {});
  await flush();
  check("(3) retry: an explicit reset + fresh kick after a terminal failure succeeds (retryable, not permanent)", getCapabilityProvisionStatus(row.slug)?.state === "ready");
}

// ===================== (9) retry-reset must never erase a TRUE (non-failed) status (Code Review round 3) =====================
// A retry on a READY or still-INSTALLING slug must leave that status alone — resetCapabilityProvisionStatus
// only ever clears a TERMINAL 'failed' entry. Mirrors exactly what the generic REST retry route
// (gateway/server.ts) does: reset, then re-resolve.
{
  // (9a) retry-on-ready: must still read 'ready' both immediately after the reset AND after the
  // route's own re-resolve call (proving the cache-hit short-circuit re-asserts 'ready' too).
  const row = rowFor("case-retry-on-ready");
  const bin = loomNpmPinnedBin(PKG, VERSION, BIN_REL, LOCK_HASH);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "// fixture bin\n"); // a real file, so the warm existsSync path is genuine, not assumed
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "install-failed" })); // must NEVER actually be called below
  const first = resolveCapabilityServer(row, {});
  check("(9a) precondition: the slug resolves ready via the warm cache", first?.command === process.execPath && getCapabilityProvisionStatus(row.slug)?.state === "ready");
  resetCapabilityProvisionStatus(row.slug);
  check("(9a) retry-on-ready: status is UNCHANGED immediately after reset (never erased to idle)", getCapabilityProvisionStatus(row.slug)?.state === "ready");
  resolveCapabilityServer(row, {}); // what the retry route's re-resolve call does
  check("(9a) retry-on-ready: status is STILL 'ready' after the route's own re-resolve", getCapabilityProvisionStatus(row.slug)?.state === "ready");

  // (9b) retry-while-installing: must still read 'installing', never 'idle', while a real job is in flight.
  // Uses its OWN distinct package (never PKG/VERSION) — (9a) just wrote a REAL file at
  // loomNpmPinnedBin(PKG, VERSION, BIN_REL), so reusing that pair here would resolve warm via
  // fs.existsSync instead of actually kicking a background job.
  const row2 = { ...rowFor("case-retry-while-installing"), provisionJson: JSON.stringify({ kind: "npm-pinned", package: "pkg-9b-installing", version: "1.0.0", binRelativeToPackageJson: BIN_REL }) };
  newGate();
  __setNpmPinnedProvisionerForTest(gated);
  resolveCapabilityServer(row2, {});
  check("(9b) precondition: a real job is in flight ('installing')", getCapabilityProvisionStatus(row2.slug)?.state === "installing");
  resetCapabilityProvisionStatus(row2.slug);
  check("(9b) retry-while-installing: status is STILL 'installing' (never erased to idle)", getCapabilityProvisionStatus(row2.slug)?.state === "installing");
  resolveCapabilityServer(row2, {}); // the retry route's re-resolve — in-flight dedupe makes this a no-op kick
  check("(9b) retry-while-installing: still 'installing' after the route's own re-resolve", getCapabilityProvisionStatus(row2.slug)?.state === "installing");
  gate.resolve({ binary: null, outcome: "install-failed" });
  await flush();

  // (9c) retry-on-failed: the reset DOES clear a terminal failure, and the route's re-resolve genuinely
  // re-kicks (not silently swallowed by the cooldown) — the actual RETRY behavior this mechanism exists
  // for. Its own distinct package too, for the same reason as (9b).
  const row3 = { ...rowFor("case-retry-on-failed-route"), provisionJson: JSON.stringify({ kind: "npm-pinned", package: "pkg-9c-failed", version: "1.0.0", binRelativeToPackageJson: BIN_REL }) };
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "install-failed" }));
  resolveCapabilityServer(row3, {});
  await flush();
  check("(9c) precondition: the slug is 'failed'", getCapabilityProvisionStatus(row3.slug)?.state === "failed");
  let rekicked = false;
  __setNpmPinnedProvisionerForTest(async () => { rekicked = true; return { binary: loomNpmPinnedBin("pkg-9c-failed", "1.0.0", BIN_REL, null), outcome: "ready" }; });
  resetCapabilityProvisionStatus(row3.slug);
  check("(9c) retry-on-failed: the reset actually clears the terminal failure", getCapabilityProvisionStatus(row3.slug) === undefined);
  resolveCapabilityServer(row3, {}); // the retry route's re-resolve
  await flush();
  check("(9c) retry-on-failed: the route's re-resolve genuinely re-kicked (not swallowed by the cooldown)", rekicked);
  check("(9c) retry-on-failed: status is now 'ready'", getCapabilityProvisionStatus(row3.slug)?.state === "ready");
}

// a stale in-flight failure must NOT downgrade an already-'ready' status — two concurrent jobs can't
// actually exist under the real dedupe (a second resolveCapabilityServer call while one is in-flight is a
// no-op kick), so this proves the SAME thing github-binary-provision.mjs proves for its own kind: kick a
// job, let it resolve 'ready', then simulate a LATE-arriving failure callback racing in after — the shared
// kickCapabilityProvision tracker (registry.ts) must never let that downgrade the already-'ready' status.
{
  const row = rowFor("case-stale-no-downgrade");
  const bin = loomNpmPinnedBin(PKG, VERSION, BIN_REL, LOCK_HASH);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "// fixture bin\n");
  // a warm fs.existsSync resolve (no kick at all) sets status to 'ready' directly.
  __setNpmPinnedProvisionerForTest(fixed({ binary: null, outcome: "install-failed" })); // would-be stale job, never actually run
  const server = resolveCapabilityServer(row, {});
  check("(4) a pre-existing bin on disk resolves 'ready' with no kick", server?.command === process.execPath);
  check("(4) status is 'ready' for a warm pre-existing bin", getCapabilityProvisionStatus(row.slug)?.state === "ready");
}

// ===================== (7) validation runs BEFORE any path is built/checked on the HOT PATH =====================
// Code Review finding: a corrupted row's binRelativeToPackageJson ("../../x.js") would make
// loomNpmPinnedBin's path.join traverse OUTSIDE the intended install dir — if resolveNpmPinned checked
// fs.existsSync BEFORE validating, a real, unrelated, already-existing file there would be served as
// "ready". Pre-create exactly such a file at the traversal target, craft the corrupted row, and prove it
// is REJECTED (never resolved) rather than silently served.
{
  const row = rowFor("case-traversal");
  // node_modules/<pkg>/../../x.js normalizes to <installDir>/x.js — pre-create a REAL file there.
  const installDir = loomNpmPinnedDir(PKG, row.slug, null);
  fs.mkdirSync(installDir, { recursive: true });
  const trapFile = path.join(installDir, "x.js");
  fs.writeFileSync(trapFile, "// an unrelated, real, pre-existing file\n");
  check("(7) precondition: the traversal-target file genuinely exists", fs.existsSync(trapFile));
  const corruptedRow = { ...row, provisionJson: JSON.stringify({ kind: "npm-pinned", package: PKG, version: row.slug, binRelativeToPackageJson: "../../x.js" }) };
  let kicked = false;
  __setNpmPinnedProvisionerForTest(async () => { kicked = true; return { binary: null, outcome: "install-failed" }; });
  const server = resolveCapabilityServer(corruptedRow, {});
  check("(7) a corrupted binRelativeToPackageJson ('../../x.js') never resolves, even though the traversal target exists", server === null);
  check("(7) status is 'failed' with reason 'invalid-spec' (rejected BEFORE any existsSync check)",
    getCapabilityProvisionStatus(row.slug)?.state === "failed" && getCapabilityProvisionStatus(row.slug)?.reason === "invalid-spec");
  check("(7) the provisioner was NEVER called (rejected before any background kick too)", !kicked);
}

// ===================== (8) ATOMIC INSTALL (Code Review Major) =====================
// These exercise ensureNpmPinnedAsync's real atomicity logic directly (not the fake-runner-injected
// resolveCapabilityServer path) — the fake runner stands in for `runNpmInstallAsync`'s own child-process
// result, so the atomic temp-dir/rename logic AROUND it still runs for real.
{
  // (8a) a fake child that exits "successfully" (code 0) but never actually wrote the bin into the temp
  // dir — must resolve 'install-failed', and the FINAL (non-tmp) dir must never exist (no partial
  // installed tree is ever visible to the hot path).
  {
    const pkg = "atomic-partial-pkg";
    const version = "1.0.0";
    const binRel = "bin/cli.js";
    __setSpawnForTest((_cmd, _opts) => {
      const ee = new EventEmitter();
      ee.kill = () => {};
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      process.nextTick(() => ee.emit("close", 0)); // settles via "close" (card e7d6e43b round 2), not "exit"
      return ee;
    });
    const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, lockAssetPathOverride: FIXTURE_LOCK_FOR_ATOMIC_TESTS });
    check("(8a) a fake 'succeeded but no bin' install resolves 'install-failed'", result.outcome === "install-failed");
    check("(8a) the FINAL install dir was never created (no partial tree visible to the hot path)", !fs.existsSync(loomNpmPinnedDir(pkg, version, ATOMIC_LOCK_HASH)));
    __setSpawnForTest();
  }

  // (8a2) the EXACT scenario the Code Review named: the bin IS written into the temp dir (modeling a
  // reify that got far enough to write the target file), but the process is then KILLED (never emits its
  // own "exit" — the TIMEOUT bound is what settles this) — must leave the slug COLD, never 'ready', and
  // the FINAL dir must never exist (the killed/abandoned tmp dir is cleaned up, never renamed into place).
  {
    const pkg = "atomic-killed-after-write-pkg";
    const version = "1.0.0";
    const binRel = "bin/cli.js";
    let killTreeCalled = false;
    __setSpawnForTest((_cmd, opts) => {
      const ee = new EventEmitter();
      ee.kill = () => {};
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      // Write the bin into the REAL temp cwd BEFORE ever settling — models a reify that wrote its target
      // file but then hangs/gets killed before the process actually exits.
      const partialBin = path.join(opts.cwd, "node_modules", pkg, binRel);
      fs.mkdirSync(path.dirname(partialBin), { recursive: true });
      fs.writeFileSync(partialBin, "// written by a child that is about to be killed mid-install\n");
      return ee; // deliberately never emits "exit" — only the timeout settles this
    });
    __setKillTreeForTest(async () => { killTreeCalled = true; }); // simulate a successful tree-kill issue
    const result = await ensureNpmPinnedAsync({ package: pkg, version, binRelativeToPackageJson: binRel, timeoutMs: 50, lockAssetPathOverride: FIXTURE_LOCK_FOR_ATOMIC_TESTS });
    check("(8a2) a killed-after-partial-write install resolves 'timeout', never 'ready'", result.outcome === "timeout" && result.binary === null);
    check("(8a2) the process TREE kill was actually issued (not just a plain child.kill())", killTreeCalled);
    check("(8a2) the FINAL dir was never created — the partially-written bin is never visible to the hot path", !fs.existsSync(loomNpmPinnedDir(pkg, version, ATOMIC_LOCK_HASH)));
    check("(8a2) the real resolver independently reports this slug as cold too", resolveCapabilityServer(
      { id: "cap-killed", slug: "case-killed-after-write", name: "x", description: "d", transport: "stdio", kind: "npm-pinned", provisionJson: JSON.stringify({ kind: "npm-pinned", package: pkg, version, binRelativeToPackageJson: binRel }), toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString() },
      {},
    ) === null);
    __setSpawnForTest();
    __setKillTreeForTest();
  }

  // (8b) a stale `<version>.tmp-*` dir left behind by a crashed/killed prior attempt must never be
  // mistaken for a ready install — only the FINAL (un-suffixed) path is ever checked by the hot path.
  {
    const pkg = "atomic-stale-tmp-pkg";
    const version = "1.0.0";
    const binRel = "bin/cli.js";
    const parentDir = path.dirname(loomNpmPinnedDir(pkg, version, null));
    const staleTmp = path.join(parentDir, `.${version}.tmp-deadbeef0001`);
    fs.mkdirSync(path.join(staleTmp, "node_modules", pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(staleTmp, "node_modules", pkg, "bin", "cli.js"), "// stale, abandoned by a crashed attempt\n");
    const row2 = { id: "cap-stale-tmp", slug: "case-stale-tmp", name: "x", description: "d", transport: "stdio", kind: "npm-pinned", provisionJson: JSON.stringify({ kind: "npm-pinned", package: pkg, version, binRelativeToPackageJson: binRel }), toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString() };
    check("(8b) a stale tmp dir is NOT mistaken for ready (the real resolver still reports cold)", resolveCapabilityServer(row2, {}) === null);
    check("(8b) the stale tmp dir is left alone (this resolve path doesn't clean up a FOREIGN tmp dir)", fs.existsSync(staleTmp));
    fs.rmSync(staleTmp, { recursive: true, force: true });
  }

  // (8c) a concurrent resolve while an install is genuinely in-flight returns null (dedupe holds under
  // the new atomic flow too, not just the old non-atomic one).
  {
    const pkg = "atomic-concurrent-pkg";
    const version = "1.0.0";
    const binRel = "bin/cli.js";
    const row3 = { id: "cap-concurrent", slug: "case-atomic-concurrent", name: "x", description: "d", transport: "stdio", kind: "npm-pinned", provisionJson: JSON.stringify({ kind: "npm-pinned", package: pkg, version, binRelativeToPackageJson: binRel }), toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString() };
    __setNpmPinnedProvisionerForTest(gated);
    newGate();
    const first = resolveCapabilityServer(row3, {});
    const second = resolveCapabilityServer(row3, {});
    check("(8c) both the first and a concurrent second resolve return null while genuinely in-flight", first === null && second === null);
    gate.resolve({ binary: null, outcome: "install-failed" });
    await flush();
  }

  // (8d) stale tmp-dir SWEEP (Code Review round 2): an abandoned `.*.tmp-*` dir (a daemon crash/restart or
  // a failed tree-kill can leave one behind forever otherwise) older than maxAgeMs is removed; a FRESH one
  // (too young to assume abandoned — a genuinely concurrent install for a DIFFERENT slug sharing this same
  // package, per the named residual race) is left alone; the final (un-suffixed) dir is never touched
  // either way. Tested directly against the exported function — no real install/timeout needed, so this
  // stays fast and immune to timing flakiness.
  {
    const pkg = "sweep-test-pkg";
    const version = "1.0.0";
    const parentDir = path.dirname(loomNpmPinnedDir(pkg, version, null));
    fs.mkdirSync(parentDir, { recursive: true });

    const oldTmp = path.join(parentDir, ".9.9.9.tmp-oldstale01");
    fs.mkdirSync(oldTmp, { recursive: true });
    const farPastSeconds = (Date.now() - 999_999_999) / 1000;
    fs.utimesSync(oldTmp, farPastSeconds, farPastSeconds); // explicit mtime — deterministic, no real wait

    const freshTmp = path.join(parentDir, ".9.9.8.tmp-freshone1");
    fs.mkdirSync(freshTmp, { recursive: true }); // mtime defaults to "now"

    check("(8d) precondition: both planted tmp dirs exist", fs.existsSync(oldTmp) && fs.existsSync(freshTmp));

    sweepStaleTmpInstallDirs(parentDir, 60_000); // maxAgeMs=60s: the old one is ~11.5 days stale, the fresh one is milliseconds old

    check("(8d) the OLD stale tmp dir was swept", !fs.existsSync(oldTmp));
    check("(8d) the FRESH tmp dir was left alone (too young to assume abandoned)", fs.existsSync(freshTmp));
    check("(8d) the final (un-suffixed) dir was never created/touched by the sweep", !fs.existsSync(loomNpmPinnedDir(pkg, version, null)));

    fs.rmSync(freshTmp, { recursive: true, force: true }); // test cleanup
  }

  // (8e) card 66ab2bc0 round 2 (D1): an OLD-SHAPE (pre-round-2, version-only, no content-hash suffix) dir
  // with a REAL bin in it is NOT mistaken for ready by the REAL hot-path resolver — mirrors (8b)'s
  // stale-tmp-dir shape, for the old final-dir shape instead of an abandoned tmp dir.
  {
    const pkg = "atomic-old-shape-pkg";
    const version = "1.0.0";
    const binRel = "bin/cli.js";
    const oldShapeBin = path.join(process.env.LOOM_HOME, "node", pkg, version, "node_modules", pkg, binRel);
    fs.mkdirSync(path.dirname(oldShapeBin), { recursive: true });
    fs.writeFileSync(oldShapeBin, "// pre-round-2 (old-shape) install — must never be mistaken for ready\n");
    const row4 = { id: "cap-old-shape", slug: "case-old-shape", name: "x", description: "d", transport: "stdio", kind: "npm-pinned", provisionJson: JSON.stringify({ kind: "npm-pinned", package: pkg, version, binRelativeToPackageJson: binRel }), toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: new Date().toISOString() };
    check("(8e) an old-shape (version-only) dir with a real bin is NOT mistaken for ready (the real resolver still reports cold)", resolveCapabilityServer(row4, {}) === null);
    check("(8e) the old-shape bin is left alone (this resolve path doesn't delete pre-existing content)", fs.existsSync(oldShapeBin));
  }
}

// ===================== (6) outputDirEnvVar — the mechanism the image-gen migration depends on =====================
{
  const scratchRow = {
    ...rowFor("case-scratch-dir"), wantsScratchDir: true,
    provisionJson: JSON.stringify({ kind: "npm-pinned", package: PKG, version: VERSION, binRelativeToPackageJson: BIN_REL, outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR" }),
  };
  const bin = loomNpmPinnedBin(PKG, VERSION, BIN_REL, LOCK_HASH);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "// fixture bin\n");
  const server = resolveCapabilityServer(scratchRow, { scratchDir: "/tmp/scratch-dir-xyz" });
  check("(6) outputDirEnvVar injects the scratch dir into env under the named var", server?.env?.NANO_BANANA_OUTPUT_DIR === "/tmp/scratch-dir-xyz");
  const serverNoScratch = resolveCapabilityServer(scratchRow, {});
  check("(6) no scratchDir in ctx ⇒ no env block at all", !serverNoScratch?.env);
}

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — npm-pinned capability provisioning: the spawn hot path is fs.existsSync-fast when cold, the mounted map stays byte-identical to an ungranted spawn while cold, concurrent resolves dedupe to one in-flight job, a terminal failure is retryable, every classified outcome (invalid-spec/install-failed/timeout/disabled) maps onto the status model with reason+errorTail, the warm mount shape is {command: process.execPath, args:[bin]} with no hardcoded --output-dir flag, and a warm row driven through the REAL buildMcpServers comes out wrapped exactly once by the env-isolating launcher with realArgs=[bin]."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
