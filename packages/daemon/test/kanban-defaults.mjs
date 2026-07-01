// Kanban-defaults test: the PLATFORM default kanban column set (and its invariants) via resolveConfig.
// Hermetic: imports the built resolveConfig from @loom/shared (dist), NO daemon, NO real claude, NO db.
// Guards the exact default order AND the structural invariants the daemon relies on (create-default
// lane, terminal lane, the idle-watcher's `todo` count, the `inbox` intake lane at index 0). Board Hold
// Model redesign: the `blocked` column / `humanHold` role is retired from the shipped default — `held`
// is the sole human brake now, so a fresh project's default board carries no such lane at all.
import "./_guard.mjs";
const { resolveConfig } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// resolveConfig({}) — an EMPTY (override-less) project: it must inherit the platform defaults.
const cols = resolveConfig({}).kanbanColumns;
const keys = cols.map((c) => c.key);

// --- exact default order ---------------------------------------------------------------------------
const EXPECTED = ["inbox", "backlog", "todo", "in_progress", "waiting", "review", "done"];
check(`default order is ${EXPECTED.join(" · ")}`, JSON.stringify(keys) === JSON.stringify(EXPECTED));
check("no default column carries the retired humanHold role",
  !cols.some((c) => c.role === "humanHold"));
check("no default column is keyed 'blocked' (the retired brake lane)",
  !keys.includes("blocked"));

// --- structural invariants (the daemon relies on each) ---------------------------------------------
check("index 0 key === 'inbox' (the owner intake lane, non-terminal)", keys[0] === "inbox");
check("'backlog' (the create-default lane) is at index 1, immediately after inbox", keys[1] === "backlog");
check("last key === 'done' (terminal)", keys[keys.length - 1] === "done");
check("includes 'todo' (the idle-watcher counts it)", keys.includes("todo"));
check("'todo' is at index 2 (immediately after backlog — the blocked lane no longer sits between them)", keys[2] === "todo");

// A project WITH its own override keeps it — resolveConfig only changes the default branch.
const overridden = resolveConfig({ kanbanColumns: [{ key: "x", label: "X" }] }).kanbanColumns;
check("an explicit kanbanColumns override is preserved (not the default)",
  overridden.length === 1 && overridden[0].key === "x");

console.log(failures === 0
  ? "\n✅ ALL PASS — override-less projects inherit the 7-column platform default (inbox · backlog · todo · in_progress · waiting · review · done) with inbox the first (owner intake) lane and NO blocked/humanHold lane; first=inbox, last=done, backlog (create-default) + todo present; an explicit override still wins."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
