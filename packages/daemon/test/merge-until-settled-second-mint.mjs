import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 08e4b661 — never recover a `{settled:false}` op's outcome by re-invoking
// `confirmWorkerMergeTracked` a second time: a re-call landing after the first op settles+evicts mints a
// genuinely SECOND real op and silently reports ITS outcome/opId instead of the first op's real result.
//
// Covers:
//   (1) THE BUG'S OWN SHAPE: the first op settles+evicts during the retry's own pre-attach identity read
//       (same seam technique as merge-confirm-supersede-mint-window.mjs). Pre-fix this mints a second real
//       op (2 durable rows, wrong opId reported) — RED-proofed below via a temporary revert/rebuild/
//       restore cycle, since there is no bogus-pattern negative control for "which code path ran". Post-fix:
//       exactly ONE pending_gate_ops row ever exists for the key, and the returned opId is the FIRST (and
//       only) op minted.
//   (2) THE ADJACENT RACE (explicitly requested, card 08e4b661 review): the first op settles strictly
//       AFTER confirmWorkerMergeUntilSettled's own first attach() call already returned {settled:false},
//       but BEFORE its awaitSettleByOpId call is even invoked. recordSettleByOpId writes unconditionally
//       at settle time (before the identity-guarded entries.delete), so the wait must still return the
//       first op's real outcome immediately — never `undefined`.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-until-settled-second-mint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mussm-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mussm@loom -c user.name=mussm";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const gateSpawnedAtLeastOnce = (getCalls, label) => waitUntil(() => (getCalls() >= 1 ? true : undefined), { timeoutMs: 30_000, label });

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mussm\n");
  execSync(`git init -q && git config user.email mussm@loom && git config user.name mussm`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const dbs = [];

async function setupWorkerProject(sfx, reposDir) {
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  const mgrId = `mussm-mgr-${sfx}`, projId = `mussm-p-${sfx}`, taskId = `mussm-t-${sfx}`, workerId = `mussm-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  const config = { orchestration: { gateCommand: "pnpm gate", gateCommandTimeoutMs: 60_000 } };
  db.insertProject({ id: projId, name: "MUSSM", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mussm-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mussm-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mussm-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MUSSM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mussm-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, mgrId, projId, taskId, workerId, worktreePath };
}

// ── (1) THE BUG'S OWN SHAPE — op 1 settles+evicts during the retry's own pre-attach identity read ─────
{
  const sfx = `mint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mussm-mint-${sfx}`);
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfx, reposDir);
  const key = `merge:${workerId}`;

  let gateCalls = 0;
  let releaseGate1;
  const gateHold1 = new Promise((res) => { releaseGate1 = res; });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; if (gateCalls === 1) { await gateHold1; } return { passed: true, steps: [] }; },
    // Tiny syncAttachBudgetMs so the FIRST confirmWorkerMergeTracked call degrades to {settled:false}
    // quickly (op 1's gate is held open) — otherwise there is no pending result to recover at all.
    syncAttachBudgetMs: 100,
  });

  // Force verdictIdentity to resolve `undefined` on EVERY call — the documented fail-safe path (3a460d4a
  // doc: "only falls back to undefined when resolution genuinely FAILS"). Combined with op 1 settling+
  // evicting during a retry's pre-attach read, this is exactly the shape 3a460d4a's own "Cost" section
  // named as reachable in production — no injected throw needed.
  //
  // TWO RELEASE TRIGGERS, exactly one of which ever fires (guarded by `released`):
  //  - PRIMARY (readerCalls===2): fires on the OLD, pre-fix retry's own SECOND pre-attach identity read —
  //    this is the real race, timed to release op 1's gate (once it has genuinely spawned) strictly
  //    BEFORE that retry's own (pre-fix) second `attach()` call, reproducing the bug deterministically
  //    when this file is run against reverted (pre-08e4b661) code.
  //  - FALLBACK (gate spawned + a short grace): the FIXED code calls confirmMergeBranchTipReader exactly
  //    ONCE ever (there is no retry to make a 2nd call), so the primary trigger never fires against fixed
  //    code — this fallback is what actually releases the gate in that case, letting op 1 complete
  //    normally while confirmWorkerMergeUntilSettled sits in its own awaitSettleByOpId wait.
  let readerCalls = 0;
  let released = false;
  const releaseOnce = async (reason) => {
    if (released) return;
    released = true;
    releaseGate1("go");
    const settledInTime = await sessions.pendingOps.waitBriefly(key, 30_000);
    check(`(mint) [setup] op 1 genuinely settled after release (${reason})`, settledInTime === true);
  };
  const realBranchTipReader = sessions.confirmMergeBranchTipReader;
  sessions.confirmMergeBranchTipReader = async (...args) => {
    readerCalls++;
    await realBranchTipReader(...args); // still perform the real read, just never use its result
    if (readerCalls === 2) {
      await gateSpawnedAtLeastOnce(() => gateCalls, "(mint) gate spawned before the primary release");
      await releaseOnce("primary — the pre-fix retry's own 2nd pre-attach identity read");
    }
    return undefined; // fail-safe: forces verdictIdentity to stay undefined on every call
  };
  const fallbackRelease = (async () => {
    await gateSpawnedAtLeastOnce(() => gateCalls, "(mint) gate spawned (fallback timing)");
    // Grace window: if a 2nd identity read is going to happen at all (pre-fix code), it happens within a
    // handful of syncAttachBudgetMs polls of the first call returning pending — comfortably under this.
    await new Promise((res) => setTimeout(res, 500));
    await releaseOnce("fallback — fixed code never makes a 2nd pre-attach identity read");
  })();

  const r = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  await fallbackRelease;
  sessions.confirmMergeBranchTipReader = realBranchTipReader;

  check("(mint) [setup] the gate was genuinely released exactly once (precondition)", released === true);
  console.log(`(mint) [info] readerCalls=${readerCalls} (2 means the primary/pre-fix race path fired; 1 means the fixed code's single-call path, fallback released)`);
  check("(mint) the call settled ok", r.settled === true && r.ok === true);
  check("(mint) the merge landed", r.ok && r.value?.merged === true);

  const rows = db.listPendingGateOps().filter((row) => row.key === key);
  check("(mint) THE FIX — exactly ONE pending_gate_ops row exists for this key, never two", rows.length === 1);
  check("(mint) THE FIX — the returned opId is the ONE row's opId (the first and only op minted, never a dropped/orphaned first op)",
    r.ok && rows.length === 1 && r.value.opId === rows[0].opId);

  fs.rmSync(worktreePath, { recursive: true, force: true });
}

// ── (2) THE ADJACENT RACE — op 1 settles AFTER the first attach() returns {settled:false} but BEFORE
//        awaitSettleByOpId is even called. recordSettleByOpId writes unconditionally at settle time
//        (before the identity-guarded entries.delete), so the wait must still recover op 1's real outcome
//        immediately — never `undefined` — even though, by the time the real scan runs, the entry may
//        already be gone from `entries` and reachable only via the settledByOpId fallback.
{
  const sfx = `adjacent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mussm-adjacent-${sfx}`);
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfx, reposDir);
  const key = `merge:${workerId}`;

  let gateCalls = 0;
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await gateHold; return { passed: true, steps: [] }; },
    syncAttachBudgetMs: 100, // degrade the FIRST attach() quickly, same reason as scenario (1)
  });

  const realAwaitSettleByOpId = sessions.pendingOps.awaitSettleByOpId.bind(sessions.pendingOps);
  let wrapperCalls = 0;
  // TWO RELEASE TRIGGERS, exactly one of which does the actual release (guarded by `released`) — same
  // shape as scenario (1)'s dual-trigger design, added per card 08e4b661's Code Review round 2:
  //  - PRIMARY (wrapperCalls===1): the real awaitSettleByOpId call — releases the held gate and waits for
  //    op 1 to fully settle+evict strictly BEFORE calling through to the real implementation, so by the
  //    time the real scan over `entries` runs, the entry is already gone and the result can ONLY come
  //    from the unconditional settledByOpId fallback.
  //  - FALLBACK (gate spawned + a short grace): a REGRESSION to the old retry loop never calls
  //    awaitSettleByOpId at all, so the primary trigger would never fire and the held gate would hang
  //    this scenario for its full ceiling instead of failing fast. This releases on an independent timer
  //    regardless, so a regression reports a named FAIL (wrapperCalls stays 0) instead of a multi-minute
  //    hang. Reproduced: reverting to commit 6ebb94ca (pre-this-card) and re-running this file without
  //    this fallback hung past a 120s cap; with it, scenario (2)'s own `wrapperCalls >= 1` check below
  //    fails cleanly instead.
  let released = false;
  const releaseOnce = async (reason) => {
    if (released) return;
    released = true;
    releaseGate("go");
    await gateSpawnedAtLeastOnce(() => gateCalls, "(adjacent) gate spawned");
    const settledInTime = await sessions.pendingOps.waitBriefly(key, 30_000);
    check(`(adjacent) [setup] op 1 genuinely settled before release completes (${reason})`, settledInTime === true);
  };
  sessions.pendingOps.awaitSettleByOpId = async (opId, timeoutMs) => {
    wrapperCalls++;
    if (wrapperCalls === 1) {
      await releaseOnce("primary — awaitSettleByOpId's real first call");
    }
    return realAwaitSettleByOpId(opId, timeoutMs);
  };
  const fallbackRelease = (async () => {
    await gateSpawnedAtLeastOnce(() => gateCalls, "(adjacent) gate spawned (fallback timing)");
    await new Promise((res) => setTimeout(res, 500));
    await releaseOnce("fallback — awaitSettleByOpId was never called (regression to the old retry loop)");
  })();

  const r = await sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  await fallbackRelease;
  sessions.pendingOps.awaitSettleByOpId = realAwaitSettleByOpId;

  check("(adjacent) THE FIX — awaitSettleByOpId WAS actually called; a regression to the old retry loop never calls it at all", wrapperCalls >= 1);
  check("(adjacent) wrapperCalls === 1 (awaitSettleByOpId called exactly once, never a re-invoke)", wrapperCalls === 1);
  check("(adjacent) THE FIX — the wait recovered the REAL outcome, never undefined/timed-out", r.settled === true && r.ok === true);
  check("(adjacent) the merge landed", r.ok && r.value?.merged === true);

  const rows = db.listPendingGateOps().filter((row) => row.key === key);
  check("(adjacent) exactly ONE pending_gate_ops row — no second op minted by this race either", rows.length === 1);
  check("(adjacent) the returned opId matches the one real op's opId", r.ok && rows.length === 1 && r.value.opId === rows[0].opId);

  fs.rmSync(worktreePath, { recursive: true, force: true });
}

// ── (3) THE OK:FALSE MAPPING — run() THROWS strictly after the sync budget (op 1's first attach() has
//        already degraded to {settled:false}, so the throw is recovered via awaitSettleByOpId, never the
//        fast synchronous path). Proves settled.ok===false preserves the ORIGINAL thrown error (never
//        stringified/wrapped), and that the REST route's own mapping (gateway/server.ts: `r.error
//        instanceof Error ? r.error.message : String(r.error)`, 400) produces the expected body.
{
  const sfx = `throw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-mussm-throw-${sfx}`);
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfx, reposDir);
  const key = `merge:${workerId}`;

  const thrownError = new Error("fake gate throw — scenario (3)");
  let gateCalls = 0;
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await gateHold; throw thrownError; },
    syncAttachBudgetMs: 100, // degrade the FIRST attach() quickly, same reason as scenarios (1)/(2)
  });

  const rPromise = sessions.confirmWorkerMergeUntilSettled(mgrId, workerId);
  await gateSpawnedAtLeastOnce(() => gateCalls, "(throw) gate spawned");
  // Decisive buffer (not merely "probably already past it"): syncAttachBudgetMs is 100ms, so 150ms more
  // of real elapsed time guarantees the first attach() call has already returned {settled:false} and
  // this method is genuinely sitting in its own awaitSettleByOpId wait before the throw ever happens.
  await new Promise((res) => setTimeout(res, 150));
  releaseGate("go"); // let the held gate call now throw — strictly after the sync budget has elapsed
  const r = await rPromise;

  check("(throw) settled with ok:false — the thrown op's outcome was genuinely recovered via the awaitSettleByOpId wait", r.settled === true && r.ok === false);
  check("(throw) the ORIGINAL thrown error object identity is preserved (never stringified/wrapped)", r.ok === false && r.error === thrownError);

  // Mirrors gateway/server.ts's own `/api/sessions/:id/merge` mapping exactly (see that route's own
  // code): `if (!r.ok) return reply.code(400).send({ error: r.error instanceof Error ? r.error.message : String(r.error) });`
  const restStatusCode = r.ok === false ? 400 : 200;
  const restBody = r.ok === false ? { error: r.error instanceof Error ? r.error.message : String(r.error) } : undefined;
  check("(throw) the REST route's own mapping produces a 400 with the thrown error's message", restStatusCode === 400 && restBody?.error === thrownError.message);

  const rows = db.listPendingGateOps().filter((row) => row.key === key);
  check("(throw) exactly ONE pending_gate_ops row — no second op minted by the throw path either", rows.length === 1);

  fs.rmSync(worktreePath, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeUntilSettled recovers a pending op's own verdict by its opId " +
    "(never by re-invoking confirmWorkerMergeTracked): exactly one real op is ever minted per logical " +
    "call even when the first op settles+evicts during a would-be retry's own pre-attach identity read, " +
    "the adjacent settle-before-await race resolves to the real outcome immediately (never undefined, " +
    "and a regression to the old retry loop now fails this check instead of hanging), and a thrown " +
    "confirm's settled.ok:false path preserves the original error through to the REST route's own mapping."
  : `\n❌ ${failures} FAILURE(S).`);

for (const db of dbs) try { db.close(); } catch { /* ignore */ }

process.exit(failures === 0 ? 0 : 1);
