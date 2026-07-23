import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// HEAD-CURRENCY on a SETTLED run_gate result (card 39196378 — the "queued gate validates fire-time, not
// run-time" trap, a CONFIRMED live incident on a peer daemon): `validatedHead` is stamped at the moment a
// run STARTS, before it's even admitted past the gate semaphore. A cap-1 queue routinely runs 30+ minutes
// — easily long enough for the SAME worker to keep committing while it waits — so a caller who reads a
// GREEN result and assumes it covers whatever's on the branch NOW, without checking `validatedHead`
// against branch HEAD, can act on a false signal. The mitigation already existed for the MID-FLIGHT case
// (`staleAgainstWorktree` on a still-running/re-called op); this file proves the gap that was open on the
// SETTLED result: `headCurrent`/`headWarning`, computed once at settle time via
// SessionService.describeGateHeadCurrency.
//
// VERIFIED MECHANISM (checked against gate-semaphore.ts/gate-runner.ts, not assumed from the card): the
// build/test child process is NOT spawned at fire time — `GateSemaphore.runExclusive` awaits the queue
// (`acquire()`) BEFORE ever invoking its `fn`, and once admitted, `runGateStep` spawns directly against
// the live worktree path, no checkout/stash/snapshot involved. So a commit landing during the QUEUE WAIT
// (before admission) is fully present in what the gate actually builds/tests — only the fire-time LABEL
// misses it. A commit landing WHILE the gate is already spawned and running is a different, riskier case:
// the process may read a torn mix of old and new files. `describeGateHeadCurrency` takes THREE stamps —
// fire (`startStamp`), admission (`admitStamp`), settle (`settleStamp`) — specifically to tell these
// apart; a cruder start-vs-settle-only comparison cannot.
//
// Three shapes, and the wording must differ so a real warning doesn't get trained out by a benign one
// crying wolf:
//   (A) RACY (concerning) — the worktree changes AFTER admission, i.e. WHILE the gate is actually
//       running. headCurrent must be false, and the warning must say the run's own execution window saw
//       an unstable tree — treat the result as unverified.
//   (B) RELABELED (benign), aka "moved-during-queue-wait" — the worktree changes AFTER fire but BEFORE
//       admission (forced here via a blocker worker holding the one gate-semaphore slot), and nothing
//       moves after that. headCurrent must be false too (the sha genuinely changed), but the warning must
//       say the run's content likely DOES cover the current tree — a different, gentler claim than (A)'s.
//       This is a REAL shape, not a hypothetical: a sibling worker on this same fleet hit it independently
//       the same day this test was written (see the card's follow-up discussion) — it fired run_gate, kept
//       working, and committed before the gate settled.
//   (C) UNCHANGED — nothing happens during the run. headCurrent must be true and headWarning must be
//       absent — the common case must never carry a warning.
//
// Drives the REAL runWorkerGate against REAL git worktrees (via createWorktree), with an injected
// `runGate` seam that controls ONLY when/whether the fake gate command "runs" — the git mutations
// themselves are real `git commit`s the test performs, so the worktree-stamp comparisons are exercised for
// real, not faked.
//
// Run: 1) build daemon (pnpm build), 2) node test/run-gate-head-currency.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rghc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=rghc@loom -c user.name=rghc";
const now = new Date().toISOString();
const ptyStub = () => ({ stop() {}, isAlive() { return false; }, enqueueStdin() {} });

const worktrees = [];
const dbs = [];

async function seedWorkerInDb(db, sfx) {
  const repo = path.join(os.tmpdir(), `loom-rghc-repo-${sfx}-${Date.now()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rghc\n");
  execSync(`git init -q && git config user.email rghc@loom && git config user.name rghc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  const P = `rghc-${sfx}`, workerId = `rghc-${sfx}-wkr`;
  const { worktreePath, branch } = await createWorktree(repo, P, `t-${sfx}`);
  worktrees.push([repo, worktreePath]);
  db.insertProject({ id: P, name: `RGHC-${sfx}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });
  return { workerId, worktreePath };
}

async function seedWorker(sfx) {
  const db = new Db();
  dbs.push(db);
  const { workerId, worktreePath } = await seedWorkerInDb(db, sfx);
  return { db, workerId, worktreePath };
}

try {
  // ── (A) RACY: the worktree changes AFTER admission — WHILE the gate is actually running ───────────
  {
    const { db, workerId, worktreePath } = await seedWorker("a");
    const fakeGate = async (_gate, wt) => {
      // The injected `runGate` IS what runs after admission (it replaces the real spawn in
      // runGateSequential's call site) — mutating here is mutating DURING the gate's own execution
      // window, i.e. strictly after `admitStamp` was already taken.
      fs.writeFileSync(path.join(wt, "late.txt"), "late work\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "late commit"`, { cwd: wt });
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fakeGate });

    const r = await sessions.runWorkerGate(workerId);
    check("(A) settles inline and passes", r.settled === true && r.ok === true && r.value.passed === true);
    check("(A) headCurrent is false — the tree moved while the gate was running", r.value.headCurrent === false);
    check("(A) headWarning is present", typeof r.value.headWarning === "string");
    check("(A) headWarning reads as the RACY shape (actively running / unverified)", /actively running/i.test(r.value.headWarning ?? "") && /UNVERIFIED/i.test(r.value.headWarning ?? ""));
    check("(A) headWarning does NOT use the benign/relabeled wording", !/STALE LABEL/i.test(r.value.headWarning ?? ""));
    const currentHead = execSync("git rev-parse HEAD", { cwd: worktreePath }).toString().trim();
    check("(A) validatedHead is the PRE-late-commit sha, not the branch's new HEAD", r.value.validatedHead !== currentHead);
  }

  // ── (B) RELABELED (benign) — "moved-during-queue-wait": the worktree changes AFTER fire but BEFORE
  //        admission. Forced by a blocker worker holding the ONE gate-semaphore slot (default cap 1) so
  //        the subject's own run genuinely queues, giving the test a real window to mutate the subject's
  //        worktree BEFORE the subject's own `fn` (and thus its `admitStamp`) ever runs. Mirrors the
  //        two-worker cap-1-queueing pattern worker-run-gate.mjs's own priority-wiring case (J) uses to
  //        force real queueing rather than faking it. ───────────────────────────────────────────────────
  {
    const db = new Db();
    dbs.push(db);
    const { workerId: blockerId } = await seedWorkerInDb(db, "b-blocker");
    const { workerId: subjectId, worktreePath: subjectWt } = await seedWorkerInDb(db, "b-subject");

    const startOrder = [];
    const fakeGate = async (_gate, wt) => {
      const label = wt === subjectWt ? "subject" : "blocker";
      startOrder.push(label);
      if (label === "blocker") await sleep(1200); // holds the only slot long enough to force a real queue
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fakeGate });

    const pBlocker = sessions.runWorkerGate(blockerId); // grabs the only slot first
    await sleep(150); // the blocker has genuinely acquired it before the subject ever calls in
    const pSubject = sessions.runWorkerGate(subjectId); // queues behind the blocker (subject's startStamp
    // is taken now, BEFORE it queues — clean tree, since nothing's been mutated yet)
    await sleep(150); // subject is now genuinely queued, waiting on admission

    // The mutation that would have landed "while the worker kept working during the queue wait" — this
    // happens BEFORE the subject's own `fn` (and its `admitStamp`) ever runs, since the blocker still
    // holds the only slot.
    fs.writeFileSync(path.join(subjectWt, "late.txt"), "late work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "late commit during queue wait"`, { cwd: subjectWt });

    const [rBlocker, rSubject] = await Promise.all([pBlocker, pSubject]);
    check("(B) setup: the blocker ran before the subject (proves the subject genuinely queued)", startOrder[0] === "blocker" && startOrder[1] === "subject");
    check("(B) both settle inline and pass", rBlocker.settled === true && rBlocker.ok === true && rSubject.settled === true && rSubject.ok === true && rSubject.value.passed === true);
    check("(B) headCurrent is false — the sha genuinely changed", rSubject.value.headCurrent === false);
    check("(B) headWarning is present", typeof rSubject.value.headWarning === "string");
    check("(B) headWarning reads as the RELABELED/benign shape (stale LABEL, likely covers current code)", /STALE LABEL/i.test(rSubject.value.headWarning ?? "") && /likely DOES cover/i.test(rSubject.value.headWarning ?? ""));
    check("(B) headWarning does NOT use the racy/unverified wording", !/UNVERIFIED/i.test(rSubject.value.headWarning ?? ""));
    const currentHead = execSync("git rev-parse HEAD", { cwd: subjectWt }).toString().trim();
    check("(B) validatedHead is the PRE-queue-wait sha, not the branch's new HEAD", rSubject.value.validatedHead !== currentHead);
  }

  // ── (C) UNCHANGED: nothing happens during the run — no warning, ever ───────────────────────────────
  {
    const { db, workerId } = await seedWorker("c");
    const fakeGate = async () => ({ passed: true });
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fakeGate });

    const r = await sessions.runWorkerGate(workerId);
    check("(C) settles inline and passes", r.settled === true && r.ok === true && r.value.passed === true);
    check("(C) headCurrent is true — nothing moved", r.value.headCurrent === true);
    check("(C) headWarning is absent on the common case", r.value.headWarning === undefined);
  }

  // ── (D) UNCHANGED-ON-FAILURE: the currency fields are populated on a FAILING settle too, not just a
  //        passing one — the card's DoD is "every settled result", pass or fail. ───────────────────────
  {
    const { db, workerId } = await seedWorker("d");
    const fakeGate = async (_gate, wt) => {
      fs.writeFileSync(path.join(wt, "late.txt"), "late work\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "late commit"`, { cwd: wt });
      return { passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL x" };
    };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fakeGate });

    const r = await sessions.runWorkerGate(workerId);
    check("(D) settles inline and fails", r.settled === true && r.ok === true && r.value.passed === false);
    check("(D) headCurrent is false on a FAILING settle too", r.value.headCurrent === false);
    check("(D) headWarning (RACY shape) is present on a FAILING settle too", /actively running/i.test(r.value.headWarning ?? ""));
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a settled run_gate result states plainly whether validatedHead is still the branch HEAD, distinguishing a RACY mid-run change (unverified) from a RELABELED queue-wait change (likely still covered) from the unchanged common case, on both pass and fail outcomes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
