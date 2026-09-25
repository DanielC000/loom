// Card 14e733fb: a NORMAL, always-PASSING hermetic test — except when LOOM_TEST_EPILOGUE_FLUSH_MARKER is
// set, in which case it deliberately fails with a large, distinctive multi-line stdout+stderr payload.
// Only test-daemon-failures-epilogue-flush.mjs (via `--only=epilogue-flush-fixture`) ever sets that env
// var, so a normal full-suite run always takes the pass branch below and never pollutes a real gate run.
// This exists so the OTHER file can exercise scripts/test-daemon.mjs's own `FAILURES:` epilogue — and its
// synchronous-flush fix — through the REAL entry point (`node scripts/test-daemon.mjs --only=<name>`),
// never by importing test-daemon.mjs's internals directly.

import fs from "node:fs";

const marker = process.env.LOOM_TEST_EPILOGUE_FLUSH_MARKER;

if (marker) {
  // Deliberately large + line-numbered so a truncated echo (missing a prefix or a suffix of these lines)
  // is unambiguously detectable by the caller.
  const lineCount = Number(process.env.LOOM_TEST_EPILOGUE_FLUSH_LINE_COUNT ?? "200");
  // Card acf17673: written with fs.writeSync on fds 1/2, NEVER console.log/console.error + process.exit(1).
  // On POSIX a piped process.stdout write is async, so process.exit(1) right after 300 console.log calls
  // dropped a load-dependent tail of THIS fixture's own output before test-daemon.mjs ever captured it
  // (reproduced on Linux under CPU load with the fixture run directly, no harness in the path) — which
  // read as writeFullySync losing the epilogue. Touching process.stdout also flips the shared pipe fd to
  // O_NONBLOCK; fs.writeSync alone leaves it blocking, and the loop below covers a partial write anyway.
  const writeAll = (fd, text) => {
    const buf = Buffer.from(text, "utf-8");
    let off = 0;
    const deadline = Date.now() + 10_000;
    while (off < buf.length && Date.now() < deadline) {
      try { off += fs.writeSync(fd, buf, off, buf.length - off); } catch (e) { if (e.code !== "EAGAIN") throw e; }
    }
  };
  let body = "";
  for (let i = 0; i < lineCount; i++) body += `${marker}-STDOUT-LINE-${i}\n`;
  writeAll(1, body);
  writeAll(2, `${marker}-STDERR-TAIL\n`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
check("epilogue-flush-fixture: no-op pass when not forced to fail (LOOM_TEST_EPILOGUE_FLUSH_MARKER unset)", true);
process.exit(failures === 0 ? 0 : 1);
