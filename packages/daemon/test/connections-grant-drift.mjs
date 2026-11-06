import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Grants added to (or revoked from) an AGENT after a session spawned: (1) the session keeps its pinned list
// (recycle freeze stays — connections-recycle-freeze-contract.mjs), (2) the agent-facing tool description and
// every refusal SAY so and name the human re-pin route, never recycle, (3) a human re-pin
// (`repinSessionGrants`) makes the session carry exactly the agent's CURRENT grants — additions arrive,
// revocations drop — and the drift note disappears. Hermetic: REAL Db + SessionService on a fake pty, the
// real TaskMcpRouter via an in-memory MCP client. No claude, no daemon, no network.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-grant-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-conndrift-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createConnection, createSshConnection } = await import("../dist/connections/store.js");
const { utils: sshUtils } = (await import("ssh2")).default;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const repo = path.join(os.tmpdir(), `loom-conndrift-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# connections-grant-drift\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cgd@loom -c user.name=cgd");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profMgr", name: "MgrRig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Homelab", startupPrompt: "MGR_PROMPT", position: 0, profileId: "profMgr" });
const mk = (name) => createConnection(db, { name, host: `${name.toLowerCase()}.lan`, authScheme: "bearer", secret: `sek-${name}` }).id;
const [c1, c2, c3, c4, c5, c6] = ["Raspi", "Nas", "Pve", "Debian", "PlexLxc", "Plex"].map(mk);

class SeamHost extends createSeamHost(PtyHost) {
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());

// Every outbound call goes to this stub — never the network. `fetched` records the URL it was asked for.
let fetched = null;
const fetchStub = async (url) => { fetched = String(url); return new Response("ok", { status: 200 }); };
const withClient = async (sessionId, fn) => {
  const server = new TaskMcpRouter(db, {}, fetchStub).buildServer("pP", sessionId);
  const client = new Client({ name: "conn-drift", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { return await fn(client); } finally { await client.close(); }
};
const authDescription = (sessionId) => withClient(sessionId, async (c) => (await c.listTools()).tools.find((t) => t.name === "authenticated_request")?.description ?? "");
const callAuth = (sessionId, connection) => withClient(sessionId, async (c) => {
  const r = await c.callTool({ name: "authenticated_request", arguments: { connection, path: "/x" } });
  return JSON.parse(r.content[0].text);
});
const sorted = (a) => JSON.stringify([...(a ?? [])].sort());

try {
  // The owner granted 3 at first; the manager spawns; then 3 more are granted AND one original is revoked.
  db.updateAgent("agentMgr", { connections: [c1, c2, c3] });
  const mgr = svc.startManager("agentMgr", "GO");
  check("(1) fresh spawn pins the 3 granted at spawn time", sorted(db.getSession(mgr.id).connections) === sorted([c1, c2, c3]));
  check("(2) no drift yet -> no drift note in the tool description", !/granted to your agent after/.test(await authDescription(mgr.id)));

  db.updateAgent("agentMgr", { connections: [c1, c2, c4, c5, c6] }); // +Debian +PlexLxc +Plex, -Pve
  const desc = await authDescription(mgr.id);
  check("(3) description reports 3 connections granted after the session started", /3 connection\(s\) were granted to your agent after this session started/.test(desc));
  check("(3) description reports the 1 revoked-but-still-pinned connection", /1 connection\(s\) this session still holds are no longer granted/.test(desc));
  check("(3) description names the human re-pin route and a fresh session", desc.includes(`/api/sessions/${mgr.id}/repin-grants`) && /fresh session/.test(desc));
  check("(3) description never tells the agent that recycle/resume picks grants up", /does not change this/.test(desc) && !/recycle (to|and) (pick|use)/i.test(desc));
  const refused = await callAuth(mgr.id, c4);
  check("(4) a call to a not-yet-pinned connection is refused", refused.ok === false);
  check("(4) the refusal carries the grant-drift explanation", typeof refused.grantDrift === "string" && /3 connection\(s\) were granted/.test(refused.grantDrift));

  // The freeze: a recycle does NOT pick the grants up (pinned contract, unchanged).
  db.setBusy(mgr.id, false);
  const mgr2 = await svc.recycleManager(mgr.id, "CONTINUE");
  check("(5) recycle keeps the pinned 3 (freeze unchanged)", sorted(db.getSession(mgr2.id).connections) === sorted([c1, c2, c3]));
  check("(5) the recycled successor still gets the drift note", /3 connection\(s\) were granted/.test(await authDescription(mgr2.id)));

  // A human re-pin: additions arrive, the revoked one drops, the note goes away.
  const r = svc.repinSessionGrants(mgr2.id);
  check("(6) re-pin: the session now carries exactly the agent's CURRENT 5 grants", sorted(db.getSession(mgr2.id).connections) === sorted([c1, c2, c4, c5, c6]));
  check("(6) re-pin: the revoked connection is DROPPED", !db.getSession(mgr2.id).connections.includes(c3));
  check("(6) re-pin diff names the connections change", JSON.stringify(Object.keys(r.diff)) === JSON.stringify(["connections"]));
  check("(7) after the re-pin the drift note is gone", !/granted to your agent after|no longer granted/.test(await authDescription(mgr2.id)));
  fetched = null;
  const viaNew = await callAuth(mgr2.id, c6);
  check("(7) a call to a previously-missing connection now SUCCEEDS and dials that connection's own https URL", viaNew.ok === true && fetched === "https://plex.lan/x");
  fetched = null;
  const revokedCall = await callAuth(mgr2.id, c3);
  check("(8) a revoked connection is now refused and nothing is dialled", revokedCall.ok === false && fetched === null);

  // ---- drift counts only what THIS session could actually use ----
  db.insertProject({ id: "pB", name: "B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  const cB = createConnection(db, { name: "OtherProj", host: "otherproj.lan", authScheme: "bearer", secret: "sek-B", projectId: "pB" }).id;
  const cGone = mk("Gone");
  db.insertAgent({ id: "agentIso", projectId: "pP", name: "Iso", startupPrompt: "ISO", position: 1, profileId: "profMgr" });
  db.updateAgent("agentIso", { connections: [c1] });
  const iso = svc.startManager("agentIso", "GO");
  db.updateAgent("agentIso", { connections: [c1, cB, cGone] });
  db.deleteConnection(cGone); // granted, then deleted: metadata is gone
  const isoDesc = await authDescription(iso.id);
  check("(9) a connection scoped to ANOTHER project, and a granted-then-deleted one, add no drift (no note at all)", !/granted to your agent after|no longer granted/.test(isoDesc));
  check("(9) …and a refused call carries no grantDrift either", (await callAuth(iso.id, cB)).grantDrift === undefined);
  db.updateAgent("agentIso", { connections: [c1, cB, cGone, c2] });
  check("(9) polarity control: one genuinely usable new grant is counted as exactly 1, ignoring the other two", /1 connection\(s\) were granted to your agent after/.test(await authDescription(iso.id)));

  // ---- the ssh_exec path: same note on its description and on a refused call ----
  const mkSsh = (name) => createSshConnection(db, { name, host: `${name.toLowerCase()}.lan`, port: 22, user: "loom", privateKey: generateParseableEd25519(sshUtils).private, hostKeyFingerprint: "SHA256:" + "A".repeat(43) }).id;
  const [s1, s2] = [mkSsh("SshOne"), mkSsh("SshTwo")];
  db.insertAgent({ id: "agentSsh", projectId: "pP", name: "SshAgent", startupPrompt: "SSH", position: 2, profileId: "profMgr" });
  db.updateAgent("agentSsh", { connections: [s1] });
  const sshMgr = svc.startManager("agentSsh", "GO");
  const sshDesc = () => withClient(sshMgr.id, async (c) => (await c.listTools()).tools.find((t) => t.name === "ssh_exec")?.description ?? "");
  check("(10) ssh_exec is registered and carries no note before any drift", (await sshDesc()).includes("SshOne") && !/granted to your agent after/.test(await sshDesc()));
  db.updateAgent("agentSsh", { connections: [s1, s2] });
  const sd = await sshDesc();
  check("(10) ssh_exec's description reports the 1 ssh connection granted after spawn, naming the route", /1 connection\(s\) were granted to your agent after/.test(sd) && sd.includes(`/api/sessions/${sshMgr.id}/repin-grants`));
  check("(10) the note asks the owner OR MANAGER (a worker/auditor must not be told to address the human)", /ask your owner or manager to re-pin/.test(sd));
  const sshRefused = await withClient(sshMgr.id, async (c) => JSON.parse((await c.callTool({ name: "ssh_exec", arguments: { connectionId: s2, command: "uptime" } })).content[0].text));
  check("(10) an ssh_exec call to the not-yet-pinned connection is refused with the grantDrift explanation", sshRefused.ok === false && /1 connection\(s\) were granted/.test(sshRefused.grantDrift ?? ""));
} finally {
  db.close();
  cleanupPathSync(tmpHome);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
