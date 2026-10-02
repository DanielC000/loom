import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8e84e4a6 (full review lane 1 2785fbc2 M5): requestDaemonRestart used to let two overlapping
// daemon_restart calls (two managers, Lead + manager, or an MCP client retrying mid-build) each run
// their OWN `pnpm install --frozen-lockfile` + `turbo build --force` against the SAME main checkout
// concurrently — stepping on the (then-fixed-path) web-dist snapshot, racing the restart-intent write,
// and letting the first green exit while the second's install/build children were still mutating the
// tree. Also: a bare `child.kill()` on the "install" step's timeout only killed the SHELL, leaving a
// `pnpm`-spawned descendant tree alive (the SAME class of bug `gate-timeout-tree-kill.mjs` fixed for the
// merge/worker gate runner — card 3564fd1e).
//
// Proves:
//   (A) SINGLE-FLIGHT, RED-proofed via negative control: a second overlapping requestDaemonRestart call
//       ATTACHES to the in-flight attempt instead of starting a second real buildDaemon() — proven by a
//       concurrent-invocation counter that (negative control) DOES catch >1 when the SAME counter is
//       driven by two direct, unguarded buildDaemon() calls (the old, unprotected shape), but never
//       exceeds 1 when driven through two overlapping requestDaemonRestart() calls (the fix).
//   (B) NOTES CARRIED: the second (attached) caller's own `reason` is folded into the persisted restart
//       intent's `reason` text alongside the first caller's, rather than being silently dropped — and
//       the attached caller is handed back the SAME result object as the first.
//   (C) TREE-KILL, REAL SPAWN: restart.ts's own `runBuildStep` (the SAME helper `buildDaemon` calls for a
//       real "install"/"build" step) spawns a real grandchild via a real OS-level timeout and kills the
//       WHOLE tree, not just the top-level shell — mirrors gate-timeout-tree-kill.mjs's own tier 1
//       methodology exactly, against restart.ts's runner instead of gate-runner.ts's.
//   (D) FAILED ATTEMPT: an attached (second) caller on a doomed attempt gets the IDENTICAL failure result
//       as the first, never its own independent outcome — and a later, genuinely FRESH call (after the
//       failed one settles) starts its own new attempt rather than staying stuck attached to the old
//       failure forever (the single-flight latch is scoped to `restarting:true` ONLY — see MINOR 1).
//   (CRITICAL, Code Review): `attempt`'s promise must NEVER reject — an unhandled rejection anywhere in
//       this daemon process is turned into `process.exit(1)` by crashlog.ts (NOT the restart sentinel), so
//       the supervisor would never relaunch and the whole fleet would stay down. Proven for two real throw
//       sites (writeRestartIntent via a deterministic renameSync fault injection, and a throwing
//       `isSupervisorAlive`): a registered `unhandledRejection` listener sees nothing, and the caller still
//       gets a plain `{restarting:false}` — with its own negative control showing the listener IS a real,
//       working instrument: a synthetic `Promise.reject().finally()` (the general hazard shape a bare
//       `.finally()` on a rejecting promise creates, NOT a literal reproduction of the pre-review code)
//       DOES trip it.
//   (E) MINOR 1 pin: the single-flight lock stays LATCHED through a `restarting:true` result until the
//       scheduled exit has actually fired, not merely until the promise resolved — RED-proofed against
//       the pre-MINOR-1 shape (commit e495cbd7), which cleared the lock on ANY settle immediately.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/daemon-restart-single-flight.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-drsf-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
delete process.env.LOOM_SUPERVISED;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const restart = await import("../dist/orchestration/restart.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
// Fault-injection seam for writeJsonAtomic (pty/claude-config.ts) — fs's ESM namespace import can't be
// monkeypatched directly, so this is the real seam test/write-json-atomic-fault-injection.mjs already uses
// to force a deterministic, cross-platform rename failure instead of a probabilistic concurrent-writer race.
const { __setRenameSyncForTest } = await import("../dist/pty/claude-config.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (cond, timeoutMs, stepMs = 50) => {
  try {
    return !!(await sharedWaitUntil(cond, { timeoutMs, intervalMs: stepMs, label: "daemon-restart-single-flight: cond" }));
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return cond();
  }
};

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-drsf-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

// ============================== (A)+(B) single-flight + notes carried ==============================
{
  const file = tmpDbFile("sf");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "sf-proj", name: "SF", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "sf-agent", projectId: "sf-proj", name: "t", startupPrompt: "", position: 0 });
  // cwd must be a real, existing dir — liveFleetResumeSet() filters on fs.existsSync(cwd).
  db.insertSession({ id: "sf-mgrA", projectId: "sf-proj", agentId: "sf-agent", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: "sf-mgrB", projectId: "sf-proj", agentId: "sf-agent", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const sessions = new SessionService(db, { getPersistablePendingSnapshot: () => ({ texts: [], holds: {} }), isComposerDirty: () => false }, new OrchestrationControl());

  // Gate the "install" step on a manually-released promise so TWO requestDaemonRestart calls can be
  // in flight at once, deterministically (no timing race) — the second call is only issued once the
  // first call's build has genuinely started (concurrentNow === 1), and only released once both calls
  // have been ISSUED (see below), so the overlap window is real, not accidental.
  let concurrentNow = 0;
  let maxConcurrent = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const blockingRunStep = async (step) => {
    if (step.label !== "install") return { code: 0, out: "" };
    concurrentNow++;
    maxConcurrent = Math.max(maxConcurrent, concurrentNow);
    await gate;
    concurrentNow--;
    return { code: 0, out: "" };
  };

  process.env.LOOM_SUPERVISED = "1";
  let resultA, resultB;
  try {
    const pA = sessions.requestDaemonRestart("sf-mgrA", "reason from A", {
      buildDeps: { runStep: blockingRunStep },
      exit: () => {}, // never actually exits this test process
      isSupervisorAlive: async () => ({ alive: true }),
    });
    // Wait until A's build has genuinely entered the blocked "install" step before firing B — proves
    // the overlap is real (B arrives WHILE A's buildDaemon() is mid-flight), not merely sequential.
    await waitUntil(() => concurrentNow === 1, 2000);
    // B's own attach check (`if (this.inFlightRestart)`) is entirely SYNCHRONOUS code running before the
    // first `await` in requestDaemonRestart — no sleep needed between minting `pB` and knowing B has
    // already attached; releasing the gate immediately below is safe.
    const pB = sessions.requestDaemonRestart("sf-mgrB", "reason from B", {
      buildDeps: { runStep: blockingRunStep }, // never actually invoked for B — single-flight attaches instead
      exit: () => {},
      isSupervisorAlive: async () => ({ alive: true }),
    });
    releaseGate();
    [resultA, resultB] = await Promise.all([pA, pB]);
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }

  check("(A) the guarded path NEVER ran two concurrent builds — max concurrency stayed at 1", maxConcurrent === 1);
  check("(A) both overlapping callers see a successful restart", resultA.restarting === true && resultB.restarting === true);
  check("(A) the attached (second) caller gets the IDENTICAL result object as the first", resultA === resultB);

  const written = restart.readRestartIntent();
  check("(B) the persisted intent's managerSessionId is the FIRST (entry-creating) caller's own session id",
    written?.managerSessionId === "sf-mgrA");
  check("(B) the restart-intent reason carries the FIRST caller's own reason text",
    typeof written?.reason === "string" && written.reason.includes("reason from A"));
  check("(B) the restart-intent reason ALSO carries the SECOND (attached) caller's reason text — not silently dropped",
    typeof written?.reason === "string" && written.reason.includes("reason from B") && written.reason.includes("sf-mgrB"));

  // ---- NEGATIVE CONTROL: the SAME concurrency counter genuinely detects >1 when nothing guards it ----
  // Proves the instrument above is capable of going RED (not vacuously green) — this directly reproduces
  // the pre-fix shape (two unguarded buildDaemon() calls racing against the SAME checkout) that
  // requestDaemonRestart's single-flight (A) above now prevents.
  {
    let ncConcurrent = 0, ncMax = 0, ncRelease;
    const ncGate = new Promise((r) => { ncRelease = r; });
    const ncRunStep = async (step) => {
      if (step.label !== "install") return { code: 0, out: "" };
      ncConcurrent++;
      ncMax = Math.max(ncMax, ncConcurrent);
      await ncGate;
      ncConcurrent--;
      return { code: 0, out: "" };
    };
    const bgiRoot = path.join(os.tmpdir(), `loom-drsf-nc-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const b1 = restart.buildDaemon({ runStep: ncRunStep, root: bgiRoot });
    const b2 = restart.buildDaemon({ runStep: ncRunStep, root: bgiRoot });
    await waitUntil(() => ncConcurrent === 2, 2000);
    check("(negative control) two UNGUARDED buildDaemon() calls DO run concurrently (proves the counter can detect the bug the fix prevents)", ncConcurrent === 2);
    ncRelease();
    await Promise.all([b1, b2]);
    check("(negative control) the unguarded pair's own max concurrency reached 2", ncMax === 2);
    try { fs.rmSync(bgiRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================== (D) failed attempt: attached caller sees the SAME failure, and a later
// FRESH call genuinely retries (MINOR 1's latch is restarting:true-ONLY) ==============================
{
  const file = tmpDbFile("fail-retry");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "fr-proj", name: "FR", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "fr-agent", projectId: "fr-proj", name: "t", startupPrompt: "", position: 0 });
  for (const id of ["fr-mgrA", "fr-mgrB", "fr-mgrC"]) {
    db.insertSession({ id, projectId: "fr-proj", agentId: "fr-agent", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  }

  const sessions = new SessionService(db, { getPersistablePendingSnapshot: () => ({ texts: [], holds: {} }), isComposerDirty: () => false }, new OrchestrationControl());

  // A blocking, ALWAYS-FAILING "install" step, gated so two overlapping callers can both attach to the
  // SAME doomed attempt before it settles — mirrors (A)'s overlap shape, but for the failure path.
  let releaseFailGate;
  const failGate = new Promise((r) => { releaseFailGate = r; });
  let failConcurrentNow = 0, failMaxConcurrent = 0;
  const failingRunStep = async (step) => {
    if (step.label !== "install") return { code: 0, out: "" };
    failConcurrentNow++;
    failMaxConcurrent = Math.max(failMaxConcurrent, failConcurrentNow);
    await failGate;
    failConcurrentNow--;
    return { code: 1, out: "ERR_SIMULATED_INSTALL_FAILURE" };
  };

  process.env.LOOM_SUPERVISED = "1";
  let resultA, resultB;
  try {
    const pA = sessions.requestDaemonRestart("fr-mgrA", "first attempt (will fail)", {
      buildDeps: { runStep: failingRunStep }, exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
    });
    await waitUntil(() => failConcurrentNow === 1, 2000);
    const pB = sessions.requestDaemonRestart("fr-mgrB", "attached while the same attempt is about to fail", {
      buildDeps: { runStep: failingRunStep }, exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
    });
    releaseFailGate();
    [resultA, resultB] = await Promise.all([pA, pB]);
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }

  check("(D) the guarded path never ran two concurrent builds even for a FAILING attempt", failMaxConcurrent === 1);
  check("(D) the first caller sees the build failure (restarting:false)",
    resultA.restarting === false && /ERR_SIMULATED_INSTALL_FAILURE/.test(resultA.error ?? ""));
  check("(D) the ATTACHED (second) caller receives the IDENTICAL failure result object, not its own independent outcome",
    resultA === resultB);

  // --- retry: a FRESH call after a failed attempt must start a genuinely NEW attempt — the latch (MINOR
  // 1) is scoped to `restarting:true` ONLY, so a `restarting:false` settle must clear it immediately. ---
  let retryRan = false;
  const retrySucceedsRunStep = async (step) => {
    if (step.label === "install") retryRan = true;
    return { code: 0, out: `${step.label} ok` };
  };
  process.env.LOOM_SUPERVISED = "1";
  let resultC;
  try {
    resultC = await sessions.requestDaemonRestart("fr-mgrC", "retry after the failed attempt", {
      buildDeps: { runStep: retrySucceedsRunStep }, exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
    });
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }
  check("(D retry) a fresh call after a failed attempt actually ran its OWN install step — a genuinely new attempt, not stuck attached to the old failure",
    retryRan === true);
  check("(D retry) and the fresh attempt succeeds normally", resultC.restarting === true);

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================== (CRITICAL) no unhandledRejection, ever — Code Review finding ==============================
{
  // NEGATIVE CONTROL FIRST: proves the `unhandledRejection` listener installed below is a real, working
  // instrument — a SYNTHETIC `Promise.reject().finally()` (the general hazard shape a bare `.finally()` on
  // a rejecting promise creates, not a literal reproduction of the pre-review source) DOES produce one, so
  // a clean result from the real scenarios below means the fix is real, not that nothing was watching.
  {
    const caught = [];
    const onUR = (err) => caught.push(err);
    process.on("unhandledRejection", onUR);
    try {
      const rejecting = Promise.reject(new Error("synthetic rejection for the negative control"));
      void rejecting.finally(() => {}); // the general bare-`.finally()`-on-a-rejecting-promise hazard, not a literal copy of any real code
      // setImmediate (not a sleep of arbitrary duration) is the documented, minimal mechanism for letting
      // Node's unhandledRejection tracker run its course — it fires on a LATER event-loop phase than the
      // microtask queue the rejection settles on, so one tick is sufficient and deterministic, not a guess.
      await new Promise((r) => setImmediate(r));
      check("(negative control) a bare `.finally()` on a rejecting promise DOES produce an unhandledRejection — proves the listener below is a real, working instrument, not vacuously green",
        caught.length === 1);
    } finally {
      process.off("unhandledRejection", onUR);
    }
  }

  const file = tmpDbFile("critical");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "crit-proj", name: "CRIT", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "crit-agent", projectId: "crit-proj", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "crit-mgr", projectId: "crit-proj", agentId: "crit-agent", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const sessions = new SessionService(db, { getPersistablePendingSnapshot: () => ({ texts: [], holds: {} }), isComposerDirty: () => false }, new OrchestrationControl());

  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  process.env.LOOM_SUPERVISED = "1";
  try {
    // --- writeRestartIntent (→ writeJsonAtomic → renameSync) throws ---
    __setRenameSyncForTest(() => { const e = new Error("ENOENT: simulated persistent rename failure"); e.code = "ENOENT"; throw e; });
    let resultWI;
    try {
      resultWI = await sessions.requestDaemonRestart("crit-mgr", "writeRestartIntent throws", {
        buildDeps: { runStep: async () => ({ code: 0, out: "" }) },
        exit: () => {},
        isSupervisorAlive: async () => ({ alive: true }),
      });
    } finally {
      __setRenameSyncForTest(); // restore the real renameSync immediately, win or lose
    }
    await new Promise((r) => setImmediate(r));
    check("(CRITICAL) writeRestartIntent throwing still resolves the caller with restarting:false (never rejects)",
      resultWI?.restarting === false);
    check("(CRITICAL) writeRestartIntent throwing produces NO unhandledRejection", unhandled.length === 0);

    // --- isSupervisorAlive (the pre-build liveness check) throws ---
    let resultSA, threwToCaller = false;
    try {
      resultSA = await sessions.requestDaemonRestart("crit-mgr", "isSupervisorAlive throws", {
        buildDeps: { runStep: async () => ({ code: 0, out: "" }) },
        exit: () => {},
        isSupervisorAlive: async () => { throw new Error("simulated isSupervisorAlive failure"); },
      });
    } catch {
      threwToCaller = true;
    }
    await new Promise((r) => setImmediate(r));
    check("(CRITICAL) isSupervisorAlive throwing still resolves the caller with restarting:false (never throws TO the caller either)",
      threwToCaller === false && resultSA?.restarting === false);
    check("(CRITICAL) isSupervisorAlive throwing produces NO unhandledRejection", unhandled.length === 0);
  } finally {
    delete process.env.LOOM_SUPERVISED;
    process.off("unhandledRejection", onUnhandled);
  }

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================== (E) MINOR 1 pin: the latch holds through the exit window, not merely
// until the promise resolves — RED against the pre-MINOR-1 shape (commit e495cbd7), which cleared the
// lock the instant ANY settle happened (via a bare `.finally()`), including `restarting:true`. Under that
// shape a second call arriving in the few hundred ms before the scheduled exit actually fires would find
// the lock already free and start its OWN competing build against a checkout about to vanish under it. ==
{
  const file = tmpDbFile("latch-window");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "lw-proj", name: "LW", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "lw-agent", projectId: "lw-proj", name: "t", startupPrompt: "", position: 0 });
  for (const id of ["lw-mgrA", "lw-mgrB", "lw-mgrC"]) {
    db.insertSession({ id, projectId: "lw-proj", agentId: "lw-agent", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  }

  const sessions = new SessionService(db, { getPersistablePendingSnapshot: () => ({ texts: [], holds: {} }), isComposerDirty: () => false }, new OrchestrationControl());

  let installInvocations = 0;
  const countingRunStep = async (step) => {
    if (step.label === "install") installInvocations++;
    return { code: 0, out: `${step.label} ok` };
  };
  const exitCalls = [];
  const captureExit = (code) => exitCalls.push(code);

  process.env.LOOM_SUPERVISED = "1";
  let resultA, resultB, resultC;
  try {
    resultA = await sessions.requestDaemonRestart("lw-mgrA", "first attempt", {
      buildDeps: { runStep: countingRunStep }, exit: captureExit, isSupervisorAlive: async () => ({ alive: true }),
    });
    check("(E) the first call succeeds (restarting:true)", resultA.restarting === true);
    check("(E) exit has NOT fired yet immediately after the promise resolves — still inside the flush window",
      exitCalls.length === 0);

    // A SECOND call arriving WHILE still inside the exit window (nothing has awaited the 300ms timer yet)
    // must ATTACH to the already-resolved attempt — same result object, no second install step.
    resultB = await sessions.requestDaemonRestart("lw-mgrB", "second call inside the exit window", {
      buildDeps: { runStep: countingRunStep }, exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
    });
    check("(E) a call arriving BEFORE the exit timer fires ATTACHES to the still-latched attempt (identical result object)",
      resultB === resultA);
    check("(E) and did NOT run its own install step — proves it attached rather than starting a fresh build",
      installInvocations === 1);

    // Wait for the ACTUAL scheduled exit to fire (the 300ms flush timer) — only then is the lock genuinely
    // released.
    await waitUntil(() => exitCalls.length === 1, 3000);
    check("(E) the scheduled exit eventually fires with the restart sentinel",
      exitCalls.length === 1 && exitCalls[0] === restart.RESTART_EXIT_CODE);

    // A THIRD call, arriving only AFTER the exit has actually fired, must start a genuinely FRESH attempt.
    resultC = await sessions.requestDaemonRestart("lw-mgrC", "third call after the exit window has closed", {
      buildDeps: { runStep: countingRunStep }, exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
    });
    check("(E) a call arriving AFTER the exit timer fired starts a genuinely NEW attempt (its own install step ran)",
      installInvocations === 2);
    check("(E) and the fresh attempt succeeds normally", resultC.restarting === true);
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================== (C) TREE-KILL, real spawn (runBuildStep) ==============================
{
  const scratchDir = path.join(os.tmpdir(), `loom-drsf-tk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(scratchDir, { recursive: true });
  const pidFile = path.join(scratchDir, "grandchild.pid");
  const q = (p) => `"${p}"`;
  // Mirrors gate-timeout-tree-kill.mjs's own tier-1 fixture exactly (shell -> node -> node, collapsing the
  // real incident's shell -> pnpm -> vitest fork-pool shape into something fast + deterministic): a
  // non-detached grandchild writes its own pid then hangs forever, and the "step" process itself hangs
  // forever too, so the ONLY thing that ever ends this is our own timeoutMs bound.
  const parentScript = path.join(scratchDir, "parent.cjs");
  fs.writeFileSync(parentScript, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const gc = spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  const step = { label: "install", command: `${q(process.execPath)} ${q(parentScript)}`, args: [], shell: true, timeoutMs: 1000 };
  const started = Date.now();
  const result = await restart.runBuildStep(step, scratchDir);
  const elapsed = Date.now() - started;
  check("(C) the step's own timeoutMs bound fires: non-zero code", result.code !== 0);
  check("(C) the failure tail names the timeout", /exceeded \d+ms — killed/.test(result.out));
  check("(C) the settle happens promptly (well under 10x the timeout bound, never hangs the test)", elapsed < step.timeoutMs * 10);

  await waitUntil(() => fs.existsSync(pidFile), 5000);
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  check("(C) the grandchild pid file was actually written (the grandchild really started)",
    Number.isFinite(grandchildPid) && grandchildPid > 0);
  const gcGone = await waitUntil(() => !isAlive(grandchildPid), 5000);
  check("(C) the GRANDCHILD is ACTUALLY GONE after the timeout kill — restart.ts's runBuildStep now kills the WHOLE tree via the shared killGateProcessTree helper, not just the shell", gcGone);

  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — requestDaemonRestart single-flights its build+exit sequence (a second overlapping caller attaches instead of racing a second real build; the negative control proves the concurrency instrument itself is non-vacuous), both callers' reason notes land in the persisted restart intent, restart.ts's own runBuildStep now kills the REAL process tree on timeout (grandchild included) not just the top-level shell, a failed attempt's attached caller sees the identical failure while a later fresh call genuinely retries, the whole attempt body never produces an unhandledRejection even when writeRestartIntent or isSupervisorAlive throw, and the single-flight lock stays latched through the exit window itself (not merely until the promise resolves)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
