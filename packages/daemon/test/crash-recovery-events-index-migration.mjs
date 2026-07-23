import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Index-migration test for card bf0b902c (crash-recovery watcher blocked the event loop ~8s/tick): proves
// idx_orch_events_worker + idx_orch_events_kind actually land and actually change the query plan.
//
// Unlike an ADD-COLUMN migration (see deny-globs-migration.mjs), worker_session_id/ts/kind are ORIGINAL
// orchestration_events columns present since its very first CREATE TABLE — the ONLY pre/post difference a
// pre-fix DB has is the two indexes' ABSENCE, so we simulate "a real pre-migration install" by DROPPING
// both new indexes on an otherwise-real, already-populated Db and re-opening, rather than hand-rebuilding
// an entire legacy schema by hand (nothing else about the table's shape changed). This was ALSO verified
// by hand against a WAL-safe backup of a real production ~/.loom/loom.db (17.8k events / 2559 sessions)
// per verify-schema-change-against-upgraded-db — see the worker report for bf0b902c for those numbers;
// this file is the hermetic, CI-safe regression guard.
//
// Proves:
//   (1) a FRESH Db already carries both new indexes (no future regression on new installs).
//   (2) with the indexes DROPPED (simulating a pre-fix DB) and the table populated, listEventsForWorker's
//       query is a SCAN + a TEMP B-TREE sort — the actual bug, not an assumed one.
//   (3) re-opening (2)'s file via `new Db(path)` re-creates BOTH indexes (the idempotent CREATE INDEX IF
//       NOT EXISTS in exec(SCHEMA)) with NO throw, and the SAME query is now an indexed SEARCH with no
//       separate sort step (sqlite's implicit trailing rowid on every index entry already satisfies
//       ORDER BY ts, rowid).
//   (4) the new candidate-derivation query (Db.listWorkerSessionIdsWithEventKind) is ALSO an indexed
//       SEARCH via idx_orch_events_kind, and returns exactly the distinct session ids that recorded a
//       trigger kind — not every session in the table.
//   (5) idempotent: a 2nd re-open doesn't duplicate the indexes.
//
// Run: 1) build (turbo builds shared first), 2) node test/crash-recovery-events-index-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-crw-index-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "crw-index.db");
const planText = (rows) => rows.map((r) => r.detail).join(" | ");

let db;
try {
  const { Db } = await import("../dist/db.js");

  // ===== (1) a FRESH Db already carries both new indexes =====
  db = new Db(dbFile);
  {
    const raw = new Database(dbFile, { readonly: true });
    const names = raw.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    raw.close();
    check("(1) a fresh Db already has idx_orch_events_worker", names.includes("idx_orch_events_worker"));
    check("(1) a fresh Db already has idx_orch_events_kind", names.includes("idx_orch_events_kind"));
  }

  // Populate: a bunch of sessions' worth of events, only a few of which carry a recovery-trigger kind —
  // mirrors the real snapshot's shape (11 triggered out of 1963 candidates on a real 2559-session fleet).
  const N_SESSIONS = 300;
  const triggeredIds = new Set();
  {
    const insert = db.appendEvent.bind(db);
    for (let i = 0; i < N_SESSIONS; i++) {
      const sid = `sess-${i}`;
      // A few boring events per session that are NEVER a recovery trigger.
      insert({ id: randomUUID(), ts: `2026-01-01T00:00:0${i % 10}.000Z`, managerSessionId: sid, workerSessionId: sid, taskId: null, kind: "session_created", detail: {} });
      insert({ id: randomUUID(), ts: `2026-01-01T00:00:1${i % 10}.000Z`, managerSessionId: sid, workerSessionId: sid, taskId: null, kind: "gate_started", detail: {} });
      if (i % 30 === 0) { // ~10 of the 300 ever record a trigger — small relative to the fleet, like production
        insert({ id: randomUUID(), ts: `2026-01-01T00:00:2${i % 10}.000Z`, managerSessionId: sid, workerSessionId: sid, taskId: null, kind: "session_died", detail: {} });
        triggeredIds.add(sid);
      }
    }
  }
  db.close();

  // ===== (2) DROP both new indexes — simulates a real pre-fix DB (columns pre-date the fix; only the
  // indexes are new) — then measure the OLD, buggy plan directly. =====
  {
    const raw = new Database(dbFile);
    raw.exec("DROP INDEX idx_orch_events_worker; DROP INDEX idx_orch_events_kind;");
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM orchestration_events WHERE worker_session_id = ? ORDER BY ts, rowid").all("sess-0");
    check("(2) pre-fix (indexes dropped): listEventsForWorker's query SCANs the table", /SCAN orchestration_events/.test(planText(plan)));
    check("(2) pre-fix: the SCAN also needs a separate sort step (the actual O(N) bug)", /TEMP B-TREE/.test(planText(plan)));
    raw.close();
  }

  // ===== (3) re-open via `new Db(path)` — the idempotent CREATE INDEX IF NOT EXISTS must re-create both,
  // with no throw, and the query plan must now be an indexed SEARCH with no separate sort. =====
  const { Db: Db2 } = await import("../dist/db.js");
  let reopenError = null;
  let db2;
  try { db2 = new Db2(dbFile); } catch (e) { reopenError = e; }
  check("(3) re-opening the index-dropped file does NOT throw", reopenError === null);
  if (reopenError) console.log("    threw:", reopenError.stack || reopenError);

  if (!reopenError) {
    const raw = new Database(dbFile, { readonly: true });
    const names = raw.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    check("(3) idx_orch_events_worker is back after re-open", names.includes("idx_orch_events_worker"));
    check("(3) idx_orch_events_kind is back after re-open", names.includes("idx_orch_events_kind"));

    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM orchestration_events WHERE worker_session_id = ? ORDER BY ts, rowid").all("sess-0");
    const planStr = planText(plan);
    check("(3) listEventsForWorker's query is now an indexed SEARCH (not a SCAN)", /SEARCH orchestration_events USING INDEX idx_orch_events_worker/.test(planStr));
    check("(3) no separate sort step is needed (the index's implicit trailing rowid satisfies ORDER BY ts, rowid)", !/TEMP B-TREE/.test(planStr));

    // ===== (4) the new candidate-derivation query is ALSO indexed, and returns exactly the triggered ids =====
    const kindPlan = raw.prepare(
      "EXPLAIN QUERY PLAN SELECT DISTINCT worker_session_id AS id FROM orchestration_events WHERE kind IN ('session_died','worker_report_undelivered') AND worker_session_id IS NOT NULL",
    ).all();
    check("(4) the trigger-kind candidate query uses idx_orch_events_kind, not a table SCAN", /USING (COVERING )?INDEX idx_orch_events_kind/.test(planText(kindPlan)) && !/SCAN orchestration_events/.test(planText(kindPlan)));
    raw.close();

    const found = new Set(db2.listWorkerSessionIdsWithEventKind(["session_died", "worker_report_undelivered"]));
    check("(4) listWorkerSessionIdsWithEventKind returns EXACTLY the sessions that ever recorded a trigger",
      found.size === triggeredIds.size && [...triggeredIds].every((id) => found.has(id)));
    check(`(4) that's a small fraction of the fleet (${found.size} of ${N_SESSIONS}), not O(N) — the actual fix`,
      found.size < N_SESSIONS / 10);

    // ===== (5) idempotent: a 3rd open doesn't duplicate the indexes =====
    const { Db: Db3 } = await import("../dist/db.js");
    const db3 = new Db3(dbFile);
    db3.close();
    const raw2 = new Database(dbFile, { readonly: true });
    const names2 = raw2.prepare("PRAGMA index_list(orchestration_events)").all().map((i) => i.name);
    raw2.close();
    check("(5) a 3rd open is idempotent — no duplicate idx_orch_events_worker",
      names2.filter((n) => n === "idx_orch_events_worker").length === 1);
    check("(5) a 3rd open is idempotent — no duplicate idx_orch_events_kind",
      names2.filter((n) => n === "idx_orch_events_kind").length === 1);

    db2.close();
  }
} finally {
  try { db?.close(); } catch { /* already closed */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — idx_orch_events_worker + idx_orch_events_kind land on a fresh Db AND re-appear idempotently on a DB that predates them (simulated by dropping them over an otherwise-real, populated table); listEventsForWorker's query plan flips from SCAN+TEMP-B-TREE to an indexed SEARCH with no separate sort; the new candidate-derivation query is index-backed and returns exactly the small set of sessions that ever recorded a recovery-trigger event, not the whole fleet."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
