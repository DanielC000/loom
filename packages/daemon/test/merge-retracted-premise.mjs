import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// RETRACTED-PREMISE merge-review backstop test (card cf60a32a — the mechanical half of `0fa32321`; doctrine
// half merged as `514da7cf`; NARROWED to a line-anchored marker by card `637558ca`). REAL git on temp
// repos, NO claude and NO live daemon — drives SessionService.reviewWorkerMerge() directly against an
// isolated LOOM_HOME (mirrors merge-deny-glob.mjs's and merge-review-commit-subject.mjs's in-process style).
//
// THE GAP IT GUARDS: card title = squash-commit subject on this project. When a card's premise is
// retracted (the "bug" proved not to exist) but its branch still merges (usually to salvage a regression
// test as free coverage), the retracted claim becomes PERMANENT MAINLINE HISTORY unless the title is
// retitled first. `b88704bb`'s `coerced` flag is CATEGORICALLY BLIND to this: it only fires when
// `toConventionalSubject` REWRITES the title, and a title like `fix(x): ...` is already valid Conventional
// form, so `coerced` reads false on exactly the case this backstop exists to catch. This proves the new,
// separate `matchRetractedPremiseTitle`-driven warning fires on body-vs-title CONTENT instead.
//
// CARD `637558ca`: the ORIGINAL predicate was a bare case-insensitive `\bretracted\b` substring match over
// the whole body — it fired on two LIVE false positives from unrelated prose senses of the word (card
// `e7bcb0df`'s "the retracted count-floor idea", a discarded design option; card `66d91a11`'s "...and
// retracted before I'd checked", a person retracting a belief). The fix requires the marker to stand ALONE
// on its own line (see `lineAnchoredMarker` in worktrees.ts) — a deliberate declaration, not any mention of
// the word anywhere in the body. This file proves all THREE directions together so they can't drift apart:
//   - POSITIVE CONTROL: a genuine standalone marker line + `fix(` title still fires.
//   - NEGATIVE CONTROLS: both live false positives, verbatim, no longer fire.
//
// Proves (the DoD's 4 named cases):
//   (A) MATCH — title starts with `fix(` and the body carries a standalone retraction marker line:
//       reviewWorkerMerge surfaces a "RETRACTED-PREMISE" warning clause; subjectPreview fields
//       (rawTitle/commitSubject/coerced) are UNAFFECTED (coerced stays false — proving b88704bb's fields
//       are untouched by this check).
//   (B) NO-MATCH — an unmatched card (fix( title, body with no marker; and separately a non-`fix(` title
//       whose body DOES carry a marker word, but not as its own line) produces a result with no
//       RETRACTED-PREMISE clause, no warning at all.
//   (C) MISSING TASK — a taskless worker (no taskId at all): no warning, no throw — fails safe.
//   (D) EXISTING WARNINGS INTACT — a branch that ALSO trips the deny-glob warning composes both clauses in
//       one `warning` string; subjectPreview is still correct alongside it.
//
// Also exercises the pure matcher directly (no git, cheap) for the marker-variant + edge-case surface
// (case sensitivity, apostrophe variants, no-body, no-title-prefix, the two live false positives) that the
// integration cases above don't each need their own temp repo for.
// Run: 1) build daemon (pnpm build), 2) node test/merge-retracted-premise.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrp-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, matchRetractedPremiseTitle } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrp@loom -c user.name=mrp";
const now = new Date().toISOString();

// ── Pure-matcher checks (no git, no DB) ───────────────────────────────────────────────────────────────────
// POSITIVE CONTROL FIRST (DoD item 2) — a genuine, DELIBERATELY-DECLARED retraction (its own standalone
// line, as the narrowed predicate now requires) must still fire. Shown BEFORE the negative controls so a
// reader can see the check is capable of a match at all before trusting its zeros below.
check("matcher: fix( title + standalone 'RETRACTED' heading line -> matches (POSITIVE CONTROL)",
  matchRetractedPremiseTitle("fix(orchestration): nudge text",
    "## Root cause\n\nRETRACTED\n\nThe premise never held up under real load — keeping the added regression test as coverage.") === "retracted");
check("matcher: fix( title + standalone \"WON'T-DO\" heading line -> matches",
  matchRetractedPremiseTitle("fix(daemon): thing", "## WON'T-DO\n\nClosing this — it was never real.") === "won't-do");
check("matcher: fix( title + standalone 'NOT A BUG' line -> matches",
  matchRetractedPremiseTitle("fix(daemon): thing", "NOT A BUG\n\nTurns out this is expected behavior.") === "not a bug");
check("matcher: fix( title + unrelated body -> null",
  matchRetractedPremiseTitle("fix(daemon): thing", "Implemented the fix as described.") === null);
check("matcher: fix( title + incidental 'retract' (not 'retracted') -> null (narrow, not substring-y)",
  matchRetractedPremiseTitle("fix(daemon): thing", "We may need to retract this claim later.") === null);
check("matcher: non-fix( title (already feat() + standalone marker line -> null (title gate)",
  matchRetractedPremiseTitle("feat(daemon): thing", "RETRACTED") === null);
check("matcher: bare-prose title (no type at all) + standalone marker line -> null",
  matchRetractedPremiseTitle("Refresh the dashboard", "RETRACTED") === null);
check("matcher: empty body -> null, no throw",
  matchRetractedPremiseTitle("fix(daemon): thing", "") === null);

// NEGATIVE CONTROLS (DoD item 3) — the two LIVE false positives that motivated this card, VERBATIM, must
// no longer fire now the marker must stand on its own line.
const FP1_E7BCB0DF = "⚠️ This is a floor on the instrument's INPUT, not on the measurement — " +
  "categorically different from the retracted count-floor idea (which failed because executed-test count " +
  "doesn't track coverage).";
check("matcher: live FP e7bcb0df ('...the retracted count-floor idea...', mid-sentence, a discarded design option) -> null",
  matchRetractedPremiseTitle("fix(daemon): the underscore-prefixed directory GAP 2 fix", FP1_E7BCB0DF) === null);

const FP2_66D91A11 = "The Codescape peer did it for three failures, then caught themselves — 'I never " +
  "established WHEN that number is sampled' — and retracted before I'd checked.";
check("matcher: live FP 66d91a11 ('...and retracted before I'd checked', mid-sentence, a person retracting a belief) -> null",
  matchRetractedPremiseTitle("fix(sessions): the gate detail renders concurrentAtStart as bare \"concurrent=\"", FP2_66D91A11) === null);

// The two negative controls above are only meaningful if this exact check CAN return non-null on a body
// that also contains that same false-positive prose — prove it's not vacuously silent by adding a real
// standalone marker line alongside each FP's prose and confirming it now DOES match.
check("matcher: FP1's prose PLUS a real standalone marker line elsewhere -> matches (control isn't vacuous)",
  matchRetractedPremiseTitle("fix(daemon): thing", `${FP1_E7BCB0DF}\n\nRETRACTED\n\nExplanation.`) === "retracted");
check("matcher: FP2's prose PLUS a real standalone marker line elsewhere -> matches (control isn't vacuous)",
  matchRetractedPremiseTitle("fix(daemon): thing", `${FP2_66D91A11}\n\nRETRACTED\n\nExplanation.`) === "retracted");

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p, { withTask, denyGlobs } = {}) {
  db.insertProject({ id: p.projId, name: "MRP", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null, ...(denyGlobs !== undefined ? { denyGlobs } : {}) });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  if (withTask !== false) {
    db.insertTask({ id: p.taskId, projectId: p.projId, title: p.title, body: p.body ?? "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  }
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: withTask !== false ? p.taskId : null, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mrp\n");
  execSync(`git init -q && git config user.email mrp@loom && git config user.name mrp && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function commitChange(worktreePath, file, content, msg) {
  fs.writeFileSync(path.join(worktreePath, file), content);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${msg}"`, { cwd: worktreePath });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const A = { projId: `mrp-a-proj-${sfx}`, agentId: `mrp-a-top-${sfx}`, taskId: `mrp-a-task-${sfx}`, mgrId: `mrp-a-mgr-${sfx}`, workerId: `mrp-a-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrp-match-${sfx}`), title: "fix(orchestration): the idle-watchdog nudge lacks the card id", body: "## Root cause was wrong\n\nRETRACTED\n\nThe original bug never reproduced under real load — keeping the added regression test as coverage." };
const B1 = { projId: `mrp-b1-proj-${sfx}`, agentId: `mrp-b1-top-${sfx}`, taskId: `mrp-b1-task-${sfx}`, mgrId: `mrp-b1-mgr-${sfx}`, workerId: `mrp-b1-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrp-nomarker-${sfx}`), title: "fix(daemon): paste double-fires on rapid Ctrl-V", body: "Straightforward reproduction and fix, see the diff." };
const B2 = { projId: `mrp-b2-proj-${sfx}`, agentId: `mrp-b2-top-${sfx}`, taskId: `mrp-b2-task-${sfx}`, mgrId: `mrp-b2-mgr-${sfx}`, workerId: `mrp-b2-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrp-notitle-${sfx}`), title: "test(daemon): regression coverage for the nudge text (premise retracted, not a bug)", body: "premise retracted, not a bug — see title." };
const C = { projId: `mrp-c-proj-${sfx}`, agentId: `mrp-c-top-${sfx}`, taskId: `mrp-c-task-${sfx}`, mgrId: `mrp-c-mgr-${sfx}`, workerId: `mrp-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrp-taskless-${sfx}`) };
const D = { projId: `mrp-d-proj-${sfx}`, agentId: `mrp-d-top-${sfx}`, taskId: `mrp-d-task-${sfx}`, mgrId: `mrp-d-mgr-${sfx}`, workerId: `mrp-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mrp-composed-${sfx}`), title: "fix(daemon): the retitle warning is missing", body: "WON'T-DO\n\nClosing this — the premise didn't hold up. Merging only to keep the added regression test as coverage." };

try {
  // ── (A) MATCH: fix( title + a standalone retraction marker line in the body ─────────────────────────────
  initRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    commitChange(worktreePath, "watchdog.ts", "export const x = 1;\n", "keep regression test");
    seed(A, { withTask: true });

    const review = await sessions.reviewWorkerMerge(A.mgrId, A.workerId);
    check("(A) reviewWorkerMerge surfaces a RETRACTED-PREMISE warning", typeof review.warning === "string" && /RETRACTED-PREMISE/.test(review.warning));
    check("(A) warning tells the manager to retitle before confirming", /retitle before confirming/.test(review.warning));
    check("(A) subjectPreview.rawTitle is unaffected", review.rawTitle === A.title);
    check("(A) subjectPreview.commitSubject is unaffected (already conventional, unchanged)", review.commitSubject === A.title);
    check("(A) subjectPreview.coerced stays FALSE — b88704bb's fields are blind to this case, untouched by ours", review.coerced === false);
    check("(A) diff fields still reflect the real branch diff", review.filesChanged === 1);
  }

  // ── (B1) NO-MATCH: fix( title, body carries no retraction marker -> byte-identical to today ─────────────
  initRepo(B1.repo);
  {
    const { worktreePath, branch } = await createWorktree(B1.repo, B1.projId, B1.taskId);
    B1.worktreePath = worktreePath; B1.branch = branch;
    commitChange(worktreePath, "paste.ts", "export const y = 2;\n", "fix paste");
    seed(B1, { withTask: true });

    const review = await sessions.reviewWorkerMerge(B1.mgrId, B1.workerId);
    check("(B1) no warning at all when the body carries no marker", review.warning === undefined);
    check("(B1) subjectPreview fields still present and correct", review.rawTitle === B1.title && review.commitSubject === B1.title && review.coerced === false);
  }

  // ── (B2) NO-MATCH: title does NOT start with fix( (even though title+body mention the marker words) ─────
  initRepo(B2.repo);
  {
    const { worktreePath, branch } = await createWorktree(B2.repo, B2.projId, B2.taskId);
    B2.worktreePath = worktreePath; B2.branch = branch;
    commitChange(worktreePath, "test-nudge.ts", "export const z = 3;\n", "add regression test");
    seed(B2, { withTask: true });

    const review = await sessions.reviewWorkerMerge(B2.mgrId, B2.workerId);
    check("(B2) no warning when the title is already retitled off fix(", review.warning === undefined);
  }

  // ── (C) MISSING TASK: a taskless worker -> no warning, no throw, fails safe ──────────────────────────────
  initRepo(C.repo);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, "mrp-c-orphan-task");
    C.worktreePath = worktreePath; C.branch = branch;
    commitChange(worktreePath, "orphan.ts", "export const w = 4;\n", "orphan change");
    seed(C, { withTask: false });

    let reviewError = null;
    let review;
    try {
      review = await sessions.reviewWorkerMerge(C.mgrId, C.workerId);
    } catch (err) {
      reviewError = err;
    }
    check("(C) reviewWorkerMerge does not throw for a taskless (missing-task) worker", reviewError === null);
    if (reviewError) console.log(`    threw: ${reviewError?.stack || reviewError}`);
    check("(C) no warning at all for a missing task", review?.warning === undefined);
    check("(C) no subjectPreview fields fabricated either", review?.rawTitle === undefined && review?.commitSubject === undefined && review?.coerced === undefined);
  }

  // ── (D) EXISTING WARNINGS INTACT: composes with the deny-glob warning in the same `warning` string ───────
  initRepo(D.repo);
  {
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch;
    fs.mkdirSync(path.join(worktreePath, "mockups"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "mockups", "direction-1.html"), "<html></html>\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "add mockup + keep regression test"`, { cwd: worktreePath });
    seed(D, { withTask: true }); // default denyGlobs (mockups/**)

    const review = await sessions.reviewWorkerMerge(D.mgrId, D.workerId);
    check("(D) RETRACTED-PREMISE warning present", /RETRACTED-PREMISE/.test(review.warning ?? ""));
    check("(D) DENY-GLOB warning ALSO present in the same warning string", /DENY-GLOB/.test(review.warning ?? ""));
    check("(D) merge_request event still carries deniedAdds:1 (unaffected by our check)",
      db.listEvents(D.mgrId).some((e) => e.kind === "merge_request" && e.detail?.deniedAdds === 1));
    check("(D) subjectPreview still correct alongside the composed warnings", review.rawTitle === D.title && review.commitSubject === D.title && review.coerced === false);
  }
} finally {
  db.close();
  for (const p of [A, B1, B2, C, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge's review step flags a fix( titled card whose body carries a STANDALONE " +
    "retraction marker line with a RETRACTED-PREMISE warning (never a block), no longer fires on either live " +
    "false positive (mid-sentence mentions of \"retract(ed)\"), stays silent on an unmatched card or a " +
    "missing/unreadable task, and composes cleanly alongside the existing STRANDED/STALE-BASE/DENY-GLOB " +
    "warnings and b88704bb's subject-preview fields."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
