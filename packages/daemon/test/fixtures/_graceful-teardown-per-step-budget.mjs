// Card 347b3584 round 2 fixture: arms the REAL armHardShutdownWatchdog with a SHORT default hardExitMs,
// then proves the per-step override is genuinely per-step, not a one-shot replacement of the default:
//   (1) a step given an explicit LONG budget must survive well past the short default — nothing kills it
//       during a deliberate async delay longer than the default but shorter than its own override.
//   (2) a LATER step that does NOT override (falls back to the same short default) must still be bounded
//       by it — a genuine, synchronous, never-returning hang on this second step is force-killed within
//       roughly the short default, not the long one from step (1).
// Used by test/graceful-teardown-hard-exit-backstop.mjs. argv[2]=defaultHardExitMs (short),
// argv[3]=longBudgetMs, argv[4]=surviveBlockMs (defaultHardExitMs < surviveBlockMs < longBudgetMs).
//
// @decision 347b3584 — round 3: the short-budget step's hang makes this fixture's watchdog FIRE (by
// design) and write the real record file, which resolves from LOOM_HOME — call requireHermeticEnv()
// before arming, so a bare `node <this file>.mjs` run with no LOOM_HOME set refuses instead of writing
// into the real ~/.loom.
import { requireHermeticEnv } from "../_guard.mjs";
import { armHardShutdownWatchdog } from "../../dist/graceful-teardown.js";

requireHermeticEnv();

const defaultHardExitMs = Number(process.argv[2]);
const longBudgetMs = Number(process.argv[3]);
const surviveBlockMs = Number(process.argv[4]);

console.log(`[fixture] pid=${process.pid} defaultHardExitMs=${defaultHardExitMs} longBudgetMs=${longBudgetMs} surviveBlockMs=${surviveBlockMs}`);
const watchdog = armHardShutdownWatchdog({ hardExitMs: defaultHardExitMs, intendedExitCode: 0, label: "test-per-step-budget" });

watchdog.step("long-step", longBudgetMs);
await new Promise((resolve) => setTimeout(resolve, surviveBlockMs));
console.log("[fixture] long-step survived past the short default (per-step override worked) — now hanging on a short-budget step");

watchdog.step("short-step"); // no override — falls back to defaultHardExitMs
const sab = new SharedArrayBuffer(4);
Atomics.wait(new Int32Array(sab), 0, 0); // genuinely, synchronously hang forever
console.log("[fixture] UNREACHABLE — the watchdog failed to terminate this process on the short-budget step");
