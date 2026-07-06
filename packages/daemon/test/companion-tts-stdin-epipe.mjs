import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — P0 daemon-crash fix (task f6fb84a3): a cold/failed synth whose python child exits
// BEFORE draining stdin fires an ASYNC 'error' (EPIPE) on child.stdin. With no listener on that stream,
// Node re-throws it as an uncaughtException, which crashlog.ts turns into process.exit(1) — killing the
// WHOLE daemon over one failed voice synth. Fully hermetic: a FAKE spawnImpl (test seam) stands in for
// node:child_process.spawn, so no real python/venv/network is ever touched.
//
// Proves:
//   1. an async 'error' emitted on the child's stdin (simulating the EPIPE) is SWALLOWED — it never
//      escapes as an uncaughtException on this process.
//   2. the synth call still degrades cleanly to `null` (ok:false) via the child's own 'exit' event —
//      the existing degrade-to-text path is unchanged.
// Run: 1) build (turbo builds shared first), 2) node test/companion-tts-stdin-epipe.mjs
import { EventEmitter } from "node:events";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { createKokoroSynthesizer, __setSpawnForTest, __setTtsPythonBinForTest } = await import("../dist/companion/tts.js");

function makeFakeChild() {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.write = () => true;
  stdin.end = () => {};
  child.stdin = stdin;
  child.kill = () => {};
  return child;
}

let crashed = false;
let crashErr = null;
const onUncaught = (err) => { crashed = true; crashErr = err; };
process.on("uncaughtException", onUncaught);

try {
  __setTtsPythonBinForTest("/fake/venv/python"); // pretend the venv is already warm
  let lastChild = null;
  __setSpawnForTest(() => { lastChild = makeFakeChild(); return lastChild; });

  const synth = createKokoroSynthesizer();
  const resultPromise = synth.synthesize({ text: "hello there", lang: null, voice: null });
  check("setup: the fake child was spawned synchronously", lastChild !== null);

  // Simulate the bug's real sequence: the child's stdin errors asynchronously (an EPIPE from a child
  // that closed its read end), then the child itself exits (non-zero — it never produced audio). Each
  // fires in its OWN setImmediate turn so a throw escaping the first (the unfixed behavior) can't stop
  // the second from running and settling the pending promise.
  setImmediate(() => {
    const epipe = new Error("write EPIPE");
    epipe.code = "EPIPE";
    lastChild.stdin.emit("error", epipe);
  });
  setImmediate(() => {
    lastChild.emit("exit", 1);
  });

  const result = await resultPromise;

  check("1: an async stdin 'error' (EPIPE) never escapes as an uncaughtException", crashed === false);
  check("2: the synth call still degrades to null (ok:false) via the child's exit event", result === null);

  if (crashed) console.error("  (uncaughtException was):", crashErr);
} catch (err) {
  console.error("UNCAUGHT IN TEST BODY:", err);
  failures++;
} finally {
  process.removeListener("uncaughtException", onUncaught);
  __setSpawnForTest();
  __setTtsPythonBinForTest(undefined);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
