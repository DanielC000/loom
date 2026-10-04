import type { ShutdownMarkerInput } from "./shutdown-marker.js";

/**
 * SIGINT/SIGTERM plus SIGHUP — Node also emits SIGHUP for the Windows console-close case (closing the
 * terminal window) as well as the POSIX hangup case. Hoisted to module scope (card f1366911) so it can
 * be read both by the signal-registration loop — now installed in index.ts BEFORE the full
 * post-boot graceful-teardown function exists — and by that full function once it does; both classify
 * off this ONE list, same as before this card.
 */
export const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Dependencies {@link makeBootShutdownStub} needs, injected so the stub is unit-testable with fakes
 * (card f1366911 — no test here boots a real daemon; see that card's decision record for why).
 */
export interface BootShutdownStubDeps {
  writeShutdownMarker: (input: ShutdownMarkerInput) => void;
  /** Best-effort DB close, for when a DB connection already exists at the time of the stop. Omit (or
   *  have it resolve to undefined) before `new Db()` has run — the stub tolerates either. */
  closeDb?: () => void;
  exit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * @decision f1366911 — never reference any other boot-constructed subsystem handle from this stub, and
 * never widen what it does beyond marker-write + DB-close + log + exit: those handles may not exist yet
 * this early in boot, and the full teardown (not this stub) owns tearing them down.
 */
export function makeBootShutdownStub(deps: BootShutdownStubDeps): (reason: string) => void {
  let fired = false;
  return (reason: string) => {
    if (fired) {
      // A second signal/stop arriving before `exit` has actually torn the process down — don't repeat
      // the marker write / DB close / log, just re-request the exit.
      try { deps.exit(0); } catch { /* never throw on the exit path */ }
      return;
    }
    fired = true;
    const isSignal = (HANDLED_SIGNALS as readonly string[]).includes(reason);
    try {
      deps.writeShutdownMarker({ kind: isSignal ? "signal" : "intentional", reason, signal: isSignal ? reason : null });
    } catch { /* the marker write must never block the exit */ }
    try {
      deps.closeDb?.();
    } catch { /* a DB close failure must never block the exit */ }
    try {
      deps.log(`[shutdown] stop during boot (${reason})`);
    } catch { /* a logging failure must never block the exit */ }
    try {
      deps.exit(0);
    } catch { /* never throw on the exit path */ }
  };
}
