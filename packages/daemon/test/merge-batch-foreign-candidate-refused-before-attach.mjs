import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE_BATCH's OWNER EXEMPTION, PROVED (card 94725dcb) — mergeBatchTracked's attach() call passes
// `{exempt:true, reason:"..."}` instead of a real isOwner/refuse check, reasoning that the per-candidate
// EXACT ownership loop at the top of mergeBatchTracked (every workerSessionId must have
// `worker.parentSessionId === managerSessionId`) already refuses a foreign-lineage caller before
// buildBatchDedupeKey or attach() are ever reached — so there is nothing left for attach() itself to
// check.
//
// Code Review (M1) found the FIRST version of this test vacuous: its lone "foreign" worker had no
// `branch`, so the per-candidate loop's OWN NEXT check (`!worker.branch`) would have returned early even
// with the ownership comparison deleted — the test's "attach was never called" assertion stayed green for
// the wrong reason, and a version of the real check loosened to `sameManagerLineage` ALSO kept it green
// (an unrelated-lineage caller is refused either way, so that specific loosening was never exercised at
// all). Fixed below with REAL candidates (real branch + real worktree) and TWO scenarios, because one
// scenario cannot discriminate both failure modes:
//   SCENARIO A — an UNRELATED manager (no recycle link at all) calling on another manager's workers.
//   SCENARIO B — a RECYCLED SUCCESSOR whose candidate workers have NOT yet been reparented (still
//     `parentSessionId` = the predecessor — the real, documented race `reparentLiveWorkers` leaves open
//     for a non-live worker).
//
// Code Review (second round) then found that the FIX for M1 proved the discrimination by temporarily
// EDITING THE REAL service.ts SOURCE (deleting, then loosening, the real per-candidate check) and
// REBUILDING THE DAEMON from inside this committed test file. That is unsafe for a reason specific to
// this project: the merge gate runs test files CONCURRENTLY, in several lanes, against the SAME
// worktree's `dist/` — a test that mutates `src`/rebuilds `dist` at runtime corrupts every OTHER test
// running in parallel in that same worktree, and a crash mid-mutation leaves a broken tree behind for the
// rest of the gate. Tests must treat `src`/`dist` as READ-ONLY, full stop.
//
// THE RED PROOFS THEMSELVES (check deleted; check loosened to lineage) are therefore NOT part of this
// committed test — they were run ONCE, by hand, outside the test suite (edit, rebuild, observe, revert,
// rebuild), and their output is reported in the worker_report for card 94725dcb's Code Review, not
// re-executed here. What THIS file keeps, read-only against whatever `dist/` already is: the real,
// current refusal behavior for both scenarios, plus the buildBatchDedupeKey invariant the exemption
// actually rests on, plus the spy-sanity negative control. If the per-candidate check is ever genuinely
// changed in `src/sessions/service.ts`, this file's own scenario A/B assertions will go red against the
// REBUILT `dist/` the next time someone runs `pnpm build` — exactly the normal, safe way a test should
// observe a source change, never by rebuilding itself.
//
// Proves (real git, real SessionService, read-only against the current build — no mocked ownership
// predicate, no source mutation, no rebuild):
//   (1)/(3) scenario A/B are each refused by the REAL per-candidate check, before buildBatchDedupeKey or
//       attach() are ever reached (spy count 0 for each).
//   (2) a DIRECT assertion on buildBatchDedupeKey itself — the real invariant the exemption actually
//       rests on: the SAME candidate set produces a DIFFERENT key under the foreign manager than under
//       the true owner, so even a caller that somehow reached attach() could never collide with the real
//       op's key.
//   (4) NEGATIVE CONTROL / spy sanity: the TRUE owner, with real candidates, DOES reach attach() (the
//       spy's count goes positive) — proving (1)'s zero isn't vacuous.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-foreign-candidate-refused-before-attach.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService, buildBatchDedupeKey } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbfc@loom -c user.name=mbfc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

const repo = path.join(os.tmpdir(), `loom-mbfc-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
registerForCleanup(repo);
write(repo, "README.md", "# mbfc\n");
execSync(`git init -q && git config user.email mbfc@loom && git config user.name mbfc`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const worktrees = [];
let db;
try {
  const P = `mbfc-proj-${sfx}`;
  db = new Db();
  db.insertProject({ id: P, name: "MBFC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const baseSession = (id, role, extra = {}) => ({ id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...extra });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  // Gate REJECTS immediately — this test only needs attach() to be REACHED (for the sanity/negative
  // control), never a successful landing (whose finalize/worktree-removal/branch-delete async tail would
  // otherwise outlive this fixture and race db.close()).
  const fakeGate = async () => ({ passed: false, reason: "test: gate rejected by design" });
  const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0 });

  const origAttach = svc.pendingOps.attach.bind(svc.pendingOps);
  let attachCalls = 0;
  svc.pendingOps.attach = (...args) => { attachCalls++; return origAttach(...args); };

  const makeRealCandidate = async (label) => {
    const taskId = `mbfc-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    write(worktreePath, `${label}.txt`, `${label}\n`);
    commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    return { taskId, worktreePath, branch };
  };

  // ── SCENARIO A: an UNRELATED manager, two REAL candidates it does not own ──────────────────────────
  const ownerMgr = `${P}-owner-mgr`;
  db.insertSession(baseSession(ownerMgr, "manager"));
  const foreignMgr = `${P}-foreign-mgr`; // no recycledFrom link to ownerMgr — a genuinely different lineage
  db.insertSession(baseSession(foreignMgr, "manager"));
  const aCandidates = [];
  for (const l of ["a1", "a2"]) {
    const c = await makeRealCandidate(l);
    const workerId = `${P}-wkr-${l}`;
    db.insertSession(baseSession(workerId, "worker", { cwd: c.worktreePath, processState: "exited", parentSessionId: ownerMgr, taskId: c.taskId, worktreePath: c.worktreePath, branch: c.branch }));
    aCandidates.push(workerId);
  }

  // ── SCENARIO B: a RECYCLED SUCCESSOR, candidates NOT YET reparented (still parented to the predecessor) ─
  const predMgr = `${P}-pred-mgr`;
  db.insertSession(baseSession(predMgr, "manager", { processState: "exited" }));
  const succMgr = `${P}-succ-mgr`;
  db.insertSession(baseSession(succMgr, "manager", { recycledFrom: predMgr }));
  const bCandidates = [];
  for (const l of ["b1", "b2"]) {
    const c = await makeRealCandidate(l);
    const workerId = `${P}-wkr-${l}`;
    db.insertSession(baseSession(workerId, "worker", { cwd: c.worktreePath, processState: "exited", parentSessionId: predMgr, taskId: c.taskId, worktreePath: c.worktreePath, branch: c.branch })); // STILL parented to the predecessor
    bCandidates.push(workerId);
  }

  const beforeA = attachCalls;
  const refusedA = await svc.mergeBatchTracked(foreignMgr, aCandidates);
  check("(1) scenario A (unrelated manager) is refused as 'not your worker'", refusedA.settled === true && refusedA.ok === true && refusedA.value.ok === false && /not your worker/.test(refusedA.value.reason ?? ""));
  check("(1) scenario A: pendingOps.attach was NEVER called", attachCalls - beforeA === 0);

  const beforeB = attachCalls;
  const refusedB = await svc.mergeBatchTracked(succMgr, bCandidates);
  check("(1) scenario B (recycled successor, not reparented) is refused as 'not your worker'", refusedB.settled === true && refusedB.ok === true && refusedB.value.ok === false && /not your worker/.test(refusedB.value.reason ?? ""));
  check("(1) scenario B: pendingOps.attach was NEVER called", attachCalls - beforeB === 0);

  // ── (2) the real invariant the exemption rests on ───────────────────────────────────────────────────
  const keyForeign = buildBatchDedupeKey(db, foreignMgr, aCandidates.map((workerSessionId) => ({ workerSessionId })));
  const keyOwner = buildBatchDedupeKey(db, ownerMgr, aCandidates.map((workerSessionId) => ({ workerSessionId })));
  check("(2) buildBatchDedupeKey DIFFERS between the foreign manager and the true owner for the SAME candidate set", keyForeign !== keyOwner);

  // ── (4) NEGATIVE CONTROL / spy sanity: the TRUE owner's own batch DOES reach attach() ───────────────
  const beforeOwner = attachCalls;
  const landed = await svc.mergeBatchTracked(ownerMgr, aCandidates);
  check("(4) [spy sanity / negative control] the TRUE owner's batch call DOES reach attach()", attachCalls - beforeOwner > 0);
  check("(4) [sanity] the true owner's own batch was not itself refused as 'not your worker'", !(landed.settled && landed.ok && /not your worker/.test(landed.value?.reason ?? "")));
  // The rejected gate above drives mergeBatchTracked's OWN fallback path (a real, async
  // confirmWorkerMergeTracked per candidate) — drain it before closing the db, or its tail settles after
  // close() and logs a caught-but-noisy "database connection is not open" (no assertion depends on this).
  await waitUntil(() => svc.pendingOps.listAllOfKind("merge").length === 0, { label: "fallback confirms drained before db.close()", timeoutMs: 30_000 });
} finally {
  if (db) db.close();
  for (const wt of worktrees) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBatchTracked's attach() owner EXEMPTION (card 94725dcb) is proved against the real, current build: an unrelated manager AND a recycled-successor-not-yet-reparented manager are both refused by the per-candidate check before pendingOps.attach is ever called, buildBatchDedupeKey itself differs for the two lineages over the identical candidate set, and the true owner's own batch genuinely reaches attach() (spy sanity, not vacuous). The RED proofs (check deleted; check loosened to lineage) were run once, by hand, outside this committed test — see this file's own header and the card's worker_report for their output; this file never mutates src/dist or rebuilds the daemon itself."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
