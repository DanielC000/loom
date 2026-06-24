import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board-column lifecycle test (task B). HERMETIC like tasks-filter.mjs: no daemon, no real claude —
// drives the built logic (dist/tasks/columns.js + dist/db.js + @loom/shared columnKeyForRole) against a
// throwaway SQLite Db. The HARD INVARIANT under test: no task may ever reference a non-existent column.
// Asserts the DoD:
//   (a) remove-with-cards → those cards land in the defaultLanding column (no orphan);
//   (b) rename-key → cards follow old→new;
//   (c) the migration backfills a legacy-keyed board to roles with ZERO card movement (+ one-shot marker);
//   (d) guards reject removing terminal/defaultLanding without reassignment + enforce the ≥1-column floor;
//   (e) NO orphan reachable by any op (incl. a pre-existing orphan swept on the next layout change).
// Run: 1) build daemon, 2) node test/column-lifecycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { planColumnLayout, backfillColumnRoles, COLUMN_ROLE_BACKFILL_KEY } from "../dist/tasks/columns.js";
import { resolveConfig, columnKeyForRole } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-column-lifecycle-${Date.now()}.db`);
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

const mkProject = (id, config) => db.insertProject({ id, name: id, repoPath: `C:/${id}`, vaultPath: `C:/${id}`, config, createdAt: now, archivedAt: null });
const mkTask = (id, projectId, columnKey) => db.insertTask({ id, projectId, title: `T-${id}`, body: "", columnKey, position: 1, createdAt: now, updatedAt: now });
const keysOf = (projectId) => db.listTasks(projectId).map((t) => t.columnKey);
const noOrphan = (projectId) => { const cols = new Set(resolveConfig(db.getProject(projectId)?.config).kanbanColumns.map((c) => c.key)); return db.listTasks(projectId).every((t) => cols.has(t.columnKey)); };

// The role-annotated default board (post-task-A): used as the starting layout for the lifecycle tests.
const DEFAULT = resolveConfig({}).kanbanColumns; // inbox/backlog/blocked/todo/in_progress/waiting/review/done

try {
  // === resolver fallbacks (legacy board with NO roles) ===
  const legacy = [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }];
  check("columnKeyForRole(terminal) → LAST column on a role-less board", columnKeyForRole(legacy, "terminal") === "c");
  check("columnKeyForRole(defaultLanding) → FIRST column on a role-less board", columnKeyForRole(legacy, "defaultLanding") === "a");
  check("columnKeyForRole(active) → undefined on a role-less board (no fallback)", columnKeyForRole(legacy, "active") === undefined);
  check("columnKeyForRole(terminal) → role match wins over last", columnKeyForRole([{ key: "x", label: "X", role: "terminal" }, { key: "y", label: "Y" }], "terminal") === "x");

  // === (a) remove a column WITH cards → its cards land in defaultLanding ===
  mkProject("pa", {});
  mkTask("a1", "pa", "review");   // a card in the column we'll remove
  mkTask("a2", "pa", "backlog");  // a card already in the defaultLanding column
  const removeReview = DEFAULT.filter((c) => c.key !== "review"); // drop the review lane (a non-required role)
  const ra = updateColumns("pa", removeReview);
  check("(a) remove-with-cards succeeds", ra.ok === true);
  check("(a) removing a role-bearing non-required lane WARNS (review)", !!ra.ok && ra.warnings.some((w) => w.includes("review")));
  check("(a) the removed lane's card moved to defaultLanding (backlog)", db.getTask("a1").columnKey === "backlog");
  check("(a) the defaultLanding card stayed put", db.getTask("a2").columnKey === "backlog");
  check("(a) no orphan after remove-with-cards", noOrphan("pa"));
  check("(a) 'review' is gone from the stored board", !resolveConfig(db.getProject("pa").config).kanbanColumns.some((c) => c.key === "review"));

  // === (b) rename a column KEY → cards follow old→new ===
  mkProject("pb", {});
  mkTask("b1", "pb", "todo");
  mkTask("b2", "pb", "in_progress");
  // Rename "todo" → "queued" (label-and-key) and "in_progress" → "doing", keeping roles.
  const renamed = DEFAULT.map((c) => {
    if (c.key === "todo") return { key: "queued", label: "Queued", role: c.role, prevKey: "todo" };
    if (c.key === "in_progress") return { key: "doing", label: "Doing", role: c.role, prevKey: "in_progress" };
    return c;
  });
  const rb = updateColumns("pb", renamed);
  check("(b) rename-key succeeds", rb.ok === true);
  check("(b) card on renamed 'todo' followed to 'queued'", db.getTask("b1").columnKey === "queued");
  check("(b) card on renamed 'in_progress' followed to 'doing'", db.getTask("b2").columnKey === "doing");
  check("(b) no orphan after rename", noOrphan("pb"));
  // A LABEL-ONLY edit (prevKey === key) migrates NO cards.
  mkProject("pb2", {});
  mkTask("bl", "pb2", "backlog");
  const labelOnly = DEFAULT.map((c) => (c.key === "backlog" ? { key: "backlog", label: "Renamed Backlog", role: c.role, prevKey: "backlog" } : c));
  updateColumns("pb2", labelOnly);
  check("(b) label-only edit moves no cards", db.getTask("bl").columnKey === "backlog");
  check("(b) label-only edit applied the new label", resolveConfig(db.getProject("pb2").config).kanbanColumns.find((c) => c.key === "backlog").label === "Renamed Backlog");

  // === (c) migration backfills a LEGACY board to roles with ZERO card movement ===
  // A legacy override (keys, NO roles) + an override-less project + a custom-key board (no legacy keys).
  mkProject("pc", { kanbanColumns: [
    { key: "backlog", label: "Backlog" }, { key: "todo", label: "To Do" },
    { key: "in_progress", label: "In Progress" }, { key: "done", label: "Done" },
  ] });
  mkProject("pc_default", {}); // override-less → inherits role-annotated defaults; migration must skip it
  mkProject("pc_custom", { kanbanColumns: [{ key: "ideas", label: "Ideas" }, { key: "shipped", label: "Shipped" }] });
  mkTask("c1", "pc", "backlog");
  mkTask("c2", "pc", "todo");
  mkTask("c3", "pc", "done");
  const before = keysOf("pc").sort();
  const mig = backfillColumnRoles(db);
  check("(c) migration reports ≥1 project migrated", mig.migrated >= 1);
  const pcCols = db.getProject("pc").config.kanbanColumns;
  const roleOf = (k) => pcCols.find((c) => c.key === k)?.role;
  check("(c) backlog → defaultLanding", roleOf("backlog") === "defaultLanding");
  check("(c) todo → workReady", roleOf("todo") === "workReady");
  check("(c) in_progress → active", roleOf("in_progress") === "active");
  check("(c) done → terminal", roleOf("done") === "terminal");
  check("(c) ZERO card movement (columnKeys unchanged)", JSON.stringify(keysOf("pc").sort()) === JSON.stringify(before));
  check("(c) override-less project left untouched (no stored kanbanColumns)", db.getProject("pc_default").config.kanbanColumns === undefined);
  const custom = db.getProject("pc_custom").config.kanbanColumns;
  check("(c) custom board gets defaultLanding on FIRST column", custom[0].role === "defaultLanding");
  check("(c) custom board gets terminal on LAST column", custom[custom.length - 1].role === "terminal");
  // One-shot: marker set, re-run no-ops.
  check("(c) one-shot marker is set after migration", !!db.getMeta(COLUMN_ROLE_BACKFILL_KEY));
  const mig2 = backfillColumnRoles(db);
  check("(c) re-run is a no-op (marker-guarded)", mig2.migrated === 0);

  // === (d) guards ===
  // Remove the terminal column (done) WITHOUT reassigning the role → reject.
  const dropTerminal = DEFAULT.filter((c) => c.key !== "done");
  check("(d) reject removing the terminal column without reassignment",
    planColumnLayout(DEFAULT, dropTerminal).ok === false);
  // Remove the defaultLanding column (backlog) WITHOUT reassigning → reject.
  const dropLanding = DEFAULT.filter((c) => c.key !== "backlog");
  check("(d) reject removing the defaultLanding column without reassignment",
    planColumnLayout(DEFAULT, dropLanding).ok === false);
  // ≥1-column floor.
  check("(d) reject an empty board (≥1-column floor)", planColumnLayout(DEFAULT, []).ok === false);
  // Duplicate / missing required roles.
  check("(d) reject two defaultLanding columns",
    planColumnLayout(DEFAULT, [{ key: "x", label: "X", role: "defaultLanding" }, { key: "y", label: "Y", role: "defaultLanding" }, { key: "z", label: "Z", role: "terminal" }]).ok === false);
  // WITH reassignment it's allowed: move terminal onto 'review', then remove 'done'.
  mkProject("pd", {});
  mkTask("d1", "pd", "done");
  const reassignThenRemove = DEFAULT
    .filter((c) => c.key !== "done")
    .map((c) => (c.key === "review" ? { ...c, role: "terminal" } : c));
  const rd = updateColumns("pd", reassignThenRemove);
  check("(d) removing terminal WITH reassignment to another column succeeds", rd.ok === true);
  check("(d) the old terminal card swept to defaultLanding (backlog)", db.getTask("d1").columnKey === "backlog");
  check("(d) no orphan after reassign-then-remove", noOrphan("pd"));
  check("(d) bad rename source (prevKey not a current column) is rejected",
    planColumnLayout(DEFAULT, DEFAULT.map((c) => (c.key === "backlog" ? { ...c, prevKey: "nope" } : c))).ok === false);

  // === (f) accentColor + wipLimit round-trip through planColumnLayout (the new optional KanbanColumn fields) ===
  // Set on a desired column → present on the output column; survive a rename (prevKey carries them); an
  // ABSENT field stays absent (no undefined-injection — JSON.stringify of an undefined value DROPS the key,
  // so an explicit `'wipLimit' in col` check distinguishes absent from `undefined`).
  const fPlan = planColumnLayout(DEFAULT, DEFAULT.map((c) =>
    c.key === "todo" ? { key: "todo", label: "To Do", role: c.role, accentColor: "#6b8afd", wipLimit: 3 } : c));
  check("(f) plan succeeds with accentColor + wipLimit set", fPlan.ok === true);
  const fTodo = fPlan.columns.find((c) => c.key === "todo");
  check("(f) accentColor round-trips onto the output column", fTodo.accentColor === "#6b8afd");
  check("(f) wipLimit round-trips onto the output column", fTodo.wipLimit === 3);
  const fBacklog = fPlan.columns.find((c) => c.key === "backlog");
  check("(f) an ABSENT accentColor stays absent (no undefined-injection)", !("accentColor" in fBacklog));
  check("(f) an ABSENT wipLimit stays absent (no undefined-injection)", !("wipLimit" in fBacklog));
  // The fields survive a KEY RENAME (prevKey present): rename todo→queued carrying both.
  const fRename = planColumnLayout(DEFAULT, DEFAULT.map((c) =>
    c.key === "todo" ? { key: "queued", label: "Queued", role: c.role, prevKey: "todo", accentColor: "#ff0066", wipLimit: 5 } : c));
  check("(f) rename plan succeeds carrying the new fields", fRename.ok === true);
  const fQueued = fRename.columns.find((c) => c.key === "queued");
  check("(f) accentColor survives a rename (prevKey)", fQueued.accentColor === "#ff0066");
  check("(f) wipLimit survives a rename (prevKey)", fQueued.wipLimit === 5);
  // End-to-end DB persistence: the serialized config JSON keeps both fields after applyBoardColumnLayout.
  mkProject("pf", {});
  const pfDesired = DEFAULT.map((c) =>
    c.key === "in_progress" ? { key: "in_progress", label: "In Progress", role: c.role, accentColor: "#00cc88", wipLimit: 2 } : c);
  const rf = updateColumns("pf", pfDesired);
  check("(f) DB write succeeds with the new fields", rf.ok === true);
  const pfStored = resolveConfig(db.getProject("pf").config).kanbanColumns.find((c) => c.key === "in_progress");
  check("(f) accentColor persisted through the DB write path", pfStored.accentColor === "#00cc88");
  check("(f) wipLimit persisted through the DB write path", pfStored.wipLimit === 2);
  const pfBacklog = resolveConfig(db.getProject("pf").config).kanbanColumns.find((c) => c.key === "backlog");
  check("(f) an untouched column carries NO accentColor after the DB round-trip", !("accentColor" in pfBacklog));

  // === (e) the invariant: a PRE-EXISTING orphan is swept on the next layout change ===
  mkProject("pe", {});
  mkTask("e1", "pe", "ghost"); // a card on a key that is NOT in any column (data-state orphan)
  check("(e) precondition: the ghost card IS an orphan", !noOrphan("pe"));
  // Any benign layout change (here: relabel inbox) must sweep the orphan → defaultLanding.
  const relabel = DEFAULT.map((c) => (c.key === "inbox" ? { ...c, label: "Intake" } : c));
  const re = updateColumns("pe", relabel);
  check("(e) layout change succeeds despite a pre-existing orphan", re.ok === true);
  check("(e) the orphan was swept to defaultLanding (backlog)", db.getTask("e1").columnKey === "backlog");
  check("(e) NO orphan reachable after the op", noOrphan("pe"));
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — column lifecycle is atomic + orphan-free: remove-with-cards lands cards in defaultLanding, rename-key follows cards old→new, the migration backfills legacy boards to roles with zero card movement (one-shot), guards reject removing terminal/defaultLanding without reassignment + the ≥1-column floor, and no op (incl. a pre-existing orphan) can leave a task on a non-existent column."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
