// Card 14e733fb: a NORMAL, always-PASSING hermetic test — except when LOOM_TEST_EPILOGUE_FLUSH_MARKER is
// set, in which case it deliberately fails with a large, distinctive multi-line stdout+stderr payload.
// Only test-daemon-failures-epilogue-flush.mjs (via `--only=epilogue-flush-fixture`) ever sets that env
// var, so a normal full-suite run always takes the pass branch below and never pollutes a real gate run.
// This exists so the OTHER file can exercise scripts/test-daemon.mjs's own `FAILURES:` epilogue — and its
// synchronous-flush fix — through the REAL entry point (`node scripts/test-daemon.mjs --only=<name>`),
// never by importing test-daemon.mjs's internals directly.

const marker = process.env.LOOM_TEST_EPILOGUE_FLUSH_MARKER;

if (marker) {
  // Deliberately large + line-numbered so a truncated echo (missing a prefix or a suffix of these lines)
  // is unambiguously detectable by the caller.
  const lineCount = Number(process.env.LOOM_TEST_EPILOGUE_FLUSH_LINE_COUNT ?? "200");
  for (let i = 0; i < lineCount; i++) console.log(`${marker}-STDOUT-LINE-${i}`);
  console.error(`${marker}-STDERR-TAIL`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
check("epilogue-flush-fixture: no-op pass when not forced to fail (LOOM_TEST_EPILOGUE_FLUSH_MARKER unset)", true);
process.exit(failures === 0 ? 0 : 1);
