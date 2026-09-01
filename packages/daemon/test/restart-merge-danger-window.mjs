import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f05e5a06: `requestDaemonRestart` (the `daemon_restart` MCP tool, the path that actually fires for
// a manager's routine deploy) used to exit via a bare `process.exit()`, which emits NO signal — so
// `gracefulShutdown`'s own merge-danger-window guard (index.ts, bound only to SIGINT/SIGTERM/SIGHUP) never
// ran for it, even though the owner's manual `loom stop` (which DOES emit a signal) was the ONLY path
// actually guarded. This proves the fix: requestDaemonRestart now awaits
// waitForMergeDangerWindowsToClear() before scheduling its exit, with the SAME bounded, fail-open
// semantics gracefulShutdown uses (never a hard refusal; always resolves within the grace ceiling), and
// makes the wait OBSERVABLE via the returned `mergeDangerWait` field (per the card's DoD-3: "a wait that
// happens invisibly cannot be verified later").
//
// Proves:
//   (1) NO active merge-danger window -> requestDaemonRestart resolves immediately (mergeDangerWait.
//       windowsActive === 0, waitedMs small) -- the common case pays no latency.
//   (2) An ACTIVE merge-danger window (simulated via enterMergeDangerWindow, the same call
//       mergeBranchLocked makes right before `git merge --squash`) -> requestDaemonRestart's promise does
//       NOT resolve while the window stays open, and DOES resolve once it's cleared -- proving the wait is
//       real, not a no-op, and that it's anchored to the observable window state (not a fixed sleep).
//   (3) ORDERING (card DoD-2): `exit` is never invoked before the awaited wait settles -- and the
//       pre-existing 300ms MCP-response-flush delay still runs AFTER the wait, unshortened -- proving the
//       merge-danger wait doesn't race or get bypassed by that timer.
//   (4) The guard is FAIL-OPEN + BOUNDED: a window that never clears still lets requestDaemonRestart
//       resolve, within the (test-shrunk) grace ceiling -- never a hard refusal.
// Run: 1) build daemon (tsc -p tsconfig.json), 2) node test/restart-merge-danger-window.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNeverWithControl, observeOnce, pollUntil } from "./_timing-guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
process.env.LOOM_SUPERVISED = "1"; // requestDaemonRestart refuses outright when unsupervised

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { clearRestartIntent } = await import("../dist/orchestration/restart.js");
const { enterMergeDangerWindow, exitMergeDangerWindow, listActiveMergeDangerWindows } = await import("../dist/git/merge-danger-window.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeExit = () => { const calls = []; return { calls, fn: (code) => calls.push({ code, at: Date.now() }) }; };

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ids = { projId: `mdw-proj-${sfx}`, agentId: `mdw-agent-${sfx}`, mgrId: `mdw-mgr-${sfx}` };
const now = new Date().toISOString();
const REPO_PATH = path.join(os.tmpdir(), `loom-mdw-fake-repo-${sfx}`); // never touched on disk -- this test never calls a real merge
const buildDeps = { runStep: async () => ({ code: 0, out: "" }) }; // instant green build, shared by every case below

try {
  db.insertProject({ id: ids.projId, name: "MDW", repoPath: REPO_PATH, vaultPath: REPO_PATH, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: REPO_PATH, processState: "running", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // --- (1) no active window: resolves immediately, wait is a documented no-op ---
  // ALSO doubles as the positiveControl proof for (2)/(3a) below: waitForMergeDangerWindowsToClear is a
  // GLOBAL wait (any active window anywhere blocks it -- not scoped to a repo/session), so once (2) opens
  // its own window there is no way to independently exercise a genuine "no window" call alongside it. This
  // run, taken here BEFORE any window exists, is the one place in this process that CAN genuinely observe
  // `resolved`/exit-callback flipping true under a real (not fabricated) no-window condition -- captured
  // now and reused as the positiveControl's return value below, rather than faking a state that (2)'s own
  // scenario makes impossible to reconstruct concurrently.
  check("(1-pre) no merge-danger window active", listActiveMergeDangerWindows().length === 0);
  const exit1 = makeExit();
  const t0 = Date.now();
  const r1 = await sessions.requestDaemonRestart(ids.mgrId, "deploy, nothing in flight", { buildDeps, exit: exit1.fn, mergeDangerGraceMs: 5000 });
  const elapsed1 = Date.now() - t0;
  check("(1) restarting:true", r1.restarting === true);
  check("(1) mergeDangerWait reports 0 windows active", r1.mergeDangerWait?.windowsActive === 0);
  check("(1) mergeDangerWait resolves fast when nothing is in flight (<1000ms, not the 5000ms ceiling)", elapsed1 < 1000);
  const resolvedProofWentTrue = r1.restarting === true; // r1 already resolved above -- a real, not fabricated, observation
  const exitProofWentTrue = await pollUntil(() => exit1.calls.length > 0, { timeoutMs: 1000, intervalMs: 20 });
  check("(1) exit1 fired within the flush delay (this run doubles as (2)/(3a)'s positive-control proof)", exitProofWentTrue);
  clearRestartIntent();

  // --- (2) + (3): an active window blocks the promise until cleared, and `exit` is never called before that ---
  enterMergeDangerWindow(REPO_PATH, "loom/some-branch", "op-1");
  check("(2-pre) merge-danger window now active", listActiveMergeDangerWindows().length === 1);

  const exit2 = makeExit();
  let resolved = false;
  const p2 = sessions.requestDaemonRestart(ids.mgrId, "deploy while a squash is in flight", { buildDeps, exit: exit2.fn, mergeDangerGraceMs: 5000 })
    .then((r) => { resolved = true; return r; });

  // (2)+(3a): prove requestDaemonRestart does NOT resolve / call exit while the window is still open --
  // via assertNeverWithControl (a bounded sampling window with a MANDATORY positiveControl proving the
  // SAME check can go true), not a bare fixed sleep-then-look: a raw sleep can't distinguish "genuinely
  // blocked" from "just hasn't happened yet by luck" in one trial (see fixed-wait-negative-guard.mjs).
  const neverResolvedEarly = await assertNeverWithControl({
    label: "requestDaemonRestart resolves while a merge-danger window is still open",
    check: () => resolved === true,
    windowMs: 300,
    // Reuses (1)'s already-observed proof (see the comment above (1)) -- the SAME resolved-flip mechanism,
    // genuinely exercised moments ago under the one no-window condition this process can produce.
    positiveControl: async () => resolvedProofWentTrue,
  });
  check("(2) requestDaemonRestart has NOT resolved while the window is still open (assertNeverWithControl-proven)", neverResolvedEarly);

  const exitCalledEarly = await assertNeverWithControl({
    label: "daemon_restart's exit callback fires while a merge-danger window is still open",
    check: () => exit2.calls.length > 0,
    windowMs: 300,
    // Reuses (1)'s already-observed proof that the exit callback genuinely fires under no-window conditions.
    positiveControl: async () => exitProofWentTrue,
  });
  check("(3a) daemon_restart's exit callback was NOT called while the window is still open (assertNeverWithControl-proven)", exitCalledEarly);

  const clearedAt = Date.now();
  exitMergeDangerWindow(REPO_PATH); // the observable event mergeBranchLocked's own `finally` fires on every exit
  const r2 = await p2;
  const settledAt = Date.now();
  check("(2) requestDaemonRestart resolves once the window clears", resolved === true);
  check("(2) mergeDangerWait reports 1 window was active", r2.mergeDangerWait?.windowsActive === 1);
  check("(2) mergeDangerWait's waitedMs reflects a REAL wait (>=250ms, not a near-zero no-op)", (r2.mergeDangerWait?.waitedMs ?? 0) >= 250);
  check("(2) it resolved promptly after the window cleared (<2000ms poll latency), not after riding out the 5000ms ceiling",
    settledAt - clearedAt < 2000);
  check("(3b) exit still not yet called the instant the wait settles (the 300ms MCP-response-flush delay is unshortened)", exit2.calls.length === 0);
  // (3c): exit DOES eventually fire, ~300ms later -- observed via pollUntil (a real completion signal to
  // wait for), not a guessed fixed sleep.
  const exitEventuallyFired = await pollUntil(() => exit2.calls.length > 0, { timeoutMs: 1000, intervalMs: 20 });
  check("(3c) exit fires once the (unshortened) 300ms flush delay elapses (observed via pollUntil)", exitEventuallyFired);
  check("(3c) exit's captured timestamp lands after the wait settled, at roughly the flush delay (>=250ms later)",
    exit2.calls.length === 1 && exit2.calls[0].at >= settledAt + 250);
  clearRestartIntent();

  // --- (4) fail-open: a window that never clears still lets the call resolve, within the (shrunk) ceiling ---
  enterMergeDangerWindow(REPO_PATH, "loom/never-clears", "op-2");
  const exit4 = makeExit();
  const t4 = Date.now();
  const r4 = await sessions.requestDaemonRestart(ids.mgrId, "deploy against a window that never clears", { buildDeps, exit: exit4.fn, mergeDangerGraceMs: 500 });
  const elapsed4 = Date.now() - t4;
  check("(4) restarting:true even though the window never cleared (fail-open, never a hard refusal)", r4.restarting === true);
  check("(4) resolved within the shrunk grace ceiling, not blocked indefinitely (400-2000ms)", elapsed4 >= 400 && elapsed4 < 2000);
  check("(4) mergeDangerWait.waitedMs is bounded by the grace ceiling (<=700ms, allowing poll slack)", (r4.mergeDangerWait?.waitedMs ?? 0) <= 700);
  exitMergeDangerWindow(REPO_PATH); // cleanup -- don't leak a dangling window into another test's process
  clearRestartIntent();
  await sleep(350); // drain case (4)'s own pending flush timer before process exit
} finally {
  db.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS -- requestDaemonRestart now awaits the merge-danger-window guard (observably, in its return value) before scheduling its exit: fast when nothing's in flight, blocks until a real in-flight squash clears (not a no-op), never races the pre-existing 300ms flush delay, and fails open within a bounded grace ceiling when the window never clears."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
