import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 31f8467c investigation — SECOND checkpoint. Exercises the `alreadyLandedGitFactory` test seam
// (SessionService — the ONLY git factory threaded into tipAcrossLandedCheck/pinnedTipForLandedSquash's own
// resolveGitRef/branchExistsInRepo/readLandedTipTrailer calls) to prove what a REAL already-landed-lookup
// git failure actually produces during a same-ids RE-CALL shaped like
// batch-fallback-already-landed-skips-gate.mjs's own scenario (A) — NOT (D): this fixture never sets
// `mergeGateInterval`, so it is the plain re-call shape, for ONE candidate, leaving the other candidate's
// own lookup untouched.
//
// (B) resolveGitRef TIMEOUT for candidate a only: a GENUINE async hang, settled only by a real timer —
//     distinct from (A)'s synchronous throw, which rejects on the same microtask it's thrown (no timer
//     involved at all). b stays untouched.
//
// FINDING THIS PINS (investigation note, card 31f8467c): a resolveGitRef failure (throw OR timeout) during
// the SOLO fallback's own already-landed lookup does NOT produce `fallback[].started:false` — it produces
// the ALREADY-DESIGNED fail-closed retain (cc9bce38: "an unreadable/unstable tip fails CLOSED via the
// sentinel" — branch+worktree KEPT, no task move, a `merge_branch_retained` event with `source:"solo"`),
// while `fallback[].started` stays `true` (the solo confirm WAS attempted and DID complete — just
// conservatively, without finalizing). `started` only means "the confirm call was invoked", never "it
// finalized cleanly" — those are different facts, and this file is the regression pin for that gap (the
// TIMEOUT failure mode; see the sibling -throw.mjs for the THROW failure mode of the same finding).
//
// NOTE (card 3a34fc76, closing the gap 715ad688 left open — investigated under a blocked checkpoint, see
// that card's body for the full Q&A): the fault below is wrapped in the REAL, exported `withTimeout`
// (git/bounded.js) at a short, test-chosen ms (~200ms), imported the same way `canonicalGit` already is.
// This keeps (B) a genuine hang settled only by a real timer-based rejection, mechanically distinct from
// (A)'s instant throw — but it is NOT the session's own outer `withTimeout` instance (the one
// resolveGitRef/branchExistsInRepo/readLandedTipTrailer construct themselves, at `this.gitOpMs`) that
// fires; that outer instance's own setTimeout gets cleared early once the inner one rejects first.
// Investigated and confirmed this makes NO behavioral difference reaching any consumer: `withTimeout`
// itself (git/bounded.ts:44-52) is a pure race with no side effects beyond settling (no kill path, no
// error classification, no timeout-streak bookkeeping) regardless of which side wins, and all three read
// functions this seam feeds — resolveGitRef (git/worktrees.ts:412-421), branchExistsInRepo
// (git/worktrees.ts:1316-1324), readLandedTipTrailer (git/worktrees.ts:3888-3896) — wrap their own
// `withTimeout` call in a bare `catch { return <fixed fallback>; }` that discards the rejection's
// identity entirely; no caller ever branches on error content, only on the null/true/null return value.
// So the timer INSTANCE is irrelevant to every consumer; only "a real timer-based rejection happened" is
// ever observable, and that property survives unchanged.
//
// `gitOpMs` is now passed as `undefined` (not 1500) for the faulted re-call below, so the production
// default (`GIT_OP_TIMEOUT_MS`, 15_000ms — git/worktrees.ts:120) applies to every REAL git call this
// session makes. This matters for more than `branch --list`/`log -1`: `finishSoloAlreadyLanded`'s own
// `check()` closure calls `findLandedSquashCommit(..., { timeoutMs: this.gitOpMs })` (service.ts:20089)
// WITHOUT threading `alreadyLandedGitFactory` through — a real, un-intercepted `git log --grep` history
// walk (git/worktrees.ts:6567-6570) sharing this SAME session-wide budget. On ANY failure, including a
// timeout, it degrades to `catch { return null; }` (git/worktrees.ts:6614-6616), which makes
// `finishSoloAlreadyLanded` return null (service.ts:20090-20091) and fall through to attempting a REAL
// solo merge for that candidate instead of the already-landed shortcut — never reaching the fail-closed
// retain sentinel this file's checks assert on. A too-tight shared `gitOpMs` therefore doesn't just slow
// this file down under load; it can silently change WHICH CODE PATH the real re-call takes, which is the
// best-supported explanation for the previously observed 68s outlier and the real `git cherry-pick`
// confirmed-killed at the old 1500ms budget (cherry-pick only runs on this fallback-to-real-merge path —
// never on the already-landed shortcut). Do NOT re-tighten `gitOpMs` for "determinism" — it is the exact
// opposite: a tight shared budget is what made this file's pass/fail outcome depend on host load.
//
// SPLIT (card 715ad688): the original combined file (A)+(B)+(C) ran ~49-56s solo-in-suite but was
// SIGTERM-killed at the 120,000ms blanket ceiling under a real 966-file loaded gate (op 8a918209) —
// LOAD-SENSITIVE, not deterministic (6/6 green in solo trials never cleared it under load). This file
// keeps ONLY scenario (B) (resolveGitRef TIMEOUT); (A) (resolveGitRef THROW) moved verbatim to
// batch-fallback-already-landed-lookup-fault-injection-throw.mjs, (C) (readLandedTipTrailer THROW,
// absorbed) moved verbatim to batch-fallback-already-landed-lookup-fault-injection-absorbed.mjs. Mirrors
// card 45d6e631's split of batch-fallback-already-landed-skips-gate.mjs — see project memory
// `batch-fallback-already-landed-skips-gate-rides-the-120s-ceiling`.
//
// Decision record: docs/decisions/31f8467c-*.md (if present) — see that card and 715ad688 for the fuller
// investigation narrative; not restated here.  Run: pnpm build, then
// node test/batch-fallback-already-landed-lookup-fault-injection-timeout.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
useOwnLoomHome("loom-bgrot-timeout-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { canonicalGit, withTimeout } = await import("../dist/git/bounded.js");
const TEST_FAULT_MS = 200; // short, test-chosen ms — see header NOTE (card 3a34fc76) for why this is safe

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgrot@loom -c user.name=bgrot";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const mk = (label) => {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    projId: `bgrot-${label}-proj-${sfx}`, agentId: `bgrot-${label}-agent-${sfx}`, mgrId: `bgrot-${label}-mgr-${sfx}`,
    repo: path.join(os.tmpdir(), `loom-bgrot-${label}-${sfx}`), sfx,
  };
};
function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# bgrot\n");
  fs.mkdirSync(path.join(P.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  fs.mkdirSync(path.join(P.repo, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(P.repo, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "packages", "daemon", "test", "flaky-mid.mjs"), "// stub\n");
  execSync(`git init -q && git config user.email bgrot@loom && git config user.name bgrot`, { cwd: P.repo });
  commitAll(P.repo, "init", GIT_ID);
}
async function addWorker(db, P, n, files) {
  const taskId = `bgrot-${n}-task-${P.sfx}`; const workerId = `bgrot-${n}-wkr-${P.sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true }); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
function seedProject(db, P) {
  db.insertProject({ id: P.projId, name: "BGROT", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "node packages/daemon/test/flaky-mid.mjs" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
const PASS_FULL = { passed: true, steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 5, status: 0 }] };
const settle = async (p) => { try { return { value: await p }; } catch (err) { return { thrown: err }; } };
function mkService(db, alreadyLandedGitFactory, gitOpMs) {
  const ctx = { calls: 0 };
  ctx.sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    gitOpMs,
    runGate: async () => { ctx.calls++; return PASS_FULL; },
    reapWorktreeProcesses: noReap,
    alreadyLandedGitFactory,
  });
  return ctx;
}
const dbs = [];
const eventsOf = (db, kind, workerId) => db.listEventsForWorker(workerId).filter((e) => e.kind === kind);

/** Mirrors batch-fallback-already-landed-skips-gate.mjs's own landedFixture: fast-forwards both candidates
 *  via the POST-FF-throw trick (finishAlreadyMerged throws once), leaving BOTH landed-but-unfinalized. The
 *  SETUP call always uses the real, unfaulted default (gitFactory unset) — only the RE-CALL under test
 *  gets the faulted seam. */
async function landedFixture(label) {
  const P = mk(label); makeRepo(P);
  const db = new Db(); dbs.push(db);
  seedProject(db, P);
  const a = await addWorker(db, P, `${label}a`, { [`src/${label}a.ts`]: `export const ${label}a = 1;\n` });
  const b = await addWorker(db, P, `${label}b`, { [`src/${label}b.ts`]: `export const ${label}b = 2;\n` });
  const ctx = mkService(db, undefined, undefined);
  const svc = ctx.sessions;
  let thrown = false; const o = svc.finishAlreadyMerged.bind(svc);
  svc.finishAlreadyMerged = async (...x) => { if (!thrown) { thrown = true; throw new Error("injected finishAlreadyMerged failure"); } return o(...x); };
  const r1 = await settle(svc.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
  if (!(r1.value?.ok && r1.value.value?.postGateThrow === true)) throw new Error("setup fixture did not reach postGateThrow as expected");
  return { P, db, a, b, o };
}

try {
  // (B) resolveGitRef TIMEOUT for candidate a only — same shape via a different failure mode.
  {
    const { P, db, a, b, o } = await landedFixture("rgm");
    const alreadyLandedGitFactory = (repoPath, timeoutMs) => {
      const real = canonicalGit(repoPath, timeoutMs);
      return { raw: async (args) => {
        // never resolves on its own — wrapped in the REAL, exported withTimeout at a short, test-chosen
        // ms so it still rejects via a genuine timer-based mechanism (see header NOTE, card 3a34fc76),
        // independent of the session's own (now generous) gitOpMs below.
        // @decision 56c10535 — resolveBranchTip's exact lookup replaced the old `rev-parse --verify
        // <ref>^{commit}` call with `for-each-ref --format=... -- refs/heads/<branch>`; match THAT shape
        // or this injection silently never fires (the real call succeeds, masking the scenario entirely).
        if (args[0] === "for-each-ref" && args[args.length - 1] === `refs/heads/${a.branch}`) return withTimeout(new Promise(() => {}), TEST_FAULT_MS, "test-fault resolveBranchTip");
        return real.raw(args);
      } };
    };
    const ctx2 = mkService(db, alreadyLandedGitFactory, undefined);
    ctx2.sessions.finishAlreadyMerged = o;
    const r2 = await settle(ctx2.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    const fb = r2.value?.value?.fallback ?? [];
    check("(B) both candidates still report started:true under a TIMEOUT fault too", fb.length === 2 && fb.every((f) => f.started === true));
    check("(B) a's branch is RETAINED under the timeout fault too (same fail-closed sentinel)", eventsOf(db, "merge_branch_retained", a.workerId).some((e) => e.detail?.source === "solo"));
    check("(B) a's task did NOT reach a terminal lane", db.getTask(a.taskId)?.columnKey === "in_progress");
    check("(B) b's branch was NOT retained and its task DID reach a terminal lane (untouched by a's fault)", eventsOf(db, "merge_branch_retained", b.workerId).length === 0 && db.getTask(b.taskId)?.columnKey !== "in_progress");
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an already-landed-lookup resolveGitRef TIMEOUT fails CLOSED (retain, started:true), never started:false, identically to the THROW failure mode. See batch-fallback-already-landed-lookup-fault-injection-throw.mjs for the THROW case, and -absorbed.mjs for the readLandedTipTrailer case. See card 31f8467c for the still-open question this leaves (started:false's real cause lies elsewhere)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
