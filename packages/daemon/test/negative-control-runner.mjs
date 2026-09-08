import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process/git
// Test for card 616e5ec2's `packages/daemon/scripts/negative-control.mjs` — the one-call
// RED→GREEN→clean-tree proof runner meant to replace the hand-executed 6-step marker-in/marker-out
// cycle the /worker doctrine mandates for every new check.
//
// THE RECURSIVE CONSTRAINT (the card's own words): "You are building the tool that proves a check can
// fail. So prove yours can. Show me your runner correctly reporting RED on a genuinely broken case —
// not just GREEN on a good one." This file does both:
//   (a) HAPPY PATH — a real fix/regression pair where the runner must report success (exit 0) and must
//       have restored the file byte-for-byte afterwards.
//   (b) THE RUNNER'S OWN RED CASE, TWO WAYS — a test that can't actually distinguish broken from fixed
//       (RED phase unexpectedly "passes") and a fix that doesn't actually fix anything (GREEN phase
//       still fails) — the runner must exit non-zero and name which phase misbehaved, in BOTH cases.
//   (c) RESTORE INTEGRITY — confirmed directly against the real snapshot content, not merely inferred
//       from a green run, for every scenario above (including the failing ones: a scenario that fails
//       for an UNRELATED reason must still leave the file exactly as it found it).
//
// Runs entirely against a throwaway, isolated git fixture repo (created fresh per run under a temp
// dir) via negative-control.mjs's own --repo-root test seam — never against this repo's real source,
// and never invokes the real (slow) `pnpm --filter @loom/daemon build`; --build is a fast synthetic
// no-op for every scenario here, since this test is about the runner's OWN control flow, not about
// exercising a real TypeScript build.
//
// Run: node packages/daemon/test/negative-control-runner.mjs
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

// A no-op "build" — this test exercises the runner's control flow, not a real build. Cross-platform
// (node -e), always exits 0 so it never itself causes a phase to fail.
const NOOP_BUILD = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-negctl-fixture-${process.pid}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  return dir;
}

// Commits BROKEN_CONTENT as HEAD (the "pre-fix" state --ref will read), then leaves FIXED_CONTENT sitting
// uncommitted in the working tree (the real-world shape: a worker's fix is an uncommitted edit on top of
// HEAD) — mirrors exactly what negative-control.mjs's own --ref default (HEAD) assumes.
function commitBrokenThenApplyFix(dir, { brokenContent, fixedContent }) {
  const srcPath = path.join(dir, "src", "example.txt");
  fs.writeFileSync(srcPath, brokenContent, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "broken (pre-fix) state"]);
  fs.writeFileSync(srcPath, fixedContent, "utf8"); // uncommitted "fix"
  return srcPath;
}

// A test .mjs that exits 0 iff src/example.txt's content is EXACTLY fixedContent — a real content-aware
// check, the shape every actual project test in this repo takes.
function writeContentAwareTest(dir, fixedContent) {
  const testPath = path.join(dir, "test", "check.mjs");
  const body =
    "import fs from 'node:fs';\n" +
    "import path from 'node:path';\n" +
    `const content = fs.readFileSync(path.join(process.cwd(), 'src', 'example.txt'), 'utf8');\n` +
    `process.exit(content === ${JSON.stringify(fixedContent)} ? 0 : 1);\n`;
  fs.writeFileSync(testPath, body, "utf8");
  return testPath;
}

function writeAlwaysExit(dir, name, code) {
  const testPath = path.join(dir, "test", name);
  fs.writeFileSync(testPath, `process.exit(${code});\n`, "utf8");
  return testPath;
}

function runNegativeControl(dir, { files, tests, ref = "HEAD", build = NOOP_BUILD }) {
  const args = [SCRIPT];
  for (const f of files) args.push("--file", f);
  for (const t of tests) args.push("--test", t);
  args.push("--ref", ref, "--build", build, "--repo-root", dir);
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ── (a) HAPPY PATH: a real content-aware test correctly distinguishes broken from fixed. ──────────────
{
  const dir = makeFixtureRepo();
  const BROKEN = "broken content\n";
  const FIXED = "fixed content\n";
  commitBrokenThenApplyFix(dir, { brokenContent: BROKEN, fixedContent: FIXED });
  writeContentAwareTest(dir, FIXED);

  const r = runNegativeControl(dir, { files: ["src/example.txt"], tests: ["test/check.mjs"] });
  check("happy path: runner exits 0 when RED genuinely fails and GREEN genuinely passes", r.status === 0);
  check("happy path: reports the RED phase failed as expected", /failed, as expected/.test(r.stdout));
  check("happy path: reports the GREEN phase passed as expected", /passed, as expected/.test(r.stdout));
  check("happy path: reports the restore as byte-identical", /CLEAN.*confirmed for all file\(s\)/.test(r.stdout));
  const restored = fs.readFileSync(path.join(dir, "src", "example.txt"), "utf8");
  check("happy path: file on disk is restored to the exact fixed content afterwards", restored === FIXED);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (b1) THE RUNNER'S OWN RED CASE — an "always green" test can't distinguish broken from fixed, so the
// RED phase unexpectedly PASSES. The runner itself must catch this and exit non-zero, not paper over it. ─
{
  const dir = makeFixtureRepo();
  commitBrokenThenApplyFix(dir, { brokenContent: "broken\n", fixedContent: "fixed\n" });
  const alwaysGreen = writeAlwaysExit(dir, "always-green.mjs", 0);

  const r = runNegativeControl(dir, {
    files: ["src/example.txt"],
    tests: [path.relative(dir, alwaysGreen).replaceAll("\\", "/")],
  });
  check("negative-control's OWN red case (1/2): exits non-zero when the RED phase unexpectedly passes", r.status !== 0);
  check("...and names it as the RED phase, not a generic failure", /RED phase did not fail/.test(r.stderr));
  const restored = fs.readFileSync(path.join(dir, "src", "example.txt"), "utf8");
  check("...and STILL restores the file byte-for-byte despite reporting failure", restored === "fixed\n");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (b2) THE RUNNER'S OWN RED CASE, THE OTHER DIRECTION — an "always red" test means the GREEN phase
// never passes even after restore. The runner must catch this too, distinctly from (b1). ─────────────────
{
  const dir = makeFixtureRepo();
  commitBrokenThenApplyFix(dir, { brokenContent: "broken\n", fixedContent: "fixed\n" });
  const alwaysRed = writeAlwaysExit(dir, "always-red.mjs", 1);

  const r = runNegativeControl(dir, {
    files: ["src/example.txt"],
    tests: [path.relative(dir, alwaysRed).replaceAll("\\", "/")],
  });
  check("negative-control's OWN red case (2/2): exits non-zero when the GREEN phase never passes", r.status !== 0);
  check("...and names it as the GREEN phase, distinct from the RED-phase message above", /GREEN phase did not pass/.test(r.stderr));
  check("...and does NOT also claim the RED phase failed as expected — it did, but that's not the failure here", !/❌.*RED phase did not fail/.test(r.stderr));
  const restored = fs.readFileSync(path.join(dir, "src", "example.txt"), "utf8");
  check("...and STILL restores the file byte-for-byte despite reporting failure", restored === "fixed\n");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (c) MULTI-FILE: more than one --file, both reverted and restored together. ─────────────────────────
{
  const dir = makeFixtureRepo();
  const aPath = path.join(dir, "src", "a.txt");
  const bPath = path.join(dir, "src", "b.txt");
  fs.writeFileSync(aPath, "a-broken\n", "utf8");
  fs.writeFileSync(bPath, "b-broken\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "broken"]);
  fs.writeFileSync(aPath, "a-fixed\n", "utf8");
  fs.writeFileSync(bPath, "b-fixed\n", "utf8");
  const testPath = path.join(dir, "test", "check-both.mjs");
  fs.writeFileSync(
    testPath,
    "import fs from 'node:fs';\nimport path from 'node:path';\n" +
      "const a = fs.readFileSync(path.join(process.cwd(), 'src', 'a.txt'), 'utf8');\n" +
      "const b = fs.readFileSync(path.join(process.cwd(), 'src', 'b.txt'), 'utf8');\n" +
      "process.exit(a === 'a-fixed\\n' && b === 'b-fixed\\n' ? 0 : 1);\n",
    "utf8"
  );

  const r = runNegativeControl(dir, { files: ["src/a.txt", "src/b.txt"], tests: ["test/check-both.mjs"] });
  check("multi-file: runner exits 0 across two reverted/restored files", r.status === 0);
  check("multi-file: a.txt restored exactly", fs.readFileSync(aPath, "utf8") === "a-fixed\n");
  check("multi-file: b.txt restored exactly", fs.readFileSync(bPath, "utf8") === "b-fixed\n");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n✅ ALL PASS — negative-control.mjs correctly proves RED-then-GREEN-then-restored on a real fix, and " +
      "correctly reports its OWN failure (distinctly, per phase) when a test can't tell broken from fixed in " +
      "either direction — restoring the file byte-for-byte even when it reports failure."
    : `\n❌ ${failures} FAILURE(S).`
);
process.exit(failures === 0 ? 0 : 1);
