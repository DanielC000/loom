import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0f693dea — "a peer_message sender has no way to verify delivery, and gets no signal for recycle
// latency". The card's own §RETRACTED section killed the original misrouting premise (a resolved
// targetSessionId legitimately changes at every manager handoff — that's expected, not a fault), but kept
// §NEW-EVIDENCE alive: a `[loom:redelivery-parked]` notice tells a peer_message sender delivery may have
// failed AND, in the same breath, that no check exists for it — a genuine dead end. This suite proves the
// fix:
//   DoD-2 (PRIMARY): `peer_message_status(msgId)` — a sender-side delivery read keyed to a peer_message's
//     own msgId, scoped to the CALLER's own event stream (never another manager's sends, never the peer's
//     transcript/internals).
//   DoD-3: a `recycledSincePriorSend` disclosure + advisory when the resolved targetSessionId differs from
//     the sender's own previous send to the same targetProjectId — the bare-id-change #125 misread.
//   DoD-4: a `queued` result carries an advisory that a successor seat may read it.
//   DoD-5 (the card's own test list): same-session resend ⇒ unchanged shape · resolved-session change
//     between sends ⇒ disclosure appears · a parked send ⇒ the sender-side delivery read resolves it ·
//     zero live managers ⇒ still BOARDS (regression guard).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — mirrors peer-message.mjs's own harness: a REAL Db +
// SessionService driven against a FAKE pty (enqueueStdin spied/scripted so busy/idle and give-up/confirm
// are directly controllable), the REAL OrchestrationMcpRouter, over an in-process MCP InMemoryTransport.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-message-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-msg-status-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { __resetPeerMessageRateLimitState } = await import("../dist/sessions/peer-message-guard.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-peer-msg-status-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# peer_message_status test repo\n");
execSync(`git init -q && git add . && git -c user.email=peer@loom -c user.name=peer commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pC", name: "Project C (no live sessions)", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pA", name: "A", startupPrompt: "A", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pB", name: "B", startupPrompt: "B", position: 0, profileId: null });

db.createProjectLink("pA", "pB");
db.createProjectLink("pA", "pC");

const seedSession = (id, projectId, agentId, role, processState = "live", recycledFrom = null) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null, recycledFrom,
});
seedSession("MGR_A", "pA", "agentA", "manager");   // the sending manager
seedSession("MGR_B1", "pB", "agentB", "manager");  // pB's first live manager

// Fake pty: BUSY set is directly controllable so a send can be forced onto the held (queued) path;
// otherwise delivers immediately. Mirrors peer-message.mjs's own SeamHost, plus a `busy` Set this file
// controls directly (peer-message.mjs never needed a queued/held peer send).
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.enqueued = []; this.busy = new Set(); this.nextPosition = 1; }
  createPty(opts) { return super.createPty(opts); }
  stop() {}
  enqueueStdin(id, text, source, onDeliver, _opts, kind, _questionId, _ownerText, _proactive, _senderId, tail, onGiveUpExhaustedPositional) {
    const isTailObject = typeof tail === "object" && tail !== null;
    const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : onGiveUpExhaustedPositional;
    this.enqueued.push({ id, text, source, kind, onGiveUpExhausted, onDeliver });
    if (this.busy.has(id)) return { delivered: false, position: this.nextPosition++ };
    return { delivered: true };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const orch = new OrchestrationMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);
async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "peer-message-status-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const mgrAClient = await connect(orch.buildServer("MGR_A", "manager"));
  const mCall = async (name, args) => parse(await mgrAClient.callTool({ name, arguments: args }));
  const mgrTools = (await mgrAClient.listTools()).tools.map((t) => t.name);
  check("(0) peer_message_status is registered on the MANAGER surface", mgrTools.includes("peer_message_status"));

  // ===================== (a) DELIVERED-LIVE: msgId returned, status resolves "delivered" =====================
  const delivered = await mCall("peer_message", { targetProjectId: "pB", text: "hello B" });
  check("(a) delivered-live send returns a msgId", delivered.deliveryStatus === "delivered-live" && typeof delivered.msgId === "string" && delivered.msgId.length > 0);
  const aStatus = await mCall("peer_message_status", { msgId: delivered.msgId });
  check("(a) peer_message_status resolves a delivered-live send: found:true, state:\"delivered\"",
    aStatus.found === true && aStatus.state === "delivered" && typeof aStatus.at === "string");

  // ===================== (b) UNKNOWN msgId: found:false, state:null, at:null =====================
  const bStatus = await mCall("peer_message_status", { msgId: "not-a-real-msgid" });
  check("(b) an unrecognized msgId returns found:false, state:null, at:null (not an error)",
    bStatus.found === false && bStatus.state === null && bStatus.at === null);

  // ===================== (c) ZERO LIVE MANAGERS ⇒ still BOARDS (regression guard, DoD-5) =====================
  const tasksCBefore = db.listTasks("pC").length;
  const boarded = await mCall("peer_message", { targetProjectId: "pC", text: "anyone home?" });
  check("(c) a target project with ZERO live sessions of any kind still BOARDS, not an error",
    boarded.deliveryStatus === "boarded" && !!boarded.taskId && !boarded.error && db.listTasks("pC").length === tasksCBefore + 1);
  check("(c) a boarded send carries NO msgId (no redelivery chain to track)", boarded.msgId === undefined);

  // ===================== (d) QUEUED: msgId returned, advisory present, status "pending" =====================
  __resetPeerMessageRateLimitState();
  host.busy.add("MGR_B1");
  const queued = await mCall("peer_message", { targetProjectId: "pB", text: "are you free?" });
  check("(d) a HELD (busy) send reports deliveryStatus:\"queued\" with a msgId", queued.deliveryStatus === "queued" && typeof queued.msgId === "string");
  check("(d) DoD-4: a queued result carries an advisory that a successor seat may read it",
    typeof queued.advisory === "string" && /successor/i.test(queued.advisory));
  const dStatus = await mCall("peer_message_status", { msgId: queued.msgId });
  check("(d) peer_message_status on a still-queued msgId reads \"pending\" (found, unresolved either way)",
    dStatus.found === true && dStatus.state === "pending");

  // ===== (d2) CR CRITICAL FIX PROOF: a HELD send that later DRAINS NORMALLY must resolve to "delivered", =====
  // ===== never read "pending" forever. Root cause the CR found: resolveQueuedMessage (service.ts) used to ===
  // ===== stamp session_message_delivered with managerSessionId:"" (never the sender) — a sender-scoped ======
  // ===== db.listEvents(managerSessionId) read could NEVER see it. FIXED AT THE SOURCE (not by widening =======
  // ===== peer_message_status's own read into the peer's stream — a REJECTED option, see that function's ====
  // ===== own doc, mcp/orchestration.ts): resolveQueuedMessage now threads the real originating sender ========
  // ===== through, so the event simply appears where peer_message_status already looks. Simulate the real ===
  // ===== drain by firing the SAME onDeliver callback pty.enqueueStdin was given (the real drain/ =============
  // ===== consumePending path invokes exactly this), then re-read status — this is the reviewer's required ===
  // ===== RED-then-GREEN: against the pre-fix code (resolveQueuedMessage hard-coding managerSessionId:"") ====
  // ===== the FIRST check below goes RED; against the fix it's GREEN. =========================================
  const dEnqueued = host.enqueued.find((e) => e.id === "MGR_B1" && e.text.includes("are you free?"));
  check("(d2) setup: the queued dispatch carried an onDeliver callback (the real hand-off hook)", typeof dEnqueued?.onDeliver === "function");
  dEnqueued.onDeliver(); // simulates the recipient's next Stop draining the FIFO — a real, successful hand-off
  const d2Status = await mCall("peer_message_status", { msgId: queued.msgId });
  check("(d2) CRITICAL FIX: a queued send that DRAINS resolves to \"delivered\" (not stuck \"pending\" forever)",
    d2Status.found === true && d2Status.state === "delivered");
  check("(d2) CRITICAL FIX: the delivered reading carries a REAL timestamp, not a null placeholder", typeof d2Status.at === "string" && d2Status.at.length > 0);
  // (d2 cont'd) mechanism-level proof, not just the externally-observed effect: the session_message_delivered
  // event itself now carries the REAL sender — this is what makes it visible to a sender-scoped read at all.
  const deliveredEvent = db.listEventsForWorker("MGR_B1").find((e) => e.kind === "session_message_delivered" && e.detail?.msgId === queued.msgId);
  check("(d2 cont'd) the session_message_delivered event carries managerSessionId:\"MGR_A\" (the real sender), not \"\"",
    deliveredEvent?.managerSessionId === "MGR_A");

  // ===================== (e) SAME-SESSION RESEND ⇒ unchanged shape (DoD-5) =====================
  const resend = await mCall("peer_message", { targetProjectId: "pB", text: "still there?" });
  check("(e) a resend to the SAME resolved target session carries no recycledSincePriorSend disclosure",
    resend.targetSessionId === "MGR_B1" && resend.recycledSincePriorSend === undefined
    && (resend.advisory === undefined || !resend.advisory.includes("manager session changed")));
  host.busy.delete("MGR_B1");

  // ===================== (f) PARK ⇒ the sender-side delivery read resolves it (DoD-5, the primary ask) =====
  __resetPeerMessageRateLimitState();
  const enqBeforePark = host.enqueued.length;
  const parkSend = await mCall("peer_message", { targetProjectId: "pB", text: "PEER_STATUS_PARK_TEST" });
  check("(f) setup: park-test send returns a msgId", typeof parkSend.msgId === "string");
  const firstDispatch = host.enqueued.slice(enqBeforePark).find((e) => e.id === "MGR_B1");
  check("(f) setup: the dispatch carried a give-up hook", typeof firstDispatch?.onGiveUpExhausted === "function");
  firstDispatch.onGiveUpExhausted(); // chainDepth 0 -> re-mint (below GIVE_UP_REMINT_LIMIT)
  const remint = host.enqueued.slice(enqBeforePark).find((e) => e.id === "MGR_B1" && e !== firstDispatch);
  check("(f) setup: the give-up RE-MINTED a fresh dispatch", typeof remint?.onGiveUpExhausted === "function");
  remint.onGiveUpExhausted(); // chainDepth 1 -> terminal PARK
  const fStatus = await mCall("peer_message_status", { msgId: parkSend.msgId });
  check("(f) PARK COVERAGE: peer_message_status resolves a parked send's ROOT msgId to state:\"parked\" — the dead end DoD-2 exists to close",
    fStatus.found === true && fStatus.state === "parked" && typeof fStatus.at === "string");

  // ===================== (g) CONFIRMED-AFTER-PARK: a late confirming hook corrects the reading =====================
  svc.handleGiveUpConfirmed("MGR_B1", parkSend.msgId, 12345);
  const gStatus = await mCall("peer_message_status", { msgId: parkSend.msgId });
  check("(g) a late confirming hook corrects the SAME msgId's reading to \"confirmed-after-park\"",
    gStatus.found === true && gStatus.state === "confirmed-after-park");

  // ===================== (h) OWNERSHIP: another manager can never resolve MGR_A's own msgId =====================
  seedSession("MGR_C", "pC", "agentA", "manager"); // reuse agentA — only role/project matter here
  db.createProjectLink("pC", "pB"); // give pC the tool floor too (peer_message_status gated like peer_message)
  const mgrCClient = await connect(orch.buildServer("MGR_C", "manager"));
  const cCall = async (name, args) => parse(await mgrCClient.callTool({ name, arguments: args }));
  const hStatus = await cCall("peer_message_status", { msgId: delivered.msgId });
  check("(h) OWNERSHIP: a DIFFERENT manager querying MGR_A's own msgId gets found:false — never another sender's delivery state",
    hStatus.found === false && hStatus.state === null);
  // (h cont'd) OWNERSHIP holds even against an 8-char PREFIX of another sender's msgId — proves (j) below's
  // prefix resolution is scoped by lineage FIRST, never a global prefix scan across every sender.
  const hPrefixStatus = await cCall("peer_message_status", { msgId: delivered.msgId.slice(0, 8) });
  check("(h cont'd) OWNERSHIP: a DIFFERENT manager querying an 8-char PREFIX of MGR_A's own msgId also gets found:false",
    hPrefixStatus.found === false && hPrefixStatus.state === null);
  await mgrCClient.close();

  // ===== (j) CR MAJOR-1 FIX PROOF: an unambiguous 8-char id-PREFIX resolves — the SAME truncated value =====
  // ===== the [loom:redelivery-parked] notice actually hands a sender (it only ever slices to 8 chars; =====
  // ===== see peer-message.mjs's (10)/(10b) for the notice's OWN literal text making this same proof). =====
  const jStatus = await mCall("peer_message_status", { msgId: delivered.msgId.slice(0, 8) });
  check("(j) CR MAJOR-1 FIX: an unambiguous 8-char msgId PREFIX resolves exactly like the full id",
    jStatus.found === true && jStatus.state === "delivered" && jStatus.msgId === delivered.msgId);

  // ===== (l) CR MAJOR-2 FIX PROOF: a RECYCLED sender can still resolve a msgId its PREDECESSOR minted — =====
  // ===== the card's own subject (recycle-awareness), reproduced inside its own fix's ownership scoping. =====
  seedSession("MGR_A2", "pA", "agentA", "manager", "live", "MGR_A");
  const mgrA2Client = await connect(orch.buildServer("MGR_A2", "manager"));
  const a2Call = async (name, args) => parse(await mgrA2Client.callTool({ name, arguments: args }));
  const lStatus = await a2Call("peer_message_status", { msgId: delivered.msgId });
  check("(l) CR MAJOR-2 FIX: a RECYCLED successor (MGR_A2, recycledFrom:MGR_A) resolves a msgId its PREDECESSOR (MGR_A) minted",
    lStatus.found === true && lStatus.state === "delivered");
  await mgrA2Client.close();

  // ===================== (i) RESOLVED-SESSION CHANGE BETWEEN SENDS ⇒ disclosure appears (DoD-3, DoD-5) =====
  __resetPeerMessageRateLimitState();
  db.setProcessState("MGR_B1", "exited"); // MGR_B1 is no longer live — simulates a recycle at the target
  seedSession("MGR_B2", "pB", "agentB", "manager"); // a fresh successor manager for pB comes up live
  const recycled = await mCall("peer_message", { targetProjectId: "pB", text: "still there? (after recycle)" });
  check("(i) a send whose resolved targetSessionId DIFFERS from the sender's own prior send to this project reports recycledSincePriorSend:true",
    recycled.deliveryStatus === "delivered-live" && recycled.targetSessionId === "MGR_B2" && recycled.recycledSincePriorSend === true);
  check("(i) DoD-3: the advisory names old and new session prefixes, framed as a recycle — not a routing fault",
    typeof recycled.advisory === "string" && recycled.advisory.includes("MGR_B1".slice(0, 8)) && recycled.advisory.includes("MGR_B2".slice(0, 8))
    && /recycle/i.test(recycled.advisory) && recycled.advisory.includes("not a routing fault"));

  // (i cont'd) a FOLLOW-UP send to the SAME (now-stable) target session again carries NO disclosure —
  // proves this is edge-triggered (fires once, on the actual change), not sticky/always-on.
  const afterRecycle = await mCall("peer_message", { targetProjectId: "pB", text: "one more, same target" });
  check("(i cont'd) a further send to the SAME (unchanged) target session carries no recycledSincePriorSend",
    afterRecycle.targetSessionId === "MGR_B2" && afterRecycle.recycledSincePriorSend === undefined);

  await mgrAClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — peer_message_status resolves a sender's own msgId (delivered/pending/parked/confirmed-after-park/unknown), scoped strictly to the caller's own sends (never another manager's, never the peer's own state); peer_message discloses a targetSessionId change since the sender's own prior send to that project (recycledSincePriorSend + advisory) without being sticky, a queued send advises that a successor seat may read it, and a zero-live-managers target still boards."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
