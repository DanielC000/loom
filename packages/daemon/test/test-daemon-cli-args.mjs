// Card 05724a32 acceptance evidence: scripts/test-daemon.mjs used to have NO unknown-flag rejection —
// `const countOnly = process.argv.includes("--count") || process.argv.includes("--list")` meant ANY other
// argument (a typo, e.g. `--nope`) fell straight through to a full ~20min suite run, silently, since the
// broken invocation and a bare `node scripts/test-daemon.mjs` were observably identical up to that point.
//
// Exercises the exported `classifyCliArgs` pure classifier directly — never a subprocess spawn of this
// script itself. That matters here specifically: the "no flags" outcome means "run the full suite", so
// spawning it (even to kill it quickly) would nest an entire hermetic test run inside this one test.
// `discoverHermeticTests`/`auditDiscoveryAgainstGit` in test-daemon-discovery.mjs already establish this
// import-without-triggering-isMain pattern for this exact file.
import { classifyCliArgs, KNOWN_CLI_FLAGS } from "../scripts/test-daemon.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// [positive control] the real bug: an unrecognized flag must classify as "error", never "run" (which is
// what silently launched the full suite before the fix) and never "count"/"help" either.
{
  const result = classifyCliArgs(["--nope"]);
  check("[positive control] an unrecognized flag classifies as mode:error, not mode:run", result.mode === "error");
  check("the offending flag is named in the result", result.unrecognized?.includes("--nope"));
}

// A flag-shaped-looking typo of a real flag must still be rejected — not fuzzy-matched or silently
// accepted.
{
  const result = classifyCliArgs(["--counts"]);
  check("a near-miss of a real flag (--counts) is still rejected as unrecognized, not fuzzy-matched", result.mode === "error" && result.unrecognized.includes("--counts"));
}

// Multiple bad args are all named, not just the first.
{
  const result = classifyCliArgs(["--nope", "--also-bad"]);
  check("multiple unrecognized args are ALL named", result.mode === "error" && result.unrecognized.length === 2 && result.unrecognized.includes("--nope") && result.unrecognized.includes("--also-bad"));
}

// A mix of one real flag and one bad one must still refuse — a valid flag never rescues an invalid one
// (fail closed, not "at least one flag was fine").
{
  const result = classifyCliArgs(["--count", "--nope"]);
  check("a valid flag alongside an invalid one still refuses (fail closed, not partial accept)", result.mode === "error" && result.unrecognized.includes("--nope") && !result.unrecognized.includes("--count"));
}

// --help / -h: dedicated mode, takes priority over any other args present.
{
  check("--help classifies as mode:help", classifyCliArgs(["--help"]).mode === "help");
  check("-h classifies as mode:help", classifyCliArgs(["-h"]).mode === "help");
  check("--help takes priority even alongside an otherwise-invalid arg", classifyCliArgs(["--nope", "--help"]).mode === "help");
}

// [negative controls] every currently-supported flag must still work, individually — a fix that tightens
// parsing must not collaterally break a real flag (this script is invoked BY the merge gate itself).
{
  check("[negative control] --count still classifies as mode:count", classifyCliArgs(["--count"]).mode === "count");
  check("[negative control] --list still classifies as mode:count (alias)", classifyCliArgs(["--list"]).mode === "count");
  check("[negative control] no args at all still classifies as mode:run (the real gate invocation)", classifyCliArgs([]).mode === "run");
}

// KNOWN_CLI_FLAGS is exported so the error message can name the real, current flag set — assert it's
// exactly the set this test exercises above, so a future flag addition can't silently drift the two apart.
check(
  "KNOWN_CLI_FLAGS is exactly {--count, --list, --help, -h}",
  KNOWN_CLI_FLAGS.size === 4 && ["--count", "--list", "--help", "-h"].every((f) => KNOWN_CLI_FLAGS.has(f)),
);

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-cli-args: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
