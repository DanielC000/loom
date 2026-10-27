import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RED-FIRST FOR CARD e8e98d43 (docs/decisions/e8e98d43-*.md — read it for the full narrative, including
// this test's own evolution from two earlier, discarded designs; this header states only its mechanism):
// drives a REAL batch through the GENUINE `isBranchHeld` path (no stub) to a real `heldAtFinish` refusal
// for BOTH causes — (T) TRANSIENT via an injected `heldProbeGitFactory` git-read fault, (P) PERMANENT via
// a planted `batch_merge_branch_retained` event — asserting `finishRefused`/`landed` exclusion, the nudge,
// that a RE-FIRE while the cause persists is a genuine CACHE REPLAY, and that `worker_merge_confirm`
// called DIRECTLY on the candidate (never a `merge_batch` re-fire) is the real remedy.
// Run: 1) pnpm build, 2) node packages/daemon/test/mergebatch-finishalreadymerged-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbfr@loom -c user.name=mbfr";
const now = () => new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// card e8e98d43 (CR finding #8): `process.exit()` terminates the process immediately — a pending `finally`
// never runs, so a bare `process.exit()` inside the `try` below used to leak the temp LOOM_HOME (db never
// closed, cleanup never ran for the still-open handle). Exit ONLY after the try/finally has fully resolved.
let db;
try {
  const repo = path.join(os.tmpdir(), `loom-mbfr-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbfr\n");
  execSync(`git init -q && git config user.email mbfr@loom && git config user.name mbfr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const initSha = git(repo, ["rev-parse", "HEAD"]);

  const projId = `mbfr-proj-${sfx}`, agentId = `mbfr-agent-${sfx}`, mgrId = `mbfr-mgr-${sfx}`;
  db = new Db();
  db.insertProject({ id: projId, name: "MBFR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now(), archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now(), lastActivity: now(), lastError: null, role: "manager" });

  const cut = async (label) => {
    const taskId = `mbfr-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now(), updatedAt: now() });
    const workerId = `mbfr-wkr-${label}-${sfx}`;
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now(), lastActivity: now(), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { workerId, taskId, branch, worktreePath };
  };
  // Returns the `ts` it stamped, so a caller needing a STRICTLY LATER follow-up event can derive one
  // without a fixed wait (see the (P) scenario below).
  const fileRetain = (x, landedSha, assembledTip) => {
    const ts = now();
    db.appendEvent({ id: randomUUID(), ts, managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: x.workerId, taskId: x.taskId, detail: { opId: "planted", branch: x.branch, assembledTip, liveTip: null, phase: "pre-stop", landedSha, repoKey: null } });
    return ts;
  };
  const strictlyAfter = (isoTs) => new Date(Date.parse(isoTs) + 1).toISOString();

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const mainTip = () => git(repo, ["rev-parse", "HEAD"]);

  // ── SCENARIO (T): TRANSIENT heldAtFinish refusal, via a REAL isBranchHeld read fault ─────────────────
  // x carries a planted retain whose release marker (a `Loom-Worker-Branch: <x.branch>` commit) is already
  // on main BEFORE the batch runs — so the PRE-ASSEMBLY held check (isBranchHeld's own release-scan read)
  // sees it released and x is selected normally. The git-read fault only arms once main has advanced past
  // its pre-batch tip — i.e. exactly once THIS batch's own fast-forward lands — so it fires at
  // `finishAlreadyMerged`'s LATER `heldAtFinish` check and nowhere earlier.
  {
    const x = await cut("tx"), y = await cut("ty");
    fileRetain(x, initSha, initSha);
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "chore: release marker" -m "Loom-Worker-Branch: ${x.branch}"`, { cwd: repo });
    const pre = mainTip();
    let armed = () => mainTip() !== pre;
    const probeFactory = (rp) => ({ raw: async (args) => {
      if (args[0] === "merge-base" && armed()) throw new Error("injected merge-base fault (test)");
      return execFileSync("git", args, { cwd: rp, encoding: "utf8" });
    } });
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }), gateOpRetainMs: 0, syncAttachBudgetMs: 120_000, heldProbeGitFactory: probeFactory });

    const r = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    const v = r.value;
    check("(T) the batch call resolved ok (no thrown error)", r.settled && r.ok);
    check("(T) main advanced (the batch fast-forward happened)", mainTip() !== pre);
    check("(T) landedCount counts BOTH as a git fact; landed only has y", v?.landedCount === 2 && v?.landed?.length === 1 && v.landed[0].workerSessionId === y.workerId);
    check("(T) finishRefused carries exactly ONE entry, for x", Array.isArray(v?.finishRefused) && v.finishRefused.length === 1 && v.finishRefused[0].workerSessionId === x.workerId);
    check("(T) heldRangeUnverifiable:true, and the reason is the real gitUnverified text", v?.finishRefused?.[0]?.heldRangeUnverifiable === true && /release could not be VERIFIED/.test(v.finishRefused[0].reason ?? ""));
    check("(T) x's worktree/branch are untouched (no finalize ran)", fs.existsSync(x.worktreePath));
    check("(T) x's task is still in its original column", db.getTask(x.taskId)?.columnKey === "in_progress");

    // WHY THIS STAYS A CACHE HIT (CR correction, see the record's own "CR correction" section): the fault
    // still persists (armed() still true — main has advanced and never goes back), so a re-fire with the
    // SAME candidates must be served from the until-superseded verdict cache, not re-run. Proof it is a
    // genuine replay, not a coincidental repeat: the sibling y's own `merge_done` count stays at exactly 1
    // — a real re-assembly would route y (its branch already deleted from (T)'s own finalize) through the
    // solo fallback, which would finalize an ALREADY-landed y a second time and file a SECOND merge_done.
    const mergeDoneCount = () => db.listEventsForWorker(y.workerId).filter((e) => e.kind === "merge_done").length;
    const before = mergeDoneCount();
    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T) re-fire while the cause persists is a genuine cache replay (cacheHit present)", !!r2.cacheHit);
    check(`(T) re-fire did NOT re-finalize y a second time (merge_done count stayed ${before})`, mergeDoneCount() === before);
    check("(T) re-fire's replayed value still names x in finishRefused (a true fact about that run)", r2.value?.finishRefused?.some((f) => f.workerSessionId === x.workerId));
    check("(T) x's worktree is STILL untouched after the cache-hit re-fire (it never re-evaluated x)", fs.existsSync(x.worktreePath));

    // THE REAL REMEDY: worker_merge_confirm directly on x — never a merge_batch re-fire. Clear the
    // injected fault first (simulating the transient cause actually clearing in production).
    armed = () => false;
    const confirmed = await svc.confirmWorkerMergeTracked(mgrId, x.workerId);
    check("(T) worker_merge_confirm on x resolved ok", confirmed.settled && confirmed.ok);
    check("(T) worker_merge_confirm on x actually finalized it (worktree now gone)", !fs.existsSync(x.worktreePath));
  }

  // ── SCENARIO (P): PERMANENT heldAtFinish refusal, via a REAL planted retain (no injected fault) ──────
  // The retain's own `landedSha` is x's OWN batch-landing commit (filed from inside the gate callback,
  // standing in for a concurrent retain writer); main carries no LATER squash for x, so `isBranchHeld`
  // finds a stable, non-transient hold once the fast-forward lands.
  {
    const x = await cut("px");
    await new Promise((r) => setTimeout(r, 1100)); // distinct author-date from x, for deterministic ordering elsewhere
    const y = await cut("py");
    const xTip0 = git(repo, ["rev-parse", x.branch]);
    let retainTs; // captured below so the release's own merge_done can be stamped STRICTLY later, with
    // no sleep at all (fixed-wait-negative-guard.mjs: a fixed wait immediately before a negative
    // assertion is unfalsifiable in one trial — this ordering need has nothing to do with that assertion,
    // so an explicit, derived timestamp is the correct fix, not an exemption).
    const gate = async (_cmd, wt) => {
      const landed = git(wt, ["log", "-n1", "--format=%H", "--fixed-strings", `--grep=Loom-Worker-Branch: ${x.branch}`]);
      retainTs = fileRetain(x, landed, initSha);
      return { passed: true };
    };
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: gate, gateOpRetainMs: 0, syncAttachBudgetMs: 120_000 });

    const r = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    const v = r.value;
    check("(P) the batch call resolved ok", r.settled && r.ok);
    check("(P) finishRefused carries exactly ONE entry, for x", Array.isArray(v?.finishRefused) && v.finishRefused.length === 1 && v.finishRefused[0].workerSessionId === x.workerId);
    check("(P) no heldRangeUnverifiable (a genuine, stable hold)", v?.finishRefused?.[0]?.heldRangeUnverifiable === undefined);
    check("(P) x's worktree is untouched", fs.existsSync(x.worktreePath));

    // Release the hold WITHOUT moving x's tip (a real, non-reconciled merge_done newer than the retain,
    // plus the task reaching a terminal column) — proves `isBranchHeld`'s release arms don't need the tip
    // to move, the false premise the original (pre-CR) classifyOutcome design rested on.
    db.appendEvent({ id: randomUUID(), ts: strictlyAfter(retainTs), managerSessionId: mgrId, kind: "merge_done", workerSessionId: x.workerId, taskId: x.taskId, detail: { branch: x.branch, repoKey: null } });
    const term = svc.columnKeyForProjectRole(projId, "terminal");
    db.updateTask(x.taskId, { columnKey: term });
    check("(P) x's branch tip is UNCHANGED by the release", git(repo, ["rev-parse", x.branch]) === xTip0);

    // A merge_batch re-fire is STILL a cache replay naming x — expected and correct (see "CR correction"):
    // the batch verdict is a historical record, not a live poll, and re-firing is never the remedy anyway.
    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(P) re-fire after the release is STILL a cache replay naming x (expected — not the remedy)", !!r2.cacheHit && r2.value?.finishRefused?.some((f) => f.workerSessionId === x.workerId));

    // THE REAL REMEDY: worker_merge_confirm directly on x finalizes it, entirely independent of the
    // batch-level cache above — its own solo verdict cache is keyed differently and re-evaluates fresh.
    const confirmed = await svc.confirmWorkerMergeTracked(mgrId, x.workerId);
    check("(P) worker_merge_confirm on x resolved ok", confirmed.settled && confirmed.ok);
    check("(P) worker_merge_confirm on x actually finalized it (worktree now gone)", !fs.existsSync(x.worktreePath));
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
}
process.exit(failures === 0 ? 0 : 1);
