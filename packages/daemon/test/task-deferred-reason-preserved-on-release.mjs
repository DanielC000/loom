import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1d27c3cd — `tasks_update(deferred:false)` also cleared `deferredReason`, with no way to recover
// it: on the DESIGNED, RECOMMENDED `deferredUntilTaskId` auto-release path (card 793ac76d), that meant a
// manager's written explanation of why a card was ever deferred was destroyed UNOBSERVED the moment the
// blocker merged. Fix: both release paths — the explicit manual `deferred:false` (updateProjectTask) and
// the auto-release (persistDeferredStateBestEffort) — now fold the outgoing `deferredReason` into the
// card's `body` as its own "**Previously deferred:**" paragraph BEFORE nulling the field, via the shared
// `foldReleasedDeferralIntoBody` helper (mcp/tasks.js).
//
// HERMETIC: a real Db (better-sqlite3) + a real temp git repo (execSync) for the auto-release scenario,
// driving the built business logic directly (dist/db.js + dist/mcp/tasks.js) — no daemon, no real claude.
// Mirrors task-defer-until.mjs's blocker-landing recipe and task-manual-deferral-reason.mjs's manual-path
// recipe exactly, so this file adds ONLY the reason-preservation assertions neither of those covers.
//
// Proves:
//   (1) NEGATIVE CONTROL / bug reproduction shape: without this fix, `deferred:false` clears
//       `deferredReason` to null and the body is untouched — the exact defect the card reports. This
//       file's own (2)/(4) below are the POSITIVE proof the fix closes that gap; see this file's run
//       notes (dispatched alongside the src change) for the RED-before-GREEN check against the pre-fix
//       dist build.
//   (2) MANUAL clear (deferred:true→false via updateProjectTask): deferredReason/deferredAt still reset
//       to null (unchanged contract, task-manual-deferral-reason.mjs's own (5)) — but the reason now
//       survives, folded into body as its own paragraph, persisted to the raw DB row.
//   (3) a manual clear on a card with NO reason (route-(a) deferral, or a deferral that never got one)
//       never fabricates a fold paragraph — body is untouched.
//   (4) AUTO-RELEASE (deferredUntilTaskId blocker merges, read via getProjectTask): the reason is folded
//       into body on the SAME read that clears deferred — proving the fix reaches the
//       persistDeferredStateBestEffort path, not just the manual-clear path in updateProjectTask.
//   (5) IDEMPOTENCE: a card that defers-with-reason, releases, re-defers-with-a-NEW-reason, and releases
//       AGAIN ends up with exactly ONE "Previously deferred" paragraph — the latest — never two.
//   (6) the fold preserves whatever else was already in the body (an unrelated paragraph survives,
//       untouched, alongside the new fold paragraph).
//
// Card 595fe28f — the fold FLATTENED a structured reason (headings, blank-line paragraphs) into one
// unreadable run-on blob, with `## heading` markers surviving as literal INLINE text. Fix: blank-line
// (paragraph) breaks inside the reason collapse to a single NEWLINE now, never a space, so every
// line/heading/section keeps its own physical line — this repo's own board renders `body` as plain
// pre-wrap TEXT (Board.tsx TaskDrawer / SessionTaskCard's ReadOnlyTaskDrawer), no markdown engine
// involved, so a real line break is the entire readability fix. This file adds:
//   (7) unit-level: a blank-line-separated heading is no longer glued inline to the prior sentence, and
//       NO blank line (`\n\n`) survives anywhere inside the folded note (the idempotence invariant this
//       function's whole design rests on — see its own doc comment).
//   (8) a REAL, multi-KB, structured reason (the literal `deferredReason` of live board card `66649a90`,
//       copied verbatim into fixtures/real-deferred-reason-specimen.txt) positive-controls the rendering
//       improvement, THEN re-verifies (5)'s idempotence claim with THIS multi-KB structured fold as the
//       PRIOR note being stripped on a second cycle — not just a short synthetic string — including a
//       fenced code block in the second reason, to check that formatting choice against a code fence too.
//   (9) DoD-5: this formatting change is character-count-NEUTRAL vs. the pre-fix (space-joined) fold —
//       it swaps space-separators for newline-separators 1-for-1, contributing zero net body growth.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferred-reason-preserved-on-release.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Safe even pre-fix, when DEFERRED_RELEASE_NOTE_PREFIX is undefined (not yet exported) — `String(undefined
// ?? "")` degrades to counting matches of an EMPTY pattern rather than throwing, so a RED run against the
// pre-fix build still prints a clean FAIL instead of crashing mid-script.
const escapeRegExp = (s) => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const countFoldParagraphs = (body) => (body.match(new RegExp(escapeRegExp(DEFERRED_RELEASE_NOTE_PREFIX), "g")) || []).length;

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask, foldReleasedDeferralIntoBody, DEFERRED_RELEASE_NOTE_PREFIX } =
  await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-reason-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-reason-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // ===== unit-level sanity on the helper itself: idempotent strip-then-append =====
  // Guarded rather than called unconditionally: pre-fix, `foldReleasedDeferralIntoBody` isn't exported
  // at all (undefined) — calling it directly would THROW and, since the finally block's db.close() never
  // ran, mask the real signal behind an unrelated EBUSY-on-unlink crash. Recording it as an ordinary
  // FAIL keeps the RED run's PASS/FAIL ledger clean and lets every later (real end-to-end) check still run.
  if (typeof foldReleasedDeferralIntoBody === "function") {
    const b0 = "Some existing body text.";
    const b1 = foldReleasedDeferralIntoBody(b0, "blocked on X", "2026-01-01T00:00:00.000Z");
    check("helper: appends a fresh fold paragraph", b1.includes("Some existing body text.") && b1.includes(DEFERRED_RELEASE_NOTE_PREFIX) && b1.includes("blocked on X"));
    const b2 = foldReleasedDeferralIntoBody(b1, "blocked on Y", "2026-02-01T00:00:00.000Z");
    check("helper: folding again REPLACES the prior fold, not stacks (exactly one fold paragraph survives)", countFoldParagraphs(b2) === 1);
    check("helper: the replaced fold carries the NEW reason", b2.includes("blocked on Y") && !b2.includes("blocked on X"));
    check("helper: unrelated original text still survives both folds", b2.includes("Some existing body text."));
  } else {
    check("helper: foldReleasedDeferralIntoBody is exported from mcp/tasks.js", false);
  }

  // ===== (2) MANUAL clear preserves the reason via fold-into-body =====
  const c2 = createProjectTask(db, "pRepo", { title: "manual deferral", body: "Original card description." });
  const setR2 = await updateProjectTask(db, "pRepo", c2.id, { deferred: true, deferredReason: "owner-gated: awaiting infra sign-off" });
  check("(2) setup: manual deferral with reason succeeds", !("error" in setR2));
  const clearR2 = await updateProjectTask(db, "pRepo", c2.id, { deferred: false });
  check("(2) clear succeeds", !("error" in clearR2));
  check("(2) deferredReason still resets to null in the response (unchanged contract)", clearR2.deferredReason === null);
  check("(2) deferredAt still resets to null in the response (unchanged contract)", clearR2.deferredAt === null);
  const raw2 = db.getTask(c2.id);
  check("(2) raw DB row: deferredReason/deferredAt both null", raw2.deferredReason === null && raw2.deferredAt === null);
  check("(2) raw DB row: body now carries the fold paragraph with the outgoing reason", raw2.body.includes(DEFERRED_RELEASE_NOTE_PREFIX) && raw2.body.includes("owner-gated: awaiting infra sign-off"));
  check("(2) raw DB row: original body content survives alongside the fold", raw2.body.includes("Original card description."));

  // ===== (3) a manual clear with NO reason to preserve never fabricates a fold paragraph =====
  const c3 = createProjectTask(db, "pRepo", { title: "route-a deferral, no reason", body: "Plain body." });
  const blocker3 = createProjectTask(db, "pRepo", { title: "blocker for c3" });
  await updateProjectTask(db, "pRepo", c3.id, { deferred: true, deferredUntilTaskId: blocker3.id });
  const clearR3 = await updateProjectTask(db, "pRepo", c3.id, { deferred: false });
  check("(3) clear succeeds", !("error" in clearR3));
  const raw3 = db.getTask(c3.id);
  check("(3) NO fold paragraph fabricated when there was no reason to save", !raw3.body.includes(DEFERRED_RELEASE_NOTE_PREFIX));
  check("(3) body untouched otherwise", raw3.body === "Plain body.");

  // ===== (4) AUTO-RELEASE preserves the reason (persistDeferredStateBestEffort, via getProjectTask) =====
  const blocker4 = createProjectTask(db, "pRepo", { title: "blocker card 4" });
  const c4 = createProjectTask(db, "pRepo", { title: "auto-released deferral", body: "Card 4 description." });
  await updateProjectTask(db, "pRepo", c4.id, { deferred: true, deferredUntilTaskId: blocker4.id, deferredReason: "blocked on 4's prerequisite" });
  const preRelease4 = db.getTask(c4.id);
  check("(4) setup: deferredReason recorded before release", preRelease4.deferredReason === "blocked on 4's prerequisite");
  landBlocker(blocker4.id, "feat(x): blocker 4 landed");
  const got4 = await getProjectTask(db, "pRepo", c4.id);
  check("(4) auto-clears to deferred:false on this read", got4.deferred === false);
  const raw4 = db.getTask(c4.id);
  check("(4) raw DB row: deferredReason nulled (unchanged auto-release contract)", raw4.deferredReason === null);
  check("(4) raw DB row: body now carries the fold paragraph with the auto-released reason", raw4.body.includes(DEFERRED_RELEASE_NOTE_PREFIX) && raw4.body.includes("blocked on 4's prerequisite"));
  check("(4) raw DB row: original body content survives alongside the fold", raw4.body.includes("Card 4 description."));

  // ===== (4b) same, but discovered via listProjectTasks instead of getProjectTask =====
  const blocker4b = createProjectTask(db, "pRepo", { title: "blocker card 4b" });
  const c4b = createProjectTask(db, "pRepo", { title: "auto-released via list", body: "Card 4b description." });
  await updateProjectTask(db, "pRepo", c4b.id, { deferred: true, deferredUntilTaskId: blocker4b.id, deferredReason: "blocked on 4b's prerequisite" });
  landBlocker(blocker4b.id, "feat(y): blocker 4b landed");
  await listProjectTasks(db, "pRepo", { includeBody: true });
  const raw4b = db.getTask(c4b.id);
  check("(4b) listProjectTasks AS the discovering read also folds the reason into body", raw4b.body.includes(DEFERRED_RELEASE_NOTE_PREFIX) && raw4b.body.includes("blocked on 4b's prerequisite"));

  // ===== (5) IDEMPOTENCE across a real defer→release→re-defer→release cycle: exactly one fold paragraph =====
  const c5 = createProjectTask(db, "pRepo", { title: "repeated defer/release cycles", body: "Card 5 description." });
  await updateProjectTask(db, "pRepo", c5.id, { deferred: true, deferredReason: "first parking reason" });
  await updateProjectTask(db, "pRepo", c5.id, { deferred: false });
  const raw5First = db.getTask(c5.id);
  check("(5) first cycle: fold paragraph present with the first reason", raw5First.body.includes("first parking reason"));
  await updateProjectTask(db, "pRepo", c5.id, { deferred: true, deferredReason: "second parking reason, different from the first" });
  await updateProjectTask(db, "pRepo", c5.id, { deferred: false });
  const raw5Second = db.getTask(c5.id);
  check("(5) after a SECOND defer/release cycle, exactly ONE fold paragraph survives (no pile-up)", countFoldParagraphs(raw5Second.body) === 1);
  check("(5) the surviving fold carries the SECOND (latest) reason", raw5Second.body.includes("second parking reason, different from the first"));
  check("(5) the FIRST reason is gone from the surviving fold (replaced, not appended)", !raw5Second.body.includes("first parking reason"));
  check("(5) original card body content still present", raw5Second.body.includes("Card 5 description."));

  // ===== (7) unit-level: blank-line breaks become a single newline, never a space; no \n\n survives =====
  const structuredReason = "Intro paragraph.\n\n## A Heading\nBody line under the heading.\n\n## Another Heading\nMore body.";
  const noteOnly = foldReleasedDeferralIntoBody("", structuredReason, "2026-01-01T00:00:00.000Z");
  check("(7) a blank-line-separated heading is on its OWN line, not glued inline to the prior sentence", /\n## A Heading/.test(noteOnly));
  check("(7) the second heading is likewise on its own line", /\n## Another Heading/.test(noteOnly));
  check("(7) the old bug shape (heading glued after a single space) is gone", !noteOnly.includes(". ## A Heading") && !noteOnly.includes(". ## Another Heading"));
  check("(7) NO blank line (\\n\\n) survives anywhere inside the folded note — the idempotence invariant", !/\n\n/.test(noteOnly));

  // ===== (8) REAL, multi-KB, structured reason: positive control + idempotence with a MULTI-KB prior fold =====
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const realReason1 = fs.readFileSync(path.join(fixturesDir, "real-deferred-reason-specimen.txt"), "utf8");
  check("(8) setup: the real specimen is genuinely multi-KB and structured (sanity on the fixture itself)", realReason1.length > 2000 && (realReason1.match(/^## /gm) || []).length >= 3);

  const c8 = createProjectTask(db, "pRepo", { title: "real multi-KB structured deferral", body: "Card 8 description." });
  await updateProjectTask(db, "pRepo", c8.id, { deferred: true, deferredReason: realReason1 });
  await updateProjectTask(db, "pRepo", c8.id, { deferred: false });
  const raw8First = db.getTask(c8.id);
  check("(8) first cycle: real specimen's headings survive on their own line, not run into the prior line", /\n## 🎯 THE RELEASE CONDITION/.test(raw8First.body) && /\n## 🔴 READ §COLD-START/.test(raw8First.body));
  const note8First = raw8First.body.slice(raw8First.body.indexOf(DEFERRED_RELEASE_NOTE_PREFIX));
  check("(8) first cycle: no blank line survives inside the multi-KB folded note", !/\n\n/.test(note8First));

  // Re-defer with a DIFFERENT structured reason — deliberately including a FENCED CODE BLOCK, per the
  // kickoff's specific instruction to check what this formatting choice does to one — then release again.
  // What matters for DoD-3 is that the PRIOR fold being stripped here is the multi-KB real specimen above,
  // not a short string: that's the case the existing (pre-595fe28f) test never exercised.
  const reason2Lines = [
    "Second parking reason, different from the first, with a fenced code block.",
    "",
    "## A Section With Code",
    "Some explanation text before the block.",
    "",
    "```",
    "line one -> value",
    "line two -> other value",
    "```",
    "",
    "Text after the code block, on its own paragraph.",
    "",
    "## Another Section",
    "Final notes here explaining the second pass.",
  ];
  const reason2 = reason2Lines.join("\n");
  await updateProjectTask(db, "pRepo", c8.id, { deferred: true, deferredReason: reason2 });
  await updateProjectTask(db, "pRepo", c8.id, { deferred: false });
  const raw8Second = db.getTask(c8.id);
  check("(8) after a SECOND cycle whose PRIOR fold was multi-KB and structured, exactly ONE fold paragraph survives (no pile-up)", countFoldParagraphs(raw8Second.body) === 1);
  check("(8) the surviving fold carries the SECOND (latest) reason's headings, each on its own line", /\n## A Section With Code/.test(raw8Second.body) && /\n## Another Section/.test(raw8Second.body));
  check("(8) the FIRST (multi-KB) reason's content is gone from the surviving fold (replaced, not appended)", !raw8Second.body.includes("THE RELEASE CONDITION") && !raw8Second.body.includes("READ §COLD-START"));
  check("(8) the fenced code block survives intact, bounded by single newlines, not globbed into one run-on line", raw8Second.body.includes("```\nline one -> value\nline two -> other value\n```"));
  const note8Second = raw8Second.body.slice(raw8Second.body.indexOf(DEFERRED_RELEASE_NOTE_PREFIX));
  check("(8) second cycle: no blank line survives inside the new folded note either", !/\n\n/.test(note8Second));
  check("(8) original card body content still present", raw8Second.body.includes("Card 8 description."));

  // ===== (9) DoD-5: this formatting change is character-count-NEUTRAL vs. the pre-fix (space-joined) fold =====
  // The pre-fix formula joined the note's 3 segments (prefix / reason / cleared-suffix) with a single
  // SPACE, and collapsed each blank-line run inside the reason to a single SPACE too. This fix swaps
  // every one of those space-separators for a single NEWLINE — same separator COUNT, same 1-char width —
  // so the folded note's total character count is unchanged. Concrete answer to the card's DoD-5: this
  // card's own formatting change contributes ZERO net bytes beyond what the existing fold already writes;
  // whatever body-size growth exists from folding a whole reason into body is 1d27c3cd's own accepted
  // cost, not something this card adds on top of it.
  const legacyFold = (reason, releasedAt) => `${DEFERRED_RELEASE_NOTE_PREFIX} ${reason.replace(/\s*\n{2,}\s*/g, " ").trim()} _(cleared ${releasedAt})_`;
  const legacyNote = legacyFold(realReason1, "2026-01-01T00:00:00.000Z");
  const newNote = foldReleasedDeferralIntoBody("", realReason1, "2026-01-01T00:00:00.000Z");
  check("(9) DoD-5: the new (newline) formatting is character-count-NEUTRAL vs. the old (space) formatting — zero net growth added by this card", legacyNote.length === newNote.length);

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a released deferral's reason (manual clear or auto-release alike) is folded into the card body as a closure record before the field is nulled, survives alongside the rest of the body, is never fabricated when there was no reason, and stays idempotent (exactly one, the latest) across repeated defer/release cycles."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
