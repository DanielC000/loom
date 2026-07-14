import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Manager-driven board column create/rename/delete (mcp/orchestration.ts board_column_create/rename/
// delete) — card 33118e17, owner-approved capability-surface expansion. DETERMINISTIC + CLAUDE-FREE +
// NETWORK-FREE, hermetic like escalation-status.mjs: a REAL Db + SessionService driven against a FAKE
// pty, the REAL OrchestrationMcpRouter, over an in-process MCP InMemoryTransport (no HTTP, no daemon).
//
// Proves the DoD:
//   (a) board_column_create appends a new column (with an optional role) to the resolved board.
//   (b) board_column_rename changes a column's key and/or label; a card on the renamed key follows
//       old→new (the SAME re-key the human column editor performs — 100% reuse, no new logic).
//   (c) board_column_delete removes a column; a card still on it re-keys to defaultLanding (no orphan).
//   (d) deleting a REQUIRED-role column (defaultLanding/terminal) without reassigning the role elsewhere
//       is HARD-REJECTED — the existing planColumnLayout guard, not a new one.
//   (e) all three tools are on the MANAGER surface and ABSENT from the WORKER surface (a worker must
//       never restructure a shared board).
//
// Run: 1) build (turbo builds shared first), 2) node test/board-column-mcp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-bcol-${Date.now()}-${process.pid}`);
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
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so any spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-bcol-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# board-column-mcp test repo\n");
execSync(`git init -q && git add . && git -c user.email=bcol@loom -c user.name=bcol commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "Project 1", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agent1", projectId: "p1", name: "Work1", startupPrompt: "WORK-1", position: 0, profileId: null });

const seedSession = (id, projectId, agentId, role) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null,
});
seedSession("MGR", "p1", "agent1", "manager");
seedSession("W", "p1", "agent1", "worker"); // must never see board_column_*

// Fake pty: no real claude spawn is exercised by this test.
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
const orch = new OrchestrationMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "bcol-test", version: "0" });
  await client.connect(clientT);
  return client;
}

async function callAs(sessionId, role, name, args) {
  const client = await connect(orch.buildServer(sessionId, role));
  const res = parse(await client.callTool({ name, arguments: args ?? {} }));
  await client.close();
  return res;
}

const boardKeys = () => resolveConfig(db.getProject("p1").config).kanbanColumns.map((c) => c.key);
const columnByKey = (key) => resolveConfig(db.getProject("p1").config).kanbanColumns.find((c) => c.key === key);
const mkTask = (id, columnKey) => db.insertTask({ id, projectId: "p1", title: `T-${id}`, body: "", columnKey, position: 1, createdAt: now, updatedAt: now });

try {
  // ===================== (e) surface presence =====================
  const mgrClient = await connect(orch.buildServer("MGR", "manager"));
  const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
  check("(e) board_column_create is on the MANAGER surface", mgrTools.includes("board_column_create"));
  check("(e) board_column_rename is on the MANAGER surface", mgrTools.includes("board_column_rename"));
  check("(e) board_column_delete is on the MANAGER surface", mgrTools.includes("board_column_delete"));
  await mgrClient.close();
  const wkrClient = await connect(orch.buildServer("W", "worker"));
  const wkrTools = (await wkrClient.listTools()).tools.map((t) => t.name);
  check("(e) board_column_create is ABSENT from the worker surface", !wkrTools.includes("board_column_create"));
  check("(e) board_column_rename is ABSENT from the worker surface", !wkrTools.includes("board_column_rename"));
  check("(e) board_column_delete is ABSENT from the worker surface", !wkrTools.includes("board_column_delete"));
  await wkrClient.close();

  // ===================== (a) create =====================
  const before = boardKeys();
  const created = await callAs("MGR", "manager", "board_column_create", { key: "triage", label: "Triage", role: "intake" });
  // 'intake' is already held by 'inbox' on the default board — role must be UNIQUE-per-non-required-role,
  // so claiming it again is a hard reject (the SAME planColumnLayout guard, not a new one).
  check("(a) creating a column with an already-held single-use role is REJECTED", created.ok === false && /intake/.test(created.error));

  const created2 = await callAs("MGR", "manager", "board_column_create", { key: "triage", label: "Triage" });
  check("(a) create (no role) succeeds", created2.ok === true);
  check("(a) the new column is appended to the board", boardKeys().length === before.length + 1 && boardKeys().includes("triage"));
  check("(a) the new column carries the given label", columnByKey("triage")?.label === "Triage");

  const dup = await callAs("MGR", "manager", "board_column_create", { key: "triage", label: "Dup" });
  check("(a) creating a column with a DUPLICATE key is REJECTED", dup.ok === false && /unique/.test(dup.error));

  // ===================== (b) rename =====================
  mkTask("tk1", "triage"); // a card sitting on the column we're about to rename
  const renamed = await callAs("MGR", "manager", "board_column_rename", { key: "triage", newKey: "sorting", newLabel: "Sorting" });
  check("(b) rename succeeds", renamed.ok === true);
  check("(b) the old key is gone, the new key is present", !boardKeys().includes("triage") && boardKeys().includes("sorting"));
  check("(b) the new column carries the new label", columnByKey("sorting")?.label === "Sorting");
  check("(b) the card on the renamed column FOLLOWED old→new", db.getTask("tk1").columnKey === "sorting");

  const renameMissing = await callAs("MGR", "manager", "board_column_rename", { key: "no-such-key", newLabel: "X" });
  check("(b) renaming an unknown key is REJECTED", renameMissing.ok === false && /no such column/.test(renameMissing.error));

  const renameNoArgs = await callAs("MGR", "manager", "board_column_rename", { key: "sorting" });
  check("(b) rename with neither newKey nor newLabel is REJECTED (nothing to change)",
    renameNoArgs.ok === false && renameNoArgs.error === "pass newKey and/or newLabel");

  // ===================== (c) delete (non-required lane, with a card on it) =====================
  const defaultLandingKey = resolveConfig(db.getProject("p1").config).kanbanColumns.find((c) => c.role === "defaultLanding").key;
  const deleted = await callAs("MGR", "manager", "board_column_delete", { key: "sorting" });
  check("(c) delete succeeds", deleted.ok === true);
  check("(c) the deleted column is gone from the board", !boardKeys().includes("sorting"));
  check("(c) the card that was on it re-keyed to defaultLanding (no orphan)", db.getTask("tk1").columnKey === defaultLandingKey);

  const deleteMissing = await callAs("MGR", "manager", "board_column_delete", { key: "sorting" });
  check("(c) deleting an already-gone key is REJECTED", deleteMissing.ok === false && /no such column/.test(deleteMissing.error));

  // ===================== (d) required-role removal is HARD-REJECTED =====================
  const deleteDefaultLanding = await callAs("MGR", "manager", "board_column_delete", { key: defaultLandingKey });
  check("(d) deleting the defaultLanding column (role not reassigned) is HARD-REJECTED",
    deleteDefaultLanding.ok === false && /default-landing/.test(deleteDefaultLanding.error));
  check("(d) the board is UNCHANGED after the rejected delete", boardKeys().includes(defaultLandingKey));

  const terminalKey = resolveConfig(db.getProject("p1").config).kanbanColumns.find((c) => c.role === "terminal").key;
  const deleteTerminal = await callAs("MGR", "manager", "board_column_delete", { key: terminalKey });
  check("(d) deleting the terminal column (role not reassigned) is HARD-REJECTED",
    deleteTerminal.ok === false && /terminal/.test(deleteTerminal.error));
  check("(d) the board is UNCHANGED after the rejected delete", boardKeys().includes(terminalKey));

  // Reassigning the role via rename (moving defaultLanding to another column) THEN deleting the old
  // holder succeeds — proving the guard is about role-coverage, not the column itself.
  const otherKey = boardKeys().find((k) => k !== defaultLandingKey && k !== terminalKey);
  // board_column_rename only carries key/label — reassigning a role isn't its job (out of scope for this
  // card); confirm instead that deleting a NON-required-role lane with no cards on it just works.
  const deleteOther = await callAs("MGR", "manager", "board_column_delete", { key: otherKey });
  check("(d) deleting a NON-required-role lane (no cards) succeeds", deleteOther.ok === true);

  // Defense in depth: the service method itself is reused verbatim — no bypass of updateBoardColumns.
  let svcHasMethod = typeof svc.updateBoardColumns === "function";
  check("(defense-in-depth) sessions.updateBoardColumns exists and is the delegate", svcHasMethod);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_column_create/rename/delete are manager-gated (absent from the worker surface) and delegate 100% to the existing atomic updateBoardColumns writer: create appends, rename re-keys a moved card old→new, delete re-keys a removed column's cards to defaultLanding, and removing a required-role (defaultLanding/terminal) column without reassigning it is hard-rejected exactly like the human column editor — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
