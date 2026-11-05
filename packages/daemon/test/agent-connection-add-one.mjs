import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Atomic ADD-ONE agent connection grant (card b1df40f2): POST /api/agents/:id/connections.
//
// Covers:
//   (1) happy path + idempotency: adding an id lands (added:true, fresh-spawn note), re-adding is a
//       200 no-op (added:false, list unchanged, no note); the pending binding is marked applied.
//   (2) REFUSAL PARITY with the whole-list POST /api/agents/:id — the SAME 400 status and BYTE-IDENTICAL
//       error text for a cross-project connection; an unknown NEW id is 404 on the add-one only (the
//       whole-list route tolerates unknown ids — asymmetry is deliberate); bad body -> 400; bad agent -> 404.
//       Also the extracted validator is behaviour-preserving on the whole-list route for the capability
//       cases (oauth2-bound requiresConnection capability, codex-profiled capability grant).
//       (2d) codex parity on the add-one: existing capability + codex profile -> 400, text byte-equal to whole-list.
//       (2e) the pending credential binding is flipped to 'applied' by the add-one (real Question -> answer -> add-one).
//   (3) STRUCTURAL GUARDS on the Db method (NOT a race reproduction): better-sqlite3 is synchronous, so two
//       requests can never truly interleave inside one process. The REAL race was the web client's
//       GET-then-POST of the whole list; that is guarded by the web-side check in packages/web/test
//       (the Settings grant mutation calls api.addAgentConnection, not updateAgent). What (3a)-(3c) pin is
//       that Db.addAgentConnection issues no read-before-write gap: an INTERLEAVE HOOK on the real handle fires
//       a whole-list write after the method's first read statement; the correct ONE-UPDATE implementation has
//       no such gap, a read-then-write mutant is hit by the hook and loses the grant (3c is the control).
//   (4) NO MCP SURFACE: the real guard is validateAgentPatch(allowCredentialGrants:false) on the MCP write
//       paths PLUS no built MCP tools/list inputSchema declaring `connections`; asserted here on the BUILT
//       tools/list of several routers. The src/mcp source-text scan is kept only as a secondary tripwire.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-connection-add-one.mjs
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = useOwnLoomHome("loom-agent-conn-add-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createConnection, createOAuthConnection } = await import("../dist/connections/store.js");
const { createCapabilityDef } = await import("../dist/capabilities/registry.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const J = (x) => JSON.stringify(x);

const db = new Db(path.join(tmpHome, "addone.db"));
const now = new Date().toISOString();
db.insertProject({ id: "pA", name: "A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pB", name: "B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, extra = {}) => db.insertAgent({ id, projectId: "pA", name: id, startupPrompt: "", position: 0, profileId: null, ...extra });
const conn = (name, projectId) => createConnection(db, { name, host: `${name}.example`, authScheme: "bearer", secret: `sek-${name}`, ...(projectId ? { projectId } : {}) });
const connA = conn("ConnA", "pA");
const connB = conn("ConnB", "pB");
const connG1 = conn("ConnG1");
const connG2 = conn("ConnG2");
const connOAuth = createOAuthConnection(db, {
  name: "ConnOAuth", host: "o.example", provider: "custom",
  clientId: "cid", clientSecret: "csecret", authUrl: "https://o.example/auth", tokenUrl: "https://o.example/token", scopes: ["read"],
});
createCapabilityDef(db, {
  slug: "addone-cap", name: "AddOne Cap", description: "test cap", transport: "stdio", kind: "bundled",
  provision: { command: process.execPath, args: [] }, toolAllowlist: [], wantsScratchDir: false,
  requiresConnection: true, secretEnvVar: "ADDONE_TOKEN",
});

const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub,
  platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
const addOne = (agentId, connectionId) => app.inject({ method: "POST", url: `/api/agents/${agentId}/connections`, payload: { connectionId } });
const wholeList = (agentId, payload) => app.inject({ method: "POST", url: `/api/agents/${agentId}`, payload });
const listOf = (agentId) => db.getAgent(agentId).connections ?? [];

// ===================== (1) happy path + idempotency =====================
{
  mkAgent("agent1");
  const r1 = await addOne("agent1", connG1.id);
  const b1 = JSON.parse(r1.body);
  check("(1) add-one: 200", r1.statusCode === 200);
  check("(1) the id landed on the agent row", J(listOf("agent1")) === J([connG1.id]));
  check("(1) response reports added:true + the fresh-spawn note", b1.added === true && typeof b1.connectionsFreshSpawnNote === "string");
  const r2 = await addOne("agent1", connG2.id);
  check("(1) a second distinct id APPENDS (existing grant kept)", r2.statusCode === 200 && J(listOf("agent1")) === J([connG1.id, connG2.id]));
  const again = await addOne("agent1", connG1.id);
  const bAgain = JSON.parse(again.body);
  check("(1) IDEMPOTENT: re-adding a present id is 200 with added:false", again.statusCode === 200 && bAgain.added === false);
  check("(1) ...the list is unchanged (no duplicate) and no fresh-spawn note", J(listOf("agent1")) === J([connG1.id, connG2.id]) && !("connectionsFreshSpawnNote" in bAgain));
  check("(1) a same-project scoped connection is accepted", (await addOne("agent1", connA.id)).statusCode === 200 && listOf("agent1").includes(connA.id));
  // Corrupt column reads as [] (same as toAgent) and the add repairs it to a clean array.
  mkAgent("agentCorrupt");
  db.db.prepare("UPDATE agents SET connections = ? WHERE id = ?").run("{not valid json", "agentCorrupt");
  check("(1) a corrupt connections column: add-one lands as a clean single-element list", (await addOne("agentCorrupt", connG1.id)).statusCode === 200 && J(listOf("agentCorrupt")) === J([connG1.id]));
}

// ===================== (2) refusal parity with the whole-list route =====================
{
  mkAgent("agentP");
  const wl = await wholeList("agentP", { connections: [connB.id] });
  const ao = await addOne("agentP", connB.id);
  check("(2) cross-project: whole-list 400", wl.statusCode === 400);
  check("(2) cross-project: add-one 400", ao.statusCode === 400);
  check("(2) cross-project: error text is BYTE-IDENTICAL on both routes", JSON.parse(wl.body).error === JSON.parse(ao.body).error && JSON.parse(ao.body).error.includes(connB.id));
  check("(2) the refused add-one did NOT land", J(listOf("agentP")) === J([]));

  const unknownAdd = await addOne("agentP", "no-such-connection");
  check("(2) an UNKNOWN new id is 404 on the add-one", unknownAdd.statusCode === 404);
  const unknownWhole = await wholeList("agentP", { connections: ["no-such-connection"] });
  check("(2) ...while the whole-list route still TOLERATES an unknown id (deliberate asymmetry, unchanged)", unknownWhole.statusCode === 200);
  db.updateAgent("agentP", { connections: [] });

  check("(2) missing connectionId -> 400", (await app.inject({ method: "POST", url: "/api/agents/agentP/connections", payload: {} })).statusCode === 400);
  check("(2) non-string connectionId -> 400", (await addOne("agentP", 5)).statusCode === 400);
  check("(2) unknown agent -> 404", (await addOne("nope", connG1.id)).statusCode === 404);

  // Whole-list validator extraction is behaviour-preserving for the capability cases (status + text).
  const oauthRes = await wholeList("agentP", { capabilities: [{ slug: "addone-cap", connectionId: connOAuth.id }] });
  check("(2) whole-list oauth2-bound capability: 400 with the binding error text", oauthRes.statusCode === 400 && /oauth2 connection, which can't be statically injected/.test(JSON.parse(oauthRes.body).error));
  const crossCap = await wholeList("agentP", { capabilities: [{ slug: "addone-cap", connectionId: connB.id }] });
  check("(2) whole-list cross-project capability connectionId: 400 with the scope text", crossCap.statusCode === 400 && JSON.parse(crossCap.body).error === JSON.parse(ao.body).error);
  db.insertProfile({ id: "profCodex", name: "Codex Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
  mkAgent("agentCodex", { profileId: "profCodex" });
  const codexRes = await wholeList("agentCodex", { capabilities: [{ slug: "addone-cap" }] });
  check("(2) whole-list capability grant on a codex-profiled agent: 400 naming codex", codexRes.statusCode === 400 && /codex/.test(JSON.parse(codexRes.body).error));
  check("(2) a plain connection add-one on a codex-profiled agent is unaffected (connections are not stdio)", (await addOne("agentCodex", connG1.id)).statusCode === 200);

  // The whole-list route also refuses a bad connections SHAPE exactly as before.
  check("(2) whole-list connections shape error unchanged", (await wholeList("agentP", { connections: [1] })).statusCode === 400);

  // (2d) card 3c18328b item 4: CODEX PARITY on the add-one route. An agent that ALREADY carries a capability
  // and is bound to a codex profile: a connections-only add-one is refused 400 with codex text BYTE-EQUAL to
  // the whole-list route's response for the same post-add list (the validator reads existing.capabilities).
  mkAgent("agentCodexCap", { profileId: "profCodex" });
  db.updateAgent("agentCodexCap", { capabilities: [{ slug: "addone-cap" }] });
  const wlCodex = await wholeList("agentCodexCap", { connections: [connG1.id] });
  const aoCodex = await addOne("agentCodexCap", connG1.id);
  check("(2d) codex+existing-capability agent: whole-list connections write is 400 naming codex", wlCodex.statusCode === 400 && /codex/.test(JSON.parse(wlCodex.body).error));
  check("(2d) ...and the add-one is 400 too", aoCodex.statusCode === 400);
  check("(2d) ...with BYTE-EQUAL error text on both routes", JSON.parse(aoCodex.body).error === JSON.parse(wlCodex.body).error);
  check("(2d) the refused add-one did NOT land", J(listOf("agentCodexCap")) === J([]));
}

// ===================== (2e) the pending binding is marked APPLIED by the add-one (card 3c18328b item 1) =====================
// Real flow: a credential Question filed by a session OF the agent is answered (provisions a Connection, binding
// stays 'pending'), then the add-one grant must flip it to 'applied'. RED = delete the markBindingsAppliedForAgent
// call at the add-one route while keeping the route.
{
  const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
  db.insertProfile({ id: "profBind", name: "Bind Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  mkAgent("agentBind");
  db.insertSession({
    id: "sessBind", projectId: "pA", agentId: "agentBind", engineSessionId: "eng-bind", title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const built = buildQuestionAsk(
    { type: "credential", title: "Need a token", body: "test ask", provisionTo: { connection: { name: "Bind Me", host: "bind.example" }, binding: { profileId: "profBind" } } },
    { sessionId: "sessBind", projectId: "pA", db, role: "manager" },
  );
  if ("error" in built) throw new Error(`buildQuestionAsk: ${built.error}`);
  db.insertQuestion({ ...built.question, id: "cred-bind" });
  const ans = await app.inject({ method: "POST", url: "/api/questions/cred-bind/answer", payload: { secret: "sek-bind" } });
  const provId = db.getQuestion("cred-bind").provisionConnectionId;
  check("(2e) setup: the credential answer provisioned a connection and left the binding 'pending'", ans.statusCode === 200 && !!provId && db.getQuestion("cred-bind").provisionBindingState === "pending");
  const grant = await addOne("agentBind", provId);
  check("(2e) the add-one grant of the provisioned connection -> 200", grant.statusCode === 200 && listOf("agentBind").includes(provId));
  check("(2e) the pending binding is now 'applied' (markBindingsAppliedForAgent ran on the add-one route)", db.getQuestion("cred-bind").provisionBindingState === "applied");
}

// ===================== (3) concurrency: an interleaved whole-list write is not lost =====================
// Wrap the REAL handle's prepare(): while db.addAgentConnection is running and BEFORE it has issued any
// write, the first read statement (get/all) it performs is followed by a whole-list write from "another
// request" (db.updateAgent) — i.e. the write lands exactly between the method's read and its write.
function installInterleave(targetDb, agentId, wholeListConnections, methodName = "addAgentConnection") {
  const handle = targetDb.db;
  const origPrepare = handle.prepare.bind(handle);
  const origMethod = targetDb[methodName].bind(targetDb);
  const state = { inMethod: false, wroteYet: false, firing: false, fired: 0 };
  handle.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (!state.inMethod || state.firing) return stmt;
    return new Proxy(stmt, {
      get(t, prop) {
        const v = t[prop];
        if (typeof v !== "function") return v;
        return (...args) => {
          const out = v.apply(t, args);
          if (prop === "run") state.wroteYet = true;
          else if ((prop === "get" || prop === "all") && !state.wroteYet && state.fired === 0) {
            state.firing = true; state.fired++;
            try { targetDb.updateAgent(agentId, { connections: wholeListConnections }); } finally { state.firing = false; }
          }
          return out;
        };
      },
    });
  };
  targetDb[methodName] = (...a) => { state.inMethod = true; try { return origMethod(...a); } finally { state.inMethod = false; } };
  return state;
}
{
  // (3a) STRUCTURAL smoke (not a race): two injected requests in flight together; sync sqlite serialises them.
  mkAgent("agentRace");
  const [w, a] = await Promise.all([wholeList("agentRace", { connections: [connG2.id] }), addOne("agentRace", connG1.id)]);
  check("(3a) concurrent whole-list + add-one: both 200", w.statusCode === 200 && a.statusCode === 200);
  check("(3a) the add-one grant survives alongside the whole-list write", listOf("agentRace").includes(connG1.id));

  // (3b) STRUCTURAL guard on the Db method: a hook-injected whole-list write lands between the add-one's read and its write.
  mkAgent("agentInterleave");
  db.updateAgent("agentInterleave", { connections: [connA.id] });
  const st = installInterleave(db, "agentInterleave", [connA.id, connG2.id]);
  const r = await addOne("agentInterleave", connG1.id);
  const finalList = listOf("agentInterleave");
  console.log(`      interleave hook fired ${st.fired}x (0 = the implementation has no read-before-write gap); final list = ${J(finalList)}`);
  check("(3b) the add-one request still succeeds", r.statusCode === 200);
  // If the hook fired, a whole-list write landed mid-method and its grant (connG2) MUST have survived.
  // If it did not fire, the implementation has no gap to interleave in (single statement) — also correct.
  check("(3b) an interleaved WHOLE-LIST grant is NOT lost (connG2 present whenever the hook fired)", st.fired === 0 || finalList.includes(connG2.id));
  check("(3b) the add-one grant landed (connG1 present)", finalList.includes(connG1.id));
  check("(3b) the pre-existing grant is kept (connA present)", finalList.includes(connA.id));

  // (3c) HARNESS CONTROL — the hook must be able to FAIL. A deliberately non-atomic reference (JS read of
  // the list, then a write of the whole list) run through the SAME hook has to lose the interleaved grant.
  // Without this the (3b) pass could be a hook that never fires on anything.
  mkAgent("agentControl");
  db.updateAgent("agentControl", { connections: [connA.id] });
  db.nonAtomicReference = (agentId, connectionId) => {
    const row = db.db.prepare("SELECT connections FROM agents WHERE id = ?").get(agentId);
    const list = JSON.parse(row.connections);
    db.db.prepare("UPDATE agents SET connections = ? WHERE id = ?").run(J(list.includes(connectionId) ? list : [...list, connectionId]), agentId);
  };
  const stc = installInterleave(db, "agentControl", [connA.id, connG2.id], "nonAtomicReference");
  db.nonAtomicReference("agentControl", connG1.id);
  check("(3c) CONTROL: the hook fired inside the non-atomic reference", stc.fired === 1);
  check("(3c) CONTROL: the non-atomic reference LOSES the interleaved whole-list grant (connG2 absent) — the failure (3b) guards against", !listOf("agentControl").includes(connG2.id) && listOf("agentControl").includes(connG1.id));
}

// ===================== (4) no MCP router exposes an add-agent-connection writer =====================
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const mcpDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "mcp");
  const offenders = [];
  let scanned = 0;
  for (const f of readdirSync(mcpDir).filter((n) => n.endsWith(".ts"))) {
    scanned++;
    const src = readFileSync(path.join(mcpDir, f), "utf8");
    if (/addAgentConnection|\/api\/agents\/[^"'`]*\/connections/.test(src)) offenders.push(f);
    for (const m of src.matchAll(/registerTool\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (/agent.*connection|add.?connection|connection.*grant|grant.*connection/i.test(m[1])) offenders.push(`${f}:${m[1]}`);
    }
  }
  // Control: the SAME extraction pattern must find a tool known to be registered (platform.ts agent_update).
  const platformNames = [...readFileSync(path.join(mcpDir, "platform.ts"), "utf8").matchAll(/registerTool\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  check("(4) CONTROL: the registration-name pattern finds the known tool 'agent_update' in platform.ts", platformNames.includes("agent_update"));
  check(`(4) secondary tripwire: scanned ${scanned} src/mcp/*.ts files (source-text scan, weak) — none references addAgentConnection, the add-one route, or an add/grant-connection tool name`, scanned > 5 && offenders.length === 0);
  if (offenders.length) console.log("      offenders:", offenders.join(", "));
}

// ===================== (4b) BUILT tools/list: no router tool inputSchema declares `connections` =====================
// Card 3c18328b item 3. The real guard against an agent-callable connection-grant writer is that no MCP tool
// can even NAME a `connections` argument (and validateAgentPatch runs allowCredentialGrants:false on MCP).
{
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
  const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
  const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
  const { TaskMcpRouter } = await import("../dist/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const listTools = async (server) => {
    const client = new Client({ name: "add-one-surface", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools;
    await client.close();
    return tools;
  };
  // Every property key (at any depth) declared in a JSON-schema fragment.
  const propKeys = (s, out = new Set()) => {
    if (!s || typeof s !== "object") return out;
    if (s.properties && typeof s.properties === "object") for (const [k, v] of Object.entries(s.properties)) { out.add(k); propKeys(v, out); }
    for (const v of Object.values(s)) if (v && typeof v === "object") propKeys(v, out);
    return out;
  };
  const withConnections = (tools) => tools.filter((t) => propKeys(t.inputSchema).has("connections")).map((t) => t.name);
  // Control 1: the scanner flags a synthetic tool that declares `connections` (nested too).
  check("(4b) CONTROL: the scanner flags a synthetic tool declaring `connections` (top-level and nested)",
    J(withConnections([{ name: "bad_top", inputSchema: { properties: { connections: {} } } }, { name: "bad_nested", inputSchema: { properties: { patch: { properties: { connections: {} } } } } }, { name: "ok", inputSchema: { properties: { name: {} } } }])) === J(["bad_top", "bad_nested"]));
  const savedDev = process.env.LOOM_DEV;
  const surfaces = [];
  try {
    const orch = new OrchestrationMcpRouter(db, {});
    surfaces.push(["orchestration manager", await listTools(orch.buildServer("sessBind", "manager"))]);
    surfaces.push(["orchestration worker", await listTools(orch.buildServer("sessBind", "worker"))]);
    surfaces.push(["loom-tasks", await listTools(new TaskMcpRouter(db, {}).buildServer("pA", "sessBind"))]);
    surfaces.push(["setup", await listTools(new SetupMcpRouter(db, {}).buildServer("s-setup"))]);
    for (const dev of ["1", undefined]) {
      if (dev === undefined) delete process.env.LOOM_DEV; else process.env.LOOM_DEV = dev;
      surfaces.push([`platform (LOOM_DEV=${dev ?? "unset"})`, await listTools(new PlatformMcpRouter(db, {}).buildServer("s-platform"))]);
    }
  } finally {
    if (savedDev === undefined) delete process.env.LOOM_DEV; else process.env.LOOM_DEV = savedDev;
  }
  // Control 2: the real corpus is non-trivial and contains agent-writing tools (the thing this guards).
  const platformTools = surfaces.find(([n]) => n.startsWith("platform"))[1];
  check("(4b) CONTROL: the built platform surface lists agent_update with real properties", propKeys(platformTools.find((t) => t.name === "agent_update")?.inputSchema).size > 0);
  for (const [name, tools] of surfaces) {
    check(`(4b) ${name}: ${tools.length} built tools, none declares a \`connections\` input property`, tools.length > 3 && withConnections(tools).length === 0);
    const hits = withConnections(tools);
    if (hits.length) console.log("      tools declaring `connections`:", hits.join(", "));
  }
}

db.close();
console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/agents/:id/connections adds one id atomically (single UPDATE), is idempotent, shares the whole-list route's refusals byte-for-byte (404 for an unknown NEW id on the add-one only), never loses an interleaved whole-list write, and no MCP source references it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
