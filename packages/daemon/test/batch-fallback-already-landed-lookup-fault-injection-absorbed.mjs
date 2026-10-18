import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 31f8467c investigation — SECOND checkpoint. Exercises the `alreadyLandedGitFactory` test seam
// (SessionService — the ONLY git factory threaded into tipAcrossLandedCheck/pinnedTipForLandedSquash's own
// resolveGitRef/branchExistsInRepo/readLandedTipTrailer calls) to prove what a REAL already-landed-lookup
// git failure actually produces during a same-ids RE-CALL shaped like
// batch-fallback-already-landed-skips-gate.mjs's own scenario (A) — NOT (D): this fixture never sets
// `mergeGateInterval`, so it is the plain re-call shape, for ONE candidate, leaving the other candidate's
// own lookup untouched.
//
// (C) readLandedTipTrailer THROW for candidate a's own LANDED SHA ONLY (resolved via a direct, read-only
//     findLandedSquashCommit probe before the fault is installed — persistent, not one-shot): silently
//     absorbed — a finalizes normally too, byte-identical outcome to the unfaulted control (started:true,
//     terminal, no retain event). See the scope note below for exactly what this does and does not prove.
//
// This file's own honest scope (Code Review c584521b on afa5940f): a BATCH-FF landing's own tip
// commit never carries a `Loom-Landed-Tip:` trailer (only a SOLO squash writes it — worktrees.ts ~8737),
// so in THIS fixture `readLandedTipTrailer`'s unfaulted call already returns `null` (no trailer present) —
// identical to what the fault-induced catch-to-null ALSO returns. This scenario therefore pins ONLY "a
// trailer-read failure is absorbed (fails safe to null, same as a genuine absence)" — it does NOT, and
// cannot without a real solo-squash fixture (a materially bigger build, skipped per that review's own
// explicit allowance), show a present trailer's value being DISCARDED in favor of `legacyTip`. The
// dist-patch RED proof (readLandedTipTrailer's catch rethrowing instead of returning null) that confirms
// this scenario CAN fail is a one-time manual verification, reported in the commit/PR, not part of this
// file — a committed test must never itself patch `dist/`.
//
// SPLIT (card 715ad688): the original combined file (A)+(B)+(C) ran ~49-56s solo-in-suite but was
// SIGTERM-killed at the 120,000ms blanket ceiling under a real 966-file loaded gate (op 8a918209) —
// LOAD-SENSITIVE, not deterministic (6/6 green in solo trials never cleared it under load). This file
// keeps ONLY scenario (C) (readLandedTipTrailer THROW, absorbed); (A) (resolveGitRef THROW) moved verbatim
// to batch-fallback-already-landed-lookup-fault-injection-throw.mjs, (B) (resolveGitRef TIMEOUT) moved
// verbatim to batch-fallback-already-landed-lookup-fault-injection-timeout.mjs. Mirrors card 45d6e631's
// split of batch-fallback-already-landed-skips-gate.mjs — see project memory
// `batch-fallback-already-landed-skips-gate-rides-the-120s-ceiling`.
//
// Decision record: docs/decisions/31f8467c-*.md (if present) — see that card and 715ad688 for the fuller
// investigation narrative; not restated here.  Run: pnpm build, then
// node test/batch-fallback-already-landed-lookup-fault-injection-absorbed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
useOwnLoomHome("loom-bgrot-absorbed-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, findLandedSquashCommit } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

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
  // (C) readLandedTipTrailer THROW, scoped EXACTLY to candidate a's own landed sha, PERSISTENT (every
  // matching call is faulted, not just the first) — silently absorbed, no behavior change at all.
  {
    const { P, db, a, b, o } = await landedFixture("rlt");
    // Resolve a's REAL landed sha first via a direct, read-only probe (content is already on main after
    // landedFixture's own setup fast-forward) — the SAME lookup tipAcrossLandedCheck's own recovery path
    // uses, so the fault below can match the EXACT call this flow actually makes, not a guess by call
    // order.
    const aLandedSha = await findLandedSquashCommit(P.repo, a.branch, "HEAD");
    check("(C) resolved a's own landed sha before installing the fault", typeof aLandedSha === "string" && /^[0-9a-f]{40}$/.test(aLandedSha));
    let faultedCount = 0;
    const alreadyLandedGitFactory = (repoPath, timeoutMs) => {
      const real = canonicalGit(repoPath, timeoutMs);
      return { raw: async (args) => {
        if (args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B" && args[3] === aLandedSha) {
          faultedCount++; // PERSISTENT — no one-shot gate — every call matching a's exact sha is faulted
          throw new Error("INJECTED FAULT (throw) readLandedTipTrailer");
        }
        return real.raw(args);
      } };
    };
    const ctx2 = mkService(db, alreadyLandedGitFactory, 8000);
    ctx2.sessions.finishAlreadyMerged = o;
    const r2 = await settle(ctx2.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    const fb = r2.value?.value?.fallback ?? [];
    check("(C) the fault actually fired, scoped to a's exact landed sha", faultedCount >= 1);
    check("(C) both candidates finalize normally (started:true, terminal, no retain)", fb.length === 2 && fb.every((f) => f.started === true));
    check("(C) a's task reached a terminal lane (the trailer read failure was absorbed, not a gap)", db.getTask(a.taskId)?.columnKey !== "in_progress");
    check("(C) no merge_branch_retained event for a (readLandedTipTrailer's own fail-safe null just falls through to the legacyTip read)", eventsOf(db, "merge_branch_retained", a.workerId).length === 0);
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a readLandedTipTrailer failure is silently absorbed (fails safe to null), no behavior change. See batch-fallback-already-landed-lookup-fault-injection-throw.mjs and -timeout.mjs for the resolveGitRef failure modes, which fail CLOSED instead. See card 31f8467c for the still-open question this leaves (started:false's real cause lies elsewhere)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
