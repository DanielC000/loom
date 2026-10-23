import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers the tool surface (manager-only), branch-name shape validation, and the basic hard refusals (any live/queued gate op, a worktree cut in flight, a tracked change in the canonical tree):
//   - (SURF) manager has the tool, worker does not
//   - (HOME) Loom's own reserved/operational home is refused
//   - (UNK) round 10 — an unknown branch is now refused DIRECTLY, never deferred to GitWriter
//   - (DWIM) round 10's CRITICAL #1 — a same-named remote-tracking ref is refused, not silently DWIM'd
//   - (NAMES) round 10's MAJOR #2 — a dangerous branch-name SHAPE is refused before any git call
//   - (GATE) a live/queued op of ANY kind blocks the switch, hard
//   - (CUT) a worktree cut in flight blocks the switch, hard
//   - (DIRTY) a tracked change in the canonical tree blocks the switch
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-surface-gate.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-surf-");
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // textually before this file's own enterMergeQuarantine( call, below — see createworktree-loom-home-guard.mjs/merge-quarantine-loom-home-guard.mjs

import {
  loadPcbDistModules, makeFixtureKit, git, PASS_GATE, listToolNames,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db, unsafeBranchNameReason, enterMergeQuarantine, clearMergeQuarantine } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (SURF) manager has the tool, worker does not =====================
  {
    const fx = makeFixture("surf");
    const mgrTools = await listToolNames(fx.orch.buildServer(fx.mgrId, "manager"));
    check("(SURF) manager surface registers project_checkout_branch", mgrTools.includes("project_checkout_branch"));
    const w = await fx.addWorker("w");
    const wkrTools = await listToolNames(fx.orch.buildServer(w.workerId, "worker"));
    check("(SURF) worker surface does NOT register project_checkout_branch", !wkrTools.includes("project_checkout_branch"));
  }

  // ===================== (HOME) Loom's own reserved/operational home is refused =====================
  {
    const fx = makeFixture("home", { repoPath: process.env.LOOM_HOME });
    const res = await fx.call("project_checkout_branch", { branch: "main" });
    check("(HOME) refused on Loom's own reserved home", res.ok === false && /operational home/i.test(res.error));
  }

  // ===================== (UNK) round 10 — an unknown branch is now refused DIRECTLY, never deferred to GitWriter =====================
  // Round 10 (sixth CR, CRITICAL #1): a non-existent local branch used to return {ok:true,classifiedTip:
  // null} and defer to GitWriter.checkout()'s own unknown-branch handling — which is exactly the path a
  // same-named remote-tracking ref could DWIM through. It is now a hard, structured refusal decided here,
  // before any git mutation — inverting this scenario's own OLD assertion (refused !== true).
  {
    const fx = makeFixture("unk");
    const res = await fx.call("project_checkout_branch", { branch: "no-such-branch" });
    check("(UNK) an unknown branch is refused DIRECTLY by this tool's own precondition (round 10 — no longer deferred to GitWriter)", res.ok === false && res.refused === true && /no local branch/.test(res.error));
    check("(UNK) canonical untouched", fx.canonBranch() === fx.main);
    check("(UNK) watermark stays absent", fx.watermark() === null);
    check("(UNK) no event is filed for an ORDINARY unknown name (no remote-tracking shadow)", fx.mwEvents().length === 0);
  }

  // ===================== (DWIM) round 10's CRITICAL #1 — a same-named remote-tracking ref is refused, not silently DWIM'd =====================
  // The exact repro: a REAL configured "origin" remote (git remote add alone is enough — verified
  // directly, no clone/fetch needed), refs/remotes/origin/evil written directly (no local "evil"), then a
  // plain `project_checkout_branch({branch:"evil"})`. Under the pre-round-10 code this returned ok:true —
  // GitWriter.checkout()'s own plain `git checkout evil` DWIM'd a new local branch tracking origin/evil,
  // and the in-lock mismatch guard never ran because classifiedTip was null.
  {
    const fx = makeFixture("dwim");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/nope.git");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", fx.canonHead(), "-m", "forged");
    git(fx.repo, "update-ref", "refs/remotes/origin/evil", forged);
    check("(DWIM) setup: a remote-tracking shadow ref exists, no local 'evil' branch", git(fx.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/evil") === "refs/remotes/origin/evil");
    const r = await fx.call("project_checkout_branch", { branch: "evil" });
    check("(DWIM) is refused — round 8 would have returned ok:true here via git's own checkout DWIM", r.ok === false && r.refused === true && /remote-tracking ref/.test(r.error));
    check("(DWIM) canonical was NEVER switched to evil", fx.canonBranch() === fx.main);
    check("(DWIM) W was never established (never laundered)", fx.watermark() === null);
    check("(DWIM) a HIGH mainline_moved_outside_loom event was filed, naming remote-tracking-shadow", fx.mwEvents().some((e) => e.detail.branch === "evil" && e.detail.severity === "high" && e.detail.evidence.includes("remote-tracking-shadow") && e.detail.to === forged));
    // negative control: a REAL local branch of the same shape (no shadow involved) still works normally.
    git(fx.repo, "branch", "real-branch");
    fx.trustBranch("real-branch");
    db.deleteMeta(fx.alertKey); // the DWIM refusal above filed a project-wide alert; clear it for the control
    const r2 = await fx.call("project_checkout_branch", { branch: "real-branch" });
    check("(DWIM) negative control: an ordinary, trusted LOCAL branch switch is unaffected", r2.ok === true);
  }

  // ===================== (NAMES) round 10's MAJOR #2 — a dangerous branch-name SHAPE is refused before any git call =====================
  // "-" and "@{-1}" are git revision shorthand for "the previous branch"; "-bsneaky" is parsed as the -b
  // option; "refs/heads/x" is a full ref path, never a short name — all refused by unsafeBranchNameReason,
  // BEFORE any repo resolution or git read, for BOTH the ordinary switch and create:true paths (a real
  // watermark is established first, via a seed landing, so the create-path refusal is PROVABLY about the
  // name, not merely "no watermark yet" — that would be a vacuous pass for the wrong reason).
  for (const bad of ["-", "@{-1}", "-bsneaky", "refs/heads/x"]) {
    const fx = makeFixture("names");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check(`(NAMES "${bad}") setup: a real landing establishes a watermark to create from`, seeded.settled === true && seeded.ok === true);
    const headBefore = fx.canonHead();
    const r1 = await fx.call("project_checkout_branch", { branch: bad });
    check(`(NAMES switch "${bad}") refused before canonical moves`, r1.ok === false);
    check(`(NAMES switch "${bad}") HEAD unchanged`, fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
    const r2 = await fx.call("project_checkout_branch", { branch: bad, create: true });
    check(`(NAMES create "${bad}") refused before canonical moves, WITH a real watermark present (not a vacuous "no watermark" pass)`, r2.ok === false && !/no established mainline watermark/.test(r2.error));
    check(`(NAMES create "${bad}") HEAD unchanged`, fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
  }
  // "origin/x" is DELIBERATELY excluded from the create-path loop above: it is a syntactically legal local
  // branch name (unsafeBranchNameReason does not reject it — see the negative control below), so
  // create:true genuinely succeeds with it; only the ORDINARY SWITCH path refuses it, because no local
  // ref by that name exists yet (the (UNK)-shaped refusal, not a name-validation one).
  {
    const fx = makeFixture("namesorigin");
    const headBefore = fx.canonHead();
    const r1 = await fx.call("project_checkout_branch", { branch: "origin/x" });
    check('(NAMES switch "origin/x") refused before canonical moves (no local ref by that name, not a name-shape rejection)', r1.ok === false && r1.refused === true);
    check('(NAMES switch "origin/x") HEAD unchanged', fx.canonHead() === headBefore && fx.canonBranch() === fx.main);
  }
  // Per-site negative control (a) — direct unit coverage of unsafeBranchNameReason itself, pure, no
  // fixture: proves the (NAMES) block above is testing a REAL rejection, not a vacuous one, and that a
  // genuinely ordinary name (which the (OK)/(CREATE) scenarios elsewhere in this file already exercise
  // end-to-end) is NOT rejected by this same function.
  {
    check('(NAMES) unsafeBranchNameReason("-") rejects (leading dash)', typeof unsafeBranchNameReason("-") === "string");
    check('(NAMES) unsafeBranchNameReason("@{-1}") rejects (revision shorthand)', typeof unsafeBranchNameReason("@{-1}") === "string");
    check('(NAMES) unsafeBranchNameReason("-bsneaky") rejects (option-shaped)', typeof unsafeBranchNameReason("-bsneaky") === "string");
    check('(NAMES) unsafeBranchNameReason("refs/heads/x") rejects (full ref path)', typeof unsafeBranchNameReason("refs/heads/x") === "string");
    check('(NAMES) unsafeBranchNameReason("a..b") rejects (range syntax)', typeof unsafeBranchNameReason("a..b") === "string");
    check('(NAMES) negative control: unsafeBranchNameReason("origin/x") does NOT reject (a legal local-branch shape)', unsafeBranchNameReason("origin/x") === null);
    check('(NAMES) negative control: unsafeBranchNameReason("feature/x") does NOT reject (an ordinary name)', unsafeBranchNameReason("feature/x") === null);
  }

  // ===================== (GATE) a live/queued op of ANY kind blocks the switch, hard =====================
  {
    const fx = makeFixture("gate");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas"); // pre-trust so this scenario tests ONLY the gate-op refusal, not S1's concern
    const w = await fx.addWorker("w");

    // -- arm 1: the pending_gate_ops row (round 4) --
    const pendingOpId = "pcb-gate-pending-1";
    db.insertPendingGateOp({
      opId: pendingOpId, kind: "gate", key: `worker-gate:${pendingOpId}`, ownerSessionId: fx.mgrId,
      projectId: fx.projId, taskId: w.taskId, branch: w.branch, startedAt: new Date().toISOString(),
      state: "pending", surfacedPending: true,
    });
    check("(GATE) setup: liveGateOpsForRepoPath sees the pending_gate_ops row as gateType worker", fx.sessions.liveGateOpsForRepoPath(fx.repo).some((o) => o.opId === pendingOpId && o.gateType === "worker"));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(GATE) a pending-row op refuses the switch, hard", r1.ok === false && r1.refused === true && Array.isArray(r1.liveGateOps) && r1.liveGateOps.some((o) => o.opId === pendingOpId));
    check("(GATE) canonical untouched by the refusal", fx.canonBranch() === fx.main);
    db.settlePendingGateOp(pendingOpId);
    check("(GATE) negative control: a settled row no longer reads as live", !fx.sessions.liveGateOpsForRepoPath(fx.repo).some((o) => o.opId === pendingOpId));
    // `w` itself is still an UNMERGED worker branch — land it now so it can never mask arm 2's own
    // negative control below (this is a fixture-cleanliness step, not part of what arm 1 proves).
    const wConfirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(GATE) fixture cleanup: the seed worker from arm 1 is landed before arm 2", wConfirmed.settled === true && wConfirmed.ok === true && wConfirmed.value.merged === true);

    // -- arm 2: the LIVE GateSemaphore snapshot itself — one RUNNING (deploy) + one QUEUED (merge/batch,
    //    cap=1 forces the queue) entry, proving BOTH phases and more than one gateType are seen. --
    let releaseRunning;
    const runningP = fx.sessions.gateSemaphore.runExclusive(
      1, { gateType: "deploy", projectId: fx.projId, sessionId: fx.mgrId, opId: "pcb-sem-running", repoPath: fx.repo },
      () => new Promise((res) => { releaseRunning = res; }), "high",
    );
    for (let i = 0; i < 200 && fx.sessions.gateSemaphore.snapshot().entries.length === 0; i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: the deploy entry is registered as running", fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" && e.phase === "running"));
    const queuedP = fx.sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: fx.projId, sessionId: fx.mgrId, opId: "pcb-sem-queued", repoPath: fx.repo, batchBranches: ["loom/a", "loom/b"] },
      async () => PASS_GATE, "high",
    );
    for (let i = 0; i < 200 && !fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-queued"); i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: the batch entry is registered as queued (cap=1 behind the running deploy)", fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-queued" && e.phase === "queued"));
    const liveOps = fx.sessions.liveGateOpsForRepoPath(fx.repo);
    check("(GATE) liveGateOpsForRepoPath sees the RUNNING deploy entry", liveOps.some((o) => o.opId === "pcb-sem-running" && o.gateType === "deploy" && o.phase === "running"));
    check("(GATE) liveGateOpsForRepoPath sees the QUEUED merge/batch entry", liveOps.some((o) => o.opId === "pcb-sem-queued" && o.gateType === "merge" && o.phase === "queued"));
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(GATE) the semaphore arm ALSO refuses the switch, hard", r2.ok === false && r2.refused === true && r2.liveGateOps?.length >= 2);
    releaseRunning();
    await runningP;
    await queuedP;
    // the semaphore's own entry removal can trail the settled promise by a tick or two — poll rather
    // than assume it's synchronous with the await above.
    for (let i = 0; i < 200 && fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" || e.opId === "pcb-sem-queued"); i++) await new Promise((r) => setImmediate(r));
    check("(GATE) setup: both semaphore entries are gone after settling", !fx.sessions.gateSemaphore.snapshot().entries.some((e) => e.opId === "pcb-sem-running" || e.opId === "pcb-sem-queued"));
    check("(GATE) negative control: once both settle, the SAME call now succeeds", (await fx.call("project_checkout_branch", { branch: "atlas" })).ok === true);
  }

  // ===================== (CUT) a worktree cut in flight blocks the switch, hard =====================
  {
    const fx = makeFixture("cut");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    fx.sessions.markCuttingWorktree(fx.repo);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(CUT) a worktree cut in flight refuses the switch, hard", r1.ok === false && r1.refused === true);
    check("(CUT) canonical untouched", fx.canonBranch() === fx.main);
    fx.sessions.unmarkCuttingWorktree(fx.repo);
    check("(CUT) negative control: once unmarked, isWorktreeCuttingInFlight reads false", fx.sessions.isWorktreeCuttingInFlight(fx.repo) === false);
    check("(CUT) negative control: the SAME call now succeeds", (await fx.call("project_checkout_branch", { branch: "atlas" })).ok === true);

    // -- the refcount is released even when the REAL createWorktree(...) call THROWS (a quarantined repo),
    //    exercised through the real production path (spawnWorker), not the test's own addWorker helper. --
    enterMergeQuarantine(fx.repo, "atlas", "pcb-cut-throw-test");
    const taskId = "pcb-cut-throw-task";
    db.insertTask({ id: taskId, projectId: fx.projId, title: "feat(x): throw test", body: "", columnKey: "in_progress", position: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let threw = false;
    try { await fx.sessions.spawnWorker(fx.mgrId, { taskId, agentId: fx.agentId, kickoffPrompt: "GO" }); } catch { threw = true; }
    const liveForTask = db.listAllSessions().some((s) => s.taskId === taskId && s.processState === "live");
    check("(CUT) setup control: the quarantined spawn never produced a live worker session (threw or refused cleanly)", threw || !liveForTask);
    check("(CUT) the refcount is released even though createWorktree failed (no leaked mark)", fx.sessions.isWorktreeCuttingInFlight(fx.repo) === false);
    clearMergeQuarantine(fx.repo);
  }

  // ===================== (DIRTY) a tracked change in the canonical tree blocks the switch =====================
  {
    const fx = makeFixture("dirty");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    fs.writeFileSync(path.join(fx.repo, "README.md"), "# pcb (tracked edit)\n"); // tracked file, modified but not committed
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(DIRTY) a tracked change refuses the switch, hard", r1.ok === false && r1.refused === true && /tracked/.test(r1.error));
    check("(DIRTY) canonical untouched", fx.canonBranch() === fx.main);
    git(fx.repo, "checkout", "-q", "--", "README.md"); // discard the tracked edit
    // negative control: an UNTRACKED file does NOT block.
    fs.writeFileSync(path.join(fx.repo, "untracked.txt"), "scratch\n");
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(DIRTY) negative control: an untracked file does NOT block the switch", r2.ok === true);
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "the tool surface (manager-only), branch-name shape validation, and the basic hard refusals (any live/queued gate op, a worktree cut in flight, a tracked change in the canonical tree)" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
