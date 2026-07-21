// Gate lint: no literal NUL bytes in ANY tracked *.ts file (card dda55f2e / origin finding e16e27c1).
// A NUL byte inside a tracked TypeScript source file makes ripgrep (and therefore the Grep tool, and
// plain `grep` without `-a`) silently treat the WHOLE file as binary and stop searching after the first
// match — so any grep-based "does X exist" / "is X still used" search past that byte returns a false
// negative. This bit packages/daemon/src/sessions/service.ts for real (a hash-domain-separator literal
// written as a raw 0x00 byte instead of the escaped `"\0"` form) before this task replaced it — a Dev
// worker nearly concluded a real, live-called function was dead code because its only other call site
// sat past the NUL. This test is the backstop: it fails the gate the moment a NEW literal NUL sneaks
// into any tracked .ts file, and separately proves the detector actually catches one (fixture repo).
//
// HERMETIC: git + fs only — no daemon, no build required. Run: node test/no-nul-in-tracked-ts.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Lists every tracked *.ts file under repoRoot and reports any whose CURRENT working-tree content
// contains a literal NUL (0x00) byte, with the byte offset it was found at.
function findNulBytesInTrackedTs(repoRoot) {
  const listing = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "*.ts"], { encoding: "buffer" });
  const files = listing.toString("utf8").split("\0").filter(Boolean);
  const offenders = [];
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; } // tracked but absent from the working tree
    const idx = buf.indexOf(0);
    if (idx !== -1) offenders.push({ file: rel, offset: idx });
  }
  return offenders;
}

// --- (A) the detector actually detects an injected NUL — proven against a REAL fixture git repo ----
{
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-nul-lint-fixture-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: fixtureRoot });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");

    fs.writeFileSync(path.join(fixtureRoot, "clean.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(fixtureRoot, "dirty.ts"), Buffer.from("export const bad = \"\0\";\n", "latin1"));
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    const offenders = findNulBytesInTrackedTs(fixtureRoot);
    check("(fixture) detector FAILS the file with an injected NUL byte", offenders.some((o) => o.file === "dirty.ts"));
    check("(fixture) detector does NOT flag the clean sibling file", !offenders.some((o) => o.file === "clean.ts"));
    check("(fixture) exactly one offender found", offenders.length === 1);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// --- (B) the real backstop: THIS repo's tracked *.ts files carry zero NUL bytes right now -----------
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, "..", "..", ".."); // test/ -> daemon -> packages -> repo root
  const offenders = findNulBytesInTrackedTs(repoRoot);
  if (offenders.length) {
    for (const o of offenders) console.log(`      NUL byte at offset ${o.offset} in ${o.file}`);
  }
  check("(repo) no tracked *.ts file contains a literal NUL byte", offenders.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the NUL-byte detector correctly flags an injected NUL in a fixture repo, and this repo's tracked *.ts files are clean."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
