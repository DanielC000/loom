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
import { classifyCliArgs, KNOWN_CLI_FLAGS, KNOWN_CLI_VALUE_PREFIXES, resolveSelection } from "../scripts/test-daemon.mjs";

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

// Card 6185fbfc: --only=/--exclude=/--concurrency= — a standalone selection capability, decoupled from
// any change to the real gate command (this card left the gate command itself unchanged). Value-bearing,
// so recognized by PREFIX, kept in a SEPARATE export from KNOWN_CLI_FLAGS (exact-match) above.
{
  check(
    "KNOWN_CLI_VALUE_PREFIXES is exactly {--only=, --exclude=, --concurrency=}",
    KNOWN_CLI_VALUE_PREFIXES.length === 3 && ["--only=", "--exclude=", "--concurrency="].every((p) => KNOWN_CLI_VALUE_PREFIXES.includes(p)),
  );

  check("--only=a,b classifies as mode:run with only:['a','b']", (() => {
    const r = classifyCliArgs(["--only=a,b"]);
    return r.mode === "run" && Array.isArray(r.only) && r.only.length === 2 && r.only[0] === "a" && r.only[1] === "b";
  })());
  check("--only= list is trimmed and drops empty entries (a, ,b -> ['a','b'])", (() => {
    const r = classifyCliArgs(["--only=a, ,b"]);
    return r.only.length === 2 && r.only[0] === "a" && r.only[1] === "b";
  })());
  check("--exclude=x classifies as mode:run with exclude:['x'], only left null", (() => {
    const r = classifyCliArgs(["--exclude=x"]);
    return r.mode === "run" && r.only === null && Array.isArray(r.exclude) && r.exclude.length === 1 && r.exclude[0] === "x";
  })());
  check("no --only/--exclude/--concurrency given -> all three null (byte-identical default path)", (() => {
    const r = classifyCliArgs([]);
    return r.only === null && r.exclude === null && r.concurrency === null;
  })());

  check("--concurrency=3 classifies as mode:run with concurrency:3", classifyCliArgs(["--concurrency=3"]).concurrency === 3);
  check("[positive control] --concurrency=abc (not a number) is rejected, not silently defaulted", (() => {
    const r = classifyCliArgs(["--concurrency=abc"]);
    return r.mode === "error" && r.unrecognized.some((u) => u.includes("--concurrency=abc"));
  })());
  check("[positive control] --concurrency=0 is rejected (must be a POSITIVE integer)", classifyCliArgs(["--concurrency=0"]).mode === "error");
  check("[positive control] --concurrency=-1 is rejected", classifyCliArgs(["--concurrency=-1"]).mode === "error");
  check("[positive control] --concurrency=1.5 is rejected (integer only)", classifyCliArgs(["--concurrency=1.5"]).mode === "error");
  check("--count alongside --only= still classifies as mode:count (--count/--list take priority, unchanged)", classifyCliArgs(["--count", "--only=a"]).mode === "count");

  // resolveSelection: pure selection-resolution logic, exercised directly (no subprocess spawn).
  const HERM = ["a", "b", "c"];
  check("no only/exclude -> selected IS the same array reference as the input (default-path proof)", (() => {
    const r = resolveSelection(HERM, {});
    return r.error === null && r.selected === HERM;
  })());
  check("--only=a,c narrows to exactly those two, in the given order", (() => {
    const r = resolveSelection(HERM, { only: ["a", "c"] });
    return r.error === null && r.selected.length === 2 && r.selected[0] === "a" && r.selected[1] === "c";
  })());
  check("[positive control] --only names an unknown file -> refused, selected:null", (() => {
    const r = resolveSelection(HERM, { only: ["a", "nope"] });
    return r.selected === null && r.error?.includes("nope");
  })());
  check("--exclude=b removes exactly b, keeps a and c", (() => {
    const r = resolveSelection(HERM, { exclude: ["b"] });
    return r.error === null && r.selected.length === 2 && r.selected.includes("a") && r.selected.includes("c") && !r.selected.includes("b");
  })());
  check("[positive control] --exclude names an unknown file -> refused (a typo must not silently no-op)", (() => {
    const r = resolveSelection(HERM, { exclude: ["nope"] });
    return r.selected === null && r.error?.includes("nope");
  })());
  check("--only=a,b,c + --exclude=b composes: exclude applies on top of only", (() => {
    const r = resolveSelection(HERM, { only: ["a", "b", "c"], exclude: ["b"] });
    return r.error === null && r.selected.length === 2 && r.selected.includes("a") && r.selected.includes("c");
  })());
  check("[positive control] a selection that empties to zero is refused, not silently reported green", (() => {
    const r = resolveSelection(HERM, { only: ["a"], exclude: ["a"] });
    return r.selected === null && r.error?.toLowerCase().includes("zero");
  })());
}

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-cli-args: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
