import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression tests for card 361520a0, Half One — the human REST merge route (`POST /api/sessions/:id/merge`,
// the Review panel's "Human-initiated merge") used to call the RAW, untracked `confirmWorkerMerge` directly:
// no PendingOpRegistry dedupe, no durable `pending_gate_ops` tombstone. The incident this fixes: an owner
// clicking Merge while a manager's own `worker_merge_confirm` was already running on the SAME worker minted
// a genuine SECOND gate run instead of attaching to the first, and the owner-minted op left NO row for
// `gate_status`/`gate_history` to ever find (§THE DECISIVE CLUE in the card).
//
// Exercises `SessionService.confirmWorkerMergeUntilSettled` directly — the exact method the gateway's REST
// handler calls — rather than standing up a full fastify server, since the REST handler itself is a thin
// shape-adapter over this method (see gateway/server.ts's own `/api/sessions/:id/merge`).
//
// Covers:
//   (1) a merge confirmed ONLY through the REST-style call now leaves a REAL `pending_gate_ops` row —
//       negative control (zero rows before) pasted alongside the positive (one row after).
//   (2) a REST-style call and an MCP-style `confirmWorkerMergeTracked` call, fired concurrently on the SAME
//       worker, attach to ONE real gate invocation and ONE `pending_gate_ops` row — never two.
//   (3) the bounded wait ceiling: while the gate is still genuinely running past the ceiling, the REST-style
//       call reports NOT settled — never a synthesized `merged:false` — and a later re-attach (once the gate
//       actually finishes) returns the real settled result.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-rest-route-tracked.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 43f5b242: a local `waitUntil` used to be defined here but had ZERO call sites in this file —
// dead code, removed rather than converted (nothing depended on its behavior).
const GIT_ID = "-c user.email=mrt@loom -c user.name=mrt";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mrt\n");
  execSync(`git init -q && git config user.email mrt@loom && git config user.name mrt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, reposDir, { gateCommandTimeoutMs, mgrProcessState = "live" } = {}) {
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  const mgrId = `mrt-mgr-${sfx}`, projId = `mrt-p-${sfx}`, taskId = `mrt-t-${sfx}`, workerId = `mrt-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand: "pnpm gate", ...(gateCommandTimeoutMs ? { gateCommandTimeoutMs } : {}) } };
  db.insertProject({ id: projId, name: "MRT", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mrt-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  // LIVE by default, not "exited": SessionService.isManagerSessionDead treats an "exited" manager as a dead
  // owner and EVICTS any pre-existing op under this key so a fresh confirm can proceed — correct production
  // behavior, but wrong for tests (1)-(3), which deliberately race a SECOND call against an op the first
  // call already minted (a real manager driving a merge is live, never exited, mid-confirm). Test (4) below
  // is the deliberate exception — it passes mgrProcessState:"exited" to reproduce the REST route's own real
  // shape (worker.parentSessionId, which a human clicking Merge has no reason to expect is live).
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mrt-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: mgrProcessState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mrt-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MRT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  worktrees.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mrt-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId };
}

// ── (1) A REST-style confirm alone leaves a REAL pending_gate_ops row — negative control (0 before) +
//        positive (1 after, settled, verdict:pass). This is the exact gap §THE DECISIVE CLUE measured: the
//        owner-minted op `f7cb473e` had NO row at all because the old REST route bypassed the Tracked path.
{
  const sfx = `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mrt-row-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir);
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });

  check("(row) NEGATIVE CONTROL — zero pending_gate_ops rows before any confirm", db.listPendingGateOps().length === 0);

  const result = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  check("(row) the REST-style confirm settles ok", result.settled === true && result.ok === true);
  check("(row) the merge actually landed", result.ok && result.value?.merged === true);

  const rows = db.listPendingGateOps();
  check("(row) POSITIVE — exactly ONE pending_gate_ops row now exists for a REST-only confirm", rows.length === 1);
  check("(row) the row is for this worker's merge key", rows[0]?.key === `merge:${workerId}`);
  check("(row) the row settled with a pass verdict", rows[0]?.state === "settled" && rows[0]?.verdict === "pass");
}

// ── (2) THE CORE FIX: a REST-style call and an MCP-style call on the SAME worker, fired concurrently,
//        attach to ONE real gate invocation and ONE durable row — never two (the duplicate-mint this card
//        exists to prevent). Modeled on the card's own incident: two live ops, same task, same branch.
{
  const sfx = `dedupe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mrt-dedupe-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir);
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await sleep(30); return { passed: true }; },
  });

  // Fired back-to-back with NO await between them — both calls race PendingOpRegistry.attach's own
  // synchronous no-await window on the SAME key (merge:${workerId}), exactly like the real incident: the
  // owner's REST click landing while the manager's own worker_merge_confirm was already in flight.
  const pRest = sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  const pMcp = sessions.confirmWorkerMergeTracked(mgrId, workerId);

  const [restResult, mcpResult] = await Promise.all([pRest, pMcp]);

  check("(dedupe) the real gate command ran EXACTLY ONCE — never a second, duplicate op", gateCalls === 1);
  check("(dedupe) the REST-style call settled ok and merged", restResult.settled === true && restResult.ok === true && restResult.value?.merged === true);
  check("(dedupe) the MCP-style call settled ok and merged", mcpResult.settled === true && mcpResult.ok === true && mcpResult.value?.merged === true);
  check("(dedupe) BOTH calls report the SAME opId — they attached to ONE op, not two",
    restResult.ok && mcpResult.ok && restResult.value.opId === mcpResult.value.opId);

  const rows = db.listPendingGateOps().filter((r) => r.key === `merge:${workerId}`);
  check("(dedupe) exactly ONE pending_gate_ops row exists for this worker — not two (the §THE DECISIVE CLUE gap)", rows.length === 1);
}

// ── (3) Bounded wait ceiling honesty: while the gate is still genuinely running past the ceiling, the
//        REST-style wrapper reports NOT settled — never a synthesized `merged:false` (a false negative here
//        would invite exactly the duplicate re-click this card exists to prevent). A tiny configured
//        gateCommandTimeoutMs (the schema minimum, 1000ms) gives a 6x ceiling of 6s — small enough to
//        actually wait out in a targeted test run. syncAttachBudgetMs is also shrunk so the wrapper's own
//        loop polls the deadline every ~150ms instead of in one 12s (default) attach call.
{
  const sfx = `ceiling-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mrt-ceiling-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir, { gateCommandTimeoutMs: 1000 });
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  let gateSpawned = false;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateSpawned = true; await gateHold; return { passed: true }; },
    syncAttachBudgetMs: 150,
  });

  const startedAt = Date.now();
  const pendingResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  const elapsedMs = Date.now() - startedAt;

  check("(ceiling) the gate genuinely spawned (setup sanity)", gateSpawned === true);
  check("(ceiling) the wrapper gave up as NOT settled once the ceiling passed", pendingResult.settled === false);
  check("(ceiling) it NEVER synthesizes a false merged:false — there is simply no `value` on a settled:false result",
    pendingResult.settled === false && pendingResult.value === undefined);
  check("(ceiling) it waited roughly the configured ceiling (~6s), not the old default 12s sync-attach budget",
    elapsedMs >= 5000 && elapsedMs < 11000);
  check("(ceiling) it reports the real op's opId so a caller can poll/match it later", typeof pendingResult.op?.opId === "string");

  // Release the gate and re-attach (a caller re-clicking Merge, or the Review panel re-polling) — proves
  // this is a genuine re-attach loop, not a broken one-shot: the SAME op eventually settles for real.
  // Card 6144fe32: a NAIVE immediate re-attach here races a REAL git squash (union-merge/checkout/squash,
  // real subprocess work, NOT covered by the stubbed `runGate`) against confirmWorkerMergeUntilSettled's
  // OWN ceiling (gateCommandTimeoutMs*6 — 6s at this test's tiny 1000ms knob), which is sized as a GATE
  // budget, not a "cover an unbounded git subprocess" budget — under host load the squash can outlast it,
  // and this exact assertion goes red for a reason that has nothing to do with the behavior under test.
  // Wait on the REAL settle CONDITION instead (waitBriefly races the op's own settle promise, the same
  // primitive the "(dead-owner)" block below already uses for this identical hazard) — bounded by a
  // generous OUTER cap so a genuinely-stuck op still fails the assertion below instead of hanging forever.
  releaseGate("go");
  await sessions.pendingOps.waitBriefly(`merge:${workerId}`, 30_000);
  const finalResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  check("(ceiling) a later re-attach on the SAME worker returns the REAL settled result", finalResult.settled === true && finalResult.ok === true);
  check("(ceiling) the merge actually landed once the gate was released", finalResult.ok && finalResult.value?.merged === true);
  check("(ceiling) the re-attach's opId matches the one the timed-out call already reported",
    finalResult.ok && finalResult.value.opId === pendingResult.op?.opId);
}

// ── (4) THE CRITICAL FIX (Code Review, card 361520a0, Half Four): a human clicking Merge derives
//        managerSessionId from worker.parentSessionId — a manager that need not be the one driving THIS
//        merge, and can easily be dead (recycled/stopped) by the time the click lands. Before the fix, EVERY
//        loop iteration inside confirmWorkerMergeUntilSettled re-ran confirmWorkerMergeTracked's per-call
//        dead-owner check, which evicted the RUNNING op it had itself minted moments earlier (its
//        managerSessionId is the same dead manager on every check) and re-minted a genuinely fresh
//        confirmWorkerMerge call — each one running a real `git merge main` and queuing a real gate command
//        — on EVERY ~syncAttachBudgetMs poll. Reproduced here with the SAME shape the reviewer's own probe
//        used: a tiny gateCommandTimeoutMs (6s ceiling) and a tiny syncAttachBudgetMs (50ms) so the loop
//        genuinely iterates roughly 100+ times inside one confirmWorkerMergeUntilSettled call — a held-open
//        gate (never resolves on its own) proves those iterations really are polling an in-flight op, not
//        racing straight to settlement on the first try.
{
  const sfx = `dead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mrt-dead-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir, { gateCommandTimeoutMs: 1000, mgrProcessState: "exited" });
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await gateHold; return { passed: true }; },
    syncAttachBudgetMs: 50,
  });

  // Spy on console.warn to count the dead-owner eviction log line directly — the FIRST call mints a
  // genuinely fresh op (nothing pre-existing to evict, so this must be 0 even on call 1), and every retry
  // after that must skip the check entirely (opts.skipDeadOwnerRecovery) rather than re-evaluating it
  // against the now-running op it just minted — so this must stay 0 across the WHOLE call, not just once.
  let evictionWarnings = 0;
  const origWarn = console.warn;
  console.warn = (...args) => { if (String(args[0]).includes("had a dead owner")) evictionWarnings++; origWarn(...args); };

  const startedAt = Date.now();
  const pendingResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  const elapsedMs = Date.now() - startedAt;
  console.warn = origWarn;

  check("(dead-owner) it genuinely looped for roughly the full 6s ceiling (proving MANY poll iterations happened, not a one-shot)",
    elapsedMs >= 5000 && elapsedMs < 11000);
  check("(dead-owner) it gave up as NOT settled once the ceiling passed (the gate is still genuinely running)", pendingResult.settled === false);
  check("(dead-owner) CRITICAL — the real gate command ran EXACTLY ONCE despite ~100+ poll iterations against a dead-owner op", gateCalls === 1);
  check("(dead-owner) the dead-owner eviction check never fired mid-loop (0 'had a dead owner' warnings)", evictionWarnings === 0);
  const deadRows = db.listPendingGateOps().filter((r) => r.key === `merge:${workerId}`);
  check("(dead-owner) CRITICAL — exactly ONE pending_gate_ops row exists — not the ~38-row eviction storm the pre-fix probe measured", deadRows.length === 1);
  check("(dead-owner) that one row is still 'pending' (the real op is genuinely still running, never evicted)", deadRows[0]?.state === "pending");

  // Release the gate — the SAME op the whole loop was polling settles for real, proving this isn't merely
  // "nothing bad happens because nothing ever runs": a real merge was genuinely in flight the whole time.
  // waitBriefly (NOT a fixed sleep — polls the real settle signal) closes a DIFFERENT race than the one
  // this test is about: the squash-merge/etc. after gateHold resolves is itself async, so re-attaching
  // IMMEDIATELY can land while the op is still (legitimately) "running" under the dead manager — a FRESH
  // top-level confirmWorkerMergeUntilSettled call is entitled to its OWN one-time dead-owner check (this is
  // two independent call sequences, not the internal retry loop Half Four fixes), so that race would evict
  // and re-mint a SECOND real invocation for reasons unrelated to the bug under test. Waiting for the
  // real op to settle first isolates what this assertion is actually about: once the in-flight op is done,
  // a later re-attach must dedupe against its RETAINED result, never mint a new one.
  releaseGate("go");
  await sessions.pendingOps.waitBriefly(`merge:${workerId}`, 8000);
  const finalResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  check("(dead-owner) once released, the SAME in-flight op settles for real and merges", finalResult.settled === true && finalResult.ok === true && finalResult.value?.merged === true);
  check("(dead-owner) still exactly ONE real gate invocation total — the later re-attach dedupes against the RETAINED result, never mints a second", gateCalls === 1);
}

// ── (5) POSITIVE CONTROL — the identical shape with a LIVE owner (Code Review, card 361520a0, Half Four:
//        "the live-owner control must stay green too — that is your positive control that the test can tell
//        the two apart"). Same tiny timings, same held-open gate, same ~100+ poll iterations — proves (4)'s
//        assertions aren't vacuously true of every shape this harness can construct: a live owner was
//        already never subject to the dead-owner eviction check (nothing to evict — isManagerSessionDead is
//        false), so this must show the identical exactly-one-invocation result as (4), confirming the fix
//        didn't have to special-case anything to get (4) right.
{
  const sfx = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mrt-live-${sfx}`);
  const { db, mgrId, workerId } = await setupWorkerProject(sfx, reposDir, { gateCommandTimeoutMs: 1000 });
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await gateHold; return { passed: true }; },
    syncAttachBudgetMs: 50,
  });

  const pendingResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  check("(live-owner control) it gave up as NOT settled once the ceiling passed, same as (4)", pendingResult.settled === false);
  check("(live-owner control) POSITIVE CONTROL — the real gate command ran EXACTLY ONCE, matching (4) — the dead-owner case isn't an outlier shape", gateCalls === 1);
  const liveRows = db.listPendingGateOps().filter((r) => r.key === `merge:${workerId}`);
  check("(live-owner control) exactly ONE pending_gate_ops row, matching (4)", liveRows.length === 1);

  // Card 6144fe32: the SAME wall-clock race as the "(ceiling)" block above — an immediate re-attach here
  // races a REAL git squash against confirmWorkerMergeUntilSettled's own 6x-gateCommandTimeoutMs ceiling
  // (6s at this test's tiny 1000ms knob), which is sized as a GATE budget, not a "wait out an unbounded git
  // subprocess" budget. This was the card's own named, live-reproduced failure — see the fix note above.
  releaseGate("go");
  await sessions.pendingOps.waitBriefly(`merge:${workerId}`, 30_000);
  const finalResult = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  check("(live-owner control) once released, the SAME op settles for real and merges", finalResult.settled === true && finalResult.ok === true && finalResult.value?.merged === true);
  check("(live-owner control) still exactly ONE real gate invocation total", gateCalls === 1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the REST merge route's confirmWorkerMergeUntilSettled shares the SAME PendingOpRegistry dedupe + durable pending_gate_ops tombstone as the MCP worker_merge_confirm path, a concurrent REST+MCP confirm on one worker never mints a duplicate op, the bounded wait ceiling never synthesizes a false 'not merged' while the real gate is still running, and — Half Four — a dead-owner manager (the REST route's own worker.parentSessionId shape) never re-evicts and re-mints the in-flight op on every internal poll: exactly one real gate invocation runs, matching a live owner's identical shape."
  : `\n❌ ${failures} FAILURE(S).`);

for (const db of dbs) try { db.close(); } catch { /* ignore */ }
for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(failures === 0 ? 0 : 1);
