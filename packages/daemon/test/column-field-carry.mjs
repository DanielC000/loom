import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board-column field-carry contract (card 654869e2). HERMETIC like column-lifecycle.mjs: no daemon, no
// real claude — drives the built planner (dist/tasks/columns.js) + a throwaway SQLite Db.
//
// WHAT THIS PINS, and why it matters to a CLIENT: the atomic layout change is CARRY-WHAT-YOU-ARE-GIVEN.
// `planColumnLayout` copies a KanbanColumn field onto the stored column only when the DesiredColumn
// actually carried it (`!== undefined`), and the PUT replaces the WHOLE array — so omitting a field is
// indistinguishable from asking for it to be removed. Any editor that rebuilds the layout from its own
// state MUST therefore round-trip every field it does not model, or one unrelated edit strips that field
// from every column.
//
// Not hypothetical: packages/web's ColumnManager enumerated the fields it knew about, and had no control
// for (and zero references to) `excludeFromIdleWatchdog`, which only the manager-side board_column_* MCP
// tools write. A human renaming any column therefore silently cleared it, re-arming the idle watcher /
// pending-request gate / wake-impact on a lane deliberately marked a dead end. The web fix round-trips
// the unmodelled remainder (packages/web/src/lib/columnDesired.ts); THIS test pins the daemon-side
// asymmetry that makes such a round-trip obligatory, so it can never silently flip to "preserve the
// stored value on omit" and leave that client code looking pointless.
//
// Run: node packages/daemon/scripts/test-daemon.mjs --only=column-field-carry --concurrency=1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { planColumnLayout } from "../dist/tasks/columns.js";
import { resolveConfig } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-column-field-carry-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

// Mirror SessionService.updateBoardColumns: plan (pure) then execute (one atomic transaction).
function updateColumns(projectId, desired) {
  const current = resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
  const plan = planColumnLayout(current, desired);
  if (!plan.ok) return { ok: false, error: plan.error };
  db.applyBoardColumnLayout(projectId, plan.columns, plan.rekeys, plan.defaultLandingKey);
  return { ok: true, columns: plan.columns, warnings: plan.warnings };
}
const colsOf = (projectId) => resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
const colOf = (projectId, key) => colsOf(projectId).find((c) => c.key === key);
const mkProject = (id) => db.insertProject({ id, name: id, repoPath: `C:/${id}`, vaultPath: `C:/${id}`, config: {}, createdAt: now, archivedAt: null });

// A minimal three-lane board carrying every optional KanbanColumn field on its middle (parked) lane.
const LAYOUT = [
  { key: "todo", label: "To do", role: "defaultLanding" },
  { key: "dropped", label: "Dropped", role: "parked", accentColor: "#6b8afd", wipLimit: 3, excludeFromIdleWatchdog: true },
  { key: "done", label: "Done", role: "terminal" },
];

try {
  // === the field is STORED when the desired entry carries it ===
  mkProject("p1");
  const seed = updateColumns("p1", LAYOUT);
  check("seed layout applies", seed.ok === true);
  const dropped = colOf("p1", "dropped");
  check("excludeFromIdleWatchdog is stored when SENT", dropped?.excludeFromIdleWatchdog === true);
  check("accentColor is stored when SENT", dropped?.accentColor === "#6b8afd");
  check("wipLimit is stored when SENT", dropped?.wipLimit === 3);

  // === THE ASYMMETRY: omitting the field on a LATER layout change DROPS it ===
  // Exactly what a field-enumerating client sends to rename one lane: key/label/role only.
  const renameOnly = colsOf("p1").map((c) => ({ key: c.key, label: c.key === "todo" ? "Backlog" : c.label, role: c.role }));
  const after = updateColumns("p1", renameOnly);
  check("the rename-only layout applies", after.ok === true);
  check("the renamed lane took the new label", colOf("p1", "todo")?.label === "Backlog");
  check("OMITTING excludeFromIdleWatchdog DROPS it (carry-what-you-are-given)", colOf("p1", "dropped")?.excludeFromIdleWatchdog === undefined);
  check("OMITTING accentColor DROPS it too (same rule, same direction)", colOf("p1", "dropped")?.accentColor === undefined);
  check("OMITTING wipLimit DROPS it too", colOf("p1", "dropped")?.wipLimit === undefined);

  // === and ROUND-TRIPPING it survives the identical rename (what the fixed client now sends) ===
  mkProject("p2");
  updateColumns("p2", LAYOUT);
  const roundTripped = colsOf("p2").map((c) => (c.key === "todo" ? { ...c, label: "Backlog" } : { ...c }));
  const kept = updateColumns("p2", roundTripped);
  check("the round-tripping layout applies", kept.ok === true);
  check("ROUND-TRIPPED excludeFromIdleWatchdog survives the rename", colOf("p2", "dropped")?.excludeFromIdleWatchdog === true);
  check("ROUND-TRIPPED accentColor survives", colOf("p2", "dropped")?.accentColor === "#6b8afd");
  check("ROUND-TRIPPED wipLimit survives", colOf("p2", "dropped")?.wipLimit === 3);
  check("the rename still landed alongside the preserved fields", colOf("p2", "todo")?.label === "Backlog");

  // === an explicit FALSE is stored as false, not collapsed to absent ===
  // `false` and absent resolve the same to today's consumers, but the planner distinguishes them, so a
  // client must not rewrite one into the other.
  mkProject("p3");
  updateColumns("p3", LAYOUT.map((c) => (c.key === "dropped" ? { ...c, excludeFromIdleWatchdog: false } : c)));
  const p3 = colOf("p3", "dropped");
  check("an explicit false is stored as false", p3?.excludeFromIdleWatchdog === false);
  check("...and is PRESENT on the stored column, not absent", p3 !== undefined && "excludeFromIdleWatchdog" in p3);

  // === the field survives a KEY RENAME when round-tripped, and its cards follow ===
  mkProject("p4");
  updateColumns("p4", LAYOUT);
  db.insertTask({ id: "t1", projectId: "p4", title: "T-t1", body: "", columnKey: "dropped", position: 1, createdAt: now, updatedAt: now });
  const rekeyed = colsOf("p4").map((c) => (c.key === "dropped" ? { ...c, key: "abandoned", prevKey: "dropped" } : { ...c }));
  const rk = updateColumns("p4", rekeyed);
  check("the key-rename layout applies", rk.ok === true);
  check("excludeFromIdleWatchdog survives a KEY rename when round-tripped", colOf("p4", "abandoned")?.excludeFromIdleWatchdog === true);
  check("prevKey is STRIPPED from the stored column (it is a request-only field)", !("prevKey" in (colOf("p4", "abandoned") ?? {})));
  check("the renamed lane's card followed old to new", db.getTask("t1").columnKey === "abandoned");
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the atomic column layout change is CARRY-WHAT-YOU-ARE-GIVEN: a KanbanColumn field is stored only when the request carried it, omitting it DROPS it (excludeFromIdleWatchdog / accentColor / wipLimit alike), an explicit false is kept as false, and a round-tripped field survives both a label edit and a key rename (cards following old to new). Any client that rebuilds the whole layout must round-trip the fields it does not model."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
