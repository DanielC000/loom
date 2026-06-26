import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Config-PATCH column re-key — orphan guard (P1 ORPHAN — close a bypassed safe-path asymmetry).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + the REAL Platform router (in-process MCP,
// like project-config-patch.mjs) + the REAL Fastify gateway (app.inject, like platform-home-rest.mjs).
//
// The bug: BOTH config-PATCH surfaces — the platform `project_configure` MCP tool AND the REST
// `PATCH /api/projects/:id/config` — wrote kanbanColumns BLIND (db.setProjectConfig) with NO card re-key.
// The ONLY safe path (planColumnLayout → applyBoardColumnLayout, the column editor's PUT) re-keys cards;
// these bypassed it. So renaming/removing a column ORPHANED every card on the old key (Board filters
// strictly → invisible), violating columns.ts's hard invariant "no task references a non-existent column".
// The fix routes BOTH surfaces through the safe writer (setProjectConfigSafe): a key-set change re-keys the
// affected cards to the resolved defaultLanding lane; a non-column / same-key-set patch stays on the blind path.
//
// Proves (asserting NO card is EVER left on a non-existent column):
//   (1) PLATFORM project_configure that DROPS a column holding a card → the card is re-keyed to the landing
//       lane, NOT orphaned; the new columns are stored exactly;
//   (2) REST PATCH that drops/renames a column holding a card → same: card re-keyed, no orphan;
//   (3) a same-key-set patch (label-only edit) leaves cards untouched and applies the new label (blind path);
//   (4) an empty-board patch is REJECTED with the stored config left UNCHANGED (no orphan-by-wipe).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-config-column-orphan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveConfig, columnKeyForRole } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-cfgorphan-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45319";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

// Fake pty (the router's constructor needs a SessionService; no tool here spawns).
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "cfgorphan-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

// "No orphan" = every card sits on a column key that exists in the project's resolved board.
const noOrphan = (projectId) => {
  const keys = new Set(resolveConfig(db.getProject(projectId).config).kanbanColumns.map((c) => c.key));
  return db.listTasks(projectId).every((t) => keys.has(t.columnKey));
};

const stub = {};
let app;
try {
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer());
  app = await buildServer({ db, pty: stub, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

  // The default board's resolved defaultLanding lane — the catch-all the safe writer re-keys orphans to.
  const landing = columnKeyForRole(resolveConfig({}).kanbanColumns, "defaultLanding"); // "backlog" by default

  // ===================== (1) PLATFORM project_configure that DROPS a column with a card =====================
  db.insertProject({ id: "pA", name: "A", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const cardA = randomUUID();
  db.insertTask({ id: cardA, projectId: "pA", title: "on review", body: "", columnKey: "review", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  // PATCH to a 2-column board — DROPS "review" (and the rest). The card on "review" must NOT orphan.
  const newBoardA = [{ key: "backlog", label: "Backlog", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }];
  const resA = await platform("project_configure", { projectId: "pA", config: { kanbanColumns: newBoardA } });
  check("(1) platform project_configure (column drop) accepted", resA.ok === true && !resA.error);
  check("(1) the new columns are stored exactly", JSON.stringify(db.getProject("pA").config.kanbanColumns) === JSON.stringify(newBoardA));
  check("(1) ★ the card on the dropped 'review' column was RE-KEYED to the landing lane (not orphaned)",
    db.getTask(cardA).columnKey === landing);
  check("(1) ★ NO card is left on a non-existent column", noOrphan("pA"));

  // ===================== (2) REST PATCH that drops/renames a column with a card =====================
  db.insertProject({ id: "pB", name: "B", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const cardB = randomUUID();
  db.insertTask({ id: cardB, projectId: "pB", title: "on todo", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  // The REST PATCH replaces the whole override (no merge). A blind PATCH has no prevKey, so renaming "todo"
  // → "doing" reads as drop-todo + add-doing: the card on "todo" lands in the landing lane (no orphan).
  const newBoardB = resolveConfig({}).kanbanColumns.map((c) => (c.key === "todo" ? { ...c, key: "doing", label: "Doing" } : c));
  const r2 = await app.inject({ method: "PATCH", url: "/api/projects/pB/config", payload: { config: { kanbanColumns: newBoardB } } });
  check("(2) REST PATCH (column rename) → 200", r2.statusCode === 200);
  check("(2) 'todo' is gone from the stored board, 'doing' is present",
    !resolveConfig(db.getProject("pB").config).kanbanColumns.some((c) => c.key === "todo")
    && resolveConfig(db.getProject("pB").config).kanbanColumns.some((c) => c.key === "doing"));
  check("(2) ★ the card on the renamed-away 'todo' column was RE-KEYED to the landing lane (not orphaned)",
    db.getTask(cardB).columnKey === landing);
  check("(2) ★ NO card is left on a non-existent column", noOrphan("pB"));

  // ===================== (3) a same-key-set patch (label edit) leaves cards untouched (blind path) =====================
  db.insertProject({ id: "pC", name: "C", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const cardC = randomUUID();
  db.insertTask({ id: cardC, projectId: "pC", title: "on review", body: "", columnKey: "review", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const relabeled = resolveConfig({}).kanbanColumns.map((c) => (c.key === "review" ? { ...c, label: "In Review" } : c));
  const r3 = await platform("project_configure", { projectId: "pC", config: { kanbanColumns: relabeled } });
  check("(3) a label-only (same key set) patch accepted", r3.ok === true && !r3.error);
  check("(3) the card stayed on its 'review' column (no re-key on a same-key-set patch)", db.getTask(cardC).columnKey === "review");
  check("(3) the new label applied", resolveConfig(db.getProject("pC").config).kanbanColumns.find((c) => c.key === "review").label === "In Review");
  check("(3) NO card orphaned", noOrphan("pC"));

  // ===================== (4) an empty-board patch is REJECTED, config UNCHANGED =====================
  db.insertProject({ id: "pD", name: "D", repoPath: tmpHome, vaultPath: tmpHome,
    config: { kanbanColumns: [{ key: "todo", label: "Todo", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }] },
    createdAt: now, archivedAt: null, reserved: false });
  const cardD = randomUUID();
  db.insertTask({ id: cardD, projectId: "pD", title: "on todo", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const r4 = await platform("project_configure", { projectId: "pD", config: { kanbanColumns: [] } });
  check("(4) an empty-board patch is REJECTED", typeof r4.error === "string" && !r4.ok);
  check("(4) the stored board is UNCHANGED after the rejected empty patch",
    db.getProject("pD").config.kanbanColumns.length === 2 && db.getTask(cardD).columnKey === "todo");
  check("(4) NO card orphaned", noOrphan("pD"));
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — BOTH config-PATCH surfaces (platform project_configure + REST PATCH) route a kanbanColumns key-set change through the safe writer: a dropped/renamed column re-keys its cards to the landing lane (never orphaning them on a non-existent column), a same-key-set patch stays on the blind path, and an empty board is rejected with the config unchanged — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
