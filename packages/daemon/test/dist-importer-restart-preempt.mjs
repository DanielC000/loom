import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c9a21e8f — a deploy restart pre-empts ADVISORY dist-importer checks (and only those), carries ONE
// coalesced re-fire per (project, repo) across the exit, and `gate_queue` reports `restartSafe`.
// Everything real except the check's own cut/build/run-set/remove/gate steps (the same
// distImporterCheck* seams dist-importer-check-glue.mjs uses) — the REAL GateSemaphore, the REAL
// requestDaemonRestart (build/exit/supervisor stubbed), the REAL restart-intent file under a temp LOOM_HOME.
//
//   (1) RUNNING advisory, abort honoured: preempt cancels it, nothing re-starts after it (the follow-up
//       folded in while it ran is NOT drained into a new run), the refire set is the UNION of the running
//       run's + the folded landing's touched modules, and no path-scoped reap fires (it settled in time).
//   (2) RUNNING advisory, abort NOT honoured within the bound (stuck in its cut/build): preempt reports it
//       `unverified` and reaps strays rooted in THAT run's own derived worktree path — never any other path.
//   (3) QUEUED advisory behind a non-advisory holder: cancelled; the holder's own signal is untouched.
//   (4) NON-advisory gates are never cancelled (a worker self-check + a merge-type op): cancelled count 0,
//       their signals stay un-aborted.
//   (5) PERSISTED CAP: > cap touched modules keeps exactly the cap and reports the overflow count —
//       never silently dropped.
//   (6) requestDaemonRestart end to end: advisory cancelled BEFORE the intent is written, the intent file
//       carries `distImporterRefire`, the result carries `advisoryPreempt`, a concurrent merge op is left
//       running, and a restart with NO advisory writes no refire field.
//   (6b) A restart that is REFUSED after the pre-empt (supervisor gone at the recheck) re-fires in-process.
//   (7) REFIRE: one check per carried entry, cut at the CURRENT mainline HEAD (not the stale sha), run set
//       computed from the carried union; a dropped-count entry tells the manager the re-check is partial.
//   (8) COALESCING (DoD-2): landings 2 and 3 arriving while landing 1 runs yield exactly ONE follow-up, cut
//       at landing 3's sha, covering the union of landing 2+3's modules.
//   (9) gate_queue `restartSafe`: true when empty / advisory-only; false for a worker self-check, a merge
//       op, and a landing-check.
//   (10) gate_cancel on a RUNNING advisory not confirmed gone: `cancel_signalled` (distinct from
//        `not_cancelled`), reason names the phase boundary; an ordinary self-check keeps `not_cancelled`.
//   (11) boot wiring: index.ts passes the persisted intent field to refireDistImporterChecks (TEXT check of
//        the source — wiring presence only, NOT behaviour; the behaviour is (6)+(7)).
//
//   (2b) mid-cut (no worktree path recorded yet): reaped by the deterministic DERIVED path only.
//   (8b) the follow-up's touched set asserted on runs that reach computeRunSet: landing A alone, then the
//        deduped union of B+C.
//   (9b) restartSafe conjuncts the queue snapshot alone cannot see: a merge in pre-admission prep, a
//        repo-guard-only holder, a merge mid-squash, a merge parked on its worker's self-check; all
//        released => true again.
//   (12) a landing arriving DURING the pause is folded into the refire set (one entry, union of modules);
//        once the list is SEALED a later arrival is never carried but never silent (manager nudged by sha).
//   (12b) end to end: arrivals between the pre-empt and the intent write AND between the write and the exit
//        are both in the persisted intent's refire.
//   (12c) a restart refused at the recheck re-fires in-process INCLUDING the paused arrival.
//   (13) a THROW after the pre-empt: the catch-all re-fires in-process, no intent is left behind.
//   (13b) the throw lands AFTER the intent write: the intent is cleared and the re-fire happens exactly once.
//   (14a/14b) a post-landing kick whose changed-paths git op is still pending across the seal: carried in the
//        intent if it resolves inside the bounded wait, else nudged by sha at the seal (late resolve = quiet).
//   (15) the paused-arrival merge is idempotent: an over-cap arrival merged twice reports its overflow once.
//
// Run: 1) build (pnpm build), 2) node test/dist-importer-restart-preempt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `lm-dirp-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
delete process.env.LOOM_SUPERVISED;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const restart = await import("../dist/orchestration/restart.js");
const { resolveWorktreePath } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dirp@loom -c user.name=dirp";
const now = new Date().toISOString();
const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const REPO = path.join(os.tmpdir(), `lm-dirp-repo-${sfx}`);
registerForCleanup(REPO);
fs.mkdirSync(REPO, { recursive: true });
fs.writeFileSync(path.join(REPO, "README.md"), "# dirp\n");
execSync("git init -q -b main", { cwd: REPO });
commitAll(REPO, "init", GIT_ID);
const headOf = () => execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();

const dbs = [];
let n = 0;
/** One fully-wired fixture: own Db, project, manager, SessionService with the check's step seams stubbed. */
function mkEnv(opts = {}) {
  n++;
  const P = { projId: `dirp-p${n}-${sfx}`, agentId: `dirp-a${n}-${sfx}`, mgrId: `dirp-m${n}-${sfx}` };
  const db = new Db(path.join(os.tmpdir(), `lm-dirp-db${n}-${sfx}.db`)); dbs.push(db);
  db.insertProject({ id: P.projId, name: "DIRP", repoPath: REPO, vaultPath: REPO, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const rec = { cuts: [], cutPaths: [], builds: 0, runSets: [], reaps: [], nudges: [] };
  const cutEntered = deferred();
  const buildGate = { mode: "honour-abort", entered: deferred(), ignoreRelease: deferred(), enteredCount: 0 };
  const sessions = new SessionService(db, {
    stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; },
    getPersistablePendingSnapshot: () => ({ texts: [], holds: {}, mintedAt: {} }), isComposerDirty: () => false,
  }, new OrchestrationControl(), {
    gateCancelVerifyMs: opts.gateCancelVerifyMs ?? 100,
    runGate: async () => ({ passed: true, steps: [] }),
    reapWorktreeProcesses: async (p) => { rec.reaps.push(p); return { killedPids: [] }; },
    distImporterCheckCreateWorktree: async (_repoPath, _projectId, taskId, _o, repoKey, sha) => {
      if (opts.cutHangs) { rec.cuts.push({ taskId, repoKey, sha }); cutEntered.resolve(); await new Promise(() => {}); } // a cut that never returns
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lm-dirp-wt-"));
      registerForCleanup(wt);
      rec.cutPaths.push(wt);
      rec.cuts.push({ taskId, repoKey, sha });
      return { worktreePath: wt, branch: `loom/dirp-${rec.cuts.length}` };
    },
    ...(opts.changedPaths ? { distImporterCheckChangedPaths: opts.changedPaths } : {}),
    distImporterCheckBuild: async (_wt, signal) => {
      rec.builds++;
      buildGate.enteredCount++;
      buildGate.entered.resolve();
      if (buildGate.mode === "ignore-abort") await buildGate.ignoreRelease.promise;
      else await new Promise((res) => { if (signal?.aborted) return res(); signal?.addEventListener("abort", () => res(), { once: true }); });
      return { ok: true };
    },
    distImporterCheckComputeRunSet: async (_wt, touched) => {
      rec.runSets.push([...touched]);
      return { ok: true, candidates: [{ path: "packages/daemon/test/a.mjs", touchedCount: 1 }], corpusSize: 4 };
    },
    distImporterCheckRemoveWorktree: async () => ({ removed: true, wedged: false, aborted: false }),
    distImporterCheckListCheckedOutBranches: async () => new Set(),
  });
  const origEnq = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (id, text, ctx) => { rec.nudges.push({ id, text }); return origEnq(id, text, ctx); };
  const cap = sessions.gateQueueForManager(P.projId).cap;
  /** A non-advisory occupant of a real semaphore slot, held until `release()`. */
  const hold = (gateType, extra = {}) => {
    const d = deferred();
    const state = { signal: null, started: deferred() };
    const run = sessions.gateSemaphore.runExclusive(cap, { gateType, projectId: P.projId, sessionId: P.mgrId, taskId: null, branch: null, opId: `${gateType}-op-${Math.random().toString(36).slice(2, 8)}`, ...extra },
      async (_s, signal) => { state.signal = signal; state.started.resolve(); await d.promise; return "ok"; }, "high").catch(() => "rejected");
    return { run, release: () => d.resolve(), state };
  };
  const advisoryEntries = () => sessions.gateSemaphore.snapshot().entries.filter((e) => e.distImporterCheckOnly);
  const kick = (sha, paths) => sessions.enqueueDistImporterCheck(P.projId, "primary", REPO, P.mgrId, sha, paths);
  /** The POST-LANDING kick (changed-paths git op included), as the merge path fires it. */
  const landing = (sha) => sessions.kickDistImporterCheck(P.projId, "primary", REPO, P.mgrId, sha);
  return { P, db, sessions, rec, buildGate, cutEntered, cap, hold, advisoryEntries, kick, landing };
}
const D = (m) => `packages/daemon/dist/${m}.js`;
/** Await a check's kick promise, but never hang the whole file when a regression starts an UNWANTED second
 *  run (whose build waits forever for an abort nobody sends): wait for "settled OR a second build entered",
 *  then abort anything still running so the later assertions still execute and the failure is NAMED. */
async function settleOrUnstick(e, p) {
  let done = false;
  void p.then(() => { done = true; });
  await waitUntil(() => done || e.rec.builds > 1, { label: "check loop settled (or an unwanted second run entered its build)", timeoutMs: 10_000 });
  e.sessions.gateSemaphore.snapshot().entries.forEach((x) => e.sessions.gateSemaphore.cancelRunning(x.id, "test unstick"));
  await p;
}

// ── (1) RUNNING advisory, abort honoured ─────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  const p1 = e.kick("a".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  void e.kick("b".repeat(40), [D("bar")]); // folded into the follow-up batch (returns at once)
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(5_000);
  check("(1) one advisory cancelled", pre.cancelled === 1);
  check("(1) none unverified (it honoured the abort)", pre.unverified.length === 0);
  check("(1) refire = ONE entry carrying the UNION of the running run + the folded landing's modules",
    pre.refire.length === 1 && pre.refire[0].projectId === e.P.projId && pre.refire[0].repoKey === "primary" && pre.refire[0].managerSessionId === e.P.mgrId
      && JSON.stringify(pre.refire[0].touchedDistPaths) === JSON.stringify([D("bar"), D("foo")]));
  await settleOrUnstick(e, p1); // the loop has fully settled — the witness for the negative assertions below
  check("(1) the folded follow-up was NOT drained into a new run (only the one build ever ran)", e.rec.builds === 1 && e.rec.cuts.length === 1);
  check("(1) no path-scoped reap fired (it settled within the bound)", e.rec.reaps.length === 0);
  check("(1) the manager got the cancelled nudge naming the restart", e.rec.nudges.some((x) => x.id === e.P.mgrId && /cancelled before it produced a result/.test(x.text) && /daemon restart/.test(x.text)));
  check("(1) gate queue is empty afterward", e.advisoryEntries().length === 0);
  e.sessions.resumeDistImporterChecks();
}

// ── (2) RUNNING advisory, abort not honoured within the bound ───────────────────────────────────────
{
  const e = mkEnv();
  e.buildGate.mode = "ignore-abort";
  const p1 = e.kick("c".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const opId = e.advisoryEntries()[0].opId;
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(150);
  check("(2) reported UNVERIFIED (named by 8-char opId prefix)", pre.cancelled === 1 && pre.unverified.length === 1 && pre.unverified[0] === opId.slice(0, 8));
  check("(2) strays reaped by THAT run's own RECORDED worktree path (the cut's), and only that path", e.rec.reaps.length === 1 && e.rec.reaps[0] === e.rec.cutPaths[0]);
  e.buildGate.ignoreRelease.resolve();
  await p1;
  check("(2) once released it exits cancelled without starting another run", e.rec.builds === 1 && e.advisoryEntries().length === 0);
  e.sessions.resumeDistImporterChecks();
}
{
  // (2b) still MID-CUT (no path recorded yet): falls back to the deterministic derived path, and only that.
  const e = mkEnv({ cutHangs: true });
  void e.kick("c2".repeat(20), [D("foo")]);
  await e.cutEntered.promise;
  const opId = e.advisoryEntries()[0].opId;
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(150);
  const derived = resolveWorktreePath(e.P.projId, `dist-importer-check-${opId}`, "primary");
  check("(2b) mid-cut: reported unverified and reaped by the DERIVED path only", pre.unverified.length === 1 && e.rec.reaps.length === 1 && e.rec.reaps[0] === derived);
  e.sessions.resumeDistImporterChecks();
}

// ── (3) QUEUED advisory behind a non-advisory holder ────────────────────────────────────────────────
{
  const e = mkEnv();
  const holders = [];
  for (let i = 0; i < e.cap; i++) { const h = e.hold("merge"); await h.state.started.promise; holders.push(h); }
  const p1 = e.kick("d".repeat(40), [D("foo")]);
  await waitUntil(() => e.advisoryEntries().some((x) => x.phase === "queued"), { label: "(3) advisory is queued behind the holders" });
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(2_000);
  check("(3) the queued advisory was cancelled", pre.cancelled === 1 && pre.unverified.length === 0);
  await p1;
  check("(3) it never reached a worktree cut (nothing spawned for a queued cancel)", e.rec.cuts.length === 0);
  check("(3) every non-advisory holder is untouched (signal not aborted, still running)", holders.every((h) => h.state.signal && !h.state.signal.aborted));
  check("(3) refire still carries its modules", pre.refire.length === 1 && pre.refire[0].touchedDistPaths[0] === D("foo"));
  holders.forEach((h) => h.release());
  await Promise.all(holders.map((h) => h.run));
  e.sessions.resumeDistImporterChecks();
}

// ── (4) non-advisory gates are never cancelled ──────────────────────────────────────────────────────
{
  const e = mkEnv();
  const w = e.hold("worker"); const m = e.hold("merge", { landingCheckOnly: false });
  await w.state.started.promise;
  if (e.cap > 1) await m.state.started.promise;
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(500);
  check("(4) nothing cancelled when only a worker self-check / merge op is live", pre.cancelled === 0 && pre.refire.length === 0);
  check("(4) neither signal was aborted", !w.state.signal.aborted && (e.cap < 2 || !m.state.signal.aborted));
  w.release(); m.release(); await Promise.all([w.run, m.run]);
  e.sessions.resumeDistImporterChecks();
}

// ── (5) persisted cap ───────────────────────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  const CAP = restart.DIST_IMPORTER_REFIRE_MAX_PATHS;
  const first = Array.from({ length: CAP }, (_, i) => D(`m${String(i).padStart(4, "0")}`));
  const folded = Array.from({ length: 25 }, (_, i) => D(`z${String(i).padStart(3, "0")}`));
  const p1 = e.kick("e".repeat(40), first);
  await e.buildGate.entered.promise;
  void e.kick("f".repeat(40), folded);
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(5_000);
  await settleOrUnstick(e, p1);
  const ent = pre.refire[0];
  check("(5) exactly the cap is kept", ent.touchedDistPaths.length === CAP);
  check("(5) the overflow count is REPORTED, not silently dropped (25 over the cap)", ent.droppedPathCount === 25);
  e.sessions.resumeDistImporterChecks();
}

// ── (6) requestDaemonRestart end to end ─────────────────────────────────────────────────────────────
const restartDeps = (extra = {}) => ({
  buildDeps: { runStep: async () => ({ code: 0, out: "" }) },
  exit: () => {}, isSupervisorAlive: async () => ({ alive: true }),
  armHardShutdownWatchdog: () => ({ step() {}, disarm() {} }), advisoryPreemptVerifyMs: 5_000, mergeDangerGraceMs: 50, ...extra,
});
{
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("1".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  // The default cap is 1, so this merge op QUEUES behind the running advisory; it is admitted only once the
  // restart's pre-empt frees the slot — which is exactly the point (it is real work the restart must not abort).
  const merge = e.hold("merge");
  await waitUntil(() => e.sessions.gateSemaphore.snapshot().entries.some((x) => x.gateType === "merge"), { label: "(6) the merge op is registered (queued behind the advisory)" });
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "deploy c9a21e8f fixture", restartDeps());
  check("(6) restart proceeded", res.restarting === true);
  check("(6) result reports the pre-empt", res.advisoryPreempt?.cancelled === 1 && res.advisoryPreempt?.refireQueued === 1 && res.advisoryCancelUnverified === undefined);
  const intent = restart.readRestartIntent();
  check("(6) the restart intent carries ONE refire entry with the carried modules",
    Array.isArray(intent?.distImporterRefire) && intent.distImporterRefire.length === 1 && intent.distImporterRefire[0].touchedDistPaths[0] === D("foo") && intent.distImporterRefire[0].managerSessionId === e.P.mgrId);
  await p1;
  await merge.state.started.promise; // admitted into the slot the advisory vacated
  check("(6) the advisory is gone and the concurrent MERGE op was left running, un-aborted", e.advisoryEntries().length === 0 && merge.state.signal && !merge.state.signal.aborted
    && e.sessions.gateQueueForManager(e.P.projId).running.some((x) => x.gateType === "merge"));
  restart.clearRestartIntent();
  merge.release(); await merge.run;
  delete process.env.LOOM_SUPERVISED;
}
{
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "deploy with no advisory", restartDeps());
  const intent = restart.readRestartIntent();
  check("(6) NO advisory live: restart proceeds, no refire field, no advisoryPreempt in the result",
    res.restarting === true && intent && intent.distImporterRefire === undefined && res.advisoryPreempt === undefined);
  restart.clearRestartIntent();
  delete process.env.LOOM_SUPERVISED;
}
{
  // (6b) refused AFTER the pre-empt (the recheck says the supervisor is gone): nothing will exit, so it re-fires in-process.
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("2".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  let calls = 0;
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "deploy that gets refused", restartDeps({ isSupervisorAlive: async () => ({ alive: ++calls < 2, reason: "gone" }) }));
  // NOT awaiting p1 yet: the in-process re-fire may coalesce into run 1's own still-draining loop (one check
  // either way), so p1 only settles once the RE-FIRED run is also stopped below.
  check("(6b) restart was refused at the recheck", res.restarting === false);
  await waitUntil(() => e.rec.builds === 2, { label: "(6b) the cancelled advisory re-fired in-process (a second build entered)" });
  check("(6b) the re-fire was cut at the CURRENT HEAD", e.rec.cuts.length === 2 && e.rec.cuts[1].sha === headOf());
  check("(6b) no restart intent was left behind", restart.readRestartIntent() === null);
  e.buildGate.mode = "honour-abort";
  await e.sessions.preemptAdvisoryDistImporterChecks(2_000); // stop the re-fired run so the test can exit cleanly
  await p1;
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}

// ── (7) refire ──────────────────────────────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  e.buildGate.mode = "ignore-abort"; // the build returns only when released, then the run reaches its run-set step
  const head = headOf();
  const { started, done } = await e.sessions.refireDistImporterChecks([
    { projectId: e.P.projId, repoKey: "primary", managerSessionId: e.P.mgrId, touchedDistPaths: [D("foo"), D("bar")], droppedPathCount: 7 },
  ]);
  await e.buildGate.entered.promise;
  check("(7) one check started for the one carried entry", started === 1);
  check("(7) cut at the CURRENT mainline HEAD", e.rec.cuts.length === 1 && e.rec.cuts[0].sha === head);
  e.buildGate.ignoreRelease.resolve();
  await done;
  check("(7) the run set was computed from the carried modules", JSON.stringify(e.rec.runSets[0]) === JSON.stringify([D("foo"), D("bar")]));
  check("(7) a dropped-count entry tells the manager the re-check is PARTIAL", e.rec.nudges.some((x) => x.id === e.P.mgrId && /7 more exceeded/.test(x.text) && /NOT covered/.test(x.text)));
  const none = await e.sessions.refireDistImporterChecks([]);
  check("(7) refire of an empty list starts nothing", none.started === 0);
}

// ── (8) coalescing: ONE follow-up at the newest sha with the union ──────────────────────────────────
{
  const e = mkEnv();
  const shaA = "a1".repeat(20), shaB = "b2".repeat(20), shaC = "c3".repeat(20);
  const p1 = e.kick(shaA, [D("foo")]);
  await e.buildGate.entered.promise;
  void e.kick(shaB, [D("bar")]);
  void e.kick(shaC, [D("baz"), D("bar")]);
  e.sessions.gateSemaphore.snapshot().entries.forEach((x) => e.sessions.gateSemaphore.cancelRunning(x.id, "let run 1 end")); // run 1 exits; the loop drains the follow-up
  await waitUntil(() => e.rec.builds === 2, { label: "(8) the single follow-up run entered its build" });
  check("(8) exactly one follow-up, cut at the NEWEST landing's sha", e.rec.cuts.length === 2 && e.rec.cuts[1].sha === shaC);
  e.sessions.gateSemaphore.snapshot().entries.forEach((x) => e.sessions.gateSemaphore.cancelRunning(x.id, "let run 2 end"));
  await p1;
  check("(8) never a run per landing: three landings => two runs total", e.rec.builds === 2);
}
{
  // (8b) the follow-up's touched set — asserted on a run that actually reaches computeRunSet (build returns, not aborted)
  const e = mkEnv();
  e.buildGate.mode = "ignore-abort";
  const shaA = "a1".repeat(20), shaC = "c3".repeat(20);
  const p1 = e.kick(shaA, [D("foo")]);
  await e.buildGate.entered.promise;
  void e.kick("b2".repeat(20), [D("bar")]);
  void e.kick(shaC, [D("baz"), D("bar")]);
  e.buildGate.ignoreRelease.resolve(); // every build now returns at once
  await p1;
  check("(8b) two run sets: landing A alone, then the union of B+C deduped",
    e.rec.runSets.length === 2 && JSON.stringify(e.rec.runSets[0]) === JSON.stringify([D("foo")]) && JSON.stringify([...e.rec.runSets[1]].sort()) === JSON.stringify([D("bar"), D("baz")]));
}

// ── (9) gate_queue restartSafe ──────────────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  check("(9) empty queue => restartSafe true", e.sessions.gateQueueForManager(e.P.projId).restartSafe === true);
  const p1 = e.kick("9".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const q1 = e.sessions.gateQueueForManager(e.P.projId);
  check("(9) an advisory-only queue => restartSafe true (the advisory is still listed)", q1.restartSafe === true && q1.running.some((x) => x.distImporterCheckOnly === true));
  const w = e.hold("worker"); // QUEUED behind the running advisory (default cap 1) — a queued real op counts too
  await waitUntil(() => e.sessions.gateSemaphore.snapshot().entries.some((x) => !x.distImporterCheckOnly), { label: "(9) the worker self-check is registered" });
  check("(9) advisory running + a QUEUED worker self-check => restartSafe false", e.sessions.gateQueueForManager(e.P.projId).restartSafe === false);
  e.sessions.gateSemaphore.snapshot().entries.filter((x) => x.distImporterCheckOnly).forEach((x) => e.sessions.gateSemaphore.cancelRunning(x.id, "free the slot"));
  await p1;
  await w.state.started.promise;
  check("(9) the worker self-check alone, running => restartSafe false", e.sessions.gateQueueForManager(e.P.projId).restartSafe === false);
  w.release(); await w.run;
  const lc = e.hold("worker", { landingCheckOnly: true }); await lc.state.started.promise;
  check("(9) + a landing-check (NOT an advisory) => restartSafe false", e.sessions.gateQueueForManager(e.P.projId).restartSafe === false);
  lc.release(); await lc.run;
  const m = e.hold("merge"); await m.state.started.promise;
  check("(9) + a merge op => restartSafe false", e.sessions.gateQueueForManager(e.P.projId).restartSafe === false);
  m.release(); await m.run;
}

// ── (9b) restartSafe: the conjuncts the queue snapshot alone cannot see / that (9) left untested ─────
{
  const e = mkEnv();
  const mgr = e.P.mgrId;
  // A merge confirm still in its pre-admission prep: registered in pendingOps, NOT in the semaphore yet.
  const d1 = deferred();
  const mergePrep = e.sessions.pendingOps.attach("merge:prep-fixture", "merge", mgr, 20, async () => { await d1.promise; return "x"; }, undefined, {}, undefined);
  check("(9b) the prep fixture is NOT visible in the semaphore snapshot", e.sessions.gateSemaphore.snapshot().entries.length === 0);
  check("(9b) a merge op in pre-admission prep => restartSafe false", e.sessions.gateQueueForManager(e.P.projId).restartSafe === false);
  d1.resolve(); await mergePrep;
  check("(9b) control: once that merge op settled => restartSafe true again", e.sessions.gateQueueForManager(e.P.projId).restartSafe === true);
  const rel = await e.sessions.gateSemaphore.acquireRepoGuardOnly({ repoPath: "/tmp/dirp-rgo/repo", projectId: e.P.projId, sessionId: mgr, taskId: null, branch: null, opId: "dirp-rgo-op" });
  const q1 = e.sessions.gateQueueForManager(e.P.projId);
  check("(9b) a repo-guard-only holder => restartSafe false", q1.repoGuardOnly.length === 1 && q1.restartSafe === false);
  rel();
  await e.sessions.gateSemaphore.runExclusive(1, { gateType: "merge", projectId: e.P.projId, sessionId: mgr, taskId: null, branch: null, repoPath: "/tmp/dirp-sq/repo", opId: "dirp-sq-op" },
    async (_s, _c, _h, _m, holdRepoGuardOnExit) => { holdRepoGuardOnExit(); return "g"; });
  const q2 = e.sessions.gateQueueForManager(e.P.projId);
  check("(9b) a merge mid-squash (past its gate, only the repo guard held) => restartSafe false", q2.squashing.length === 1 && q2.restartSafe === false);
  e.sessions.gateSemaphore.endSquash("/tmp/dirp-sq/repo", "dirp-sq-op");
  // A merge parked pre-admission on its worker's self-check: the self-check is a live `gate` pending op.
  const d2 = deferred();
  const selfCheck = e.sessions.pendingOps.attach(`gate:${mgr}`, "gate", mgr, 20, async () => { await d2.promise; return "x"; }, undefined, {}, undefined);
  e.sessions.parkedMergeWaits.set("dirp-parked-merge", { sessionId: mgr, projectId: e.P.projId, taskId: null, branch: null, since: Date.now(), cancel: () => false });
  const q3 = e.sessions.gateQueueForManager(e.P.projId);
  check("(9b) a merge parked on its worker's self-check => restartSafe false", q3.waitingOnSelfCheck.length === 1 && q3.restartSafe === false);
  e.sessions.parkedMergeWaits.delete("dirp-parked-merge");
  d2.resolve(); await selfCheck;
  check("(9b) everything released => restartSafe true", e.sessions.gateQueueForManager(e.P.projId).restartSafe === true);
}

// ── (12) a landing that ARRIVES DURING the pause is folded into the refire set, never dropped ────────
{
  const e = mkEnv();
  const p1 = e.kick("a".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(5_000);
  await settleOrUnstick(e, p1);
  const buildsBefore = e.rec.builds;
  await e.kick("b".repeat(40), [D("late")]); // arrives while paused
  check("(12) a paused arrival starts no check", e.rec.builds === buildsBefore && e.advisoryEntries().length === 0);
  const merged = e.sessions.mergePausedDistImporterArrivals(pre.refire);
  check("(12) the merged refire carries BOTH the cancelled run's module and the late arrival's (one entry)",
    merged.length === 1 && JSON.stringify(merged[0].touchedDistPaths) === JSON.stringify([D("foo"), D("late")]));
  const sealed = e.sessions.mergePausedDistImporterArrivals(merged, true);
  e.rec.nudges.length = 0;
  await e.kick("c".repeat(40), [D("verylate")]);
  const after = e.sessions.mergePausedDistImporterArrivals(sealed);
  check("(12) after the list is SEALED an arrival is not carried...", !after[0].touchedDistPaths.includes(D("verylate")));
  check("(12) ...but is never silent: the manager is nudged naming the uncovered sha", e.rec.nudges.some((x) => x.id === e.P.mgrId && /cccccccc/.test(x.text) && /NOT covered/.test(x.text)));
  e.sessions.resumeDistImporterChecks();
}
{
  // (12b) end to end: one arrival between the pre-empt and the intent write, one between the intent write and the
  // exit. The boot refire (the intent file) must contain BOTH.
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("1".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const origFleet = e.sessions.liveFleetResumeSet.bind(e.sessions);
  e.sessions.liveFleetResumeSet = () => { void e.kick("2".repeat(40), [D("beforeIntent")]); return origFleet(); };
  let calls = 0;
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "arrivals during the pause", restartDeps({
    isSupervisorAlive: async () => { if (++calls === 2) void e.kick("3".repeat(40), [D("afterIntent")]); return { alive: true }; },
  }));
  await p1;
  const intent = restart.readRestartIntent();
  const got = intent?.distImporterRefire?.[0]?.touchedDistPaths ?? [];
  check("(12b) restart proceeded", res.restarting === true);
  check("(12b) the intent's refire covers the original, the pre-intent arrival AND the post-intent arrival",
    JSON.stringify([...got].sort()) === JSON.stringify([D("afterIntent"), D("beforeIntent"), D("foo")]));
  restart.clearRestartIntent();
  delete process.env.LOOM_SUPERVISED;
}
{
  // (12c) refused at the recheck: the IN-PROCESS refire must include the arrival too.
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("4".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const origFleet = e.sessions.liveFleetResumeSet.bind(e.sessions);
  e.sessions.liveFleetResumeSet = () => { e.buildGate.mode = "ignore-abort"; void e.kick("5".repeat(40), [D("late")]); return origFleet(); };
  let calls = 0;
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "refused after arrivals", restartDeps({ isSupervisorAlive: async () => ({ alive: ++calls < 2, reason: "gone" }) }));
  check("(12c) restart was refused at the recheck", res.restarting === false);
  await waitUntil(() => e.rec.builds === 2, { label: "(12c) the in-process refire entered its build" });
  e.buildGate.ignoreRelease.resolve();
  await p1;
  await waitUntil(() => e.rec.runSets.length >= 1, { label: "(12c) the refired run computed its run set" });
  check("(12c) the refired run covers the original module AND the paused arrival", e.rec.runSets.some((s) => s.includes(D("foo")) && s.includes(D("late"))));
  check("(12c) no restart intent left behind", restart.readRestartIntent() === null);
  delete process.env.LOOM_SUPERVISED;
}

// ── (13) a THROW after the pre-empt: the catch-all refires in-process, and clears an already-written intent ──
{
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("6".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  e.sessions.liveFleetResumeSet = () => { throw new Error("boom before the intent write"); };
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "throws before the intent", restartDeps());
  check("(13) a throw after the pre-empt => restarting:false with the unexpected-failure error", res.restarting === false && /failed unexpectedly/.test(res.error ?? ""));
  await waitUntil(() => e.rec.builds === 2, { label: "(13) the catch-all re-fired the cancelled advisory in-process" });
  check("(13) no intent exists", restart.readRestartIntent() === null);
  e.buildGate.mode = "honour-abort";
  await e.sessions.preemptAdvisoryDistImporterChecks(2_000);
  await p1;
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}
{
  // (13b) the throw lands AFTER the intent was written (the second supervisor check throws): the intent MUST be cleared,
  // or a later crash-boot would re-fire from it a second time.
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const p1 = e.kick("7".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  let calls = 0;
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "throws after the intent", restartDeps({
    isSupervisorAlive: async () => { if (++calls === 2) throw new Error("boom after the intent write"); return { alive: true }; },
  }));
  check("(13b) restarting:false", res.restarting === false);
  check("(13b) the already-written restart intent was CLEARED by the catch-all", restart.readRestartIntent() === null);
  await waitUntil(() => e.rec.builds === 2, { label: "(13b) re-fired in-process (second build entered)" });
  e.buildGate.mode = "honour-abort";
  await e.sessions.preemptAdvisoryDistImporterChecks(2_000);
  await p1;
  check("(13b) re-fired exactly once: the re-fire settled (cancelled) and the total build count is still 2", e.rec.builds === 2);
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}

// ── (14) a post-landing kick whose changed-paths git op is still PENDING across the seal is never silent ──
{
  // (14a) the git op resolves inside the seal's bounded wait: the landing is CARRIED in the intent, no nudge.
  process.env.LOOM_SUPERVISED = "1";
  const held = deferred();
  const e = mkEnv({ changedPaths: async () => held.promise });
  const kicked = e.landing("8".repeat(40)); // fire-and-forget at the merge path: registered before its first await
  const origSettle = e.sessions.settleInFlightDistImporterKicks.bind(e.sessions);
  e.sessions.settleInFlightDistImporterKicks = (ms) => { const p = origSettle(ms); setImmediate(() => held.resolve([D("inflight").replace(/dist\/(.*)\.js$/, "src/$1.ts")])); return p; };
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "kick pending across the seal", restartDeps({ distImporterKickSettleMs: 5_000 }));
  await kicked;
  const got = restart.readRestartIntent()?.distImporterRefire?.[0]?.touchedDistPaths ?? [];
  check("(14a) restart proceeded", res.restarting === true);
  check("(14a) the in-flight kick resolved during the seal wait is CARRIED in the intent", got.includes(D("inflight")));
  check("(14a) ...and no 'NOT covered' nudge was needed", !e.rec.nudges.some((x) => /NOT covered/.test(x.text)));
  restart.clearRestartIntent();
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}
{
  // (14b) the git op stays pending past the bound: the manager is nudged by name AT THE SEAL, and the late kick stays quiet.
  process.env.LOOM_SUPERVISED = "1";
  const held = deferred();
  const e = mkEnv({ changedPaths: async () => held.promise });
  const kicked = e.landing("9".repeat(40));
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "kick never resolves in time", restartDeps({ distImporterKickSettleMs: 50 }));
  check("(14b) restart proceeded", res.restarting === true);
  const nudgedAtSeal = e.rec.nudges.filter((x) => x.id === e.P.mgrId && /99999999/.test(x.text) && /NOT covered/.test(x.text)).length;
  check("(14b) the unresolved kick is nudged by name before the restart exits (exactly once)", nudgedAtSeal === 1);
  check("(14b) ...and is not in the intent's refire", !(restart.readRestartIntent()?.distImporterRefire ?? []).some((r) => r.touchedDistPaths.includes(D("late"))));
  held.resolve(["packages/daemon/src/late.ts"]);
  await kicked;
  check("(14b) the late-resolving kick adds no second nudge and starts no check",
    e.rec.nudges.filter((x) => /99999999/.test(x.text)).length === 1 && e.rec.builds === 0);
  restart.clearRestartIntent();
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}

// ── (15) the paused-arrival merge is idempotent: overflow is counted once, from the immutable pre-empt base ──
{
  process.env.LOOM_SUPERVISED = "1";
  const e = mkEnv();
  const many = Array.from({ length: 600 }, (_, i) => D(`m${String(i).padStart(4, "0")}`));
  const origFleet = e.sessions.liveFleetResumeSet.bind(e.sessions);
  e.sessions.liveFleetResumeSet = () => { void e.kick("a1".repeat(20), many); return origFleet(); };
  let calls = 0;
  const res = await e.sessions.requestDaemonRestart(e.P.mgrId, "over-cap arrival merged twice", restartDeps({
    isSupervisorAlive: async () => { if (++calls === 2) void e.kick("b2".repeat(20), [D("zextra")]); return { alive: true }; }, // forces the seal to merge a SECOND time and rewrite the intent
  }));
  const ent = restart.readRestartIntent()?.distImporterRefire?.[0];
  check("(15) restart proceeded", res.restarting === true);
  check("(15) the cap is kept", ent?.touchedDistPaths.length === 500);
  check("(15) the overflow (601 unique - 500 kept = 101) is reported ONCE, not re-counted by the second merge", ent?.droppedPathCount === 101);
  restart.clearRestartIntent();
  e.sessions.resumeDistImporterChecks();
  delete process.env.LOOM_SUPERVISED;
}

// ── (10) gate_cancel outcome on a RUNNING advisory not confirmed gone ───────────────────────────────
{
  const e = mkEnv({ gateCancelVerifyMs: 100 });
  e.buildGate.mode = "ignore-abort";
  const p1 = e.kick("7".repeat(40), [D("foo")]);
  await e.buildGate.entered.promise;
  const opId = e.advisoryEntries()[0].opId;
  const r = await e.sessions.cancelGateOp(e.P.mgrId, opId, { scope: { kind: "project" } });
  check("(10) advisory: outcome is the DISTINCT cancel_signalled", r.outcome === "cancel_signalled" && r.opId === opId);
  check("(10) its reason names the phase boundary and does NOT claim the kill failed", /exits at its next phase boundary/.test(r.reason) && !/kill issued but the process tree was not verified dead/.test(r.reason));
  e.buildGate.ignoreRelease.resolve(); await p1;
  // control: a NON-advisory run (a landing-check: worker-kind, landingCheckOnly) that also ignores the abort keeps `not_cancelled`
  const stuck = deferred();
  const w = e.sessions.gateSemaphore.runExclusive(e.cap, { gateType: "worker", projectId: e.P.projId, sessionId: e.P.mgrId, taskId: null, branch: null, opId: "landchk-op-ctl", landingCheckOnly: true },
    async () => { await stuck.promise; return "ok"; }, "high").catch(() => "rejected");
  await waitUntil(() => e.sessions.gateSemaphore.snapshot().entries.some((x) => x.opId === "landchk-op-ctl" && x.phase === "running"), { label: "(10) control landing-check admitted" });
  const r2 = await e.sessions.cancelGateOp(e.P.mgrId, "landchk-op-ctl", { scope: { kind: "project" } });
  check("(10) control: a non-advisory run that ignores the abort stays `not_cancelled`", r2.outcome === "not_cancelled");
  stuck.resolve(); await w;
}

// ── (11) boot wiring (TEXT check — presence only, not behaviour) ────────────────────────────────────
{
  const raw = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // Comments stripped first (a comment can carry either token, or push the real calls apart); anchored on code tokens.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const sweepAt = code.indexOf("await sessions.sweepOrphanedDistImporterCheckWorktrees(");
  const guardAt = code.indexOf("if (restartIntent?.distImporterRefire?.length)");
  const refireAt = code.indexOf("await sessions.refireDistImporterChecks(restartIntent.distImporterRefire)");
  check("(11) index.ts boot: the sweep call, the intent-field guard and the refire call all exist as CODE, in that order",
    sweepAt >= 0 && guardAt > sweepAt && refireAt > guardAt);
  check("(11) ...and the refire sits within ONE brace-balanced region after the guard (not a distant unrelated call)",
    (() => { if (!(guardAt > 0 && refireAt > guardAt)) return false; const seg = code.slice(guardAt, refireAt); let d = 0; for (const c of seg) { if (c === "{") d++; else if (c === "}") d--; if (d < 0) return false; } return d >= 1; })());
  check("(11) negative control: a comment-only mention does NOT count as the wiring",
    "// await sessions.refireDistImporterChecks(restartIntent.distImporterRefire)".replace(/(^|[^:"'`])\/\/.*$/gm, "$1").indexOf("refireDistImporterChecks") === -1);
}

for (const db of dbs) { try { db.close?.(); } catch { /* best-effort */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
