import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8457d0ed: `notifyLead`'s own live-target resolution was a bare `role==="manager" &&
// processState==="live"` scan — the THIRD site of the class card e79e2956 fixed at
// `messagePeerManager`/`platformEscalate`. A recycling predecessor stays `processState:"live"` until its
// successor SETTLES (an async step, seconds later) while `hasSuccessor` flips true SYNCHRONOUSLY at the
// successor's own insert — so during that window BOTH the predecessor and its successor are live manager
// rows in the same project, and the old scan could resolve the about-to-retire predecessor instead of its
// already-live successor. The fix excludes any session with a live successor, mirroring
// `redriveQueuedMessage`'s own guard (and e79e2956's two sites).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — mirrors peer-message-ack-cursor.mjs's own fixture shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-notify-lead-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-notify-lead-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# notify_lead live-successor test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=notify-lead@loom -c user.name=notify-lead");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentAssist", projectId: "pA", name: "Assistant", startupPrompt: "Assistant", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pA", name: "Manager", startupPrompt: "Manager", position: 0, profileId: null });

const seedSession = (id, projectId, agentId, role, extra = {}) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null, ...extra,
});
seedSession("ASSIST_A", "pA", "agentAssist", "assistant");
seedSession("MGR_A_OLD", "pA", "agentMgr", "manager"); // the recycling predecessor — stays "live" during settle
seedSession("MGR_A_NEW", "pA", "agentMgr", "manager", { recycledFrom: "MGR_A_OLD", gen: 1 }); // its already-live successor

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.enqueued = []; }
  enqueueStdin(id, text, source, _onDeliver, _opts, kind) {
    this.enqueued.push({ id, text, kind });
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
  const client = new Client({ name: "notify-lead-live-successor-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const assistClient = await connect(orch.buildServer("ASSIST_A", "assistant"));
  const aCall = async (name, args) => parse(await assistClient.callTool({ name, arguments: args }));

  // ===================== A live successor must win over its still-live predecessor =====================
  check("(setup) hasSuccessor(MGR_A_OLD) is true — the successor row alone establishes this, synchronously",
    db.hasSuccessor("MGR_A_OLD") === true);
  check("(setup) MGR_A_OLD is STILL processState:live — the transient overlap window this test targets",
    db.getSession("MGR_A_OLD").processState === "live");

  const raceSend = await aCall("notify_lead", { text: "status update while my manager recycles" });
  check("(1) delivers live (a live successor exists)", raceSend.deliveryStatus === "delivered-live" && !raceSend.error);
  check("(1) delivered to the SUCCESSOR (MGR_A_NEW), never the superseded predecessor",
    host.enqueued.length === 1 && host.enqueued[0].id === "MGR_A_NEW");
  check("(1) the response names the successor as targetSessionId, not the predecessor",
    raceSend.targetSessionId === "MGR_A_NEW");

  // ===================== Control: once the predecessor is gone, a plain live scan still works =====================
  db.setProcessState("MGR_A_OLD", "exited");
  host.enqueued.length = 0;
  const stable = await aCall("notify_lead", { text: "a normal, non-racing relay" });
  check("(2) a normal single-live-manager relay still delivers live", stable.deliveryStatus === "delivered-live" && !stable.error);
  check("(2) delivered to the (only live) manager", host.enqueued.length === 1 && host.enqueued[0].id === "MGR_A_NEW");
  check("(2) the response names it as targetSessionId", stable.targetSessionId === "MGR_A_NEW");

  console.log(failures === 0
    ? "\n✅ ALL PASS — notify_lead resolves the project's LIVE successor manager over a still-live recycling predecessor, and a normal single-live-manager relay is unaffected."
    : `\n❌ ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
}
