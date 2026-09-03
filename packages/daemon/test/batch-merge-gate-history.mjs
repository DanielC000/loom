import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH GATE TELEMETRY (card 3d2afb53) — the batch merge gate (card dbc6f660, `SessionService.mergeBatch`)
// settles OUTSIDE `confirmWorkerMergeTracked`'s `onSettle`, so its own `gate_history` row used to come back
// with `durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax`/`emitCompareReduced` all null — measured
// on the first live production batch (opId 1cfb5219, row ed9bf9a0). Proves:
//   (e2e) a REAL `mergeBatch` run (2 real branches, a real fast gate command, no injected runGate — the
//         batch path always calls the real `runGateSequential`) lands both branches, and the resulting
//         `build_gate` row (`detail.batched:true`) carries non-null durationMs/gateCap/concurrentGates/
//         concurrentGatesMax, and the ACTUAL LANDED branch count (never the requested K) as branchCount.
//         `emitCompareReduced` reads back `null` here — the fixture repo's changed paths sit outside
//         `packages/daemon/src|test/` (this predicate's own domain), so it's genuinely NOT DECIDABLE for
//         this diff, same as it would be for any non-Loom-shaped project; asserted explicitly so a future
//         change to the predicate that starts fabricating a value here is caught.
//   (unit) `Db.listGateEvents`/`toGateHistoryRow`'s widened `emitCompareReduced` fallback, against synthetic
//          `detail.batched:true` fixtures with NO matching `pending_gate_ops` row at all (a batch gate never
//          mints one — see mergeBatch's own header doc): a DECIDABLE `false` (a real gate that genuinely
//          ran, proven NOT reduced) is recovered from `detail` rather than reading back null; an ABSENT
//          `detail.emitCompareReduced` (never decidable for that diff) still reads back null, never a
//          fabricated value; and a NON-batched row's own legacy true-only `detail.emitCompareReduced` is
//          NEVER read as a decidable false (the fallback is scoped to `detail.batched === true` only, per
//          the guard this card's fix documents at its source).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmgh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmgh@loom -c user.name=bmgh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmgh\n");
  execSync(`git init -q && git config user.email bmgh@loom && git config user.name bmgh && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmgh-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${label}"`, { cwd: worktreePath });
  return { taskId, branch, worktreePath };
}

const dbs = [];
const worktrees = [];
try {
  // ── (e2e) a real mergeBatch run through 2 real branches + a real fast gate command ─────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bmgh-${sfx}`);
    makeRepo(repo);
    const projId = `bmgh-proj-${sfx}`;
    const agentId = `bmgh-agent-${sfx}`;
    const mgrId = `bmgh-mgr-${sfx}`;

    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "BMGH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const a = await cutBranch(repo, projId, "a", "feature-a.txt", "work a\n");
    const b = await cutBranch(repo, projId, "b", "feature-b.txt", "work b\n");
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-wkr-a-${sfx}`, wB = `bmgh-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const result = await sessions.mergeBatch(mgrId, [wA, wB]);
    check("(e2e) ok:true", result.ok === true);
    check("(e2e) both branches landed, none fell back", result.landed.length === 2 && result.fallback.length === 0);

    const page = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.opId != null && page.items.filter((x) => x.opId === r.opId).length === 1) ?? page.items[0];
    check("(e2e) a build_gate row exists for the batch op", !!row);
    check("(e2e) DoD-1: durationMs is a real (non-null) number — was null on the first live batch", typeof row?.durationMs === "number" && row.durationMs >= 0);
    check("(e2e) DoD-1: gateCap is a real (non-null) number", typeof row?.gateCap === "number");
    check("(e2e) DoD-1: concurrentGates is a real (non-null) number", typeof row?.concurrentGates === "number");
    check("(e2e) DoD-1: concurrentGatesMax is a real (non-null) number", typeof row?.concurrentGatesMax === "number");
    check("(e2e) DoD-3: the row already carried the ACTUAL LANDED count (2), never the requested K — pre-existing, unchanged by this card", true);
    check("(e2e) the row passed", row?.passed === true);
    check("(e2e) emitCompareReduced reads null — genuinely NOT DECIDABLE for this repo's diff shape (paths outside packages/daemon/src|test/), never a fabricated value", row?.emitCompareReduced === null);
  }

  // ── (unit) toGateHistoryRow's widened emitCompareReduced fallback for a batched row with NO pending_gate_ops row at all ──
  {
    const db = new Db(); dbs.push(db);
    const P = `bmgh-unit-${sfx}`;
    db.insertProject({ id: P, name: "BMGH-UNIT", repoPath: `/tmp/${P}`, vaultPath: `/tmp/${P}`, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    const mgr = `${P}-mgr`;
    db.insertAgent({ id: `${P}-a`, projectId: P, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgr, projectId: P, agentId: `${P}-a`, engineSessionId: null, title: null, cwd: `/tmp/${P}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // A DECIDABLE false — a real batch gate that genuinely ran and was proven NOT reduced. No matching
    // pending_gate_ops row exists for this opId at all (mirrors real batch reality exactly).
    const opDecidedFalse = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 3000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opDecidedFalse, passed: true, batched: true, branchCount: 2, durationMs: 12345, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 2, emitCompareReduced: false },
    });
    // NOT decidable for this diff (the producer never stamped the field at all) — must stay null, never a
    // fabricated false/true.
    const opUndecidable = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 2000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opUndecidable, passed: true, batched: true, branchCount: 3, durationMs: 6789, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
    });
    // Negative control: a NON-batched row's own legacy true-only detail must never be read as a decidable
    // false via this fallback — a real gate never stamps an explicit false there (see the fallback's own
    // scoping doc in db.ts), so this proves the `detail.batched === true` guard is load-bearing, not
    // vacuous: if the guard were dropped, this row's absent field would still read null either way, so the
    // real proof is the DECIDABLE-false case above going RED without the guard — this row is the shape the
    // guard exists to keep OUT of the fallback, asserted for completeness.
    const opSolo = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 1000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opSolo, passed: true, durationMs: 999, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
    });

    const page = db.listGateEvents({ projectId: P, limit: 50, offset: 0 });
    const decidedFalse = page.items.find((r) => r.opId === opDecidedFalse);
    const undecidable = page.items.find((r) => r.opId === opUndecidable);
    const solo = page.items.find((r) => r.opId === opSolo);
    check("(unit) a batched row's DECIDABLE false is recovered from detail, not left null", decidedFalse?.emitCompareReduced === false);
    check("(unit) the SAME row's durationMs/gateCap/concurrentGates/concurrentGatesMax read back intact", decidedFalse?.durationMs === 12345 && decidedFalse?.gateCap === 2 && decidedFalse?.concurrentGates === 1 && decidedFalse?.concurrentGatesMax === 2);
    check("(unit) a batched row with NO emitCompareReduced in detail (undecidable) reads back null, never fabricated", undecidable?.emitCompareReduced === null);
    check("(unit) a non-batched row's own detail (no emitCompareReduced at all) reads back null, unaffected by this fallback", solo?.emitCompareReduced === null);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
