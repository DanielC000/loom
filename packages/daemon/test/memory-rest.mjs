import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Memory read surface — GET /api/projects/:id/memory (card 7ea6ce71). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE: Db + buildServer via app.inject against two projects seeded with project_memory rows.
// Modeled on vault-raw.mjs (inject) + project-memory.mjs (db seeding). Proves the contract the /memory
// page reads:
//   (1) PROJECT-SCOPING — a project's memory read returns THIS project's entries ONLY, never another
//       project's (the one correctness thing the reviewer checks hard);
//   (2) SHAPE — each row carries pinned (bool) / retrievalCount (num) / updatedAt (str) / key/title/text;
//   (3) ORDER — pinned first, then most-recently-updated (db.listProjectMemory ordering);
//   (4) 404 on an unknown project; read-only (no write/forget counterpart on this path).
// Run after build: node test/memory-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-memory-rest-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45361";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const db = new Db(path.join(TMP, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "projA", name: "Project A", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "projB", name: "Project B", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

// Seed A: two pinned + two unpinned. Bump retrieval on one so retrievalCount surfaces non-zero.
db.upsertProjectMemory("projA", { key: "a-pinned-1", text: "A pinned one body", title: "A Pinned One", pinned: true }, 500);
db.upsertProjectMemory("projA", { key: "a-pinned-2", text: "A pinned two body", title: "A Pinned Two", pinned: true }, 500);
const aHot = db.upsertProjectMemory("projA", { key: "a-hot", text: "A hot unpinned body", title: "A Hot" }, 500);
db.upsertProjectMemory("projA", { key: "a-cold", text: "A cold unpinned body", title: "A Cold" }, 500);
db.touchProjectMemoryRetrieved([aHot.id, aHot.id, aHot.id]); // retrievalCount → 3

// Seed B with a DISTINCT key so a scope leak is unambiguous.
db.upsertProjectMemory("projB", { key: "b-secret-note", text: "B-only body — must never appear under A", title: "B Secret" }, 500);

const app = await buildApp(db);
const mem = (id) => app.inject({ method: "GET", url: `/api/projects/${id}/memory` });

try {
  const a = await mem("projA");
  check("(1) GET A/memory → 200", a.statusCode === 200);
  const aRows = a.json();
  check("(1) A returns exactly its 4 entries", Array.isArray(aRows) && aRows.length === 4);
  const aKeys = aRows.map((r) => r.key);
  check("(1) A includes its own keys", ["a-pinned-1", "a-pinned-2", "a-hot", "a-cold"].every((k) => aKeys.includes(k)));
  check("(1) PROJECT-SCOPING: A NEVER leaks B's entry", !aKeys.includes("b-secret-note"));
  check("(1) PROJECT-SCOPING: no A row carries projectId B", aRows.every((r) => r.projectId === "projA"));

  const b = await mem("projB");
  const bRows = b.json();
  check("(1) B returns ONLY its own single entry", b.statusCode === 200 && bRows.length === 1 && bRows[0].key === "b-secret-note");
  check("(1) PROJECT-SCOPING: B NEVER leaks any of A's entries", !bRows.some((r) => aKeys.includes(r.key)));

  // (2) shape — the fields the /memory page reads
  const hot = aRows.find((r) => r.key === "a-hot");
  check("(2) SHAPE: pinned is a boolean", typeof hot.pinned === "boolean" && hot.pinned === false);
  check("(2) SHAPE: retrievalCount is a number and reflects the 3 touches", typeof hot.retrievalCount === "number" && hot.retrievalCount === 3);
  check("(2) SHAPE: updatedAt is a non-empty string", typeof hot.updatedAt === "string" && hot.updatedAt.length > 0);
  check("(2) SHAPE: key/title/text present", typeof hot.key === "string" && typeof hot.title === "string" && typeof hot.text === "string");
  check("(2) SHAPE: content body is served for the detail view", hot.text === "A hot unpinned body");
  const pinnedRow = aRows.find((r) => r.key === "a-pinned-1");
  check("(2) SHAPE: a pinned row reports pinned:true", pinnedRow.pinned === true);

  // (3) order — pinned first (db.listProjectMemory: ORDER BY pinned DESC, updated_at DESC)
  const firstTwoPinned = aRows.slice(0, 2).every((r) => r.pinned === true);
  const lastTwoUnpinned = aRows.slice(2).every((r) => r.pinned === false);
  check("(3) ORDER: pinned entries sort ahead of unpinned", firstTwoPinned && lastTwoUnpinned);

  // (4) unknown project → 404
  check("(4) unknown project → 404", (await mem("nope")).statusCode === 404);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/projects/:id/memory is project-scoped (A never leaks B and vice-versa), returns the pinned/retrievalCount/updatedAt shape with note content, orders pinned-first, and 404s an unknown project."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
