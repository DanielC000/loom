import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b4080777 — the terminal event a refused batch fast-forward now gets, through the REAL
// `mergeBatchTracked` stack (never a manufactured event — see worktree-recycle-alias-protection.mjs's own
// fixture Z for the cheaper, focused proof that the predicate's lifecycle QUERY picks the new kind up).
//
// `RunBatchedMergeResult.landingStarted` (git/batch-merge.ts) is true from the point `onBeforeFastForward`
// fires onward; `mergeBatchTracked` (sessions/service.ts) writes ONE `merge_landing_aborted` event per
// LANDED candidate, centrally, ahead of every per-outcome branch, whenever that flag is set on a refused
// (`!result.ok`) outcome that does NOT ALSO carry `mayHaveLanded`.
//
// Card a2717148 split this file in two to keep each half's wall time well clear of the merge gate's
// per-file ceiling (the original, unsplit file sat near the ceiling under host load — see
// docs/decisions/a2717148-*.md). THIS file covers the three refusal shapes that DO write
// merge_landing_aborted, reusing this project's own established recipes for each (never re-derived from
// scratch):
//
//   (A) FORFEITED — canonical main advances mid-gate (batch-merge-gate-retry-forfeit.mjs's own recipe:
//       commit directly onto the canonical repo from inside the injected `runGate` callback). Both
//       candidates get `merge_landing_aborted`, even though `mergeBatchTracked`'s generic `!result.ok`
//       handler ALSO starts a real per-candidate solo fallback afterward (see docs/decisions/b4080777-*.md
//       for why that coexistence is safe — "latest wins", also asserted directly at the end of (A)).
//   (B) BRANCH-DIVERTED (pre-ff) — a stray checkout mid-gate (batch-merge-branch-diverted-no-fallback.mjs's
//       own `GitWriter.createBranch` recipe). Both candidates get `merge_landing_aborted`; no fallback runs.
//   (C) FF-LEVEL QUARANTINED (confirmed kill) — `enterMergeQuarantine` fired mid-gate
//       (merge-quarantine-batch.mjs's own SCENARIO D recipe), distinct from a PRE-assembly quarantine
//       (which never reaches `onBeforeFastForward` at all, so `landingStarted` is never set and no event
//       should be written — covered by `landingStarted`'s own absence, a pure code-inspection fact, not
//       retested here).
//
// The deliberate mayHaveLanded exclusions — (D) UNVERIFIED, (E) an UNCONFIRMED-kill quarantine, (F) a
// post-ff sha-mismatched branchDiverted — live in the sibling file
// merge-landing-aborted-batch-refusal-mayhavelanded.mjs (same card, same split).
//
// A "generic ff failure" (bare `ok:false`, none of forfeited/branchDiverted/quarantined/unverified set —
// e.g. a plain `--ff-only` error unrelated to any of those) is NOT given its own scenario here: it reaches
// `mergeBatchTracked` via the exact same `landingStarted`-gated write as (A), so a dedicated repro would
// exercise no code path this file's (A) doesn't already cover, and safely constructing one (an `--ff-only`
// failure that is neither a forfeit, a quarantine, nor a divert) has no existing recipe in this project to
// reuse. Named here rather than silently absent.
//
// RED-PROOFED against pre-fix code: this file FAILS (A)/(B)/(C)'s own `merge_landing_aborted` assertions —
// verified by temporarily reverting the `landingStarted` field + the centralized write in
// sessions/service.ts and re-running this file: (A)/(B)/(C)'s event-presence checks go RED, confirming the
// fixtures discriminate the fix rather than something else.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/merge-landing-aborted-batch-refusal.mjs
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
const { GitWriter } = await import("../dist/git/writer.js");
const { enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");


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

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A) FORFEITED — canonical main advances mid-gate
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("forfeit");
    const projId = `mlab-forfeit-proj-${sfx}`, agentId = `mlab-forfeit-agent-${sfx}`, mgrId = `mlab-forfeit-mgr-${sfx}`;
    let gateCalls = 0;
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => {
      gateCalls++;
      // Someone else lands directly on canonical main WHILE this batch's gate "runs" — but ONLY on the
      // first call: this SAME injected `runGate` is also reached by the forfeited batch's own real
      // per-candidate solo fallback (batch-merge-gate-retry-forfeit.mjs's own "calls 3+" precedent), which
      // must just pass cleanly rather than try to commit the SAME no-op change again.
      if (gateCalls === 1) {
        fs.writeFileSync(path.join(repo, "concurrent.txt"), "someone else landed\n");
        commitAll(repo, "chore(x): concurrent main advance", GIT_ID);
      }
      return PASS;
    });
    const w1 = await addWorker(db, repo, projId, agentId, mgrId, "fa"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "fb");
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
    const value = r.ok ? r.value : { __unsettled: r };
    // Card b4080777 finding: `MergeBatchResult` does NOT expose a `forfeited` flag on this generic
    // `!result.ok` fallthrough (unlike branchDiverted/quarantined/unverified/cancelled, each of which gets
    // its own dedicated return block) — only the durable `batch_merge_forfeited` audit event and the
    // reason text confirm this specific shape externally.
    check("(A) precondition: the batch genuinely forfeited", value.ok === false && /canonical main advanced/.test(value.reason ?? ""));
    check("(A) precondition: a durable batch_merge_forfeited event was filed", db.listEventsSince(0, 100000).some((e) => e.kind === "batch_merge_forfeited" && e.detail?.opId === value.opId));
    for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
      const events = landingAbortedEventsFor(db, w.workerId);
      check(`(A, ${label}) exactly one merge_landing_aborted was written`, events.length === 1);
      check(`(A, ${label}) it carries reason:"batch_ff_refused", batch:true, no branch field`, events[0]?.detail?.reason === "batch_ff_refused" && events[0]?.detail?.batch === true && events[0]?.detail?.branch === undefined);
      const kinds = db.listEventsForWorker(w.workerId).map((e) => e.kind);
      check(`(A, ${label}) merge_landing_started fires before merge_landing_aborted`, kinds.indexOf("merge_landing_started") >= 0 && kinds.indexOf("merge_landing_aborted") > kinds.indexOf("merge_landing_started"));
    }
    check("(A) precondition: the gate genuinely ran (both candidates share one batch gate)", gateCalls >= 1);
    // Card b4080777 Round 2 finding 2 — LATEST-WINS: the real solo fallback (started because `forfeited` falls
    // into the generic `!result.ok` handler, which does NOT use `runFallback`'s noStart mode) genuinely
    // re-gates and lands each candidate solo; each lifecycle's LAST event must be the fallback's own
    // merge_done (or another terminal it produced), never the earlier, now-superseded merge_landing_aborted.
    for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
      const kinds = db.listEventsForWorkerKinds(w.workerId, ["merge_request", "merge_landing_started", "merge_done", "merge_rejected", "merge_cancelled", "merge_landing_aborted"]).map((e) => e.kind);
      check(`(A, ${label}) the real solo fallback actually ran and landed (a merge_done now exists)`, kinds.includes("merge_done"));
      check(`(A, ${label}) latest-wins: the lifecycle's LAST event is the fallback's own terminal (merge_done), never the stale merge_landing_aborted`, kinds[kinds.length - 1] === "merge_done");
    }
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B) BRANCH-DIVERTED — a stray checkout mid-gate
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("divert");
    const projId = `mlab-divert-proj-${sfx}`, agentId = `mlab-divert-agent-${sfx}`, mgrId = `mlab-divert-mgr-${sfx}`;
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => {
      await new GitWriter(repo).createBranch(`mlab-stray-${sfx}`);
      return PASS;
    });
    const w1 = await addWorker(db, repo, projId, agentId, mgrId, "da"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "db");
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
    const value = r.ok ? r.value : { __unsettled: r };
    check("(B) precondition: the batch genuinely branch-diverted", value.ok === false && value.branchDiverted === true);
    for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
      const events = landingAbortedEventsFor(db, w.workerId);
      check(`(B, ${label}) exactly one merge_landing_aborted was written`, events.length === 1);
      check(`(B, ${label}) it carries reason:"batch_ff_refused", batch:true, no branch field`, events[0]?.detail?.reason === "batch_ff_refused" && events[0]?.detail?.batch === true && events[0]?.detail?.branch === undefined);
    }
    check("(B) NO per-candidate solo fallback ran (no squash commit on either branch)", git(repo, "log", "-1", "--format=%s", w1.branch) === "feat(x): change da" && git(repo, "log", "-1", "--format=%s", w2.branch) === "feat(x): change db");
    db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (C) FF-LEVEL QUARANTINED — enterMergeQuarantine fires mid-gate (distinct from a PRE-assembly
  // quarantine, which never reaches onBeforeFastForward at all)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("quar");
    const projId = `mlab-quar-proj-${sfx}`, agentId = `mlab-quar-agent-${sfx}`, mgrId = `mlab-quar-mgr-${sfx}`;
    const { db, sessions } = boot(repo, projId, agentId, mgrId, async () => {
      enterMergeQuarantine(repo, "unrelated-branch", "manufactured MID-GATE for card b4080777 scenario C");
      return PASS;
    });
    try {
      const w1 = await addWorker(db, repo, projId, agentId, mgrId, "qa"), w2 = await addWorker(db, repo, projId, agentId, mgrId, "qb");
      const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
      const value = r.ok ? r.value : { __unsettled: r };
      check("(C) precondition: the batch genuinely quarantined AT THE FAST-FORWARD STEP (assembly itself succeeded)", value.ok === false && value.quarantined === true);
      for (const [w, label] of [[w1, "a"], [w2, "b"]]) {
        const events = landingAbortedEventsFor(db, w.workerId);
        check(`(C, ${label}) exactly one merge_landing_aborted was written (ff-level quarantine, landingStarted already fired)`, events.length === 1);
        check(`(C, ${label}) it carries reason:"batch_ff_refused", batch:true, no branch field`, events[0]?.detail?.reason === "batch_ff_refused" && events[0]?.detail?.batch === true && events[0]?.detail?.branch === undefined);
      }
    } finally {
      clearMergeQuarantine(repo);
    }
    db.close();
  }
} finally {
  // registerForCleanup handles every repo/worktree above.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a refused batch fast-forward (forfeited, branchDiverted, an ff-level confirmed-kill quarantine) writes one merge_landing_aborted per landed candidate through the REAL mergeBatchTracked stack; and the forfeited case's real solo fallback correctly supersedes the earlier merge_landing_aborted (latest wins). See merge-landing-aborted-batch-refusal-mayhavelanded.mjs for the deliberate mayHaveLanded exclusions (unverified / unconfirmed-kill quarantine / post-ff sha-mismatched branchDiverted)."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
