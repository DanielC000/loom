import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b4080777 — the terminal event a refused batch fast-forward now gets, through the REAL
// `mergeBatchTracked` stack (never a manufactured event — see worktree-recycle-alias-protection.mjs's own
// fixture Z for the cheaper, focused proof that the predicate's lifecycle QUERY picks the new kind up).
//
// Card a2717148 split this file out of merge-landing-aborted-batch-refusal.mjs to keep each half's wall
// time well clear of the merge gate's per-file ceiling (the original, unsplit file sat near the ceiling
// under host load — see docs/decisions/a2717148-*.md). THIS file covers the three refusal shapes where
// the ff MAY have actually landed (`mayHaveLanded`, card b4080777's Round 2 follow-up) — `merge_landing_aborted`
// is deliberately NOT written for any of them, and the pre-existing content-match attribution
// (`resolveStaleGenerationOwnLanding`, card e5458ccd) resolves each one instead, never escalating:
//
//   (D) UNVERIFIED — the post-ff re-read throws (batch-merge-ff-unverified-no-fallback.mjs's own
//       `batchFfGitFactory` recipe). NO `merge_landing_aborted` is written (`mayHaveLanded`) — the
//       deliberate exclusion.
//   (E) FF-LEVEL QUARANTINED (UNCONFIRMED kill, card b4080777, Round 2) — the REAL `--ff-only` merge runs first
//       (main genuinely advances), then the SAME call throws an `UNCONFIRMED_TREE_RE`-shaped error
//       (git/bounded.ts's `treeDeathUnconfirmed`) via a `gitFactory` intercepting only
//       `["merge","--ff-only",…]` — simulating the real production shape (the child's mutation completed;
//       only its OWN kill/exit confirmation failed). Distinct from (C) (in the sibling file): the reason
//       text says main MAY already be at `targetSha`, so `mayHaveLanded:true` — NO
//       `merge_landing_aborted`, and attribution still resolves it (same re-task + reconcile proof as (D)).
//   (F) POST-FF SHA-MISMATCHED BRANCH-DIVERTED (card b4080777, Round 2) — the `--ff-only` call itself succeeds (our
//       content lands), but the post-ff re-read is fabricated to report a DIFFERENT sha on the SAME
//       expected branch (main moved further before the re-read). `mayHaveLanded:true` — NO
//       `merge_landing_aborted`, and attribution still resolves it.
//
// The shapes that DO write merge_landing_aborted — (A) FORFEITED, (B) BRANCH-DIVERTED (pre-ff), (C) an
// FF-LEVEL CONFIRMED-kill quarantine — live in the sibling file merge-landing-aborted-batch-refusal.mjs
// (same card, same split).
//
// RED-PROOFED separately, against pre-Round-2-fix code (the write gated on `!result.unverified` alone):
// (D)/(E)/(F) each wrote a spurious `merge_landing_aborted` before the fix and write none after.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/merge-landing-aborted-batch-refusal-mayhavelanded.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
useOwnLoomHome("loom-mlab-home-");
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${sfx}`);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");
const { clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");


let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mlab@loom -c user.name=mlab";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "mlab", GIT_AUTHOR_EMAIL: "mlab@loom", GIT_COMMITTER_NAME: "mlab", GIT_COMMITTER_EMAIL: "mlab@loom" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-mlab-${label}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mlab\n");
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mlab@loom");
  git(repo, "config", "user.name", "mlab");
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch", "-M", "main");
  // A resolvable LOCAL origin/HEAD symbolic ref — no real remote needed (mirrors
  // merge-landing-started-emission.mjs's own makeRepo) — mainline-resolution reads (including scenario
  // D's attribution check) expect this.
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return repo;
}

function boot(repo, projId, agentId, mgrId, runGate, extraOpts = {}) {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate, ...extraOpts,
  });
  db.insertProject({ id: projId, name: `MLAB-${projId}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { db, sessions };
}

async function addWorker(db, repo, projId, agentId, mgrId, tag) {
  const taskId = `mlab-${tag}-task-${sfx}`, workerId = `mlab-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

function landingAbortedEventsFor(db, workerId) {
  return db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_landing_aborted");
}

// Shared by (D)/(E)/(F): the existing e5458ccd attribution mechanism, exercised directly (not assumed from
// fixture Q's name) — simulate a re-task (a SECOND createWorktree on `w.taskId`, the established "re-task
// reuses the exact path/branch" recipe every worktree-recycle-alias-protection.mjs fixture uses) and run
// `reconcileOrchestrationOnBoot`. The batch-landed commit (carrying Loom-Worker-Branch/Loom-Worker-Base,
// stamped by landBranchCommitsIndividually) must be found and resolved to `merge_done`, never escalated.
async function assertAttributionResolves(label, db, sessions, repo, projId, agentId, mgrId, w) {
  const successorId = `${w.workerId}-successor`;
  const retasked = await createWorktree(repo, projId, w.taskId); // reuses w's exact worktreePath/branch
  registerForCleanup(retasked.worktreePath);
  // `currentGenerationIds` (reconcileOrchestrationOnBoot's own internal worktreePath-grouping, NOT the
  // `protectedSessionIds` arg below) picks the CURRENT generation of a shared worktreePath by `createdAt`
  // across distinct lineage groups — the successor needs a STRICTLY LATER createdAt than w's own, or it
  // ties and w itself can be read as "current" (never reaching resolveStaleGenerationOwnLanding at all).
  const successorCreatedAt = new Date(Date.parse(now) + 10_000).toISOString();
  db.insertSession({ id: successorId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: retasked.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: successorCreatedAt, lastActivity: successorCreatedAt, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: retasked.worktreePath, branch: retasked.branch });
  // Deliberately NO `protectedSessionIds` arg: passing the successor's own id there would mark its
  // (shared!) worktreePath PROTECTED (card 9ac3a739's path-keyed protection), which skips w — the stale
  // row THIS check is about — before it ever reaches the staleGeneration branch.
  const reconcileResult = await sessions.reconcileOrchestrationOnBoot();
  check(`(${label}) reconcile settles without throwing`, !!reconcileResult);
  const postReconcile = db.listEventsForWorker(w.workerId);
  check(`(${label}) worker A GETS a merge_done via the existing content-match attribution, never escalated`, postReconcile.some((ev) => ev.kind === "merge_done" && ev.detail?.staleGenerationAttributed === true));
  check(`(${label}) worker A is NEVER tracked in the one-shot escalation store`, db.listStaleGenerationUnresolved().every((e) => e.sessionId !== w.workerId));
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (D) UNVERIFIED — the post-ff re-read throws; the deliberate DoD-1 exclusion
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("unver");
    const projId = `mlab-unver-proj-${sfx}`, agentId = `mlab-unver-agent-${sfx}`, mgrId = `mlab-unver-mgr-${sfx}`;
    let combinedCalls = 0;
    function postReadFailsGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
            combinedCalls++;
            if (combinedCalls > 1) throw new Error("git rev-parse timed out after 10000ms");
          }
          return real.raw(args);
        },
      };
    }
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => PASS, { batchFfGitFactory: postReadFailsGitFactory });
    const w1 = await addWorker(db, repo, projId, agentId, mgrId, "ua"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "ub");
    // A real manager review BEFORE the batch runs (writes each candidate's own `merge_request`, carrying
    // its reviewed tip) — the precondition `resolveStaleGenerationOwnLanding`'s `eventPresence.hasMergeRequest`
    // guard requires, and the one worktree-recycle-alias-protection.mjs's own fixture Q also sets up before
    // simulating a batch landing. A batch candidate with no prior review would always no-op regardless of
    // this card's fix, so skipping this step would silently test nothing for the re-task/attribution half.
    await sessions.reviewWorkerMerge(mgrId, w1.workerId);
    await sessions.reviewWorkerMerge(mgrId, w2.workerId);
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
    const value = r.ok ? r.value : { __unsettled: r };
    check("(D) precondition: the batch genuinely landed-but-unverified (never a bare !ok, never branchDiverted/quarantined)", value.ok === false && value.unverified === true && value.branchDiverted !== true && value.quarantined !== true);
    for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
      const events = landingAbortedEventsFor(db, w.workerId);
      check(`(D, ${label}) NO merge_landing_aborted was written — the DELIBERATE exclusion (it may have landed)`, events.length === 0);
      const kinds = db.listEventsForWorker(w.workerId).map((e) => e.kind);
      check(`(D, ${label}) the worker's own lifecycle still ends at merge_landing_started`, kinds[kinds.length - 1] === "merge_landing_started");
    }

    await assertAttributionResolves("D", db, sessions, repo, projId, agentId, mgrId, w1);
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (E) FF-LEVEL QUARANTINED, UNCONFIRMED KILL (card b4080777, Round 2) — distinct from (C): the `--ff-only` child
  // itself throws a treeDeathUnconfirmed-shaped error, whose own reason text says main MAY already be at
  // targetSha. mayHaveLanded:true — NO merge_landing_aborted; attribution still resolves it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("unconf");
    const projId = `mlab-unconf-proj-${sfx}`, agentId = `mlab-unconf-agent-${sfx}`, mgrId = `mlab-unconf-mgr-${sfx}`;
    function unconfirmedKillGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "merge" && args[1] === "--ff-only") {
            // The REAL merge runs first — main genuinely advances, exactly as the production shape this
            // simulates (the git child's own mutation completed; only ITS kill/exit confirmation failed) —
            // then throw the git/bounded.ts UNCONFIRMED_TREE_RE shape treeDeathUnconfirmed(e) matches.
            await real.raw(args);
            throw new Error("(git child killed): Abort signal received (process tree not fully confirmed dead)");
          }
          return real.raw(args);
        },
      };
    }
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => PASS, { batchFfGitFactory: unconfirmedKillGitFactory });
    const w1 = await addWorker(db, repo, projId, agentId, mgrId, "ea"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "eb");
    await sessions.reviewWorkerMerge(mgrId, w1.workerId);
    await sessions.reviewWorkerMerge(mgrId, w2.workerId);
    try {
      const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
      const value = r.ok ? r.value : { __unsettled: r };
      check("(E) precondition: the batch genuinely quarantined via an UNCONFIRMED kill (never a bare !ok)", value.ok === false && value.quarantined === true);
      check("(E) precondition: the reason names the unconfirmed kill (not a plain already-quarantined refusal)", /could not be confirmed dead after a kill/.test(value.reason ?? ""));
      for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
        const events = landingAbortedEventsFor(db, w.workerId);
        check(`(E, ${label}) NO merge_landing_aborted was written — mayHaveLanded (main may already be at targetSha)`, events.length === 0);
        const kinds = db.listEventsForWorker(w.workerId).map((e) => e.kind);
        check(`(E, ${label}) the worker's own lifecycle still ends at merge_landing_started`, kinds[kinds.length - 1] === "merge_landing_started");
      }
    } finally {
      // The real quarantine registry is genuinely armed by this scenario (the unconfirmed-kill catch
      // branch really calls enterMergeQuarantine on `repo`) — clear it BEFORE the attribution check below,
      // which itself needs to createWorktree against this same repo (a quarantined repo refuses that too).
      clearMergeQuarantine(repo);
    }
    await assertAttributionResolves("E", db, sessions, repo, projId, agentId, mgrId, w1);
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (F) POST-FF SHA-MISMATCHED BRANCH-DIVERTED (card b4080777, Round 2) — the `--ff-only` call itself succeeds (our
  // content lands), but the post-ff re-read is fabricated to report a DIFFERENT sha on the SAME expected
  // branch — simulating something else advancing main further before the re-read. mayHaveLanded:true —
  // NO merge_landing_aborted; attribution still resolves it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("postdiv");
    const projId = `mlab-postdiv-proj-${sfx}`, agentId = `mlab-postdiv-agent-${sfx}`, mgrId = `mlab-postdiv-mgr-${sfx}`;
    let combinedCalls = 0;
    function postFfShaMismatchGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
            combinedCalls++;
            // Call 1 = the pre-ff forfeit-check read (must be REAL, or the forfeit check itself refuses).
            // Call 2 = the post-ff verify read — fabricate a DIFFERENT sha on the SAME expected branch.
            if (combinedCalls > 1) return `${"f".repeat(40)}\nrefs/heads/main\n`;
          }
          return real.raw(args);
        },
      };
    }
    const baseMainSha = git(repo, "rev-parse", "main");
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => PASS, { batchFfGitFactory: postFfShaMismatchGitFactory });
    const w1 = await addWorker(db, repo, projId, agentId, mgrId, "fa2"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "fb2");
    await sessions.reviewWorkerMerge(mgrId, w1.workerId);
    await sessions.reviewWorkerMerge(mgrId, w2.workerId);
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
    const value = r.ok ? r.value : { __unsettled: r };
    check("(F) precondition: the batch genuinely post-ff branch-diverted on a SHA mismatch (never unverified)", value.ok === false && value.branchDiverted === true && value.unverified !== true);
    check("(F) precondition: the reason names the sha mismatch, not a branch-name mismatch", /canonical HEAD reads/.test(value.reason ?? ""));
    check("(F) canonical mainline's OWN ref actually DID advance — the --ff-only genuinely landed, only the fabricated re-read disagreed", git(repo, "rev-parse", "main") !== baseMainSha);
    for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
      const events = landingAbortedEventsFor(db, w.workerId);
      check(`(F, ${label}) NO merge_landing_aborted was written — mayHaveLanded (our content landed before main moved further)`, events.length === 0);
      const kinds = db.listEventsForWorker(w.workerId).map((e) => e.kind);
      check(`(F, ${label}) the worker's own lifecycle still ends at merge_landing_started`, kinds[kinds.length - 1] === "merge_landing_started");
    }
    await assertAttributionResolves("F", db, sessions, repo, projId, agentId, mgrId, w1);
    db.close();
  }
} finally {
  // registerForCleanup handles every repo/worktree above.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — deliberately excluding every mayHaveLanded outcome (unverified, an ff-level UNCONFIRMED-kill quarantine, and a post-ff sha-mismatched branchDiverted) from merge_landing_aborted — all three resolved instead by the pre-existing content-match attribution, never escalated. See merge-landing-aborted-batch-refusal.mjs for the shapes that DO write merge_landing_aborted (forfeited / branchDiverted / an ff-level confirmed-kill quarantine)."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
