import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f75a2202: `Task.deferredUntilEvent`'s `kind:"request-answered"` axis used to have ZERO consumers
// (`packages/shared/src/types.ts` said so in its own doc) — a card could annotate itself
// `deferredUntilEvent:{kind:"request-answered", key:<questionId>}` and nothing would ever fire when that
// request was answered. Card `7762098b` sat `deferred:true` for three days after its named request was
// answered because of exactly this gap. This file proves the fix (option A: wire it) — the
// `requestAnsweredTriggerNotice` join function (orchestration/deferred-trigger-notice.ts), mirroring the
// existing `deferredTriggerNotice`/`gate-fail-naming` unit-test shape in deferred-trigger-notice.mjs —
// PLUS the real wiring at the REST answer route (gateway/server.ts's POST /api/questions/:id/answer),
// proven end-to-end through the real Fastify route via app.inject (not just the join function in
// isolation), since a join function that's never actually called from a real nudge site is exactly the
// "shipped a detector, nobody reads it" failure this card exists to close.
//
// Proves:
//   (1) requestAnsweredTriggerNotice: a task whose deferredUntilEvent.key matches the answered question id
//       produces the notice line, naming the request id and the card id.
//   (2) requestAnsweredTriggerNotice: BYTE-IDENTICAL ("") when no task matches at all.
//   (3) negative control — a task bound to a DIFFERENT request id does not fire for the answered one (and
//       DOES fire for its own, proving the miss is real selectivity, not a broken pattern).
//   (4) negative control — a task bound via kind:"gate-fail-naming" (not "request-answered") to the SAME
//       key never fires, mirroring deferred-trigger-notice.mjs's own (6) cross-kind check.
//   (5) multiple matching tasks each get their own line.
//   (6) END-TO-END: POST /api/questions/:id/answer (the real gateway route, via app.inject) appends the
//       notice to the SAME live push-nudge already sent to the asker, for a card bound to THIS request —
//       and does NOT mention a sibling card bound to a DIFFERENT, still-pending request (negative control
//       on the real route, not just the join function).
//
// Run: 1) build daemon (pnpm build), 2) node test/request-answered-trigger-notice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ratn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { requestAnsweredTriggerNotice } = await import("../dist/orchestration/deferred-trigger-notice.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── requestAnsweredTriggerNotice (hermetic unit layer) ───────────────────────────────────────────────
{
  const dir = mkdtempManaged("loom-ratn-db-");
  const db = new Db(path.join(dir, "ratn.db"));
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "RATN", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

  const QID_A = randomUUID();
  const QID_B = randomUUID();
  const QID_UNMATCHED = randomUUID();

  const matchTaskId = randomUUID();
  db.insertTask({ id: matchTaskId, projectId: projId, title: "deferred on a Request", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, deferred: true, deferredReason: `waiting on request ${QID_A}` });
  db.updateTask(matchTaskId, { deferredUntilEvent: { kind: "request-answered", key: QID_A } });

  const otherRequestTaskId = randomUUID();
  db.insertTask({ id: otherRequestTaskId, projectId: projId, title: "deferred on a DIFFERENT request", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: `waiting on request ${QID_B}` });
  db.updateTask(otherRequestTaskId, { deferredUntilEvent: { kind: "request-answered", key: QID_B } });

  const wrongKindTaskId = randomUUID();
  db.insertTask({ id: wrongKindTaskId, projectId: projId, title: "deferred on a gate, not a request", body: "", columnKey: "in_progress", position: 3, createdAt: now, updatedAt: now, deferred: true, deferredReason: "watching a gate fail" });
  db.updateTask(wrongKindTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: QID_A } }); // same STRING value as QID_A, wrong kind

  const plainTaskId = randomUUID();
  db.insertTask({ id: plainTaskId, projectId: projId, title: "an ordinary card, no annotation", body: "", columnKey: "in_progress", position: 4, createdAt: now, updatedAt: now });

  // (1) the matching task fires, naming the request id and the card id.
  const notice1 = requestAnsweredTriggerNotice(db, projId, QID_A);
  check("(1) the notice carries the loom tag", notice1.includes("[loom:deferred-trigger]"));
  check("(1) the notice names the answered request id", notice1.includes(QID_A));
  check("(1) the notice names the matching card id", notice1.includes(matchTaskId));
  check("(1) the notice does NOT mention the other-request or wrong-kind cards", !notice1.includes(otherRequestTaskId) && !notice1.includes(wrongKindTaskId));

  // (2) no task at all matches an unrelated request id ⇒ byte-identical "".
  const notice2 = requestAnsweredTriggerNotice(db, projId, QID_UNMATCHED);
  check("(2) no matching task ⇒ byte-identical empty string", notice2 === "");

  // (3) negative control: otherRequestTaskId is bound to QID_B, not QID_A — proven both ways (it fires
  // for ITS OWN key, and stays silent for QID_A), so the miss above is real selectivity, not a dead check.
  const notice3 = requestAnsweredTriggerNotice(db, projId, QID_B);
  check("(3) a task bound to its OWN request id DOES fire (positive control for the QID_A miss above)", notice3.includes(otherRequestTaskId));
  check("(3) ...and does not drag in the QID_A card", !notice3.includes(matchTaskId));

  // (4) negative control: kind:"gate-fail-naming" sharing the SAME key string as QID_A never fires for
  // the request-answered join — mirrors deferred-trigger-notice.mjs's own cross-kind check, inverted.
  check("(4) a wrong-kind task sharing the same key string is excluded from notice1 above", !notice1.includes(wrongKindTaskId));

  // (5) two independently-matching tasks (a second task also bound to QID_A) each get their own line.
  const secondMatchTaskId = randomUUID();
  db.insertTask({ id: secondMatchTaskId, projectId: projId, title: "also deferred on the same Request", body: "", columnKey: "in_progress", position: 5, createdAt: now, updatedAt: now, deferred: true, deferredReason: `also waiting on request ${QID_A}` });
  db.updateTask(secondMatchTaskId, { deferredUntilEvent: { kind: "request-answered", key: QID_A } });
  const notice5 = requestAnsweredTriggerNotice(db, projId, QID_A);
  const lines5 = notice5.split("\n").filter((l) => l.includes("[loom:deferred-trigger]"));
  check("(5) two independently-matching tasks produce TWO separate notice lines, never merged", lines5.length === 2);
  check("(5) both card ids are present", notice5.includes(matchTaskId) && notice5.includes(secondMatchTaskId));

  void plainTaskId; // seeded only to prove an ordinary card with no annotation is silently ignored throughout
  db.close();
}

// ── END-TO-END: the real REST answer route actually appends the notice ─────────────────────────────────
{
  const dir = mkdtempManaged("loom-ratn-e2e-");
  const db = new Db(path.join(dir, "ratn-e2e.db"));
  const now = new Date().toISOString();
  const projId = "ratn-e2e-proj";
  const agentId = "ratn-e2e-agent";
  db.insertProject({ id: projId, name: "RATN-E2E", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

  const mgrId = "ratn-e2e-mgr";
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-ratn", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // The question that's about to be answered — a card is bound to it below.
  const answeredQid = "ratn-e2e-q-answered";
  db.insertQuestion({
    id: answeredQid, sessionId: mgrId, projectId: projId, title: "Ship v2?", body: "b",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });
  // A SIBLING question that stays pending throughout — never answered in this test — so the task bound to
  // IT is the negative control: it must NOT be mentioned when the OTHER question above is answered.
  const stillPendingQid = "ratn-e2e-q-still-pending";
  db.insertQuestion({
    id: stillPendingQid, sessionId: mgrId, projectId: projId, title: "Roll back?", body: "b",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });

  const boundTaskId = "ratn-e2e-task-bound";
  db.insertTask({ id: boundTaskId, projectId: projId, title: "deferred on the request being answered", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, deferred: true, deferredReason: `waiting on request ${answeredQid}` });
  db.updateTask(boundTaskId, { deferredUntilEvent: { kind: "request-answered", key: answeredQid } });

  const siblingTaskId = "ratn-e2e-task-sibling";
  db.insertTask({ id: siblingTaskId, projectId: projId, title: "deferred on the STILL-PENDING request", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: `waiting on request ${stillPendingQid}` });
  db.updateTask(siblingTaskId, { deferredUntilEvent: { kind: "request-answered", key: stillPendingQid } });

  const enqueued = [];
  const pty = {
    enqueueStdin: (sessionId, text, source, _a, _b, kind, questionId) => {
      enqueued.push({ sessionId, text, source, kind, questionId });
      return { delivered: true };
    },
  };
  const app = await buildServer({
    db, pty, sessions: { killAllWorkers: () => 0 }, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {},
    userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  });
  try {
    const res = await app.inject({
      method: "POST", url: `/api/questions/${answeredQid}/answer`,
      payload: { note: "go ahead" },
    });
    check("(6) setup: the real answer route accepted the answer (200)", res.statusCode === 200);
    check("(6) setup: exactly one nudge was pushed", enqueued.length === 1);
    const nudgeText = enqueued[0]?.text ?? "";
    check("(6) the pushed nudge carries the base 'was answered' text unchanged", nudgeText.includes('Your question "Ship v2?" was answered'));
    check("(6) the pushed nudge carries the [loom:deferred-trigger] appendix", nudgeText.includes("[loom:deferred-trigger]"));
    check("(6) the appendix names the bound card", nudgeText.includes(boundTaskId));
    check("(6) NEGATIVE CONTROL: the appendix does NOT mention the sibling card bound to the still-pending request", !nudgeText.includes(siblingTaskId));
    check("(6) NEGATIVE CONTROL: the sibling's still-pending question was untouched", db.getQuestion(stillPendingQid).state === "pending");
  } finally {
    await app.close();
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — requestAnsweredTriggerNotice turns an answered request id into a per-matching-card [loom:deferred-trigger] line (byte-identical \"\" when nothing matches, selective against both a different request id and a different deferredUntilEvent.kind sharing the same key), and the real POST /api/questions/:id/answer route now appends it to the live push-nudge it already sends the asker — proven through the real Fastify route via app.inject, with a negative control showing a sibling card bound to a still-pending request is never mentioned."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
