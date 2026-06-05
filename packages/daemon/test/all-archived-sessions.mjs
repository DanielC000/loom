// Cross-project Archive test (Task 526abd46). HERMETIC like session-archive.mjs: no daemon, no real
// claude — drives the built Db against a throwaway SQLite Db + an isolated LOOM_HOME. Covers the new
// db.listAllArchivedSessions() backing GET /api/archived-sessions:
//   A. spans ALL projects (per-project listArchivedSessions sees only its own; the all-variant merges).
//   B. returns ONLY archived rows (archived_at NOT NULL) — live/exited-but-not-archived are excluded.
//   C. newest-archived-FIRST globally (ORDER BY archived_at DESC), interleaving across projects.
//   D. each row is enriched with projectName + agentName (the cross-project grouping needs both).
// Run: 1) build the daemon, 2) node test/all-archived-sessions.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-all-archive-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const Database = (await import("better-sqlite3")).default;
const { Db } = await import("../dist/db.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();
const at = (ms) => new Date(Date.parse("2026-06-01T00:00:00.000Z") + ms).toISOString();
const mkSession = (id, projectId, agentId, over = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: "C:/tmp/loom-arch",
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

try {
  const db = new Db(dbFile);
  // Two projects, each with one agent.
  db.insertProject({ id: "pA", name: "Alpha", repoPath: "C:/tmp/a", vaultPath: "C:/tmp/a", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Beta", repoPath: "C:/tmp/b", vaultPath: "C:/tmp/b", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentAlpha", startupPrompt: "", position: 0 });
  db.insertAgent({ id: "aB", projectId: "pB", name: "agentBeta", startupPrompt: "", position: 0 });

  // Rows interleaved across projects, plus a non-archived row that must be excluded.
  db.insertSession(mkSession("a1", "pA", "aA", { role: "manager" }));
  db.insertSession(mkSession("b1", "pB", "aB", { role: "worker" }));
  db.insertSession(mkSession("a2", "pA", "aA", { role: "worker" }));
  db.insertSession(mkSession("live", "pA", "aA")); // stays archived_at NULL → excluded

  // insertSession doesn't write archived_at (it's set by the archive flow), so stamp controlled
  // instants directly to drive the cross-project DESC ordering — b1 newest, then a2, then a1.
  const raw = new Database(dbFile);
  const stamp = raw.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?");
  stamp.run(at(1000), "a1");
  stamp.run(at(3000), "b1");
  stamp.run(at(2000), "a2");
  raw.close();

  const all = db.listAllArchivedSessions();

  // A. spans all projects
  check("A: listAllArchivedSessions spans both projects (3 archived rows)", all.length === 3);
  check("A: includes rows from pA AND pB", all.some((s) => s.projectId === "pA") && all.some((s) => s.projectId === "pB"));
  // per-project variant still scopes to one project (sanity that we didn't break it)
  check("A: per-project listArchivedSessions(pA) sees only pA's 2", db.listArchivedSessions("pA").length === 2);

  // B. only archived rows
  check("B: the non-archived 'live' row is EXCLUDED", all.every((s) => s.id !== "live"));
  check("B: every returned row has archivedAt set", all.every((s) => !!s.archivedAt));

  // C. newest-archived first, globally interleaved across projects
  check("C: ordered archived_at DESC across projects (b1 → a2 → a1)",
    all.map((s) => s.id).join(",") === "b1,a2,a1");

  // D. enriched with project + agent names
  const b1 = all.find((s) => s.id === "b1");
  const a1 = all.find((s) => s.id === "a1");
  check("D: rows carry projectName", b1.projectName === "Beta" && a1.projectName === "Alpha");
  check("D: rows carry agentName", b1.agentName === "agentBeta" && a1.agentName === "agentAlpha");

  db.close();
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — listAllArchivedSessions spans all projects, returns only archived rows newest-first, enriched with project/agent names."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
