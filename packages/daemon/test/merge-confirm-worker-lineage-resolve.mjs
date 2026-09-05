import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WORKER-LINEAGE-RESOLVED MERGE OP (card `3a2dac9c`, out of `eeb26621`'s investigation — "THE HOLE").
//
// THE BUG: a solo merge op is keyed `merge:${workerSessionId}` — minted under whichever worker session id
// was live when confirmWorkerMergeTracked's own attach() call ran. `worker_recycle` mints a fresh
// successor session id and carries ZERO op state (wakes + the pty queue only) — nothing aliases the key,
// nothing resolves it by lineage. An op minted before a `worker_recycle` therefore stays registered under
// the PREDECESSOR's key forever, even though it keeps running (and the successor is now the "current"
// worker for that same worktree/branch). Two damaged surfaces:
//   1. `peekPendingMerge` (worker_list/worker_status/`/api/sessions`'s `pendingMerge` field) reads
//      `merge:${successorId}` — misses the predecessor's real, still-running op entirely. A false negative
//      on "is a merge in flight for this worker?"
//   2. A re-confirm addressed to the successor's id mints a SECOND, genuinely concurrent merge op instead
//      of dedupe-attaching to the first — precisely the failure PendingOpRegistry's dedupe exists to
//      prevent. (Verified separately, at file:line, that this is NOT already serialized: `mergeMainIntoWorktree`
//      — git/worktrees.ts — runs against the shared worktree path with no lock of its own, well before
//      `gateSemaphore.runExclusive` ever serializes anything, so two such ops can race real git state.)
//
// THE FIX: `lineageResolvedPendingOp` (sessions/lineage.ts) walks a session's `recycledFrom`
// chain BACKWARD — the read-side complement of the existing forward-walking `liveLineageSuccessor` — to
// find a per-session-keyed pending op minted under any ancestor. `peekPendingMerge` uses it to surface a
// predecessor's op (with `predecessorSessionId` attribution, since the successor's OWN id now not
// carrying an op is no longer proof nothing is running); `confirmWorkerMergeTracked` uses the SAME walk to
// pick which key to attach() under, so a confirm addressed to the successor dedupe-attaches onto the
// predecessor's already-running op instead of minting a second one. Nothing is mutated — the op keeps its
// original key/tombstone forever; only the READS (and the WRITE's own key *selection*, never the op's
// stored identity) are lineage-aware.
//
// HERMETIC: mirrors merge-confirm-dead-owner-recovery.mjs's "zombie op" pattern — a never-settling stub
// `run()` seeded directly via `pendingOps.attach`, no real git/gate involved (the successor's worktree is
// a nonexistent path, so confirmWorkerMergeTracked's own `alreadyFinished` short-circuit skips the
// git-based verdictIdentity resolution entirely — this test is about KEY RESOLUTION, not merge mechanics).
//
// Proves:
//   (1) peekPendingMerge(predecessor) — the common, never-recycled case — is BYTE-IDENTICAL: no
//       `predecessorSessionId`, plain op view.
//   (2) peekPendingMerge(successor) — THE FIX — finds the predecessor's still-running op and attributes
//       it via `predecessorSessionId`.
//   (3) NEGATIVE CONTROL: peekPendingMerge on an UNRELATED worker (no recycledFrom link at all) finds
//       NOTHING — the lineage walk doesn't spuriously match an unrelated running op.
//   (4) confirmWorkerMergeTracked, called with the SUCCESSOR's id, dedupe-ATTACHES to the predecessor's
//       running op (same opId, `settled:false`) instead of minting a second one.
//   (5) THE ACTUAL SURFACE-2 CLOSE: after that call, there is still exactly ONE "merge" op in the whole
//       registry — no second entry was ever created under `merge:${successorId}`.
//   (6) CODE REVIEW FOLLOW-UP (Minor, on this same card): the write-site key selection must adopt a
//       predecessor's key ONLY while that op is still RUNNING, never a merely-RETAINED (already-settled)
//       view — otherwise a re-confirm after the predecessor's op settles would mint a FRESH op under the
//       PREDECESSOR's key, and the successor's own genuinely-new merge would forever misreport as "my
//       predecessor's op" (mirror image of this card's own bug). Uses a REAL repo+worktree (unlike (1)-(5)
//       above) because this scenario's confirm call is NOT expected to dedupe-attach — it must actually
//       run a fresh merge for real.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-worker-lineage-resolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mwlr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mwlr@loom -c user.name=mwlr";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMergeTracked, on a pure dedupe-ATTACH call, never reaches pty.stop/isAlive/enqueueStdin at
// all (it races the EXISTING entry's settlement — `confirmWorkerMerge`, the run() this would invoke on a
// fresh mint, is never called) — a stub is sufficient, mirrors merge-confirm-dead-owner-recovery.mjs.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 100 });

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mwlr-proj-${sfx}`, agentId = `mwlr-agent-${sfx}`, taskId = `mwlr-task-${sfx}`;
const liveMgrId = `mwlr-mgr-${sfx}`;
const predId = `mwlr-pred-${sfx}`, succId = `mwlr-succ-${sfx}`, unrelatedId = `mwlr-unrelated-${sfx}`;
// Nonexistent on purpose — makes confirmWorkerMergeTracked's own `worktreeGone` check true, so
// `alreadyFinished:true` and the git-based verdictIdentity resolution is skipped entirely. This test is
// about which KEY gets attached to, not merge mechanics.
const goneWorktree = path.join(os.tmpdir(), `loom-mwlr-gone-${sfx}`);

try {
  db.insertProject({ id: projId, name: "MWLR", repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MWLR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: liveMgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The PREDECESSOR worker — hard-stopped by worker_recycle in the real path, but its session ROW is never
  // deleted (mirrors recycleWorker's own shape: `processState:"exited"`, still present for lineage walks).
  db.insertSession({ id: predId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: goneWorktree, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: liveMgrId, taskId, worktreePath: goneWorktree, branch: "loom/mwlr" });
  // The SUCCESSOR worker — a fresh id, `recycledFrom` pointing at the predecessor, SAME worktree/branch
  // (recycleWorker reuses both verbatim — "SAME worktree — code state persists").
  db.insertSession({ id: succId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: goneWorktree, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: liveMgrId, taskId, worktreePath: goneWorktree, branch: "loom/mwlr", recycledFrom: predId });
  // An UNRELATED worker — no recycledFrom link to predId at all — the negative control.
  db.insertSession({ id: unrelatedId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: goneWorktree, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: liveMgrId, taskId: null });

  // ── seed a "zombie" (never-settling) merge op under the PREDECESSOR's key — the exact shape a real
  // op left running across a mid-gate worker_recycle. Owned by the LIVE manager (not a dead one — this
  // test is purely about KEY resolution, not the separate dead-owner-eviction machinery). ─────────────
  const predKey = `merge:${predId}`;
  void sessions.pendingOps.attach(predKey, "merge", liveMgrId, 10, () => new Promise(() => {}));
  await waitUntil(
    () => sessions.pendingOps.peek(predKey)?.state === "running",
    { label: "predecessor's merge op observable as running" },
  );
  const zombie = sessions.pendingOps.peek(predKey);

  // ── (1) BYTE-IDENTICAL: peeking the PREDECESSOR's own id (the never-recycled shape) ─────────────────
  const viaPred = sessions.peekPendingMerge(predId);
  check("(1) peekPendingMerge(predecessor) finds its own op", viaPred?.opId === zombie.opId && viaPred?.state === "running");
  check("(1) …with NO predecessorSessionId attribution — this IS its own op", viaPred?.predecessorSessionId === undefined);

  // ── (2) THE FIX: peeking the SUCCESSOR's id finds the predecessor's still-running op ────────────────
  const viaSucc = sessions.peekPendingMerge(succId);
  check("(2) peekPendingMerge(successor) finds the SAME op the predecessor's own key holds (was blind before this fix)", viaSucc?.opId === zombie.opId && viaSucc?.state === "running");
  check("(2) …attributed to the predecessor, so a reader can tell \"my op\" from \"my predecessor's op\"", viaSucc?.predecessorSessionId === predId);

  // ── (3) NEGATIVE CONTROL: an UNRELATED worker (no recycledFrom chain to predId) sees NOTHING ─────────
  const viaUnrelated = sessions.peekPendingMerge(unrelatedId);
  check("(3) NEGATIVE CONTROL: an unrelated worker's own lineage walk does not spuriously find the predecessor's op", viaUnrelated === undefined);

  // ── (4) confirmWorkerMergeTracked, addressed to the SUCCESSOR, dedupe-ATTACHES to the SAME op ────────
  const before = sessions.pendingOps.listAllOfKind("merge").length;
  check("(4) precondition: exactly one merge op exists before this call", before === 1);
  const result = await sessions.confirmWorkerMergeTracked(liveMgrId, succId);
  check("(4) degrades to pending (dedupe-attached to a never-settling run, not a fresh short-circuit)", result.settled === false);
  check("(4) THE FIX: the pending response carries the PREDECESSOR's opId — same real op, not a second mint", result.op.opId === zombie.opId);

  // ── (5) SURFACE 2 CLOSED: still exactly ONE merge op in the whole registry — no second entry was ever
  // created under `merge:${succId}` ────────────────────────────────────────────────────────────────────
  const after = sessions.pendingOps.listAllOfKind("merge");
  check("(5) exactly ONE merge op still exists — confirming against the successor never minted a second, concurrent op", after.length === 1);
  check("(5) that one op is still the predecessor's original opId", after[0]?.opId === zombie.opId);
  check("(5) `merge:${succId}` itself was never populated — the successor never got its OWN entry", sessions.pendingOps.peek(`merge:${succId}`) === undefined);

  // ── (6) THE RUNNING-ONLY FIX (Code Review Minor, card `3a2dac9c`) — a RETAINED predecessor view must
  // NOT be adopted by the write site ──────────────────────────────────────────────────────────────────
  const repo6 = path.join(os.tmpdir(), `loom-mwlr-repo6-${sfx}`);
  fs.mkdirSync(repo6, { recursive: true });
  fs.writeFileSync(path.join(repo6, "README.md"), "# mwlr\n");
  execSync(`git init -q && git config user.email mwlr@loom && git config user.name mwlr`, { cwd: repo6 });
  commitAll(repo6, "init", GIT_ID);
  const { worktreePath: wt6, branch: branch6 } = await createWorktree(repo6, `${projId}-6`, `${taskId}-6`);
  fs.writeFileSync(path.join(wt6, "feat6.txt"), "work\n");
  commitAll(wt6, "feat6", GIT_ID);
  db.insertProject({ id: `${projId}-6`, name: "MWLR6", repoPath: repo6, vaultPath: repo6, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${agentId}-6`, projectId: `${projId}-6`, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: `${taskId}-6`, projectId: `${projId}-6`, title: "MWLR6-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: `${liveMgrId}-6`, projectId: `${projId}-6`, agentId: `${agentId}-6`, engineSessionId: null, title: null, cwd: repo6, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const pred6Id = `mwlr-pred6-${sfx}`, succ6Id = `mwlr-succ6-${sfx}`;
  db.insertSession({ id: pred6Id, projectId: `${projId}-6`, agentId: `${agentId}-6`, engineSessionId: null, title: null, cwd: wt6, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${liveMgrId}-6`, taskId: `${taskId}-6`, worktreePath: wt6, branch: branch6 });
  db.insertSession({ id: succ6Id, projectId: `${projId}-6`, agentId: `${agentId}-6`, engineSessionId: null, title: null, cwd: wt6, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${liveMgrId}-6`, taskId: `${taskId}-6`, worktreePath: wt6, branch: branch6, recycledFrom: pred6Id });

  // Seed a quickly-SETTLING (not never-settling) op under the predecessor's key, with retention on — the
  // shape `peekPendingMerge` shows briefly after any real merge settles (card d1aee5f1's RETAINED TERMINAL
  // VIEW), here standing in for "the predecessor's op already finished before this successor's own confirm".
  const pred6Key = `merge:${pred6Id}`;
  void sessions.pendingOps.attach(pred6Key, "merge", `${liveMgrId}-6`, 10, () => Promise.resolve({ merged: false, reason: "retained-precondition" }), undefined, { retainMs: 5000 });
  await waitUntil(() => sessions.pendingOps.peek(pred6Key)?.state !== "running", { label: "(6) predecessor's op observable as SETTLED (retained)" });
  const retainedPred = sessions.pendingOps.peek(pred6Key);
  check("(6) precondition: predecessor's op settled into a RETAINED terminal view (not running)", retainedPred !== undefined && retainedPred.state !== "running");

  // Sanity (unaffected by this fix — the READ side still surfaces a retained predecessor view; that's a
  // harmless display fill, not the bug):
  const viaSucc6 = sessions.peekPendingMerge(succ6Id);
  check("(6) sanity: peekPendingMerge(successor) still surfaces the retained predecessor view (read side unaffected)", viaSucc6?.opId === retainedPred.opId && viaSucc6?.predecessorSessionId === pred6Id);

  // NOTE: this file's shared `sessions` instance uses a tight `syncAttachBudgetMs:100` (right-sized for
  // scenarios (1)-(5)'s never-settling zombie ops) — too tight for a REAL git merge to reliably finish
  // synchronously, so a FIXED call may itself degrade to `{settled:false}` before the real merge lands (a
  // SEPARATE `SessionService` with a generous budget, mirroring merge-confirm-dead-owner-recovery.mjs's
  // `sessionsFast`, would need its OWN registry and so could never see `pred6Key` above). A BROKEN call,
  // by contrast, serves the predecessor's cached retained verdict SYNCHRONOUSLY (`settled:true,
  // cacheHit:{...}`, no `.op` at all) — so this must not assume either shape going in.
  const result6 = await sessions.confirmWorkerMergeTracked(`${liveMgrId}-6`, succ6Id);
  check("(6) THE FIX: confirmWorkerMergeTracked did NOT serve the predecessor's cached RETAINED verdict as its own (would read settled+cacheHit, no .op)", !(result6.settled === true && !!result6.cacheHit));
  const succ6Key = `merge:${succ6Id}`;
  let mergedForReal;
  if (result6.settled === false) {
    check("(6) THE FIX: the pending response carries a genuinely DIFFERENT opId, not the predecessor's", result6.op.opId !== retainedPred.opId);
    await waitUntil(() => sessions.pendingOps.peek(succ6Key)?.state !== "running", { label: "(6) successor's own fresh merge op settled", timeoutMs: 60_000 });
    mergedForReal = sessions.pendingOps.peek(succ6Key)?.outcome === "merged";
  } else {
    mergedForReal = result6.ok === true && result6.value?.merged === true;
  }
  check("(6) it actually ran a REAL merge for the successor's own worktree (never the predecessor's stubbed value)", mergedForReal);
  check("(6) the successor's file actually landed on main", fs.existsSync(path.join(repo6, "feat6.txt")));
  check("(6) the predecessor's retained view is UNCHANGED afterward — never clobbered by the successor's fresh mint", sessions.pendingOps.peek(pred6Key)?.opId === retainedPred.opId);
} finally {
  db.close();
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(path.join(os.tmpdir(), `loom-mwlr-repo6-${sfx}`), { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge op minted before a worker_recycle stays registered under the PREDECESSOR's key forever (nothing rewrites it), so peekPendingMerge/confirmWorkerMergeTracked now resolve it by walking the successor's `recycledFrom` chain backward: peekPendingMerge on the successor's own id finds the predecessor's still-running op (attributed via predecessorSessionId) instead of reading blind, an unrelated worker's own lineage walk finds nothing (negative control), a re-confirm addressed to the successor dedupe-attaches onto the SAME real op instead of minting a second, genuinely concurrent one — closing the exact hole PendingOpRegistry's dedupe exists to prevent — and (Code Review follow-up) the write site adopts a predecessor's key ONLY while it's still RUNNING, never a merely-retained/settled one, so a successor's own genuinely-fresh merge is never misreported as its predecessor's."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
