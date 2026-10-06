import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 59986602 — makes confirmWorkerMerge's pre-admission wait on its worker's own
// `run_gate` self-check (card 5f7d7a01, Round 4 of docs/decisions/164f7915-*.md) ABORTABLE via `gate_cancel`,
// and surfaces the parked merge in `gate_queue`'s new `waitingOnSelfCheck` array.
//
// THE FIX: `confirmWorkerMerge`'s wait (`pendingOps.waitBriefly('gate:'+workerSessionId, gateTimeoutMs,
// abortSignal)`) races against a locally-owned abort signal registered in `SessionService.parkedMergeWaits`,
// keyed by the MERGE's own opId (never the self-check's). `gateQueueForManager` reads that SAME map to
// populate `waitingOnSelfCheck`; `cancelGateOp` reads it as a third fallback (after the ordinary gate
// registry and the repo-guard-only wait) to resolve a caller-supplied MERGE opId into the registered
// `cancel()` call. Cancelling ends only the MERGE's own wait — the self-check itself is left running,
// untouched, exactly as the manager's plan review ruled: "a manager who cancels a merge wants it NOT to
// land" (so the merge settles the SAME clean `cancelled` outcome a QUEUED merge gate withdrawal already
// produces), and cancelling the self-check instead doesn't even help the worst case named in the card (an
// unverified kill leaves `runWorkerGate`'s own promise unresolved forever).
//
// THE SEAM: no admission race is needed here (unlike merge-confirm-self-check-admission-race.mjs) — a
// `pendingOps` entry's `state` is "running" from the instant it is MINTED, well before any GateSemaphore
// admission (see `peekPendingMerge`'s own doc) — so a plain `runWorkerGate(workerId)` call already satisfies
// confirmWorkerMerge's `gate:<id>` "running" check with no cap-saturating holder or timing race required.
//
// Scenarios:
//   (1) THE WORST CASE NAMED IN THE CARD: the self-check's own gate call NEVER resolves (the "unverified
//       kill" shape — even a real kill attempt could leave `runWorkerGate`'s promise unsettled forever).
//       Cancelling the MERGE's own opId must still end the wait PROMPTLY (it never depends on the
//       self-check's own settle/kill at all) — the merge settles `cancelled`/`manual`, the self-check is
//       left genuinely RUNNING, untouched, and nothing downstream (gate/squash) ever ran. `pConfirm` is
//       raced against a bounded, fail-fast deadline (`withDeadline`, never a sleep that gates success) so
//       a regression that defeats the cancel produces a NAMED FAIL instead of an indefinite hang.
//   (2) A DEFERRED self-check, raced both ways (Code Review round 2 — the prior version of this scenario
//       cancelled an already-dead opId, which `not_found` already covered before this card existed and
//       proved nothing about the fix):
//       (2a) resolve the self-check's own gate AND fire `cancelGateOp` in the SAME synchronous tick, before
//            confirmWorkerMerge's own continuation ever runs — a deterministic stand-in for "the abort lands
//            just as the self-check settles naturally": asserts a CONSISTENT pair (cancel reports cancelled
//            AND the merge settles cancelled — never both outcomes, never neither; no squash, main sha
//            unchanged).
//       (2b) the converse — wait until the parked row has already LEFT `waitingOnSelfCheck` (the wait ended
//            naturally; the self-check won) before calling `cancelGateOp`: `not_found`, and the merge
//            actually lands (main sha DOES advance — a real squash happened).
//   (3) NEGATIVE CONTROL: with the abort wiring NEUTRALISED (monkeypatch `parkedMergeWaits.set` to a no-op
//       — never touching a missing export, never reverting source) the exact same parked shape as (1)
//       produces NO `waitingOnSelfCheck` row and `cancelGateOp` reports `not_found` — proving the assertions
//       in (1) actually exercise the new wiring, not something that was already true.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-parked-wait-cancellable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mpwc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const dbs = [];
const GIT_ID = "-c user.email=mpwc@loom -c user.name=mpwc";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const GENEROUS_SYNC_BUDGET_MS = 600_000; // DI seam only — never the production constant (mirrors the sibling admission-race test)
// Code Review round 2: a FAIL-FAST bound for a promise that a regression could leave hanging forever (the
// reviewer's own mutations B/C turned this file's unbounded `await pConfirm` into an exit-124 hang, not a
// FAIL). NEVER gates the GREEN path — a successful cancel resolves in low milliseconds, orders of
// magnitude under this — it only turns "hangs forever" into a prompt, named FAIL.
const DEADLINE_MS = 10_000;

async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 16000, label } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: label ?? "mpwc: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly
  }
}

// Races `promise` against a bounded, AWAITED deadline timer (never a fixed sleep that itself gates
// success) — returns the settled value, or `undefined` on timeout/rejection (logged, never thrown), so a
// caller can assert "it SETTLED" and "it settled to X" as two separate, named, crash-free checks rather
// than the test process hanging indefinitely on a regression that defeats the fix.
async function withDeadline(promise, ms, label) {
  let timer;
  const sentinel = Symbol("mpwc-timeout");
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(sentinel), ms); });
  try {
    const v = await Promise.race([promise, timeout]);
    if (v === sentinel) { console.log(`[withDeadline] ${label} did NOT settle within ${ms}ms`); return undefined; }
    return v;
  } catch (err) {
    console.log(`[withDeadline] ${label} REJECTED: ${err?.message ?? err}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mpwc\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mpwc@loom && git config user.name mpwc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function sfxOf() { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

// Builds one isolated (db, sessions, project, manager, worker) rig whose worker's own self-check gate is
// driven by a caller-controlled `gateFor`. No cap-saturating holder needed — see the header's SEAM note.
async function buildRig(sfx, gateFor) {
  const reposDir = path.join(os.tmpdir(), `loom-mpwc-repos-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);

  const projId = `mpwc-p-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MPWC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });

  const taskId = `mpwc-task-${sfx}`;
  const wt = await createWorktree(repo, projId, taskId);
  registerForCleanup(wt.worktreePath);
  db.insertTask({ id: taskId, projectId: projId, title: "MPWC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  commitAll(wt.worktreePath, "feature", GIT_ID);

  const mgrId = `mpwc-mgr-${sfx}`, workerId = `mpwc-wkr-${sfx}`;
  db.insertAgent({ id: `agent-mgr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mgr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: gateFor, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, gateOpRetainMs: 0 });
  return { db, sessions, projId, taskId, repo, wt, mgrId, workerId };
}

// ── (1) THE WORST CASE: the self-check's own gate call NEVER resolves. Cancelling the MERGE must still
//     end the wait promptly — it never depends on the self-check's own kill/settle at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `never-${sfxOf()}`;
  let gateCalls = 0;
  const neverSettles = new Promise(() => {}); // deliberately never resolves — the unverified-kill shape
  const { db, sessions, projId, repo, taskId, wt, mgrId, workerId } = await buildRig(sfx, async () => { gateCalls++; await neverSettles; return { passed: true }; });

  const mainHeadBefore = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

  sessions.runWorkerGate(workerId); // the self-check — intentionally never awaited; it never settles
  await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state === "running", { label: "self-check minted" });

  const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const mergeOpId = await waitUntil(() => sessions.peekPendingMerge(workerId)?.opId, { label: "merge op minted" });
  check("(1) precondition: the merge op minted a real opId", typeof mergeOpId === "string" && mergeOpId.length > 0);

  const parkedRow = await waitUntil(
    () => sessions.gateQueueForManager(projId).waitingOnSelfCheck.find((e) => e.opId === mergeOpId),
    { label: "waitingOnSelfCheck row appears" },
  );
  check("(1) [gate_queue] the parked merge is surfaced in waitingOnSelfCheck", !!parkedRow);
  const selfCheckOpId = sessions.pendingOps.peek(`gate:${workerId}`)?.opId;
  check("(1) [gate_queue] blockingOpId names the self-check's own live opId", !!selfCheckOpId && parkedRow?.blockingOpId === selfCheckOpId);
  check("(1) [gate_queue] own-project row carries taskId/branch/workerLabel, not redacted", parkedRow?.redacted !== true && parkedRow?.branch === wt.branch && parkedRow?.taskId === taskId);

  const t0 = Date.now();
  const cancelResult = await withDeadline(sessions.cancelGateOp(mgrId, mergeOpId, { scope: { kind: "project" } }), DEADLINE_MS, "(1) cancelGateOp");
  const cancelElapsedMs = Date.now() - t0;
  const confirmResult = await withDeadline(pConfirm, DEADLINE_MS, "(1) pConfirm");

  check("(1) [FIX] cancelGateOp SETTLED within the bound (never hung)", cancelResult !== undefined);
  check("(1) [FIX] cancelGateOp returned PROMPTLY — never waited on the self-check's own kill/settle", cancelElapsedMs < 3000);
  check("(1) [FIX] cancelGateOp reports cancelled/queued/merge", cancelResult?.outcome === "cancelled" && cancelResult?.phase === "queued" && cancelResult?.gateType === "merge");
  check("(1) [FIX] the note names the self-check's opId and says it was left running",
    typeof cancelResult?.note === "string" && cancelResult.note.includes(selfCheckOpId) && /left running/i.test(cancelResult.note));
  check("(1) [FIX] confirmWorkerMergeTracked SETTLED within the bound (never hung)", confirmResult !== undefined);
  check("(1) [FIX] the merge settled the SAME clean cancelled shape a QUEUED merge-gate withdrawal uses",
    confirmResult?.settled === true && confirmResult?.ok === true && confirmResult?.value?.cancelled === true && confirmResult?.value?.cancelKind === "manual");
  check("(1) [FIX] exactly one of cancelled/merged — never both", (confirmResult?.value?.cancelled === true) !== (confirmResult?.value?.merged === true));
  check("(1) [FIX] the row left gate_queue the instant the wait ended", sessions.gateQueueForManager(projId).waitingOnSelfCheck.length === 0);

  // DoD: nothing downstream ran (no second gate, no squash), and the self-check was left alone.
  check("(1) [DoD] no second (merge-own) gate invocation ever happened", gateCalls === 1);
  check("(1) [DoD] the self-check itself is left RUNNING, untouched by the merge's own cancel", sessions.pendingOps.peek(`gate:${workerId}`)?.state === "running");
  const mainHeadAfter = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  check("(1) [DoD] main's sha is UNCHANGED — no squash ever reached the canonical repo", mainHeadAfter === mainHeadBefore);
  check("(1) [DoD] the task's mergedSha stays unset", db.getTask(taskId)?.mergedSha == null);
}

// ── (2a) DEFERRED self-check: resolve it AND fire cancelGateOp in the SAME synchronous tick, before
//     confirmWorkerMerge's own continuation ever runs — a deterministic stand-in for "the abort lands just
//     as the self-check settles naturally." Asserts a CONSISTENT pair: cancelled + cancelled, no squash.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `race-a-${sfxOf()}`;
  let gateCalls = 0;
  let resolveSelfCheck;
  const deferred = new Promise((res) => { resolveSelfCheck = res; });
  const { db, sessions, projId, repo, taskId, wt, mgrId, workerId } = await buildRig(sfx, async () => { gateCalls++; await deferred; return { passed: true }; });

  const mainHeadBefore = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

  sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state === "running", { label: "self-check minted" });
  const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const mergeOpId = await waitUntil(() => sessions.peekPendingMerge(workerId)?.opId, { label: "merge op minted" });
  await waitUntil(() => sessions.gateQueueForManager(projId).waitingOnSelfCheck.some((e) => e.opId === mergeOpId), { label: "waitingOnSelfCheck row appears" });
  check("(2a) precondition: the parked row is visible before the race", sessions.gateQueueForManager(projId).waitingOnSelfCheck.some((e) => e.opId === mergeOpId));

  // SAME TICK, no await in between: whichever continuation's own chain reaches the wait first decides the
  // race deterministically (JS has no preemption mid-synchronous-run) — never a wall-clock guess.
  resolveSelfCheck();
  const cancelPromise = sessions.cancelGateOp(mgrId, mergeOpId, { scope: { kind: "project" } });

  const cancelResult = await withDeadline(cancelPromise, DEADLINE_MS, "(2a) cancelGateOp");
  const confirmResult = await withDeadline(pConfirm, DEADLINE_MS, "(2a) pConfirm");

  check("(2a) [FIX] cancelGateOp SETTLED within the bound (never hung)", cancelResult !== undefined);
  check("(2a) [FIX] cancelGateOp reports cancelled", cancelResult?.outcome === "cancelled");
  check("(2a) [FIX] confirmWorkerMergeTracked SETTLED within the bound (never hung)", confirmResult !== undefined);
  check("(2a) [FIX] the merge settled the SAME clean cancelled shape", confirmResult?.settled === true && confirmResult?.ok === true && confirmResult?.value?.cancelled === true && confirmResult?.value?.cancelKind === "manual");
  check("(2a) [FIX] exactly one of cancelled/merged — never both, never neither", (confirmResult?.value?.cancelled === true) !== (confirmResult?.value?.merged === true));
  const mainHeadAfter = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  check("(2a) [DoD] main's sha is UNCHANGED when cancel wins the same-tick race — no squash", mainHeadAfter === mainHeadBefore);
  check("(2a) [DoD] the task's mergedSha stays unset", db.getTask(taskId)?.mergedSha == null);
}

// ── (2b) THE CONVERSE: wait until the parked row has already LEFT waitingOnSelfCheck (the wait ended
//     naturally; the self-check won) BEFORE attempting to cancel — not_found, and the merge actually lands.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `race-b-${sfxOf()}`;
  const { sessions, repo, mgrId, workerId } = await buildRig(sfx, async () => ({ passed: true }));

  const mainHeadBefore = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

  sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state === "running", { label: "self-check minted" });
  const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const mergeOpId = await waitUntil(() => sessions.peekPendingMerge(workerId)?.opId, { label: "merge op minted" });

  // `parkedMergeWaits` NO LONGER HOLDING this opId is the one observable event proving the wait already
  // ended naturally — checked directly (same field `cancelGateOp`/`gateQueueForManager` themselves read),
  // never a fixed sleep, and never a two-step "wait for the row to appear, then wait for it to leave"
  // (this self-check resolves near-instantly, so the row can come and go between two separate polls
  // without either one ever observing it — exactly what made this step cost a full multi-poll timeout
  // before this fix).
  await waitUntil(() => sessions.parkedMergeWaits.has(mergeOpId) === false, { label: "parked wait cleared (wait ended naturally)" });

  const cancelResult = await withDeadline(sessions.cancelGateOp(mgrId, mergeOpId, { scope: { kind: "project" } }), DEADLINE_MS, "(2b) cancelGateOp");
  const confirmResult = await withDeadline(pConfirm, DEADLINE_MS, "(2b) pConfirm");

  check("(2b) [CONTROL] cancelGateOp SETTLED within the bound", cancelResult !== undefined);
  check("(2b) [CONTROL] cancelGateOp reports not_found once the wait has already ended naturally — never a false cancel", cancelResult?.outcome === "not_found");
  check("(2b) [CONTROL] confirmWorkerMergeTracked SETTLED within the bound", confirmResult !== undefined);
  check("(2b) [CONTROL] the merge actually landed (not cancelled)", confirmResult?.settled === true && confirmResult?.ok === true && confirmResult?.value?.merged === true && confirmResult?.value?.cancelled !== true);
  const mainHeadAfter = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  check("(2b) [CONTROL] main's sha ADVANCED — a real squash landed", mainHeadAfter !== mainHeadBefore);
}

// ── (3) NEGATIVE CONTROL: neutralise the abort wiring (monkeypatch `parkedMergeWaits.set` to a no-op —
//     never a missing export, never reverted source) against the EXACT SAME parked shape as (1): no
//     `waitingOnSelfCheck` row, and `cancelGateOp` falls back to `not_found` — proving (1)'s assertions
//     actually exercise this card's new wiring, not something already true beforehand.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `neutral-${sfxOf()}`;
  const neverSettles = new Promise(() => {});
  const { sessions, projId, mgrId, workerId } = await buildRig(sfx, async () => { await neverSettles; return { passed: true }; });

  const realSet = sessions.parkedMergeWaits.set.bind(sessions.parkedMergeWaits);
  sessions.parkedMergeWaits.set = () => sessions.parkedMergeWaits; // neutralise: never register, so nothing is ever discoverable

  sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state === "running", { label: "self-check minted" });
  sessions.confirmWorkerMergeTracked(mgrId, workerId); // intentionally never awaited — this is the pre-fix shape, parked forever
  const mergeOpId = await waitUntil(() => sessions.peekPendingMerge(workerId)?.opId, { label: "merge op minted" });
  check("(3) precondition: the merge op minted a real opId (same shape as (1))", typeof mergeOpId === "string" && mergeOpId.length > 0);

  // Give the (neutralised) wiring the SAME chance to surface the row that (1) proved it does — a short,
  // bounded poll that is expected to time out and return the honest `undefined` (never a row), not a
  // fixed-wait assertion that something did NOT happen (see this project's own fixed-wait-witness guard):
  // the absence is cross-checked below by `waitUntil`'s own last-try re-read, not inferred from a sleep.
  const parkedRow = await waitUntil(
    () => sessions.gateQueueForManager(projId).waitingOnSelfCheck.find((e) => e.opId === mergeOpId),
    { timeoutMs: 800, label: "neutralised: waitingOnSelfCheck row (expected absent)" },
  );
  check("(3) [NEGATIVE CONTROL] no waitingOnSelfCheck row — the wiring is genuinely neutralised", !parkedRow);

  const cancelResult = await withDeadline(sessions.cancelGateOp(mgrId, mergeOpId, { scope: { kind: "project" } }), DEADLINE_MS, "(3) cancelGateOp");
  check("(3) [NEGATIVE CONTROL] cancelGateOp falls back to not_found, exactly like pre-fix code", cancelResult?.outcome === "not_found");

  sessions.parkedMergeWaits.set = realSet;
}

for (const db of dbs) try { db.close(); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge's pre-admission wait on its worker's self-check (card 59986602) is cancellable via the merge's own opId, ends promptly (within a fail-fast deadline, never hanging) even when the self-check's own kill would never verify, leaves the self-check running untouched, stays consistent under a same-tick race against the self-check's own natural completion either direction (cancel wins ⇒ cancelled+no-squash; natural completion wins ⇒ not_found+landed), and is surfaced in gate_queue's new waitingOnSelfCheck array — all proven against a negative control showing the SAME parked shape produces none of this when the new wiring is neutralised."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
