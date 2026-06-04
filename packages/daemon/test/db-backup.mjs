// Automatic DB backup test. HERMETIC like tasks-priority.mjs / worktrees.mjs: NO daemon, NO real
// claude, NO ~/.loom, NO port 4317. Everything runs against a throwaway temp dir + temp SQLite DB
// that this test creates and cleans up. takeBackup/rotateBackups are ALWAYS given explicit
// srcDbPath/destDir, so the prod DB_PATH / ~/.loom/backups default is NEVER used — prod is untouchable.
//
// Asserts:
//   (1) RESTORE-VERIFY (the core DoD): seed a temp DB, take an ONLINE backup WHILE the writer is still
//       open (data still in the WAL — the exact incident scenario), open the snapshot as a fresh
//       SQLite DB, and assert row counts match. Proves the backup captures committed WAL'd data the
//       main file may not yet hold, and that the snapshot is a valid, complete DB.
//   (2) ROTATION keeps only the newest `keep` loom-*.db by mtime, prunes older, and NEVER touches a
//       non-loom file (the manual-backup safety guarantee).
//   (3) Best-effort: an injected failing dest returns null and does NOT throw (daemon-survives proof);
//       a non-existent source is a silent skip (null).
//   (4) The periodic DbBackupWatcher.tick() produces a snapshot when enabled, and is a no-op when
//       disabled / interval 0.
//   (5) Windows-safe filename: no ":" in the snapshot name.
//
// The boot + pre-restart triggers are thin wrappers that call takeBackup({reason}) — covered by (1).
// Run: 1) build daemon, 2) node test/db-backup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { takeBackup, rotateBackups, snapshotFilename, DbBackupWatcher } from "../dist/orchestration/db-backup.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Our OWN brand-new temp dir — never ~/.loom. All artifacts (DB + backups) live under here.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-db-backup-"));
const dbFile = path.join(root, "loom.db");
const destDir = path.join(root, "backups", "auto");
const now = new Date().toISOString();

const rowCount = (file, table) => {
  const c = new Database(file, { readonly: true });
  try { return c.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { c.close(); }
};

try {
  // --- seed a temp DB and KEEP the writer open (data sits in the WAL) -------------------------------
  const db = new Db(dbFile);
  db.insertProject({ id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "projB", name: "Beta", repoPath: "C:/b", vaultPath: "C:/b", config: {}, createdAt: now, archivedAt: null });
  for (let i = 0; i < 5; i++) {
    db.insertTask({ id: `t${i}`, projectId: "projA", title: `Task ${i}`, body: "", columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now });
  }
  const liveProjects = db.listProjects().length;
  const liveTasks = db.listTasks("projA").length;
  check("seeded 2 projects + 5 tasks in the live DB", liveProjects === 2 && liveTasks === 5);

  // (1) RESTORE-VERIFY — online backup while the writer is STILL OPEN (WAL'd data must be captured).
  const dest = await takeBackup({ reason: "test-restore", keep: 48, srcDbPath: dbFile, destDir, now: new Date() });
  check("takeBackup returned a snapshot path", typeof dest === "string");
  check("snapshot file exists on disk", dest && fs.existsSync(dest));
  check("snapshot opens as a valid SQLite DB with matching projects count", dest && rowCount(dest, "projects") === 2);
  check("snapshot contains the WAL'd tasks (row counts match the live DB)", dest && rowCount(dest, "tasks") === 5);

  // (5) Windows-safe filename — no ":" anywhere.
  check("snapshot filename has no ':' (Windows-safe)", dest && !path.basename(dest).includes(":"));
  check("snapshotFilename sanitizes the ISO ':'", !snapshotFilename(new Date("2026-06-04T12:34:56.789Z")).includes(":"));

  db.close();

  // (2) ROTATION — drop keep+3 dummy loom-*.db files with distinct mtimes + a NON-loom file, rotate,
  // assert only the newest `keep` loom files survive and the non-loom file is untouched.
  const rotDir = path.join(root, "rot");
  fs.mkdirSync(rotDir, { recursive: true });
  const keep = 3;
  const made = [];
  for (let i = 0; i < keep + 3; i++) {
    const f = path.join(rotDir, `loom-2026-06-04T00-00-0${i}.000Z.db`);
    fs.writeFileSync(f, `snapshot ${i}`);
    // mtime ascending with i ⇒ higher i = newer. base + i seconds.
    const t = new Date(2026, 5, 4, 0, 0, i);
    fs.utimesSync(f, t, t);
    made.push(f);
  }
  const sentinel = path.join(rotDir, "pre-manual-keepme.db.txt"); // non-loom-*.db ⇒ must survive
  fs.writeFileSync(sentinel, "do not delete");
  // also a file that looks like a manual backup but isn't a loom-*.db
  const manualish = path.join(rotDir, "backup-old.db");
  fs.writeFileSync(manualish, "manual");

  rotateBackups(rotDir, keep);
  const survivors = fs.readdirSync(rotDir).filter((n) => /^loom-.*\.db$/.test(n)).sort();
  check("rotation kept exactly `keep` loom snapshots", survivors.length === keep);
  // newest keep are the highest-index files (i = 3,4,5).
  check("rotation kept the NEWEST snapshots (by mtime), pruned the oldest",
    survivors.every((n) => ["loom-2026-06-04T00-00-03.000Z.db", "loom-2026-06-04T00-00-04.000Z.db", "loom-2026-06-04T00-00-05.000Z.db"].includes(n)));
  check("rotation NEVER touched the non-loom sentinel file", fs.existsSync(sentinel));
  check("rotation NEVER touched a non-'loom-' .db file", fs.existsSync(manualish));

  // (3) BEST-EFFORT — a failing dest must return null and NOT throw (daemon-survives). Inject failure by
  // making the dest dir path a regular FILE, so mkdirSync(dir,{recursive}) throws ENOTDIR internally.
  const badParent = path.join(root, "blocked");
  fs.writeFileSync(badParent, "i am a file, not a dir");
  const badDest = path.join(badParent, "auto"); // mkdir under a file ⇒ fails
  let threw = false;
  let badResult = "unset";
  try { badResult = await takeBackup({ reason: "test-fail", keep: 48, srcDbPath: dbFile, destDir: badDest, now: new Date() }); }
  catch { threw = true; }
  check("a failing backup dest does NOT throw (best-effort)", !threw);
  check("a failing backup returns null (logged + continue)", badResult === null);

  // non-existent source ⇒ silent skip (null), no throw.
  let skipResult = "unset";
  try { skipResult = await takeBackup({ reason: "test-missing", keep: 48, srcDbPath: path.join(root, "does-not-exist.db"), destDir, now: new Date() }); }
  catch { threw = true; }
  check("a missing source DB is a silent skip (null), no throw", skipResult === null && !threw);

  // (4) PERIODIC WATCHER — tick() snapshots when enabled; no-op when disabled / interval 0.
  const watchDir = path.join(root, "watch");
  const enabledWatcher = new DbBackupWatcher({ enabled: true, intervalMinutes: 60, keep: 48, srcDbPath: dbFile, destDir: watchDir });
  const tickPath = await enabledWatcher.tick(new Date());
  check("enabled watcher.tick() produced a snapshot", typeof tickPath === "string" && fs.existsSync(tickPath));
  check("watcher snapshot is a valid DB (projects present)", tickPath && rowCount(tickPath, "projects") === 2);

  const disabledWatcher = new DbBackupWatcher({ enabled: false, intervalMinutes: 60, keep: 48, srcDbPath: dbFile, destDir: path.join(root, "nope1") });
  check("disabled watcher.tick() is a no-op (null)", (await disabledWatcher.tick(new Date())) === null);
  const zeroWatcher = new DbBackupWatcher({ enabled: true, intervalMinutes: 0, keep: 48, srcDbPath: dbFile, destDir: path.join(root, "nope2") });
  check("interval-0 watcher.tick() is a no-op (null)", (await zeroWatcher.tick(new Date())) === null);
  check("no-op watchers wrote nothing", !fs.existsSync(path.join(root, "nope1")) && !fs.existsSync(path.join(root, "nope2")));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — online backup captures WAL'd data into a valid snapshot (restore-verify), rotation keeps newest-N loom-*.db and spares non-loom files, failures are best-effort no-throws, and the periodic watcher snapshots when enabled / no-ops when off."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
