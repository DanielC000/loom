// Card 01d30507 belt-and-braces: scripts/build-npm-package.mjs step 4 copies PACKAGED_ROOTS.daemonDist
// (packages/daemon/dist) WHOLESALE into the published tarball via fs.cpSync with no filtering at all —
// so any stray file sitting there ships verbatim regardless of how it got there. findStrayDistShims()
// is the pure check that detects a leftover graceful-teardown-hard-exit-backstop.mjs dist-patch shim
// before that copy happens (the isMain-guarded block refuses the whole build if it finds one). This test
// exercises ONLY the pure, exported detection function against a throwaway fixture dir — never the real
// packaging side effects (no `pnpm build`, no `npm pack`), so it stays fast and hermetic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStrayDistShims } from "../../../scripts/build-npm-package.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const fixtureDir = mkdtempManaged("loom-build-npm-package-stray-shim-");

// Negative control: an ordinary, real dist-shaped directory with no stray shim must return empty.
fs.writeFileSync(path.join(fixtureDir, "graceful-teardown.js"), "// real compiled module\n");
fs.writeFileSync(path.join(fixtureDir, "index.js"), "// real compiled module\n");
check(
  "[negative control] an ordinary dist dir with no stray shim reports none",
  findStrayDistShims(fixtureDir).length === 0,
);

// Positive control: a leftover clockshim sibling (round-6 clock-patch shape) is detected.
const clockshimName = `graceful-teardown.clockshim-${process.pid}-ab12cd.js`;
fs.writeFileSync(path.join(fixtureDir, clockshimName), "// stray test-patch shim\n");
check(
  "[positive control] a leftover graceful-teardown.clockshim-*.js sibling is detected",
  findStrayDistShims(fixtureDir).includes(clockshimName),
);
fs.unlinkSync(path.join(fixtureDir, clockshimName));

// Positive control: a leftover winrace sibling (win32 PS-script patch shape) is also detected.
const winraceName = `graceful-teardown.winrace-${process.pid}-ef34gh.js`;
fs.writeFileSync(path.join(fixtureDir, winraceName), "// stray test-patch shim\n");
check(
  "[positive control] a leftover graceful-teardown.winrace-*.js sibling is detected",
  findStrayDistShims(fixtureDir).includes(winraceName),
);
fs.unlinkSync(path.join(fixtureDir, winraceName));

// A filename that merely CONTAINS "clockshim"/"winrace" without the exact anchored prefix shape must
// NOT false-positive (the regex is anchored to the start of the basename).
fs.writeFileSync(path.join(fixtureDir, "not-a-real-clockshim-match.js"), "// unrelated\n");
check(
  "[negative control] a filename merely containing 'clockshim' without the anchored prefix is not flagged",
  findStrayDistShims(fixtureDir).length === 0,
);

// A missing directory (e.g. a build that hasn't run yet) must return empty rather than throw — this
// check runs BEFORE build-npm-package.mjs's own "daemon dist exists" verification step, so it must be
// safe to call even when the directory genuinely isn't there yet. The path is never created by anything
// (findStrayDistShims only fs.readdirSync's it and catches ENOENT), but it still carries a per-run-unique
// suffix rather than a bare fixed literal — same avoidance shape fixed-tmpdir-literal-guard.mjs polices
// for any path.join(os.tmpdir(), ...) fixture site, even one that (like this one) never actually touches
// the filesystem at that path.
check(
  "[missing dir] a nonexistent directory returns an empty list rather than throwing",
  findStrayDistShims(path.join(os.tmpdir(), `loom-nonexistent-dist-dir-for-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)).length === 0,
);

console.log(`\n${failures === 0 ? "✅" : "❌"} build-npm-package-stray-shim-guard: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
