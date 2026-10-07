// SHARED fake-pty test double for PtyHost's createPty() seam.
//
// Card ec7983c6: `class SeamHost extends PtyHost` used to be defined locally, byte-for-byte or near-
// byte-for-byte, in 115 separate test files. 97 of those local copies discarded the onExit callback
// (`onExit() { return { dispose() {} }; }`) and made kill() a no-op — so a "killed" fake pty could
// never flip alive→false, meaning PtyHost.stop() was structurally unable to neutralize that session's
// timers. 13 files had already independently re-derived the correct wiring below; this fixture makes
// that the ONE canonical shape instead of leaving the correct answer to be rediscovered per file.
//
// write()/resize() are deliberately inert no-ops: nothing written to this fake pty auto-completes a
// turn or auto-triggers an exit. A scenario that needs the pty to "exit" must call kill() itself (which
// invokes the tracked onExit callback, exactly once, synchronously) — real exit timing/async behavior
// (e.g. a REAL node-pty firing onExit on a later tick) is each test's own concern, not this fixture's.
//
// PtyHost itself is resolved via a POST-LOOM_HOME dynamic `await import("../dist/pty/host.js")` in every
// consuming test (env must be hermetic before dist/db.js's module-load-time reads run) — so this fixture
// is a FACTORY that takes the already-resolved PtyHost class, not a module that imports it itself.
//
// USAGE:
//   const { PtyHost } = await import("../dist/pty/host.js");
//   const { createSeamHost } = await import("./_seam-host-fixture.mjs");
//   const host = new (createSeamHost(PtyHost))(events);
//
// A test needing extra local state (capture arrays, distinct pids per spawn, overridden stop()/
// enqueueStdin()) extends the returned class and calls super.createPty(opts) to reuse this wiring:
//   class SeamHost extends createSeamHost(PtyHost) {
//     constructor(events) { super(events); this.capture = []; }
//     createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
//   }
export function createSeamHost(PtyHost) {
  return class SeamHost extends PtyHost {
    createPty(_opts) {
      let exitCb = null;
      return {
        pid: 4242,
        write() {},
        onData() { return { dispose() {} }; },
        onExit(cb) { exitCb = cb; return { dispose() {} }; },
        kill() { const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 }); },
        resize() {},
      };
    }
    // Card d634cd2e: this fixture's fake pty uses a fixed, fictional pid (4242) that can collide with a
    // REAL pid on the host (a Linux CI runner, in particular) — kill() above fires the real onExit
    // callback, which would otherwise run a real OS-wide process-tree enumeration + SIGKILL sweep against
    // whatever that pid actually is. No-op here instead of running the real reaper. See PtyHost's own
    // `reapExitedDescendants` doc comment for why this is the ONE place that overrides it.
    reapExitedDescendants(_rootPid, _sessionId) {}
    // Card 2897acc4: same reasoning as reapExitedDescendants above — `verifyRootDeadOrForceKill` (called
    // directly by stop()/escalateGracefulStop/stopCodex, not only via reapExitedDescendants) would
    // otherwise run a real OS-wide enumeration against this fixture's fictional pid too. Report a benign
    // "already confirmed dead" result so no caller (recycleWorker included) sees anything to escalate.
    async probeRootSurvival(_rootPid, _sessionId) {
      return { foundAlive: false, identityConfirmed: false, enumerationFailed: false };
    }
    killRoot(_pid) {}
    // Card 87691385 (CR f89d9552 round 3, MINOR 2) — the at-spawn root-creation-time capture seam runs a
    // REAL `powershell.exe` CIM query (measured 600-920ms) on win32 for EVERY spawn through this fixture,
    // same reasoning as reapExitedDescendants/probeRootSurvival above — never let a hermetic test pay for
    // (or race) the real OS query against this fixture's fictional pid. Measured impact (this card):
    // kickoff-readiness-fallback.mjs (13 real spawns through this fixture) 10.974s -> 6.170s with this stub.
    async captureRootCreationRow(_pid) { return null; }
    // Round 5 (item 1b) — `probeRootSurvival` above always reports "not alive", so `verifyRootDeadOrForceKill`
    // never reaches its own post-kill `sweepOrphanedDescendants` call from THIS fixture's defaults alone;
    // this override exists as belt-and-braces for a subclass that overrides probeRootSurvival/killRoot
    // per scenario (reaching dead:true) without ALSO overriding this seam — never the real OS-wide sweep.
    sweepOrphanedDescendants(_rootPid) {}
  };
}
