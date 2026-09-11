import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process/git
// Test for card 69f3bd03's `packages/daemon/scripts/extraction-loss-scan.mjs` — the comment-extraction
// loss scan scoped to ADDED lines + records, replacing the whole-branch-source subtraction that masks a
// real loss when a removed token happens to recur elsewhere, unchanged, in a large file.
//
// Four cases, each its own hermetic temp git repo (never this repo's real source):
//   (a) POSITIVE CONTROL — a removed clause whose distinctive token recurs elsewhere in the file, in a
//       part the tranche never touched, but is absent from the added lines and from any record. This is
//       EXACTLY the case a whole-file "subtract the branch source" method misses (the token still reads
//       as "present" in the whole file) and the added-lines-scoped method must catch. Asserts the token
//       IS reported as an advisory miss — this is the case the DoD requires to fail against a whole-file
//       implementation and pass against the real one (see the negative-control cycle run separately).
//   (b) a removed clause whose token is absent from the added lines but present in a record that an
//       added @decision id resolves to ⇒ NOT reported.
//   (c) a non-comment removed (and added) line ⇒ non-zero exit, line printed.
//   (d) an added line of 113 bytes ⇒ non-zero exit, line printed.
//
// Run: node packages/daemon/test/extraction-loss-scan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "extraction-loss-scan.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-extloss-fixture-${process.pid}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  return dir;
}

function runScan(dir, file, range) {
  const result = spawnSync(process.execPath, [SCRIPT, file, "--range", range, "--repo-root", dir], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ── (a) POSITIVE CONTROL: a removed token recurring elsewhere, unchanged, in the same file ─────────────
{
  const dir = makeFixtureRepo();
  const filePath = path.join(dir, "example.mjs");
  fs.writeFileSync(
    filePath,
    "// The frobnicator here explains why the retry loop always backs off twice.\n" +
      "// Historical note: frobnicator behavior was chosen after an incident.\n" +
      "function retry() {\n" +
      "  return 1;\n" +
      "}\n" +
      "\n" +
      "// frobnicator recurs here too, in code untouched by the later tranche edit.\n" +
      "function unrelated() {\n" +
      "  return 2;\n" +
      "}\n",
    "utf8",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  // Comment-only tranche: remove the top two-line comment block, add nothing.
  fs.writeFileSync(
    filePath,
    "function retry() {\n" +
      "  return 1;\n" +
      "}\n" +
      "\n" +
      "// frobnicator recurs here too, in code untouched by the later tranche edit.\n" +
      "function unrelated() {\n" +
      "  return 2;\n" +
      "}\n",
    "utf8",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "tranche: remove frobnicator comment"]);

  const r = runScan(dir, "example.mjs", "HEAD~1...HEAD");
  check(
    "(a) [positive control] a token still present elsewhere, unchanged, in the file IS reported as a miss " +
      "(the case a whole-file implementation misses and the added-lines-scoped one must catch)",
    /"frobnicator"/.test(r.stdout),
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (b) a removed token carried forward by a record an added @decision id resolves to ⇒ not reported ───
{
  const dir = makeFixtureRepo();
  const filePath = path.join(dir, "example.mjs");
  fs.writeFileSync(
    filePath,
    "// gloopfrazzle justified why we always retried twice before failing.\n" +
      "function old() {\n" +
      "  return 3;\n" +
      "}\n",
    "utf8",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  fs.mkdirSync(path.join(dir, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "docs", "decisions", "1a2b3c4d-retry-twice.md"),
    "# 1a2b3c4d — retry twice before failing\n\ngloopfrazzle: always retry twice before giving up.\n",
    "utf8",
  );

  fs.writeFileSync(
    filePath,
    "// @decision 1a2b3c4d — always retry twice before giving up.\n" +
      "function old() {\n" +
      "  return 3;\n" +
      "}\n",
    "utf8",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "tranche: extract gloopfrazzle clause to a record"]);

  const r = runScan(dir, "example.mjs", "HEAD~1...HEAD");
  check(
    "(b) a token carried by the record its added @decision id resolves to is NOT reported as a miss",
    !/"gloopfrazzle"/.test(r.stdout),
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (c) a non-comment removed/added line ⇒ non-zero exit, line printed ──────────────────────────────────
{
  const dir = makeFixtureRepo();
  const filePath = path.join(dir, "example.mjs");
  fs.writeFileSync(filePath, "function work() {\n  return 1;\n}\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  fs.writeFileSync(filePath, "function work() {\n  return 2;\n}\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "tranche: change return value (not comment-only)"]);

  const r = runScan(dir, "example.mjs", "HEAD~1...HEAD");
  check("(c) a non-comment-only diff exits non-zero", r.status !== 0);
  check("(c) the non-comment removed line is printed", /return 1;/.test(r.stderr) || /return 1;/.test(r.stdout));
  check("(c) the non-comment added line is printed", /return 2;/.test(r.stderr) || /return 2;/.test(r.stdout));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (d) an added line of 113 bytes ⇒ non-zero exit, line printed ────────────────────────────────────────
{
  const dir = makeFixtureRepo();
  const filePath = path.join(dir, "example.mjs");
  fs.writeFileSync(filePath, "function work() {\n  return 1;\n}\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  const longLine = "// " + "x".repeat(110); // 3 + 110 = 113 bytes, over the 112-byte cap
  check("(d) fixture's over-length comment line is genuinely 113 bytes", Buffer.byteLength(longLine, "utf8") === 113);
  fs.writeFileSync(filePath, `${longLine}\nfunction work() {\n  return 1;\n}\n`, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "tranche: add an over-length comment line"]);

  const r = runScan(dir, "example.mjs", "HEAD~1...HEAD");
  check("(d) an added line over 112 bytes exits non-zero", r.status !== 0);
  check("(d) the over-length line is printed", r.stderr.includes(longLine) || r.stdout.includes(longLine));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n✅ ALL PASS — extraction-loss-scan.mjs reports a removed token still present elsewhere unchanged " +
      "in the file (case a — the whole-file-masked case), suppresses one carried by a resolved record " +
      "(case b), and hard-fails on a non-comment line (case c) or an over-length added line (case d)."
    : `\n❌ ${failures} FAILURE(S).`,
);
process.exit(failures === 0 ? 0 : 1);
