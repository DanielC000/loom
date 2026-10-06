import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1ac74580 — `merge_landing_started` emission-site tests. The reconcile-side attribution/escalation
// behavior (review-only vs crashed-after-landing-write) is covered by
// worktree-recycle-alias-protection.mjs; THIS file proves the event is written at the right moment and
// nowhere else, on the REAL confirm path (both solo and batch):
//
// (e) a refusal BEFORE the landing write (a clean, no-event mainline-watermark refusal) writes NO marker;
//     a GATE FAILURE (the gate runs, then rejects — never reaches the squash) ALSO writes no marker, since
//     the marker sits strictly AFTER the gate, immediately before the squash.
// (f) a normal, successful solo confirm writes EXACTLY ONE merge_landing_started, immediately followed by
//     exactly one merge_done — never duplicated by the gate's own internal retry machinery (the marker
//     sits outside that loop, see docs/decisions/1ac74580-merge-landing-started.md).
// (batch) a real 2-worker batch landing writes one merge_landing_started PER LANDED worker, each carrying
//     detail.batch:true and no `branch` field, each immediately followed by that worker's own merge_done.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-landing-started-emission.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mlse-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");
const { runBatchedMerge } = await import("../dist/git/batch-merge.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mlse@loom -c user.name=mlse";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mlse\n");
  execSync(`git init -q && git config user.email mlse@loom && git config user.name mlse`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git branch -M main`, { cwd: repo });
  // A resolvable LOCAL origin/HEAD symbolic ref — no real remote needed (mirrors
  // worktree-recycle-alias-protection.mjs's initRepo) — several mainline-resolution reads expect this.
  execSync(`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`, { cwd: repo });
}

const dbs = [];
const worktrees = [];
try {
  // ── (f) a normal, successful solo confirm writes merge_landing_started exactly once, right before
  // merge_done ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-solo-ok-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-ok-proj-${sfx}`, agentId = `mlse-ok-agent-${sfx}`, taskId = `mlse-ok-task-${sfx}`;
    const mgrId = `mlse-ok-mgr-${sfx}`, workerId = `mlse-ok-w-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "MLSE-OK", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "mlse-injected-gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "MLSE-OK-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });
    const op = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "solo-ok" });
    check("(f, solo) settled with a real merge", op.settled === true && op.ok === true && op.value?.merged === true);
    check("(f, solo) the gate ran exactly once", gateCalls === 1);

    const events = db.listEventsForWorker(workerId);
    const landingStarted = events.filter((e) => e.kind === "merge_landing_started");
    check("(f, solo) exactly one merge_landing_started was written", landingStarted.length === 1);
    check("(f, solo) it carries no `branch` field (never branch-keyed, card 1ac74580)", landingStarted[0] && landingStarted[0].detail?.branch === undefined);
    // Ordering, not strict adjacency: finalizeMerge also files this worker's own worker_retired in
    // between (legitimate, unrelated bookkeeping) — the load-bearing fact is merge_done comes AFTER
    // merge_landing_started, exactly once each, never the other way around or duplicated.
    const kinds = events.map((e) => e.kind);
    const startedIdx = kinds.indexOf("merge_landing_started");
    const doneIdx = kinds.indexOf("merge_done");
    check("(f, solo) merge_landing_started fires before merge_done, each exactly once — never duplicated by the gate's own internal retry machinery",
      startedIdx >= 0 && doneIdx > startedIdx && kinds.filter((k) => k === "merge_done").length === 1);
  }

  // ── (e) a clean, pre-landing-write refusal (unreadable mainline watermark) writes NO marker ──────────
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-wm-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-wm-proj-${sfx}`, agentId = `mlse-wm-agent-${sfx}`, taskId = `mlse-wm-task-${sfx}`;
    const mgrId = `mlse-wm-mgr-${sfx}`, workerId = `mlse-wm-w-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "MLSE-WM", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "MLSE-WM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    // The watermark row is PRESENT but fails to parse — "unreadable" — triggers confirmWorkerMerge's very
    // first git-touching refusal, well before the landing write, with no event of ANY kind appended.
    db.setMeta(mainlineWatermarkKey(projId, "primary"), "not valid json at all");

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });
    const op = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "solo-watermark-unreadable" });
    check("(e, refusal) refused — nothing was landed", op.settled === true && op.ok === true && op.value?.merged === false);
    check("(e, refusal) the refusal fires before the gate ever runs", gateCalls === 0);
    const events = db.listEventsForWorker(workerId);
    check("(e, refusal) no merge_landing_started was written", !events.some((e) => e.kind === "merge_landing_started"));
    check("(e, refusal) no event of any kind was written for this worker — a genuinely clean, synchronous refusal", events.length === 0);
  }

  // ── (e) a GATE FAILURE (reached the gate, never reaches the squash) writes NO marker either — the ──────
  // marker sits strictly AFTER the gate ───────────────────────────────────────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-gatefail-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-gf-proj-${sfx}`, agentId = `mlse-gf-agent-${sfx}`, taskId = `mlse-gf-task-${sfx}`;
    const mgrId = `mlse-gf-mgr-${sfx}`, workerId = `mlse-gf-w-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "MLSE-GF", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "mlse-injected-gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "MLSE-GF-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let gateCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: false, steps: [], reason: "injected failure" }; },
    });
    const op = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "solo-gate-failed" });
    check("(e, gate failure) refused — the gate failed, nothing landed", op.settled === true && op.ok === true && op.value?.merged === false);
    check("(e, gate failure) the gate genuinely ran", gateCalls === 1);
    const events = db.listEventsForWorker(workerId);
    check("(e, gate failure) no merge_landing_started was written — the gate rejected before the squash point", !events.some((e) => e.kind === "merge_landing_started"));
  }

  // ── (batch) a real 2-worker batch landing writes one merge_landing_started PER LANDED worker, each ─────
  // detail.batch:true + no branch, each immediately followed by that worker's own merge_done ─────────────
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-batch-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-batch-proj-${sfx}`, agentId = `mlse-batch-agent-${sfx}`, mgrId = `mlse-batch-mgr-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "MLSE-BATCH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    async function cutBranch(label, file, content) {
      const taskId = `mlse-batch-task-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      fs.writeFileSync(path.join(worktreePath, file), content);
      commitAll(worktreePath, label, GIT_ID);
      return { taskId, branch, worktreePath };
    }
    const a = await cutBranch("a", "feature-a.txt", "work a\n");
    const b = await cutBranch("b", "feature-b.txt", "work b\n");
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `mlse-batch-wkr-a-${sfx}`, wB = `mlse-batch-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
    const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    if (!r.settled) {
      await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
        { timeoutMs: 60_000, label: "batch op to settle asynchronously" });
    }
    check("(batch) settled", r.settled || sessions.gateStatus(r.op.opId).state === "settled");

    for (const [wId, label] of [[wA, "a"], [wB, "b"]]) {
      const events = db.listEventsForWorker(wId);
      const landingStarted = events.filter((e) => e.kind === "merge_landing_started");
      check(`(batch, ${label}) exactly one merge_landing_started was written`, landingStarted.length === 1);
      check(`(batch, ${label}) it carries detail.batch:true`, landingStarted[0]?.detail?.batch === true);
      check(`(batch, ${label}) it carries no \`branch\` field`, landingStarted[0] && landingStarted[0].detail?.branch === undefined);
      // Ordering, not strict adjacency — same reasoning as the solo case above.
      const kinds = events.map((e) => e.kind);
      const startedIdx = kinds.indexOf("merge_landing_started");
      const doneIdx = kinds.indexOf("merge_done");
      check(`(batch, ${label}) merge_landing_started fires before this worker's own merge_done, each exactly once`,
        startedIdx >= 0 && doneIdx > startedIdx && kinds.filter((k) => k === "merge_done").length === 1);
    }
  }

  // ── (e, pre-squash reviewed-tip-moved) a commit landing IN THE GATE-QUEUE WINDOW — after the review was
  // captured, after the admission-time union already ran — is caught by the pre-squash reviewedTipVerdict
  // re-check (service.ts, `refuseReviewedTipMoved(rt, "pre-squash")`), strictly BEFORE the marker. Reuses
  // merge-reviewed-tip-refusal.mjs's own "gatewin" recipe (a post-merge hook that commits into the
  // worker's branch the instant the daemon's own admission-time union-merge runs) to reproduce the window
  // deterministically. Code Review round: proves the marker's placement is EXACT, not merely present —
  // see the RED proof immediately after this block.
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-tipmoved-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-tm-proj-${sfx}`, agentId = `mlse-tm-agent-${sfx}`, taskId = `mlse-tm-task-${sfx}`;
    const mgrId = `mlse-tm-mgr-${sfx}`, workerId = `mlse-tm-w-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "MLSE-TM", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "mlse-injected-gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "MLSE-TM-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let gateCalls = 0;
    // Card 39ad0ee8: this fixture's own branch identity moves during confirmWorkerMergeTracked's async git
    // identity resolve (the post-merge hook below commits into the worker's branch mid-admission) — exactly
    // the case _settle-tracked.mjs's own RE-MINT GUARD doc warns can't be fixed in the shared helper ("a
    // fixture whose identity the op itself moves should pass a generous per-instance syncAttachBudgetMs ...
    // so it never degrades in the first place"). Under host load the default 12s SYNC_ATTACH_BUDGET_MS can
    // legitimately expire before this scenario's (fast, fully-stubbed-gate) real work finishes, degrading the
    // first call to {settled:false}; the re-poll then finds the op already settled with a moved identity and
    // mints a second op, which settleTracked correctly treats as a real bug (RED: "re-poll minted a fresh op
    // ... instead of re-attaching", gate ops d111d8b9/bf9711f8, both load-only). A generous budget (matching
    // the convention other DI-seam-using tests already use, e.g. batch-merge-finalize-guard-edges.mjs) makes
    // the first call settle inline instead, closing the gap this scenario can't otherwise avoid.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
      syncAttachBudgetMs: 600_000,
    });
    await sessions.reviewWorkerMerge(mgrId, workerId); // records the review-time tip on merge_request
    fs.writeFileSync(path.join(repo, "main-adv.txt"), "m\n"); commitAll(repo, "chore(test): main advances", GIT_ID);
    const hook = path.join(repo, ".git", "hooks", "post-merge");
    fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f gate-window.txt ]; then echo made-in-the-window > gate-window.txt && git ${GIT_ID} add gate-window.txt && git ${GIT_ID} commit -q -m gate-window; fi\nexit 0\n`, { mode: 0o755 });
    const op = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "solo-tip-moved" });
    fs.rmSync(hook, { force: true });
    check("(e, tip-moved) the hook really committed into the worker's branch during the daemon's own admission-time union",
      (() => { try { return execSync(`git log ${branch} --format=%s`, { cwd: repo }).toString().includes("gate-window"); } catch { return false; } })());
    check("(e, tip-moved) refused — nothing landed", op.settled === true && op.ok === true && op.value?.merged === false);
    const events = db.listEventsForWorker(workerId);
    check("(e, tip-moved) refused specifically via reviewed_tip_moved at phase pre-squash (not some other refusal)",
      events.some((e) => e.kind === "merge_rejected" && e.detail?.reason === "reviewed_tip_moved" && e.detail?.phase === "pre-squash"));
    check("(e, tip-moved) the gate genuinely ran before the refusal (this refusal sits strictly AFTER the gate)", gateCalls === 1);
    check("(e, tip-moved) no merge_landing_started was written — this refusal fires strictly between the gate and the marker", !events.some((e) => e.kind === "merge_landing_started"));
  }

  // ── (batch, assembly-dropped) a candidate DROPPED during assembly (a real conflict against an earlier
  // candidate in the SAME batch, batch-merge.mjs test (3)'s own recipe) never reaches onBeforeFastForward
  // at all, so it gets NO marker — exercised at the git/batch-merge.ts layer directly (runBatchedMerge),
  // never through SessionService.mergeBatchTracked: that layer's own per-candidate solo FALLBACK would
  // re-attempt (and genuinely re-mark) a dropped candidate on its own separate confirm attempt, which
  // would confound this assertion with a second, legitimate emission unrelated to the one being tested.
  {
    const repo = path.join(os.tmpdir(), `loom-mlse-dropped-${sfx}`);
    makeRepo(repo);
    const projId = `mlse-drop-proj-${sfx}`;
    fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
    commitAll(repo, "seed shared.txt", GIT_ID);
    const baseMainSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

    async function cutBranch(label, mutate) {
      const taskId = `mlse-drop-task-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      worktrees.push(worktreePath);
      mutate(worktreePath);
      return { workerSessionId: `mlse-drop-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}` };
    }
    // b edits shared.txt; lands cleanly.
    const b = await cutBranch("b", (wt) => { fs.writeFileSync(path.join(wt, "shared.txt"), "changed by b\n"); commitAll(wt, "edit-b", GIT_ID); });
    // c ALSO edits shared.txt, differently — conflicts against b once b has already landed in the SAME batch worktree, and is DROPPED.
    const c = await cutBranch("c", (wt) => { fs.writeFileSync(path.join(wt, "shared.txt"), "changed by c, differently\n"); commitAll(wt, "edit-c", GIT_ID); });

    const { worktreePath: batchWt } = await createWorktree(repo, projId, `mlse-drop-batch-${sfx}`);
    worktrees.push(batchWt);
    const onBeforeFastForwardCalls = [];
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [b, c], async () => ({ passed: true, steps: [] }), {}, (landed) => { onBeforeFastForwardCalls.push(landed); });
    check("(batch, dropped) fixture: b landed, c was dropped as a real conflict", result.landed.length === 1 && result.landed[0]?.branch === b.branch && result.dropped.length === 1 && result.dropped[0]?.branch === c.branch && result.dropped[0]?.conflict === true);
    check("(batch, dropped) fixture: the fast-forward itself succeeded", result.ok === true);
    check("(batch, dropped) onBeforeFastForward fired exactly once", onBeforeFastForwardCalls.length === 1);
    check("(batch, dropped) onBeforeFastForward's `landed` carries ONLY b — never the dropped candidate c", onBeforeFastForwardCalls[0]?.length === 1 && onBeforeFastForwardCalls[0][0]?.workerSessionId === b.workerSessionId);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — merge_landing_started fires exactly once, immediately before the one irreversible landing write, on both the solo and batch paths (card 1ac74580); a pre-landing-write refusal (a clean admin refusal, or a genuine gate failure) writes no marker."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
