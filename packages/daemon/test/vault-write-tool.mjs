import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card be8be211 — the confined `vault_write` MCP tool (loom-tasks / TaskMcpRouter), the profile-gated
// affordance letting a research/Analyst rig write its deliverable note straight into ITS OWN project's
// vault instead of a manager hand-transcribing it. SECURITY-CRITICAL, fully hermetic: NO real network,
// NO real claude — a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam,
// mirrors authenticated-request.mjs), the REAL TaskMcpRouter driven over an in-process MCP
// InMemoryTransport, and the REAL SetupMcpRouter for the agent-forbidden-key coverage.
//
// Proves, end-to-end (shared type -> profiles/validate.ts -> resolveProfile -> session-row pin ->
// TaskMcpRouter tools/list -> vault/writer.ts):
//   (a) off (no profile grant): vault_write OMITTED from tools/list entirely (not merely denied).
//   (b) on: vault_write PRESENT, and a real call lands a UTF-8 file under the project's vault root.
//   (c) a traversal/absolute/backslash path is REJECTED (the reused vault/writer.ts confinement).
//   (d) an agent-facing profile writer (setup AND platform profile_create/update) REJECTS
//       vaultWrite:true, and the underlying agentProfileKeyError unit rejects/allows correctly.
//   (e) the tool's inputSchema carries no projectId param — the write can only ever address the
//       caller's OWN session-derived project (server-derived, never agent-passed).
//
// Run: 1) build (turbo builds shared first), 2) node test/vault-write-tool.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-vault-write-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { agentProfileKeyError } = await import("../dist/profiles/validate.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

try {
  const db = new Db(path.join(tmpHome, "d.db"));
  const now = new Date().toISOString();
  const PROJECT_ID = "pVaultWrite";
  const vaultPath = path.join(tmpHome, "vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  db.insertProject({ id: PROJECT_ID, name: "VaultWriteProj", repoPath: tmpHome, vaultPath, config: {}, createdAt: now, archivedAt: null });

  // A second project, to prove vault_write can never be pointed at ANOTHER project's vault (there is no
  // parameter through which to even try — see (e) below).
  const OTHER_PROJECT_ID = "pOtherVault";
  const otherVaultPath = path.join(tmpHome, "other-vault");
  fs.mkdirSync(otherVaultPath, { recursive: true });
  db.insertProject({ id: OTHER_PROJECT_ID, name: "OtherProj", repoPath: tmpHome, vaultPath: otherVaultPath, config: {}, createdAt: now, archivedAt: null });

  // Profile A: no vaultWrite (the default/off case). Profile B: grants it.
  db.insertProfile({ id: "profNoVault", name: "NoVaultRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertProfile({ id: "profWithVault", name: "WithVaultRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null, vaultWrite: true });
  db.insertAgent({ id: "agentNoVault", projectId: PROJECT_ID, name: "NoVault", startupPrompt: "", position: 0, profileId: "profNoVault" });
  db.insertAgent({ id: "agentWithVault", projectId: PROJECT_ID, name: "WithVault", startupPrompt: "", position: 1, profileId: "profWithVault" });

  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) { this.capture.push(opts); return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

  const sNoVault = svc.startNew("agentNoVault");
  const sWithVault = svc.startNew("agentWithVault");

  check("session row: no-vaultWrite profile pins vaultWrite falsy", !db.getSession(sNoVault.id).vaultWrite);
  check("session row: vaultWrite profile pins vaultWrite = true", db.getSession(sWithVault.id).vaultWrite === true);

  // Spawn-path additivity: `vaultWrite` never reaches SpawnOpts at all (mirrors `connections` — the
  // mechanism lives entirely in the DB-resolved MCP router, not the pty spawn path).
  const oNo = optsFor(sNoVault.id);
  const oWith = optsFor(sWithVault.id);
  check("SpawnOpts carries NO 'vaultWrite' key on either session (spawn path untouched)", !("vaultWrite" in oNo) && !("vaultWrite" in oWith));
  check("otherwise-identical spawn opts (role/model/skills/browserTesting/documentConversion) match", oNo.role === oWith.role && oNo.model === oWith.model && JSON.stringify(oNo.skills) === JSON.stringify(oWith.skills) && oNo.browserTesting === oWith.browserTesting && oNo.documentConversion === oWith.documentConversion);

  const wakes = {}; // vault_write never touches wakes; a stub suffices (mirrors authenticated-request.mjs)
  const router = new TaskMcpRouter(db, wakes);

  const connectTo = async (sessionId) => {
    const projectId = router.resolveProject(sessionId);
    const server = router.buildServer(projectId, sessionId);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vault-write-test", version: "0" });
    await client.connect(clientT);
    return client;
  };

  // --- (a) off: vault_write OMITTED from tools/list entirely ---
  {
    const client = await connectTo(sNoVault.id);
    const tools = (await client.listTools()).tools;
    check("(a) no-vaultWrite session: vault_write OMITTED from tools/list", !tools.some((t) => t.name === "vault_write"));
    check("(a) every other loom-tasks tool still present (additive, not replacing)", ["tasks_list", "tasks_get", "wake_me"].every((n) => tools.some((t) => t.name === n)));
    await client.close();
  }

  // --- (b)/(e) on: vault_write PRESENT, inputSchema has no projectId, and a real write lands on disk ---
  let vaultWriteTool;
  {
    const client = await connectTo(sWithVault.id);
    const tools = (await client.listTools()).tools;
    vaultWriteTool = tools.find((t) => t.name === "vault_write");
    check("(b) vaultWrite session: vault_write PRESENT in tools/list", !!vaultWriteTool);
    const props = Object.keys(vaultWriteTool?.inputSchema?.properties ?? {});
    check("(e) inputSchema is EXACTLY {path, content} — no projectId (server-derived, never agent-passed)", props.sort().join(",") === "content,path");

    const res = await client.callTool({ name: "vault_write", arguments: { path: "Design/Note.md", content: "hello from vault_write" } });
    const parsed = JSON.parse(res.content[0].text);
    check("(b) vault_write call: ok:true", parsed.ok === true);
    const onDisk = path.join(vaultPath, "Design", "Note.md");
    check("(b) file actually lands on disk under the project vault root", fs.existsSync(onDisk) && fs.readFileSync(onDisk, "utf8") === "hello from vault_write");
    check("(b) it was committed through the vault auto-committer (git init + commit, mirrors vault/writer.ts)", parsed.committed === true);

    // Overwrite: writeVaultFile is create-OR-overwrite (write-only design, no delete tool exposed).
    const res2 = await client.callTool({ name: "vault_write", arguments: { path: "Design/Note.md", content: "updated" } });
    const parsed2 = JSON.parse(res2.content[0].text);
    check("(b) a second call OVERWRITES (create-or-overwrite semantics)", parsed2.ok === true && fs.readFileSync(onDisk, "utf8") === "updated");
    check("(b) no 'vault_delete'-shaped tool exists on this router", !tools.some((t) => t.name.includes("vault_delete")));

    await client.close();
  }

  // --- (c) traversal / absolute / backslash paths are REJECTED — the inherited vault/writer.ts confinement ---
  {
    const client = await connectTo(sWithVault.id);
    const bad = ["../escape.md", "../../escape.md", path.join(tmpHome, "outside.md"), "sub\\evil.md"];
    for (const p of bad) {
      const res = await client.callTool({ name: "vault_write", arguments: { path: p, content: "should never land" } });
      const parsed = JSON.parse(res.content[0].text);
      check(`(c) path '${JSON.stringify(p)}' REJECTED (ok:false)`, parsed.ok === false);
    }
    check("(c) nothing escaped the vault root: tmpHome itself gained no new file", !fs.existsSync(path.join(tmpHome, "outside.md")) && !fs.existsSync(path.join(tmpHome, "escape.md")));
    // Confirm confinement is to THIS project's vault, never the sibling project's vault dir — vault_write
    // has no projectId param at all (see (e) above), so there is no input through which to even try.
    check("(c) the sibling project's vault directory stayed empty (no cross-project reach)", fs.readdirSync(otherVaultPath).filter((f) => f !== ".git").length === 0);
    await client.close();
  }

  // --- (d) an agent-facing profile writer REJECTS vaultWrite:true (AGENT_FORBIDDEN_PROFILE_KEYS) ---
  // (d0) the underlying agentProfileKeyError unit itself, mirroring open-design-spawn.mjs's coverage
  // of the same guard for `openDesign` — both setup's and platform's profile_create/update funnel
  // through this ONE function, so this direct unit assertion is the load-bearing one.
  {
    check("(d0) agentProfileKeyError REJECTS a payload setting vaultWrite:true",
      typeof agentProfileKeyError({ vaultWrite: true }) === "string");
    check("(d0) agentProfileKeyError allows a payload that doesn't touch vaultWrite",
      agentProfileKeyError({ name: "x" }) === null);
  }
  {
    const setupRouter = new SetupMcpRouter(db, svc);
    // The Setup router is role-gated to role==="setup" — spawn one plain "setup" session row directly
    // (no real claude needed; the MCP handler only reads db.getSession(sessionId).role).
    const setupSessionId = "sSetupForVaultWriteTest";
    db.insertSession({
      id: setupSessionId, projectId: PROJECT_ID, agentId: "agentNoVault", engineSessionId: null, title: null,
      cwd: tmpHome, processState: "live", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "setup",
    });
    const server = setupRouter.buildServer(setupSessionId);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vault-write-setup-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const nProfBefore = db.listProfiles().length;
    const created = await call("profile_create", { profile: { name: "SneakyRig", vaultWrite: true } });
    check("(d) profile_create REJECTS a payload setting vaultWrite:true", typeof created.error === "string" && !created.id);
    check("(d) the rejected profile_create persisted NOTHING", db.listProfiles().length === nProfBefore);

    const updated = await call("profile_update", { profileId: "profNoVault", patch: { vaultWrite: true } });
    check("(d) profile_update REJECTS a patch setting vaultWrite:true", typeof updated.error === "string");
    check("(d) the rejected profile_update left the profile's vaultWrite untouched (still off)", !db.getProfile("profNoVault").vaultWrite);

    await client.close();
  }

  // --- (d) platform-router surface: same guard, same rejection (share agentProfileKeyError with setup,
  // but the load-bearing agent-forbidden guard deserves direct coverage on BOTH elevated routers) ---
  {
    const platformRouter = new PlatformMcpRouter(db, svc);
    const server = platformRouter.buildServer("platLeadForVaultWriteTest");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "vault-write-platform-test", version: "0" });
    await client.connect(clientT);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

    const nProfBefore = db.listProfiles().length;
    const created = await call("profile_create", { profile: { name: "SneakyPlatformRig", vaultWrite: true } });
    check("(d) platform profile_create REJECTS a payload setting vaultWrite:true", typeof created.error === "string" && !created.id);
    check("(d) the rejected platform profile_create persisted NOTHING", db.listProfiles().length === nProfBefore);

    const updated = await call("profile_update", { profileId: "profNoVault", patch: { vaultWrite: true } });
    check("(d) platform profile_update REJECTS a patch setting vaultWrite:true", typeof updated.error === "string");
    check("(d) the rejected platform profile_update left the profile's vaultWrite untouched (still off)", !db.getProfile("profNoVault").vaultWrite);

    await client.close();
  }

  db.close();

  console.log(failures === 0
    ? "\n✅ ALL PASS — vault_write: OMITTED from tools/list when the profile didn't opt in, PRESENT + writes land under the project vault root when it did, traversal/absolute/backslash paths rejected (inherited confinement), no projectId param exists to address another project, agentProfileKeyError itself rejects vaultWrite:true, and BOTH the agent-facing setup and platform profile writers REJECT vaultWrite:true with nothing persisted."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
