import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs + a real turbo spawn against an isolated fixture
// Card ec6ead9d — proves turbo's OWN native local-cache eviction (`cacheMaxAge`/`cacheMaxSize`, root
// turbo.json) genuinely bounds a cache directory's growth, with a positive AND negative control on both
// the age axis and the size axis. SCENARIO 0 (added by code review — the ORIGINAL version of this suite
// never read the real root turbo.json at all, so deleting its cacheMaxAge/cacheMaxSize keys left this
// whole file green) reads+parses the REAL root turbo.json (JSONC comments stripped), asserts the real
// intended values, and RED-proves that check against an in-memory copy with a key stripped out — the
// real file on disk is never written to by this test, only read. NEVER runs a real build against the
// real repo's shared `.turbo/cache` (turbo 2.x shares that one directory across every git worktree of
// this repo — see decision ec6ead9d) — every build (and the one dry-run) here targets its own disposable
// fixture repo with its own `--cache-dir`, both under the OS temp dir, removed in a `finally`. See
// docs/decisions/ec6ead9d-bound-turbo-cache-growth.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..", "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const TURBO_BIN = (() => {
  try { return require.resolve("turbo/bin/turbo"); }
  catch { return path.join(repoRoot, "node_modules", "turbo", "bin", "turbo"); }
})();

// turbo's own file-content hashing is git-based: an UNTRACKED/uncommitted change to an input file is
// silently invisible to it (measured directly — see this test's own commit history / PR description),
// so every fixture here is a real git repo, and every content change is committed before the next build.
function gitCommitAll(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root, stdio: "ignore" });
}

// House convention (companion-git-push.mjs's own `initRepo`): persisted identity + gpgsign=false so this
// fixture's commits never depend on, or are blocked by, the host's ambient git identity/signing config —
// plus `core.hooksPath` neutralised to `os.devNull` (same convention codex-worker-auto-commit.mjs uses,
// proven there not to fire even against a REAL planted hook) so an ambient global hooks config on the
// host can never run against this disposable fixture's own commits.
function initGitRepo(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom-test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "loom-test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", os.devNull], { cwd: root, stdio: "ignore" });
}

/** Writes a minimal single-package fixture monorepo at `root`, with its own turbo.json carrying
 * `cacheConfig` (merged into the standard "build" task). The package's own build script writes a fixed-
 * size, incompressible (random-byte) dist file whose CONTENT depends on a source "version.txt" input —
 * so committing a change to that file (never the script's own runtime randomness) is what changes
 * turbo's content hash and so creates a genuinely NEW, distinct cache entry each time. */
function makeFixture(root, cacheConfig) {
  fs.mkdirSync(path.join(root, "packages", "pkg-a"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "turbo-cache-eviction-fixture-root", private: true, workspaces: ["packages/*"], packageManager: "npm@10.0.0",
  }));
  fs.writeFileSync(path.join(root, "turbo.json"), JSON.stringify({
    $schema: "https://turbo.build/schema.json",
    ...cacheConfig,
    tasks: { build: { outputs: ["dist/**"] } },
  }));
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "package.json"), JSON.stringify({
    name: "pkg-a", version: "1.0.0", private: true, scripts: { build: "node build.js" },
  }));
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "version.txt"), "v1");
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "build.js"),
    'const fs=require("fs"),path=require("path"),crypto=require("crypto");' +
    'const v=fs.readFileSync(path.join(__dirname,"version.txt"),"utf8");' +
    'fs.mkdirSync(path.join(__dirname,"dist"),{recursive:true});' +
    'fs.writeFileSync(path.join(__dirname,"dist","out.bin"),Buffer.concat([Buffer.from(v),crypto.randomBytes(50000)]));');
  initGitRepo(root);
  gitCommitAll(root, "fixture init");
}

function setVersion(root, v) {
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "version.txt"), v);
  gitCommitAll(root, `version ${v}`);
}

function runTurboBuild(root, cacheDir) {
  // shell:false equivalent — execFileSync with an args array, no shell, mirroring restart.ts's own
  // no-shell turbo invocation (51522f05). Output captured but not asserted on here — this test asserts
  // on the FILESYSTEM result (which cache files exist), the thing eviction actually promises.
  return execFileSync(process.execPath, [TURBO_BIN, "build", `--cache-dir=${cacheDir}`], { cwd: root, encoding: "utf8" });
}

function cacheFiles(cacheDir) {
  try { return fs.readdirSync(cacheDir); } catch { return []; }
}

function runTurboDry(root, cacheDir) {
  return execFileSync(process.execPath, [TURBO_BIN, "build", "--dry=json", `--cache-dir=${cacheDir}`], { cwd: root, encoding: "utf8" });
}

/** Strips `//` line comments and `/* *\/` block comments from JSONC text, respecting string literals (a
 * `//` inside a quoted string — e.g. turbo.json's own `"https://turbo.build/schema.json"` — is NOT a
 * comment). A minimal hand-rolled state machine, not a library: this repo has no JSONC-parsing dependency
 * and the root turbo.json's comment usage is simple enough not to need one. */
function stripJsonComments(text) {
  let out = "";
  let inString = false, inLineComment = false, inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLineComment) { if (c === "\n") { inLineComment = false; out += c; } continue; }
    if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === "\\") { out += n; i++; continue; }
      if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLineComment = true; i++; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; i++; continue; }
    out += c;
  }
  return out;
}

const ROOT_TURBO_JSON_PATH = path.join(repoRoot, "turbo.json");
// The INTENDED values (card ec6ead9d, owner/manager decision) — asserted against, not just "exists" —
// so a silent downgrade (someone narrowing the age/size back toward "basically off") is also caught, not
// only an outright deletion of the keys.
const INTENDED_CACHE_MAX_AGE = "14d";
const INTENDED_CACHE_MAX_SIZE = "5GB";

// === SCENARIO 0: the ROOT turbo.json actually carries the real eviction config — NOT a copy, not a
// re-typed literal elsewhere in this file. Card ec6ead9d code review: the ORIGINAL version of this test
// suite never read turbo.json at all, so deleting cacheMaxAge/cacheMaxSize from the real file left every
// other scenario here GREEN (they all define their OWN throwaway fixture turbo.json, never the real
// one) — a clean suite that would not have caught the exact regression it exists to guard against. ===
{
  const rawText = fs.readFileSync(ROOT_TURBO_JSON_PATH, "utf8");
  const parsed = JSON.parse(stripJsonComments(rawText));
  check(`(0) root turbo.json's cacheMaxAge is the intended "${INTENDED_CACHE_MAX_AGE}" (not merely present)`,
    parsed.cacheMaxAge === INTENDED_CACHE_MAX_AGE);
  check(`(0) root turbo.json's cacheMaxSize is the intended "${INTENDED_CACHE_MAX_SIZE}" (not merely present)`,
    parsed.cacheMaxSize === INTENDED_CACHE_MAX_SIZE);

  // --- (0 RED PROOF) the SAME check, run against an in-memory COPY with the key stripped out — proves
  // this check can actually go RED, never touching the real file on disk. A string-level strip (not a
  // JSON.parse + delete + re-stringify) deliberately keeps the rest of the real file byte-for-byte
  // unexamined, so this is a test of the DETECTOR, not a second parse of a reconstructed document. ---
  const copyMissingAge = rawText.replace(/"cacheMaxAge"\s*:\s*"[^"]*",?\s*\n/, "");
  check("(0 sanity) the in-memory copy genuinely differs from the real file (the strip actually did something)",
    copyMissingAge !== rawText && copyMissingAge.length < rawText.length);
  const parsedMissingAge = JSON.parse(stripJsonComments(copyMissingAge));
  check("(0 RED PROOF) the SAME check correctly reports MISSING when fed a copy with cacheMaxAge stripped out",
    parsedMissingAge.cacheMaxAge !== INTENDED_CACHE_MAX_AGE);
  check("(0 RED PROOF) and the stripped copy's cacheMaxSize is untouched (the strip was targeted, not a wipe)",
    parsedMissingAge.cacheMaxSize === INTENDED_CACHE_MAX_SIZE);

  // --- (0 real-value integration) feed the REAL values (not hand-typed small test values) into an
  // isolated fixture and confirm turbo's OWN schema parser accepts them — a DRY run only (no real spawn
  // of a multi-day wait; `--dry=json` computes hashes/config without executing or touching any cache). ---
  const root = path.join(os.tmpdir(), `loom-tce-realvalues-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const cacheDir = path.join(root, ".turbo-cache-test");
  try {
    makeFixture(root, { cacheMaxAge: parsed.cacheMaxAge, cacheMaxSize: parsed.cacheMaxSize });
    const dryOut = runTurboDry(root, cacheDir);
    check("(0 real-value integration) turbo's real schema parser accepts the REAL cacheMaxAge/cacheMaxSize values with no error",
      !/turbo_json_parse_error/.test(dryOut) && JSON.parse(dryOut).turboVersion);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// === SCENARIO 1: age-based eviction — a genuinely-old entry is evicted; a fresh one is not. ===
{
  const root = path.join(os.tmpdir(), `loom-tce-age-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const cacheDir = path.join(root, ".turbo-cache-test");
  try {
    // 10s, not 2s (card ec6ead9d code review): a tight threshold made the NEGATIVE control (below) flaky
    // — two real, sequential turbo spawns occasionally took long enough on a loaded host to cross a 2s
    // gap on their own, with no sleep at all, producing a false eviction. 10s leaves comfortable headroom
    // for the negative control's natural back-to-back timing while this positive arm still explicitly
    // sleeps PAST it via `sleepPast`, never relying on "should be fast enough."
    makeFixture(root, { cacheMaxAge: "10s" });
    runTurboBuild(root, cacheDir); // entry #1 (v1)
    const filesAfterFirst = cacheFiles(cacheDir);
    check("(age) first build populates the cache", filesAfterFirst.length > 0);

    await sleepPast(10500, 10000, "past cacheMaxAge=10s");

    setVersion(root, "v2");
    runTurboBuild(root, cacheDir); // triggers eviction at START of this run, THEN writes entry #2
    const filesAfterSecond = cacheFiles(cacheDir);
    const entry1Manifest = filesAfterFirst.find((f) => f.endsWith("-manifest.json"));
    check("(age) the AGED-PAST-THRESHOLD entry #1 is evicted",
      !!entry1Manifest && !filesAfterSecond.includes(entry1Manifest));
    check("(age) a FRESH entry #2 (written by THIS run) survives",
      filesAfterSecond.length > 0 && !filesAfterSecond.every((f) => filesAfterFirst.includes(f)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// === SCENARIO 1 NEGATIVE CONTROL: same age config, but WITHOUT crossing the threshold — nothing evicted.
// Deliberately NO sleep here — two back-to-back real turbo spawns comfortably finish well inside the 10s
// threshold, so this stays a genuine "never crossed it" case rather than racing a tight margin. ===
{
  const root = path.join(os.tmpdir(), `loom-tce-age-neg-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const cacheDir = path.join(root, ".turbo-cache-test");
  try {
    makeFixture(root, { cacheMaxAge: "10s" });
    runTurboBuild(root, cacheDir); // entry #1 (v1)
    const filesAfterFirst = cacheFiles(cacheDir);

    setVersion(root, "v2");
    runTurboBuild(root, cacheDir); // immediately after — well under 10s — entry #2
    const filesAfterSecond = cacheFiles(cacheDir);
    const entry1Manifest = filesAfterFirst.find((f) => f.endsWith("-manifest.json"));
    check("(age negative control) entry #1 SURVIVES when the threshold was never crossed",
      !!entry1Manifest && filesAfterSecond.includes(entry1Manifest));
    check("(age negative control) entry #2 also exists (both entries present, nothing evicted)",
      filesAfterSecond.length > filesAfterFirst.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// === SCENARIO 2: size-based eviction — total cache over cap evicts the OLDEST entry; a lone entry
// under the cap never is. Cap is derived from a REAL measured entry size, not a guessed constant, so the
// test can't vacuously pass or fail on an assumption about turbo's own compression ratio.
//
// Eviction is checked against the EXISTING on-disk total at the START of a `turbo run`, BEFORE that
// run's own write — confirmed directly (debug run, not assumed): after building A then B (A+B together
// over cap), BOTH still existed, because at B's own run-start the existing total was just A (under cap)
// — eviction never re-checks after its own write. Only a THIRD build (C), whose run-start total is A+B
// (now genuinely over cap), evicts the oldest (A) and leaves B and C. So this scenario needs three builds
// to observe eviction at all, not two. ===
{
  const root = path.join(os.tmpdir(), `loom-tce-size-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const cacheDir = path.join(root, ".turbo-cache-test");
  try {
    // Pass 1 (no cap yet): measure one real entry's on-disk size.
    makeFixture(root, {});
    runTurboBuild(root, cacheDir);
    const oneEntryBytes = cacheFiles(cacheDir)
      .reduce((sum, f) => sum + fs.statSync(path.join(cacheDir, f)).size, 0);
    check("(size) measured a real, non-zero single-entry cache size to derive the cap from",
      oneEntryBytes > 0);
    fs.rmSync(cacheDir, { recursive: true, force: true });

    // Pass 2: a cap sized for ~1.3 entries — two distinct entries together exceed it, one alone doesn't.
    const capBytes = Math.ceil(oneEntryBytes * 1.3);
    fs.writeFileSync(path.join(root, "turbo.json"), JSON.stringify({
      $schema: "https://turbo.build/schema.json",
      cacheMaxSize: `${capBytes}B`,
      tasks: { build: { outputs: ["dist/**"] } },
    }));
    setVersion(root, "s1");
    runTurboBuild(root, cacheDir); // entry #A, alone — under cap, nothing to evict
    const filesAfterA = cacheFiles(cacheDir);
    check("(size) a LONE entry under the cap is never evicted by its own build",
      filesAfterA.length > 0);

    setVersion(root, "s2");
    runTurboBuild(root, cacheDir); // run-start total = A alone (under cap) → no eviction yet; THIS run writes B
    const filesAfterB = cacheFiles(cacheDir);
    const entryAManifest = filesAfterA.find((f) => f.endsWith("-manifest.json"));
    check("(size) entry A still SURVIVES right after B is written (A+B together now over cap, but eviction hasn't re-checked yet)",
      filesAfterB.includes(entryAManifest));

    setVersion(root, "s3");
    runTurboBuild(root, cacheDir); // run-start total = A+B (NOW over cap) → evicts oldest (A); THIS run writes C
    const filesAfterC = cacheFiles(cacheDir);
    const entryBManifest = filesAfterB.find((f) => f.endsWith("-manifest.json") && f !== entryAManifest);
    check("(size) the OLDEST entry (A) is evicted once the combined total exceeded cacheMaxSize",
      !filesAfterC.includes(entryAManifest));
    check("(size) the middle entry (B) SURVIVES — eviction removes only the oldest, not everything over cap",
      !!entryBManifest && filesAfterC.includes(entryBManifest));
    check("(size) the newest entry (C, written by THIS run) also survives",
      filesAfterC.length > 0 && !filesAfterC.every((f) => filesAfterB.includes(f)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// === SCENARIO 2 NEGATIVE CONTROL: a generous cap (1TB) — both entries survive, nothing evicted. ===
{
  const root = path.join(os.tmpdir(), `loom-tce-size-neg-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const cacheDir = path.join(root, ".turbo-cache-test");
  try {
    makeFixture(root, { cacheMaxSize: "1TB" });
    runTurboBuild(root, cacheDir); // entry #A
    const filesAfterA = cacheFiles(cacheDir);
    setVersion(root, "g2");
    runTurboBuild(root, cacheDir); // entry #B
    const filesAfterB = cacheFiles(cacheDir);
    const entryAManifest = filesAfterA.find((f) => f.endsWith("-manifest.json"));
    check("(size negative control) a generous cap evicts NOTHING — entry #A still present",
      !!entryAManifest && filesAfterB.includes(entryAManifest));
    check("(size negative control) both entries coexist (combined count grew, not replaced)",
      filesAfterB.length > filesAfterA.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the ROOT turbo.json genuinely carries the intended cacheMaxAge/cacheMaxSize (RED-proven against an in-memory copy), those real values parse under turbo's own schema, and the eviction MECHANISM they rely on genuinely evicts the oldest/over-cap entries (and only those), on a real spawn against an isolated fixture, never the shared repo cache."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
