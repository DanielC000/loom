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
import { performance } from "node:perf_hooks";
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

// --- allowExtend (card 24642c3d) is forwarded to EVERY step's own runStep call, trailing after
// envOverride, so a caller can disable the one-time auto-extend for a whole gate run (e.g. the merge
// gate's own retry-after-timeout call) without touching any other argument ---
const extendCalls = [];
const extendRecordingRunner = (command, cwd, timeoutMs, envOverride, allowExtend) => {
  extendCalls.push({ command, allowExtend });
  return { status: 0 };
};
await runGateSequential("pnpm lint && pnpm test", "/work/tree", 5000, extendRecordingRunner, undefined, false);
check("(allowExtend) explicit false is forwarded to every step", extendCalls.every((c) => c.allowExtend === false));
extendCalls.length = 0;
await runGateSequential("pnpm lint && pnpm test", "/work/tree", 5000, extendRecordingRunner);
check("(allowExtend) omitted defaults to undefined (runStep's own default of true then applies)", extendCalls.every((c) => c.allowExtend === undefined));

// --- per-step durations (card a2873f7e): `steps: [{step, durationMs, status}, ...]` for EVERY step that
// actually spawned, derived from decidedAt — computed for the internal auto-extend decision and, before
// this card, thrown away before any caller saw it. Same shape on the green path and the rejected path
// (the comparison that diagnoses a flake is ACROSS outcomes), and a step whose runner never sets
// decidedAt reports durationMs:null, never a fabricated 0. ---
check("(durations) a green 3-step gate (okRunner never sets decidedAt) reports one entry per step, honest null durations",
  green.steps.length === 3 &&
  JSON.stringify(green.steps.map((s) => s.step)) === JSON.stringify(["pnpm lint", "pnpm test", "pnpm build"]) &&
  green.steps.every((s) => s.durationMs === null && s.status === 0));

const timedRunner = (command) => ({ status: command === "pnpm test" ? 1 : 0, decidedAt: performance.now() });
const greenTimed = await runGateSequential("pnpm lint && pnpm build", "/work/tree", 5000, (command) => ({ status: 0, decidedAt: performance.now() }));
check("(durations) a runner that DOES set decidedAt reports a real numeric durationMs (never negative)",
  greenTimed.steps.length === 2 && greenTimed.steps.every((s) => typeof s.durationMs === "number" && s.durationMs >= 0));

const redTimed = await runGateSequential("pnpm lint && pnpm test && pnpm build", "/work/tree", 5000, timedRunner);
check("(durations) green and rejected report the SAME per-step shape — {step,durationMs,status} on both, not two different shapes",
  redTimed.passed === false &&
  redTimed.steps.length === 2 && // the third step never spawned — short-circuited before it
  redTimed.steps.every((s) => Object.keys(s).sort().join(",") === "durationMs,status,step") &&
  greenTimed.steps.every((s) => Object.keys(s).sort().join(",") === "durationMs,status,step") &&
  redTimed.steps[0].status === 0 && redTimed.steps[1].status === 1);

const singleGreen = await runGateSequential("pnpm build", "/work/tree", 5000, okRunner);
check("(durations) a single-step (no `&&`) gate behaves identically — one entry, same shape",
  singleGreen.steps.length === 1 &&
  singleGreen.steps[0].step === "pnpm build" && singleGreen.steps[0].status === 0 && singleGreen.steps[0].durationMs === null);

// --- card 4c5bf820: the GREEN return now also carries `outputTail` (the LAST step's own bounded tail) —
// before this card, `runGateSequential`'s success return (`{passed:true, steps}`) discarded outputTail
// entirely, even though every step's own GateStepResult always computes one; a passing gate had nothing
// retained afterward. Same field, populated by the SAME mechanism a rejection already uses. ---
const tailRunner = (command) => ({ status: 0, outputTail: `stdout from ${command}` });
const greenWithTail = await runGateSequential("pnpm lint && pnpm test", "/work/tree", 5000, tailRunner);
check("(RED-first control) a runner that never sets outputTail leaves the green result's outputTail undefined — proves this isn't fabricated by runGateSequential itself",
  green.outputTail === undefined);
check("(outputTail, green — THE FIX) a passing gate's result carries the LAST step's own outputTail, not nothing",
  greenWithTail.passed === true && greenWithTail.outputTail === "stdout from pnpm test");
const redWithTail = await runGateSequential("pnpm lint && pnpm test", "/work/tree", 5000, (command) => ({ status: command === "pnpm test" ? 1 : 0, outputTail: `stdout from ${command}` }));
check("(outputTail, parity) a failing gate's result ALSO carries the failed step's outputTail — green and red are symmetric now, not just red",
  redWithTail.passed === false && redWithTail.outputTail === "stdout from pnpm test");

console.log(failures === 0
  ? "\n✅ ALL PASS — a `&&`-chained gate runs as separate sequential processes (memory frees between steps) and still fails closed on the first non-zero/errored step."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
