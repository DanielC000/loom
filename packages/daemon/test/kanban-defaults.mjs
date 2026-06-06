// Kanban-defaults test: the PLATFORM default kanban column set (and its invariants) — so an
// override-less project inherits the human-hold lane via resolveConfig. Hermetic: imports the built
// resolveConfig from @loom/shared (dist), NO daemon, NO real claude, NO db. Guards the exact default
// order AND the structural invariants the daemon relies on (create-default lane, terminal lane, the
// idle-watcher's `todo` count, and the new `blocked` sitting immediately after backlog).
import "./_guard.mjs";
const { resolveConfig } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// resolveConfig({}) — an EMPTY (override-less) project: it must inherit the platform defaults.
const cols = resolveConfig({}).kanbanColumns;
const keys = cols.map((c) => c.key);

// --- exact default order ---------------------------------------------------------------------------
const EXPECTED = ["backlog", "blocked", "todo", "in_progress", "waiting", "review", "done"];
check(`default order is ${EXPECTED.join(" · ")}`, JSON.stringify(keys) === JSON.stringify(EXPECTED));
check("blocked carries the 'Blocked (Human)' label",
  cols.some((c) => c.key === "blocked" && c.label === "Blocked (Human)"));

// --- structural invariants (the daemon relies on each) ---------------------------------------------
check("index 0 key === 'backlog' (the create-default lane)", keys[0] === "backlog");
check("last key === 'done' (terminal)", keys[keys.length - 1] === "done");
check("includes 'todo' (the idle-watcher counts it)", keys.includes("todo"));
check("'blocked' is at index 1 (immediately after backlog, before todo)", keys[1] === "blocked");

// A project WITH its own override keeps it — resolveConfig only changes the default branch.
const overridden = resolveConfig({ kanbanColumns: [{ key: "x", label: "X" }] }).kanbanColumns;
check("an explicit kanbanColumns override is preserved (not the default)",
  overridden.length === 1 && overridden[0].key === "x");

console.log(failures === 0
  ? "\n✅ ALL PASS — override-less projects inherit the 7-column platform default (backlog · blocked · todo · in_progress · waiting · review · done) with blocked immediately after backlog; first=backlog, last=done, todo present; an explicit override still wins."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
