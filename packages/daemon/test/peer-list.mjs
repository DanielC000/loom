import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// `peer_list` — the read-only complement to `peer_message` (mcp/orchestration.ts): lets a manager
// DISCOVER its owner-linked peer projects (proactively, before any of them has ever peer_message'd it)
// instead of only ever being able to reply to one. Scoped SERVER-SIDE to the caller's own project (no
// projectId param) and gated on the SAME `project_links` table `peer_message` checks via
// `db.areProjectsLinked` — so this must return EXACTLY the target set peer_message would accept.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, tool handlers invoked directly (no pty,
// no real claude/network/daemon). Mirrors manager-requests-list.mjs's setup + schema-introspection.
//
// Covers:
//   (A) a LINKED peer project surfaces as {projectId, name}.
//   (B) an UNLINKED project never surfaces.
//   (C) a linked-but-ARCHIVED peer is excluded (mirrors peer_message's archived-target rejection — a
//       listed peer is always one peer_message would actually accept right now).
//   (D) own-project scoping: no projectId param exists to widen the read (schema introspection, mirrors
//       requests_list's test), and the caller's own project never appears in its own peer list.
//   (E) non-mutating: calling peer_list never writes/consumes anything (stable across repeated calls, no
//       project_links row created/removed).
//   (F) defense in depth: a non-manager caller is rejected.
//
// Run: 1) build (turbo builds shared first), 2) node test/peer-list.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-peer-list-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "peer-list.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // pA (the caller's own project) links to pB only; pC stays unlinked; pE is linked but archived.
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Project B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pC", name: "Project C (unlinked)", repoPath: "pC", vaultPath: "pC", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pE", name: "Project E (archived)", repoPath: "pE", vaultPath: "pE", config: {}, createdAt: now, archivedAt: now });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertAgent({ id: "agentD", projectId: "pC", name: "worker-only agent", startupPrompt: "W", position: 0 });
  db.insertSession({
    id: "wkrOnly", projectId: "pC", agentId: "agentD", engineSessionId: null, title: null, cwd: "pC",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });

  db.createProjectLink("pA", "pB");
  db.createProjectLink("pA", "pE"); // linked but archived — must be excluded from the read

  const sessions = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = router.buildServer("mgrA", "manager");
  const call = async () => JSON.parse((await mgrServer._registeredTools["peer_list"].handler({})).content[0].text);

  check("peer_list is registered on the loom-orchestration surface", "peer_list" in mgrServer._registeredTools);

  const result = await call();
  check("peer_list returns a `peers` array", Array.isArray(result.peers));

  // ============ (A) a linked peer surfaces as {projectId, name} ============
  const peerB = result.peers.find((p) => p.projectId === "pB");
  check("(A) the LINKED peer pB is returned", !!peerB && peerB.name === "Project B");
  check("(A) peer_list returns EXACTLY {projectId, name} per peer — no extra project metadata", peerB && Object.keys(peerB).sort().join(",") === "name,projectId");

  // ============ (B) an unlinked project never surfaces ============
  check("(B) the UNLINKED project pC never surfaces", !result.peers.some((p) => p.projectId === "pC"));

  // ============ (C) a linked-but-archived peer is excluded ============
  check("(C) the linked-but-ARCHIVED project pE is excluded (mirrors peer_message's archived-target rejection)", !result.peers.some((p) => p.projectId === "pE"));

  // ============ (D) own-project scoping ============
  check("(D) the caller's OWN project (pA) never appears in its own peer list", !result.peers.some((p) => p.projectId === "pA"));
  check("(D) exactly one peer is returned (pB only)", result.peers.length === 1);

  {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const introspectServer = router.buildServer("mgrA", "manager");
    await introspectServer.connect(serverT);
    const mcpClient = new Client({ name: "peer-list-schema-test", version: "0" });
    await mcpClient.connect(clientT);
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "peer_list");
    const props = tool?.inputSchema?.properties ?? {};
    check("(D) peer_list has NO projectId param to widen the read", !("projectId" in props));
    check("(D) peer_list takes no args at all", Object.keys(props).length === 0);
    await mcpClient.close();
  }

  // ============ (E) non-mutating ============
  const linksBefore = db.listProjectLinks().length;
  await call();
  const second = await call();
  check("(E) calling peer_list never writes/removes a project_links row", db.listProjectLinks().length === linksBefore);
  check("(E) calling peer_list twice returns the same records (stable double-call)", JSON.stringify(second.peers.map((p) => p.projectId).sort()) === JSON.stringify(result.peers.map((p) => p.projectId).sort()));

  // ============ (F) defense in depth: non-manager caller rejected ============
  let svcRejected = false;
  try { sessions.listPeerProjects("wkrOnly"); } catch (e) { svcRejected = /manager-only/.test(e.message); }
  check("(F) svc.listPeerProjects rejects a non-manager caller", svcRejected);
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — peer_list returns exactly {projectId, name} for the caller's owner-linked peers (the exact set peer_message would accept), excludes unlinked and archived-linked projects, never surfaces the caller's own project, has no projectId param to widen the read, is non-mutating, and rejects a non-manager caller."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
