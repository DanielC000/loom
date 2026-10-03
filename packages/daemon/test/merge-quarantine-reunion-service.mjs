import { commitAll } from "./_git-commit.mjs";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SERVICE-LEVEL QUARANTINE TESTS for the two re-union quarantine branches card 7e5b23e7 round 2 added to
// sessions/service.ts, but round 2 never covered end to end (round 3, item m2 — Code Review finding on
// delta review 1cbedbbd). REAL git on temp repos, through the real `confirmWorkerMerge` — a manufactured
// quarantine (`enterMergeQuarantine`, the SAME primitive a real unconfirmed-kill raises) is entered WHILE
// the op is genuinely parked mid-wait, so this never needs to wait out `mergeMainIntoWorktree`'s own real
// 45s union-merge timeout floor plus its kill-grace window to provoke a genuine unconfirmed kill — the
// prior draft of this test assumed exactly that ("needs a real 45s+45s window"), which this file's own
// approach makes unnecessary: a quarantine entered directly, after the op's own entry-time union-merge/
// repo-guard acquisition has already run (so it is never refused before ever reaching the branch under
// test), reaches the EXACT SAME `killableCanonicalRaw` pre-check (`assertRepoNotQuarantined`, bounded.ts)
// a real kill-raised quarantine would, regardless of what raised it.
//
// Proves:
//   (A) INERT-RECLASSIFICATION QUARANTINE (service.ts, the `else if (reunion.quarantined)` branch inside
//       the post-repo-guard-wait reclassification): a docs-only (pre-wait-inert) branch takes the
//       repo-guard-only hold; main advances during that wait (forcing a re-union attempt); the canonical
//       repo is quarantined WHILE held. The re-union's own `mergeMainIntoWorktree` call hits the
//       quarantine and this branch must return the quarantined rejection immediately — the gate command is
//       NEVER called (this never reaches `runExclusive`/the real gate at all).
//   (B) ADMISSION-TIME QUARANTINE (service.ts `reunionAtAdmission`'s own re-union call, caught by
//       `rejectAdmissionReunionFailure`): an ordinary (non-inert) branch takes the real gate slot; a
//       holder occupies the ONE gate lane so this op genuinely QUEUES; main advances during that queue
//       wait (forcing admission's own re-union attempt); the canonical repo is quarantined WHILE queued.
//       The re-union's own `mergeMainIntoWorktree` call hits the quarantine and `reunionAtAdmission` must
//       throw, caught before the real gate command ever spawns.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-reunion-service.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mqrs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=mqrs@loom -c user.name=mqrs";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MQRS", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MQRS-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mqrs\n");
  fs.mkdirSync(path.join(p.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(p.repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mqrs@loom && git config user.name mqrs`, { cwd: p.repo });
  commitAll(p.repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `mqrs-${label}-proj-${sfx}`, agentId: `mqrs-${label}-agent-${sfx}`, taskId: `mqrs-${label}-task-${sfx}`,
  mgrId: `mqrs-${label}-mgr-${sfx}`, workerId: `mqrs-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mqrs-${label}-${sfx}`),
});

async function waitUntilRepoGuardQueued(sessions, projId, repoPath, timeoutMs) {
  try {
    return await sharedWaitUntil(() => {
      const snap = sessions.gateQueueForManager(projId);
      return snap.repoGuardOnly.some((e) => e.phase === "queued" && e.repoPath === repoPath);
    }, { timeoutMs, intervalMs: 10, label: "merge-quarantine-reunion-service: repo guard queued" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
}

const dbs = [];
const worktrees = [];
try {
  // ── (A) INERT-RECLASSIFICATION QUARANTINE — see this file's own header. ────────────────────────────
  {
    const A = mk("a");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, reapWorktreeProcesses: noReap });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    // Docs-only — provably inert against main BEFORE the wait (mirrors merge-gate-inert-diff.mjs scenario A).
    fs.mkdirSync(path.join(worktreePath, "docs"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    commitAll(worktreePath, "docs: add note", GIT_ID);
    seed(db, A, "pnpm gate");

    // Hold the repo-guard-only slot directly — the SAME primitive confirmWorkerMerge's own inert-skip
    // path calls, inducing a real, deterministic wait without any sibling gate ever running.
    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: A.repo, projectId: A.projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op-a",
    });

    const confirmPromise = sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    const queued = await waitUntilRepoGuardQueued(sessions, A.projId, A.repo, 10000);
    check("(A) precondition: confirmWorkerMerge's own repo-guard-only wait is genuinely queued", queued);

    if (!queued) {
      releaseTestHold();
      await Promise.allSettled([confirmPromise]);
    } else {
      // Main advances WHILE held — a NEW, UNRELATED file, so the re-union itself would otherwise succeed
      // cleanly if not for the quarantine raised below.
      fs.writeFileSync(path.join(A.repo, "main-advance-a.txt"), "main moved during the repo-guard wait\n");
      commitAll(A.repo, "main advance during repo-guard wait", GIT_ID);

      // Manufacture the quarantine WHILE the op is parked — AFTER its own entry-time (pre-wait) union-merge
      // already ran (that's what let it reach this wait at all); this is the SAME primitive a real
      // unconfirmed-kill raises, so the re-union's own `killableCanonicalRaw` pre-check cannot tell the
      // difference between this and a genuine kill-raised quarantine.
      enterMergeQuarantine(A.repo, A.branch, "manufactured for round-3 m2 service-level test (A)");

      releaseTestHold();
      const confirm = await confirmPromise;

      check("(A) the gate command was NEVER called — the inert-reclassification quarantine returns before ever reaching the real gate", calls === 0);
      check("(A) confirmWorkerMerge REJECTS", confirm.merged === false);
      check("(A) the rejection is reported as quarantined:true", confirm.quarantined === true);
      check("(A) the rejection's reason/detailText names the quarantine, not a generic failure",
        /quarantine/i.test(confirm.reason ?? "") || /quarantine/i.test(confirm.detailText ?? ""));
      const rejected = eventsOfKind(db, A.mgrId, "merge_rejected").at(-1);
      check("(A) merge_rejected event recorded with reason union_merge_quarantined (never the _at_admission variant — this never reached admission)",
        rejected?.detail?.reason === "union_merge_quarantined");
      check("(A) task NOT moved to done — squash phase never reached", db.getTask(A.taskId).columnKey !== "done");
      check("(A) worktree retained (never removed on a quarantined rejection)", fs.existsSync(worktreePath) === true);

      clearMergeQuarantine(A.repo);
      check("(A) cleanup: quarantine cleared", !activeMergeQuarantineFor(A.repo));
    }
  }

  // ── (B) ADMISSION-TIME QUARANTINE — see this file's own header. ────────────────────────────────────
  {
    const B = mk("b");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: noReap,
    });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    // An ORDINARY (non-inert) src change — this branch must take the REAL gate, never the inert skip, so
    // its own confirm genuinely queues behind the held gate slot below (never the repo-guard-only lane).
    fs.writeFileSync(path.join(worktreePath, "src", "feature-b.ts"), "export const B = true;\n");
    commitAll(worktreePath, "feat: feature-b", GIT_ID);
    seed(db, B, "pnpm gate");

    // Seize the ONE gate slot directly on the SAME semaphore confirmWorkerMerge itself uses — mirrors
    // merge-gate-reuse(-admission).mjs scenarios (K)/(O).
    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mqrs-b-holder-proj", sessionId: "mqrs-b-holder-sess" }, () => holderPromise,
    );

    const confirmPromise = sessions.confirmWorkerMerge(B.mgrId, B.workerId);

    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(B) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);

    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // Main advances WHILE genuinely queued — a NEW, UNRELATED file, so admission's own re-union would
      // otherwise succeed cleanly (exactly (K)'s own precondition) if not for the quarantine raised below.
      fs.writeFileSync(path.join(B.repo, "main-advance-b.txt"), "main moved during the queue wait\n");
      commitAll(B.repo, "main advance during queue wait", GIT_ID);

      // Manufacture the quarantine WHILE queued — AFTER the entry-time (pre-gate) union-merge has already
      // run (that's what let this op reach the queue at all) and strictly BEFORE admission.
      enterMergeQuarantine(B.repo, B.branch, "manufactured for round-3 m2 service-level test (B)");

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(B) the gate command was NEVER called — reunionAtAdmission's own quarantine throws before the gate ever spawns", calls === 0);
      check("(B) confirmWorkerMerge REJECTS", confirm.merged === false);
      check("(B) the rejection is reported as quarantined:true", confirm.quarantined === true);
      check("(B) the rejection's reason/detailText names the quarantine, not a generic failure",
        /quarantine/i.test(confirm.reason ?? "") || /quarantine/i.test(confirm.detailText ?? ""));
      const rejected = eventsOfKind(db, B.mgrId, "merge_rejected").at(-1);
      check("(B) merge_rejected event recorded with reason union_merge_quarantined_at_admission (the admission-time variant, never the plain inert one)",
        rejected?.detail?.reason === "union_merge_quarantined_at_admission");
      check("(B) task NOT moved to done — squash phase never reached", db.getTask(B.taskId).columnKey !== "done");
      check("(B) worktree retained (never removed on a quarantined rejection)", fs.existsSync(worktreePath) === true);

      clearMergeQuarantine(B.repo);
      check("(B) cleanup: quarantine cleared", !activeMergeQuarantineFor(B.repo));
    }
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — card 7e5b23e7 round 3 (m2): both re-union quarantine branches are exercised end to " +
      "end through the real confirmWorkerMerge — the inert-reclassification branch returns a quarantined " +
      "rejection before ever reaching the real gate (A), and reunionAtAdmission's own quarantine throws " +
      "before the gate command spawns (B); neither ever ran the gate command, and both are distinguishable " +
      "by their own merge_rejected reason."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const wt of worktrees) cleanupPathSync(wt);
  for (const db of dbs) db.close?.();
  cleanupPathSync(process.env.LOOM_HOME);
}
