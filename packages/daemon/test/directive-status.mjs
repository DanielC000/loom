import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// directive_status worker MCP tool test (card 35c96aa6) — the RECIPIENT half of the idempotency-key
// argument card 3c712d4e built the SENDER half of. Mirrors stale-directive-projection.mjs's discipline:
// HERMETIC, NO claude, NO external daemon — seeds a real Db (sessions + orchestration_events) and drives
// the REAL worker MCP tool (directive_status) in-process over an InMemoryTransport pair, so it asserts the
// literal tool output a worker would see. Reuses the production `possibleDuplicateRootLabel` (imported
// from dist, never re-derived) to compute expected labels — the same function `directive_status` itself
// calls, so a label mismatch here would mean the tool used something ELSE to compute one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { possibleDuplicateRootLabel } from "../dist/pty/host.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-directive-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-01T12:00:00.000Z";
const projId = "proj-ds";
const agentId = "agent-ds";
db.insertProject({ id: projId, name: "DirectiveStatus", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
// turnSeq is NOT settable at insertSession time (mirrors production — a fresh row always starts at the
// schema DEFAULT 0; only `db.incrementTurnSeq` ever advances it). recycledFrom, when given, seeds this
// session as a RECYCLE SUCCESSOR of the named predecessor id.
function seedWorker(id, parentId, { busy = false, turnSeq = 0, recycledFrom = null } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
    recycledFrom,
  });
  for (let i = 0; i < turnSeq; i++) db.incrementTurnSeq(id);
}
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(Date.parse(now) + sec * 1000).toISOString();

seedManager("MGR");

// ============ (a) never messaged at all — the empty, legitimate answer ============
seedWorker("w-empty", "MGR", { turnSeq: 2 });

// ============ (b) a plain, clean immediate delivery, never given up — self-rooted (no resendOf, no
// give-up ever occurred), so its label is derived from its OWN msgId. Per framePossibleDuplicate's own
// doc, this send would NEVER actually show a tag to the worker — included here as the "found by an
// unfiltered call" / "found when the worker already happens to know its own msgId" case, not as a
// realistic tag-driven lookup. ============
seedWorker("w-clean", "MGR", { turnSeq: 5 });
ev("w-clean", "MGR", "message_worker", at(0), { msgId: "m-clean-0000", turnSeqAtDelivery: 0 });
const labelClean = possibleDuplicateRootLabel("m-clean-0000");

// ============ (c) give-up + remint + HELD delivery — the realistic tag-driven case. The label a worker
// actually sees is derived from the chain's TRUE root (the first msgId), not the reminted msgId that
// ultimately delivered. ============
seedWorker("w-remint-delivered", "MGR", { turnSeq: 6 });
ev("w-remint-delivered", "MGR", "message_worker", at(0), { msgId: "m-remint-root", turnSeqAtDelivery: 0 });
ev("w-remint-delivered", "MGR", "session_message_gave_up", at(5), { msgId: "m-remint-root", rootMsgId: "m-remint-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-remint-1" });
ev("w-remint-delivered", "MGR", "session_message_delivered", at(6), { msgId: "m-remint-1", turnSeqAtDelivery: 1 });
const labelRemintDelivered = possibleDuplicateRootLabel("m-remint-root");

// ============ (d) give-up + remint + PARK (never delivered) — must NOT appear in deliveries at all;
// parked/pending outcomes carry no "have you seen this" signal. ============
seedWorker("w-parked-only", "MGR", { turnSeq: 0 });
ev("w-parked-only", "MGR", "message_worker", at(0), { msgId: "m-parked-root", turnSeqAtDelivery: 0 });
ev("w-parked-only", "MGR", "session_message_gave_up", at(5), { msgId: "m-parked-root", rootMsgId: "m-parked-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-parked-1" });
ev("w-parked-only", "MGR", "session_message_gave_up", at(10), { msgId: "m-parked-1", rootMsgId: "m-parked-root", chainDepth: 1, outcome: "parked" });
const labelParkedOnly = possibleDuplicateRootLabel("m-parked-root");

// ============ (e) confirmed-after-park — a genuine delivery, but with NO turnSeqAtDelivery ever stamped
// (Loom's own hand-off stamp never fired; a LATE independent signal proved the engine ran it anyway).
// turnSeq must read null, and the entry must still appear. ============
seedWorker("w-confirmed-after-park", "MGR", { turnSeq: 0 });
ev("w-confirmed-after-park", "MGR", "message_worker", at(0), { msgId: "m-cap-root", turnSeqAtDelivery: 0 });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(5), { msgId: "m-cap-root", rootMsgId: "m-cap-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-cap-1" });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(10), { msgId: "m-cap-1", rootMsgId: "m-cap-root", chainDepth: 1, outcome: "parked" });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(240), { msgId: "m-cap-1", rootMsgId: "m-cap-root", outcome: "confirmed-after-park", latencyMs: 230000 });
const labelConfirmedAfterPark = possibleDuplicateRootLabel("m-cap-root");

// ============ Change 2 — turnSeq < currentTurnSeq vs turnSeq === currentTurnSeq must be distinguishable.
// (f) delivery from an EARLIER turn: delivered at turnSeq 0, worker has since run 3 more real turns.
// (g) the ONLY delivery IS the current turn: delivered at turnSeq 0, worker is STILL at turnSeq 0 (no
// further turn has run since). Both are single, clean immediate deliveries — same shape as (b) — the ONLY
// difference is the caller's OWN currentTurnSeq at query time. ============
seedWorker("w-earlier-turn", "MGR", { turnSeq: 3 });
ev("w-earlier-turn", "MGR", "message_worker", at(0), { msgId: "m-earlier-0000", turnSeqAtDelivery: 0 });
const labelEarlierTurn = possibleDuplicateRootLabel("m-earlier-0000");

seedWorker("w-current-turn", "MGR", { turnSeq: 0 });
ev("w-current-turn", "MGR", "message_worker", at(0), { msgId: "m-current-0000", turnSeqAtDelivery: 0 });
const labelCurrentTurn = possibleDuplicateRootLabel("m-current-0000");

// ============ Recycle boundary (DoD-3) ============
// (h) a GENUINE delivery reaches the PREDECESSOR before it is recycled; the successor must resolve the
// SAME root identically — found via the lineage walk (own history is empty; the predecessor's is not).
seedWorker("w-pred-h", "MGR", { turnSeq: 4 });
ev("w-pred-h", "MGR", "message_worker", at(0), { msgId: "m-pred-h-root", turnSeqAtDelivery: 0 });
ev("w-pred-h", "MGR", "session_message_gave_up", at(5), { msgId: "m-pred-h-root", rootMsgId: "m-pred-h-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-pred-h-1" });
ev("w-pred-h", "MGR", "session_message_delivered", at(6), { msgId: "m-pred-h-1", turnSeqAtDelivery: 2 });
seedWorker("w-succ-h", "MGR", { turnSeq: 0, recycledFrom: "w-pred-h" });
const labelPredH = possibleDuplicateRootLabel("m-pred-h-root");

// (i) `carryPendingToSuccessor`'s self-rooting shape: the predecessor's chain gave up, reminted, and was
// STILL HELD (never delivered) when the recycle happened — carryPendingToSuccessor resolves it via
// `resolveQueuedMessage(msgId, {reason:"superseded"})`, which appends `session_message_delivered` with NO
// turnSeqAtDelivery (service.ts:5970/5975-5979). This must resolve to ZERO priors for this root: the
// content was truthfully never handed to any turn under this root, however alarming the carried-forward
// tag text might have looked to the successor. This is the honest answer the design checkpoint traced —
// NOT a bug, and NOT something `carryPendingToSuccessor` needed to change to get right.
seedWorker("w-pred-i", "MGR", { turnSeq: 1 });
ev("w-pred-i", "MGR", "message_worker", at(0), { msgId: "m-pred-i-root", turnSeqAtDelivery: 0 });
ev("w-pred-i", "MGR", "session_message_gave_up", at(5), { msgId: "m-pred-i-root", rootMsgId: "m-pred-i-root", chainDepth: 0, outcome: "reminted", remintedAs: "m-pred-i-1" });
ev("w-pred-i", "MGR", "session_message_delivered", at(6), { msgId: "m-pred-i-1", reason: "superseded" });
seedWorker("w-succ-i", "MGR", { turnSeq: 0, recycledFrom: "w-pred-i" });
const labelPredI = possibleDuplicateRootLabel("m-pred-i-root");

const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
}));

async function connectWorker(id) {
  const server = router.buildServer(id, "worker");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "directive-status-test-" + id, version: "0" });
  await client.connect(clientT);
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (client, args) => parse(await client.callTool({ name: "directive_status", arguments: args ?? {} }));

// ============ (a) never messaged ============
{
  const c = await connectWorker("w-empty");
  const r = await call(c);
  check("(a) never messaged: deliveryCount 0, currentTurnSeq reflects seeded turns, truncated false",
    r.deliveryCount === 0 && r.deliveries.length === 0 && r.currentTurnSeq === 2 && r.truncated === false);
  await c.close();
}

// ============ malformed root — distinguishable from a real zero-match ============
{
  const c = await connectWorker("w-empty");
  const bad = await call(c, { root: "not-hex!" });
  check("malformed root: returns {error}, NOT a silent zero-match read", typeof bad.error === "string" && bad.deliveries === undefined);
  const short = await call(c, { root: "abc123" }); // too short
  check("malformed root (too short): also returns {error}", typeof short.error === "string");
  await c.close();
}

// ============ (b) clean immediate delivery, found by its own label ============
{
  const c = await connectWorker("w-clean");
  const r = await call(c, { root: labelClean });
  check("(b) clean immediate delivery found by its own self-rooted label",
    r.deliveryCount === 1 && r.deliveries[0].msgId === "m-clean-0000" && r.deliveries[0].turnSeq === 0 && r.deliveries[0].root === labelClean);
  check("(b) fromSession is the SENDER (MGR), receivedBy is the RECIPIENT (w-clean itself, no recycle here) — the two must never be swapped",
    r.deliveries[0].fromSession === "MGR" && r.deliveries[0].receivedBy === "w-clean");
  const otherHexChar = labelClean[0] === "0" ? "1" : "0";
  const otherLabel = otherHexChar + labelClean.slice(1);
  const wrongLabel = await call(c, { root: otherLabel });
  check("(b) a DIFFERENT label finds nothing for this worker", wrongLabel.deliveryCount === 0);
  await c.close();
}

// ============ (c) remint-then-delivered: label is the chain's TRUE root, not the msgId that delivered ============
{
  const c = await connectWorker("w-remint-delivered");
  const r = await call(c, { root: labelRemintDelivered });
  check("(c) remint-then-delivered found by the chain's TRUE root label, reports the DELIVERING msgId + its own turnSeq",
    r.deliveryCount === 1 && r.deliveries[0].msgId === "m-remint-1" && r.deliveries[0].turnSeq === 1);
  await c.close();
}

// ============ (d) parked-only — never appears ============
{
  const c = await connectWorker("w-parked-only");
  const r = await call(c, { root: labelParkedOnly });
  check("(d) a chain that only ever parked (never delivered) contributes ZERO entries",
    r.deliveryCount === 0);
  await c.close();
}

// ============ (e) confirmed-after-park — appears, with turnSeq:null ============
{
  const c = await connectWorker("w-confirmed-after-park");
  const r = await call(c, { root: labelConfirmedAfterPark });
  check("(e) confirmed-after-park IS reported as a genuine prior delivery, with turnSeq explicitly null",
    r.deliveryCount === 1 && r.deliveries[0].turnSeq === null && r.deliveries[0].msgId === "m-cap-1");
  await c.close();
}

// ============ Change 2 — the specific distinguishability the manager required ============
{
  const cEarlier = await connectWorker("w-earlier-turn");
  const rEarlier = await call(cEarlier, { root: labelEarlierTurn });
  const earlierIsPrior = rEarlier.deliveries.some((d) => typeof d.turnSeq === "number" && d.turnSeq < rEarlier.currentTurnSeq);
  check("(f) a delivery from an EARLIER turn: turnSeq(0) < currentTurnSeq(3) mechanically true",
    rEarlier.deliveryCount === 1 && rEarlier.currentTurnSeq === 3 && earlierIsPrior === true);
  await cEarlier.close();

  const cCurrent = await connectWorker("w-current-turn");
  const rCurrent = await call(cCurrent, { root: labelCurrentTurn });
  const currentIsPrior = rCurrent.deliveries.some((d) => typeof d.turnSeq === "number" && d.turnSeq < rCurrent.currentTurnSeq);
  check("(g) the ONLY delivery IS the current turn: turnSeq(0) < currentTurnSeq(0) mechanically FALSE — distinguishable from (f)",
    rCurrent.deliveryCount === 1 && rCurrent.currentTurnSeq === 0 && currentIsPrior === false);

  check("(f) vs (g): the two scenarios return DISTINGUISHABLE answers to 'have I seen this before'",
    earlierIsPrior !== currentIsPrior);
  await cCurrent.close();
}

// ============ Recycle boundary (DoD-3) ============
{
  // (h) successor's OWN history is empty; the lineage walk must still find the predecessor's genuine delivery.
  const cSelf = await connectWorker("w-pred-h");
  const rSelfOnly = await call(cSelf); // sanity: predecessor itself sees its own delivery unfiltered
  check("(h) sanity: predecessor itself sees its own delivery via an unfiltered call — receivedBy is ITSELF, fromSession is the real SENDER",
    rSelfOnly.deliveryCount === 1 && rSelfOnly.deliveries[0].receivedBy === "w-pred-h" && rSelfOnly.deliveries[0].fromSession === "MGR");
  await cSelf.close();

  const cSucc = await connectWorker("w-succ-h");
  const rSucc = await call(cSucc, { root: labelPredH });
  check("(h) RECYCLE BOUNDARY: successor resolves its PREDECESSOR's genuine delivery identically via the lineage walk — receivedBy correctly names the PREDECESSOR (not the querying successor), fromSession is STILL the real sender, never the recipient",
    rSucc.deliveryCount === 1 && rSucc.deliveries[0].msgId === "m-pred-h-1"
    && rSucc.deliveries[0].receivedBy === "w-pred-h" && rSucc.deliveries[0].receivedBy !== "w-succ-h"
    && rSucc.deliveries[0].fromSession === "MGR");
  await cSucc.close();

  // (i) carryPendingToSuccessor's self-rooting shape: a superseded (never truly delivered) predecessor
  // record must resolve to ZERO priors for its own root — the honest answer, not a bug.
  const cSuccI = await connectWorker("w-succ-i");
  const rSuccI = await call(cSuccI, { root: labelPredI });
  check("(i) RECYCLE BOUNDARY: a superseded-never-delivered predecessor record reads as ZERO priors (never a false positive)",
    rSuccI.deliveryCount === 0);
  await cSuccI.close();
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — directive_status (card 35c96aa6) correctly reports ZERO for a never-messaged worker, rejects a malformed root distinguishably from a real zero-match, resolves a clean immediate delivery and a remint-then-delivered chain by the chain's TRUE root label (never the delivering msgId's own label), excludes a chain that only ever parked, reports a confirmed-after-park delivery with turnSeq explicitly null, and — the manager's specific Change 2 requirement — returns mechanically DISTINGUISHABLE answers for a delivery from an earlier turn (turnSeq < currentTurnSeq) versus a delivery THAT IS the current turn (turnSeq === currentTurnSeq). The recycle boundary resolves identically whether queried from the predecessor or a successor via the own-lineage walk, and a carried-forward record that was truthfully never delivered (carryPendingToSuccessor's superseded/self-rooting shape) correctly reads as zero priors rather than a false positive — no change to carryPendingToSuccessor or any send/requeue machinery was needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
