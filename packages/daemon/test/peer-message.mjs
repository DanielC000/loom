import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Cross-project MANAGER<->MANAGER channel (board card 2349d90c) — a manager may message a LINKED peer
// project's manager via the new `peer_message` orchestration tool, gated server-side on the owner-declared
// `project_links` table (human-only, no MCP path). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, mirrors
// platform-messaging.mjs: a REAL Db + SessionService driven against a FAKE pty (enqueueStdin spied so we
// can assert delivery routing + framing + kind), the REAL OrchestrationMcpRouter (manager surface) and
// PlatformMcpRouter (to prove no project-link MCP tool exists anywhere), each driven over an in-process
// MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD:
//   (1) LINK gate: an UNLINKED target project is rejected — a manager can reach ONLY a declared-linked peer.
//   (2) manager<->manager ONLY: delivers to the target project's LIVE manager; a live WORKER in the target
//       project (no live manager there) is never matched — the message boards instead.
//   (3) self/same-project target rejected.
//   (4) nonexistent target project rejected.
//   (5) NOT-LIVE (no live manager at all) target boards a durable card on the target's OWN board instead
//       of being dropped.
//   (4b) a LINKED but ARCHIVED target is rejected outright — NOT dead-lettered as a board card on a
//       board nobody watches (the archived-target gap this test guards against).
//   (6) delivery is framed + kind:"agent" (one-per-turn), via the same enqueueDurableMessage channel as
//       worker_message/session_message — no privilege travels, just a data message.
//   (7) a `cross_project_message` audit event is recorded for both the live-delivery and boarded cases.
//   (8) rate limiting caps a flood from the same origin manager session.
//   (9) the project-link WRITE has NO MCP reachability — no tool on the platform OR manager surface can
//       create/delete a project_links row.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-message.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-peer-msg-${Date.now()}-${process.pid}`);
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { __resetPeerMessageRateLimitState, PEER_MESSAGE_RATE_MAX } = await import("../dist/sessions/peer-message-guard.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-peer-msg-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# peer_message test repo\n");
execSync(`git init -q && git add . && git -c user.email=peer@loom -c user.name=peer commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pC", name: "Project C (unlinked)", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pD", name: "Project D (worker-only)", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pE", name: "Project E (archived)", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: now, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pA", name: "A", startupPrompt: "A", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pB", name: "B", startupPrompt: "B", position: 0, profileId: null });
db.insertAgent({ id: "agentD", projectId: "pD", name: "D", startupPrompt: "D", position: 0, profileId: null });

// A links pB only (NOT pC) — the containment boundary under test.
db.createProjectLink("pA", "pB");

const seedSession = (id, projectId, agentId, role, parent, processState = "live") => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("MGR_A", "pA", "agentA", "manager", null);           // the sending manager (pA)
seedSession("MGR_B", "pB", "agentB", "manager", null);           // the linked peer's LIVE manager
seedSession("WKR_D", "pD", "agentD", "worker", null);            // a live WORKER in pD — no live manager there

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
const platform = new PlatformMcpRouter(db, svc);
const orch = new OrchestrationMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "peer-message-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const mgrAClient = await connect(orch.buildServer("MGR_A", "manager"));
  const mCall = async (name, args) => parse(await mgrAClient.callTool({ name, arguments: args }));
  const mgrTools = (await mgrAClient.listTools()).tools.map((t) => t.name);
  check("(0) peer_message is registered on the MANAGER surface", mgrTools.includes("peer_message"));

  // ===================== (1) LINK gate — an unlinked target is rejected =====================
  const unlinked = await mCall("peer_message", { targetProjectId: "pC", text: "hi from pA" });
  check("(1) an UNLINKED target project is rejected (no delivery, no board)",
    !!unlinked.error && /not linked/.test(unlinked.error));

  // ===================== (2) manager<->manager ONLY — a live worker never matches ===============
  // pD has no link to pA either, but even setting that aside: link pA<->pD and prove a live WORKER in pD
  // (no live manager there) is never delivered to — the tool must fall through to boarding.
  db.createProjectLink("pA", "pD");
  // pE is linked too, but soft-archived — the archived-target guard under test.
  db.createProjectLink("pA", "pE");
  const enqBeforeD = host.enqueued.length;
  const tasksDBefore = db.listTasks("pD").length;
  const toWorkerOnly = await mCall("peer_message", { targetProjectId: "pD", text: "is anyone home" });
  check("(2) a target project whose ONLY live session is a WORKER never gets the message delivered to it",
    !host.enqueued.slice(enqBeforeD).some((e) => e.id === "WKR_D"));
  check("(2) instead it BOARDS on the target project's own board (deliveryStatus boarded + taskId)",
    toWorkerOnly.deliveryStatus === "boarded" && !!toWorkerOnly.taskId && !toWorkerOnly.error &&
    db.listTasks("pD").length === tasksDBefore + 1);
  const boardedD = db.getTask(toWorkerOnly.taskId);
  check("(2) the boarded card landed on pD (the target project), not pA", boardedD?.projectId === "pD");

  // ===================== (3) self/same-project target rejected =====================
  const selfTarget = await mCall("peer_message", { targetProjectId: "pA", text: "talking to myself" });
  check("(3) targeting your OWN project is rejected", !!selfTarget.error && /own project/.test(selfTarget.error));

  // ===================== (4) nonexistent target project rejected =====================
  const ghost = await mCall("peer_message", { targetProjectId: "ghost-project", text: "hello?" });
  check("(4) a nonexistent target project is rejected", !!ghost.error && /not found/.test(ghost.error));

  // ============== (4b) a LINKED but ARCHIVED target is rejected, not dead-lettered as a board card ======
  const tasksEBefore = db.listTasks("pE").length;
  const toArchived = await mCall("peer_message", { targetProjectId: "pE", text: "are you still there?" });
  check("(4b) a linked-but-archived target project is rejected", !!toArchived.error && /archived/.test(toArchived.error));
  check("(4b) NO board card was created on the archived target's board", db.listTasks("pE").length === tasksEBefore);

  // ===================== (5)+(6) linked + LIVE manager — delivers framed, kind:"agent" =====================
  const enqBeforeB = host.enqueued.length;
  const delivered = await mCall("peer_message", { targetProjectId: "pB", text: "what's your webhook payload shape?" });
  check("(5) a linked target WITH a live manager delivers live (deliveryStatus delivered-live)",
    delivered.deliveryStatus === "delivered-live" && !delivered.error);
  const lastEnq = host.enqueued[host.enqueued.length - 1];
  check("(6) delivered to MGR_B specifically, framed [loom:from-manager · Project A · projectId:pA · sessionId:MGR_A], kind:\"agent\" (one-per-turn)",
    host.enqueued.length === enqBeforeB + 1 && lastEnq.id === "MGR_B" && lastEnq.kind === "agent" &&
    lastEnq.text.startsWith("[loom:from-manager · Project A · projectId:pA · sessionId:MGR_A]\n") &&
    lastEnq.text.includes("what's your webhook payload shape?"));

  // ====== (6b) the stamped id lets the RECIPIENT reply via peer_message with NO human relay ======
  // Prove the round-trip: parse the origin projectId out of the delivered frame (exactly as a recipient
  // manager would read it off its inbound turn) and use it as `targetProjectId` on a peer_message call
  // made AS the recipient (MGR_B) — this is the whole point of the stamp: a reply with no human relay.
  const stampMatch = lastEnq.text.match(/^\[loom:from-manager · .* · projectId:(\S+) · sessionId:(\S+)\]/);
  check("(6b) the delivered frame carries a parseable projectId + sessionId stamp",
    !!stampMatch && stampMatch[1] === "pA" && stampMatch[2] === "MGR_A");
  const mgrBClient = await connect(orch.buildServer("MGR_B", "manager"));
  const bCall = async (name, args) => parse(await mgrBClient.callTool({ name, arguments: args }));
  const enqBeforeReply = host.enqueued.length;
  const reply = await bCall("peer_message", { targetProjectId: stampMatch[1], text: "here's the payload shape" });
  check("(6b) MGR_B replies using ONLY the stamped projectId — delivered live back to MGR_A, no human relay",
    reply.deliveryStatus === "delivered-live" && !reply.error &&
    host.enqueued.length === enqBeforeReply + 1 &&
    host.enqueued[host.enqueued.length - 1].id === "MGR_A" &&
    host.enqueued[host.enqueued.length - 1].text.includes("here's the payload shape"));
  await mgrBClient.close();

  // ===================== (7) audit event recorded (both directions traceable) =====================
  check("(7) a cross_project_message audit event was recorded under the sending manager (origin/target/text)",
    db.listEvents("MGR_A").some((e) => e.kind === "cross_project_message" &&
      e.detail?.originProjectId === "pA" && e.detail?.targetProjectId === "pB" &&
      e.detail?.targetSessionId === "MGR_B" && e.detail?.deliveryStatus === "delivered-live"));
  check("(7) the boarded (2) case was ALSO audited, with no targetSessionId (no live manager)",
    db.listEvents("MGR_A").some((e) => e.kind === "cross_project_message" &&
      e.detail?.targetProjectId === "pD" && e.detail?.deliveryStatus === "boarded" && e.detail?.targetSessionId === null));

  await mgrAClient.close();

  // ===================== (8) rate limiting caps a flood from one origin manager =====================
  __resetPeerMessageRateLimitState();
  const floodClient = await connect(orch.buildServer("MGR_A", "manager"));
  const floodCall = async (i) => parse(await floodClient.callTool({ name: "peer_message", arguments: { targetProjectId: "pB", text: `flood ${i}` } }));
  let sawRateLimitError = false;
  for (let i = 0; i < PEER_MESSAGE_RATE_MAX + 5; i++) {
    const r = await floodCall(i);
    if (r.error && /rate limit/.test(r.error)) { sawRateLimitError = true; break; }
  }
  check(`(8) a flood past the ${PEER_MESSAGE_RATE_MAX}-call window is rejected with a rate-limit error`, sawRateLimitError);
  await floodClient.close();
  __resetPeerMessageRateLimitState(); // leave clean state behind

  // ===================== (9) project-link WRITE has NO MCP reachability =====================
  const platformTools = (await (async () => {
    const c = await connect(platform.buildServer());
    const tools = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return tools;
  })());
  const allMcpToolNames = [...mgrTools, ...platformTools];
  check("(9) NO tool on the manager OR platform MCP surface can create/delete a project link",
    !allMcpToolNames.some((n) => /project.?link/i.test(n)));

  // Defense in depth: the service method itself rejects a non-manager caller.
  let svcRejected = false;
  try { svc.messagePeerManager("WKR_D", "pB", "x"); } catch (e) { svcRejected = /manager-only/.test(e.message); }
  check("(defense in depth) svc.messagePeerManager rejects a non-manager caller", svcRejected);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — peer_message is manager-gated, delivers ONLY to a linked peer project's LIVE manager (never a worker/other role there — falls through to a durable board card instead), rejects an unlinked/self/nonexistent/archived target (an archived target never dead-letters a board card), frames + delivers kind:\"agent\" one-per-turn via the shared enqueueDurableMessage channel, records a cross_project_message audit event both live and boarded, rate-limits a flood from one origin manager, and the project_links WRITE has no MCP path on any surface — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
