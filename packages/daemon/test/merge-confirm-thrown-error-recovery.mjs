import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THROWN-CONFIRM RECOVERY test (card 479f449f).
//
// THE BUG: the dead-owner eviction sweep in confirmWorkerMergeTracked is a STATIC "has the owning manager
// exited" check — it never consults how far the evicted op's own real work had progressed. Evicting a
// RUNNING op and re-minting a fresh confirmWorkerMerge can race the evicted op's own orphaned finalizeMerge
// (worktree-removal-first, per its "ORDER IS CRASH-CRITICAL" doc), which only ever runs AFTER that op's own
// squash already committed. The fresh re-mint can then throw operating on a directory its own predecessor
// just deleted — and the codebase used to report that as a flat `[loom:merge-failed]`, even though the
// branch's work may already be sitting on main. A manager reading "failed" for landed work is worse than no
// signal at all: every plausible response (re-dispatch, re-merge) risks redoing work that's already done.
//
// This file does NOT try to reproduce the exact dead-owner eviction race (merge-rest-route-tracked.mjs
// block (4) already covers that path end-to-end, at its own ~4% natural rate) — the injected `runGate`
// seam here forces a thrown exception deterministically, but ONLY when the branch's content is NOT yet
// on main (scenario (B) below) — confirmWorkerMerge's own EARLY `findLandedSquashCommit` preflight
// short-circuits BEFORE ever reaching the gate whenever the content IS already there (verified by
// instrumentation; see docs/decisions/7f86c02f-*.md's "Honest scope" section), so scenario (A) below
// exercises that separate, non-throwing short-circuit's own idempotency instead — not a thrown-then-recovered
// race. The ACTUAL "throws after a real landing, recovery also broken" shape is covered deterministically
// in the sibling file merge-confirm-post-squash-throw-recovery.mjs instead, via a different seam
// (patching `finalizeMerge`/`tipAcrossLandedCheck` directly).
//
// Proves:
//   (A) the branch's work is ALREADY on main (a real `git merge --squash` + the exact
//       `Loom-Worker-Branch:` trailer confirmWorkerMerge's own mergeBranch writes) BEFORE
//       confirmWorkerMerge ever runs — the early preflight finds it and resolves a REAL `merged:true`
//       (ALREADY_MERGED, `gateSkipped:"already-landed"`) without ever reaching the gate, pushes
//       `[loom:already-merged]`, and a later re-confirm stays idempotent (one `merge_done`, no double
//       squash, task done).
//   (B) NEGATIVE CONTROL — genuinely unknown: a real thrown error (the branch's work is NOT anywhere on
//       main, so the early preflight finds nothing and the gate genuinely runs and throws) — the
//       recovery correctly finds nothing, rethrows, and the manager gets an honest `[loom:merge-unknown]`
//       nudge (never silently swallowed, and — the DoD's own words — NEVER `[loom:merge-failed]`, since
//       a thrown exception can never prove the merge genuinely failed); a plain re-confirm genuinely
//       re-attempts rather than replaying the stale "unknown" (card 7f86c02f).
//   (C) a genuinely "unknown" confirm whose worktree then vanishes (an external cleanup) resolves the
//       EXACT `worktreeGoneLandingUnconfirmed` shape on re-confirm, never a crash, hang, or orphaned op
//       (card 7f86c02f condition 2).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-thrown-error-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mtr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME); // this file has NO finally/cleanup block at all — nothing else removes this

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mtr@loom -c user.name=mtr";
const git = (cwd, args) => execSync(`git ${GIT_ID} ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Onward completion nudges (the [loom:merge-unknown]/[loom:already-merged] text this file asserts on) only
// ever push from confirmWorkerMergeTracked's onSettledAfterPending callback — which per PendingOpRegistry's
// own contract fires ONLY for an op that was actually surfaced `{settled:false}` to some caller first (a
// caller that observes the outcome inline within its own sync-wait budget already has it — no push needed).
// A tiny syncAttachBudgetMs + a runGate that outlives it forces every op in this file down that real async
// path — the SAME shape the card's own dead-owner race takes (deep in a retry loop, well past the sync
// budget) — rather than the fast/inline path, which no completion nudge exists to assert on at all.
const TEST_SYNC_BUDGET_MS = 100;
const SLOW_THROW_MS = 400;

// SETTLE-BY-OPID RECOVERY (card 7f86c02f, per decision 89539537 — "await-settle-by-opid-not-re-invoke"):
// a `{settled:false}` degrade must be recovered by awaiting THAT SPECIFIC op's own settlement, read by
// opId off the registry, never by re-calling the tracked closure a second time. The old pattern here
// (poll `peek()` for "left running", then issue a second plain `confirmWorkerMergeTracked` call to read
// the result) was SAFE only while every outcome this file exercises was cacheable — once "unknown" (card
// 7f86c02f) joined NEVER_CACHED_OUTCOMES, a second plain call in scenario (B) no longer attaches to the
// first op at all: it mints a genuinely SECOND real op (another real runGate throw), which can itself
// still be running past this file's own tiny TEST_SYNC_BUDGET_MS and degrade to pending AGAIN — silently
// reporting a second run's non-settlement as "the confirm did not settle". `awaitSettleByOpId` reads the
// one op this file's own `pending` call actually minted, by its own opId, sidestepping that entirely.
async function settleByOpId(sessions, opId, label) {
  const settled = await sessions.pendingOps.awaitSettleByOpId(opId, 30_000);
  if (!settled) throw new Error(`${label}: op ${opId} did not settle within 30000ms`);
  return settled.ok ? { settled: true, ok: true, value: settled.value } : { settled: true, ok: false, error: settled.error };
}

function makePtyStub() {
  const calls = [];
  return {
    calls,
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); return { delivered: true }; },
  };
}

async function setup(sfx, { preLand } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mtr-repo-${sfx}`);
  registerForCleanup(reposDir); // this file has NO finally/cleanup block at all — nothing else removes this
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mtr\n");
  execSync(`git init -q && git config user.email mtr@loom && git config user.name mtr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const db = new Db();
  const mgrId = `mtr-mgr-${sfx}`, projId = `mtr-p-${sfx}`, taskId = `mtr-t-${sfx}`, workerId = `mtr-w-${sfx}`;
  const config = { orchestration: { gateCommand: "pnpm gate" } };
  db.insertProject({ id: projId, name: "MTR", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mtr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mtr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mtr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MTR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mtr-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  if (preLand) {
    // Mirrors mergeBranch's OWN squash + trailer exactly (worktrees.ts's mergeBranchLocked) — a REAL
    // `git merge --squash` so branchContentLandedInCommit's content check (findLandedSquashCommit's
    // proof-not-just-trailer step) genuinely passes, the same way a real predecessor's landed squash would.
    execSync(`git merge --squash ${branch}`, { cwd: repo });
    // Single-line message (deliberately, not two lines separated by a real blank line): findLandedSquashCommit's
    // `-F` fixed-string --grep only needs the exact trailer text present as a SUBSTRING anywhere in the
    // message body — it doesn't require real newlines — and a single line sidesteps any cross-shell
    // newline-escaping ambiguity in how execSync passes this arg through cmd.exe on Windows.
    execSync(`git ${GIT_ID} commit -q -m "feat: MTR-TASK" --trailer "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  }

  return { db, repo, mgrId, projId, taskId, workerId, branch, worktreePath };
}

// ── (A) RECOVERABLE: confirmWorkerMerge throws, but the branch's work is ALREADY on main ──────────────
{
  const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo, taskId } = await setup(sfx, { preLand: true });
  const headBefore = git(repo, "rev-parse HEAD");
  const pty = makePtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(A) degrades to pending past the tiny sync budget (forces the real async completion-nudge path)", pending.settled === false);
  // Not a nudge-text poll: the recovery path's [loom:already-merged] push fires from INSIDE
  // finishAlreadyMerged, partway through its own body (before its pty.stop/finalizeMerge tail) — well
  // BEFORE the op itself genuinely settles in the registry. Read this SPECIFIC op's own settlement by
  // opId (see settleByOpId above) rather than polling peek() + a second plain call — mirrors
  // merge-confirm-dead-owner-recovery.mjs's proven pattern, upgraded per decision 89539537.
  const result = await settleByOpId(sessions, pending.op.opId, "(A)");
  check("(A) the confirm settles (not a hung pending)", result.settled === true);
  check("(A) it recovers to a REAL merged:true — never reports the landed work as failed", result.ok === true && result.value?.merged === true);
  check("(A) classified as ALREADY_MERGED (the same idempotent path a stale retry uses)", result.ok === true && result.value?.emptyKind === "ALREADY_MERGED");
  check("(A) canonical repo gained NO new commit — recovery only OBSERVED the already-landed squash, never re-merged", git(repo, "rev-parse HEAD") === headBefore);

  const failedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  const unknownNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  const alreadyMergedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:already-merged\]/.test(c.text));
  check("(A) NEGATIVE CONTROL — zero [loom:merge-failed] nudges for work that actually landed", failedNudges.length === 0);
  check("(A) NEGATIVE CONTROL — zero [loom:merge-unknown] nudges either — this case is NOT unknown, it's proven merged", unknownNudges.length === 0);
  check("(A) POSITIVE — exactly one [loom:already-merged] nudge fired", alreadyMergedNudges.length === 1);

  // @decision 7f86c02f — a genuinely FRESH re-confirm after ALREADY_MERGED must also finish idempotently;
  // see that record's "Honest scope" section (this scenario does NOT exercise a thrown-confirm race).
  const result2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(A re-confirm) a plain re-confirm after ALREADY_MERGED still finishes idempotently (merged:true)", result2.settled === true && result2.ok === true && result2.value?.merged === true);
  check("(A re-confirm) EXACTLY ONE merge_done event total — the re-confirm never files a duplicate", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 1);
  check("(A re-confirm) canonical repo STILL gained no new commit after the re-confirm — never squashed twice", git(repo, "rev-parse HEAD") === headBefore);
  check("(A re-confirm) the task moved to a terminal (done) column", db.getTask(taskId)?.columnKey === "done");

  db.close();
}

// ── (B) NEGATIVE CONTROL — genuinely unknown: same thrown error, but the branch never landed anywhere ──
{
  const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setup(sfx, { preLand: false });
  const headBefore = git(repo, "rev-parse HEAD");
  const pty = makePtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(B) degrades to pending past the tiny sync budget (forces the real async completion-nudge path)", pending.settled === false);
  // Card 7f86c02f: read THIS op by opId (settleByOpId above) rather than polling peek() + a second plain
  // call — "unknown" is now a NEVER_CACHED_OUTCOMES member, so a second plain confirmWorkerMergeTracked
  // call here would no longer attach to this op; it would mint a genuinely SECOND real run instead,
  // silently reporting that second run's own (possibly still-pending) state as this op's result.
  const result = await settleByOpId(sessions, pending.op.opId, "(B)");
  check("(B) the confirm settles", result.settled === true);
  check("(B) recovery correctly found nothing to recover — the throw surfaces (ok:false)", result.settled === true && result.ok === false);
  check("(B) canonical repo untouched — recovery never invents a merge", git(repo, "rev-parse HEAD") === headBefore);

  const failedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  const unknownNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  check("(B) CRITICAL — this is NEVER reported as [loom:merge-failed] (card 479f449f DoD 2 — a thrown exception can never prove a genuine failure)", failedNudges.length === 0);
  check("(B) POSITIVE — exactly one honest [loom:merge-unknown] nudge fired instead — never silently swallowed", unknownNudges.length === 1);
  check("(B) the nudge explicitly says this is NOT a confirmed failure", unknownNudges[0] && /NOT a confirmed failure/.test(unknownNudges[0].text));
  check("(B) the nudge still carries the real thrown error text (diagnostic, not vague)", unknownNudges[0] && /Cannot use simple-git on a directory that does not exist/.test(unknownNudges[0].text));

  // Card 7f86c02f, condition 1 (the core repro's end-to-end sibling): a plain re-confirm after a
  // GENUINELY unknown outcome must also genuinely re-attempt, never replay the stale "unknown" — mirrors
  // the moved/re-fire semantics id10/id13 prove at the registry level, end-to-end through the real
  // confirmWorkerMerge recovery path. Same runGate stub (always throws), so the re-attempt settles
  // "unknown" again too — the point is that it is a FRESH run, not a cache hit.
  // GUARD AGAINST A PRE-FIX CRASH (not just a false pass): pre-fix, "unknown" dedupe-hits, so `pending2`
  // settles IMMEDIATELY as a cache hit (no `.op` field at all) — reading `pending2.op.opId` unguarded
  // would throw a TypeError here and abort the whole file before scenario (C) below ever runs. Check
  // `.settled` first and branch, so the RED proof actually reaches (and reds) every later assertion
  // instead of crashing out on this one.
  const pending2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(B re-confirm) a plain re-confirm after 'unknown' degrades to pending too — it is genuinely re-running, not an instant cache hit", pending2.settled === false);
  const result2 = pending2.settled === false && pending2.op?.opId
    ? await settleByOpId(sessions, pending2.op.opId, "(B re-confirm)")
    : pending2;
  check("(B re-confirm) it is a GENUINELY FRESH op, not the first one replayed", pending2.settled === false && pending2.op?.opId !== undefined && pending2.op.opId !== pending.op.opId);
  check("(B re-confirm) the fresh re-attempt also settles ok:false (the stub always throws) — never a cacheHit", result2.settled === true && result2.ok === false);
  check("(B re-confirm) canonical repo STILL untouched after the re-attempt", git(repo, "rev-parse HEAD") === headBefore);
  const unknownNudgesAfterReconfirm = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  check("(B re-confirm) a SECOND, independent [loom:merge-unknown] nudge fired for the fresh re-attempt (not deduped/suppressed)", unknownNudgesAfterReconfirm.length === 2);

  db.close();
}

// ── (C) card 7f86c02f, condition 2: the 5s TTL retained-map loss ───────────────────────────────────────
// "unknown" is now excluded from BOTH caches — the never-expiring until-superseded map AND (via
// `usableRetainedHit`'s own NEVER_CACHED_OUTCOMES check) the brief TTL `retained` map decision 33172f01
// added specifically to stop an accidental duplicate re-confirm from re-running against a torn-down
// worktree. A re-confirm landing WITHIN that 5s window (MERGE_OP_RETAIN_MS), after an "unknown", whose
// worktree has since genuinely disappeared (an external cleanup/GC, independent of this confirm's own
// flow), must settle to a SANE, NAMED outcome — never crash, never hang, never leave an orphaned pending
// op stuck under the key forever.
{
  const sfx = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo, taskId, worktreePath } = await setup(sfx, { preLand: false });
  const pty = makePtyStub();
  let gateCalls = 0;
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { gateCalls++; await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(C) degrades to pending past the tiny sync budget", pending.settled === false);
  const result = await settleByOpId(sessions, pending.op.opId, "(C)");
  check("(C) first confirm settles ok:false ('unknown')", result.settled === true && result.ok === false);
  check("(C) runGate invoked exactly once so far", gateCalls === 1);

  // Simulate the worktree disappearing between the first "unknown" settle and the second re-confirm —
  // e.g. a sibling cleanup/GC process tearing it down independently of this confirm's own flow.
  fs.rmSync(worktreePath, { recursive: true, force: true });
  check("(C setup) the worktree is genuinely gone on disk", !fs.existsSync(worktreePath));

  // WELL within MERGE_OP_RETAIN_MS (5s) — exactly the window 33172f01's TTL retained-map guard used to
  // cover for "unknown"; it no longer does (card 7f86c02f), so this is a genuinely fresh re-attempt.
  // CR finding (reproduced 3/3 via the reviewer's own fixture): this does NOT re-throw and does NOT
  // re-invoke the gate — confirmWorkerMerge's own EARLY worktree-existence check refuses first, before
  // any gate lane, with the SAME typed `worktreeGoneLandingUnconfirmed` shape worker_merge_confirm's own
  // "SIXTH DELIBERATE EXCEPTION" describes. That is the ONE real, fixed outcome — assert exactly it, not
  // an either/or with a thrown re-attempt (the either/or previously let a pre-fix cache REPLAY of the
  // first call's thrown error — itself `result2.error instanceof Error` — pass this check undetected).
  const pending2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const result2 = pending2.settled ? pending2 : await settleByOpId(sessions, pending2.op.opId, "(C re-confirm)");
  check("(C re-confirm) the re-confirm SETTLES — never hangs, never an unhandled rejection at the call site", result2.settled === true);
  check("(C re-confirm) resolves EXACTLY the worktree-gone-landing-unconfirmed shape — ok:true, merged:false", result2.ok === true && result2.value?.merged === false && result2.value?.worktreeGoneLandingUnconfirmed === true);
  check("(C re-confirm) NEVER a cacheHit — a genuinely fresh refusal, not a replayed 'unknown'", result2.cacheHit === undefined);
  check("(C re-confirm) runGate was NOT re-invoked — the worktree-gone check refuses before any gate lane", gateCalls === 1);
  check("(C re-confirm) the task stays in_progress — never finalized", db.getTask(taskId)?.columnKey === "in_progress");
  check("(C re-confirm) ZERO merge_done events total — nothing was ever finalized", db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length === 0);
  const rejectedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-rejected\]/.test(c.text));
  check("(C re-confirm) exactly one [loom:merge-rejected] nudge fired for the re-confirm", rejectedNudges.length === 1);
  check("(C re-confirm) peek's own outcome names worktree-gone-landing-unconfirmed", sessions.pendingOps.peek(`merge:${workerId}`)?.outcome === "worktree-gone-landing-unconfirmed");

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a thrown confirmWorkerMerge error is never reported as a flat merge-failed: confirmWorkerMergeTracked's recovery re-derives the truth from git and reports a real 'merged' when the work is already on main (never re-merging, never a bogus failed/unknown nudge), honestly reports 'unknown' (never 'failed', never silent) when the outcome genuinely cannot be determined either way, a plain re-confirm after 'unknown' genuinely re-attempts rather than replaying it (never cached, in either cache), and a re-confirm whose worktree has since vanished still settles sanely rather than hanging or crashing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
