#!/usr/bin/env node
// Build a {sessionId: {role, parent, createdAt}} map from a COPY of loom.db (never the live file --
// the daemon holds it open; copy loom.db (+ -wal/-shm if present) to a scratch dir first).
//
// better-sqlite3 must be resolved from packages/daemon's own node_modules (bare ESM resolution walks up
// from THIS file's location, not cwd) -- createRequire anchored at the daemon package.json handles that
// regardless of where this script itself lives.
//
// Usage: node query-session-roles.mjs <path-to-daemon-package-dir> <path-to-copied-loom.db> <out.json>
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const [daemonPkgDir, dbPath, outPath] = process.argv.slice(2);
if (!daemonPkgDir || !dbPath || !outPath) {
  console.error('usage: node query-session-roles.mjs <path-to-packages/daemon> <copied-loom.db> <out.json>');
  process.exit(1);
}

const require = createRequire(path.join(daemonPkgDir, 'package.json'));
const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare('SELECT id, role, parent_session_id, created_at FROM sessions').all();
const roleCounts = {};
for (const r of rows) roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
console.log('session count:', rows.length);
console.log('role counts:', JSON.stringify(roleCounts));

const map = {};
for (const r of rows) map[r.id] = { role: r.role, parent: r.parent_session_id, createdAt: r.created_at };
fs.writeFileSync(outPath, JSON.stringify(map));
console.log('wrote', outPath);
