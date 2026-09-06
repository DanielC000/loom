import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// updateProjectTask's deferredUntilEvent set-time guard (card 74716cfb) — mirrors
// task-manual-deferral-reason.mjs's discipline: drives the built business logic (dist/mcp/tasks.js)
// directly against a throwaway SQLite Db, no daemon, no real claude.
//
// Proves:
//   (1) a valid {kind:"gate-fail-naming", key} is accepted, persisted, and round-trips through getTask.
//   (2) an unrecognized `kind` is REFUSED — whole patch rejected, nothing written (a companion columnKey
//       change in the SAME patch must not land either).
//   (3) an empty/whitespace-only `key` is REFUSED the same way.
//   (4) `key` is trimmed on write.
//   (5) {kind:"request-answered", key} is ALSO accepted (the reserved second kind).
//   (6) `null` clears an existing value back to null.
//   (7) omitting the field entirely leaves an existing value untouched (byte-identical field-only patch).
//   (8) setting/clearing it NEVER touches `deferred`/`deferredReason`/`deferredAt` — it only annotates
//       (the card's own binding "never auto-clears, carries no release semantics" constraint).
// Run: 1) build daemon (pnpm build), 2) node test/task-deferred-until-event-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-deferred-until-event-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projG", name: "Guard", repoPath: "C:/g", vaultPath: "C:/g", config: {}, createdAt: now, archivedAt: null, reserved: false });

  const card = createProjectTask(db, "projG", { title: "guard test card", body: "body", columnKey: "backlog" });
  check("setup: card created", !card.error);

  // (1) a valid value is accepted and persists.
  const set1 = await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "gate-fail-naming", key: "widget.spec.js" } });
  check("(1) no error", !set1.error);
  check("(1) ack carries the value", set1.deferredUntilEvent?.kind === "gate-fail-naming" && set1.deferredUntilEvent?.key === "widget.spec.js");
  check("(1) persisted — getTask round-trips it", db.getTask(card.id).deferredUntilEvent?.key === "widget.spec.js");

  // (2) an unrecognized kind is refused — whole patch rejected, INCLUDING a companion columnKey change.
  const before2 = db.getTask(card.id).columnKey;
  const bad2 = await updateProjectTask(db, "projG", card.id, { columnKey: "review", deferredUntilEvent: { kind: "totally-bogus", key: "x" } });
  check("(2) an unrecognized kind is refused with {error}", typeof bad2.error === "string");
  check("(2) nothing written — deferredUntilEvent unchanged", db.getTask(card.id).deferredUntilEvent?.key === "widget.spec.js");
  check("(2) the companion columnKey change in the SAME patch was ALSO rejected (whole-patch-reject)", db.getTask(card.id).columnKey === before2);

  // (3) an empty/whitespace-only key is refused the same way.
  const bad3 = await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "gate-fail-naming", key: "   " } });
  check("(3) a whitespace-only key is refused with {error}", typeof bad3.error === "string");
  check("(3) nothing written", db.getTask(card.id).deferredUntilEvent?.key === "widget.spec.js");

  // (4) key is trimmed on write.
  const set4 = await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "gate-fail-naming", key: "  padded.spec.js  " } });
  check("(4) no error", !set4.error);
  check("(4) key was trimmed", set4.deferredUntilEvent?.key === "padded.spec.js");
  check("(4) persisted trimmed", db.getTask(card.id).deferredUntilEvent?.key === "padded.spec.js");

  // (5) the reserved second kind is also accepted.
  const set5 = await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "request-answered", key: "req-abc123" } });
  check("(5) request-answered kind accepted", !set5.error && set5.deferredUntilEvent?.kind === "request-answered" && set5.deferredUntilEvent?.key === "req-abc123");

  // (6) null clears it back to null.
  const set6 = await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: null });
  check("(6) no error", !set6.error);
  check("(6) cleared to null", set6.deferredUntilEvent === null);
  check("(6) persisted null", db.getTask(card.id).deferredUntilEvent === null);

  // (7) omitting the field leaves an existing value untouched across an unrelated field-only patch.
  await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "gate-fail-naming", key: "stays-put.mjs" } });
  const set7 = await updateProjectTask(db, "projG", card.id, { priority: "p0" });
  check("(7) an unrelated field-only patch leaves deferredUntilEvent untouched", set7.deferredUntilEvent?.key === "stays-put.mjs");
  check("(7) ...and did apply the unrelated field", set7.priority === "p0");

  // (8) setting/clearing it never touches deferred/deferredReason/deferredAt — pure annotation.
  const beforeDeferralState = { deferred: db.getTask(card.id).deferred, deferredReason: db.getTask(card.id).deferredReason, deferredAt: db.getTask(card.id).deferredAt };
  check("(8) setup: card is NOT deferred before this check", beforeDeferralState.deferred === false);
  await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: { kind: "gate-fail-naming", key: "another.mjs" } });
  await updateProjectTask(db, "projG", card.id, { deferredUntilEvent: null });
  const afterDeferralState = { deferred: db.getTask(card.id).deferred, deferredReason: db.getTask(card.id).deferredReason, deferredAt: db.getTask(card.id).deferredAt };
  check("(8) deferred/deferredReason/deferredAt are all UNCHANGED by set+clear — this field only annotates, never auto-clears anything", JSON.stringify(beforeDeferralState) === JSON.stringify(afterDeferralState));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — updateProjectTask's deferredUntilEvent guard accepts a well-formed {kind,key} (either recognized kind), trims the key, clears to null, leaves an existing value untouched across an unrelated field-only patch, refuses a malformed kind/empty key with the WHOLE patch rejected (including a companion field in the same call), and never touches deferred/deferredReason/deferredAt — it only annotates."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
