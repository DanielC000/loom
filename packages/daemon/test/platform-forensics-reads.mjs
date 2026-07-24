import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 80b7a33b — the three forensics reads added to the platform surface so a Platform Lead no longer
// needs a raw sqlite read of loom.db for: (1) what's actually in platform_config right now, (2) a
// bounded orchestration-events read that isn't limited to gate-run kinds, (3) a cross-project search over
// every agent's startupPrompt. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// platform-cross-project-task.mjs: a REAL Db + SessionService against a FAKE pty (PtyHost createPty()
// seam), the REAL routers driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD:
//   (1) platform_config_get returns the stored override + resolved group, REDACTED for the agent
//       surface: `integrations` (codescape path) dropped entirely, `remoteAccess.tls.{certPath,keyPath}`
//       collapsed to {configured:true}; plain operational fields pass through unredacted.
//   (2) events_search is a bounded, kind/project/session/task-filterable page over orchestration_events,
//       NOT limited to gate-run kinds; kind values are bound as query params (an unrecognized kind is
//       zero rows, never an error/injection); pagination envelope is always returned; its `limit` clamp
//       (card 07ce7c0c) defaults to DEFAULT_EVENTS_SEARCH_CAP and never exceeds MAX_EVENTS_SEARCH_PAGE.
//   (3) agent_prompt_search is a case-insensitive cross-project substring search over every agent's
//       startupPrompt, bounded/capped with a snippet (not the full prompt) per hit; its `limit` clamp
//       (card 07ce7c0c) defaults to DEFAULT_PROMPT_SEARCH_CAP and never exceeds MAX_PROMPT_SEARCH_CAP.
//   (4) TRUST GATE — all three tools are PRESENT on loom-platform but ABSENT from every agent-facing
//       surface: loom-orchestration (manager AND worker), loom-setup, and the in-project loom-tasks.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-forensics-reads.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-forensics-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db, MAX_EVENTS_SEARCH_PAGE } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, DEFAULT_EVENTS_SEARCH_CAP } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { searchAgentPrompts, DEFAULT_PROMPT_SEARCH_CAP, MAX_PROMPT_SEARCH_CAP } = await import("../dist/mcp/promptSearch.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-forensics-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# forensics-reads test repo\n");
execSync(`git init -q && git add . && git -c user.email=x@loom -c user.name=x commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pTarget", name: "Target", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD — orient via /pickup Loom Platform. Never mention Seismo directly.", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pTarget", name: "Work", startupPrompt: "WORK on Target. Formerly called SEISMO before the rename.", position: 0, profileId: null });

const seedSession = (id, projectId, role, parent) => db.insertSession({
  id, projectId, agentId: projectId === "pHome" ? "agentLead" : "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "pHome", "platform", null);
seedSession("M", "pTarget", "manager", null);
seedSession("W", "pTarget", "worker", "M");

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only lists tools here

const parse = (res) => JSON.parse(res.content[0].text);
const listTools = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "forensics-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
};

try {
  const platServer = new PlatformMcpRouter(db, svc).buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await platServer.connect(serverT);
  const client = new Client({ name: "forensics-platform", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const platToolNames = (await client.listTools()).tools.map((t) => t.name);
  check("(0) all three tools are registered on loom-platform",
    ["platform_config_get", "events_search", "agent_prompt_search"].every((n) => platToolNames.includes(n)));

  // ===================== (1) platform_config_get — secret-shaped redaction =====================
  db.setPlatformConfig({
    rateLimit: { defaultBackoffMs: 120000 },
    coalesceAgentMessages: true,
    maxConcurrentGates: 3,
    integrations: { codescape: { path: "/private/host/path/to/codescape-cli" } },
    remoteAccess: {
      enabled: true,
      bindHost: "100.64.1.2",
      tls: { certPath: "/etc/loom/cert.pem", keyPath: "/etc/loom/key.pem" },
      rateLimit: { perIpPerMin: 120, perTokenPerMin: 120, authFailLockout: { maxAttempts: 5, windowMs: 600000, lockoutMs: 900000 } },
    },
  });
  const cfg = await call("platform_config_get", {});
  check("(1) plain operational fields pass through unredacted (rateLimit, coalesceAgentMessages, maxConcurrentGates)",
    cfg.override.rateLimit?.defaultBackoffMs === 120000 && cfg.override.coalesceAgentMessages === true && cfg.override.maxConcurrentGates === 3);
  // `resolved` mirrors resolveConfig's PlatformConfig group exactly (same shape the human REST GET
  // returns) — maxConcurrentGates resolves under `orchestration.maxConcurrentGates`, not this group, so
  // it's correctly ABSENT here; it's still readable via `override.maxConcurrentGates` above.
  check("(1) resolved group carries the operational PlatformConfig fields", cfg.resolved.coalesceAgentMessages === true);
  check("(1) `integrations` (codescape path) is DROPPED ENTIRELY from the override — never reaches the agent surface",
    cfg.override.integrations === undefined && JSON.stringify(cfg).toLowerCase().includes("codescape") === false);
  check("(1) `integrations` is also absent from the resolved group",
    cfg.resolved.integrations === undefined);
  check("(1) remoteAccess.tls collapses to {configured:true} on the override — cert/key PATHS never surface",
    cfg.override.remoteAccess?.tls?.configured === true &&
    cfg.override.remoteAccess?.tls?.certPath === undefined && cfg.override.remoteAccess?.tls?.keyPath === undefined);
  check("(1) remoteAccess.tls collapses to {configured:true} on the resolved group too",
    cfg.resolved.remoteAccess?.tls?.configured === true && cfg.resolved.remoteAccess?.tls?.certPath === undefined);
  check("(1) remoteAccess.enabled/bindHost/rateLimit (non-secret) survive redaction",
    cfg.override.remoteAccess?.enabled === true && cfg.override.remoteAccess?.bindHost === "100.64.1.2" &&
    cfg.override.remoteAccess?.rateLimit?.perIpPerMin === 120);
  check("(1) no raw cert/key filesystem path leaks anywhere in the response",
    !JSON.stringify(cfg).includes("/etc/loom/cert.pem") && !JSON.stringify(cfg).includes("/etc/loom/key.pem"));

  // Config with NO remoteAccess.tls set at all — redaction must be a harmless no-op, not a crash.
  db.setPlatformConfig({ coalesceAgentMessages: false, remoteAccess: { enabled: false, bindHost: "127.0.0.1" } });
  const cfg2 = await call("platform_config_get", {});
  check("(1) a remoteAccess with no tls set passes through with no tls key (no crash, nothing to redact)",
    cfg2.override.remoteAccess?.enabled === false && cfg2.override.remoteAccess?.tls === undefined);

  // Empty platform_config (fresh store) — no crash, sane resolved defaults.
  db.setPlatformConfig({});
  const cfg3 = await call("platform_config_get", {});
  check("(1) an empty platform_config resolves without error and carries no integrations/tls leftovers",
    cfg3.override.integrations === undefined && typeof cfg3.resolved === "object");

  // ===================== (2) events_search — bounded, kind/project/session/task-filterable =====================
  const mkEvt = (id, kind, opts = {}) => db.appendEvent({
    id, ts: now, managerSessionId: opts.managerSessionId ?? "M", workerSessionId: opts.workerSessionId ?? null,
    taskId: opts.taskId ?? null, kind, detail: opts.detail,
  });
  mkEvt("ev-gate", "worker_gate", { workerSessionId: "W", taskId: "task-1", detail: { passed: true } });
  mkEvt("ev-kill", "kill_switch", { detail: { reason: "host overload" } });
  mkEvt("ev-merge-rej", "merge_rejected", { workerSessionId: "W", taskId: "task-1", detail: { reason: "gate failed" } });
  mkEvt("ev-home", "recycle_begin", { managerSessionId: "PL" });

  check("(2) loom-platform registers events_search", platToolNames.includes("events_search"));

  const allEvents = await call("events_search", {});
  check("(2) with no filter, returns an envelope carrying every seeded event",
    Array.isArray(allEvents.events) && allEvents.total >= 4 &&
    ["ev-gate", "ev-kill", "ev-merge-rej", "ev-home"].every((id) => allEvents.events.some((e) => e.id === id)));
  check("(2) envelope shape is always {events,total,returned,offset,nextOffset} — never a bare array",
    !Array.isArray(allEvents) && typeof allEvents.total === "number" && "nextOffset" in allEvents);

  const killOnly = await call("events_search", { kind: ["kill_switch"] });
  check("(2) kind filter narrows to exactly the matching kind", killOnly.events.length === 1 && killOnly.events[0].id === "ev-kill");

  const noSuchKind = await call("events_search", { kind: ["totally_not_a_real_kind"] });
  check("(2) an UNRECOGNIZED kind value is zero rows, never an error (parameterized, not interpolated — injection-safe)",
    noSuchKind.total === 0 && Array.isArray(noSuchKind.events) && noSuchKind.events.length === 0);

  const byProject = await call("events_search", { projectId: "pTarget" });
  check("(2) projectId filter (pTarget) includes worker-keyed events and the manager-keyed kill event",
    byProject.events.some((e) => e.id === "ev-gate") && byProject.events.some((e) => e.id === "ev-kill") && byProject.events.some((e) => e.id === "ev-merge-rej"));
  check("(2) projectId filter excludes the pHome-only event", !byProject.events.some((e) => e.id === "ev-home"));
  check("(2) projectId filter enriches project/agent name", byProject.events.find((e) => e.id === "ev-gate")?.projectName === "Target");
  const byHomeProject = await call("events_search", { projectId: "pHome" });
  check("(2) projectId filter (pHome) sees only the home-scoped event", byHomeProject.events.length === 1 && byHomeProject.events[0].id === "ev-home");

  const badProject = await call("events_search", { projectId: "ghost" });
  check("(2) an unknown projectId is an explicit error", badProject.error === "project not found");

  const bySession = await call("events_search", { sessionId: "W" });
  check("(2) sessionId filter matches events where that session is the WORKER",
    bySession.events.length === 2 && bySession.events.every((e) => ["ev-gate", "ev-merge-rej"].includes(e.id)));

  const byTask = await call("events_search", { taskId: "task-1" });
  check("(2) taskId filter matches events linked to that task", byTask.events.length === 2 && byTask.events.every((e) => e.taskId === "task-1"));

  const detailPreserved = allEvents.events.find((e) => e.id === "ev-kill");
  check("(2) detail is the raw kind-specific payload", detailPreserved?.detail?.reason === "host overload");

  // Pagination: explicit limit/offset walks the set with a correct nextOffset, ending at null.
  const page1 = await call("events_search", { limit: 2, offset: 0 });
  check("(2) limit:2 returns exactly 2 with a non-null nextOffset (4+ total)", page1.events.length === 2 && page1.nextOffset === 2);
  const page2 = await call("events_search", { limit: 2, offset: page1.nextOffset });
  check("(2) paging via offset:nextOffset returns the remaining rows", page2.events.length >= 2 && page2.offset === 2);

  // Clamp tests (card 07ce7c0c bundled nitpick): the `limit` clamp is a simple Math.min in
  // Db.listOrchestrationEventsBounded, previously untested. Seed well past both the default cap (50) and
  // the hard ceiling (MAX_EVENTS_SEARCH_PAGE=200) under one dedicated kind, so counts are exact regardless
  // of the other events already seeded above.
  const CLAMP_TOTAL = MAX_EVENTS_SEARCH_PAGE + 10;
  for (let i = 0; i < CLAMP_TOTAL; i++) mkEvt(`ev-clamp-${i}`, "clamp_test_kind", {});

  const clampDefault = await call("events_search", { kind: ["clamp_test_kind"] });
  check(`(2) clamp: omitted limit defaults to DEFAULT_EVENTS_SEARCH_CAP (${DEFAULT_EVENTS_SEARCH_CAP})`,
    clampDefault.returned === DEFAULT_EVENTS_SEARCH_CAP && clampDefault.events.length === DEFAULT_EVENTS_SEARCH_CAP &&
    clampDefault.total === CLAMP_TOTAL && clampDefault.nextOffset === DEFAULT_EVENTS_SEARCH_CAP);

  const clampOverMax = await call("events_search", { kind: ["clamp_test_kind"], limit: 999999 });
  check(`(2) clamp: a limit far past the ceiling clamps to MAX_EVENTS_SEARCH_PAGE (${MAX_EVENTS_SEARCH_PAGE}), never returns unbounded rows`,
    clampOverMax.returned === MAX_EVENTS_SEARCH_PAGE && clampOverMax.events.length === MAX_EVENTS_SEARCH_PAGE &&
    clampOverMax.nextOffset === MAX_EVENTS_SEARCH_PAGE);

  const clampAtMax = await call("events_search", { kind: ["clamp_test_kind"], limit: MAX_EVENTS_SEARCH_PAGE });
  check("(2) clamp: a limit exactly at the ceiling is honored unclamped", clampAtMax.returned === MAX_EVENTS_SEARCH_PAGE);

  const clampUnderCap = await call("events_search", { kind: ["clamp_test_kind"], limit: 5 });
  check("(2) clamp: a limit well under both caps is honored exactly (not silently bumped)", clampUnderCap.returned === 5);

  // ===================== (3) agent_prompt_search — cross-project, bounded, snippeted =====================
  check("(3) loom-platform registers agent_prompt_search", platToolNames.includes("agent_prompt_search"));

  const seismo = await call("agent_prompt_search", { query: "seismo" });
  check("(3) case-insensitive substring match finds BOTH agents (Lead has 'Seismo', Work has 'SEISMO')",
    seismo.hits.length === 2 && seismo.hits.some((h) => h.agentId === "agentLead") && seismo.hits.some((h) => h.agentId === "agentWork"));
  check("(3) each hit carries a snippet (not the full prompt) containing the match, case-insensitively",
    seismo.hits.every((h) => typeof h.snippet === "string" && h.snippet.toLowerCase().includes("seismo") && h.snippet.length < 200));
  check("(3) each hit carries project/agent identity", seismo.hits.every((h) => !!h.projectId && !!h.projectName && !!h.agentName));

  const seismoScoped = await call("agent_prompt_search", { query: "seismo", projectId: "pTarget" });
  check("(3) projectId narrows to just that project's agent", seismoScoped.hits.length === 1 && seismoScoped.hits[0].agentId === "agentWork");

  const noMatch = await call("agent_prompt_search", { query: "totally-absent-zzz-query" });
  check("(3) no match returns an empty, non-truncated hit list", noMatch.hits.length === 0 && noMatch.truncated === false);

  const capped = await call("agent_prompt_search", { query: "seismo", limit: 1 });
  check("(3) an explicit limit below the match count caps hits and reports truncated:true", capped.hits.length === 1 && capped.truncated === true);

  // Clamp tests (card 07ce7c0c bundled nitpick): `agent_prompt_search`'s effective limit is a plain
  // `Math.max(1, Math.min(limit ?? DEFAULT_PROMPT_SEARCH_CAP, MAX_PROMPT_SEARCH_CAP))`, previously
  // untested. Seed well past both caps under one dedicated project + unique token, so counts are exact
  // regardless of the "seismo" agents seeded above.
  db.insertProject({ id: "pClamp", name: "Clamp", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const CLAMP_AGENT_TOTAL = MAX_PROMPT_SEARCH_CAP + 10;
  for (let i = 0; i < CLAMP_AGENT_TOTAL; i++) {
    db.insertAgent({ id: `agentClamp${i}`, projectId: "pClamp", name: `Clamp${i}`, startupPrompt: "contains clamptoken here", position: i, profileId: null });
  }

  const promptClampDefault = await call("agent_prompt_search", { query: "clamptoken" });
  check(`(3) clamp: omitted limit defaults to DEFAULT_PROMPT_SEARCH_CAP (${DEFAULT_PROMPT_SEARCH_CAP})`,
    promptClampDefault.hits.length === DEFAULT_PROMPT_SEARCH_CAP && promptClampDefault.truncated === true);

  const promptClampOverMax = await call("agent_prompt_search", { query: "clamptoken", limit: 999999 });
  check(`(3) clamp: a limit far past the ceiling clamps to MAX_PROMPT_SEARCH_CAP (${MAX_PROMPT_SEARCH_CAP}), never returns unbounded hits`,
    promptClampOverMax.hits.length === MAX_PROMPT_SEARCH_CAP && promptClampOverMax.truncated === true);

  const promptClampAtMax = await call("agent_prompt_search", { query: "clamptoken", limit: MAX_PROMPT_SEARCH_CAP });
  check("(3) clamp: a limit exactly at the ceiling is honored unclamped", promptClampAtMax.hits.length === MAX_PROMPT_SEARCH_CAP);

  const badProjectPrompt = await call("agent_prompt_search", { query: "seismo", projectId: "ghost" });
  check("(3) an unknown projectId is an explicit error", badProjectPrompt.error === "project not found");

  // Unit: the pure search function honors its own limit/truncation contract directly (no MCP layer).
  const pureHits = searchAgentPrompts(
    [{ id: "p1", name: "P1", agents: [{ id: "a1", name: "A1", startupPrompt: "alpha beta alpha" }] }],
    "alpha", 5,
  );
  check("(3) unit: searchAgentPrompts stops at the FIRST match per agent (one hit per agent, not per occurrence)",
    pureHits.hits.length === 1 && pureHits.truncated === false);

  await client.close();

  // ===================== (4) TRUST GATE — ABSENT from every agent-facing surface =====================
  const platformTools = await listTools(new PlatformMcpRouter(db, svc).buildServer("PL"));
  const setupTools = await listTools(new SetupMcpRouter(db, svc).buildServer());
  const orchRouter = new OrchestrationMcpRouter(db, svc);
  const mgrTools = await listTools(orchRouter.buildServer("M", "manager"));
  const workerTools = await listTools(orchRouter.buildServer("W", "worker"));
  const taskTools = await listTools(new TaskMcpRouter(db, wakes).buildServer("pTarget", "M"));

  for (const t of ["platform_config_get", "events_search", "agent_prompt_search"]) {
    check(`(4) ${t} IS on loom-platform and ABSENT from setup/manager/worker/in-project`,
      platformTools.includes(t) && !setupTools.includes(t) && !mgrTools.includes(t) && !workerTools.includes(t) && !taskTools.includes(t));
  }
  // Negative control: prove the absence assertion has teeth (the gate would catch a leak).
  check("(4) negative control: a tool that DOES exist on orchestration is detected (proves teeth)",
    mgrTools.includes("worker_spawn"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the platform surface's three forensics reads (platform_config_get, events_search, agent_prompt_search) close the raw-sqlite-forensics gap: platform_config_get redacts codescape/TLS-key-path secret-shaped fields while passing operational tuning through; events_search is a bounded, kind/project/session/task-filterable page not limited to gate-run kinds (unrecognized kinds are zero rows, parameterized — injection-safe); agent_prompt_search is a bounded, snippeted, cross-project substring search. All three are PRESENT only on loom-platform — ABSENT from loom-setup, loom-orchestration (manager + worker), and the in-project loom-tasks surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
