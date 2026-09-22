import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e79e2956: the manager peer channel gets a "delivery cursor" against two concrete defects.
//
// Defect B (recipient-generation check): `messagePeerManager`'s live-target resolution used to be a bare
// `role==="manager" && processState==="live"` scan. A recycling predecessor stays `processState:"live"`
// until its successor SETTLES (an async step, seconds later) while `hasSuccessor` flips true SYNCHRONOUSLY
// at the successor's own insert — so during that window BOTH the predecessor and its successor are live
// manager rows in the same project, and the old scan could resolve the about-to-retire predecessor. The
// fix excludes any session with a live successor, mirroring `redriveQueuedMessage`'s own guard.
//
// Defect A (stop re-delivering / an ack cursor): a sender re-sending its own prior peer_message content
// plus more (a "growing resend", observed verbatim across turns with no distinguishing tag) is now
// detected via a literal byte-prefix match against the sender's own last send to the SAME target: an
// EXACT repeat is suppressed outright (deliveryStatus:"suppressed-duplicate", nothing delivered), and a
// genuine extension has the already-sent prefix trimmed before delivery (only the new suffix goes out,
// tagged `loom:redelivery-trimmed`, with `trimmedRedeliveredBytes` on the response).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — mirrors peer-message.mjs's own fixture shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-ack-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-peer-ack-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# peer_message ack-cursor test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=peer@loom -c user.name=peer");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "Project A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pB", name: "Project B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentA", projectId: "pA", name: "A", startupPrompt: "A", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pB", name: "B", startupPrompt: "B", position: 0, profileId: null });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "Lead", position: 0, profileId: null });
db.createProjectLink("pA", "pB");

const seedSession = (id, projectId, agentId, role, extra = {}) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null, ...extra,
});
seedSession("MGR_A", "pA", "agentA", "manager");
seedSession("MGR_B_OLD", "pB", "agentB", "manager"); // the recycling predecessor — stays "live" during settle
seedSession("MGR_B_NEW", "pB", "agentB", "manager", { recycledFrom: "MGR_B_OLD", gen: 1 }); // its already-live successor
seedSession("LEAD_OLD", "pHome", "agentLead", "platform"); // the Lead's own recycling predecessor
seedSession("LEAD_NEW", "pHome", "agentLead", "platform", { recycledFrom: "LEAD_OLD", gen: 1 }); // its already-live successor

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
  const client = new Client({ name: "peer-message-ack-cursor-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  const mgrAClient = await connect(orch.buildServer("MGR_A", "manager"));
  const mCall = async (name, args) => parse(await mgrAClient.callTool({ name, arguments: args }));

  // ===================== Defect B: a live successor must win over its still-live predecessor ============
  check("(setup) hasSuccessor(MGR_B_OLD) is true — the successor row alone establishes this, synchronously",
    db.hasSuccessor("MGR_B_OLD") === true);
  check("(setup) MGR_B_OLD is STILL processState:live — the transient overlap window this test targets",
    db.getSession("MGR_B_OLD").processState === "live");

  const raceSend = await mCall("peer_message", { targetProjectId: "pB", text: "farewell — wrapping up this thread" });
  check("(B1) delivers live (a live successor exists)", raceSend.deliveryStatus === "delivered-live" && !raceSend.error);
  check("(B1) delivered to the SUCCESSOR (MGR_B_NEW), never the superseded predecessor",
    host.enqueued.length === 1 && host.enqueued[0].id === "MGR_B_NEW");
  check("(B1) the response names the successor as targetSessionId, not the predecessor",
    raceSend.targetSessionId === "MGR_B_NEW");

  // Same defect, same fix, applied to the OTHER named channel — platform_escalate's live-Lead nudge.
  check("(setup) hasSuccessor(LEAD_OLD) is true", db.hasSuccessor("LEAD_OLD") === true);
  check("(setup) LEAD_OLD is STILL processState:live", db.getSession("LEAD_OLD").processState === "live");
  host.enqueued.length = 0;
  const esc = await mCall("platform_escalate", { title: "race test", detail: "does this reach the successor?" });
  check("(B2) platform_escalate's live nudge reaches the SUCCESSOR Lead, never the superseded predecessor",
    !esc.error && host.enqueued.length === 1 && host.enqueued[0].id === "LEAD_NEW");

  // ===================== Defect A: an exact repeat is suppressed, never re-delivered =====================
  const letterA = "A".repeat(250) + " — first installment of the letter";
  host.enqueued.length = 0;
  const send1 = await mCall("peer_message", { targetProjectId: "pB", text: letterA });
  check("(A1) setup: first send delivers live", send1.deliveryStatus === "delivered-live" && !send1.error);
  check("(A1) setup: delivered content is the full letter (nothing to trim yet)",
    host.enqueued[0].text.endsWith(letterA));

  host.enqueued.length = 0;
  const dup = await mCall("peer_message", { targetProjectId: "pB", text: letterA });
  check("(A2) an EXACT repeat of the sender's own last send is suppressed, not re-delivered",
    dup.deliveryStatus === "suppressed-duplicate" && !dup.error);
  check("(A2) nothing was actually enqueued for the exact repeat", host.enqueued.length === 0);
  check("(A2) the advisory explains why, pointing at peer_message_status", /peer_message_status/.test(dup.advisory ?? ""));

  // ===================== Defect A: a growing resend delivers only the NEW suffix, tagged ================
  const suffix = " plus a second installment, genuinely new content this time";
  const letterAB = letterA + suffix;
  host.enqueued.length = 0;
  const grow = await mCall("peer_message", { targetProjectId: "pB", text: letterAB });
  check("(A3) a growing resend still delivers live", grow.deliveryStatus === "delivered-live" && !grow.error);
  check("(A3) trimmedRedeliveredBytes reports the exact already-sent prefix length", grow.trimmedRedeliveredBytes === letterA.length);
  check("(A3) the advisory says so", /verbatim and were NOT re-sent/.test(grow.advisory ?? ""));
  check("(A3) the DELIVERED content carries the redelivery tag", host.enqueued[0].text.includes("loom:redelivery-trimmed"));
  check("(A3) the DELIVERED content contains the NEW suffix", host.enqueued[0].text.includes(suffix.trim()));
  check("(A3) the DELIVERED content does NOT repeat the already-sent letter body",
    !host.enqueued[0].text.includes(letterA));

  // ============ Defect A CR follow-up: a RECIPIENT recycle must never trigger silent loss ==============
  // The sender's own last send (letterAB, above) reached MGR_B_NEW in full. Now MGR_B_NEW itself
  // recycles — the manager's own review flagged this as the LOAD-BEARING case, not a corner: a sender
  // resending because it's unsure content landed is often unsure BECAUSE the recipient just recycled. An
  // EXACT repeat of letterAB must NOT be suppressed here (the new recipient never saw it, and the pre-fix
  // code would have wrongly suppressed it against a stale `priorOwnSend` match with no recipient check).
  seedSession("MGR_B_NEWER", "pB", "agentB", "manager", { recycledFrom: "MGR_B_NEW", gen: 2 });
  check("(setup) hasSuccessor(MGR_B_NEW) is now true — MGR_B_NEW is itself superseded", db.hasSuccessor("MGR_B_NEW") === true);

  host.enqueued.length = 0;
  const dupAfterRecycle = await mCall("peer_message", { targetProjectId: "pB", text: letterAB });
  check("(A5) an EXACT repeat of the sender's own last send is NOT suppressed once the recipient has recycled",
    dupAfterRecycle.deliveryStatus === "delivered-live" && !dupAfterRecycle.error);
  check("(A5) it is delivered to the NEW recipient (MGR_B_NEWER), never silently dropped",
    host.enqueued.length === 1 && host.enqueued[0].id === "MGR_B_NEWER");
  check("(A5) the FULL text reaches the new recipient — nothing trimmed off it",
    host.enqueued[0].text.includes(letterAB) && dupAfterRecycle.trimmedRedeliveredBytes === undefined);
  check("(A5) the response tells the sender it delivered in full DESPITE the match, because the recipient changed",
    /recipient is not confirmed to be the same session/.test(dupAfterRecycle.advisory ?? ""));

  // A6: ANOTHER recipient recycle (MGR_B_NEWER -> MGR_B_NEWEST) — a growing extension of letterAB must
  // ALSO deliver in full, untrimmed: the matched prefix (letterAB) reached MGR_B_NEWER, not MGR_B_NEWEST,
  // so trimming it here would silently lose that prefix for the session that actually has to read it.
  seedSession("MGR_B_NEWEST", "pB", "agentB", "manager", { recycledFrom: "MGR_B_NEWER", gen: 3 });
  const evenLonger = letterAB + " and now a THIRD installment, sent after ANOTHER recipient recycle";
  host.enqueued.length = 0;
  const growAfterRecycle = await mCall("peer_message", { targetProjectId: "pB", text: evenLonger });
  check("(A6) a growing extension whose matched prefix reached a NOW-SUPERSEDED recipient delivers in FULL, not trimmed",
    growAfterRecycle.deliveryStatus === "delivered-live" && growAfterRecycle.trimmedRedeliveredBytes === undefined &&
    host.enqueued[0].text.includes(letterAB) && host.enqueued[0].text.includes("THIRD installment"));
  check("(A6) delivered to the CURRENT recipient (MGR_B_NEWEST), never the stale MGR_B_NEWER", host.enqueued[0].id === "MGR_B_NEWEST");
  check("(A6) the advisory again explains the full delivery despite the textual match",
    /recipient is not confirmed to be the same session/.test(growAfterRecycle.advisory ?? ""));

  // Control: with NO further recycle, a repeat against the SAME (now-stable) recipient trims/suppresses
  // normally again — proves the recipient check doesn't just permanently disable the whole feature.
  host.enqueued.length = 0;
  const stableRepeat = await mCall("peer_message", { targetProjectId: "pB", text: evenLonger });
  check("(A7) once the recipient is stable again, an exact repeat IS correctly suppressed",
    stableRepeat.deliveryStatus === "suppressed-duplicate" && host.enqueued.length === 0);

  // ===================== A genuinely unrelated send is never mistaken for a resend =====================
  host.enqueued.length = 0;
  const unrelated = await mCall("peer_message", { targetProjectId: "pB", text: "totally unrelated short note" });
  check("(A4) an unrelated send delivers untrimmed (no false positive on a short/non-prefix message)",
    unrelated.deliveryStatus === "delivered-live" && unrelated.trimmedRedeliveredBytes === undefined &&
    host.enqueued[0].text.includes("totally unrelated short note"));

  console.log(failures === 0
    ? "\n✅ ALL PASS — peer_message resolves the target project's LIVE successor over a still-live recycling predecessor (Defect B), and detects a sender's own growing/exact resend against its last send to the same project: an exact repeat is suppressed outright and a genuine extension delivers only the new, tagged suffix — never the accumulated whole (Defect A)."
    : `\n❌ ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
}
