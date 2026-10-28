import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5958c149 — the SOLO producer-side ledger fast path for Loom-Landed-Tip.
//
// (A) ok (no hook) — a real confirmWorkerMergeTracked landing: the ledger row's worker_landed_tip is
//     stamped from the SAME synchronous verifyLandedAsOwnCommit proof mergeBranch's own return carries.
// (B) displaced (a real DCO-style commit-msg hook, installed AFTER the worker's own commit so only the
//     canonical squash is affected) — SAME: worker_landed_tip stamped correctly despite the hook.
// (C) unreadable (a hook that folds foreign text into the SAME final paragraph) — a ledger row IS still
//     written (unchanged row-write gate), but worker_landed_tip is NULL — this classification is
//     deliberately excluded from the fast path.
// (D) forged (a hook that duplicates Loom-Worker-Branch with a WRONG value) — NO ledger row at all for
//     this landing (merge.landedBase stays undefined — same as before this card).
// (E) THE ACTUAL FIX, end to end: a displaced landing whose retain event carries NO landedTip (the exact
//     pre-fix shape — a retain filed by a path that couldn't resolve the trailer) is re-evaluated by a
//     LATER, SEPARATE confirmWorkerMergeTracked call. Vanilla: the ledger (written by the ORIGINAL
//     confirm's own squash) lets the hold release correctly and the confirm proceeds to land cleanly.
//     MUTATED (db.getVerifiedLandedTip monkeypatched to return null, simulating "the reader ignores the
//     column"): the SAME call now reproduces the pre-fix stuck/misleadingly-worded refusal.
// (F) FORGED-TRAILER NEGATIVE TEST: the identical (E) construction, but the original landing was FORGED —
//     the ledger has no value for it. The synthetic retain must stay refused/held in BOTH the vanilla and
//     mutated runs — a forged landing must never be silently adopted either way.
// (G) THE CAS-PIN READER (pinnedTipForLandedSquash), NOT heldRecordedTip: (E)'s own synthetic retain event
//     makes isBranchHeld short-circuit finishAlreadyMerged BEFORE pinnedTipForLandedSquash's result (from
//     tipAcrossLandedCheck, inside finishSoloAlreadyLanded) is ever consumed — disabling ONLY that site
//     still left (E) all-green. This scenario drives a REAL ALREADY_MERGED finish with NO pre-existing
//     retain: a displaced landing (B's own DCO hook), then a LATE commit that reverts the file back to
//     main's content exactly (so a confirm against it finds an EMPTY diff — ALREADY_MERGED — with
//     mergeBranch's own frozen `landedTip` sitting at the POST-REVERT tip, never the tip actually landed).
//     GREEN (real ledger): pinnedTipForLandedSquash pins the TRUE preSquashTip; it mismatches the live
//     tip, so finalize's CAS refuses to delete — the branch is RETAINED (the cc9bce38 late-revert hazard
//     this card closes). RED (ledger disabled): the strict trailer read is ABSENT (displaced, same as
//     (B)), so the frozen legacy tip is blessed, the CAS matches, and the branch is silently DELETED.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/solo-landed-tip-ledger-fast-path.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-sllfp-home-");

requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "sllfp", GIT_AUTHOR_EMAIL: "sllfp@loom", GIT_COMMITTER_NAME: "sllfp", GIT_COMMITTER_EMAIL: "sllfp@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=sllfp@loom -c user.name=sllfp";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-sllfp-repo-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# sllfp\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "sllfp@loom"); git(repo, "config", "user.name", "sllfp");
  commitAll(repo, "init", GIT_ID);
  // resolveMainlineBranch (git/worktrees.ts) reads refs/remotes/origin/HEAD — no real remote needed, a
  // bare symbolic-ref is enough (same recipe mainline-watch-batch.mjs's own fixtures use).
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return repo;
}

// Same three hook shapes as batch-merge-displaced-trailer-hook.mjs's own A/C/D — see that file's own
// comments for exactly why each shape produces "displaced" / "unreadable" / "forged".
function installDcoHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf '\\nSigned-off-by: CI Bot <ci@example.com>\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}
function installUnreadableHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf '[skip ci]\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}
function installForgingHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf 'Loom-Worker-Branch: loom/evil0000\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}
function removeHook(repo) {
  const p = path.join(repo, ".git", "hooks", "commit-msg");
  if (fs.existsSync(p)) fs.rmSync(p);
}

function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, gateOpRetainMs: 0, reapWorktreeProcesses: noReap, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }) });
  return { db, sessions };
}

let seq = 0;
function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `sllfp-proj-${sfx}`, agentId = `sllfp-agent-${sfx}`, mgrId = `sllfp-mgr-${sfx}`;
  const d = boot();
  d.db.insertProject({ id: projId, name: `SLLFP-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // @decision 5958c149 — "expectedMainlineBranch" is ABSENT for a never-landed project (first sight),
  // which would make every ledger-write gate in this file's own confirms false. Seed it directly.
  d.db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: git(repo, "rev-parse", "HEAD") }));
  return { ...d, projId, agentId, mgrId, repo };
}

async function addWorker(ctx, tag, fileContent) {
  const n = `${tag}${++seq}`;
  const taskId = `sllfp-${n}-task`, workerId = `sllfp-${n}-wkr`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(test): ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), fileContent);
  commitAll(worktreePath, `feat(test): ${n} work`, GIT_ID);
  const preSquashTip = git(worktreePath, "rev-parse", "HEAD"); // THE branch head mergeBranch will run the squash on
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, preSquashTip };
}

const confirm = (ctx, workerId, forceRemoveWorktree) => awaitTrackedSettle(() => ctx.sessions.confirmWorkerMergeTracked(ctx.mgrId, workerId, forceRemoveWorktree), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
const branchExists = (repo, branch) => { try { git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; } };

// ======================= (A) ok — no hook =======================
{
  const repo = makeRepo("a");
  const ctx = newProject("a", repo);
  const w = await addWorker(ctx, "a", "export const a = 1;\n");
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(A) setup control: confirm settled and landed", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  check("(A) THE FIX: the ledger's worker_landed_tip equals the pre-squash branch head", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  ctx.db.close();
}

// ======================= (B) displaced =======================
{
  const repo = makeRepo("b");
  const ctx = newProject("b", repo);
  const w = await addWorker(ctx, "b", "export const b = 1;\n");
  installDcoHook(repo); // AFTER the worker's own commit — only the canonical squash is affected
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(B) setup control: confirm settled and landed under the displaced hook", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const body = git(repo, "log", "-1", "--format=%B", landedSha);
  check("(B) setup control: the landed commit's trailer really IS displaced (Signed-off-by trails it)", /Signed-off-by:/.test(body));
  check("(B) THE FIX: the ledger's worker_landed_tip equals the pre-squash branch head DESPITE the hook", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  ctx.db.close();
}

// ======================= (C) unreadable =======================
{
  const repo = makeRepo("c");
  const ctx = newProject("c", repo);
  const w = await addWorker(ctx, "c", "export const c = 1;\n");
  installUnreadableHook(repo);
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(C) setup control: confirm settled and landed under the unreadable hook", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const rows = ctx.db.db.prepare("SELECT worker_landed_tip FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ? AND tip = ?").all(ctx.projId, "primary", landedSha);
  check("(C) a ledger row IS still written (the row-write gate is unchanged)", rows.length === 1);
  check("(C) THE FIX's own gate: worker_landed_tip is NULL for \"unreadable\" (deliberately excluded)", rows[0].worker_landed_tip === null);
  check("(C) getVerifiedLandedTip reads this as absent (falls through to the strict trailer read)", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === null);
  ctx.db.close();
}

// ======================= (D) forged =======================
{
  const repo = makeRepo("d");
  const ctx = newProject("d", repo);
  const w = await addWorker(ctx, "d", "export const d = 1;\n");
  installForgingHook(repo);
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(D) setup control: confirm still settles and lands (forged ⇒ unverified pin, not a refusal)", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const rowCount = ctx.db.db.prepare("SELECT COUNT(*) AS n FROM mainline_landed_commits WHERE project_id = ? AND tip = ?").get(ctx.projId, landedSha).n;
  check("(D) THE FIX's own gate: NO ledger row at all for a forged landing (unchanged from before this card)", rowCount === 0);
  check("(D) getVerifiedLandedTip reads absent", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === null);
  ctx.db.close();
}

// ======================= (E)/(F) shared builder: land once, then synthesize a pre-fix-shaped retain =====
// Lands via confirmWorkerMergeTracked (so the ledger gets written by THIS card's real production code),
// then adds a second, filler commit and installs a hook on the FIRST worker's REMAINING branch is not
// reused — instead builds a FRESH second worker on the SAME repo whose branch we manually retain, keeping
// the FIRST landing's squash sha as the thing a later confirm must re-discover for a DIFFERENT, live
// worker whose own worktree represents "the branch as it stood when it was held" (preSquashTip == the
// live branch tip now, i.e. nothing further landed on it — the RELEASE case).
async function buildHeldScenario(tag, hookInstaller) {
  const repo = makeRepo(tag);
  const ctx = newProject(tag, repo);
  const w = await addWorker(ctx, tag, `export const ${tag} = 1;\n`);
  if (hookInstaller) hookInstaller(repo);
  // Land it for real through confirmWorkerMergeTracked once — this writes the ledger row (or not, for
  // the forged case) via THIS card's production code, then finalizes cleanly (branch deleted).
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  if (v.merged !== true) throw new Error(`buildHeldScenario(${tag}): setup landing itself did not succeed: ${JSON.stringify(v)}`);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  removeHook(repo); // the hook must not also fire on what follows

  // Re-cut the SAME branch name (same taskId ⇒ same loom/<sha256(taskId)> branch) for a SECOND worker,
  // at the ORIGINAL preSquashTip — simulating "the branch as it stood at the moment a retain would have
  // recorded it", with NOTHING further added (the release case this scenario is built to prove).
  git(repo, "branch", w.branch, w.preSquashTip);
  const worktreePath2 = mkdtempManaged(`loom-sllfp-wt2-${tag}-`);
  registerForCleanup(worktreePath2);
  git(repo, "worktree", "add", worktreePath2, w.branch);
  const workerId2 = `${w.workerId}-r`;
  ctx.db.insertSession({ id: workerId2, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId: w.taskId, worktreePath: worktreePath2, branch: w.branch });

  // THE SYNTHETIC PRE-FIX RETAIN: landedSha set, landedTip deliberately ABSENT — exactly the shape a
  // confirm whose own pinnedTipForLandedSquash call once fell through the strict trailer read (or any
  // other path that never captured it) would have filed.
  ctx.db.appendEvent({ id: `${workerId2}-retain`, ts: new Date().toISOString(), managerSessionId: ctx.mgrId, kind: "merge_branch_retained", workerSessionId: workerId2, taskId: w.taskId, detail: { opId: "synthetic", branch: w.branch, landedTip: null, liveTip: w.preSquashTip, phase: "at-finalize", landedSha, source: "solo", repoKey: null } });

  return { ctx, repo, w, workerId2, worktreePath2, landedSha };
}

// ======================= (E) THE ACTUAL FIX — release via the ledger, RED when the reader ignores it ====
{
  const { ctx, repo, w, workerId2, worktreePath2 } = await buildHeldScenario("e", installDcoHook);

  // VANILLA: the ledger (written by the first confirm's own squash) lets the hold release and this
  // SECOND confirm land cleanly.
  const rGreen = await confirm(ctx, workerId2);
  const vGreen = rGreen.ok ? rGreen.value : { __unsettled: rGreen };
  check("(E) GREEN: the held branch releases via the ledger and lands cleanly, nothing owed", rGreen.settled === true && vGreen.merged === true);

  // finalizeMerge refuses to remove worktreePath2 (it sits outside this fixture's own manufactured
  // "worktrees root" path-safety check — it was never created via the real createWorktree) and so also
  // refuses the branch delete (git still lists it checked out there) — clean both up by hand before
  // re-cutting the SAME branch name for the mutated sub-case below.
  git(repo, "worktree", "remove", "--force", worktreePath2);
  git(repo, "branch", "-D", w.branch);

  // Re-synthesize the IDENTICAL retain for a THIRD worker on the same re-cut branch, then MUTATE the
  // reader: monkeypatch getVerifiedLandedTip to return null, simulating "the reader ignores the column"
  // even though the row is genuinely there. This must reproduce the pre-fix stuck/misleading refusal.
  git(repo, "branch", w.branch, w.preSquashTip);
  const worktreePath3 = mkdtempManaged("loom-sllfp-wt3-e-");
  registerForCleanup(worktreePath3);
  git(repo, "worktree", "add", worktreePath3, w.branch);
  const workerId3 = `${workerId2}-3`;
  ctx.db.insertSession({ id: workerId3, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath3, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId: w.taskId, worktreePath: worktreePath3, branch: w.branch });
  const landedSha = git(repo, "log", "-1", "--format=%H");
  ctx.db.appendEvent({ id: `${workerId3}-retain`, ts: new Date().toISOString(), managerSessionId: ctx.mgrId, kind: "merge_branch_retained", workerSessionId: workerId3, taskId: w.taskId, detail: { opId: "synthetic2", branch: w.branch, landedTip: null, liveTip: w.preSquashTip, phase: "at-finalize", landedSha, source: "solo", repoKey: null } });

  const realGetVerifiedLandedTip = ctx.db.getVerifiedLandedTip.bind(ctx.db);
  ctx.db.getVerifiedLandedTip = () => null; // THE MUTATION: "the reader ignores the column"
  const rRed = await confirm(ctx, workerId3);
  const vRed = rRed.ok ? rRed.value : { __unsettled: rRed };
  ctx.db.getVerifiedLandedTip = realGetVerifiedLandedTip; // restore before any further use of ctx.db
  check("(E) RED (mutation: reader ignores the column): the SAME scenario now reproduces the stuck refusal", rRed.settled === true && vRed.merged === false);
  check("(E) RED: the honest NEW wording is present (\"could not be verified from Loom's own record or a strict trailer\")", typeof vRed.reason === "string" && /could not be verified from Loom's own record or a strict trailer/.test(vRed.reason));
  check("(E) RED: the OLD misleading wording is absent (no claim that a late commit genuinely landed)", typeof vRed.reason === "string" && !/were never gated or landed/.test(vRed.reason));

  ctx.db.close();
}

// ======================= (F) FORGED-TRAILER NEGATIVE TEST — must stay NOT adopted, both ways ============
{
  const { ctx, workerId2 } = await buildHeldScenario("f", installForgingHook);

  // VANILLA: no ledger value exists for a forged landing (per (D) above) — the hold must stay refused,
  // never silently trust a forged value.
  const rVanilla = await confirm(ctx, workerId2);
  const vVanilla = rVanilla.ok ? rVanilla.value : { __unsettled: rVanilla };
  check("(F) VANILLA: a forged landing's synthetic retain stays refused (never adopted)", rVanilla.settled === true && vVanilla.merged === false);

  // Re-synthesize for a second worker and ALSO mutate the reader — a forged landing must stay refused
  // under the mutation too (there is nothing for the mutation to wrongly "ignore" here, since no value
  // exists either way, but this proves the mutation doesn't accidentally change this scenario's outcome).
  const { ctx: ctx2, workerId2: workerId2b } = await buildHeldScenario("f2", installForgingHook);
  const realGetVerifiedLandedTip = ctx2.db.getVerifiedLandedTip.bind(ctx2.db);
  ctx2.db.getVerifiedLandedTip = () => null;
  const rMutated = await confirm(ctx2, workerId2b);
  const vMutated = rMutated.ok ? rMutated.value : { __unsettled: rMutated };
  ctx2.db.getVerifiedLandedTip = realGetVerifiedLandedTip;
  check("(F) MUTATED: a forged landing's synthetic retain ALSO stays refused (nothing to adopt either way)", rMutated.settled === true && vMutated.merged === false);

  ctx.db.close();
  ctx2.db.close();
}

// ======================= (G) shared builder: a displaced landing + a LATE REVERT, no retain event ========
// Deliberately NOT buildHeldScenario (that one files a synthetic merge_branch_retained event up front,
// which is exactly what makes isBranchHeld short-circuit before pinnedTipForLandedSquash's result is ever
// consumed). Built fresh per call (own repo/project) so a retain event the GREEN run files can never leak
// into the RED run and route IT into the held-branch path too.
async function buildCasPinLateRevertScenario(tag) {
  const repo = makeRepo(tag);
  const ctx = newProject(tag, repo);
  const n = `${tag}${++seq}`;
  const taskId = `sllfp-${n}-task`, workerId = `sllfp-${n}-wkr`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(test): ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  const fileName = `${n}.ts`;
  fs.writeFileSync(path.join(worktreePath, fileName), `export const ${tag} = 1;\n`);
  commitAll(worktreePath, `feat(test): ${n} work`, GIT_ID);
  const preSquashTip = git(worktreePath, "rev-parse", "HEAD");
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });

  installDcoHook(repo); // the SAME displaced-trailer hook as scenario (B)
  const r = await confirm(ctx, workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  if (v.merged !== true) throw new Error(`buildCasPinLateRevertScenario(${tag}): setup landing itself did not succeed: ${JSON.stringify(v)}`);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  removeHook(repo); // must not also fire on the late revert commit below

  check(`(G/${tag}) setup control: the ledger holds the TRUE pre-squash tip for this displaced landing`, ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === preSquashTip);

  // Re-cut the SAME branch (same taskId ⇒ same branch name) at the TRUE preSquashTip, then add a LATE
  // commit that reverts the file back to EXACTLY main's content — a confirm against this tip finds an
  // EMPTY diff against main (ALREADY_MERGED), not a fresh landing.
  git(repo, "branch", branch, preSquashTip);
  const wt = mkdtempManaged(`loom-sllfp-wtG-${tag}-`);
  registerForCleanup(wt);
  git(repo, "worktree", "add", wt, branch);
  fs.rmSync(path.join(wt, fileName));
  commitAll(wt, "revert: drop the file", GIT_ID);
  const lateRevertTip = git(wt, "rev-parse", "HEAD");
  check(`(G/${tag}) setup control: the late-revert tip genuinely differs from the originally landed tip`, lateRevertTip !== preSquashTip);
  // Deregister the worktree (clean tree, nothing left behind) BEFORE confirm runs again — isolates this
  // scenario's RED/GREEN split to the CAS-pin value itself, never to finalize's separate "still checked
  // out in a worktree" delete-skip.
  git(repo, "worktree", "remove", "--force", wt);

  const workerId2 = `${workerId}-r`;
  ctx.db.insertSession({ id: workerId2, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: wt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath: wt, branch });

  return { ctx, repo, branch, workerId2, preSquashTip, lateRevertTip };
}

// ======================= (G) GREEN — real ledger: the branch is RETAINED, pinned to the TRUE tip ========
{
  const { ctx, repo, branch, workerId2, preSquashTip, lateRevertTip } = await buildCasPinLateRevertScenario("g");
  const rGreen = await confirm(ctx, workerId2);
  const vGreen = rGreen.ok ? rGreen.value : { __unsettled: rGreen };
  check("(G) GREEN: ALREADY_MERGED finish, but the branch is RETAINED (pinned to the ledger's true tip, never the frozen legacy tip)", rGreen.settled === true && vGreen.merged === true && !!vGreen.branchRetainedWarning);
  check("(G) GREEN: the retain note names the TRUE ledger tip as landed (not the post-revert live tip)", typeof vGreen.branchRetainedWarning === "string" && vGreen.branchRetainedWarning.includes(preSquashTip.slice(0, 8)) && /advanced after this merge landed/.test(vGreen.branchRetainedWarning));
  check("(G) GREEN: the branch ref still exists — the late revert commit was NOT silently discarded", branchExists(repo, branch));
  check("(G) GREEN: the branch is unchanged, still at the late-revert tip", git(repo, "rev-parse", branch) === lateRevertTip);
  ctx.db.close();
}

// ======================= (G) RED — ledger disabled: the cc9bce38 late-revert hazard reproduces =========
{
  const { ctx, repo, branch, workerId2 } = await buildCasPinLateRevertScenario("g2");
  const realGetVerifiedLandedTip = ctx.db.getVerifiedLandedTip.bind(ctx.db);
  ctx.db.getVerifiedLandedTip = () => null; // THE MUTATION: "the CAS-pin reader ignores the ledger column"
  const rRed = await confirm(ctx, workerId2);
  const vRed = rRed.ok ? rRed.value : { __unsettled: rRed };
  ctx.db.getVerifiedLandedTip = realGetVerifiedLandedTip;
  check("(G) RED (mutation: CAS-pin reader ignores the ledger column): ALREADY_MERGED finish with NO retain — the frozen legacy tip is wrongly blessed as landed", rRed.settled === true && vRed.merged === true && !vRed.branchRetainedWarning);
  check("(G) RED: the branch ref is actually GONE — the late revert commit was silently discarded (the cc9bce38 hazard)", !branchExists(repo, branch));
  ctx.db.close();
}

console.log(failures === 0 ? "ALL PASS (solo-landed-tip-ledger-fast-path)" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
