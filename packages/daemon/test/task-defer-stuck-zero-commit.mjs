import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 93669813 — the defect: a `deferredUntilTaskId` blocker that closes `done` with ZERO commits (a
// legitimate, doctrine-sanctioned outcome — see /orchestrate) produces no squash commit, so its
// git-derived `merged` stays null FOREVER. `resolveDeferredEffective` (mcp/tasks.ts) only auto-clears
// `deferred` on a non-null `merged`, so a dependent card deferred behind that blocker used to be pinned
// PERMANENTLY DEFERRED with no signal anywhere that the release condition became unreachable — and
// `deferred:true` is SIMULTANEOUSLY discounted from the idle watchdog's actionable count
// (orchestration/idle-watcher.ts), so the stuck card was INVISIBLE: a manager could legitimately reach
// "backlog drained" while a ready-to-merge (or simply abandoned) branch sat parked forever.
//
// FIX: a new DERIVED-but-persisted `deferredStuck` field (Task.deferredStuck) — `deferred` itself still
// only clears on a proven `merged`, exactly as before; `deferredStuck` is an orthogonal VISIBILITY signal
// that flips true once the blocker can no longer be shown to resolve (closed-terminal-with-no-merge, or
// deleted/dangling), consumed by both idle-watcher.ts and wake-impact.ts so a stuck deferral counts as
// actionable again instead of staying silently discounted.
//
// HERMETIC: a real temp git repo (execSync) + a real Db, driving the built business logic directly
// (dist/mcp/tasks.js + dist/db.js + dist/orchestration/idle-watcher.js + dist/orchestration/wake-impact.js)
// — no daemon, no real claude.
//
// Proves:
//   (A) POSITIVE — a blocker closed `done` at 0 commits: the dependent's read (getProjectTask AND
//       listProjectTasks) surfaces `deferredStuck:true`, `deferred` stays `true` (scope guard: a 0-commit
//       close must never be silently redefined as un-defer), the RAW DB row self-heals (write-through,
//       same pattern as `deferred`'s own auto-clear), and a second read doesn't write-storm it again.
//   (B) POSITIVE, DoD 4 — a blocker DELETED after being validly set (the archived/deleted-blocker route)
//       is the SAME shape: stays deferred, but now ALSO surfaces `deferredStuck:true`.
//   (C) POSITIVE — the idle watchdog: a board whose ONLY non-terminal cards are exactly these two stuck
//       deferrals is genuinely actionable (nudges, names both cards, tags them STUCK in the nudge text)
//       instead of reading as "nothing to do" — the manager-facing symptom the card describes ("silent in
//       exactly the direction that suppresses its own discovery"). `hasPendingBoardWork`
//       (orchestration/wake-impact.ts, the restart-wake sibling definition) agrees.
//   (D) NEGATIVE CONTROL — a blocker that's simply still open (unmerged, NOT in the terminal column) must
//       NOT be flagged stuck: this is the ordinary, correctly-still-deferred case, and firing early here
//       would be a false positive that trains managers to ignore the flag.
//   (E) NEGATIVE CONTROL — a blocker that actually MERGES still auto-clears `deferred` to `false` exactly
//       as before, with `deferredStuck` false throughout — proves the new stuck-check doesn't regress the
//       pre-existing merge-based auto-clear path (see task-defer-until.mjs for that path's own full coverage).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-defer-stuck-zero-commit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");
const { IdleWatcher } = await import("../dist/orchestration/idle-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { hasPendingBoardWork } = await import("../dist/orchestration/wake-impact.js");

const repo = path.join(os.tmpdir(), `loom-defer-stuck-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-stuck-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();
const NOW = new Date();
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

// Write-count spy on db.updateTask (card 74ecd674 review finding — fixed-wait-negative-guard.mjs
// correctly rejected a fixed-wait-guarded negative assertion below). better-sqlite3 is SYNCHRONOUS, so
// persistDeferredStateBestEffort's db.updateTask call (if it fires at all) completes INSIDE the same
// awaited getProjectTask/listProjectTasks call — there is no macrotask gap a sleep could ever need to
// wait out, so a "no write" proof should COUNT calls, not time them: a deterministic assertion that
// fails loudly at any delay, rather than one that passes "for the wrong reason" if a write merely
// arrives after a guessed window. Counts EVERY updateTask call, not just self-heal ones — tests reset
// it to 0 immediately before the read under test, so an unrelated setup call earlier never pollutes it.
let updateTaskCalls = 0;
const _updateTask = db.updateTask.bind(db);
db.updateTask = (...args) => { updateTaskCalls++; return _updateTask(...args); };

try {
  // Default project config — no kanbanColumns override, so the "done" column carries the default
  // `terminal` role (PLATFORM_DEFAULTS) with no test-side wiring needed.
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // --- (A) 0-commit close: blocker moves to "done" with NO git commit landed ---
  const blocker = createProjectTask(db, "pRepo", { title: "diagnostic blocker (closes 0-commit)" });
  const dependent = createProjectTask(db, "pRepo", { title: "dependent card A" });
  const setA = await updateProjectTask(db, "pRepo", dependent.id, { deferred: true, deferredUntilTaskId: blocker.id });
  check("(A) set deferred+deferredUntilTaskId succeeds (no error)", !("error" in setA));
  const closeA = await updateProjectTask(db, "pRepo", blocker.id, { columnKey: "done" }); // 0 commits — no git call
  check("(A) blocker closes done (0 commits, no git activity)", !("error" in closeA));

  // Reset the write-count spy right before the read that triggers the self-heal transition, so the very
  // next check proves the spy CAN observe a real write (not vacuously always 0) before the later
  // "second read: zero calls" assertion leans on the same counter to prove an absence.
  updateTaskCalls = 0;
  const gotA = await getProjectTask(db, "pRepo", dependent.id);
  check("(A) the self-heal transition makes EXACTLY ONE db.updateTask call (proves the spy detects a real write)", updateTaskCalls === 1);
  check("(A) scope: deferred stays true — a 0-commit close must NOT be silently redefined as un-defer", gotA.deferred === true);
  check("(A) getProjectTask: deferredStuck flips true for a 0-commit-closed blocker", gotA.deferredStuck === true);
  const listA = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowA = listA.find((t) => t.id === dependent.id);
  check("(A) listProjectTasks (the board summary): ALSO surfaces deferredStuck:true", rowA?.deferredStuck === true);
  const rawA = db.getTask(dependent.id);
  check("(A) self-heal: the RAW DB row is persisted deferredStuck=true (idle-watchdog's own db.listTasks picks it up)", rawA.deferredStuck === true);
  check("(A) self-heal did NOT touch deferred or deferredUntilTaskId (only stuck changed, blocker still named)", rawA.deferred === true && rawA.deferredUntilTaskId === blocker.id);
  const updatedAtAfterStuck = rawA.updatedAt;

  // No write-storm: a second read after the stuck flag has already landed must not write again. PROVEN
  // BY COUNT, not by timing (see the spy's own comment above) — reset right before the read under test,
  // so this is a deterministic assertion about a quantity, not a guess about how long a write takes.
  updateTaskCalls = 0;
  const gotASecond = await getProjectTask(db, "pRepo", dependent.id);
  check("(A) second read: still deferredStuck:true", gotASecond.deferredStuck === true);
  check("(A) second read makes ZERO db.updateTask calls (write-count, not a timed guess)", updateTaskCalls === 0);
  const rawASecond = db.getTask(dependent.id);
  check("(A) second read performs NO further write — updatedAt unchanged (corroborates the write-count)", rawASecond.updatedAt === updatedAtAfterStuck);

  // --- (B) DoD 4 — the archived/deleted-blocker route: same shape, now ALSO visible ---
  const blocker2 = createProjectTask(db, "pRepo", { title: "blocker card (will be deleted)" });
  const dependent2 = createProjectTask(db, "pRepo", { title: "dependent card B" });
  await updateProjectTask(db, "pRepo", dependent2.id, { deferred: true, deferredUntilTaskId: blocker2.id });
  db.deleteTask(blocker2.id);
  const gotB = await getProjectTask(db, "pRepo", dependent2.id);
  check("(B) scope: a dangling blocker still degrades to stays-deferred (unchanged, never throws)", gotB.deferred === true);
  check("(B) a dangling/deleted blocker ALSO surfaces deferredStuck:true", gotB.deferredStuck === true);

  // --- (F) REGRESSION GUARD (manager review finding) — a read with includeMerged:false must NEVER
  // clear a persisted stuck flag. The companion board calls listProjectTasks/getProjectTask exactly this
  // way (companion/capabilities.ts:1123/1158); an unmeasured merged state ("we didn't check") must never
  // be written down as a measured "not stuck" — that would silently un-stick a genuinely-stuck card the
  // next time the companion board is read, reopening this exact card's defect at that boundary. Reuses
  // dependent (from A), which is already persisted deferredStuck:true. Asserts against the RAW DB row,
  // not just the returned object — the returned value can look right while the write-through has
  // already corrupted the row underneath it. ---
  const preF = db.getTask(dependent.id);
  check("(F) precondition: dependent (A) is still persisted deferredStuck=true going in", preF.deferredStuck === true);
  const listF = await listProjectTasks(db, "pRepo", { includeBody: true, includeMerged: false });
  const rowF = listF.find((t) => t.id === dependent.id);
  const rawFAfterList = db.getTask(dependent.id);
  check("(F) listProjectTasks({includeMerged:false}) does NOT clear the RAW DB row's deferred_stuck", rawFAfterList.deferredStuck === true);
  check("(F) listProjectTasks({includeMerged:false}) still REPORTS the true persisted value (not a stale false)", rowF?.deferredStuck === true);
  const gotF = await getProjectTask(db, "pRepo", dependent.id, { includeMerged: false });
  const rawFAfterGet = db.getTask(dependent.id);
  check("(F) getProjectTask({includeMerged:false}) does NOT clear the RAW DB row's deferred_stuck either", rawFAfterGet.deferredStuck === true);
  check("(F) getProjectTask({includeMerged:false}) ALSO reports the true persisted value (not a stale false)", gotF.deferredStuck === true);

  // --- (D) NEGATIVE CONTROL — a blocker that's simply still open must NOT be flagged stuck ---
  const blocker3 = createProjectTask(db, "pRepo", { title: "blocker card (still open)" });
  const dependent3 = createProjectTask(db, "pRepo", { title: "dependent card D (blocker still live)" });
  await updateProjectTask(db, "pRepo", dependent3.id, { deferred: true, deferredUntilTaskId: blocker3.id });
  const gotD = await getProjectTask(db, "pRepo", dependent3.id);
  check("(D) NEGATIVE CONTROL: stays deferred:true while the blocker is simply still open", gotD.deferred === true);
  check("(D) NEGATIVE CONTROL: deferredStuck stays FALSE — an unmerged, non-terminal blocker is not stuck, just pending", gotD.deferredStuck === false);

  // --- (E) NEGATIVE CONTROL — a blocker that actually merges still auto-clears exactly as before ---
  const blocker4 = createProjectTask(db, "pRepo", { title: "blocker card (will actually merge)" });
  const dependent4 = createProjectTask(db, "pRepo", { title: "dependent card E (blocker will merge)" });
  await updateProjectTask(db, "pRepo", dependent4.id, { deferred: true, deferredUntilTaskId: blocker4.id });
  landBlocker(blocker4.id, "feat(x): blocker 4 actually landed");
  const gotE = await getProjectTask(db, "pRepo", dependent4.id);
  check("(E) NEGATIVE CONTROL: a genuinely merged blocker still auto-clears deferred to false (unchanged)", gotE.deferred === false);
  check("(E) NEGATIVE CONTROL: deferredStuck is false on the auto-cleared row (never stuck once shipped)", gotE.deferredStuck === false);
  const rawE = db.getTask(dependent4.id);
  check("(E) NEGATIVE CONTROL: raw DB row also confirms deferredStuck=false post-autoclear", rawE.deferredStuck === false);

  // --- (C) the idle watchdog + hasPendingBoardWork: a board of ONLY stuck deferrals must read as
  // actionable. Isolated on a FRESH project (same physical repo dir, harmless — task ids are unique and
  // matched by exact taskKey trailer) so the assertion counts exactly the cards this scenario creates,
  // not the (A)/(B)/(D)/(E) scaffolding cards still sitting on "pRepo" from the scenarios above. ---
  db.insertProject({ id: "pRepo2", name: "Watchdog Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  const cBlocker1 = createProjectTask(db, "pRepo2", { title: "0-commit blocker 1" });
  const cDependent1 = createProjectTask(db, "pRepo2", { title: "stuck dependent 1" });
  await updateProjectTask(db, "pRepo2", cDependent1.id, { deferred: true, deferredUntilTaskId: cBlocker1.id });
  await updateProjectTask(db, "pRepo2", cBlocker1.id, { columnKey: "done" }); // 0 commits
  const cBlocker2 = createProjectTask(db, "pRepo2", { title: "blocker 2 (will be deleted)" });
  const cDependent2 = createProjectTask(db, "pRepo2", { title: "stuck dependent 2" });
  await updateProjectTask(db, "pRepo2", cDependent2.id, { deferred: true, deferredUntilTaskId: cBlocker2.id });
  db.deleteTask(cBlocker2.id);
  // A genuinely-still-pending (non-stuck) deferred card on the SAME board — must stay discounted, proving
  // the fix doesn't just make every deferred card actionable.
  const cBlocker3 = createProjectTask(db, "pRepo2", { title: "blocker 3 (still open)" });
  const cDependent3 = createProjectTask(db, "pRepo2", { title: "pending dependent 3" });
  await updateProjectTask(db, "pRepo2", cDependent3.id, { deferred: true, deferredUntilTaskId: cBlocker3.id });
  // Trigger the self-heal write for every card before the watchdog's RAW db.listTasks read — mirrors how
  // a real board accrues `deferredStuck` from ordinary tasks_get/tasks_list traffic over time.
  await listProjectTasks(db, "pRepo2", { includeBody: true });
  check("(C) precondition: cDependent3 stays deferredStuck:false (its blocker is still genuinely open)", (await getProjectTask(db, "pRepo2", cDependent3.id)).deferredStuck === false);

  const agentId = "it-agent";
  db.insertAgent({ id: agentId, projectId: "pRepo2", name: "t", startupPrompt: "orchestrate", position: 0 });
  const mgrId = "mgr-stuck";
  db.insertSession({
    id: mgrId, projectId: "pRepo2", agentId, engineSessionId: "eng-" + mgrId, title: null, cwd: "pRepo2",
    processState: "live", resumability: "resumable", busy: false, role: "manager",
    createdAt: minutesAgo(60), lastActivity: minutesAgo(60), lastError: null,
  });
  check("(C) hasPendingBoardWork agrees: this board has actionable work", hasPendingBoardWork(db, mgrId) === true);
  const alive = new Set([mgrId]);
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0.8,
    notifyIdleWorker: () => {}, isWorkerStranded: () => true,
  });
  watcher.tick(NOW);
  // Non-terminal cards on pRepo2: cDependent1 (stuck), cDependent2 (stuck), cBlocker3 (plain open, never
  // deferred), cDependent3 (deferred but genuinely NOT stuck → discounted) = 3 actionable, not 4.
  check(
    "(C) the manager IS nudged with exactly the stuck + plain-open cards counted (3 actionable), the genuinely-pending one discounted",
    enqueued.length === 1 && enqueued[0].id === mgrId && enqueued[0].text.includes("3 actionable"),
  );
  check("(C) the nudge tags exactly the two stuck cards as STUCK", (enqueued[0]?.text.match(/STUCK/g) ?? []).length === 2);
  check("(C) the nudge does NOT name cDependent3 — it's genuinely still pending, not stuck", !enqueued[0]?.text.includes(cDependent3.id.slice(0, 8)));
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a 0-commit-closed (or deleted) blocker's unreachable deferral is surfaced as `deferredStuck` (self-healing on the raw DB row, no write-storm) on both getProjectTask and listProjectTasks, the idle watchdog and hasPendingBoardWork both count it as actionable instead of silently discounting it, a genuinely-still-pending deferral is NOT flagged stuck, and a genuinely-merged blocker still auto-clears exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
