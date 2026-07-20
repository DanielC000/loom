import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion "lead mode" (Option B, no guardrails — owner decision `b5c606aa`, 2026-07-20; card `4af746ae`).
// BACKEND CORE: `sessions.companion_lead_mode` short-circuits `resolveCompanionGrant` (companion/
// capabilities.ts) to a SYNTHESIZED full act-scope over EVERY live project (`listAllProjects()`, read
// LIVE), superseding — never mutating — this session's own `companion_capability_grants` rows. Reuses
// 100% of the existing lever framework (registration gating, Primitive A/B/C, friction tiers, trust
// windows); lead mode changes SCOPE only. Fully hermetic: a REAL Db on a temp file + the REAL
// OrchestrationMcpRouter over an in-memory MCP transport, a REAL SessionService for the session-steer
// round-trip (mirrors companion-session-control.mjs), and a REAL AttentionPushWatcher for the wildcard
// alert-class expansion. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) lead mode ON, ZERO grant rows → full act-scope across N projects, INCLUDING one created AFTER
//       enabling (listAllProjects() is read LIVE on every call, never cached).
//   (b) lead mode OFF is byte-identical to today: zero grants ⇒ null, exactly as pre-card.
//   (c) toggling lead mode back OFF reverts to the pre-existing grant rows, which were NEVER mutated by
//       having been superseded.
//   (d) session-steer under lead mode reaches an INFRASTRUCTURE-role session (platform/operator/setup) —
//       NO role exclusion (Option B, "session-steer reaches EVERY session incl. infrastructure").
//   (e) NO MCP path can set `companion_lead_mode` — grep-provable (exactly two source call sites: the
//       db.ts setter's own definition + the gateway/server.ts REST handler, nothing under mcp/**), plus a
//       live tool-listing assertion that no tool name on the full lead-mode surface resembles a lead-mode
//       write.
// Plus: per-capability config synthesis (decisions-relay gets all 3 DECISION_CLASSES; media-out gets
// {roots:[vaultPath]} bounded to the project's own vault, {} when the project has none; attention-push's
// "*" wildcard sentinel expands to the FULL alert-class set via a real AttentionPushWatcher tick); every
// hasActGrant-gated lever registers (all 17 companion tools) with zero grant rows; a minimal test-double
// `db` (no listAllProjects) degrades to "no grant" rather than throwing.
// Run: 1) build (turbo builds shared first), 2) node test/companion-lead-mode.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-lead-mode-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { resolveCompanionGrant, isCompanionLeadModeEnabled, DECISION_CLASSES, COMPANION_CAPABILITY_SLUGS } = await import("../dist/companion/capabilities.js");
const { AttentionPushWatcher, ATTENTION_ALERT_CLASSES } = await import("../dist/companion/attention-push.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-lead-mode-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role ?? "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: opts.engineSessionId ?? `eng-${id}`, title: null,
    cwd: opts.cwd ?? os.tmpdir(), processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: role ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a) lead mode ON, ZERO grant rows → full scope across N projects + one created AFTER ============
  {
    const db = tmpDb();
    const projA = `pa-${randomUUID()}`, projB = `pb-${randomUUID()}`;
    seedProject(db, projA, "A"); seedProject(db, projB, "B");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, projA, "assistant");

    check("lead mode OFF by default on a fresh session", isCompanionLeadModeEnabled(db, sess) === false);
    check("(b) OFF + zero grants ⇒ null, byte-identical to pre-card behavior",
      resolveCompanionGrant(db, sess, "session-status") === null);

    db.setCompanionLeadMode(sess, true);
    check("setCompanionLeadMode persists + is read LIVE", isCompanionLeadModeEnabled(db, sess) === true);

    const scope = resolveCompanionGrant(db, sess, "session-status");
    check("(a) lead mode ON, zero grants ⇒ a non-null synthesized scope", scope !== null);
    check("(a) scope covers every live project (A + B)", scope.projectIds.has(projA) && scope.projectIds.has(projB) && scope.projectIds.size === 2);
    check("(a) every project resolves mode:'act'", scope.modeFor(projA) === "act" && scope.mayAct(projA) === true && scope.mayAct(projB) === true);

    // A project created AFTER lead mode was already enabled — listAllProjects() is read LIVE, so it must
    // appear on the VERY NEXT resolveCompanionGrant call with no extra plumbing.
    const projC = `pc-${randomUUID()}`;
    seedProject(db, projC, "C (created after enabling)");
    const scope2 = resolveCompanionGrant(db, sess, "session-status");
    check("(a) a project created AFTER enabling is included on the next read", scope2.projectIds.has(projC) && scope2.mayAct(projC) === true);

    // ============ (c) an EXISTING grant row is SUPERSEDED, never mutated ============
    db.upsertCompanionCapabilityGrant({ sessionId: sess, capability: "session-status", projectId: projA, mode: "read", config: {} });
    const scopeSuperseded = resolveCompanionGrant(db, sess, "session-status");
    check("(c) lead mode ON supersedes an existing READ grant — project A resolves 'act', not 'read'",
      scopeSuperseded.mayAct(projA) === true);
    check("(c) lead mode ON still covers B/C too (the row only ever named A)", scopeSuperseded.projectIds.has(projB) && scopeSuperseded.projectIds.has(projC));

    db.setCompanionLeadMode(sess, false);
    const scopeReverted = resolveCompanionGrant(db, sess, "session-status");
    check("(c) toggling OFF reverts to the UNTOUCHED grant row: only project A, mode 'read'",
      scopeReverted !== null && scopeReverted.projectIds.size === 1 && scopeReverted.projectIds.has(projA) && scopeReverted.mayAct(projA) === false);
    check("(c) the row itself was never mutated by having been superseded",
      db.getCompanionCapabilityGrant(sess, "session-status", projA).mode === "read");

    db.close();
  }

  // ============ Per-capability config synthesis ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    const decisionsScope = resolveCompanionGrant(db, sess, "decisions-relay");
    const decisionsCfg = decisionsScope.configFor(proj);
    check("decisions-relay: synthesized decisionClasses covers all 3 DECISION_CLASSES",
      Array.isArray(decisionsCfg.decisionClasses) && DECISION_CLASSES.every((c) => decisionsCfg.decisionClasses.includes(c)) && decisionsCfg.decisionClasses.length === DECISION_CLASSES.length);

    const mediaScope = resolveCompanionGrant(db, sess, "media-out");
    check("media-out: synthesized roots default to the project's OWN vaultPath",
      JSON.stringify(mediaScope.configFor(proj).roots) === JSON.stringify([proj] /* vaultPath was seeded === id */));

    // A project with NO vaultPath ⇒ {} (no safe host-wide wildcard — media-out's own tool degrades gracefully).
    const projNoVault = `pnv-${randomUUID()}`;
    db.insertProject({ id: projNoVault, name: "No Vault", repoPath: projNoVault, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
    const mediaScope2 = resolveCompanionGrant(db, sess, "media-out");
    check("media-out: a project with no vaultPath gets {} config (no roots), not a crash",
      mediaScope2.configFor(projNoVault).roots === undefined);

    const sessionSteerScope = resolveCompanionGrant(db, sess, "session-steer");
    check("session-steer: synthesized config has no roleFilter (absent config ⇒ no exclusion, matching Option B)",
      sessionSteerScope.configFor(proj).roleFilter === undefined);

    db.close();
  }

  // ============ Registration: every hasActGrant-gated lever registers with ZERO grant rows ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(sess, "assistant"));
    const expectedActTools = [
      "sessions_status", "decisions_list", "decision_resolve",
      "board_list", "board_get", "board_create", "board_update", "authored_content_grant", "board_relocate",
      "vault_lookup", "send_media",
      "session_message", "session_steer", "session_stop", "session_resume",
      "transcript_read", "session_spawn",
    ];
    for (const name of expectedActTools) {
      check(`lead mode registers "${name}" with zero grant rows`, tools.includes(name));
    }
    check(`(sanity) all ${COMPANION_CAPABILITY_SLUGS.length} catalog capability slugs resolve non-null under lead mode`,
      COMPANION_CAPABILITY_SLUGS.every((slug) => resolveCompanionGrant(db, sess, slug) !== null));

    db.close();
  }

  // ============ (d) session-steer reaches an INFRASTRUCTURE-role session — no exclusion ============
  {
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);

    // Infrastructure-role targets — platform/operator/setup, exactly the roles Option B refused to exclude.
    const platformSess = `plat-${randomUUID()}`;
    seedSession(db, platformSess, proj, "platform");
    const operatorSess = `op-${randomUUID()}`;
    seedSession(db, operatorSess, proj, "operator");
    const setupSess = `setup-${randomUUID()}`;
    seedSession(db, setupSess, proj, "setup");

    class PtyStub {
      constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.ownerText = "steer the platform session"; }
      getActiveTurnOwnerText() { return this.ownerText; }
      getActiveTurnOrigin() { return null; }
      getActiveTurnSenderId() { return null; }
      enqueueStdin(id, text) { if (!this.live.has(id)) return { delivered: false, reason: "session-dead" }; return { delivered: true }; }
      flushPending() { return []; }
      interruptForRedirect() {}
      getPending() { return []; }
      isAlive(id) { return this.live.has(id); }
      stop(id) { this.live.delete(id); }
      spawn(opts) { this.live.add(opts.sessionId); }
    }
    const pty = new PtyStub();
    pty.live.add(sess); pty.live.add(platformSess); pty.live.add(operatorSess); pty.live.add(setupSess);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, sessions, {}, pty);
    const client = await connect(orch.buildServer(sess, "assistant"));

    for (const [label, targetId] of [["platform", platformSess], ["operator", operatorSess], ["setup", setupSess]]) {
      const res = await call(client, "session_message", { target: targetId, message: "hello from lead mode" });
      check(`(d) session_message reaches the ${label} infrastructure session — no role exclusion`, !res.error && res.deliveryStatus === "delivered-live");
    }
    await client.close();
    db.close();
  }

  // ============ (e) NO MCP path can set companion_lead_mode ============
  {
    // grep-provable: the setter is called from EXACTLY the db.ts definition + the gateway/server.ts REST
    // handler — nothing under mcp/** (or companion/**'s own lever registrations) ever calls it.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.join(__dirname, "..", "src");
    const offenders = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        if (!text.includes("setCompanionLeadMode(")) continue;
        const rel = path.relative(srcDir, full).replace(/\\/g, "/");
        if (rel === "db.ts" || rel === "gateway/server.ts") continue; // the two expected sites
        offenders.push(rel);
      }
    }
    walk(srcDir);
    check("(e) grep: setCompanionLeadMode is called ONLY from db.ts's own definition + gateway/server.ts's REST handler",
      offenders.length === 0);

    // Belt-and-suspenders: no tool name on the full lead-mode MCP surface (any router) resembles a
    // lead-mode write — the agent-facing surface is read/act-scoped, never self-elevating.
    const db = tmpDb();
    const proj = `p-${randomUUID()}`;
    seedProject(db, proj, "Proj");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, proj, "assistant");
    db.setCompanionLeadMode(sess, true);
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(sess, "assistant"));
    check("(e) no MCP tool name on the lead-mode surface mentions lead-mode/leadMode",
      !tools.some((n) => /lead.?mode/i.test(n)));
    db.close();
  }

  // ============ Minimal test-double db (no listAllProjects) degrades safely, never throws ============
  {
    const minimalDb = { getSession: () => ({ companionLeadMode: true, projectId: "p1" }) };
    let threw = false;
    let result;
    try { result = resolveCompanionGrant(minimalDb, "sess", "session-status"); } catch { threw = true; }
    check("a minimal test-double db (no listAllProjects) never throws under lead mode", !threw);
    check("...and degrades to null (no grant), exactly like the pre-existing listCompanionCapabilityGrantsForSession tolerance", result === null);
  }

  // ============ attention-push wildcard: "*" expands to the FULL ATTENTION_ALERT_CLASSES set ============
  {
    const db = tmpDb();
    const projA = `pa-${randomUUID()}`, projB = `pb-${randomUUID()}`;
    seedProject(db, projA, "A"); seedProject(db, projB, "B");
    const sess = `cs-${randomUUID()}`;
    seedSession(db, sess, projA, "assistant");
    const mgrA = `mgr-a-${randomUUID()}`; seedSession(db, mgrA, projA, "manager");
    const mgrB = `mgr-b-${randomUUID()}`; seedSession(db, mgrB, projB, "manager");
    db.setCompanionLeadMode(sess, true);

    const enqueued = [];
    const pty = {
      isAlive: () => true,
      enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
      getPending: () => [],
    };
    const watcher = new AttentionPushWatcher({ db, pty, sessionId: sess });
    watcher.start(); watcher.stop(); // seed watermark past any backlog

    // One event per alert class, across BOTH projects (proving cross-project reach too), each mapped via
    // attention-push.ts's own classify() so this test never hand-derives the class↔kind mapping itself.
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "merge_rejected", detail: {} }); // merge-gate
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "worker_stuck", detail: {} }); // worker-blocked
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "worker_exited_without_report", detail: {} }); // worker-crashed
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "question_asked", detail: { title: "t" } }); // decision-pending
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "idle_escalated", detail: {} }); // manager-idle
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "context_escalated", detail: {} }); // context-overflow
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrA, kind: "platform_escalate", detail: { title: "t" } }); // escalation
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrB, kind: "session_rate_limited", detail: {} }); // usage-limit

    watcher.tick(new Date());
    check(`attention-push wildcard: all ${ATTENTION_ALERT_CLASSES.length} classes pushed (one event each, both projects in scope)`,
      enqueued.length === ATTENTION_ALERT_CLASSES.length);

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — Companion lead mode: full act-scope over every live project (incl. one created after enabling), supersedes without mutating existing grants, reverts cleanly on toggle-off, session-steer reaches infrastructure sessions with no exclusion, no MCP write path exists, and every lever/config synthesizes correctly."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error(err);
  process.exit(1);
}
