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
//   (F) Card a32533a1 — `ownTipSubject`/`ownTipSubjectConventional` (the batch-bound preview, computed for
//       a TASKED worker too, not just a taskless one): a TASKED worker whose branch's own tip commit is
//       BARE PROSE (never conventional) gets `ownTipSubject` === that raw commit message and
//       `ownTipSubjectConventional === false` — the exact, uncoerced subject a `merge_batch` would land for
//       this branch, regardless of what `commitSubject` (the card-title-derived SOLO preview) says.
//   (G) NEGATIVE CONTROL for (F): a TASKED worker whose branch's own tip commit is ALREADY conventional
//       form gets `ownTipSubject` === that commit message verbatim and `ownTipSubjectConventional === true`
//       — proving the flag isn't hardcoded false and genuinely discriminates on the commit's own form.
//   (H) Card 591906ae — a MULTI-commit branch whose NON-tip commit is bare prose (never conventional)
//       gets `ownNonTipCommitSubjects` === [that non-tip subject] (oldest-first, tip excluded) and
//       `ownNonTipCommitSubjectsConventional === false` — proving the check actually FIRES RED on a
//       real non-conventional non-tip subject, the exact gap `ownTipSubject` alone cannot see (its own
//       tip commit here IS conventional, so a tip-only check would wrongly read this branch as clean).
//   (I) POSITIVE CONTROL for (H) — a MULTI-commit branch where EVERY commit (non-tip included) is
//       already conventional form gets `ownNonTipCommitSubjectsConventional === true`, proving the flag
//       isn't hardcoded false and genuinely discriminates on the non-tip commits' own form.
//   (J) SINGLE-commit branch (cases A/B/C/E/G above) must NOT get noisier: `ownNonTipCommitSubjects` is
//       absent entirely — asserted explicitly here against case (A)'s review.
// Run: 1) build daemon (pnpm build), 2) node test/merge-review-commit-subject.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrcs-home-${Date.now()}-${process.pid}`);
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
  execSync(`git init -q && git config user.email mrcs@loom && git config user.name mrcs`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function commitChange(worktreePath, file, content, msg) {
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${msg}`, GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = { projId: `mrcs-a-proj-${sfx}`, agentId: `mrcs-a-top-${sfx}`, taskId: `mrcs-a-task-${sfx}`, mgrId: `mrcs-a-mgr-${sfx}`, workerId: `mrcs-a-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-conv-${sfx}`), title: "fix(daemon): paste double-fires on rapid Ctrl-V" };
const B = { projId: `mrcs-b-proj-${sfx}`, agentId: `mrcs-b-top-${sfx}`, taskId: `mrcs-b-task-${sfx}`, mgrId: `mrcs-b-mgr-${sfx}`, workerId: `mrcs-b-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-bracket-${sfx}`), title: "[Bug, P2] Fix paste" };
const C = { projId: `mrcs-c-proj-${sfx}`, agentId: `mrcs-c-top-${sfx}`, taskId: `mrcs-c-task-${sfx}`, mgrId: `mrcs-c-mgr-${sfx}`, workerId: `mrcs-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-prose-${sfx}`), title: "Refresh the dashboard" };
const D = { projId: `mrcs-d-proj-${sfx}`, agentId: `mrcs-d-top-${sfx}`, taskId: `mrcs-d-task-${sfx}`, mgrId: `mrcs-d-mgr-${sfx}`, workerId: `mrcs-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-taskless-${sfx}`) };
const E = { projId: `mrcs-e-proj-${sfx}`, agentId: `mrcs-e-top-${sfx}`, taskId: `mrcs-e-task-${sfx}`, mgrId: `mrcs-e-mgr-${sfx}`, workerId: `mrcs-e-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-own-conv-${sfx}`), title: "Refresh the dashboard" };
const H = { projId: `mrcs-h-proj-${sfx}`, agentId: `mrcs-h-top-${sfx}`, taskId: `mrcs-h-task-${sfx}`, mgrId: `mrcs-h-mgr-${sfx}`, workerId: `mrcs-h-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-multi-bad-${sfx}`), title: "fix(daemon): tidy up widgets" };
const I = { projId: `mrcs-i-proj-${sfx}`, agentId: `mrcs-i-top-${sfx}`, taskId: `mrcs-i-task-${sfx}`, mgrId: `mrcs-i-mgr-${sfx}`, workerId: `mrcs-i-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrcs-multi-clean-${sfx}`), title: "fix(daemon): tidy up widgets" };

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
    // ── (F) ownTipSubject/ownTipSubjectConventional for a TASKED worker (card a32533a1) ──────────────────
    // This worker's OWN tip commit ("add feature") is bare prose — never conventional — regardless of its
    // card title being already-conventional. Proves ownTipSubject tracks the BRANCH's own commit, not the
    // task title `commitSubject` above previews.
    check("(F) ownTipSubject === the branch's own tip commit (bare prose, NOT the card title)", review.ownTipSubject === "add feature");
    check("(F) ownTipSubjectConventional is false for the bare-prose tip commit", review.ownTipSubjectConventional === false);
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
    // Card 7a1a76e9 DoD-4: a taskless worker gets NO `commitSubject` (above) but DOES get
    // `tasklessSubjectPreview` — the branch's own tip commit ("orphan change", bare prose) coerced through
    // the SAME toConventionalSubject the eventual squash applies, so the preview is byte-for-byte what
    // will actually land, not the branch name (DEFECT 2's original bug) and not a fabricated placeholder.
    check("(D) tasklessSubjectPreview is the branch's tip commit, coerced (chore: prefix) — NOT the branch name",
      review?.tasklessSubjectPreview === "chore: orphan change");
  }

  // ── (G) NEGATIVE CONTROL for (F): TASKED worker whose OWN tip commit is ALREADY conventional form ──────
  initRepo(E.repo);
  {
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch;
    const ownSubject = "fix(daemon): repair the paste double-fire";
    commitChange(worktreePath, "paste2.ts", "export const v = 5;\n", ownSubject);
    seed(E, { withTask: true });

    const review = await sessions.reviewWorkerMerge(E.mgrId, E.workerId);
    // Card title ("Refresh the dashboard") is bare prose, so the SOLO preview still coerces to chore: —
    // proving ownTipSubjectConventional isn't just echoing `coerced`'s own verdict about the card title.
    check("(G) commitSubject (solo/card-title preview) is still coerced", review.coerced === true);
    check("(G) ownTipSubject === the branch's own tip commit, VERBATIM (not the card title, not re-coerced)", review.ownTipSubject === ownSubject);
    check("(G) ownTipSubjectConventional is TRUE for an already-conventional tip commit — proves the flag genuinely discriminates, not hardcoded false", review.ownTipSubjectConventional === true);
    // ── (J) SINGLE-commit branches must not get noisier: ownNonTipCommitSubjects absent ────────────────────
    check("(J) ownNonTipCommitSubjects is absent for a single-commit branch (no noisier than before this card)", review.ownNonTipCommitSubjects === undefined);
    check("(J) ownNonTipCommitSubjectsConventional is absent for a single-commit branch", review.ownNonTipCommitSubjectsConventional === undefined);
  }

  // ── (H) Card 591906ae — MULTI-commit branch, a NON-conventional NON-tip subject ─────────────────────────
  initRepo(H.repo);
  {
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    H.worktreePath = worktreePath; H.branch = branch;
    // Non-tip commit: bare prose (the defect this card exists to surface). Tip commit: conventional form —
    // deliberately, so a tip-only check (ownTipSubject/ownTipSubjectConventional) would wrongly read this
    // branch as clean, proving the new field catches what the old ones structurally cannot.
    commitChange(worktreePath, "widget.ts", "export const a = 1;\n", "tidy up widgets");
    commitChange(worktreePath, "widget2.ts", "export const b = 2;\n", "fix(daemon): finish widget tidy-up");
    seed(H, { withTask: true });

    const review = await sessions.reviewWorkerMerge(H.mgrId, H.workerId);
    check("(H) ownTipSubject is the branch's TIP commit (conventional) — the OLD field, still correct on its own", review.ownTipSubject === "fix(daemon): finish widget tidy-up");
    check("(H) ownTipSubjectConventional is TRUE for the tip — a tip-only check would wrongly call this branch clean", review.ownTipSubjectConventional === true);
    check("(H) ownNonTipCommitSubjects === [the bare-prose non-tip subject], oldest-first, tip excluded", Array.isArray(review.ownNonTipCommitSubjects) && review.ownNonTipCommitSubjects.length === 1 && review.ownNonTipCommitSubjects[0] === "tidy up widgets");
    check("(H) ownNonTipCommitSubjectsConventional is FALSE — the check actually fires red on the real non-tip defect", review.ownNonTipCommitSubjectsConventional === false);
    check("(H) ownNonTipCommitSubjectsTruncated is absent (well under the bound)", review.ownNonTipCommitSubjectsTruncated === undefined);
  }

  // ── (I) POSITIVE CONTROL for (H) — MULTI-commit branch where EVERY commit is already conventional ───────
  initRepo(I.repo);
  {
    const { worktreePath, branch } = await createWorktree(I.repo, I.projId, I.taskId);
    I.worktreePath = worktreePath; I.branch = branch;
    commitChange(worktreePath, "widget.ts", "export const a = 1;\n", "fix(daemon): start widget tidy-up");
    commitChange(worktreePath, "widget2.ts", "export const b = 2;\n", "fix(daemon): finish widget tidy-up");
    seed(I, { withTask: true });

    const review = await sessions.reviewWorkerMerge(I.mgrId, I.workerId);
    check("(I) ownNonTipCommitSubjects === [the ALREADY-conventional non-tip subject]", Array.isArray(review.ownNonTipCommitSubjects) && review.ownNonTipCommitSubjects.length === 1 && review.ownNonTipCommitSubjects[0] === "fix(daemon): start widget tidy-up");
    check("(I) ownNonTipCommitSubjectsConventional is TRUE — proves the flag isn't hardcoded false and genuinely discriminates on the non-tip commits' own form", review.ownNonTipCommitSubjectsConventional === true);
  }
} finally {
  db.close();
  for (const p of [A, B, C, D, E, H, I]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's review step now surfaces the exact prospective squash-commit subject " +
    "(already-conventional unchanged, legacy-bracket mapped, bare-prose chore:-prefixed, each with an " +
    "honest `coerced` flag), degrades cleanly (no fabricated subject) for a taskless worker, " +
    "worker_merge_confirm's own result echoes the identical subject that actually landed, and " +
    "ownTipSubject/ownTipSubjectConventional (card a32533a1) now surface the branch's OWN, uncoerced tip " +
    "commit subject for a TASKED worker too — the exact byte-for-byte subject a merge_batch would land, " +
    "genuinely discriminating conventional vs. non-conventional regardless of the card title's own form — " +
    "and ownNonTipCommitSubjects/ownNonTipCommitSubjectsConventional (card 591906ae) now surface a " +
    "multi-commit branch's OTHER commits too, genuinely firing red on a real non-conventional non-tip " +
    "subject even when the tip alone reads clean, while staying absent (no noisier) for the common " +
    "single-commit case."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
