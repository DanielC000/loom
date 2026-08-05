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
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-inert-diff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

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
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a branch whose entire diff is under docs/ skips the merge gate (gateRan:false, outcome:\"skipped\", never \"pass\"); a diff touching packages/daemon/assets/skills/**/SKILL.md (the safety case), a mixed docs+src diff, an empty diff, an unrecognized top-level directory, a rename that relocates a source file into docs/ (the whole safety case for --no-renames), and docs-lookalike prefix paths (docs-internal/, docsfoo.md) ALL still force the full gate (gateRan:true)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
