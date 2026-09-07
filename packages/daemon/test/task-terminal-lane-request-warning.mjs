import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c4355598 (item (ii) of `889ae619`'s LEAD RULING): a `tasks_update`/`project_task_update` move INTO
// the board's terminal (done) lane names the SPECIFIC still-pending owner Request(s) connected to the
// card — id + actual question title, never a bare count or a generic "heads up" — and NEVER blocks the
// move (a specimen, card `3b2aa339`, is a terminal close that was CORRECT despite a pending Request).
//
// HERMETIC, claude-free — a REAL Db + the REAL updateProjectTask/createProjectTask functions (the exact
// backing code both the in-project tasks_update and the cross-project project_task_update share), no MCP
// router needed (mirrors task-update-trimmed-ack.mjs's style: call the business logic directly).
//
// Proves:
//   (1) terminal move + ONE pending Request → pendingRequestWarning: [{id, title}], write still lands.
//   (2) terminal move + NO pending Request → pendingRequestWarning key ABSENT (not present-but-empty).
//   (3) NON-terminal move (e.g. → "review") + a pending Request → pendingRequestWarning key ABSENT (this
//       fires ONLY on a move into terminal, never on every patch touching a card with a pending Request).
//   (4) terminal move + only an ANSWERED (non-pending) Request → pendingRequestWarning key ABSENT (only
//       state:"pending" rows count — positive control that (2)/(4)'s absence isn't a broken query: a
//       DIFFERENT still-pending row on the SAME task in the SAME test run (5) DOES surface).
//   (5) terminal move + TWO pending Requests → BOTH are named (never silently collapsed to one).
//   (6) NEVER BLOCKS: the column write actually lands (DB reflects the terminal columnKey) even while a
//       pending Request is being warned about.
//   (7) a patch that ALSO touches `body` (the full-Task return branch, not the trimmed ack) still carries
//       the warning — both of updateProjectTask's two return shapes are covered.
//   (8) Code Review follow-up: a board whose terminal column is NOT the literal string "done" (a
//       role:"terminal" column renamed to "shipped") — the warning fires on THAT key, proving the
//       implementation is genuinely role-derived (columnKeyForRole), not a hardcoded "done" comparison
//       every OTHER case here would equally pass under. Bonus: "done" itself is a plain unknown column on
//       that board and is correctly rejected.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-terminal-lane-request-warning.mjs
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-terminal-lane-warning-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

let qCounter = 0;
function insertQuestion(db, { projectId, taskId, title, state }) {
  const id = `q-${++qCounter}`;
  db.insertQuestion({
    id, sessionId: "mgr-1", projectId, type: "decision", title, body: "detail", options: null, recommendation: null,
    taskId, permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null, credentialEnvVar: null,
    state, chosenOption: state === "answered" ? "A" : null, note: null,
    createdAt: now, answeredAt: state === "answered" ? now : null, consumedAt: null,
  });
  return id;
}

try {
  const db = new Db(file);
  db.insertProject({ id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agent-1", projectId: "projA", name: "Manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "mgr-1", projectId: "projA", agentId: "agent-1", engineSessionId: "eng-1", title: null, cwd: "projA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // ===================== (1) terminal move + ONE pending Request =====================
  const card1 = createProjectTask(db, "projA", { title: "card with a pending ask", columnKey: "backlog" });
  const reqId1 = insertQuestion(db, { projectId: "projA", taskId: card1.id, title: "Should we ship option (a) or (b)?", state: "pending" });

  const moved1 = await updateProjectTask(db, "projA", card1.id, { columnKey: "done" });
  check("(1) terminal move: no error", !moved1.error);
  check("(1) pendingRequestWarning is present", Array.isArray(moved1.pendingRequestWarning));
  check("(1) pendingRequestWarning names exactly the one pending request", moved1.pendingRequestWarning?.length === 1);
  check("(1) pendingRequestWarning carries the request id", moved1.pendingRequestWarning?.[0]?.id === reqId1);
  check("(1) pendingRequestWarning carries the ACTUAL question title, not a generic label",
    moved1.pendingRequestWarning?.[0]?.title === "Should we ship option (a) or (b)?");
  check("(6) NEVER BLOCKS: the move actually landed despite the pending Request", db.getTask(card1.id).columnKey === "done");

  // ===================== (2) terminal move + NO pending Request =====================
  const card2 = createProjectTask(db, "projA", { title: "card with no requests at all", columnKey: "backlog" });
  const moved2 = await updateProjectTask(db, "projA", card2.id, { columnKey: "done" });
  check("(2) terminal move with nothing pending: no error", !moved2.error);
  check("(2) pendingRequestWarning key is ABSENT (not an empty array)", !("pendingRequestWarning" in moved2));
  check("(2) the move still landed", db.getTask(card2.id).columnKey === "done");

  // ===================== (3) NON-terminal move + a pending Request =====================
  const card3 = createProjectTask(db, "projA", { title: "card moving to review, not done", columnKey: "backlog" });
  insertQuestion(db, { projectId: "projA", taskId: card3.id, title: "Is this the right approach?", state: "pending" });
  const moved3 = await updateProjectTask(db, "projA", card3.id, { columnKey: "review" });
  check("(3) non-terminal move: no error", !moved3.error);
  check("(3) pendingRequestWarning key is ABSENT on a non-terminal move (fires only on terminal moves)", !("pendingRequestWarning" in moved3));
  check("(3) the move still landed on the requested (non-terminal) column", db.getTask(card3.id).columnKey === "review");

  // ===================== (4)/(5) only-answered vs. mixed answered+pending =====================
  const card4 = createProjectTask(db, "projA", { title: "card with an answered request only", columnKey: "backlog" });
  insertQuestion(db, { projectId: "projA", taskId: card4.id, title: "Already resolved question", state: "answered" });
  const moved4 = await updateProjectTask(db, "projA", card4.id, { columnKey: "done" });
  check("(4) terminal move with only an ANSWERED request: no error", !moved4.error);
  check("(4) pendingRequestWarning key is ABSENT — an answered request is not a pending ask", !("pendingRequestWarning" in moved4));

  // (5) POSITIVE CONTROL for (2)/(4)'s absence: the identical query shape, run against a card that DOES
  // have two genuinely pending requests, must find BOTH — proving the "absent" cases above are a real
  // zero, not a broken/always-empty filter.
  const card5 = createProjectTask(db, "projA", { title: "card with two pending requests", columnKey: "backlog" });
  const req5a = insertQuestion(db, { projectId: "projA", taskId: card5.id, title: "First pending question", state: "pending" });
  const req5b = insertQuestion(db, { projectId: "projA", taskId: card5.id, title: "Second pending question", state: "pending" });
  insertQuestion(db, { projectId: "projA", taskId: card5.id, title: "An already-answered one, excluded", state: "answered" });
  const moved5 = await updateProjectTask(db, "projA", card5.id, { columnKey: "done" });
  check("(5) terminal move with TWO pending requests: no error", !moved5.error);
  check("(5) pendingRequestWarning names BOTH pending requests, never collapsed to one", moved5.pendingRequestWarning?.length === 2);
  check("(5) pendingRequestWarning includes the first pending request's id+title",
    moved5.pendingRequestWarning?.some((r) => r.id === req5a && r.title === "First pending question"));
  check("(5) pendingRequestWarning includes the second pending request's id+title",
    moved5.pendingRequestWarning?.some((r) => r.id === req5b && r.title === "Second pending question"));
  check("(5) the answered request is excluded from the warning", !moved5.pendingRequestWarning?.some((r) => r.title.includes("excluded")));

  // ===================== (7) a patch that ALSO touches body (the full-Task return branch) =====================
  const card7 = createProjectTask(db, "projA", { title: "card edited + moved to done together", body: "original body", columnKey: "backlog" });
  const req7 = insertQuestion(db, { projectId: "projA", taskId: card7.id, title: "Still-open question on a body-editing move", state: "pending" });
  const moved7 = await updateProjectTask(db, "projA", card7.id, { columnKey: "done", body: "edited body" }, undefined, card7.version);
  check("(7) body+columnKey terminal move: no error", !moved7.error);
  check("(7) returns the FULL task (body-editing branch), body included", moved7.body === "edited body");
  check("(7) the full-Task return branch ALSO carries pendingRequestWarning", Array.isArray(moved7.pendingRequestWarning) && moved7.pendingRequestWarning.length === 1);
  check("(7) pendingRequestWarning on the full-Task branch names the right request", moved7.pendingRequestWarning?.[0]?.id === req7);

  // ===================== (8) a board whose terminal column is NOT named "done" =====================
  // Code Review follow-up: every prior case moves to the literal string "done" — a hardcoded
  // `patch.columnKey === "done"` implementation would pass all of them. This is the one case that can
  // actually distinguish that from the real, role-derived `columnKeyForRole(cols, "terminal")` behavior.
  db.insertProject({
    id: "projB", name: "Beta", repoPath: "C:/b", vaultPath: "C:/b",
    config: { kanbanColumns: [{ key: "inbox", label: "Inbox", role: "defaultLanding" }, { key: "doing", label: "Doing" }, { key: "shipped", label: "Shipped", role: "terminal" }] },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const card8 = createProjectTask(db, "projB", { title: "card on a renamed-terminal board", columnKey: "inbox" });
  const req8 = insertQuestion(db, { projectId: "projB", taskId: card8.id, title: "Still-open question on the renamed board", state: "pending" });
  const moved8 = await updateProjectTask(db, "projB", card8.id, { columnKey: "shipped" });
  check("(8) move to the RENAMED terminal column 'shipped': no error", !moved8.error);
  check("(8) pendingRequestWarning fires on the renamed terminal key, not just the literal 'done'",
    Array.isArray(moved8.pendingRequestWarning) && moved8.pendingRequestWarning.length === 1);
  check("(8) pendingRequestWarning names the right request on the renamed board", moved8.pendingRequestWarning?.[0]?.id === req8);
  check("(8) the move actually landed on 'shipped'", db.getTask(card8.id).columnKey === "shipped");
  // Bonus per the reviewer: the literal "done" is a plain unknown column on THIS board (it isn't one of
  // inbox/doing/shipped) — a hardcoded "done" implementation would have nothing to compare against here,
  // so this also cross-checks that the guard above (not just the warning) is genuinely board-relative.
  const badMove8 = await updateProjectTask(db, "projB", card8.id, { columnKey: "done" });
  check("(8) BONUS: the literal 'done' is correctly REJECTED as unknown on this board", typeof badMove8.error === "string");
  check("(8) BONUS: the rejected move left the card on 'shipped'", db.getTask(card8.id).columnKey === "shipped");

  db.close();
} finally {
  cleanupPathSync(file);
  cleanupPathSync(`${file}-wal`);
  cleanupPathSync(`${file}-shm`);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a tasks_update/project_task_update move into the board's terminal lane names every still-pending owner Request connected to the card (id + actual question title, never a bare count), fires ONLY on a genuine move into terminal (not on a non-terminal move, and not for an already-answered request), never blocks the move itself, the warning is carried on both of updateProjectTask's return shapes (trimmed ack and full Task), and — proven on a board whose terminal column is renamed away from the literal 'done' — the implementation is genuinely role-derived, not a hardcoded string comparison."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
