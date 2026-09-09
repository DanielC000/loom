import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 23fde5f8 — tasks_list gains a `fields:[...]` param (mcp/server.ts, backed by the new
// `pickFields` helper in mcp/tasks.ts) so a caller who only needs a handful of columns doesn't pay for
// (or have to hand-derive) the other ~15. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// held-in-task-summary.mjs: a REAL Db + SessionService against a FAKE pty (PtyHost createPty() seam),
// the REAL TaskMcpRouter driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves the DoD line: "a test proving the un-asked-for fields are absent from the response, not
// merely absent from a spill file."
//   (A) small dataset, response stays INLINE: fields:["id","title"] returns rows whose ONLY keys are
//       id/title — every other TaskSummary key (columnKey, priority, deferredReason, held, ...) is
//       genuinely absent, not just omitted from a preview. The unprojected default read is used as a
//       positive control proving deferredReason DOES round-trip when not projected away.
//   (B) an unmatched/unknown field name is silently ignored (no error), never surfaces on the row.
//   (C) large dataset, the PROJECTED response itself is forced to SPILL to a scratch file (the
//       fields-narrowed response is still spilled) — read the actual spilled file content (not the
//       response envelope) and confirm every row there ALSO carries only the requested keys. This is
//       the "not merely absent from a spill file" half: the projection must hold in the artifact a
//       caller actually reads, whichever form the response takes.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-list-fields-projection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tlfp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-tlfp-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# tasks-list-fields-projection test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=tlfp@loom -c user.name=tlfp");

const now = new Date().toISOString();
const db = new Db();

const P = "fee1a234-0000-4000-8000-000000000001";
db.insertProject({ id: P, name: "FieldsProjection", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentM", projectId: P, name: "Manager", startupPrompt: "M", position: 0, profileId: null });
db.insertSession({ id: "M", projectId: P, agentId: "agentM", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only lists/reads tasks here

const ndjson = (res) => {
  const text = res.content[0].text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.rowsFile === "string") {
    return { rows: fs.readFileSync(parsed.rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)), spilled: true };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.rows)) return { rows: parsed.rows, spilled: false };
  return { rows: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)), spilled: false };
};
const byId = (rows, id) => rows.find((r) => r.id === id);

try {
  // ===================== (A)+(B): small dataset, inline response =====================
  const smallReasonBig = "R".repeat(6000);
  db.insertTask({ id: "t-a1", projectId: P, title: "fix(x): card one", body: "b", columnKey: "backlog", position: 0, priority: "p1", createdAt: now, updatedAt: now, held: false, deferred: true, deferredReason: smallReasonBig });
  db.insertTask({ id: "t-a2", projectId: P, title: "fix(x): card two", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now, held: true, heldBy: "human" });

  const server = new TaskMcpRouter(db, wakes).buildServer(P, "M");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tlfp", version: "0" });
  await client.connect(clientT);

  // Positive control: the UNPROJECTED default read carries deferredReason + other summary fields.
  const { rows: defaultRows } = ndjson(await client.callTool({ name: "tasks_list", arguments: {} }));
  check("(A) setup: default (unprojected) read returned both seeded cards", defaultRows.length === 2);
  check("(A) positive control: default read carries deferredReason with its real content",
    byId(defaultRows, "t-a1")?.deferredReason === smallReasonBig);
  check("(A) positive control: default read also carries columnKey/priority/held (the fields we'll later drop)",
    byId(defaultRows, "t-a1")?.columnKey === "backlog" && byId(defaultRows, "t-a1")?.priority === "p1" &&
    byId(defaultRows, "t-a2")?.held === true);

  // fields:["id","title"] — every OTHER summary key must be genuinely absent from every row.
  const { rows: projRows, spilled: projSpilled } = ndjson(await client.callTool({ name: "tasks_list", arguments: { fields: ["id", "title"] } }));
  check("(A) fields projection: still returns both cards", projRows.length === 2);
  check("(A) fields projection: response stayed inline (small enough not to need spill)", projSpilled === false);
  const keysOk = (row) => {
    const keys = Object.keys(row).sort();
    return keys.length === 2 && keys[0] === "id" && keys[1] === "title";
  };
  check("(A) fields projection: every row's key set is EXACTLY {id,title} — no columnKey/priority/held/deferredReason/etc",
    projRows.every(keysOk));
  check("(A) fields projection: id/title VALUES still correct (projection didn't corrupt content)",
    byId(projRows, "t-a1")?.title === "fix(x): card one" && byId(projRows, "t-a2")?.title === "fix(x): card two");

  // (B) an unmatched field name is silently ignored, never an error, never surfaces on the row.
  const { rows: typoRows } = ndjson(await client.callTool({ name: "tasks_list", arguments: { fields: ["id", "thisFieldDoesNotExist"] } }));
  check("(B) unknown field name: call succeeds (not an error) and still returns both cards", typoRows.length === 2);
  check("(B) unknown field name: rows carry ONLY the real field (id) — the bogus name never appears as a key",
    typoRows.every((r) => Object.keys(r).length === 1 && Object.keys(r)[0] === "id"));

  await client.close();

  // ===================== (C): large dataset, PROJECTED response forced to spill =====================
  const longTitle = "x".repeat(400);
  const BULK_COUNT = 150; // ~460 chars/row NDJSON'd => well past the 48,000-char inline budget even for {id,title} alone
  for (let i = 0; i < BULK_COUNT; i++) {
    db.insertTask({ id: `t-bulk-${String(i).padStart(4, "0")}`, projectId: P, title: longTitle, body: "b", columnKey: "backlog", position: 10 + i, priority: "p3", createdAt: now, updatedAt: now, held: false, deferred: false });
  }

  const server2 = new TaskMcpRouter(db, wakes).buildServer(P, "M");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await server2.connect(serverT2);
  const client2 = new Client({ name: "tlfp-bulk", version: "0" });
  await client2.connect(clientT2);

  const bulkRes = await client2.callTool({ name: "tasks_list", arguments: { fields: ["id", "title"], limit: BULK_COUNT + 10 } });
  const { rows: bulkRows, spilled: bulkSpilled } = ndjson(bulkRes);
  check("(C) setup: the projected bulk read actually spilled to a scratch file (proves this exercises the spill path, not just the inline one)", bulkSpilled === true);
  check("(C) setup: the SPILLED file returned all bulk rows", bulkRows.length === BULK_COUNT + 2);
  check("(C) spilled file content: EVERY row (read from the actual file on disk, not a preview) has ONLY {id,title} keys",
    bulkRows.every(keysOk));
  check("(C) spilled file content: title values are intact, not truncated/corrupted by projection",
    bulkRows.filter((r) => r.title === longTitle).length === BULK_COUNT);

  await client2.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list's fields:[...] projection genuinely drops un-asked-for keys from every row, inline and spilled alike, and silently ignores an unmatched field name."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
