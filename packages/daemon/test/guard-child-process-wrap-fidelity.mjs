// Card 8c8ee0ee — test/_guard.mjs wraps node:child_process spawn/fork/exec/execFile (to populate the
// test-spawn registry pty/host.ts's real-reaper tripwire reads — see
// docs/decisions/8c8ee0ee-structural-reap-test-tripwire.md). That wrapper sits under EVERY test file in
// this suite, so a fidelity regression there is harness-wide, not local to this one card.
//
// THE HAZARD: `exec`/`execFile` carry `util.promisify.custom` (a Symbol-keyed own property) so
// `promisify(exec)` resolves `{stdout, stderr}` instead of Node's default single-value convention. A bare
// `cp.exec = function patched(...) {...}` reassignment drops every own property/symbol of the original,
// including that one — `promisify(cp.exec)` would then silently resolve the WRONG shape (string-indexed
// positional value, not `{stdout, stderr}`) for every caller in the suite, with no error anywhere to
// point at the cause. This file proves the fix (copying every own key, string and symbol, onto the
// wrapper) actually holds, for exactly the shapes that would otherwise silently drift: promisified
// exec/execFile, plain callback-style exec/execFile, spawn's `.pid`, and fork.
//
// RUN: node test/guard-child-process-wrap-fidelity.mjs (no build needed — exercises node:child_process
// directly, not dist/pty/host.js)
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { spawn, fork, exec, execFile } from "node:child_process";
import { spawn as spawnPty } from "node-pty";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// =======================================================================================================
// (A) promisify(exec) / promisify(execFile) still resolve {stdout, stderr} — the exact shape
// util.promisify.custom encodes, and the exact shape a bare reassignment would silently drop.
// =======================================================================================================
{
  const execP = promisify(exec);
  const result = await execP(`"${process.execPath}" -e "process.stdout.write('guard-fidelity-exec-out'); process.stderr.write('guard-fidelity-exec-err')"`);
  check("(A) promisify(exec) resolves an OBJECT (not a bare string — proves util.promisify.custom survived the wrap)",
    result !== null && typeof result === "object");
  check("(A) promisify(exec) resolves {stdout} with the real stdout content", result.stdout === "guard-fidelity-exec-out");
  check("(A) promisify(exec) resolves {stderr} with the real stderr content (the field a bare-reassignment drop silently loses)",
    result.stderr === "guard-fidelity-exec-err");
}
{
  const execFileP = promisify(execFile);
  const result = await execFileP(process.execPath, ["-e", "process.stdout.write('guard-fidelity-execfile-out'); process.stderr.write('guard-fidelity-execfile-err')"]);
  check("(A) promisify(execFile) resolves an OBJECT (not a bare string)", result !== null && typeof result === "object");
  check("(A) promisify(execFile) resolves {stdout} with the real stdout content", result.stdout === "guard-fidelity-execfile-out");
  check("(A) promisify(execFile) resolves {stderr} with the real stderr content", result.stderr === "guard-fidelity-execfile-err");
}

// =======================================================================================================
// (B) the plain CALLBACK forms of exec/execFile are unchanged — argument order/count/types exactly as
// node:child_process's own documented (error, stdout, stderr) signature, never altered by the wrap.
// =======================================================================================================
await new Promise((resolve) => {
  exec(`"${process.execPath}" -e "process.stdout.write('cb-exec-out')"`, (err, stdout, stderr) => {
    check("(B) exec's callback form: no error", err === null);
    check("(B) exec's callback form: stdout is the real content, as a string", stdout === "cb-exec-out");
    check("(B) exec's callback form: stderr is a string (empty here)", stderr === "");
    resolve();
  });
});
await new Promise((resolve) => {
  execFile(process.execPath, ["-e", "process.stdout.write('cb-execfile-out')"], (err, stdout, stderr) => {
    check("(B) execFile's callback form: no error", err === null);
    check("(B) execFile's callback form: stdout is the real content, as a string", stdout === "cb-execfile-out");
    check("(B) execFile's callback form: stderr is a string (empty here)", stderr === "");
    resolve();
  });
});

// =======================================================================================================
// (C) spawn(...).pid is a real, live pid — the registry's own bookkeeping didn't corrupt the return value.
// =======================================================================================================
{
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { stdio: "ignore" });
  check("(C) spawn(...) returns a ChildProcess with a real numeric pid", typeof child.pid === "number" && child.pid > 0);
  try { process.kill(child.pid, 0); check("(C) that pid is genuinely alive right after spawn", true); }
  catch { check("(C) that pid is genuinely alive right after spawn", false); }
  // Card dbbb52db item 4: the wrap's WHOLE PURPOSE (pty/host.ts's real-reaper tripwire registry) is a
  // side effect the checks above never assert at all — they'd stay green even with the registry
  // bookkeeping entirely removed. Assert it directly.
  check("(C) spawn(...)'s pid was recorded into the test-spawn registry (the wrap's actual purpose)",
    globalThis.__LOOM_TEST_SPAWNED_PIDS__?.has(child.pid) === true);
  child.kill();
}

// =======================================================================================================
// (D) fork(...) is unchanged — returns a real ChildProcess with IPC, same as an unwrapped fork would.
// =======================================================================================================
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-guard-fidelity-fork-"));
  const forkTarget = path.join(tmpHome, "fork-target.mjs");
  fs.writeFileSync(forkTarget, "process.send?.('ready'); setTimeout(() => {}, 2000);\n");
  try {
    const child = fork(forkTarget, [], { stdio: "ignore" });
    check("(D) fork(...) returns a ChildProcess with a real numeric pid", typeof child.pid === "number" && child.pid > 0);
    const gotReady = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000);
      child.once("message", (msg) => { clearTimeout(timer); resolve(msg === "ready"); });
    });
    check("(D) the forked child's own IPC message was received (fork's channel is genuinely intact)", gotReady === true);
    // Card dbbb52db item 4: same gap as (C) above — assert the registry side effect directly.
    check("(D) fork(...)'s pid was recorded into the test-spawn registry (the wrap's actual purpose)",
      globalThis.__LOOM_TEST_SPAWNED_PIDS__?.has(child.pid) === true);
    child.kill();
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// =======================================================================================================
// (E) card dbbb52db item 4: node-pty's OWN spawn export is ALSO wrapped (card 8c8ee0ee's CR-found
// real-spawn fix — node-pty is a completely separate native module, never going through
// node:child_process) — this file only ever exercised the node:child_process wrap before this item;
// nothing here would have caught a regression that silently dropped the node-pty wrap.
// =======================================================================================================
{
  const child = spawnPty(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {});
  check("(E) node-pty's spawn(...) returns a real numeric pid", typeof child.pid === "number" && child.pid > 0);
  check("(E) node-pty spawn(...)'s pid was recorded into the test-spawn registry",
    globalThis.__LOOM_TEST_SPAWNED_PIDS__?.has(child.pid) === true);
  child.kill();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — _guard.mjs's child_process wrap preserves promisify.custom (and every other own property/symbol), the plain callback forms, and spawn/fork's own return shape, exactly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
