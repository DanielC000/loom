import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process/git
// Test for card 95f2a466: negative-control.mjs classifies its RED phase as BUILD-ONLY / STRUCTURAL /
// BEHAVIOURAL / UNCLASSIFIED, refuses (exit 3) anything but BEHAVIOURAL unless --allow-structural, and
// ends with a one-line RESULT summary. Fixture-driven through the script's --repo-root seam against a
// throwaway git repo and synthetic --build commands; never touches this checkout or runs a real build.
//
// Run: node packages/daemon/test/negative-control-classification.mjs
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
const nodeBuild = (code) => `${JSON.stringify(process.execPath)} -e "process.exit(${code})"`;

// A fixture whose RED test (run against the reverted "broken" file) fails with the given test body, and
// whose GREEN (restored) run passes: the test body only fails while src/example.txt holds the broken text.
function runCase({ failBody, build = nodeBuild(0), extraArgs = [], extraTests = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-negctl-cls-${process.pid}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "src", "example.txt"), "broken\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "broken"]);
  fs.writeFileSync(path.join(dir, "src", "example.txt"), "fixed\n");
  const mk = (name, body) => {
    fs.writeFileSync(
      path.join(dir, "test", name),
      "import fs from 'node:fs';\n" +
        "const broken = fs.readFileSync('src/example.txt', 'utf8') === 'broken\\n';\n" +
        `if (broken) { ${body} }\n`,
    );
    return `test/${name}`;
  };
  const tests = [mk("t0.mjs", failBody), ...extraTests.map((b, i) => mk(`t${i + 1}.mjs`, b))];
  const args = [SCRIPT, "--file", "src/example.txt", "--ref", "HEAD", "--build", build, "--repo-root", dir, ...extraArgs];
  for (const t of tests) args.push("--test", t);
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  const restored = fs.readFileSync(path.join(dir, "src", "example.txt"), "utf8") === "fixed\n";
  fs.rmSync(dir, { recursive: true, force: true });
  const lastLine = r.stdout.trimEnd().split(/\r?\n/).pop();
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, restored, lastLine };
}

const redIs = (r, cls) => new RegExp(`RESULT: red=${cls}\\b`).test(r.lastLine);

// ── BEHAVIOURAL: FAIL lines; exact assertion count ──────────────────────────────────────────────────
{
  const r = runCase({ failBody: "console.log('FAIL  one'); console.log('FAIL  two'); console.log('PASS  three'); process.exit(1);" });
  check("BEHAVIOURAL: exits 0", r.status === 0);
  check("BEHAVIOURAL: RESULT line is last and says red=BEHAVIOURAL failingAssertions=2 ... => OK", redIs(r, "BEHAVIOURAL") && /failingAssertions=2 green=pass restore=verified => OK$/.test(r.lastLine));
  check("BEHAVIOURAL: file restored", r.restored);
}

// ── DECOY: a behavioural FAIL line whose text contains a structural phrase, plus a stderr signature ───
{
  const r = runCase({ failBody: "console.log('FAIL  rejects when x is not a function'); console.error('TypeError: y is not a function\\n    at z (file.mjs:1:1)'); process.exit(1);" });
  check("DECOY (FAIL line + stderr signature): stays BEHAVIOURAL, exit 0", r.status === 0 && redIs(r, "BEHAVIOURAL"));
}
{
  const r = runCase({ failBody: "console.log('is not a function / does not provide an export named'); process.exit(1);" });
  check("DECOY (signature text on STDOUT only, no FAIL line): not STRUCTURAL — UNCLASSIFIED, refused exit 3", r.status === 3 && redIs(r, "UNCLASSIFIED"));
}

// ── STRUCTURAL: each signature family; refused with exit 3 ──────────────────────────────────────────
const structuralBodies = {
  "missing export": "console.error(\"SyntaxError: The requested module './x.js' does not provide an export named 'foo'\"); process.exit(1);",
  "not a function": "console.error('TypeError: api.foo is not a function\\n    at file.mjs:1:1'); process.exit(1);",
  "cannot find module": "console.error(\"Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/y.js'\"); process.exit(1);",
  "ReferenceError + stack": "console.error('ReferenceError: foo is not defined\\n    at file.mjs:1:1'); process.exit(1);",
  "TS2305": "console.error(\"error TS2305: Module './x' has no exported member 'foo'.\"); process.exit(1);",
};
for (const [name, body] of Object.entries(structuralBodies)) {
  const r = runCase({ failBody: body });
  check(`STRUCTURAL (${name}): exit 3, red=STRUCTURAL, refused, 0 assertions`, r.status === 3 && redIs(r, "STRUCTURAL") && /failingAssertions=0 .*REFUSED\(red-class-STRUCTURAL\)$/.test(r.lastLine));
  check(`STRUCTURAL (${name}): file still restored`, r.restored);
}
{
  // Negative control for the stack-frame requirement: a bare "ReferenceError" word with no stack is NOT structural.
  const r = runCase({ failBody: "console.error('ReferenceError mentioned in prose'); process.exit(1);" });
  check("ReferenceError WITHOUT a stack frame is not matched (UNCLASSIFIED, not STRUCTURAL)", redIs(r, "UNCLASSIFIED"));
}

// ── UNCLASSIFIED: exit 1, nothing printed ───────────────────────────────────────────────────────────
{
  const r = runCase({ failBody: "process.exit(1);" });
  check("UNCLASSIFIED (exit 1, silent): exit 3, red=UNCLASSIFIED, 0 assertions, refused", r.status === 3 && redIs(r, "UNCLASSIFIED") && /failingAssertions=0 .*REFUSED\(red-class-UNCLASSIFIED\)$/.test(r.lastLine));
  check("UNCLASSIFIED: stderr says why (0 recognised assertion lines in the CLASS line)", /0 recognised assertion line/.test(r.stdout));
}

// ── BUILD-ONLY: build exits non-zero (even though the test also fails with a FAIL line) ──────────────
{
  const r = runCase({ failBody: "console.log('FAIL  stale dist'); process.exit(1);", build: nodeBuild(1) });
  check("BUILD-ONLY: exit non-zero, red=BUILD-ONLY (a FAIL line cannot launder a failed build)", r.status !== 0 && redIs(r, "BUILD-ONLY"));
  check("BUILD-ONLY: file restored", r.restored);
}

// ── MIXED: one structural + one behavioural failing test → BEHAVIOURAL ──────────────────────────────
{
  const r = runCase({ failBody: structuralBodies["not a function"], extraTests: ["console.log('FAIL  real assertion'); process.exit(1);"] });
  check("MIXED (structural + behavioural): phase is BEHAVIOURAL, exit 0, failingAssertions=1", r.status === 0 && redIs(r, "BEHAVIOURAL") && /failingAssertions=1 /.test(r.lastLine));
}

// ── --allow-structural accepts STRUCTURAL, UNCLASSIFIED and BUILD-ONLY, still reports the class ──────
{
  const s = runCase({ failBody: structuralBodies["missing export"], extraArgs: ["--allow-structural"] });
  check("--allow-structural: STRUCTURAL ⇒ exit 0, RESULT shows red=STRUCTURAL(allowed) => OK", s.status === 0 && /red=STRUCTURAL\(allowed\) .*=> OK$/.test(s.lastLine));
  const u = runCase({ failBody: "process.exit(1);", extraArgs: ["--allow-structural"] });
  check("--allow-structural: UNCLASSIFIED ⇒ exit 0", u.status === 0 && /red=UNCLASSIFIED\(allowed\)/.test(u.lastLine));
  const b = runCase({ failBody: "process.exit(1);", build: nodeBuild(1), extraArgs: ["--allow-structural"] });
  // GREEN also uses the failing build here, so the run as a whole fails — but on GREEN, not on the class.
  check("--allow-structural: BUILD-ONLY RED is not itself refused (failure here is the GREEN build, exit 1 not 3)", b.status === 1 && !/REFUSED\(red-class/.test(b.lastLine));
}

// ── RED that does not fail at all keeps its old refusal (exit 1, not the class exit) ─────────────────
{
  const r = runCase({ failBody: "process.exit(0);" });
  check("RED phase passing: exit 1 (not 3), red=NONE", r.status === 1 && redIs(r, "NONE"));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
