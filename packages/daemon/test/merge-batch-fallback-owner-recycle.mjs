import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE_BATCH FALLBACKS AFTER THE OWNING MANAGER RECYCLED (card 2c16447b). Specimen: batch op d39a7fe7 settled RED
// ~25 min after it was fired; its manager had been recycled meanwhile (old session archived, workers reparented to
// the successor). `runFallback` handed the CAPTURED, now-dead manager id to the ownership-checked
// confirmWorkerMergeTracked, which threw NotYourWorkerError BEFORE gate admission; a bare `catch {}` swallowed it and
// the result + nudge still claimed "N candidate(s) routed to an individual worker_merge_confirm".
//
// Proves (REAL git, real SessionService, fake gate that performs the recycle from INSIDE the batch gate):
//   (A) owner recycled + workers reparented to the successor: every fallback confirm actually STARTS (its own gate
//       runs) and each entry is `started:true`.
//   (B) old manager archived but workers NOT yet reparented (parent === original id): still starts (covers the
//       reparent-timestamp uncertainty).
//   (C) STRICT lineage: a candidate reparented to an UNRELATED manager is NOT started, is reported `started:false`
//       with a reason, its gate never runs, and the settle nudge does not claim it was routed.
//   (D) GREEN batch across a recycle: the per-branch finalize (merge_done) is attributed to the successor owner.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-fallback-owner-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfor-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbfor@loom -c user.name=mbfor";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

// Card 58f80a64: under full-suite host contention this file's REAL-git batch (worktree cut, assembly, and the
// sequential per-candidate fallback confirms) can outrun SYNC_ATTACH_BUDGET_MS (12s), so a call legitimately
// degrades to `{settled:false}` — the documented, supported path (see pending-ops.ts), not a failure.
// `PendingOpRegistry.attach` dedupes by key, so re-calling with the SAME ids re-attaches to the identical
// in-flight op and never re-runs it; each call blocks on the real op (up to the budget), so this is a condition
// wait on genuine settlement, bounded so a real wedge still throws loudly. NEVER fabricate a value for the
// unsettled case — that fails a later assertion for an unrelated reason.
// `reCaller()` names who re-polls: after the recycle hook reparents the workers to the successor, the
// ownership check (worker.parentSessionId === caller) only accepts the CURRENT owner; the dedupe key is
// lineage-rooted so predecessor and successor attach to the same op.
async function batchUntilSettled(svc, mgr, ids, reCaller = () => mgr) {
  const deadline = Date.now() + 60_000;
  let r = await svc.mergeBatchTracked(mgr, ids);
  while (!r.settled) {
    if (Date.now() > deadline) throw new Error(`mergeBatchTracked did not settle within 60s (last op state: ${JSON.stringify(r.op)})`);
    r = await svc.mergeBatchTracked(reCaller(), ids);
  }
  return r;
}

const repo = path.join(os.tmpdir(), `loom-mbfor-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
write(repo, "README.md", "# mbfor\n");
execSync(`git init -q && git config user.email mbfor@loom && git config user.name mbfor`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const worktrees = [];
let db;
try {
  db = new Db();
  const P = `mbfor-proj-${sfx}`;
  db.insertProject({ id: P, name: "MBFOR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const baseSession = (id, role, extra = {}) => ({ id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...extra });

  const nudges = [];
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(sessionId, text) { nudges.push({ sessionId, text }); } };
  const known = new Set(); // worker worktrees: a gate run against one of these is a FALLBACK confirm's own gate
  const fallbackGateCalls = [];
  let onBatchGate = null;
  let batchPasses = false;
  const fakeGate = async (_cmd, wt) => {
    if (known.has(wt)) { fallbackGateCalls.push(wt); return { passed: false, reason: "test: fallback gate rejected" }; }
    if (onBatchGate) await onBatchGate();
    return batchPasses ? { passed: true } : { passed: false, reason: "test: batch gate red" };
  };
  const svcSync = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0 });
  const svcAsync = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0, syncAttachBudgetMs: 1 });

  let n = 0;
  async function scenario() {
    const tag = `s${++n}`;
    const mgr1 = `${P}-${tag}-mgr1`;
    db.insertSession(baseSession(mgr1, "manager"));
    const workers = [];
    for (const l of ["a", "b"]) {
      const taskId = `mbfor-task-${tag}-${l}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, P, taskId);
      worktrees.push(worktreePath); known.add(worktreePath);
      write(worktreePath, `${tag}-${l}.txt`, `${l}\n`);
      commitAll(worktreePath, `feat(test): ${tag} ${l}`, GIT_ID);
      db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${tag} ${l}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      const workerId = `${P}-${tag}-wkr-${l}`;
      db.insertSession(baseSession(workerId, "worker", { cwd: worktreePath, processState: "exited", parentSessionId: mgr1, taskId, worktreePath, branch }));
      workers.push({ workerId, worktreePath, taskId, branch });
    }
    const retire = (id) => { db.db.prepare("UPDATE sessions SET process_state='exited' WHERE id=?").run(id); db.archiveSession(id); };
    const mkSuccessor = () => { const id = `${P}-${tag}-mgr2`; db.insertSession(baseSession(id, "manager", { recycledFrom: mgr1 })); return id; };
    return { tag, mgr1, workers, retire, mkSuccessor };
  }
  const reset = () => { fallbackGateCalls.length = 0; onBatchGate = null; batchPasses = false; };

  // ── (A) owner recycled, workers reparented to the successor, batch settles RED ──
  {
    reset();
    const s = await scenario();
    let mgr2 = null;
    onBatchGate = async () => { mgr2 = s.mkSuccessor(); s.retire(s.mgr1); for (const w of s.workers) db.relinkWorkerToManager(w.workerId, mgr2); };
    const r = await batchUntilSettled(svcSync, s.mgr1, s.workers.map((w) => w.workerId), () => mgr2 ?? s.mgr1);
    const v = r.value ?? r;
    check("(A) precondition: batch ran and settled RED with both candidates in fallback[]", r.settled === true && v.ok === false && v.fallback.length === 2 && mgr2 !== null);
    // A fallback confirm's own attach can ALSO degrade to pending under load (its own 12s budget), in which
    // case its gate runs after the batch result is returned — wait for the observable gate call (positive wait).
    await waitUntil(() => s.workers.every((w) => fallbackGateCalls.includes(w.worktreePath)), { timeoutMs: 30_000, intervalMs: 50, label: "every fallback gate (A)" });
    check("(A) every fallback confirm actually STARTED (its own gate ran)", s.workers.every((w) => fallbackGateCalls.includes(w.worktreePath)));
    check("(A) every fallback entry is started:true", v.fallback.length === 2 && v.fallback.every((f) => f.started === true));
  }

  // ── (B) old manager archived, workers NOT yet reparented (parent === original id) ──
  {
    reset();
    const s = await scenario();
    onBatchGate = async () => { s.mkSuccessor(); s.retire(s.mgr1); };
    const r = await batchUntilSettled(svcSync, s.mgr1, s.workers.map((w) => w.workerId));
    const v = r.value ?? r;
    check("(B) precondition: settled RED, both in fallback[]", r.settled === true && v.ok === false && v.fallback.length === 2);
    await waitUntil(() => s.workers.every((w) => fallbackGateCalls.includes(w.worktreePath)), { timeoutMs: 30_000, intervalMs: 50, label: "every fallback gate (B)" });
    check("(B) parent still the original id, and every fallback confirm STARTED", s.workers.every((w) => fallbackGateCalls.includes(w.worktreePath)) && v.fallback.every((f) => f.started === true));
  }

  // ── (C) STRICT lineage: candidate b reparented to an UNRELATED manager ──
  {
    reset();
    const s = await scenario();
    const other = `${P}-${s.tag}-other`;
    db.insertSession(baseSession(other, "manager"));
    onBatchGate = async () => { db.relinkWorkerToManager(s.workers[1].workerId, other); };
    const nBefore = nudges.length;
    const r = await svcAsync.mergeBatchTracked(s.mgr1, s.workers.map((w) => w.workerId));
    check("(C) precondition: batch degraded to pending (the nudge is where the outcome is announced)", r.settled === false);
    await waitUntil(() => nudges.slice(nBefore).some((x) => /\[loom:merge-batch-failed\]/.test(x.text)), { timeoutMs: 30_000, intervalMs: 50, label: "batch-failed nudge (C)" });
    const nudge = nudges.slice(nBefore).find((x) => /\[loom:merge-batch-failed\]/.test(x.text)).text;
    // the in-lineage fallback confirm degrades to pending on the 1ms budget and gates asynchronously — wait for it.
    await waitUntil(() => fallbackGateCalls.includes(s.workers[0].worktreePath), { timeoutMs: 30_000, intervalMs: 50, label: "in-lineage fallback gate (C)" });
    check("(C) the in-lineage candidate's fallback started (its gate ran)", fallbackGateCalls.includes(s.workers[0].worktreePath));
    check("(C) the unrelated-parent candidate was NOT started (its gate never ran)", !fallbackGateCalls.includes(s.workers[1].worktreePath));
    check("(C) the nudge does not claim routing it did not do: 1 routed, 1 NOT started, with a reason", /\b1 candidate\(s\) routed/.test(nudge) && /1 candidate\(s\) NOT started/.test(nudge) && /fallback NOT started/.test(nudge));
    check("(C) never the old blanket claim that both were routed", !/\b2 candidate\(s\) routed/.test(nudge));
  }

  // ── (D) GREEN batch across a recycle: per-branch finalize attributed to the successor ──
  {
    reset();
    const s = await scenario();
    let mgr2 = null;
    batchPasses = true;
    onBatchGate = async () => { mgr2 = s.mkSuccessor(); s.retire(s.mgr1); for (const w of s.workers) db.relinkWorkerToManager(w.workerId, mgr2); };
    const r = await batchUntilSettled(svcSync, s.mgr1, s.workers.map((w) => w.workerId), () => mgr2 ?? s.mgr1);
    const v = r.value ?? r;
    check("(D) precondition: green batch landed both", r.settled === true && v.ok === true && v.landed.length === 2);
    const done = s.workers.map((w) => db.listEventsForWorker(w.workerId).find((e) => e.kind === "merge_done"));
    check("(D) each landed branch's merge_done is attributed to the CURRENT owner (successor), not the dead predecessor", done.every((e) => e && e.managerSessionId === mgr2));
  }
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
