import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 89c4c950 — history/design: docs/decisions/89c4c950-batch-admission-trust-refusal-short-circuit.md.
//   (A) a real commondir-trust-pin mismatch at the admission-time read ⇒ the gate command is NEVER
//       invoked (0 calls — not stubbed-but-uncounted), no per-candidate fallback starts, the durable
//       pending_gate_ops row records a "skipped" verdict (never "pass"/"fail"), and the result carries
//       the SAME `canonicalTrustRefusal:true` shape the end-of-gate arm produces — discriminated from a
//       forfeit by asserting NO `batch_merge_forfeited` event was filed.
//   (B) regression control — an ordinary admission-time FORFEIT (main moved, no trust condition) still
//       behaves exactly as before this card: the batch's own gate is still never invoked, but BOTH
//       candidates' own solo fallback IS started and a `batch_merge_forfeited` event IS filed.
// Hermetic, no daemon. Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-admission-trust-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

useOwnLoomHome("loom-bmatr-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmatr@loom -c user.name=bmatr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmatr\n");
  execSync(`git init -q && git config user.email bmatr@loom && git config user.name bmatr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmatr-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

function setupBatchProject(label) {
  const projId = `bmatr-${label}-proj-${sfx}`, agentId = `bmatr-${label}-agent-${sfx}`, mgrId = `bmatr-${label}-mgr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-bmatr-${label}-${sfx}`);
  return { projId, agentId, mgrId, repo };
}

async function seedTwoWorkers(db, P) {
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `BMATR-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const a = await cutBranch(P.repo, P.projId, `${P.projId}-a`, "feature-a.txt", "work a\n");
  const b = await cutBranch(P.repo, P.projId, `${P.projId}-b`, "feature-b.txt", "work b\n");
  const wA = `${P.projId}-wkr-a`, wB = `${P.projId}-wkr-b`;
  for (const [wId, w] of [[wA, a], [wB, b]]) {
    db.insertTask({ id: w.taskId, projectId: P.projId, title: `feat(test): ${w.taskId}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  return { wA, wB, worktreePaths: [a.worktreePath, b.worktreePath] };
}

try {
  // ── (A) ADMISSION-TIME TRUST REFUSAL — a real commondir-trust-pin mismatch at the admission read ────
  {
    console.log("\n— (A) admission-time trust refusal: a real commondir-trust-pin mismatch —");
    const P = setupBatchProject("trustrefusal");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { wA, wB, worktreePaths } = await seedTwoWorkers(db, P);
    worktrees.push(...worktreePaths);

    // Mirrors merge-confirm-verdict-cache-union-merge-refusal.mjs's own (B1) isolation technique: the
    // lookup is GLOBAL, so it is armed ONLY around a call targeting the canonical repo directly — never a
    // batch-worktree-targeting assembly call — isolating the fault to exactly the admission-time read.
    let lookupArmed = false;
    registerCommondirTrustPinLookup((_p) => (lookupArmed
      ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
      : null));
    const factory = (p, ms) => ({
      async raw(args) {
        lookupArmed = p === P.repo;
        try {
          const real = canonicalGit(p, ms, undefined, undefined, undefined, P.repo);
          return await real.raw(args);
        } finally {
          lookupArmed = false;
        }
      },
    });
    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true, steps: [] }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, batchFfGitFactory: factory });

    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(A) admission-trust-refusal batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    registerCommondirTrustPinLookup(undefined);

    check("(A) settled ok (mergeBatchTracked itself never rejects)", r.settled === true && r.ok === true);
    const value = r.value;
    check("(A) batch outcome is ok:false", !!value && value.ok === false);
    check("(A) carries its OWN distinct flag, canonicalTrustRefusal:true", value?.canonicalTrustRefusal === true);
    check("(A) carries NO forfeited/quarantined/indexLockPresent/branchDiverted/unverified/batchHeadMoved flag", !value?.forfeited && !value?.quarantined && !value?.indexLockPresent && !value?.branchDiverted && !value?.unverified && !value?.batchHeadMoved);
    check("(A) nothing landed", Array.isArray(value?.landed) && value.landed.length === 0);
    check("(A) THE DISCRIMINATING CHECK: the real gate command was NEVER invoked (0 calls, not merely uncounted)", gateCalls === 0);
    check("(A) NO per-candidate fallback was started (same no-fallback posture as quarantined) — both candidates are reported, neither started (length check guards against a vacuous every() on an empty array)", Array.isArray(value?.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === false));

    const opId = value?.opId;
    check("(A) a build_gate tombstone opId was minted", typeof opId === "string" && opId.length > 0);
    if (opId) {
      const st = sessions.gateStatus(opId);
      check("(A) gate_status(opId) settles (never lingers running/queued)", st?.state === "settled");
      const row = db.listPendingGateOps().find((x) => x.opId === opId);
      check("(A) the durable row's verdict kind is \"skipped\" (the gate genuinely never ran — never \"fail\")", row?.verdict === "skipped");
      check("(A) the verdict's skipReason names the admission trust refusal specifically", row?.verdictPayload?.skipReason === "canonical-trust-refusal-at-admission");
      check("(A) batchBranchCount survives as the REAL assembled count (2), never falsified to 0", row?.verdictPayload?.batchBranchCount === 2);
      check("(A) batchLanded:false — the separate, later fact that nothing actually landed", row?.verdictPayload?.batchLanded === false);
    }

    const forfeitEvent = db.getLatestEventForManagerByKind(P.mgrId, "batch_merge_forfeited");
    check("(A) THE DISCRIMINATING CHECK: NO batch_merge_forfeited event was filed (this is a trust refusal, never a forfeit)", !forfeitEvent);
  }

  // ── (B) REGRESSION CONTROL — an ordinary admission-time FORFEIT still behaves exactly as before ─────
  {
    console.log("\n— (B) regression control: an ordinary admission-time forfeit (main moved) —");
    const P = setupBatchProject("forfeitctrl");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { wA, wB, worktreePaths } = await seedTwoWorkers(db, P);
    worktrees.push(...worktreePaths);

    const state = { fired: 0 };
    const factory = (repoPath, blockTimeoutMs) => ({
      raw: async (args) => {
        const real = canonicalGit(repoPath, blockTimeoutMs, undefined, undefined, undefined, P.repo);
        const isTargetRead = repoPath === P.repo && Array.isArray(args) && args.length === 4
          && args[0] === "rev-parse" && args[1] === "HEAD" && args[2] === "--symbolic-full-name" && args[3] === "HEAD";
        if (isTargetRead && state.fired === 0) {
          state.fired++;
          fs.writeFileSync(path.join(P.repo, "concurrent-main-advance.txt"), "someone else landed before admission\n");
          commitAll(P.repo, "concurrent landing before admission", GIT_ID);
          return real.raw(args);
        }
        return real.raw(args);
      },
    });
    const gateCalls = [];
    const fakeGate = async (_gate, worktreePath) => { gateCalls.push(worktreePath); return { passed: true, steps: [] }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, batchFfGitFactory: factory });

    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(B) admission-forfeit-control batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });

    check("(B) settled ok", r.settled === true && r.ok === true);
    const value = r.value;
    // `MergeBatchResult` (the top-level return) has no `forfeited` boolean of its own — that field lives
    // only on the internal `RunBatchedMergeResult` (batch-merge.ts). The forfeit's own public shape is
    // the generic `!result.ok` fallback-with-reason return, discriminated by its reason text and the TWO
    // started:true fallback candidates (unlike (A)'s trust refusal, which starts none).
    check("(B) batch outcome is ok:false, reason names the forfeit (canonical main advanced)", !!value && value.ok === false && typeof value.reason === "string" && value.reason.includes("canonical main advanced"));
    check("(B) carries NO canonicalTrustRefusal flag (this is an ordinary forfeit)", !value?.canonicalTrustRefusal);
    check("(B) BOTH candidates' own solo fallback was started (unlike (A)'s no-fallback trust refusal)", Array.isArray(value?.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === true));
    // Unlike (A)'s trust refusal (no-fallback), a forfeit DOES start a per-candidate solo fallback
    // (unchanged by this card) — each candidate's own confirm re-gates via this SAME `this.runGate` stub,
    // so `gateCalls` here counts THOSE two solo gates, never the batch's own (which never spawns).
    check("(B) THE DISCRIMINATING CHECK: the BATCH's own gate command was never invoked — only the two candidates' own solo fallback confirms ran (never a batch-* worktree)", gateCalls.length === 2 && gateCalls.every((wt) => wt === worktreePaths[0] || wt === worktreePaths[1]));

    const opId = value?.opId;
    if (opId) {
      const row = db.listPendingGateOps().find((x) => x.opId === opId);
      check("(B) the durable row's verdict kind is still \"skipped\" with the FORFEIT skipReason, unchanged by this card", row?.verdict === "skipped" && row?.verdictPayload?.skipReason === "forfeited-at-admission");
    }
    const forfeitEvent = db.getLatestEventForManagerByKind(P.mgrId, "batch_merge_forfeited");
    check("(B) a batch_merge_forfeited event WAS filed (unchanged forfeit behavior)", !!forfeitEvent && forfeitEvent.detail?.opId === opId);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  registerCommondirTrustPinLookup(undefined);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
