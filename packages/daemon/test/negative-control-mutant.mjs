import "./_guard.mjs"; // prod-guard: no daemon/Db used below, pure fs/child_process/git
// Test for card f663d378's `--mutant <patch>` mode of packages/daemon/scripts/negative-control.mjs:
// the broken bytes come from applying a unified diff (keeps the API, disables the logic) instead of
// reverting --file(s) to --ref. Runs against throwaway git fixture repos via the --repo-root seam with a
// no-op --build, so no real build is involved.
//
// Run: node packages/daemon/test/negative-control-mutant.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "negative-control.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const NOOP_BUILD = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;

const FIXED_LIB = "export const isEven = (n) => n % 2 === 0;\r\nexport const keep = 1;\r\n"; // CRLF on purpose: byte-exact restore
const MUTANT_LIB = "export const isEven = (n) => false;\r\nexport const keep = 1;\r\n"; // API kept, logic disabled

const roots = [];
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-negmut-${process.pid}-`));
  roots.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "src", "lib.mjs"), FIXED_LIB);
  fs.writeFileSync(
    path.join(dir, "test", "check.mjs"),
    "import { isEven } from '../src/lib.mjs';\n" +
      "const ok = isEven(2) === true && isEven(3) === false;\n" +
      "if (!ok) console.log('FAIL  isEven misbehaves');\n" +
      "process.exit(ok ? 0 : 1);\n"
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixed state"]);
  return dir;
}

/** Make a real `git diff` patch turning the fixed lib into MUTANT_LIB, tree left unchanged afterwards. */
function makeMutantPatch(dir) {
  const lib = path.join(dir, "src", "lib.mjs");
  fs.writeFileSync(lib, MUTANT_LIB);
  const patch = git(dir, ["diff", "--", "src/lib.mjs"]);
  fs.writeFileSync(lib, FIXED_LIB);
  const p = path.join(dir, "mutant.diff");
  fs.writeFileSync(p, patch);
  return p;
}

function snapshotTree(dir) {
  return {
    lib: fs.readFileSync(path.join(dir, "src", "lib.mjs")),
    status: git(dir, ["status", "--porcelain"]),
    cached: git(dir, ["diff", "--cached"]),
  };
}
const sameTree = (a, b) => a.lib.equals(b.lib) && a.status === b.status && a.cached === b.cached;

function run(dir, extra, { build = NOOP_BUILD } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...extra, "--build", build, "--repo-root", dir], { cwd: dir, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── 1. apply + BEHAVIOURAL RED → exit 0; restore byte-identical; index untouched ───────────────────────
{
  const dir = makeFixture();
  const patch = makeMutantPatch(dir);
  const before = snapshotTree(dir);
  const r = run(dir, ["--mutant", "mutant.diff", "--test", "test/check.mjs"]);
  check("mutant happy path: exits 0", r.status === 0);
  check("mutant happy path: RED classified BEHAVIOURAL", /red=BEHAVIOURAL/.test(r.stdout) && /RESULT:.*=> OK/.test(r.stdout));
  check("mutant happy path: the patched file was auto-snapshotted (named in output)", /- src\/lib\.mjs/.test(r.stdout));
  check("mutant happy path: working tree (CRLF bytes), git status and index byte-identical after RED+GREEN", sameTree(before, snapshotTree(dir)));
  check("mutant happy path: index was never touched (nothing staged)", snapshotTree(dir).cached === "");
  void patch;
}

// ── 2. GREEN fails (always-red test): exit 1, tree still byte-identical ────────────────────────────────
{
  const dir = makeFixture();
  makeMutantPatch(dir);
  fs.writeFileSync(path.join(dir, "test", "red.mjs"), "console.log('FAIL  always');\nprocess.exit(1);\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add red test and patch"]);
  const before = snapshotTree(dir);
  const r = run(dir, ["--mutant", "mutant.diff", "--test", "test/red.mjs"]);
  check("mutant GREEN-fails: exits 1 and names the GREEN phase", r.status === 1 && /GREEN phase did not pass/.test(r.stderr));
  check("mutant GREEN-fails: tree byte-identical afterwards", sameTree(before, snapshotTree(dir)));
}

// ── 3. patch that does not apply → exit 2, clear refusal, tree byte-identical ──────────────────────────
{
  const dir = makeFixture();
  const patchPath = makeMutantPatch(dir);
  fs.writeFileSync(patchPath, fs.readFileSync(patchPath, "utf8").replace("isEven = (n) => n % 2", "isEven = (n) => n % 7"));
  const before = snapshotTree(dir);
  const r = run(dir, ["--mutant", "mutant.diff", "--test", "test/check.mjs"]);
  check("non-applying patch: exits 2", r.status === 2);
  check("non-applying patch: refusal names the apply failure and says nothing changed", /does not apply/.test(r.stderr) && /Nothing was changed/.test(r.stderr));
  check("non-applying patch: tree byte-identical", sameTree(before, snapshotTree(dir)));
  check("non-applying patch: no RESULT line (no phase ran)", !/RESULT:/.test(r.stdout));
}

// ── 4. mutual exclusion ─────────────────────────────────────────────────────────────────────────────────
{
  const dir = makeFixture();
  makeMutantPatch(dir);
  const before = snapshotTree(dir);
  const withFile = run(dir, ["--mutant", "mutant.diff", "--file", "src/lib.mjs", "--test", "test/check.mjs"]);
  const withRef = run(dir, ["--mutant", "mutant.diff", "--ref", "HEAD", "--test", "test/check.mjs"]);
  check("mutual exclusion: --mutant + --file exits 2", withFile.status === 2 && /mutually exclusive/.test(withFile.stderr));
  check("mutual exclusion: --mutant + --ref exits 2", withRef.status === 2 && /mutually exclusive/.test(withRef.stderr));
  check("mutual exclusion: tree untouched", sameTree(before, snapshotTree(dir)));
}

// ── 5. refusals: out-of-root, add, delete, rename — all exit 2 with the tree untouched ─────────────────
{
  const dir = makeFixture();
  const outsideVictim = path.join(path.dirname(dir), `loom-negmut-victim-${process.pid}.txt`);
  fs.writeFileSync(outsideVictim, "victim\n");
  roots.push(outsideVictim);
  const before = snapshotTree(dir);
  const cases = {
    "out-of-root path": `--- a/../${path.basename(outsideVictim)}\n+++ b/../${path.basename(outsideVictim)}\n@@ -1 +1 @@\n-victim\n+pwned\n`,
    "absolute path": `--- ${outsideVictim}\n+++ ${outsideVictim}\n@@ -1 +1 @@\n-victim\n+pwned\n`,
    "added file": "diff --git a/src/new.mjs b/src/new.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.mjs\n@@ -0,0 +1 @@\n+x\n",
    "deleted file": "diff --git a/src/lib.mjs b/src/lib.mjs\ndeleted file mode 100644\n--- a/src/lib.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    "renamed file": "diff --git a/src/lib.mjs b/src/lib2.mjs\nsimilarity index 100%\nrename from src/lib.mjs\nrename to src/lib2.mjs\n",
    "no file named": "not a diff at all\n",
  };
  for (const [name, body] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, "bad.diff"), body);
    const r = run(dir, ["--mutant", "bad.diff", "--test", "test/check.mjs"]);
    check(`refused (${name}): exit 2 with a named refusal`, r.status === 2 && /--mutant patch refused/.test(r.stderr));
  }
  check("refused patches: out-of-root victim file untouched", fs.readFileSync(outsideVictim, "utf8") === "victim\n");
  const after = snapshotTree(dir);
  check("refused patches: repo lib + index untouched", before.lib.equals(after.lib) && before.cached === after.cached);
  check("refused patches: no new file appeared", !fs.existsSync(path.join(dir, "src", "new.mjs")) && !fs.existsSync(path.join(dir, "src", "lib2.mjs")));
}

for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
console.log(failures === 0 ? "\n✅ ALL PASS — negative-control --mutant applies, restores byte-exactly and refuses unsafe patches." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
