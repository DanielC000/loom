import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// Card 4e026f35: `bin/lib/start-guard.mjs` replaces the never-shipped file-based `start-lock.mjs` (decision
// 03cc6cae — four Code Review rounds each reproduced a double start against the previous round's own
// reclaim fix) with an OS-released primitive that has NO reclaim/staleness logic at all. This test proves
// the mutual-exclusion property with REAL OS-level concurrency (never mocked — memory
// real-spawn-smoke-for-subprocess-features): separate child processes race a real `acquireStartGuard` call
// against the SAME (loomHome, port) pair.
//
// NEGATIVE CONTROL (discriminating-fixture proof, not a vacuous one): every mutual-exclusion scenario also
// runs against fixtures/start-guard-noop.mjs — a deliberately broken stand-in that always reports
// `acquired:true` (i.e. "the guard removed entirely", per the DoD's own wording) — and asserts the
// OPPOSITE outcome there (no exclusion at all). Both the real-module assertion and its noop counterpart
// feed the SAME pass/fail tally below, so a real regression and a miscalibrated control both show up as a
// genuine FAIL — there is no separate, hidden "expected to fail" bucket.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_MODULE = path.join(__dirname, "..", "..", "..", "bin", "lib", "start-guard.mjs"); // packages/daemon/test → repo root
const NOOP_MODULE = path.join(__dirname, "fixtures", "start-guard-noop.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A worker that imports a given copy of acquireStartGuard, calls it ONCE against (loomHome, port), prints
// its own pid + the result as JSON, and — if it acquired — holds for holdMs before releasing and exiting.
// `patchClock` ("1"/"0", argv[5]) monkey-patches Date.now to a far-future value BEFORE calling
// acquireStartGuard, to prove the result is unaffected by the wall clock (round-4's exact defeat mode —
// see decision 03cc6cae — does not apply here because nothing in this module ever reads the clock).
function workerScriptFor(modulePath) {
  const moduleUrl = pathToFileURL(modulePath).href;
  return `
if (process.argv[5] === "1") { const real = Date.now; Date.now = () => real() + 365 * 24 * 60 * 60 * 1000; }
const { acquireStartGuard } = await import(${JSON.stringify(moduleUrl)});
const loomHome = process.argv[2];
const port = Number(process.argv[3]);
const holdMs = Number(process.argv[4] || "0");
const result = await acquireStartGuard({ loomHome, port });
process.stdout.write(JSON.stringify({ pid: process.pid, acquired: result.acquired, code: result.code ?? null }));
if (result.acquired && holdMs > 0) {
  await new Promise((r) => setTimeout(r, holdMs));
  result.release();
}
`;
}

// A worker that acquires and holds FOREVER (until killed) — used where the test itself controls the
// holder's lifetime via process.kill rather than a timed hold.
function holderForeverScriptFor(modulePath) {
  const moduleUrl = pathToFileURL(modulePath).href;
  return `
const { acquireStartGuard } = await import(${JSON.stringify(moduleUrl)});
const loomHome = process.argv[2];
const port = Number(process.argv[3]);
const result = await acquireStartGuard({ loomHome, port });
process.stdout.write(JSON.stringify({ pid: process.pid, acquired: result.acquired }));
await new Promise(() => {}); // never releases, never exits on its own — the parent SIGKILLs it
`;
}

// Resolves as soon as the worker's single JSON line is readable on stdout. Does NOT wait for exit (a
// holder deliberately keeps running — see the script generators' own comments). Caller owns killing the
// child afterward via killAndWait.
function runWorker(scriptSource, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write(scriptSource);
    child.stdin.end();
    let stdout = "", stderr = "";
    const onData = (c) => {
      stdout += c;
      try {
        const result = JSON.parse(stdout);
        child.stdout.off("data", onData);
        resolve({ child, result });
      } catch { /* not a complete JSON line yet */ }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("exit", (code) => { if (!stdout.trim()) reject(new Error(`worker exited ${code} with no output: ${stderr}`)); });
  });
}

function killAndWait(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("exit", resolve);
    try { process.kill(child.pid, "SIGKILL"); } catch { resolve(); }
  });
}

// ---- Scenario A: N-trial race ⇒ the real module lets exactly one acquire; the noop lets ALL through --
// Racers hold FOREVER (killed only by the test, never self-releasing) and cleanup tolerates a rejected
// racer without leaking the others — see the decision record's "timing + cleanup choices" section.
// @decision 4e026f35
async function scenarioA(modulePath, label, expectExclusion) {
  const script = holderForeverScriptFor(modulePath);
  const TRIALS = 5;
  const RACERS = 4;
  for (let trial = 1; trial <= TRIALS; trial++) {
    const home = mkdtempManaged(`start-guard-race-A-${trial}-`);
    const port = await reserveHermeticPort();
    const settled = await Promise.allSettled(
      Array.from({ length: RACERS }, () => runWorker(script, [home, String(port)])),
    );
    try {
      const rejected = settled.filter((s) => s.status === "rejected");
      const fulfilled = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
      const acquiredCount = fulfilled.filter((r) => r.result.acquired).length;
      const expected = expectExclusion ? 1 : RACERS;
      check(
        `[A:${label} trial ${trial}] ${expectExclusion ? "exactly one" : "all"} of ${RACERS} racers acquired (got ${acquiredCount}, expected ${expected}, ${rejected.length} racer(s) failed to start)`,
        rejected.length === 0 && acquiredCount === expected,
      );
    } finally {
      const fulfilled = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
      await Promise.all(fulfilled.map((r) => killAndWait(r.child)));
    }
  }
}

// ---- Scenario B: an idle holder ⇒ real module still refuses; noop still lets the second through -------
// A few seconds idle, not the 11s this once used — see the decision record's "timing + cleanup choices"
// section for why a longer pause proves nothing more here.
// @decision 4e026f35
async function scenarioB(modulePath, label, expectExclusion) {
  const home = mkdtempManaged(`start-guard-race-B-${label}-`);
  const port = await reserveHermeticPort();
  const holder = await runWorker(holderForeverScriptFor(modulePath), [home, String(port)]);
  check(`[B:${label}] holder itself acquired`, holder.result.acquired === true);

  // TIMING-GUARD-SAFE: fully-awaited-completion — this 3s idle delay is NOT what proves the check below;
  // the check reads `second.result.acquired`, the FULLY-AWAITED return value of the very next line's
  // `runWorker()` call, which itself fully awaits the racer process's own `await acquireStartGuard(...)` —
  // a real OS `.listen()` attempt that has unambiguously SETTLED (EADDRINUSE or success) by the time its
  // JSON result is parsed. There is no still-pending state the delay could be mistaken for "hasn't
  // happened yet": the async operation under test is complete, not in flight, at the moment of the check.
  await new Promise((r) => setTimeout(r, 3_000));
  const second = await runWorker(workerScriptFor(modulePath), [home, String(port), "0", "0"]);
  check(`[B:${label}] a second attempt after a few seconds idle ${expectExclusion ? "is refused" : "still acquires (no exclusion)"}`, second.result.acquired === !expectExclusion);

  await killAndWait(holder.child);
}

// ---- Scenario C: Date.now stepped forward in the racing process ⇒ no effect on the real module's verdict
async function scenarioC(modulePath, label, expectExclusion) {
  const home = mkdtempManaged(`start-guard-race-C-${label}-`);
  const port = await reserveHermeticPort();
  const holder = await runWorker(holderForeverScriptFor(modulePath), [home, String(port)]);
  check(`[C:${label}] holder itself acquired`, holder.result.acquired === true);

  // The racing SECOND process steps its own clock a full year forward BEFORE calling acquireStartGuard —
  // if this module judged staleness by wall-clock age (what defeated round 4's reclaim mutex), a
  // sufficiently large forward step could make a live holder look "stale". It must not: nothing here
  // reads the clock at all.
  const stepped = await runWorker(workerScriptFor(modulePath), [home, String(port), "0", "1"]);
  check(`[C:${label}] a clock-stepped second attempt ${expectExclusion ? "is still refused (no effect)" : "still acquires (no exclusion)"}`, stepped.result.acquired === !expectExclusion);

  await killAndWait(holder.child);
}

// ---- Scenario D: holder SIGKILLed ⇒ real module re-acquires immediately, no sleep needed -------------
async function scenarioD(modulePath, label, expectExclusion) {
  const home = mkdtempManaged(`start-guard-race-D-${label}-`);
  const port = await reserveHermeticPort();
  const holder = await runWorker(holderForeverScriptFor(modulePath), [home, String(port)]);
  check(`[D:${label}] holder itself acquired`, holder.result.acquired === true);

  const whileAlive = await runWorker(workerScriptFor(modulePath), [home, String(port), "0", "0"]);
  check(`[D:${label}] a second attempt while the holder is alive ${expectExclusion ? "is refused" : "still acquires (no exclusion)"}`, whileAlive.result.acquired === !expectExclusion);

  await killAndWait(holder.child); // real SIGKILL, not a graceful close — see bin/lib/start-guard.mjs header

  // Immediately (no sleep) — the OS-released primitive needs no time to clear; a sleep here would hide a
  // regression into a reclaim-with-staleness shape, which WOULD need a wait before this could pass.
  const afterKill = await runWorker(workerScriptFor(modulePath), [home, String(port), "0", "0"]);
  check(`[D:${label}] immediately after SIGKILL, a fresh attempt acquires with no wait`, afterKill.result.acquired === true);
  await killAndWait(afterKill.child);
}

// ---- Scenario E: a different LOOM_HOME or port ⇒ independent (real module only — nothing to control) -
async function scenarioE() {
  const script = holderForeverScriptFor(REAL_MODULE);
  const homeA = mkdtempManaged("start-guard-race-E-a-");
  const homeB = mkdtempManaged("start-guard-race-E-b-");
  const portA = await reserveHermeticPort();
  const portB = await reserveHermeticPort();

  const [holderA, holderB] = await Promise.all([
    runWorker(script, [homeA, String(portA)]),
    runWorker(script, [homeB, String(portA)]), // same port, different home
  ]);
  check("[E] different LOOM_HOME, same port: both acquired independently", holderA.result.acquired === true && holderB.result.acquired === true);
  await Promise.all([killAndWait(holderA.child), killAndWait(holderB.child)]);

  const [holderC, holderD] = await Promise.all([
    runWorker(script, [homeA, String(portA)]),
    runWorker(script, [homeA, String(portB)]), // same home, different port
  ]);
  check("[E] same LOOM_HOME, different port: both acquired independently", holderC.result.acquired === true && holderD.result.acquired === true);
  await Promise.all([killAndWait(holderC.child), killAndWait(holderD.child)]);
}

// ---- Scenario F: darwin (and "other") platforms are a DELIBERATE no-op, unconditionally -------------
// Not a mutual-exclusion proof (there is none to prove on this branch by design — decision 03cc6cae's "Do
// not" rejects ever adding one) — confirms the no-op fires even under direct same-process contention,
// i.e. it never accidentally falls through to the win32/linux dispatch on this platform.
async function scenarioF() {
  const moduleUrl = pathToFileURL(REAL_MODULE).href;
  const script = `
Object.defineProperty(process, "platform", { value: "darwin" });
const { acquireStartGuard } = await import(${JSON.stringify(moduleUrl)});
const loomHome = process.argv[2];
const port = Number(process.argv[3]);
const a = await acquireStartGuard({ loomHome, port });
const b = await acquireStartGuard({ loomHome, port }); // same process, same target, no release in between
process.stdout.write(JSON.stringify({ a: a.acquired, b: b.acquired }));
`;
  const home = mkdtempManaged("start-guard-race-F-");
  const port = await reserveHermeticPort();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", home, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write(script);
    child.stdin.end();
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("exit", () => { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`bad output: ${stdout} / ${stderr}`)); } });
  });
  check("[F] darwin: first call acquires (no-op, always true)", result.a === true);
  check("[F] darwin: second call on the SAME target, same process, also acquires (unconditional no-op, never contends with itself)", result.b === true);
}

await scenarioA(REAL_MODULE, "real-module", true);
await scenarioA(NOOP_MODULE, "noop-control", false);
await scenarioB(REAL_MODULE, "real-module", true);
await scenarioB(NOOP_MODULE, "noop-control", false);
await scenarioC(REAL_MODULE, "real-module", true);
await scenarioC(NOOP_MODULE, "noop-control", false);
await scenarioD(REAL_MODULE, "real-module", true);
await scenarioD(NOOP_MODULE, "noop-control", false);
await scenarioE();
await scenarioF();

console.log(failures === 0
  ? "\n✅ ALL PASS — the real module (bin/lib/start-guard.mjs) enforces mutual exclusion across a 4-racer trial (each holding until killed, never a timed self-release), an idle holder, a clock-stepped racer, and an immediate re-acquire after SIGKILL; independence across (LOOM_HOME, port) pairs holds; the darwin no-op fires unconditionally. The noop-control counterpart of every exclusion scenario confirmed the OPPOSITE outcome, proving these assertions are discriminating, not vacuous."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
