import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 7f86c02f — a confirm that throws AFTER its squash landed, with the recovery probe ALSO
// transiently broken, still classifies "unknown" and must be safely re-confirmable; see that record's
// "unknown and a landing are not mutually exclusive" section for the mechanism this file pins.
//
// Covers "pre" (finalizeMerge throws before any real work) / "post" (finalizeMerge completes in full,
// including its own merge_done append, THEN throws) x solo / solo-after-5s / batch-fallback (routes a
// single candidate through mergeBatchTracked's own "< 2 eligible" early-fallback into the SAME
// confirmWorkerMergeTracked solo path — see merge-batch-fallback-already-merged-idempotent.mjs's own
// header) / two-genuinely-concurrent re-confirms. ALSO covers the "may-have-landed rethrow" case (the
// recovery PROBE itself throwing, rather than returning a null result) for solo pre/post — reachable
// cheaply by swapping the probe's own fault shape, so included rather than left as a residual.
//
// Adapted from a Code Review fixture that forces both shapes via two injectable seams: `finalizeMerge`
// (patched to throw once, either before or after its real work) and `tipAcrossLandedCheck` (the
// recovery's own probe, patched to fail transiently then clear).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-post-squash-throw-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcps-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcps@loom -c user.name=mcps";
const git = (cwd, args) => execSync(`git ${GIT_ID} ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePtyStub() {
  const calls = [];
  return { calls, stop() {}, isAlive() { return false; }, getPid() { return undefined; }, enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); return { delivered: true }; } };
}

async function setup(sfx) {
  const reposDir = path.join(os.tmpdir(), `loom-mcps-repo-${sfx}`);
  registerForCleanup(reposDir);
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcps\n");
  execSync(`git init -q && git config user.email mcps@loom && git config user.name mcps`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const db = new Db();
  const mgrId = `mcps-m-${sfx}`, projId = `mcps-p-${sfx}`, taskId = `mcps-t-${sfx}`, workerId = `mcps-w-${sfx}`;
  db.insertProject({ id: projId, name: "MCPS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcps-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcps-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcps-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCPS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcps-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { db, repo, mgrId, taskId, workerId, branch, worktreePath };
}

// mode "pre": finalizeMerge throws BEFORE doing any real work (the squash already landed via mergeBranch,
// which runs before finalizeMerge is ever called). mode "post": finalizeMerge runs its real work in
// FULL — worktree removal, merge_done append, task move to done — THEN throws anyway. Either way, the
// recovery probe (tipAcrossLandedCheck) is ALSO forced to fail (or throw, for probeFault:"throw") while
// `st.broken`, simulating the SAME transient recovery fault that genuinely produces "unknown".
function rig(db, p, mode, probeFault = "null") {
  let gateCalls = 0;
  const s = new SessionService(db, p, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await sleep(50); return { passed: true, steps: [] }; },
    syncAttachBudgetMs: 60_000,
  });
  const realFinalize = s.finalizeMerge.bind(s);
  const realTip = s.tipAcrossLandedCheck.bind(s);
  const st = { armed: true, broken: false, finalizeCalls: 0 };
  s.finalizeMerge = async (args) => {
    st.finalizeCalls++;
    if (st.armed) {
      st.armed = false; st.broken = true;
      if (mode === "post") await realFinalize(args);
      throw new Error("[mcps] injected throw between squash and finalize completion");
    }
    return realFinalize(args);
  };
  // Falls through to the REAL probe once the fault clears — a permanent stub would also break the
  // ordinary "already landed, skip the gate" early-check path, which shares this same method.
  s.tipAcrossLandedCheck = async (repoPath, branch, fn) => {
    if (st.broken) {
      if (probeFault === "throw") throw new Error("[mcps] recovery probe itself threw");
      return { result: null };
    }
    return realTip(repoPath, branch, fn);
  };
  return { s, st, gate: () => gateCalls };
}
const mergeDoneCount = (db, w) => db.listEventsForWorker(w).filter((e) => e.kind === "merge_done").length;
const commitCount = (repo) => Number(git(repo, "rev-list --count HEAD"));

// ── MAIN MATRIX: pre/post x solo/solo-after-5s/batch/concurrent ────────────────────────────────────────
for (const mode of ["pre", "post"]) {
  for (const route of ["solo", "solo-after-5s", "batch", "concurrent"]) {
    const tag = `[${mode}/${route}]`;
    const sfx = `${mode}-${route}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { db, repo, mgrId, taskId, workerId, worktreePath } = await setup(sfx);
    const p = makePtyStub();
    const { s, st, gate } = rig(db, p, mode);
    const base = commitCount(repo);

    const r1 = await s.confirmWorkerMergeTracked(mgrId, workerId);
    check(`${tag} first confirm settles ok:false (thrown -> classified unknown)`, r1.settled === true && r1.ok === false);
    check(`${tag} the squash DID land exactly once (mergeBranch runs before finalizeMerge)`, commitCount(repo) === base + 1);
    check(`${tag} after first: merge_done count is ${mode === "post" ? 1 : 0}`, mergeDoneCount(db, workerId) === (mode === "post" ? 1 : 0));
    check(`${tag} after first: worktree ${mode === "pre" ? "still exists" : "already removed"}`, fs.existsSync(worktreePath) === (mode === "pre"));
    check(`${tag} after first: task column is ${mode === "pre" ? "in_progress" : "done"}`, db.getTask(taskId)?.columnKey === (mode === "pre" ? "in_progress" : "done"));
    check(`${tag} after first: peek's own outcome is "unknown"`, s.pendingOps.peek(`merge:${workerId}`)?.outcome === "unknown");

    st.broken = false; // the transient recovery fault clears before the re-confirm

    if (route === "solo-after-5s") await sleep(5600); // past MERGE_OP_RETAIN_MS — the TTL map can't save a cache hit here either way

    if (route === "batch") {
      const b = await s.mergeBatchTracked(mgrId, [workerId]);
      const fb = b.value?.fallback?.find((f) => f.workerSessionId === workerId);
      check(`${tag} batch settles synchronously via the '< 2 eligible' early-fallback path`, b.settled === true && b.ok === true);
      check(`${tag} the fallback candidate's own confirm actually started`, fb !== undefined && fb.started === true);
    } else if (route === "concurrent") {
      const [a, b] = await Promise.all([s.confirmWorkerMergeTracked(mgrId, workerId), s.confirmWorkerMergeTracked(mgrId, workerId)]);
      check(`${tag} both concurrent re-confirms resolve merged:true`, a.ok === true && b.ok === true && a.value?.merged === true && b.value?.merged === true);
      check(`${tag} both concurrent re-confirms dedupe-attach to the SAME real op (never two squashes)`, a.value?.opId === b.value?.opId);
    } else {
      const r2 = await s.confirmWorkerMergeTracked(mgrId, workerId);
      check(`${tag} re-confirm resolves merged:true via ALREADY_MERGED`, r2.ok === true && r2.value?.merged === true);
      check(`${tag} re-confirm is NOT a cache hit — "unknown" was never cached, this is a genuinely fresh run`, r2.cacheHit === undefined);
    }

    check(`${tag} NO second squash commit landed on main`, commitCount(repo) === base + 1);
    check(`${tag} EXACTLY ONE merge_done total — finalizeMerge's OWN replay-suppression (decision e34d475c round 7) dedupes it, not this card's fix`, mergeDoneCount(db, workerId) === 1);
    check(`${tag} task finished in its terminal (done) column`, db.getTask(taskId)?.columnKey === "done");
    check(`${tag} worktree removed`, !fs.existsSync(worktreePath));
    check(`${tag} the gate ran exactly once (the re-confirm never re-gates — it finds the landing, not a reason to re-test)`, gate() === 1);

    const nudgeTags = p.calls.filter((c) => c.sessionId === mgrId).map((c) => (c.text.match(/^\[loom:[a-z-]+\]/) || ["?"])[0]);
    const failedOrUnknownNudges = nudgeTags.filter((t) => t === "[loom:merge-failed]" || t === "[loom:merge-unknown]" && false); // merge-unknown from r1 is expected/fine; only merge-failed is a hard violation
    check(`${tag} NEVER a [loom:merge-failed] nudge anywhere in this flow`, nudgeTags.every((t) => t !== "[loom:merge-failed]"));
    // Empirically pinned (verified directly against this exact rig, both routes, 3 runs each — not
    // re-derived from theory): "pre" gets exactly one [loom:already-merged] push from the re-confirm;
    // "post" gets none at all (the re-confirm's own ALREADY_MERGED resolution carries `notified:false` —
    // the first call's real finalize already owns this worker's one legitimate completion signal).
    const alreadyMergedNudges = nudgeTags.filter((t) => t === "[loom:already-merged]");
    check(`${tag} [loom:already-merged] nudge count matches the known mode-specific shape (pre:1, post:0)`, alreadyMergedNudges.length === (mode === "pre" ? 1 : 0));

    db.close();
  }
}

// ── MAY-HAVE-LANDED RETHROW: the recovery PROBE itself throws (not just "found nothing") ───────────────
// A distinct code shape from the main matrix above: `tipAcrossLandedCheck` throwing propagates OUT of
// confirmWorkerMergeTracked's own catch block uncaught (replacing, not wrapping, the original error) —
// reachable cheaply by swapping the probe's fault from "returns null" to "throws", so covered here
// rather than left as a residual.
for (const mode of ["pre", "post"]) {
  const tag = `[probe-throws/${mode}]`;
  const sfx = `pt-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, repo, mgrId, taskId, workerId, worktreePath } = await setup(sfx);
  const p = makePtyStub();
  const { s, st, gate } = rig(db, p, mode, "throw");
  const base = commitCount(repo);

  const r1 = await s.confirmWorkerMergeTracked(mgrId, workerId);
  check(`${tag} first confirm settles ok:false (the PROBE's own throw replaces the original error, still classified unknown)`, r1.settled === true && r1.ok === false);
  st.broken = false;
  const r2 = await s.confirmWorkerMergeTracked(mgrId, workerId);
  check(`${tag} re-confirm resolves merged:true via ALREADY_MERGED`, r2.ok === true && r2.value?.merged === true);
  check(`${tag} NO second squash commit landed on main`, commitCount(repo) === base + 1);
  check(`${tag} EXACTLY ONE merge_done total`, mergeDoneCount(db, workerId) === 1);
  check(`${tag} task finished in its terminal (done) column`, db.getTask(taskId)?.columnKey === "done");
  check(`${tag} worktree removed`, !fs.existsSync(worktreePath));
  check(`${tag} the gate ran exactly once`, gate() === 1);

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a confirm that throws AFTER its squash has already landed (before OR after finalizeMerge's own real work, including a already-filed merge_done), while the recovery's own probe is ALSO transiently broken (returning nothing, or itself throwing), still classifies 'unknown' rather than a false failure; a later re-confirm (across solo/solo-after-5s/batch-fallback/two-genuinely-concurrent routes) finds the real landing and resolves merged:true, with finalizeMerge's own pre-existing replay-suppression (never this card's fix) keeping merge_done at exactly one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
