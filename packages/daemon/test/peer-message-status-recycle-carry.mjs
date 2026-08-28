import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card af995d1d — the measured incident: a peer_message queued (busy target) for a manager that then
// RECYCLES before draining used to carry onto its successor under a BRAND-NEW, DISCONNECTED msgId (see
// carryPendingToSuccessor's own doc, sessions/service.ts). The successor genuinely delivers the carried
// copy — the recipient confirmed receiving and acting on it — but the ORIGINAL sender's own
// `peer_message_status(originalMsgId)` read stayed `state:"pending"` FOREVER: neither a give-up event nor
// a delivered event ever existed for the msgId the sender is actually holding, because the recycle-carry
// re-mint self-rooted a fresh id with no link back.
//
// THE FIX: carryPendingToSuccessor now appends a `session_message_gave_up` (`outcome:"reminted"`) event
// linking the OLD msgId to the NEW one — the SAME vocabulary handleGiveUpExhausted's in-session remint
// already writes — so resolveDirectiveOutcome's chain walk (shared by peer_message_status/directive_status)
// can hop from the msgId the sender is holding forward to whatever actually happens to the carried copy.
//
// THIS SUITE PINS: a held peer_message, carried across a recipient recycle, whose successor's copy later
// drains normally, converges the ORIGINAL sender's peer_message_status(originalMsgId) read to
// `state:"delivered"` — never a permanent `"pending"`. Also proves the intermediate state (still pending
// immediately after the recycle, before the successor's own copy drains) and that `sentAt` survives the
// recycle hop unchanged (still the ORIGINAL send instant, not the successor's delivery instant).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService driven against a contract-
// faithful PtyStub (mirrors peer-message-recycle-inheritance.mjs's own stub — a LIVE+BUSY recipient HOLDS
// an enqueue; flushPending splices+returns held entries WITH onDeliver; a fresh spawn() is BUSY until the
// test explicitly un-busies it, mirroring "not ready until SessionStart" in production), the REAL
// OrchestrationMcpRouter, over an in-process MCP InMemoryTransport — no mocking of carryPendingToSuccessor
// or resolveDirectiveOutcome themselves.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-message-status-recycle-carry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-status-recycle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// Same contract-faithful PtyStub as peer-message-recycle-inheritance.mjs: a LIVE+BUSY recipient HOLDS an
// enqueue (delivered:false, onDeliver preserved); a fresh spawn() is LIVE+BUSY (mirrors "not ready until
// SessionStart" in production — a re-mint onto a just-spawned successor always holds, never delivers
// immediately, so its onDeliver is never silently dropped).
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); }
  setLive(id, on = true) { if (on) this.live.add(id); else { this.live.delete(id); this.busy.delete(id); } }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  enqueueStdin(id, text, source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false };
    if (!this.busy.has(id)) { const a = this.q.get(id) ?? []; a.push({ id: `d-${a.length}`, text, source, delivered: true }); this.q.set(id, a); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = (this.q.get(id) ?? []).filter((m) => !m.delivered); this.q.set(id, []); return a; }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  pendingEntries(id) { return this.q.get(id) ?? []; }
  spawn(opts) { this.setLive(opts.sessionId); this.setBusy(opts.sessionId); }
  stop(id) { this.setLive(id, false); }
  isAlive(id) { return this.live.has(id); }
}

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();

const mkProject = (id, name) => db.insertProject({ id, name, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projectId) => db.insertAgent({ id, projectId, name: "t", startupPrompt: "BRIEF", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: o.projectId, agentId: o.agentId, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
});

const parse = (res) => JSON.parse(res.content[0].text);
async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "peer-message-status-recycle-carry-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const pA = `pA-${sfx}`, pB = `pB-${sfx}`;
  mkProject(pA, "Project A"); mkProject(pB, "Project B");
  db.createProjectLink(pA, pB);
  const agA = `agA-${sfx}`, agB = `agB-${sfx}`;
  mkAgent(agA, pA); mkAgent(agB, pB);

  const pty = new PtyStub();
  const svc = new SessionService(db, pty, new OrchestrationControl());
  const orch = new OrchestrationMcpRouter(db, svc);

  const mgrA = `mgrA-${sfx}`, mgrBOld = `mgrBold-${sfx}`;
  mkSession({ id: mgrA, projectId: pA, agentId: agA, role: "manager" });
  mkSession({ id: mgrBOld, projectId: pB, agentId: agB, role: "manager" });
  pty.setLive(mgrA); pty.setLive(mgrBOld); pty.setBusy(mgrBOld); // pB's manager is busy → the send holds

  const mgrAClient = await connect(orch.buildServer(mgrA, "manager"));
  const mCall = async (name, args) => parse(await mgrAClient.callTool({ name, arguments: args }));

  // ===================== (1) SEND while pB's manager is busy ⇒ held/queued =====================
  const sent = await mCall("peer_message", { targetProjectId: pB, text: "the exact letter card af995d1d is about" });
  check("(1) setup: the send HELD (busy target) and returned a msgId", sent.deliveryStatus === "queued" && typeof sent.msgId === "string");
  const originalMsgId = sent.msgId;

  const preStatus = await mCall("peer_message_status", { msgId: originalMsgId });
  check("(1) pre-recycle: peer_message_status reads \"pending\" (genuinely still held, unresolved either way)",
    preStatus.found === true && preStatus.state === "pending" && preStatus.at === null);
  check("(1) pre-recycle: sentAt is a real timestamp (the original send instant)", typeof preStatus.sentAt === "string" && preStatus.sentAt.length > 0);
  const sentAt = preStatus.sentAt;

  // ===================== (2) RECYCLE the recipient WHILE the send is still held =====================
  const fresh = await svc.recycleManager(mgrBOld, "successor: drain the queue");
  check("(2) the predecessor's held record is SUPERSEDED", db.listUnresolvedQueuedMessagesForWorker(mgrBOld).length === 0);
  const reminted = db.listUnresolvedQueuedMessagesForWorker(fresh.id);
  check("(2) exactly ONE record re-minted onto the successor", reminted.length === 1);

  // Mechanism-level proof, not just the externally-observed effect: a session_message_gave_up
  // (outcome:"reminted") event now links the ORIGINAL msgId forward to the successor's copy — the fix.
  const linkEvent = db.listEvents(mgrA).find((e) => e.kind === "session_message_gave_up" && e.detail?.msgId === originalMsgId);
  check("(2) FIX MECHANISM: a session_message_gave_up(outcome:\"reminted\") event links the OLD msgId forward",
    linkEvent?.detail?.outcome === "reminted" && typeof linkEvent?.detail?.remintedAs === "string");
  const newMsgId = linkEvent?.detail?.remintedAs;
  check("(2) FIX MECHANISM: the link's remintedAs matches the successor's own re-minted durable record",
    typeof newMsgId === "string" && reminted[0]?.detail?.msgId === newMsgId);

  // ===================== (3) INTERMEDIATE: still pending — the successor hasn't drained it yet =====================
  const midStatus = await mCall("peer_message_status", { msgId: originalMsgId });
  check("(3) immediately after the recycle (before the successor drains): STILL \"pending\" — not falsely delivered, not stuck-wrong either",
    midStatus.found === true && midStatus.state === "pending" && midStatus.at === null);
  check("(3) sentAt is UNCHANGED across the recycle hop (still the ORIGINAL send instant)", midStatus.sentAt === sentAt);

  // ===================== (4) the successor's copy DRAINS normally (a real, successful hand-off) =====================
  pty.setBusy(fresh.id, false); // successor becomes idle/ready
  const successorEntry = pty.pendingEntries(fresh.id).find((m) => m.id?.startsWith("qm-"));
  check("(4) setup: the successor's queued copy carried an onDeliver callback (the real hand-off hook)", typeof successorEntry?.onDeliver === "function");
  successorEntry.onDeliver(); // simulates the successor's next Stop draining the FIFO — a real, successful hand-off

  // ===================== (5) THE REGRESSION ASSERTION: the ORIGINAL msgId now reads "delivered" =====================
  const postStatus = await mCall("peer_message_status", { msgId: originalMsgId });
  check("(5) THE FIX: peer_message_status(originalMsgId) now converges to \"delivered\" — never stuck \"pending\" forever",
    postStatus.found === true && postStatus.state === "delivered");
  check("(5) the delivered reading carries a REAL timestamp, not a null placeholder", typeof postStatus.at === "string" && postStatus.at.length > 0);
  check("(5) sentAt STILL reports the ORIGINAL send instant, not the successor's later delivery instant", postStatus.sentAt === sentAt && postStatus.at !== postStatus.sentAt);

  await mgrAClient.close();
  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a peer_message held for a manager that recycles before draining, whose successor's carried copy later drains normally, converges the ORIGINAL sender's peer_message_status read to \"delivered\" (never a permanent \"pending\") — the exact incident card af995d1d measured (a letter the recipient confirmed arrived and acted on, whose sender-side status read never converged). sentAt survives the recycle hop unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
