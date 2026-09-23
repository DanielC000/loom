import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process/git
// Test for card 7c979d92: `packages/daemon/scripts/negative-control.mjs`'s `readRefContent` calls
// `execFileSync("git", ["show", ...])` to read a --file's content at --ref. Without an explicit
// `maxBuffer`, Node's 1 MiB default throws ENOBUFS for any --file whose ref content exceeds that —
// real population: packages/daemon/src/sessions/service.ts is 1.44 MB (see the card).
//
// This proves BOTH directions against a GENERATED >1 MiB fixture (never service.ts itself, so the test
// doesn't depend on that file's size):
//   (a) RED — a reconstructed PRE-FIX copy of the script (the exact `readRefContent` call with its
//       `maxBuffer` option stripped back out, so Node's 1 MiB default applies) fails on a >1 MiB --file,
//       and fails for the RIGHT reason (the git-show wrapper's own error text, mentioning the buffer).
//   (b) GREEN — the REAL, current script (with the fix in place) succeeds on the same >1 MiB fixture,
//       and still restores the file byte-for-byte afterwards.
//
// Runs entirely against a throwaway, isolated git fixture repo (created fresh per run under a temp
// dir) via negative-control.mjs's own --repo-root test seam, and never invokes the real (slow)
// `pnpm --filter @loom/daemon build` — --build is a fast synthetic no-op, same convention as
// negative-control-runner.mjs.
//
// Run: node packages/daemon/test/negative-control-large-file.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "negative-control.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A no-op "build" — this test exercises the buffer fix, not a real build. Cross-platform (node -e),
// always exits 0 so it never itself causes a phase to fail.
const NOOP_BUILD = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;

const ONE_MIB = 1024 * 1024;

// Deterministic, distinguishable, and comfortably over the 1 MiB `execFileSync` default (1,200,000 >
// 1,048,576) without being needlessly huge for a test fixture.
function makeLargeContent(marker, targetBytes) {
  const parts = [`// MARKER:${marker}\n`];
  let size = Buffer.byteLength(parts[0]);
  const filler = "x".repeat(78) + "\n"; // 79 bytes/line, no CR anywhere (autocrlf-safe)
  while (size < targetBytes) {
    parts.push(filler);
    size += Buffer.byteLength(filler);
  }
  return parts.join("");
}

const BROKEN_LARGE = makeLargeContent("BROKEN", 1_200_000);
const FIXED_LARGE = makeLargeContent("FIXED", 1_200_000);
check("fixture sanity: BROKEN_LARGE exceeds execFileSync's 1 MiB default maxBuffer", Buffer.byteLength(BROKEN_LARGE) > ONE_MIB);
check("fixture sanity: FIXED_LARGE exceeds execFileSync's 1 MiB default maxBuffer", Buffer.byteLength(FIXED_LARGE) > ONE_MIB);

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-negctl-large-fixture-${process.pid}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  return dir;
}

// Commits BROKEN_LARGE as HEAD (the state --ref reads), leaves FIXED_LARGE sitting uncommitted in the
// working tree — same real-world shape negative-control-runner.mjs's fixtures use.
function commitBrokenThenApplyFix(dir) {
  const srcPath = path.join(dir, "src", "big.txt");
  fs.writeFileSync(srcPath, BROKEN_LARGE, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "broken (pre-fix) state — large file"]);
  fs.writeFileSync(srcPath, FIXED_LARGE, "utf8"); // uncommitted "fix"
  return srcPath;
}

// A real content-aware test: exits 0 iff src/big.txt carries the FIXED marker.
function writeContentAwareTest(dir) {
  const testPath = path.join(dir, "test", "check-large.mjs");
  const body =
    "import fs from 'node:fs';\n" +
    "import path from 'node:path';\n" +
    "const content = fs.readFileSync(path.join(process.cwd(), 'src', 'big.txt'), 'utf8');\n" +
    "process.exit(content.includes('MARKER:FIXED') ? 0 : 1);\n";
  fs.writeFileSync(testPath, body, "utf8");
  return testPath;
}

function runScript(scriptPath, dir, { files, tests, ref = "HEAD", build = NOOP_BUILD }) {
  const args = [scriptPath];
  for (const f of files) args.push("--file", f);
  for (const t of tests) args.push("--test", t);
  args.push("--ref", ref, "--build", build, "--repo-root", dir);
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ── Reconstruct the PRE-FIX shape of readRefContent's execFileSync call: strip the `maxBuffer` option
// back out, so Node's 1 MiB default applies exactly as it did before card 7c979d92. Asserting the
// replace hits EXACTLY ONCE means this test breaks loudly (rather than silently passing vacuously) if
// the real call site's shape ever changes out from under it. ──────────────────────────────────────────
const realSource = fs.readFileSync(SCRIPT, "utf8");
const FIXED_CALL = 'execFileSync("git", ["show", `${ref}:${posixRel}`], { cwd: repoRoot, maxBuffer: GIT_SHOW_MAX_BUFFER_BYTES });';
const PRE_FIX_CALL = 'execFileSync("git", ["show", `${ref}:${posixRel}`], { cwd: repoRoot });';
const fixedCallOccurrences = realSource.split(FIXED_CALL).length - 1;
check("negative-control.mjs's readRefContent still has the expected fixed maxBuffer call, exactly once", fixedCallOccurrences === 1);

let brokenScriptPath = null;
if (fixedCallOccurrences === 1) {
  const brokenSource = realSource.replace(FIXED_CALL, PRE_FIX_CALL);
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-negctl-large-brokencopy-${process.pid}-`));
  brokenScriptPath = path.join(brokenDir, "negative-control-pre-fix.mjs");
  fs.writeFileSync(brokenScriptPath, brokenSource, "utf8");
}

// ── (a) RED — the reconstructed pre-fix script fails on a >1 MiB --file, for the right reason. ────────
if (brokenScriptPath) {
  const dir = makeFixtureRepo();
  commitBrokenThenApplyFix(dir);
  writeContentAwareTest(dir);

  const r = runScript(brokenScriptPath, dir, { files: ["src/big.txt"], tests: ["test/check-large.mjs"] });
  check("pre-fix copy: exits non-zero on a >1 MiB --file (this is the bug card 7c979d92 fixed)", r.status !== 0);
  check("pre-fix copy: fails specifically in the git-show read, not some other reason", /git show .* failed/i.test(r.stderr));
  check("pre-fix copy: the underlying cause is the buffer, not something unrelated", /maxBuffer|ENOBUFS/i.test(r.stderr));
  // readRefContent throws during snapshot collection, BEFORE any file is ever mutated — so the fixture
  // file must still hold its untouched FIXED_LARGE content, exactly as commitBrokenThenApplyFix left it.
  const untouched = fs.readFileSync(path.join(dir, "src", "big.txt"), "utf8");
  check("pre-fix copy: never got far enough to mutate the file — it's still the untouched working-tree content", untouched === FIXED_LARGE);

  fs.rmSync(dir, { recursive: true, force: true });
} else {
  check("pre-fix RED scenario ran (skipped — call-site shape mismatch above)", false);
}

// ── (b) GREEN — the real, current (fixed) script succeeds on the same >1 MiB fixture, and restores
// byte-for-byte. ─────────────────────────────────────────────────────────────────────────────────────
{
  const dir = makeFixtureRepo();
  commitBrokenThenApplyFix(dir);
  writeContentAwareTest(dir);

  const r = runScript(SCRIPT, dir, { files: ["src/big.txt"], tests: ["test/check-large.mjs"] });
  check("fixed script: exits 0 on a >1 MiB --file", r.status === 0);
  check("fixed script: reports the RED phase failed as expected", /failed, as expected/.test(r.stdout));
  check("fixed script: reports the GREEN phase passed as expected", /passed, as expected/.test(r.stdout));
  check("fixed script: reports the restore as byte-identical", /CLEAN.*confirmed for all file\(s\)/.test(r.stdout));
  const restored = fs.readFileSync(path.join(dir, "src", "big.txt"), "utf8");
  check("fixed script: the >1 MiB file on disk is restored to the exact fixed content afterwards", restored === FIXED_LARGE);

  fs.rmSync(dir, { recursive: true, force: true });
}

if (brokenScriptPath) fs.rmSync(path.dirname(brokenScriptPath), { recursive: true, force: true });

console.log(
  failures === 0
    ? "\n✅ ALL PASS — negative-control.mjs's git-show buffer fix is proven: RED (ENOBUFS) on a >1 MiB " +
      "file with the maxBuffer option stripped back out, GREEN with the real fix in place, tree restored " +
      "byte-for-byte."
    : `\n❌ ${failures} FAILURE(S).`
);
process.exit(failures === 0 ? 0 : 1);
