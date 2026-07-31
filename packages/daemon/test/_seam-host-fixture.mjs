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
  };
}
