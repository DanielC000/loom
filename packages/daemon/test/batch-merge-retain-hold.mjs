import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A RETAINED BATCH CANDIDATE STAYS HELD (card 42daa283, round 3). Companion to batch-merge-branch-advanced-during-gate.mjs (which
// proves the retain itself); THIS file proves the HOLD: once a merge_batch retains a candidate (its branch moved after assembly),
// no later merge_batch may assemble it or fallback-confirm it — its unreviewed commit(s) must never reach main behind the
// manager's back — until EITHER a merge_done NEWER than the retain exists (landed deliberately) OR its branch is POSITIVELY
// confirmed gone. Tip movement alone does NOT release it, and an UNREADABLE branch (a probe error) fails CLOSED.
// A candidate is released ONLY by a REAL merge_done (detail.reconciled !== true) newer than its latest retain event — i.e. a deliberate
// worker_merge_confirm. NOT by tip movement, NOT by a missing/unreadable branch, NOT by boot Pass A2's fabricated (reconciled) merge_done.
// One real mixed batch [A,B,C] (A retained, B landed, C dropped on a conflict and never finished) is built once; then, in order:
//   (again)      A is committed to AGAIN, then a same-ids re-fire (fresh op, since C is unfinished) — still held, both late commits off main
//   (restart)    the same re-fire through a FRESH SessionService (no process-local verdict cache) — still held
//   (restart2)   a two-candidate [A,B] re-fire through yet another fresh service (the pure after-restart case)
//   (reason)     a synthetic ref-kept-after-finalize retain event on a fresh worker D: its held reason must NOT tell the manager to
//                worker_merge_confirm (the worker is finalized), and D must not count toward the batch size
//   (K)          [held D, unfinished C] is ONE real candidate: the early "nothing eligible to batch" return, no batch worktree
//   (allheld)    [A, D] — EVERY candidate held: the same early return; no op is minted for zero candidates ([].every is vacuously true)
//   (reconciled) a boot-Pass-A2-style merge_done (detail.reconciled:true, newer) on A and on D does NOT release either
// The hold scan makes NO git call at all, so a transient git failure (a locked ref, a timeout) has nothing to fail open through; (gone)
// is the observable proof that git state is not consulted.
// The hand-deleted-branch, release-control and finalizeMerge CAS-skip cases live in batch-merge-retain-hold-release.mjs (split to keep runtime down).
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-retain-hold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmrh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmrh@loom -c user.name=bmrh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const subjects = (repo, ref) => git(repo, `log ${ref} --format=%s`).split("\n");

const dbs = [];
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmrh-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmrh\n");
  execSync(`git init -q && git config user.email bmrh@loom && git config user.name bmrh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

try {
  // ── the real mixed batch ─────────────────────────────────────────────────────────────────────────────
  const repo = makeRepo("mix");
  const projId = `bmrh-proj-${sfx}`, agentId = `bmrh-agent-${sfx}`, mgrId = `bmrh-mgr-${sfx}`;
  const cut = async (label, file) => {
    const taskId = `bmrh-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", "feature-a.txt");
  const b = await cut("b", "feature-b.txt");
  const c = await cut("c", "feature-a.txt"); // add/add conflict with A once A has landed ⇒ dropped, never finished
  const d = await cut("d", "feature-d.txt");  // synthetic held candidate for the (reason)/(release) cases; not in the first batch

  const script = path.join(os.tmpdir(), `loom-bmrh-gate-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (!fs.existsSync(path.join(wt, "late-commit.txt"))) {`,
    `  fs.writeFileSync(path.join(wt, "late-commit.txt"), "added during the gate\\n");`,
    `  execSync("git add late-commit.txt && git -c user.email=bmrh@loom -c user.name=bmrh commit -q -m late-commit", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BMRH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmrh-wkr-a-${sfx}`, wB = `bmrh-wkr-b-${sfx}`, wC = `bmrh-wkr-c-${sfx}`, wD = `bmrh-wkr-d-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"], [wC, c, "c"], [wD, d, "d"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  // A budget pinned HIGH through the constructor seam so the outcome cannot depend on host speed.
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, ...extra });
  const svc1 = mk();

  const first = await svc1.mergeBatchTracked(mgrId, [wA, wB, wC]);
  const firstVal = first.settled && first.ok ? first.value : undefined;
  check("(setup) the batch took the sync path and landed A and B", first.settled === true && firstVal?.ok === true && !!firstVal.landed.find((l) => l.branch === a.branch) && !!firstVal.landed.find((l) => l.branch === b.branch));
  check("(setup) A was RETAINED (pre-stop) — its branch moved during the gate", firstVal?.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate?.phase === "pre-stop");
  check("(setup) C was dropped to fallback (so the batch is MIXED: C is never finished)", !!firstVal?.fallback.find((f) => f.workerSessionId === wC));
  try {
    await waitUntil(() => db.listEventsForWorker(wC).some((e) => e.kind === "merge_rejected" || e.kind === "merge_cancelled"), { timeoutMs: 90_000, label: "C's fallback confirm to settle (rejected)" });
  } catch { check("(setup) C's fallback confirm settled", false); }
  const mainAfterFirst = git(repo, "rev-parse HEAD");

  const untouched = (tag) => {
    check(`(${tag}) main did not move`, git(repo, "rev-parse HEAD") === mainAfterFirst);
    check(`(${tag}) NEITHER late commit is on main`, !fs.existsSync(path.join(repo, "late-commit.txt")) && !fs.existsSync(path.join(repo, "late-commit-2.txt")) &&
      !subjects(repo, "HEAD").some((s) => s.startsWith("late-commit")));
    check(`(${tag}) A's branch still carries the late commit(s) and its worktree survives`, refExists(repo, a.branch) && subjects(repo, a.branch).includes("late-commit") && fs.existsSync(path.join(a.worktreePath, "late-commit.txt")));
    check(`(${tag}) A's task is still in_progress with no merge_done (never solo-confirmed)`, db.getTask(a.taskId)?.columnKey === "in_progress" && !db.listEventsForWorker(wA).some((e) => e.kind === "merge_done" && e.detail?.reconciled !== true));
  };
  const heldEntry = (val, w) => val?.fallback.find((f) => f.workerSessionId === w && f.started === false && /held/.test(f.reason));
  const refire = async (svc, ids) => {
    let r = await svc.mergeBatchTracked(mgrId, ids);
    if (!r.settled) {
      await waitUntil(() => svc.gateStatus(r.op.opId).state === "settled", { timeoutMs: 90_000, label: "re-fire op to settle" });
      r = await svc.mergeBatchTracked(mgrId, ids);
    }
    return r.settled && r.ok ? r.value : undefined;
  };

  // BMRH_ONLY=gateoff skips every case except (gateoff) so a RED for that one route is not pre-empted by earlier cases changing state.
  const only = process.env.BMRH_ONLY;
  if (!only) {
  // (again) A commits AGAIN after the retain (its worker was left live by the pre-stop retain), then a same-ids re-fire.
  fs.writeFileSync(path.join(a.worktreePath, "late-commit-2.txt"), "a SECOND unreviewed commit\n");
  commitAll(a.worktreePath, "late-commit-2", GIT_ID);
  const againVal = await refire(svc1, [wA, wB, wC]);
  check("(again) A's tip moved AGAIN and the re-fire still reports A HELD (started:false, \"held\", names worker_merge)", !!heldEntry(againVal, wA) && /worker_merge/.test(heldEntry(againVal, wA).reason));
  untouched("again");
  check("(again) A's branch carries BOTH late commits", subjects(repo, a.branch).includes("late-commit-2") && subjects(repo, a.branch).includes("late-commit"));
  check("(again) no second retain event was filed for A (it was never re-assembled)", db.listEventsForWorker(wA).filter((e) => e.kind === "batch_merge_branch_retained").length === 1);

  // (restart) a FRESH service: no process-local verdict cache at all.
  const restartVal = await refire(mk(), [wA, wB, wC]);
  check("(restart) a fresh SessionService (no cache) still reports A HELD", !!heldEntry(restartVal, wA));
  untouched("restart");

  // (restart2) the pure two-candidate after-restart case.
  const restart2Val = await refire(mk(), [wA, wB]);
  check("(restart2) a fresh service re-firing [A,B] still reports A HELD", !!heldEntry(restart2Val, wA));
  untouched("restart2");

  // (reason) a synthetic ref-kept-after-finalize retain on D: finalized worker, so its held reason must not say worker_merge_confirm.
  const retainEvt = (w, task, branch, phase) => db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: w, taskId: task,
    detail: { opId: "synthetic", branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase },
  });
  retainEvt(wD, d.taskId, d.branch, "ref-kept-after-finalize");
  const reasonVal = await refire(mk(), [wD, wB]);
  const heldD = heldEntry(reasonVal, wD);
  check("(reason) D (ref-kept-after-finalize) is reported held", !!heldD);
  check("(reason) its reason does NOT tell the manager to worker_merge_confirm, and says to inspect the ref", !!heldD && !/worker_merge_confirm/.test(heldD.reason) && /inspect it/.test(heldD.reason));
  check("(reason) contrast: A's live-phase reason DOES name worker_merge_confirm", /worker_merge_confirm/.test(heldEntry(againVal, wA)?.reason ?? ""));
  check("(reason) D's branch and task were left alone", refExists(repo, d.branch) && db.getTask(d.taskId)?.columnKey === "in_progress" && !fs.existsSync(path.join(repo, "feature-d.txt")));

  // (members) a held candidate is not a MEMBER of the batch that ran: no batch_merge_dropped event of the re-fire names D's branch.
  const dropEvents = db.listEvents(mgrId).filter((e) => e.kind === "batch_merge_dropped");
  check("(members) positive control: the first batch's drop events DO list its members (A among them)", dropEvents.some((e) => e.detail?.branches?.some((x) => x.branch === a.branch)));
  check("(members) no drop event lists held D as a batch member", !dropEvents.some((e) => e.detail?.branches?.some((x) => x.branch === d.branch)));

  // (K) a held candidate must not count toward the batch size: [held D, unfinished C] is ONE real candidate, so no batch worktree is cut.
  const kVal = await refire(mk(), [wD, wC]);
  check("(K) [held D, C] does not batch (one real candidate): the early \"nothing eligible to batch\" return, D still reported held", kVal?.reason === "nothing eligible to batch" && !!heldEntry(kVal, wD));

  // (allheld) EVERY candidate held: no live candidate, so no batch worktree/op ([].every is vacuously true and must not bypass the early return).
  const gateRowsBeforeAllHeld = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 }).items.length;
  const allHeldVal = await refire(mk(), [wA, wD]);
  check("(allheld) [A, D] both held: the early \"nothing eligible to batch\" return, BOTH reported held", allHeldVal?.reason === "nothing eligible to batch" && !!heldEntry(allHeldVal, wA) && !!heldEntry(allHeldVal, wD));
  check("(allheld) no gate op was minted for zero candidates", db.listGateEvents({ projectId: projId, limit: 50, offset: 0 }).items.length === gateRowsBeforeAllHeld);
  const allHeldSingle = await refire(mk(), [wA]);
  check("(allheld) [A] alone: same early return, A reported held", allHeldSingle?.reason === "nothing eligible to batch" && !!heldEntry(allHeldSingle, wA));
  untouched("allheld");

  // (reconciled) boot Pass A2 FABRICATES a merge_done (detail.reconciled:true) for a card that merely sits in the terminal column —
  // e.g. a human dragging a held card to Done. It is newer than the retain, and must NOT release the hold.
  const laterTs = (ms) => new Date(Date.now() + ms).toISOString();
  db.appendEvent({ id: randomUUID(), ts: laterTs(5), managerSessionId: mgrId, kind: "merge_done", workerSessionId: wA, taskId: a.taskId, detail: { branch: a.branch, reconciled: true } });
  db.appendEvent({ id: randomUUID(), ts: laterTs(5), managerSessionId: mgrId, kind: "merge_done", workerSessionId: wD, taskId: d.taskId, detail: { branch: d.branch, reconciled: true } });
  const reconciledVal = await refire(mk(), [wA, wB, wC]);
  check("(reconciled) a NEWER but reconciled merge_done does NOT release A", !!heldEntry(reconciledVal, wA));
  untouched("reconciled");
  const reconciledD = await refire(mk(), [wD, wB]);
  check("(reconciled) ...nor D", !!heldEntry(reconciledD, wD) && refExists(repo, d.branch) && !fs.existsSync(path.join(repo, "feature-d.txt")));

  }
  // (gateoff) the human-only per-project merge-gate switch (card e8df2659) routes the WHOLE batch to fallback before any assembly: a held
  // candidate must still be skipped by runFallback there (never solo-confirmed) and reported held.
  const gateCfg = db.getProject(projId).config;
  db.setProjectConfig(projId, { ...gateCfg, orchestration: { ...(gateCfg.orchestration ?? {}), mergeGate: "off" } });
  const gateOffVal = await refire(mk(), [wA, wB, wC]);
  check("(gateoff) the gate-off route was taken (\"merge gate disabled\")", gateOffVal?.reason === "merge gate disabled");
  check("(gateoff) A is STILL reported held and not solo-confirmed on that route", !!heldEntry(gateOffVal, wA) && !db.listEventsForWorker(wA).some((e) => e.kind === "merge_done" && e.detail?.reconciled !== true));
  untouched("gateoff");
  db.setProjectConfig(projId, gateCfg);

} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
