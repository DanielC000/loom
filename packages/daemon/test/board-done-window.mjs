// Board done-lane window test (card a483cbec — the opt-in `?doneLimit=N` on GET /api/projects/:id/board;
// see docs/decisions/a483cbec-board-done-lane-window.md). HERMETIC: no daemon, no real claude — builds the
// REAL gateway (dist/gateway/server.js) over a throwaway SQLite Db in a temp LOOM_HOME and drives it with
// app.inject.
//
// Covers:
//   A. THE DEFAULT IS BYTE-IDENTICAL. The no-param response is compared against the pre-change handler
//      expression recomputed in this test from the same built modules the route uses. That expression is
//      pinned to commit 2ff0e2eb (`packages/daemon/src/gateway/server.ts`, the board route body:
//      `{ columns: cols, tasks: toBoardTasks(tasks, terminalKey, boardRollup(deps.db, p.id, tasks)) }`)
//      and transcribed here rather than read from git at test time — a `git show HEAD:` snapshot pins to
//      whatever HEAD happens to be and so can never fail once the change itself is HEAD (lesson 250).
//      Asserted on the serialized bytes, so a new response KEY (not just a new value) fails it too.
//   B. THE WINDOW. ?doneLimit=N returns exactly the N most-recently-done cards, in byRecentlyDone order,
//      and leaves every live lane whole.
//   C. THE TRUE TOTAL. `doneTotal` is the lane's real length, not the window's, and `doneLimit` echoes
//      the EFFECTIVE post-parse window.
//   D. A RENAMED TERMINAL LANE. The window follows the terminal ROLE, not a lane named "done" — a board
//      whose terminal lane is keyed `shipped` is windowed identically, and the lane keyed `done` on that
//      same board (role-less) is NOT windowed.
//   E. MALFORMED / EDGE PARAMS fail OPEN to the full byte-identical default (garbage, negative, blank),
//      and a fractional limit floors.
//   F. CHILD ROLLUP SURVIVES THE WINDOW. A live parent's childCount still counts children the window
//      dropped — boardRollup must be fed the FULL task list, never the windowed one.
//
// Run: 1) build the daemon, 2) node test/board-done-window.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import path from "node:path";

useOwnLoomHome("loom-board-done-window-");
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

// Dynamic, AFTER useOwnLoomHome: dist/paths.js freezes every LOOM_HOME-derived const at import time.
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { toBoardTasks } = await import("../dist/mcp/tasks.js");
const { boardRollup } = await import("../dist/tasks/relations.js");
const { resolveConfig, columnKeyForRole, byRecentlyDone } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db(path.join(process.env.LOOM_HOME, "loom.db"));
const now = new Date().toISOString();
// Distinct, strictly-increasing updatedAt values so byRecentlyDone's order is deterministic and its
// position/id tie-breaks are never what this test is actually measuring.
const at = (i) => new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 60_000).toISOString();

const DONE = 12;      // done cards on the default board
const LIVE = 4;       // live cards on the default board
const WINDOW = 5;     // the window every B/C assertion below reads

try {
  db.insertProject({ id: "pDefault", name: "Default board", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null });
  // A board whose TERMINAL lane is deliberately NOT keyed "done", with a decoy lane that IS — so case D
  // can only pass by resolving the terminal ROLE, never by matching a key name.
  db.insertProject({
    id: "pRenamed", name: "Renamed terminal", repoPath: "C:/b", vaultPath: "C:/b", createdAt: now, archivedAt: null,
    config: { kanbanColumns: [
      { key: "inbox", label: "Inbox", role: "defaultLanding" },
      { key: "done", label: "Done (a decoy — no role)" },
      { key: "shipped", label: "Shipped", role: "terminal" },
    ] },
  });

  const mk = (id, projectId, columnKey, i, over = {}) => db.insertTask({
    id, projectId, title: `T-${id}`, body: `body of ${id}`, columnKey,
    position: i, createdAt: at(i), updatedAt: at(i), ...over,
  });

  // F: a LIVE parent whose children sit at the OLD end of the done lane, so a WINDOW-sized window drops
  // them. `parentId` is set at INSERT, never via db.updateTask — an update bumps `updatedAt`, which would
  // re-sort those two cards to the NEWEST end and quietly move them back INSIDE the window, making both
  // the order assertion and F's own precondition read the opposite of what they were written to prove.
  mk("parent", "pDefault", "todo", 200);
  // Default board: 12 done (oldest→newest by updatedAt) + 4 live.
  for (let i = 0; i < DONE; i++) mk(`d${i}`, "pDefault", "done", i, i < 2 ? { parentId: "parent" } : {});
  for (let i = 0; i < LIVE; i++) mk(`l${i}`, "pDefault", "in_progress", 100 + i, i === 0 ? { parentId: "parent" } : {});

  // Renamed board: 7 in the real terminal lane, 3 in the decoy "done" lane.
  for (let i = 0; i < 7; i++) mk(`s${i}`, "pRenamed", "shipped", i);
  for (let i = 0; i < 3; i++) mk(`k${i}`, "pRenamed", "done", 50 + i);

  const app = await buildServer({
    db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, control: {}, usageStatus: {},
  });

  try {
    const board = async (url) => (await app.inject({ method: "GET", url })).json();

    // ── A. The default response is byte-identical to the pre-change handler ──────────────────────
    // The pinned pre-change expression, transcribed from commit 2ff0e2eb (see the header).
    const pinnedDefaultResponse = (projectId) => {
      const p = db.getProject(projectId);
      const cols = resolveConfig(p.config).kanbanColumns;
      const terminalKey = columnKeyForRole(cols, "terminal");
      const tasks = db.listTasks(p.id);
      return { columns: cols, tasks: toBoardTasks(tasks, terminalKey, boardRollup(db, p.id, tasks)) };
    };
    const defaultRaw = await app.inject({ method: "GET", url: "/api/projects/pDefault/board" });
    check("A: the no-param response is BYTE-IDENTICAL to the pinned pre-change handler expression",
      defaultRaw.body === JSON.stringify(pinnedDefaultResponse("pDefault")));
    const dflt = defaultRaw.json();
    check("A: and it carries NO window keys at all (absent, not zero)",
      !("doneTotal" in dflt) && !("doneLimit" in dflt));
    check(`A precondition: the default really does ship all ${DONE} done cards`,
      dflt.tasks.filter((t) => t.columnKey === "done").length === DONE);

    // ── B/C. The window, its order, and the true total ──────────────────────────────────────────
    const win = await board(`/api/projects/pDefault/board?doneLimit=${WINDOW}`);
    const winDone = win.tasks.filter((t) => t.columnKey === "done");
    check(`B: ?doneLimit=${WINDOW} ships exactly ${WINDOW} done cards`, winDone.length === WINDOW);
    // The 5 newest of d0..d11 are d11,d10,d9,d8,d7 — and byRecentlyDone order means that exact sequence.
    check("B: they are the N most-recently-done cards, in byRecentlyDone order",
      winDone.map((t) => t.id).join(",") === "d11,d10,d9,d8,d7");
    check("B: the window agrees with the shared comparator applied to the FULL lane",
      winDone.map((t) => t.id).join(",") ===
        [...dflt.tasks.filter((t) => t.columnKey === "done")].sort(byRecentlyDone).slice(0, WINDOW).map((t) => t.id).join(","));
    check("B: every LIVE lane is still whole (the window touches only the terminal lane)",
      win.tasks.filter((t) => t.columnKey === "in_progress").length === LIVE
      && win.tasks.filter((t) => t.columnKey === "todo").length === 1);
    check("C: doneTotal is the lane's TRUE length, not the window's",
      win.doneTotal === DONE && win.doneTotal !== winDone.length);
    check(`C: doneLimit echoes the effective window (${WINDOW})`, win.doneLimit === WINDOW);
    check("C: a done row in the window still has its body dropped to hasBody (4fa2c146 is unchanged)",
      winDone.every((t) => !("body" in t) && t.hasBody === true));

    // A window LARGER than the lane returns the whole lane and is honest about both numbers.
    const over = await board("/api/projects/pDefault/board?doneLimit=9999");
    check("C: a window past the lane's end returns the whole lane, with the true total",
      over.tasks.filter((t) => t.columnKey === "done").length === DONE && over.doneTotal === DONE);
    check("C: ...and echoes the limit as sent (never clamped DOWN — the full set is one param away)",
      over.doneLimit === 9999);
    // doneLimit=0 is a legitimate request (live lanes only) and must NOT read as "no window".
    const zero = await board("/api/projects/pDefault/board?doneLimit=0");
    check("C: doneLimit=0 is a real empty window, not a fallback to the full set",
      zero.tasks.filter((t) => t.columnKey === "done").length === 0 && zero.doneTotal === DONE && zero.doneLimit === 0);

    // ── D. A renamed terminal lane ──────────────────────────────────────────────────────────────
    const ren = await board("/api/projects/pRenamed/board?doneLimit=2");
    check("D: the TERMINAL-role lane is windowed even though it is keyed `shipped`, not `done`",
      ren.tasks.filter((t) => t.columnKey === "shipped").length === 2 && ren.doneTotal === 7);
    check("D: ...in byRecentlyDone order (the 2 newest shipped cards)",
      ren.tasks.filter((t) => t.columnKey === "shipped").map((t) => t.id).join(",") === "s6,s5");
    check("D: the decoy lane literally keyed `done` is NOT windowed (role, never a name match)",
      ren.tasks.filter((t) => t.columnKey === "done").length === 3);

    // ── E. Malformed params fail OPEN to the byte-identical default ─────────────────────────────
    const pinnedBytes = JSON.stringify(pinnedDefaultResponse("pDefault"));
    for (const raw of ["abc", "-1", "", "NaN", "null"]) {
      const res = await app.inject({ method: "GET", url: `/api/projects/pDefault/board?doneLimit=${raw}` });
      check(`E: ?doneLimit=${JSON.stringify(raw)} falls back to the full byte-identical default`,
        res.body === pinnedBytes);
    }
    const frac = await board("/api/projects/pDefault/board?doneLimit=3.7");
    check("E: a fractional limit floors (3.7 ⇒ a window of 3)",
      frac.tasks.filter((t) => t.columnKey === "done").length === 3 && frac.doneLimit === 3);

    // ── F. The child rollup is computed over the FULL list, never the window ────────────────────
    const parentDefault = dflt.tasks.find((t) => t.id === "parent");
    const parentWindowed = win.tasks.find((t) => t.id === "parent");
    check("F precondition: two of the parent's children sort OUTSIDE the window",
      !winDone.some((t) => t.id === "d0") && !winDone.some((t) => t.id === "d1"));
    check("F: the parent's childCount/childDone are unchanged by the window (3 children, 2 done)",
      parentDefault.childCount === 3 && parentDefault.childDone === 2
      && parentWindowed.childCount === 3 && parentWindowed.childDone === 2);
  } finally {
    await app.close();
  }
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the default board response is byte-identical, ?doneLimit=N windows the TERMINAL lane in byRecentlyDone order with the lane's true total, a renamed terminal lane is covered, a malformed param fails open, and the child rollup survives the window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
