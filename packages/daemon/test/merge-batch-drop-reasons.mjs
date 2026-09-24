import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE_BATCH DROP REASONS (card bc2240d7) — the manager-facing side. git/batch-merge.ts already computed a
// specific reason per dropped candidate, but sessions/service.ts's `!result.ok` branch REPLACED every chosen
// candidate's reason with the batch-level "nothing landed cleanly … every candidate was dropped", the
// [loom:merge-batch-*] nudges printed only that, and nothing was filed durably or logged — so a manager could
// not tell a conflict from a merge-commit drop from a bug (2026-09-23 specimen: `gate_status` said
// `never_existed`, the daemon log had nothing under the opId).
//
// Proves (REAL git, real SessionService, fake gate; the assembly-level cases live in batch-merge-merge-commits.mjs):
//   (1) ALL-DROPPED batch (two different non-conflict reasons): the result's `fallback[]` carries EACH
//       candidate's OWN reason — resolution-content vs not-reachable — not the generic batch reason.
//   (2) a `batch_merge_dropped` event is filed per drop, carrying the batch opId, branch and reason, even though
//       the batch never gated.
//   (3) PARTIAL batch (one lands, one CONFLICTS with it): the conflicting candidate's reason + conflict:true are
//       in `fallback[]` and its event; the async `[loom:merge-batch-done]` nudge carries the per-candidate reason.
//   (4) the nudge's per-candidate list is BOUNDED (first N + "+K more").
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-drop-reasons.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbdr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbdr@loom -c user.name=mbdr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

// Card 58f80a64: under full-suite host contention this file's REAL-git batch (worktree cut, assembly, and the
// sequential per-candidate fallback confirms) can outrun SYNC_ATTACH_BUDGET_MS (12s), so a call legitimately
// degrades to `{settled:false}` — the documented, supported path (see pending-ops.ts), not a failure.
// `PendingOpRegistry.attach` dedupes by key, so re-calling with the SAME ids re-attaches to the identical
// in-flight op and never re-runs it; each call blocks on the real op (up to the budget), so this is a condition
// wait on genuine settlement, bounded so a real wedge still throws loudly. NEVER fabricate a value for the
// unsettled case — that fails a later assertion for an unrelated reason.
async function batchUntilSettled(svc, mgr, ids) {
  const deadline = Date.now() + 60_000;
  let r = await svc.mergeBatchTracked(mgr, ids);
  while (!r.settled) {
    if (Date.now() > deadline) throw new Error(`mergeBatchTracked did not settle within 60s (last op state: ${JSON.stringify(r.op)})`);
    r = await svc.mergeBatchTracked(mgr, ids);
  }
  return r;
}

function makeRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-mbdr-${name}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  write(repo, "README.md", "# mbdr\n");
  write(repo, "shared.txt", "base\n");
  execSync(`git init -q && git config user.email mbdr@loom && git config user.name mbdr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const worktrees = [];
let db;
try {
  db = new Db();
  const P = `mbdr-proj-${sfx}`;
  const repo = makeRepo("repo");
  db.insertProject({ id: P, name: "MBDR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const mgrId = `${P}-mgr1`;
  db.insertSession({ id: mgrId, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  async function addWorker(label, file, content) {
    const taskId = `mbdr-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    if (file) { write(worktreePath, file, content); commitAll(worktreePath, `feat(test): ${label}`, GIT_ID); }
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr-${label}`;
    db.insertSession({ id: workerId, projectId: P, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { workerId, taskId, branch, worktreePath };
  }

  const nudges = [];
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(sessionId, text) { nudges.push({ sessionId, text }); } };
  // The batch's own private worktree passes; any known worker worktree (a fallback confirm's own gate) fails
  // fast so fallback confirms drain instead of holding the shared gate slot.
  const known = new Set();
  const fakeGate = async (_cmd, wt) => (known.has(wt) ? { passed: false, reason: "test: fallback gate rejected" } : { passed: true });
  // Card 7c0e1e36: a 120s sync budget so scenario (1)/(2) never degrades and never re-calls; under host load a
  // re-call minted a SECOND real op (8 dropped lines under two opIds, root cause not isolated), failing (2).
  const svcSync = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0, syncAttachBudgetMs: 120_000 });
  const svcAsync = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0, syncAttachBudgetMs: 1 });

  // ── (1)+(2) ALL-DROPPED batch: c = hand-resolved conflict merge, d = merge of a branch NOT on main ──
  const c = await addWorker("res", "shared.txt", "worker version\n");
  const d = await addWorker("foreign", "foreign-own.txt", "own\n");
  const side = await addWorker("side", "side.txt", "side\n");
  known.add(c.worktreePath); known.add(d.worktreePath); known.add(side.worktreePath);
  write(repo, "shared.txt", "main version\n");
  commitAll(repo, "chore(test): main edits shared", GIT_ID);
  try { execSync(`git ${GIT_ID} merge --no-edit ${git(repo, "rev-parse HEAD")}`, { cwd: c.worktreePath, stdio: "pipe" }); } catch { /* conflict expected */ }
  write(c.worktreePath, "shared.txt", "hand resolved\n");
  commitAll(c.worktreePath, "Merge main into branch (resolved)", GIT_ID);
  execSync(`git ${GIT_ID} merge --no-edit ${side.branch}`, { cwd: d.worktreePath, stdio: "pipe" });

  const r1 = await batchUntilSettled(svcSync, mgrId, [c.workerId, d.workerId]);
  const v1 = r1.value ?? r1;
  const opId1 = v1.opId;
  check("(1) precondition: a batch ran, nothing landed, ok:false with a batch-level reason", r1.settled === true && v1.ok === false && v1.landed.length === 0 && typeof opId1 === "string");
  const fbC = v1.fallback.find((f) => f.workerSessionId === c.workerId);
  const fbD = v1.fallback.find((f) => f.workerSessionId === d.workerId);
  check("(1) the resolved-merge candidate's fallback reason is ITS OWN (names resolution content), not the batch-level text", !!fbC && /conflict-resolution content/.test(fbC.reason) && !/every candidate was dropped/.test(fbC.reason));
  check("(1) the foreign-merge candidate's fallback reason is ITS OWN (not reachable from main)", !!fbD && /not reachable from main/.test(fbD.reason));
  check("(1) the two candidates' reasons DIFFER (a per-candidate reason, not one shared string)", !!fbC && !!fbD && fbC.reason !== fbD.reason);

  const dropEvents = db.listEvents(mgrId).filter((e) => e.kind === "batch_merge_dropped");
  check("(2) one batch_merge_dropped event per drop, both carrying the batch opId", dropEvents.length === 2 && dropEvents.every((e) => e.detail?.opId === opId1));
  check("(2) each event carries its branch and OWN reason",
    dropEvents.some((e) => e.detail?.branch === c.branch && /conflict-resolution content/.test(e.detail?.reason)) &&
    dropEvents.some((e) => e.detail?.branch === d.branch && /not reachable from main/.test(e.detail?.reason)));
  check("(2) the events carry the dropped worker's identity", dropEvents.length === 2 && dropEvents.every((e) => typeof e.workerSessionId === "string" && e.workerSessionId.length > 0));

  // ── (3)+(4) PARTIAL batch, ASYNC path: a lands; b CONFLICTS with a (both add the same new file) ──
  const a = await addWorker("a", "dup.txt", "from a\n");
  const b = await addWorker("b", "dup.txt", "from b\n");
  known.add(a.worktreePath); known.add(b.worktreePath);
  const nBefore = nudges.length;
  const r2 = await svcAsync.mergeBatchTracked(mgrId, [a.workerId, b.workerId]);
  check("(3) precondition: the batch degrades to pending (async path — the nudge is the only place the outcome is announced)", r2.settled === false);
  await sharedWaitUntil(() => nudges.slice(nBefore).some((n) => n.sessionId === mgrId && /\[loom:merge-batch-(done|failed)\]/.test(n.text)), { timeoutMs: 30_000, intervalMs: 50, label: "merge-batch settle nudge" });
  const nudge = nudges.slice(nBefore).find((n) => n.sessionId === mgrId && /\[loom:merge-batch-(done|failed)\]/.test(n.text)).text;
  check("(3) the settle nudge carries a per-candidate reason naming the conflict", /Per-candidate reasons:/.test(nudge) && /conflict cherry-picking/.test(nudge));
  const ev2 = db.listEvents(mgrId).filter((e) => e.kind === "batch_merge_dropped" && e.detail?.branch === b.branch);
  check("(3) the conflicting candidate's event is flagged conflict:true", ev2.length === 1 && ev2[0].detail?.conflict === true);
  check("(3) the landed candidate is NOT reported as dropped", !db.listEvents(mgrId).some((e) => e.kind === "batch_merge_dropped" && e.detail?.branch === a.branch));

  // (4) bounded: a nudge for a batch with many fallbacks lists at most 4 + "+K more" (exercised on the same
  // formatter via a K=6 all-dropped batch of pure "foreign merge" branches).
  const many = [];
  for (let i = 0; i < 6; i++) {
    const w = await addWorker(`m${i}`, `many-${i}.txt`, "own\n");
    const s = await addWorker(`ms${i}`, `many-side-${i}.txt`, "side\n");
    known.add(w.worktreePath); known.add(s.worktreePath);
    execSync(`git ${GIT_ID} merge --no-edit ${s.branch}`, { cwd: w.worktreePath, stdio: "pipe" });
    many.push(w);
  }
  const nBefore2 = nudges.length;
  const r3 = await svcAsync.mergeBatchTracked(mgrId, many.map((w) => w.workerId));
  if (r3.settled === false) {
    await sharedWaitUntil(() => nudges.slice(nBefore2).some((n) => n.sessionId === mgrId && /\[loom:merge-batch-(done|failed)\]/.test(n.text)), { timeoutMs: 30_000, intervalMs: 50, label: "merge-batch settle nudge (bounded)" });
    const t = nudges.slice(nBefore2).find((n) => n.sessionId === mgrId && /\[loom:merge-batch-(done|failed)\]/.test(n.text)).text;
    const listed = (t.match(/worker mbdr-pro/g) ?? []).length;
    check("(4) the per-candidate list is bounded: at most 4 listed, the rest summarised as '+K more'", listed <= 4 && /\+\d+ more/.test(t));
  } else {
    check("(4) precondition: the K>cap batch degraded to pending", false);
  }
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
