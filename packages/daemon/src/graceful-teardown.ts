import { waitForMergeDangerWindowsToClear } from "./git/merge-danger-window.js";

/**
 * This function is the structural fix: it runs `teardown()` best-effort — ANY synchronous throw inside it
 * (not just the one write that has actually been observed to throw; a future write or fault added to that
 * body is covered too) is swallowed — and then UNCONDITIONALLY awaits the merge-danger-window guard before
 * calling `exit`.
 *
 * @decision 7f9444f3 — no teardown write may run unguarded ahead of the merge-danger-aware exit: an
 * unguarded `console.log` in `gracefulShutdown` once threw EPIPE (destroyed stdout, Windows-console-close
 * SIGHUP), skipping it and writing a phantom crash.log misread as `[loom:crash-recovered]`.
 *
 * Because the guard+exit sits outside the try, no failure inside `teardown()` can ever prevent it from
 * running, and because the throw never escapes this function, it can never reach the process-level
 * `uncaughtException` handler that would write a crash record for what is a clean stop.
 */
export function runGracefulTeardown(
  teardown: () => void,
  exit: () => void,
  waitFn: () => Promise<void> = waitForMergeDangerWindowsToClear,
): void {
  try {
    teardown();
  } catch {
    /* never let a teardown-step failure (incl. a destroyed stdout/stderr) block the merge-danger-aware exit below */
  }
  void waitFn().finally(exit); // always a clean stop — NOT exit 75 (the supervisor's restart sentinel)
}
