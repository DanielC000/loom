import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RED-FIRST FOR CARD e8e98d43 (docs/decisions/e8e98d43-*.md — read it for the full narrative, including
// this test's own evolution from two earlier, discarded designs; this header states only its mechanism):
// drives a REAL batch through the GENUINE `isBranchHeld` path (no stub) to a real `heldAtFinish` refusal
// for BOTH causes — (T) TRANSIENT via an injected `heldProbeGitFactory` git-read fault, (P) PERMANENT via
// a planted `batch_merge_branch_retained` event — asserting `finishRefused`/`landed` exclusion, the nudge,
// that a RE-FIRE while the cause persists is a genuine CACHE REPLAY, and that `worker_merge_confirm`
// called DIRECTLY on the candidate (never a `merge_batch` re-fire) is the real remedy.
// SCENARIO (T2), RED-FIRST FOR CARD d240fceb (docs/decisions/d240fceb-*.md): extends (T) one step further
// — the fault CLEARS, with NO `worker_merge_confirm` on x in between, and `merge_batch` is re-fired a
// SECOND and (after confirming x) a THIRD time. Asserts the re-fire replays run 1 (no re-assembly,
// observed via `freshMint`'s absence and the opId staying identical to run 1's — NOT via the injected
// `runGate`'s own call count, which a CR found does not discriminate in this 2-candidate shape), y's
// `merge_done` count stays at 1, `worker_merge_confirm` on x still finalizes it, and the THIRD re-fire
// (after x is confirmed) is ALSO a cache replay that never reads "nothing landed cleanly" — proving the
// batch's own history, not a fresh re-derivation, is what a re-fire now serves.
// SCENARIO (T3), RED-FIRST FOR CARD d240fceb's CR (session f16ef8c1): the MAJOR fix — a cached
// `finishRefused` candidate only counts as finished while its branch tip is PROVABLY unchanged; a LATE
// commit on x after the fault clears must make a re-fire fall through to a genuinely FRESH run (never a
// cache replay that would silently hide it), landing the late commit via the ordinary solo fallback.
// Also unit-tests the extracted, exported pure note-building helpers (`cacheHitNote`,
// `buildFinishRefusedNote`, mcp/orchestration.js) directly against synthetic input (card d240fceb, m1/m3)
// — cheaper than driving the full MCP tool registration just to pin their text.
// Run: 1) pnpm build, 2) node packages/daemon/test/mergebatch-finishalreadymerged-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbfr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { cacheHitNote, buildFinishRefusedNote } = await import("../dist/mcp/orchestration.js");

const GIT_ID = "-c user.email=mbfr@loom -c user.name=mbfr";
const now = () => new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// card e8e98d43 (CR finding #8): `process.exit()` terminates the process immediately — a pending `finally`
// never runs, so a bare `process.exit()` inside the `try` below used to leak the temp LOOM_HOME (db never
// closed, cleanup never ran for the still-open handle). Exit ONLY after the try/finally has fully resolved.
let db;
try {
  const repo = path.join(os.tmpdir(), `loom-mbfr-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbfr\n");
  execSync(`git init -q && git config user.email mbfr@loom && git config user.name mbfr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const initSha = git(repo, ["rev-parse", "HEAD"]);

  const projId = `mbfr-proj-${sfx}`, agentId = `mbfr-agent-${sfx}`, mgrId = `mbfr-mgr-${sfx}`;
  db = new Db();
  db.insertProject({ id: projId, name: "MBFR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now(), archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now(), lastActivity: now(), lastError: null, role: "manager" });

  const cut = async (label) => {
    const taskId = `mbfr-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now(), updatedAt: now() });
    const workerId = `mbfr-wkr-${label}-${sfx}`;
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now(), lastActivity: now(), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { workerId, taskId, branch, worktreePath };
  };
  // Returns the `ts` it stamped, so a caller needing a STRICTLY LATER follow-up event can derive one
  // without a fixed wait (see the (P) scenario below).
  const fileRetain = (x, landedSha, assembledTip) => {
    const ts = now();
    db.appendEvent({ id: randomUUID(), ts, managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: x.workerId, taskId: x.taskId, detail: { opId: "planted", branch: x.branch, assembledTip, liveTip: null, phase: "pre-stop", landedSha, repoKey: null } });
    return ts;
  };
  const strictlyAfter = (isoTs) => new Date(Date.parse(isoTs) + 1).toISOString();

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const mainTip = () => git(repo, ["rev-parse", "HEAD"]);

  // ── SCENARIO (T): TRANSIENT heldAtFinish refusal, via a REAL isBranchHeld read fault ─────────────────
  // x carries a planted retain whose release marker (a `Loom-Worker-Branch: <x.branch>` commit) is already
  // on main BEFORE the batch runs — so the PRE-ASSEMBLY held check (isBranchHeld's own release-scan read)
  // sees it released and x is selected normally. The git-read fault only arms once main has advanced past
  // its pre-batch tip — i.e. exactly once THIS batch's own fast-forward lands — so it fires at
  // `finishAlreadyMerged`'s LATER `heldAtFinish` check and nowhere earlier.
  {
    const x = await cut("tx"), y = await cut("ty");
    fileRetain(x, initSha, initSha);
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "chore: release marker" -m "Loom-Worker-Branch: ${x.branch}"`, { cwd: repo });
    const pre = mainTip();
    let armed = () => mainTip() !== pre;
    const probeFactory = (rp) => ({ raw: async (args) => {
      if (args[0] === "merge-base" && armed()) throw new Error("injected merge-base fault (test)");
      return execFileSync("git", args, { cwd: rp, encoding: "utf8" });
    } });
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }), gateOpRetainMs: 0, syncAttachBudgetMs: 120_000, heldProbeGitFactory: probeFactory });

    const r = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    const v = r.value;
    check("(T) the batch call resolved ok (no thrown error)", r.settled && r.ok);
    check("(T) main advanced (the batch fast-forward happened)", mainTip() !== pre);
    check("(T) landedCount counts BOTH as a git fact; landed only has y", v?.landedCount === 2 && v?.landed?.length === 1 && v.landed[0].workerSessionId === y.workerId);
    check("(T) finishRefused carries exactly ONE entry, for x", Array.isArray(v?.finishRefused) && v.finishRefused.length === 1 && v.finishRefused[0].workerSessionId === x.workerId);
    check("(T) heldRangeUnverifiable:true, and the reason is the real gitUnverified text", v?.finishRefused?.[0]?.heldRangeUnverifiable === true && /release could not be VERIFIED/.test(v.finishRefused[0].reason ?? ""));
    check("(T) x's worktree/branch are untouched (no finalize ran)", fs.existsSync(x.worktreePath));
    check("(T) x's task is still in its original column", db.getTask(x.taskId)?.columnKey === "in_progress");

    // WHY THIS STAYS A CACHE HIT (CR correction, see the record's own "CR correction" section): the fault
    // still persists (armed() still true — main has advanced and never goes back), so a re-fire with the
    // SAME candidates must be served from the until-superseded verdict cache, not re-run. Proof it is a
    // genuine replay, not a coincidental repeat: the sibling y's own `merge_done` count stays at exactly 1
    // — a real re-assembly would route y (its branch already deleted from (T)'s own finalize) through the
    // solo fallback, which would finalize an ALREADY-landed y a second time and file a SECOND merge_done.
    const mergeDoneCount = () => db.listEventsForWorker(y.workerId).filter((e) => e.kind === "merge_done").length;
    const before = mergeDoneCount();
    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T) re-fire while the cause persists is a genuine cache replay (cacheHit present)", !!r2.cacheHit);
    check(`(T) re-fire did NOT re-finalize y a second time (merge_done count stayed ${before})`, mergeDoneCount() === before);
    check("(T) re-fire's replayed value still names x in finishRefused (a true fact about that run)", r2.value?.finishRefused?.some((f) => f.workerSessionId === x.workerId));
    check("(T) x's worktree is STILL untouched after the cache-hit re-fire (it never re-evaluated x)", fs.existsSync(x.worktreePath));

    // THE REAL REMEDY: worker_merge_confirm directly on x — never a merge_batch re-fire. Clear the
    // injected fault first (simulating the transient cause actually clearing in production).
    armed = () => false;
    const confirmed = await svc.confirmWorkerMergeTracked(mgrId, x.workerId);
    check("(T) worker_merge_confirm on x resolved ok", confirmed.settled && confirmed.ok);
    check("(T) worker_merge_confirm on x actually finalized it (worktree now gone)", !fs.existsSync(x.worktreePath));
  }

  // ── SCENARIO (T2), RED-FIRST FOR CARD d240fceb: re-fire AFTER the fault clears, with NO prior
  // worker_merge_confirm on x — the exact gap scenario (T) above does not cover (it clears the fault only
  // to call confirmWorkerMergeTracked directly, never a re-fire). Before the fix: `candidateFinished(x)`
  // is false (worktree present, task not terminal) and `retainedOutstanding.has(x)` is false too
  // (isBranchHeld's own release-scan already saw x as released, from the start — the gap is specifically
  // that finishAlreadyMerged's LATER heldAtFinish check has no corresponding release-arm in isBranchHeld's
  // model) — so `batchAlreadyFinished` is false and the re-fire re-assembles from scratch.
  {
    const x = await cut("t2x"), y = await cut("t2y");
    fileRetain(x, initSha, initSha);
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "chore: release marker" -m "Loom-Worker-Branch: ${x.branch}"`, { cwd: repo });
    const pre = mainTip();
    let armed = () => mainTip() !== pre;
    const probeFactory = (rp) => ({ raw: async (args) => {
      if (args[0] === "merge-base" && armed()) throw new Error("injected merge-base fault (test)");
      return execFileSync("git", args, { cwd: rp, encoding: "utf8" });
    } });
    let gateCalls = 0;
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true }; },
      gateOpRetainMs: 0, syncAttachBudgetMs: 120_000, heldProbeGitFactory: probeFactory,
    });

    const r1 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T2) run 1 resolved ok, x finishRefused, y landed", r1.settled && r1.ok &&
      r1.value?.finishRefused?.length === 1 && r1.value.finishRefused[0].workerSessionId === x.workerId &&
      r1.value?.landed?.length === 1 && r1.value.landed[0].workerSessionId === y.workerId);
    check("(T2) run 1 genuinely ran the gate once", gateCalls === 1);

    const mergeDoneCountFor = (who) => db.listEventsForWorker(who.workerId).filter((e) => e.kind === "merge_done").length;
    const yBefore = mergeDoneCountFor(y);

    // Clear the fault WITHOUT confirming x — this is the exact step scenario (T) skips.
    armed = () => false;
    check("(T2) x still neither finished nor pre-assembly-held after the clear (worktree present, task not terminal)",
      fs.existsSync(x.worktreePath) && db.getTask(x.taskId)?.columnKey === "in_progress");

    // (a)+(b): the re-fire must be a cache REPLAY of run 1, not a fresh re-assembly. gateCalls alone does
    // NOT discriminate here (CR, session f16ef8c1): in this 2-candidate shape both candidates drop before
    // the gate even on a FRESH re-assembly (x's cherry-pick is empty, y's branch is already gone), so
    // gateCalls stays at 1 either way. The real discriminators are `freshMint` (set ONLY on a genuinely
    // fresh run, never alongside `cacheHit`) and the `opId` staying the SAME as run 1's (a fresh mint
    // always gets a NEW opId; a cache hit re-serves the original op's own result, opId included).
    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T2) re-fire after the clear IS a cache replay (cacheHit present)", !!r2.cacheHit);
    check("(T2) re-fire carries NO freshMint (mutually exclusive with a cache hit)", r2.freshMint === undefined);
    check("(T2) re-fire's opId is UNCHANGED from run 1's (same op served, not a fresh mint)", r1.value?.opId !== undefined && r2.value?.opId === r1.value?.opId);
    check("(T2) re-fire did NOT run the gate again (no re-assembly)", gateCalls === 1);
    check("(T2) re-fire's value still names x in finishRefused and y in landed (replay of run 1)",
      r2.value?.finishRefused?.some((f) => f.workerSessionId === x.workerId) &&
      r2.value?.landed?.some((l) => l.workerSessionId === y.workerId));
    check("(T2) re-fire is NOT the misleading 'nothing landed cleanly' shape", r2.value?.ok !== false || r2.value?.landed?.length !== 0);
    // (c): y's merge_done count is unaffected — the replay never re-touches y at all.
    check(`(T2) y's merge_done count stayed at ${yBefore} (no duplicate, no re-assembly fallback)`, mergeDoneCountFor(y) === yBefore);
    // x is untouched by the replay — it never re-evaluated x live.
    check("(T2) x's worktree is still untouched by the replay itself", fs.existsSync(x.worktreePath));

    // (d): worker_merge_confirm on x directly is STILL the real remedy, independent of the batch cache.
    const confirmed = await svc.confirmWorkerMergeTracked(mgrId, x.workerId);
    check("(T2) worker_merge_confirm on x resolved ok", confirmed.settled && confirmed.ok);
    check("(T2) worker_merge_confirm on x actually finalized it (worktree now gone)", !fs.existsSync(x.worktreePath));
    const xMergeDoneAfterConfirm = mergeDoneCountFor(x);
    check("(T2) x got exactly ONE merge_done from the real confirm (no duplicate)", xMergeDoneAfterConfirm === 1);

    // THIRD re-fire, now AFTER x is genuinely confirmed: must STILL be a cache replay (never a fresh
    // mint — gateCalls stays at 1), and must NEVER read as "nothing landed cleanly" even though x is now
    // truly finished too (this is the exact misleading-forever-cached shape d240fceb measured on main
    // before this fix: once both candidates satisfy candidateFinished, a stale "every candidate dropped"
    // verdict minted by a messy re-assembly would replay forever; this fix never mints that verdict at all).
    const r3 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T2) THIRD re-fire (after confirming x) is STILL a cache replay", !!r3.cacheHit);
    check("(T2) THIRD re-fire carries NO freshMint either", r3.freshMint === undefined);
    check("(T2) THIRD re-fire's opId is STILL run 1's — never a fresh mint, even post-confirm", r3.value?.opId === r1.value?.opId);
    check("(T2) THIRD re-fire did NOT run the gate again either", gateCalls === 1);
    check("(T2) THIRD re-fire is NEVER the 'nothing landed cleanly' verdict", r3.value?.reason !== "nothing landed cleanly into the batch — every candidate was dropped");
    check("(T2) THIRD re-fire's merge_done count for x is unchanged (no re-touch)", mergeDoneCountFor(x) === xMergeDoneAfterConfirm);
    check(`(T2) THIRD re-fire's merge_done count for y is unchanged (still ${yBefore})`, mergeDoneCountFor(y) === yBefore);
  }

  // ── SCENARIO (T3), RED-FIRST FOR CARD d240fceb's CR (session f16ef8c1) — THE MAJOR FIX: a LATE commit
  // on a finishRefused candidate must NEVER be hidden by the replay. x commits a genuinely new, unlanded
  // change (`late.txt`) onto its branch AFTER the fault clears, before any re-fire — the live-tip check
  // (resolveBranchTip vs the cached finishRefused entry's own `assembledTip`, its branch tip AT ASSEMBLY
  // time — never `sha`, the landed/rewritten commit on main) must see the mismatch and fall through to a
  // FRESH run, which lands `late.txt` via the ordinary per-candidate solo fallback (the same mechanism
  // that already made this safe pre-fix — see the record's "CR correction").
  {
    const x = await cut("t3x"), y = await cut("t3y");
    fileRetain(x, initSha, initSha);
    execSync(`git ${GIT_ID} commit -q --allow-empty -m "chore: release marker" -m "Loom-Worker-Branch: ${x.branch}"`, { cwd: repo });
    const pre = mainTip();
    let armed = () => mainTip() !== pre;
    const probeFactory = (rp) => ({ raw: async (args) => {
      if (args[0] === "merge-base" && armed()) throw new Error("injected merge-base fault (test)");
      return execFileSync("git", args, { cwd: rp, encoding: "utf8" });
    } });
    let gateCalls = 0;
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: async () => { gateCalls++; return { passed: true }; },
      gateOpRetainMs: 0, syncAttachBudgetMs: 120_000, heldProbeGitFactory: probeFactory,
    });

    const r1 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T3) run 1 resolved ok, x finishRefused, y landed", r1.settled && r1.ok &&
      r1.value?.finishRefused?.length === 1 && r1.value.finishRefused[0].workerSessionId === x.workerId);

    // Clear the fault, THEN commit a genuinely new, unlanded change onto x's branch.
    armed = () => false;
    fs.writeFileSync(path.join(x.worktreePath, "late.txt"), "late\n");
    commitAll(x.worktreePath, "feat(test): late", GIT_ID);
    const lateSha = git(x.worktreePath, ["rev-parse", "HEAD"]);
    check("(T3) x's live tip has genuinely moved past the cached finishRefused entry's own assembledTip",
      lateSha !== r1.value.finishRefused[0].assembledTip);

    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(T3) re-fire with a late commit is NOT a cache replay (falls through to a fresh run)", !r2.cacheHit);
    // The solo fallback finalizes via a real squash — a NEW commit, not `lateSha` itself (same shape the
    // batch's own cherry-pick-based landing uses) — so the real proof is the CONTENT landing, not an
    // ancestor check on the original pre-squash commit id.
    check("(T3) late.txt's own content actually landed on main (never silently hidden)", lateSha !== mainTip() && git(repo, ["ls-tree", "--name-only", "HEAD"]).split("\n").includes("late.txt"));
    check("(T3) x's worktree was finalized by the fresh run's own fallback (not left stranded)", !fs.existsSync(x.worktreePath));
    const termKey = svc.columnKeyForProjectRole(projId, "terminal");
    check("(T3) x's task actually reached a terminal column", db.getTask(x.taskId)?.columnKey === termKey);
  }

  // ── UNIT TESTS: the extracted pure note-building helpers (card d240fceb, m1/m3) ─────────────────────
  {
    const soloNote = cacheHitNote({ identity: "abc123" }, "op-1");
    check("(unit) solo cacheHitNote still names forceRemoveWorktree directly", /re-call with forceRemoveWorktree:true/.test(soloNote));
    const batchNote = cacheHitNote({ identity: "abc123" }, "op-1", "worker_merge_confirm");
    check("(unit) batch cacheHitNote names worker_merge_confirm, not a nonexistent merge_batch param", /worker_merge_confirm/.test(batchNote) && !/re-call with forceRemoveWorktree:true/.test(batchNote));

    check("(unit) buildFinishRefusedNote returns undefined for an empty/absent list", buildFinishRefusedNote(undefined) === undefined && buildFinishRefusedNote([]) === undefined);
    const frNote = buildFinishRefusedNote([{ workerSessionId: "w1", taskId: "t1", branch: "loom/abc", sha: "deadbeef", reason: "held" }]);
    check("(unit) buildFinishRefusedNote is worded historically, not as an unconditional present-tense claim",
      /AS OF THAT RUN/.test(frNote) && /CURRENT state/.test(frNote) && /worker_merge_confirm on w1/.test(frNote));
  }

  // ── SCENARIO (P): PERMANENT heldAtFinish refusal, via a REAL planted retain (no injected fault) ──────
  // The retain's own `landedSha` is x's OWN batch-landing commit (filed from inside the gate callback,
  // standing in for a concurrent retain writer); main carries no LATER squash for x, so `isBranchHeld`
  // finds a stable, non-transient hold once the fast-forward lands.
  {
    const x = await cut("px");
    await new Promise((r) => setTimeout(r, 1100)); // distinct author-date from x, for deterministic ordering elsewhere
    const y = await cut("py");
    const xTip0 = git(repo, ["rev-parse", x.branch]);
    let retainTs; // captured below so the release's own merge_done can be stamped STRICTLY later, with
    // no sleep at all (fixed-wait-negative-guard.mjs: a fixed wait immediately before a negative
    // assertion is unfalsifiable in one trial — this ordering need has nothing to do with that assertion,
    // so an explicit, derived timestamp is the correct fix, not an exemption).
    const gate = async (_cmd, wt) => {
      const landed = git(wt, ["log", "-n1", "--format=%H", "--fixed-strings", `--grep=Loom-Worker-Branch: ${x.branch}`]);
      retainTs = fileRetain(x, landed, initSha);
      return { passed: true };
    };
    const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: gate, gateOpRetainMs: 0, syncAttachBudgetMs: 120_000 });

    const r = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    const v = r.value;
    check("(P) the batch call resolved ok", r.settled && r.ok);
    check("(P) finishRefused carries exactly ONE entry, for x", Array.isArray(v?.finishRefused) && v.finishRefused.length === 1 && v.finishRefused[0].workerSessionId === x.workerId);
    check("(P) no heldRangeUnverifiable (a genuine, stable hold)", v?.finishRefused?.[0]?.heldRangeUnverifiable === undefined);
    check("(P) x's worktree is untouched", fs.existsSync(x.worktreePath));

    // Release the hold WITHOUT moving x's tip (a real, non-reconciled merge_done newer than the retain,
    // plus the task reaching a terminal column) — proves `isBranchHeld`'s release arms don't need the tip
    // to move, the false premise the original (pre-CR) classifyOutcome design rested on.
    db.appendEvent({ id: randomUUID(), ts: strictlyAfter(retainTs), managerSessionId: mgrId, kind: "merge_done", workerSessionId: x.workerId, taskId: x.taskId, detail: { branch: x.branch, repoKey: null } });
    const term = svc.columnKeyForProjectRole(projId, "terminal");
    db.updateTask(x.taskId, { columnKey: term });
    check("(P) x's branch tip is UNCHANGED by the release", git(repo, ["rev-parse", x.branch]) === xTip0);

    // A merge_batch re-fire is STILL a cache replay naming x — expected and correct (see "CR correction"):
    // the batch verdict is a historical record, not a live poll, and re-firing is never the remedy anyway.
    const r2 = await svc.mergeBatchTracked(mgrId, [x.workerId, y.workerId]);
    check("(P) re-fire after the release is STILL a cache replay naming x (expected — not the remedy)", !!r2.cacheHit && r2.value?.finishRefused?.some((f) => f.workerSessionId === x.workerId));

    // THE REAL REMEDY: worker_merge_confirm directly on x finalizes it, entirely independent of the
    // batch-level cache above — its own solo verdict cache is keyed differently and re-evaluates fresh.
    const confirmed = await svc.confirmWorkerMergeTracked(mgrId, x.workerId);
    check("(P) worker_merge_confirm on x resolved ok", confirmed.settled && confirmed.ok);
    check("(P) worker_merge_confirm on x actually finalized it (worktree now gone)", !fs.existsSync(x.worktreePath));
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
}
process.exit(failures === 0 ? 0 : 1);
