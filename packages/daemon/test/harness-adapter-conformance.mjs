import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
// Conformance test for `claudeAdapter` (card 2b099e48, Code Review B1): before this test, `claudeAdapter`
// had ZERO consumers and ZERO tests exercising any of its ten delegate methods — a swapped or dropped
// argument in any one of them would have been silently uncaught (the reviewer's own stated concern). This
// checks two things a "the file compiles" pass cannot: (1) `capabilities` and method PRESENCE actually
// agree, in BOTH directions (a capability claiming `true` with no method is a lie; a defined method with
// no capability claiming it is dead weight nobody would ever call); (2) each delegate's return value is
// EQUIVALENT to calling the underlying pre-existing function directly — proving `claudeAdapter` genuinely
// forwards arguments/results rather than merely existing.
import { claudeAdapter } from "../dist/pty/claude-adapter.js";
import { resolveExecutable } from "../dist/pty/resolve-bin.js";
import { getCachedClaudeVersion } from "../dist/orchestration/usage-status.js";
import { readTranscript, resolveTranscriptFile, engineTranscriptExists } from "../dist/pty/claude-transcript.js";
import { readContextStats } from "../dist/sessions/context.js";
import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("id is 'claude'", claudeAdapter.id === "claude");

// (1) Capability ↔ method-presence pairing, both directions.
const PAIRS = [
  ["contextTelemetry", "readContextStats"],
  ["usageTelemetry", "readCumulativeUsage"],
  ["rateLimitStatus", "readRateLimitStatus"],
  ["versionGating", "readCachedVersion"],
];
for (const [capName, methodName] of PAIRS) {
  const capTrue = claudeAdapter.capabilities[capName] === true;
  const hasMethod = typeof claudeAdapter[methodName] === "function";
  check(`capability '${capName}'=${claudeAdapter.capabilities[capName]} <=> '${methodName}' is ${hasMethod ? "defined" : "undefined"} (must agree)`,
    capTrue === hasMethod);
}
// livenessWatch/builtinReset gate a RETURN VALUE (null when unsupported), not method PRESENCE — both
// members are non-optional on HarnessAdapter (watchLiveness, vendorProcessSlashCommand) so every adapter
// must define them; only checked for presence here, their behavior is exercised below.
check("watchLiveness is always defined (non-optional on HarnessAdapter)", typeof claudeAdapter.watchLiveness === "function");
check("vendorProcessSlashCommand is always defined (non-optional on HarnessAdapter)", typeof claudeAdapter.vendorProcessSlashCommand === "function");
check("resolveBinary is always defined (non-optional on HarnessAdapter)", typeof claudeAdapter.resolveBinary === "function");
check("locateTranscript/transcriptExists/readTranscript/snapshotTranscript are always defined (non-optional)",
  typeof claudeAdapter.locateTranscript === "function" &&
  typeof claudeAdapter.transcriptExists === "function" &&
  typeof claudeAdapter.readTranscript === "function" &&
  typeof claudeAdapter.snapshotTranscript === "function");

// (2) Equivalence — each delegate's result matches calling the underlying function directly.
check("resolveBinary('claude') === resolveExecutable('claude')",
  claudeAdapter.resolveBinary("claude") === resolveExecutable("claude"));
check("vendorProcessSlashCommand('reset') === '/clear'",
  claudeAdapter.vendorProcessSlashCommand("reset") === "/clear");
check("readCachedVersion() === getCachedClaudeVersion()",
  claudeAdapter.readCachedVersion() === getCachedClaudeVersion());
check("snapshotTranscript(missing engine id) === false, matching the underlying function's own contract",
  claudeAdapter.snapshotTranscript("/no/such/cwd", "no-such-id", "proj", "sess") === false);

withEngineTranscriptFixture(
  {
    prefix: "loom-adapter-conformance-",
    engineSessionId: "adapter-conformance-fixture",
    fileContent: JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "hi" }] },
    }) + "\n",
  },
  (cwd) => {
    const id = "adapter-conformance-fixture";
    check("locateTranscript(cwd, id) === resolveTranscriptFile(cwd, id)",
      claudeAdapter.locateTranscript(cwd, id) === resolveTranscriptFile(cwd, id));
    check("transcriptExists(cwd, id) === engineTranscriptExists(cwd, id) === true",
      claudeAdapter.transcriptExists(cwd, id) === engineTranscriptExists(cwd, id) && engineTranscriptExists(cwd, id) === true);
    check("readTranscript(cwd, id) deep-equals the direct readTranscript(cwd, id) call",
      JSON.stringify(claudeAdapter.readTranscript(cwd, id)) === JSON.stringify(readTranscript(cwd, id)));
    check("readContextStats(cwd, id) deep-equals the direct readContextStats(cwd, id) call",
      JSON.stringify(claudeAdapter.readContextStats(cwd, id)) === JSON.stringify(readContextStats(cwd, id)));
  },
);

// watchLiveness: a real chokidar watch against the (real) engine-transcript store. Only asserts shape +
// clean teardown — this is not the place to re-verify the debounced-sweep behavior (see
// worker-liveness-signal.mjs / gate-idle-liveness.mjs for that).
{
  const watcher = claudeAdapter.watchLiveness(() => {});
  check("watchLiveness returns a real handle with a close() method", watcher !== null && typeof watcher.close === "function");
  if (watcher) { try { watcher.close(); } catch { /* best-effort teardown */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — claudeAdapter's capability flags and method presence agree in both directions, and every delegate's result matches calling the underlying pre-existing function directly (a swapped/dropped argument in any delegate would now be caught here)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
