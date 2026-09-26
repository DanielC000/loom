import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A COMMIT ADDED AFTER THE MANAGER'S worker_merge REVIEW MUST NOT LAND UNREVIEWED (card bbccf470).
// `reviewWorkerMerge` records the branch tip it reviewed (on the `merge_request` event); merge_batch's assembly and
// worker_merge_confirm refuse a candidate whose tip no longer equals its last-reviewed tip, EXCEPT for tip advances the
// daemon itself made (mergeMainIntoWorktree — the union-merge). A worker that was never reviewed is NOT refused.
// Fixtures are REAL: real git repos + worktrees, a real (trivially passing) gate command, a real mergeBatchTracked /
// confirmWorkerMergeTracked. Batch: A moved after review, B reviewed+unmoved, C never reviewed ⇒ B and C land, A does not.
// Solo: moved ⇒ refused (never cached); union-only advance ⇒ lands; worker commit THEN a daemon union ⇒ still refused;
// re-review ⇒ clears; recycled successor on the same branch ⇒ same verdict. The "moved" verdict is STRUCTURAL (derived from git, nothing stored): a forged
// `refs/loom/*` ref must not launder a worker commit; a commit made while the confirm waits in the gate queue is refused at the squash point; a moved batch candidate
// is never solo-confirmed on ANY path (2-candidate, gate-off); a multi-hop daemon chain (review→union→union) still lands; assembly cherry-picks the VERIFIED tip.
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-reviewed-tip-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mrt-no-such-codex-bin");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mrt@loom -c user.name=mrt";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const onMain = (repo, file) => { try { git(repo, `cat-file -e HEAD:${file}`); return true; } catch { return false; } };
const dbs = [];

// opts.gateBody: the gate command's script body (default: pass). opts.mergeGate: the project's orchestration.mergeGate ("off" ⇒ the gate-off fallback path).
async function world(tag, labels, opts = {}) {
  const repo = path.join(os.tmpdir(), `loom-mrt-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mrt\n");
  for (const [f, c] of Object.entries(opts.baseFiles ?? {})) fs.writeFileSync(path.join(repo, f), c);
  execSync(`git init -q && git config user.email mrt@loom && git config user.name mrt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `mrt-proj-${tag}-${sfx}`, agentId = `mrt-agent-${tag}-${sfx}`, mgrId = `mrt-mgr-${tag}-${sfx}`;
  const script = path.join(os.tmpdir(), `loom-mrt-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, opts.gateBody ?? "process.exit(0);\n");
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `MRT-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"`, ...(opts.mergeGate ? { mergeGate: opts.mergeGate } : {}) } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });
  const w = {};
  for (const label of labels) {
    const taskId = `mrt-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `feature-${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
    const sid = `mrt-wkr-${tag}-${label}-${sfx}`;
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: sid, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    w[label] = { sid, taskId, worktreePath, branch };
  }
  return { repo, db, sessions, mgrId, projId, agentId, w };
}
const lateCommit = (wt, name = "late-commit") => { fs.writeFileSync(path.join(wt, `${name}.txt`), "after review\n"); commitAll(wt, name, GIT_ID); };
const eventsFor = (W, label) => W.db.listEventsForWorker(W.w[label].sid);
const settled = async (p) => { const r = await p; return r.settled && r.ok ? r.value : undefined; };

// ── (1) BATCH: A moved after review ⇒ not assembled, reported started:false; B (reviewed, unmoved) and C (never reviewed) land.
{
  const W = await world("batch", ["a", "b", "c"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.b.sid);
  lateCommit(W.w.a.worktreePath);
  const res = await settled(W.sessions.mergeBatchTracked(W.mgrId, [W.w.a.sid, W.w.b.sid, W.w.c.sid]));
  check("(batch) the batch itself succeeded", res?.ok === true);
  check("(batch) OUTCOME: A's post-review commit is NOT on main", !onMain(W.repo, "late-commit.txt"));
  check("(batch) OUTCOME: A's own reviewed work is NOT on main either (A was not assembled)", !onMain(W.repo, "feature-a.txt"));
  check("(batch) control: B (reviewed, unmoved) landed", onMain(W.repo, "feature-b.txt"));
  check("(batch) control: C (never reviewed) landed — never-reviewed is NOT refused", onMain(W.repo, "feature-c.txt"));
  const fa = res?.fallback.find((f) => f.workerSessionId === W.w.a.sid);
  check("(batch) A is reported in fallback with started:false", !!fa && fa.started === false);
  check("(batch) A's reason says to re-review with worker_merge and names both tips", !!fa && /re-review with worker_merge/.test(fa.reason) && /reviewed [0-9a-f]{8}/.test(fa.reason) && /now [0-9a-f]{8}/.test(fa.reason));
  check("(batch) A was never auto-solo-confirmed (no merge_done / merge_rejected / build_gate event for A)",
    !W.db.listEventsForWorker(W.w.a.sid).some((e) => e.kind === "merge_done" || e.kind === "merge_rejected" || e.kind === "build_gate"));
  let aLog = ""; try { aLog = git(W.repo, `log ${W.w.a.branch} --format=%s`); } catch { /* branch gone */ }
  check("(batch) A's branch, late commit and task survive", aLog.split("\n").includes("late-commit") &&W.db.getTask(W.w.a.taskId)?.columnKey === "in_progress");
}

// ── (2) SOLO: moved after review ⇒ refused, never cached; re-review clears it.
{
  const W = await world("solo", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  lateCommit(W.w.a.worktreePath);
  const r1 = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(solo) confirm refused: merged:false with the re-review message", r1?.merged === false && /re-review with worker_merge/.test(r1.reason ?? ""));
  check("(solo) OUTCOME: nothing landed (neither the reviewed work nor the late commit)", !onMain(W.repo, "feature-a.txt") && !onMain(W.repo, "late-commit.txt"));
  check("(solo) refused BEFORE the gate ran (no build_gate event) and a merge_rejected event names the reason",
    !W.db.listEventsForWorker(W.w.a.sid).some((e) => e.kind === "build_gate") && W.db.listEventsForWorker(W.w.a.sid).some((e) => e.kind === "merge_rejected" && e.detail?.reason === "reviewed_tip_moved"));
  const r2 = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(solo) a re-confirm is REFUSED AGAIN (the refusal is not cached as a verdict) — freshly evaluated", r2?.merged === false && /re-review/.test(r2.reason ?? ""));
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid); // re-review: the latest review wins
  const r3 = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(solo) after a RE-REVIEW the confirm lands (latest review wins)", r3?.merged === true && onMain(W.repo, "late-commit.txt") && onMain(W.repo, "feature-a.txt"));
}

// ── (3) SOLO: main advanced ⇒ the daemon's own union-merge moves the tip; that must NOT count as unreviewed.
{
  const W = await world("union", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  fs.writeFileSync(path.join(W.repo, "main-moved.txt"), "main moved\n");
  commitAll(W.repo, "chore(test): main moves", GIT_ID);
  const { mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
  const tipBefore = git(W.w.a.worktreePath, "rev-parse HEAD");
  const u = await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath);
  check("(union) the daemon union-merge moved the branch tip", u.ok && u.merged && git(W.w.a.worktreePath, "rev-parse HEAD") !== tipBefore);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(union) a daemon-only advance is NOT refused — the confirm lands", r?.merged === true && onMain(W.repo, "feature-a.txt"));
}

// ── (4) SOLO: review → daemon union → worker commit ⇒ refused; and review → worker commit → daemon union ⇒ refused.
for (const order of ["union-then-commit", "commit-then-union"]) {
  const W = await world(`chain-${order}`, ["a"]);
  const { mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const advanceMain = (n) => { fs.writeFileSync(path.join(W.repo, `main-${n}.txt`), "m\n"); commitAll(W.repo, `chore(test): main ${n}`, GIT_ID); };
  advanceMain(1);
  if (order === "union-then-commit") {
    await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath);
    advanceMain(2);
    await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath); // a second chained daemon advance
    lateCommit(W.w.a.worktreePath);
  } else {
    lateCommit(W.w.a.worktreePath);
    const u = await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath); // the daemon unions on TOP of the unreviewed commit
    check(`(chain ${order}) the daemon union really landed on top of the worker commit`, u.ok && u.merged);
  }
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check(`(chain ${order}) confirm REFUSED — the chain review→…→worker commit is unreviewed`, r?.merged === false && /re-review with worker_merge/.test(r.reason ?? ""));
  check(`(chain ${order}) OUTCOME: the late commit is not on main`, !onMain(W.repo, "late-commit.txt"));
}

// ── (5) RECYCLED SUCCESSOR on the same branch: the review was filed for the predecessor; the tip check is BRANCH-keyed.
{
  const W = await world("recycle", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  lateCommit(W.w.a.worktreePath);
  const succ = `mrt-wkr-recycle-a2-${sfx}`;
  W.db.insertSession({ id: succ, projectId: W.projId, agentId: W.agentId, engineSessionId: null, title: null, cwd: W.w.a.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: W.mgrId, taskId: W.w.a.taskId, worktreePath: W.w.a.worktreePath, branch: W.w.a.branch });
  W.db.archiveSession?.(W.w.a.sid);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, succ));
  check("(recycle) the successor (same branch) is refused off the PREDECESSOR's review", r?.merged === false && /re-review with worker_merge/.test(r.reason ?? "") && !onMain(W.repo, "late-commit.txt"));
}

// ── (3b) MULTI-HOP ACCEPT: review → union → union → confirm must LAND (mutation: cap the walk at 1 hop ⇒ this fails).
{
  const W = await world("multihop", ["a"]);
  const { mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(W.repo, `hop-${n}.txt`), "m\n"); commitAll(W.repo, `chore(test): hop ${n}`, GIT_ID);
    const u = await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath);
    check(`(multi-hop) daemon union #${n} moved the tip`, u.ok && u.merged);
  }
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(multi-hop) review → union → union → confirm LANDS", r?.merged === true && onMain(W.repo, "feature-a.txt"));
}

// ── (3c) FORGERY: a worker that writes a ref under refs/loom/ (shared by every worktree) must NOT launder its commit.
{
  const W = await world("forge", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const reviewed = git(W.w.a.worktreePath, "rev-parse HEAD");
  lateCommit(W.w.a.worktreePath);
  const late = git(W.w.a.worktreePath, "rev-parse HEAD");
  git(W.w.a.worktreePath, `update-ref refs/loom/tip-advance/${reviewed} ${late}`); // the R2 forgery against the old stored-edge design
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(forge) a forged refs/loom/tip-advance ref does NOT launder the worker commit — refused, nothing landed", r?.merged === false && /re-review with worker_merge/.test(r.reason ?? "") && !onMain(W.repo, "late-commit.txt"));
}

// ── (3d) QUEUE/UNION WINDOW (R3): a commit made AFTER the confirm-start check but BEFORE the gate captures its tip is INSIDE the gated tip (so the gate-tip-moved guard
// never sees it) — the pinned-tip re-check at the squash point must refuse it. Reproduced deterministically with a post-merge hook that commits to the worker's
// worktree right after the daemon's union-merge (main advanced, so the union runs).
{
  const W = await world("gatewin", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  fs.writeFileSync(path.join(W.repo, "main-adv.txt"), "m\n"); commitAll(W.repo, "chore(test): main advances", GIT_ID);
  const hook = path.join(W.repo, ".git", "hooks", "post-merge");
  fs.writeFileSync(hook, "#!/bin/sh\nif [ ! -f gate-window.txt ]; then echo made-in-the-window > gate-window.txt && git add gate-window.txt && git -c user.email=mrt@loom -c user.name=mrt commit -q -m gate-window; fi\nexit 0\n", { mode: 0o755 });
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  fs.rmSync(hook, { force: true });
  check("(queue-window) the hook really committed on the worker's branch after the union", (() => { try { return git(W.repo, `log ${W.w.a.branch} --format=%s`).split("\n").includes("gate-window"); } catch { return onMain(W.repo, "gate-window.txt"); /* branch already deleted by a landing */ } })());
  check("(queue-window) OUTCOME: the commit made in the window did NOT land", r?.merged === false && !onMain(W.repo, "gate-window.txt") && !onMain(W.repo, "feature-a.txt"));
  check("(queue-window) it was the reviewed-tip check that refused, at the squash point (phase pre-squash)",
    eventsFor(W, "a").some((e) => e.kind === "merge_rejected" && e.detail?.reason === "reviewed_tip_moved" && e.detail?.phase === "pre-squash"));
}

// ── (3e) R1: a moved candidate is NEVER solo-confirmed by merge_batch — the `< 2` path and the gate-off path.
for (const mode of ["lt2", "gate-off"]) {
  const W = await world(`r1-${mode}`, ["a", "b"], mode === "gate-off" ? { mergeGate: "off" } : {});
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  lateCommit(W.w.a.worktreePath);
  const res = await settled(W.sessions.mergeBatchTracked(W.mgrId, [W.w.a.sid, W.w.b.sid]));
  const fa = res?.fallback.find((f) => f.workerSessionId === W.w.a.sid);
  check(`(r1 ${mode}) A is reported started:false with the re-review message`, !!fa && fa.started === false && /re-review with worker_merge/.test(fa.reason));
  check(`(r1 ${mode}) OUTCOME: A's commits are not on main`, !onMain(W.repo, "late-commit.txt") && !onMain(W.repo, "feature-a.txt"));
  check(`(r1 ${mode}) NO confirm was ever started for A (no merge_rejected / merge_done / build_gate event)`, !eventsFor(W, "a").some((e) => ["merge_rejected", "merge_done", "build_gate"].includes(e.kind)));
  check(`(r1 ${mode}) control: B (unmoved) is still handled and lands`, onMain(W.repo, "feature-b.txt"));
}

// ── (3f) REPO-KEY SCOPE + STALE REVIEW.
{
  const W = await world("scope", ["a"]);
  W.db.appendEvent({ id: `mrt-ev-other-${sfx}`, ts: new Date().toISOString(), managerSessionId: W.mgrId, workerSessionId: W.w.a.sid, taskId: W.w.a.taskId, kind: "merge_request", detail: { branch: W.w.a.branch, filesChanged: 1, tip: "0".repeat(40), repoKey: "other-repo" } });
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(scope) a review filed for a DIFFERENT repoKey on the same branch name does not bind this repo's confirm", r?.merged === true && onMain(W.repo, "feature-a.txt"));
  const W2 = await world("stale", ["a"]);
  W2.db.appendEvent({ id: `mrt-ev-stale-${sfx}`, ts: new Date().toISOString(), managerSessionId: W2.mgrId, workerSessionId: W2.w.a.sid, taskId: W2.w.a.taskId, kind: "merge_request", detail: { branch: W2.w.a.branch, filesChanged: 1, tip: "1".repeat(40), repoKey: null } });
  const r2 = await settled(W2.sessions.confirmWorkerMergeTracked(W2.mgrId, W2.w.a.sid));
  check("(stale) a same-repo review whose tip is no ancestor of the branch fails CLOSED through the walk-back (re-review clears it)", r2?.merged === false && /re-review/.test(r2.reason ?? "") && !onMain(W2.repo, "feature-a.txt"));
}

// ── (3g) ASSEMBLY PINS THE VERIFIED TIP: assembleBatchBranches cherry-picks candidate.tip, never the (since-moved) branch ref.
{
  const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");
  const W = await world("pin", ["a"]);
  const verified = git(W.w.a.worktreePath, "rev-parse HEAD");
  lateCommit(W.w.a.worktreePath); // the branch moves AFTER the tip was verified
  const batch = await createWorktree(W.repo, W.projId, `mrt-batch-pin-${sfx}`);
  registerForCleanup(batch.worktreePath);
  const res = await assembleBatchBranches(batch.worktreePath, [{ workerSessionId: W.w.a.sid, taskId: W.w.a.taskId, branch: W.w.a.branch, taskTitle: "feat(test): a", tip: verified }]);
  check("(pin) the candidate landed", res.landed.length === 1 && res.dropped.length === 0);
  check("(pin) assembledTip is the VERIFIED tip, not the moved ref", res.landed[0]?.assembledTip === verified);
  check("(pin) the post-verification commit is NOT in the batch tree", fs.existsSync(path.join(batch.worktreePath, "feature-a.txt")) && !fs.existsSync(path.join(batch.worktreePath, "late-commit.txt")));
  check("(pin) the landed row does not leak the internal pin field", res.landed[0] && !("tip" in res.landed[0]));
}

// ── (3h) A COMMITTED CONFLICTED TREE must not pass as a "clean union" (S5). `git merge-tree --write-tree` exits 1 on a conflict WITHOUT throwing through the
// simple-git wrapper, printing the conflicted tree oid first — a worker can commit that tree as a merge of [prev, main-commit].
{
  const W = await world("conflicted", ["a"], { baseFiles: { "shared.txt": "base\n" } });
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const wt = W.w.a.worktreePath;
  fs.writeFileSync(path.join(wt, "shared.txt"), "branch side\n"); commitAll(wt, "feat(test): branch edits shared", GIT_ID);
  // The reviewed tip is the review-time tip; re-review so the branch edit above is reviewed, then main conflicts with it.
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  fs.writeFileSync(path.join(W.repo, "shared.txt"), "main side\n"); commitAll(W.repo, "chore(test): main edits shared", GIT_ID);
  const prev = git(wt, "rev-parse HEAD"), mainTip = git(W.repo, "rev-parse HEAD");
  let out = ""; try { out = git(W.repo, `merge-tree --write-tree ${prev} ${mainTip}`); } catch (e) { out = String(e.stdout ?? ""); }
  const conflictedTree = out.split(/\r?\n/)[0].trim();
  check("(conflicted) fixture: merge-tree really reported a conflict (more than one output line)", /^[0-9a-f]{40,64}$/.test(conflictedTree) && out.trim().split(/\r?\n/).length > 1);
  const forged = git(W.repo, `commit-tree ${conflictedTree} -p ${prev} -p ${mainTip} -m forged-merge`);
  git(wt, `reset -q --hard ${forged}`);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(conflicted) a committed CONFLICTED tree is NOT accepted as a clean union — refused, nothing landed", r?.merged === false && /re-review with worker_merge/.test(r.reason ?? "") && !onMain(W.repo, "feature-a.txt"));
}

// ── (3i) A LEGITIMATE union under the BRANCH's own .gitattributes (merge=union) must not be falsely refused (S4): the daemon unions in the WORKTREE (branch-side
// attributes), the walk's merge-tree runs in canonical (main's attributes) — the walk must use the branch-side attributes.
{
  const W = await world("attrs", ["a"], { baseFiles: { "notes.txt": "line\n" } });
  const wt = W.w.a.worktreePath;
  fs.writeFileSync(path.join(wt, ".gitattributes"), "notes.txt merge=union\n");
  fs.writeFileSync(path.join(wt, "notes.txt"), "line branch\n");
  commitAll(wt, "feat(test): branch notes with a union merge driver", GIT_ID);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  fs.writeFileSync(path.join(W.repo, "notes.txt"), "line main\n"); commitAll(W.repo, "chore(test): main edits notes", GIT_ID);
  const { mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
  const u = await mergeMainIntoWorktree(W.repo, wt);
  check("(attrs) fixture: the daemon union-merge SUCCEEDED thanks to the branch's merge=union attribute", u.ok && u.merged);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(attrs) the daemon's own union under branch-side attributes is NOT falsely refused — the confirm lands", r?.merged === true && onMain(W.repo, "feature-a.txt"));
}

// ── (3j) `git replace` must not rewrite the history the walk judges (cheap hardening: --no-replace-objects on every walk call). A replace ref makes the worker's
// late commit LOOK like a clean [reviewed, main] merge; the walk must still see the real commit.
{
  const W = await world("replace", ["a"]);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const wt = W.w.a.worktreePath;
  const reviewed = git(wt, "rev-parse HEAD");
  fs.writeFileSync(path.join(W.repo, "main-r.txt"), "m\n"); commitAll(W.repo, "chore(test): main advances", GIT_ID);
  const mainTip = git(W.repo, "rev-parse HEAD");
  lateCommit(wt);
  const late = git(wt, "rev-parse HEAD");
  const cleanTree = git(W.repo, `merge-tree --write-tree ${reviewed} ${mainTip}`).split(/\r?\n/)[0].trim();
  const fake = git(W.repo, `commit-tree ${cleanTree} -p ${reviewed} -p ${mainTip} -m fake-union`);
  git(W.repo, `replace ${late} ${fake}`);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(replace) a git-replace'd late commit posing as a clean union is REFUSED (the walk ignores replace refs)", r?.merged === false && /re-review with worker_merge/.test(r.reason ?? ""));
}

// ── (6) UNREADABLE tip fails CLOSED: the last review recorded no tip (tip:null) ⇒ refused with the same message.
{
  const W = await world("failclosed", ["a"]);
  W.db.appendEvent({ id: `mrt-ev-${sfx}`, ts: new Date().toISOString(), managerSessionId: W.mgrId, workerSessionId: W.w.a.sid, taskId: W.w.a.taskId, kind: "merge_request", detail: { branch: W.w.a.branch, filesChanged: 1, tip: null } });
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(fail-closed) a review whose tip could not be read refuses rather than assuming unchanged", r?.merged === false && /re-review with worker_merge/.test(r.reason ?? "") && !onMain(W.repo, "feature-a.txt"));
}

// ── (7) NEVER-REVIEWED solo confirm is unaffected.
{
  const W = await world("never", ["a"]);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check("(never-reviewed) a solo confirm with no review on record lands as before", r?.merged === true && onMain(W.repo, "feature-a.txt"));
}

for (const db of dbs) { try { db.close?.(); } catch { /* best effort */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
