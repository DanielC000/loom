import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 91fef05a — question_pull's BOUNDED, NO-LOSS pull-and-consume. Manager directive: unlike every
// other unbounded-response tool this card fixed, question_pull can't just spill an overflow to a scratch
// file — a row is CONSUMED (flipped to 'consumed', never re-pullable) the instant it's read, so a spilled
// pointer the caller's own note-reading missed would silently drop a live decision with no way to ever
// get it back. Fix: `db.pullAnsweredQuestionsForAgentBounded` (db.ts) flips to 'consumed' ONLY the
// oldest-first prefix of answered rows whose SERIALIZED size (via `questionPullItem`, the real
// agent-facing projection) stays within `QUESTION_PULL_BUDGET_CHARS` — always at least one row, even if
// it alone exceeds the budget — leaving every other row exactly 'answered' for a follow-up pull.
// `question_pull`'s response gains `remaining` (a count of untouched answered rows) and, when >0, a
// `note` telling the caller to pull again.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: a REAL Db + the REAL OrchestrationMcpRouter, driven directly via
// `_registeredTools[...].handler(...)` (mirrors question-inbox.mjs's (T) section) — no MCP transport
// needed for this level of test.
//
// Covers:
//   (A) many large answered rows ⇒ the FIRST pull returns a SUBSET (not all), `remaining>0`, a `note`;
//       the leftover rows are STILL 'answered' in the DB (never flipped) and their push-nudges are never
//       purged. A SECOND pull gets exactly the rest, `remaining:0`, no `note` — and nothing is ever
//       double-returned or dropped across the two pulls (the union is the full original set).
//   (B) ONE oversized single answer (its own serialized size alone exceeds the budget) is STILL delivered
//       inline in one pull and consumed — never withheld forever, never spilled.
//   (C) a normal SMALL corpus pulls everything in one call, `remaining:0`, no `note` — byte-identical to
//       the pre-this-card response shape apart from the new `remaining` field.
//   (D) the purge-nudges call only ever names the CONSUMED ids for that pull, never a `remaining` id.
// Run: 1) build (turbo builds shared first), 2) node test/question-pull-bounded.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-qpb-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { QUESTION_PULL_BUDGET_CHARS } = await import("../dist/mcp/questionTool.js");

function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = `${name}-proj`;
  const agentId = `${name}-agent`;
  const mgrId = `${name}-mgr`;
  db.insertProject({ id: projId, name: "QPB", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return { dbFile, db, projId, agentId, mgrId };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
function insertAnswered(e, id, note) {
  const now = new Date().toISOString();
  e.db.insertQuestion({
    id, sessionId: e.mgrId, projectId: e.projId, title: `q-${id}`, body: "b", options: null,
    recommendation: null, state: "answered", chosenOption: null, note, createdAt: now, answeredAt: now, consumedAt: null,
  });
}
const parse = (r) => JSON.parse(r.content[0].text);

try {
  // ============ (A) many large answered rows: first pull returns a subset + remaining + note ============
  {
    const e = mkDb("many");
    const purgeCalls = [];
    const router = new OrchestrationMcpRouter(e.db, { purgeAnsweredQuestionNudges(sessionId, ids) { purgeCalls.push({ sessionId, ids: [...ids] }); } });
    const server = router.buildServer(e.mgrId, "manager");
    const pull = async () => parse(await server._registeredTools["question_pull"].handler({}));

    const bigNote = "N".repeat(2000);
    const wantCount = Math.ceil(QUESTION_PULL_BUDGET_CHARS / 2000) + 5;
    const ids = Array.from({ length: wantCount }, (_, i) => `q-many-${i}`);
    for (const id of ids) insertAnswered(e, id, bigNote);

    const first = await pull();
    check("(A) fixture sanity: total answered rows exceed a single pull's budget", wantCount * (2000 + 60) > QUESTION_PULL_BUDGET_CHARS);
    check("(A) the first pull did NOT return every row", first.questions.length > 0 && first.questions.length < wantCount);
    check("(A) remaining > 0 on the first pull", first.remaining > 0 && first.remaining === wantCount - first.questions.length);
    check("(A) a note is present when remaining > 0", typeof first.note === "string" && first.note.includes("question_pull again"));
    check("(A) the returned entries' total serialized size stays within the budget", JSON.stringify(first.questions).length <= QUESTION_PULL_BUDGET_CHARS + 100);

    // Leftover rows are STILL 'answered' in the DB — never flipped, never lost.
    const firstIds = new Set(first.questions.map((q) => q.questionId));
    const leftoverIds = ids.filter((id) => !firstIds.has(id));
    check("(A) leftover rows are still 'answered' in the DB (not consumed)", leftoverIds.every((id) => e.db.getQuestion(id)?.state === "answered"));
    check("(A) the purge call only named the CONSUMED ids, never a leftover/remaining id", purgeCalls.length === 1 && purgeCalls[0].ids.length === first.questions.length && purgeCalls[0].ids.every((id) => firstIds.has(id)));

    // Second pull gets exactly the rest.
    const second = await pull();
    check("(B) the second pull returns exactly the leftover rows", second.questions.length === leftoverIds.length && second.questions.every((q) => leftoverIds.includes(q.questionId)));
    check("(B) remaining is 0 on the second (final) pull", second.remaining === 0);
    check("(B) no note when remaining is 0", second.note === undefined);
    check("(B) every leftover row is NOW 'consumed'", leftoverIds.every((id) => e.db.getQuestion(id)?.state === "consumed"));

    // Union of both pulls covers the whole original set exactly once — nothing dropped, nothing doubled.
    const unionIds = new Set([...first.questions.map((q) => q.questionId), ...second.questions.map((q) => q.questionId)]);
    check("(A+B) the union of both pulls is exactly the original set, no duplicates, nothing missing", unionIds.size === wantCount && ids.every((id) => unionIds.has(id)));

    // A THIRD pull (nothing left) returns empty, remaining:0, no note.
    const third = await pull();
    check("(A+B) a third pull (nothing left) returns an empty list, remaining:0", third.questions.length === 0 && third.remaining === 0 && third.note === undefined);

    cleanup(e);
  }

  // ============ (C) ONE oversized single answer is still delivered inline, never withheld ============
  {
    const e = mkDb("oversized");
    const router = new OrchestrationMcpRouter(e.db, { purgeAnsweredQuestionNudges() {} });
    const server = router.buildServer(e.mgrId, "manager");
    const pull = async () => parse(await server._registeredTools["question_pull"].handler({}));

    const hugeNote = "H".repeat(QUESTION_PULL_BUDGET_CHARS + 10000);
    insertAnswered(e, "q-huge", hugeNote);
    check("(C) fixture sanity: this ONE row's own serialized size alone exceeds the budget", JSON.stringify({ questionId: "q-huge", title: "q-q-huge", type: "decision", chosenOption: null, note: hugeNote }).length > QUESTION_PULL_BUDGET_CHARS);

    const result = await pull();
    check("(C) the oversized row is STILL delivered in one pull (never withheld)", result.questions.length === 1 && result.questions[0].questionId === "q-huge");
    check("(C) the oversized row's full note survived, untruncated (never spilled, never cut)", result.questions[0].note === hugeNote);
    check("(C) remaining is 0 (nothing else queued)", result.remaining === 0);
    check("(C) the oversized row was consumed", e.db.getQuestion("q-huge")?.state === "consumed");

    cleanup(e);
  }

  // ============ (D) a normal small corpus: byte-identical apart from the new remaining:0 field ============
  {
    const e = mkDb("small");
    const router = new OrchestrationMcpRouter(e.db, { purgeAnsweredQuestionNudges() {} });
    const server = router.buildServer(e.mgrId, "manager");
    const pull = async () => parse(await server._registeredTools["question_pull"].handler({}));

    insertAnswered(e, "q-small-1", "a small answer");
    insertAnswered(e, "q-small-2", "another small answer");
    const result = await pull();
    check("(D) a small corpus returns every row in one pull", result.questions.length === 2);
    check("(D) each entry's shape is unchanged (questionId/title/type/chosenOption/note)", result.questions.every((q) => "questionId" in q && "title" in q && "type" in q && "chosenOption" in q && "note" in q));
    check("(D) remaining is 0", result.remaining === 0);
    check("(D) no note field when remaining is 0", result.note === undefined);
    check("(D) both rows are now consumed", e.db.getQuestion("q-small-1")?.state === "consumed" && e.db.getQuestion("q-small-2")?.state === "consumed");

    cleanup(e);
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_pull is now a BOUNDED, NO-LOSS pull-and-consume: a batch too large to return inline in one call only consumes the prefix it actually delivers (oldest-first), leaving the rest exactly 'answered' (and still re-nudgeable) for a follow-up pull that returns the remainder exactly once; a single oversized answer is still delivered whole rather than withheld forever; a normal small corpus is unaffected apart from the new remaining:0 field."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
