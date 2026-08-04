import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// REUSE-A-GREEN-SELF-CHECK test (card e50600d2 — perf(orchestration): don't re-run the identical gate at
// merge when the worker's own `run_gate` self-check already validated the EXACT same merge input). REAL
// git on temp repos, an INJECTED `runGate` seam shared by BOTH `runWorkerGate` and `confirmWorkerMerge`
// (mirrors merge-gate-retry.mjs's in-process style) so a call COUNTER proves whether the gate command
// actually ran a second time, rather than trusting the return value alone.
//
// THE WASTE THIS CLOSES: `run_gate` (worker self-check) and `worker_merge_confirm` (merge gate) run the
// IDENTICAL gateCommand. When main hasn't moved and nothing changed since a green self-check, the second
// run tests a byte-identical tree — pure duplicate lane time.
//
// FAIL-CLOSED IS THE WHOLE DESIGN: this suite's center of gravity is the REFUSAL cases, not the happy
// path — an unprovable reuse must always fall back to running the gate, never to assuming.
//
// Proves:
//   (A) HAPPY PATH — a green, current self-check on an unmoved/clean/caught-up branch is REUSED: the
//       gate command is called exactly ONCE (by run_gate; confirmWorkerMerge calls it zero more times),
//       the merge succeeds, and the result records gateRan:false + reusedOpId === the self-check's opId.
//       The `build_gate` audit event also carries `reused:true` + the same `reusedOpId`.
//   (B) MOVED MAIN (after the self-check) — main advances past the branch's fork point AFTER a green
//       self-check: confirmWorkerMerge must call the gate command again (a real re-gate), and the result
//       records gateRan:true with no reusedOpId.
//   (C) STALE BASE (before the self-check even ran) — the branch was ALREADY behind main when the
//       self-check ran (a distinct temporal ordering from (B), same underlying guard: behindMain is
//       re-derived FRESH at confirm time, never assumed): still forces a real re-gate.
//   (D) RACY/"UNVERIFIED" SELF-CHECK — the self-check's OWN settle already flagged headCurrent:false (the
//       worktree changed WHILE that run was executing — the same shape run-gate-head-currency.mjs proves
//       elsewhere): never reused, even though nothing has changed since that settle.
//   (E) DIRTY WORKTREE — a real uncommitted edit lands AFTER a green, current self-check: never reused.
//   (F) A LATER FAILING SELF-CHECK SUPERSEDES AN EARLIER GREEN ONE — run_gate passes, then run_gate is
//       called again at the SAME commit and FAILS: confirmWorkerMerge must re-gate (the LATEST self-check
//       is what's on record, not the stale earlier green).
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-reuse.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgru-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=mgru@loom -c user.name=mgru";
const now = new Date().toISOString();

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);
// Card b798e706, Code Review fix (test (P) discrimination): true iff `ancestorSha` is reachable from
// `descendantRef` in `repo` — used to prove a specific commit actually landed IN a tree (e.g. the
// worktree, via the admission-time re-union merge), not just that SOME refusal/success shape occurred.
// `git merge-base --is-ancestor` exits 0/1 by design (never stderr text on a clean "false"), so a
// non-zero exit is read as `false` rather than an error.
const isAncestor = (repo, ancestorSha, descendantRef) => {
  try {
    execSync(`git merge-base --is-ancestor ${ancestorSha} ${descendantRef}`, { cwd: repo });
    return true;
  } catch {
    return false;
  }
};

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MGRU", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGRU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgru\n");
  execSync(`git init -q && git config user.email mgru@loom && git config user.name mgru && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mgru-${label}-proj-${sfx}`, agentId: `mgru-${label}-agent-${sfx}`, taskId: `mgru-${label}-task-${sfx}`,
  mgrId: `mgru-${label}-mgr-${sfx}`, workerId: `mgru-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgru-${label}-${sfx}`), file,
});

const dbs = [];
const worktrees = [];
try {
  // ── (A) HAPPY PATH — reuse ───────────────────────────────────────────────────────────────────────────
  {
    const A = mk("a", "feature-a.txt");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    seed(db, A, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(A.workerId);
    check("(A) precondition: self-check settled green", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);
    check("(A) precondition: gate called exactly once (the self-check)", calls === 1);

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) confirmWorkerMerge does NOT call the gate again", calls === 1);
    check("(A) merged:true", confirm.merged === true);
    check("(A) gateRan:false", confirm.gateRan === false);
    check("(A) reusedOpId === the self-check's own opId", confirm.reusedOpId === selfCheck.value.opId);
    // Card 3407caad, DoD-4 NEGATIVE CONTROL: a REUSED self-check never spawns a gate for the merge, so
    // gateProximity must be undefined here too — same "nothing to report" discipline as gateExtended.
    check("(A) gateProximity is undefined — REUSED, no gate spawned for this merge", confirm.gateProximity === undefined);
    const buildGate = eventsOfKind(db, A.mgrId, "build_gate")[0];
    check("(A) build_gate audit event carries reused:true + the same reusedOpId", buildGate?.detail?.reused === true && buildGate?.detail?.reusedOpId === selfCheck.value.opId);
    check("(A) task moved to done", db.getTask(A.taskId).columnKey === "done");
  }

  // ── (B) MOVED MAIN (after the self-check) — must re-gate ────────────────────────────────────────────
  {
    const B = mk("b", "feature-b.txt");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    seed(db, B, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(B.workerId);
    check("(B) precondition: self-check settled green", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);

    // Main advances AFTER the self-check ran — the branch's history now misses this commit.
    fs.writeFileSync(path.join(B.repo, "main-advance-b.txt"), "main moved forward\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main advance b"`, { cwd: B.repo });

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) confirmWorkerMerge re-ran the gate for real", calls === 2);
    check("(B) merged:true (the union-merge forwards cleanly, no conflict)", confirm.merged === true);
    check("(B) gateRan:true", confirm.gateRan === true);
    check("(B) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (C) STALE BASE (before the self-check even ran) — must re-gate ─────────────────────────────────
  {
    const C = mk("c", "feature-c.txt");
    makeRepo(C);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, C.file), "work for C\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    // Main advances BEFORE the self-check runs — the branch is stale from the outset.
    fs.writeFileSync(path.join(C.repo, "main-advance-c.txt"), "main moved forward first\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main advance c"`, { cwd: C.repo });
    seed(db, C, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(C.workerId);
    check("(C) precondition: self-check settled green despite the stale base", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) confirmWorkerMerge re-ran the gate for real", calls === 2);
    check("(C) merged:true (the union-merge forwards cleanly, no conflict)", confirm.merged === true);
    check("(C) gateRan:true", confirm.gateRan === true);
    check("(C) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (D) RACY / "UNVERIFIED" SELF-CHECK — must re-gate ───────────────────────────────────────────────
  {
    const D = mk("d", "feature-d.txt");
    makeRepo(D);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async (_gate, wt) => {
      calls++;
      if (calls === 1) {
        // Mutate the worktree WHILE the "gate" is running — the exact RACY shape run-gate-head-currency.mjs
        // proves elsewhere: the settle stamp diverges from the admit stamp, so this run settles
        // headCurrent:false ("treat this result as UNVERIFIED for your current code") even though nothing
        // moves again after this.
        fs.writeFileSync(path.join(wt, "late.txt"), "late work\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "late commit"`, { cwd: wt });
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, D.file), "work for D\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${D.file}"`, { cwd: worktreePath });
    seed(db, D, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(D.workerId);
    check("(D) precondition: self-check settled green but RACY (headCurrent:false)", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true && selfCheck.value.headCurrent === false);

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) confirmWorkerMerge re-ran the gate for real (a racy settle is never reused)", calls === 2);
    check("(D) merged:true", confirm.merged === true);
    check("(D) gateRan:true", confirm.gateRan === true);
    check("(D) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (E) DIRTY WORKTREE (a real uncommitted edit after a green, current self-check) — must re-gate ──
  {
    const E = mk("e", "feature-e.txt");
    makeRepo(E);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, E.file), "work for E\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${E.file}"`, { cwd: worktreePath });
    seed(db, E, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(E.workerId);
    check("(E) precondition: self-check settled green and current", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true && selfCheck.value.headCurrent === true);

    // A real uncommitted edit lands AFTER the self-check settled clean.
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "post-gate edit\n");

    const confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
    check("(E) confirmWorkerMerge re-ran the gate for real (a dirty worktree is never reused)", calls === 2);
    check("(E) gateRan:true", confirm.gateRan === true);
    check("(E) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (F) A LATER FAILING SELF-CHECK SUPERSEDES AN EARLIER GREEN ONE — must re-gate ──────────────────
  {
    const F = mk("f", "feature-f.txt");
    makeRepo(F);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 2) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "flaked" };
      return { passed: true };
    };
    // gateOpRetainMs:0 (mirrors gate-timeout-circuit-breaker.mjs): disables run_gate's own settle-grace
    // retention window, so these two BACK-TO-BACK run_gate calls each trigger a genuinely fresh
    // invocation instead of the second being served the first's cached (green) result.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0 });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, F.file), "work for F\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${F.file}"`, { cwd: worktreePath });
    seed(db, F, "pnpm gate");

    const first = await sessions.runWorkerGate(F.workerId);
    check("(F) precondition: FIRST self-check settled green", first.settled === true && first.ok === true && first.value.passed === true);
    const second = await sessions.runWorkerGate(F.workerId);
    check("(F) precondition: SECOND self-check (same commit) settled FAILED", second.settled === true && second.ok === true && second.value.passed === false);

    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) confirmWorkerMerge re-ran the gate for real (latest record is the failing one, not the stale green)", calls === 3);
    check("(F) merged:true (the third call, back to passing, is what's on record)", confirm.merged === true);
    check("(F) gateRan:true", confirm.gateRan === true);
    check("(F) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (G) A NEW COMMIT on the branch itself after the self-check — must re-gate (never match on a newer
  //        sha than the one the self-check actually validated) ───────────────────────────────────────────
  {
    const G = mk("g", "feature-g.txt");
    makeRepo(G);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = worktreePath; G.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, G.file), "work for G\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${G.file}"`, { cwd: worktreePath });
    seed(db, G, "pnpm gate");

    const selfCheck = await sessions.runWorkerGate(G.workerId);
    check("(G) precondition: self-check settled green at commit A", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);
    const shaA = selfCheck.value.validatedHead;

    // A NEW commit (B) lands on the branch itself AFTER the self-check validated A — main is untouched.
    fs.writeFileSync(path.join(worktreePath, "second-commit.txt"), "commit B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "second commit B"`, { cwd: worktreePath });
    const shaB = execSync("git rev-parse HEAD", { cwd: worktreePath }).toString().trim();
    check("(G) precondition: the branch really did advance past what was validated", shaB !== shaA);

    const confirm = await sessions.confirmWorkerMerge(G.mgrId, G.workerId);
    check("(G) confirmWorkerMerge re-ran the gate for real (validatedHead A can never match commit B)", calls === 2);
    check("(G) gateRan:true", confirm.gateRan === true);
    check("(G) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (H) SIMULATED DAEMON RESTART — the in-memory self-check record is process-local; a fresh
  //        SessionService (a new process, sharing the same on-disk db) has never seen it, so a merge right
  //        after a restart falls back to gating cleanly — no crash, no `undefined` treated as a match ────
  {
    const H = mk("h", "feature-h.txt");
    makeRepo(H);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const preRestart = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    H.worktreePath = worktreePath; H.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, H.file), "work for H\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${H.file}"`, { cwd: worktreePath });
    seed(db, H, "pnpm gate");

    const selfCheck = await preRestart.runWorkerGate(H.workerId);
    check("(H) precondition: self-check settled green on the PRE-restart instance", selfCheck.settled === true && selfCheck.ok === true && selfCheck.value.passed === true);

    // A fresh SessionService — its lastWorkerGateCheck map starts empty, exactly like a real
    // daemon_restart's new process — sharing the SAME db (the on-disk state a restart actually preserves).
    const postRestart = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const confirm = await postRestart.confirmWorkerMerge(H.mgrId, H.workerId);
    check("(H) confirmWorkerMerge on the post-restart instance ran the gate for real (no crash, no phantom reuse)", calls === 2);
    check("(H) merged:true", confirm.merged === true);
    check("(H) gateRan:true", confirm.gateRan === true);
    check("(H) reusedOpId is absent", confirm.reusedOpId === undefined);
  }

  // ── (I) THE TOCTOU GUARD ITSELF — mergeBranch's own in-lock re-verification (CR follow-up) ───────────
  // Directly exercises the mechanism that closes the race the manager flagged: reuse is decided BEFORE
  // mergeBranch's own canonical-index lock is even requested, so a SIBLING merge on this same repo could
  // land in between. `requireCanonicalHead` is what confirmWorkerMerge threads through so mergeBranch can
  // catch that INSIDE its own lock, before touching anything, rather than trusting a stale premise.
  {
    const I = mk("i", "feature-i.txt");
    makeRepo(I);
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(I.repo, I.projId, I.taskId);
    I.worktreePath = worktreePath; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, I.file), "work for I\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${I.file}"`, { cwd: worktreePath });
    const realMainHead = execSync("git rev-parse HEAD", { cwd: I.repo }).toString().trim();

    // A STALE (wrong) requireCanonicalHead — simulating "main advanced after the reuse decision was made".
    const staleResult = await mergeBranch(I.repo, branch, "MGRU-I stale", {}, "0000000000000000000000000000000000000000");
    check("(I) a stale requireCanonicalHead is REFUSED, not silently honored", staleResult.ok === false && staleResult.gateBaseInvalidated === true);
    check("(I) the refusal reads as a benign race, not a real merge failure", /benign race|advanced/i.test(staleResult.reason ?? ""));
    const headAfterStale = execSync("git rev-parse HEAD", { cwd: I.repo }).toString().trim();
    check("(I) canonical repo HEAD is COMPLETELY untouched by the refused attempt", headAfterStale === realMainHead);
    const stagedAfterStale = execSync("git diff --cached --name-only", { cwd: I.repo }).toString().trim();
    check("(I) canonical repo index carries NO residue from the refused attempt", stagedAfterStale === "");

    // The MATCHING (current) head is honored normally — the check doesn't block a genuinely valid reuse.
    const okResult = await mergeBranch(I.repo, branch, "MGRU-I ok", {}, realMainHead);
    check("(I) a CURRENT requireCanonicalHead proceeds normally (merged, not refused)", okResult.ok === true && okResult.gateBaseInvalidated === undefined);
  }

  // ── (J) MAIN ADVANCES DURING A REAL (non-reused) GATE'S OWN RUN — card eda70da6. Unlike (B)/(C)/(D)/(E),
  //        where main only ever moves BEFORE the real gate starts (so the union-merge already folds the
  //        move in before the gate runs), here main advances INSIDE the fake gate call itself — i.e.
  //        strictly AFTER the gate is admitted and BEFORE it settles. This is a SUBSET of the full window
  //        the fix closes (`gateBaseMainHead` is captured earlier still, at the union-merge — see (K) for
  //        the part of the window this test can't distinguish: a move during the QUEUE WAIT between the
  //        union-merge and admission, which an admission-time capture would have missed). No self-check is
  //        ever recorded for this worker (mirrors (H)'s post-restart shape), so this is unambiguously the
  //        REAL gate-run path, not the reuse path (card e50600d2) already covered by (I). The squash must
  //        refuse — a benign, retryable race, zero side effects — rather than silently landing on a tree
  //        the gate never actually validated. The retry (main now holding still) then proves the paired
  //        unchanged-main-proceeds case using the SAME real-gate-run path.
  {
    const J = mk("j", "feature-j.txt");
    makeRepo(J);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // Main advances WHILE this FIRST gate "run" is in flight — after admission, before settle.
        // Simulates a human REST commit (or, on a peer project, a sibling merge) landing mid-gate.
        fs.writeFileSync(path.join(J.repo, "main-advance-during-gate.txt"), "main moved during the gate\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during gate"`, { cwd: J.repo });
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(J.repo, J.projId, J.taskId);
    J.worktreePath = worktreePath; J.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, J.file), "work for J\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${J.file}"`, { cwd: worktreePath });
    seed(db, J, "pnpm gate");

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: J.repo }).toString().trim();
    const confirm = await sessions.confirmWorkerMerge(J.mgrId, J.workerId);
    check("(J) the gate ran for real (no self-check on record)", calls === 1);
    check("(J) gateRan:true (a real run, not the reuse-path refusal (I) already covers)", confirm.gateRan === true);
    check("(J) confirmWorkerMerge REFUSES rather than landing on the un-gated tree", confirm.merged === false);
    check("(J) the refusal reads as a benign, retryable race, not a real merge/gate failure", /benign race|advanced/i.test(confirm.reason ?? ""));
    const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: J.repo }).toString().trim();
    check("(J) canonical repo gained ONLY the mid-gate commit — no squash landed on top of it (zero side effects)", commitsAheadOfBaseline === "1");
    const stagedAfterRefusal = execSync("git diff --cached --name-only", { cwd: J.repo }).toString().trim();
    check("(J) canonical repo index carries no residue from the refused attempt", stagedAfterRefusal === "");
    check("(J) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);

    // RETRY: main holds still through this second real gate run — re-confirming re-derives everything
    // fresh and actually lands, proving the refusal above was retryable, not a dead end.
    const retry = await sessions.confirmWorkerMerge(J.mgrId, J.workerId);
    check("(J) a retry re-confirm succeeds once main stops moving mid-gate", retry.merged === true);
    check("(J) task moved to done on the retry", db.getTask(J.taskId).columnKey === "done");
  }

  // ── (K) MAIN ADVANCES DURING THE SEMAPHORE QUEUE WAIT (between the union-merge and gate admission) —
  //        card eda70da6, updated by card b798e706. THIS is the case that discriminates "capture only at
  //        the union-merge, frozen for the whole queue wait" (the OLD behavior — always self-aborts) from
  //        "re-derive at admission" (the fix): (J) moves main strictly AFTER admission, where both
  //        behave identically (nothing separates union-merge from admission when nothing else holds the
  //        gate semaphore). Here, an external holder occupies the ONE gate slot (default
  //        `maxConcurrentGates` is 1 — see gate-semaphore-concurrency.mjs's own (A)), so
  //        confirmWorkerMerge's real gate request genuinely QUEUES after its union-merge already ran and
  //        captured `gateBaseMainHead`. Main advances WHILE queued (before admission), then the holder
  //        releases and the queued gate is admitted. Before card b798e706, an admission-time capture would
  //        have read the ALREADY-advanced main and wrongly MATCHED it at squash time (the exact defect the
  //        eda70da6 CR caught — capturing only once, at admission, silently skips validating the tree
  //        against what the gate actually ran against); the fix is narrower than that rejected first
  //        draft — it doesn't move the CAPTURE to admission, it RE-DERIVES the already-correct
  //        union-merge-time capture at admission, by re-unioning against the fresh tip when it moved and
  //        re-testing THAT tree — so admission now sees the true CURRENT main and lands on the first pass
  //        instead of self-aborting every time.
  //
  //        ⚠️ Code Review correction: this block proves "main advanced during the queue wait for a reason
  //        OTHER than a same-repo sibling's own squash" (the holder above is a GENERIC lane occupant, not
  //        a second real merge) — it is NOT a proof that a queued SAME-REPO SIBLING merge lands on its
  //        first pass. `GateSemaphore.release()` frees the per-repo admission guard the moment a running
  //        merge's GATE settles, strictly BEFORE that merge's own squash (called outside `runExclusive`,
  //        afterward) — so in the REAL same-repo-sibling case, this op is typically admitted BEFORE the
  //        sibling has squashed, re-derives to a no-op against an unmoved main, and can still self-abort
  //        once the sibling's squash lands mid-gate-run. A direct commit under test control (below) and a
  //        real sibling's own squash landing are NOT mechanically equivalent from this code's point of
  //        view, despite both being "canonical HEAD advances" — the FORMER is complete before this op's
  //        admission (what this block tests, and what the fix genuinely closes); the LATTER typically
  //        isn't (what remains open, carded as `c24dd48a`). See `gate-semaphore.ts`'s
  //        `GateDescriptor.repoPath` doc for the full mechanism.
  {
    const K = mk("k", "feature-k.txt");
    makeRepo(K);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    // reapWorktreeProcesses STUBBED (CR follow-up): the pre-gate reap this test would otherwise exercise
    // for real (reapProcessesRootedInWorktree, unstubbed elsewhere in this file) does a live process
    // enumeration (WMI on Windows) with its OWN default 10s timeout (pty/host.ts) — one enumeration
    // hitting that bound could consume this test's ENTIRE queue-wait deadline below, throwing past the
    // file's try/finally and silently skipping every test appended after (K). Stubbing it out removes
    // that flake surface entirely rather than just outracing it; every OTHER step here is a handful of
    // fast local git spawns.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });
    const { worktreePath, branch } = await createWorktree(K.repo, K.projId, K.taskId);
    K.worktreePath = worktreePath; K.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, K.file), "work for K\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${K.file}"`, { cwd: worktreePath });
    seed(db, K, "pnpm gate");

    // Seize the ONE gate slot directly on the SAME semaphore confirmWorkerMerge itself uses, via an
    // unrelated descriptor — simulating a sibling gate (or, on this project's own self-hosting setup, any
    // other daemon-executed heavy gate) already holding the lane when this confirm's own gate request
    // arrives. Held open until `releaseHolder()` is called below.
    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mgru-k-holder-proj", sessionId: "mgru-k-holder-sess" }, () => holderPromise,
    );

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: K.repo }).toString().trim();
    const confirmPromise = sessions.confirmWorkerMerge(K.mgrId, K.workerId);

    // Wait until confirmWorkerMerge's OWN gate request is genuinely QUEUED behind the holder — i.e. its
    // union-merge (and therefore its `gateBaseMainHead` capture) has already completed. Deterministic
    // (polls live semaphore state), not a timed guess. Bounded so a real regression fails fast instead of
    // hanging forever — but this bound is now a generous SAFETY MARGIN, not a race against a known 10s
    // ceiling (reap is stubbed above), so 20s costs nothing on the pass path and still can't take down
    // the rest of the file: the precondition failure is reported as a `check()`, and the block returns
    // early (skipping the state-dependent assertions below, which would be meaningless without it)
    // instead of throwing past this file's try/finally.
    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(K) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);
    if (!queued) {
      // Precondition unmet — release the holder so nothing is left dangling, let the still-pending
      // confirm settle on its own, and bail out of this block WITHOUT asserting on its (now
      // indeterminate) outcome. Reported as a failed check above, not a thrown exception.
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // Main advances WHILE genuinely queued — strictly BETWEEN the union-merge (already ran, captured)
      // and this confirm's own gate ever being admitted. A direct commit, deterministic and complete
      // BEFORE this op's own admission — see the block header above for why this is deliberately NOT a
      // stand-in for a same-repo sibling's own squash (which typically lands AFTER this op is admitted,
      // not before), and for what this block does and does not prove.
      fs.writeFileSync(path.join(K.repo, "main-advance-during-queue.txt"), "main moved during the queue wait\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during queue wait"`, { cwd: K.repo });

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(K) the queued gate ran for real once admitted", calls === 1);
      check("(K) gateRan:true", confirm.gateRan === true);
      // DoD-2(i): no gateBaseInvalidated, no manager re-confirm — lands on the FIRST pass despite main
      // having moved during the queue wait, because admission re-derives (re-unions) against the fresh
      // tip before the gate ever runs.
      check("(K) confirmWorkerMerge LANDS on the first pass — admission re-derives against the moved main", confirm.merged === true);
      check("(K) no gateBaseInvalidated — the base was fresh BY THE TIME the gate ran, not stale", confirm.reason === undefined);
      const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: K.repo }).toString().trim();
      // 2 = the queue-wait commit + the squash commit this confirm itself lands on top of it.
      check("(K) canonical repo gained the queue-wait commit AND the squash — first-pass landing, no wasted second gate run", commitsAheadOfBaseline === "2");
      const stagedAfterLanding = execSync("git diff --cached --name-only", { cwd: K.repo }).toString().trim();
      check("(K) canonical repo index carries no residue after a clean landing", stagedAfterLanding === "");
      check("(K) task moved to done on the first pass", db.getTask(K.taskId).columnKey === "done");
      check("(K) worktree removed after a successful merge (no retry needed)", fs.existsSync(worktreePath) === false);
    }
  }
  // ── (L) THE MOVED-MAIN-BETWEEN-THE-TWO-READS CASE — card 24cc40f9. The reuse path used to prove its
  //        behind-main premise with one git read (`countCommitsBehind(repoPath, branch, "HEAD")`) and
  //        capture its gate-base sha with a SEPARATE one (`resolveGitRef(repoPath, "HEAD")`): if main
  //        advanced between those two independent spawns, the proof referred to the OLD sha while the
  //        captured `gateBaseMainHead` held the NEW one — and the in-lock re-check at squash time, which
  //        compares against the NEW sha, would then WRONGLY MATCH, landing a squash the self-check never
  //        actually validated. The fix reads HEAD ONCE and threads that SAME sha into `countCommitsBehind`
  //        as its explicit `base`, so the two are pinned to one commit by construction. This exercises the
  //        actual production primitives in the actual production order (resolveGitRef → countCommitsBehind
  //        with that captured sha as base → mergeBranch's requireCanonicalHead) — no new test seam needed,
  //        since the fix already removes the vulnerable window rather than hiding it behind timing.
  {
    const L = mk("l", "feature-l.txt");
    makeRepo(L);
    const { resolveGitRef, countCommitsBehind, mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(L.repo, L.projId, L.taskId);
    L.worktreePath = worktreePath; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, L.file), "work for L\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${L.file}"`, { cwd: worktreePath });
    const mainHeadAtCapture = execSync("git rev-parse HEAD", { cwd: L.repo }).toString().trim();

    // The reuse path's own sequence: capture HEAD ONCE...
    const freshHead = await resolveGitRef(L.repo, "HEAD");
    check("(L) precondition: the single captured HEAD is main's real current tip", freshHead === mainHeadAtCapture);

    // ...then main advances — the EXACT window the old two-separate-reads code was vulnerable to (a
    // GitWriter REST commit/checkout can land at any time; it does not serialize on withCanonicalIndexLock).
    fs.writeFileSync(path.join(L.repo, "main-advance-l.txt"), "main moved after the single capture\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main advance l"`, { cwd: L.repo });
    const mainHeadAfterAdvance = execSync("git rev-parse HEAD", { cwd: L.repo }).toString().trim();
    check("(L) precondition: main genuinely advanced past the captured sha", mainHeadAfterAdvance !== freshHead);

    // ...then `countCommitsBehind` is called with the FROZEN captured sha as `base` (never a live "HEAD"
    // re-read) — its answer is pinned to the pre-advance commit regardless of main having since moved.
    const freshBehindMain = await countCommitsBehind(L.repo, branch, freshHead);
    check("(L) countCommitsBehind against the FROZEN captured sha is unaffected by the main advance", freshBehindMain === 0);

    // The reuse decision threads this SAME frozen `freshHead` into mergeBranch as `gateBaseMainHead` —
    // exercise that directly: since main has since moved, the in-lock TOCTOU re-check must REFUSE rather
    // than match (the old bug's failure mode: a freshly re-read HEAD at capture time would have equalled
    // main's now-current tip and WRONGLY matched here, landing a squash the behind-main proof never
    // actually verified).
    const result = await mergeBranch(L.repo, branch, "MGRU-L", {}, freshHead);
    check("(L) mergeBranch's in-lock check REFUSES the stale frozen head — no incorrect match", result.ok === false && result.gateBaseInvalidated === true);
    const headAfterRefusal = execSync("git rev-parse HEAD", { cwd: L.repo }).toString().trim();
    check("(L) canonical repo HEAD untouched by the refused attempt", headAfterRefusal === mainHeadAfterAdvance);

    // And the paired positive: the SAME frozen-head pattern proceeds normally once threaded with a head
    // that DOES match main's actual current tip — proving the refusal above is specifically about the
    // moved-main case, not a general brokenness of the mechanism.
    const okResult = await mergeBranch(L.repo, branch, "MGRU-L ok", {}, mainHeadAfterAdvance);
    check("(L) the same pattern proceeds normally once the captured head matches main's actual current tip", okResult.ok === true);
  }
  // ── (M) ALREADY-LANDED (preLanded) BRANCH GAINS NEW COMMITS DURING THE GATE — card b0ab78d6. The
  //        union-merge is deliberately SKIPPED once a branch's squash already landed on main (`preLanded`,
  //        to protect ALREADY_MERGED re-confirm classification — see confirmWorkerMerge's own doc), so
  //        BEFORE this fix `gateBaseMainHead` was never captured on this path even though a REAL gate still
  //        runs. If the worktree's branch gains a genuinely new commit WHILE that gate is in flight (a
  //        redirected/still-active worker keeps committing before being told to stand down — the worker's
  //        pty is not stopped until AFTER this method returns), the squash re-derives fresh at squash time
  //        and stages that new commit's diff — content no gate ever validated together with main. Pre-fix,
  //        with `gateBaseMainHead` left `undefined`, mergeBranch's in-lock re-check was skipped entirely and
  //        this landed SILENTLY even with main having ALSO advanced in the same window — exactly eda70da6's
  //        DoD prohibition, on the one path its fix didn't reach. Post-fix, the preLanded branch captures
  //        canonical HEAD at the same point the union-merge would have run, so the SAME in-lock
  //        `requireCanonicalHead` re-check now fires here too and refuses instead of silently squashing.
  {
    const M = mk("m", "feature-m.txt");
    makeRepo(M);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(M.repo, M.projId, M.taskId);
    M.worktreePath = worktreePath; M.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, M.file), "work for M\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${M.file}"`, { cwd: worktreePath });

    // Precondition: this branch's squash already landed on main — worktree deliberately retained (a
    // stale/racing confirm, or a manager holding it open for follow-up work), mirroring merge-union-gate.mjs
    // scenario (D)'s own setup.
    const landed = await mergeBranch(M.repo, branch, "MGRU-M initial land");
    check("(M) precondition: branch's initial work already landed in main", landed.ok === true);

    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // Simulates the worktree SURVIVING the earlier land and gaining a genuinely new commit WHILE the
        // gate is in flight — the "not merely theoretical" case the card names.
        fs.writeFileSync(path.join(worktreePath, "m-followup.txt"), "new work after the earlier land\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "m followup during gate"`, { cwd: worktreePath });
        // Main ALSO advances in the same window (a sibling merge, or a human REST commit) — the concrete
        // race `gateBaseMainHead` exists to catch.
        fs.writeFileSync(path.join(M.repo, "main-advance-during-gate-m.txt"), "main moved during the gate\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during gate m"`, { cwd: M.repo });
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, M, "pnpm gate");

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: M.repo }).toString().trim();
    const confirm = await sessions.confirmWorkerMerge(M.mgrId, M.workerId);
    check("(M) the gate ran for real (a real gate on the preLanded path, not the reuse path)", calls === 1);
    check("(M) gateRan:true", confirm.gateRan === true);
    check("(M) confirmWorkerMerge REFUSES rather than silently squashing the new commit onto an advanced main", confirm.merged === false);
    check("(M) the refusal reads as a benign, retryable race, not a real merge/gate failure", /benign race|advanced/i.test(confirm.reason ?? ""));
    const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: M.repo }).toString().trim();
    check("(M) canonical repo gained ONLY the mid-gate advance commit — no squash landed on top of it (zero side effects)", commitsAheadOfBaseline === "1");
    const stagedAfterRefusal = execSync("git diff --cached --name-only", { cwd: M.repo }).toString().trim();
    check("(M) canonical repo index carries no residue from the refused attempt", stagedAfterRefusal === "");
    check("(M) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);

    // RETRY: main holds still through this second real gate run — re-confirming re-derives everything
    // fresh (the branch is no longer a pure preLanded duplicate, so this retry takes the ordinary
    // union-merge path) and actually lands the follow-up commit. Guarded on the refusal actually having
    // happened (worktree still present): on a regression (the first confirm silently merged instead of
    // refusing) the worktree is ALREADY torn down by finalizeMerge, and a retry against a gone worktree
    // would throw a raw GitConstructError, masking the real failure with an unrelated crash — the checks
    // above already recorded that regression, so just skip the retry rather than compounding it.
    if (confirm.merged === false && fs.existsSync(worktreePath)) {
      const retry = await sessions.confirmWorkerMerge(M.mgrId, M.workerId);
      check("(M) a retry re-confirm succeeds once main stops moving mid-gate", retry.merged === true);
      check("(M) task moved to done on the retry", db.getTask(M.taskId).columnKey === "done");
    } else {
      check("(M) retry skipped — the first confirm did not refuse as expected, so there is no clean retry to prove", false);
    }
  }
  // ── (N) ALREADY-LANDED (preLanded) PURE RE-CONFIRM STAYS IDEMPOTENT WHEN ONLY MAIN MOVES — card
  //        b0ab78d6, regression found and closed before merge. (M) above and this scenario are a
  //        DISCRIMINATING PAIR, not two independent tests: (M) proves the fix still refuses when the
  //        branch itself gains new content during the gate; (N) proves it does NOT refuse when the branch
  //        is a TRUE pure duplicate and only main moves elsewhere. Only together do they prove the new
  //        `gateBaseBranchHead` branch-stability check can actually tell the two cases apart — (N) alone
  //        would not catch a fix that simply stopped enforcing `requireCanonicalHead` altogether on this
  //        path (which would also make (N) pass, while quietly breaking (M)). Identical setup to (M) EXCEPT
  //        the worktree/branch gains NOTHING new during the gate — this is the COMMON case on the preLanded
  //        path (a stale/racing re-confirm, see the early-idempotency doc in worktrees.ts), and was
  //        idempotent (`ALREADY_MERGED`, `merged:true`) before `gateBaseMainHead` existed on this path at
  //        all. A bare `gateBaseMainHead` capture (no branch-stability discriminator) regresses this into a
  //        refusal purely because main moved elsewhere — routine on an active fleet, and harmless here since
  //        nothing from this branch is landing either way.
  {
    const N = mk("n", "feature-n.txt");
    makeRepo(N);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId);
    N.worktreePath = worktreePath; N.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, N.file), "work for N\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${N.file}"`, { cwd: worktreePath });

    const landed = await mergeBranch(N.repo, branch, "MGRU-N initial land");
    check("(N) precondition: branch's initial work already landed in main", landed.ok === true);

    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // Main advances mid-gate — UNRELATED to this branch (a sibling merge, a human REST commit).
        // Nothing whatsoever is added to the worktree/branch — the discriminator this scenario exists to
        // prove: a TRUE pure duplicate must stay idempotent regardless of what main does elsewhere.
        fs.writeFileSync(path.join(N.repo, "unrelated-main-advance-n.txt"), "some other merge landed\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "unrelated main advance n"`, { cwd: N.repo });
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, N, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
    // `calls === 1` is this scenario's own proof that a real gate ran (not the reuse path) — unlike (M)'s
    // refusal, the ALREADY_MERGED success path returns via `finishAlreadyMerged`, whose result never
    // carries `gateRan` at all (confirmed: merge-union-gate.mjs scenario D doesn't assert it either), so
    // there is no `confirm.gateRan` field to check here.
    check("(N) the gate ran for real (a real gate on the preLanded path, not the reuse path)", calls === 1);
    check("(N) confirmWorkerMerge STAYS IDEMPOTENT — merged:true despite main moving mid-gate", confirm.merged === true);
    check("(N) emptyKind === 'ALREADY_MERGED' (a benign no-op, not a gateBaseInvalidated refusal)", confirm.emptyKind === "ALREADY_MERGED");
    check("(N) task moved to done", db.getTask(N.taskId).columnKey === "done");
    check("(N) worktree removed (idempotent cleanup completed, not left retained by a false refusal)", !fs.existsSync(worktreePath));
  }

  // ── (O) ADMISSION-TIME RE-UNION CONFLICT — card b798e706 DoD-3. Main advances WHILE genuinely queued
  //        (same precondition as (K)), but this time with a change that CONFLICTS with the worktree's own
  //        work (both sides modify README.md's one line differently from their common base). The
  //        admission-time re-union (K's happy path) must instead hit a REAL git conflict here — proving
  //        the outcome is a defined, observable rejection (`union_conflict_at_admission`), never a silent
  //        vanish and never a silent proceed on the stale (pre-conflict) base.
  {
    const O = mk("o", "feature-o.txt");
    makeRepo(O);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });
    const { worktreePath, branch } = await createWorktree(O.repo, O.projId, O.taskId);
    O.worktreePath = worktreePath; O.branch = branch; worktrees.push(worktreePath);
    // Worker's own change modifies README.md's ONE line (not just adds a new file) — the same line the
    // conflicting main advance below will ALSO modify, differently, from the same base ("# mgru\n").
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# mgru WORKER\n");
    fs.writeFileSync(path.join(worktreePath, O.file), "work for O\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${O.file} + conflicting readme edit"`, { cwd: worktreePath });
    seed(db, O, "pnpm gate");

    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mgru-o-holder-proj", sessionId: "mgru-o-holder-sess" }, () => holderPromise,
    );

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: O.repo }).toString().trim();
    const confirmPromise = sessions.confirmWorkerMerge(O.mgrId, O.workerId);

    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(O) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);
    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // Main advances WHILE queued, with a CONFLICTING edit to the same line the worker's own branch
      // already changed — the base line was "# mgru\n"; both sides now diverge from it differently.
      fs.writeFileSync(path.join(O.repo, "README.md"), "# mgru MAIN\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during queue (conflicting)"`, { cwd: O.repo });

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(O) the gate NEVER ran — the admission-time re-union conflict throws before the gate spawns", calls === 0);
      check("(O) confirmWorkerMerge REJECTS — a defined, observable outcome, never silent", confirm.merged === false);
      check("(O) the rejection names the conflict, not a generic error", /conflict/i.test(confirm.reason ?? ""));
      const rejected = eventsOfKind(db, O.mgrId, "merge_rejected").at(-1);
      check("(O) merge_rejected event recorded with reason union_conflict_at_admission", rejected?.detail?.reason === "union_conflict_at_admission");
      const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: O.repo }).toString().trim();
      check("(O) canonical repo gained ONLY the queue-wait commit — no squash ever attempted (zero side effects)", commitsAheadOfBaseline === "1");
      const stagedAfterRejection = execSync("git diff --cached --name-only", { cwd: O.repo }).toString().trim();
      check("(O) canonical repo index carries no residue from the rejected attempt", stagedAfterRejection === "");
      check("(O) worktree retained so the manager can resolve the conflict (not silently vanished)", fs.existsSync(worktreePath) === true);
    }
  }

  // ── (P) THE FAIL-CLOSED GUARD STILL FIRES AFTER A SUCCESSFUL ADMISSION-TIME RE-UNION — card b798e706
  //        DoD-4. A main advance that admission's re-union CAN absorb (the queue-wait movement, exactly
  //        like (K)) is followed by a SECOND, later main advance DURING the gate's own execution — a
  //        movement the re-derivation (which only runs ONCE, right before the gate spawns) cannot see
  //        coming and does not re-absorb. `requireCanonicalHead`'s in-lock re-check at squash time must
  //        still catch THIS window fail-closed, exactly as it always has (mirrors (J)/(M)) — proving this
  //        card's fix narrows the stale-base window rather than deleting the guard that protects it.
  {
    const P = mk("p", "feature-p.txt");
    makeRepo(P);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) {
        // SECOND main advance — DURING the gate's own execution, well after admission's re-union already
        // ran and re-derived `gateBaseMainHead` against the FIRST (queue-wait) advance. Gated to the FIRST
        // call only: the RETRY confirm below calls this fake gate again, and it must behave like a normal
        // green gate on that second call, not repeat a now-no-op write+commit (which would throw on
        // "nothing to commit").
        fs.writeFileSync(path.join(P.repo, "main-advance-during-gate-p.txt"), "a second, later main advance\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during gate (p)"`, { cwd: P.repo });
      }
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, P.file), "work for P\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${P.file}"`, { cwd: worktreePath });
    seed(db, P, "pnpm gate");

    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: "mgru-p-holder-proj", sessionId: "mgru-p-holder-sess" }, () => holderPromise,
    );

    const mainHeadBeforeConfirm = execSync("git rev-parse HEAD", { cwd: P.repo }).toString().trim();
    const confirmPromise = sessions.confirmWorkerMerge(P.mgrId, P.workerId);

    const queueDeadline = Date.now() + 20_000;
    let queued = false;
    while (Date.now() <= queueDeadline) {
      if (sessions.gateSemaphore.snapshot().queued >= 1) { queued = true; break; }
      await sleep(5);
    }
    check("(P) precondition: confirmWorkerMerge's gate request is genuinely queued (union-merge already ran)", queued);
    if (!queued) {
      releaseHolder();
      await Promise.allSettled([holderRun, confirmPromise]);
    } else {
      // FIRST main advance — WHILE queued, absorbed cleanly by admission's re-union (exactly (K)'s case).
      fs.writeFileSync(path.join(P.repo, "main-advance-during-queue-p.txt"), "the absorbable queue-wait advance\n");
      execSync(`git add . && git ${GIT_ID} commit -q -m "main advance during queue (p)"`, { cwd: P.repo });
      const queueWaitSha = execSync("git rev-parse HEAD", { cwd: P.repo }).toString().trim();

      releaseHolder();
      await holderRun;
      const confirm = await confirmPromise;

      check("(P) the gate ran for real once admitted (the first advance was absorbed, not refused here)", calls === 1);
      check("(P) gateRan:true", confirm.gateRan === true);
      check("(P) confirmWorkerMerge STILL REFUSES — the SECOND advance (during the gate) is not re-absorbed", confirm.merged === false);
      check("(P) the refusal reads as a benign, retryable race, not a real merge/gate failure", /benign race|advanced/i.test(confirm.reason ?? ""));
      const commitsAheadOfBaseline = execSync(`git rev-list --count ${mainHeadBeforeConfirm}..HEAD`, { cwd: P.repo }).toString().trim();
      // 2 = the absorbed queue-wait commit + the during-gate commit — no squash landed on top of either.
      check("(P) canonical repo gained BOTH main advances — no squash landed (zero side effects)", commitsAheadOfBaseline === "2");
      const stagedAfterRefusal = execSync("git diff --cached --name-only", { cwd: P.repo }).toString().trim();
      check("(P) canonical repo index carries no residue from the refused attempt", stagedAfterRefusal === "");
      check("(P) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);

      // DISCRIMINATION (Code Review finding, card b798e706): every check above is ALSO satisfied by
      // PRE-FIX code — pre-fix, this op would have refused on the FIRST advance already (no admission-time
      // re-union at all), landing on the identical `merged:false`/2-commits-ahead/no-residue/retained
      // shape by a totally different mechanism. None of that proves the re-union actually ran. This one
      // does: the queue-wait commit only reaches the WORKTREE (a real `git merge` write, not the canonical
      // repo mergeMainIntoWorktree never touches) if `reunionAtAdmission` genuinely re-unioned against it —
      // pre-fix code never runs that merge at all, so this specific commit could never become an ancestor
      // of the worktree's own HEAD. RED-verified against pre-fix code (git stash of this card's src/ diff,
      // rebuild, re-run — same method as card 171297dc's sibling fix): fails exactly this check, all
      // others upstream of it still pass.
      check("(P) the admission-time re-union GENUINELY RAN — the queue-wait commit landed in the worktree (not just refused for some other reason)",
        isAncestor(worktreePath, queueWaitSha, "HEAD"));

      // RETRY: main holds still through this second attempt — re-confirming re-derives everything fresh
      // (a new union-merge, a new gateBaseMainHead) and actually lands, proving the fail-closed refusal
      // above was retryable, not a dead end.
      const retry = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
      check("(P) a retry re-confirm succeeds once main stops moving mid-gate", retry.merged === true);
      check("(P) task moved to done on the retry", db.getTask(P.taskId).columnKey === "done");
    }
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge whose inputs are provably identical to a green, current self-check skips the redundant gate run (gateRan:false + reusedOpId), while a moved main, a stale base, a racy/UNVERIFIED settle, a dirty worktree, or a superseding later failure ALL still force a real re-gate (gateRan:true, no reusedOpId)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
