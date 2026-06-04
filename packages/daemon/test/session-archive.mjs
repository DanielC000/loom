// Per-project session Archive test (Task 13abd3ba). HERMETIC like dead-id.mjs / tasks-filter.mjs:
// no daemon, no real claude — drives the built Db + SessionService archive logic and the transcript
// snapshot helpers against a throwaway SQLite Db + an isolated LOOM_HOME. Covers:
//   A. migration adds sessions.archived_at without disturbing rows (idempotent).
//   B. archive cascades a manager → its workers; archived rows are EXCLUDED from the live lists
//      (listSessions/listAllSessions/listWorkers) and surface via listArchivedSessions.
//   C. a LIVE group member BLOCKS the archive ("stop the fleet first").
//   D. snapshotTranscript copies the engine JSONL (idempotent), readArchivedTranscript renders it,
//      an already-dead session (no JSONL) snapshots nothing, deleteArchivedTranscript removes it.
//   E. restore brings one row back; permanent delete cascades + drops the snapshot.
// Run: 1) build the daemon, 2) node test/session-archive.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-archive-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const Database = (await import("better-sqlite3")).default;
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const {
  encodeProjectDir, snapshotTranscript, readArchivedTranscript,
  archivedTranscriptPath, archivedTranscriptExists, deleteArchivedTranscript,
} = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();
const mkSession = (id, over = {}) => ({
  id, projectId: "pA", agentId: "aA", engineSessionId: null, title: null, cwd: "C:/tmp/loom-arch",
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

// ── ~/.claude transcript fixtures for the snapshot test (unique cwd → unique encoded dir) ──
const fakeCwd = path.join(os.tmpdir(), `loom-arch-cwd-${Date.now()}`);
const engineId = `arch-engine-${Date.now()}`;
const claudeDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fakeCwd));
const claudeFile = path.join(claudeDir, `${engineId}.jsonl`);

try {
  // ════════ A. migration ════════
  let db = new Db(dbFile);
  db.insertProject({ id: "pA", name: "Arch", repoPath: "C:/tmp/loom-arch", vaultPath: "C:/tmp/loom-arch", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentA", startupPrompt: "", position: 0 });
  db.insertSession(mkSession("sMig"));
  const colsAfterFresh = new Database(dbFile).pragma("table_info(sessions)").map((c) => c.name);
  check("A: fresh schema has sessions.archived_at", colsAfterFresh.includes("archived_at"));
  check("A: a new session archivedAt is null", db.getSession("sMig").archivedAt === null);
  db.close();

  // Simulate a LEGACY DB (column absent), then reopen → migrateSessions must ADD it back, row intact.
  const raw = new Database(dbFile);
  raw.exec("ALTER TABLE sessions DROP COLUMN archived_at");
  check("A: legacy DB lacks archived_at before migration",
    !raw.pragma("table_info(sessions)").map((c) => c.name).includes("archived_at"));
  raw.close();
  db = new Db(dbFile); // triggers migrateSessions
  check("A: migration re-added archived_at",
    new Database(dbFile).pragma("table_info(sessions)").map((c) => c.name).includes("archived_at"));
  check("A: migration preserved the existing row", !!db.getSession("sMig") && db.getSession("sMig").archivedAt === null);
  db.close();
  db = new Db(dbFile); // reopen again — migration is idempotent (no throw)
  check("A: migration is idempotent (second open ok)", !!db.getSession("sMig"));

  const sessions = new SessionService(db, {}, {});

  // ════════ B. cascade archive + exclusion + listArchivedSessions ════════
  db.insertSession(mkSession("mgr", { role: "manager" }));
  db.insertSession(mkSession("w1", { role: "worker", parentSessionId: "mgr", taskId: "t1", branch: "loom/w1" }));
  db.insertSession(mkSession("w2", { role: "worker", parentSessionId: "mgr", taskId: "t2", branch: "loom/w2" }));
  db.insertSession(mkSession("plain")); // unrelated exited session — must stay in the rail

  check("B: listWorkers(mgr) sees both workers pre-archive", db.listWorkers("mgr").length === 2);
  check("B: listAllSessions includes the group pre-archive",
    db.listAllSessions().filter((s) => ["mgr", "w1", "w2"].includes(s.id)).length === 3);

  const res = sessions.archiveSession("mgr");
  check("B: archiveSession(mgr) cascades to its workers (3 archived)",
    res.archived.length === 3 && ["mgr", "w1", "w2"].every((id) => res.archived.includes(id)));
  check("B: archived group EXCLUDED from listAllSessions (only 'plain' + 'sMig' remain of ours)",
    db.listAllSessions().every((s) => !["mgr", "w1", "w2"].includes(s.id)));
  check("B: 'plain' still visible in the rail", db.listAllSessions().some((s) => s.id === "plain"));
  check("B: listSessions(agent) excludes archived", db.listSessions("aA").every((s) => !["mgr", "w1", "w2"].includes(s.id)));
  check("B: listWorkers(mgr) now empty (workers archived)", db.listWorkers("mgr").length === 0);
  const arch = db.listArchivedSessions("pA");
  check("B: listArchivedSessions returns the 3 archived (with agent name)",
    arch.length === 3 && arch.every((s) => s.agentName === "agentA") && arch.every((s) => !!s.archivedAt));
  check("B: idempotent — re-archiving an archived session is a no-op", sessions.archiveSession("mgr").archived.length === 0);

  // ════════ C. live group BLOCKS the archive ════════
  db.insertSession(mkSession("mgrLive", { role: "manager" }));
  db.insertSession(mkSession("wLive", { role: "worker", parentSessionId: "mgrLive", processState: "live" }));
  let blocked = false;
  try { sessions.archiveSession("mgrLive"); } catch (e) { blocked = /stop the fleet first/.test(e.message); }
  check("C: archiving a manager with a LIVE worker is blocked", blocked);
  check("C: nothing was archived (manager still in the rail)", db.listAllSessions().some((s) => s.id === "mgrLive"));
  let liveBlocked = false;
  try { sessions.archiveSession("wLive"); } catch (e) { liveBlocked = /stop the fleet first/.test(e.message); }
  check("C: archiving a LIVE session directly is blocked", liveBlocked);

  // ════════ D. snapshot helpers ════════
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(claudeFile,
    '{"type":"user","message":{"content":"hello"}}\n' +
    '{"type":"system","message":{"content":"ignored"}}\n' +
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n');
  const okSnap = snapshotTranscript(fakeCwd, engineId, "pA", "snapSess");
  check("D: snapshotTranscript returns true when the JSONL exists", okSnap === true);
  check("D: snapshot file written under LOOM_HOME/archives", fs.existsSync(archivedTranscriptPath("pA", "snapSess")));
  check("D: archivedTranscriptExists(pA, snapSess) is true", archivedTranscriptExists("pA", "snapSess"));
  const turns = readArchivedTranscript("pA", "snapSess");
  check("D: readArchivedTranscript parses 2 turns (system line skipped)",
    turns.length === 2 && turns[0].role === "user" && turns[0].text === "hello" && turns[1].role === "assistant" && turns[1].text === "hi there");
  check("D: snapshot is idempotent (re-snapshot still true)", snapshotTranscript(fakeCwd, engineId, "pA", "snapSess") === true);
  check("D: already-dead session (no JSONL) snapshots nothing",
    snapshotTranscript(fakeCwd, "no-such-engine-id", "pA", "deadSess") === false && !archivedTranscriptExists("pA", "deadSess"));
  deleteArchivedTranscript("pA", "snapSess");
  check("D: deleteArchivedTranscript removes the snapshot", !archivedTranscriptExists("pA", "snapSess"));

  // ════════ E. restore + permanent delete (cascade, snapshot dropped) ════════
  // Give the manager + w2 real snapshots so delete proves it removes them.
  snapshotTranscript(fakeCwd, engineId, "pA", "mgr");
  snapshotTranscript(fakeCwd, engineId, "pA", "w2");
  check("E: seeded snapshots for mgr + w2", archivedTranscriptExists("pA", "mgr") && archivedTranscriptExists("pA", "w2"));

  sessions.restoreSession("w1");
  check("E: restore brings w1 back to the rail", db.getSession("w1").archivedAt === null && db.listWorkers("mgr").some((w) => w.id === "w1"));

  let notArchived = false;
  try { sessions.deleteArchivedSession("w1"); } catch (e) { notArchived = /only an archived session/.test(e.message); }
  check("E: deleting a non-archived session is refused", notArchived);

  const delRes = sessions.deleteArchivedSession("mgr");
  check("E: delete cascades to ARCHIVED workers only (mgr + w2, not the restored w1)",
    delRes.deleted.includes("mgr") && delRes.deleted.includes("w2") && !delRes.deleted.includes("w1") && delRes.deleted.length === 2);
  check("E: deleted rows are gone", !db.getSession("mgr") && !db.getSession("w2"));
  check("E: restored w1 row survives the manager delete", !!db.getSession("w1"));
  check("E: deleted snapshots removed", !archivedTranscriptExists("pA", "mgr") && !archivedTranscriptExists("pA", "w2"));
} finally {
  try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessions.archived_at migrates cleanly; archive cascades + excludes from the live lists; a live group is blocked; transcript snapshots copy/render/delete; restore + cascade delete work."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
