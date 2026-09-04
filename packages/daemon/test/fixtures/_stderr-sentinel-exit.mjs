// Card bf30e8b6 fixture: writes a known, uniquely-greppable SENTINEL payload to stderr and then exits 1 by
// one of several MODES (argv[3]) at a chosen payload SIZE (argv[2] bytes) — used to test whether the
// runOne/spawnWithTimeout capture path in scripts/test-daemon.mjs (spawn().stderr.on("data") accumulated
// until the "close" event) can lose stderr content to a race between the child's own exit and the async
// pipe drain. See test/test-daemon-stderr-capture-race.mjs (the driver) for what each mode measures.
//
// The payload carries a START marker and an END marker so the driver can tell PARTIAL loss (only the tail
// truncated) from TOTAL loss (nothing arrived at all) — either shape would confirm the race; neither
// marker missing is the clean/expected result.
const size = Number(process.argv[2]) || 100;
const mode = process.argv[3] || "throw";
const marker = process.argv[4] || "SENTINEL";

const fillerLen = Math.max(0, size - (`${marker}-START\n`.length + `\n${marker}-END`.length));
const payload = `${marker}-START\n${"x".repeat(fillerLen)}\n${marker}-END`;

if (mode === "throw") {
  // The REALISTIC shape: an uncaught exception, exactly how a real assertion/exception failure in a test
  // file surfaces — Node's own fatal-exception handler writes the stack (including this message) to
  // stderr and exits 1. This is the shape `merge-composer-integrity-warning`'s own missing diagnostic
  // would have taken if it threw rather than printed a FAIL line.
  throw new Error(payload);
}

if (mode === "write-then-exit-sync") {
  // THE RACE CANDIDATE: write to stderr, then call process.exit(1) IMMEDIATELY — synchronously, without
  // waiting for the write's own callback/flush. On a platform where a stderr pipe write is asynchronous,
  // this can outrun the OS pipe buffer being drained before the process (and its stdio handles) close.
  process.stderr.write(payload);
  process.exit(1);
} else if (mode === "write-then-exit-callback") {
  // The documented-SAFE explicit pattern: wait for the write's own callback (guaranteed flushed to the OS)
  // before exiting — contrast case for the exit-TIMING axis, distinct from the size axis.
  process.stderr.write(payload, () => process.exit(1));
} else if (mode === "write-then-natural") {
  // Contrast: write, then let Node's normal event-loop drain/exit happen — no explicit process.exit() call
  // at all. The ordinary, undisputed-safe shape.
  process.stderr.write(payload);
  process.exitCode = 1;
}
