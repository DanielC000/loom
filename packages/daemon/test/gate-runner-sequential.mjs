// Gate-runner sequential-process test (card fb8df559, Auditor finding b9515beb). HERMETIC: NO real
// spawn, NO daemon — drives orchestration/gate-runner.js directly with a FAKE step runner, so it proves
// a `&&`-chained gateCommand runs as SEPARATE sequential processes (memory frees between steps) while
// keeping the OLD single-`spawnSync` short-circuit semantics: the first non-zero step stops the run.
// runGateSequential is ASYNC (real `spawn`, never `spawnSync` — a blocking spawnSync would freeze the
// WHOLE daemon event loop for the step's duration, silently defeating Part 1's client-timeout-resilience
// fix; see the LOAD-BEARING note on runGateStep in gate-runner.ts) — the fake runners below stay plain
// synchronous functions; `await`ing a non-Promise value is a no-op pass-through, so they exercise the
// same short-circuit/ordering logic without needing to spawn anything real.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-runner-sequential.mjs
import { splitGateSteps, runGateSequential } from "../dist/orchestration/gate-runner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- splitGateSteps: pure top-level `&&` splitting ---
check("(split) three-step gate splits into three ordered steps",
  JSON.stringify(splitGateSteps("pnpm lint && pnpm test && pnpm build")) === JSON.stringify(["pnpm lint", "pnpm test", "pnpm build"]));
check("(split) a gate with no `&&` is a single-element array (no special-casing needed)",
  JSON.stringify(splitGateSteps("pnpm build")) === JSON.stringify(["pnpm build"]));
check("(split) a `&&` INSIDE quotes is not a split point",
  JSON.stringify(splitGateSteps('node -e "1 && 2" && node -e "3"')) === JSON.stringify(['node -e "1 && 2"', 'node -e "3"']));
check("(split) stray whitespace around `&&` is trimmed off each step",
  JSON.stringify(splitGateSteps("  a   &&   b  ")) === JSON.stringify(["a", "b"]));

// --- runGateSequential: each step is its OWN call to the injected runner (a real runner = a real
// separate child process — this proves the call boundary, i.e. no single shared `&&` spawn) ---
const calls = [];
const okRunner = (command, cwd, timeoutMs) => { calls.push({ command, cwd, timeoutMs }); return { status: 0 }; };
const green = await runGateSequential("pnpm lint && pnpm test && pnpm build", "/work/tree", 5000, okRunner);
check("(order) a green 3-step gate runs all three steps, each as its OWN runner call",
  calls.length === 3 && calls.every((c) => c.cwd === "/work/tree" && c.timeoutMs === 5000));
check("(order) steps run in the ORIGINAL `&&` order",
  JSON.stringify(calls.map((c) => c.command)) === JSON.stringify(["pnpm lint", "pnpm test", "pnpm build"]));
check("(order) a green run reports passed:true", green.passed === true);

// --- fail-closed short-circuit: a middle-step non-zero exit stops the run BEFORE the next step ---
const calls2 = [];
const middleFails = (command) => { calls2.push(command); return { status: command === "pnpm test" ? 1 : 0 }; };
const red = await runGateSequential("pnpm lint && pnpm test && pnpm build", "/work/tree", 5000, middleFails);
check("(short-circuit) a failing middle step stops the run — the trailing step NEVER runs",
  JSON.stringify(calls2) === JSON.stringify(["pnpm lint", "pnpm test"]));
check("(short-circuit) fails closed: passed:false, and names the failed step",
  red.passed === false && red.failedStep === "pnpm test");

// --- a spawn error (not just a non-zero exit) also fails closed, same as the old single-spawnSync path ---
const spawnErrorRunner = (command) => command === "pnpm lint" ? { status: 0 } : { status: null, error: new Error("ENOENT") };
const errRed = await runGateSequential("pnpm lint && pnpm test", "/work/tree", 5000, spawnErrorRunner);
check("(spawn error) a runner-reported spawn error fails the gate closed",
  errRed.passed === false && errRed.failedStep === "pnpm test");

console.log(failures === 0
  ? "\n✅ ALL PASS — a `&&`-chained gate runs as separate sequential processes (memory frees between steps) and still fails closed on the first non-zero/errored step."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
