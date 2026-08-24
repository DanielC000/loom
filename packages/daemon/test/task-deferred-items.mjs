import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0d4bc3f0 (board-hygiene): a DoD sub-item deferred from one card onto another used to live only in
// `Related:` prose — the receiving card was under no obligation to acknowledge it, and nothing in either
// card's merge signal showed the item was dropped (it happened TWICE in one day on this very project; see
// the card body). This is option B (typed field): `Task.deferredItems` (the donor's OUTBOUND list,
// written via `tasks_defer_item`) plus a DERIVED `incomingDeferredItems` INBOUND summary
// (getProjectTask/tasks_get, mirroring how `requests` is already surfaced) computed by scanning the
// project's OTHER tasks for an entry whose `toTaskId` names this one. HERMETIC, claude-free — a REAL Db +
// the REAL TaskMcpRouter over an in-process MCP InMemoryTransport, no real claude/network/daemon.
//
// Proves:
//   (A) tasks_defer_item creates a well-formed item (id/timestamps/status:"open") on the DONOR's OWN
//       tasks_get (deferredItems).
//   (B) DETECTABILITY (the card's actual DoD-4): the RECEIVING task's tasks_get surfaces the item in
//       incomingDeferredItems WITHOUT ever having been told the donor's id — open count is 1, and this
//       stays true even after the DONOR card closes (moves to the terminal column) having never been
//       acknowledged. This is the literal "a card that defers an item onto another, where the recipient
//       never acknowledges it, is detectable" scenario from the card's own DoD.
//   (C) tasks_defer_item_ack flips the item's status; the change is visible from BOTH the donor's own
//       tasks_get (deferredItems) AND the recipient's incomingDeferredItems (open count drops, the
//       specific item's status updates) — addressed by itemId, not by array position.
//   (D) validation: a self-reference (toTaskId === the donor itself) is rejected; an unknown toTaskId is
//       rejected; empty text is rejected — none of these write anything.
//   (E) incomingDeferredItems on a task that nobody ever deferred anything onto reads all-zero/empty (the
//       negative control — the mechanism can report "nothing", not just "something").
//   (F) toTaskId accepts an unambiguous 8-char id-prefix (mirrors deferredUntilTaskId's own convention).
//   (G) multiple donors deferring onto the SAME recipient all show up together in incomingDeferredItems,
//       each correctly attributed to its OWN fromTaskId/fromTaskTitle.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferred-items.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-deferred-items-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "di.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "di-proj";
const mgrId = "di-mgr", agentId = "di-agent";

async function taskClient(router, projectId, sessionId) {
  const server = router.buildServer(projectId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-deferred-items-test", version: "0" });
  await client.connect(clientT);
  return {
    client,
    call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text),
  };
}

try {
  db.insertProject({ id: projId, name: "DI", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-di", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const donorId = "aaaaaaaa-0000-4000-8000-000000000001";
  const recipientId = "bbbbbbbb-0000-4000-8000-000000000002";
  const lonelyId = "cccccccc-0000-4000-8000-000000000003"; // (E) negative control — nothing ever deferred onto this one
  db.insertTask({ id: donorId, projectId: projId, title: "Donor card", body: "b", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  db.insertTask({ id: recipientId, projectId: projId, title: "Recipient card", body: "b", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  db.insertTask({ id: lonelyId, projectId: projId, title: "Nobody ever deferred onto this one", body: "b", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

  const wakes = new WakeService({ db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {} });
  const taskRouter = new TaskMcpRouter(db, wakes);
  const { client, call } = await taskClient(taskRouter, projId, mgrId);

  // ============================ (A) tasks_defer_item creates a well-formed item ========================
  const deferred = await call("tasks_defer_item", { id: donorId, toTaskId: recipientId, text: "suppress the re-injection when the original was already consumed" });
  check("(A) tasks_defer_item returns no error", !deferred.error);
  check("(A) the returned item carries a fresh id", typeof deferred.id === "string" && deferred.id.length > 0);
  check("(A) toTaskId is the resolved FULL id", deferred.toTaskId === recipientId);
  check("(A) status starts open", deferred.status === "open");
  check("(A) text round-trips", deferred.text === "suppress the re-injection when the original was already consumed");
  check("(A) createdAt/updatedAt are stamped and equal on creation", typeof deferred.createdAt === "string" && deferred.createdAt === deferred.updatedAt);

  const donorRead = await call("tasks_get", { id: donorId });
  check("(A) the donor's OWN tasks_get surfaces it in deferredItems", Array.isArray(donorRead.deferredItems) && donorRead.deferredItems.length === 1);
  check("(A) the donor's own copy matches what was returned", donorRead.deferredItems[0].id === deferred.id && donorRead.deferredItems[0].status === "open");

  // ============================ (B) DETECTABILITY — the card's actual DoD-4 =============================
  const recipientReadBefore = await call("tasks_get", { id: recipientId });
  check("(B) the RECEIVING task's tasks_get surfaces incomingDeferredItems WITHOUT knowing the donor's id in advance", recipientReadBefore.incomingDeferredItems.total === 1);
  check("(B) it's counted open", recipientReadBefore.incomingDeferredItems.open === 1 && recipientReadBefore.incomingDeferredItems.acknowledged === 0 && recipientReadBefore.incomingDeferredItems.declined === 0);
  check("(B) the item names its donor (fromTaskId/fromTaskTitle)", recipientReadBefore.incomingDeferredItems.items[0].fromTaskId === donorId && recipientReadBefore.incomingDeferredItems.items[0].fromTaskTitle === "Donor card");
  check("(B) the item's itemId matches the donor-side id", recipientReadBefore.incomingDeferredItems.items[0].itemId === deferred.id);

  // Close the donor WITHOUT ever acknowledging the item — the exact "drop" scenario from the card body.
  const closeResult = await call("tasks_update", { id: donorId, columnKey: "done" });
  check("(setup) donor card closes cleanly", !closeResult.error);
  const recipientReadAfterDonorClosed = await call("tasks_get", { id: recipientId });
  check("(B) the item STAYS visible and OPEN even after its donor card has closed — this IS the detection", recipientReadAfterDonorClosed.incomingDeferredItems.open === 1);
  check("(B) a closed donor is not filtered out of the inbound view", recipientReadAfterDonorClosed.incomingDeferredItems.items.some((it) => it.fromTaskId === donorId));

  // ============================ (C) tasks_defer_item_ack flips status, visible from both ends ===========
  const ackResult = await call("tasks_defer_item_ack", { id: donorId, itemId: deferred.id, status: "acknowledged" });
  check("(C) ack returns no error", !ackResult.error);
  check("(C) ack returns the item with the new status", ackResult.status === "acknowledged" && ackResult.id === deferred.id);
  check("(C) ack bumps updatedAt past createdAt", ackResult.updatedAt >= ackResult.createdAt);

  const donorReadAfterAck = await call("tasks_get", { id: donorId });
  check("(C) the donor's own deferredItems reflects the new status", donorReadAfterAck.deferredItems[0].status === "acknowledged");
  const recipientReadAfterAck = await call("tasks_get", { id: recipientId });
  check("(C) the recipient's incomingDeferredItems ALSO reflects it — open drops to 0, acknowledged to 1", recipientReadAfterAck.incomingDeferredItems.open === 0 && recipientReadAfterAck.incomingDeferredItems.acknowledged === 1);
  check("(C) the specific item's status updates in the inbound view too", recipientReadAfterAck.incomingDeferredItems.items[0].status === "acknowledged");

  // ============================ (D) validation — self-reference, unknown id, empty text ==================
  const selfRefResult = await call("tasks_defer_item", { id: donorId, toTaskId: donorId, text: "nope" });
  check("(D) a self-reference is rejected", typeof selfRefResult.error === "string");
  const unknownResult = await call("tasks_defer_item", { id: donorId, toTaskId: "not-a-real-task-id", text: "nope" });
  check("(D) an unknown toTaskId is rejected", typeof unknownResult.error === "string");
  const emptyTextResult = await call("tasks_defer_item", { id: donorId, toTaskId: recipientId, text: "   " });
  check("(D) empty/whitespace-only text is rejected", typeof emptyTextResult.error === "string");
  const donorReadAfterRejections = await call("tasks_get", { id: donorId });
  check("(D) none of the rejected calls wrote anything — deferredItems count is unchanged", donorReadAfterRejections.deferredItems.length === 1);
  const unknownAckResult = await call("tasks_defer_item_ack", { id: donorId, itemId: "not-a-real-item-id", status: "declined" });
  check("(D) acking an unknown itemId is rejected", typeof unknownAckResult.error === "string");

  // ============================ (E) negative control — a task nobody deferred anything onto ==============
  const lonelyRead = await call("tasks_get", { id: lonelyId });
  check("(E) incomingDeferredItems on an untouched task reads total:0", lonelyRead.incomingDeferredItems.total === 0);
  check("(E) all buckets are zero, items is an empty array (not undefined/null)", lonelyRead.incomingDeferredItems.open === 0 && lonelyRead.incomingDeferredItems.acknowledged === 0 && lonelyRead.incomingDeferredItems.declined === 0 && Array.isArray(lonelyRead.incomingDeferredItems.items) && lonelyRead.incomingDeferredItems.items.length === 0);
  check("(E) an untouched task's own deferredItems is also an empty array", Array.isArray(lonelyRead.deferredItems) && lonelyRead.deferredItems.length === 0);

  // ============================ (F) toTaskId accepts an unambiguous 8-char id-prefix =====================
  const prefix = lonelyId.slice(0, 8);
  const byPrefix = await call("tasks_defer_item", { id: donorId, toTaskId: prefix, text: "prefix-targeted hand-off" });
  check("(F) tasks_defer_item resolves an 8-char toTaskId prefix", !byPrefix.error && byPrefix.toTaskId === lonelyId);
  const lonelyReadAfterPrefix = await call("tasks_get", { id: lonelyId });
  check("(F) the prefix-targeted item shows up under the RESOLVED full id", lonelyReadAfterPrefix.incomingDeferredItems.total === 1);

  // ============================ (G) multiple donors onto the SAME recipient, correctly attributed ========
  const secondDonorId = "dddddddd-0000-4000-8000-000000000004";
  db.insertTask({ id: secondDonorId, projectId: projId, title: "Second donor card", body: "b", columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });
  const secondDeferred = await call("tasks_defer_item", { id: secondDonorId, toTaskId: recipientId, text: "a second, unrelated hand-off onto the same recipient" });
  check("(G) a second donor can defer onto the same recipient", !secondDeferred.error);
  const recipientReadMulti = await call("tasks_get", { id: recipientId });
  check("(G) both hand-offs are visible together", recipientReadMulti.incomingDeferredItems.total === 2);
  check("(G) each is attributed to its OWN donor", recipientReadMulti.incomingDeferredItems.items.some((it) => it.fromTaskId === donorId) && recipientReadMulti.incomingDeferredItems.items.some((it) => it.fromTaskId === secondDonorId));
  check("(G) the first (acknowledged) and second (open) items keep their own distinct statuses", recipientReadMulti.incomingDeferredItems.items.find((it) => it.fromTaskId === donorId).status === "acknowledged" && recipientReadMulti.incomingDeferredItems.items.find((it) => it.fromTaskId === secondDonorId).status === "open");

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_defer_item writes a well-formed structured hand-off onto the donor's OWN deferredItems; the RECEIVING task's tasks_get surfaces it in incomingDeferredItems WITHOUT ever being told the donor's id in advance, and — the card's actual DoD-4 — the item stays visibly OPEN even after its donor card closes having never acknowledged it, which IS the detection; tasks_defer_item_ack flips status visibly from BOTH ends, addressed by itemId (not array position); self-reference/unknown-id/empty-text writes are all rejected with nothing written; an untouched task reads an honest all-zero/empty negative control; an 8-char toTaskId prefix resolves to the full id; and multiple donors deferring onto the same recipient are each correctly attributed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
