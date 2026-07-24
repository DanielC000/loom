import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Subordinate→lead relay (board card 2db23c4d) — an owner-facing NON-manager session (role "assistant":
// the Companion, or any ideation/thought-partner rig sharing that same role) gets ONE narrow lever,
// `notify_lead`, to message ITS OWN project's live manager. Mirrors peer_message's mechanics/test shape
// (peer-message.mjs), same-project instead of cross-project — no project-link gate, no target param at
// all. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService driven against a FAKE pty
// (enqueueStdin spied so we can assert delivery routing + framing + kind), the REAL
// OrchestrationMcpRouter, driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD:
//   (1) notify_lead is registered on the ASSISTANT surface only (never manager/worker).
//   (2) a live manager in the caller's own project receives the relay LIVE, framed
//       [loom:from-assistant · <name> · sessionId:...], kind:"agent" (one-per-turn).
//   (3) manager-ONLY match: a live WORKER in the same project (no live manager) is never delivered to —
//       falls through to boarding instead.
//   (4) NOT-LIVE (no live manager at all) target boards a durable card on the caller's OWN project board.
//   (5) an `assistant_relay_message` audit event is recorded for both the live-delivery and boarded cases.
//   (6) a manager RECYCLE is survived for free: the predecessor manager's row is no longer live, the
//       successor's live row in the same project is the one that receives the relay — no stale target.
//   (7) rate limiting caps a flood from the same origin assistant session, in its OWN dedicated bucket
//       (never shared with peer_message's).
//   (8) defense in depth: a non-assistant caller is rejected at the service layer.
//
// Run: 1) build (turbo builds shared first), 2) node test/notify-lead.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-notify-lead-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { __resetNotifyLeadRateLimitState, __resetPeerMessageRateLimitState, NOTIFY_LEAD_RATE_MAX } =
  await import("../dist/sessions/peer-message-guard.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-notify-lead-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# notify_lead test repo\n");
execSync(`git init -q && git add . && git -c user.email=nl@loom -c user.name=nl commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B (worker-only)", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pA", name: "A", startupPrompt: "A", position: 0, profileId: null });
db.insertAgent({ id: "agentAsst", projectId: "pA", name: "Thought Partner", startupPrompt: "TP", position: 1, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pB", name: "B", startupPrompt: "B", position: 0, profileId: null });

const seedSession = (id, projectId, agentId, role, parent, processState = "live") => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("ASST_A", "pA", "agentAsst", "assistant", null);    // the relaying assistant (pA)
seedSession("MGR_A", "pA", "agentA", "manager", null);          // pA's LIVE manager
seedSession("WKR_B", "pB", "agentB", "worker", null);           // a live WORKER in pB — no live manager there

// Fake pty: capture createPty (spawn) + stop, AND spy enqueueStdin (full arg list, so we can assert the
// framing/source/kind the real enqueueDurableMessage channel uses) so we can prove delivery routing
// without a real claude TUI.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; this.enqueued = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
  enqueueStdin(id, text, source, _onDeliver, _opts, kind) { this.enqueued.push({ id, text, source, kind }); return { delivered: true }; }
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
  const client = new Client({ name: "notify-lead-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const asstClient = await connect(orch.buildServer("ASST_A", "assistant"));
  const aCall = async (name, args) => parse(await asstClient.callTool({ name, arguments: args }));

  // ===================== (1) notify_lead is registered on the ASSISTANT surface only =====================
  const asstTools = (await asstClient.listTools()).tools.map((t) => t.name);
  check("(1) notify_lead is registered on the ASSISTANT surface", asstTools.includes("notify_lead"));
  const mgrToolsA = (await (async () => {
    const c = await connect(orch.buildServer("MGR_A", "manager"));
    const t = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return t;
  })());
  check("(1) notify_lead is NOT on the MANAGER surface (manager has no need to relay to itself)", !mgrToolsA.includes("notify_lead"));
  const wkrToolsB = (await (async () => {
    const c = await connect(orch.buildServer("WKR_B", "worker"));
    const t = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return t;
  })());
  check("(1) notify_lead is NOT on the WORKER surface", !wkrToolsB.includes("notify_lead"));

  // ===================== (2) a live manager in the caller's own project receives the relay =====================
  const enqBeforeA = host.enqueued.length;
  const delivered = await aCall("notify_lead", { text: "can you check on the merge queue?" });
  check("(2) a live manager in the caller's own project delivers live (deliveryStatus delivered-live)",
    delivered.deliveryStatus === "delivered-live" && !delivered.error);
  const lastEnq = host.enqueued[host.enqueued.length - 1];
  check("(2) delivered to MGR_A specifically, framed [loom:from-assistant · Thought Partner · sessionId:ASST_A], kind:\"agent\" (one-per-turn)",
    host.enqueued.length === enqBeforeA + 1 && lastEnq.id === "MGR_A" && lastEnq.kind === "agent" &&
    lastEnq.text.startsWith("[loom:from-assistant · Thought Partner · sessionId:ASST_A]\n") &&
    lastEnq.text.includes("can you check on the merge queue?"));

  // ===================== (3) manager-ONLY match — a live worker in a DIFFERENT project is irrelevant, =====
  // and (4) a project with NO live manager at all boards instead. Reuse pB (worker-only) as the assistant's
  // OWN project to prove both: no manager anywhere in pB, so notify_lead must board, never match WKR_B.
  seedSession("ASST_B", "pB", "agentB", "assistant", null);
  const asstBClient = await connect(orch.buildServer("ASST_B", "assistant"));
  const bCall = async (name, args) => parse(await asstBClient.callTool({ name, arguments: args }));
  const enqBeforeB = host.enqueued.length;
  const tasksBBefore = db.listTasks("pB").length;
  const toNoManager = await bCall("notify_lead", { text: "is anyone home" });
  check("(3) a live WORKER (no live manager) in the caller's project never gets the message delivered to it",
    !host.enqueued.slice(enqBeforeB).some((e) => e.id === "WKR_B"));
  check("(4) instead it BOARDS on the caller's OWN project board (deliveryStatus boarded + taskId)",
    toNoManager.deliveryStatus === "boarded" && !!toNoManager.taskId && !toNoManager.error &&
    db.listTasks("pB").length === tasksBBefore + 1);
  const boardedB = db.getTask(toNoManager.taskId);
  check("(4) the boarded card landed on pB (the caller's own project)", boardedB?.projectId === "pB");
  await asstBClient.close();

  // ===================== (5) assistant_relay_message audit event recorded (both directions) =====================
  check("(5) a assistant_relay_message audit event was recorded for the live-delivery case",
    db.listEvents("ASST_A").some((e) => e.kind === "assistant_relay_message" &&
      e.detail?.assistantSessionId === "ASST_A" && e.detail?.projectId === "pA" &&
      e.detail?.targetSessionId === "MGR_A" && e.detail?.deliveryStatus === "delivered-live"));
  check("(5) the boarded (no-live-manager) case was ALSO audited, with no targetSessionId",
    db.listEvents("ASST_B").some((e) => e.kind === "assistant_relay_message" &&
      e.detail?.projectId === "pB" && e.detail?.deliveryStatus === "boarded" && e.detail?.targetSessionId === null));

  // ===================== (6) a manager RECYCLE is survived for free =====================
  // Retire MGR_A (mirrors what recycleAsManager does to a predecessor) and insert a FRESH successor row,
  // live, in the SAME project — notify_lead must re-resolve to the successor, never the stale predecessor.
  db.setProcessState("MGR_A", "exited");
  seedSession("MGR_A2", "pA", "agentA", "manager", null);
  const enqBeforeRecycle = host.enqueued.length;
  const afterRecycle = await aCall("notify_lead", { text: "still there?" });
  check("(6) after a manager recycle, the relay reaches the NEW live successor, not the exited predecessor",
    afterRecycle.deliveryStatus === "delivered-live" &&
    host.enqueued.length === enqBeforeRecycle + 1 &&
    host.enqueued[host.enqueued.length - 1].id === "MGR_A2");

  await asstClient.close();

  // ===================== (7) rate limiting caps a flood from one origin assistant session =====================
  __resetNotifyLeadRateLimitState();
  __resetPeerMessageRateLimitState(); // leave the sibling bucket untouched either way — dedicated buckets
  const floodClient = await connect(orch.buildServer("ASST_A", "assistant"));
  const floodCall = async (i) => parse(await floodClient.callTool({ name: "notify_lead", arguments: { text: `flood ${i}` } }));
  let sawRateLimitError = false;
  for (let i = 0; i < NOTIFY_LEAD_RATE_MAX + 5; i++) {
    const r = await floodCall(i);
    if (r.error && /rate limit/.test(r.error)) { sawRateLimitError = true; break; }
  }
  check(`(7) a flood past the ${NOTIFY_LEAD_RATE_MAX}-call window is rejected with a rate-limit error`, sawRateLimitError);
  await floodClient.close();
  __resetNotifyLeadRateLimitState(); // leave clean state behind

  // ===================== (8) defense in depth: a non-assistant caller is rejected =====================
  let svcRejected = false;
  try { svc.notifyLead("WKR_B", "x"); } catch (e) { svcRejected = /assistant-only/.test(e.message); }
  check("(defense in depth) svc.notifyLead rejects a non-assistant caller", svcRejected);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — notify_lead is assistant-only (never manager/worker), delivers ONLY to its own project's LIVE manager (never a worker there — falls through to a durable board card instead), frames + delivers kind:\"agent\" one-per-turn via the shared enqueueDurableMessage channel, records an assistant_relay_message audit event both live and boarded, survives a manager recycle by re-resolving the live successor, rate-limits a flood from one origin assistant session in its own dedicated bucket, and rejects a non-assistant caller at the service layer — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
