// Hermetic unit test for the web-side session grouping in src/lib/sessions.ts — the pure, dependency-free
// groupSessionRows() behind the Terminals page. No daemon, no claude, no React: it imports the TS source
// directly via Node's type stripping and asserts on plain objects, so it exercises the REAL shipped helper
// and can't drift from a copy.
//
// Like diff.mjs / companion.mjs, the web package has no test runner, so this is a self-contained node script
// wired into @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/sessions.mjs
import assert from "node:assert/strict";
import { groupSessionRows } from "../src/lib/sessions.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A minimal live-session row — only the fields groupSessionRows reads (id/role/parentSessionId/createdAt).
const S = (id, role, extra = {}) => ({ id, role, parentSessionId: null, createdAt: `2026-07-01T00:00:0${id.length % 10}.000Z`, ...extra });
// Flatten every session across every emitted row — the "does it appear ANYWHERE on the page" view.
const allMembers = (rows) => rows.flatMap((r) => r.list);
const ids = (rows) => allMembers(rows).map((s) => s.id);

// ── The load-bearing security invariant: a companion (assistant role) is filtered out of the grouping ──

// 1) An assistant-role session appears in NO row — not as a manager, orphan, or standalone tile.
check("an assistant (companion) session is dropped from the grouping entirely", () => {
  const rows = groupSessionRows([S("companion-1", "assistant")]);
  assert.deepEqual(rows, [], "a lone companion produces no rows at all");
  assert.ok(!ids(rows).includes("companion-1"), "the companion must not appear in any row");
});

// 2) It can't leak into the standalone catch-all: a role-less standalone still shows, the companion never does.
check("a companion never lands in the standalone row alongside plain sessions", () => {
  const rows = groupSessionRows([S("plain-1", null), S("companion-1", "assistant")]);
  const standalone = rows.find((r) => r.kind === "standalone");
  assert.ok(standalone, "the plain session still gets a standalone row");
  assert.deepEqual(standalone.list.map((s) => s.id), ["plain-1"], "only the plain session, never the companion");
  assert.ok(!ids(rows).includes("companion-1"));
});

// 3) It can't leak as an orphan either — an assistant with a (bogus) parent is still dropped, not orphaned.
check("a companion with a parent id is still dropped (never surfaces as an orphan)", () => {
  const rows = groupSessionRows([S("companion-1", "assistant", { parentSessionId: "mgr-x" })]);
  assert.deepEqual(rows, [], "no orphan row for a parented companion");
});

// 4) Mixed fleet: the companion is the ONLY thing removed; the manager row + its worker are intact.
check("in a mixed fleet only the companion is excluded; manager/worker/standalone survive", () => {
  const rows = groupSessionRows([
    S("mgr-1", "manager"),
    S("wkr-1", "worker", { parentSessionId: "mgr-1" }),
    S("plain-1", null),
    S("companion-1", "assistant"),
  ]);
  assert.ok(!ids(rows).includes("companion-1"), "the companion is gone");
  const mgrRow = rows.find((r) => r.kind === "manager");
  assert.ok(mgrRow, "the manager row exists");
  assert.deepEqual(mgrRow.list.map((s) => s.id), ["mgr-1", "wkr-1"], "manager first, then its worker");
  assert.ok(ids(rows).includes("plain-1"), "the standalone plain session still shows");
});

// ── Baseline grouping (guards the extraction didn't change behavior for non-companion sessions) ────────

check("a worker whose parent isn't in the set becomes an orphan (not dropped)", () => {
  const rows = groupSessionRows([S("wkr-1", "worker", { parentSessionId: "gone" })]);
  const orphan = rows.find((r) => r.kind === "orphans");
  assert.ok(orphan, "an orphan row is emitted");
  assert.deepEqual(orphan.list.map((s) => s.id), ["wkr-1"]);
});

console.log(`\n${pass} passed`);
