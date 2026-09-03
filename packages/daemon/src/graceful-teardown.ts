import { waitForMergeDangerWindowsToClear } from "./git/merge-danger-window.js";

/**
 * Card 7f9444f3: a real crash showed `gracefulShutdown` (index.ts) throwing an `uncaughtException` from
 * an UNGUARDED `console.log` — EPIPE on a destroyed stdout (the Windows-console-close SIGHUP case is the
 * realistic trigger, since Node emits SIGHUP for that). That throw sat on the line immediately BEFORE the
 * merge-danger-aware exit board card `5a7692a4` added, so it skipped `waitForMergeDangerWindowsToClear()`
 * entirely — reopening the exact ~92s-margin mid-canonical-merge-squash hazard that card exists to
 * prevent — AND turned a clean, deliberate signal stop into a fatal exception that writes a phantom
 * crash.log, misread by the next boot as `[loom:crash-recovered]`.
 *
 * This function is the structural fix: it runs `teardown()` best-effort — ANY synchronous throw inside
 * it (not just the one write that has actually been observed to throw; a future write or fault added to
 * that body is covered too) is swallowed — and then UNCONDITIONALLY awaits the merge-danger-window guard
 * before calling `exit`. Because the guard+exit sits outside the try, no failure inside `teardown()` can
 * ever prevent it from running, and because the throw never escapes this function, it can never reach the
 * process-level `uncaughtException` handler that would write a crash record for what is a clean stop.
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
