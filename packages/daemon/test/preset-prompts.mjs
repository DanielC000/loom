import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Preset Prompts — the GLOBAL "terminal action-buttons" store + its human/UI REST CRUD. HERMETIC +
// CLAUDE-FREE + NETWORK-FREE, in the style of tasks-priority.mjs + agent-runs-rest.mjs:
//   • PART A — the Db methods directly against a throwaway SQLite db: create APPENDS ascending
//     positions, list is ORDERED by position, update round-trips label/prompt/position (and reorders),
//     delete removes + is idempotent, and a fresh create still appends at the end after deletes.
//   • PART B — the REST routes through the REAL buildServer driven by app.inject (every non-db dep
//     stubbed): the full CRUD round-trip create → list (ordered) → update (reorders) → delete, plus the
//     DoD edge cases — 404 (PUT unknown id) and 400 (missing/blank/oversized field; bad position type).
// Run: 1) build (turbo builds shared first), 2) node test/preset-prompts.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-presets-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45393";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

try {
  // ====================================================================================================
  // PART A — the Db methods directly
  // ====================================================================================================
  const db = new Db(path.join(tmpHome, "a.db"));
  check("A list is empty on a fresh store", db.listPresetPrompts().length === 0);

  const p1 = db.createPresetPrompt({ label: "Run tests", prompt: "Run the test suite." });
  const p2 = db.createPresetPrompt({ label: "Commit", prompt: "Commit and report SHA." });
  const p3 = db.createPresetPrompt({ label: "Status", prompt: "git status" });
  check("A create mints an id + timestamps", typeof p1.id === "string" && typeof p1.createdAt === "string" && typeof p1.updatedAt === "string");
  check("A create APPENDS ascending positions (0,1,2)", p1.position === 0 && p2.position === 1 && p3.position === 2);

  const listed = db.listPresetPrompts();
  check("A list returns every row", listed.length === 3);
  check("A list is ORDERED by position", listed[0].id === p1.id && listed[1].id === p2.id && listed[2].id === p3.id);

  db.updatePresetPrompt(p2.id, { label: "Commit & push", prompt: "Commit, push, report SHA." });
  const u = db.getPresetPrompt(p2.id);
  check("A update round-trips label+prompt", u.label === "Commit & push" && u.prompt === "Commit, push, report SHA.");
  check("A update leaves an untouched field (position) intact", u.position === 1);
  check("A update bumps updated_at", u.updatedAt >= p2.updatedAt);

  // reorder via a position patch → the list reflects the new order
  db.updatePresetPrompt(p3.id, { position: -1 });
  check("A list REORDERS by the updated position", db.listPresetPrompts()[0].id === p3.id);

  db.deletePresetPrompt(p1.id);
  check("A delete removes the row", db.getPresetPrompt(p1.id) === undefined && db.listPresetPrompts().length === 2);
  let delThrew = false;
  try { db.deletePresetPrompt(p1.id); } catch { delThrew = true; }
  check("A delete is idempotent on a missing id", !delThrew);

  // a fresh create still appends at the END (MAX(position)+1) even after deletes/reorders
  const maxBefore = db.listPresetPrompts().reduce((m, r) => Math.max(m, r.position), -Infinity);
  const p4 = db.createPresetPrompt({ label: "Build", prompt: "pnpm build" });
  check("A create still appends at the end after deletes (MAX+1)", p4.position === maxBefore + 1);
  db.close();

  // ====================================================================================================
  // PART B — the REST routes via the REAL buildServer (every non-db dep stubbed; app.inject, no network)
  // ====================================================================================================
  const dbB = new Db(path.join(tmpHome, "b.db"));
  const stub = {};
  const app = await buildServer({ db: dbB, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const empty = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B GET empty → 200 []", empty.statusCode === 200 && Array.isArray(empty.json()) && empty.json().length === 0);

  // create
  const c1 = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { label: "Run tests", prompt: "Run the suite." } });
  check("B POST → 201 with {id,label,prompt,position}",
    c1.statusCode === 201 && typeof c1.json().id === "string" && c1.json().label === "Run tests" && c1.json().prompt === "Run the suite." && c1.json().position === 0);
  const c2 = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { label: "Commit", prompt: "Commit." } });
  check("B second POST appends position 1", c2.statusCode === 201 && c2.json().position === 1);
  const id1 = c1.json().id, id2 = c2.json().id;
  check("B POST trims the label", c1.json().label === "Run tests");

  // list ordered
  const list = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B GET → ordered by position", list.statusCode === 200 && list.json().map((r) => r.id).join(",") === `${id1},${id2}`);

  // update (label + reorder by position)
  const upd = await app.inject({ method: "PUT", url: `/api/preset-prompts/${id1}`, payload: { label: "Run all tests", position: 5 } });
  check("B PUT → 200 with the patched row", upd.statusCode === 200 && upd.json().label === "Run all tests" && upd.json().position === 5);
  const afterUpd = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B PUT reorders (id1 now after id2)", afterUpd.json().map((r) => r.id).join(",") === `${id2},${id1}`);

  // delete + idempotent re-delete
  const del = await app.inject({ method: "DELETE", url: `/api/preset-prompts/${id1}` });
  check("B DELETE → 200 {ok:true}", del.statusCode === 200 && del.json().ok === true);
  const delAgain = await app.inject({ method: "DELETE", url: `/api/preset-prompts/${id1}` });
  check("B DELETE is idempotent → 200 {ok:true}", delAgain.statusCode === 200 && delAgain.json().ok === true);
  const afterDel = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B list after delete has only id2", afterDel.json().length === 1 && afterDel.json()[0].id === id2);

  // 404: PUT an unknown id
  const put404 = await app.inject({ method: "PUT", url: "/api/preset-prompts/does-not-exist", payload: { label: "x" } });
  check("B PUT unknown id → 404", put404.statusCode === 404);

  // 400: bad POST inputs (missing / blank / oversized)
  const noLabel = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { prompt: "p" } });
  check("B POST missing label → 400", noLabel.statusCode === 400);
  const blankLabel = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { label: "   ", prompt: "p" } });
  check("B POST blank label → 400", blankLabel.statusCode === 400);
  const noPrompt = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { label: "L" } });
  check("B POST missing prompt → 400", noPrompt.statusCode === 400);
  const tooLong = await app.inject({ method: "POST", url: "/api/preset-prompts", payload: { label: "x".repeat(5000), prompt: "p" } });
  check("B POST oversized label → 400", tooLong.statusCode === 400);
  // a rejected POST creates nothing
  const stillOne = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B rejected POSTs created nothing", stillOne.json().length === 1);

  // 400: bad PUT inputs (on an EXISTING id, so it's the validation that 400s — not the 404)
  const badPos = await app.inject({ method: "PUT", url: `/api/preset-prompts/${id2}`, payload: { position: "front" } });
  check("B PUT non-numeric position → 400", badPos.statusCode === 400);
  const blankUpd = await app.inject({ method: "PUT", url: `/api/preset-prompts/${id2}`, payload: { label: "" } });
  check("B PUT blank label → 400", blankUpd.statusCode === 400);
  // a rejected PUT changed nothing
  const unchanged = await app.inject({ method: "GET", url: "/api/preset-prompts" });
  check("B rejected PUTs changed nothing", unchanged.json()[0].id === id2 && unchanged.json()[0].label === "Commit");

  await app.close();
  dbB.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Preset Prompts: db create-appends/list-ordered/update-reorders/delete-idempotent, and the REST CRUD round-trip (create→list ordered→update→delete) with 404 (unknown id) + 400 (missing/blank/oversized/bad-position) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
