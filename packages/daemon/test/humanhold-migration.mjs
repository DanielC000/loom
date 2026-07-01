import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board Hold Model migration test (migrateHumanHoldToHeld, tasks/columns.ts). NO claude, NO daemon —
// a REAL Db driven directly. Hermetic like column-lifecycle.mjs: each run gets its own temp LOOM_HOME.
//
// Proves:
//   (1) a project with an EXPLICIT kanbanColumns override carrying a humanHold-role column: every card on
//       it is promoted held=true and moved to workReady (fallback defaultLanding), and the humanHold
//       column is dropped from the stored override.
//   (2) an override-LESS project (inherits the new PLATFORM_DEFAULTS, which has no humanHold column) whose
//       tasks table still has a legacy card sitting on the old default's `blocked` key: it is migrated the
//       same way (held=true + moved), with NO config rewrite (nothing was stored to rewrite).
//   (3) an override-less project with NO legacy `blocked` cards is left untouched (a genuine no-op).
//   (4) an override-based project whose humanHold column carries ZERO cards still has the column DROPPED.
//   (5) idempotency: a second run is a clean no-op (returns {projectsMigrated:0, cardsMigrated:0}) and
//       does not re-touch anything.
//   (6) an override-based board whose `blocked` column carries NO role annotation at all (a never-
//       backfilled home — role-matching alone can't find it) is STILL matched by the legacy KEY, so its
//       card is promoted + the column dropped, exactly like (1).
//
// Run: 1) build (turbo builds shared first), 2) node test/humanhold-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-hhm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { migrateHumanHoldToHeld } = await import("../dist/tasks/columns.js");

const now = new Date().toISOString();
const db = new Db();

try {
  // ===== (1) explicit override carrying a humanHold-role column =====
  db.insertProject({
    id: "pOverride", name: "Override", repoPath: "/tmp/pOverride", vaultPath: "/tmp/pOverride",
    createdAt: now, archivedAt: null,
    config: { kanbanColumns: [
      { key: "backlog", label: "Backlog", role: "defaultLanding" },
      { key: "todo", label: "To Do", role: "workReady" },
      { key: "gated", label: "Gated (Human)", role: "humanHold" },
      { key: "done", label: "Done", role: "terminal" },
    ] },
  });
  const t1 = randomUUID();
  db.insertTask({ id: t1, projectId: "pOverride", title: "gated card", body: "", columnKey: "gated", position: 1, createdAt: now, updatedAt: now });

  // ===== (2) override-less project with a legacy card on the old default's "blocked" key =====
  db.insertProject({ id: "pLegacy", name: "Legacy", repoPath: "/tmp/pLegacy", vaultPath: "/tmp/pLegacy", config: {}, createdAt: now, archivedAt: null });
  const t2 = randomUUID();
  db.insertTask({ id: t2, projectId: "pLegacy", title: "legacy blocked card", body: "", columnKey: "blocked", position: 1, createdAt: now, updatedAt: now });

  // ===== (3) override-less project with NO legacy blocked cards — a genuine no-op =====
  db.insertProject({ id: "pClean", name: "Clean", repoPath: "/tmp/pClean", vaultPath: "/tmp/pClean", config: {}, createdAt: now, archivedAt: null });
  const t3 = randomUUID();
  db.insertTask({ id: t3, projectId: "pClean", title: "ordinary card", body: "", columnKey: "backlog", position: 1, createdAt: now, updatedAt: now });

  // ===== (4) override-based humanHold column with ZERO cards on it — still dropped =====
  db.insertProject({
    id: "pEmptyGate", name: "EmptyGate", repoPath: "/tmp/pEmptyGate", vaultPath: "/tmp/pEmptyGate",
    createdAt: now, archivedAt: null,
    config: { kanbanColumns: [
      { key: "backlog", label: "Backlog", role: "defaultLanding" },
      { key: "gated", label: "Gated (Human)", role: "humanHold" },
      { key: "done", label: "Done", role: "terminal" },
    ] },
  });

  // ===== (6) override-based board, `blocked` column with NO role annotation (never-backfilled home) =====
  db.insertProject({
    id: "pRoleless", name: "Roleless", repoPath: "/tmp/pRoleless", vaultPath: "/tmp/pRoleless",
    createdAt: now, archivedAt: null,
    config: { kanbanColumns: [
      { key: "backlog", label: "Backlog", role: "defaultLanding" },
      { key: "todo", label: "To Do", role: "workReady" },
      { key: "blocked", label: "Blocked" }, // NO role — the legacy pre-backfill shape
      { key: "done", label: "Done", role: "terminal" },
    ] },
  });
  const t6 = randomUUID();
  db.insertTask({ id: t6, projectId: "pRoleless", title: "roleless blocked card", body: "", columnKey: "blocked", position: 1, createdAt: now, updatedAt: now });

  const r1 = migrateHumanHoldToHeld(db);
  // pOverride + pLegacy + pEmptyGate + pRoleless are touched; pClean is a genuine no-op (asserted below).
  check("(migrate) reports 4 project(s) touched, 3 card(s) promoted", r1.projectsMigrated === 4 && r1.cardsMigrated === 3);

  // --- (1) assertions ---
  const p1 = db.getTask(t1);
  check("(1) the gated card is held=true", p1.held === true);
  check("(1) the gated card moved to workReady ('todo')", p1.columnKey === "todo");
  const cfg1 = db.getProject("pOverride").config.kanbanColumns;
  check("(1) the humanHold column ('gated') is dropped from the stored override", !cfg1.some((c) => c.key === "gated"));
  check("(1) the other columns survive untouched", cfg1.some((c) => c.key === "backlog") && cfg1.some((c) => c.key === "todo") && cfg1.some((c) => c.key === "done"));

  // --- (2) assertions ---
  const p2 = db.getTask(t2);
  check("(2) the override-less legacy 'blocked' card is held=true", p2.held === true);
  check("(2) it moved to the (new-default) workReady lane ('todo')", p2.columnKey === "todo");
  check("(2) no kanbanColumns override was written for the override-less project", db.getProject("pLegacy").config.kanbanColumns === undefined);

  // --- (3) assertions ---
  const p3 = db.getTask(t3);
  check("(3) an untouched card stays exactly as it was", p3.held === false && p3.columnKey === "backlog");
  check("(3) no config override was written for the clean project", db.getProject("pClean").config.kanbanColumns === undefined);

  // --- (4) assertions ---
  const cfg4 = db.getProject("pEmptyGate").config.kanbanColumns;
  check("(4) a humanHold column with zero cards is still dropped", !cfg4.some((c) => c.key === "gated"));

  // --- (6) assertions ---
  const p6 = db.getTask(t6);
  check("(6) the roleless 'blocked'-keyed card is held=true (matched by KEY, not role)", p6.held === true);
  check("(6) it moved to workReady ('todo')", p6.columnKey === "todo");
  const cfg6 = db.getProject("pRoleless").config.kanbanColumns;
  check("(6) the roleless 'blocked' column is dropped from the stored override", !cfg6.some((c) => c.key === "blocked"));
  check("(6) the other columns survive untouched", cfg6.some((c) => c.key === "backlog") && cfg6.some((c) => c.key === "todo") && cfg6.some((c) => c.key === "done"));

  // --- (5) idempotency ---
  const r2 = migrateHumanHoldToHeld(db);
  check("(5) a second run is a clean no-op (marker guard)", r2.projectsMigrated === 0 && r2.cardsMigrated === 0);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — migrateHumanHoldToHeld promotes humanHold-column cards to held + moves them to workReady, drops the humanHold column (override-based, override-less/legacy-key, and roleless-legacy-key alike, even with zero cards), leaves untouched projects alone, and is idempotent — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
