import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate DIAGNOSTIC-REJECTION test (card 4b8f2b6e — the bare "build gate failed" string). REAL git +
// a REAL failing `node` gate step, NO claude and NO live daemon — drives SessionService.confirmWorkerMerge()
// directly against an isolated LOOM_HOME (mirrors merge-union-gate.mjs's in-process style).
//
// THE HOLE IT GUARDS: a gate rejection used to hand the manager only the bare string "build gate failed" —
// the failing phase, the first failing test/assertion, and the child's own stderr/stdout were all
// discarded, so a real test failure, an fs.rmSync teardown flake, and a self-wiped node_modules TS2688 all
// looked identical. THE FIX: gate-runner.ts now captures each step's exit code/signal/timeout + a bounded
// stdout+stderr tail, and confirmWorkerMerge folds a best-effort phase + failing-test extraction into BOTH
// the sync `gateDetail` result field and the `[loom:merge-rejected]` notification text.
//
// Proves:
//   (A) GATE REJECTION IS DIAGNOSTIC — a real failing `node` step populates gateDetail.{phase, failedStep,
//       failingTest, stderrTail, exitCode, signal, timedOut} in the SYNC result, the SAME detail appears in
//       the `[loom:merge-rejected]` signal text delivered to the manager's pty, `reason` stays the bare
//       "build gate failed" string for back-compat, and exactly ONE merge_rejected event is recorded (no
//       merge_done).
//   (B) ONE-TERMINAL-SIGNAL INVARIANT ON SUCCESS — a green gate still merges cleanly with NO gateDetail,
//       and fires exactly ONE merge_done event (never a merge_rejected alongside it).
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-diagnostic.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgd@loom -c user.name=mgd";
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin on these paths; capture every
// enqueueStdin call so the test can assert on the ACTUAL `[loom:merge-rejected]` text a manager would see.
const enqueued = [];
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const eventsOfKind = (mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MGD", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// A real gate step that fails with recognizable stdout/stderr — mirrors what a real test-runner's default
// reporter prints (a "FAIL <name>" line + a thrown AssertionError), so extractFailingTest has something
// genuine to find.
const RUN_TESTS_SCRIPT = [
  "console.log('running suite...');",
  "console.error('FAIL widget.spec.js > renders correctly');",
  "console.error('AssertionError: expected 2 to equal 3');",
  "process.exit(1);",
].join("\n");

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgd\n");
  fs.writeFileSync(path.join(p.repo, "run-tests.mjs"), RUN_TESTS_SCRIPT);
  execSync(`git init -q && git config user.email mgd@loom && git config user.name mgd && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mgd-${label}-proj-${sfx}`, agentId: `mgd-${label}-agent-${sfx}`, taskId: `mgd-${label}-task-${sfx}`,
  mgrId: `mgd-${label}-mgr-${sfx}`, workerId: `mgd-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgd-${label}-${sfx}`), file,
});
const A = mk("a", "feature-a.txt"); // (A) real failing gate step → diagnostic rejection
const B = mk("b", "feature-b.txt"); // (B) green gate → exactly one merge_done, no gateDetail
const C = mk("c", "feature-c.txt"); // (C) card 55cba5c5: unattributable failure → honest null + reason

try {
  // ── (A) DIAGNOSTIC REJECTION: a real `node run-tests.mjs` step fails with 1 ───────────────────────────
  makeRepo(A);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    seed(A, "node run-tests.mjs");

    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) rejected: merged:false", confirmA.merged === false);
    check("(A) reason stays the bare back-compat string", confirmA.reason === "build gate failed");
    check("(A) gateDetail is populated", confirmA.gateDetail != null);
    check("(A) gateDetail.phase derived as 'test' (step names run-tests.mjs)", confirmA.gateDetail?.phase === "test");
    check("(A) gateDetail.failedStep names the actual failing command", confirmA.gateDetail?.failedStep === "node run-tests.mjs");
    check("(A) gateDetail.failingTest extracted the FAIL line", confirmA.gateDetail?.failingTest?.includes("FAIL widget.spec.js") === true);
    check("(A) gateDetail.stderrTail carries the real child output", (confirmA.gateDetail?.stderrTail ?? "").includes("AssertionError: expected 2 to equal 3"));
    check("(A) gateDetail.exitCode is the real exit code (1)", confirmA.gateDetail?.exitCode === 1);
    check("(A) gateDetail.signal is null (a plain non-zero exit, not a kill)", confirmA.gateDetail?.signal === null);
    check("(A) gateDetail.timedOut is false (failed on its own, not the timeout bound)", confirmA.gateDetail?.timedOut === false);

    // The SAME detail must reach the manager's pty via the `[loom:merge-rejected]` signal text — not just
    // the sync return value — so a manager reading its own turn sees the diagnosis too.
    const rejectMsgs = enqueued.filter((args) => args[0] === A.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(A) exactly ONE [loom:merge-rejected] signal fired for this worker", rejectMsgs.length === 1);
    const text = rejectMsgs[0]?.[1] ?? "";
    check("(A) signal text names the phase", text.includes("phase: test"));
    check("(A) signal text names the failed step", text.includes("step: node run-tests.mjs"));
    check("(A) signal text names the failing test", text.includes("FAIL widget.spec.js"));
    check("(A) signal text carries the gate output tail", text.includes("--- gate output tail ---") && text.includes("AssertionError"));
    check("(A) signal text still says build gate failed + retains the untouched/retained language", /build gate failed/.test(text) && /canonical repo untouched, worktree retained/.test(text));

    check("(A) exactly ONE merge_rejected event recorded", eventsOfKind(A.mgrId, "merge_rejected").length === 1);
    check("(A) NO merge_done event recorded", eventsOfKind(A.mgrId, "merge_done").length === 0);
    check("(A) worktree RETAINED (fail-closed)", fs.existsSync(A.worktreePath));
    check("(A) task NOT moved to done", db.getTask(A.taskId).columnKey !== "done");
  }

  // ── (B) ONE-TERMINAL-SIGNAL INVARIANT: a green gate merges cleanly, exactly one merge_done ────────────
  makeRepo(B);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    seed(B, 'node -e "process.exit(0)"');

    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) GREEN GATE → merged:true", confirmB.merged === true);
    check("(B) no gateDetail on a success (only populated on a gate rejection)", confirmB.gateDetail === undefined);
    check("(B) exactly ONE merge_done event recorded (terminal-signal invariant preserved)", eventsOfKind(B.mgrId, "merge_done").length === 1);
    check("(B) NO merge_rejected event recorded", eventsOfKind(B.mgrId, "merge_rejected").length === 0);
    check("(B) worktree removed (clean merge cleanup)", !fs.existsSync(B.worktreePath));
    check("(B) task moved to done", db.getTask(B.taskId).columnKey === "done");
  }

  // ── (C) card 55cba5c5: a genuinely UNATTRIBUTABLE failure (no recognizable failing-test marker at
  //        all) reports an honest failingTest:undefined + a failingTestReason explaining why — never a
  //        fabricated best-guess test name, in EITHER the sync gateDetail or the [loom:merge-rejected]
  //        text ──────────────────────────────────────────────────────────────────────────────────────
  makeRepo(C);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch;
    fs.writeFileSync(path.join(worktreePath, C.file), "work for C\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    seed(C, 'node -e "console.error(\'kaboom, no idea why\'); process.exit(1)"');

    const confirmC = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) rejected: merged:false", confirmC.merged === false);
    check("(C) gateDetail.failingTest is undefined — no recognizable marker, so no guess", confirmC.gateDetail?.failingTest === undefined);
    check("(C) gateDetail.failingTestReason explains the honest miss", typeof confirmC.gateDetail?.failingTestReason === "string" && confirmC.gateDetail.failingTestReason.length > 0);

    const rejectMsgsC = enqueued.filter((args) => args[0] === C.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(C) exactly ONE [loom:merge-rejected] signal fired", rejectMsgsC.length === 1);
    const textC = rejectMsgsC[0]?.[1] ?? "";
    check("(C) signal text never fabricates a 'failing: <name>' claim", !textC.includes("failing: "));
    check("(C) signal text names the honest reason instead", textC.includes(confirmC.gateDetail.failingTestReason));
  }
} finally {
  db.close();
  for (const p of [A, B, C]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a gate rejection is now DIAGNOSTIC: the failing phase, the failed step, a best-effort failing-test extraction, and a bounded output tail all populate BOTH the sync gateDetail result AND the [loom:merge-rejected] signal text, while `reason` stays the bare back-compat string; a green gate still fires exactly one merge_done with no gateDetail, preserving the one-terminal-signal invariant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
