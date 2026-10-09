import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cee17efe — the sessions/service.ts GLUE half: kickDistImporterCheck/runDistImporterCheckLoop/
// runOneDistImporterCheck, wired into confirmWorkerMergeTracked's solo-squash path. REAL git fixture
// repos (shaped like a tiny packages/daemon tree so changedDaemonSrcTsPathsForCommit's own path-prefix
// filter actually matches) + a REAL createWorktree/removeWorktree/deleteBranch + a REAL GateSemaphore —
// only the dist-importer check's own build step (distImporterCheckBuild) and the harness `runGate` call
// are test-doubled, mirroring merge-gate-interval.mjs's own mkService pattern.
//
// Uses a temp LOOM_HOME (createworktree-loom-home-guard.mjs's own chokepoint: this file calls the real
// createWorktree(, so WORKTREES_DIR — a sibling of LOOM_HOME — must be test-owned, never the owner's
// real ~/.loom-worktrees).
//
//   (1) an ungated (gate-interval) landing touching ONE module triggers exactly ONE kick, one
//       distImporterCheckOnly event (passed:true), one nudge naming the module + PASS; the worktree +
//       branch it cut are both removed afterward (CLEANUP on the PASS path).
//   (2) a GATED landing (mergeGate "every") never kicks at all (kickDistImporterCheck call count: 0) —
//       a structural, same-turn fact, not a timing race.
//   (3) a docs-only ungated landing (no packages/daemon/src/**/*.ts touched) kicks once but the kick
//       settles with NO event/nudge (nothing in packages/daemon/src to check).
//   (4) CAPPED RUN (SECOND LEAD ruling — never skip): a landing touching BOTH modules in a 4-file corpus
//       matches 3 of 4 files; cap=2 (60% of 4, floored) runs only the top-2 by touched-module-count. The
//       2-touched-module file (named to sort LAST alphabetically on purpose) still makes the cut ahead of
//       a 1-touched-module file that sorts first — proving ranking, not alphabetical order, decides. The
//       nudge reports "ran 2 of 3".
//   (5) RED RUN: a failing `--only=` run nudges with the failing file named, says "candidate, not a
//       verdict", and leaves the project's merge-gate state (ungatedSinceLastPass/gateOwed/lastPass*)
//       BYTE-IDENTICAL to right after the landing recorded its OWN ungated outcome — proving the check
//       never touches the gate counter. CLEANUP on the FAIL path too.
//   (6) COALESCING: two landings on the SAME (project,repo) arrive while the first's run is still
//       in-flight (held at the `--only=` admission) — the second is folded into ONE follow-up run
//       (never two concurrent runs; never a run per landing), covering the union of touched modules.
//   (7) NO REPO GUARD TAKEN (LEAD ruling A(ii)): while the dist-importer-check's OWN `--only=` run is
//       held admitted (worker-kind, no repoPath on its descriptor), a DIFFERENT worker's real merge
//       confirm on the SAME project+repo is admitted and settles WITHOUT waiting for the check — proving
//       the per-repo merge-admission guard (92e960d1/e4701333) was never engaged by this check.
// LEAD round-2 rulings (2026-10-09):
//   (8) QUEUE SURVIVAL (ruling 2): landing 1's own run throws unexpectedly (a real DB write failing,
//       nowhere near any mechanism-failure handling) — landing 2, arriving after, still gets its own
//       real run; the coalescing queue never sticks running:true forever.
//   (9) MECHANISM FAILURE, build fails: a nudge distinct from a real red, pending-op settled 'error',
//       CLEANUP still runs (worktree + branch both removed even though the build itself failed).
//   (10) MECHANISM FAILURE, harness-not-executed (ruling 1): the harness itself reporting selected files
//        were never run is nudged as a mechanism failure, never a red.
//   (11) MECHANISM FAILURE, no identifiable failing test (ruling 1): a non-zero exit with nothing
//        recognizable is nudged as a mechanism failure, never a red with an "(unnamed)" placeholder.
//   (12) BOOT SWEEP (ruling 4a): a worktree+branch left behind by a crash mid-run (no session row at
//        all, invisible to every OTHER boot sweep) is re-derived from its durable pending_gate_ops row
//        and removed by sweepOrphanedDistImporterCheckWorktrees; an unrelated row with nothing on disk
//        is a true no-op, not a crash.
//
// Run: 1) build (pnpm build), 2) node test/dist-importer-check-glue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-dic-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Card cee17efe (LEAD round-2 ruling 6): this dir was created directly (never through
// mkdtempManaged/useOwnLoomHome), so without this it was the one temp root in this file NEVER
// registered for guaranteed cleanup — registerForCleanup closes that gap the same way every other
// temp path in this file already is (TEMPLATE_REPO, each per-scenario repo).
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dic@loom -c user.name=dic";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const noReap = async () => ({ killedPids: [] });

// ── fixture: a tiny repo shaped like packages/daemon, so the real path-prefix filter matches ──────────
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-dic-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
(() => {
  mkdirp(TEMPLATE_REPO);
  fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# dic\n");
  mkdirp(path.join(TEMPLATE_REPO, "packages", "daemon", "src"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "src", "foo.ts"), "export const FOO = 1;\n");
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "src", "bar.ts"), "export const BAR = 1;\n");
  mkdirp(path.join(TEMPLATE_REPO, "packages", "daemon", "test"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "test", "importer-a.mjs"), "const m = await import(\"../dist/foo.js\");\n");
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "test", "importer-b.mjs"), "const m = await import(\"../dist/bar.js\");\n");
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "test", "unrelated.mjs"), "const m = await import(\"../dist/baz.js\");\n");
  // Named to sort LAST alphabetically on purpose — its presence in a capped run set can only be
  // explained by touched-module-count ranking (it imports BOTH foo+bar), never by alphabetical order.
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "test", "zzz-importer-both.mjs"), "const a = await import(\"../dist/foo.js\");\nconst b = await import(\"../dist/bar.js\");\n");
  mkdirp(path.join(TEMPLATE_REPO, "packages", "daemon", "scripts"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "packages", "daemon", "scripts", "test-daemon.mjs"), "export const EXCLUDED_DIR_NAMES = new Set();\nexport const NOT_HERMETIC = new Set();\n");
  execSync(`git init -q && git config user.email dic@loom && git config user.name dic`, { cwd: TEMPLATE_REPO });
  commitAll(TEMPLATE_REPO, "init", GIT_ID);
})();
function makeRepo(repo) {
  mkdirp(path.dirname(repo));
  registerForCleanup(repo);
  fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
}
const mk = (label) => ({
  projId: `dic-${label}-proj-${sfx}`, agentId: `dic-${label}-agent-${sfx}`, mgrId: `dic-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-dic-${label}-${sfx}`),
});
async function seedProject(db, P, orchestration) {
  db.insertProject({ id: P.projId, name: "DIC", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
let workerN = 0;
async function addWorker(db, P, files) {
  workerN++;
  const taskId = `dic-t${workerN}-${sfx}`;
  const workerId = `dic-w${workerN}-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${workerN}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktreeDirect(P.repo, P.projId, taskId);
  worktrees.push(wt.worktreePath);
  for (const [rel, body] of Object.entries(files)) { mkdirp(path.dirname(path.join(wt.worktreePath, rel))); fs.writeFileSync(path.join(wt.worktreePath, rel), body); }
  commitAll(wt.worktreePath, `feat(x): change ${workerN}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { taskId, workerId, worktreePath: wt.worktreePath, branch: wt.branch };
}
const { createWorktree: createWorktreeDirect, taskKey } = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

/** True once the project's worktree dir on disk holds EXACTLY the REAL workers' own taskKey-named
 *  entries (`knownTaskIds`) — no extra entry, which is what a left-behind dist-importer-check worktree
 *  (a DIFFERENT, opId-derived taskKey) would show up as. `taskKey` hashes its input, so this compares
 *  the actual hashed directory names rather than guessing a literal "dist-importer-check-*" prefix. */
function onlyKnownWorktreeDirsLeft(projectId, knownTaskIds) {
  const projDir = path.join(WORKTREES_DIR, projectId);
  if (!fs.existsSync(projDir)) return true;
  const expected = new Set(knownTaskIds.map((t) => taskKey(t)));
  return fs.readdirSync(projDir).every((name) => expected.has(name));
}

/** Card cee17efe (LEAD round-2 ruling 6): the check's own branch is `loom/${taskKey("dist-importer-
 *  check-<opId>")}` — a 12-HEX HASH, never a literal "dist-importer-check-*"-prefixed name, so a
 *  `git branch --list "loom/dist-importer-check-*"` glob can NEVER match it and reads "" (empty) whether
 *  or not cleanup actually ran — vacuously green either way, and the opId itself is internal (never
 *  exposed to this test), so the real name can't be precomputed either. Callers instead filter the full
 *  `loom/*` set against the ONE legitimate survivor they already know by name (`w.branch`, returned by
 *  `addWorker`) — see each call site's own comment for why a before/after diff was tried first and
 *  rejected as racy (`kickDistImporterCheck` fires fire-and-forget from inside the merge call itself, so
 *  a "before" snapshot taken after `confirm()` resolves can already contain the check's own branch). */
function listLoomBranches(repoPath) {
  const out = execSync("git branch --list \"loom/*\" --format=%(refname:short)", { cwd: repoPath }).toString().trim();
  return out ? out.split("\n").sort() : [];
}

/** By the time `settleAllKicks` resolves, `runOneDistImporterCheck`'s own `finally` block (which deletes
 *  the branch) has already run to completion in-process — but the underlying `git branch -D` is
 *  deliberately best-effort (see its own `catch` in service.ts: "non-fatal", left-behind is accepted,
 *  same posture as the worktree-removal side), so in principle a transient OS-level git delay could leave
 *  it visible for a moment after that.
 *
 *  Card cee17efe (round-3 ruling 6, count added round-4 ruling 7): the PRIOR version of this comment
 *  asserted "measured flake: ~1-in-5 single-shot reads" — re-investigated by instrumenting the FIRST read
 *  (before any retry sleep) across every `survivorBranches` call in this file, 6 per complete run at the
 *  time of that investigation — (1), (5), (9), (14), (16), (17). MEASURED: 0 first-read misses in 21
 *  reads across 4 full runs of this suite (one run's own log captured only 3 of its 6 before the process
 *  moved on, hence 21, not the 24-call ceiling of 4 runs x 6 calls). Card 02c5311d: scenario (20) was
 *  added later and also calls `survivorBranches` (7 calls/run as of this card) — the 21-reads/24-ceiling
 *  figures above are NOT re-derived for 7; they describe the 6-call-per-run suite that was actually
 *  measured, not this file's current shape. The ~1-in-5 figure is accordingly RETRACTED as unverified here — this file's own scenarios
 *  never produced a concurrent actor (each uses its own freshly-cloned repo, and scenarios run
 *  sequentially, never in parallel, so there is no OTHER process that could hold a stale ref open), and no
 *  transient git-level lag was reproduced either. The retry loop is kept anyway, defensively, since a
 *  bounded retry costs nothing when it never fires and this investigation cannot rule out a flake on a
 *  more loaded host than the one it was run on — but a future reader must not cite the old figure as still
 *  measured, and should re-investigate (the SAME first-read-instrumentation technique, reporting the new
 *  N) rather than assume this holds forever, per `read-the-artifact-before-you-send-not-after`'s "not
 *  reproduced in N clean trials" discipline. */
/** Card cee17efe (round-4 ruling 1b): the `gate_history`/`countGateEvents` projection for one settled
 *  dist-importer-check op, by its `opId` — asserts the SAME row `db.listGateEvents`/`countGateEvents`
 *  (the real production projection a human/agent reader actually sees, not just the raw event detail
 *  scenarios already check) shows the EXPECTED `outcome`/`gateRan`, not merely that an event exists. */
function gateHistoryRowFor(db, projectId, opId) {
  return db.listGateEvents({ projectId, limit: 50, offset: 0 }).items.find((r) => r.opId === opId);
}

async function survivorBranches(repoPath, knownBranch) {
  const deadline = performance.now() + 2_000;
  for (;;) {
    const survivors = listLoomBranches(repoPath).filter((b) => b !== knownBranch);
    if (survivors.length === 0 || performance.now() > deadline) return survivors;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** mkService + the dist-importer-check-specific spies/seams this file needs on top of merge-gate-interval.mjs's own. */
function mkService(db, extra = {}) {
  const gate = { calls: 0, pass: true, failNext: false, distHold: null, distFailingTest: undefined, distMechanismLike: false, distHarnessNotExecuted: false, distTimedOut: false, lastDistCall: null };
  const sessions = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gateCmd, cwd, timeoutMs, runStep, envOverride, allowExtend, cancelSignal, hooks, spillFile) => {
      // Card cee17efe (LEAD round-2 ruling 1): the real gate command now delivers its selection via
      // --only-file=<path> (a file inside the check's own worktree), never inline --only=<names> — see
      // that card's own decision record for why (the cmd.exe command-line-length fix).
      if (gateCmd.includes("--only-file=")) {
        // Card cee17efe (LEAD round-2 ruling 5): captured so scenario (1) can assert the gate-env
        // contract — the SAME concurrency-pin envOverride + spill file + liveness hooks runWorkerGate's
        // own real worker self-check already uses, never a second, weaker convention.
        gate.lastDistCall = { envOverride, hooks, spillFile };
        if (gate.distHold) {
          // Card cee17efe (round-3 ruling 1 proof): race the hold against the semaphore's own
          // cancelSignal, mirroring runGateSequential's real cancelSignal.aborted check — a RUNNING
          // cancel scenario needs this stub to actually resolve {cancelled:true} rather than ignore the
          // abort and keep awaiting the hold forever.
          const cancelled = cancelSignal
            ? await new Promise((res) => { gate.distHold.then(() => res(false)); cancelSignal.addEventListener("abort", () => res(true), { once: true }); })
            : await gate.distHold.then(() => false);
          if (cancelled) return { passed: false, cancelled: true, steps: [] };
        }
        if (gate.distTimedOut) return { passed: false, failedStep: "test", failedStatus: 1, failedTimedOut: true, steps: [] };
        if (gate.distFailingTest) return { passed: false, failedStep: "test", failedStatus: 1, steps: [], failingTest: gate.distFailingTest };
        // Card cee17efe (LEAD round-2 ruling 1): a non-test exit (harness-not-executed, or a red with no
        // identifiable failing test at all) — the check's own classification routes this to a mechanism-
        // failure nudge, never a red with an "(unnamed)" placeholder.
        if (gate.distHarnessNotExecuted) return { passed: false, failedStep: "test", failedStatus: 1, steps: [], harnessNotExecutedDetected: true };
        if (gate.distMechanismLike) return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; // no failingTest at all
        return { passed: true, steps: [] };
      }
      gate.calls++;
      if (gate.failNext) { gate.failNext = false; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; }
      return gate.pass ? { passed: true, steps: [] } : { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
    },
    reapWorktreeProcesses: noReap,
    distImporterCheckBuild: async () => ({ ok: true }),
    ...extra,
  });
  const spy = { kicks: [], nudges: [] };
  const origKick = sessions.kickDistImporterCheck.bind(sessions);
  sessions.kickDistImporterCheck = (...a) => { const p = origKick(...a); spy.kicks.push(p); return p; };
  const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (id, text, ctx) => { spy.nudges.push({ id, text }); return origEnqueue(id, text, ctx); };
  return { sessions, gate, spy };
}
const confirm = async (sessions, mgrId, workerId) => {
  const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  return r.settled && r.ok ? r.value : { __unsettled: r };
};
// `maxConcurrentGates` has NO per-project override layer (platform-only, like schedulerEnabled) — a
// project config's own `orchestration.maxConcurrentGates` is silently ignored by resolveConfig. Scenario
// (7) needs cap=2 so the check's own held worker-kind run and an ordinary merge's gate run can BOTH be
// admitted — raised ONCE, here, on the platform row every `new Db()` instance in this file shares (same
// underlying sqlite file, same LOOM_HOME, same pattern merge-gate-interval.mjs uses for its own
// "a fresh Db reads the same persisted state" restart-persistence checks).
(() => { const bootDb = new Db(); bootDb.setPlatformConfig({ maxConcurrentGates: 2 }); bootDb.close(); })();
const settleAllKicks = async (spy) => { while (spy.kicks.length) await Promise.all(spy.kicks.splice(0)); };

const dbs = [];
const worktrees = [];
try {
  // ── (1) ordinary ungated landing, ONE module, PASS, CLEANUP ────────────────────────────────────────
  {
    const P = mk("pass"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 2;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(1) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    check("(1) kickDistImporterCheck fired exactly once", ctx.spy.kicks.length === 1);
    await settleAllKicks(ctx.spy);
    const ev = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(1) distImporterCheckOnly event" });
    check("(1) the event names the landed sha, the touched module, and PASSED", ev.detail.landedSha && ev.detail.touchedDistPaths.some((p) => p.endsWith("foo.js")) && ev.detail.passed === true);
    check("(1) exactly one nudge was pushed, naming the module and PASS", ctx.spy.nudges.length === 1 && ctx.spy.nudges[0].text.includes("foo") && ctx.spy.nudges[0].text.includes("passed"));
    check("(1) CLEANUP (worktree): no extra worktree dir survives beyond the real worker's own", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    // Card cee17efe (LEAD round-2 ruling 6): `w.branch` is the ONE legitimate `loom/*` branch this
    // scenario could ever leave behind (whether or not the ordinary merge's own finalize has deleted it
    // by this point — either is fine); any OTHER surviving loom/* branch can only be the check's own leak.
    // A before/after diff was tried first and is RACY: kickDistImporterCheck fires fire-and-forget from
    // INSIDE confirmWorkerMergeTracked, so its own branch can already exist by the time confirm()'s
    // promise resolves — a "before" snapshot taken then can itself already contain the leak, hiding it.
    const survivors1 = await survivorBranches(P.repo, w.branch);
    check(`(1) CLEANUP (branch): no check branch survives beyond the real worker's own (found: ${survivors1.join(", ") || "none"})`, survivors1.length === 0);
    // Card cee17efe (LEAD round-2 ruling 5): the gate-env contract — same concurrency pin, a real spill
    // file path, and the semaphore's own liveness hooks object (never undefined) runWorkerGate's real
    // worker self-check already gets.
    check("(1) the real test run pins LOOM_GATE_TEST_CONCURRENCY (the same env override runWorkerGate uses)", ctx.gate.lastDistCall?.envOverride?.LOOM_GATE_TEST_CONCURRENCY === "3");
    check("(1) the real test run carries a real spill file path", typeof ctx.gate.lastDistCall?.spillFile === "string" && ctx.gate.lastDistCall.spillFile.length > 0);
    check("(1) the real test run forwards the semaphore's own liveness hooks (never undefined)", typeof ctx.gate.lastDistCall?.hooks === "object" && ctx.gate.lastDistCall.hooks !== null);
  }

  // ── (2) GATED landing never kicks — structural, no wait needed ─────────────────────────────────────
  {
    const P = mk("gated"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "on" });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 3;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(2) landing was GATED (not ungated)", v.merged === true && v.skipReason === undefined && v.gateRan === true);
    check("(2) kickDistImporterCheck NEVER fired for a gated landing", ctx.spy.kicks.length === 0);
  }

  // ── (3) docs-only ungated landing kicks but finds nothing to check ─────────────────────────────────
  {
    const P = mk("docs"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "README.md": "docs change\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(3) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    check("(3) kickDistImporterCheck fired once (the attach point was reached)", ctx.spy.kicks.length === 1);
    await settleAllKicks(ctx.spy);
    check("(3) NO distImporterCheckOnly event (nothing under packages/daemon/src changed)", !db.listEvents(P.mgrId).some((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true));
    check("(3) NO nudge was pushed", ctx.spy.nudges.length === 0);
  }

  // ── (4) CAPPED RUN: both modules touched in a 4-file corpus (3 match, cap=2) — never skipped ───────
  {
    const P = mk("capped"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, {
      "packages/daemon/src/foo.ts": "export const FOO = 4;\n",
      "packages/daemon/src/bar.ts": "export const BAR = 4;\n",
    });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(4) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const ev = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true && e.detail?.landedSha), { label: "(4) capped-run event" });
    check("(4) NEVER skipped: a real distImporterCheckOnly event WAS recorded (it reached gate admission)", !!ev);
    check("(4) exactly cap=2 of the 3 matched files ran", ev.detail.ranSize === 2 && ev.detail.matchedSize === 3);
    const nudge = await waitUntil(() => ctx.spy.nudges[0], { label: "(4) capped-run nudge" });
    check("(4) the nudge says 'ran 2 of 3' and names the cap", nudge.text.includes("ran 2 of 3") && nudge.text.includes("cap 60% of corpus"));
    check("(4) the nudge still reads as an ordinary pass (never a skip)", nudge.text.includes("passed") && !nudge.text.includes("skipped"));
  }

  // ── (5) RED RUN: nudges with the failing file, never touches the gate counter, CLEANUP on fail ─────
  {
    const P = mk("red"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 5;\n" });
    ctx.gate.distFailingTest = "importer-a.mjs";
    const stateBefore = { ...db.getMergeGateState(P.projId) };
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    const stateRightAfterLanding = { ...db.getMergeGateState(P.projId) };
    check("(5) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const nudge = await waitUntil(() => ctx.spy.nudges[0], { label: "(5) red-run nudge" });
    check("(5) the nudge names the failing file", nudge.text.includes("importer-a.mjs"));
    check("(5) the nudge says a red here is a CANDIDATE, not a verdict, and to re-run on main first", nudge.text.includes("candidate, not a verdict") && nudge.text.toLowerCase().includes("re-run"));
    const stateAfterCheck = db.getMergeGateState(P.projId);
    check("(5) the merge-gate state is BYTE-IDENTICAL to right after the landing recorded its OWN outcome — the RED check touched NOTHING further", JSON.stringify(stateAfterCheck) === JSON.stringify(stateRightAfterLanding) && JSON.stringify(stateRightAfterLanding) !== JSON.stringify(stateBefore));
    check("(5) CLEANUP on the FAIL path too (worktree): no extra worktree dir survives beyond the real worker's own", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    // See (1)'s identical comment for why this is `!== w.branch`, not a before/after diff.
    const survivors5 = await survivorBranches(P.repo, w.branch);
    check(`(5) CLEANUP on the FAIL path too (branch): no check branch survives even on a RED run (found: ${survivors5.join(", ") || "none"})`, survivors5.length === 0);
  }

  // ── (6) COALESCING: a second landing arriving mid-run folds into ONE follow-up run ─────────────────
  {
    const P = mk("coalesce"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 10 });
    const hold = deferred();
    ctx.gate.distHold = hold.promise;
    const w1 = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 6;\n" });
    const v1Promise = confirm(ctx.sessions, P.mgrId, w1.workerId);
    const v1 = await v1Promise;
    check("(6) landing 1 merged ungated", v1.merged === true && v1.skipReason === "gate-interval");
    check("(6) exactly one kick so far", ctx.spy.kicks.length === 1);
    // wait until run #1 is genuinely HELD at its own `--only=` admission (observable: the pending gate op
    // for this project now exists and is still state:"pending") before landing #2 arrives.
    await waitUntil(() => db.listPendingGateOps().some((o) => o.projectId === P.projId && o.kind === "gate" && o.key.startsWith("dist-importer-check:") && o.state === "pending"),
      { label: "(6) run #1 admitted and held", timeoutMs: 10_000 });
    const w2 = await addWorker(db, P, { "packages/daemon/src/bar.ts": "export const BAR = 6;\n" });
    const v2 = await confirm(ctx.sessions, P.mgrId, w2.workerId);
    check("(6) landing 2 ALSO merged ungated (both independently landed)", v2.merged === true && v2.skipReason === "gate-interval");
    check("(6) landing 2's kick fired too, but did NOT start a second concurrent run (still only ONE run's worth of distImporterCheckOnly events by now)", ctx.spy.kicks.length === 2 && !db.listEvents(P.mgrId).some((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true));
    hold.resolve({});
    await settleAllKicks(ctx.spy);
    const events = () => db.listEvents(P.mgrId).filter((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true);
    await waitUntil(() => events().length >= 2, { label: "(6) both runs settled (the original + ONE follow-up)" });
    check("(6) EXACTLY TWO runs total (the original + ONE follow-up — never a run per landing, never two concurrent)", events().length === 2);
    const followUp = events().find((e) => e.detail.touchedDistPaths.some((p) => p.endsWith("bar.js")));
    check("(6) the follow-up run's own touched-module set covers landing 2's module (bar.js)", !!followUp);
  }

  // ── (7) NO REPO GUARD TAKEN: a same-repo merge confirm is admitted while the check runs ────────────
  {
    const P = mk("norepoguard"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 10 });
    const hold = deferred();
    ctx.gate.distHold = hold.promise;
    const w1 = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 7;\n" });
    const v1 = await confirm(ctx.sessions, P.mgrId, w1.workerId);
    check("(7) landing 1 merged ungated", v1.merged === true);
    await waitUntil(() => db.listPendingGateOps().some((o) => o.projectId === P.projId && o.kind === "gate" && o.key.startsWith("dist-importer-check:") && o.state === "pending"),
      { label: "(7) the check's own run is admitted and held", timeoutMs: 10_000 });
    // A DIFFERENT worker's ORDINARY gated merge on the SAME repo, started WHILE the check holds —
    // ctx.gate.pass defaults true and its own command ("pnpm gate") never matches "--only=", so it is
    // NOT held by `hold`; it must complete promptly if (and only if) no per-repo guard serializes it
    // behind the check.
    db.setProjectConfig(P.projId, { orchestration: { gateCommand: "pnpm gate", mergeGate: "on" } }); // flip to gated so THIS confirm actually spawns a real gate
    const w2 = await addWorker(db, P, { "packages/daemon/src/baz-unrelated.ts": "export const BAZ = 7;\n" });
    const v2Promise = confirm(ctx.sessions, P.mgrId, w2.workerId);
    // DIRECT, STRUCTURAL proof (LEAD ruling A(ii)): read the live GateSemaphore registry while v2's own
    // "merge"-kind entry for THIS project exists (running or queued) and assert its OWN `repoContended`
    // flag is false — the semaphore's own admission-level signal for "a per-repo guard is why I'm
    // waiting", never inferred from wall-clock timing.
    const v2Entry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.gateType === "merge" && e.projectId === P.projId),
      { label: "(7) v2's own merge entry appears in the live registry", timeoutMs: 10_000 });
    check("(7) v2's merge entry is NOT repo-contended — the check's own worker-kind descriptor carries no repoPath, so the per-repo guard has nothing to match", v2Entry.repoContended === false);
    const v2 = await v2Promise;
    // Card cee17efe (LEAD round-2 ruling 6): the wall-clock `elapsedMs < 5_000` bound this used to carry
    // is dropped — it added no further proof beyond the STRUCTURAL `repoContended === false` check just
    // above (the real, admission-level signal), and would flake under real host load. `t0` is no longer
    // read; the structural proof is what actually establishes "need not wait for the check's own held slot".
    check("(7) the SECOND (ordinary) merge was admitted and settled (cap=2, so it need not wait for the check's own held slot)", v2.merged === true && v2.gateRan === true);
    hold.resolve({});
    await settleAllKicks(ctx.spy);
  }

  // ── (8) QUEUE SURVIVAL (LEAD round-2 ruling 2): a run that throws UNEXPECTEDLY (something runOneDist-
  // ImporterCheck's own try/catch never reaches at all — a DB write failing before it) must never leave
  // this (project,repo)'s coalescing queue stuck `running:true` forever: the NEXT, independent landing
  // still gets its own real run ─────────────────────────────────────────────────────────────────────
  {
    const P = mk("throws"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    // Monkey-patch a single real DB write INSIDE runOneDistImporterCheck (insertPendingGateOp, its very
    // first statement) to throw once — reproduces an unexpected throw with NO mechanism-failure handling
    // anywhere near it, exactly the shape ruling 2 fixes: before the fix, this would leave
    // distImporterCheckQueues' entry stuck running:true, and landing 2 below would silently fold into
    // that dead batch and never produce its own run.
    const origInsert = db.insertPendingGateOp.bind(db);
    let thrown = false;
    db.insertPendingGateOp = (op) => {
      if (!thrown && op.key.startsWith("dist-importer-check:")) { thrown = true; throw new Error("synthetic unexpected throw (card cee17efe ruling 2 proof)"); }
      return origInsert(op);
    };
    const w1 = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 8;\n" });
    const v1 = await confirm(ctx.sessions, P.mgrId, w1.workerId);
    check("(8) landing 1 merged ungated", v1.merged === true);
    await settleAllKicks(ctx.spy);
    check("(8) landing 1's own run threw unexpectedly and produced NO distImporterCheckOnly event", !db.listEvents(P.mgrId).some((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true));
    db.insertPendingGateOp = origInsert; // restore — landing 2's own run must proceed normally
    const w2 = await addWorker(db, P, { "packages/daemon/src/bar.ts": "export const BAR = 8;\n" });
    const v2 = await confirm(ctx.sessions, P.mgrId, w2.workerId);
    check("(8) landing 2 ALSO merged ungated", v2.merged === true);
    await settleAllKicks(ctx.spy);
    const ev2 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true),
      { label: "(8) landing 2's OWN run genuinely fired — the queue did not stick running:true forever after landing 1's throw" });
    check("(8) landing 2's run genuinely executed and passed", ev2.detail.passed === true);
  }

  // ── (9) MECHANISM FAILURE (build fails): a nudge distinct from a real red, pending-op settled 'error',
  // CLEANUP still runs (worktree + branch both removed even though the build itself failed) ───────────
  {
    const P = mk("buildfail"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, { distImporterCheckBuild: async () => ({ ok: false, reason: "synthetic build failure (card cee17efe mechanism-failure proof)" }) });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 9;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(9) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"), { label: "(9) the check's own pending-gate-op settled" });
    check("(9) the pending-gate-op settled as 'error' (a mechanism failure, never a fail/pass verdict)", op.verdict === "error");
    // LEAD round-3 ruling 2: a mechanism failure now records its OWN distImporterCheckOnly event too (so
    // gate_history/countGateEvents can see it) — mechanismLike:true, never a passed:true/false verdict,
    // so it's never confused with a real gate pass/fail.
    const ev9 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(9) the mechanism-failure's OWN distImporterCheckOnly event" });
    check("(9) the event is mechanismLike, never a passed pass/fail verdict", ev9.detail.mechanismLike === true && ev9.detail.passed === undefined);
    // LEAD round-4 ruling 1(b): the REAL gate_history/countGateEvents projection — not just the raw event
    // detail above — must also show this as "error"/gateRan:false, never "reject".
    const hist9 = gateHistoryRowFor(db, P.projId, op.opId);
    check("(9) gate_history projects this row as outcome:'error' (never 'reject')", hist9?.outcome === "error");
    check("(9) gate_history projects gateRan:false (a cut/build mechanism failure never spawns a real gate process)", hist9?.gateRan === false);
    const counts9 = db.countGateEvents({ projectId: P.projId });
    check("(9) countGateEvents tallies this under byOutcome.error (never byOutcome.reject)", counts9.byOutcome.error === 1 && !counts9.byOutcome.reject);
    check("(9) countGateEvents tallies this under byGateType.distImporterCheck (never byGateType.worker)", counts9.byGateType.distImporterCheck === 1 && !counts9.byGateType.worker);
    const nudge = await waitUntil(() => ctx.spy.nudges[0], { label: "(9) the mechanism-failure nudge" });
    check("(9) the nudge names the synthetic build failure and reads distinctly from a real test red", nudge.text.includes("synthetic build failure") && nudge.text.includes("could not run") && !nudge.text.includes("FAILED:"));
    check("(9) CLEANUP (worktree): no extra worktree dir survives even though the build itself failed", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    const survivors9 = await survivorBranches(P.repo, w.branch);
    check(`(9) CLEANUP (branch): no check branch survives even though the build itself failed (found: ${survivors9.join(", ") || "none"})`, survivors9.length === 0);
  }

  // ── (10) MECHANISM FAILURE (harness-not-executed): the harness itself reporting selected files were
  // never run is nudged as a mechanism failure, never a red ─────────────────────────────────────────
  {
    const P = mk("harnessnotexec"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    ctx.gate.distHarnessNotExecuted = true;
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 10;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(10) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"), { label: "(10) the check's own pending-gate-op settled" });
    check("(10) the pending-gate-op settled as 'error' (never 'fail') — a harness-not-executed exit is a mechanism failure", op.verdict === "error");
    const nudge = await waitUntil(() => ctx.spy.nudges[0], { label: "(10) the mechanism-failure nudge" });
    check("(10) the nudge names the harness-not-executed mechanism, never a real red", nudge.text.includes("not actually executed") && !nudge.text.includes("FAILED:"));
  }

  // ── (11) MECHANISM FAILURE (no identifiable failing test): a non-zero exit with nothing recognizable
  // is nudged as a mechanism failure, never a red with an "(unnamed)" placeholder ─────────────────────
  {
    const P = mk("noidtest"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    ctx.gate.distMechanismLike = true;
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 11;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(11) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"), { label: "(11) the check's own pending-gate-op settled" });
    check("(11) the pending-gate-op settled as 'error' (never 'fail') — no identifiable failing test is a mechanism failure", op.verdict === "error");
    const nudge = await waitUntil(() => ctx.spy.nudges[0], { label: "(11) the mechanism-failure nudge" });
    check("(11) the nudge never claims an '(unnamed)' failing file — it reads as a harness/usage error instead", !nudge.text.includes("(unnamed)") && nudge.text.includes("no identifiable failing test"));
  }

  // ── (12) BOOT SWEEP (LEAD round-2 ruling 4a): a worktree+branch left behind by a crash mid-run (no
  // session row at all — invisible to every OTHER boot sweep) is re-derived from its durable
  // pending_gate_ops row and removed; an unrelated row with nothing on disk is a true no-op ──────────
  {
    const P = mk("bootsweep"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });

    // Simulate what a crash mid-run leaves behind: the REAL deterministic worktree+branch
    // runOneDistImporterCheck would have cut for this opId, but NO corresponding session row (it never
    // has one) and a pending_gate_ops row still stuck 'pending' (the crash happened before settle).
    const crashedOpId = randomUUID();
    const crashedTaskId = `dist-importer-check-${crashedOpId}`;
    const crashedWt = await createWorktreeDirect(P.repo, P.projId, crashedTaskId);
    worktrees.push(crashedWt.worktreePath);
    db.insertPendingGateOp({
      opId: crashedOpId, kind: "gate", key: `dist-importer-check:${crashedOpId}`, ownerSessionId: P.mgrId,
      projectId: P.projId, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false,
    });
    check("(12) [setup] the simulated crash left a REAL worktree on disk", fs.existsSync(crashedWt.worktreePath));
    check("(12) [setup] the simulated crash left the REAL branch too", listLoomBranches(P.repo).includes(crashedWt.branch));

    // Negative control: an UNRELATED pending_gate_ops row (a genuinely different opId) whose worktree was
    // never created on disk at all — the sweep must skip it silently, never throw, never miscount it.
    const phantomOpId = randomUUID();
    db.insertPendingGateOp({
      opId: phantomOpId, kind: "gate", key: `dist-importer-check:${phantomOpId}`, ownerSessionId: P.mgrId,
      projectId: P.projId, taskId: null, branch: null, startedAt: now, state: "settled", surfacedPending: false,
    });

    const swept = await ctx.sessions.sweepOrphanedDistImporterCheckWorktrees();
    check("(12) the sweep reports exactly ONE real removal (the phantom row contributes nothing)", swept === 1);
    check("(12) the leftover worktree is GONE after the sweep", !fs.existsSync(crashedWt.worktreePath));
    check("(12) the leftover branch is GONE after the sweep too", !listLoomBranches(P.repo).includes(crashedWt.branch));
  }

  // ── LEAD round-3 rulings (2026-10-09) ───────────────────────────────────────────────────────────────

  // ── (13) QUEUED CANCEL (R3-1/R3-3): the check's own "low"-tier run genuinely queues behind a
  // saturated cap and is withdrawn WHILE STILL QUEUED — GateCancelledError, `fn` never invoked, so NO
  // worktree is ever cut. Settles 'cancelled' (never 'error'/'reject'), records its OWN
  // distImporterCheckOnly event, and pushes the shared cancelled nudge ──────────────────────────────
  {
    const P = mk("queuedcancel"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate so the check's own run genuinely queues
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    let releaseHolder;
    const holderHold = new Promise((res) => { releaseHolder = res; });
    const pHolder = ctx.sessions.gateSemaphore.runExclusive(
      1, { gateType: "worker", projectId: P.projId, sessionId: `qc-holder-${sfx}` },
      async () => { await holderHold; return "holder"; },
    );
    pHolder.catch(() => {});
    await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().active === 1, { label: "(13) [setup] the holder op saturates the cap" });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 13;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(13) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    const queuedEntry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.distImporterCheckOnly === true && e.phase === "queued"),
      { label: "(13) [setup] the check's own run genuinely queues behind the saturated cap", timeoutMs: 10_000 });
    check("(13) [setup] the queued entry carries distImporterCheckOnly:true", !!queuedEntry && queuedEntry.distImporterCheckOnly === true);
    const cancelOk = queuedEntry ? ctx.sessions.gateSemaphore.cancelQueued(queuedEntry.id, "manual", "test queued cancel (card cee17efe round-3 proof)") : false;
    check("(13) the queued-cancel call itself succeeded", cancelOk === true);
    releaseHolder({});
    await pHolder.catch(() => {});
    await settleAllKicks(ctx.spy);
    const op13 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(13) the check's own pending-gate-op settled" });
    db.setPlatformConfig({ maxConcurrentGates: 2 }); // restore — this is a GLOBAL platform row shared by every later scenario's own Db() instance; leaving it at 1 here would silently narrow every scenario that follows
    check("(13) the pending-gate-op settled as 'cancelled' (never 'error'/'reject')", op13.verdict === "cancelled");
    const ev13 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(13) the cancel's OWN distImporterCheckOnly event" });
    check("(13) the event carries cancelled:true", ev13.detail.cancelled === true);
    const nudge13 = await waitUntil(() => ctx.spy.nudges[0], { label: "(13) the cancelled nudge" });
    check("(13) the nudge reads as cancelled and touches nothing further", nudge13.text.includes("cancelled") && nudge13.text.includes("nothing further to do"));
    check("(13) NO worktree was ever cut — a withdrawn QUEUED op never admits, so createWorktree is never called", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
  }

  // ── (14) RUNNING CANCEL (R3-1/R3-3): cancelled AFTER admission, while the real `--only-file=` run is
  // genuinely in flight — GateSequentialResult resolves {cancelled:true} normally (never rejects); must
  // settle 'cancelled', never fall through to mechanismLike's harness/usage-error misclassification ──
  {
    const P = mk("runningcancel"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const hold = deferred();
    ctx.gate.distHold = hold.promise;
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 14;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(14) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    // Card cee17efe (round-3 proof, fixing a real test race): wait for `gate.lastDistCall` — set at the
    // TOP of the stub's `--only-file=` branch, BEFORE it awaits `distHold` — not just "phase:running",
    // which admits as soon as `runExclusive`'s callback starts and can still be anywhere inside the
    // cut/build/scan phases that precede the real gate call. Cancelling too early would land on one of
    // THOSE phases' own `cancelSignal.aborted` checks instead of the gate's own `GateSequentialResult`
    // (`gateResult.cancelled`) — a different code path than the one this scenario means to prove.
    await waitUntil(() => ctx.gate.lastDistCall !== null, { label: "(14) [setup] the check's own run has genuinely reached the real --only-file= gate call (held on distHold)", timeoutMs: 10_000 });
    const runningEntry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.distImporterCheckOnly === true && e.phase === "running"),
      { label: "(14) [setup] the check's own run is genuinely RUNNING (admitted, held at --only-file=)", timeoutMs: 10_000 });
    check("(14) [setup] the running entry carries distImporterCheckOnly:true", !!runningEntry && runningEntry.distImporterCheckOnly === true);
    const aborted = runningEntry ? ctx.sessions.gateSemaphore.cancelRunning(runningEntry.id, "test running cancel (card cee17efe round-3 proof)") : false;
    check("(14) the running-cancel call itself succeeded", aborted === true);
    await settleAllKicks(ctx.spy);
    const op14 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(14) the check's own pending-gate-op settled" });
    check("(14) the pending-gate-op settled as 'cancelled' (never 'error'/'reject' — the mechanismLike misclassification this ruling fixes)", op14.verdict === "cancelled");
    const ev14 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(14) the cancel's OWN distImporterCheckOnly event" });
    check("(14) the event carries cancelled:true (never mechanismLike:true)", ev14.detail.cancelled === true && !ev14.detail.mechanismLike);
    // LEAD round-4 ruling 1(b)/3: gate_history must show outcome:'cancelled' AND gateRan:true — the gate
    // process genuinely spawned (this cancel landed INSIDE the real --only-file= run), unlike (9)/(16)/(17).
    const hist14 = gateHistoryRowFor(db, P.projId, op14.opId);
    check("(14) gate_history projects this row as outcome:'cancelled'", hist14?.outcome === "cancelled");
    check("(14) gate_history projects gateRan:true (the gate process genuinely spawned before this cancel landed)", hist14?.gateRan === true);
    const counts14 = db.countGateEvents({ projectId: P.projId });
    check("(14) countGateEvents tallies this under byOutcome.cancelled", counts14.byOutcome.cancelled === 1);
    const nudge14 = await waitUntil(() => ctx.spy.nudges[0], { label: "(14) the cancelled nudge" });
    check("(14) the nudge reads as cancelled, never as a harness/usage-error mechanism failure", nudge14.text.includes("cancelled") && !nudge14.text.includes("harness"));
    check("(14) CLEANUP (worktree): no extra worktree dir survives a RUNNING cancel", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    const survivors14 = await survivorBranches(P.repo, w.branch);
    check(`(14) CLEANUP (branch): no check branch survives a RUNNING cancel (found: ${survivors14.join(", ") || "none"})`, survivors14.length === 0);
  }

  // ── (15) TIMEOUT (R3-1): a genuine gate timeout (failedTimedOut:true, no identifiable failing test)
  // is reported AS A TIMEOUT, never folded into mechanismLike's "harness/usage error" nudge ───────────
  {
    const P = mk("timeout"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    ctx.gate.distTimedOut = true;
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 15;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(15) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op15 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(15) the check's own pending-gate-op settled" });
    check("(15) the pending-gate-op settled as 'fail' (a genuine timeout is a real outcome, never 'error')", op15.verdict === "fail");
    const ev15 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(15) the timeout's OWN distImporterCheckOnly event" });
    check("(15) the event carries timedOut:true and mechanismLike:false", ev15.detail.timedOut === true && ev15.detail.mechanismLike === false);
    const nudge15 = await waitUntil(() => ctx.spy.nudges[0], { label: "(15) the timeout nudge" });
    check("(15) the nudge names it a TIMEOUT, never a harness/usage error or an '(unnamed)' placeholder", nudge15.text.includes("TIMED OUT") && !nudge15.text.includes("harness") && !nudge15.text.includes("(unnamed)"));
  }

  // ── (16) CUT-FAIL mechanism failure (R3-3): createWorktree itself fails — a mechanism failure with
  // cleanup asserted (nothing was ever cut, so cleanup is a true no-op, not a leak) ──────────────────
  {
    const P = mk("cutfail"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, { distImporterCheckCreateWorktree: async () => { throw new Error("synthetic cut failure (card cee17efe round-3 proof)"); } });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 16;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(16) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op16 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(16) the check's own pending-gate-op settled" });
    check("(16) the pending-gate-op settled as 'error' (a cut failure is a mechanism failure, never a fail/pass verdict)", op16.verdict === "error");
    const ev16 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(16) the cut-fail's OWN distImporterCheckOnly event" });
    check("(16) the event carries mechanismLike:true", ev16.detail.mechanismLike === true);
    const hist16 = gateHistoryRowFor(db, P.projId, op16.opId);
    check("(16) gate_history projects this row as outcome:'error' (never 'reject')", hist16?.outcome === "error");
    check("(16) gate_history projects gateRan:false (a cut failure never spawns a real gate process)", hist16?.gateRan === false);
    const nudge16 = await waitUntil(() => ctx.spy.nudges[0], { label: "(16) the mechanism-failure nudge" });
    check("(16) the nudge names the synthetic cut failure, distinct from a real test red", nudge16.text.includes("synthetic cut failure") && nudge16.text.includes("could not run") && !nudge16.text.includes("FAILED:"));
    check("(16) CLEANUP (worktree): nothing was ever cut, so cleanup is a true no-op", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    const survivors16 = await survivorBranches(P.repo, w.branch);
    check(`(16) CLEANUP (branch): nothing was ever cut, so cleanup is a true no-op (found: ${survivors16.join(", ") || "none"})`, survivors16.length === 0);
  }

  // ── (17) SCAN-FAIL mechanism failure (R3-3): the direct-importer scan itself fails AFTER a real cut
  // + build — a mechanism failure with cleanup asserted (worktree + branch both removed) ─────────────
  {
    const P = mk("scanfail"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, { distImporterCheckComputeRunSet: async () => ({ ok: false, reason: "synthetic scan failure (card cee17efe round-3 proof)" }) });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 17;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(17) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op17 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(17) the check's own pending-gate-op settled" });
    check("(17) the pending-gate-op settled as 'error' (a scan failure is a mechanism failure, never a fail/pass verdict)", op17.verdict === "error");
    const ev17 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(17) the scan-fail's OWN distImporterCheckOnly event" });
    check("(17) the event carries mechanismLike:true", ev17.detail.mechanismLike === true);
    const hist17 = gateHistoryRowFor(db, P.projId, op17.opId);
    check("(17) gate_history projects this row as outcome:'error' (never 'reject')", hist17?.outcome === "error");
    check("(17) gate_history projects gateRan:false (a scan failure never spawns a real gate process)", hist17?.gateRan === false);
    const nudge17 = await waitUntil(() => ctx.spy.nudges[0], { label: "(17) the mechanism-failure nudge" });
    check("(17) the nudge names the synthetic scan failure, distinct from a real test red", nudge17.text.includes("synthetic scan failure") && nudge17.text.includes("could not run") && !nudge17.text.includes("FAILED:"));
    check("(17) CLEANUP (worktree): the real cut IS removed even though the scan itself failed", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    const survivors17 = await survivorBranches(P.repo, w.branch);
    check(`(17) CLEANUP (branch): the real cut's branch IS removed even though the scan itself failed (found: ${survivors17.join(", ") || "none"})`, survivors17.length === 0);
  }

  // ── (18) BOOT SWEEP, branch-only leftover (R3-4): the worktree DIR is already gone but the BRANCH
  // survives — the two used to be coupled under one existence check, silently stranding the branch ──
  {
    const P = mk("bootsweepbranch"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const crashedOpId = randomUUID();
    const crashedTaskId = `dist-importer-check-${crashedOpId}`;
    const crashedWt = await createWorktreeDirect(P.repo, P.projId, crashedTaskId);
    db.insertPendingGateOp({
      opId: crashedOpId, kind: "gate", key: `dist-importer-check:${crashedOpId}`, ownerSessionId: P.mgrId,
      projectId: P.projId, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false,
    });
    check("(18) [setup] the simulated worktree exists before the dir is removed by hand", fs.existsSync(crashedWt.worktreePath));
    check("(18) [setup] the branch exists too", listLoomBranches(P.repo).includes(crashedWt.branch));
    // Remove ONLY the worktree dir by hand (never through `removeWorktree`, which would also prune the
    // branch's own worktree registration cleanly) — simulates a partial prior cleanup, or an operator
    // manually clearing the dir, that left the branch behind.
    fs.rmSync(crashedWt.worktreePath, { recursive: true, force: true });
    execSync(`git worktree prune`, { cwd: P.repo }); // drop git's own stale worktree registration for the removed dir
    check("(18) [setup] the dir is gone but the branch still exists", !fs.existsSync(crashedWt.worktreePath) && listLoomBranches(P.repo).includes(crashedWt.branch));

    const swept = await ctx.sessions.sweepOrphanedDistImporterCheckWorktrees();
    check("(18) the sweep reports exactly ONE real removal (the branch-only leftover)", swept === 1);
    check("(18) the leftover branch is GONE after the sweep, even though its dir was already gone", !listLoomBranches(P.repo).includes(crashedWt.branch));
  }

  // ── (19) BOOT SWEEP control (R3-4): a REAL worker worktree (not a dist-importer-check one) survives
  // the sweep — proves the sweep only ever acts on `dist-importer-check:`-keyed pending_gate_ops rows ──
  {
    const P = mk("bootsweepsurvive"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 19;\n" });
    check("(19) [setup] the real worker worktree exists", fs.existsSync(w.worktreePath));
    check("(19) [setup] the real worker branch exists", listLoomBranches(P.repo).includes(w.branch));
    const swept = await ctx.sessions.sweepOrphanedDistImporterCheckWorktrees();
    check("(19) the sweep reports ZERO removals (no dist-importer-check: row exists for this project)", swept === 0);
    check("(19) the REAL worker worktree is UNTOUCHED", fs.existsSync(w.worktreePath));
    check("(19) the REAL worker branch is UNTOUCHED", listLoomBranches(P.repo).includes(w.branch));
  }

  // ── LEAD round-4 rulings (CR3 174f4ae4) ─────────────────────────────────────────────────────────────

  // ── (20) MID-PHASE CANCEL during BUILD (round-4 ruling 5): cancelSignal.aborted is checked right
  // after the build step — a RUNNING cancel landing WHILE build() is still awaiting settles via the
  // mid-phase "cancelled" outcome, never the gate-outcome branch (14) proves — gateSpawned:false here,
  // since the real --only-file= call is never reached ─────────────────────────────────────────────────
  {
    const P = mk("midcancel"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const buildHold = deferred();
    const buildState = { entered: false };
    const ctx = mkService(db, { distImporterCheckBuild: async () => { buildState.entered = true; await buildHold.promise; return { ok: true }; } });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 20;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(20) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await waitUntil(() => buildState.entered === true, { label: "(20) [setup] the build step has genuinely been entered (held on buildHold)", timeoutMs: 10_000 });
    const runningEntry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.distImporterCheckOnly === true && e.phase === "running"),
      { label: "(20) [setup] the check's own run is genuinely RUNNING (admitted, held inside the build step)", timeoutMs: 10_000 });
    check("(20) [setup] the running entry carries distImporterCheckOnly:true", !!runningEntry && runningEntry.distImporterCheckOnly === true);
    const aborted = runningEntry ? ctx.sessions.gateSemaphore.cancelRunning(runningEntry.id, "test mid-phase (build) cancel (card cee17efe round-4 proof)") : false;
    check("(20) the running-cancel call itself succeeded", aborted === true);
    buildHold.resolve({});
    await settleAllKicks(ctx.spy);
    const op20 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(20) the check's own pending-gate-op settled" });
    check("(20) the pending-gate-op settled as 'cancelled' (the MID-PHASE branch, never 'error'/'reject')", op20.verdict === "cancelled");
    const ev20 = await waitUntil(() => db.listEvents(P.mgrId).find((e) => e.kind === "worker_gate" && e.detail?.distImporterCheckOnly === true), { label: "(20) the mid-phase cancel's OWN distImporterCheckOnly event" });
    check("(20) the event carries cancelled:true and gateSpawned:false (the gate call was never reached)", ev20.detail.cancelled === true && ev20.detail.gateSpawned === false);
    const hist20 = gateHistoryRowFor(db, P.projId, op20.opId);
    check("(20) gate_history projects this row as outcome:'cancelled' with gateRan:false", hist20?.outcome === "cancelled" && hist20?.gateRan === false);
    check("(20) CLEANUP (worktree): no extra worktree dir survives a mid-phase cancel", onlyKnownWorktreeDirsLeft(P.projId, [w.taskId]));
    const survivors20 = await survivorBranches(P.repo, w.branch);
    check(`(20) CLEANUP (branch): no check branch survives a mid-phase cancel (found: ${survivors20.join(", ") || "none"})`, survivors20.length === 0);
  }

  // ── (21) WEDGED REMOVAL, in-run cleanup (round-4 ruling 1a): removeWorktree reports {removed:false,
  // wedged:true} — recordWorktreeWedgeAttempt must run and the background wedge-retry sweep must arm ──
  {
    const P = mk("wedgedinrun"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let wedgeAttemptCalls = 0;
    let armWedgeSweepCalls = 0;
    const ctx = mkService(db, { distImporterCheckRemoveWorktree: async () => ({ removed: false, wedged: true, aborted: false }) });
    // `db` here is the SAME instance `mkService` passed into `new SessionService(db, ...)` — patch it
    // directly rather than reaching through `ctx.sessions.db` (a `private`-in-TS, plain-at-runtime field).
    const origRecordWedge = db.recordWorktreeWedgeAttempt.bind(db);
    db.recordWorktreeWedgeAttempt = (...a) => { wedgeAttemptCalls++; return origRecordWedge(...a); };
    const origArmWedgeSweep = ctx.sessions.armWedgeSweep.bind(ctx.sessions);
    ctx.sessions.armWedgeSweep = (...a) => { armWedgeSweepCalls++; return origArmWedgeSweep(...a); };
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 21;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(21) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op21 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(21) the check's own pending-gate-op settled" });
    check("(21) recordWorktreeWedgeAttempt was called exactly once (the in-run cleanup path)", wedgeAttemptCalls === 1);
    check("(21) armWedgeSweep was called (the background wedge-retry sweep is armed)", armWedgeSweepCalls >= 1);
    // CLEANUP (test isolation, not production behavior): `distImporterCheckRemoveWorktree` is stubbed
    // wedged, so this run's own worktree dir is deliberately left on disk — but `pending_gate_ops` is
    // shared across every scenario's `Db()` in this FILE (same underlying sqlite file), and
    // `sweepOrphanedDistImporterCheckWorktrees` scans it GLOBALLY, unscoped by project. Left uncleaned,
    // this row (and its still-on-disk worktree) would be picked up and double-counted by (22)'s own
    // sweep call. Force-clean it directly (bypassing the stub) so (22) tests ONLY its own row.
    if (op21) {
      const taskIdForOp21 = `dist-importer-check-${op21.opId}`;
      const wtPath21 = path.join(WORKTREES_DIR, P.projId, taskKey(taskIdForOp21));
      try { fs.rmSync(wtPath21, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { execSync(`git worktree prune`, { cwd: P.repo }); } catch { /* best-effort */ }
      try { execSync(`git branch -D loom/${taskKey(taskIdForOp21)}`, { cwd: P.repo }); } catch { /* may already be gone — card cee17efe round-4 ruling 1a, this scenario's own test-isolation cleanup above */ }
    }
  }

  // ── (22) WEDGED REMOVAL, boot-sweep path (round-4 ruling 1a): the SAME assertion against
  // sweepOrphanedDistImporterCheckWorktrees — a wedged dir removal must ALSO route into the wedge-retry
  // machinery there, not just in the in-run cleanup path (21) proves ──────────────────────────────────
  {
    const P = mk("wedgedbootsweep"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let wedgeAttemptCalls = 0;
    let armWedgeSweepCalls = 0;
    const ctx = mkService(db, { distImporterCheckRemoveWorktree: async () => ({ removed: false, wedged: true, aborted: false }) });
    const origRecordWedge = db.recordWorktreeWedgeAttempt.bind(db);
    db.recordWorktreeWedgeAttempt = (...a) => { wedgeAttemptCalls++; return origRecordWedge(...a); };
    const origArmWedgeSweep = ctx.sessions.armWedgeSweep.bind(ctx.sessions);
    ctx.sessions.armWedgeSweep = (...a) => { armWedgeSweepCalls++; return origArmWedgeSweep(...a); };
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const crashedOpId = randomUUID();
    const crashedTaskId = `dist-importer-check-${crashedOpId}`;
    const crashedWt = await createWorktreeDirect(P.repo, P.projId, crashedTaskId);
    worktrees.push(crashedWt.worktreePath);
    db.insertPendingGateOp({
      opId: crashedOpId, kind: "gate", key: `dist-importer-check:${crashedOpId}`, ownerSessionId: P.mgrId,
      projectId: P.projId, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false,
    });
    check("(22) [setup] the simulated crash left a REAL worktree on disk", fs.existsSync(crashedWt.worktreePath));
    const swept = await ctx.sessions.sweepOrphanedDistImporterCheckWorktrees();
    check("(22) the sweep reports ZERO real removals (the stubbed removeWorktree never actually removed anything)", swept === 0);
    check("(22) recordWorktreeWedgeAttempt was called exactly once (the boot-sweep path)", wedgeAttemptCalls === 1);
    check("(22) armWedgeSweep was called (the background wedge-retry sweep is armed)", armWedgeSweepCalls >= 1);
  }

  // ── (23) card 02c5311d: the in-run cleanup's `deleteBranch` calls must NOT strip a branch that git
  //    still has checked out — `update-ref -d` (unlike `branch -D`) deletes a checked-out branch's ref
  //    anyway, so on a left-on-disk (not fully removed) worktree, the branch must survive post-cleanup.
  //    Distinct from (21)/(22) (wedged:true, which routes into the wedge-retry machinery) — this is the
  //    plain `removed:false, wedged:false` ("could not remove, non-fatal, left on disk") shape, which
  //    falls through the SAME listCheckedOutBranches guard. ───────────────────────────────────────────
  {
    const P = mk("branchsurvive"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, { distImporterCheckRemoveWorktree: async () => ({ removed: false, wedged: false, aborted: false }) });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 23;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(23) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op23 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(23) the check's own pending-gate-op settled" });
    check("(23) the check itself still passed (the stub only affects worktree removal, not the gate)", op23?.verdict === "pass");
    const checkTaskId = `dist-importer-check-${op23.opId}`;
    const checkWtPath = path.join(WORKTREES_DIR, P.projId, taskKey(checkTaskId));
    const checkBranch = `loom/${taskKey(checkTaskId)}`;
    check("(23) [setup] the stubbed removal left the worktree dir on disk, still a REAL registered git worktree",
      fs.existsSync(checkWtPath) && execSync("git worktree list --porcelain", { cwd: P.repo }).toString().includes(checkWtPath.replace(/\\/g, "/")));
    check("(23) the branch SURVIVES: git still has it checked out, so the CAS delete was skipped",
      listLoomBranches(P.repo).includes(checkBranch));
    // CLEANUP (test isolation, not production behavior): bypass the stub and force-remove the worktree +
    // branch directly, the same technique (21) uses, so this scenario's own leftover row/dir/branch never
    // confuses a later scenario's sweep (pending_gate_ops is shared across every Db() in this file).
    try { fs.rmSync(checkWtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { execSync(`git worktree prune`, { cwd: P.repo }); } catch { /* best-effort */ }
    try { execSync(`git branch -D ${checkBranch}`, { cwd: P.repo }); } catch { /* may already be gone */ }
  }

  // ── (24) card 02c5311d: the FAIL-CLOSED catch — if listCheckedOutBranches itself THROWS (an unreadable
  //    list), the guard must treat that as "still checked out" and skip the delete, never read a throw as
  //    "safe to delete". Ordinary flow (real cut + real removal both succeed) so the ONLY reason the
  //    branch could survive is this fail-closed catch, not a stubbed removal failure. ──────────────────
  {
    const P = mk("failclosed"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, {
      distImporterCheckListCheckedOutBranches: async () => { throw new Error("synthetic listCheckedOutBranches failure (card 02c5311d fail-closed proof)"); },
    });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 24;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(24) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op24 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(24) the check's own pending-gate-op settled" });
    check("(24) the check itself still passed (the stub only affects the branch-delete guard's own read)", op24?.verdict === "pass");
    const checkTaskId = `dist-importer-check-${op24.opId}`;
    const checkWtPath = path.join(WORKTREES_DIR, P.projId, taskKey(checkTaskId));
    const checkBranch = `loom/${taskKey(checkTaskId)}`;
    check("(24) [setup] the worktree itself WAS genuinely removed (real removal succeeded)", !fs.existsSync(checkWtPath));
    check("(24) the branch SURVIVES anyway: an unreadable listCheckedOutBranches fails CLOSED, never read as 'safe to delete'",
      listLoomBranches(P.repo).includes(checkBranch));
    // CLEANUP (test isolation): the worktree dir is already gone (real removal); only the branch survives.
    try { execSync(`git branch -D ${checkBranch}`, { cwd: P.repo }); } catch { /* may already be gone */ }
  }

  // ── (25) card 02c5311d: coverage for the DETERMINISTIC-PATH's own `expectedBranch` guard (round-3
  //    ruling 5's shape) — withTimeout races `createWorktree`, never cancels it, so a cut that loses the
  //    race can still land a REAL worktree+branch on disk in the background; worktreePath/branch stay
  //    unset for THIS invocation, so its finally cleanup takes the deterministic path. Shortens
  //    distImporterCheckProvisionTimeoutMs so the race fires in test time; the stub fully awaits the REAL
  //    cut (landing it for real) BEFORE holding its own return past the shortened timeout, so by the time
  //    the race fires the worktree is unconditionally already on disk — never a timing guess. ALSO stubs
  //    removal to fail (same technique as (23)) — otherwise the deterministic path's OWN worktree-removal
  //    attempt (round-3 ruling 5's self-heal) would succeed on its own and leave nothing for the
  //    `expectedBranch` guard to actually protect against, since a fully-removed worktree is no longer
  //    checked out by the time that guard runs. ──────────────────────────────────────────────────────
  {
    const P = mk("detpathsurvive"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db, {
      distImporterCheckProvisionTimeoutMs: 2_000,
      distImporterCheckRemoveWorktree: async () => ({ removed: false, wedged: false, aborted: false }),
      distImporterCheckCreateWorktree: async (...args) => {
        const real = await createWorktreeDirect(...args); // lands for REAL, fully, before any delay starts
        // TIMING-GUARD-SAFE: scripted-duration-margin — this IS the mocked subject's own scripted
        // internal latency (a test-set constant, not a wait inserted to gate a check): it's deliberately
        // sized past distImporterCheckProvisionTimeoutMs (2_000 above) so the race ALWAYS resolves via the
        // real withTimeout's own timer, deterministically — the assertions below never await or observe
        // this delay's own completion; they read filesystem/git state the source's synchronous finally
        // cleanup already settled once that timer fired.
        await new Promise((res) => setTimeout(res, 2_500));
        return real;
      },
    });
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, { "packages/daemon/src/foo.ts": "export const FOO = 25;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(25) landing merged ungated (gate-interval)", v.merged === true && v.skipReason === "gate-interval");
    await settleAllKicks(ctx.spy);
    const op25 = await waitUntil(() => db.listPendingGateOps().find((o) => o.projectId === P.projId && o.key.startsWith("dist-importer-check:") && o.state === "settled"),
      { label: "(25) the check's own pending-gate-op settled", timeoutMs: 10_000 });
    check("(25) the check settled as a mechanism failure (the cut 'timed out'; worktreePath/branch stayed unset)", op25?.verdict === "error");
    const checkTaskId = `dist-importer-check-${op25.opId}`;
    const checkWtPath = path.join(WORKTREES_DIR, P.projId, taskKey(checkTaskId));
    const checkBranch = `loom/${taskKey(checkTaskId)}`;
    check("(25) [setup] the REAL cut landed on disk anyway, and the stubbed removal left it there (still genuinely checked out)", fs.existsSync(checkWtPath));
    check("(25) the branch SURVIVES: the deterministic-path's own expectedBranch delete was guarded (git still has it checked out)",
      listLoomBranches(P.repo).includes(checkBranch));
    // CLEANUP (test isolation): bypass the stub and force-remove the real worktree + branch.
    try { fs.rmSync(checkWtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { execSync(`git worktree prune`, { cwd: P.repo }); } catch { /* best-effort */ }
    try { execSync(`git branch -D ${checkBranch}`, { cwd: P.repo }); } catch { /* may already be gone */ }
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the dist-importer check fires only for an ungated gate-interval landing that touches packages/daemon/src, runs a capped subset (never a skip) when the matched set is large, nudges a red run as a candidate while touching no gate counter, coalesces concurrent landings into one follow-up run, takes no per-repo guard, and cleans up its worktree/branch on both the pass and fail paths."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
