import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// INERT-DIFF GATE SKIP test (card db9b0130 — owner-proposed: "running the full merge gate for a merge
// that only contains docs is not needed"). REAL git on temp repos, an INJECTED `runGate` seam (mirrors
// merge-gate-reuse.mjs's own style) so a call COUNTER proves whether the gate command actually ran,
// rather than trusting the return value alone.
//
// FAIL-CLOSED IS THE WHOLE DESIGN — this suite's center of gravity is scenario (B), the safety case named
// explicitly by the card: a diff confined to `packages/daemon/assets/skills/**/SKILL.md` is markdown, but
// markdown under `assets/**` IS product behaviour and IS tested — a predicate that skips (B) is the exact
// defect this card exists to prevent, and it would look identical to a working one on (A) alone.
//
// Proves:
//   (A) HAPPY PATH — a branch whose ENTIRE diff is under `docs/` never spawns a gate at all: the gate
//       command is called ZERO times, the merge still succeeds, and the result records gateRan:false with
//       NO reusedOpId (this is not the reuse path — no self-check was ever recorded). The `build_gate`
//       audit event carries `skipped:true`, never `reused:true`, and `gate_history`'s own derived
//       `outcome` reads `"skipped"` — NEVER `"pass"` (card 3a6f04cc's `gateRan` bit must not be
//       reintroduced-around via a new door).
//   (B) THE SAFETY CASE — a branch touching ONLY `packages/daemon/assets/skills/**/SKILL.md` (markdown,
//       but a tested subtree) MUST run the full gate: gateRan:true, the gate command called exactly once.
//   (C) MIXED DIFF — docs + one src file — MUST run the full gate: an allowlist match on SOME paths never
//       licenses skipping when even one path falls outside it.
//   (D) EMPTY DIFF — a branch with NO net changes against main (nothing to prove inert from) — MUST run
//       the full gate rather than being special-cased as trivially inert.
//   (E) UNKNOWN TOP-LEVEL DIRECTORY — a brand-new, never-seen-before directory is not on the allowlist by
//       construction — MUST run the full gate (DoD-2's fail-closed default, exercised directly rather than
//       merely asserted).
//   (F)/(G) added later, see their own inline headers below (rename safety case; docs/-prefix boundary).
//   (H) SAME-REPO SIBLING MID-GATE, STILL INERT AFTER RECLASSIFICATION (card ac7aad04, superseding
//       b9e07a4a's own version of this scenario): an inert-diff skip must WAIT for a same-repo sibling
//       that is genuinely running a real gate right now, never race ahead of it — proving the
//       reachability fix (GateSemaphore.acquireRepoGuardOnly) actually closes the gap. Once the guard is
//       granted (the sibling has already landed), the waiting op RE-DERIVES against the new main instead
//       of trusting its stale pre-wait verdict — since this branch's own diff is STILL fully inert
//       against the sibling's landed change, it LANDS (this is the whole point of ac7aad04: a guaranteed
//       manager round-trip becomes a real merge).
//   (I) SAME-REPO SIBLING MID-GATE, NO LONGER INERT AFTER RECLASSIFICATION (card ac7aad04): the SAME
//       wait-then-reclassify path, but the sibling's own landed change makes THIS branch's diff no longer
//       provably inert against the new main — this MUST run the real gate, never a stale skip (DoD-2's
//       fail-closed requirement, exercised for real rather than merely asserted).
//   (J) BRANCH-ONLY MOVE DURING THE GUARD WAIT (card db413510): (H)/(I) both moved MAIN during the wait
//       (a sibling's real gate squashing). This isolates the other endpoint — main never moves, only the
//       BRANCH gains a new commit during the wait (a still-active worker committing further) — the gap
//       ac7aad04's own re-derivation left open (it was keyed on main movement alone). MUST re-derive and
//       take the real gate, never ride through on the stale pre-wait docs-only verdict.
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-inert-diff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { assertNeverWithControl, observeOnce } from "./_timing-guard.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgid-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgid@loom -c user.name=mgid";
const now = new Date().toISOString();

// Races `sessions.confirmWorkerMerge` against a bounded timeout — used ONLY to prove a repo guard was
// genuinely released (not leaked) after a prior op's exit: a leaked guard wedges this call forever, so a
// real settle within `timeoutMs` is itself the proof, independent of what the settled result says.
const TIMEOUT = Symbol("timeout");
async function confirmWithTimeout(sessions, mgrId, workerId, timeoutMs) {
  const result = await Promise.race([
    sessions.confirmWorkerMerge(mgrId, workerId),
    sleep(timeoutMs).then(() => TIMEOUT),
  ]);
  return result === TIMEOUT ? "TIMEOUT" : result;
}

// Polls `gateQueueForManager` (the SAME read `gate_queue` uses) until a repo-guard-only wait for
// `repoPath` shows up QUEUED — i.e. an inert-diff-skip candidate has ALREADY computed its own
// gateBaseMainHead/inertSkip and is now genuinely blocked behind a same-repo sibling's real gate. A fixed
// sleep()-based window is NOT equivalent here: it races real git subprocess timing (findLandedSquashCommit
// + the pre-gate union-merge, each a separate spawn) against the sibling's own held-open gate — on a slow
// git subprocess, the sibling could land BEFORE the waiting op ever reaches its own guard acquisition,
// making it hit an entirely different, pre-existing code path than the one under test. This poll makes the
// synchronization point exact regardless of git subprocess speed.
async function waitUntilRepoGuardQueued(sessions, projId, repoPath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = sessions.gateQueueForManager(projId);
    if (snap.repoGuardOnly.some((e) => e.phase === "queued" && e.repoPath === repoPath)) return true;
    await sleep(10);
  }
  return false;
}

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MGID", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGID-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgid\n");
  execSync(`git init -q && git config user.email mgid@loom && git config user.name mgid && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `mgid-${label}-proj-${sfx}`, agentId: `mgid-${label}-agent-${sfx}`, taskId: `mgid-${label}-task-${sfx}`,
  mgrId: `mgid-${label}-mgr-${sfx}`, workerId: `mgid-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgid-${label}-${sfx}`),
});

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

const dbs = [];
const worktrees = [];
try {
  // ── (A) HAPPY PATH — a docs-only branch skips the gate entirely ────────────────────────────────────
  {
    const A = mk("a");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "docs", "investigations"));
    fs.writeFileSync(path.join(worktreePath, "docs", "investigations", "note.md"), "findings\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: add finding"`, { cwd: worktreePath });
    seed(db, A, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) the gate command was NEVER called — the diff is provably inert", calls === 0);
    check("(A) merged:true", confirm.merged === true);
    check("(A) gateRan:false", confirm.gateRan === false);
    check("(A) reusedOpId is absent — this is a SKIP, not a reuse", confirm.reusedOpId === undefined);
    check("(A) a distinguishing warning is present", typeof confirm.warning === "string" && /docs\//.test(confirm.warning));

    const buildGate = eventsOfKind(db, A.mgrId, "build_gate")[0];
    check("(A) build_gate audit event carries skipped:true", buildGate?.detail?.skipped === true);
    check("(A) build_gate audit event does NOT carry reused:true — no prior run was reused, none ever ran", buildGate?.detail?.reused !== true);

    const history = db.listGateEvents({ projectId: A.projId, limit: 10, offset: 0 });
    check("(A) gate_history's own derived outcome is \"skipped\" — NEVER \"pass\"", history.items[0]?.outcome === "skipped");
    check("(A) gate_history's own derived gateRan is false", history.items[0]?.gateRan === false);
    check("(A) task moved to done", db.getTask(A.taskId).columnKey === "done");
  }

  // ── (B) THE SAFETY CASE — assets/skills/**/SKILL.md is markdown but IS tested; MUST full-gate ───────
  {
    const B = mk("b");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill", "SKILL.md"), "# skill\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: edit SKILL.md"`, { cwd: worktreePath });
    seed(db, B, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) the gate command WAS called — a SKILL.md-only diff is never proven inert", calls === 1);
    check("(B) merged:true", confirm.merged === true);
    check("(B) gateRan:true — the whole safety case this card exists to protect", confirm.gateRan === true);
    check("(B) reusedOpId is absent (a real run, not a reuse)", confirm.reusedOpId === undefined);

    const buildGate = eventsOfKind(db, B.mgrId, "build_gate")[0];
    check("(B) build_gate audit event does NOT carry skipped:true", buildGate?.detail?.skipped !== true);
    const history = db.listGateEvents({ projectId: B.projId, limit: 10, offset: 0 });
    check("(B) gate_history's own derived outcome is \"pass\" (a real run), not \"skipped\"", history.items[0]?.outcome === "pass");
  }

  // ── (C) MIXED DIFF — docs + one src file — MUST full-gate ──────────────────────────────────────────
  {
    const C = mk("c");
    makeRepo(C);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "findings\n");
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "index.ts"), "export const x = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add index + note"`, { cwd: worktreePath });
    seed(db, C, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) the gate command WAS called — one path outside the allowlist gates the WHOLE diff", calls === 1);
    check("(C) merged:true", confirm.merged === true);
    check("(C) gateRan:true", confirm.gateRan === true);
  }

  // ── (D) EMPTY DIFF — nothing to prove inert from — MUST full-gate, never special-cased as trivially
  //        inert ──────────────────────────────────────────────────────────────────────────────────────
  {
    const D = mk("d");
    makeRepo(D);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    // No commits on the branch at all — a genuinely empty diff against main.
    seed(db, D, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) the gate command WAS called — an empty diff is not special-cased as inert", calls === 1);
    // A genuinely empty diff has nothing to squash (STAGE_EMPTY_RETRY) — that return shape never carries
    // `gateRan` at all (see confirmWorkerMerge's own STAGE_EMPTY_RETRY return), so the assertion that
    // actually matters here is `calls === 1` above: the predicate did NOT skip the gate for a zero-path
    // diff, exactly per isInertMergeDiff's own "zero changed paths ⇒ false" contract.
    check("(D) merged:false (nothing to squash, unrelated to the inert-diff predicate)", confirm.merged === false);
    check("(D) classified STAGE_EMPTY_RETRY, not an inert-diff skip", confirm.emptyKind === "STAGE_EMPTY_RETRY");
  }

  // ── (E) UNKNOWN TOP-LEVEL DIRECTORY — never seen before, not on the allowlist by construction — MUST
  //        full-gate ─────────────────────────────────────────────────────────────────────────────────
  {
    const E = mk("e");
    makeRepo(E);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "brand-new-unknown-dir"));
    fs.writeFileSync(path.join(worktreePath, "brand-new-unknown-dir", "whatever.md"), "text\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "chore: new dir"`, { cwd: worktreePath });
    seed(db, E, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
    check("(E) the gate command WAS called — an unrecognized top-level directory fails closed", calls === 1);
    check("(E) gateRan:true", confirm.gateRan === true);
  }

  // ── (F) THE WHOLE SAFETY CASE FOR `--no-renames` (Code Review, card db9b0130) — a `git mv` that
  //        RELOCATES A SOURCE FILE into docs/ must still full-gate. PROVEN on git 2.47.0 (manually
  //        reproduced against a base that already contains the source file, exactly like main does here):
  //        with git's default rename detection left ON, `git diff --name-only <base>..<branch>` after a
  //        `git mv src/x.ts docs/x.ts` prints ONLY the destination path — the deleted source path vanishes
  //        from the list entirely. Without `--no-renames`, this diff would classify as inert (only
  //        `docs/x.ts` appears to have changed) and the gate would be SKIPPED while a real source file
  //        silently leaves main un-gated. `src/x.ts` is committed to MAIN itself (before the worktree is
  //        even cut) — the base MUST already contain the file being renamed for git's rename heuristic to
  //        have anything to detect; committing it only on the branch (as an earlier draft of this test
  //        did) makes the file absent from the diff base entirely, which trivially shows just the
  //        destination regardless of `--no-renames` and doesn't exercise the rename path at all. This arm
  //        is the demonstration that the flag matters, not just an assertion that it's present.
  {
    const F = mk("f");
    makeRepo(F);
    mkdirp(path.join(F.repo, "src"));
    fs.writeFileSync(path.join(F.repo, "src", "x.ts"), "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: add src/x.ts"`, { cwd: F.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "docs"));
    execSync(`git mv src/x.ts docs/x.ts`, { cwd: worktreePath });
    execSync(`git ${GIT_ID} commit -q -m "docs: relocate x.ts"`, { cwd: worktreePath });
    seed(db, F, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) the gate command WAS called — a rename that relocates a source file into docs/ must still full-gate", calls === 1);
    check("(F) gateRan:true", confirm.gateRan === true);
  }

  // ── (G) PREFIX-BOUNDARY REGRESSION GUARD — `startsWith(\"docs/\")` is correct today, but
  //        `startsWith(\"docs\")` (dropping the trailing slash) would pass every OTHER arm in this file.
  //        Neither `docs-internal/` nor `docsfoo.md` is actually under `docs/` and both must full-gate. ──
  {
    const G = mk("g");
    makeRepo(G);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = worktreePath; G.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "docs-internal"));
    fs.writeFileSync(path.join(worktreePath, "docs-internal", "x.md"), "text\n");
    fs.writeFileSync(path.join(worktreePath, "docsfoo.md"), "text\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "chore: docs-lookalike paths"`, { cwd: worktreePath });
    seed(db, G, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(G.mgrId, G.workerId);
    check("(G) the gate command WAS called — docs-internal/ and docsfoo.md are NOT under docs/", calls === 1);
    check("(G) gateRan:true", confirm.gateRan === true);
  }

  // ── (H) SAME-REPO SIBLING MID-GATE (card b9e07a4a) — see this file's own header for the summary.
  //        TWO workers sharing ONE repo, deliberately (unlike gate-semaphore-concurrency.mjs's
  //        seedTwoWorkers, which keeps two workers on SEPARATE repos to avoid coupling an unrelated
  //        gate-CAP test to real squash-merge ordering): this test's whole point IS that ordering, and the
  //        fix under test (acquireRepoGuardOnly) is exactly what makes it deterministic instead of a race
  //        — worker2 (inert) never even attempts its squash until worker1's (the real gate) has already
  //        landed, so there is no genuine concurrent-squash race for git to flake on. ─────────────────────
  {
    const H = mk("h");
    makeRepo(H);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    let gate1Calls = 0;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async () => {
      gate1Calls++;
      gate1AdmittedResolve();
      await new Promise((res) => { releaseGate1 = res; });
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    db.insertProject({ id: H.projId, name: "MGID-H", repoPath: H.repo, vaultPath: H.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: H.agentId, projectId: H.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: H.mgrId, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: H.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const task1Id = `${H.taskId}-1`, task2Id = `${H.taskId}-2`;
    const worker1Id = `${H.workerId}-1`, worker2Id = `${H.workerId}-2`;
    db.insertTask({ id: task1Id, projectId: H.projId, title: "MGID-H-REAL", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: task2Id, projectId: H.projId, title: "MGID-H-INERT", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });

    // worker1: a REAL (non-inert) change — the sibling that must NOT be force-invalidated.
    const wt1 = await createWorktree(H.repo, H.projId, task1Id);
    worktrees.push(wt1.worktreePath);
    mkdirp(path.join(wt1.worktreePath, "src"));
    fs.writeFileSync(path.join(wt1.worktreePath, "src", "index.ts"), "export const x = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: real change"`, { cwd: wt1.worktreePath });
    db.insertSession({ id: worker1Id, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: H.mgrId, taskId: task1Id, worktreePath: wt1.worktreePath, branch: wt1.branch });

    // worker2: a docs-only (inert) change — cut from the SAME main tip, before worker1 ever squashes.
    const wt2 = await createWorktree(H.repo, H.projId, task2Id);
    worktrees.push(wt2.worktreePath);
    mkdirp(path.join(wt2.worktreePath, "docs"));
    fs.writeFileSync(path.join(wt2.worktreePath, "docs", "note.md"), "notes\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: add note"`, { cwd: wt2.worktreePath });
    db.insertSession({ id: worker2Id, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: H.mgrId, taskId: task2Id, worktreePath: wt2.worktreePath, branch: wt2.branch });

    // Fire worker1's confirm first — a REAL gate, held open until we manually release it.
    const p1 = sessions.confirmWorkerMerge(H.mgrId, worker1Id);
    await gate1Admitted; // worker1 has genuinely admitted and is mid-gate, holding the repo guard

    // Fire worker2's confirm — the ORDINARY manager slip b9e07a4a's reachability finding describes:
    // firing a second same-repo confirm while the first is still mid-gate. Before this card, the
    // inert-diff skip never touched the repo guard at all and could squash BEFORE worker1 reached its own
    // squash-lock, forcing worker1 to eat a full re-gate.
    let worker2Settled = false;
    const p2 = sessions.confirmWorkerMerge(H.mgrId, worker2Id).then((r) => { worker2Settled = true; return r; });

    // Deterministic sync point — see `waitUntilRepoGuardQueued`'s own doc: don't release worker1 until
    // worker2 has GENUINELY reached (and is blocked on) its own repo-guard-only wait, not after a fixed
    // timer that races real git subprocess speed.
    const worker2Queued = await waitUntilRepoGuardQueued(sessions, H.projId, H.repo, 10000);
    check("(H) worker2 genuinely reached its own repo-guard-only wait before worker1 landed", worker2Queued);

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(H) the inert worker2 confirm does NOT settle while worker1's real gate is still running",
      check: () => worker2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(H) worker2's inert confirm PROVABLY waited — did not race ahead of worker1's real gate", neverSettled);

    // Release worker1's gate — it passes, squashes, and its repo hold releases only after ITS OWN squash
    // has landed (endSquash, called after mergeBranch — see confirmWorkerMerge's own finally).
    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(H) worker1 (the sibling, mid-gate) merged successfully", confirm1.merged === true);
    check("(H) worker1 ran a real gate exactly once", confirm1.gateRan === true && gate1Calls === 1);
    check("(H) worker1 was NOT force-invalidated by the inert merge racing ahead — the whole point of this card",
      confirm1.merged === true && confirm1.reason !== "gate_base_invalidated");

    check("(H) worker2's inert skip never spawned a gate of its own", confirm2.gateRan !== true);
    // DETERMINISTIC, not a possible residual — worker2's `gateBaseMainHead`/`inertSkip` are BOTH computed
    // BEFORE `acquireRepoGuardOnly`'s wait (see that call site's own doc), so worker2's own capture is
    // GUARANTEED to happen before worker1's squash lands (this test fires worker2's confirm immediately
    // after worker1's gate admits, well before `releaseGate1`). By the time worker2's wait ends and it
    // holds the guard, main HAS already moved (worker1 landed) — but worker2's OWN diff (docs/note.md
    // only) never touched anything worker1 changed (src/index.ts), so after card ac7aad04's
    // reclassification re-unions worker2's worktree with the NEW main and re-checks, the diff is STILL
    // fully inert. This is the whole point of ac7aad04, superseding b9e07a4a's own version of this test
    // (which asserted a DETERMINISTIC `gate_base_invalidated` rejection here — that was the relocated
    // cost this card exists to eliminate, not a permanent property of the design).
    check("(H) worker2 LANDS — the wait produced a real merge, not a guaranteed manager round-trip",
      confirm2.merged === true && confirm2.reason !== "gate_base_invalidated");
    check("(H) worker2's own docs note actually landed on main", fs.existsSync(path.join(H.repo, "docs", "note.md")));
    check("(H) worker1's src file is present too (worker2's reclassification reunion did not clobber it)", fs.existsSync(path.join(H.repo, "src", "index.ts")));
    check("(H) worker2's task moved to done", db.getTask(task2Id).columnKey === "done");
  }

  // ── (I) SAME-REPO SIBLING MID-GATE, RECLASSIFICATION FINDS A GENUINE CONFLICT (card ac7aad04) — see
  //        this file's own header for the summary. worker1 and worker2 both edit the SAME line of the
  //        SAME docs file, cut from the same base: worker1's edit is part of a wider (non-inert) change,
  //        worker2's edit is docs-only (provably inert PRE-wait). Once worker1 lands and worker2's
  //        reclassification re-unions worker2's worktree with the new main, that union hits a REAL git
  //        conflict on the shared line — an intentionally unresolvable case, chosen because it's the one
  //        deterministic way to make an ALREADY-inert union-producer diff turn ambiguous after a clean
  //        reunion (a clean, non-conflicting reunion always isolates exactly this branch's OWN net
  //        changes — see the reclassification's own in-code doc). Proves DoD-2's central safety property:
  //        `inertSkip` is NEVER carried across the wait as a stale `true` — the op falls through to the
  //        ordinary real-gate/reunion machinery and is REJECTED there (never silently merged), exactly
  //        like any other admission-time reunion conflict. ─────────────────────────────────────────────
  {
    const I = mk("i");
    fs.mkdirSync(I.repo, { recursive: true });
    mkdirp(path.join(I.repo, "docs"));
    fs.writeFileSync(path.join(I.repo, "docs", "note.md"), "shared line\n");
    execSync(`git init -q && git config user.email mgid@loom && git config user.name mgid && git add . && git ${GIT_ID} commit -q -m init`, { cwd: I.repo });
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    // ONE shared counter across both workers — worker2 is expected to NEVER reach it at all (the
    // admission-time reunion conflict throws before `runGateSeq` spawns anything), so a total of 1 at the
    // end proves worker2's gate command was never actually invoked.
    let gateCalls = 0;
    let gate1AdmittedResolve;
    const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
    let releaseGate1;
    const fakeGate = async () => {
      gateCalls++;
      gate1AdmittedResolve();
      await new Promise((res) => { releaseGate1 = res; });
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    db.insertProject({ id: I.projId, name: "MGID-I", repoPath: I.repo, vaultPath: I.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: I.agentId, projectId: I.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: I.mgrId, projectId: I.projId, agentId: I.agentId, engineSessionId: null, title: null, cwd: I.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const task1Id = `${I.taskId}-1`, task2Id = `${I.taskId}-2`;
    const worker1Id = `${I.workerId}-1`, worker2Id = `${I.workerId}-2`;
    db.insertTask({ id: task1Id, projectId: I.projId, title: "MGID-I-REAL", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: task2Id, projectId: I.projId, title: "MGID-I-INERT", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });

    // worker1: a REAL (non-inert) change that ALSO rewrites docs/note.md's shared line.
    const wt1 = await createWorktree(I.repo, I.projId, task1Id);
    worktrees.push(wt1.worktreePath);
    fs.writeFileSync(path.join(wt1.worktreePath, "docs", "note.md"), "worker1 rewrite\n");
    mkdirp(path.join(wt1.worktreePath, "src"));
    fs.writeFileSync(path.join(wt1.worktreePath, "src", "other.ts"), "export const y = 2;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: real change + docs rewrite"`, { cwd: wt1.worktreePath });
    db.insertSession({ id: worker1Id, projectId: I.projId, agentId: I.agentId, engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: I.mgrId, taskId: task1Id, worktreePath: wt1.worktreePath, branch: wt1.branch });

    // worker2: a docs-only (inert) change to the SAME line — cut from the SAME base, before worker1 lands.
    const wt2 = await createWorktree(I.repo, I.projId, task2Id);
    worktrees.push(wt2.worktreePath);
    fs.writeFileSync(path.join(wt2.worktreePath, "docs", "note.md"), "worker2 rewrite\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: worker2 rewrite"`, { cwd: wt2.worktreePath });
    db.insertSession({ id: worker2Id, projectId: I.projId, agentId: I.agentId, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: I.mgrId, taskId: task2Id, worktreePath: wt2.worktreePath, branch: wt2.branch });

    // Fire worker1's confirm first — a REAL gate, held open until we manually release it.
    const p1 = sessions.confirmWorkerMerge(I.mgrId, worker1Id);
    await gate1Admitted; // worker1 has genuinely admitted and is mid-gate, holding the repo guard

    // Fire worker2's confirm — same ordinary manager-slip shape as (H): a second same-repo confirm while
    // the first is still mid-gate.
    let worker2Settled = false;
    const p2 = sessions.confirmWorkerMerge(I.mgrId, worker2Id).then((r) => { worker2Settled = true; return r; });

    // Deterministic sync point (see `waitUntilRepoGuardQueued`'s own doc) — load-bearing HERE specifically:
    // without it, worker2's OWN pre-wait union-merge/inert-check could race against worker1's release and
    // land AFTER worker1 already squashed, hitting the pre-existing (pre-ac7aad04) union-merge-conflict
    // path instead of ac7aad04's own reclassification code — the exact thing this scenario exists to test.
    const worker2Queued = await waitUntilRepoGuardQueued(sessions, I.projId, I.repo, 10000);
    check("(I) worker2 genuinely reached its own repo-guard-only wait before worker1 landed", worker2Queued);

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(I) the inert worker2 confirm does NOT settle while worker1's real gate is still running",
      check: () => worker2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(I) worker2's inert confirm PROVABLY waited — did not race ahead of worker1's real gate", neverSettled);

    // Release worker1's gate — it passes and squashes, landing docs/note.md="worker1 rewrite\n" + src/other.ts.
    releaseGate1("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(I) worker1 (the sibling, mid-gate) merged successfully", confirm1.merged === true);
    check("(I) worker1 ran a real gate exactly once", confirm1.gateRan === true && gateCalls === 1);

    // worker2's reclassification re-unions against the new main and hits a genuine conflict on
    // docs/note.md (both sides rewrote the same line) — DoD-2's fail-closed contract: this MUST fall
    // through to the ordinary real-gate/reunion path, never silently keep `inertSkip:true`.
    check("(I) worker2's gate command was NEVER actually invoked — the admission-time reunion conflict is caught before runGateSeq spawns anything", gateCalls === 1 /* == worker1's own call, none from worker2 */);
    check("(I) worker2 was REJECTED, not silently merged — the reclassification correctly gave up its stale inert verdict",
      confirm2.merged === false);
    check("(I) worker2's rejection names the real conflict, not a stale gate_base_invalidated shape",
      typeof confirm2.reason === "string" && confirm2.reason.includes("branch conflicts with current main")
      && confirm2.detailText?.includes("squash phase never reached, canonical repo untouched, worktree retained")
      && confirm2.detailText?.includes("the advance conflicts with this branch's own content"));
    // STRUCTURALLY discriminating (Code Review calibration note, card ac7aad04): the two rejection
    // reasons above are both STRINGS, so a single test-calibration gap in the wording could carry both.
    // This checks SHAPE instead: `AdmissionReunionFailedError`'s own rejection path (`rejectAdmissionReunionFailure`)
    // returns a bare `{merged,reason,detailText,notified,opId}` — it throws BEFORE the gate/squash-lock
    // ever runs, so it never has a `gateRan` to report. The PRE-FIX `gate_base_invalidated` rejection is a
    // DIFFERENT code path (mergeBranch's own squash-lock re-check, reached only AFTER `merge =
    // await mergeBranch(...)`) whose return literal ALWAYS spreads `gateRan` (see that return site) —
    // present with a real boolean value even when merged:false. Confirming its ABSENCE here is a shape
    // check no reason-string wording could accidentally satisfy on either side of this card.
    check("(I) confirm2 has NO gateRan field at all — proves this is genuinely the sparser AdmissionReunionFailedError shape (thrown pre-gate), not the gate_base_invalidated shape mergeBranch's squash-lock produces",
      !("gateRan" in confirm2));
    check("(I) worker2's worktree is retained for the manager to resolve", fs.existsSync(wt2.worktreePath));
    check("(I) worker2's task is still in_progress (not falsely marked done)", db.getTask(task2Id).columnKey === "in_progress");

    // GUARD-RELEASED-ON-EVERY-EXIT (DoD-3): worker2's reclassification released its OWN repo-guard-only
    // hold explicitly before falling into `runExclusive` (else it would deadlock waiting on itself — see
    // the in-code doc at the reclassification site), and `runExclusive`'s own admission hold released
    // through the pre-existing outer try/finally when `reunionAtAdmission` threw. Prove BOTH actually let
    // go, not just that this test didn't hang: fire a THIRD, brand-new inert (docs-only) worker on the
    // SAME repo and confirm it merges promptly — a leaked guard from either exit would wedge this forever.
    const task3Id = `${I.taskId}-3`;
    const worker3Id = `${I.workerId}-3`;
    db.insertTask({ id: task3Id, projectId: I.projId, title: "MGID-I-INERT-3", body: "", columnKey: "in_progress", position: 3, createdAt: now, updatedAt: now });
    const wt3 = await createWorktree(I.repo, I.projId, task3Id);
    worktrees.push(wt3.worktreePath);
    mkdirp(path.join(wt3.worktreePath, "docs"));
    fs.writeFileSync(path.join(wt3.worktreePath, "docs", "another.md"), "worker3 notes\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: worker3 note"`, { cwd: wt3.worktreePath });
    db.insertSession({ id: worker3Id, projectId: I.projId, agentId: I.agentId, engineSessionId: null, title: null, cwd: wt3.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: I.mgrId, taskId: task3Id, worktreePath: wt3.worktreePath, branch: wt3.branch });
    // 20s, not a tight bound: this is only a leaked-guard tripwire (a genuine leak hangs FOREVER, so any
    // finite bound catches it) — a tight one risks flaking on ordinary git-subprocess variance this deep
    // into the suite (observed: an occasional real confirm taking a few seconds under load).
    const confirm3 = await confirmWithTimeout(sessions, I.mgrId, worker3Id, 20000);
    check("(I) a THIRD, unrelated inert worker on the same repo did NOT hang behind a leaked guard", confirm3 !== "TIMEOUT");
    check("(I) and it merged successfully — the repo guard was genuinely free", confirm3 !== "TIMEOUT" && confirm3.merged === true && confirm3.gateRan !== true);
  }

  // ── (J) BRANCH-ONLY MOVE DURING THE GUARD WAIT (card db413510) — the short-circuit at the
  //        reclassification site (`!postWaitHead || postWaitHead !== gateBaseMainHead`) was BRANCH-BLIND:
  //        it only ever re-derived when MAIN moved during the guard wait, never when the BRANCH did. This
  //        scenario isolates that half of the bug: MAIN NEVER MOVES (no sibling squash, ever) — the wait is
  //        instead induced by directly holding the repo guard from the TEST itself, via the exact same
  //        `GateSemaphore.acquireRepoGuardOnly` primitive `confirmWorkerMerge` uses — while worker's OWN
  //        branch gains a genuinely new, non-docs commit. The reachable sequence named on the card: "the
  //        confirming worker's pty is not stopped until after the merge method returns... so a worker
  //        committing once more while its own merge waits on the repo guard is an ordinary sequence, not a
  //        contrived one." PRE-FIX: the new src commit rides through on the STALE docs-only inert verdict —
  //        gateRan stays false and the fake gate is NEVER called, even though a real src file just squashed
  //        onto main ungated. POST-FIX: the branch-tip mismatch is caught, `isInertMergeDiff` re-derives
  //        against the branch's NEW tip (by name, not by stale sha), finds it no longer inert, and routes to
  //        the real gate. ─────────────────────────────────────────────────────────────────────────────────
  {
    const J = mk("j");
    makeRepo(J);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(J.repo, J.projId, J.taskId);
    J.worktreePath = worktreePath; J.branch = branch; worktrees.push(worktreePath);
    // Start docs-only — provably inert against main BEFORE the wait, exactly like (A).
    mkdirp(path.join(worktreePath, "docs"));
    fs.writeFileSync(path.join(worktreePath, "docs", "note.md"), "notes\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: add note"`, { cwd: worktreePath });
    seed(db, J, "pnpm gate");

    const mainHeadBefore = execSync(`git rev-parse HEAD`, { cwd: J.repo }).toString().trim();

    // Hold the repo-guard-only slot for J.repo directly from the test — the SAME primitive
    // `confirmWorkerMerge`'s inert-skip path itself calls (`acquireRepoGuardOnly`). This induces a real
    // wait WITHOUT any sibling gate ever running and WITHOUT main ever moving — isolating the branch-only
    // move this scenario exists to prove, uncontaminated by (H)/(I)'s main-movement case.
    const releaseTestHold = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: J.repo, projectId: J.projId, sessionId: "test-holder", taskId: null, branch: null, opId: "test-holder-op",
    });

    let confirmSettled = false;
    const pConfirm = sessions.confirmWorkerMerge(J.mgrId, J.workerId).then((r) => { confirmSettled = true; return r; });

    // Deterministic sync point (same helper (H)/(I) use): don't commit to the branch, and don't release
    // the test's own hold, until worker's confirm has GENUINELY reached its own repo-guard-only wait —
    // i.e. it has already captured `inertSkip`/`gateBaseMainHead`/`preWaitBranchHead` and is now blocked.
    const queued = await waitUntilRepoGuardQueued(sessions, J.projId, J.repo, 10000);
    check("(J) worker's confirm genuinely reached its own repo-guard-only wait before we release our hold", queued);

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(J) the confirm does NOT settle while the test hold is still held",
      check: () => confirmSettled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(J) confirm PROVABLY waited on the guard, not a fluke of scheduling", neverSettled);

    // NOW, while the worker's confirm is genuinely blocked on the guard, commit a NEW, non-docs file
    // directly to the worker's OWN branch — the reachable race the card names: a still-active worker
    // committing further while its own merge waits on the repo guard, which can be minutes.
    mkdirp(path.join(worktreePath, "src"));
    fs.writeFileSync(path.join(worktreePath, "src", "late.ts"), "export const late = true;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: late commit during the guard wait"`, { cwd: worktreePath });

    // Sanity check main BEFORE releasing our hold — this is the actual "during the wait" window. (main
    // necessarily DOES move once we release and the confirm's own real gate squashes — that's the
    // EXPECTED outcome this scenario proves, not a violation of "main never moved during the wait".)
    const mainHeadStillDuringWait = execSync(`git rev-parse HEAD`, { cwd: J.repo }).toString().trim();
    check("(J) sanity: main genuinely never moved during the wait itself — isolates the branch-only case",
      mainHeadStillDuringWait === mainHeadBefore);

    // Release the test's own hold — main never moved WHILE HELD (just proven above); ONLY the branch did.
    releaseTestHold();
    const confirm = await pConfirm;

    // ⭐ THE CENTRAL ASSERTION — the whole point of card db413510: a branch that gained a genuinely new,
    // non-docs commit DURING the guard wait must NOT ride through on the stale pre-wait inert verdict. Pre-
    // fix this is FALSE (gateRan stays false, calls stays 0) because the short-circuit only checks
    // `postWaitHead !== gateBaseMainHead` — main never moved, so it never re-derives, and the stale
    // `inertSkip:true` computed against the OLD (docs-only) branch tip rides straight through.
    check("(J) the late src commit forced a REAL gate — the stale docs-only inert verdict was NOT trusted",
      confirm.gateRan === true && calls === 1);
    check("(J) merged successfully once the real gate passed", confirm.merged === true);
    check("(J) the late src file actually landed on main (proves this isn't a rejection masking the bug)",
      fs.existsSync(path.join(J.repo, "src", "late.ts")));
    check("(J) the docs note landed too", fs.existsSync(path.join(J.repo, "docs", "note.md")));
    // DELETED (card 776fc8c9): a check here comparing `branchHeadAfterLateCommit` against `mainHeadBefore`
    // is unconditionally true both pre-fix and post-fix — the worker's branch already diverged from main
    // at test setup, so its tip differs from main's OLD head BY CONSTRUCTION, regardless of which verdict
    // the inert-skip path reached. Re-pointing it at main's POST-MERGE head doesn't fix this either:
    // `mergeBranch` squashes the branch BY NAME (see `sessions/service.ts`'s `mergeBranch(repoPath, branch,
    // ...)` call), so the late commit's content lands on main identically whether the fix routed this
    // through the real gate or not — the bug this scenario proves is about GATING, not about whether the
    // content lands, so no comparison of "what landed" can discriminate it. The `existsSync(..., "src",
    // "late.ts")` check above already proves the post-late-commit content is what's on main; the actual
    // discriminating proof of the fix is "(J) the late src commit forced a REAL gate" above (gateRan/calls).
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a branch whose entire diff is under docs/ skips the merge gate (gateRan:false, outcome:\"skipped\", never \"pass\"); a diff touching packages/daemon/assets/skills/**/SKILL.md (the safety case), a mixed docs+src diff, an empty diff, an unrecognized top-level directory, a rename that relocates a source file into docs/ (the whole safety case for --no-renames), and docs-lookalike prefix paths (docs-internal/, docsfoo.md) ALL still force the full gate (gateRan:true); an inert-diff skip waiting on a same-repo sibling's real gate re-derives against the sibling's landed change once granted — landing for real when still provably inert (H), falling through to the ordinary real-gate/reunion path (never a stale skip) when reclassification turns up ambiguous (I), and a branch that gains a new non-docs commit DURING the wait — with main never moving at all — is caught too, never riding through on a stale docs-only verdict (J)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
