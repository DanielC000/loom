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
//   (3) CONCURRENCY: a whole-list write that lands BETWEEN the add-one's read and its write must not be
//       lost. Driven by an INTERLEAVE HOOK on the real better-sqlite3 handle: after the first read
//       statement the add-one's Db method issues (and before its first write), a whole-list write lands.
//       The correct implementation is ONE UPDATE statement — it issues no read before its write, so the
//       hook has no gap to fire in and both writes survive; a read-then-write mutant is hit by the hook and
//       loses the whole-list grant (that is the RED this test exists to show).
//   (4) NO MCP SURFACE: no tool on any built MCP router is named like an add-agent-connection writer.
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

  // markBindingsAppliedForAgent runs on the add-one: covered end-to-end by e2e/pending-bindings.spec.ts
  // (needs a real filed credential Question, which this fixture does not create).
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
  // (3a) Real HTTP-level concurrency: both requests in flight together — both grants survive.
  mkAgent("agentRace");
  const [w, a] = await Promise.all([wholeList("agentRace", { connections: [connG2.id] }), addOne("agentRace", connG1.id)]);
  check("(3a) concurrent whole-list + add-one: both 200", w.statusCode === 200 && a.statusCode === 200);
  check("(3a) the add-one grant survives alongside the whole-list write", listOf("agentRace").includes(connG1.id));

  // (3b) Interleaved: a whole-list write lands between the add-one's read and its write.
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
  check(`(4) scanned ${scanned} src/mcp/*.ts files (source-text scan, not a tools/list probe) — none references addAgentConnection, the add-one route, or an add/grant-connection tool name`, scanned > 5 && offenders.length === 0);
  if (offenders.length) console.log("      offenders:", offenders.join(", "));
}

db.close();
console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/agents/:id/connections adds one id atomically (single UPDATE), is idempotent, shares the whole-list route's refusals byte-for-byte (404 for an unknown NEW id on the add-one only), never loses an interleaved whole-list write, and no MCP source references it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
