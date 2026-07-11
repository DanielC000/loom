import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EventTrigger data-layer test (Loom Event Triggers subsystem, card f5d07121 — T1, the FOUNDATION card).
// NO claude, NO dispatcher, NO REST — this card is pure data plumbing: the shared type + allowlist, the
// event_triggers SCHEMA table, and the Db CRUD/due-reader/watermark-advance helpers. Hermetic: each env
// gets its OWN temp .db (never the daemon's). Covers: insert/list/get/update/delete round-trip, the
// nullable project_id scope + wake/spawn target columns, listDueEventTriggers returning only enabled
// rows, and advanceEventTriggerSeq advancing last_seq alone vs. also stamping the last_fired_at
// dedupe/rate-guard column.
//
// Run: 1) build (turbo builds shared first), 2) node test/event-triggers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { EVENT_TRIGGER_EVENT_KINDS } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-event-triggers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `pp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `pa-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `ps-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Triggers", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "spawn-target", startupPrompt: "You are Dev.", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  return { dbFile, db, projId, agentId, sessId };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const seedWakeTrigger = (e, id, over = {}) => {
  const t = {
    id, eventKind: "worker_stuck", projectId: e.projId, mode: "wake",
    targetSessionId: e.sessId, agentId: null, enabled: true, lastSeq: 0, lastFiredAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
  e.db.insertEventTrigger(t);
  return t;
};

// --- Allowlist sanity: every eligible kind is a non-empty string, deduped ---
{
  check("allowlist is non-empty", EVENT_TRIGGER_EVENT_KINDS.length > 0);
  check("allowlist has no duplicates", new Set(EVENT_TRIGGER_EVENT_KINDS).size === EVENT_TRIGGER_EVENT_KINDS.length);
  check("allowlist excludes task/card-lifecycle kinds (none exist on the bus today)",
    !EVENT_TRIGGER_EVENT_KINDS.some((k) => k.startsWith("task_") || k.startsWith("card_")));
}

// --- Insert + get round-trip: every column survives, nullable columns stay null ---
{
  const e = makeEnv();
  const t = seedWakeTrigger(e, "trig-wake");
  const got = e.db.getEventTrigger("trig-wake");
  check("get: round-trips id/eventKind/mode", got.id === t.id && got.eventKind === "worker_stuck" && got.mode === "wake");
  check("get: projectId scope survives", got.projectId === e.projId);
  check("get: targetSessionId set, agentId null (wake mode)", got.targetSessionId === e.sessId && got.agentId === null);
  check("get: enabled defaults true, lastSeq 0, lastFiredAt null", got.enabled === true && got.lastSeq === 0 && got.lastFiredAt === null);
  check("get: unknown id returns undefined", e.db.getEventTrigger("nope") === undefined);
  cleanupEnv(e);
}

// --- Insert a spawn-mode + all-projects (projectId: null) trigger — nullable scope round-trips ---
{
  const e = makeEnv();
  e.db.insertEventTrigger({
    id: "trig-spawn-global", eventKind: "platform_escalate", projectId: null, mode: "spawn",
    targetSessionId: null, agentId: e.agentId, enabled: true, lastSeq: 0, lastFiredAt: null,
    createdAt: new Date().toISOString(),
  });
  const got = e.db.getEventTrigger("trig-spawn-global");
  check("spawn/global: projectId null (all-projects scope)", got.projectId === null);
  check("spawn/global: agentId set, targetSessionId null (spawn mode)", got.agentId === e.agentId && got.targetSessionId === null);
  cleanupEnv(e);
}

// --- List: returns every row, ordered, regardless of enabled state ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-a");
  seedWakeTrigger(e, "trig-b", { enabled: false });
  const all = e.db.listEventTriggers();
  check("list: returns both rows", all.length === 2 && all.some((r) => r.id === "trig-a") && all.some((r) => r.id === "trig-b"));
  cleanupEnv(e);
}

// --- Due-reader: listDueEventTriggers returns ONLY enabled rows ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-enabled", { enabled: true });
  seedWakeTrigger(e, "trig-disabled", { enabled: false });
  const due = e.db.listDueEventTriggers();
  check("due-reader: only the enabled row comes back", due.length === 1 && due[0].id === "trig-enabled");
  cleanupEnv(e);
}

// --- Update: partial patch only touches provided fields ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-update");
  e.db.updateEventTrigger("trig-update", { enabled: false });
  let got = e.db.getEventTrigger("trig-update");
  check("update: enabled flips to false", got.enabled === false);
  check("update: untouched fields unchanged (mode still wake)", got.mode === "wake");
  e.db.updateEventTrigger("trig-update", { mode: "spawn", targetSessionId: null, agentId: e.agentId });
  got = e.db.getEventTrigger("trig-update");
  check("update: mode/target/agent switch to spawn shape", got.mode === "spawn" && got.targetSessionId === null && got.agentId === e.agentId);
  e.db.updateEventTrigger("trig-update", { projectId: null });
  got = e.db.getEventTrigger("trig-update");
  check("update: projectId can be explicitly cleared to null (all-projects)", got.projectId === null);
  cleanupEnv(e);
}

// --- Delete ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-delete");
  e.db.deleteEventTrigger("trig-delete");
  check("delete: row is gone", e.db.getEventTrigger("trig-delete") === undefined);
  check("delete: listEventTriggers no longer includes it", !e.db.listEventTriggers().some((r) => r.id === "trig-delete"));
  cleanupEnv(e);
}

// --- Watermark advance: a plain scan-past advance moves last_seq but leaves last_fired_at untouched ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-watermark");
  e.db.advanceEventTriggerSeq("trig-watermark", 42);
  const got = e.db.getEventTrigger("trig-watermark");
  check("watermark: last_seq advances", got.lastSeq === 42);
  check("watermark: last_fired_at stays null (no fire happened)", got.lastFiredAt === null);
  cleanupEnv(e);
}

// --- Watermark advance WITH a fire: stamps the dedupe/rate-guard column too ---
{
  const e = makeEnv();
  seedWakeTrigger(e, "trig-fired");
  const firedAt = new Date().toISOString();
  e.db.advanceEventTriggerSeq("trig-fired", 7, firedAt);
  const got = e.db.getEventTrigger("trig-fired");
  check("fired: last_seq advances", got.lastSeq === 7);
  check("fired: last_fired_at stamped", got.lastFiredAt === firedAt);
  // A later plain advance (no fire this round) must not clobber the previously-stamped last_fired_at.
  e.db.advanceEventTriggerSeq("trig-fired", 9);
  const got2 = e.db.getEventTrigger("trig-fired");
  check("fired: a subsequent no-fire advance preserves the prior last_fired_at", got2.lastSeq === 9 && got2.lastFiredAt === firedAt);
  cleanupEnv(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — event_triggers CRUD round-trips every column (incl. the nullable project_id all-projects scope and the wake/spawn target columns), listDueEventTriggers surfaces only enabled rows, updateEventTrigger patches partially (including explicitly clearing a nullable column), deleteEventTrigger removes the row, and advanceEventTriggerSeq moves the last_seq watermark alone or — when a real fire happened — also stamps the last_fired_at dedupe/rate-guard column without a later no-fire advance clobbering it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
