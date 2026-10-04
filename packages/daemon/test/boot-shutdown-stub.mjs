// Hermetic unit test for boot-shutdown-stub.ts's makeBootShutdownStub (card f1366911). NO daemon, NO
// network, pure factory against fakes — manager directive on this card: no test here boots a real
// daemon (a prior "throwaway daemon" recipe launched a real claude turn once, and left a stray daemon
// running for 3 days another time).
//
// Covers: the marker is written with the right kind/reason/signal classification; exit(0) is called;
// the stub NEVER throws even when every dependency (writeShutdownMarker/closeDb/log/exit) throws; and a
// second invocation (idempotency) doesn't repeat the marker write / DB close / log — only re-requests exit.
// Run: 1) build daemon, 2) node test/boot-shutdown-stub.mjs
import { makeBootShutdownStub, HANDLED_SIGNALS } from "../dist/boot-shutdown-stub.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("HANDLED_SIGNALS names exactly SIGINT/SIGTERM/SIGHUP",
  JSON.stringify([...HANDLED_SIGNALS].sort()) === JSON.stringify(["SIGHUP", "SIGINT", "SIGTERM"].sort()));

// ════════ (1) a signal reason classifies as "signal" and writes the marker + exits + logs ════════
{
  const calls = { marker: [], closeDb: 0, log: [], exit: [] };
  const stub = makeBootShutdownStub({
    writeShutdownMarker: (input) => calls.marker.push(input),
    closeDb: () => { calls.closeDb++; },
    exit: (code) => calls.exit.push(code),
    log: (msg) => calls.log.push(msg),
  });
  stub("SIGTERM");
  check("(1) writes exactly one marker", calls.marker.length === 1);
  check("(1) classifies a HANDLED_SIGNALS member as kind:signal", calls.marker[0]?.kind === "signal");
  check("(1) carries the raw reason through untouched", calls.marker[0]?.reason === "SIGTERM");
  check("(1) signal field is the signal name itself for a signal stop", calls.marker[0]?.signal === "SIGTERM");
  check("(1) best-effort closes the DB exactly once", calls.closeDb === 1);
  check("(1) logs once", calls.log.length === 1);
  check("(1) exits with code 0", calls.exit.length === 1 && calls.exit[0] === 0);
}

// ════════ (2) a non-signal reason (the HTTP hook) classifies as "intentional", signal:null ════════
{
  const calls = { marker: [] };
  const stub = makeBootShutdownStub({
    writeShutdownMarker: (input) => calls.marker.push(input),
    exit: () => {},
    log: () => {},
  });
  stub("POST /internal/shutdown");
  check("(2) classifies a non-signal reason as kind:intentional", calls.marker[0]?.kind === "intentional");
  check("(2) signal field is null for an intentional stop", calls.marker[0]?.signal === null);
  check("(2) closeDb is OPTIONAL — omitting it entirely never throws", true); // the stub() call above already proves this by not throwing
}

// ════════ (3) never throws, even when EVERY dependency throws ════════
{
  let threw = false;
  const stub = makeBootShutdownStub({
    writeShutdownMarker: () => { throw new Error("marker boom"); },
    closeDb: () => { throw new Error("db boom"); },
    exit: () => { throw new Error("exit boom"); },
    log: () => { throw new Error("log boom"); },
  });
  try {
    stub("SIGINT");
  } catch {
    threw = true;
  }
  check("(3) the stub never throws, even when every single dependency throws", threw === false);
}

// ════════ (4) idempotent on a second call — doesn't repeat marker/closeDb/log, only re-exits ════════
{
  const calls = { marker: 0, closeDb: 0, log: 0, exit: 0 };
  const stub = makeBootShutdownStub({
    writeShutdownMarker: () => { calls.marker++; },
    closeDb: () => { calls.closeDb++; },
    exit: () => { calls.exit++; },
    log: () => { calls.log++; },
  });
  stub("SIGINT");
  stub("SIGINT"); // a second signal arriving before `exit` has actually torn the process down
  check("(4) marker written exactly once across two calls", calls.marker === 1);
  check("(4) DB closed exactly once across two calls", calls.closeDb === 1);
  check("(4) logged exactly once across two calls", calls.log === 1);
  check("(4) exit requested on BOTH calls (never skip re-requesting the exit)", calls.exit === 2);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — makeBootShutdownStub classifies correctly, never throws even when every dependency does, and is idempotent across repeated invocations."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
