import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs+git
// Card 97ddb56b — proves `working-tree-eol-guard.mjs --fix`'s engine (`_eol-policy.mjs`'s
// `scanEolViolations` + `fixViolations`) end to end on a throwaway git repo with the same .gitattributes
// shape as this repo (`* text=auto` plus an `eol=lf` pin) under core.autocrlf=true:
//   bare-LF new file -> scan RED -> fixViolations -> scan GREEN, and an eol=lf path that must end CR==0.
// Also pins what --fix must NOT do: touch a clean file, touch the index, write outside the root, or be
// reachable from the guards runner (which passes no argv to the guards it spawns).
// Run: node packages/daemon/test/working-tree-eol-guard-fix.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, unregister, finishAndExit } from "./_tmp-fixture.mjs";
import { scanEolViolations, fixViolations, convertToPolicy, countEndings } from "./_eol-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const crlfBytes = (s) => Buffer.from(s.split("\n").join("\r\n"), "latin1");

const fixtureRoot = mkdtempManaged("loom-eol-fix-");
const outsideDir = mkdtempManaged("loom-eol-fix-outside-");
try {
  const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args], { encoding: "buffer" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "true"); // emulate the Windows host regardless of the runner's global config
  fs.writeFileSync(path.join(fixtureRoot, ".gitattributes"), "* text=auto\r\nlfpinned/** text eol=lf\r\n");
  fs.mkdirSync(path.join(fixtureRoot, "lfpinned"));
  fs.writeFileSync(path.join(fixtureRoot, "clean.json"), crlfBytes('{\n  "a": 1\n}\n'));
  fs.writeFileSync(path.join(fixtureRoot, "lfpinned", "ok.md"), "# ok\nstays lf\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const cleanBefore = fs.readFileSync(path.join(fixtureRoot, "clean.json"));
  const okBefore = fs.readFileSync(path.join(fixtureRoot, "lfpinned", "ok.md"));
  check("(baseline) a fixture with only correct files scans GREEN", scanEolViolations(fixtureRoot).violations.length === 0);

  // The exact shape of the incident: whole-file Write of NEW files lands bare LF.
  fs.writeFileSync(path.join(fixtureRoot, "new-untracked.ts"), "const a = 1;\nconst b = 2;\n");            // untracked, crlf policy
  fs.writeFileSync(path.join(fixtureRoot, "new-staged.ts"), "export const s = 1;\nexport const t = 2;\n"); // will be git-added
  git("add", "new-staged.ts");
  fs.writeFileSync(path.join(fixtureRoot, "lfpinned", "new.sh"), "#!/bin/sh\r\necho hi\r\n");              // eol=lf path with CRLF
  fs.writeFileSync(path.join(fixtureRoot, "mixed.txt"), "one\r\ntwo\nthree\r\n");                          // mixed endings, crlf policy
  const indexBefore = git("ls-files", "-s", "new-staged.ts").toString("utf8").replace(/\s+\d+\t/, " ");

  const red = scanEolViolations(fixtureRoot);
  const redFiles = red.violations.map((v) => v.file).sort();
  check(`RED: the guard's scan flags exactly the four bad files (got ${redFiles.join(", ")})`,
    redFiles.join(",") === ["lfpinned/new.sh", "mixed.txt", "new-staged.ts", "new-untracked.ts"].join(","));
  check("RED: the eol=lf-pinned file is flagged with policy lf, the others with crlf",
    red.violations.find((v) => v.file === "lfpinned/new.sh")?.policy === "lf" &&
    red.violations.filter((v) => v.file !== "lfpinned/new.sh").every((v) => v.policy === "crlf"));

  // A path that escapes the root must be refused and left untouched, never written.
  const outsideFile = path.join(outsideDir, "victim.txt");
  fs.writeFileSync(outsideFile, "a\nb\n");
  const escapeRel = path.relative(fixtureRoot, outsideFile);
  const { changed, skipped } = fixViolations(fixtureRoot, [
    ...red.violations,
    { file: escapeRel, tracked: false, policy: "crlf", crlf: 0, bareLf: 2 },
    { file: path.resolve(outsideFile), tracked: false, policy: "crlf", crlf: 0, bareLf: 2 },
  ]);
  check(`--fix rewrote exactly the four flagged files (changed: ${changed.map((c) => c.file).sort().join(", ")})`, changed.length === 4);
  check("--fix refused both outside-the-root paths (relative ../ and absolute)", skipped.length === 2 && skipped.every((s) => s.reason === "outside the worktree"));
  check("--fix left the outside-the-root file byte-identical", fs.readFileSync(outsideFile).equals(Buffer.from("a\nb\n")));

  const green = scanEolViolations(fixtureRoot);
  check("GREEN: re-scan after --fix reports zero violations", green.violations.length === 0);

  const newSh = fs.readFileSync(path.join(fixtureRoot, "lfpinned", "new.sh"));
  check("eol=lf-pinned path ends with CR==0 (and keeps its content)", countEndings(newSh).crlf === 0 && newSh.toString("latin1") === "#!/bin/sh\necho hi\n");
  const untrackedNow = fs.readFileSync(path.join(fixtureRoot, "new-untracked.ts"));
  check("bare-LF new file ends fully CRLF (CR==LF, content preserved)",
    countEndings(untrackedNow).bareLf === 0 && untrackedNow.equals(crlfBytes("const a = 1;\nconst b = 2;\n")));
  check("a MIXED-ending file converges to all-CRLF", fs.readFileSync(path.join(fixtureRoot, "mixed.txt")).equals(crlfBytes("one\ntwo\nthree\n")));

  check("untouched files are byte-identical (clean CRLF file + correct LF-pinned file)",
    fs.readFileSync(path.join(fixtureRoot, "clean.json")).equals(cleanBefore) && fs.readFileSync(path.join(fixtureRoot, "lfpinned", "ok.md")).equals(okBefore));
  const indexAfter = git("ls-files", "-s", "new-staged.ts").toString("utf8").replace(/\s+\d+\t/, " ");
  check("the already-staged file's index entry is unchanged by --fix (no re-add needed)", indexBefore === indexAfter);
  check("an immediate second --fix is a no-op", fixViolations(fixtureRoot, green.violations).changed.length === 0);

  check("(unit) convertToPolicy is idempotent in both directions",
    convertToPolicy(convertToPolicy(Buffer.from("x\ny\n"), "crlf"), "crlf").equals(crlfBytes("x\ny\n")) &&
    convertToPolicy(convertToPolicy(Buffer.from("x\r\ny\r\n"), "lf"), "lf").equals(Buffer.from("x\ny\n")));

  // The runner must never be able to trigger --fix: it spawns each guard with only its own path as argv.
  const runnerSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-static-guards.mjs"), "utf8");
  check("the guards runner spawns each guard with only the guard path as argv (no --fix can ride along)",
    /spawnSync\(process\.execPath, \[repoRelPath\]/.test(runnerSrc) && !runnerSrc.includes("--fix"));
} finally {
  for (const d of [fixtureRoot, outsideDir]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${d} — ${err}`); }
    if (!fs.existsSync(d)) unregister(d);
  }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
