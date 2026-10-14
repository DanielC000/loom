import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c0c9ca4a — the Platform Lead's own `question_ask` (mcp/platform.ts) never appended a
// `question_asked` orchestration event (only the manager's did, mcp/orchestration.ts) — so the Lead's
// decisions and notices never reached companion attention-push, and the owner got no companion signal
// when the Lead asked something. Fixed by sharing `appendQuestionAskedEvent` (mcp/questionTool.ts)
// between the two question_ask registrations.
//
// Drives the REAL Platform Lead question_ask MCP handler (never a hand-seeded event) end-to-end into a
// REAL AttentionPushWatcher tick, covering the card's own DoD:
//   (a) a Lead DECISION ask pushes to a companion subscribed to "decision-pending", scoped to the
//       correct project (a sibling companion granted on a DIFFERENT project gets nothing).
//   (b) a Lead NOTICE ask pushes ONLY to a companion that explicitly opted into the "notice" alert
//       class — and NEVER to a lead-mode ("*") wildcard companion (card b5c606aa's own wildcard
//       exclusion, proven here specifically for the LEAD filing path rather than the manager one
//       companion-lead-mode.mjs already covers).
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL PlatformMcpRouter over an in-memory MCP
// transport + a REAL AttentionPushWatcher. NO network, NO real claude, NO daemon.
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/platform-question-asked-attention-push.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-platform-qa-attnpush-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { AttentionPushWatcher } = await import("../dist/companion/attention-push.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-question-asked-attention-push-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name, opts = {}) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null, reserved: opts.reserved ?? false });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role ?? "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: role ?? null,
  });
}

const dbFile = path.join(tmpHome, "platform-qa-attnpush.db");
const db = new Db(dbFile);

try {
  // The reserved Platform home — where a real Lead session lives — plus a sibling, unrelated project so
  // the scope assertions below can prove a cross-project leak is NOT happening.
  const platformHome = "home-platform";
  seedProject(db, platformHome, "Loom Platform", { reserved: true });
  const otherProject = "proj-other";
  seedProject(db, otherProject, "Other Project");

  const leadId = "lead-1";
  seedSession(db, leadId, platformHome, "platform");

  // ============ (a) a Lead DECISION ask pushes to a companion subscribed to decision-pending, on the
  //     RIGHT project — a sibling companion granted only on a DIFFERENT project gets nothing. ============
  {
    const companionOnHome = "companion-home";
    seedSession(db, companionOnHome, platformHome, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionOnHome, capability: "attention-push", projectId: platformHome,
      mode: "read", config: { alertClasses: ["decision-pending"] },
    });
    const companionOnOther = "companion-other";
    seedSession(db, companionOnOther, otherProject, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionOnOther, capability: "attention-push", projectId: otherProject,
      mode: "read", config: { alertClasses: ["decision-pending"] },
    });

    const enqueuedHome = [];
    const ptyHome = { isAlive: () => true, enqueueStdin: (id, text) => { enqueuedHome.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcherHome = new AttentionPushWatcher({ db, pty: ptyHome, sessionId: companionOnHome });
    watcherHome.start(); watcherHome.stop(); // seed watermark past any backlog

    const enqueuedOther = [];
    const ptyOther = { isAlive: () => true, enqueueStdin: (id, text) => { enqueuedOther.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcherOther = new AttentionPushWatcher({ db, pty: ptyOther, sessionId: companionOnOther });
    watcherOther.start(); watcherOther.stop();

    const router = new PlatformMcpRouter(db, {});
    const client = await connect(router.buildServer(leadId));
    const res = await call(client, "question_ask", { type: "decision", title: "pick a strategy", body: "A or B", options: ["A", "B"] });
    check("(a) the real Lead question_ask(type:'decision') call succeeds", typeof res.questionId === "string");
    await client.close();

    // The filing-site event itself, on the REAL question (not hand-built).
    const filedEvents = db.listEvents(leadId).filter((e) => e.kind === "question_asked");
    check("(a) the Lead's question_ask filed a REAL question_asked event", filedEvents.some((e) => e.detail?.questionId === res.questionId));
    const filed = filedEvents.find((e) => e.detail?.questionId === res.questionId);
    check("(a) the event carries detail.type === 'decision'", filed?.detail?.type === "decision");
    check("(a) the event's managerSessionId is the Lead's own session (appendQuestionAskedEvent's `sessionId` param)", filed?.managerSessionId === leadId);
    check("(a) the event's auto-derived detail.projectId matches the project the Lead's session (and so its question) is actually filed against — the Platform home",
      filed?.detail?.projectId === platformHome);

    watcherHome.tick(new Date());
    check("(a) a companion subscribed to decision-pending ON THE PLATFORM HOME gets the push",
      enqueuedHome.length === 1 && /decision needed/.test(enqueuedHome[0].text) && /pick a strategy/.test(enqueuedHome[0].text));

    watcherOther.tick(new Date());
    check("(a) a sibling companion granted only on a DIFFERENT project gets NOTHING (no cross-project leak)",
      enqueuedOther.length === 0);
  }

  // ============ (b) a Lead NOTICE ask pushes ONLY to a companion that explicitly opted into "notice" —
  //     never to a lead-mode ("*") wildcard companion. ============
  {
    const noticeOptIn = "companion-notice-optin";
    seedSession(db, noticeOptIn, platformHome, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: noticeOptIn, capability: "attention-push", projectId: platformHome,
      mode: "read", config: { alertClasses: ["notice"] },
    });
    const leadModeCompanion = "companion-lead-mode";
    seedSession(db, leadModeCompanion, platformHome, "assistant");
    db.setCompanionLeadMode(leadModeCompanion, true);

    const enqueuedOptIn = [];
    const ptyOptIn = { isAlive: () => true, enqueueStdin: (id, text) => { enqueuedOptIn.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcherOptIn = new AttentionPushWatcher({ db, pty: ptyOptIn, sessionId: noticeOptIn });
    watcherOptIn.start(); watcherOptIn.stop();

    const enqueuedLeadMode = [];
    const ptyLeadMode = { isAlive: () => true, enqueueStdin: (id, text) => { enqueuedLeadMode.push({ id, text }); return { delivered: true }; }, getPending: () => [] };
    const watcherLeadMode = new AttentionPushWatcher({ db, pty: ptyLeadMode, sessionId: leadModeCompanion });
    watcherLeadMode.start(); watcherLeadMode.stop();

    const router = new PlatformMcpRouter(db, {});
    const client = await connect(router.buildServer(leadId));
    const res = await call(client, "question_ask", { type: "notice", title: "deploy finished", body: "all good" });
    check("(b) the real Lead question_ask(type:'notice') call succeeds", typeof res.questionId === "string");
    await client.close();

    const filed = db.listEvents(leadId).filter((e) => e.kind === "question_asked").find((e) => e.detail?.questionId === res.questionId);
    check("(b) the notice's REAL question_asked event carries detail.type === 'notice'", filed?.detail?.type === "notice");

    watcherOptIn.tick(new Date());
    check("(b) a companion that explicitly opted into 'notice' DOES get the push",
      enqueuedOptIn.length === 1 && /FYI/.test(enqueuedOptIn[0].text) && /deploy finished/.test(enqueuedOptIn[0].text));

    watcherLeadMode.tick(new Date());
    check("(b) a lead-mode ('*') wildcard companion NEVER gets the notice push (card b5c606aa's wildcard exclusion)",
      enqueuedLeadMode.length === 0);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — the Platform Lead's question_ask now files a question_asked event (shared with the " +
      "manager's own registration via appendQuestionAskedEvent), scoped to the correct project, so a " +
      "real Lead decision reaches a subscribed companion and a real Lead notice reaches only an " +
      "explicitly opted-in companion, never a lead-mode wildcard one."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}
