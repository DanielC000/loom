import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs+git
// Card 4dea1939 — the EOL guard's untracked listing must return REAL paths for non-ASCII names.
// `git ls-files --others` without `-z` C-quotes such a name (core.quotePath: "\342\200\224.md" in double
// quotes), which matches no file on disk, so the guard silently skipped an untracked bare-LF file whose
// name had an em dash while flagging its ASCII twin. Fixture repo, `* text=auto` + autocrlf=true.
// Run: node packages/daemon/test/working-tree-eol-guard-nonascii-untracked.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { scanEolViolations, listUntrackedFiles } from "./_eol-policy.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const fixtureRoot = mkdtempManaged("loom-eol-nonascii-");
try {
  const git = (...args) => execFileSync("git", ["-C", fixtureRoot, ...args], { encoding: "buffer" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "true");
  fs.writeFileSync(path.join(fixtureRoot, ".gitattributes"), "* text=auto\r\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const asciiName = "plain-note.md";
  const dashName = "note — dash.md";
  const accentName = "café.md";
  for (const n of [asciiName, dashName, accentName]) fs.writeFileSync(path.join(fixtureRoot, n), "# t\nbare lf\n"); // untracked, LF

  const listed = listUntrackedFiles(fixtureRoot) || [];
  check("untracked listing returns the real (unquoted) non-ASCII names", listed.includes(dashName) && listed.includes(accentName));
  check("untracked listing still returns the ASCII name", listed.includes(asciiName));

  const flagged = scanEolViolations(fixtureRoot).violations.map((v) => v.file);
  check("ASCII-named untracked bare-LF file is flagged (control)", flagged.includes(asciiName));
  check("em-dash-named untracked bare-LF file is flagged", flagged.includes(dashName));
  check("accent-named untracked bare-LF file is flagged", flagged.includes(accentName));
} catch (e) {
  console.log(`FAIL  unexpected error: ${e && e.stack || e}`);
  failures++;
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
