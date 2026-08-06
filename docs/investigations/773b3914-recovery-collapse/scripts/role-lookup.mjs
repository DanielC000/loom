// Card 773b3914 — resolves session role/project for a set of session ids via the read-only loom.db,
// anchored with createRequire at packages/daemon/package.json so better-sqlite3 resolves (this
// project's documented recipe for scripting against it outside the daemon process).
//
// Usage: node role-lookup.mjs <path-to-daemon-package.json> <path-to-tripwire_window.json>
import { createRequire } from "module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const daemonPkg = process.argv[2];
const winPath = process.argv[3];

const req = createRequire(daemonPkg);
const Database = req("better-sqlite3");

const dbPath = path.join(os.homedir(), ".loom", "loom.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const win = JSON.parse(fs.readFileSync(winPath, "utf8"));
const uniqueSessions = [...new Set(win.map(e => e.sessionId))];

const out = [];
for (const sid of uniqueSessions) {
  const row = db.prepare("SELECT id, project_id, role, parent_session_id FROM sessions WHERE id = ?").get(sid);
  if (!row) { out.push({ sessionId: sid, found: false }); continue; }
  const proj = db.prepare("SELECT name FROM projects WHERE id = ?").get(row.project_id);
  out.push({ sessionId: sid, found: true, role: row.role, project: proj ? proj.name : row.project_id, hasParent: !!row.parent_session_id });
}
console.log(JSON.stringify(out, null, 2));
