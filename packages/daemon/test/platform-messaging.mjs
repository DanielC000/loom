import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P4 — cross-project messaging + manager→Lead escalation. DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like platform-mgmt-surface.mjs: a REAL Db + SessionService driven against a FAKE
// pty (we additionally spy enqueueStdin so we can assert delivery routing without a real claude TUI), the
// REAL PlatformMcpRouter (the Lead's surface) and the REAL OrchestrationMcpRouter (the manager surface),
// each driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD:
//   (a) session_message is PLATFORM-gated — present on the platform surface, absent from the manager
//       surface; manager/worker sessions get NO platform surface at all (resolveRole null); it DELIVERS a
//       framed message to a live session cross-project (deliveryStatus delivered-live), 404s ONLY an unknown
//       id, and for a NOT-LIVE target BOARDS a durable card on the target's project board (deliveryStatus
//       boarded + taskId) instead of throwing — so the Lead's message is never silently dropped.
//   (b) platform_escalate is MANAGER-gated — present on the manager surface, absent from the platform and
//       worker surfaces; it creates a structured task on the RESERVED Platform board (NOT the caller's
//       project), capturing origin project+session, title, detail, severity; returns the task id; and
//       refuses gracefully when no reserved project exists.
//   (b2) REGRESSION — with a SECOND reserved home ("Getting Started") also present, platform_escalate
//       still name-targets the "Loom Platform" home, NOT the setup home (which sorts first by name).
//   (c) a non-manager (worker) cannot call platform_escalate (not on its surface; the service guard rejects).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-messaging.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-p4-${Date.now()}-${process.pid}`);
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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-p4-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform P4 test repo\n");
execSync(`git init -q && git add . && git -c user.email=p4@loom -c user.name=p4 commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home (P1) — platform_escalate must target THIS board.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
// An ordinary project — the escalating manager + message targets live here.
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

const seedSession = (id, role, parent, processState = "live") => db.insertSession({
  id, projectId: "pOrd", agentId: "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "platform", null);      // a live Lead — the live-nudge target for platform_escalate
seedSession("MGR", "manager", null);      // the escalating manager
seedSession("W", "worker", "MGR");        // a worker (no platform_escalate on its surface)
seedSession("TARGET", null, null);        // a live plain session — session_message delivery target
seedSession("DEAD", null, null, "exited"); // a not-live session — session_message must 404 it

// Fake pty: capture createPty (spawn) + stop, AND spy enqueueStdin so we can assert delivery routing
// (the model SeamHost never registers a `live` entry, so the real enqueueStdin would no-op; spying it
// lets us prove messageSessionAsPlatform framed + routed to the right session id).
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
const orch = new OrchestrationMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "p4-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  // ===================== (a) session_message — PLATFORM-gated; cross-hierarchy delivery =====================
  // Role gate: only a platform session gets the platform surface (manager/worker/unknown → null).
  check("(a) platform session PL HAS the platform surface", !!platform.resolveRole("PL"));
  check("(a) manager session MGR gets NO platform surface (resolveRole null)", platform.resolveRole("MGR") === null);
  check("(a) worker session W gets NO platform surface (resolveRole null)", platform.resolveRole("W") === null);

  const platformClient = await connect(platform.buildServer());
  const pCall = async (name, args) => parse(await platformClient.callTool({ name, arguments: args }));
  const platformTools = (await platformClient.listTools()).tools.map((t) => t.name);
  check("(a) session_message is registered on the platform surface", platformTools.includes("session_message"));
  check("(a) platform_escalate is NOT on the platform surface (boundary: it's the manager surface)", !platformTools.includes("platform_escalate"));

  // Delivers to a live session cross-project (TARGET is a live pOrd session; the Lead is in pHome).
  const beforeEnq = host.enqueued.length;
  const msg = await pCall("session_message", { sessionId: "TARGET", text: "stand by for a platform-wide restart" });
  check("(a) session_message delivers to a LIVE session (deliveryStatus delivered-live, no error)",
    msg.deliveryStatus === "delivered-live" && !msg.error);
  const lastEnq = host.enqueued[host.enqueued.length - 1];
  check("(a) session_message routed to the TARGET session, framed [loom:from-platform]",
    host.enqueued.length === beforeEnq + 1 && lastEnq.id === "TARGET" &&
    lastEnq.text.startsWith("[loom:from-platform]\n") && lastEnq.text.includes("stand by for a platform-wide restart"));
  // ===== DELIVER-ONCE (card c17291c3): a retried/duplicated send of the SAME directive is a no-op ======
  // Manifestation (a) from the card: two consecutive identical turns from a resent/retried session_message
  // call. A resend with the SAME (sessionId, text) within the dedupe window must inject NOTHING new.
  const beforeDup = host.enqueued.length;
  const dup = await pCall("session_message", { sessionId: "TARGET", text: "stand by for a platform-wide restart" });
  check("(a) a duplicated/retried send of the SAME directive returns duplicate:true + the ORIGINAL deliveryStatus, no error",
    dup.duplicate === true && dup.deliveryStatus === "delivered-live" && !dup.error);
  check("(a) the duplicate injects NOTHING new (no second enqueue — delivers exactly once)",
    host.enqueued.length === beforeDup);

  // A genuinely-DIFFERENT directive to the same recipient is NOT suppressed — dedup keys on content, not
  // just the recipient, so real distinct direction still lands.
  const beforeDistinct = host.enqueued.length;
  const distinct = await pCall("session_message", { sessionId: "TARGET", text: "a completely different directive" });
  check("(a) a genuinely-distinct directive to the same session still delivers fresh (no duplicate flag, new enqueue)",
    !distinct.duplicate && distinct.deliveryStatus === "delivered-live" && host.enqueued.length === beforeDistinct + 1);

  // Manifestation (b) from the card: the directive text itself already carries a leading
  // [loom:from-platform] line (e.g. relayed/copied from a prior framed message) — the tag must be applied
  // EXACTLY ONCE, never doubled into "[loom:from-platform]\n[loom:from-platform]\n<body>".
  const beforePrefixed = host.enqueued.length;
  const prefixed = await pCall("session_message", { sessionId: "TARGET", text: "[loom:from-platform]\nsecond hop of a relayed directive" });
  const prefixedEnq = host.enqueued[host.enqueued.length - 1];
  check("(b) a caller-supplied leading [loom:from-platform] tag is collapsed to exactly ONE occurrence, one turn",
    !prefixed.error && host.enqueued.length === beforePrefixed + 1 &&
    prefixedEnq.text === "[loom:from-platform]\nsecond hop of a relayed directive" &&
    (prefixedEnq.text.match(/\[loom:from-platform\]/g) || []).length === 1);

  // 404 ONLY for a truly unknown id.
  check("(a) session_message 404s an unknown session", (await pCall("session_message", { sessionId: "ghost", text: "x" })).error === "session not found");
  // A NOT-LIVE target no longer throws — it BOARDS a durable card on the target's project board (pOrd) and
  // returns deliveryStatus "boarded" + the taskId, so the Lead's message is never silently dropped.
  const ordTasksBefore = db.listTasks("pOrd").length;
  const enqBeforeDead = host.enqueued.length;
  const boarded = await pCall("session_message", { sessionId: "DEAD", text: "read this when you resume" });
  check("(a) session_message to a NOT-LIVE target returns deliveryStatus 'boarded' + a taskId (no error)",
    boarded.deliveryStatus === "boarded" && !!boarded.taskId && !boarded.error);
  const boardedTask = db.getTask(boarded.taskId);
  check("(a) the boarded note landed on the TARGET's project board (pOrd), capturing the message + session",
    !!boardedTask && boardedTask.projectId === "pOrd" && db.listTasks("pOrd").length === ordTasksBefore + 1 &&
    boardedTask.body.includes("read this when you resume") && boardedTask.body.includes("DEAD"));
  check("(a) boarding a not-live target enqueues NOTHING (no live PTY to receive a turn)",
    host.enqueued.length === enqBeforeDead);
  // An audit event was recorded for the successful LIVE delivery (filed under the target as workerSessionId).
  check("(a) a session_message audit event was recorded for TARGET",
    db.listEventsForWorker("TARGET").some((e) => e.kind === "session_message"));

  await platformClient.close();

  // ===================== (b) platform_escalate — MANAGER-gated; durable to the RESERVED board =============
  const mgrClient = await connect(orch.buildServer("MGR", "manager"));
  const mCall = async (name, args) => parse(await mgrClient.callTool({ name, arguments: args }));
  const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
  check("(b) platform_escalate is registered on the MANAGER surface", mgrTools.includes("platform_escalate"));
  check("(b) session_message is NOT on the manager surface (boundary: it's the platform surface)", !mgrTools.includes("session_message"));

  const nTasksHomeBefore = db.listTasks("pHome").length;
  const nTasksOrdBefore = db.listTasks("pOrd").length;
  const enqBeforeEsc = host.enqueued.length;
  const esc = await mCall("platform_escalate", {
    title: "worker_merge gate hangs on a slow build",
    detail: "Three workers stalled 4+ min on `pnpm build` during the merge gate; no progress signal surfaced.",
    severity: "high",
  });
  check("(b) platform_escalate returns the created task id + the reserved Platform projectId",
    !!esc.taskId && esc.projectId === "pHome" && !esc.error);
  const task = db.getTask(esc.taskId);
  check("(b) the escalation task was created on the RESERVED Platform board (not the caller's project)",
    !!task && task.projectId === "pHome" && db.listTasks("pHome").length === nTasksHomeBefore + 1 && db.listTasks("pOrd").length === nTasksOrdBefore);
  check("(b) the task title is the escalated title", task?.title === "worker_merge gate hangs on a slow build");
  check("(b) the task body captures origin project + manager session + severity + detail (structured)",
    task?.body.includes("Ordinary") && task?.body.includes("`pOrd`") && task?.body.includes("`MGR`") &&
    task?.body.includes("high") && task?.body.includes("Three workers stalled"));
  check("(b) the task landed on the Platform backlog column", task?.columnKey === "backlog");
  check("(b) a platform_escalate audit event was recorded (origin + platform target)",
    db.listEvents("MGR").some((e) => e.kind === "platform_escalate" && e.taskId === esc.taskId && e.detail?.originProjectId === "pOrd" && e.detail?.platformProjectId === "pHome"));
  // Additive best-effort live nudge: a live Lead (PL) got a heads-up via the enqueue channel.
  const escNudge = host.enqueued.slice(enqBeforeEsc).find((e) => e.id === "PL");
  check("(b) a live Lead session was nudged [loom:escalation] (additive — board task is the durable inbox)",
    esc.deliveryStatus === "delivered-live" && !!escNudge && escNudge.text.startsWith("[loom:escalation]") && escNudge.text.includes(esc.taskId));

  await mgrClient.close();

  // ===== (b2) REGRESSION — a 2nd reserved home must NOT mis-target platform_escalate =====
  // E1-4 added the ungated "Getting Started" setup home — a SECOND reserved project. The old name-agnostic
  // `listAllProjects().find(p => p.reserved)` is now ambiguous: "Getting Started" sorts BEFORE "Loom
  // Platform" (listAllProjects is ORDER BY name), so the bare .find would target the SETUP home. The
  // name-scoped fix (getReservedProjectByName(PLATFORM_PROJECT_NAME)) must still file onto "Loom Platform".
  db.insertProject({ id: "pSetup", name: "Getting Started", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(b2) two reserved homes now coexist, and 'Getting Started' sorts ahead of 'Loom Platform'",
    db.listAllProjects().filter((p) => p.reserved).length === 2 &&
    db.listAllProjects().find((p) => p.reserved).name === "Getting Started"); // the bare-.find trap
  const setupTasksBefore = db.listTasks("pSetup").length;
  const esc2 = await (async () => {
    const c = await connect(orch.buildServer("MGR", "manager"));
    const r = parse(await c.callTool({ name: "platform_escalate", arguments: { title: "second escalation", detail: "after the setup home exists", severity: "low" } }));
    await c.close();
    return r;
  })();
  check("(b2) platform_escalate STILL targets the 'Loom Platform' home (pHome) — never the setup home",
    esc2.projectId === "pHome" && !esc2.error);
  check("(b2) the task landed on pHome, and the setup home got NOTHING",
    db.getTask(esc2.taskId)?.projectId === "pHome" && db.listTasks("pSetup").length === setupTasksBefore);
  // Drop the setup home again so the later "no reserved project" refusal test (archive pHome) still holds.
  db.archiveProject("pSetup");

  // ===================== (c) a non-manager (worker) cannot call platform_escalate =====================
  const wkrClient = await connect(orch.buildServer("W", "worker"));
  const wkrTools = (await wkrClient.listTools()).tools.map((t) => t.name);
  check("(c) platform_escalate is ABSENT from the worker surface (worker only gets worker_report + my_context)",
    !wkrTools.includes("platform_escalate") && wkrTools.includes("worker_report"));
  await wkrClient.close();
  // Defense in depth: the service method itself rejects a non-manager caller (even if the surface were reached).
  let svcRejected = false;
  try { svc.platformEscalate("W", { title: "x", detail: "y" }); } catch (e) { svcRejected = /manager-only/.test(e.message); }
  check("(c) svc.platformEscalate rejects a non-manager caller (manager-only guard)", svcRejected);

  // ===================== (b) graceful refusal when no reserved project exists =====================
  // Archive the reserved home directly (bypassing the tool guard) so listAllProjects no longer finds it.
  db.archiveProject("pHome");
  let noHomeErr = "";
  try { svc.platformEscalate("MGR", { title: "x", detail: "y", severity: "low" }); } catch (e) { noHomeErr = e.message; }
  check("(b) platform_escalate refuses gracefully when no reserved project exists", /no reserved/.test(noHomeErr));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_message is platform-gated and delivers a framed message to any live session cross-project (deliveryStatus delivered-live; 404 only on an unknown id; a NOT-LIVE target BOARDS a durable card on its project board → boarded + taskId, never dropped); platform_escalate is manager-gated, files a structured escalation task on the RESERVED Platform board (not the caller's), returns its id, nudges a live Lead best-effort, and refuses gracefully with no reserved project; a worker cannot call it; the two tools stay on their separate surfaces — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
