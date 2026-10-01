import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round 3), DoD item 5 — the `unverified` sibling of
// batch-merge-branch-diverted-no-fallback.mjs, at the SAME `mergeBatchTracked` level. That file proves
// `result.branchDiverted` runs no per-candidate fallback; this one proves `result.unverified` (the `--ff-
// only` did NOT throw — HEAD genuinely advanced — but the POST-ff re-read confirming where it landed
// failed) does the same, and files `batch_merge_ff_unverified` rather than `batch_merge_branch_diverted`.
//
// No existing production seam can fail ONLY the post-ff re-read from this level — see
// mainline-watch-ff-unverified.mjs's own header for why it instead simulates the DOWNSTREAM state by hand.
// This file drives the REAL defect through the REAL `mergeBatchTracked` stack instead, via a new, narrow
// test seam: `SessionService`'s `batchFfGitFactory` opt, threaded into `runBatchedMerge`'s own `deps`
// (sessions/service.ts). The injected factory proxies every real git call except the SECOND
// `rev-parse HEAD --symbolic-full-name HEAD` combined read (the first is the pre-check/forfeit read inside
// `fastForwardCanonicalMain`; the second is `verifyLanded`'s own post-ff re-read) — which it makes THROW,
// mirroring batch-merge-canonical-branch-divert.mjs's own `scenarioPostReadFailureIsUnverified` exactly,
// just reached through the full service stack rather than called directly against `fastForwardCanonicalMain`.
//
//   (1) the gate reports green, the real `--ff-only` genuinely lands (canonical HEAD actually advances),
//       but the injected factory's post-ff re-read throws — `result.unverified === true`, never
//       `branchDiverted` (the landing almost certainly happened; only the read failed).
//   (2) NO per-candidate fallback ran: every candidate reports `started:false` (a second, divergent landing
//       on top of content that's probably already on main would be the WORSE outcome a fallback risks).
//   (3) canonical mainline's OWN ref actually DID advance (unlike a divert, this is a successful landing —
//       just an unconfirmed one).
//   (4) a durable `batch_merge_ff_unverified` event was filed, never `batch_merge_branch_diverted`.
//
// FALSIFIABILITY (mirrors batch-merge-branch-diverted-no-fallback.mjs's own "TEST GAP 5(b)" proof): if
// sessions/service.ts's `if (result.unverified)` block (~17725) were ever deleted, this outcome would
// instead fall through to the generic `!result.ok` branch below it — which DOES run the ordinary
// per-candidate fallback. Verified directly: temporarily deleting that block and re-running this file turns
// checks (2) (started:false / no squash commits) and (4) (the distinct event/nudge) from PASS to FAIL —
// the fallback starts a real solo `worker_merge_confirm` per candidate instead, which lands a SECOND,
// divergent commit on top of the already-landed (but unconfirmed) batch content.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-ff-unverified-no-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmuv-nf-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmuv", GIT_AUTHOR_EMAIL: "bmuv@loom", GIT_COMMITTER_NAME: "bmuv", GIT_COMMITTER_EMAIL: "bmuv@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmuv@loom -c user.name=bmuv";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `bmuvnf-proj-${sfx}`, agentId: `bmuvnf-agent-${sfx}`, mgrId: `bmuvnf-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmuvnf-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmuvnf\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmuv@loom"); git(P.repo, "config", "user.name", "bmuv");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const canonBranch = () => git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const baseSha = canonHead();

// The injected batch git factory: proxies every real call except the SECOND combined
// `rev-parse HEAD --symbolic-full-name HEAD` (the post-ff re-read inside `verifyLanded`), which throws —
// a transient read failure, never a wrong-but-readable answer (that would classify as `branchDiverted`
// instead; see batch-merge-canonical-branch-divert.mjs's own sibling scenarios for both shapes).
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

/** One "daemon": a Db + a SessionService wired with the injected batch git factory. */
function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate: async () => PASS,
    batchFfGitFactory: postReadFailsGitFactory,
  });
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { nudges.push(String(text)); return orig(target, text, ...rest); };
  return { db, sessions, nudges };
}

async function addWorker(db, tag) {
  const taskId = `bmuvnf-${tag}-task-${sfx}`, workerId = `bmuvnf-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

try {
  const d = boot();
  d.db.insertProject({ id: P.projId, name: "BMUVNF", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const w1 = await addWorker(d.db, "a"), w2 = await addWorker(d.db, "b");

  check("precondition: canonical is on mainline before the batch", canonBranch() === MAIN && canonHead() === baseSha);
  const r = await d.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("settled synchronously", r.settled === true);
  const value = r.settled && r.ok ? r.value : { __unsettled: r };

  check("precondition: the injected factory's post-ff interception actually fired", combinedCalls > 1);
  check("(1) the batch reports unverified (never a bare !ok, never branchDiverted)", value.ok === false && value.unverified === true && value.branchDiverted !== true);
  check("(1) reason names the verification failure", /could not be verified|could not be re-read/i.test(value.reason ?? ""));
  check("(2) NO per-candidate fallback was started — every candidate reports started:false", Array.isArray(value.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === false));
  check("(2) the dedicated manager guidance names the next step (git log + ALREADY_MERGED)", value.fallback.every((f) => /check git log|ALREADY_MERGED/i.test(f.reason)));
  // Card b801bad0 (fix round 4), DoD item 4 — the unverifiedTail also names the checkout check now: an
  // unverified post-ff re-read leaves canonical's OWN branch unconfirmed too, not just the landing.
  check("(2) the guidance also names confirming the checkout before any worker_merge_confirm", value.fallback.every((f) => /confirm canonical is checked out on .* before any worker_merge_confirm/i.test(f.reason)));
  check("(2) neither worker's branch carries a squash commit (no solo worker_merge_confirm ran)", git(P.repo, "log", "-1", "--format=%s", w1.branch) === "feat(x): change a" && git(P.repo, "log", "-1", "--format=%s", w2.branch) === "feat(x): change b");
  check("(2) neither worker's task moved off in_progress", d.db.getTask(w1.taskId)?.columnKey === "in_progress" && d.db.getTask(w2.taskId)?.columnKey === "in_progress");
  check("(3) canonical mainline's OWN ref DID advance — the --ff-only genuinely landed, only the re-read failed", git(P.repo, "rev-parse", MAINREF) !== baseSha);
  check("(3) the branch is still MAIN, not diverted (unlike a confirmed branchDiverted outcome)", canonBranch() === MAIN);

  const unverified = d.db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_ff_unverified" && e.detail?.projectId === P.projId);
  const diverted = d.db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_branch_diverted" && e.detail?.projectId === P.projId);
  check("(4) exactly ONE durable batch_merge_ff_unverified event, naming the expected branch", unverified.length === 1 && unverified[0].detail.expectedBranch === MAIN);
  check("(4) NO batch_merge_branch_diverted event was filed (this is a distinct outcome)", diverted.length === 0);

  // Card b801bad0 (fix round 4), DoD item 2 — `gate_status(opId)`'s own `batchLanded` field must carry the
  // THIRD, distinct meaning this round's docs add (mcp/orchestration.ts, PendingGateOpVerdict.batchLanded):
  // `undefined` on a batch "pass" row whose fast-forward genuinely landed but whose post-landing re-read
  // failed — never `false` (that would read as a MEASURED NEGATIVE, i.e. "confirmed NOT landed", which is
  // the wrong claim here: the landing almost certainly happened) and never a bare absence indistinguishable
  // from "not a batch row". `batchBranchCount` stays the real assembled count regardless (unaffected by this).
  const gs = d.sessions.gateStatus(value.opId);
  check("(5) gate_status is settled, outcome pass (the GATE passed — only the post-ff verify failed)", gs.state === "settled" && gs.outcome === "pass" && gs.passed === true);
  check("(5) gate_status.batchLanded is undefined — the THIRD meaning (could not be verified), never false", gs.batchLanded === undefined);
  check("(5) gate_status.batchBranchCount is still the real assembled count, unaffected by batchLanded's undefined", gs.batchBranchCount === 2);
  // No async settle nudge check here: this op settled SYNCHRONOUSLY (`r.settled === true` above), and
  // merge_batch's own tool description is explicit that the async nudge "fires once, but ONLY for a caller
  // that actually observed the pending shape — a caller whose batch settles inside the bounded wait gets
  // the full result inline and needs no nudge" — so asserting one fired here would assert the wrong thing.
  check("(4) no async settle nudge fired at all (this op settled synchronously, so none was needed)", d.nudges.length === 0);

  d.db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an unverified batch fast-forward (the --ff-only genuinely landed, only the post-ff re-read failed) runs NO per-candidate fallback, is recorded as a distinct batch_merge_ff_unverified event (never branchDiverted), and surfaces its own dedicated manager guidance."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
