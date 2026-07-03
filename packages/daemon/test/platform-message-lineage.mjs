import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5519559c — session_message (Platform Lead, P4) must route a NOT-LIVE target to the LIVE successor
// in its recycle lineage before falling back to boarding. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like platform-messaging.mjs: a REAL Db + SessionService driven against a FAKE pty (spying
// enqueueStdin to assert delivery routing), the REAL PlatformMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD:
//   (a) session_message to a RECYCLED (not-live) target with a LIVE successor delivers to the successor —
//       NOT boarded — and the response's routedTo names the successor.
//   (b) the forward walk follows a MULTI-HOP lineage (dead -> dead -> live), not just one hop.
//   (c) session_message to a not-live target whose lineage has NO live session anywhere still falls back
//       to boarding (the pre-existing behavior, unregressed).
//   (d) this is independent of card 2ca18433's "still-live-then-recycles-after-queuing" path — a plain
//       live delivery (no recycle involved) is untouched (no routedTo, deliveryStatus delivered-live).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-message-lineage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-p4-lineage-${Date.now()}-${process.pid}`);
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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-p4-lineage-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform lineage-routing test repo\n");
execSync(`git init -q && git add . && git -c user.email=p4@loom -c user.name=p4 commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

const seedSession = (id, processState, recycledFrom) => db.insertSession({
  id, projectId: "pOrd", agentId: "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: null, parentSessionId: null, recycledFrom: recycledFrom ?? null,
});
seedSession("PL", "live", null); // the calling Lead (not addressed by the surface itself)

// (a) one-hop lineage: ONE-A (recycled, dead) -> ONE-B (its live successor).
seedSession("ONE-A", "exited", null);
seedSession("ONE-B", "live", "ONE-A");

// (b) multi-hop lineage: TWO-A (dead) -> TWO-B (recycled again, ALSO dead) -> TWO-C (live).
seedSession("TWO-A", "exited", null);
seedSession("TWO-B", "exited", "TWO-A");
seedSession("TWO-C", "live", "TWO-B");

// (c) dead lineage with NO live session anywhere: THREE-A (dead) -> THREE-B (also dead, no further successor).
seedSession("THREE-A", "exited", null);
seedSession("THREE-B", "exited", "THREE-A");

// (d) a plain live target with no recycle history at all.
seedSession("PLAIN", "live", null);

// Fake pty: capture createPty (spawn) + stop, AND spy enqueueStdin so we can assert delivery routing.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; this.enqueued = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
  enqueueStdin(id, text) { this.enqueued.push({ id, text }); return { delivered: true }; }
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

const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "p4-lineage-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const platformClient = await connect(platform.buildServer());
  const pCall = async (name, args) => parse(await platformClient.callTool({ name, arguments: args }));

  // ===================== (a) one-hop: recycled target routes to its live successor =====================
  const tasksBeforeA = db.listTasks("pOrd").length;
  const enqBeforeA = host.enqueued.length;
  const resA = await pCall("session_message", { sessionId: "ONE-A", text: "one-hop routing" });
  check("(a) delivers to the LIVE successor, not boarded (deliveryStatus delivered-live)",
    resA.deliveryStatus === "delivered-live" && !resA.taskId && !resA.error);
  check("(a) routedTo names the live successor ONE-B", resA.routedTo === "ONE-B");
  const lastEnqA = host.enqueued[host.enqueued.length - 1];
  check("(a) the framed message was actually enqueued on the SUCCESSOR's id (ONE-B), not the dead target",
    host.enqueued.length === enqBeforeA + 1 && lastEnqA.id === "ONE-B" &&
    lastEnqA.text.startsWith("[loom:from-platform]\n") && lastEnqA.text.includes("one-hop routing"));
  check("(a) nothing was boarded on the project board", db.listTasks("pOrd").length === tasksBeforeA);
  check("(a) an audit event was recorded against the SUCCESSOR (ONE-B), not the dead target",
    db.listEventsForWorker("ONE-B").some((e) => e.kind === "session_message"));

  // ===================== (b) multi-hop: forward walk follows TWO dead links to the live end ============
  const enqBeforeB = host.enqueued.length;
  const resB = await pCall("session_message", { sessionId: "TWO-A", text: "multi-hop routing" });
  check("(b) a two-hop dead chain still resolves to the live end (deliveryStatus delivered-live)",
    resB.deliveryStatus === "delivered-live" && !resB.taskId && !resB.error);
  check("(b) routedTo names the live end of the chain (TWO-C), not the intermediate TWO-B",
    resB.routedTo === "TWO-C");
  const lastEnqB = host.enqueued[host.enqueued.length - 1];
  check("(b) the framed message landed on TWO-C's id", host.enqueued.length === enqBeforeB + 1 && lastEnqB.id === "TWO-C");

  // ===================== (c) dead lineage with no live session anywhere still boards (unregressed) =====
  const tasksBeforeC = db.listTasks("pOrd").length;
  const enqBeforeC = host.enqueued.length;
  const resC = await pCall("session_message", { sessionId: "THREE-A", text: "nobody home" });
  check("(c) a fully-dead lineage (no live session anywhere) still BOARDS (deliveryStatus boarded + taskId)",
    resC.deliveryStatus === "boarded" && !!resC.taskId && !resC.error);
  check("(c) boarding a fully-dead lineage has no routedTo", resC.routedTo === undefined);
  const boardedTaskC = db.getTask(resC.taskId);
  check("(c) the boarded card landed on the project board and captures the ORIGINAL target id",
    db.listTasks("pOrd").length === tasksBeforeC + 1 && boardedTaskC.body.includes("THREE-A") && boardedTaskC.body.includes("nobody home"));
  check("(c) boarding a fully-dead lineage enqueues nothing", host.enqueued.length === enqBeforeC);

  // ===================== (d) an ordinary live target (no recycle history) is untouched ==================
  const enqBeforeD = host.enqueued.length;
  const resD = await pCall("session_message", { sessionId: "PLAIN", text: "no lineage involved" });
  check("(d) a plain live target delivers directly with NO routedTo (lineage lookup is a no-op for it)",
    resD.deliveryStatus === "delivered-live" && resD.routedTo === undefined && !resD.error);
  const lastEnqD = host.enqueued[host.enqueued.length - 1];
  check("(d) the message landed on PLAIN's own id", host.enqueued.length === enqBeforeD + 1 && lastEnqD.id === "PLAIN");

  await platformClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_message to a recycled (not-live) target resolves FORWARD through its recycle " +
    "lineage to the live successor and delivers there (routedTo names it, one hop or many), falls back to " +
    "boarding only when the lineage has no live session anywhere, and leaves plain live delivery (no recycle " +
    "history) untouched — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
