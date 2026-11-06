import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// question_ask type:"notice" that ALSO carries `action`/`fulfillmentTarget` (fields that only mean something
// on a "permission" ask and are dropped on a notice) returns a non-blocking `advisory`; the notice is still
// filed. The trigger is structural only -- prose is never inspected.
//
// Proves, against the REAL manager question_ask tool through an in-memory MCP client:
//   (1) notice + action               -> advisory present, row filed in state 'notice'
//   (2) notice + fulfillmentTarget    -> advisory present
//   (3) bare notice (title+body only) -> NO advisory (negative control: an ordinary FYI is untouched)
//   (4) notice whose BODY reads like an owner action but has no structured field -> NO advisory (documents
//       the deliberate prose-blind limit)
//   (5) permission + action           -> NO advisory (the right shape is never flagged)
//   (6) notice + attachments only     -> NO advisory (attaching a report to an FYI is legitimate)
//   (7) noticeOwnerActionAdvisory unit: blank/whitespace `action` does not trigger.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("question-ask-notice-advisory-");
const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { noticeOwnerActionAdvisory } = await import("../dist/mcp/questionTool.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-qa-adv-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pA", name: "A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pA", name: "mgr", startupPrompt: "x", position: 0, profileId: null });
db.insertSession({
  id: "MGR", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin() { return { delivered: true }; }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
const orch = new OrchestrationMcpRouter(db, svc);

async function ask(args) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await orch.buildServer("MGR", "manager").connect(s);
  const client = new Client({ name: "qa-adv", version: "0" });
  await client.connect(c);
  const res = JSON.parse((await client.callTool({ name: "question_ask", arguments: args })).content[0].text);
  await client.close();
  return res;
}

const r1 = await ask({ type: "notice", title: "t1", body: "b", action: "rotate the key" });
check("(1) notice + action: advisory returned", typeof r1.advisory === "string" && /permission/.test(r1.advisory));
check("(1) the notice is STILL filed (non-blocking), in its own 'notice' state",
  typeof r1.questionId === "string" && db.getQuestion(r1.questionId)?.state === "notice");

const r2 = await ask({ type: "notice", title: "t2", body: "b", fulfillmentTarget: { profileId: "p", key: "k" } });
check("(2) notice + fulfillmentTarget: advisory returned", typeof r2.advisory === "string");

const r3 = await ask({ type: "notice", title: "t3", body: "b" });
check("(3) bare notice: NO advisory", r3.advisory === undefined && typeof r3.questionId === "string");

const r4 = await ask({ type: "notice", title: "t4", body: "Please approve the deploy and then click the button in the dashboard." });
check("(4) prose-only owner action on a notice: NO advisory (structural trigger only, by design)", r4.advisory === undefined);

const r5 = await ask({ type: "permission", title: "t5", body: "b", action: "rotate the key" });
check("(5) permission + action: NO advisory", r5.advisory === undefined && typeof r5.questionId === "string");

const r6 = await ask({ type: "notice", title: "t6", body: "b", attachments: [] });
check("(6) notice with attachments field only: NO advisory", r6.advisory === undefined);

// (8) FOLLOW the advisory end to end. It must not send the agent down a path that fails: a notice is filed in
// its own terminal 'notice' state, so `supersedes` on it is refused. The advisory's advice is a NEW ask.
check("(8) the advisory does not tell the agent to pass `supersedes`", typeof r1.advisory === "string" && !/supersedes/i.test(r1.advisory));
const rFollow = await ask({ type: "permission", title: "t1-follow", body: "b", action: "rotate the key" });
check("(8) following the advisory (a NEW permission ask, no supersedes) is filed fine and pending",
  typeof rFollow.questionId === "string" && rFollow.error === undefined && db.getQuestion(rFollow.questionId)?.state === "pending");
const rBad = await ask({ type: "permission", title: "t1-bad", body: "b", action: "rotate the key", supersedes: r1.questionId });
check("(8) control: superseding the NOTICE is indeed refused/failed (why the advisory must not suggest it)",
  rBad.supersede?.error !== undefined || rBad.error !== undefined);

// (9) Lead router: one call proves the platform question_ask also returns the advisory.
db.insertProject({ id: "pPlat", name: "PlatformHome", repoPath: repo, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentL", projectId: "pPlat", name: "Lead", startupPrompt: "L", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pPlat", agentId: "agentL", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});
{
  const platRouter = new PlatformMcpRouter(db, svc);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await platRouter.buildServer("PL").connect(s);
  const client = new Client({ name: "qa-adv-plat", version: "0" });
  await client.connect(c);
  const call = async (args) => JSON.parse((await client.callTool({ name: "question_ask", arguments: args })).content[0].text);
  const lead1 = await call({ type: "notice", title: "L1", body: "b", action: "rotate the key" });
  check("(9) Lead router: notice + action returns the advisory and still files the notice",
    typeof lead1.advisory === "string" && db.getQuestion(lead1.questionId)?.state === "notice");
  const lead2 = await call({ type: "notice", title: "L2", body: "b" });
  check("(9) Lead router control: a bare notice has no advisory", lead2.advisory === undefined && typeof lead2.questionId === "string");
  await client.close();
}

check("(7) blank/whitespace action does not trigger", noticeOwnerActionAdvisory({ type: "notice", action: "   " }) === undefined);
check("(7) non-notice type never triggers", noticeOwnerActionAdvisory({ type: "decision", action: "x" }) === undefined);

try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
