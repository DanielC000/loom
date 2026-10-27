import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 293beb47 — regression proof for git/bounded.ts's own decision anchor for this card (full
// mechanism/record there, never restated here). Mocks ONLY node:child_process's `spawn` — never real fd
// exhaustion, never the live daemon. Runs as its own isolated process (one `node <file>` per test file
// in this harness), so mutating the global `child_process.spawn` here never leaks into another test.
//
// Round 2 (Code Review NOT-SHIP on commit 949fdb0e): (B)/(C) below now drive a REAL `cp.ChildProcess()`
// whose `_handle.spawn` is overridden to return the real `UV_EMFILE`/`UV_ENFILE` binding, so Node's own
// unmodified internal `onexit`/`onErrorNT` code actually runs — a hand-rolled EventEmitter fake (round
// 1's defect) never exercises that real path and is blind to a real defect in it. The (D) adversarial
// scenario is the one deliberate exception: it tests a shape Node itself can never produce, so a
// hand-rolled fake is correct there, not a workaround.
import { EventEmitter } from "node:events";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Round 2 (S3): a SINGLE array that is NEVER reset across the whole file — the round-1 test reset its
// flag per scenario and checked it immediately after that scenario's own `await`, which silently
// misattributed a late-firing crash to a LATER scenario and let every "no uncaughtException" check read
// PASS even with a broken fix. Each scenario below records this array's length before/after its own work
// and drains the event loop with `setImmediate` (the "check" phase boundary, run only after Node's own
// nextTick queue — where the real crash path lives — has fully emptied; not an arbitrary time duration,
// so this is not the fixed-wait-guarding-a-negative-assertion shape fixed-wait-negative-guard.mjs polices)
// before reading the delta.
const uncaughtExceptions = [];
process.on("uncaughtException", (e) => {
  uncaughtExceptions.push(e);
  console.log(`[uncaughtException] ${e && e.message}`);
});
async function crashDeltaDuring(fn) {
  const before = uncaughtExceptions.length;
  const result = await fn();
  await new Promise((r) => setImmediate(r));
  return { ...result, crashDelta: uncaughtExceptions.length - before };
}

const { boundedSimpleGit, classifySpawnResourceExhaustionCode, tagErrorWithSpawnGuardMarkerForTest } = await import("../dist/git/bounded.js");

// --- (A) direct unit checks on the classifier -------------------------------------------------------
// Guarded by its own existence check (never a bare call) so that running this file against PRE-FIX code
// (where this export does not exist at all) reports a clean, named FAIL here and still falls through to
// the real regression scenarios below, instead of an unrelated top-level throw masking them entirely.
check("classifySpawnResourceExhaustionCode is exported as a function", typeof classifySpawnResourceExhaustionCode === "function");
check("tagErrorWithSpawnGuardMarkerForTest is exported as a function", typeof tagErrorWithSpawnGuardMarkerForTest === "function");
if (typeof classifySpawnResourceExhaustionCode === "function" && typeof tagErrorWithSpawnGuardMarkerForTest === "function") {
  // Round 2 (B2): Node's real syscall is "spawn " + spawnfile, never a bare "spawn" — these three cover
  // the no-file edge case, the real local shape, and the real win32 shape (an absolute path WITH spaces,
  // the exact thing the round-1 regex couldn't match). Round 3 (B-a): classification ALSO now requires
  // this process's own spawn-guard marker, so a correctly-SHAPED message with no marker must still
  // return undefined — `tagErrorWithSpawnGuardMarkerForTest` is what makes these "genuinely ours".
  check("matches the no-spawnfile edge case (tagged)", classifySpawnResourceExhaustionCode(tagErrorWithSpawnGuardMarkerForTest(new Error("Error: spawn EMFILE\n    at foo (bar.js:1:1)"))) === "EMFILE");
  check("matches the real local shape (spawn git EMFILE, tagged)", classifySpawnResourceExhaustionCode(tagErrorWithSpawnGuardMarkerForTest(new Error("Error: spawn git EMFILE\n    at foo (bar.js:1:1)"))) === "EMFILE");
  check("matches the real win32 shape (absolute path WITH spaces, tagged)", classifySpawnResourceExhaustionCode(tagErrorWithSpawnGuardMarkerForTest(new Error("Error: spawn C:\\Program Files\\Git\\cmd\\git.exe EMFILE\n    at foo (bar.js:1:1)"))) === "EMFILE");
  check("matches ENFILE the same way (tagged)", classifySpawnResourceExhaustionCode(tagErrorWithSpawnGuardMarkerForTest(new Error("Error: spawn git ENFILE\n    at foo (bar.js:1:1)"))) === "ENFILE");
  check("returns undefined for an unrelated message (negative control)", classifySpawnResourceExhaustionCode(new Error("fatal: not a git repository")) === undefined);
  check("returns undefined for a non-Error input", classifySpawnResourceExhaustionCode("just a string") === undefined);

  // Round 3 (B-a), the core regression: the CORRECTLY-SHAPED EMFILE text, UNTAGGED (as it would be on a
  // real git failure's own stderr/message, including one deliberately forged by anything with write
  // access to a shared, worker-writable `.git` — a pre-commit hook is the real, reproduced vector), must
  // NEVER classify, on ANY line of the message, not just later ones.
  check("B-a: a correctly-shaped but UNTAGGED EMFILE line on message line 1 is NOT classified", classifySpawnResourceExhaustionCode(new Error("Error: spawn git EMFILE\n    at foo (bar.js:1:1)")) === undefined);
  check("B-a: a correctly-shaped but UNTAGGED EMFILE line on message line 2+ (the reviewer's hook repro shape) is NOT classified", classifySpawnResourceExhaustionCode(new Error("fatal: something\nhint: x\nError: spawn npx EMFILE")) === undefined);
} else {
  failures += 8; // account for the 8 checks skipped above so a pre-fix run's failure count is still honest
}

// The REAL guard (installed lazily, on this process's FIRST `boundedSimpleGit()` call) captures
// whatever `child_process.spawn` IS at that moment as its OWN permanent `realSpawn` closure variable —
// a LATER `cp.spawn = ...` reassignment is invisible to it (that is simple-git's own guard's job, not
// this test's to re-exercise). So every scenario below must be reachable through ONE dispatcher,
// installed BEFORE the very first `boundedSimpleGit()` call in this process, that falls through to the
// true original spawn for everything except a per-scenario MARKER command string — dispatched via
// `boundedSimpleGit`'s own `binaryOverride` param (its 7th arg), which simple-git passes straight through
// as `spawn()`'s own `command` argument.
const TRUE_REAL_SPAWN = cp.spawn;
const fakeBehaviors = new Map();
cp.spawn = (...args) => {
  const behavior = fakeBehaviors.get(args[0]);
  return behavior ? behavior(...args) : TRUE_REAL_SPAWN(...args);
};
// FIDELITY-CRITICAL: without this, simple-git's ESM `spawn` binding (a snapshot — see the decision
// record) would stay pointed at the TRUE original spawn, our dispatcher above would never actually be
// reached by simple-git at all, and every fake scenario below would silently degrade into a REAL ENOENT
// for a literally-nonexistent binary name instead — a harmless, unrelated failure mode that was never
// broken, making the whole RED-phase proof pass for the wrong reason. This call makes our dispatcher
// reachable EVEN AGAINST PRE-FIX code (which has no `syncBuiltinESMExports()` call of its own) — exactly
// what a genuine apples-to-apples RED/GREEN comparison needs.
syncBuiltinESMExports();

const repoPath = process.cwd();
const uv = process.binding("uv");

// Round 2 (B1): drives a REAL `cp.ChildProcess()` whose `_handle.spawn` is overridden to return the real
// UV_EMFILE/UV_ENFILE binding directly — Node's OWN unmodified `ChildProcess.prototype.spawn` then runs
// its real internal logic from that return value onward (the exact early-return path, including the real
// `onexit`/`onErrorNT` chain that a hand-rolled EventEmitter fake never touches).
function realEarlyReturnChild(uvCode) {
  return (_cmd, gitArgs) => {
    const child = new cp.ChildProcess();
    child._handle.spawn = () => uvCode;
    child.spawn({ file: "git", args: ["git", ...(gitArgs || [])], stdio: "pipe", envPairs: [] });
    return child;
  };
}

// --- (B) EMFILE: must reject, classified, no crash (REAL ChildProcess) -------------------------------
{
  fakeBehaviors.set("FAKE_EMFILE_293beb47", realEarlyReturnChild(uv.UV_EMFILE));
  const git = boundedSimpleGit(repoPath, 15000, undefined, undefined, undefined, undefined, "FAKE_EMFILE_293beb47");
  const { rejection, crashDelta } = await crashDeltaDuring(async () => {
    let rejection = null;
    try { await git.raw(["status"]); } catch (e) { rejection = e; }
    return { rejection };
  });
  check("(B) EMFILE scenario rejects (does not resolve)", rejection !== null);
  check("(B) EMFILE rejection message's FIRST line matches the real Node syscall shape", /^Error: spawn .* EMFILE$/.test((rejection?.message ?? "").split("\n")[0]));
  check("(B) EMFILE rejection message carries the real spawn-guard marker (end-to-end tagging happened)", (rejection?.message ?? "").includes("[loom-spawn-guard:"));
  check("(B) EMFILE rejection carries .code === 'EMFILE'", rejection && rejection.code === "EMFILE");
  check("(B) EMFILE scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (C) ENFILE: same shape, different code (REAL ChildProcess) --------------------------------------
{
  fakeBehaviors.set("FAKE_ENFILE_293beb47", realEarlyReturnChild(uv.UV_ENFILE));
  const git = boundedSimpleGit(repoPath, 15000, undefined, undefined, undefined, undefined, "FAKE_ENFILE_293beb47");
  const { rejection, crashDelta } = await crashDeltaDuring(async () => {
    let rejection = null;
    try { await git.raw(["status"]); } catch (e) { rejection = e; }
    return { rejection };
  });
  check("(C) ENFILE scenario rejects (does not resolve)", rejection !== null);
  check("(C) ENFILE rejection message's FIRST line matches the real Node syscall shape", /^Error: spawn .* ENFILE$/.test((rejection?.message ?? "").split("\n")[0]));
  check("(C) ENFILE rejection message carries the real spawn-guard marker (end-to-end tagging happened)", (rejection?.message ?? "").includes("[loom-spawn-guard:"));
  check("(C) ENFILE rejection carries .code === 'ENFILE'", rejection && rejection.code === "ENFILE");
  check("(C) ENFILE scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (D) [SYNTHETIC-ONLY, unreachable on any real Node path] adversarial 'error' then a SUCCESS-shaped
// close(0) must still reject (error wins) -----------------------------------------------------------
// Requirement (e)'s exact risk: stubbed streams must never let simple-git read a 0-exit-code close as
// success once an 'error' has already been received on the same child. Deliberately feeds a shape REAL
// Node can NEVER produce (real EMFILE/ENFILE always closes with a negative errno — see (B)/(C); a plain
// EventEmitter fake is correct HERE, unlike (B)/(C), because this is testing the guard's own defensive
// emit-override, not reproducing a real Node code path) to prove the REJECTION, not the exit code, is
// what decides the outcome. Round 3, N2: labeled explicitly as synthetic-only in every check below —
// this scenario does NOT claim to reproduce anything a real Node process can actually do.
{
  fakeBehaviors.set("FAKE_ADVERSARIAL_293beb47", () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = undefined;
    child.stderr = undefined;
    child.stdin = undefined;
    const err = new Error("spawn git EMFILE");
    err.code = "EMFILE";
    process.nextTick(() => {
      child.emit("error", err);
      child.emit("close", 0, null); // adversarial: a success-shaped close despite the prior 'error'
    });
    return child;
  });
  const git = boundedSimpleGit(repoPath, 15000, undefined, undefined, undefined, undefined, "FAKE_ADVERSARIAL_293beb47");
  const { resolved, rejection, crashDelta } = await crashDeltaDuring(async () => {
    let resolved = undefined;
    let rejection = null;
    try { resolved = await git.raw(["status"]); } catch (e) { rejection = e; }
    return { resolved, rejection };
  });
  check("(D) [SYNTHETIC-ONLY] adversarial close(0)-after-error still rejects, never resolves as success", resolved === undefined && rejection !== null);
  check("(D) [SYNTHETIC-ONLY] adversarial scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (E) real ENOENT spawn passes through the guard UNTOUCHED (identity-preserving) ------------------
{
  const { gotErr, child, crashDelta } = await crashDeltaDuring(async () => {
    const { spawn: realSpawn } = cp;
    const child = realSpawn("this-binary-does-not-exist-293beb47", [], { windowsHide: true });
    let gotErr = null;
    await new Promise((resolve) => { child.on("error", (e) => { gotErr = e; resolve(); }); });
    return { gotErr, child };
  });
  check("(E) real ENOENT: pid is undefined (Node's own real shape, unrelated to our guard)", child.pid === undefined);
  check("(E) real ENOENT: stdout is a REAL stream, not one of our stub streams", typeof child.stdout?.pipe === "function");
  check("(E) real ENOENT: error code is the real, unclassified-by-us ENOENT", gotErr && gotErr.code === "ENOENT");
  check("(E) real ENOENT scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (F) real successful spawn passes through the guard UNTOUCHED ------------------------------------
{
  const { code, child, crashDelta } = await crashDeltaDuring(async () => {
    const { spawn: realSpawn } = cp;
    const child = realSpawn(process.execPath, ["--version"], { windowsHide: true });
    const code = await new Promise((resolve) => { child.on("close", resolve); });
    return { code, child };
  });
  check("(F) real success: stdout is a REAL stream", typeof child.stdout?.pipe === "function");
  check("(F) real success: close code is 0", code === 0);
  check("(F) real success scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (G) a genuinely unrelated real git failure (not-a-repo cwd) still surfaces normally -------------
{
  const { rejection, crashDelta } = await crashDeltaDuring(async () => {
    const git = boundedSimpleGit(os.tmpdir(), 15000); // a real, existing dir that is never a git repo
    let rejection = null;
    try { await git.raw(["status"]); } catch (e) { rejection = e; }
    return { rejection };
  });
  check("(G) unrelated real failure still rejects normally", rejection !== null);
  check("(G) unrelated real failure is NOT misclassified as EMFILE/ENFILE", classifySpawnResourceExhaustionCode(rejection) === undefined);
  check("(G) unrelated real failure scenario: no uncaughtException fired during this scenario", crashDelta === 0);
}

// --- (H) Round 3 (B-a) end-to-end: a REAL git failure, through a REAL pre-commit hook that forges an
// EMFILE/ENFILE-shaped line on its own stderr, must NEVER be misclassified -----------------------------
// The shared `.git` is worker-writable, so a hook forging this exact text is a real, not theoretical,
// attack surface (the reviewer's own reproduction). Tests the forged line on stderr line 2 (the
// reviewer's repro shape — a hook's own sub-tool genuinely hitting EMFILE, unrelated to git) AND line 1
// (the message-start anchor from B2/B-a alone would NOT have caught this one).
{
  const hookRepo = fs.mkdtempSync(path.join(os.tmpdir(), "loom-293beb47-hookrepo-"));
  const envOverrides = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  try {
    const initGit = boundedSimpleGit(hookRepo, 15000, envOverrides);
    await initGit.raw(["init"]);
    const hooksDir = path.join(hookRepo, ".git", "hooks");
    const writeHook = (forgedLine1st) => {
      const lines = forgedLine1st
        ? ["#!/bin/sh", "echo \"Error: spawn npx EMFILE\" >&2", "echo \"pre-commit: lint failed on file foo.js\" >&2", "exit 1"]
        : ["#!/bin/sh", "echo \"pre-commit: lint failed on file foo.js\" >&2", "echo \"Error: spawn npx EMFILE\" >&2", "exit 1"];
      fs.writeFileSync(path.join(hooksDir, "pre-commit"), lines.join("\n") + "\n", { mode: 0o755 });
    };

    for (const [label, forgedLine1st] of [["forged on stderr line 2 (the reviewer's repro shape)", false], ["forged on stderr line 1", true]]) {
      writeHook(forgedLine1st);
      const { rejection, crashDelta } = await crashDeltaDuring(async () => {
        const git = boundedSimpleGit(hookRepo, 15000, envOverrides);
        let rejection = null;
        try { await git.raw(["commit", "--allow-empty", "-m", "x"]); } catch (e) { rejection = e; }
        return { rejection };
      });
      check(`(H) real pre-commit-hook failure, ${label}: rejects (the hook genuinely failed the commit)`, rejection !== null);
      check(`(H) real pre-commit-hook failure, ${label}: .code stays undefined (never misclassified as EMFILE)`, rejection && rejection.code === undefined);
      check(`(H) real pre-commit-hook failure, ${label}: classifySpawnResourceExhaustionCode also returns undefined`, classifySpawnResourceExhaustionCode(rejection) === undefined);
      check(`(H) real pre-commit-hook failure, ${label}: no uncaughtException fired during this scenario`, crashDelta === 0);
    }
  } finally {
    fs.rmSync(hookRepo, { recursive: true, force: true });
  }
}

console.log(uncaughtExceptions.length === 0 ? "no uncaughtException observed across the ENTIRE run (cumulative)" : `${uncaughtExceptions.length} uncaughtException(s) observed across the ENTIRE run (cumulative)`);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 && uncaughtExceptions.length === 0 ? 0 : 1);
