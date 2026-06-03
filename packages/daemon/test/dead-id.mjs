// Dead-ID detection test (§12-Q5). Hermetic: uses an isolated LOOM_HOME so it never
// touches the real dev DB. Seeds a session whose engine transcript does NOT exist on disk,
// runs the sweep, asserts it flips to resumability:"dead".
// Run: 1) build the daemon, 2) node test/dead-id.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-deadid-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { sweepDeadSessions } = await import("../dist/sessions/liveness.js");

const db = new Db();
const now = new Date().toISOString();
db.insertProject({ id: "pX", name: "X", repoPath: "C:/tmp/loom-x", vaultPath: "C:/tmp/loom-x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "tX", projectId: "pX", name: "t", startupPrompt: "", position: 0 });
db.insertSession({
  id: "sDead", projectId: "pX", agentId: "tX",
  engineSessionId: "bogus-id-no-transcript-12345", title: null, cwd: "C:/tmp/loom-x",
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null,
});

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  check("seeded session starts 'resumable'", db.getSession("sDead").resumability === "resumable");
  const marked = sweepDeadSessions(db);
  check("sweep marked exactly 1 session dead", marked === 1);
  check("session whose engine transcript is missing is now 'dead'", db.getSession("sDead").resumability === "dead");
  check("idempotent: a second sweep marks 0", sweepDeadSessions(db) === 0);
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nALL PASS — dead-ID detection flips unresumable sessions to dead (§12-Q5)." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
