import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 293d418e — a branch whose content is PROVEN already on main finishes as ALREADY_MERGED WITHOUT running the merge gate.
// REAL git on temp repos + an INJECTED `runGate` counter (the batch-post-gate-throw-outcome.mjs POST fixture: FF lands, then finishAlreadyMerged throws once; a same-ids re-call drops both to the solo fallback).
//   (A) re-call: gate calls == 0, merge_done carries gateSkipped+landedSha, no build_gate event, later re-call replays harmlessly.
//   (B1/B2) NEGATIVE: a late commit on a new / an already-changed path never takes the skip.  (C) NEGATIVE: a dirty worktree.  (D) interval mode: zero gates + gateSkipped, counter untouched.
//   (E) pins the documented revert-to-fork-point residual (cc9bce38).  (F) pins the intended change: main later modified a landed path -> finishes merged:true.
// Decision record: docs/decisions/293d418e-*.md.  Run: pnpm build, then LOOM_CODEX_BIN=<nonexistent> node test/batch-fallback-already-landed-skips-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
useOwnLoomHome("loom-bgrot-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgrot@loom -c user.name=bgrot";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const mk = (label) => ({
  projId: `bgrot-${label}-proj-${sfx}`, agentId: `bgrot-${label}-agent-${sfx}`, mgrId: `bgrot-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-bgrot-${label}-${sfx}`),
});
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
  const taskId = `bgrot-${n}-task-${sfx}`; const workerId = `bgrot-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true }); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
function seedProject(db, P) {
  db.insertProject({ id: P.projId, name: "BGROT", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "node packages/daemon/test/flaky-mid.mjs", ...(P.orch ?? {}) } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
const PASS_FULL = { passed: true, steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 5, status: 0 }] };
const settle = async (p) => { try { return { value: await p }; } catch (err) { return { thrown: err }; } };
function mkService(db, script) {
  const ctx = { calls: 0 };
  ctx.sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gate, ...rest) => { ctx.calls++; return script(ctx.calls, gate, ...rest); },
    reapWorktreeProcesses: noReap,
  });
  return ctx;
}
const dbs = [];
const eventsOf = (db, kind, workerId) => db.listEventsForWorker(workerId).filter((e) => e.kind === kind);

/** POST-FF fixture: the batch fast-forwards both candidates, then the first landed branch's finishAlreadyMerged throws once. */
async function landedFixture(label, orchExtra = {}) {
  const P = mk(label); P.orch = orchExtra; makeRepo(P);
  const db = new Db(); dbs.push(db);
  seedProject(db, P);
  const a = await addWorker(db, P, `${label}a`, { [`src/${label}a.ts`]: `export const ${label}a = 1;\n` });
  const b = await addWorker(db, P, `${label}b`, { [`src/${label}b.ts`]: `export const ${label}b = 2;\n` });
  const ctx = mkService(db, async () => PASS_FULL);
  const svc = ctx.sessions;
  let thrown = false; const o = svc.finishAlreadyMerged.bind(svc);
  svc.finishAlreadyMerged = async (...x) => { if (!thrown) { thrown = true; throw new Error("injected finishAlreadyMerged failure"); } return o(...x); };
  const r1 = await settle(svc.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
  check(`(${label}/setup) the POST-FF throw resolved as postGateThrow (both branches already on main)`, r1.value?.ok && r1.value.value?.postGateThrow === true);
  return { P, db, a, b, ctx, svc };
}

try {
  // (A) the batch re-call: both branches are proven landed → ZERO gate calls, both finalize ALREADY_MERGED without a gate.
  {
    const { P, db, a, b, ctx, svc } = await landedFixture("al");
    const before = ctx.calls;
    const r2 = await settle(svc.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    const extra = ctx.calls - before;
    check(`(A) the same-ids re-call gates ZERO times for already-landed branches (extra gate calls = ${extra})`, extra === 0);
    const fb = r2.value?.value?.fallback ?? [];
    check("(A) both candidates were routed to the fallback and started", fb.length === 2 && fb.every((f) => f.started === true));
    for (const c of [a, b]) {
      const done = eventsOf(db, "merge_done", c.workerId);
      const d = done.find((e) => e.detail?.gateSkipped === "already-landed");
      check(`(A) ${c.branch}: merge_done carries gateSkipped:"already-landed" + the landed commit sha`, !!d && /^[0-9a-f]{40}$/.test(String(d.detail.landedSha)));
      check(`(A) ${c.branch}: no build_gate event (nothing was gated or recorded as a pass)`, eventsOf(db, "build_gate", c.workerId).length === 0);
      const t = db.getTask(c.taskId);
      check(`(A) ${c.branch}: the task reached a terminal lane`, !!t && t.columnKey !== "in_progress");
    }
    const main = execSync("git log --format=%s", { cwd: P.repo }).toString();
    check("(A) main carries each branch's commit exactly once (nothing re-landed)", (main.match(/feat\(x\): change ala/g) ?? []).length === 1 && (main.match(/feat\(x\): change alb/g) ?? []).length === 1);
    // a later genuine re-call of a finished worker replays the terminal ALREADY_MERGED (no gate) — caching it is harmless
    const r3 = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    check("(A) a later re-call of the finished worker still gates ZERO times", ctx.calls - before === 0 && r3.value?.ok !== false);
  }

  // (B) NEGATIVE: a branch with ANY unlanded delta must not take the skip.
  //  (B1) a late commit adding a NEW path (branch ahead of its landed commit): the ordinary path runs — the gate runs and the late commit lands for real.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dl");
    fs.writeFileSync(path.join(a.worktreePath, "src", "dla-late.ts"), "export const dlaLate = 999;\n");
    commitAll(a.worktreePath, "feat(x): late change dla", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check(`(B1) a late commit adding a new path STILL gates (gate calls +${ctx.calls - before})`, ctx.calls - before >= 1);
    check("(B1) …and is never reported as a gate-skipped finish", v?.gateSkipped === undefined && eventsOf(db, "merge_done", a.workerId).every((e) => e.detail?.gateSkipped === undefined));
  }
  //  (B2) a late commit on an ALREADY-CHANGED path (the landed file gets new content): the content check is non-empty, so the skip is NOT taken — nothing finishes, nothing is deleted.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dc");
    fs.writeFileSync(path.join(a.worktreePath, "src", "dca.ts"), "export const dca = 12345;\n");
    commitAll(a.worktreePath, "feat(x): late edit of an already-landed path", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(B2) a late commit on an already-changed path does NOT take the gate-skip path", v?.gateSkipped === undefined && v?.merged !== true && eventsOf(db, "merge_done", a.workerId).length === 0);
    check("(B2) …and the branch and worktree are untouched", fs.existsSync(a.worktreePath) && execSync(`git branch --list ${a.branch}`, { cwd: P.repo }).toString().trim() !== "");
    void before;
  }

  // (C) NEGATIVE: a dirty worktree is never finished by the skip.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dt");
    fs.writeFileSync(path.join(a.worktreePath, "src", "uncommitted.ts"), "export const x = 1;\n");
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(C) a dirty worktree does NOT take the gate-skip path", v?.gateSkipped === undefined && eventsOf(db, "merge_done", a.workerId).every((e) => e.detail?.gateSkipped === undefined));
    check("(C) …and the confirm is refused (merged:false) with the untouched dirty file still on disk", v?.merged === false && fs.existsSync(path.join(a.worktreePath, "src", "uncommitted.ts")));
  }

  // (D) interval mode: the skip is not a gated landing — the counter state is byte-identical before/after AND the discriminating facts hold (zero gate calls + gateSkipped on every finish).
  {
    const { P, db, a, b, ctx, svc } = await landedFixture("iv", { mergeGateInterval: 3 });
    const st0 = JSON.stringify(db.getMergeGateState(P.projId, "primary"));
    const before = ctx.calls;
    await settle(svc.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    const skipped = [a, b].every((c) => eventsOf(db, "merge_done", c.workerId).some((e) => e.detail?.gateSkipped === "already-landed"));
    check("(D) interval mode: the re-call gates ZERO times AND both branches finished as gateSkipped (only the new path produces both)", ctx.calls - before === 0 && skipped);
    check("(D) interval mode: the merge-gate counter state is unchanged (the skip is not counted as a gated or ungated landing)", JSON.stringify(db.getMergeGateState(P.projId, "primary")) === st0);
  }

  // (E) KNOWN, DOCUMENTED RESIDUAL (decision 293d418e / cc9bce38): a late commit that reverts a changed path to its FORK-POINT content drops that path from mergeBase..branch,
  //  so the content proof is vacuous and the skip finishes it — exactly as the old squash-to-nothing did. Pinned so the behaviour cannot change silently.
  {
    const { P, db, a, ctx, svc } = await landedFixture("rv");
    execSync("git rm -q src/rva.ts", { cwd: a.worktreePath });
    commitAll(a.worktreePath, "feat(x): late revert to fork-point content", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(E) the revert-to-fork-point residual finishes as a gate-skipped ALREADY_MERGED (documented residual, not a regression)", v?.merged === true && v?.gateSkipped === "already-landed" && ctx.calls === before);
  }

  // (F) BEHAVIOUR CHANGE (intended, decision 293d418e): main LATER modified a path the branch changed. The old path's squash conflicted (merged:false); the skip compares against the
  //  LANDED commit, so it finishes ALREADY_MERGED (merged:true) — the branch's content did land.
  {
    const { P, db, a, ctx, svc } = await landedFixture("mm");
    fs.writeFileSync(path.join(P.repo, "src", "mma.ts"), "export const mma = 'main moved on';\n");
    commitAll(P.repo, "chore(x): main modifies a landed path", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(F) main modified a path the branch changed after it landed: finishes merged:true, gateSkipped, ZERO gates", v?.merged === true && v?.gateSkipped === "already-landed" && ctx.calls === before);
  }

  // (G) ATTRIBUTION (card cd92e609): a LATER main commit re-uses the branch's trailer (recycled branch name) over an unrelated path. merge_done.landedSha and the text name the commit that
  //  INTRODUCED the content; the persisted task.mergedSha (ship-state, verified/backfilled elsewhere) stays on findLandedSquashCommit's sha (the newest) — attribution only, never gating/pinning.
  {
    const { P, db, a, ctx, svc } = await landedFixture("at");
    const grep = () => execSync(`git log --format=%H --grep="Loom-Worker-Branch: ${a.branch}" -F`, { cwd: P.repo }).toString().trim().split(/\s+/).filter(Boolean);
    const introducer = grep()[0];
    fs.writeFileSync(path.join(P.repo, "src", "unrelated-at.ts"), "export const unrelated = 1;\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "feat(x): a later task re-using the branch name" -m "Loom-Worker-Branch: ${a.branch}"`, { cwd: P.repo });
    const newest = execSync("git rev-parse HEAD", { cwd: P.repo }).toString().trim();
    check("(G/setup) two same-branch trailer commits on main, newest != introducer", newest !== introducer && grep().length === 2);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    const d = eventsOf(db, "merge_done", a.workerId).find((e) => e.detail?.gateSkipped === "already-landed");
    check("(G) finishes gate-skipped with ZERO gates (verdict unchanged by the attribution)", v?.merged === true && v?.gateSkipped === "already-landed" && ctx.calls === before);
    check("(G) merge_done.landedSha is the commit that INTRODUCED the content, not the newer trailer commit", d?.detail?.landedSha === introducer);
    check("(G) the result warning names the introducing commit", typeof v?.warning === "string" && v.warning.includes(introducer.slice(0, 8)) && !v.warning.includes(newest.slice(0, 8)));
    check("(G) the persisted task.mergedSha is UNCHANGED (still the lookup's newest sha; not attribution)", db.getTask(a.taskId)?.mergedSha === newest.slice(0, 7));
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an already-landed branch finishes as ALREADY_MERGED without a gate; any unlanded delta or dirty worktree still takes the ordinary path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
