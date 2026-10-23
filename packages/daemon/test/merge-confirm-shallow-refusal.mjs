import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7ebb4acf, Re-review 11cd4e3e, SF3 — the shallow-canonical-repo refusal (git/bounded.ts's
// `detectShallowCanonicalRepo`) must be checked at the TOP of `confirmWorkerMerge` and `mergeBatchTracked`
// (sessions/service.ts), not just inside `mergeBranch`/`runBatchedMerge`'s own in-lock backstop
// (canonical-git-shallow-refusal.mjs's (M1)/(B1)) — so a shallow repo never burns a gate lane, let alone
// reaches checkCutBaseAncestry/reviewedTipVerdict/findLandedSquashCommit/the admission-time union-merge.
//
// Proves, against a REAL `git clone --depth 2` fixture, through the REAL SessionService:
//   (SOLO) confirmWorkerMergeTracked against a shallow canonical repo refuses with
//          merged:false/canonicalRepoShallow:true, ZERO gate calls, an actionable reason, and leaves the
//          repo/worktree/task untouched.
//   (SOLO-OK) POSITIVE CONTROL — the identical shape against a FULL (non-shallow) clone of the same
//          origin lands normally (the hoist must not false-positive on an ordinary repo).
//   (BATCH) mergeBatchTracked (2 workers) against a shallow canonical repo refuses the SAME way, before
//          createWorktree/the advisory merge-base ever run: ZERO gate calls, fallback:[] (no per-candidate
//          fallback attempted — distinct from a real `!ok` rejection, which WOULD fall back).
//   (BATCH-OK) POSITIVE CONTROL — the identical 2-worker batch against a FULL clone lands normally.
// Run: 1) build daemon (pnpm build), 2) node test/merge-confirm-shallow-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
useOwnLoomHome("loom-mcsr-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const IDENT = { GIT_AUTHOR_NAME: "mcsr", GIT_AUTHOR_EMAIL: "mcsr@loom", GIT_COMMITTER_NAME: "mcsr", GIT_COMMITTER_EMAIL: "mcsr@loom" };
const GIT_ID = "-c user.email=mcsr@loom -c user.name=mcsr";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

/** A REAL origin repo with `n` commits, plus a real `git clone --depth <depth>` of it under `root/name`. */
function makeShallowClone(root, name, n, depth) {
  const origin = path.join(root, name, "origin");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q");
  git(origin, "config", "core.autocrlf", "false"); git(origin, "config", "user.email", "mcsr@loom"); git(origin, "config", "user.name", "mcsr");
  for (let i = 1; i <= n; i++) { fs.writeFileSync(path.join(origin, "f.txt"), `line ${i}\n`, { flag: "a" }); commitAll(origin, `commit ${i}`); }
  const clone = path.join(root, name, "clone");
  execFileSync("git", ["clone", "--depth", String(depth), "-q", `file://${origin.replace(/\\/g, "/")}`, clone], { encoding: "utf8" });
  return { origin, clone };
}

/** One "daemon": a Db + a SessionService whose `runGate` seam counts calls. `tag` must be DISTINCT per
 *  call (never derived from the repo path's basename — every fixture's clone dir is literally named
 *  "clone", so that collided across scenarios and tripped a UNIQUE constraint on a shared project id). */
function boot(repo, tag) {
  const db = new Db();
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { gateCalls++; return PASS; },
  });
  const projId = `mcsr-p-${sfx}-${tag}`, mgrId = `mcsr-m-${sfx}-${tag}`, agentId = `mcsr-a-${sfx}-${tag}`;
  db.insertProject({ id: projId, name: "MCSR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { db, sessions, projId, mgrId, agentId, gateCalls: () => gateCalls };
}

async function addWorker(d, repo, tag) {
  const taskId = `mcsr-${tag}-task-${sfx}`, workerId = `mcsr-${tag}-wkr-${sfx}`;
  d.db.insertTask({ id: taskId, projectId: d.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, d.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  d.db.insertSession({ id: workerId, projectId: d.projId, agentId: d.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: d.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

const root = path.join(os.tmpdir(), `loom-mcsr-${sfx}`);
fs.mkdirSync(root, { recursive: true }); registerForCleanup(root);

// ── (SOLO) confirmWorkerMergeTracked refuses a shallow canonical repo, before the gate ──────────────────
{
  const { clone } = makeShallowClone(root, "solo", 4, 1);
  const d = boot(clone, "solo");
  const w = await addWorker(d, clone, "solo");
  const headBefore = git(clone, "rev-parse", "HEAD");
  const r = await awaitTrackedSettle(() => d.sessions.confirmWorkerMergeTracked(d.mgrId, w.workerId), { label: "confirmWorkerMergeTracked (shallow)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(SOLO) refuses with merged:false, canonicalRepoShallow:true (got ${JSON.stringify(v)})`, v.merged === false && v.canonicalRepoShallow === true);
  check("(SOLO) reason names the shallow state and an actionable remedy", /shallow/i.test(v.reason ?? "") && /git fetch --unshallow/.test(v.reason ?? ""));
  check("(SOLO) ZERO gate calls — refused before checkCutBaseAncestry/the gate ever ran", d.gateCalls() === 0);
  check("(SOLO) canonical HEAD unchanged — nothing was squashed", git(clone, "rev-parse", "HEAD") === headBefore);
  check("(SOLO) the worker's feature content never landed", !fs.existsSync(path.join(clone, "solo.txt")));
  check("(SOLO) the worktree is retained", fs.existsSync(w.worktreePath));
  check("(SOLO) the task did not move off in_progress", d.db.getTask(w.taskId)?.columnKey === "in_progress");
  d.db.close();
}

// ── (SOLO-OK) POSITIVE CONTROL — the identical shape on a FULL (non-shallow) clone of the SAME origin
// lands normally through confirmWorkerMergeTracked. ──────────────────────────────────────────────────────
{
  const { origin } = makeShallowClone(root, "solo-ok", 4, 1); // only need a fresh origin
  const d = boot(origin, "solo-ok");
  const w = await addWorker(d, origin, "solook");
  const r = await awaitTrackedSettle(() => d.sessions.confirmWorkerMergeTracked(d.mgrId, w.workerId), { label: "confirmWorkerMergeTracked (full)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(SOLO-OK) a full (non-shallow) clone lands normally (got ${JSON.stringify(v)})`, v.merged === true && v.canonicalRepoShallow === undefined);
  check("(SOLO-OK) the gate actually ran once", d.gateCalls() === 1);
  check("(SOLO-OK) the worker's feature content landed", fs.existsSync(path.join(origin, "solook.txt")));
  d.db.close();
}

// ── (BATCH) mergeBatchTracked refuses a shallow canonical repo BEFORE createWorktree/the advisory
// merge-base ever run — ZERO gate calls, fallback:[] (never a per-candidate fallback attempt). ──────────
{
  const { clone } = makeShallowClone(root, "batch", 4, 1);
  const d = boot(clone, "batch");
  const w1 = await addWorker(d, clone, "batcha"), w2 = await addWorker(d, clone, "batchb");
  const headBefore = git(clone, "rev-parse", "HEAD");
  const r = await awaitTrackedSettle(() => d.sessions.mergeBatchTracked(d.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (shallow)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(BATCH) refuses with ok:false, canonicalRepoShallow:true (got ${JSON.stringify(v)})`, v.ok === false && v.canonicalRepoShallow === true);
  check("(BATCH) reason names the shallow state and an actionable remedy", /shallow/i.test(v.reason ?? "") && /git fetch --unshallow/.test(v.reason ?? ""));
  check("(BATCH) ZERO gate calls — refused before createWorktree/the advisory merge-base ever ran", d.gateCalls() === 0);
  check("(BATCH) fallback:[] — no per-candidate fallback was even attempted", Array.isArray(v.fallback) && v.fallback.length === 0);
  check("(BATCH) landed:[] — nothing landed", Array.isArray(v.landed) && v.landed.length === 0);
  check("(BATCH) canonical HEAD unchanged", git(clone, "rev-parse", "HEAD") === headBefore);
  check("(BATCH) neither worker's branch carries a squash commit", git(clone, "log", "-1", "--format=%s", w1.branch) === "feat(x): change batcha" && git(clone, "log", "-1", "--format=%s", w2.branch) === "feat(x): change batchb");
  check("(BATCH) neither task moved off in_progress", d.db.getTask(w1.taskId)?.columnKey === "in_progress" && d.db.getTask(w2.taskId)?.columnKey === "in_progress");
  d.db.close();
}

// ── (BATCH-OK) POSITIVE CONTROL — the identical 2-worker batch against a FULL clone lands normally. ─────
{
  const { origin } = makeShallowClone(root, "batch-ok", 4, 1);
  const d = boot(origin, "batch-ok");
  const w1 = await addWorker(d, origin, "batchoka"), w2 = await addWorker(d, origin, "batchokb");
  const r = await awaitTrackedSettle(() => d.sessions.mergeBatchTracked(d.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (full)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check(`(BATCH-OK) a full (non-shallow) clone lands normally (got ${JSON.stringify(v)})`, v.ok === true && v.canonicalRepoShallow === undefined && Array.isArray(v.landed) && v.landed.length === 2);
  check("(BATCH-OK) the gate actually ran once", d.gateCalls() === 1);
  check("(BATCH-OK) both workers' content landed on mainline", fs.existsSync(path.join(origin, "batchoka.txt")) && fs.existsSync(path.join(origin, "batchokb.txt")));
  d.db.close();
}

// ── (MIDFLIGHT-SOLO) Code Review e9cbcb15, SF1 — a repo that stays non-shallow through the TOP check but
// goes shallow AFTER it (here: during the gate) must hit mergeBranch's own in-flight backstop and be
// classified canonicalRepoShallow — never the generic squashRefused "Re-task a rebase" text. Real git: the
// repo starts a genuine full clone (so the top check passes), then a REAL `.git/shallow` file is written
// mid-flight, from inside `reviewedTipVerdict` (a real step confirmWorkerMerge runs between the top check
// and the gate/squash) — not a stubbed return, a real file the squash-time fs-only check will see. ──────
{
  const { origin } = makeShallowClone(root, "midflight-solo", 4, 1);
  const d = boot(origin, "midflight-solo");
  const w = await addWorker(d, origin, "midsolo");
  check("(MIDFLIGHT-SOLO setup) the repo is NOT shallow before the call", !fs.existsSync(path.join(origin, ".git", "shallow")));
  const origRtv = d.sessions.reviewedTipVerdict.bind(d.sessions);
  let injected = false;
  d.sessions.reviewedTipVerdict = async (...args) => {
    if (!injected) { injected = true; fs.writeFileSync(path.join(origin, ".git", "shallow"), "0000000000000000000000000000000000000000\n"); }
    return origRtv(...args);
  };
  const headBefore = git(origin, "rev-parse", "HEAD");
  const r = await awaitTrackedSettle(() => d.sessions.confirmWorkerMergeTracked(d.mgrId, w.workerId), { label: "confirmWorkerMergeTracked (midflight shallow)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check("(MIDFLIGHT-SOLO) the injection actually fired before this result settled", injected === true);
  check(`(MIDFLIGHT-SOLO) refuses with merged:false, canonicalRepoShallow:true (got ${JSON.stringify(v)})`, v.merged === false && v.canonicalRepoShallow === true);
  check("(MIDFLIGHT-SOLO) the gate DID run (the repo was still non-shallow when it started)", d.gateCalls() === 1);
  check("(MIDFLIGHT-SOLO) reason/detailText name the shallow state", /shallow/i.test(v.reason ?? "") && /shallow/i.test(v.detailText ?? ""));
  check(`(MIDFLIGHT-SOLO) NEVER the generic squashRefused "Re-task a rebase" text (detailText: ${JSON.stringify(v.detailText)})`, !/Re-task a rebase/.test(v.detailText ?? "") && v.squashRefused !== true);
  check("(MIDFLIGHT-SOLO) canonical HEAD unchanged — nothing was squashed", git(origin, "rev-parse", "HEAD") === headBefore);
  fs.rmSync(path.join(origin, ".git", "shallow"), { force: true });
  d.db.close();
}

// ── (MIDFLIGHT-BATCH) the same shape for the batch path: runBatchedMerge's own in-flight backstop fires
// BEFORE assembly/the gate (unlike the solo path, where mergeBranch's backstop fires AFTER it) — so this
// is the window between mergeBatchTracked's own top check and runBatchedMerge's call, not "during the
// gate" for batch. Injected the same way, via the per-candidate `reviewedTipVerdict` call mergeBatchTracked
// makes for each candidate before assembly. ──────────────────────────────────────────────────────────────
{
  const { origin } = makeShallowClone(root, "midflight-batch", 4, 1);
  const d = boot(origin, "midflight-batch");
  const w1 = await addWorker(d, origin, "midbatcha"), w2 = await addWorker(d, origin, "midbatchb");
  check("(MIDFLIGHT-BATCH setup) the repo is NOT shallow before the call", !fs.existsSync(path.join(origin, ".git", "shallow")));
  const origRtv = d.sessions.reviewedTipVerdict.bind(d.sessions);
  let injected = false;
  d.sessions.reviewedTipVerdict = async (...args) => {
    if (!injected) { injected = true; fs.writeFileSync(path.join(origin, ".git", "shallow"), "0000000000000000000000000000000000000000\n"); }
    return origRtv(...args);
  };
  const headBefore = git(origin, "rev-parse", "HEAD");
  const r = await awaitTrackedSettle(() => d.sessions.mergeBatchTracked(d.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (midflight shallow)", timeoutMs: 60_000, pendingOps: d.sessions.pendingOps });
  const v = r.ok ? r.value : { __unsettled: r };
  check("(MIDFLIGHT-BATCH) the injection actually fired before this result settled", injected === true);
  check(`(MIDFLIGHT-BATCH) refuses with ok:false, canonicalRepoShallow:true (got ${JSON.stringify(v)})`, v.ok === false && v.canonicalRepoShallow === true);
  check("(MIDFLIGHT-BATCH) the gate did NOT run — runBatchedMerge's own backstop fires before assembly/the gate", d.gateCalls() === 0);
  check("(MIDFLIGHT-BATCH) every candidate reports started:false — no per-candidate fallback was actually attempted (mirrors quarantined/branchDiverted's own no-start shape)", Array.isArray(v.fallback) && v.fallback.length === 2 && v.fallback.every((f) => f.started === false));
  check("(MIDFLIGHT-BATCH) reason names the shallow state", /shallow/i.test(v.reason ?? ""));
  check("(MIDFLIGHT-BATCH) canonical HEAD unchanged", git(origin, "rev-parse", "HEAD") === headBefore);
  fs.rmSync(path.join(origin, ".git", "shallow"), { force: true });
  d.db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked/mergeBatchTracked refuse a shallow canonical repo at the TOP, before any gate, and never false-positive on an ordinary one; a repo that goes shallow only AFTER that top check still hits mergeBranch's/runBatchedMerge's own in-flight backstop and is classified canonicalRepoShallow, never the generic squashRefused/rebase text."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
