import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A merge gate admitted for a repo supersedes that repo's QUEUED advisory dist-importer checks, and the superseded
// landing is only dropped once the MERGE CALLER reports coverage (a full-gate pass that landed; the real-path cases live in
// dist-importer-supersede-coverage.mjs). Here the caller is simulated through the two SessionService methods it uses
// (reportAdvisoryCoverage / settleSupersededAdvisories); the semaphore itself never decides. Real GateSemaphore and real
// SessionService; only the check's own cut/build/run-set/remove steps are stubbed (the distImporterCheck* seams, as in
// dist-importer-restart-preempt.mjs). Every await on a promise this file does not control is bounded (`bounded`), so a
// regression goes RED on a NAMED line instead of hanging.
//
//   (1) coverage reported: queued advisory + admitted merge on the SAME repo => advisory withdrawn (never cut/built), recorded
//       as superseded (event, no failure nudge, ONE superseded nudge), and once coverage is reported nothing re-runs.
//   (2) no coverage reported (gate failed / threw / cancelled): the advisory re-runs EXACTLY once at the superseded sha,
//       covering the superseded landing's modules.
//   (3) a DIFFERENT repo's merge leaves the queued advisory alone.
//   (4) a RUNNING advisory is untouched (signal not aborted).
//   (5) no gate => no skip: a repo-guard-only hold, a worker gate, a deploy gate and a batch-fallback merge on the same repo
//       never supersede.
//   (6) Windows casing/slashes: the helper folds them on win32 only; the live comparison is exercised with a mixed-case,
//       backslash pair on win32.
//   (7) before/after admission split: a landing folded BEFORE admission rides the superseded set; one arriving AFTER drains
//       normally (its own run covers only its modules).
//   (8) a restart pre-empt while a gate holds superseded advisories folds them into the refire set and empties the map, so a
//       later gate fail cannot also re-run them.
//   (9) the advisory carries NO repoPath (stays out of the per-repo guard) and the snapshot never echoes advisoryRepoPath.
//
// Run: 1) build (pnpm build), 2) node test/dist-importer-supersede.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `lm-disup-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
delete process.env.LOOM_SUPERVISED;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { normalizeRepoPathForCompare } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
/** Await a promise this test does not control, but fail on a NAMED line (and exit) instead of hanging if it never settles. */
async function bounded(p, label, timeoutMs = 15_000) {
  const s = { done: false };
  p.then(() => { s.done = true; }, () => { s.done = true; });
  try { await waitUntil(() => s.done, { label, timeoutMs }); }
  catch { console.log(`FAIL  ${label} (did not settle within ${timeoutMs}ms)`); process.exit(1); }
  return p;
}
/** Lazily-bounded thenable: the bound starts when the promise is AWAITED, not when it is created. */
const lb = (p, label) => ({ then: (res, rej) => bounded(p, label).then(res, rej) });
const GIT_ID = "-c user.email=disup@loom -c user.name=disup";
const now = new Date().toISOString();
const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const REPO = path.join(os.tmpdir(), `lm-disup-repo-${sfx}`);
registerForCleanup(REPO);
fs.mkdirSync(REPO, { recursive: true });
fs.writeFileSync(path.join(REPO, "README.md"), "# disup\n");
execSync("git init -q -b main", { cwd: REPO });
commitAll(REPO, "init", GIT_ID);
const OTHER_REPO = path.join(os.tmpdir(), `lm-disup-other-${sfx}`);

const dbs = [];
let n = 0;
function mkEnv() {
  n++;
  const P = { projId: `disup-p${n}-${sfx}`, agentId: `disup-a${n}-${sfx}`, mgrId: `disup-m${n}-${sfx}` };
  const db = new Db(path.join(os.tmpdir(), `lm-disup-db${n}-${sfx}.db`)); dbs.push(db);
  db.insertProject({ id: P.projId, name: "DISUP", repoPath: REPO, vaultPath: REPO, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const rec = { cuts: [], builds: 0, nudges: [] };
  const sessions = new SessionService(db, {
    stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; },
    getPersistablePendingSnapshot: () => ({ texts: [], holds: {}, mintedAt: {} }), isComposerDirty: () => false,
  }, new OrchestrationControl(), {
    gateCancelVerifyMs: 100,
    runGate: async () => ({ passed: true, steps: [] }),
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    distImporterCheckCreateWorktree: async (_r, _p, taskId, _o, repoKey, sha) => {
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lm-disup-wt-"));
      registerForCleanup(wt);
      rec.cuts.push({ taskId, repoKey, sha });
      return { worktreePath: wt, branch: `loom/disup-${rec.cuts.length}` };
    },
    distImporterCheckBuild: async (_wt, signal) => {
      rec.builds++;
      await new Promise((res) => { if (signal?.aborted) return res(); signal?.addEventListener("abort", () => res(), { once: true }); });
      return { ok: true };
    },
    distImporterCheckComputeRunSet: async () => ({ ok: true, candidates: [{ path: "packages/daemon/test/a.mjs", touchedCount: 1 }], corpusSize: 4 }),
    distImporterCheckRemoveWorktree: async () => ({ removed: true, wedged: false, aborted: false }),
    distImporterCheckListCheckedOutBranches: async () => new Set(),
  });
  const origEnq = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (id, text, ctx) => { rec.nudges.push({ id, text }); return origEnq(id, text, ctx); };
  const cap = sessions.gateQueueForManager(P.projId).cap;
  const sem = sessions.gateSemaphore;
  const hold = (gateType, extra = {}) => {
    const d = deferred();
    const state = { signal: null, started: deferred() };
    const run = sem.runExclusive(cap, { gateType, projectId: P.projId, sessionId: P.mgrId, taskId: null, branch: null, opId: `${gateType}-op-${Math.random().toString(36).slice(2, 8)}`, ...extra },
      async (_s, signal) => { state.signal = signal; state.started.resolve(); await d.promise; return "ok"; }, "high").catch(() => "rejected");
    return { run: lb(run, "holder settled"), release: () => d.resolve(), state: { get signal() { return state.signal; }, started: { promise: lb(state.started.promise, "holder admitted") } } };
  };
  /** A gate whose body the test controls: resolves with `outcome()` once `finish()` is called. */
  const gate = (gateType, repoPath, extra = {}, capArg = cap) => {
    const fin = deferred(); const started = deferred();
    const opId = `${gateType}-g-${Math.random().toString(36).slice(2, 8)}`;
    let mode = "pass";
    const run = sem.runExclusive(capArg, { gateType, projectId: P.projId, sessionId: P.mgrId, taskId: null, branch: null, opId, repoPath, ...extra },
      async () => {
        started.resolve(); await fin.promise;
        if (mode === "throw") throw new Error("gate boom");
        if (mode === "fail") return { passed: false, steps: [] };
        if (mode === "no-passed") return { steps: [] };
        if (mode === "cancelled") return { passed: true, cancelled: true, steps: [] };
        return { passed: true, steps: [] };
      }, "high").then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));
    return {
      run: lb(run, `gate ${opId} settled`), started: { promise: lb(started.promise, `gate ${opId} admitted`) }, opId,
      finish: (m = "pass") => { mode = m; fin.resolve(); },
      /** The simulated MERGE CALLER: report coverage (or not), then settle — exactly what the real merge path does on exit. */
      settle: (covered) => { if (covered) sessions.reportAdvisoryCoverage(opId); sessions.settleSupersededAdvisories(opId); },
    };
  };
  const advisoryEntries = () => sem.snapshot().entries.filter((x) => x.distImporterCheckOnly);
  const kick = (sha, paths) => lb(sessions.enqueueDistImporterCheck(P.projId, "primary", REPO, P.mgrId, sha, paths), `advisory check ${sha.slice(0, 4)} settled`);
  const events = () => db.listEvents(P.mgrId).filter((x) => x.kind === "worker_gate" && x.detail?.distImporterCheckOnly === true);
  /** Saturate the cap, queue ONE advisory behind it, and queue a merge gate (same repo) that outranks it. */
  async function queueAdvisoryAndMerge(sha, paths, mergeRepo = REPO, mergeExtra = {}, gateType = "merge") {
    const holders = [];
    for (let i = 0; i < cap; i++) { const h = hold("deploy"); await h.state.started.promise; holders.push(h); }
    const advisoryDone = kick(sha, paths);
    await waitUntil(() => advisoryEntries().some((x) => x.phase === "queued"), { label: "advisory queued behind the holders" });
    const g = gate(gateType, mergeRepo, mergeExtra);
    await waitUntil(() => sem.snapshot().entries.some((x) => x.opId === g.opId && x.phase === "queued"), { label: "merge queued behind the holders" });
    return { holders, advisoryDone, g };
  }
  const drain = async (holders) => { holders.forEach((h) => h.release()); await Promise.all(holders.map((h) => h.run)); };
  const cancelAdvisories = () => advisoryEntries().forEach((x) => { if (x.phase === "running") sem.cancelRunning(x.id, "test cleanup"); else sem.cancelQueued(x.id, "manual", "test cleanup"); });
  return { P, db, sessions, sem, rec, cap, hold, gate, advisoryEntries, kick, events, queueAdvisoryAndMerge, drain, cancelAdvisories };
}
const D = (m) => `packages/daemon/dist/${m}.js`;
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);

// ── (1) PASS: superseded, recorded quietly, nothing re-runs ─────────────────────────────────────────
{
  const e = mkEnv();
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")]);
  holders[0].release();
  await g.started.promise;
  await advisoryDone;
  check("(1) the queued advisory left the queue the moment the merge was admitted", e.advisoryEntries().length === 0);
  check("(1) it never reached a worktree cut or build", e.rec.cuts.length === 0 && e.rec.builds === 0);
  const ev = e.events();
  check("(1) recorded as SUPERSEDED (cancelled:true, superseded:true, names the superseding op), never a failure",
    ev.length === 1 && ev[0].detail.cancelled === true && ev[0].detail.superseded === true && ev[0].detail.supersededByOpId === g.opId && ev[0].detail.gateSpawned === false && ev[0].detail.mechanismLike !== true && ev[0].detail.passed !== false);
  const mine = e.rec.nudges.filter((x) => x.id === e.P.mgrId);
  check("(1) exactly ONE nudge, the superseded one, naming sha8 and the gate opId8; no cancelled/failure nudge",
    mine.length === 1 && mine[0].text.includes(`advisory check for ${A.slice(0, 8)} superseded by full gate ${g.opId.slice(0, 8)}`) && /re-runs only if that gate does not pass/.test(mine[0].text) && !/cancelled before it produced|could not run|FAILED/i.test(mine[0].text));
  check("(1) the landing is held against the superseding op while it runs", e.sessions.supersededAdvisories.get(g.opId)?.size === 1);
  g.finish("pass");
  const r = await g.run;
  check("(1) the gate passed", r.ok && r.v.passed === true);
  check("(1) a gate PASS alone drops nothing: the landing stays held until the merge CALLER settles it", e.sessions.supersededAdvisories.get(g.opId)?.size === 1 && e.advisoryEntries().length === 0);
  g.settle(true);
  check("(1) coverage reported => PASS drops the superseded landing: map empty and NO advisory entered the queue (synchronous witness: the re-enqueue would register inside the same finally)",
    e.sessions.supersededAdvisories.size === 0 && e.advisoryEntries().length === 0 && e.rec.cuts.length === 0);
  await e.drain(holders.slice(1).concat([holders[0]]));
}

// ── (2) no coverage reported => the advisory re-runs EXACTLY once at the superseded sha ──────────────
for (const mode of ["fail", "throw", "cancelled", "pass"]) {
  const e = mkEnv();
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo"), D("bar")]);
  holders[0].release();
  await g.started.promise;
  await advisoryDone;
  g.finish(mode);
  await g.run;
  g.settle(false); // "pass" included: a gate PASS the caller did not vouch for (reduced / not landed) is NOT coverage
  await waitUntil(() => e.rec.builds === 1, { label: `(2:${mode}) the superseded advisory re-ran` });
  check(`(2:${mode}) it re-ran exactly once, at the superseded sha`, e.rec.cuts.length === 1 && e.rec.cuts[0].sha === A);
  const run = [...e.sessions.activeDistImporterRuns.values()][0];
  check(`(2:${mode}) ...covering the superseded landing's modules`, JSON.stringify([...run.touchedDistPaths].sort()) === JSON.stringify([D("bar"), D("foo")]));
  check(`(2:${mode}) the map is empty (re-enqueued once, not held again)`, e.sessions.supersededAdvisories.size === 0 && e.advisoryEntries().length === 1);
  e.cancelAdvisories();
  await waitUntil(() => e.advisoryEntries().length === 0, { label: `(2:${mode}) re-run cleaned up` });
  check(`(2:${mode}) and nothing ran a second time`, e.rec.cuts.length === 1);
  await e.drain(holders);
}

// ── (3) a different repo is untouched ───────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")], OTHER_REPO);
  holders[0].release();
  await g.started.promise;
  check("(3) a merge admitted on ANOTHER repo leaves the queued advisory queued", e.advisoryEntries().length === 1 && e.advisoryEntries()[0].phase === "queued");
  check("(3) nothing recorded, nothing held", e.events().length === 0 && e.sessions.supersededAdvisories.size === 0);
  g.finish("pass"); await g.run;
  e.cancelAdvisories(); await advisoryDone;
  await e.drain(holders);
}

// ── (4) a RUNNING advisory is untouched ─────────────────────────────────────────────────────────────
{
  const e = mkEnv();
  const adv = e.kick(A, [D("foo")]);
  await waitUntil(() => e.rec.builds === 1, { label: "(4) advisory running" });
  const entry = e.advisoryEntries()[0];
  const g = e.gate("merge", REPO, {}, e.cap + 1); // one extra slot so the merge is admitted WHILE the advisory still runs
  await g.started.promise;
  check("(4) a merge admitted while the advisory RUNS leaves it running (not cancelled, no superseded record)", e.advisoryEntries().length === 1 && e.advisoryEntries()[0].id === entry.id && e.advisoryEntries()[0].phase === "running" && e.events().length === 0 && e.sessions.supersededAdvisories.size === 0);
  g.finish("pass"); await g.run;
  e.cancelAdvisories(); await adv;
}

// ── (5) no gate admission => no skip ────────────────────────────────────────────────────────────────
for (const [label, gateType, extra] of [["worker gate", "worker", {}], ["deploy gate", "deploy", {}], ["batch-fallback merge", "merge", { fallbackOfBatchOpId: "batch-op-1" }]]) {
  const e = mkEnv();
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")], REPO, extra, gateType);
  holders[0].release();
  await g.started.promise;
  check(`(5) ${label} admitted on the same repo does NOT supersede`, e.advisoryEntries().length === 1 && e.events().length === 0 && e.sessions.supersededAdvisories.size === 0);
  g.finish("pass"); await g.run;
  e.cancelAdvisories(); await advisoryDone;
  await e.drain(holders);
}
{
  // An ungated / interval-skipped landing (and the inert-diff skip) never calls runExclusive: its only footprint is the repo-guard-only hold.
  const e = mkEnv();
  const holders = [];
  for (let i = 0; i < e.cap; i++) { const h = e.hold("deploy"); await h.state.started.promise; holders.push(h); }
  const advisoryDone = e.kick(A, [D("foo")]);
  await waitUntil(() => e.advisoryEntries().some((x) => x.phase === "queued"), { label: "(5) advisory queued" });
  const release = await e.sem.acquireRepoGuardOnly({ repoPath: REPO, projectId: e.P.projId, sessionId: e.P.mgrId, opId: "rgo-op" });
  release();
  check("(5) a repo-guard-only hold (what an ungated landing does) does NOT supersede", e.advisoryEntries().length === 1 && e.events().length === 0 && e.sessions.supersededAdvisories.size === 0);
  holders[0].release();
  await waitUntil(() => e.rec.builds === 1, { label: "(5) with no gate admitted, the advisory just runs" });
  e.cancelAdvisories(); await advisoryDone;
  await e.drain(holders);
}

// ── (6) path normalisation ──────────────────────────────────────────────────────────────────────────
{
  check("(6) win32: backslashes + case + trailing slash fold to one key", normalizeRepoPathForCompare("C:\\Users\\Me\\Repo\\", "win32") === normalizeRepoPathForCompare("c:/users/me/repo", "win32"));
  check("(6) win32: genuinely different paths stay different", normalizeRepoPathForCompare("C:\\a\\repo", "win32") !== normalizeRepoPathForCompare("C:\\a\\repo2", "win32"));
  check("(6) posix: case is significant (a/Repo != a/repo)", normalizeRepoPathForCompare("/a/Repo", "linux") !== normalizeRepoPathForCompare("/a/repo", "linux"));
  check("(6) posix: trailing slash folds", normalizeRepoPathForCompare("/a/repo/", "linux") === normalizeRepoPathForCompare("/a/repo", "linux"));
  const e = mkEnv();
  const variant = process.platform === "win32" ? REPO.toUpperCase().replace(/\//g, "\\") : `${REPO}/`;
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")], variant);
  holders[0].release();
  await g.started.promise; await advisoryDone;
  check(`(6) live: a merge on a ${process.platform === "win32" ? "mixed-case/backslash" : "trailing-slash"} spelling of the same repo still supersedes`, e.advisoryEntries().length === 0 && e.events().length === 1 && e.events()[0].detail.superseded === true);
  g.finish("pass"); await g.run;
  await e.drain(holders);
}

// ── (7) landings before vs after admission ──────────────────────────────────────────────────────────
{
  for (const mode of ["pass", "fail"]) {
    const e = mkEnv();
    const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")]);
    void e.kick(B, [D("bar")]); // folded BEFORE admission (the advisory is still queued, its queue is running)
    holders[0].release();
    await g.started.promise;
    const post = e.kick(C, [D("baz")]); // AFTER admission: not in that gate's base
    void advisoryDone; void post; // the check loop also owns the follow-up run (blocked in its build), so it must not be awaited here
    await waitUntil(() => [...e.sessions.activeDistImporterRuns.values()].some((r) => r.landedSha === C), { label: `(7:${mode}) the post-admission landing got its own advisory run` });
    let run = [...e.sessions.activeDistImporterRuns.values()][0];
    check(`(7:${mode}) the post-admission landing gets its own run, covering ONLY its modules`, e.sessions.activeDistImporterRuns.size === 1 && JSON.stringify(run.touchedDistPaths) === JSON.stringify([D("baz")]));
    check(`(7:${mode}) the pre-admission landings are held (not drained) under the superseding op`, (() => { const s = e.sessions.supersededAdvisories.get(g.opId)?.get(`${e.P.projId}:primary`); return !!s && s.sha === B && JSON.stringify([...s.paths].sort()) === JSON.stringify([D("bar"), D("foo")]); })());
    g.finish(mode); await g.run;
    g.settle(mode === "pass");
    if (mode === "pass") {
      await waitUntil(() => e.rec.cuts.length === 1, { label: "(7:pass) the post-admission run was cut" });
      e.cancelAdvisories(); await advisoryDone;
      check("(7:pass) the pass drops the pre-admission landings: only the post-admission sha was ever cut", e.sessions.supersededAdvisories.size === 0 && e.rec.cuts.length === 1 && e.rec.cuts[0].sha === C);
    } else {
      // The fail re-enqueue coalesces behind the post-admission run; end that one and the follow-up drains.
      await waitUntil(() => e.rec.builds === 1, { label: "(7:fail) the post-admission run is building" });
      e.cancelAdvisories();
      await waitUntil(() => e.rec.builds === 2, { label: "(7:fail) the superseded landings re-ran as ONE follow-up" });
      run = [...e.sessions.activeDistImporterRuns.values()][0];
      check("(7:fail) the re-run is ONE check at the newest superseded sha covering the union of the pre-admission landings", e.rec.cuts.length === 2 && e.rec.cuts[1].sha === B && JSON.stringify([...run.touchedDistPaths].sort()) === JSON.stringify([D("bar"), D("foo")]));
      e.cancelAdvisories(); await advisoryDone;
      check("(7:fail) and no third run", e.rec.cuts.length === 2);
    }
    await e.drain(holders);
  }
}

// ── (8) restart pre-empt while a gate holds superseded advisories ───────────────────────────────────
{
  const e = mkEnv();
  const { holders, advisoryDone, g } = await e.queueAdvisoryAndMerge(A, [D("foo")]);
  holders[0].release();
  await g.started.promise; await advisoryDone;
  const pre = await e.sessions.preemptAdvisoryDistImporterChecks(2_000);
  check("(8) the restart's refire set carries the superseded advisory's modules", pre.refire.length === 1 && pre.refire[0].touchedDistPaths.length === 1 && pre.refire[0].touchedDistPaths[0] === D("foo"));
  check("(8) the held map is emptied (an aborted restart's refire and a later gate settle can't both re-run it)", e.sessions.supersededAdvisories.size === 0);
  const refire = await e.sessions.refireDistImporterChecks(pre.refire);
  await waitUntil(() => e.advisoryEntries().length === 1, { label: "(8) in-process refire queued ONE check (the cap is still full)" });
  g.finish("fail"); await g.run;
  g.settle(false); // the caller's settle after the restart emptied the map is a no-op: nothing is held to re-run
  await waitUntil(() => e.rec.builds === 1, { label: "(8) the refired check ran once the gate's slot freed" });
  check("(8) the gate's later FAIL re-runs nothing more (still exactly one check)", e.rec.cuts.length === 1 && e.advisoryEntries().length === 1);
  e.cancelAdvisories(); await bounded(refire.done, "(8) the refired check settled");
  await e.drain(holders);
}

// ── (9) repo identity stays out of the per-repo guard and out of the snapshot ────────────────────────
{
  const e = mkEnv();
  const adv = e.kick(A, [D("foo")]);
  await waitUntil(() => e.rec.builds === 1, { label: "(9) advisory running" });
  const descs = [...e.sem.registry.values()].map((x) => x.descriptor).filter((d) => d.distImporterCheckOnly);
  check("(9) the live advisory descriptor carries advisoryRepoPath and NO repoPath", descs.length === 1 && descs[0].advisoryRepoPath === REPO && descs[0].repoPath == null);
  check("(9) it holds no per-repo guard slot", e.sem.activeWorkerRepos.size === 0 && e.sem.activeMergeRepos.size === 0);
  const snap = e.advisoryEntries()[0];
  check("(9) the snapshot entry does not echo the repo identity", snap && !("advisoryRepoPath" in snap) && !JSON.stringify(snap).includes(REPO.replace(/\\/g, "\\\\")));
  e.cancelAdvisories(); await adv;
}

for (const db of dbs) { try { db.close?.(); } catch { /* best-effort */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
