import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Index-migration test for card db316c89 (a review finding: isQueuedMessageDelivered and
// listUnresolvedQueuedMessagesForWorker json_extract-SCAN every `session_message_delivered` row —
// measured 39-54ms synchronous event-loop block per call on a real backup, growing linearly with
// orchestration_events, on every drain/done-report/resume/recycle-carry).
//
// Like crash-recovery-events-index-migration.mjs, kind/detail_json are ORIGINAL orchestration_events
// columns (present since its very first CREATE TABLE) — the only pre/post difference a pre-fix DB has is
// the new partial index's ABSENCE, so a real pre-migration install is simulated by DROPPING it on an
// otherwise-real, populated Db and re-opening, rather than hand-rebuilding a legacy schema.
//
// Proves:
//   (1) a FRESH Db already carries idx_orch_events_delivered_msgid (no regression on new installs).
//   (2) with the index DROPPED (simulating a pre-fix DB) and the table populated, isQueuedMessageDelivered's
//       query is a bare SEARCH via idx_orch_events_kind (no msgid-specific index) — the actual cost: it
//       still has to walk every session_message_delivered row testing json_extract per row.
//   (3) re-opening (2)'s file via `new Db(path)` re-creates the index (idempotent CREATE INDEX IF NOT
//       EXISTS) with no throw, and isQueuedMessageDelivered's query plan now names the new index.
//   (4) listUnresolvedQueuedMessagesForWorker's anti-join subquery ALSO reports the new index (the
//       INDEXED BY hint in db.ts — sqlite's planner does not pick this index unassisted for that query
//       shape; see db.ts's own comment on those two call sites) and still returns exactly the correct,
//       genuinely-unresolved rows — the hint must not change the result, only the plan.
//   (5) idempotent: a 2nd re-open doesn't duplicate the index.
//
// Run: 1) build (turbo builds shared first), 2) node test/msgid-delivery-index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-msgid-index-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "msgid-index.db");
const planText = (rows) => rows.map((r) => r.detail).join(" | ");
const INDEX_NAME = "idx_orch_events_delivered_msgid";

let db;
try {
  const { Db } = await import("../dist/db.js");

  // ===== (1) a FRESH Db already carries the new partial index =====
  db = new Db(dbFile);
  {
    const raw = new Database(dbFile, { readonly: true });
    const names = raw.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    raw.close();
    check(`(1) a fresh Db already has ${INDEX_NAME}`, names.includes(INDEX_NAME));
  }

  // Populate: a worker with real delivered + queued/unresolved messages — mirrors the real shape a
  // drain/done-report/resume/recycle sees: many delivered markers (the scan cost), a handful queued, and
  // exactly one genuinely unresolved (never delivered) message for one worker.
  const WORKER_WITH_UNRESOLVED = "worker-unresolved";
  const WORKER_ALL_RESOLVED = "worker-all-resolved";
  const UNRESOLVED_MSG_ID = "msg-never-delivered";
  const DELIVERED_MSG_ID_A = "msg-delivered-a";
  const DELIVERED_MSG_ID_B = "msg-delivered-b";
  const N_DELIVERED_NOISE = 500; // bulk delivered rows the scan has to walk pre-fix
  {
    const insert = db.appendEvent.bind(db);
    for (let i = 0; i < N_DELIVERED_NOISE; i++) {
      insert({ id: randomUUID(), ts: `2026-01-01T00:00:00.000Z`, managerSessionId: "mgr", workerSessionId: `noise-${i}`, taskId: null, kind: "session_message_delivered", detail: { msgId: `noise-msg-${i}` } });
    }
    // worker-all-resolved: one queued message that HAS a matching delivered marker -> fully resolved
    insert({ id: randomUUID(), ts: `2026-01-01T00:00:01.000Z`, managerSessionId: "mgr", workerSessionId: WORKER_ALL_RESOLVED, taskId: null, kind: "session_message_queued", detail: { msgId: DELIVERED_MSG_ID_A } });
    insert({ id: randomUUID(), ts: `2026-01-01T00:00:02.000Z`, managerSessionId: "mgr", workerSessionId: WORKER_ALL_RESOLVED, taskId: null, kind: "session_message_delivered", detail: { msgId: DELIVERED_MSG_ID_A } });
    // worker-unresolved: one queued message with NO matching delivered marker -> genuinely unresolved,
    // plus one that DOES resolve, so the anti-join must distinguish the two on the SAME worker.
    insert({ id: randomUUID(), ts: `2026-01-01T00:00:03.000Z`, managerSessionId: "mgr", workerSessionId: WORKER_WITH_UNRESOLVED, taskId: null, kind: "session_message_queued", detail: { msgId: DELIVERED_MSG_ID_B } });
    insert({ id: randomUUID(), ts: `2026-01-01T00:00:04.000Z`, managerSessionId: "mgr", workerSessionId: WORKER_WITH_UNRESOLVED, taskId: null, kind: "session_message_delivered", detail: { msgId: DELIVERED_MSG_ID_B } });
    insert({ id: randomUUID(), ts: `2026-01-01T00:00:05.000Z`, managerSessionId: "mgr", workerSessionId: WORKER_WITH_UNRESOLVED, taskId: null, kind: "session_message_queued", detail: { msgId: UNRESOLVED_MSG_ID } });
  }
  db.close();

  // ===== (2) DROP the new index — simulates a real pre-fix DB (columns pre-date the fix; only the
  // index is new) — then confirm the pre-fix plan has no msgid-specific index at all. =====
  {
    const raw = new Database(dbFile);
    raw.exec(`DROP INDEX ${INDEX_NAME};`);
    const plan = raw.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_events WHERE kind = 'session_message_delivered' AND json_extract(detail_json, '$.msgId') = ? LIMIT 1",
    ).all(UNRESOLVED_MSG_ID);
    check("(2) pre-fix (index dropped): isQueuedMessageDelivered falls back to idx_orch_events_kind, not the msgid index", /USING INDEX idx_orch_events_kind/.test(planText(plan)) && !planText(plan).includes(INDEX_NAME));
    raw.close();
  }

  // ===== (3) re-open via `new Db(path)` — the idempotent CREATE INDEX IF NOT EXISTS must re-create it,
  // with no throw, and isQueuedMessageDelivered's query plan must now name the new index. =====
  const { Db: Db2 } = await import("../dist/db.js");
  let reopenError = null;
  let db2;
  try { db2 = new Db2(dbFile); } catch (e) { reopenError = e; }
  check("(3) re-opening the index-dropped file does NOT throw", reopenError === null);
  if (reopenError) console.log("    threw:", reopenError.stack || reopenError);

  if (!reopenError) {
    const raw = new Database(dbFile, { readonly: true });
    const names = raw.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    check(`(3) ${INDEX_NAME} is back after re-open`, names.includes(INDEX_NAME));

    const deliveredPlan = raw.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_events WHERE kind = 'session_message_delivered' AND json_extract(detail_json, '$.msgId') = ? LIMIT 1",
    ).all(UNRESOLVED_MSG_ID);
    check(`(3) isQueuedMessageDelivered's query now names ${INDEX_NAME}`, planText(deliveredPlan).includes(INDEX_NAME));

    // ===== (4) the anti-join subquery (listUnresolvedQueuedMessagesForWorker) ALSO names the new index
    // (the INDEXED BY hint) AND still returns exactly the correct rows. =====
    const subqueryPlan = raw.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM orchestration_events
         WHERE kind = 'session_message_queued'
           AND worker_session_id = ?
           AND COALESCE(json_extract(detail_json, '$.msgId'), '') NOT IN (
             SELECT COALESCE(json_extract(detail_json, '$.msgId'), '')
               FROM orchestration_events INDEXED BY ${INDEX_NAME}
               WHERE kind = 'session_message_delivered'
           )
       ORDER BY ts, rowid`,
    ).all(WORKER_WITH_UNRESOLVED);
    check(`(4) listUnresolvedQueuedMessagesForWorker's anti-join subquery names ${INDEX_NAME}`, planText(subqueryPlan).includes(INDEX_NAME));
    raw.close();

    const unresolvedForWorker = db2.listUnresolvedQueuedMessagesForWorker(WORKER_WITH_UNRESOLVED);
    check("(4) returns EXACTLY the one genuinely-unresolved message for that worker, not the resolved one too",
      unresolvedForWorker.length === 1 && unresolvedForWorker[0].detail.msgId === UNRESOLVED_MSG_ID);

    const resolvedForWorker = db2.listUnresolvedQueuedMessagesForWorker(WORKER_ALL_RESOLVED);
    check("(4) a worker whose only queued message already resolved returns nothing",
      resolvedForWorker.length === 0);

    check("(4) isQueuedMessageDelivered(genuinely undelivered) = false", db2.isQueuedMessageDelivered(UNRESOLVED_MSG_ID) === false);
    check("(4) isQueuedMessageDelivered(a real delivered msgId) = true", db2.isQueuedMessageDelivered(DELIVERED_MSG_ID_A) === true);

    const undelivered = db2.listUndeliveredQueuedMessages();
    check("(4) listUndeliveredQueuedMessages (unscoped) also surfaces exactly the one unresolved message",
      undelivered.length === 1 && undelivered[0].detail.msgId === UNRESOLVED_MSG_ID);

    // ===== (5) idempotent: a 3rd open doesn't duplicate the index =====
    const { Db: Db3 } = await import("../dist/db.js");
    const db3 = new Db3(dbFile);
    db3.close();
    const raw2 = new Database(dbFile, { readonly: true });
    const names2 = raw2.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    raw2.close();
    check(`(5) a 3rd open is idempotent — no duplicate ${INDEX_NAME}`,
      names2.filter((n) => n === INDEX_NAME).length === 1);

    db2.close();
  }
} finally {
  try { db?.close(); } catch { /* already closed */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — idx_orch_events_delivered_msgid lands on a fresh Db AND re-appears idempotently on a DB that predates it (simulated by dropping it over an otherwise-real, populated table); isQueuedMessageDelivered's and listUnresolvedQueuedMessagesForWorker's query plans both name the new index, and the anti-join still returns exactly the genuinely-unresolved rows, never the already-resolved ones."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
