// Card 22d995ca: a NORMAL, always-PASSING hermetic test — except when LOOM_TEST_DECLARED_WARNING_MARKER
// is set, in which case it ALSO prints one declared `WARN  ` line (the two-space convention
// scripts/test-daemon.mjs's own `declaredWarnings` scan looks for — see that file's comment near its
// `WARN_LINE_RE`) while STILL exiting 0. This simulates exactly the shape this card fixes: a known,
// non-blocking, declared warning living inside an otherwise-passing file (the real specimen is
// codex-transcript-real-spawn.mjs's `reportGracefulStopExitCode`).
//
// Only warn-marker-surfaces-on-pass.mjs (via `--only=warn-marker-declared-warning-fixture`) ever sets
// that env var, so a normal full-suite run always takes the plain-pass branch below and this fixture
// never pollutes a real gate run with a spurious WARNINGS: block.

const marker = process.env.LOOM_TEST_DECLARED_WARNING_MARKER;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (marker) {
  console.log(`WARN  ${marker}-DECLARED-WARNING: a deliberate, non-blocking test-side warning (card 22d995ca) — this file still passes.`);
}
check("warn-marker-declared-warning-fixture: always passes regardless of LOOM_TEST_DECLARED_WARNING_MARKER", true);
process.exit(failures === 0 ? 0 : 1);
