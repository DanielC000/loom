import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9a5d040c (child of d9332365) — commitTrailers/commitLogBody GATING on the SOLO squash path
// (git/worktrees.ts's mergeBranchLocked). Card 3e92e23b (merged, see commit-trailers-config.mjs) already
// proved the CONFIG resolves correctly; this suite proves the MERGE-PATH BEHAVIOR for all four on/off
// combinations, end to end through the SAME confirmWorkerMergeTracked call production uses — not just a
// bare mergeBranch invocation — so the ledger/mergedSha/watermark readers are exercised for real.
// REAL git, a REAL Db/SessionService, NO claude and NO live daemon.
//
// Proves:
//   (1) both "on" (config omitted — every existing project's default) — byte-identical message shape to
//       today: all four reserved trailers + the worker-commit-log body present.
//   (2) trailers "off", body "on" — NO Loom-* trailer line anywhere in the landed message; the body is
//       STILL present (card 9a5d040c: the two keys are independent); the in-process parent+tree
//       verification is unaffected (proven via the SAME ledger read solo-landed-tip-ledger-fast-path.mjs's
//       own scenario (A) uses: getVerifiedLandedTip resolves to the pre-squash tip, which only happens on
//       a "verified" landedBase); mergedSha/mergedVerification="content" and the mainline watermark all
//       advance exactly as in (1).
//   (3) trailers "on", body "off" — trailers present; NO "Worker commits:" body block.
//   (4) both "off" — subject-only message (plus trailing newline); ledger/mergedSha/watermark still hold.
//   (A) RE-CONFIRM, trailers "off" — a SECOND `mergeBranch` call on the SAME already-landed branch must
//       still end as a no-op (never a second squash commit), even though `findLandedSquashCommit`'s own
//       retroactive "ALREADY_MERGED" classification is itself trailer-keyed (`git log
//       --grep=Loom-Worker-Branch:`) and finds nothing with trailers off — the squash's own `!staged`
//       short-circuit (a CONTENT check: `git diff --cached` after `git merge --squash`) is what actually
//       prevents a second commit, never the trailer. Asserted directly against `git rev-list --count`.
//       UNCHANGED by card e8d4fdc3: this scenario calls bare `mergeBranch`, never SessionService, so the
//       ledger write (`recordMainlineLedgerEntryIfRepoUnchanged`, confirmWorkerMerge-only) never runs here
//       either way — its own classification stays STAGE_EMPTY_RETRY before and after that card.
//   (B) card e8d4fdc3 — SessionService-level ALREADY_MERGED via the ledger fallback, trailers "off": a
//       branch whose content already landed (ledger `worker_landed_tip` seeded, as a real trailers-off
//       confirm would) and whose worker reported `done` (the 1550eb87 hard-error trigger) still resolves
//       `merged:true` via `confirmWorkerMergeTracked` — never the hard, cached `orphaned_zero_ahead`
//       refusal the pre-fix trailer-only lookup produced for this exact shape.
//   (C) card e8d4fdc3 — trailers "ON" is byte-identical: the SAME already-landed-plus-reported-done shape,
//       with trailers on, resolves via the EXISTING trailer lookup alone (the ledger fallback is never
//       reached — `findLandedSquashCommit`'s trailer walk finds it first).
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/commit-trailers-solo-merge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-ctsm-home-");

requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (p) => pathToFileURL(path.join(__dirname, "..", "dist", p)).href;
const { Db } = await import(distUrl("db.js"));
const { SessionService } = await import(distUrl("sessions/service.js"));
const { OrchestrationControl } = await import(distUrl("orchestration/control.js"));
const { createWorktree, mergeBranch } = await import(distUrl("git/worktrees.js"));
const { mainlineWatermarkKey } = await import(distUrl("git/mainline-watch.js"));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "ctsm", GIT_AUTHOR_EMAIL: "ctsm@loom", GIT_COMMITTER_NAME: "ctsm", GIT_COMMITTER_EMAIL: "ctsm@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=ctsm@loom -c user.name=ctsm";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const tmpDirs = [];

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-ctsm-repo-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# ctsm\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "ctsm@loom"); git(repo, "config", "user.name", "ctsm");
  commitAll(repo, "init", GIT_ID);
  // resolveMainlineBranch (git/worktrees.ts) reads refs/remotes/origin/HEAD — a bare symbolic-ref is
  // enough, no real remote needed (same recipe solo-landed-tip-ledger-fast-path.mjs's own makeRepo uses).
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return repo;
}

function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, gateOpRetainMs: 0, reapWorktreeProcesses: noReap, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }) });
  return { db, sessions };
}

let seq = 0;
function newProject(tag, repo, orchestrationConfig) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `ctsm-proj-${sfx}`, agentId = `ctsm-agent-${sfx}`, mgrId = `ctsm-mgr-${sfx}`;
  const d = boot();
  d.db.insertProject({ id: projId, name: `CTSM-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestrationConfig } }, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // @decision 5958c149 — "expectedMainlineBranch" is ABSENT for a never-landed project (first sight),
  // which would make every ledger-write gate in this file's own confirms false. Seed it directly.
  d.db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: git(repo, "rev-parse", "HEAD") }));
  return { ...d, projId, agentId, mgrId, repo };
}

async function addWorker(ctx, tag, fileContent) {
  const n = `${tag}${++seq}`;
  const taskId = `ctsm-${n}-task`, workerId = `ctsm-${n}-wkr`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(test): ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), fileContent);
  commitAll(worktreePath, `feat(test): ${n} work`, GIT_ID);
  const preSquashTip = git(worktreePath, "rev-parse", "HEAD");
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, preSquashTip, n };
}

const confirm = (ctx, workerId, forceRemoveWorktree) => awaitTrackedSettle(() => ctx.sessions.confirmWorkerMergeTracked(ctx.mgrId, workerId, forceRemoveWorktree), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });

const TRAILER_KEYS = ["Loom-Worker-Branch", "Loom-Landed-Tip", "Loom-Worker-Base", "Loom-Worker-PathSet"];
const hasAnyTrailer = (body) => TRAILER_KEYS.some((k) => body.includes(`${k}: `));
const hasAllTrailers = (body) => TRAILER_KEYS.every((k) => new RegExp(`^${k}: `, "m").test(body));
const hasBody = (body) => body.includes("Worker commits:");

// ======================= (1) both "on" (config omitted — the default) =======================
{
  const repo = makeRepo("1");
  const ctx = newProject("1", repo, {});
  const w = await addWorker(ctx, "1", "export const one = 1;\n");
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(1) setup control: confirm settled and landed", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const msg = git(repo, "log", "-1", "--format=%B", landedSha);
  check("(1) both on: all four reserved trailers are present", hasAllTrailers(msg));
  check("(1) both on: the worker-commit-log body is present", hasBody(msg));
  check("(1) both on: the ledger's worker_landed_tip equals the pre-squash branch head", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  const task = ctx.db.getTask(w.taskId);
  check("(1) both on: mergedSha is stamped", task?.mergedSha === landedSha.slice(0, 7));
  check("(1) both on: mergedVerification is \"content\"", task?.mergedVerification === "content");
  check("(1) both on: the mainline watermark advanced to the landed sha", JSON.parse(ctx.db.getMeta(mainlineWatermarkKey(ctx.projId, "primary"))).sha === landedSha);
  ctx.db.close();
}

// ======================= (2) trailers "off", body "on" =======================
{
  const repo = makeRepo("2");
  const ctx = newProject("2", repo, { commitTrailers: "off" });
  const w = await addWorker(ctx, "2", "export const two = 2;\n");
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(2) setup control: confirm settled and landed", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const msg = git(repo, "log", "-1", "--format=%B", landedSha);
  check("(2) trailers off: NO reserved trailer line appears anywhere in the landed message", !hasAnyTrailer(msg));
  check("(2) trailers off, body on: the worker-commit-log body is STILL present (independent keys)", hasBody(msg));
  check("(2) trailers off: the parent+tree verification is UNAFFECTED — the ledger's worker_landed_tip still " +
    "equals the pre-squash branch head (this only happens on a \"verified\" landedBase)",
    ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  const task = ctx.db.getTask(w.taskId);
  check("(2) trailers off: mergedSha is STILL stamped", task?.mergedSha === landedSha.slice(0, 7));
  check("(2) trailers off: mergedVerification is STILL \"content\" (derived from merge.sha, never a trailer read)", task?.mergedVerification === "content");
  check("(2) trailers off: the mainline watermark STILL advanced to the landed sha", JSON.parse(ctx.db.getMeta(mainlineWatermarkKey(ctx.projId, "primary"))).sha === landedSha);
  ctx.db.close();
}

// ======================= (3) trailers "on", body "off" =======================
{
  const repo = makeRepo("3");
  const ctx = newProject("3", repo, { commitLogBody: "off" });
  const w = await addWorker(ctx, "3", "export const three = 3;\n");
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(3) setup control: confirm settled and landed", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const msg = git(repo, "log", "-1", "--format=%B", landedSha);
  check("(3) body off: all four reserved trailers are STILL present", hasAllTrailers(msg));
  check("(3) body off: NO \"Worker commits:\" block appears", !hasBody(msg));
  check("(3) body off: the ledger's worker_landed_tip equals the pre-squash branch head", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  ctx.db.close();
}

// ======================= (4) both "off" =======================
{
  const repo = makeRepo("4");
  const ctx = newProject("4", repo, { commitTrailers: "off", commitLogBody: "off" });
  const w = await addWorker(ctx, "4", "export const four = 4;\n");
  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check("(4) setup control: confirm settled and landed", r.settled === true && v.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  const msg = git(repo, "log", "-1", "--format=%B", landedSha);
  check("(4) both off: NO reserved trailer line appears anywhere in the landed message", !hasAnyTrailer(msg));
  check("(4) both off: NO \"Worker commits:\" block appears", !hasBody(msg));
  check("(4) both off: the subject itself still landed intact", msg.split("\n")[0] === `feat(test): ${w.n}`);
  check("(4) both off: the ledger's worker_landed_tip STILL equals the pre-squash branch head (parent+tree proof is trailer-independent)", ctx.db.getVerifiedLandedTip(ctx.projId, "primary", landedSha) === w.preSquashTip);
  const task = ctx.db.getTask(w.taskId);
  check("(4) both off: mergedSha is STILL stamped", task?.mergedSha === landedSha.slice(0, 7));
  check("(4) both off: mergedVerification is STILL \"content\"", task?.mergedVerification === "content");
  check("(4) both off: the mainline watermark STILL advanced to the landed sha", JSON.parse(ctx.db.getMeta(mainlineWatermarkKey(ctx.projId, "primary"))).sha === landedSha);
  ctx.db.close();
}

// ======================= (A) RE-CONFIRM with trailers "off": never a second squash commit =======================
// Deliberately at the BARE mergeBranch level (manager directive, not confirmWorkerMergeTracked) — this is
// about mergeBranch's own re-entrant behavior on an already-landed branch, independent of the session/task
// bookkeeping layer above it.
{
  const repo = makeRepo("5");
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const taskId = `ctsm-a-task-${sfx}`;
  const branch = `loom/a-${sfx}`;
  const wt = mkdtempManaged(`loom-ctsm-wtA-`);
  tmpDirs.push(wt);
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  fs.writeFileSync(path.join(wt, "a.ts"), "export const a = 1;\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "a work");
  try { git(repo, "worktree", "remove", "--force", wt); } catch { /* best-effort */ }

  const countBefore = Number(git(repo, "rev-list", "--count", "main"));
  const first = await mergeBranch(repo, branch, taskId, { commitTrailers: "off" });
  check("(A) precondition: the first landing succeeded", first.ok === true && typeof first.sha === "string" && !first.noop);
  const countAfterFirst = Number(git(repo, "rev-list", "--count", "main"));
  check("(A) precondition: exactly one new commit landed from the first call", countAfterFirst === countBefore + 1);
  const firstMsg = git(repo, "log", "-1", "--format=%B", first.sha);
  check("(A) precondition: the first landing really carries NO reserved trailer (trailers off)", !hasAnyTrailer(firstMsg));

  // THE ACTUAL TEST: a second mergeBranch call on the SAME branch, now fully landed and with no new
  // worker commits — findLandedSquashCommit's own ALREADY_MERGED lookup greps for Loom-Worker-Branch,
  // which this landing never wrote, so it degrades to STAGE_EMPTY_RETRY — but the squash's OWN
  // content-based empty-diff check must still make this a noop either way.
  const second = await mergeBranch(repo, branch, taskId, { commitTrailers: "off" });
  check("(A) THE FIX'S OWN GATE: the re-confirm ends as a no-op (ok:true, noop:true), never a refusal or a second real commit", second.ok === true && second.noop === true);
  check("(A) the classification is honestly STAGE_EMPTY_RETRY (not ALREADY_MERGED) — trailers off means " +
    `findLandedSquashCommit's grep finds nothing, which is the expected, documented degradation (got: ${second.emptyKind})`,
    second.emptyKind === "STAGE_EMPTY_RETRY");
  const countAfterSecond = Number(git(repo, "rev-list", "--count", "main"));
  check("(A) THE ACTUAL ASSERTION: git rev-list --count main is UNCHANGED after the re-confirm — no double-land", countAfterSecond === countAfterFirst);
}

/** Seeds a `worker_report(status:"done")` event — the 1550eb87 hard-error trigger `workerReportedComplete` reads. */
function seedReportedDone(ctx, w) {
  ctx.db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: ctx.mgrId, workerSessionId: w.workerId, taskId: w.taskId, kind: "worker_report", detail: { status: "done" } });
}

// ======================= (B) card e8d4fdc3 — SessionService-level ALREADY_MERGED via the ledger fallback, trailers "off" =======================
// Fabricates exactly the state a crash/race between a real trailers-off landing's commit+ledger-write and
// its OWN finalize would leave behind (card e8d4fdc3's card body: "a kill-unconfirmed commit plus a retry,
// a throw after the commit, or a crash between commit and finalize") — the worker's branch/worktree are
// STILL LIVE (finalize never ran), main already carries the SAME content under a no-trailer commit (as a
// real trailers-off squash would produce), and the ledger already carries `worker_landed_tip` for this
// EXACT branch tip (as a real trailers-off confirm's own `recordMainlineLedgerEntryIfRepoUnchanged` write
// would have stamped — scenario (2) above already proves that write happens for real). The worker ALSO
// reported `done`, arming the 1550eb87 hard-error path PRE-FIX would have hit.
{
  const repo = makeRepo("B");
  const ctx = newProject("B", repo, { commitTrailers: "off" });
  const w = await addWorker(ctx, "B", "export const b = 1;\n");
  const landedBase = git(repo, "rev-parse", "HEAD");
  // The SAME file+content the worker's own branch carries, committed directly onto main with NO trailer —
  // mirrors what a real trailers-off squash of this exact branch would have produced.
  fs.writeFileSync(path.join(repo, `${w.n}.ts`), "export const b = 1;\n");
  commitAll(repo, `feat(test): ${w.n} work`, GIT_ID);
  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(B) setup control: the fabricated landing carries NO reserved trailer (trailers off)", !hasAnyTrailer(git(repo, "log", "-1", "--format=%B", landedSha)));
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", landedSha, landedBase, w.preSquashTip, w.branch);
  check("(B) setup control: the ledger reverse-lookup resolves the fabricated landing", ctx.db.getLandedCommitByWorkerTip(ctx.projId, "primary", w.branch, w.preSquashTip) === landedSha);
  seedReportedDone(ctx, w);

  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(B) THE FIX: resolves ALREADY_MERGED via the ledger fallback, never the hard orphaned_zero_ahead refusal (got: ${JSON.stringify(v)})`,
    r.settled === true && v.merged === true && v.emptyKind === "ALREADY_MERGED");
  check("(B) never the 1550eb87 hard error", v.hardError !== true);
  ctx.db.close();
}

// ======================= (C) card e8d4fdc3 — trailers "ON" is byte-identical: the trailer walk alone still wins =======================
// The SAME already-landed-plus-reported-done shape as (B), but with trailers ON — the fabricated landing
// carries a REAL `Loom-Worker-Branch:` trailer, so `findLandedSquashCommit`'s own trailer walk resolves it
// on the FIRST try; the ledger fallback this card adds is never reached. Proves the fallback is additive,
// never a behavior change, for a repo that actually has the trailer.
{
  const repo = makeRepo("C");
  const ctx = newProject("C", repo, {});
  const w = await addWorker(ctx, "C", "export const c = 1;\n");
  fs.writeFileSync(path.join(repo, `${w.n}.ts`), "export const c = 1;\n");
  commitAll(repo, [`feat(test): ${w.n} work`, `Loom-Worker-Branch: ${w.branch}`], GIT_ID);
  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(C) setup control: the fabricated landing carries the real trailer (trailers on)", hasAnyTrailer(git(repo, "log", "-1", "--format=%B", landedSha)));
  // Deliberately NO ledger row seeded here — if the fix ever regressed to consulting the ledger FIRST (or
  // ONLY), this scenario would fail closed instead of passing, proving the trailer walk alone still wins.
  seedReportedDone(ctx, w);

  const r = await confirm(ctx, w.workerId);
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(C) trailers on: resolves ALREADY_MERGED via the trailer walk alone, byte-identical to before card e8d4fdc3 (got: ${JSON.stringify(v)})`,
    r.settled === true && v.merged === true && v.emptyKind === "ALREADY_MERGED");
  ctx.db.close();
}

// ======================= (D) card e8d4fdc3 round 2 — CRITICAL: a review fork sharing a landed branch's
// own tip must NOT be finished by boot-reconcile Pass A =======================
// Production repro: `worker_spawn`'s `reviewOf*` cuts a review fork AT the reviewed branch's own headSha.
// A lands for real (trailers ON — proving round 1's own "trailers off" framing was never the real scope,
// see docs/decisions/e8d4fdc3-*.md's round-2 "Correcting …" section); R is cut from A's OWN pre-squash
// tip — a SEPARATE branch/task/worker, never landed itself. Pre-round-2 (tip-only ledger match), Pass A's
// own `findLandedSquashCommitViaMap` → ledger fallback wrongly resolved R as "already landed" and
// finished it — finalizing and deleting a worktree/branch that was never actually merged.
{
  const repo = makeRepo("D");
  const ctx = newProject("D", repo, {}); // trailers ON (config omitted — the default)
  const a = await addWorker(ctx, "D", "export const dA = 1;\n");

  const rA = await confirm(ctx, a.workerId);
  const vA = rA.ok ? rA.value : { __unsettled: rA };
  check("(D) setup control: A landed for real (trailers ON)", rA.settled === true && vA.merged === true);
  const landedSha = git(repo, "log", "-1", "--format=%H");
  check("(D) setup control: A's landed commit carries the real trailer naming A's own branch", git(repo, "log", "-1", "--format=%B", landedSha).includes(`Loom-Worker-Branch: ${a.branch}`));

  // Cut the review fork R AT A's own pre-squash tip — a SEPARATE branch/task/worker, never landed itself.
  const reviewBranch = `loom/review-${a.n}`;
  const reviewWt = mkdtempManaged("loom-ctsm-review-");
  tmpDirs.push(reviewWt);
  git(repo, "worktree", "add", "-q", "-b", reviewBranch, reviewWt, a.preSquashTip);
  const reviewTaskId = `ctsm-review-${a.n}-task`, reviewWorkerId = `ctsm-review-${a.n}-wkr`;
  ctx.db.insertTask({ id: reviewTaskId, projectId: ctx.projId, title: `feat(test): review of ${a.n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  ctx.db.insertSession({ id: reviewWorkerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: reviewWt, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId: reviewTaskId, worktreePath: reviewWt, branch: reviewBranch });
  check("(D) precondition: the review fork's own live tip equals A's pre-squash tip (the forgery shape)", git(reviewWt, "rev-parse", "HEAD") === a.preSquashTip);

  const result = await ctx.sessions.reconcileOrchestrationOnBoot();
  check(`(D) THE CRITICAL FIX: boot-reconcile Pass A did NOT finish the review fork (got mergesFinished=${result.mergesFinished})`, result.mergesFinished === 0);
  check("(D) the review fork's task is STILL in_progress — never finished", ctx.db.getTask(reviewTaskId)?.columnKey === "in_progress");
  // NON-DISCRIMINATING against round 2's own branch-keyed fix (e8d4fdc3 CR round 2, minor 4): verified via
  // a --ref 587af85d negative control that these two pass even under the PRE-round-2 (tip-only-match) bug
  // — Pass A still wrongly finishes the review fork there (mergesFinished=1, task leaves in_progress), yet
  // the worktree/branch survive regardless, because `finalizeMerge`'s own checked-out-worktree guard
  // (decision cc9bce38: "skips the delete only while git still lists the branch") independently refuses to
  // delete a branch still checked out in a live worktree — a SEPARATE defense-in-depth layer, not evidence
  // of the branch-keying fix. Kept as a secondary assertion (no data loss either way), not as proof of the
  // critical fix; the two checks above are what actually prove it.
  check("(D) secondary defense-in-depth: the review fork's worktree is STILL present (never deleted — cc9bce38's own checked-out guard, independent of this fix)", fs.existsSync(reviewWt));
  check("(D) secondary defense-in-depth: the review fork's branch is STILL present (never deleted — cc9bce38's own checked-out guard, independent of this fix)", git(repo, "branch", "--list", reviewBranch).includes(reviewBranch));
  ctx.db.close();
}

// ======================= (E) card e8d4fdc3 round 2 — a forged re-point of an UNRELATED worker's branch
// onto a landed tip must NOT be finished either =======================
// The forgery variant: Z is a PRE-EXISTING branch with its OWN unrelated commit, then force-repointed
// (via `update-ref` — the primitive raw `.git` write access actually grants; ordinary `branch -f` refuses
// to move a branch checked out in any worktree) onto A's landed tip — same production hazard as (D),
// reached via a direct ref move instead of a fresh cut.
{
  const repo = makeRepo("E");
  const ctx = newProject("E", repo, {}); // trailers ON (config omitted — the default)
  const a = await addWorker(ctx, "E", "export const eA = 1;\n");
  const rA = await confirm(ctx, a.workerId);
  const vA = rA.ok ? rA.value : { __unsettled: rA };
  check("(E) setup control: A landed for real (trailers ON)", rA.settled === true && vA.merged === true);

  const z = await addWorker(ctx, "E", "export const eZ = 1;\n");
  check("(E) precondition: Z's own tip differs from A's pre-squash tip before the forgery", z.preSquashTip !== a.preSquashTip);
  // `git branch -f` refuses to move a branch checked out in ANY worktree (including its own) — the real
  // forgery primitive is the lower-level `update-ref`, which has no such safety check and is exactly what
  // raw `.git` write access (the shared, worker-writable `.git` — decision 356538ef) actually grants.
  git(repo, "update-ref", `refs/heads/${z.branch}`, a.preSquashTip); // the forgery: re-point Z directly onto A's recorded tip
  check("(E) precondition: the forgery actually moved Z's tip to A's pre-squash tip", git(repo, "rev-parse", `refs/heads/${z.branch}`) === a.preSquashTip);

  const result = await ctx.sessions.reconcileOrchestrationOnBoot();
  check(`(E) THE CRITICAL FIX: boot-reconcile Pass A did NOT finish the force-repointed branch (got mergesFinished=${result.mergesFinished})`, result.mergesFinished === 0);
  check("(E) Z's task is STILL in_progress — never finished", ctx.db.getTask(z.taskId)?.columnKey === "in_progress");
  // NON-DISCRIMINATING against round 2's own branch-keyed fix — same reason as (D)'s own note above:
  // `finalizeMerge`'s checked-out-worktree guard (decision cc9bce38) independently refuses to delete a
  // branch still checked out in a live worktree, regardless of whether Pass A's classification is right.
  check("(E) secondary defense-in-depth: Z's worktree is STILL present (never deleted — cc9bce38's own checked-out guard, independent of this fix)", fs.existsSync(z.worktreePath));
  check("(E) secondary defense-in-depth: Z's branch is STILL present (never deleted — cc9bce38's own checked-out guard, independent of this fix)", git(repo, "branch", "--list", z.branch).includes(z.branch));
  ctx.db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — commitTrailers/commitLogBody gate the solo squash's message exactly as specified " +
    "(independently togglable), leave the in-process parent+tree verification, the landed-tip ledger, " +
    "mergedSha/mergedVerification, and the mainline watermark advance completely unaffected in every " +
    "combination, and a trailers-off re-confirm never double-lands despite the retroactive ALREADY_MERGED " +
    "lookup itself being trailer-keyed."
  : `\n❌ ${failures} FAILURE(S).`);
for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}
process.exit(failures === 0 ? 0 : 1);
