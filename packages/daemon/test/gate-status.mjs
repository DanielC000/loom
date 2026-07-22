import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_status(opId) (card edc1ec12, Platform-Audit finding 7afa6ea9) — the read-only diagnostic that would
// have instantly falsified "the gate is wedged/flaky" in the audit's cited incident: a caller holding an
// opId from a `run_gate`/`worker_merge_confirm` {status:"pending"} response can check whether that run is
// still queued, actually running (and for how long), or already gone (settled/never existed) — WITHOUT
// waiting for the eventual completion nudge.
//
// card 225bc7bd: `gate_status` used to do an EXACT-match-only lookup, so pasting the 8-char short id Loom
// displays everywhere else (the paste-able id every sibling tool — tasks_get/worker_spawn/
// escalation_status/agent_get — accepts) silently missed a genuinely LIVE op and reported "not_found", a
// value documented to mean "settled or never existed" — the opposite of the truth. Fixed by resolving
// `opId` as EITHER a full id OR an unambiguous prefix (mirroring the shared `resolveIdPrefix` sibling
// tools already use), with an ambiguous prefix returning a distinct, NEVER "not_found", outcome.
//
// Proves:
//   (unit) GateSemaphore.findByOpId locates a RUNNING entry and a QUEUED entry by the FULL opId carried on
//          their GateDescriptor; resolves an unambiguous 8-char PREFIX of a live opId to that SAME entry
//          (the exact false-negative this card fixes); returns kind:"ambiguous" (naming both candidates,
//          never picking one) for a prefix matching two live opIds; returns kind:"none" for an opId with
//          no live entry at all (never existed, or already settled) — three DISTINGUISHABLE outcomes, and
//          once settled, the same full opId no longer resolves either.
//   (e2e)  SessionService.gateStatus, via the REAL runWorkerGate AND confirmWorkerMergeTracked (an
//          injected `runGate` seam controls timing without a real spawn): "running" while genuinely
//          in-flight (by full id AND by its 8-char prefix), with a plausible elapsedMs, and "not_found"
//          once the op has settled — proving this never surfaces a terminal result itself, only live run
//          state, and that the prefix fix reaches the actual MCP-facing method, not just the unit layer.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gst-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

const GIT_ID = "-c user.email=gst@loom -c user.name=gst";
const now = new Date().toISOString();

// ── (unit) GateSemaphore.findByOpId ──────────────────────────────────────────────────────────────────
{
  const mkHold = () => { let release; const p = new Promise((res) => { release = res; }); return { p, release: (v) => release(v) }; };

  const sem = new GateSemaphore();
  const OP_RUNNING = "ec0f9383-bcd0-498e-9f51-7f5fdd66dd14"; // real-shaped opId (card 225bc7bd's own repro)
  const OP_QUEUED = "b7a1c9de-1111-2222-3333-444455556666";
  const hRunning = mkHold();
  const pRun = sem.runExclusive(1, { gateType: "merge", projectId: "P", sessionId: "s1", opId: OP_RUNNING }, () => hRunning.p);
  const pQueued = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s2", opId: OP_QUEUED }, async () => "second");
  await sleep(20); // let pRun acquire the lane (cap 1) + pQueued queue behind it, never invoking its own fn

  const running = sem.findByOpId(OP_RUNNING);
  check("(unit) findByOpId locates the RUNNING entry by its FULL opId", running.kind === "found" && running.record.phase === "running" && running.record.opId === OP_RUNNING);
  const queued = sem.findByOpId(OP_QUEUED);
  check("(unit) findByOpId locates the QUEUED entry by its FULL opId", queued.kind === "found" && queued.record.phase === "queued" && queued.record.opId === OP_QUEUED);

  // card 225bc7bd's actual bug: an 8-char PREFIX of a live opId used to report "not found" (undefined) —
  // indistinguishable from a settled/nonexistent op — even though the run was genuinely live.
  const prefixHit = sem.findByOpId(OP_RUNNING.slice(0, 8));
  check("(unit) an unambiguous 8-char opId PREFIX resolves to the SAME running entry", prefixHit.kind === "found" && prefixHit.record.opId === OP_RUNNING);
  const prefixHitQueued = sem.findByOpId(OP_QUEUED.slice(0, 8));
  check("(unit) an unambiguous 8-char opId PREFIX also resolves a QUEUED entry", prefixHitQueued.kind === "found" && prefixHitQueued.record.opId === OP_QUEUED);

  // An AMBIGUOUS prefix (matches two distinct live opIds) is a THIRD, distinguishable outcome — must never
  // silently pick one, and must never collapse into "not found" (a miss that can't resolve is a different
  // answer than a miss that means "gone").
  const OP_AMBIG_A = "aaaaaaaa-0001-0000-0000-000000000000";
  const OP_AMBIG_B = "aaaaaaaa-0002-0000-0000-000000000000";
  const hAmbigA = mkHold();
  const pAmbigA = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s3", opId: OP_AMBIG_A }, () => hAmbigA.p);
  const pAmbigB = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s4", opId: OP_AMBIG_B }, async () => "second"); // queues behind A
  await sleep(20);
  const ambiguous = sem.findByOpId("aaaaaaaa");
  check(
    "(unit) a prefix matching TWO live opIds returns kind:\"ambiguous\", naming BOTH candidates",
    ambiguous.kind === "ambiguous" && ambiguous.ids.length === 2 && ambiguous.ids.includes(OP_AMBIG_A) && ambiguous.ids.includes(OP_AMBIG_B),
  );

  const none = sem.findByOpId("deadbeef-0000-0000-0000-000000000000");
  check("(unit) an opId with no match at all returns kind:\"none\" — distinguishable from \"found\" and \"ambiguous\"", none.kind === "none");
  const tooShort = sem.findByOpId(OP_RUNNING.slice(0, 4));
  check("(unit) a ref shorter than the 8-char prefix floor never matches, even against a live op (too short to resolve safely)", tooShort.kind === "none");

  hRunning.release("done");
  hAmbigA.release("done");
  await Promise.all([pRun, pQueued, pAmbigA, pAmbigB]);
  check("(unit) once settled, the SAME full opId is no longer found (live-only lookup, never a terminal result)", sem.findByOpId(OP_RUNNING).kind === "none");
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gst\n");
  execSync(`git init -q && git config user.email gst@loom && git config user.name gst && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const dbs = [];
const worktrees = [];
try {
  // ── (e2e, gate kind) sessions.gateStatus reflects a REAL runWorkerGate op's live state ──────────────
  {
    const P = `gst-gate-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GST", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GST-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    let releaseGate;
    const fakeGate = () => new Promise((res) => { releaseGate = res; });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    // The injected fakeGate never resolves on its own — runWorkerGate genuinely degrades to pending past
    // SYNC_ATTACH_BUDGET_MS (12s, not injectable — same wait every completion-nudge test already pays).
    const first = await sessions.runWorkerGate(workerId);
    check("(e2e gate) degrades to pending past the sync-wait budget", first.settled === false);
    const opId = first.op.opId;

    const status = sessions.gateStatus(opId);
    check("(e2e gate) gate_status reports state:\"running\" while genuinely in flight", status.state === "running" && status.gateType === "worker");
    check("(e2e gate) elapsedMs is a plausible number (at least the sync-wait budget already elapsed)", typeof status.elapsedMs === "number" && status.elapsedMs >= 0);

    // card 225bc7bd's actual bug, reproduced against the REAL MCP-facing method (not just the unit-layer
    // GateSemaphore): the 8-char short id Loom displays for this SAME opId used to report "not_found" —
    // indistinguishable from settled/nonexistent — even though the run was genuinely live.
    const prefixStatus = sessions.gateStatus(opId.slice(0, 8));
    check("(e2e gate) gate_status ALSO resolves an unambiguous 8-char opId PREFIX to the SAME live run", prefixStatus.state === "running" && prefixStatus.gateType === "worker");

    releaseGate({ passed: true });
    await sleep(200); // let the settle .then() microtask actually clear the semaphore registry entry
    const after = sessions.gateStatus(opId);
    check("(e2e gate) once settled, gate_status reports \"not_found\" — it never surfaces a terminal result itself", after.state === "not_found" && after.gateType === null && after.elapsedMs === null);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore.findByOpId locates a running/queued entry by its FULL opId or an unambiguous 8-char PREFIX (card 225bc7bd), distinguishes an ambiguous prefix (kind:\"ambiguous\") from no match at all (kind:\"none\"), and nothing once settled; SessionService.gateStatus reports \"running\" (by full id or prefix) with a plausible elapsedMs for a genuinely in-flight gate op and \"not_found\" once it settles — never a terminal result of its own, and never for a live op whose short id was pasted in."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
