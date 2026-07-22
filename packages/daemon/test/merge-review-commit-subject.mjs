import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PROSPECTIVE COMMIT SUBJECT merge-review test (card b88704bb). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.reviewWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-deny-glob.mjs's in-process style).
//
// THE GAP IT GUARDS: reviewWorkerMerge (step 1 of the two-step merge gate) used to return no commit
// subject at all — the subject is derived LATER, inside confirmWorkerMerge -> mergeBranch ->
// toConventionalSubject, i.e. AFTER the manager has already reviewed and approved. So the gate presented a
// diff for review and then wrote a permanent, immutable commit subject the reviewer was never shown, and
// a silent coercion (legacy bracket / bare prose -> a guessed type) carried no signal to anyone. This test
// proves reviewWorkerMerge now surfaces the EXACT prospective subject (byte-for-byte what mergeBranch will
// commit) plus an honest, factual `coerced` flag — and that a taskless worker gets neither fabricated.
//
// Proves:
//   (A) ALREADY-CONVENTIONAL title -> commitSubject is UNCHANGED, rawTitle === commitSubject, coerced
//       is FALSE (a plain string-equality fact, not an accuracy judgment).
//   (B) LEGACY BRACKET title (`[Bug, P2] ...`) -> commitSubject is the MAPPED conventional form, rawTitle
//       is the original bracketed title, coerced is TRUE.
//   (C) BARE PROSE title -> commitSubject is `chore: <prose>`, coerced is TRUE.
//   (D) TASKLESS worker (no taskId at all) -> rawTitle/commitSubject/coerced are ALL ABSENT — no crash,
//       no subject fabricated from the branch name.
//   (E) The confirmed merge's OWN result (confirmWorkerMerge) echoes the SAME `commitSubject` that was
//       previewed at review time, for case (B) — proving the preview never drifts from what actually lands.
// Run: 1) build daemon (pnpm build), 2) node test/merge-review-commit-subject.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrcs-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrcs@loom -c user.name=mrcs";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p, { withTask }) {
  db.insertProject({ id: p.projId, name: "MRCS", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  if (withTask) {
    db.insertTask({ id: p.taskId, projectId: p.projId, title: p.title, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  }
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: withTask ? p.taskId : null, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mrcs\n");
  execSync(`git init -q && git config user.email mrcs@loom && git config user.name mrcs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function commitChange(worktreePath, file, content, msg) {
  fs.writeFileSync(path.join(worktreePath, file), content);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${msg}"`, { cwd: worktreePath });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = { projId: `mrcs-a-proj-${sfx}`, agentId: `mrcs-a-top-${sfx}`, taskId: `mrcs-a-task-${sfx}`, mgrId: `mrcs-a-mgr-${sfx}`, workerId: `mrcs-a-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-conv-${sfx}`), title: "fix(daemon): paste double-fires on rapid Ctrl-V" };
const B = { projId: `mrcs-b-proj-${sfx}`, agentId: `mrcs-b-top-${sfx}`, taskId: `mrcs-b-task-${sfx}`, mgrId: `mrcs-b-mgr-${sfx}`, workerId: `mrcs-b-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-bracket-${sfx}`), title: "[Bug, P2] Fix paste" };
const C = { projId: `mrcs-c-proj-${sfx}`, agentId: `mrcs-c-top-${sfx}`, taskId: `mrcs-c-task-${sfx}`, mgrId: `mrcs-c-mgr-${sfx}`, workerId: `mrcs-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-prose-${sfx}`), title: "Refresh the dashboard" };
const D = { projId: `mrcs-d-proj-${sfx}`, agentId: `mrcs-d-top-${sfx}`, taskId: `mrcs-d-task-${sfx}`, mgrId: `mrcs-d-mgr-${sfx}`, workerId: `mrcs-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-taskless-${sfx}`) };

try {
  // ── (A) ALREADY-CONVENTIONAL: commitSubject unchanged, coerced:false ───────────────────────────────────
  initRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    commitChange(worktreePath, "feature.ts", "export const x = 1;\n", "add feature");
    seed(A, { withTask: true });

    const review = await sessions.reviewWorkerMerge(A.mgrId, A.workerId);
    check("(A) commitSubject === the already-conventional title", review.commitSubject === A.title);
    check("(A) rawTitle === the raw title", review.rawTitle === A.title);
    check("(A) coerced is false", review.coerced === false);
  }

  // ── (B) LEGACY BRACKET: mapped type, coerced:true ───────────────────────────────────────────────────────
  initRepo(B.repo);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    commitChange(worktreePath, "paste.ts", "export const y = 2;\n", "fix paste");
    seed(B, { withTask: true });

    const review = await sessions.reviewWorkerMerge(B.mgrId, B.workerId);
    check("(B) rawTitle === the raw bracketed title", review.rawTitle === B.title);
    check("(B) commitSubject is the mapped conventional form", review.commitSubject === "fix: Fix paste");
    check("(B) coerced is true", review.coerced === true);

    // ── (E) confirmWorkerMerge's own result echoes the SAME commitSubject previewed above ────────────────
    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(E) confirm succeeded", confirm.merged === true);
    check("(E) confirm echoes the SAME commitSubject the review previewed", confirm.commitSubject === review.commitSubject);
  }

  // ── (C) BARE PROSE: chore:-prefixed, coerced:true ───────────────────────────────────────────────────────
  initRepo(C.repo);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch;
    commitChange(worktreePath, "dash.ts", "export const z = 3;\n", "refresh dashboard");
    seed(C, { withTask: true });

    const review = await sessions.reviewWorkerMerge(C.mgrId, C.workerId);
    check("(C) rawTitle === the raw prose title", review.rawTitle === C.title);
    check("(C) commitSubject is chore:-prefixed", review.commitSubject === "chore: Refresh the dashboard");
    check("(C) coerced is true", review.coerced === true);
  }

  // ── (D) TASKLESS: no card at all -> fields ABSENT, no crash, no fabricated subject from the branch ──────
  initRepo(D.repo);
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, "mrcs-d-orphan-task");
    D.worktreePath = worktreePath; D.branch = branch;
    commitChange(worktreePath, "orphan.ts", "export const w = 4;\n", "orphan change");
    seed(D, { withTask: false });

    let reviewError = null;
    let review;
    try {
      review = await sessions.reviewWorkerMerge(D.mgrId, D.workerId);
    } catch (err) {
      reviewError = err;
    }
    check("(D) reviewWorkerMerge does not throw for a taskless worker", reviewError === null);
    if (reviewError) console.log(`    threw: ${reviewError?.stack || reviewError}`);
    check("(D) rawTitle is absent", review?.rawTitle === undefined);
    check("(D) commitSubject is absent", review?.commitSubject === undefined);
    check("(D) coerced is absent", review?.coerced === undefined);
    check("(D) diff fields are still the real ones", review?.filesChanged === 1);
  }
} finally {
  db.close();
  for (const p of [A, B, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's review step now surfaces the exact prospective squash-commit subject " +
    "(already-conventional unchanged, legacy-bracket mapped, bare-prose chore:-prefixed, each with an " +
    "honest `coerced` flag), degrades cleanly (no fabricated subject) for a taskless worker, and " +
    "worker_merge_confirm's own result echoes the identical subject that actually landed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
