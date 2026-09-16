// Local duplicate of packages/daemon/src/crashlog.ts's installEpipeTolerantStdio, for
// scripts/daemon-supervisor.mjs — which runs BEFORE the daemon package is even built, so it cannot
// import daemon src/dist. Same duplication rationale as CRASHLOG_MAX_GENERATIONS (see that constant's
// own doc in both files); kept in sync by packages/daemon/test/epipe-tolerant-stdio-supervisor-parity.mjs.
//
// @decision 3fba0cd2 — do not widen either guard's swallow past code === "EPIPE"; the `.on("error")`
// listener is the one that actually fires for a real severed pipe against a net.Socket-backed
// stdout/stderr (verified in packages/daemon/test/epipe-tolerant-stdio.mjs), the write-wrapper alone
// does not stop it — keep both, and call this before anything else writes to stdout/stderr.

/**
 * Wrap `process.stdout`/`process.stderr` against a destroyed pipe (e.g. the hosting console/terminal
 * going away), which otherwise reaches `uncaughtException` and kills the process. Two independent
 * guards, BOTH required: a try/catch around `write()` itself (covers a stream whose write genuinely
 * throws synchronously) PLUS an `.on("error")` listener (covers a real `net.Socket`-backed stdout,
 * where `write()` returns normally and the failure surfaces later as an async `"error"` event that
 * Node rethrows as `uncaughtException` when nothing is listening).
 */
export function installEpipeTolerantStdio() {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (...args) => {
      try {
        return original(...args);
      } catch (err) {
        if (err?.code === "EPIPE") return false;
        throw err;
      }
    };
    stream.on("error", (err) => {
      if (err?.code !== "EPIPE") throw err;
    });
  }
}
